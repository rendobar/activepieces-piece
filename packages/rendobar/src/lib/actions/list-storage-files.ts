import { createAction, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { connectionDropdown } from '../common/storage';
import { storageAdvice, requireStorageId } from '../common/pure';
import { STORAGE_FILES_OUTPUT_SCHEMA } from '../common/output-schemas';

type ObjectsPage = {
  folders: string[];
  objects: { key: string; size: number; lastModified: number | null }[];
  cursor: string | null;
};

/**
 * The prefix the API expects: no leading slash, and a trailing one so a
 * partial name like `raw/202` cannot match `raw/2026/` as a prefix.
 */
function normalizeFolder(folder: unknown): string {
  const trimmed = typeof folder === 'string' ? folder.trim().replace(/^\/+/, '') : '';
  if (trimmed === '' || trimmed.endsWith('/')) return trimmed;
  return `${trimmed}/`;
}

export const listStorageFiles = createAction({
  auth: rendobarAuth,
  name: 'list_storage_files',
  classification: 'SEARCH',
  displayName: 'List Storage Files',
  description: 'List the folders and files under a folder in a connected bucket.',
  audience: 'both',
  aiMetadata: {
    description:
      'List folders and files directly under a folder in a connected bucket, each with a storage://<id>/<path> URI to use as a job input. Reads only, never changes the bucket.',
    idempotent: true,
  },
  outputSchema: STORAGE_FILES_OUTPUT_SCHEMA,

  props: {
    storageId: Property.Dropdown({
      displayName: 'Connection',
      description: 'The connected bucket to list.',
      required: true,
      auth: rendobarAuth,
      refreshers: [],
      options: async ({ auth }) => connectionDropdown(auth?.secret_text, false),
    }),
    folder: Property.ShortText({
      displayName: 'Folder',
      description: 'A folder ending in /, for example raw/2026/. Leave empty for the top of the bucket.',
      required: false,
    }),
    limit: Property.Number({
      displayName: 'Limit',
      description: 'How many folders and files to return at most.',
      required: false,
      defaultValue: 100,
    }),
  },

  async run(context) {
    const storageId = requireStorageId(context.propsValue.storageId);
    const folder = normalizeFolder(context.propsValue.folder);
    const want = Math.max(1, context.propsValue.limit ?? 100);
    const uri = (key: string) => `storage://${storageId}/${key}`;
    const folders: { path: string; uri: string }[] = [];
    const files: { path: string; size_bytes: number; last_modified: number | null; uri: string }[] = [];
    let cursor: string | null = null;
    try {
      do {
        // A folder counts against the limit exactly like a file does, so this
        // asks for only what is still needed, capped at the API's own ceiling.
        const remaining = want - (folders.length + files.length);
        const query = new URLSearchParams();
        if (folder) query.set('prefix', folder);
        if (cursor) query.set('cursor', cursor);
        query.set('limit', String(Math.min(1000, remaining)));
        // Annotated because `cursor` feeds the next request, and TypeScript cannot
        // infer a type that refers to itself across loop iterations.
        const response: { data: ObjectsPage } = await rendobar<{ data: ObjectsPage }>(
          context.auth.secret_text,
          HttpMethod.GET,
          `/storage/${encodeURIComponent(storageId)}/objects?${query}`,
        );
        const page = response.data;
        for (const prefix of page.folders) folders.push({ path: prefix, uri: uri(prefix) });
        for (const o of page.objects) files.push({ path: o.key, size_bytes: o.size, last_modified: o.lastModified, uri: uri(o.key) });
        cursor = page.cursor;
      } while (cursor !== null && folders.length + files.length < want);
    } catch (error) {
      throw new Error(storageAdvice(error), { cause: error });
    }
    // Trimmed as one combined budget, folders first: a page can overshoot the
    // limit in a single response, and folders and files share one `want`.
    const keptFolders = folders.slice(0, want);
    const keptFiles = files.slice(0, want - keptFolders.length);
    const truncated = cursor !== null || folders.length + files.length > want;
    return { folders: keptFolders, files: keptFiles, truncated };
  },
});
