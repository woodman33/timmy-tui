// The wire contract between the `timmy pro` client and the Pro worker that the
// two sides share. Every error the worker returns is JSON with a human `error`
// message and one of these stable codes; clients branch on the code, never on
// the wording or on a bare HTTP status.

export const PRO_ERROR_CODES = [
  'invalid_request',
  'invalid_key',
  'unknown_key',
  'unknown_checkout',
  'key_already_issued',
  'subscription_inactive',
  'invalid_signature',
  'not_found',
  'method_not_allowed',
  'rate_limited',
  'unavailable',
  'payment_provider_error',
  'internal_error',
] as const;

export type ProErrorCode = (typeof PRO_ERROR_CODES)[number];

export function isProErrorCode(value: unknown): value is ProErrorCode {
  return typeof value === 'string' && (PRO_ERROR_CODES as readonly string[]).includes(value);
}

/** A Stripe Checkout Session id, the only checkout reference either side accepts. */
export const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
