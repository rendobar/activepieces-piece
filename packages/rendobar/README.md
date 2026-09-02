# Rendobar

Media processing and AI generation. Submit FFmpeg commands, burn captions,
compress to a target size, generate and edit images, and read the result back.

## Install

Activepieces installs custom pieces from npm by package name. On a self-hosted
instance, add it from **Admin -> Pieces -> Install**:

```
@rendobar/piece-rendobar
```

Installing custom pieces is a paid feature on Activepieces Cloud.

You will need a Rendobar API key from [app.rendobar.com](https://app.rendobar.com).
Source and issues live at
[github.com/rendobar/activepieces-piece](https://github.com/rendobar/activepieces-piece).

## Actions

| Action | What it does |
|---|---|
| Run a Media Job | Submits a job and, by default, waits for the finished file |
| Upload File | Puts a file from the flow into Rendobar and returns a URL a job can read |
| Get Job | Reads a job's status, output file and cost |
| Find Jobs | Lists recent jobs, filtered by status and type |
| Get Job Logs | Reads a job's execution logs, for diagnosing a failure |
| Get Account | Plan, credit balance, subscription and limits |
| Cancel Job | Stops a job that has not started running |
| Custom API Call | Any other Rendobar endpoint |

## Triggers

**Finished Job** registers a webhook and starts the flow the moment a job
finishes. **Finished Job (Polling)** does the same on a timer, for an
Activepieces that Rendobar cannot reach from the internet.

## Waiting

`Run a Media Job` waits by **pausing** the flow, not by holding a worker. It
hands Rendobar a resume URL as the job's callback and sleeps until the job
finishes, so a render that takes hours costs nothing while it waits and is not
bound by the flow run timeout.

If this Activepieces cannot be reached from the internet, there is nowhere to
call back to, so the step falls back to polling and `Maximum Wait (seconds)`
applies. That is the only case where the wait is bounded by the run timeout.

## Files

`Upload File` takes a file from an earlier step (or a URL, which Activepieces
fetches first) and returns a stable `url`. Paste that into any media input of a
Run a Media Job step.

Bytes never pass through Rendobar's API: it hands back a presigned storage URL
and the upload goes straight there, in parts when the file is large.

Going the other way, Run a Media Job has a **Download the Output File** option.
With it on, the finished file is attached to the step so the next one can upload
it somewhere without fetching the URL itself. With it off you get the URL only,
which is cheaper and enough when the next step accepts a link.

## How the form is built

The fields come from Rendobar's live contract
(`GET /jobs/types/{type}/schema`), so a new job type appears here without a
release of this piece. That covers both halves of a job:

- **Input Media** — one labelled field per input the job reads. `ffmpeg` and
  `ffprobe` name their inputs from the command itself, so they get a
  filename-to-source map instead.
- **Parameters** — the job's own settings. A job type with several models shows
  a **Variant** dropdown first, and the fields below change to match. A job type
  whose parameters are a structured document rather than a flat field list
  (`compose`) gets a single JSON editor.

An older Rendobar deployment that does not publish the input descriptor falls
back to a JSON editor for the media, so the piece keeps working either way.

## Output

Every job-shaped step returns the same flat row, so the columns line up whether
it came from an action or a trigger: `id`, `type`, `status`, `succeeded`,
`file_url`, `file_size_bytes`, `cost_formatted`, `duration_ms` and the rest.
`data` holds the job-type-specific result (a probe report, a transcript) and
`files` the full output list.

`cost_formatted` can be `null` on a row read the moment a job completes, because
billing settles a moment later. A later read, including a trigger's, carries it.

## Waiting

Run a Media Job waits up to *Maximum Wait* seconds (300 by default) and then
returns the job as it stands. The job keeps running on Rendobar either way, so a
long render is better handled by turning the wait off and starting a second flow
from the Finished Job trigger.

## Connecting

Paste a Rendobar API key from **Settings → API Keys** at
[app.rendobar.com](https://app.rendobar.com). An OAuth access token is accepted
in the same field, but a key is what lets the instant trigger register its
webhook: Rendobar treats webhook management as account management and refuses
OAuth tokens there.
