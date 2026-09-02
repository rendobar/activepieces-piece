# Rendobar for Activepieces

The [Rendobar](https://rendobar.com) piece for [Activepieces](https://www.activepieces.com).
Published to npm as [`@rendobar/piece-rendobar`](https://www.npmjs.com/package/@rendobar/piece-rendobar).

Submit media jobs, wait for them without polling, upload files, and trigger a
flow when a job finishes.

## Install

Activepieces installs custom pieces from npm by package name. On a self-hosted
instance, add it from **Admin → Pieces → Install**:

```
@rendobar/piece-rendobar
```

Installing custom pieces is a paid feature on Activepieces Cloud.

## What it does

Seven actions and two triggers. `packages/rendobar/README.md` is the reference,
and it is what renders on the npm page.

The part worth knowing about: **Create job pauses the flow on a waitpoint rather
than polling.** Rendobar calls back when the job finishes and the flow resumes,
so a ten minute render costs no execution time while it waits. If a callback URL
cannot be reached, it falls back to polling on its own.

## Repository layout

```
packages/rendobar/     the piece, and the only thing published
scripts/               fetch pinned Activepieces source, generate the version,
                       bundle, verify the artifact
.ap-pin                the Activepieces commit everything compiles against
```

## Developing

```bash
npm ci
npm run ap:fetch
npm run ci
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), which covers why the framework is
fetched rather than installed, why the published package has no dependencies,
and how releases work.

## Licence

MIT. See [LICENSE](./LICENSE).
