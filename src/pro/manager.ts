// The license lifecycle on this machine: buy, activate, renew, refresh, rotate,
// forget. Network calls go through the ProService port and storage through the
// LicenseVault port (ports.ts); what the result means is entitlement.ts's job.
//
// Every outcome is recorded in one place: a token that verifies is saved, a
// token that does not is dropped with its reason, and a refusal of the stored
// key is remembered whichever command heard it.

import { entitlementFromToken, evaluateLicense, nextStep, type Entitlement } from './entitlement.js';
import { normalizeLicenseKey } from './license.js';
import { LicenseStorageError, PERSISTED_PROBLEMS, ProServiceError, type LicenseVault, type PersistedProblem, type ProService, type StoredLicense, type StoredProblem } from './ports.js';

/** The user gave something that is not a usable license key. */
export class LicenseInputError extends Error {
  override name = 'LicenseInputError';
}

/** This build has no Pro service to talk to. */
export class ProUnavailableError extends Error {
  override name = 'ProUnavailableError';
  constructor() {
    super('Timmy Pro is not available in this build yet (no Pro service is configured; TIMMY_PRO_URL sets one).');
  }
}

/** No purchase was started: this machine holds a license that is (or can again be) good, or one it cannot read. */
export class PurchaseRefusedError extends Error {
  override name = 'PurchaseRefusedError';
  constructor(readonly entitlement: Entitlement) {
    super(entitlement.active ? 'Timmy Pro is already active on this machine' : `no purchase was started: ${entitlement.detail}`);
  }
}

/** After the service refused the stored key (or its token could not be used), ask again at most this often. */
const PROBLEM_RECHECK_SECONDS = 3600;
/** After the service was busy or out of reach, wait this long before refreshing automatically again. */
const TRANSIENT_BACKOFF_SECONDS = 300;

export interface LicenseManagerDeps {
  vault: LicenseVault;
  service: ProService | null;
  publicKey: CryptoKey | null;
  /** Unix seconds. */
  now: () => number;
}

/** What a checkout has produced so far. A ready key always comes back, saved or not. */
export type PurchaseClaim =
  | { state: 'pending' }
  | { state: 'ready'; key: string; saved: true; entitlement: Entitlement }
  /** The key could not be written to the license file: the caller must show it now. */
  | { state: 'ready'; key: string; saved: false; saveError: Error };

/** The new key always comes back: the old one stopped working on the server before rotate() returned. */
export type RotationResult =
  /** `activationError`: the new key is saved but could not be activated yet; `timmy pro activate` retries. */
  | { key: string; saved: true; entitlement: Entitlement; activationError: Error | null }
  /** The new key could not be written to the license file: the caller must show it now. */
  | { key: string; saved: false; saveError: Error };

type StoredRead = { license: StoredLicense | null } | { unreadable: Entitlement };

export class LicenseManager {
  private refreshing: Promise<Entitlement> | null = null;

  constructor(private readonly deps: LicenseManagerDeps) {}

  /** Offline: what the stored license says right now. */
  async currentEntitlement(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    return evaluateLicense(read.license, this.deps.publicKey, this.deps.now());
  }

  storedKey(): string | null {
    const read = this.readStored();
    return 'license' in read ? read.license?.key ?? null : null;
  }

  /** Exchanges a typed or pasted key for a token and saves both. */
  async activate(rawKey: string): Promise<Entitlement> {
    return this.exchange(parseKey(rawKey));
  }

  /** Gets a fresh token for the stored key. */
  async renew(): Promise<Entitlement> {
    return this.exchange(this.requireStoredKey());
  }

  /**
   * Opens a Stripe Checkout, but only for someone with no license here or whose subscription has ended.
   * Checkout cannot tell who is buying, so this is what stops a second subscription by accident.
   */
  async startPurchase(): Promise<{ url: string; sessionId: string }> {
    const service = this.requireService();
    const entitlement = await this.freshEntitlement();
    if (nextStep(entitlement) !== 'buy') throw new PurchaseRefusedError(entitlement);
    return service.startCheckout();
  }

  /** Asks once whether a checkout has produced a key; saves it the moment it has, and never loses it. */
  async claimPurchase(sessionId: string): Promise<PurchaseClaim> {
    const result = await this.requireService().claim(sessionId);
    if (result.state === 'pending') return result;
    const key = normalizeLicenseKey(result.key) ?? result.key;
    try {
      return { state: 'ready', key, saved: true, entitlement: await this.recordToken(key, result.token) };
    } catch (error) {
      return { state: 'ready', key, saved: false, saveError: asError(error) };
    }
  }

  async billingPortalUrl(): Promise<string> {
    return this.requireService().billingUrl();
  }

  /** Replaces the stored key. Once the server has rotated, nothing here may lose the new key. */
  async rotate(): Promise<RotationResult> {
    const { key } = await this.requireService().rotate(this.requireStoredKey());
    try {
      this.deps.vault.write({ v: 1, key, token: null, savedAt: this.deps.now() });
    } catch (error) {
      return { key, saved: false, saveError: asError(error) };
    }
    try {
      return { key, saved: true, entitlement: await this.exchange(key), activationError: null };
    } catch (error) {
      return { key, saved: true, entitlement: await this.currentEntitlement(), activationError: asError(error) };
    }
  }

  /**
   * Gets a new token when the current one is missing, unusable or close to expiry, with pacing:
   * a stored problem is rechecked at most hourly, and a busy or unreachable service is left
   * alone for a few minutes. Concurrent callers share one refresh. Never throws for network or
   * storage trouble: it returns what it has.
   */
  refreshIfDue(): Promise<Entitlement> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Forgets the license on this machine. The subscription itself is untouched. */
  deactivate(): boolean {
    return this.deps.vault.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async refreshOnce(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    const stored = read.license;
    const now = this.deps.now();
    const entitlement = await evaluateLicense(stored, this.deps.publicKey, now);
    if (!stored || !this.deps.service || !needsRefresh(entitlement, stored, now)) return entitlement;
    try {
      return await this.exchange(stored.key);
    } catch (error) {
      if (error instanceof LicenseInputError || error instanceof LicenseStorageError) return entitlement;
      if (!(error instanceof ProServiceError)) throw error;
      if (isKeyRefusal(error)) return this.currentEntitlement();
      if (error.retryable) this.writeQuietly({ ...stored, retryAfter: now + TRANSIENT_BACKOFF_SECONDS });
      return entitlement;
    }
  }

  /** For a purchase decision: asks the service about a stored key now, whatever the pacing says. */
  private async freshEntitlement(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    if (!read.license) return evaluateLicense(null, this.deps.publicKey, this.deps.now());
    try {
      return await this.exchange(read.license.key);
    } catch (error) {
      if (error instanceof ProServiceError || error instanceof LicenseStorageError) return this.currentEntitlement();
      throw error;
    }
  }

  /** Exchanges a key for a token and records the outcome. A refusal of the stored key is recorded, then rethrown. */
  private async exchange(key: string): Promise<Entitlement> {
    let token: string;
    try {
      ({ token } = await this.requireService().activate(key));
    } catch (error) {
      if (error instanceof ProServiceError && isKeyRefusal(error) && this.storedKey() === key) this.recordRefusal(key, error);
      throw error;
    }
    return this.recordToken(key, token);
  }

  /** Saves the key with its token when the token verifies (or cannot be checked here), else with why it was dropped. */
  private async recordToken(key: string, token: string): Promise<Entitlement> {
    const now = this.deps.now();
    const entitlement = await entitlementFromToken(token, this.deps.publicKey, now);
    const keepToken = entitlement.active || entitlement.reason === 'no_public_key';
    const license: StoredLicense = { v: 1, key, token: keepToken ? token : null, savedAt: now };
    if (!entitlement.active && isPersistedProblem(entitlement.reason)) license.problem = { reason: entitlement.reason, at: now };
    this.deps.vault.write(license);
    return entitlement;
  }

  private recordRefusal(key: string, error: ProServiceError): void {
    const now = this.deps.now();
    const problem: StoredProblem = { reason: error.code === 'unknown_key' ? 'key_revoked' : 'subscription_inactive', at: now };
    if (error.subscriptionStatus) problem.subscriptionStatus = error.subscriptionStatus;
    this.writeQuietly({ v: 1, key, token: null, savedAt: now, problem });
  }

  /** Best-effort bookkeeping: a write that fails here must not hide the answer the caller is waiting for. */
  private writeQuietly(license: StoredLicense): void {
    try {
      this.deps.vault.write(license);
    } catch (error) {
      if (!(error instanceof LicenseStorageError)) throw error;
    }
  }

  private readStored(): StoredRead {
    try {
      return { license: this.deps.vault.read() };
    } catch (error) {
      if (!(error instanceof LicenseStorageError)) throw error;
      return { unreadable: { active: false, reason: 'license_unreadable', detail: error.message } };
    }
  }

  private requireService(): ProService {
    if (!this.deps.service) throw new ProUnavailableError();
    return this.deps.service;
  }

  private requireStoredKey(): string {
    const key = this.storedKey();
    if (!key) throw new LicenseInputError('No usable Timmy Pro license key on this machine. Run `timmy pro activate -` and paste your key.');
    return key;
  }
}

function parseKey(raw: string): string {
  const key = normalizeLicenseKey(raw);
  if (!key) throw new LicenseInputError('That is not a Timmy Pro license key (expected tpro_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX).');
  return key;
}

function needsRefresh(entitlement: Entitlement, stored: StoredLicense, now: number): boolean {
  if (stored.retryAfter !== undefined && now < stored.retryAfter) return false;
  if (entitlement.active) return entitlement.refreshDue;
  if (entitlement.reason === 'no_public_key') return false;
  if (!stored.token && stored.problem) return now - stored.problem.at >= PROBLEM_RECHECK_SECONDS;
  return true;
}

const isKeyRefusal = (error: ProServiceError): boolean =>
  error.kind === 'refused' && (error.code === 'subscription_inactive' || error.code === 'unknown_key');

const isPersistedProblem = (reason: string): reason is PersistedProblem => (PERSISTED_PROBLEMS as readonly string[]).includes(reason);

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
