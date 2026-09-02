import { PieceAuth } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobar } from './common/client';

/**
 * An API key, not OAuth, and that is a deliberate reversal.
 *
 * Activepieces resolves an OAuth2 piece's client credentials one of three ways
 * (`packages/.../oauth2/index.ts`): CLOUD_OAUTH2 fetches them from
 * secrets.activepieces.com keyed by PIECE NAME, which only works for pieces
 * Activepieces has onboarded themselves; PLATFORM_OAUTH2 is unimplemented in
 * the community edition; and plain OAUTH2 makes every user register their own
 * OAuth client and paste a client id AND secret. A piece installed from npm
 * gets the third, so "sign in with Rendobar" would really mean "go create an
 * OAuth application first" — strictly worse than copying one key.
 *
 * The key also buys the trigger. Webhook registration is account management, so
 * `POST /webhooks/endpoints` refuses OAuth tokens; with a key the trigger fires
 * the moment a job lands instead of on a five-minute poll.
 *
 * The field still accepts an OAuth access token for anyone who has one: the API
 * takes either as `Authorization: Bearer`.
 */
export const rendobarAuth = PieceAuth.SecretText({
  displayName: 'API Key',
  description: `Connect with a Rendobar API key.

1. Open [app.rendobar.com](https://app.rendobar.com) and sign in, creating an account if you do not have one.
2. Go to **Settings → API Keys** and click **Create key**.
3. Copy the key and paste it below. It starts with \`rb_\`.

A full-access key works. If you narrow its scopes, this piece needs \`jobs:write\`, \`assets:write\` and \`billing:read\`, plus \`webhooks:write\` for the Finished Job trigger.

Jobs are billed to that key's organization. An OAuth access token also works here if you already have one.`,
  required: true,
  validate: async ({ auth }) => {
    // A wrong key is the single most common setup mistake, and without this it
    // surfaces later as a failed run rather than on the connect screen.
    try {
      await rendobar(auth, HttpMethod.GET, '/account/capabilities');
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Could not reach Rendobar with that key.',
      };
    }
  },
});
