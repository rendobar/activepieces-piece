import type { DropdownState } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobar } from './client';
import { storageAdvice } from './pure';

/** A connection as `GET /storage` returns it: the fields this piece reads. */
export type StorageConnection = {
  id: string;
  provider: string;
  bucket: string;
  region?: string;
  access?: 'read';
  pending?: true;
  defaultDestination?: true;
};

export type StorageRow = {
  id: string;
  provider: string;
  bucket: string;
  region: string | null;
  access: 'read' | 'deliver';
  default_destination: boolean;
  pending: boolean;
};

export async function listConnections(token: string): Promise<StorageConnection[]> {
  const { data } = await rendobar<{ data: StorageConnection[] }>(token, HttpMethod.GET, '/storage');
  return data;
}

/**
 * The options for every connection dropdown in the piece. `writableOnly` keeps
 * the ones a job can deliver to: the API refuses a read-only connection as a
 * destination, and a pending one cannot write yet.
 */
export async function connectionDropdown(token: string | undefined, writableOnly: boolean): Promise<DropdownState<string>> {
  if (!token) return { disabled: true, options: [], placeholder: 'Please connect your account first' };
  try {
    const usable = (await listConnections(token)).filter((c) => !writableOnly || (c.access !== 'read' && c.pending !== true));
    if (usable.length === 0) {
      return { disabled: true, options: [], placeholder: 'No storage to use here. Connect a bucket on the Storage page first.' };
    }
    return { disabled: false, options: usable.map((c) => ({ label: `${c.id} (${c.provider}, ${c.bucket})`, value: c.id })) };
  } catch (error) {
    return { disabled: true, options: [], placeholder: storageAdvice(error) };
  }
}

/** One connection as a flat row. The endpoint and credentials stay out: a flow acts on the id. */
export function toStorageRow(c: StorageConnection): StorageRow {
  return {
    id: c.id,
    provider: c.provider,
    bucket: c.bucket,
    region: c.region ?? null,
    access: c.access === 'read' ? 'read' : 'deliver',
    default_destination: c.defaultDestination === true,
    pending: c.pending === true,
  };
}
