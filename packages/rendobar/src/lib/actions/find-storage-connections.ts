import { createAction } from '@activepieces/pieces-framework';
import { rendobarAuth } from '../auth';
import { listConnections, toStorageRow } from '../common/storage';
import { storageAdvice } from '../common/pure';
import { STORAGE_LIST_OUTPUT_SCHEMA } from '../common/output-schemas';

export const findStorageConnections = createAction({
  auth: rendobarAuth,
  name: 'find_storage_connections',
  classification: 'SEARCH',
  displayName: 'Find Storage Connections',
  description: "List the buckets connected on Rendobar's Storage page.",
  audience: 'both',
  aiMetadata: {
    description:
      "List the user's connected buckets. Use an id as storage://<id>/<path> for a job input, or choose it under Deliver To on Run a Media Job unless its access is read. Reads only.",
    idempotent: true,
  },
  outputSchema: STORAGE_LIST_OUTPUT_SCHEMA,
  props: {},

  async run(context) {
    try {
      return (await listConnections(context.auth.secret_text)).map(toStorageRow);
    } catch (error) {
      throw new Error(storageAdvice(error), { cause: error });
    }
  },
});
