import { vi } from 'vitest';
import { httpClient, type HttpMethod } from '@activepieces/pieces-common';

export type Sent = { method: HttpMethod; url: string; body?: unknown };

/**
 * Replaces the piece's one HTTP seam. Every request is recorded, and `reply`
 * answers it with a response or throws the Error it returns, which is how an
 * HttpError reaches the code under test.
 */
export function stubApi(reply: (sent: Sent) => { status: number; body?: unknown } | Error): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(httpClient, 'sendRequest').mockImplementation(async (request: { method: HttpMethod; url: string; body?: unknown }) => {
    const record: Sent = { method: request.method, url: request.url, body: request.body };
    sent.push(record);
    const out = reply(record);
    if (out instanceof Error) throw out;
    // The framework's HttpResponse has more members than any test reads.
    return { status: out.status, body: out.body, headers: {} } as never;
  });
  return sent;
}
