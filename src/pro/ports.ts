// The ports the license manager works through, owned here rather than by their
// adapters: the Pro service (client.ts speaks it over HTTP), the license store
// on this machine and the record of the checkout it has open (vault.ts keeps
// both in files).

import type { ProErrorCode } from './protocol.js';

// ── the Pro service ──────────────────────────────────────────────────────

/** `expired`: Stripe gave up on the checkout before it was paid; it can never complete. */
export type ClaimResult = { state: 'pending' } | { state: 'expired' } | { state: 'ready'; key: string; token: string };

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

export interface ProServiceErrorDetails {
  /** The worker's error code, present only when the Pro service itself answered. */
  code?: ProErrorCode | null;
  httpStatus?: number | null;
  /**
   * Stripe's status for the subscription, when the service reported one with its refusal: the
   * subscription is not active (`subscription_inactive`), or its key can no longer be shown (`key_already_issued`).
   */
  subscriptionStatus?: string | null;
}

export class ProServiceError extends Error {
  override name = 'ProServiceError';
  readonly code: ProErrorCode | null;
  readonly httpStatus: number | null;
  readonly subscriptionStatus: string | null;

  constructor(message: string, readonly kind: ProFailureKind, details: ProServiceErrorDetails = {}) {
    super(message);
    this.code = details.code ?? null;
    this.httpStatus = details.httpStatus ?? null;
    this.subscriptionStatus = details.subscriptionStatus ?? null;
  }

  /** Worth trying again later. Only a refusal is final. */
  get retryable(): boolean {
    return this.kind !== 'refused';
  }
}

// ── the license on this machine ──────────────────────────────────────────

/** Why the stored key has no usable token, as learned from the service or from checking a token. */
export const PERSISTED_PROBLEMS = ['subscription_inactive', 'key_revoked', 'invalid_token', 'clock_skew'] as const;
export type PersistedProblem = (typeof PERSISTED_PROBLEMS)[number];

export interface StoredProblem {
  reason: PersistedProblem;
  /** Unix seconds. */
  at: number;
  /** Stripe's status for the subscription, when the service reported one. */
  subscriptionStatus?: string;
}

export interface StoredLicense {
  v: 1;
  /** The license key, as issued (`tpro_XXXXXXXX-…`). */
  key: string;
  /** The latest signed license token, or null when none is held. */
  token: string | null;
  /** Unix seconds of the last write. */
  savedAt: number;
  /** Why there is no token, when the reason is known. */
  problem?: StoredProblem;
  /** Unix seconds before which no automatic refresh is tried; set after every automatic attempt that needs a pause. */
  nextRefreshAt?: number;
}

/** A Pro file on this machine could not be read, written or removed, or its contents are not something this build understands. */
export class LicenseStorageError extends Error {
  override name = 'LicenseStorageError';
  constructor(
    message: string,
    readonly operation: 'read' | 'write' | 'clear',
    /** Which file: the license, or the record of an open checkout. */
    readonly subject: 'license file' | 'checkout record' = 'license file',
  ) {
    super(message);
  }
}

/** Storage for the one license on this machine. read() is null only when there is none; anything else unusable throws LicenseStorageError. */
export interface LicenseVault {
  read(): StoredLicense | null;
  write(license: StoredLicense): void;
  /** Removes the stored license; true when there was one. */
  clear(): boolean;
}

// ── the checkout this machine has open ───────────────────────────────────

/** A Stripe Checkout that `timmy pro upgrade` opened here and has not seen through yet. */
export interface OpenCheckout {
  v: 1;
  sessionId: string;
  url: string;
  /** Unix seconds. For reference only: whether it can still be paid is for the service to say. */
  openedAt: number;
}

/**
 * The record of the one checkout this machine has open, so that running `upgrade` again resumes it
 * instead of opening a second payable checkout. read() is null only when there is none; anything
 * unusable throws LicenseStorageError (never "no checkout": that would invite a second purchase).
 */
export interface CheckoutStore {
  read(): OpenCheckout | null;
  write(checkout: OpenCheckout): void;
  /** Removes the record; true when there was one. */
  clear(): boolean;
}
