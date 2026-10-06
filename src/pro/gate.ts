// What Timmy features call to ask "may I offer this Pro feature here?".
//
// A gate never throws, and it keeps features off the network when it can: an
// active license answers at once while a due renewal runs in the background, and
// only an inactive one waits for a refresh (the license manager paces those, and
// requests made from a gate give up after GATE_TIMEOUT_MS). A gate keeps one
// license manager for its lifetime, so checks share renewals and pacing;
// checkProFeature uses one default gate per process. A bad configuration or an
// unexpected failure comes back as a denial with a message for the user. This
// only decides what this machine offers; hosted features must also check the
// license key on the server.

import { featureAccess, type Entitlement, type FeatureAccess } from './entitlement.js';
import type { LicenseManager } from './manager.js';
import type { ProFeature } from './plan.js';
import { resolveProRuntime, type Env, type RuntimeOverrides } from './runtime.js';

/** How long a request made for a feature check may take. */
export const GATE_TIMEOUT_MS = 5_000;

export type ProGateResult =
  | FeatureAccess
  | { allowed: false; reason: 'config_error' | 'unexpected_error'; message: string };

/**
 * When a feature check may use the network:
 * - `background` (default): an active license answers at once and a due renewal runs in the
 *   background; an inactive one waits for a refresh, since that may be what turns it back on.
 * - `wait`: wait for any renewal that is due, then answer.
 * - `never`: answer from the license on this machine alone.
 */
export type ProGateRefresh = 'background' | 'wait' | 'never';

export interface ProGateCheckOptions {
  refresh?: ProGateRefresh;
}

export interface ProGate {
  /** May this machine offer `feature`? Never throws. */
  check(feature: ProFeature, options?: ProGateCheckOptions): Promise<ProGateResult>;
}

/**
 * Where a gate gets its license: a manager you already have, or one built on first use from an
 * environment (default: process.env), with pieces of the outside world replaced if given
 * (`timeoutMs` defaults to GATE_TIMEOUT_MS).
 */
export type ProGateSource = { manager: LicenseManager } | { env?: Env; overrides?: RuntimeOverrides };

export function createProGate(source: ProGateSource = {}): ProGate {
  let manager: Promise<LicenseManager> | null = null;
  const managerFor = (): Promise<LicenseManager> =>
    (manager ??= 'manager' in source
      ? Promise.resolve(source.manager)
      : resolveProRuntime(source.env ?? process.env, { timeoutMs: GATE_TIMEOUT_MS, ...source.overrides }).then((runtime) => runtime.manager));

  return {
    async check(feature, options = {}) {
      let current: LicenseManager;
      try {
        current = await managerFor();
      } catch (error) {
        return { allowed: false, reason: 'config_error', message: `Timmy Pro is misconfigured: ${messageOf(error)}` };
      }
      try {
        return featureAccess(await entitlementFor(current, options.refresh ?? 'background'), feature);
      } catch (error) {
        return { allowed: false, reason: 'unexpected_error', message: `Could not check Timmy Pro on this machine: ${messageOf(error)}` };
      }
    },
  };
}

let defaultGate: ProGate | null = null;

/** Asks this process's gate, built from process.env on first use, whether this machine may offer `feature`. Never throws. */
export function checkProFeature(feature: ProFeature, options: ProGateCheckOptions = {}): Promise<ProGateResult> {
  defaultGate ??= createProGate();
  return defaultGate.check(feature, options);
}

async function entitlementFor(manager: LicenseManager, refresh: ProGateRefresh): Promise<Entitlement> {
  if (refresh === 'wait') return manager.refreshIfDue();
  const current = await manager.currentEntitlement();
  if (refresh === 'never') return current;
  if (!current.active) return manager.refreshIfDue();
  if (current.refreshDue) void manager.refreshIfDue().catch(() => { /* the next check tries again */ });
  return current;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
