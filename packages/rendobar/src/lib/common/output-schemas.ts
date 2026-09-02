import { type OutputSchema } from '@activepieces/pieces-framework';

/**
 * How the builder presents each action's output.
 *
 * A dedicated module because 64 files across the catalog keep their schemas
 * here rather than beside the code that fetches the data. The split is worth
 * having: `common/job.ts` is about talking to Rendobar, this is about how a
 * flow author reads the result, and the two change for different reasons.
 *
 * Without a schema the builder renders raw JSON and variables are picked out of
 * unlabelled keys. The formats are the point: a byte count reads as a size, a
 * duration as a duration, nanodollars stop looking like a nine-digit integer.
 */

/** The 30-column row every job-shaped action and trigger returns. */
export const JOB_OUTPUT_SCHEMA: OutputSchema = {
  fields: [
    { key: 'status', label: 'Status' },
    { key: 'succeeded', label: 'Succeeded', format: 'boolean' },
    { key: 'type', label: 'Job Type' },
    { key: 'file_url', label: 'Output File URL', format: 'url' },
    { key: 'file_name', label: 'File Name' },
    { key: 'file_size_bytes', label: 'File Size', format: 'filesize' },
    { key: 'file_format', label: 'Format' },
    { key: 'file_duration_ms', label: 'Media Duration', format: 'duration' },
    { key: 'error_code', label: 'Error Code' },
    { key: 'error_message', label: 'Error' },
    { key: 'cost_formatted', label: 'Cost' },
    { key: 'duration_ms', label: 'Processing Time', format: 'duration' },
    { key: 'completed_at', label: 'Completed', format: 'datetime' },
    { key: 'expires_at', label: 'Output Expires', format: 'datetime' },
    { key: 'id', label: 'Job ID' },
    {
      key: 'files',
      label: 'All Output Files',
      // Name each entry by its filename rather than "Item 1". The expression
      // path is unaffected; only the label changes.
      labelKey: 'path',
      listItems: [
        { key: 'url', label: 'URL', format: 'url' },
        { key: 'path', label: 'Path' },
        { key: 'size', label: 'Size', format: 'filesize' },
        { key: 'type', label: 'Type' },
      ],
    },
  ],
};

/**
 * Find Jobs returns the same rows as a top-level ARRAY, so the label template
 * goes on the schema itself. Without it every result reads "Item 1, Item 2".
 */
export const JOB_LIST_OUTPUT_SCHEMA: OutputSchema = {
  itemLabel: '{type} · {status}',
  fields: JOB_OUTPUT_SCHEMA.fields,
};

/**
 * Get Account. `balance` is a plain number of dollars, which is exactly the
 * case `currency` exists for, and the plan limits are worth labelling because
 * they are what a flow checks before submitting work.
 */
export const ACCOUNT_OUTPUT_SCHEMA: OutputSchema = {
  fields: [
    { key: 'plan_name', label: 'Plan' },
    { key: 'balance', label: 'Balance', format: 'currency', currency: 'USD' },
    { key: 'subscription_status', label: 'Subscription' },
    { key: 'cancels_at_period_end', label: 'Cancels at Period End', format: 'boolean' },
    {
      key: 'limits',
      label: 'Plan Limits',
      children: [
        { key: 'concurrentJobs', label: 'Concurrent Jobs', format: 'number' },
        { key: 'maxJobTimeout', label: 'Max Job Time', format: 'duration' },
        { key: 'maxInputFileSize', label: 'Max Input File', format: 'filesize' },
        { key: 'storageQuota', label: 'Storage Quota', format: 'filesize' },
        { key: 'outputRetentionDays', label: 'Output Retention (days)', format: 'number' },
      ],
    },
  ],
};

/** Upload File. The size is bytes and the expiry is a timestamp. */
export const UPLOAD_OUTPUT_SCHEMA: OutputSchema = {
  fields: [
    { key: 'url', label: 'Media URL', description: 'Paste into any media input of a job', format: 'url' },
    { key: 'file_name', label: 'File Name' },
    { key: 'size_bytes', label: 'Size', format: 'filesize' },
    { key: 'content_type', label: 'Type' },
    { key: 'expires_at', label: 'Expires', format: 'datetime' },
    { key: 'reused_existing', label: 'Reused an Existing Upload', format: 'boolean' },
    { key: 'asset_id', label: 'Asset ID' },
  ],
};

/** Get Job Logs returns one flat row per line. */
export const JOB_LOGS_OUTPUT_SCHEMA: OutputSchema = {
  itemLabel: '{level} · {message}',
  fields: [
    { key: 'timestamp', label: 'Time', format: 'datetime' },
    { key: 'level', label: 'Level' },
    { key: 'step', label: 'Step' },
    { key: 'event', label: 'Event' },
    { key: 'message', label: 'Message' },
  ],
};

/** Share Output. The URL is the whole point, so it leads and formats as one. */
export const SHARE_OUTPUT_SCHEMA: OutputSchema = {
  fields: [
    { key: 'shareUrl', label: 'Public URL', description: 'Permanent, needs no authentication', format: 'url' },
    { key: 'already_shared', label: 'Was Already Shared', format: 'boolean' },
    { key: 'createdAt', label: 'Shared At', format: 'datetime' },
    { key: 'shareId', label: 'Share ID' },
  ],
};
