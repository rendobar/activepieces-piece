/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { findJobs } from '../src/lib/actions/find-jobs';
import { stubApi } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('Find Jobs', () => {
  it('reports deliveries as not available, since GET /jobs omits them', async () => {
    stubApi(() => ({
      status: 200,
      body: { data: [{ id: 'job_1', type: 'ffmpeg', status: 'complete' }] },
    }));
    const rows = await findJobs.run({ auth: { secret_text: 'rb_key' }, propsValue: {} } as never);
    expect(rows).toMatchObject([{ deliveries: null }]);
  });
});
