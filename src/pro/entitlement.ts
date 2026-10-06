// What this machine may offer: the verified answer to "is Pro on here?", and
// the one next step for every way it can be off.
//
// Entitlement comes only from a license token that verifies against the
// public key. Claims sent by the server next to a token are never trusted, and
// feature ids this build does not know are dropped.

import { verifyLicenseToken, type TokenProblem } from './license.js';
import { PRO_FEATURE_LABELS, PRO_PLAN, isProFeature, type ProFeature } from './plan.js';
import type { PersistedProblem, StoredLicense } from './ports.js';

/** Refresh a token once it has this little time left (tokens last up to 7 days). */
export const REFRESH_WINDOW_SECONDS = 2 * 86_400;

/** Why Pro is off on this machine. Each reason (with the subscription status, for a stopped subscription) has one next step. */
export type InactiveReason =
  | 'no_license' //            nothing stored here
  | 'key_not_activated' //     a key is stored without a usable token
  | 'token_expired' //         the token lapsed; the subscription may well be fine
  | 'invalid_token' //         the token does not verify against this build's public key
  | 'no_public_key' //         this build cannot check tokens at all
  | 'clock_skew' //            this computer's clock disagrees with the service
  | 'subscription_inactive' // the subscription is not active (see subscriptionStatus)
  | 'key_revoked' //           the service no longer knows this key (it was replaced)
  | 'license_unreadable'; //   the license file exists but cannot be read or understood

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
  | { active: false; reason: InactiveReason; detail: string; subscriptionStatus?: string };

const REASON_FOR_TOKEN: Readonly<Record<TokenProblem, InactiveReason>> = {
  missing: 'key_not_activated',
  not_timmy: 'key_not_activated',
  malformed: 'key_not_activated',
  bad_signature: 'invalid_token',
  unsupported: 'invalid_token',
  inactive: 'subscription_inactive',
  expired: 'token_expired',
  future: 'clock_skew',
};

const PROBLEM_DETAIL: Readonly<Record<PersistedProblem, string>> = {
  subscription_inactive: 'the Pro service says the subscription is not active',
  key_revoked: 'the Pro service no longer recognizes this license key',
  invalid_token: 'the license token does not verify against this build of Timmy',
  clock_skew: "this computer's clock disagrees with the Pro service",
};

export async function evaluateLicense(license: StoredLicense | null, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!license) return { active: false, reason: 'no_license', detail: 'no Timmy Pro license on this machine' };
  if (!license.token && license.problem) {
    const { reason, subscriptionStatus } = license.problem;
    const detail = subscriptionStatus ? `${PROBLEM_DETAIL[reason]} (${subscriptionStatus})` : PROBLEM_DETAIL[reason];
    return subscriptionStatus ? { active: false, reason, detail, subscriptionStatus } : { active: false, reason, detail };
  }
  if (!license.token) return { active: false, reason: 'key_not_activated', detail: 'license key saved but not activated' };
  return entitlementFromToken(license.token, publicKey, nowSeconds);
}

export async function entitlementFromToken(token: string, publicKey: CryptoKey | null, nowSeconds: number): Promise<Entitlement> {
  if (!publicKey) return { active: false, reason: 'no_public_key', detail: 'this build has no Timmy Pro public key to check licenses with' };
  const check = await verifyLicenseToken(token, publicKey, nowSeconds);
  if (!check.ok) return { active: false, reason: REASON_FOR_TOKEN[check.code], detail: check.reason };
  return {
    active: true,
    features: check.claims.features.filter(isProFeature),
    status: check.claims.status,
    tokenExpiresAt: check.claims.exp,
    refreshDue: check.claims.exp - nowSeconds <= REFRESH_WINDOW_SECONDS,
  };
}

// ── what to do about it ──────────────────────────────────────────────────

export type NextStep = 'none' | 'buy' | 'renew' | 'billing' | 'use_newest_key' | 'update_timmy' | 'check_clock' | 'fix_license_file';

const STEP_FOR: Readonly<Record<InactiveReason, NextStep>> = {
  no_license: 'buy',
  key_not_activated: 'renew',
  token_expired: 'renew',
  subscription_inactive: 'billing',
  key_revoked: 'use_newest_key',
  invalid_token: 'update_timmy',
  no_public_key: 'update_timmy',
  clock_skew: 'check_clock',
  license_unreadable: 'fix_license_file',
};

/** A subscription in one of these states is over; anything else (past_due, unpaid, paused) can still charge or resume. */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export function nextStep(entitlement: Entitlement): NextStep {
  if (entitlement.active) return 'none';
  if (entitlement.reason === 'subscription_inactive' && ENDED_SUBSCRIPTION_STATUSES.has(entitlement.subscriptionStatus ?? '')) return 'buy';
  return STEP_FOR[entitlement.reason];
}

export type FeatureAccess =
  | { allowed: true }
  | { allowed: false; reason: InactiveReason | 'not_in_plan'; message: string };

export function featureAccess(entitlement: Entitlement, feature: ProFeature): FeatureAccess {
  if (!entitlement.active) return { allowed: false, reason: entitlement.reason, message: accessMessage(entitlement, feature) };
  if (entitlement.features.includes(feature)) return { allowed: true };
  return { allowed: false, reason: 'not_in_plan', message: `${PRO_FEATURE_LABELS[feature]} needs a newer Timmy Pro license token. Run \`timmy pro activate\`.` };
}

const PRICE = `$${PRO_PLAN.priceUsdMonthly}/month`;

/** One sentence telling this user what to do, never "buy" to someone whose subscription can still resume. */
export function accessMessage(entitlement: Entitlement, feature?: ProFeature): string {
  const step = nextStep(entitlement);
  if (entitlement.active || step === 'none') return `${PRO_PLAN.name} is active.`;
  switch (step) {
    case 'buy':
      if (entitlement.reason === 'subscription_inactive') return `Your ${PRO_PLAN.name} subscription has ended. Run \`timmy pro upgrade\` to start a new one (${PRICE}).`;
      return feature
        ? `${PRO_FEATURE_LABELS[feature]} is part of ${PRO_PLAN.name} (${PRICE}). Run \`timmy pro upgrade\`, or \`timmy pro activate -\` if you have a key.`
        : `Get ${PRO_PLAN.name} (${PRICE}) with \`timmy pro upgrade\`, or run \`timmy pro activate -\` if you have a key.`;
    case 'renew':
      return `Your ${PRO_PLAN.name} license needs renewing on this machine. Run \`timmy pro activate\` while online.`;
    case 'billing':
      return `Your ${PRO_PLAN.name} subscription is ${entitlement.subscriptionStatus?.replaceAll('_', ' ') ?? 'not active'}. Fix it with \`timmy pro billing\`, then run \`timmy pro activate\`.`;
    case 'use_newest_key':
      return `This license key was replaced. Activate the newest key with \`timmy pro activate -\`.`;
    case 'update_timmy':
      return `This build of Timmy cannot check Pro licenses (${entitlement.detail}). Update Timmy, or check TIMMY_PRO_PUBLIC_KEY.`;
    case 'check_clock':
      return `This computer's clock looks wrong, so the ${PRO_PLAN.name} license cannot be checked. Set the clock automatically, then run \`timmy pro activate\`.`;
    case 'fix_license_file':
      return `The ${PRO_PLAN.name} license file on this machine cannot be read (${entitlement.detail}). Fix or remove that file, then run \`timmy pro activate -\` with your key.`;
  }
}
