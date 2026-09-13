/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { HttpError } from '@activepieces/pieces-common';
import { findStorageConnections } from '../src/lib/actions/find-storage-connections';
import { listStorageFiles } from '../src/lib/actions/list-storage-files';
import { stubApi } from './helpers';

const run = (action: { run: (ctx: never) => Promise<unknown> }, propsValue: Record<string, unknown>) =>
  action.run({ auth: { secret_text: 'rb_key' }, propsValue } as never);

afterEach(() => vi.restoreAllMocks());

describe('Find Storage Connections', () => {
  it('returns one row per connection', async () => {
    stubApi(() => ({ status: 200, body: { data: [{ id: 'prod-media', provider: 's3', bucket: 'acme', region: 'eu-west-1' }], meta: { total: 1 } } }));
    expect(await run(findStorageConnections, {})).toEqual([
      { id: 'prod-media', provider: 's3', bucket: 'acme', region: 'eu-west-1', access: 'deliver', default_destination: false, pending: false },
    ]);
  });

  it('tells a key without storage access how to get one', async () => {
    stubApi(() => new HttpError({}, { status: 403, responseBody: { error: { code: 'INSUFFICIENT_SCOPE', message: 'This endpoint requires the storage:read scope.' } } } as never));
    await expect(run(findStorageConnections, {})).rejects.toThrow(/new API key/);
  });
});

describe('List Storage Files', () => {
  it('follows the cursor until the limit, then says the list was cut', async () => {
    const pages = [
      { folders: ['raw/2026/'], objects: [{ key: 'raw/a.mp4', size: 10, lastModified: 1_757_000_000_000 }], cursor: 'p2' },
      { folders: [], objects: [{ key: 'raw/b.mp4', size: 20, lastModified: null }, { key: 'raw/c.mp4', size: 30, lastModified: null }], cursor: 'p3' },
    ];
    const sent = stubApi(() => ({ status: 200, body: { data: pages.shift() } }));
    const out = await run(listStorageFiles, { storageId: 'prod-media', folder: 'raw/', limit: 3 });
    expect(sent[0]?.url).toContain('/storage/prod-media/objects?prefix=raw%2F');
    expect(sent[0]?.url).toContain('limit=3');
    expect(sent[1]?.url).toContain('cursor=p2');
    expect(sent[1]?.url).toContain('limit=1');
    expect(out).toEqual({
      folders: [{ path: 'raw/2026/', uri: 'storage://prod-media/raw/2026/' }],
      files: [
        { path: 'raw/a.mp4', size_bytes: 10, last_modified: 1_757_000_000_000, uri: 'storage://prod-media/raw/a.mp4' },
        { path: 'raw/b.mp4', size_bytes: 20, last_modified: null, uri: 'storage://prod-media/raw/b.mp4' },
      ],
      truncated: true,
    });
  });

  it('counts folders toward the limit too, so a page of folders alone can fill it in one request', async () => {
    const sent = stubApi(() => ({
      status: 200,
      body: { data: { folders: ['a/', 'b/', 'c/'], objects: [], cursor: 'p2' } },
    }));
    const out = await run(listStorageFiles, { storageId: 'prod-media', limit: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('limit=2');
    expect(out).toEqual({
      folders: [
        { path: 'a/', uri: 'storage://prod-media/a/' },
        { path: 'b/', uri: 'storage://prod-media/b/' },
      ],
      files: [],
      truncated: true,
    });
  });

  it('normalizes the folder before sending it as a prefix', async () => {
    const sent = stubApi(() => ({ status: 200, body: { data: { folders: [], objects: [], cursor: null } } }));
    await run(listStorageFiles, { storageId: 'prod-media', folder: ' /raw/2026 ', limit: 5 });
    expect(sent[0]?.url).toContain('prefix=raw%2F2026%2F');
  });

  it('refuses an empty or blank storage id before making any request', async () => {
    const sent = stubApi(() => ({ status: 200, body: { data: { folders: [], objects: [], cursor: null } } }));
    await expect(run(listStorageFiles, { storageId: '   ', limit: 5 })).rejects.toThrow(/storage connection/i);
    expect(sent).toHaveLength(0);
  });

  it('escapes %, ? and # in the uri but keeps the raw key in path', async () => {
    stubApi(() => ({
      status: 200,
      body: {
        data: {
          folders: [],
          objects: [
            { key: 'raw/clip#1.mp4', size: 1, lastModified: null },
            { key: '50%.mp4', size: 2, lastModified: null },
            { key: 'a?b.mp4', size: 3, lastModified: null },
            { key: 'raw exports/日本語 café.mp4', size: 4, lastModified: null },
          ],
          cursor: null,
        },
      },
    }));
    const out = await run(listStorageFiles, { storageId: 'prod-media', limit: 10 });
    expect(out).toEqual({
      folders: [],
      files: [
        { path: 'raw/clip#1.mp4', size_bytes: 1, last_modified: null, uri: 'storage://prod-media/raw/clip%231.mp4' },
        { path: '50%.mp4', size_bytes: 2, last_modified: null, uri: 'storage://prod-media/50%25.mp4' },
        { path: 'a?b.mp4', size_bytes: 3, last_modified: null, uri: 'storage://prod-media/a%3Fb.mp4' },
        {
          path: 'raw exports/日本語 café.mp4',
          size_bytes: 4,
          last_modified: null,
          uri: 'storage://prod-media/raw exports/日本語 café.mp4',
        },
      ],
      truncated: false,
    });
  });
});
