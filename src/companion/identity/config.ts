/**
 * R11 round 4 (H173, contract C1): whether Timmy's identity provider (Clerk) is configured, read from the environment and
 * nothing else. Node only: no network, nobody asked. The companion's GET /api/identity answers the page with the public part
 * (pageIdentity), and the account screen stays reviewable in the "needs" state, naming the exact environment names, when
 * it is not; nothing signs in then.
 *
 *   configured      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY) is set and well formed, AND one verifier is
 *                   set: CLERK_JWT_KEY (the instance's public key, PEM: verification needs no network) or CLERK_SECRET_KEY
 *                   (then the instance's JWKS, <frontendApi>/.well-known/jwks.json, is fetched once and kept).
 *   frontendApi     derived from the publishable key's own shape: pk_test_ or pk_live_ followed by base64 of the instance's
 *                   frontend API host with a trailing $ (Clerk's format), so https://<host>. Never asked of anyone.
 *   needs           the exact environment names missing (or unusable), in the order to set them; empty when configured.
 *   words           one line a person reads.
 *
 * Nothing here returns a secret: CLERK_SECRET_KEY is reported as set or not (secretKeySet), never carried; CLERK_JWT_KEY is
 * the instance's PUBLIC key and is carried for the verifier (session.ts) but never sent to the page (pageIdentity strips it).
 */
import type { Env } from '../../setup/home.js';

export type { Env };

/** The environment names, in the order a person sets them. */
export const IDENTITY_ENV = Object.freeze({
  publishable: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  publishableAlt: 'CLERK_PUBLISHABLE_KEY',
  jwtKey: 'CLERK_JWT_KEY',
  secretKey: 'CLERK_SECRET_KEY',
});

/** How a session token is verified: against the PEM public key (no network), the instance's JWKS, or not at all. */
export type IdentityVerifier = 'pem' | 'jwks' | 'none';

export interface IdentityConfig {
  /** Both halves are set: the page can load Clerk, and the server can verify what it sends. */
  configured: boolean;
  /** The instance's publishable key (public by design: the page is given it). Absent when not set or malformed. */
  publishableKey?: string;
  /** https://<the instance's frontend API host>, derived from the publishable key. Absent when the key is absent or malformed. */
  frontendApi?: string;
  /** Which verifier the server has. */
  verifier: IdentityVerifier;
  /** The instance's public key, PEM (CLERK_JWT_KEY, normalized): server-side only, never sent to the page. */
  jwtKey?: string;
  /** The JWKS address the server fetches once when only CLERK_SECRET_KEY is set: <frontendApi>/.well-known/jwks.json. */
  jwks?: string;
  /** Whether CLERK_SECRET_KEY is set (its value is never carried). */
  secretKeySet: boolean;
  /** The exact environment names missing or unusable; empty when configured. */
  needs: string[];
  /** One line a person reads. */
  words: string;
}

/** What the page is told (GET /api/identity): the public part only. */
export interface PageIdentity {
  configured: boolean;
  publishableKey?: string;
  frontendApi?: string;
  needs: string[];
  words: string;
}

const PUBLISHABLE = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/;
/** A host as Clerk encodes it: letters, digits, dots and dashes (a dev instance: <slug>.clerk.accounts.dev; production: clerk.<domain>). */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/**
 * The frontend API of a publishable key, from its shape alone: pk_test_|pk_live_ + base64("<host>$") → https://<host>.
 * null when the key is not of that shape (then it is not a Clerk publishable key, whatever it is).
 */
export function frontendApiOf(publishableKey: string): string | null {
  const m = PUBLISHABLE.exec(publishableKey.trim());
  if (!m) return null;
  let decoded: string;
  try { decoded = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
  const host = decoded.endsWith('$') ? decoded.slice(0, -1) : decoded;
  if (!HOST.test(host)) return null;
  return `https://${host.toLowerCase()}`;
}

/** Whether a publishable key is a test (development) instance's. */
export const isTestInstance = (publishableKey: string): boolean => publishableKey.trim().startsWith('pk_test_');

/**
 * CLERK_JWT_KEY as a PEM public key: the dashboard shows it with real line breaks; an .env file often keeps them as the two
 * characters \n; and some keep the base64 body alone. Any of these becomes one PEM. null when it is none of them.
 */
export function pemOf(raw: string): string | null {
  let s = raw.trim().replace(/\\n/g, '\n').replace(/^["']|["']$/g, '').trim();
  if (!s) return null;
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(s)) return null; // a private key is never this setting (it is the instance's PUBLIC key)
  if (!s.includes('-----BEGIN')) {
    const body = s.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]{64,}$/.test(body)) return null;
    s = `-----BEGIN PUBLIC KEY-----\n${body.replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END PUBLIC KEY-----`;
  }
  if (!/^-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]+-----END (RSA )?PUBLIC KEY-----$/.test(s)) return null;
  return s;
}

const set = (v: string | undefined): string => (typeof v === 'string' ? v.trim() : '');

/** The identity provider's configuration, from the environment given (process.env when none): see the module's words. */
export function identityConfig(env: Env = process.env): IdentityConfig {
  const needs: string[] = [];
  const notes: string[] = [];
  const pkRaw = set(env[IDENTITY_ENV.publishable]) || set(env[IDENTITY_ENV.publishableAlt]);
  const pkName = set(env[IDENTITY_ENV.publishable]) ? IDENTITY_ENV.publishable : set(env[IDENTITY_ENV.publishableAlt]) ? IDENTITY_ENV.publishableAlt : IDENTITY_ENV.publishable;
  let publishableKey: string | undefined;
  let frontendApi: string | undefined;
  if (!pkRaw) {
    needs.push(IDENTITY_ENV.publishable);
  } else {
    const api = frontendApiOf(pkRaw);
    if (api) { publishableKey = pkRaw; frontendApi = api; } else {
      needs.push(pkName);
      notes.push(`${pkName} is set but is not a Clerk publishable key (pk_test_… or pk_live_… from the dashboard's API keys)`);
    }
  }
  const jwtRaw = set(env[IDENTITY_ENV.jwtKey]);
  const secretKeySet = set(env[IDENTITY_ENV.secretKey]).length > 0;
  let verifier: IdentityVerifier = 'none';
  let jwtKey: string | undefined;
  let jwks: string | undefined;
  if (jwtRaw) {
    const pem = pemOf(jwtRaw);
    if (pem) { verifier = 'pem'; jwtKey = pem; } else notes.push(`${IDENTITY_ENV.jwtKey} is set but is not a PEM public key (the dashboard's API keys → JWKS public key)`);
  }
  if (verifier === 'none' && secretKeySet) {
    if (frontendApi) { verifier = 'jwks'; jwks = `${frontendApi}/.well-known/jwks.json`; }
    // without the frontend API there is nowhere to fetch the JWKS from: the publishable key is already in needs
  }
  if (verifier === 'none' && !secretKeySet) needs.push(IDENTITY_ENV.jwtKey);
  if (verifier === 'none' && secretKeySet && jwtRaw) needs.push(IDENTITY_ENV.jwtKey);
  const configured = needs.length === 0 && verifier !== 'none' && Boolean(publishableKey);
  const words = configured
    ? `Timmy's identity provider is configured: Clerk at ${frontendApi}${isTestInstance(publishableKey!) ? ' (a development instance)' : ''}; sessions are verified ${verifier === 'pem' ? 'against the instance\'s public key (no network)' : 'against the instance\'s JWKS, fetched once'}.`
    : `Timmy's identity provider is not configured, so nothing signs in. Set ${needs.length ? needs.join(' and ') : 'the environment'}: ${IDENTITY_ENV.publishable} is the Clerk instance's publishable key (pk_test_… or pk_live_…), and ${IDENTITY_ENV.jwtKey} its public key (PEM, from the dashboard's API keys; then verification needs no network) or ${IDENTITY_ENV.secretKey} (then the instance's JWKS is fetched once).${notes.length ? ` ${notes.join('. ')}.` : ''}`;
  return {
    configured,
    ...(publishableKey ? { publishableKey } : {}),
    ...(frontendApi ? { frontendApi } : {}),
    verifier,
    ...(jwtKey ? { jwtKey } : {}),
    ...(jwks ? { jwks } : {}),
    secretKeySet,
    needs,
    words,
  };
}

/** The public part, what GET /api/identity answers: never the PEM, never whether a secret is set. */
export function pageIdentity(cfg: IdentityConfig): PageIdentity {
  return {
    configured: cfg.configured,
    ...(cfg.publishableKey ? { publishableKey: cfg.publishableKey } : {}),
    ...(cfg.frontendApi ? { frontendApi: cfg.frontendApi } : {}),
    needs: [...cfg.needs],
    words: cfg.words,
  };
}

/**
 * The Content-Security-Policy connect-src addition the page needs when configured: Clerk's JS in the page talks to the
 * instance's frontend API and nothing else off this computer; script-src stays 'self' (Clerk's JS is served by the
 * companion from node_modules, /vendor/clerk/). Empty when not configured: the policy does not widen for nothing.
 */
export const connectSrcFor = (cfg: IdentityConfig): string => (cfg.configured && cfg.frontendApi ? ` ${cfg.frontendApi}` : '');
