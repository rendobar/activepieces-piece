import { createAction, Property } from '@activepieces/pieces-framework';
import { UPLOAD_OUTPUT_SCHEMA } from '../common/output-schemas';
import { HttpMethod, streamUtils } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer as readableToBuffer } from 'node:stream/consumers';
import { rendobar, putBytes, contentTypeFor, type AssetInit } from '../common/client';

/**
 * Get a file out of the flow and into Rendobar.
 *
 * Without this the piece only worked on media that already had a public URL,
 * so the ordinary Activepieces shape — a file arrives from Drive, a form, or
 * an email, and something happens to it — could not be built at all.
 *
 * Bytes never pass through Rendobar's API: it hands back a presigned storage
 * URL and the upload goes straight there. The result is a stable content URL
 * to paste into any media input of a Run a Media Job step.
 */
export const uploadFile = createAction({
  auth: rendobarAuth,
  name: 'upload_file',
  classification: 'WRITE',
  displayName: 'Upload File',
  description: 'Upload a file to Rendobar and get a URL a job can read.',
  audience: 'both',
  aiMetadata: {
    description:
      'Upload a local or flow-provided file to Rendobar storage and return a URL usable as a job input. Use before Run a Media Job when the media is not already at a public URL; skip it when you already have one. A retry normally stores a second copy, so treat it as not idempotent unless the source reports no length, in which case the file is hashed and an identical earlier upload is reused.',
    idempotent: false,
  },
  outputSchema: UPLOAD_OUTPUT_SCHEMA,

  props: {
    file: Property.File({
      displayName: 'File',
      description:
        'The file to upload. Take it from an earlier step, or paste a URL and it will be fetched first.',
      required: true,
      // Media is the whole point of this piece, and a worker has about 1 GB.
      // Buffering a video to upload it spends the file's whole size in that
      // budget and is OOM-killed on a big enough one. Streaming holds one part
      // at a time instead. Older engines still deliver a buffered ApFile, which
      // toStreamingBody normalises, so this is safe below platform 0.87.0.
      streaming: true,
    }),
    filename: Property.ShortText({
      displayName: 'File Name',
      description: "Override the stored name. Leave empty to keep the file's own name.",
      required: false,
    }),
    keep: Property.Checkbox({
      displayName: 'Keep After 24 Hours',
      description:
        'Off, the upload is temporary and is cleaned up after a day, which is right for a file you are about to process. On, it is stored against your plan quota.',
      required: false,
      defaultValue: false,
    }),
  },

  async run(context) {
    const token = context.auth.secret_text;
    const { file, filename, keep } = context.propsValue;

    const name = filename?.trim() ? filename.trim() : file.filename;
    const contentType = contentTypeFor(name, file.extension);

    // `POST /assets` needs the size up front: it is what decides a single
    // presigned PUT from a multipart upload, and it fixes the part boundaries.
    // A stream does not always know its length — the source may send no
    // Content-Length, and the value is dropped for a compressed response — so
    // when it is missing the only option is to read the file once to measure
    // it. That is the buffering this action is otherwise avoiding, which is why
    // it happens only in the case that leaves no choice.
    const streamed = streamUtils.toStreamingBody(file);
    let body = streamed.body;
    let size = streamed.size;
    // Rendobar dedups on a client-declared sha256 and does nothing without one,
    // so a retried step otherwise stores a second copy of the same bytes. The
    // hash can only be computed from the whole file, which is exactly what the
    // streaming path avoids holding — so it is sent only when the bytes are
    // already in hand, and skipped rather than bought by buffering a video.
    let checksum: string | undefined;
    if (size === undefined) {
      const measured = await readableToBuffer(body);
      size = measured.length;
      checksum = createHash('sha256').update(measured).digest('hex');
      body = Readable.from(measured);
    }

    const init = await rendobar<AssetInit>(token, HttpMethod.POST, '/assets', {
      filename: name,
      size,
      contentType,
      lifecycle: keep ? 'persisted' : 'ephemeral',
      ...(checksum === undefined ? {} : { checksum }),
    });

    // Rendobar answers `deduplicated` when a ready asset already carries this
    // checksum, and there is nothing left to send. Only reachable when a
    // checksum was declared above; a streamed upload of known size sends none,
    // so it always stores a fresh copy.
    if (init.status !== 'deduplicated') {
      const upload = init.upload;
      if (upload === undefined) {
        throw new Error('Rendobar did not return an upload target for this file.');
      }

      if ('parts' in upload) {
        // Large file: equal parts, each acknowledged with an ETag that the
        // finalize call needs in order to reassemble them in order.
        //
        // Read one part at a time out of the stream rather than slicing a
        // buffer of the whole file, so peak memory is one part instead of the
        // entire upload. The chunks arrive in order and the parts are ordered,
        // so they are paired by position.
        const parts: { partNumber: number; etag: string }[] = [];
        let index = 0;
        for await (const chunk of streamUtils.readChunks({
          readable: body,
          chunkSize: upload.partSize,
        })) {
          const part = upload.parts[index++];
          if (part === undefined) {
            throw new Error(
              'The file is larger than the upload Rendobar prepared for it. Re-run the step so the size is measured again.',
            );
          }
          const etag = await putBytes(part.url, chunk, contentType);
          if (etag === undefined) {
            throw new Error(`Storage did not acknowledge part ${part.partNumber} of the upload.`);
          }
          parts.push({ partNumber: part.partNumber, etag });
        }
        if (parts.length !== upload.parts.length) {
          throw new Error(
            `The file ended after ${parts.length} of ${upload.parts.length} parts. Re-run the step so the size is measured again.`,
          );
        }
        await rendobar(token, HttpMethod.POST, `/assets/${init.data.id}/complete`, { parts });
      } else {
        // Under the multipart threshold, so one request and one buffer, which
        // is bounded by that threshold rather than by the file.
        await putBytes(upload.url, await readableToBuffer(body), contentType);
        await rendobar(token, HttpMethod.POST, `/assets/${init.data.id}/complete`, {});
      }
    }

    return {
      asset_id: init.data.id,
      // The field to paste into a job's media input.
      url: init.data.url,
      file_name: name,
      size_bytes: size,
      content_type: init.data.contentType ?? contentType,
      expires_at: init.data.expiresAt ?? null,
      reused_existing: init.status === 'deduplicated',
    };
  },
});
