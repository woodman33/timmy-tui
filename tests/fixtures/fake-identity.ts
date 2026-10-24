/**
 * R11 round 4 (H172): a FAKE identity provider for tests: an RSA key pair made at run time (generateKeyPairSync), its public
 * key in PEM as CLERK_JWT_KEY, and session tokens minted with the private key, RS256, in the shape of Clerk's session JWT
 * (sub = the user id "user_…", iat, nbf, exp, azp, iss, sid). The product's verifier (src/companion/identity, H173's
 * verifySession) checks the signature and the claims exactly as it checks Clerk's: nothing here bypasses it. No Clerk account,
 * no network: the key never leaves this process, and every token is labelled FAKE in the tests that use it.
 *
 * Also minted here, for the refusals a verifier must make: a token signed by ANOTHER key (forged), one without `sub`, one
 * whose `sub` is not a user id, and one that has expired.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface FakeClaims {
  sub?: string;
  /** seconds since the epoch; defaults: iat now, nbf now - 30, exp now + 3600 */
  iat?: number;
  nbf?: number;
  exp?: number;
  /** the authorized party: the page's origin (the companion's address) */
  azp?: string;
  iss?: string;
  sid?: string;
  [claim: string]: unknown;
}

export interface FakeIdentity {
  /** the instance's "PEM public key", as Clerk's dashboard gives it: the value of CLERK_JWT_KEY */
  publicKeyPem: string;
  /** a FAKE publishable key naming a frontend API host that resolves nowhere (identityConfig reads the host from it) */
  publishableKey: string;
  /** the frontend API host the publishable key names */
  frontendApi: string;
  /** the environment that configures the product's verifier with this provider's key (and nothing else of Clerk's) */
  env(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** a session token for `sub`, signed by this provider's key; `claims` overrides any default */
  token(sub: string, claims?: Omit<FakeClaims, 'sub'>): string;
  /** a token with these claims exactly (no defaults but iat/nbf/exp): for a token without `sub`, with a bad `sub`, … */
  tokenOf(claims: FakeClaims): string;
  /** a token for `sub` signed by ANOTHER key the verifier never saw: forged */
  forged(sub: string, claims?: Omit<FakeClaims, 'sub'>): string;
  /** a token for `sub` that expired a minute ago */
  expired(sub: string): string;
  /** the key id the tokens name in their header */
  kid: string;
}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function sign(privateKey: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

/** A user id in Clerk's shape ("user_" + 27 characters), from a short name: FAKE, never an account's. */
export const fakeUserId = (name: string): string => `user_FAKE${name.replace(/[^A-Za-z0-9]/g, '').padEnd(23, '0').slice(0, 23)}`;

/** A FAKE identity provider of its own (one per test file; the pair is made here, never read from a file). */
export function fakeIdentityProvider(o: { azp?: string; frontendApi?: string } = {}): FakeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const frontendApi = o.frontendApi ?? 'fake-identity.clerk.accounts.invalid';
  // (Clerk's publishable key: pk_test_ + base64(frontend API host + "$"); this one names a host that resolves nowhere)
  const publishableKey = `pk_test_${Buffer.from(`${frontendApi}$`).toString('base64')}`;
  const kid = `ins_FAKE${Date.now().toString(36)}`;
  const now = (): number => Math.floor(Date.now() / 1000);
  const defaults = (sub: string | undefined, claims: FakeClaims): Record<string, unknown> => {
    const t = now();
    return {
      ...(sub === undefined ? {} : { sub }),
      iat: t, nbf: t - 30, exp: t + 3600,
      ...(o.azp ? { azp: o.azp } : {}),
      iss: `https://${frontendApi}`, sid: `sess_FAKE${t.toString(36)}`,
      ...claims,
    };
  };
  return {
    publicKeyPem, publishableKey, frontendApi, kid,
    env: (base = process.env) => ({ ...base, CLERK_JWT_KEY: publicKeyPem, CLERK_PUBLISHABLE_KEY: publishableKey, CLERK_SECRET_KEY: '' }),
    token: (sub, claims = {}) => sign(privateKey, kid, defaults(sub, claims)),
    tokenOf: (claims) => sign(privateKey, kid, defaults(claims.sub, claims)),
    forged: (sub, claims = {}) => sign(other, kid, defaults(sub, claims)),
    expired: (sub) => sign(privateKey, kid, defaults(sub, { exp: now() - 60, nbf: now() - 3700, iat: now() - 3700 })),
  };
}
