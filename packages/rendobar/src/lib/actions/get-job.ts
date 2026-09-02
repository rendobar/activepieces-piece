import { createAction } from '@activepieces/pieces-framework';
import { rendobarAuth } from '../auth';
import { getJobById, jobIdDropdown, toJobRow, JOB_OUTPUT_SCHEMA } from '../common/job';

export const getJob = createAction({
  auth: rendobarAuth,
  name: 'get_job',
  classification: 'READ',
  displayName: 'Get Job',
  description: 'Read a job: its status, output file and cost.',
  audience: 'both',
  aiMetadata: {
    description:
      'Read one Rendobar job by ID and return its status, output file URL and cost. Use to check on a job that was submitted without waiting; to submit new work use Run a Media Job instead. Reads only, safe to retry.',
    idempotent: true,
  },
  outputSchema: JOB_OUTPUT_SCHEMA,

  props: {
    jobId: jobIdDropdown,
  },
  async run(context) {
    return toJobRow(await getJobById(context.auth.secret_text, context.propsValue.jobId));
  },
});
