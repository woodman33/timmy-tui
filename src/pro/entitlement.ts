// What this machine may offer: the verified answer to "is Pro on here?".
//
// Entitlement comes only from a license token that verifies against the
// public key. Claims sent by the server next to a token are never trusted.

import { verifyLicenseToken, type LicenseClaims } from './license.js';
import { PRO_FEATURE_LABELS, PRO_PLAN, type ProFeature } from './plan.js';
import type { StoredLicense } from './vault.js';

/** Refresh a token once it has this little time left (tokens last up to 7 days). */
export const REFRESH_WINDOW_SECONDS = 2 * 86_400;

export type EntitlementGap = 'not_activated' | 'no_public_key' | 'invalid_token' | 'expired' | 'inactive' | 'revoked';

export type Entitlement =
  | { active: true; claims: LicenseClaims; refreshDue: boolean }
  | { active: false; reason: EntitlementGap; detail: string };

export async function evaluateLicense(license: StoredLicense | null, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!license) return { active: false, reason: 'not_activated', detail: 'no Timmy Pro license on this machine' };
  if (!license.token) return { active: false, reason: 'not_activated', detail: 'license key saved but not activated' };
  return entitlementFromToken(license.token, publicKey, nowSeconds);
}

export async function entitlementFromToken(token: string, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!publicKey) return { active: false, reason: 'no_public_key', detail: 'this build has no Timmy Pro public key to check licenses with' };
  const check = await verifyLicenseToken(token, publicKey, nowSeconds);
  if (check.ok) return { active: true, claims: check.claims, refreshDue: check.claims.exp - nowSeconds <= REFRESH_WINDOW_SECONDS };
  const reason: EntitlementGap = check.reason === 'token expired' ? 'expired' : check.reason === 'subscription not active' ? 'inactive' : 'invalid_token';
  return { active: false, reason, detail: check.reason };
}

export function allowsFeature(entitlement: Entitlement, feature: ProFeature): boolean {
  return entitlement.active && entitlement.claims.features.includes(feature);
}

export function upgradeMessage(feature: ProFeature): string {
  return `${PRO_FEATURE_LABELS[feature]} is part of ${PRO_PLAN.name} ($${PRO_PLAN.priceUsdMonthly}/month). Run \`timmy pro upgrade\`.`;
}
