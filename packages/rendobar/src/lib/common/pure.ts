/**
 * The decisions that cost money or hang a flow, with no framework behind them.
 *
 * Everything here is a pure function of its arguments: no HTTP, no Activepieces
 * context, no clock. That is deliberate and is not architecture for its own
 * sake. A piece only builds inside the Activepieces monorepo, so anything that
 * imports `@activepieces/*` cannot be tested from this repo, and a test that
 * only runs somewhere else is a test that never runs. Keeping this logic import
 * free is what lets `packages/shared` exercise it in the same CI that guards
 * every other contract these connectors depend on.
 *
 * Two classes of bug live here, and neither is visible in a type:
 *   - a wrong fingerprint bills a customer twice
 *   - a wrong reachability answer pauses a flow that nothing will ever resume
 */

// ── Idempotency ─────────────────────────────────────────────────────────────

/**
 * A stable fingerprint of a submission.
 *
 * FNV-1a over canonical JSON. Not a security boundary: it only has to make two
 * different submissions produce different keys, and the same submission rebuild
 * the same one.
 *
 * Keys are sorted at every level, because `{a,b}` and `{b,a}` are the same
 * request and must not bill twice.
 */
export function fingerprint(value: unknown): string {
  let hash = 0x811c9dc5;
  const json = canonical(value);
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

// ── Callback delivery ───────────────────────────────────────────────────────

/**
 * Whether Rendobar could POST a callback to this URL.
 *
 * Mirrors the server's `validateWebhookUrl` (apps/api/src/lib/webhooks.ts).
 * Checked here rather than discovered from a 400, because the alternative is
 * submitting a job, having the URL rejected, and submitting a second one, which
 * is the exact double charge {@link fingerprint} exists to prevent.
 *
 * Being STRICTER than the server is safe: the flow polls instead of pausing.
 * Being LOOSER is not: the callback is attached, the submit is refused with a
 * 400, and the job never runs at all. Keep the two in step in that direction.
 */
export function isPubliclyReachable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  return (
    ![
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^0\./,
      /^\[::1\]$/,
      /^\[::\]$/,
      /^\[fc00:/,
      /^\[fe80:/,
      /\.internal$/,
      /\.local$/,
      /^169\.254\./, // cloud metadata (AWS/GCP/Azure)
      /^100\.100\./, // Alibaba metadata
      // IPv4-mapped IPv6. The URL parser canonicalises these to hex groups, so
      // [::ffff:7f00:1] IS 127.0.0.1 and the dotted patterns never see it.
      /^\[::ffff:/,
    ].some((pattern) => pattern.test(host)) &&
    !host.endsWith('.workers.dev') &&
    !host.endsWith('.pages.dev')
  );
}

/** The `data` of a `POST /jobs` response, as far as the pause decision cares. */
export type SubmitData = { id: string; status?: string; idempotent?: boolean };

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

/**
 * Whether a callback is still coming for THIS submission.
 *
 * False means pausing would hang the flow for the waitpoint's full 30 days, so
 * the caller must fall back to polling. Two answers mean no:
 *
 *   idempotent  the key matched a job submitted earlier, which carries the
 *               EARLIER call's callback URL. Rendobar resumes that waitpoint.
 *   terminal    a sync job type ran inline. Its callback is dispatched from the
 *               same request that answered us, so it can land before the run is
 *               even marked paused, and a resume that arrives first is lost.
 */
export function callbackStillComing(data: SubmitData): boolean {
  if (data.idempotent === true) return false;
  if (typeof data.status === 'string' && TERMINAL.has(data.status)) return false;
  return true;
}

// ── Callback body ───────────────────────────────────────────────────────────

/**
 * The envelope Rendobar POSTs to a webhook endpoint AND to a per-job callback.
 * Identical for both, which is what lets the Finished Job trigger and the
 * paused Run a Media Job step read one body with one implementation.
 */
export type WebhookEnvelope = {
  event?: string;
  data?: { jobId?: string; jobType?: string; status?: string };
};

/**
 * The job id out of a callback body, or undefined if this is not one.
 *
 * The id is all that is taken. The finished shape always comes from a fresh
 * read, because the envelope is a notification and the job is the truth: a body
 * that arrived late, was replayed or was truncated still names a job whose
 * current state can be looked up.
 */
export function jobIdFromEnvelope(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const jobId = (body as WebhookEnvelope).data?.jobId;
  return typeof jobId === 'string' && jobId !== '' ? jobId : undefined;
}

// ── Diagnosing a refusal ────────────────────────────────────────────────────

/**
 * Turn a failed webhook registration into advice that matches the cause.
 *
 * Two very different problems land in the same catch and need opposite fixes:
 *
 *   403 INSUFFICIENT_SCOPE  the key is valid and jobs run fine, but it was
 *                           narrowed and cannot manage webhook endpoints. The
 *                           fix is a key with `webhooks:write`.
 *   anything else           usually this Activepieces is not reachable from the
 *                           internet, so there is nowhere to deliver to. The
 *                           fix is the polling trigger.
 *
 * Reported as one message before, which sent a scope problem to go and check
 * its network. A least-privilege key is the likely case now that Rendobar keys
 * carry scopes, and it is exactly the caller who reads the advice carefully.
 */
export function webhookRegistrationHelp(reason: string): string {
  const scoped = /insufficient[_ ]scope|requires the [a-z]+:[a-z]+ scope/i.test(reason);
  return scoped
    ? `Rendobar refused to register a webhook for this flow: ${reason} ` +
        'Create a key that includes the webhooks:write scope, or use the Finished Job (Polling) trigger, which needs no extra scope.'
    : `Rendobar could not register a webhook for this flow: ${reason} ` +
        'If this Activepieces is not reachable from the internet, use the Finished Job (Polling) trigger instead.';
}

/**
 * A required identifier, trimmed, or a message naming the problem.
 *
 * Shared by every "which field is wrong" guard below rather than each
 * duplicating the same trim-or-throw, since only the message differs.
 */
function requireNonEmpty(value: unknown, message: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') throw new Error(message);
  return trimmed;
}

/**
 * The job id a step was given, or a message naming the problem.
 *
 * An unset id is the common case, not an exotic one: a dropdown left untouched,
 * or an expression like `{{step_1.id}}` that pointed at nothing and resolved to
 * an empty string. Passing it through builds `/jobs/` and Rendobar answers
 * "Route not found", which tells the person nothing about which step is wrong
 * or what to do. Measured against a live Activepieces before this existed.
 */
export function requireJobId(jobId: unknown): string {
  return requireNonEmpty(
    jobId,
    'No job was given. Pick one from the dropdown, or check that the field referencing an earlier step resolves to a job id.',
  );
}

/**
 * The storage connection id a step was given, or a message naming the problem.
 *
 * Same reasoning as {@link requireJobId}: an empty id would otherwise build
 * `/storage//objects` and Rendobar would answer "Route not found", naming
 * neither the step at fault nor the fix.
 */
export function requireStorageId(storageId: unknown): string {
  return requireNonEmpty(
    storageId,
    'No storage connection was given. Pick one from the Connection dropdown, or check that the field referencing an earlier step resolves to a connection id.',
  );
}

/**
 * Fail the step when the job itself failed.
 *
 * Without this a job that failed on Rendobar still produced a GREEN step
 * carrying `succeeded: false`, so the flow's error path never ran and the
 * author had to remember to test a field by hand. Every other step in a flow
 * fails when its work fails; this one quietly did not.
 *
 * Off is a real choice, not a legacy escape: a failure is sometimes an outcome
 * to branch on rather than a fault. AssemblyAI exposes the same switch for the
 * same reason, and also defaults it on.
 *
 * A job still RUNNING is not a failure. Waiting can hit its own deadline while
 * the job carries on, and turning that into a step error would report a
 * timeout as a broken job.
 */
export function raiseIfJobFailed(
  row: { status?: unknown; error_code?: unknown; error_message?: unknown },
  fail: boolean,
): void {
  if (!fail) return;
  const status = typeof row.status === 'string' ? row.status : '';
  if (status !== 'failed' && status !== 'cancelled') return;

  const code = typeof row.error_code === 'string' ? row.error_code : undefined;
  const message = typeof row.error_message === 'string' ? row.error_message : undefined;
  throw new Error(
    message
      ? `The job ${status}: ${message}${code ? ` (${code})` : ''}`
      : `The job ${status} without reporting a reason. Read its logs with Get Job Logs.`,
  );
}

/**
 * The error code Rendobar reports for a failed request, if it reported one.
 *
 * Retry safety in this piece rests on a single idea: a repeat that finds the
 * world ALREADY in the state it asked for is a success, not a failure. Sharing
 * an output that is already shared, cancelling a job that is already cancelled.
 * Both arrive as a 409 and both need the code to tell them apart from a genuine
 * conflict, so the reading lives here rather than in each action.
 *
 * Deliberately not a general "retry this" helper: what counts as the desired
 * state differs per action and only the action knows it.
 */
export function conflictCode(error: unknown, status = 409): string | undefined {
  const cause = error instanceof Error ? error.cause : error;
  const response = (cause as { response?: { status?: unknown; body?: unknown } } | undefined)?.response;
  if (response?.status !== status) return undefined;
  const body = response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : undefined;
}

// ── Storage ─────────────────────────────────────────────────────────

/**
 * Escape a raw object key or folder path for the path part of a `storage://`
 * URI, so a `%`, `?` or `#` coming from the bucket cannot be mistaken by a
 * parser for a percent-escape, a query string or a fragment. Mirrors the
 * API's own decoder (apps/api), which reverses exactly this.
 *
 * Order matters: `%` is escaped first, or escaping `?`/`#` afterwards would
 * double-escape the `%` those produce. Everything else -- spaces, unicode,
 * `{template}` tokens -- stays literal. The storage id and the `/` separators
 * are never passed through this; only the path part is.
 */
export function encodeStoragePath(path: string): string {
  return path.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23');
}

/**
 * The Deliver To selection as `storage://` URIs.
 *
 * One path applies to every chosen connection. A flow that needs a different
 * path per bucket is two steps, or a Custom API Call. Leading slashes go and the
 * rest is sent as written, so the API's own template rules decide what a folder
 * or a token means. A repeated connection is one destination.
 */
export function destinationUris(ids: unknown, path: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const suffix = typeof path === 'string' ? encodeStoragePath(path.trim().replace(/^\/+/, '')) : '';
  const uris: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') continue;
    const uri = suffix === '' ? `storage://${id.trim()}` : `storage://${id.trim()}/${suffix}`;
    if (!uris.includes(uri)) uris.push(uri);
  }
  return uris;
}

/**
 * Refuse a Delivery Folder or Path that names nowhere to write it into.
 *
 * A path with no destination is very likely someone who filled in the path and
 * expected it to pick a bucket on its own, or a Deliver To whose expression
 * resolved to nothing. Submitting anyway would send the job as though no
 * destination were named at all, silently dropping the path instead of erroring.
 *
 * A `deliverTo` that is present but not an array is a broken expression, not an
 * empty choice, and is refused even with no path: {@link destinationUris}
 * would otherwise treat it exactly like nothing being chosen.
 */
export function requireDeliveryTarget(deliverTo: unknown, deliveryPath: unknown): void {
  if (deliverTo !== undefined && deliverTo !== null && !Array.isArray(deliverTo)) {
    throw new Error(
      'Deliver To did not resolve to a list of connections. Check the field referencing an earlier step.',
    );
  }
  const path = typeof deliveryPath === 'string' ? deliveryPath.trim() : '';
  const chosen = Array.isArray(deliverTo) && deliverTo.some((id) => typeof id === 'string' && id.trim() !== '');
  if (path !== '' && !chosen) {
    throw new Error(
      'Delivery Folder or Path applies to the connections chosen under Deliver To. Choose one, or clear the path.',
    );
  }
}

/**
 * What to tell someone whose storage read was refused. A key made before
 * connected storage shipped has no storage scope, and the API's sentence names
 * the scope but not the fix. Keyed on the error code, never the wording.
 */
export function storageAdvice(error: unknown): string {
  if (conflictCode(error, 403) === 'INSUFFICIENT_SCOPE') {
    return 'This API key cannot read connected storage. Create a new API key in the Rendobar dashboard, where Storage access is on by default, and reconnect Rendobar.';
  }
  return error instanceof Error ? error.message : String(error);
}
