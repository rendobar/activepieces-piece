import { createAction, Property } from '@activepieces/pieces-framework';
import { JOB_LIST_OUTPUT_SCHEMA } from '../common/output-schemas';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { toJobRow, type Job } from '../common/job';

export const findJobs = createAction({
  auth: rendobarAuth,
  name: 'find_jobs',
  classification: 'SEARCH',
  displayName: 'Find Jobs',
  description: 'List recent jobs, filtered by status and type.',
  audience: 'both',
  aiMetadata: {
    description:
      'List recent Rendobar jobs, newest first, optionally filtered by status and job type. Use to survey or reconcile several jobs; to read one job you already have the ID of, use Get Job. Reads only, safe to retry.',
    idempotent: true,
  },
  outputSchema: JOB_LIST_OUTPUT_SCHEMA,

  props: {
    status: Property.StaticDropdown({
      displayName: 'Status',
      description: 'Leave empty for every status.',
      required: false,
      options: {
        options: [
          { label: 'Succeeded', value: 'complete' },
          { label: 'Failed', value: 'failed' },
          { label: 'Cancelled', value: 'cancelled' },
          { label: 'Running', value: 'running' },
          { label: 'Waiting', value: 'waiting' },
          { label: 'Dispatched', value: 'dispatched' },
        ],
      },
    }),
    jobType: Property.ShortText({
      displayName: 'Job Type',
      description: 'Only this job type, for example compress.target. Leave empty for all.',
      required: false,
    }),
    limit: Property.Number({
      displayName: 'Limit',
      description: 'How many to return, newest first.',
      required: false,
      defaultValue: 25,
    }),
  },

  async run(context) {
    const { status, jobType, limit } = context.propsValue;
    const query = new URLSearchParams({
      limit: String(Math.max(1, Math.min(100, limit ?? 25))),
      sort: 'created',
      order: 'desc',
    });
    if (status) query.set('status', status);
    if (jobType) query.set('type', jobType);

    const page = await rendobar<{ data: Job[] }>(
      context.auth.secret_text,
      HttpMethod.GET,
      `/jobs?${query.toString()}`,
    );
    // Same row shape as every other job-shaped step, so a table built on one
    // works on the others.
    return page.data.map(toJobRow);
  },
});
