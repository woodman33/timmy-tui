// Minimal Stripe REST client for the Pro Worker: four calls, form-encoded, no SDK.
// Errors carry Stripe's message and HTTP status but never the request's secret.

export interface CheckoutSessionInfo {
  id: string;
  mode: string | null;
  status: string | null;
  paymentStatus: string | null;
  customerId: string | null;
  email: string | null;
  subscription: SubscriptionInfo | null;
}

export interface SubscriptionInfo {
  id: string;
  status: string;
  customerId: string | null;
  /** Unix seconds; read from the subscription or, on newer API versions, its first item. */
  currentPeriodEnd: number | null;
  /** Price ids and lookup keys on the subscription's items: what was actually bought. */
  priceIds: string[];
  priceLookupKeys: string[];
}

export interface StripeClient {
  createCheckoutSession(input: { priceId: string; successUrl: string; cancelUrl: string; source: string }): Promise<{ id: string; url: string }>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionInfo>;
  retrieveSubscription(id: string): Promise<SubscriptionInfo | null>;
  findPriceIdByLookupKey(lookupKey: string): Promise<string | null>;
}

export class StripeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'StripeApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.stripe.com/v1';

export function stripeClient(secretKey: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): StripeClient {
  async function call(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<any> {
    if (!secretKey) throw new StripeApiError('Stripe secret key not configured', 500);
    const body = new URLSearchParams(params).toString();
    const url = method === 'GET' && body ? `${API}${path}?${body}` : `${API}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'POST' ? body : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new StripeApiError(json?.error?.message ?? `Stripe returned HTTP ${res.status}`, res.status);
    return json;
  }

  return {
    async createCheckoutSession({ priceId, successUrl, cancelUrl, source }) {
      const session = await call('POST', '/checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        success_url: successUrl,
        cancel_url: cancelUrl,
        'metadata[product]': 'timmy_pro',
        'metadata[source]': source,
        'subscription_data[metadata][product]': 'timmy_pro',
      });
      return { id: String(session.id), url: String(session.url) };
    },
    async retrieveCheckoutSession(id) {
      const s = await call('GET', `/checkout/sessions/${encodeURIComponent(id)}`, { 'expand[]': 'subscription' });
      return parseCheckoutSession(s);
    },
    async retrieveSubscription(id) {
      return parseSubscription(await call('GET', `/subscriptions/${encodeURIComponent(id)}`));
    },
    async findPriceIdByLookupKey(lookupKey) {
      const list = await call('GET', '/prices', { 'lookup_keys[]': lookupKey, active: 'true', limit: '1' });
      return list?.data?.[0]?.id ?? null;
    },
  };
}

export function parseSubscription(raw: any): SubscriptionInfo | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const items: any[] = Array.isArray(raw.items?.data) ? raw.items.data : [];
  const periodEnd = raw.current_period_end ?? items[0]?.current_period_end ?? null;
  const prices = items.map((item) => item?.price).filter((price) => price && typeof price === 'object');
  return {
    id: raw.id,
    status: String(raw.status ?? 'unknown'),
    customerId: typeof raw.customer === 'string' ? raw.customer : raw.customer?.id ?? null,
    currentPeriodEnd: typeof periodEnd === 'number' ? periodEnd : null,
    priceIds: prices.map((price) => String(price.id)),
    priceLookupKeys: prices.map((price) => price.lookup_key).filter((key): key is string => typeof key === 'string'),
  };
}

export function parseCheckoutSession(raw: any): CheckoutSessionInfo {
  return {
    id: String(raw?.id ?? ''),
    mode: raw?.mode ?? null,
    status: raw?.status ?? null,
    paymentStatus: raw?.payment_status ?? null,
    customerId: typeof raw?.customer === 'string' ? raw.customer : raw?.customer?.id ?? null,
    email: raw?.customer_details?.email ?? raw?.customer_email ?? null,
    subscription: typeof raw?.subscription === 'object' ? parseSubscription(raw.subscription) : null,
  };
}
