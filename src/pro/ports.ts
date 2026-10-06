// The two ports the license manager works through, owned here rather than by
// their adapters: the Pro service (client.ts speaks it over HTTP) and the
// license store on this machine (vault.ts keeps it in a file).

import type { ProErrorCode } from './protocol.js';

// ── the Pro service ──────────────────────────────────────────────────────

export type ClaimResult = { state: 'pending' } | { state: 'ready'; key: string; token: string };

export interface ProService {
  startCheckout(): Promise<{ url: string; sessionId: string }>;
  claim(sessionId: string): Promise<ClaimResult>;
  activate(key: string): Promise<{ token: string }>;
  rotate(key: string): Promise<{ key: string }>;
  billingUrl(): Promise<string>;
}

/**
 * How a call to the Pro service failed:
 * - `refused`: the service answered with a coded refusal (see `code`); asking again will not help.
 * - `rate_limited`, `server_error`, `unreachable`: the service was busy, broken or not reached.
 * - `unexpected_response`: something other than the Pro service answered (a proxy page, a
 *   redirect, a wrong host) or the answer was malformed. Never read as a refusal.
 */
export type ProFailureKind = 'refused' | 'rate_limited' | 'server_error' | 'unreachable' | 'unexpected_response';

export class ProServiceError extends Error {
  override name = 'ProServiceError';
  constructor(
    message: string,
    readonly kind: ProFailureKind,
    /** The worker's error code, present only when the Pro service itself answered. */
    readonly code: ProErrorCode | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }

  /** Worth trying again later. Only a refusal is final. */
  get retryable(): boolean {
    return this.kind !== 'refused';
  }
}

// ── the license on this machine ──────────────────────────────────────────

/** A refusal the service gave for the stored key, kept so offline checks report it too. */
export interface StoredRefusal {
  reason: 'subscription_inactive' | 'key_revoked';
  /** Unix seconds. */
  at: number;
}

export interface StoredLicense {
  v: 1;
  /** The license key, as issued (`tpro_XXXXXXXX-…`). */
  key: string;
  /** The latest signed license token, or null when none is held. */
  token: string | null;
  /** Unix seconds of the last write. */
  savedAt: number;
  refusal?: StoredRefusal;
}

export interface LicenseVault {
  read(): StoredLicense | null;
  write(license: StoredLicense): void;
  /** Removes the stored license; true when there was one. */
  clear(): boolean;
}
