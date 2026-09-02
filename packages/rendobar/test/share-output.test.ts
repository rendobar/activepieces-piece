/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { httpClient, HttpMethod, HttpError } from '@activepieces/pieces-common';
import { createMockActionContext } from '@activepieces/pieces-framework';
import { shareOutput } from '../src/lib/actions/share-output';

/**
 * Sharing has to survive being run twice.
 *
 * A flow re-run, or a step retry, shares a job that is already shared. Rendobar
 * answers 409 there. Failing would make the action unsafe to retry and would
 * break any flow that re-runs, so the existing link is fetched instead. These
 * tests pin that recovery, and pin that it does NOT swallow other conflicts.
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

function conflict(code: string, message: string) {
  // The constructor takes `responseBody`, not `body`. Getting that wrong builds
  // an HttpError whose `.response.body` is undefined, so every check against it
  // silently falls through — which is exactly how the first run of this test
  // "failed" against correct code.
  return new HttpError({}, { status: 409, responseBody: { error: { code, message } } } as any);
}

const ctx = () => ({
  ...createMockActionContext({ propsValue: {} as never }),
  auth: { secret_text: 'rb_key' },
  propsValue: { jobId: 'job_1' },
}) as any;

const SHARED = {
  status: 201,
  body: { data: { shareId: 'shr_1', shareUrl: 'https://cdn.rendobar.com/shared/shr_1/output.webp' } },
};

afterEach(() => vi.restoreAllMocks());

describe('sharing an output', () => {
  it('returns the new public link', async () => {
    const sent = stub(() => SHARED);
    const out: any = await shareOutput.run(ctx());

    expect(out.shareUrl).toBe('https://cdn.rendobar.com/shared/shr_1/output.webp');
    expect(out.already_shared).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe(HttpMethod.POST);
  });

  it('returns the existing link when the job was already shared', async () => {
    // The retry-safety this action claims with `idempotent: true`.
    const sent = stub((s) =>
      s.method === HttpMethod.POST
        ? conflict('CONFLICT', 'This job output is already shared.')
        : { status: 200, body: { data: { shareId: 'shr_1', shareUrl: 'https://cdn/x.webp', createdAt: 1 } } },
    );

    const out: any = await shareOutput.run(ctx());

    expect(out.shareUrl).toBe('https://cdn/x.webp');
    expect(out.already_shared).toBe(true);
    expect(sent.map((s) => s.method)).toEqual([HttpMethod.POST, HttpMethod.GET]);
  });

  it('raises a 409 that is not an already-shared conflict', async () => {
    // The GET deliberately SUCCEEDS here. An earlier version of this test made
    // it fail too, so an action that recovered from every 409 still rejected
    // and the test passed against broken code. The read has to work for the
    // over-broad recovery to be observable.
    const sent = stub((s) =>
      s.method === HttpMethod.POST
        ? conflict('SOMETHING_ELSE', 'A different conflict.')
        : { status: 200, body: { data: { shareId: 'shr_x', shareUrl: 'https://cdn/x.webp' } } },
    );

    await expect(shareOutput.run(ctx())).rejects.toThrow();
    // And it must not have gone looking for a link it had no business fetching.
    expect(sent.map((s) => s.method)).toEqual([HttpMethod.POST]);
  });

  it('raises when the conflict is real but the link has since gone', async () => {
    // POST says shared, GET says not. Returning null as a share URL would be
    // worse than failing.
    stub((s) =>
      s.method === HttpMethod.POST
        ? conflict('CONFLICT', 'already shared')
        : { status: 200, body: { data: null } },
    );
    await expect(shareOutput.run(ctx())).rejects.toThrow();
  });

  it('refuses a step that was given no job', async () => {
    stub(() => SHARED);
    const c = ctx();
    c.propsValue = { jobId: '' };
    await expect(shareOutput.run(c)).rejects.toThrow(/No job was given/);
  });

  it('does not recover from a non-conflict failure', async () => {
    stub(() => new HttpError({}, { status: 400, responseBody: { error: { code: 'VALIDATION_ERROR' } } } as any));
    await expect(shareOutput.run(ctx())).rejects.toThrow();
  });
});
