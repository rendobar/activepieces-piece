import {
  createTrigger,
  TriggerStrategy,
  Property,
  StaticPropsValue,
  AppConnectionValueForAuthProperty,
} from '@activepieces/pieces-framework';
import { DedupeStrategy, Polling, pollingHelper, HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { isTerminal, toJobRow, type Job, JOB_OUTPUT_SCHEMA } from '../common/job';
import { FINISHED_JOB_SAMPLE } from './sample';

/**
 * The fallback trigger.
 *
 * Finished Job registers a webhook and fires the moment a job lands, which is
 * the right answer whenever Rendobar can reach this Activepieces. It cannot on
 * an instance that is not publicly resolvable, because Rendobar refuses to
 * register a delivery URL on a private address. This one polls `GET /jobs`
 * instead and works anywhere, at the cost of Activepieces' polling interval
 * (about five minutes).
 */


const props = {
  outcome: Property.StaticDropdown({
    displayName: 'Outcome',
    description: 'Which finished jobs should start this flow.',
    required: false,
    defaultValue: 'complete',
    options: {
      options: [
        { label: 'Succeeded only (recommended)', value: 'complete' },
        { label: 'Failed only', value: 'failed' },
        { label: 'Any finished job, including cancelled', value: 'any' },
      ],
    },
  }),
  jobType: Property.ShortText({
    displayName: 'Job Type',
    description: 'Only start on this job type, for example compress.target. Leave empty for all types.',
    required: false,
  }),
};

const polling: Polling<
  AppConnectionValueForAuthProperty<typeof rendobarAuth>,
  StaticPropsValue<typeof props>
> = {
  strategy: DedupeStrategy.TIMEBASED,
  items: async ({ auth, propsValue }) => {
    const query = new URLSearchParams({ limit: '100', sort: 'created', order: 'desc' });
    // "any" cannot be one request: the API filters on a single status, and the
    // three terminal ones are separate values. Asking for none and filtering
    // here costs one call instead of three.
    if (propsValue.outcome && propsValue.outcome !== 'any') {
      query.set('status', propsValue.outcome);
    }
    if (propsValue.jobType) query.set('type', propsValue.jobType);

    const page = await rendobar<{ data: Job[] }>(
      auth.secret_text,
      HttpMethod.GET,
      `/jobs?${query.toString()}`,
    );

    return page.data
      .filter((job) => isTerminal(job.status) && job.completedAt != null)
      .map((job) => ({
        // The event is the job FINISHING, so dedupe on completedAt. Keying on
        // createdAt would replay a long render that was submitted before the
        // last poll and only landed during this one.
        epochMilliSeconds: job.completedAt as number,
        data: toJobRow(job),
      }));
  },
};

export const finishedJobPolling = createTrigger({
  auth: rendobarAuth,
  name: 'finished_job_polling',
  classification: 'READ',
  displayName: 'Finished Job (Polling)',
  description: 'Checks every few minutes for finished jobs. Use when this Activepieces cannot receive webhooks.',
  aiMetadata: {
    description:
      'Fires once per Rendobar job that reaches a finished state, carrying that job\'s output file URL, cost and timing.',
  },
  props,
  outputSchema: JOB_OUTPUT_SCHEMA,
  type: TriggerStrategy.POLLING,
  sampleData: FINISHED_JOB_SAMPLE,
  async test(context) {
    return await pollingHelper.test(polling, context);
  },
  async onEnable(context) {
    await pollingHelper.onEnable(polling, context);
  },
  async onDisable(context) {
    await pollingHelper.onDisable(polling, context);
  },
  async run(context) {
    return await pollingHelper.poll(polling, context);
  },
});
