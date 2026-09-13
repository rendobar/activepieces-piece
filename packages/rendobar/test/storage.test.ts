/// <reference types="vitest/globals" />
import { vi } from 'vitest';
import { HttpError } from '@activepieces/pieces-common';
import { connectionDropdown, toStorageRow, type StorageConnection } from '../src/lib/common/storage';
import { stubApi } from './helpers';

// Typed explicitly: an untyped array literal widens `true`/'read'` to
// `boolean`/`string`, which then fails `toStorageRow`'s `StorageConnection`
// parameter (its optional fields are the literal types `true` and `'read'`).
const CONNECTIONS: StorageConnection[] = [
  { id: 'prod-media', provider: 's3', bucket: 'acme', region: 'eu-west-1', defaultDestination: true },
  { id: 'raw', provider: 'r2', bucket: 'raw', region: 'auto', access: 'read' },
  { id: 'new-aws', provider: 's3', bucket: 'incoming', region: 'us-east-1', pending: true },
];
const answer = (data: unknown[]) => stubApi(() => ({ status: 200, body: { data, meta: { total: data.length } } }));

afterEach(() => vi.restoreAllMocks());

describe('connectionDropdown', () => {
  it('offers only connections a job can write to when asked for destinations', async () => {
    answer(CONNECTIONS);
    expect(await connectionDropdown('rb_key', true)).toEqual({
      disabled: false,
      options: [{ label: 'prod-media (s3, acme)', value: 'prod-media' }],
    });
  });

  it('offers every connection for browsing', async () => {
    answer(CONNECTIONS);
    const state = await connectionDropdown('rb_key', false);
    expect(state.options.map((o) => o.value)).toEqual(['prod-media', 'raw', 'new-aws']);
  });

  it('says to connect a bucket when none qualifies, and to connect the account without auth', async () => {
    answer([CONNECTIONS[1]]);
    expect(await connectionDropdown('rb_key', true)).toMatchObject({ disabled: true, placeholder: expect.stringContaining('Storage page') });
    expect(await connectionDropdown(undefined, true)).toMatchObject({ disabled: true, placeholder: expect.stringContaining('connect your account') });
  });

  it('turns a key without storage access into the fix', async () => {
    stubApi(() => new HttpError({}, { status: 403, responseBody: { error: { code: 'INSUFFICIENT_SCOPE', message: 'This endpoint requires the storage:read scope.' } } } as never));
    expect(await connectionDropdown('rb_key', true)).toMatchObject({ disabled: true, placeholder: expect.stringContaining('new API key') });
  });
});

describe('toStorageRow', () => {
  it('is one flat row with what a flow acts on', () => {
    expect(toStorageRow(CONNECTIONS[1])).toEqual({
      id: 'raw',
      provider: 'r2',
      bucket: 'raw',
      region: 'auto',
      access: 'read',
      default_destination: false,
      pending: false,
    });
  });
});
