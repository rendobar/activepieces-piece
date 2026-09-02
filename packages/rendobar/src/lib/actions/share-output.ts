import { createAction } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';
import { jobIdDropdown, requireJobId } from '../common/job';
import { conflictCode } from '../common/pure';
import { SHARE_OUTPUT_SCHEMA } from '../common/output-schemas';

type Share = { shareId: string; shareUrl: string; createdAt?: number };

export const shareOutput = createAction({
  auth: rendobarAuth,
  name: 'share_output',
  classification: 'WRITE',
  displayName: 'Share Output',
  description: "Turn a finished job's output into a permanent public link.",
  audience: 'both',
  aiMetadata: {
    description:
      "Create a permanent public URL for a finished Rendobar job's output file, for posting somewhere that cannot authenticate. The URL a job returns is short lived; this one is not. Sharing the same job twice returns the existing link rather than failing, so it is safe to retry.",
    idempotent: true,
  },
  outputSchema: SHARE_OUTPUT_SCHEMA,

  props: {
    jobId: jobIdDropdown,
  },

  async run(context) {
    const token = context.auth.secret_text;
    const jobId = requireJobId(context.propsValue.jobId);
    const path = `/jobs/${encodeURIComponent(jobId)}/share`;

    try {
      const created = await rendobar<{ data: Share }>(token, HttpMethod.POST, path);
      return { ...created.data, already_shared: false };
    } catch (error) {
      // 409 means somebody already shared this output. Failing there would make
      // the action unsafe to retry and would break a re-run of a flow that
      // shared the same job, so the existing link is fetched and returned
      // instead. That is what makes `idempotent: true` above honest.
      if (conflictCode(error) !== 'CONFLICT') throw error;
      const existing = await rendobar<{ data: Share | null }>(token, HttpMethod.GET, path);
      if (existing.data === null) throw error;
      return { ...existing.data, already_shared: true };
    }
  },
});
