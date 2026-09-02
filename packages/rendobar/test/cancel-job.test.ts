/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { httpClient, HttpMethod, HttpError } from '@activepieces/pieces-common';
import { createMockActionContext } from '@activepieces/pieces-framework';
import { cancelJob } from '../src/lib/actions/cancel-job';

/**
 * Cancelling has to survive being run twice.
 *
 * Rendobar refuses to cancel a job that is no longer cancellable, and answers
 * one 409 for two very different situations. Already cancelled means the
 * outcome this step asked for holds, so a retry must succeed. Already finished
 * means the cancel never happened, and reporting success there would be a lie
 * about the flow's own history.
 */

type Sent = { method: HttpMethod; url: string };

function stub(reply: (s: Sent) => { status: number; body?: unknown } | Error) {
  const sent: Sent[] = [];
  vi.spyOn(httpClient, 'sendRequest').mockImplementation(async (request: any) => {
    const record: Sent = { method: request.method, url: request.url };
    sent.push(record);
    const out = reply(record);
    if (out instanceof Error) throw out;
    return { status: out.status, body: out.body, headers: {} } as any;
  });
  return sent;
}

// The constructor takes `responseBody`, not `body`.
const conflict = () =>
  new HttpError({}, {
    status: 409,
    responseBody: { error: { code: 'CONFLICT', message: 'Cannot cancel job in "complete" status.' } },
  } as any);

const job = (status: string) => ({ id: 'job_1', type: 'ffmpeg', status });
const ctx = () => ({
  ...createMockActionContext({ propsValue: {} as never }),
  auth: { secret_text: 'rb_key' },
  propsValue: { jobId: 'job_1' },
}) as any;

afterEach(() => vi.restoreAllMocks());

describe('cancelling a job', () => {
  it('returns the cancelled job', async () => {
    const sent = stub(() => ({ status: 200, body: { data: job('cancelled') } }));
    const out: any = await cancelJob.run(ctx());

    expect(out.status).toBe('cancelled');
    expect(sent).toHaveLength(1);
  });

  it('succeeds on a retry, because the job is already cancelled', async () => {
    const sent = stub((s) =>
      s.method === HttpMethod.POST ? conflict() : { status: 200, body: { data: job('cancelled') } },
    );

    const out: any = await cancelJob.run(ctx());

    expect(out.status).toBe('cancelled');
    expect(sent.map((s) => s.method)).toEqual([HttpMethod.POST, HttpMethod.GET]);
  });

  it('still fails when the job finished instead of cancelling', async () => {
    // The cancel genuinely did not happen. Saying otherwise would tell the flow
    // it stopped work that in fact ran to completion and was billed.
    stub((s) =>
      s.method === HttpMethod.POST ? conflict() : { status: 200, body: { data: job('complete') } },
    );
    await expect(cancelJob.run(ctx())).rejects.toThrow();
  });

  it('does not treat a non-conflict failure as recoverable', async () => {
    stub(() => new HttpError({}, { status: 404, responseBody: { error: { code: 'NOT_FOUND' } } } as any));
    await expect(cancelJob.run(ctx())).rejects.toThrow();
  });

  it('refuses a step that was given no job', async () => {
    stub(() => ({ status: 200, body: { data: job('cancelled') } }));
    const c = ctx();
    c.propsValue = { jobId: '  ' };
    await expect(cancelJob.run(c)).rejects.toThrow(/No job was given/);
  });
});
