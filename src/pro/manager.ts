// The license lifecycle on this machine: activate, refresh, claim a purchase,
// rotate, forget. Network calls go through the ProService port; storage goes
// through the LicenseVault port; entitlement is decided by entitlement.ts.

import { ProServiceError, type ProService } from './client.js';
import { entitlementFromToken, evaluateLicense, type Entitlement } from './entitlement.js';
import { normalizeLicenseKey } from './license.js';
import type { LicenseVault } from './vault.js';

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

export interface LicenseManagerDeps {
  vault: LicenseVault;
  service: ProService | null;
  publicKey: CryptoKey | null;
  /** Unix seconds. */
  now: () => number;
}

export type PurchaseClaim = { state: 'pending' } | { state: 'ready'; key: string; entitlement: Entitlement };

export interface RotationResult {
  key: string;
  entitlement: Entitlement;
  /** Why the new key could not be activated yet; the new key is saved either way. */
  activationError: string | null;
}

export class LicenseManager {
  constructor(private readonly deps: LicenseManagerDeps) {}

  current(): Promise<Entitlement> {
    return evaluateLicense(this.deps.vault.read(), this.deps.publicKey, this.deps.now());
  }

  storedKey(): string | null {
    return this.deps.vault.read()?.key ?? null;
  }

  /** Exchanges a key (or the stored one) for a fresh token and saves both. */
  async activate(rawKey?: string): Promise<Entitlement> {
    const key = rawKey === undefined ? this.requireStoredKey() : parseKey(rawKey);
    const { token } = await this.requireService().activate(key);
    return this.save(key, token);
  }

  /** Asks once whether a checkout has produced a key; saves it the moment it has. */
  async claimPurchase(sessionId: string): Promise<PurchaseClaim> {
    const result = await this.requireService().claim(sessionId);
    if (result.state === 'pending') return result;
    const key = normalizeLicenseKey(result.key) ?? result.key;
    return { state: 'ready', key, entitlement: await this.save(key, result.token) };
  }

  /** Replaces the stored key. The old key dies on the server first, so the new one is saved before anything else can fail. */
  async rotate(): Promise<RotationResult> {
    const { key } = await this.requireService().rotate(this.requireStoredKey());
    this.deps.vault.write({ v: 1, key, token: null, savedAt: this.deps.now() });
    try {
      return { key, entitlement: await this.activate(key), activationError: null };
    } catch (error) {
      if (!(error instanceof ProServiceError)) throw error;
      return { key, entitlement: await this.current(), activationError: error.message };
    }
  }

  /**
   * Gets a new token when the current one is missing, unusable or close to expiry.
   * Offline or rate-limited: keeps what it has. Refused by the server: drops the token.
   */
  async refreshIfDue(): Promise<Entitlement> {
    const stored = this.deps.vault.read();
    const entitlement = await evaluateLicense(stored, this.deps.publicKey, this.deps.now());
    if (!stored || !this.deps.service || !needsRefresh(entitlement)) return entitlement;
    try {
      return await this.activate(stored.key);
    } catch (error) {
      if (!(error instanceof ProServiceError)) throw error;
      if (error.status !== 403 && error.status !== 404) return entitlement;
      this.deps.vault.write({ ...stored, token: null, savedAt: this.deps.now() });
      return { active: false, reason: 'revoked', detail: error.message };
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
    const keepToken = entitlement.active || (!entitlement.active && entitlement.reason === 'no_public_key');
    this.deps.vault.write({ v: 1, key, token: keepToken ? token : null, savedAt: now });
    return entitlement;
  }

  private requireService(): ProService {
    if (!this.deps.service) throw new ProUnavailableError();
    return this.deps.service;
  }

  private requireStoredKey(): string {
    const key = this.storedKey();
    if (!key) throw new LicenseInputError('No Timmy Pro license key on this machine. Run `timmy pro activate <key>`.');
    return key;
  }
}

function parseKey(raw: string): string {
  const key = normalizeLicenseKey(raw);
  if (!key) throw new LicenseInputError('That is not a Timmy Pro license key (expected tpro_XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX).');
  return key;
}

function needsRefresh(entitlement: Entitlement): boolean {
  return entitlement.active ? entitlement.refreshDue : entitlement.reason !== 'no_public_key';
}
