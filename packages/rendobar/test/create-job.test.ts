/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { httpClient, HttpMethod } from '@activepieces/pieces-common';
import { ExecutionType, createMockActionContext } from '@activepieces/pieces-framework';
import { createJob } from '../src/lib/actions/create-job';

/**
 * The action's decision tree, run against the real framework.
 *
 * `pure.ts` covers each decision on its own, in the rendobar monorepo. What
 * only shows up here is their COMPOSITION: which branch actually pauses, what
 * body is submitted, and whether the resume path reads the job it was told of.
 *
 * `createMockActionContext` cannot drive this action on its own. Its `run`
 * still carries the deprecated `pause` and has no `createWaitpoint` or
 * `waitForWaitpoint`, which is what a pausing action calls. That is why no
 * waitpoint piece in the catalog has tests. The hooks are supplied below rather
 * than the action being reshaped to suit the helper.
 */

type Sent = { method: HttpMethod; url: string; body?: unknown };

function stubApi(reply: (sent: Sent) => { status: number; body: unknown }) {
  const sent: Sent[] = [];
  vi.spyOn(httpClient, 'sendRequest').mockImplementation(async (request: any) => {
    const record: Sent = { method: request.method, url: request.url, body: request.body };
    sent.push(record);
    const { status, body } = reply(record);
    return { status, body, headers: {} } as any;
  });
  return sent;
}

const RESUME_URL = 'https://cloud.activepieces.com/api/v1/resume/wp_1';

function waitpointHooks(resumeUrl: string, onPause: (id: string) => void) {
  return {
    id: 'run_1',
    createWaitpoint: async () => ({ id: 'wp_1', resumeUrl, buildResumeUrl: () => resumeUrl }),
    waitForWaitpoint: onPause,
  };
}

function context(props: Record<string, unknown> = {}, resumeUrl: string = RESUME_URL) {
  const base = createMockActionContext({ propsValue: {} as never });
  const paused: string[] = [];
  const ctx = {
    ...base,
    auth: { secret_text: 'rb_test_key' },
    propsValue: {
      jobType: 'ffmpeg',
      params: {},
      inputs: {},
      waitForResult: true,
      maxWaitSeconds: 1,
      downloadOutput: false,
      ...props,
    },
    run: waitpointHooks(resumeUrl, (id: string) => paused.push(id)),
    step: { name: 'step_1' },
  } as any;
  return { ctx, paused };
}

const ACCEPTED = { status: 201, body: { data: { id: 'job_1', status: 'waiting' } } };
const DONE = {
  status: 200,
  body: {
    data: {
      id: 'job_1',
      type: 'ffmpeg',
      status: 'complete',
      output: { file: { url: 'https://cdn/x.mp4' } },
    },
  },
};
const isPost = (s: Sent) => s.method === HttpMethod.POST;

afterEach(() => vi.restoreAllMocks());

describe('waiting', () => {
  it('pauses on a waitpoint and hands Rendobar its resume URL', async () => {
    const sent = stubApi((r) => (isPost(r) ? ACCEPTED : DONE));
    const { ctx, paused } = context();

    await createJob.run(ctx);

    expect((sent.find(isPost)?.body as any).callback.url).toBe(RESUME_URL);
    expect(paused).toEqual(['wp_1']);
    // Paused means it must not have sat there polling for the result.
    expect(sent.filter((s) => s.method === HttpMethod.GET)).toHaveLength(0);
  });

  it('does not pause when the key matched a job submitted earlier', async () => {
    // That job carries the EARLIER call's callback URL, so nothing would ever
    // resume this waitpoint and the flow would hang for its full 30 days.
    const sent = stubApi((r) =>
      isPost(r)
        ? { status: 200, body: { data: { id: 'job_1', status: 'waiting', idempotent: true } } }
        : DONE,
    );
    const { ctx, paused } = context();

    await createJob.run(ctx);

    expect(paused).toEqual([]);
    expect(sent.some((s) => s.method === HttpMethod.GET)).toBe(true);
  });

  it('does not pause when a sync job type already finished', async () => {
    // Its callback is dispatched from the same request that answered us, so it
    // can land before the run is even marked paused.
    const sent = stubApi((r) =>
      isPost(r) ? { status: 200, body: { data: { id: 'job_1', status: 'complete' } } } : DONE,
    );
    const { ctx, paused } = context({ jobType: 'qr.generate' });

    await createJob.run(ctx);

    expect(paused).toEqual([]);
    expect(sent.some((s) => s.method === HttpMethod.GET)).toBe(true);
  });

  it('sends no callback and polls when the resume URL is unreachable', async () => {
    const sent = stubApi((r) => (isPost(r) ? ACCEPTED : DONE));
    const { ctx, paused } = context({}, 'http://localhost:8080/resume/wp_1');

    await createJob.run(ctx);

    expect(paused).toEqual([]);
    // Attaching it would have the API refuse the submit with a 400, so the job
    // would never run at all.
    expect((sent.find(isPost)?.body as any).callback).toBeUndefined();
  });

  it('creates no waitpoint at all when the user did not ask to wait', async () => {
    stubApi((r) => (isPost(r) ? ACCEPTED : DONE));
    const { ctx, paused } = context({ waitForResult: false });

    await createJob.run(ctx);

    expect(paused).toEqual([]);
  });
});

describe('the idempotency key', () => {
  it('is unchanged by the callback URL, so a retry cannot bill twice', async () => {
    // The regression this guards, visible only at this level: the callback
    // carries a fresh waitpoint URL on every attempt. If it fed the key, each
    // retry would submit and bill a new job.
    const keys: string[] = [];

    for (const url of ['https://cloud.activepieces.com/resume/AAA', 'https://cloud.activepieces.com/resume/BBB']) {
      const sent = stubApi((r) => (isPost(r) ? ACCEPTED : DONE));
      const { ctx } = context({}, url);
      await createJob.run(ctx);
      keys.push((sent.find(isPost)?.body as any).idempotencyKey);
      vi.restoreAllMocks();
    }

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain('activepieces:run_1:step_1:');
  });
});

describe('resuming', () => {
  it('reads the job the callback names rather than trusting the body', async () => {
    const sent = stubApi(() => DONE);
    const { ctx } = context();
    ctx.executionType = ExecutionType.RESUME;
    ctx.resumePayload = { body: { event: 'job.completed', data: { jobId: 'job_1' } } };

    const row: any = await createJob.run(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/jobs/job_1');
    expect(row.status).toBe('complete');
    expect(row.file_url).toBe('https://cdn/x.mp4');
  });

  it('says what to do when resumed by something that names no job', async () => {
    stubApi(() => DONE);
    const { ctx } = context();
    ctx.executionType = ExecutionType.RESUME;
    ctx.resumePayload = { body: { hello: 'world' } };

    // Anything can POST to a resume URL, so this must be a clear step error.
    await expect(createJob.run(ctx)).rejects.toThrow(/names no job/);
  });
});
