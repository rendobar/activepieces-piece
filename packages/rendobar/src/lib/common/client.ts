import { httpClient, HttpMethod, AuthenticationType, HttpError } from '@activepieces/pieces-common';
import { PIECE_VERSION } from './version';
import type { SubmitData } from './pure';

export const BASE_URL = 'https://api.rendobar.com';

/**
 * Reported to Rendobar on every request, so a bug report can name the build.
 *
 * Generated from package.json at build time rather than hardcoded. The bundler
 * does not ship package.json, so it cannot be read at runtime, but it can be
 * read at build time. See scripts/generate-version.mjs.
 */
export { PIECE_VERSION };

/**
 * Every request from this piece, so the client header and auth are set in one
 * place. `httpClient` rather than fetch: the pieces contribution rules require
 * it, and it carries the platform's retry and error handling.
 */
export async function rendobar<T>(
  accessToken: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const response = await httpClient.sendRequest<T>({
      method,
      url: `${BASE_URL}${path}`,
      authentication: { type: AuthenticationType.BEARER_TOKEN, token: accessToken },
      // Free-form by design on Rendobar's side, so a new connector needs no API
      // change to appear in usage-by-client. `name/version` is the HTTP product
      // convention Rendobar parses: a bare name still works, and sending the
      // version is what makes a bug report say WHICH piece build produced it.
      headers: { 'X-Rendobar-Client': `activepieces/${PIECE_VERSION}` },
      ...(body === undefined ? {} : { body }),
    });
    return response.body;
  } catch (error) {
    throw new Error(readableMessage(error), { cause: error });
  }
}

/**
 * Rendobar answers every failure with `{ error: { code, message } }`, and that
 * message is already written for a person: "Not enough credits for this job",
 * "Member not found". HttpError's own message is a JSON dump of the whole
 * request and response, so without this a user hitting 402 reads a wall of
 * JSON instead of a sentence.
 *
 * Anything unrecognised falls through to the original, because a mangled error
 * is worse than a verbose one.
 */
function readableMessage(error: unknown): string {
  if (!(error instanceof HttpError)) return error instanceof Error ? error.message : String(error);

  const body = error.response.body;
  const reported =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error?: { message?: unknown } }).error
      : undefined;

  return typeof reported?.message === 'string'
    ? reported.message
    : `Rendobar responded with status ${error.response.status}`;
}

/** One entry of `GET /jobs/types`. */
export type JobTypeSummary = {
  type: string;
  summary: string;
  useCases: string[];
  chainsWith: string[];
};

/** One field of `GET /jobs/types/{type}/schema`. */
export type ConnectorField = {
  /** Unique within the job type. The form keys on this. */
  key: string;
  /** The param to submit under. NOT unique: see `key`. */
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'options' | 'json';
  required: boolean;
  default?: unknown;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
  description?: string;
  advanced?: boolean;
  showWhen?: { field: string; equals: string[] };
};

/**
 * One media input a job reads. Same shape as a param field plus two flags only
 * an input needs: whether the value is a file URL, and whether it takes a list.
 */
export type ConnectorInput = ConnectorField & {
  url?: boolean;
  multiple?: boolean;
};

export type JobSchema = {
  type: string;
  fields: ConnectorField[];
  discriminator?: string;
  /**
   * The media this job reads. Absent on an API deployed before the inputs
   * descriptor shipped, which is why every consumer here treats it as optional
   * and falls back to a JSON editor.
   */
  inputs?: {
    fields: ConnectorInput[];
    /** Any filename may be an input key (ffmpeg, ffprobe). Render a map. */
    variadic: boolean;
  };
  /**
   * The full json schema. Only read when `fields` is empty, to tell a job type
   * whose parameters are a document apart from one that takes none.
   */
  jsonSchema?: unknown;
};

/**
 * Send raw bytes to a presigned storage URL.
 *
 * Deliberately not `rendobar()`: a presigned URL carries its own signature in
 * the query string, and adding an Authorization header on top makes the
 * storage layer reject the request. Nothing about this call is a Rendobar API
 * call except where the URL came from.
 *
 * Returns the ETag, which the finalize step needs for a multipart upload.
 */
export async function putBytes(
  url: string,
  body: Buffer,
  contentType: string,
): Promise<string | undefined> {
  const response = await httpClient.sendRequest({
    method: HttpMethod.PUT,
    url,
    // A Buffer is passed through to fetch untouched; anything else here would
    // be JSON-serialized and the stored object would be corrupt.
    body,
    // Never omit this. With no Content-Type the http client defaults to
    // application/json, storage keeps that as the object's type, and the job
    // runner then refuses the input with `returned application/json, not a
    // file`. The upload still reports success and the asset still reads as
    // ready, so the failure only ever surfaces one step later.
    headers: { 'Content-Type': contentType },
  });
  const etag = response.headers?.['etag'] ?? response.headers?.['ETag'];
  return typeof etag === 'string' ? etag.replace(/"/g, '') : undefined;
}

/** `POST /assets` answers with one of three shapes. */
export type AssetInit = {
  status: 'presigned' | 'multipart' | 'deduplicated';
  data: { id: string; url: string; filename?: string; sizeBytes?: number; contentType?: string; expiresAt?: number };
  upload?:
    | { method: 'PUT'; url: string; expiresAt: number }
    | { uploadId: string; partSize: number; parts: { partNumber: number; url: string }[]; expiresAt: number };
};

/**
 * A storage content type for an uploaded file.
 *
 * Only the media this API actually processes is listed; anything else is
 * binary, which is both true and safe. What matters is that the result is
 * never a text or JSON type for a file that is neither.
 */
export function contentTypeFor(filename: string, extension: string | undefined): string {
  const ext = (extension ?? filename.split('.').pop() ?? '').toLowerCase();
  return MEDIA_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

// ── Idempotent submission ───────────────────────────────────────

/**
 * The job id a 409 names, when the conflict is a spent idempotency key.
 *
 * Rendobar refuses to reuse a key bound to a job that failed retryably, and
 * reports the job it is bound to. Any other 409 is somebody else's problem and
 * returns undefined so the caller raises it.
 */
function spentKeyJobId(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.response.status !== 409) return undefined;
  const body = error.response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const details = (body as { error?: { details?: { jobId?: unknown } } }).error?.details;
  return typeof details?.jobId === 'string' ? details.jobId : undefined;
}

/** What `POST /jobs` answers with. The shape of `data` is `SubmitData`, whose
 * pause-relevant reading lives in ./pure alongside its tests. */
export type SubmitResult = { data: SubmitData };

export async function submitJob(
  accessToken: string,
  submission: Record<string, unknown>,
  baseKey: string,
  budget: number,
): Promise<SubmitResult> {
  let idempotencyKey = baseKey;

  for (let attempt = 1; ; attempt++) {
    try {
      return await rendobar<SubmitResult>(accessToken, HttpMethod.POST, '/jobs', {
        ...submission,
        idempotencyKey,
      });
    } catch (error) {
      // `rendobar` wraps the HttpError as `cause` to keep its message readable.
      const boundJobId = spentKeyJobId(error instanceof Error ? error.cause : error);
      if (boundJobId === undefined || attempt >= budget) throw error;
      idempotencyKey = `${baseKey}~${boundJobId}`;
    }
  }
}
