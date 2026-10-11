/**
 * Timmy Cloud's backend: the agency credential, redaction and tokens.
 *
 * The agency credential (the provider account's API token) comes only from an environment variable or a secret file
 * named at start; the file must be readable by its owner only (0600 or stricter) and a looser one is refused. The value
 * is kept in memory, sent only to the provider, and never written to a response, an event, a log line or an error:
 * every one of those passes through `Redactor`, which also catches a provider error that echoes the credential back.
 *
 * Customer and operator tokens are stored only as sha256 hashes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

export const AGENCY_TOKEN_ENV = 'TIMMY_CLOUD_AGENCY_TOKEN';
export const OPERATOR_TOKEN_SHA256_ENV = 'TIMMY_CLOUD_OPERATOR_TOKEN_SHA256';
export const REDACTED = '[redacted: agency credential]';

/** Printable ASCII with no space, no double quote and no backslash, 16 to 1024 characters. */
const CREDENTIAL_SHAPE = /^[\x21\x23-\x5B\x5D-\x7E]{16,1024}$/;

export class CredentialError extends Error {}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface AgencyCredential { value: string; source: 'environment' | 'secret file' }

/**
 * Loads the agency credential from `file` (a secret file named at start) or from the environment variable
 * TIMMY_CLOUD_AGENCY_TOKEN, never both. The variable is removed from `env` once read, so no child process inherits it.
 * Throws CredentialError, in words with no path and no value, when there is none or the file is not private.
 */
export function loadAgencyCredential(opts: { file?: string | null; env: NodeJS.ProcessEnv }): AgencyCredential {
  const fromEnv = opts.env[AGENCY_TOKEN_ENV];
  if (opts.file && fromEnv !== undefined) {
    throw new CredentialError(`Both a secret file and ${AGENCY_TOKEN_ENV} were given: name one source for the agency credential. Nothing was started.`);
  }
  let value: string;
  let source: AgencyCredential['source'];
  if (opts.file) {
    let st;
    try { st = lstatSync(opts.file); } catch { throw new CredentialError('The secret file could not be read (it does not exist or is not readable). Nothing was started.'); }
    if (st.isSymbolicLink()) throw new CredentialError('The secret file is a symbolic link: name the file itself, so its own permissions can be checked. Nothing was started.');
    if (!st.isFile()) throw new CredentialError('The secret file is not a regular file. Nothing was started.');
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new CredentialError(`The secret file's permissions are ${mode.toString(8).padStart(4, '0')}: it must be readable by its owner only (chmod 600). Nothing was started.`);
    }
    value = readFileSync(opts.file, 'utf8').replace(/(\r?\n)+$/, '');
    source = 'secret file';
  } else if (fromEnv !== undefined) {
    value = fromEnv;
    delete opts.env[AGENCY_TOKEN_ENV];
    source = 'environment';
  } else {
    throw new CredentialError(`No agency credential: set ${AGENCY_TOKEN_ENV}, or name a secret file (mode 0600) with --agency-token-file. Nothing was started.`);
  }
  if (!CREDENTIAL_SHAPE.test(value)) {
    throw new CredentialError('The agency credential is not usable: it must be 16 to 1024 printable characters with no spaces, quotes or backslashes. Nothing was started.');
  }
  return { value, source };
}

/** Replaces every form of the given secrets in text: as is, JSON-escaped, URL-encoded and base64 (also as a Bearer header). */
export class Redactor {
  private readonly needles: string[];

  constructor(secrets: string[]) {
    const forms = new Set<string>();
    for (const s of secrets) {
      if (!s) continue;
      forms.add(s);
      forms.add(JSON.stringify(s).slice(1, -1));
      forms.add(encodeURIComponent(s));
      forms.add(Buffer.from(s, 'utf8').toString('base64'));
      forms.add(Buffer.from(s, 'utf8').toString('base64url'));
      forms.add(Buffer.from(`Bearer ${s}`, 'utf8').toString('base64'));
    }
    // Longest first, so a longer form is replaced before a shorter one inside it.
    this.needles = [...forms].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const n of this.needles) if (out.includes(n)) out = out.split(n).join(REDACTED);
    return out;
  }

  /** A deep copy of a JSON value with every string redacted. */
  redactDeep<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }

  /** True when text holds any form of a secret. */
  leaks(text: string): boolean {
    return this.needles.some((n) => text.includes(n));
  }
}

/** A new bearer token: 32 random bytes, base64url, with a prefix that makes it recognisable in a configuration. */
export function newToken(): string {
  return `tc_${randomBytes(32).toString('base64url')}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Constant-time comparison of a presented token with a stored sha256 (hex). */
export function tokenMatches(given: string, sha256: string): boolean {
  const wellFormed = HEX64.test(sha256);
  const a = Buffer.from(sha256Hex(given), 'hex');
  const b = Buffer.from(wellFormed ? sha256 : '0'.repeat(64), 'hex');
  return timingSafeEqual(a, b) && wellFormed;
}

/** The operator's token hash, from --operator-token-sha256 or TIMMY_CLOUD_OPERATOR_TOKEN_SHA256 (the token itself is never given). */
export function loadOperatorTokenSha256(opts: { given?: string | null; env: NodeJS.ProcessEnv }): string {
  const value = (opts.given ?? opts.env[OPERATOR_TOKEN_SHA256_ENV] ?? '').trim().toLowerCase();
  if (!HEX64.test(value)) {
    throw new CredentialError(`No operator credential: give the sha256 (64 hex digits) of the operator's token with --operator-token-sha256 or ${OPERATOR_TOKEN_SHA256_ENV}; the token itself is never given to the backend. Nothing was started.`);
  }
  return value;
}
