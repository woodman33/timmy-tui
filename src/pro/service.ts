// The Timmy Pro service: Stripe Checkout in, license keys and signed license
// tokens out. Pure Request → Response so the same code runs in the Cloudflare
// Worker (workers/pro) and in the root test suite with an in-memory store.
//
// Routes
//   GET  /                   landing page with the Upgrade button
//   POST /checkout           Stripe Checkout Session (JSON for the CLI, 303 for the web form)
//   GET  /welcome            after payment: shows the license key (first 24 hours only)
//   POST /license/claim      the CLI polls this after `timmy pro upgrade` (same 24-hour window)
//   POST /license/activate   key → signed license token
//   POST /license/rotate     key → new key; the old key stops working
//   GET|POST /billing        Stripe's customer-portal login (the customer signs in by email)
//   POST /stripe/webhook     signature-checked Stripe events keep status current
//   GET  /health
//
// Rules this file enforces (each one has a test in tests/pro-service.test.ts):
//   - Only a subscription to the Timmy Pro price counts; any other subscription
//     on the same Stripe account is ignored.
//   - Status always comes from a fresh Stripe read taken inside a per-subscription
//     lock, so out-of-order or concurrent events cannot leave a stale status.
//   - Tokens are issued only while the plan is on; past_due keeps Pro 14 days.
//   - A key is revealed by checkout session only once, within 24 hours; after a
//     rotation it is shown only to whoever rotated it.

import { PAST_DUE_GRACE_SECONDS, PRO_FEATURE_LABELS, PRO_FEATURES, PRO_PLAN, isProActive } from './plan.js';
import { sha256Hex } from './encoding.js';
import { deriveLicenseKey, importSigningKey, licenseKeyHash, normalizeLicenseKey, proClaims, signLicenseToken, type LicenseClaims } from './license.js';
import { verifyStripeSignature } from './stripe-signature.js';
import { StripeApiError, type StripeClient, type SubscriptionInfo } from './stripe-api.js';
import type { LicenseStore, SubscriptionRecord } from './store.js';

export interface ProEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Optional; otherwise the price is found by lookup key `timmy_pro_monthly`. */
  STRIPE_PRICE_PRO?: string;
  /** Stripe's no-code customer-portal login link (Dashboard → Billing → Customer portal). */
  STRIPE_PORTAL_LOGIN_URL?: string;
  /** ed25519 private key, PKCS8, base64url. Secret. */
  LICENSE_SIGNING_KEY?: string;
  /** HMAC secret license keys are derived from. Secret. */
  LICENSE_KEY_SECRET?: string;
  /** Canonical public origin for redirect URLs; defaults to the request's origin. */
  PUBLIC_URL?: string;
}

export interface ProDeps {
  env: ProEnv;
  store: LicenseStore;
  stripe: StripeClient;
  /** Unix seconds. */
  now: () => number;
}

/** Routes that cost Stripe calls or touch keys; the Worker rate-limits these per client IP. */
export const RATE_LIMITED_PATHS: ReadonlySet<string> = new Set(['/checkout', '/welcome', '/license/claim', '/license/activate', '/license/rotate']);

const DAY = 86_400;
const TOKEN_TTL = 7 * DAY;
const PERIOD_GRACE = 3 * DAY;
const REVEAL_WINDOW = DAY;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const PAID = new Set(['paid', 'no_payment_required']);
const CHECKOUT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
const KNOWN_PATHS = new Set(['/health', '/', '/checkout', '/welcome', '/license/claim', '/license/activate', '/license/rotate', '/billing', '/stripe/webhook']);

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Logs the specific reason server-side; callers only learn that the service is unavailable. */
function unavailable(reason: string): HttpError {
  console.error(`timmy-pro: ${reason}`);
  return new HttpError(503, 'service unavailable');
}

export async function handleProRequest(request: Request, deps: ProDeps): Promise<Response> {
  const url = new URL(request.url);
  try {
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /health':
        return json({ ok: true, service: 'timmy-pro' });
      case 'GET /':
        return html(landingPage(url.searchParams.has('canceled')));
      case 'POST /checkout':
        return await checkout(request, url, deps);
      case 'GET /welcome':
        return await welcome(url, deps);
      case 'POST /license/claim':
        return await claim(request, deps);
      case 'POST /license/activate':
        return await activate(request, deps);
      case 'POST /license/rotate':
        return await rotate(request, deps);
      case 'GET /billing':
        return new Response(null, { status: 303, headers: { Location: billingUrl(deps.env), ...SECURITY_HEADERS } });
      case 'POST /billing':
        return json({ url: billingUrl(deps.env) });
      case 'POST /stripe/webhook':
        return await webhook(request, deps);
      default:
        return KNOWN_PATHS.has(url.pathname) ? json({ error: 'method not allowed' }, 405) : json({ error: 'not found' }, 404);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
    if (err instanceof StripeApiError) {
      console.error(`timmy-pro: Stripe API error (HTTP ${err.status})`);
      return json({ error: 'payment provider error' }, 502);
    }
    console.error('timmy-pro: unhandled error', err instanceof Error ? err.message : String(err));
    return json({ error: 'internal error' }, 500);
  }
}

// ── routes ────────────────────────────────────────────────────────────────

async function checkout(request: Request, url: URL, deps: ProDeps): Promise<Response> {
  const fromWebForm = (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
  const body = fromWebForm ? {} : await readJson(request);
  const source = fromWebForm ? 'web' : body?.source === 'cli' ? 'cli' : 'api';
  const priceId = await proPriceId(deps);
  const origin = publicOrigin(url, deps.env);
  const session = await deps.stripe.createCheckoutSession({
    priceId,
    successUrl: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/?canceled=1`,
    source,
  });
  if (fromWebForm) return new Response(null, { status: 303, headers: { Location: session.url, ...SECURITY_HEADERS } });
  return json({ url: session.url, session_id: session.id });
}

async function welcome(url: URL, deps: ProDeps): Promise<Response> {
  const sessionId = url.searchParams.get('session_id') ?? '';
  if (!SESSION_ID.test(sessionId)) return html(messagePage('That link is not a Timmy Pro checkout link.'), 400);
  const settled = await settleCheckout(sessionId, deps);
  if (settled.state === 'invalid') return html(messagePage('We could not find a Timmy Pro purchase for that checkout.'), 404);
  if (settled.state === 'pending') return html(messagePage('Your payment is still processing. Refresh this page in a moment.'), 202);
  if (!canReveal(settled.record, deps.now())) return html(alreadyIssuedPage(), 410);
  return html(welcomePage(await keyFor(settled.record, deps), settled.record.status));
}

async function claim(request: Request, deps: ProDeps): Promise<Response> {
  const sessionId = String((await readJson(request))?.session_id ?? '');
  if (!SESSION_ID.test(sessionId)) throw new HttpError(400, 'invalid session_id');
  const settled = await settleCheckout(sessionId, deps);
  if (settled.state === 'invalid') throw new HttpError(404, 'no Timmy Pro purchase for that checkout');
  if (settled.state === 'pending') return json({ status: 'pending' }, 202);
  if (!canReveal(settled.record, deps.now())) throw new HttpError(410, 'license key already issued');
  const record = await requireActive(settled.record, deps);
  return json({ status: 'ready', key: await keyFor(record, deps), ...(await issueToken(record, deps)) });
}

async function activate(request: Request, deps: ProDeps): Promise<Response> {
  const record = await requireActive(await recordForKey((await readJson(request))?.key, deps), deps);
  return json(await issueToken(record, deps));
}

async function rotate(request: Request, deps: ProDeps): Promise<Response> {
  const current = await recordForKey((await readJson(request))?.key, deps);
  const next = await withLock(current.subscriptionId, async () => {
    const latest = (await deps.store.getBySubscription(current.subscriptionId)) ?? current;
    return saveRecord({ ...latest, keyVersion: latest.keyVersion + 1 }, deps);
  });
  return json({ key: await keyFor(next, deps) });
}

async function webhook(request: Request, deps: ProDeps): Promise<Response> {
  const raw = await request.text();
  const check = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), deps.env.STRIPE_WEBHOOK_SECRET, deps.now());
  if (!check.ok) {
    console.warn(`timmy-pro: webhook signature rejected (${check.reason})`);
    throw new HttpError(400, 'invalid signature');
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
  const eventId = typeof event?.id === 'string' ? event.id : '';
  if (!eventId) throw new HttpError(400, 'event has no id');
  if (await deps.store.hasProcessedEvent(eventId)) return json({ received: true, duplicate: true });

  const object = event?.data?.object ?? {};
  // The payload is only a hint about which object changed; the status always
  // comes from a fresh Stripe read (events can arrive late or out of order).
  if (CHECKOUT_EVENTS.has(event.type) && object.mode === 'subscription' && typeof object.id === 'string') {
    await settleCheckout(object.id, deps, { refresh: true });
  } else if (SUBSCRIPTION_EVENTS.has(event.type) && typeof object.id === 'string') {
    await syncSubscription(object.id, {}, deps);
  }
  await deps.store.markEventProcessed(eventId, deps.now());
  return json({ received: true });
}

// ── core ──────────────────────────────────────────────────────────────────

type Settled = { state: 'ready'; record: SubscriptionRecord } | { state: 'pending' } | { state: 'invalid' };

const unknownSessions = new Map<string, number>();
const UNKNOWN_TTL = 600;

async function settleCheckout(sessionId: string, deps: ProDeps, opts: { refresh?: boolean } = {}): Promise<Settled> {
  const now = deps.now();
  if (!opts.refresh) {
    const known = await deps.store.getByCheckoutSession(sessionId);
    if (known) return { state: 'ready', record: known };
    if ((unknownSessions.get(sessionId) ?? 0) > now) return { state: 'invalid' };
  }

  let info;
  try {
    info = await deps.stripe.retrieveCheckoutSession(sessionId);
  } catch (err) {
    if (err instanceof StripeApiError && err.status === 404) {
      if (unknownSessions.size >= 1000) unknownSessions.clear();
      unknownSessions.set(sessionId, now + UNKNOWN_TTL);
      return { state: 'invalid' };
    }
    throw err;
  }
  if (info.mode !== 'subscription') return { state: 'invalid' };
  if (info.status !== 'complete' || !PAID.has(info.paymentStatus ?? '') || !info.subscription) return { state: 'pending' };
  if (!isProSubscription(info.subscription, deps.env)) return { state: 'invalid' };
  const record = await syncSubscription(info.subscription.id, { customerId: info.customerId, email: info.email, checkoutSessionId: info.id }, deps);
  return record ? { state: 'ready', record } : { state: 'invalid' };
}

/** Only a subscription to the Timmy Pro price unlocks Pro — not any subscription on the account. */
function isProSubscription(sub: SubscriptionInfo, env: ProEnv): boolean {
  return sub.priceLookupKeys.includes(PRO_PLAN.lookupKey) || (!!env.STRIPE_PRICE_PRO && sub.priceIds.includes(env.STRIPE_PRICE_PRO));
}

/** Re-reads the subscription from Stripe inside its lock and records it; null when it is not a Pro subscription. */
function syncSubscription(
  subscriptionId: string,
  extra: { customerId?: string | null; email?: string | null; checkoutSessionId?: string | null },
  deps: ProDeps,
): Promise<SubscriptionRecord | null> {
  return withLock(subscriptionId, async () => {
    const fresh = await deps.stripe.retrieveSubscription(subscriptionId);
    if (!fresh || !isProSubscription(fresh, deps.env)) return null;
    const existing = await deps.store.getBySubscription(subscriptionId);
    const now = deps.now();
    return saveRecord({
      subscriptionId,
      customerId: extra.customerId ?? fresh.customerId ?? existing?.customerId ?? null,
      email: extra.email ?? existing?.email ?? null,
      status: fresh.status,
      currentPeriodEnd: fresh.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
      keyVersion: existing?.keyVersion ?? 1,
      keyHash: existing?.keyHash ?? '',
      checkoutSessionId: extra.checkoutSessionId ?? existing?.checkoutSessionId ?? null,
      createdAt: existing?.createdAt ?? now,
      pastDueSince: fresh.status === 'past_due' ? (existing?.pastDueSince ?? now) : null,
      updatedAt: now,
    }, deps);
  });
}

/** Refreshes from Stripe if the period looks over (a missed webhook), then requires the plan to be on. */
async function requireActive(record: SubscriptionRecord, deps: ProDeps): Promise<SubscriptionRecord> {
  const now = deps.now();
  const stale = record.currentPeriodEnd !== null && record.currentPeriodEnd + PERIOD_GRACE <= now;
  const current = stale ? await syncSubscription(record.subscriptionId, {}, deps) : record;
  if (!current) throw new HttpError(403, 'subscription not active', { status: 'unknown' });
  if (!isProActive(current.status, current.pastDueSince, now)) throw new HttpError(403, 'subscription not active', { status: current.status });
  return current;
}

const canReveal = (record: SubscriptionRecord, now: number) => record.keyVersion === 1 && now - record.createdAt <= REVEAL_WINDOW;

/** Recomputes the key hash for the record's key version, then stores it. */
async function saveRecord(record: SubscriptionRecord, deps: ProDeps): Promise<SubscriptionRecord> {
  const keyHash = await licenseKeyHash(await keyFor(record, deps));
  const saved = { ...record, keyHash, updatedAt: deps.now() };
  await deps.store.upsert(saved);
  return saved;
}

async function keyFor(record: SubscriptionRecord, deps: ProDeps): Promise<string> {
  if (!deps.env.LICENSE_KEY_SECRET) throw unavailable('LICENSE_KEY_SECRET is not set');
  return deriveLicenseKey(deps.env.LICENSE_KEY_SECRET, record.subscriptionId, record.keyVersion);
}

async function recordForKey(input: unknown, deps: ProDeps): Promise<SubscriptionRecord> {
  const key = normalizeLicenseKey(typeof input === 'string' ? input : null);
  if (!key) throw new HttpError(400, 'that is not a Timmy Pro license key');
  const record = await deps.store.getByKeyHash(await licenseKeyHash(key));
  if (!record) throw new HttpError(404, 'unknown license key');
  return record;
}

let signingKeyCache: { pkcs8: string; key: Promise<CryptoKey> } | null = null;

async function issueToken(record: SubscriptionRecord, deps: ProDeps): Promise<{ token: string; claims: LicenseClaims }> {
  const pkcs8 = deps.env.LICENSE_SIGNING_KEY;
  if (!pkcs8) throw unavailable('LICENSE_SIGNING_KEY is not set');
  if (!signingKeyCache || signingKeyCache.pkcs8 !== pkcs8) signingKeyCache = { pkcs8, key: importSigningKey(pkcs8) };
  const now = deps.now();
  let expiresAt = now + TOKEN_TTL;
  if (record.currentPeriodEnd) expiresAt = Math.min(expiresAt, record.currentPeriodEnd + PERIOD_GRACE);
  if (record.status === 'past_due' && record.pastDueSince !== null) expiresAt = Math.min(expiresAt, record.pastDueSince + PAST_DUE_GRACE_SECONDS);
  // Stripe was just consulted (requireActive) and says the plan is on; a renewal may still be landing.
  if (expiresAt <= now) expiresAt = now + DAY;
  const claims = proClaims({
    subscriptionRef: (await sha256Hex(record.subscriptionId)).slice(0, 16),
    status: record.status,
    issuedAt: now,
    expiresAt,
  });
  return { token: await signLicenseToken(claims, await signingKeyCache.key), claims };
}

let priceCache: { id: string; until: number } | null = null;

async function proPriceId(deps: ProDeps): Promise<string> {
  if (deps.env.STRIPE_PRICE_PRO) return deps.env.STRIPE_PRICE_PRO;
  const now = deps.now();
  if (priceCache && priceCache.until > now) return priceCache.id;
  const id = await deps.stripe.findPriceIdByLookupKey(PRO_PLAN.lookupKey);
  if (!id) throw unavailable(`no active Stripe price with lookup key ${PRO_PLAN.lookupKey}`);
  priceCache = { id, until: now + 600 };
  return id;
}

function billingUrl(env: ProEnv): string {
  const link = env.STRIPE_PORTAL_LOGIN_URL ?? '';
  if (!/^https:\/\/[^\s]+$/.test(link)) throw unavailable('STRIPE_PORTAL_LOGIN_URL is not set');
  return link;
}

// Serializes read-modify-write per subscription. A Durable Object lets other
// requests run while one awaits Stripe, so without this two events for the same
// subscription could interleave and the slower (staler) read would win.
const lockTails = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = prior.then(() => mine);
  lockTails.set(key, tail);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

/** Test seam: clears the in-memory caches between test cases. */
export function resetProCaches(): void {
  unknownSessions.clear();
  priceCache = null;
  signingKeyCache = null;
}

// ── responses ─────────────────────────────────────────────────────────────

function publicOrigin(url: URL, env: ProEnv): string {
  return (env.PUBLIC_URL || url.origin).replace(/\/+$/, '');
}

async function readJson(request: Request): Promise<any> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return null;
  return request.json().catch(() => null);
}

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // form-action must also allow the 303 hop to Stripe Checkout: browsers apply it to redirects.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'",
      ...SECURITY_HEADERS,
    },
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;background:#000;color:#fff;font:17px/1.55 "Avenir Next",Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:56px 20px}
h1{font-size:34px;line-height:1.15;margin:0 0 8px}.label{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7CFF8A}
ul{padding-left:20px}li{margin:6px 0}.price{font-size:44px;font-weight:700;margin:16px 0 4px}
button{background:#7CFF8A;color:#000;border:0;border-radius:8px;padding:14px 22px;font:600 17px "Avenir Next",Helvetica,sans-serif;cursor:pointer}
code,.key{font-family:ui-monospace,Menlo,monospace}.key{display:block;font-size:20px;padding:16px;border:1px solid #fff;border-radius:8px;margin:16px 0;word-break:break-all}
code{background:#111;padding:2px 6px;border-radius:4px}.note{border-left:3px solid #7CFF8A;padding-left:12px}
</style></head><body><main>${inner}</main></body></html>`;
}

function landingPage(canceled: boolean): string {
  const features = PRO_FEATURES.map((f) => `<li>${escapeHtml(PRO_FEATURE_LABELS[f])}</li>`).join('');
  return page(PRO_PLAN.name, `<div class="label">Timmy Pro</div><h1>Hosted receipts, logs and runs for Timmy.</h1>
<div class="price">$${PRO_PLAN.priceUsdMonthly}<span style="font-size:18px;font-weight:400"> / month</span></div>
<ul>${features}</ul>
${canceled ? '<p class="note">Checkout canceled. Nothing was charged.</p>' : ''}
<form method="post" action="/checkout"><button type="submit">Upgrade to Pro</button></form>
<p>Free Timmy stays fully local. Pro features are hosted and opt-in.</p>`);
}

function welcomePage(key: string, status: string): string {
  const safeKey = escapeHtml(key);
  return page('Welcome to Timmy Pro', `<div class="label">You're Pro</div><h1>Welcome to Timmy Pro.</h1>
<p>Your license key:</p><span class="key">${safeKey}</span>
<p>Activate it in your terminal:</p><p><code>timmy pro activate ${safeKey}</code></p>
<p class="note">Save it now: this page shows the key for 24 hours only. Keep it private; anyone who has it can use your plan.
If it ever leaks, run <code>timmy pro rotate</code> to replace it. Subscription status: <strong>${escapeHtml(status)}</strong>.</p>
<p>Manage or cancel any time with <code>timmy pro billing</code>.</p>`);
}

function alreadyIssuedPage(): string {
  return page('Timmy Pro', `<div class="label">Timmy Pro</div><h1>Your license key was already issued.</h1>
<p>For your security this link only shows the key once, for 24 hours. Use the key you saved with <code>timmy pro activate</code>.</p>
<p>Lost it? Reply to your Stripe receipt email and we'll help.</p>`);
}

function messagePage(message: string): string {
  return page('Timmy Pro', `<div class="label">Timmy Pro</div><h1>${escapeHtml(message)}</h1>`);
}
