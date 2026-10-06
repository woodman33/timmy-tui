import { describe, expect, it } from 'vitest';
import { parseSubscription, stripeClient, StripeApiError } from '../src/pro/stripe-api.js';

describe('Stripe REST client', () => {
  it('creates subscription checkouts without promotion codes and tags them as Timmy Pro', async () => {
    const seen: { url: string; body: string }[] = [];
    const client = stripeClient('sk_test_x', async (url, init) => {
      seen.push({ url, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }), { status: 200 });
    });
    await client.createCheckoutSession({ priceId: 'price_1', successUrl: 'https://a/welcome', cancelUrl: 'https://a/', source: 'cli' });
    const params = new URLSearchParams(seen[0].body);
    expect(seen[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('line_items[0][price]')).toBe('price_1');
    expect(params.get('subscription_data[metadata][product]')).toBe('timmy_pro');
    expect(params.has('allow_promotion_codes')).toBe(false);
  });

  it('turns Stripe errors into StripeApiError without echoing the key', async () => {
    const client = stripeClient('sk_test_secret', async () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 404 }));
    const err = await client.findPriceIdByLookupKey('x').catch((e) => e);
    expect(err).toBeInstanceOf(StripeApiError);
    expect(err.status).toBe(404);
    expect(String(err.message)).not.toContain('sk_test_secret');
  });

  it('reads price identity and the period end from either API shape', () => {
    const newer = parseSubscription({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ current_period_end: 123, price: { id: 'price_1', lookup_key: 'timmy_pro_monthly' } }] } });
    expect(newer).toEqual({ id: 'sub_1', status: 'active', customerId: 'cus_1', currentPeriodEnd: 123, priceIds: ['price_1'], priceLookupKeys: ['timmy_pro_monthly'] });
    expect(parseSubscription({ id: 'sub_2', status: 'canceled', current_period_end: 456, items: { data: [] } })?.currentPeriodEnd).toBe(456);
    expect(parseSubscription(null)).toBeNull();
  });
});
