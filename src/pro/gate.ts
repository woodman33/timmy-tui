// The one call a Timmy feature makes to ask "may I offer this Pro feature here?".
//
// It never throws, and it keeps features off the network when it can: an active
// license answers at once while a due renewal runs in the background, and only an
// inactive one waits for a refresh (the license manager paces those, and requests
// made from here give up after GATE_TIMEOUT_MS). A bad configuration or an
// unexpected failure comes back as a denial with a message for the user. This
// only decides what this machine offers; hosted features must also check the
// license key on the server.

import { featureAccess, type Entitlement, type FeatureAccess } from './entitlement.js';
import type { LicenseManager } from './manager.js';
import type { ProFeature } from './plan.js';
import { resolveProRuntime, type Env, type RuntimeOverrides } from './runtime.js';

/** How long a feature check lets one request to the Pro service take. */
export const GATE_TIMEOUT_MS = 5_000;

export type ProGateResult =
  | FeatureAccess
  | { allowed: false; reason: 'config_error' | 'unexpected_error'; message: string };

/**
 * When a feature check may use the network:
 * - `background` (default): an active license answers at once and a due renewal runs in the
 *   background; an inactive one waits for a refresh, since that may be what turns it back on.
 * - `wait`: refresh first when due, then answer.
 * - `never`: answer from the license on this machine alone.
 */
export type ProGateRefresh = 'background' | 'wait' | 'never';

export interface ProGateOptions {
  refresh?: ProGateRefresh;
  env?: Env;
  /** Replaces pieces of the outside world; `timeoutMs` defaults to GATE_TIMEOUT_MS here. */
  overrides?: RuntimeOverrides;
  /** Use this manager (and its own request timeout) instead of building one from `env`. */
  manager?: LicenseManager;
}

export async function checkProFeature(feature: ProFeature, options: ProGateOptions = {}): Promise<ProGateResult> {
  let manager = options.manager;
  if (!manager) {
    try {
      manager = (await resolveProRuntime(options.env ?? process.env, { timeoutMs: GATE_TIMEOUT_MS, ...options.overrides })).manager;
    } catch (error) {
      return { allowed: false, reason: 'config_error', message: `Timmy Pro is misconfigured: ${messageOf(error)}` };
    }
  }
  try {
    return featureAccess(await entitlementFor(manager, options.refresh ?? 'background'), feature);
  } catch (error) {
    return { allowed: false, reason: 'unexpected_error', message: `Could not check Timmy Pro on this machine: ${messageOf(error)}` };
  }
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
