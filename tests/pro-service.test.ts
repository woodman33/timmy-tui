import { beforeEach, describe, expect, it } from 'vitest';
import { handleProRequest, resetProCaches, type ProDeps } from '../src/pro/service.js';
import { MemoryLicenseStore } from '../src/pro/store.js';
import { StripeApiError, type SubscriptionInfo } from '../src/pro/stripe-api.js';
import { generateLicenseKeyPair, importVerifyKey, verifyLicenseToken } from '../src/pro/license.js';
import { signStripePayload } from '../src/pro/stripe-signature.js';
import { PRO_FEATURES } from '../src/pro/plan.js';
import { DAY, NOW, ORIGIN, PORTAL, WEBHOOK_SECRET, fakeStripe, proSub } from './helpers/pro-harness.js';

let stripe: ReturnType<typeof fakeStripe>;
let deps: ProDeps;
let verifyKey: CryptoKey;
let clock: number;

beforeEach(async () => {
  resetProCaches();
  const pair = await generateLicenseKeyPair();
  verifyKey = await importVerifyKey(pair.publicRaw);
  stripe = fakeStripe();
  clock = NOW;
  deps = {
    env: {
      STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_LOGIN_URL: PORTAL,
      LICENSE_SIGNING_KEY: pair.privatePkcs8, LICENSE_KEY_SECRET: 'key-secret',
    },
    store: new MemoryLicenseStore(),
    stripe: stripe.client,
    now: () => clock,
  };
});

const call = (method: string, path: string, body?: unknown) =>
  handleProRequest(new Request(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), deps);

async function newSession() {
  return ((await (await call('POST', '/checkout', { source: 'cli' })).json()) as { session_id: string }).session_id;
}

async function paidSession(sub?: (sessionId: string) => SubscriptionInfo) {
  const sessionId = await newSession();
  stripe.pay(sessionId, sub?.(sessionId));
  return sessionId;
}

async function claimKey(sessionId: string) {
  return ((await (await call('POST', '/license/claim', { session_id: sessionId })).json()) as { key: string }).key;
}

async function webhook(event: object) {
  const raw = JSON.stringify(event);
  return handleProRequest(new Request(`${ORIGIN}/stripe/webhook`, {
    method: 'POST',
    headers: { 'stripe-signature': await signStripePayload(raw, WEBHOOK_SECRET, NOW), 'content-type': 'application/json' },
    body: raw,
  }), deps);
}

describe('checkout', () => {
  it('creates a Pro checkout via the lookup key, caching the price', async () => {
    const res = await call('POST', '/checkout', { source: 'cli' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    await call('POST', '/checkout', { source: 'cli' });
    expect(stripe.calls.filter((c) => c === 'lookup:timmy_pro_monthly')).toHaveLength(1);
    expect(stripe.calls.find((c) => c.startsWith('create:'))).toBe(`create:price_test_pro:cli:${ORIGIN}/welcome?session_id={CHECKOUT_SESSION_ID}`);
  });

  it('sends the web form straight to Stripe with a 303', async () => {
    const res = await handleProRequest(new Request(`${ORIGIN}/checkout`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }), deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it('is unavailable without a price, and says no more than that', async () => {
    stripe.client.findPriceIdByLookupKey = async () => null;
    const res = await call('POST', '/checkout', { source: 'cli' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'service unavailable', code: 'unavailable' });
  });
});

describe('after payment', () => {
  it('shows the key on the welcome page, the same key on a revisit, under a strict CSP', async () => {
    const sessionId = await paidSession();
    const first = await call('GET', `/welcome?session_id=${sessionId}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-security-policy')).toContain("default-src 'none'");
    const key = (await first.text()).match(/tpro_[0-9A-Z-]{35}/)?.[0];
    expect(key).toBeTruthy();
    expect(await (await call('GET', `/welcome?session_id=${sessionId}`)).text()).toContain(`timmy pro activate ${key}`);
  });

  it('says pending before payment, and rejects unknown or malformed sessions (unknown ones cached)', async () => {
    const sessionId = await newSession();
    expect((await call('GET', `/welcome?session_id=${sessionId}`)).status).toBe(202);
    expect((await call('POST', '/license/claim', { session_id: sessionId })).status).toBe(202);
    expect((await call('GET', '/welcome?session_id=cs_test_doesnotexist1')).status).toBe(404);
    expect((await call('POST', '/license/claim', { session_id: 'cs_test_doesnotexist1' })).status).toBe(404);
    expect(stripe.calls.filter((c) => c === 'retrieve:cs_test_doesnotexist1')).toHaveLength(1);
    expect((await call('GET', '/welcome?session_id=<script>')).status).toBe(400);
  });

  it('hands the CLI a key and a token that verifies offline with every Pro feature', async () => {
    const body = (await (await call('POST', '/license/claim', { session_id: await paidSession() })).json()) as { status: string; token: string };
    expect(body.status).toBe('ready');
    const check = await verifyLicenseToken(body.token, verifyKey, NOW);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.claims.features).toEqual([...PRO_FEATURES]);
    expect(check.claims.exp).toBe(NOW + 7 * DAY);
    expect(JSON.stringify(check.claims)).not.toContain('sub_');
  });

  it('ignores a paid subscription to any other price on the same Stripe account', async () => {
    const sessionId = await paidSession((id) => proSub(`sub_${id.slice(-8)}`, 'active', { priceIds: ['price_card_shop'], priceLookupKeys: ['card_shop_monthly'] }));
    expect((await call('GET', `/welcome?session_id=${sessionId}`)).status).toBe(404);
    expect((await call('POST', '/license/claim', { session_id: sessionId })).status).toBe(404);
  });

  it('reveals the key for 24 hours only', async () => {
    const sessionId = await paidSession();
    await claimKey(sessionId);
    clock = NOW + DAY + 1;
    expect((await call('GET', `/welcome?session_id=${sessionId}`)).status).toBe(410);
    expect((await call('POST', '/license/claim', { session_id: sessionId })).status).toBe(410);
  });

  it('gives a canceled subscription no token, even inside the reveal window', async () => {
    const sessionId = await paidSession((id) => proSub(`sub_${id.slice(-8)}`, 'canceled'));
    const res = await call('POST', '/license/claim', { session_id: sessionId });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'subscription not active', code: 'subscription_inactive', status: 'canceled' });
  });
});

describe('activate, rotate, billing', () => {
  it('activates a sloppily typed key, and refuses unknown or malformed keys', async () => {
    const key = await claimKey(await paidSession());
    const res = await call('POST', '/license/activate', { key: key.toLowerCase().replace(/-/g, '') });
    expect(res.status).toBe(200);
    expect((await verifyLicenseToken(((await res.json()) as { token: string }).token, verifyKey, NOW)).ok).toBe(true);
    expect((await call('POST', '/license/activate', { key: 'tpro_' + '0'.repeat(32) })).status).toBe(404);
    expect((await call('POST', '/license/activate', { key: 'hello' })).status).toBe(400);
  });

  it('rotating needs the current key, kills it, and the checkout link stops revealing keys', async () => {
    const sessionId = await paidSession();
    const oldKey = await claimKey(sessionId);
    const rotated = (await (await call('POST', '/license/rotate', { key: oldKey })).json()) as { key: string };
    expect(rotated.key).not.toBe(oldKey);
    expect((await call('POST', '/license/activate', { key: oldKey })).status).toBe(404);
    expect((await call('POST', '/license/activate', { key: rotated.key })).status).toBe(200);
    expect((await call('GET', `/welcome?session_id=${sessionId}`)).status).toBe(410);
    expect((await call('POST', '/license/rotate', { session_id: sessionId })).status).toBe(400);
  });

  it('keeps the first new key valid when two rotations of one key race', async () => {
    const oldKey = await claimKey(await paidSession());
    const store = deps.store;
    let lookups = 0;
    let bothLookedUp!: () => void;
    const gate = new Promise<void>((resolve) => { bothLookedUp = resolve; });
    // Both requests find the old key before either takes the subscription lock.
    deps.store = {
      getBySubscription: (id) => store.getBySubscription(id),
      async getByKeyHash(hash) {
        const record = await store.getByKeyHash(hash);
        if (++lookups === 2) bothLookedUp();
        await gate;
        return record;
      },
      getByCheckoutSession: (id) => store.getByCheckoutSession(id),
      upsert: (record) => store.upsert(record),
      hasProcessedEvent: (id) => store.hasProcessedEvent(id),
      markEventProcessed: (id, at) => store.markEventProcessed(id, at),
    };

    const responses = await Promise.all([
      call('POST', '/license/rotate', { key: oldKey }),
      call('POST', '/license/rotate', { key: oldKey }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 404]);
    const winner = (await responses.find((res) => res.status === 200)!.json()) as { key: string };
    expect((await call('POST', '/license/activate', { key: winner.key })).status).toBe(200);
  });

  it('labels every refusal with a stable code the CLI can rely on', async () => {
    const body = async (res: Response) => ({ status: res.status, ...((await res.json()) as object) });
    const sessionId = await paidSession();
    const key = await claimKey(sessionId);
    expect(await body(await call('POST', '/license/activate', { key: 'tpro_00000000-00000000-00000000-00000000' })))
      .toEqual({ status: 404, error: 'unknown license key', code: 'unknown_key' });
    expect(await body(await call('POST', '/license/activate', { key: 'tpro_nope' })))
      .toEqual({ status: 400, error: 'that is not a Timmy Pro license key', code: 'invalid_key' });
    expect(await body(await call('POST', '/license/claim', { session_id: 'cs_test_unknownsession00' })))
      .toEqual({ status: 404, error: 'no Timmy Pro purchase for that checkout', code: 'unknown_checkout' });
    expect(await body(await call('POST', '/license/claim', { session_id: 'not a session' })))
      .toEqual({ status: 400, error: 'invalid session_id', code: 'invalid_request' });
    expect(await body(await call('GET', '/license/claim'))).toEqual({ status: 405, error: 'method not allowed', code: 'method_not_allowed' });
    expect(await body(await call('GET', '/nowhere'))).toEqual({ status: 404, error: 'not found', code: 'not_found' });
    clock += 2 * DAY;
    expect(await body(await call('POST', '/license/claim', { session_id: sessionId })))
      .toEqual({ status: 410, error: 'license key already issued', code: 'key_already_issued' });
    expect((await call('POST', '/license/activate', { key })).status).toBe(200);
  });

  it('past_due keeps Pro for 14 days, then stops', async () => {
    const sessionId = await paidSession((id) => proSub(`sub_${id.slice(-8)}`, 'past_due'));
    const key = await claimKey(sessionId);
    clock = NOW + 13 * DAY;
    const ok = await call('POST', '/license/activate', { key });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { claims: { exp: number } }).claims.exp).toBeLessThanOrEqual(NOW + 14 * DAY);
    clock = NOW + 15 * DAY;
    expect((await call('POST', '/license/activate', { key })).status).toBe(403);
  });

  it('re-reads Stripe when the stored period is over (a missed webhook)', async () => {
    const sessionId = await paidSession();
    const key = await claimKey(sessionId);
    const subId = `sub_${sessionId.slice(-8)}`;
    clock = NOW + 40 * DAY;
    stripe.subs.set(subId, proSub(subId, 'canceled'));
    expect((await call('POST', '/license/activate', { key })).status).toBe(403);
    stripe.subs.set(subId, proSub(subId, 'active', { currentPeriodEnd: NOW + 60 * DAY }));
    expect((await call('POST', '/license/activate', { key })).status).toBe(200);
  });

  it('sends billing to Stripe\'s own email login, never a key-authorized portal session', async () => {
    const res = await call('GET', '/billing');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(PORTAL);
    expect(await (await call('POST', '/billing', {})).json()).toEqual({ url: PORTAL });
    deps.env.STRIPE_PORTAL_LOGIN_URL = undefined;
    expect((await call('GET', '/billing')).status).toBe(503);
  });
});

describe('webhook', () => {
  it('rejects unsigned, mis-signed and stale events with a generic error, touching nothing', async () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.deleted', data: { object: { id: 'sub_x' } } });
    const send = (sig?: string) => handleProRequest(new Request(`${ORIGIN}/stripe/webhook`, { method: 'POST', headers: sig ? { 'stripe-signature': sig } : {}, body: raw }), deps);
    for (const res of [await send(), await send(await signStripePayload(raw, 'whsec_wrong', NOW)), await send(await signStripePayload(raw, WEBHOOK_SECRET, NOW - 600))]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid signature', code: 'invalid_signature' });
    }
    expect(stripe.calls.some((c) => c.startsWith('subscription:'))).toBe(false);
  });

  it('cancellation trusts a fresh Stripe read over the event payload', async () => {
    const sessionId = await paidSession();
    const key = await claimKey(sessionId);
    const subId = `sub_${sessionId.slice(-8)}`;
    stripe.subs.set(subId, proSub(subId, 'canceled'));
    expect((await webhook({ id: 'evt_cancel', type: 'customer.subscription.deleted', data: { object: { id: subId, status: 'active' } } })).status).toBe(200);
    const refused = await call('POST', '/license/activate', { key });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'subscription not active', code: 'subscription_inactive', status: 'canceled' });
  });

  it('concurrent events for one subscription cannot leave a stale status', async () => {
    const sessionId = await paidSession();
    const key = await claimKey(sessionId);
    const subId = `sub_${sessionId.slice(-8)}`;
    stripe.slowReads.set(subId, 40); // event A reads "active", then stalls
    const a = webhook({ id: 'evt_a', type: 'customer.subscription.updated', data: { object: { id: subId } } });
    await new Promise((r) => setTimeout(r, 5));
    stripe.subs.set(subId, proSub(subId, 'canceled')); // the plan is canceled; event B arrives
    const b = webhook({ id: 'evt_b', type: 'customer.subscription.deleted', data: { object: { id: subId } } });
    await Promise.all([a, b]);
    expect((await call('POST', '/license/activate', { key })).status).toBe(403);
  });

  it('processes each event id once', async () => {
    const subId = stripe.pay(await newSession()).id;
    const event = { id: 'evt_dup', type: 'customer.subscription.updated', data: { object: { id: subId } } };
    expect(await (await webhook(event)).json()).toEqual({ received: true });
    expect(await (await webhook(event)).json()).toEqual({ received: true, duplicate: true });
    expect(stripe.calls.filter((c) => c === `subscription:${subId}`)).toHaveLength(1);
  });

  it('checkout.session.completed records the purchase before the buyer comes back', async () => {
    const sessionId = await paidSession();
    await webhook({ id: 'evt_done', type: 'checkout.session.completed', data: { object: { id: sessionId, mode: 'subscription' } } });
    const retrievals = stripe.calls.filter((c) => c === `retrieve:${sessionId}`).length;
    expect((await call('POST', '/license/claim', { session_id: sessionId })).status).toBe(200);
    expect(stripe.calls.filter((c) => c === `retrieve:${sessionId}`)).toHaveLength(retrievals);
  });

  it('ignores subscription events for other products', async () => {
    stripe.subs.set('sub_other', proSub('sub_other', 'active', { priceIds: ['price_other'], priceLookupKeys: [] }));
    expect((await webhook({ id: 'evt_other', type: 'customer.subscription.created', data: { object: { id: 'sub_other' } } })).status).toBe(200);
    expect(await deps.store.getBySubscription('sub_other')).toBeNull();
  });
});

describe('errors and routing', () => {
  it('never forwards Stripe\'s error text', async () => {
    stripe.client.retrieveCheckoutSession = async () => { throw new StripeApiError('Invalid API Key provided: sk_live_****1234', 401); };
    const res = await call('POST', '/license/claim', { session_id: 'cs_live_abcdefghij' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk_live');
  });

  it('fails closed when license secrets are missing', async () => {
    const sessionId = await paidSession();
    deps.env.LICENSE_KEY_SECRET = undefined;
    expect((await call('POST', '/license/claim', { session_id: sessionId })).status).toBe(503);
  });

  it('serves the landing page, health, 404 and 405', async () => {
    expect(await (await call('GET', '/')).text()).toContain('$19');
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('GET', '/license/activate')).status).toBe(405);
  });
});
