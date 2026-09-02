/// <reference types="vitest/globals" />
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { httpClient, HttpMethod } from '@activepieces/pieces-common';
import { createMockActionContext } from '@activepieces/pieces-framework';
import { uploadFile } from '../src/lib/actions/upload-file';

/**
 * Uploading must not hold the whole file in memory.
 *
 * A worker has about 1 GB and this piece exists to move media, so buffering a
 * video to upload it spends the file's entire size in that budget. These tests
 * assert the shape that avoids it: one part in memory at a time, never the
 * whole upload.
 */

const PART = 8;

type Sent = { method: HttpMethod; url: string; body?: unknown };

function stubApi(
  reply: (sent: Sent) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const sent: Sent[] = [];
  vi.spyOn(httpClient, 'sendRequest').mockImplementation(async (request: any) => {
    const record: Sent = { method: request.method, url: request.url, body: request.body };
    sent.push(record);
    const { status, body, headers } = reply(record);
    return { status, body, headers: headers ?? {} } as any;
  });
  return sent;
}

function multipartPlan(count: number) {
  return {
    status: 'multipart',
    data: { id: 'ast_1', url: 'https://api.rendobar.com/assets/ast_1/content' },
    upload: {
      uploadId: 'up_1',
      partSize: PART,
      expiresAt: 0,
      parts: Array.from({ length: count }, (_, i) => ({
        partNumber: i + 1,
        url: 'https://storage/part/' + (i + 1),
      })),
    },
  };
}

function context(file: unknown) {
  return {
    ...createMockActionContext({ propsValue: {} as never }),
    auth: { secret_text: 'rb_test_key' },
    propsValue: { file, keep: false },
  } as any;
}

const isPut = (s: Sent) => s.method === HttpMethod.PUT;
const isInit = (s: Sent) => s.method === HttpMethod.POST && s.url.endsWith('/assets');
const ETAG = { status: 200, headers: { etag: '"abc"' } };

function planReply(count: number) {
  return (r: Sent) =>
    isInit(r)
      ? { status: 200, body: multipartPlan(count) }
      : isPut(r)
        ? ETAG
        : { status: 200, body: {} };
}

afterEach(() => vi.restoreAllMocks());

describe('a large upload', () => {
  it('has not read the whole file by the time the first part is sent', async () => {
    // The assertion that actually distinguishes streaming from buffering.
    // Checking the PUT sizes does not: they are one part either way, which is
    // why an earlier version of this test passed against a buffered
    // implementation. What only streaming can do is send part 1 before the rest
    // of the file has been read.
    let emitted = 0;
    let readWhenFirstPutFired: number | undefined;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 3; i++) {
          emitted += PART;
          yield Buffer.alloc(PART, 1);
        }
      })(),
    );

    const sent = stubApi((r) => {
      if (isPut(r) && readWhenFirstPutFired === undefined) readWhenFirstPutFired = emitted;
      return isInit(r)
        ? { status: 200, body: multipartPlan(3) }
        : isPut(r)
          ? ETAG
          : { status: 200, body: {} };
    });

    await uploadFile.run(context({ filename: 'v.mp4', size: PART * 3, body: source }));

    expect(sent.filter(isPut)).toHaveLength(3);
    expect(readWhenFirstPutFired).toBeLessThan(PART * 3);
  });

  it('sends each part to its own URL, in order', async () => {
    const bytes = Buffer.alloc(PART * 3, 1);
    const sent = stubApi(planReply(3));

    await uploadFile.run(
      context({ filename: 'v.mp4', size: bytes.length, body: Readable.from(bytes) }),
    );

    const puts = sent.filter(isPut);
    for (const put of puts) expect((put.body as Buffer).length).toBe(PART);
    expect(puts.map((p) => p.url)).toEqual([
      'https://storage/part/1',
      'https://storage/part/2',
      'https://storage/part/3',
    ]);
  });

  it('finalizes with an ETag per part, in order', async () => {
    const bytes = Buffer.alloc(PART * 2, 1);
    const sent = stubApi(planReply(2));

    await uploadFile.run(
      context({ filename: 'v.mp4', size: bytes.length, body: Readable.from(bytes) }),
    );

    const complete = sent.find((s) => s.url.includes('/complete'));
    expect((complete?.body as any).parts).toEqual([
      { partNumber: 1, etag: 'abc' },
      { partNumber: 2, etag: 'abc' },
    ]);
  });

  it('refuses when the stream ends before the parts do', async () => {
    stubApi(planReply(3));

    await expect(
      uploadFile.run(
        context({
          filename: 'v.mp4',
          size: PART * 3,
          body: Readable.from(Buffer.alloc(PART, 1)),
        }),
      ),
    ).rejects.toThrow(/ended after 1 of 3 parts/);
  });

  it('refuses when the stream outlasts the parts', async () => {
    stubApi(planReply(1));

    await expect(
      uploadFile.run(
        context({
          filename: 'v.mp4',
          size: PART,
          body: Readable.from(Buffer.alloc(PART * 3, 1)),
        }),
      ),
    ).rejects.toThrow(/larger than the upload Rendobar prepared/);
  });
});

describe('measuring the file', () => {
  it('uses the size the source reported', async () => {
    const sent = stubApi(planReply(1));

    await uploadFile.run(
      context({ filename: 'v.mp4', size: PART, body: Readable.from(Buffer.alloc(PART, 1)) }),
    );

    expect((sent.find(isInit)?.body as any).size).toBe(PART);
  });

  it('reads the file once to measure it when the source reports no length', async () => {
    const bytes = Buffer.alloc(PART * 2, 1);
    const sent = stubApi(planReply(2));

    await uploadFile.run(
      context({ filename: 'v.mp4', size: undefined, body: Readable.from(bytes) }),
    );

    expect((sent.find(isInit)?.body as any).size).toBe(PART * 2);
    expect(sent.filter(isPut)).toHaveLength(2);
  });

  it('still accepts a buffered file from an older engine', async () => {
    const sent = stubApi((r) =>
      isInit(r)
        ? {
            status: 200,
            body: {
              status: 'presigned',
              data: { id: 'ast_1', url: 'https://api.rendobar.com/assets/ast_1/content' },
              upload: { method: 'PUT', url: 'https://storage/one', expiresAt: 0 },
            },
          }
        : isPut(r)
          ? ETAG
          : { status: 200, body: {} },
    );

    const result: any = await uploadFile.run(
      context({ filename: 'small.png', extension: 'png', data: Buffer.alloc(4, 1) }),
    );

    expect((sent.find(isInit)?.body as any).size).toBe(4);
    expect(sent.filter(isPut)).toHaveLength(1);
    expect(result.size_bytes).toBe(4);
  });
});

describe('a file already stored', () => {
  it('uploads nothing when Rendobar recognises it by checksum', async () => {
    const sent = stubApi(() => ({
      status: 200,
      body: {
        status: 'deduplicated',
        data: { id: 'ast_1', url: 'https://api.rendobar.com/assets/ast_1/content' },
      },
    }));

    const result: any = await uploadFile.run(
      context({ filename: 'v.mp4', size: PART, body: Readable.from(Buffer.alloc(PART, 1)) }),
    );

    expect(sent.filter(isPut)).toHaveLength(0);
    expect(result.reused_existing).toBe(true);
  });
});
