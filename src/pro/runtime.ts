// Wires the license machinery to the real world: the environment, the license
// file under TIMMY_HOME, the network and the clock. No terminal code lives here,
// so Pro features can depend on it (through gate.ts) without loading the CLI.

import { resolveTimmyHome } from '../utils/init.js';
import { HttpProService, type FetchLike } from './client.js';
import { importVerifyKey } from './license.js';
import { LicenseManager } from './manager.js';
import { ProConfigError, resolveProSettings, type ProSettings } from './settings.js';
import { FileLicenseVault } from './vault.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** Replaceable pieces of the outside world, for tests and embedders. */
export interface RuntimeOverrides {
  fetch?: FetchLike;
  /** Unix seconds. */
  now?: () => number;
}

export interface ProRuntime {
  settings: ProSettings;
  manager: LicenseManager;
}

/** Throws ProConfigError when TIMMY_PRO_URL or the public key is unusable. */
export async function resolveProRuntime(env: Env = process.env, overrides: RuntimeOverrides = {}): Promise<ProRuntime> {
  const settings = resolveProSettings(env, resolveTimmyHome(env));
  const manager = new LicenseManager({
    vault: new FileLicenseVault(settings.licensePath),
    service: settings.serviceUrl ? new HttpProService(settings.serviceUrl, overrides.fetch) : null,
    publicKey: settings.publicKey ? await verifyKey(settings.publicKey, settings.publicKeySource) : null,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
  });
  return { settings, manager };
}

/** The license manager for this machine. Most features want checkProFeature (gate.ts) instead. */
export async function loadLicenseManager(env: Env = process.env, overrides: RuntimeOverrides = {}): Promise<LicenseManager> {
  return (await resolveProRuntime(env, overrides)).manager;
}

async function verifyKey(raw: string, source: ProSettings['publicKeySource']): Promise<CryptoKey> {
  try {
    return await importVerifyKey(raw);
  } catch {
    throw new ProConfigError(source === 'env'
      ? 'TIMMY_PRO_PUBLIC_KEY is not a valid Timmy Pro public key (32 raw bytes, base64url).'
      : 'The built-in Timmy Pro public key is not valid; this build is broken. Set TIMMY_PRO_PUBLIC_KEY or update Timmy.');
  }
}
