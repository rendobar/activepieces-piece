import { createCustomApiCallAction } from '@activepieces/pieces-common';
import { createPiece, PieceCategory } from '@activepieces/pieces-framework';
import { rendobarAuth } from './lib/auth';
import { BASE_URL } from './lib/common/client';
import { createJob } from './lib/actions/create-job';
import { getJob } from './lib/actions/get-job';
import { cancelJob } from './lib/actions/cancel-job';
import { shareOutput } from './lib/actions/share-output';
import { uploadFile } from './lib/actions/upload-file';
import { findJobs } from './lib/actions/find-jobs';
import { getJobLogs } from './lib/actions/get-job-logs';
import { getAccount } from './lib/actions/get-account';
import { finishedJob } from './lib/triggers/finished-job';
import { finishedJobPolling } from './lib/triggers/finished-job-polling';

export { rendobarAuth };

export const rendobar = createPiece({
  displayName: 'Rendobar',
  description: 'Media processing and AI generation API',
  auth: rendobarAuth,
  minimumSupportedRelease: '0.36.1',
  // The 512 PNG, not logo-mark.svg. That SVG is a base64 PNG wrapped in colour
  // filters rather than real vector art, so it costs 105 KB to draw an icon at
  // 32 px. This is the same mark at 15 KB, and PNG is what 584 of 729 pieces use.
  logoUrl: 'https://cdn.rendobar.com/assets/brand/web-app-manifest-512x512.png',
  categories: [PieceCategory.CONTENT_AND_FILES],
  authors: ['rendobar'],
  actions: [
    createJob,
    uploadFile,
    getJob,
    findJobs,
    getJobLogs,
    getAccount,
    cancelJob,
    shareOutput,
    createCustomApiCallAction({
      baseUrl: () => BASE_URL,
      auth: rendobarAuth,
      authMapping: async (auth) => ({
        Authorization: `Bearer ${auth}`,
      }),
    }),
  ],
  triggers: [finishedJob, finishedJobPolling],
});
