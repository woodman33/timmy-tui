// The license lifecycle on this machine: buy, activate, renew, refresh, rotate,
// forget. Network calls go through the ProService port and storage through the
// LicenseVault port (ports.ts); what the result means is entitlement.ts's job.

import { REFUSAL_DETAIL, entitlementFromToken, evaluateLicense, type Entitlement } from './entitlement.js';
import { normalizeLicenseKey } from './license.js';
import { ProServiceError, type LicenseVault, type ProService, type StoredLicense } from './ports.js';

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

/** After the service refused the stored key, ask again at most this often. */
const REFUSAL_RECHECK_SECONDS = 3600;

export interface LicenseManagerDeps {
  vault: LicenseVault;
  service: ProService | null;
  publicKey: CryptoKey | null;
  /** Unix seconds. */
  now: () => number;
}

export type PurchaseClaim = { state: 'pending' } | { state: 'ready'; key: string; entitlement: Entitlement };

export interface RotationResult {
  /** The new key. The old one stopped working on the server before this returned. */
  key: string;
  /** Whether the new key reached the license file; when false, the caller must show it now. */
  saved: boolean;
  entitlement: Entitlement;
  /** What went wrong after the server rotated (saving or activating), if anything. */
  followUpError: Error | null;
}

export class LicenseManager {
  constructor(private readonly deps: LicenseManagerDeps) {}

  /** Offline: what the stored license says right now. */
  currentEntitlement(): Promise<Entitlement> {
    return evaluateLicense(this.deps.vault.read(), this.deps.publicKey, this.deps.now());
  }

  storedKey(): string | null {
    return this.deps.vault.read()?.key ?? null;
  }

  /** Exchanges a typed or pasted key for a token and saves both. */
  async activate(rawKey: string): Promise<Entitlement> {
    const key = parseKey(rawKey);
    const { token } = await this.requireService().activate(key);
    return this.save(key, token);
  }

  /** Gets a fresh token for the stored key. */
  async renew(): Promise<Entitlement> {
    const key = this.requireStoredKey();
    const { token } = await this.requireService().activate(key);
    return this.save(key, token);
  }

  /** Opens a Stripe Checkout for Timmy Pro. */
  async startPurchase(): Promise<{ url: string; sessionId: string }> {
    return this.requireService().startCheckout();
  }

  /** Asks once whether a checkout has produced a key; saves it the moment it has. */
  async claimPurchase(sessionId: string): Promise<PurchaseClaim> {
    const result = await this.requireService().claim(sessionId);
    if (result.state === 'pending') return result;
    const key = normalizeLicenseKey(result.key) ?? result.key;
    return { state: 'ready', key, entitlement: await this.save(key, result.token) };
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
      return { key, saved: false, entitlement: { active: false, reason: 'key_not_activated', detail: 'the new key is not saved on this machine' }, followUpError: asError(error) };
    }
    try {
      return { key, saved: true, entitlement: await this.activate(key), followUpError: null };
    } catch (error) {
      return { key, saved: true, entitlement: await this.currentEntitlement(), followUpError: asError(error) };
    }
  }

  /**
   * Gets a new token when the current one is missing, unusable or close to expiry.
   * Busy, offline or answered by something other than the Pro service: keeps what it has.
   * Refused by the service: drops the token and remembers why, rechecking at most hourly.
   */
  async refreshIfDue(): Promise<Entitlement> {
    const stored = this.deps.vault.read();
    const now = this.deps.now();
    const entitlement = await evaluateLicense(stored, this.deps.publicKey, now);
    if (!stored || !this.deps.service || !needsRefresh(entitlement, stored, now)) return entitlement;
    try {
      return await this.renew();
    } catch (error) {
      if (error instanceof LicenseInputError) return entitlement;
      if (!(error instanceof ProServiceError)) throw error;
      if (error.kind !== 'refused' || (error.code !== 'subscription_inactive' && error.code !== 'unknown_key')) return entitlement;
      const reason = error.code === 'unknown_key' ? 'key_revoked' : 'subscription_inactive';
      this.deps.vault.write({ ...stored, token: null, savedAt: now, refusal: { reason, at: now } });
      return { active: false, reason, detail: REFUSAL_DETAIL[reason] };
    }
  }

  /** Forgets the license on this machine. The subscription itself is untouched. */
  deactivate(): boolean {
    return this.deps.vault.clear();
  }

  /** Always keeps the key; keeps the token when it verifies, or when there is no key to verify it with. */
  private async save(key: string, token: string): Promise<Entitlement> {
    const now = this.deps.now();
    const entitlement = await entitlementFromToken(token, this.deps.publicKey, now);
    const keepToken = entitlement.active || entitlement.reason === 'no_public_key';
    this.deps.vault.write({ v: 1, key, token: keepToken ? token : null, savedAt: now });
    return entitlement;
  }

  private requireService(): ProService {
    if (!this.deps.service) throw new ProUnavailableError();
    return this.deps.service;
  }

  private requireStoredKey(): string {
    const key = this.storedKey();
    if (!key) throw new LicenseInputError('No Timmy Pro license key on this machine. Run `timmy pro activate -` and paste your key.');
    return key;
  }
}

function parseKey(raw: string): string {
  const key = normalizeLicenseKey(raw);
  if (!key) throw new LicenseInputError('That is not a Timmy Pro license key (expected tpro_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX).');
  return key;
}

function needsRefresh(entitlement: Entitlement, stored: StoredLicense, now: number): boolean {
  if (entitlement.active) return entitlement.refreshDue;
  if (entitlement.reason === 'no_public_key') return false;
  if (!stored.token && stored.refusal) return now - stored.refusal.at >= REFUSAL_RECHECK_SECONDS;
  return true;
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
