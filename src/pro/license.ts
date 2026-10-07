// Timmy Pro license keys and license tokens.
//
// A license KEY (`tpro_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`) is what a buyer
// keeps. The server derives it from the Stripe subscription id with an HMAC
// secret and stores only its SHA-256, so a leaked database leaks no keys, a key
// can be shown again to its buyer, and rotating (version + 1) revokes the old one.
//
// A license TOKEN is the short-lived offline proof the CLI keeps: claims signed
// with ed25519, the same signature family Timmy uses for receipts. The CLI
// verifies it with a public key compiled into the build, so editing a local
// file cannot fake Pro. Hosted Pro features still check the key server-side.

import { PRO_FEATURES, isActiveStatus, type ProFeature } from './plan.js';
import { fromBase64Url, fromUtf8, hmacSha256, isCrockford, sha256Hex, toBase64Url, toCrockford, utf8 } from './encoding.js';

export const LICENSE_KEY_PREFIX = 'tpro_';
const KEY_BODY_CHARS = 32; // 20 HMAC bytes = 160 bits in Crockford base32

export async function deriveLicenseKey(secret: string, subscriptionId: string, version: number): Promise<string> {
  if (!secret) throw new Error('license key secret not configured');
  if (!Number.isInteger(version) || version < 1) throw new Error('license key version must be a positive integer');
  const mac = await hmacSha256(secret, `timmy-pro-key|v1|${subscriptionId}|${version}`);
  const body = toCrockford(mac.slice(0, 20)).slice(0, KEY_BODY_CHARS);
  return LICENSE_KEY_PREFIX + (body.match(/.{8}/g) ?? []).join('-');
}

/** Canonical form of a typed or pasted key, or null when it cannot be a key. */
export function normalizeLicenseKey(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith(LICENSE_KEY_PREFIX)) return null;
  const body = trimmed.slice(LICENSE_KEY_PREFIX.length).replace(/[\s-]/g, '').toUpperCase()
    .replace(/[IL]/g, '1').replace(/O/g, '0');
  if (body.length !== KEY_BODY_CHARS || !isCrockford(body)) return null;
  return LICENSE_KEY_PREFIX + (body.match(/.{8}/g) ?? []).join('-');
}

export const licenseKeyHash = (canonicalKey: string): Promise<string> => sha256Hex(canonicalKey);

// ── tokens ────────────────────────────────────────────────────────────────

export const TOKEN_PREFIX = 'tpro1';

export interface LicenseClaims {
  v: 1;
  plan: 'pro';
  features: ProFeature[];
  /** Stripe subscription status when the token was issued. */
  status: string;
  /** Pseudonymous subscription reference (first 16 hex of its SHA-256). */
  sub: string;
  iat: number;
  exp: number;
}

/** Why a token was refused, as a code callers can branch on; `reason` is the human wording. */
export type TokenProblem = 'missing' | 'not_timmy' | 'malformed' | 'bad_signature' | 'unsupported' | 'inactive' | 'expired' | 'future';

export type TokenCheck = { ok: true; claims: LicenseClaims } | { ok: false; code: TokenProblem; reason: string };

export async function signLicenseToken(claims: LicenseClaims, privateKey: CryptoKey): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, utf8(signingInput));
  return `${signingInput}.${toBase64Url(signature)}`;
}

export async function verifyLicenseToken(
  token: string | null | undefined,
  publicKey: CryptoKey,
  nowSeconds: number,
  clockSkewSeconds = 300,
): Promise<TokenCheck> {
  if (typeof token !== 'string') return { ok: false, code: 'missing', reason: 'no license token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, code: 'not_timmy', reason: 'not a Timmy Pro token' };
  const payloadBytes = fromBase64Url(parts[1]);
  const signature = fromBase64Url(parts[2]);
  if (!payloadBytes || !signature) return { ok: false, code: 'malformed', reason: 'malformed token' };
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, utf8(`${parts[0]}.${parts[1]}`));
  if (!valid) return { ok: false, code: 'bad_signature', reason: 'signature does not verify' };
  let claims: LicenseClaims;
  try {
    claims = JSON.parse(fromUtf8(payloadBytes)) as LicenseClaims;
  } catch {
    return { ok: false, code: 'malformed', reason: 'malformed token claims' };
  }
  if (claims?.v !== 1 || claims.plan !== 'pro' || !Array.isArray(claims.features)) return { ok: false, code: 'unsupported', reason: 'unsupported token' };
  if (!isActiveStatus(claims.status)) return { ok: false, code: 'inactive', reason: 'subscription not active' };
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { ok: false, code: 'expired', reason: 'token expired' };
  if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + clockSkewSeconds) return { ok: false, code: 'future', reason: 'token issued in the future' };
  return { ok: true, claims };
}

export function proClaims(input: { subscriptionRef: string; status: string; issuedAt: number; expiresAt: number }): LicenseClaims {
  return { v: 1, plan: 'pro', features: [...PRO_FEATURES], status: input.status, sub: input.subscriptionRef, iat: input.issuedAt, exp: input.expiresAt };
}

// ── keys ──────────────────────────────────────────────────────────────────

export async function importSigningKey(pkcs8Base64Url: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(pkcs8Base64Url.trim());
  if (!bytes) throw new Error('license signing key is not base64url');
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, false, ['sign']);
}

export async function importVerifyKey(rawBase64Url: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(rawBase64Url.trim());
  if (!bytes || bytes.length !== 32) throw new Error('license public key must be 32 raw bytes, base64url');
  return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
}

export async function generateLicenseKeyPair(): Promise<{ privatePkcs8: string; publicRaw: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    privatePkcs8: toBase64Url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    publicRaw: toBase64Url(await crypto.subtle.exportKey('raw', pair.publicKey)),
  };
}
