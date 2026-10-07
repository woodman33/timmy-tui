// The license lifecycle on this machine: buy, activate, renew, refresh, rotate,
// forget. Network calls go through the ProService port and storage through the
// LicenseVault and CheckoutStore ports (ports.ts); what the result means is
// entitlement.ts's job.
//
// Buying never opens a second payable checkout: the one `upgrade` opened is
// recorded before the user sees it and resumed by the next `upgrade` until the
// service says otherwise. The service, not this machine's clock, decides: the
// record is forgotten once its key is saved here, or the service says it
// expired unpaid, does not know it, or the subscription it started has ended;
// a paid one whose subscription can still charge blocks a new checkout.
//
// Two kinds of write, kept apart:
// - adopting a key the user gave, bought or rotated to replaces whatever is stored;
// - bookkeeping for the stored key (renewals, refusals, pacing) re-reads the file
//   and applies only while that same key is still stored, so a slow request never
//   overwrites a key, a purchase or a removal made meanwhile by another command.
// Every outcome is recorded here: a token that verifies is saved, one that does
// not is dropped with its reason, a refusal of the stored key is remembered
// whichever command heard it, and an automatic refresh that should not be
// repeated soon leaves the time it may be tried again.

import { entitlementFromToken, evaluateLicense, nextStep, problemFromRefusal, type Entitlement } from './entitlement.js';
import { isEndedSubscriptionStatus } from './plan.js';
import { normalizeLicenseKey } from './license.js';
import { LicenseStorageError, PERSISTED_PROBLEMS, ProServiceError, type CheckoutStore, type ClaimResult, type LicenseVault, type PersistedProblem, type ProService, type StoredLicense } from './ports.js';

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

/**
 * An earlier checkout from this machine started a subscription that has not ended, but its key cannot
 * be collected here (the 24-hour window closed, the key was replaced, or the subscription is not
 * active). Opening another checkout would start a second subscription.
 */
export class PaidCheckoutError extends Error {
  override name = 'PaidCheckoutError';
  constructor() {
    super('an earlier checkout from this machine started a subscription that has not ended');
  }
}

/** After a refusal, an unusable token or a renewal that came back short-lived, refresh automatically at most this often. */
const PROBLEM_RECHECK_SECONDS = 3600;
/** After the service was busy or out of reach, or the license file could not be written, wait this long. */
const TRANSIENT_BACKOFF_SECONDS = 300;

export interface LicenseManagerDeps {
  vault: LicenseVault;
  /** The checkout `upgrade` has open, so that running it again resumes that checkout instead of opening another. */
  checkouts: CheckoutStore;
  service: ProService | null;
  publicKey: CryptoKey | null;
  /** Unix seconds. */
  now: () => number;
}

/** What a checkout has produced so far. A ready key always comes back, saved or not. */
export type PurchaseClaim =
  | { state: 'pending' }
  /** Stripe gave up on the checkout before it was paid; its record here is forgotten. */
  | { state: 'expired' }
  | { state: 'ready'; key: string; saved: true; entitlement: Entitlement }
  /** The key could not be written to the license file: the caller must show it now. */
  | { state: 'ready'; key: string; saved: false; saveError: Error };

export type ReadyPurchase = Extract<PurchaseClaim, { state: 'ready' }>;

/** What `upgrade` has to do next: finish a checkout in the browser, or nothing, because an earlier checkout from here was already paid. */
export type PurchaseStart =
  /** `resumed`: the checkout an earlier `upgrade` opened, still payable. */
  | { state: 'checkout'; url: string; sessionId: string; resumed: boolean }
  | ReadyPurchase;

/** The new key always comes back: the old one stopped working on the server before rotate() returned. */
export type RotationResult =
  /** `activationError`: the new key is saved but could not be activated yet; `timmy pro activate` retries. */
  | { key: string; saved: true; entitlement: Entitlement; activationError: Error | null }
  /** The new key could not be written to the license file: the caller must show it now. */
  | { key: string; saved: false; saveError: Error };

type StoredRead = { license: StoredLicense | null } | { unreadable: Entitlement };

/** `adopt` replaces whatever is stored; `bookkeep` writes only while the same key is still stored. */
type WriteMode = 'adopt' | 'bookkeep';

export class LicenseManager {
  private refreshing: Promise<Entitlement> | null = null;
  /** The latest pacing decision, also kept here so an unwritable license file cannot mean one request per check. */
  private paced: { key: string; until: number } | null = null;

  constructor(private readonly deps: LicenseManagerDeps) {}

  /** Offline: what the stored license says right now. */
  async currentEntitlement(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    return evaluateLicense(read.license, this.deps.publicKey, this.deps.now());
  }

  /** The stored key, for display; null when there is none or the file cannot be read (currentEntitlement says which). */
  storedKey(): string | null {
    const read = this.readStored();
    return 'license' in read ? read.license?.key ?? null : null;
  }

  /** Exchanges a typed or pasted key for a token and saves both, replacing any stored license. */
  async activate(rawKey: string): Promise<Entitlement> {
    return this.exchange(parseKey(rawKey), 'adopt');
  }

  /** Gets a fresh token for the stored key. */
  async renew(): Promise<Entitlement> {
    return this.exchange(this.requireStoredKey(), 'bookkeep');
  }

  /**
   * Opens a Stripe Checkout, but only for someone with no license here or whose subscription has ended,
   * and never while the checkout an earlier `upgrade` opened can still be paid: that one is resumed, and
   * one paid meanwhile is saved instead. Checkout cannot tell who is buying, so these checks are what
   * stop a second subscription by accident. Throws PaidCheckoutError when an earlier checkout started a
   * subscription that can still charge but whose key cannot be collected here.
   */
  async startPurchase(): Promise<PurchaseStart> {
    const service = this.requireService();
    const entitlement = await this.freshEntitlement();
    if (nextStep(entitlement) !== 'buy') throw new PurchaseRefusedError(entitlement);
    const earlier = await this.settleEarlierCheckout();
    if (earlier) return earlier;
    const checkout = await service.startCheckout();
    this.deps.checkouts.write({ v: 1, sessionId: checkout.sessionId, url: checkout.url, openedAt: this.deps.now() });
    return { state: 'checkout', ...checkout, resumed: false };
  }

  /**
   * Asks once whether a checkout has produced a key; saves it the moment it has, and never loses it.
   * The checkout stays recorded until its key is saved here, so a later `upgrade` can still collect it,
   * or until the service says it expired unpaid or does not know it.
   */
  async claimPurchase(sessionId: string): Promise<PurchaseClaim> {
    let result: ClaimResult;
    try {
      result = await this.requireService().claim(sessionId);
    } catch (error) {
      if (error instanceof ProServiceError && error.code === 'unknown_checkout') this.forgetCheckout(sessionId);
      throw error;
    }
    if (result.state === 'pending') return result;
    if (result.state === 'expired') {
      this.forgetCheckout(sessionId);
      return result;
    }
    const key = normalizeLicenseKey(result.key) ?? result.key;
    let entitlement: Entitlement;
    try {
      entitlement = await this.recordToken(key, result.token, 'adopt');
    } catch (error) {
      return { state: 'ready', key, saved: false, saveError: asError(error) };
    }
    this.forgetCheckout(sessionId);
    return { state: 'ready', key, saved: true, entitlement };
  }

  async billingPortalUrl(): Promise<string> {
    return this.requireService().billingUrl();
  }

  /** Replaces the stored key. Once the server has rotated, nothing here may lose the new key. */
  async rotate(): Promise<RotationResult> {
    const service = this.requireService();
    const oldKey = this.requireStoredKey();
    const rotated = await this.rememberingRefusal(oldKey, () => service.rotate(oldKey));
    const key = normalizeLicenseKey(rotated.key) ?? rotated.key;
    try {
      this.adopt({ v: 1, key, token: null, savedAt: this.deps.now() });
    } catch (error) {
      return { key, saved: false, saveError: asError(error) };
    }
    try {
      return { key, saved: true, entitlement: await this.exchange(key, 'bookkeep'), activationError: null };
    } catch (error) {
      return { key, saved: true, entitlement: await this.currentEntitlement(), activationError: asError(error) };
    }
  }

  /**
   * Gets a new token when the current one is missing, unusable or close to expiry, with pacing:
   * after a busy or unreachable service it waits a few minutes, and after a refusal, an unusable
   * token or a renewal that came back short-lived, an hour. Concurrent callers share one refresh.
   * Never throws for network or storage trouble: it returns what it has.
   */
  refreshIfDue(): Promise<Entitlement> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Forgets the license on this machine. The subscription itself is untouched, and so is the record of
   * an open checkout: a checkout that can still be paid must still be resumed, not doubled.
   */
  deactivate(): boolean {
    this.paced = null;
    return this.deps.vault.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async refreshOnce(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    const stored = read.license;
    const now = this.deps.now();
    const entitlement = await evaluateLicense(stored, this.deps.publicKey, now);
    if (!stored || !this.deps.service || !this.needsRefresh(entitlement, stored, now)) return entitlement;
    try {
      const outcome = await this.exchange(stored.key, 'bookkeep');
      this.pace(stored.key, nextAttemptAfter(outcome, now));
      return outcome;
    } catch (error) {
      if (error instanceof LicenseStorageError) {
        this.paced = { key: stored.key, until: now + TRANSIENT_BACKOFF_SECONDS };
        return entitlement;
      }
      if (!(error instanceof ProServiceError)) throw error;
      this.pace(stored.key, now + (error.retryable ? TRANSIENT_BACKOFF_SECONDS : PROBLEM_RECHECK_SECONDS));
      return this.currentEntitlement();
    }
  }

  /**
   * The checkout an earlier `upgrade` opened here, as the service sees it: saved when it was paid,
   * resumed while it is unpaid or the service cannot say, and forgotten (null: open a new one) once the
   * service says it expired, does not know it, or the subscription it started has ended. A paid one
   * whose subscription can still charge throws PaidCheckoutError; a damaged record, LicenseStorageError.
   */
  private async settleEarlierCheckout(): Promise<PurchaseStart | null> {
    const earlier = this.deps.checkouts.read();
    if (!earlier) return null;
    const resume: PurchaseStart = { state: 'checkout', sessionId: earlier.sessionId, url: earlier.url, resumed: true };
    let claim: PurchaseClaim;
    try {
      claim = await this.claimPurchase(earlier.sessionId);
    } catch (error) {
      if (!(error instanceof ProServiceError)) throw error;
      // The service could not say what became of it: resuming the same checkout is safe, opening another is not.
      if (error.retryable) return resume;
      if (error.code === 'unknown_checkout') return null; // claimPurchase forgot it
      if (error.code !== 'key_already_issued' && error.code !== 'subscription_inactive') throw error;
      // Paid, but its key cannot be collected here: only a subscription that has ended leaves room for another.
      if (!isEndedSubscriptionStatus(error.subscriptionStatus)) throw new PaidCheckoutError();
      this.forgetCheckout(earlier.sessionId);
      return null;
    }
    if (claim.state === 'pending') return resume;
    if (claim.state === 'expired') return null; // claimPurchase forgot it
    return claim;
  }

  /** Drops the record of checkout `sessionId` (a record of another checkout stays). Never hides the caller's answer. */
  private forgetCheckout(sessionId: string): void {
    try {
      if (this.deps.checkouts.read()?.sessionId === sessionId) this.deps.checkouts.clear();
    } catch (error) {
      if (!(error instanceof LicenseStorageError)) throw error;
    }
  }

  /** For a purchase decision: asks the service about a stored key now, whatever the pacing says. */
  private async freshEntitlement(): Promise<Entitlement> {
    const read = this.readStored();
    if ('unreadable' in read) return read.unreadable;
    if (!read.license) return evaluateLicense(null, this.deps.publicKey, this.deps.now());
    try {
      return await this.exchange(read.license.key, 'bookkeep');
    } catch (error) {
      if (error instanceof ProServiceError || error instanceof LicenseStorageError) return this.currentEntitlement();
      throw error;
    }
  }

  /** Exchanges a key for a token and records the outcome. A refusal of the stored key is recorded, then rethrown. */
  private async exchange(key: string, mode: WriteMode): Promise<Entitlement> {
    const service = this.requireService();
    const { token } = await this.rememberingRefusal(key, () => service.activate(key));
    return this.recordToken(key, token, mode);
  }

  /** Calls the service with a key; when the service refuses that key while it is the stored one, the refusal is recorded first. */
  private async rememberingRefusal<T>(key: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ProServiceError) this.recordRefusal(key, error);
      throw error;
    }
  }

  /**
   * Saves the key with a token the service just issued when it verifies (or cannot be checked here),
   * else with why it was dropped. In bookkeeping mode a key replaced meanwhile is left alone, and the
   * newer license's state is returned instead.
   */
  private async recordToken(key: string, token: string, mode: WriteMode): Promise<Entitlement> {
    const now = this.deps.now();
    const entitlement = await entitlementFromToken(token, this.deps.publicKey, now, 'issued');
    const keepToken = entitlement.active || entitlement.reason === 'no_public_key';
    const license: StoredLicense = { v: 1, key, token: keepToken ? token : null, savedAt: now };
    if (!entitlement.active && isPersistedProblem(entitlement.reason)) license.problem = { reason: entitlement.reason, at: now };
    if (mode === 'adopt') {
      this.adopt(license);
      return entitlement;
    }
    return this.updateStored(key, () => license) ? entitlement : this.currentEntitlement();
  }

  private recordRefusal(key: string, error: ProServiceError): void {
    const problem = problemFromRefusal(error);
    if (!problem) return;
    const now = this.deps.now();
    this.updateStoredQuietly(key, () => ({ v: 1, key, token: null, savedAt: now, problem: { ...problem, at: now } }));
  }

  /** Remembers when to try an automatic refresh for `key` again: here, and in the license file while it still holds `key`. */
  private pace(key: string, until: number | null): void {
    this.paced = until === null ? null : { key, until };
    if (until !== null) this.updateStoredQuietly(key, (current) => ({ ...current, nextRefreshAt: until }));
  }

  /** Writes a license the user chose (a typed key, a purchase, a rotation), replacing whatever was stored. */
  private adopt(license: StoredLicense): void {
    this.deps.vault.write(license);
    this.paced = null;
  }

  /** Bookkeeping for `key`: re-reads the license and applies `change` only if `key` is still the stored one. */
  private updateStored(key: string, change: (current: StoredLicense) => StoredLicense): boolean {
    const current = this.deps.vault.read();
    if (current?.key !== key) return false;
    this.deps.vault.write(change(current));
    return true;
  }

  /** Bookkeeping that must not hide the answer the caller is waiting for when the file cannot be read or written. */
  private updateStoredQuietly(key: string, change: (current: StoredLicense) => StoredLicense): void {
    try {
      this.updateStored(key, change);
    } catch (error) {
      if (!(error instanceof LicenseStorageError)) throw error;
    }
  }

  private needsRefresh(entitlement: Entitlement, stored: StoredLicense, now: number): boolean {
    const pacedHere = this.paced?.key === stored.key ? this.paced.until : 0;
    if (now < Math.max(stored.nextRefreshAt ?? 0, pacedHere)) return false;
    if (entitlement.active) return entitlement.refreshDue;
    if (entitlement.reason === 'no_public_key') return false;
    if (!stored.token && stored.problem) return now - stored.problem.at >= PROBLEM_RECHECK_SECONDS;
    return true;
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

  /** The stored key. A license file that cannot be read throws LicenseStorageError: it is not "no key". */
  private requireStoredKey(): string {
    const key = this.deps.vault.read()?.key;
    if (!key) throw new LicenseInputError('No Timmy Pro license key on this machine. Run `timmy pro activate -` and paste your key.');
    return key;
  }
}

function parseKey(raw: string): string {
  const key = normalizeLicenseKey(raw);
  if (!key) throw new LicenseInputError('That is not a Timmy Pro license key (expected tpro_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX).');
  return key;
}

/** When to try again after an automatic refresh that reached the service; null when the new token needs nothing. */
function nextAttemptAfter(outcome: Entitlement, now: number): number | null {
  if (!outcome.active) return now + PROBLEM_RECHECK_SECONDS;
  // A token that is due on arrival is short on purpose (a past-due grace period, a late renewal): asking again now will not help.
  if (outcome.refreshDue) return Math.min(now + PROBLEM_RECHECK_SECONDS, outcome.tokenExpiresAt);
  return null;
}

const isPersistedProblem = (reason: string): reason is PersistedProblem => (PERSISTED_PROBLEMS as readonly string[]).includes(reason);

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
