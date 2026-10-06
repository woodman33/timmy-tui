// The one call a Timmy feature makes to ask "may I offer this Pro feature here?".
//
// It never throws: a bad configuration, an unreadable license file or an
// unreachable service all come back as a denial with a message for the user.
// This only decides what this machine offers; hosted features must also check
// the license key on the server.

import { featureAccess, type FeatureAccess } from './entitlement.js';
import type { LicenseManager } from './manager.js';
import type { ProFeature } from './plan.js';
import { resolveProRuntime, type Env, type RuntimeOverrides } from './runtime.js';

export type ProGateResult = FeatureAccess | { allowed: false; reason: 'config_error' | 'license_unreadable'; message: string };

export interface ProGateOptions {
  /** Ask the service for a fresh token when the current one is due (default true). */
  refresh?: boolean;
  env?: Env;
  overrides?: RuntimeOverrides;
  /** Use this manager instead of building one from `env`. */
  manager?: LicenseManager;
}

export async function checkProFeature(feature: ProFeature, options: ProGateOptions = {}): Promise<ProGateResult> {
  let manager = options.manager;
  if (!manager) {
    try {
      manager = (await resolveProRuntime(options.env ?? process.env, options.overrides)).manager;
    } catch (error) {
      return { allowed: false, reason: 'config_error', message: `Timmy Pro is misconfigured: ${messageOf(error)}` };
    }
  }
  try {
    const entitlement = options.refresh === false ? await manager.currentEntitlement() : await manager.refreshIfDue();
    return featureAccess(entitlement, feature);
  } catch (error) {
    return { allowed: false, reason: 'license_unreadable', message: `Could not read the Timmy Pro license on this machine: ${messageOf(error)}` };
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
