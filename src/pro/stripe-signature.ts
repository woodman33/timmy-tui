// Stripe webhook signature check (https://docs.stripe.com/webhooks#verify-manually).
//
// The `Stripe-Signature` header carries `t=<unix seconds>` and one or more
// `v1=<hex HMAC-SHA256>` entries. The signed payload is `${t}.${rawBody}` —
// the raw request text, never re-serialized JSON. A request is genuine only if
// one v1 matches under the endpoint's signing secret and `t` is recent.

import { hmacSha256, timingSafeEqual, toHex } from './encoding.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: string };

export async function verifyStripeSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<SignatureCheck> {
  if (!secret) return { ok: false, reason: 'webhook signing secret not configured' };
  if (!header) return { ok: false, reason: 'missing Stripe-Signature header' };

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'malformed Stripe-Signature header' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: 'timestamp outside tolerance' };

  const expected = toHex(await hmacSha256(secret, `${timestamp}.${rawBody}`));
  let matched = false;
  for (const candidate of signatures) matched = timingSafeEqual(candidate, expected) || matched;
  return matched ? { ok: true, timestamp } : { ok: false, reason: 'no matching signature' };
}

/** Builds a valid header for a payload, as `stripe trigger` would; used by tests and local tooling. */
export async function signStripePayload(rawBody: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${toHex(await hmacSha256(secret, `${timestamp}.${rawBody}`))}`;
}
