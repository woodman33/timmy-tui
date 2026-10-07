// Where the `timmy pro` client finds its service and its license public key.
//
// Both ship empty and are filled in at go-live (docs/PRO.md). TIMMY_PRO_URL and
// TIMMY_PRO_PUBLIC_KEY override them, e.g. to point at a test-mode worker.
// The local token only decides what this machine offers; hosted Pro features
// check the license key on the server, so the override unlocks nothing hosted.

import { join } from 'node:path';

export const BUILD_PRO_SERVICE_URL = '';
export const BUILD_PRO_PUBLIC_KEY = '';

export interface ProSettings {
  /** Service origin without a trailing slash, or null when this build has none. */
  serviceUrl: string | null;
  /** ed25519 public key (32 raw bytes, base64url) that license tokens must verify against. */
  publicKey: string | null;
  publicKeySource: 'build' | 'env' | null;
  /** The local license file: <TIMMY_HOME>/pro/license.json */
  licensePath: string;
}

export interface ProBuildDefaults {
  serviceUrl: string;
  publicKey: string;
}

export class ProConfigError extends Error {
  override name = 'ProConfigError';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain http is acceptable only to this machine: the one exception to "license traffic is https". */
export const isLoopbackHttp = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

export function resolveProSettings(
  env: Readonly<Record<string, string | undefined>>,
  timmyHomeDir: string,
  build: ProBuildDefaults = { serviceUrl: BUILD_PRO_SERVICE_URL, publicKey: BUILD_PRO_PUBLIC_KEY },
): ProSettings {
  const envUrl = present(env.TIMMY_PRO_URL);
  const envKey = present(env.TIMMY_PRO_PUBLIC_KEY);
  const buildKey = present(build.publicKey);
  const rawUrl = envUrl ?? present(build.serviceUrl);
  return {
    serviceUrl: rawUrl === null ? null : serviceOrigin(rawUrl),
    publicKey: envKey ?? buildKey,
    publicKeySource: envKey ? 'env' : buildKey ? 'build' : null,
    licensePath: join(timmyHomeDir, 'pro', 'license.json'),
  };
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** License keys travel to this URL, so it must be https (plain http only on this machine) and a bare origin. */
function serviceOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProConfigError(`TIMMY_PRO_URL is not a URL: ${raw}`);
  }
  const secure = url.protocol === 'https:' || isLoopbackHttp(url);
  if (!secure) throw new ProConfigError(`TIMMY_PRO_URL must use https (http is allowed only for localhost): ${raw}`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ProConfigError(`TIMMY_PRO_URL must be a bare origin such as https://pro.example.com: ${raw}`);
  }
  return url.origin;
}
