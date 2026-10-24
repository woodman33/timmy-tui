/**
 * R11 round 4 (H173, contract C1): a Clerk session token verified by this server, the one way a request gets a user.
 *
 * The page sends `clerk.session.getToken()` (a short-lived RS256 JWT the instance signs) in the request header
 * X-Timmy-Session (never a query string, never a cookie of this server's) and in its WebSocket hello's `session` field.
 * This module verifies it with `jose`:
 *   - against CLERK_JWT_KEY, the instance's PEM public key (cfg.verifier 'pem'): no network, nothing asked of anyone;
 *   - or, with only CLERK_SECRET_KEY set (cfg.verifier 'jwks'), against the instance's JWKS at
 *     <frontendApi>/.well-known/jwks.json, fetched once per address and kept for the process (jose's remote set, which
 *     refetches only for an unknown key id, with its own cooldown); when the network is not there, the request is refused
 *     with words, and nothing is assumed.
 * Claims checked: the signature (RS256 only); exp and nbf, with 5 s of leeway; sub, the user, which must have Clerk's
 * `user_…` shape (anything else is refused: no other id ever becomes a user); sid, the session; azp, when the token carries
 * one, must be one of the page's own origins (the companion's http://<host>); iss, when the frontend API is known and the
 * token carries one, must be it. The token is never logged, never repeated in words, never written anywhere.
 *
 * Who the user is: `sub` (id) and `sid` (sessionId) always; `username` and `email` when the instance's JWT template adds
 * them (a session token carries none by default: the dashboard's JWT templates can add {{user.username}} and
 * {{user.primary_email_address}} under those names). The page shows the account from clerk.user; the server needs the id.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { createPublicKey, type KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { IdentityConfig } from './config.js';

export interface SessionUser {
  /** Clerk's user id: user_ followed by letters and digits. */
  id: string;
  /** Clerk's session id (sid). */
  sessionId: string;
  username?: string;
  email?: string;
}

export type SessionResult = { ok: true; user: SessionUser } | { ok: false; why: string };

/** Clerk's user id shape; a user id of any other shape is refused everywhere (session, scope). */
export const USER_ID = /^user_[A-Za-z0-9]{8,64}$/;
/** Clerk's session id shape. */
export const SESSION_ID = /^sess_[A-Za-z0-9]{8,64}$/;
/** The request header the page sends its session in (lower case, as node gives headers). */
export const SESSION_HEADER = 'x-timmy-session';
/** The leeway on exp and nbf, in seconds. */
export const CLOCK_LEEWAY_S = 5;
/** A token longer than this is not a session token of anyone's. */
const MAX_TOKEN = 8192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface VerifyOptions {
  /** The moment to check exp and nbf against (a test's); now when absent. */
  now?: Date | number;
  /** The page's own origins (http://127.0.0.1:<port>, http://localhost:<port>, with --lan the LAN addresses): azp must be one of them when present. */
  origins?: readonly string[];
  /** A test's FAKE JWKS address on 127.0.0.1, in place of cfg.jwks (never used outside a test). */
  jwks?: string;
}

/** The words a refusal gives, in one place, so the same cause says the same thing on every route. */
export const SESSION_WORDS = Object.freeze({
  notConfigured: 'Refused: Timmy\'s identity provider is not configured on this companion, so no session can be verified and nothing signs in.',
  absent: 'Refused: this needs a signed-in Timmy account. The page sends its session in the X-Timmy-Session header with every request; none was sent.',
  shape: 'Refused: what was sent as the session is not a session token.',
  signature: 'Refused: the session token\'s signature is not this instance\'s, so it is not trusted.',
  expired: 'Refused: the session token has expired; the page refreshes it before each request, so reload the page or sign in again.',
  notYet: 'Refused: the session token is not valid yet (its nbf is ahead of this computer\'s clock).',
  noSubject: 'Refused: the session token names no user (sub).',
  badSubject: 'Refused: the session token\'s user is not a Clerk user id (user_…), so it is not one Timmy keeps anything for.',
  noSession: 'Refused: the session token names no session (sid).',
  badParty: 'Refused: the session token was issued to another page (azp), not to this companion\'s.',
  badIssuer: 'Refused: the session token was issued by another instance (iss), not the one this companion is configured with.',
  algorithm: 'Refused: the session token is not signed the way Clerk signs sessions (RS256).',
  jwksUnreachable: 'Refused: the instance\'s signing keys (JWKS) could not be fetched from the network, so the session cannot be verified; set CLERK_JWT_KEY (the instance\'s public key) to verify without the network.',
  jwksNoKey: 'Refused: the session token was signed with a key the instance\'s JWKS does not list.',
});

/** The session token of a request: its X-Timmy-Session header, and nothing else (no query, no cookie, no body). */
export function sessionTokenOf(headers: IncomingHttpHeaders): string | null {
  const h = headers[SESSION_HEADER];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The page's own origins for a request's Host: what Clerk puts in azp for a page served there. */
export function originsOf(host: string | undefined, lan: readonly string[] = []): string[] {
  const out: string[] = [];
  if (typeof host === 'string' && /^[A-Za-z0-9.\-[\]:]+$/.test(host)) {
    out.push(`http://${host.toLowerCase()}`);
    // the same page by its other local name (a token minted on localhost is the same page as 127.0.0.1)
    const m = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.exec(host);
    if (m) for (const name of ['127.0.0.1', 'localhost', '[::1]']) out.push(`http://${name}${m[2] ?? ''}`);
  }
  for (const a of lan) out.push(`http://${a}`);
  return [...new Set(out)];
}

// the remote key sets, one per address, kept for the process: fetched once, refetched by jose only for an unknown key id
const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const pemKeys = new Map<string, KeyObject>();

function keyFor(cfg: IdentityConfig, opts: VerifyOptions): { key: KeyObject | ReturnType<typeof createRemoteJWKSet> } | { why: string } {
  if (cfg.verifier === 'pem' && cfg.jwtKey) {
    let k = pemKeys.get(cfg.jwtKey);
    if (!k) {
      try { k = createPublicKey(cfg.jwtKey); } catch { return { why: 'Refused: CLERK_JWT_KEY is set but node cannot read it as a public key, so no session can be verified.' }; }
      if (k.asymmetricKeyType !== 'rsa') return { why: 'Refused: CLERK_JWT_KEY is not an RSA public key, and Clerk signs sessions with RS256, so no session can be verified.' };
      pemKeys.set(cfg.jwtKey, k);
    }
    return { key: k };
  }
  const address = opts.jwks ?? cfg.jwks;
  if (cfg.verifier === 'jwks' && address) {
    let set = remoteSets.get(address);
    if (!set) { set = createRemoteJWKSet(new URL(address), { timeoutDuration: 5000, cooldownDuration: 30000 }); remoteSets.set(address, set); }
    return { key: set };
  }
  return { why: SESSION_WORDS.notConfigured };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Verifies a session token against the configuration: the user, or why not. `token` is what the request sent (anything;
 * only a string of a JWT's shape is even parsed). The words never repeat the token.
 */
export async function verifySession(token: unknown, cfg: IdentityConfig, opts: VerifyOptions = {}): Promise<SessionResult> {
  if (!cfg.configured) return { ok: false, why: SESSION_WORDS.notConfigured };
  if (token === undefined || token === null || token === '') return { ok: false, why: SESSION_WORDS.absent };
  if (typeof token !== 'string' || token.length > MAX_TOKEN || !JWT_SHAPE.test(token)) return { ok: false, why: SESSION_WORDS.shape };
  const k = keyFor(cfg, opts);
  if ('why' in k) return { ok: false, why: k.why };
  const now = opts.now === undefined ? new Date() : new Date(opts.now);
  let payload: JWTPayload;
  const check = { algorithms: ['RS256'], clockTolerance: CLOCK_LEEWAY_S, currentDate: now, requiredClaims: ['exp', 'sub', 'sid'] };
  try {
    // two overloads of jwtVerify: a key, or a key-resolving function (the remote set)
    ({ payload } = typeof k.key === 'function' ? await jwtVerify(token, k.key, check) : await jwtVerify(token, k.key, check));
  } catch (err) {
    return { ok: false, why: refusalOf(err) };
  }
  const sub = str(payload.sub);
  if (!sub) return { ok: false, why: SESSION_WORDS.noSubject };
  if (!USER_ID.test(sub)) return { ok: false, why: SESSION_WORDS.badSubject };
  const sid = str(payload.sid);
  if (!sid) return { ok: false, why: SESSION_WORDS.noSession };
  const azp = str(payload.azp);
  if (azp !== undefined) {
    const origins = (opts.origins ?? []).map((o) => o.toLowerCase().replace(/\/$/, ''));
    if (!origins.includes(azp.toLowerCase().replace(/\/$/, ''))) return { ok: false, why: SESSION_WORDS.badParty };
  }
  const iss = str(payload.iss);
  if (iss !== undefined && cfg.frontendApi && iss.replace(/\/$/, '').toLowerCase() !== cfg.frontendApi.toLowerCase()) return { ok: false, why: SESSION_WORDS.badIssuer };
  const username = str(payload.username);
  const email = str(payload.email) ?? str(payload.primary_email_address) ?? str(payload.email_address);
  return { ok: true, user: { id: sub, sessionId: sid, ...(username ? { username } : {}), ...(email ? { email } : {}) } };
}

/** The words for what jose refused: by its error class and claim, never by repeating the token. */
function refusalOf(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return SESSION_WORDS.expired;
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'nbf') return SESSION_WORDS.notYet;
    if (err.claim === 'sub') return SESSION_WORDS.noSubject;
    if (err.claim === 'sid') return SESSION_WORDS.noSession;
    if (err.claim === 'exp') return SESSION_WORDS.expired;
    return `Refused: the session token's ${err.claim} claim is not acceptable.`;
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return SESSION_WORDS.signature;
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return SESSION_WORDS.algorithm;
  if (err instanceof joseErrors.JWKSNoMatchingKey) return SESSION_WORDS.jwksNoKey;
  if (err instanceof joseErrors.JWKSTimeout) return SESSION_WORDS.jwksUnreachable;
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return SESSION_WORDS.shape;
  // a JWKS fetch that failed (no network, a refused connection, a non-JSON answer): the fetch's own error, or jose's words
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('ERR_JWKS')) return SESSION_WORDS.jwksUnreachable;
  if (err instanceof TypeError || (err as { name?: unknown } | null)?.name === 'AbortError') return SESSION_WORDS.jwksUnreachable;
  return SESSION_WORDS.signature;
}

/** For tests and the handoff: forgets the kept key sets (a FAKE JWKS address is not reused across tests). */
export function forgetKeys(): void { remoteSets.clear(); pemKeys.clear(); }
