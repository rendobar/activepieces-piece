import { createAction } from '@activepieces/pieces-framework';
import { JOB_LOGS_OUTPUT_SCHEMA } from '../common/output-schemas';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { jobIdDropdown } from '../common/job';
import { requireJobId } from '../common/pure';

type LogEntry = {
  timestamp?: number;
  level?: string;
  step?: string;
  event?: string;
  message?: string;
};

export const getJobLogs = createAction({
  auth: rendobarAuth,
  name: 'get_job_logs',
  classification: 'READ',
  displayName: 'Get Job Logs',
  description: "Read a job's execution logs, for diagnosing a failure.",
  audience: 'both',
  aiMetadata: {
    description:
      "Read the stored execution logs for one Rendobar job, including the underlying tool's output. Use to diagnose why a job failed, after Get Job has shown the error. Logs exist only when the job recorded them. Reads only, safe to retry.",
    idempotent: true,
  },
  outputSchema: JOB_LOGS_OUTPUT_SCHEMA,

  props: {
    jobId: jobIdDropdown,
  },

  async run(context) {
    const res = await rendobar<{ data: LogEntry[] }>(
      context.auth.secret_text,
      HttpMethod.GET,
      `/jobs/${encodeURIComponent(requireJobId(context.propsValue.jobId))}/logs`,
    );
    // A flat row per line, with the same keys on every one, so the result drops
    // straight into a table or a filter step.
    return (res.data ?? []).map((entry) => ({
      timestamp: entry.timestamp ?? null,
      level: entry.level ?? null,
      step: entry.step ?? null,
      event: entry.event ?? null,
      message: entry.message ?? null,
    }));
  },
});
