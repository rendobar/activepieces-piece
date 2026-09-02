import { createAction } from '@activepieces/pieces-framework';
import { ACCOUNT_OUTPUT_SCHEMA } from '../common/output-schemas';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar } from '../common/client';

type Capabilities = {
  plan?: { slug?: string; name?: string };
  limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
};

type BillingState = {
  balance?: { amount?: number };
  plan?: { slug?: string; name?: string; price?: number };
  subscription?: { status?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: number | null };
};

export const getAccount = createAction({
  auth: rendobarAuth,
  name: 'get_account',
  classification: 'READ',
  displayName: 'Get Account',
  description: 'Read the plan, credit balance and limits for this connection.',
  audience: 'both',
  aiMetadata: {
    description:
      'Read the Rendobar account behind this connection: plan, remaining credit balance, subscription status and plan limits. Use to check affordability or quota before submitting work. Reads only, safe to retry.',
    idempotent: true,
  },
  outputSchema: ACCOUNT_OUTPUT_SCHEMA,

  props: {},

  async run(context) {
    const token = context.auth.secret_text;

    // Two endpoints because neither is complete on its own: capabilities
    // carries the full limit set and the feature flags, billing carries the
    // balance and the subscription.
    const capabilities = await rendobar<{ data: Capabilities }>(
      token,
      HttpMethod.GET,
      '/account/capabilities',
    );

    // Billing refuses an OAuth token by design. This connection is normally an
    // API key, but the field accepts a token too, and losing the balance is a
    // better outcome than failing the whole step.
    let billing: BillingState = {};
    try {
      const res = await rendobar<{ data: BillingState }>(token, HttpMethod.GET, '/billing/state');
      billing = res.data;
    } catch {
      billing = {};
    }

    const plan = capabilities.data.plan ?? billing.plan;
    const balance = billing.balance?.amount;

    return {
      plan_slug: plan?.slug ?? null,
      plan_name: plan?.name ?? null,
      // Dollars, as the API reports it.
      balance: balance ?? null,
      balance_known: balance !== undefined,
      subscription_status: billing.subscription?.status ?? null,
      cancels_at_period_end: billing.subscription?.cancelAtPeriodEnd ?? null,
      // Open-ended maps whose keys differ by plan. Flattening them would invent
      // columns that change between runs.
      limits: capabilities.data.limits ?? {},
      features: capabilities.data.features ?? {},
    };
  },
});
