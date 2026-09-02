# Contributing

Thanks for looking. This repository holds the Rendobar piece for Activepieces,
published to npm as `@rendobar/piece-rendobar`.

## Getting set up

```bash
npm ci
npm run ap:fetch     # fetches the Activepieces packages we compile against
npm run ci           # typecheck, test, bundle, verify
```

`npm run ci` is the same sequence the CI workflow runs, so if it passes locally
it passes there.

## Why there is an `.ap-src`

The piece uses framework APIs that are not on npm. `@activepieces/pieces-framework`
was last published as 0.32.0, and building against it fails with fifteen errors:
`ExecutionType`, `resumePayload`, `streamUtils` and `streaming: true` are all
missing. Those are the waitpoint pause and the streaming upload, which is most of
what this piece does.

So `scripts/fetch-ap.mjs` fetches four packages of Activepieces source at the
commit pinned in `.ap-pin`. It is a sparse, blobless fetch: about 5 MB and two
seconds. Typechecking, tests and the bundler all resolve against that.

The pin is deliberate. Tracking `main` would make a green build unreproducible
and turn an upstream refactor into a red build here for no reason of ours. Bump
`.ap-pin` as its own change, so that when it breaks something the diff says so.

## Why the published package has no dependencies

The artifact is bundled: the framework is inlined and `dependencies` is `{}`.
That is what every piece in the Activepieces catalog does, and the engine loads
`<package>/src/index.js` directly. It also means a stale framework on npm cannot
affect us.

`scripts/verify-artifact.mjs` asserts all of that before anything is published,
including that the `X-Rendobar-Client` version survived minification. Those
assertions are mutation tested, so each one demonstrably fails when the thing it
checks is broken.

## Releasing

Version bumps come from release-please. Merging its release PR pushes a tag, and
the tag triggers a publish to npm over OIDC trusted publishing, with provenance.
No one publishes by hand, and no token exists to leak.

The version reaches the runtime through `scripts/generate-version.mjs`, which
writes `src/lib/common/version.ts` from `package.json` at build time. It is
gitignored, so it cannot drift from the manifest.

## One thing that will bite

**`httpClient` defaults to `Content-Type: application/json`.** A presigned PUT
that does not set the type explicitly stores the media as JSON, the upload still
reports success, the asset still reads as ready, and every job that reads it
fails one step later with `returned application/json, not a file`. `putBytes`
sets it; keep it that way.

## Why the wait is a waitpoint

An Activepieces run is capped at **10 minutes** on Cloud, where a worker handles
**one** run at a time. Rendobar jobs run up to an hour on Free and nine on Pro.
A blocking wait therefore holds a worker for minutes and still cannot outlast
the jobs people actually submit.

A **paused** flow costs neither. Pause does not count against the run timeout and
may last 30 days. So `Run a Media Job` creates a `WEBHOOK` waitpoint, passes its
resume URL as the job's per-job `callback.url`, and calls `waitForWaitpoint`.
Rendobar's callback contract is what makes this safe: terminal events
(complete, failed, cancelled) always fire and cannot be filtered out, so a
waiter can never hang.

This is the pattern the `assemblyai` piece uses, which has the same
submit-then-wait shape.

### Three ways this hangs if you change it

A paused flow that is never resumed sits there for the waitpoint's full 30 days,
so every path that pauses must be certain a callback is still coming.

1. **`idempotent: true`** in the submit response means the key matched a job
   submitted earlier, which carries the EARLIER call's callback URL. Rendobar
   will resume that waitpoint, not this one. Poll instead.
2. **A terminal `status`** in the submit response means a sync job type ran
   inline and its callback has already been and gone. Poll instead.
3. **An unreachable resume URL.** `isPubliclyReachable` mirrors the server's
   `validateWebhookUrl`. Keep them in step: if this check is *looser* than the
   server's, the callback is attached, the submit is refused with a 400, and the
   job never runs at all.

### The callback URL is not part of the idempotency key

A retry mints a fresh waitpoint and so a fresh URL. Folding that into the
fingerprint would give every retry a new key, submit a second job, and bill for
it — undoing exactly what the key is there to prevent. Build the key from the
submission, then add the callback.

## Uploading streams, and why the size still gets measured

A worker has about 1 GB and this piece exists to move media, so buffering a
video to upload it spends the file's whole size in that budget and is OOM-killed
on a big enough one. `Upload File` declares `streaming: true` and pushes one
part at a time with `streamUtils.readChunks`, so peak memory is one part rather
than the whole upload.

`POST /assets` still needs the size up front: it is what chooses a single
presigned PUT from a multipart upload, and it fixes the part boundaries. A
stream does not always know its length, since the source may send no
`Content-Length` and the value is dropped for a compressed response. When it is
missing there is no way to open the upload, so the file is read once to measure
it. That is the one case that still buffers, and it is unavoidable rather than
an oversight.

Two guards exist because a plan built from a wrong size would otherwise store a
truncated file that reads as `ready`: the upload fails if the stream ends before
the parts do, and if it outlasts them.

### Testing that this actually streams

Asserting the PUT bodies are one part each does NOT distinguish streaming from
buffering — they are part-sized either way, and an earlier version of that test
passed against a buffered implementation. The observable that separates them is
**how much of the source has been read when the first part is sent**. The test
counts bytes emitted by the source and asserts the first PUT fires before the
whole file has been pulled.
