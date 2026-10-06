// What this machine may offer: the verified answer to "is Pro on here?", and
// the one next step for every way it can be off.
//
// Entitlement comes only from a license token that verifies against the
// public key. Claims sent by the server next to a token are never trusted, and
// feature ids this build does not know are dropped.

import { verifyLicenseToken } from './license.js';
import { PRO_FEATURE_LABELS, PRO_PLAN, isProFeature, type ProFeature } from './plan.js';
import type { StoredLicense } from './ports.js';

/** Refresh a token once it has this little time left (tokens last up to 7 days). */
export const REFRESH_WINDOW_SECONDS = 2 * 86_400;

/** Why Pro is off on this machine. Each reason has exactly one next step (see nextStep). */
export type InactiveReason =
  | 'no_license' //            nothing stored here
  | 'key_not_activated' //     a key is stored without a usable token
  | 'token_expired' //         the token lapsed; the subscription may well be fine
  | 'invalid_token' //         the token does not verify against this build's public key
  | 'no_public_key' //         this build cannot check tokens at all
  | 'subscription_inactive' // the subscription is off
  | 'key_revoked'; //          the service no longer knows this key (it was replaced)

export type Entitlement =
  | {
      active: true;
      features: readonly ProFeature[];
      /** Stripe subscription status when the token was issued. */
      status: string;
      /** Unix seconds when the offline token runs out (it renews before then while online). */
      tokenExpiresAt: number;
      refreshDue: boolean;
    }
  | { active: false; reason: InactiveReason; detail: string };

export async function evaluateLicense(license: StoredLicense | null, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!license) return { active: false, reason: 'no_license', detail: 'no Timmy Pro license on this machine' };
  if (!license.token && license.refusal) return { active: false, reason: license.refusal.reason, detail: REFUSAL_DETAIL[license.refusal.reason] };
  if (!license.token) return { active: false, reason: 'key_not_activated', detail: 'license key saved but not activated' };
  return entitlementFromToken(license.token, publicKey, nowSeconds);
}

export async function entitlementFromToken(token: string, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!publicKey) return { active: false, reason: 'no_public_key', detail: 'this build has no Timmy Pro public key to check licenses with' };
  const check = await verifyLicenseToken(token, publicKey, nowSeconds);
  if (check.ok) {
    return {
      active: true,
      features: check.claims.features.filter(isProFeature),
      status: check.claims.status,
      tokenExpiresAt: check.claims.exp,
      refreshDue: check.claims.exp - nowSeconds <= REFRESH_WINDOW_SECONDS,
    };
  }
  const reason: InactiveReason = check.code === 'expired' ? 'token_expired' : check.code === 'inactive' ? 'subscription_inactive' : 'invalid_token';
  return { active: false, reason, detail: check.reason };
}

export const REFUSAL_DETAIL: Readonly<Record<'subscription_inactive' | 'key_revoked', string>> = {
  subscription_inactive: 'the Pro service says the subscription is not active',
  key_revoked: 'the Pro service no longer recognizes this license key',
};

// ── what to do about it ──────────────────────────────────────────────────

export type NextStep = 'none' | 'buy' | 'renew' | 'billing' | 'use_newest_key' | 'update_timmy';

const STEP_FOR: Readonly<Record<InactiveReason, NextStep>> = {
  no_license: 'buy',
  key_not_activated: 'renew',
  token_expired: 'renew',
  subscription_inactive: 'billing',
  key_revoked: 'use_newest_key',
  invalid_token: 'update_timmy',
  no_public_key: 'update_timmy',
};

export function nextStep(entitlement: Entitlement): NextStep {
  return entitlement.active ? 'none' : STEP_FOR[entitlement.reason];
}

export type FeatureAccess =
  | { allowed: true }
  | { allowed: false; reason: InactiveReason | 'not_in_plan'; message: string };

export function featureAccess(entitlement: Entitlement, feature: ProFeature): FeatureAccess {
  if (!entitlement.active) return { allowed: false, reason: entitlement.reason, message: accessMessage(entitlement, feature) };
  if (entitlement.features.includes(feature)) return { allowed: true };
  return { allowed: false, reason: 'not_in_plan', message: `${PRO_FEATURE_LABELS[feature]} needs a newer Timmy Pro license token. Run \`timmy pro activate\`.` };
}

/** One sentence telling this user what to do, never "buy" to someone who already holds a key. */
export function accessMessage(entitlement: Entitlement, feature?: ProFeature): string {
  const subject = feature ? PRO_FEATURE_LABELS[feature] : PRO_PLAN.name;
  switch (nextStep(entitlement)) {
    case 'none':
      return `${PRO_PLAN.name} is active.`;
    case 'buy':
      return feature
        ? `${subject} is part of ${PRO_PLAN.name} ($${PRO_PLAN.priceUsdMonthly}/month). Run \`timmy pro upgrade\`, or \`timmy pro activate -\` if you have a key.`
        : `Get ${PRO_PLAN.name} ($${PRO_PLAN.priceUsdMonthly}/month) with \`timmy pro upgrade\`, or run \`timmy pro activate -\` if you have a key.`;
    case 'renew':
      return `Your ${PRO_PLAN.name} license needs renewing on this machine. Run \`timmy pro activate\` while online.`;
    case 'billing':
      return `Your ${PRO_PLAN.name} subscription is not active. Run \`timmy pro billing\` to check or restart it.`;
    case 'use_newest_key':
      return `This license key was replaced. Activate the newest key with \`timmy pro activate -\`.`;
    case 'update_timmy':
      return `This build of Timmy cannot check Pro licenses (${entitlement.active ? '' : entitlement.detail}). Update Timmy, or check TIMMY_PRO_PUBLIC_KEY.`;
  }
}
