// Shared fixtures for the Timmy Pro tests: a fake Stripe that keeps its own
// sessions and subscriptions, and helpers that drive the real request handler.

import { StripeApiError, type CheckoutSessionInfo, type StripeClient, type SubscriptionInfo } from '../../src/pro/stripe-api.js';
import { handleProRequest, resetProCaches, type ProDeps } from '../../src/pro/service.js';
import { MemoryLicenseStore } from '../../src/pro/store.js';
import { generateLicenseKeyPair } from '../../src/pro/license.js';
import { signStripePayload } from '../../src/pro/stripe-signature.js';
import type { FetchLike } from '../../src/pro/client.js';

export const NOW = 1_800_000_000;
export const DAY = 86_400;
export const WEBHOOK_SECRET = 'whsec_test';
export const ORIGIN = 'https://pro.example.test';
export const PORTAL = 'https://billing.stripe.com/p/login/test_portal';

export const proSub = (id: string, status = 'active', over: Partial<SubscriptionInfo> = {}): SubscriptionInfo => ({
  id, status, customerId: 'cus_buyer', currentPeriodEnd: NOW + 30 * DAY,
  priceIds: ['price_test_pro'], priceLookupKeys: ['timmy_pro_monthly'], ...over,
});

export function fakeStripe() {
  const sessions = new Map<string, CheckoutSessionInfo & { subId?: string }>();
  const subs = new Map<string, SubscriptionInfo>();
  const calls: string[] = [];
  const slowReads = new Map<string, number>();
  let n = 0;
  const client: StripeClient = {
    async createCheckoutSession(input) {
      calls.push(`create:${input.priceId}:${input.source}:${input.successUrl}`);
      const id = `cs_test_session${n++}abcdef`;
      sessions.set(id, { id, mode: 'subscription', status: 'open', paymentStatus: 'unpaid', customerId: null, email: null, subscription: null });
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
    async retrieveCheckoutSession(id) {
      calls.push(`retrieve:${id}`);
      const s = sessions.get(id);
      if (!s) throw new StripeApiError('No such checkout.session: secret detail sk_test_****1234', 404);
      const { subId, ...info } = s;
      return structuredClone({ ...info, subscription: subId ? subs.get(subId) ?? null : null });
    },
    async retrieveSubscription(id) {
      calls.push(`subscription:${id}`);
      const snapshot = subs.has(id) ? structuredClone(subs.get(id)!) : null; // state as of the call
      const delay = slowReads.get(id);
      if (delay) {
        slowReads.delete(id);
        await new Promise((r) => setTimeout(r, delay));
      }
      return snapshot;
    },
    async findPriceIdByLookupKey(key) {
      calls.push(`lookup:${key}`);
      return key === 'timmy_pro_monthly' ? 'price_test_pro' : null;
    },
  };
  const pay = (sessionId: string, sub: SubscriptionInfo = proSub(`sub_${sessionId.slice(-8)}`)) => {
    subs.set(sub.id, sub);
    sessions.set(sessionId, { ...sessions.get(sessionId)!, status: 'complete', paymentStatus: 'paid', customerId: 'cus_buyer', email: 'buyer@example.com', subId: sub.id });
    return sub;
  };
  /** Stripe gave up on an unpaid checkout (it does so 24 hours after opening it, by default). */
  const expire = (sessionId: string) => {
    sessions.set(sessionId, { ...sessions.get(sessionId)!, status: 'expired' });
  };
  return { client, sessions, subs, calls, slowReads, pay, expire };
}

/**
 * A complete Pro service in memory: the real request handler over a fake Stripe
 * and a memory store, reachable through `fetch` like a deployed worker.
 */
export async function proWorld() {
  resetProCaches();
  const pair = await generateLicenseKeyPair();
  const stripe = fakeStripe();
  let clock = NOW;
  const deps: ProDeps = {
    env: {
      STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_LOGIN_URL: PORTAL,
      LICENSE_SIGNING_KEY: pair.privatePkcs8, LICENSE_KEY_SECRET: 'key-secret',
    },
    store: new MemoryLicenseStore(),
    stripe: stripe.client,
    now: () => clock,
  };
  const fetch: FetchLike = (input, init) => handleProRequest(new Request(input, init), deps);
  return {
    deps,
    stripe,
    fetch,
    publicKey: pair.publicRaw,
    origin: ORIGIN,
    now: () => clock,
    advance: (seconds: number) => { clock += seconds; },
    async webhook(event: object): Promise<Response> {
      const raw = JSON.stringify(event);
      return handleProRequest(new Request(`${ORIGIN}/stripe/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': await signStripePayload(raw, WEBHOOK_SECRET, clock), 'content-type': 'application/json' },
        body: raw,
      }), deps);
    },
  };
}

export type ProWorld = Awaited<ReturnType<typeof proWorld>>;
