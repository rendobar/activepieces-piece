import { createAction } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { jobIdDropdown, toJobRow, getJobById, requireJobId, type Job, JOB_OUTPUT_SCHEMA } from '../common/job';
import { conflictCode } from '../common/pure';

export const cancelJob = createAction({
  auth: rendobarAuth,
  name: 'cancel_job',
  classification: 'DESTRUCTIVE',
  displayName: 'Cancel Job',
  description: 'Stop a job that has not started running yet.',
  audience: 'both',
  aiMetadata: {
    description:
      'Cancel a Rendobar job that is still waiting, dispatched or running. Safe to retry: a job that is already cancelled reports success, because the outcome asked for already holds. A job that finished before the cancel landed cannot be cancelled and the call fails.',
    idempotent: true,
  },
  outputSchema: JOB_OUTPUT_SCHEMA,

  props: {
    jobId: jobIdDropdown,
  },
  async run(context) {
    const token = context.auth.secret_text;
    const jobId = requireJobId(context.propsValue.jobId);

    try {
      // Cancel answers with the whole job, so this needs no follow-up read and
      // still returns the same columns as every other job-shaped step.
      const cancelled = await rendobar<{ data: Job }>(
        token,
        HttpMethod.POST,
        `/jobs/${encodeURIComponent(jobId)}/cancel`,
      );
      return toJobRow(cancelled.data);
    } catch (error) {
      // Rendobar refuses to cancel a job that is no longer cancellable, which
      // covers two very different situations under one 409. If the job is
      // already CANCELLED then the outcome this step asked for holds and a
      // retry should not fail; that is what makes it safe to retry. If it
      // finished instead, the cancel genuinely did not happen and saying
      // otherwise would be a lie about the flow's own history.
      if (conflictCode(error) !== 'CONFLICT') throw error;
      const current = await getJobById(token, jobId);
      if (current.status !== 'cancelled') throw error;
      return toJobRow(current);
    }
  },
});
