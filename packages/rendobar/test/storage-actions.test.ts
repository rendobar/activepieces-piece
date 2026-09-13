/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { HttpError } from '@activepieces/pieces-common';
import { findStorage } from '../src/lib/actions/find-storage';
import { listStorageFiles } from '../src/lib/actions/list-storage-files';
import { stubApi } from './helpers';

const run = (action: { run: (ctx: never) => Promise<unknown> }, propsValue: Record<string, unknown>) =>
  action.run({ auth: { secret_text: 'rb_key' }, propsValue } as never);

afterEach(() => vi.restoreAllMocks());

describe('Find Storage Connections', () => {
  it('returns one row per connection', async () => {
    stubApi(() => ({ status: 200, body: { data: [{ id: 'prod-media', provider: 's3', bucket: 'acme', region: 'eu-west-1' }], meta: { total: 1 } } }));
    expect(await run(findStorage, {})).toEqual([
      { id: 'prod-media', provider: 's3', bucket: 'acme', region: 'eu-west-1', access: 'deliver', default_destination: false, pending: false },
    ]);
  });

  it('tells a key without storage access how to get one', async () => {
    stubApi(() => new HttpError({}, { status: 403, responseBody: { error: { code: 'INSUFFICIENT_SCOPE', message: 'This endpoint requires the storage:read scope.' } } } as never));
    await expect(run(findStorage, {})).rejects.toThrow(/new API key/);
  });
});

describe('List Storage Files', () => {
  it('follows the cursor until the limit, then says the list was cut', async () => {
    const pages = [
      { folders: ['raw/2026/'], objects: [{ key: 'raw/a.mp4', size: 10, lastModified: 1_757_000_000_000 }], cursor: 'p2' },
      { folders: [], objects: [{ key: 'raw/b.mp4', size: 20, lastModified: null }, { key: 'raw/c.mp4', size: 30, lastModified: null }], cursor: 'p3' },
    ];
    const sent = stubApi(() => ({ status: 200, body: { data: pages.shift() } }));
    const out = await run(listStorageFiles, { storageId: 'prod-media', folder: 'raw/', limit: 2 });
    expect(sent[0]?.url).toContain('/storage/prod-media/objects?prefix=raw%2F');
    expect(sent[1]?.url).toContain('cursor=p2');
    expect(out).toEqual({
      folders: [{ path: 'raw/2026/', uri: 'storage://prod-media/raw/2026/' }],
      files: [
        { path: 'raw/a.mp4', size_bytes: 10, last_modified: 1_757_000_000_000, uri: 'storage://prod-media/raw/a.mp4' },
        { path: 'raw/b.mp4', size_bytes: 20, last_modified: null, uri: 'storage://prod-media/raw/b.mp4' },
      ],
      truncated: true,
    });
  });
});
