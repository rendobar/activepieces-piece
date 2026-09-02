import path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * The action tests need the real framework: ExecutionType, the props system,
 * and the httpClient the submit path uses. None of that is on npm at a usable
 * version, so scripts/fetch-ap.mjs pins and fetches the framework source into
 * .ap-src and everything resolves against that.
 *
 * Aliases point at source rather than dist, so nothing upstream has to build.
 */
const apSrc = path.resolve(__dirname, '../../.ap-src');

export default defineConfig({
  test: { globals: true, environment: 'node' },
  resolve: {
    alias: {
      '@activepieces/core-utils': path.resolve(apSrc, 'packages/core/utils/src/index.ts'),
      '@activepieces/core-piece-types': path.resolve(apSrc, 'packages/core/piece-types/src/index.ts'),
      '@activepieces/pieces-framework': path.resolve(apSrc, 'packages/pieces/framework/src/index.ts'),
      '@activepieces/pieces-common': path.resolve(apSrc, 'packages/pieces/common/src/index.ts'),
    },
  },
});
