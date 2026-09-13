/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { finishedJob } from '../src/lib/triggers/finished-job';
import { stubApi } from './helpers';

const settled = { event: 'job.deliveries_settled', data: { jobId: 'job_1', deliveries: [] } };
const job = { id: 'job_1', type: 'ffmpeg', status: 'complete', deliveries: [{ storageId: 'prod-media', status: 'delivered' }] };
const run = (jobType: string) =>
  finishedJob.run({ auth: { secret_text: 'rb_key' }, propsValue: { outcome: 'delivered', jobType }, payload: { body: settled } } as never);

afterEach(() => vi.restoreAllMocks());

describe('Finished Job trigger, deliveries settled', () => {
  it('subscribes to job.deliveries_settled for that outcome', async () => {
    const sent = stubApi(() => ({ status: 201, body: { data: { id: 'whe_1' } } }));
    await finishedJob.onEnable({
      auth: { secret_text: 'rb_key' },
      propsValue: { outcome: 'delivered' },
      webhookUrl: 'https://cloud.activepieces.com/api/v1/webhooks/flow_1',
      store: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
    } as never);
    expect(sent[0]?.body).toMatchObject({ subscribedEvents: ['job.deliveries_settled'] });
  });

  it('matches a Job Type filter against the job itself, since that event carries no type', async () => {
    stubApi(() => ({ status: 200, body: { data: job } }));
    const rows = await run('ffmpeg');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'job_1', deliveries: job.deliveries });
  });

  it('still drops a job of another type', async () => {
    stubApi(() => ({ status: 200, body: { data: job } }));
    expect(await run('compress.target')).toEqual([]);
  });
});
