import { describe, expect, it } from 'vitest';
import { signStripePayload, verifyStripeSignature } from '../src/pro/stripe-signature.js';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000;
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

describe('Stripe webhook signature', () => {
  it('accepts a body signed with the endpoint secret', async () => {
    const header = await signStripePayload(BODY, SECRET, NOW);
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: true, timestamp: NOW });
  });

  it('rejects a body changed after signing', async () => {
    const header = await signStripePayload(BODY, SECRET, NOW);
    const check = await verifyStripeSignature(BODY.replace('updated', 'deleted'), header, SECRET, NOW);
    expect(check).toEqual({ ok: false, reason: 'no matching signature' });
  });

  it('rejects a signature made with another secret', async () => {
    const header = await signStripePayload(BODY, 'whsec_attacker', NOW);
    expect((await verifyStripeSignature(BODY, header, SECRET, NOW)).ok).toBe(false);
  });

  it('rejects replays outside the five-minute tolerance', async () => {
    const header = await signStripePayload(BODY, SECRET, NOW - 301);
    expect(await verifyStripeSignature(BODY, header, SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('accepts when any one of several v1 signatures matches (secret rotation)', async () => {
    const good = await signStripePayload(BODY, SECRET, NOW);
    const header = `t=${NOW},v1=${'0'.repeat(64)},${good.split(',')[1]}`;
    expect((await verifyStripeSignature(BODY, header, SECRET, NOW)).ok).toBe(true);
  });

  it('fails closed on a missing header, a malformed header, or no configured secret', async () => {
    expect(await verifyStripeSignature(BODY, null, SECRET, NOW)).toEqual({ ok: false, reason: 'missing Stripe-Signature header' });
    expect(await verifyStripeSignature(BODY, 'v1=abc', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed Stripe-Signature header' });
    const header = await signStripePayload(BODY, SECRET, NOW);
    expect(await verifyStripeSignature(BODY, header, '', NOW)).toEqual({ ok: false, reason: 'webhook signing secret not configured' });
  });
});
