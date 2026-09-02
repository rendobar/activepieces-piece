import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import {
  getJobById,
  isTerminal,
  toJobRow,
  JOB_OUTPUT_SCHEMA,
  type Job,
} from '../common/job';
import {
  jobIdFromEnvelope,
  webhookRegistrationHelp,
  type WebhookEnvelope,
} from '../common/pure';
import { FINISHED_JOB_SAMPLE } from './sample';

/**
 * Fires the moment a job finishes, by registering a real webhook endpoint on
 * Rendobar for the lifetime of the flow.
 *
 * This is why the piece authenticates with an API key rather than OAuth.
 * Creating a webhook endpoint is account management — it returns a signing
 * secret and aims deliveries at any URL you name — so `POST /webhooks/endpoints`
 * refuses OAuth tokens. With a key the trigger is instant; the polling variant
 * exists for an Activepieces that Rendobar cannot reach.
 */

const OUTCOME_EVENTS: Record<string, string[]> = {
  complete: ['job.completed'],
  failed: ['job.failed'],
  any: ['job.completed', 'job.failed', 'job.cancelled'],
};

export const finishedJob = createTrigger({
  auth: rendobarAuth,
  name: 'finished_job',
  classification: 'READ',
  displayName: 'Finished Job',
  description: 'Starts the flow the moment a media job finishes.',
  aiMetadata: {
    description:
      "Fires once per Rendobar job that reaches a finished state, carrying that job's output file URL, cost and timing.",
  },
  type: TriggerStrategy.WEBHOOK,
  outputSchema: JOB_OUTPUT_SCHEMA,

  props: {
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
      description:
        'Only start on this job type, for example compress.target. Leave empty for all types. Rendobar delivers every finished job, so this is applied here.',
      required: false,
    }),
  },
  sampleData: FINISHED_JOB_SAMPLE,

  async onEnable(context) {
    const events = OUTCOME_EVENTS[context.propsValue.outcome ?? 'complete'] ?? OUTCOME_EVENTS['any'];

    try {
      const created = await rendobar<{ data: { id: string } }>(
        context.auth.secret_text,
        HttpMethod.POST,
        '/webhooks/endpoints',
        {
          // The API caps this at 50 characters.
          name: 'Activepieces',
          url: context.webhookUrl,
          subscribedEvents: events,
        },
      );
      await context.store.put('endpointId', created.data.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(webhookRegistrationHelp(reason));
    }
  },

  async onDisable(context) {
    const endpointId = await context.store.get<string>('endpointId');
    if (!endpointId) return;
    // Leaving it behind would keep delivering to a dead URL until Rendobar
    // auto-disables it after ten consecutive failures, and would burn one of
    // the ten endpoints an organization is allowed.
    await rendobar(
      context.auth.secret_text,
      HttpMethod.DELETE,
      `/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
    );
    await context.store.delete('endpointId');
  },

  async run(context) {
    const envelope = context.payload.body as WebhookEnvelope;
    const jobId = jobIdFromEnvelope(envelope);
    if (jobId === undefined) return [];

    const wanted = context.propsValue.jobType?.trim();
    if (wanted && envelope.data?.jobType !== wanted) return [];

    // The delivery carries a summary; the job read carries every column the
    // actions return. Re-reading keeps one row shape across the whole piece,
    // which is what lets a table built on Get Job work here unchanged.
    const job = await getJobById(context.auth.secret_text, jobId);
    return [toJobRow(job)];
  },

  async test(context) {
    // The builder's Test button needs data without waiting for a real job, so
    // this shows the most recent finished ones.
    const page = await rendobar<{ data: Job[] }>(
      context.auth.secret_text,
      HttpMethod.GET,
      '/jobs?limit=5&sort=created&order=desc&status=complete',
    );
    return page.data.filter((job) => isTerminal(job.status)).map(toJobRow);
  },
});
