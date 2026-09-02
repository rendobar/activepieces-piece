import { HttpMethod } from '@activepieces/pieces-common';
import { Property } from '@activepieces/pieces-framework';
import { rendobar } from './client';
import { rendobarAuth } from '../auth';

/**
 * The slice of Rendobar's job response this piece reads. Deliberately partial:
 * the API adds fields additively, and naming only what is used keeps a new
 * field from turning into a compile error here.
 */
export type Job = {
  id: string;
  type: string;
  status: 'waiting' | 'dispatched' | 'running' | 'complete' | 'failed' | 'cancelled';
  source?: string | null;
  client?: string | null;
  mediaType?: string | null;
  outputCategory?: string;
  region?: string | null;
  retryCount?: number;
  logsAvailable?: boolean;
  timeoutMs?: number | null;
  createdAt?: number;
  startedAt?: number | null;
  completedAt?: number | null;
  retentionExpiresAt?: number | null;
  cost?: { amount: number; formatted: string } | null;
  error?: { code?: string; message?: string };
  output?: {
    data?: unknown;
    file?: {
      url: string;
      path: string;
      type: string;
      size: number;
      meta?: { format?: string; width?: number; height?: number; durationMs?: number };
    } | null;
    files?: { url: string; path: string; type: string; size: number }[];
  };
};

/** A job stops changing in exactly these three states. */
export const TERMINAL_STATUSES = ['complete', 'failed', 'cancelled'] as const;

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * One job as a flat row of primitives, per the output-quality rules: every
 * value lands in its own spreadsheet column, and a missing one is null rather
 * than absent so an array of these keeps consistent columns.
 *
 * Two fields stay nested on purpose. `data` is the whole point of a job type
 * like ffprobe or captions.transcribe (a probe result, a transcript) and its
 * shape differs per type, so flattening would either stringify it or drop it.
 * `files` is a list whose length is not known ahead of time. Both are additions
 * beside the flat columns, never a replacement for them.
 */
export function toJobRow(job: Job): Record<string, unknown> {
  const file = job.output?.file ?? null;
  const started = job.startedAt ?? null;
  const completed = job.completedAt ?? null;

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    succeeded: job.status === 'complete',
    media_type: job.mediaType ?? null,
    output_category: job.outputCategory ?? null,

    file_url: file?.url ?? null,
    file_name: file?.path ?? null,
    file_type: file?.type ?? null,
    file_size_bytes: file?.size ?? null,
    file_format: file?.meta?.format ?? null,
    file_width: file?.meta?.width ?? null,
    file_height: file?.meta?.height ?? null,
    file_duration_ms: file?.meta?.durationMs ?? null,
    file_count: job.output?.files?.length ?? 0,

    error_code: job.error?.code ?? null,
    error_message: job.error?.message ?? null,

    cost_formatted: job.cost?.formatted ?? null,
    // Nanodollars, the unit the API bills in: 1 USD = 1,000,000,000.
    cost_nanodollars: job.cost?.amount ?? null,

    created_at: job.createdAt ?? null,
    started_at: started,
    completed_at: completed,
    duration_ms: started !== null && completed !== null ? completed - started : null,
    expires_at: job.retentionExpiresAt ?? null,

    region: job.region ?? null,
    source: job.source ?? null,
    retry_count: job.retryCount ?? null,
    logs_available: job.logsAvailable ?? null,

    // Job-type-specific result and the full file list. See the comment above.
    data: job.output?.data ?? null,
    files: job.output?.files ?? [],
  };
}

export { jobIdFromEnvelope, requireJobId, type WebhookEnvelope } from './pure';
export { JOB_OUTPUT_SCHEMA } from './output-schemas';
import { requireJobId } from './pure';

export async function getJobById(accessToken: string, jobId: string): Promise<Job> {
  const response = await rendobar<{ data: Job }>(
    accessToken,
    HttpMethod.GET,
    `/jobs/${encodeURIComponent(requireJobId(jobId))}`,
  );
  return response.data;
}

/**
 * Poll until the job stops changing or the budget runs out.
 *
 * Rendobar has no server-side long-poll on REST, so waiting is the caller's
 * job. The interval starts short because most FFmpeg work finishes in seconds,
 * and backs off to 5s so a long render does not spend the flow's whole request
 * budget on polling.
 *
 * Returns whatever the last read saw. A caller that still finds a non-terminal
 * status has hit its own deadline, not an error: the job keeps running on
 * Rendobar and can be picked up later by the Finished Job trigger.
 */
export async function waitForJob(
  accessToken: string,
  jobId: string,
  maxWaitMs: number,
): Promise<Job> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 1000;
  let job = await getJobById(accessToken, jobId);

  while (!isTerminal(job.status) && Date.now() + delay < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 5000);
    job = await getJobById(accessToken, jobId);
  }
  return job;
}

/**
 * Job picker for the two actions that address an existing job.
 *
 * A job id is normally carried from an earlier step in the same flow, which is
 * what the variable picker on this field is for. The list exists for the other
 * case: a job someone submitted elsewhere, and testing a flow by hand. It is
 * the most recent 50, newest first, because a job id means nothing on its own.
 */
export const jobIdDropdown = Property.Dropdown({
  displayName: 'Job',
  description:
    'Pick a recent job, or insert the ID from an earlier step (for example the Job ID of a Create Job step).',
  required: true,
  auth: rendobarAuth,
  refreshers: [],
  options: async ({ auth }) => {
    if (!auth) {
      return { disabled: true, options: [], placeholder: 'Please connect your account first' };
    }
    try {
      const page = await rendobar<{ data: Job[] }>(
        auth.secret_text,
        HttpMethod.GET,
        '/jobs?limit=50&sort=created&order=desc',
      );
      if (page.data.length === 0) {
        return { disabled: false, options: [], placeholder: 'No jobs yet. Run a Create Job step first.' };
      }
      return {
        disabled: false,
        options: page.data.map((job) => ({
          label: `${job.type} — ${job.status} — ${formatWhen(job.createdAt)} (${job.id})`,
          value: job.id,
        })),
      };
    } catch {
      return { disabled: true, options: [], placeholder: 'Failed to load jobs. Check your connection.' };
    }
  },
});

function formatWhen(epochMs: number | undefined): string {
  if (epochMs === undefined) return 'unknown time';
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}


/**
 * Attach the job's output file to the step, so the next step gets a real file
 * rather than a link it has to fetch.
 *
 * This is what lets a Rendobar step sit in the middle of an ordinary flow: a
 * file arrives from Drive, a job runs, and the result goes to Slack. Without it
 * the piece could only ever hand on a URL, and half the connectors downstream
 * want bytes.
 *
 * The URL is time limited, so downloading here also decouples the flow from the
 * signature's expiry. A job that produced no file (a probe, a transcript) is
 * returned untouched.
 */
/**
 * Activepieces Cloud's per-file ceiling, and the self-hosted default is higher.
 * Assuming the smaller one means a self-hosted user is warned early rather than
 * a Cloud user failing late, and the message names the setting either way.
 */
const CLOUD_MAX_FILE_BYTES = 10 * 1_000_000;

export async function attachOutputFile(
  row: Record<string, unknown>,
  files: { write: (input: { fileName: string; data: Buffer }) => Promise<string> },
  maxFileBytes: number = CLOUD_MAX_FILE_BYTES,
): Promise<Record<string, unknown>> {
  const url = row['file_url'];
  if (typeof url !== 'string' || url === '') return row;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `The job finished but its output could not be downloaded (HTTP ${response.status}). The URL is time limited; read it sooner, or leave the download option off and fetch it yourself.`,
    );
  }

  // Refuse before spending the bandwidth. Activepieces caps a step file at
  // AP_MAX_FILE_SIZE_MB, which is 10 MB on Cloud and 25 MB self-hosted by
  // default, and a rendered video clears that routinely. Without this the step
  // downloads the whole file and then fails inside files.write with a platform
  // error that says nothing about Rendobar or about what to do instead.
  //
  // The size is already on the row, so this costs nothing. It is a warning
  // about the PLATFORM's limit rather than one of ours, which is why it names
  // the setting and the alternative instead of a number we chose.
  const size = row['file_size_bytes'];
  if (typeof size === 'number' && size > maxFileBytes) {
    throw new Error(
      `The output is ${Math.round(size / 1_000_000)} MB, over this Activepieces' per-file limit of ` +
        `${Math.round(maxFileBytes / 1_000_000)} MB (AP_MAX_FILE_SIZE_MB, 10 MB on Activepieces Cloud). ` +
        'Turn off "Download the Output File" and pass file_url to the next step, which most steps accept.',
    );
  }

  const name = typeof row['file_name'] === 'string' && row['file_name'] !== '' ? row['file_name'] : 'output';
  const data = Buffer.from(await response.arrayBuffer());

  return { ...row, file: await files.write({ fileName: name, data }) };
}
