// Whether a model key is configured, and where: the doctor's REPL line (the operator's 22:23 order). It
// looks where loadConfig() in ./config.ts looks, in the same order, but read only. It never returns or
// prints the key, never writes a file, and never builds the settings store: building it writes the
// settings file, with the environment's key in it, which a read-only check must not do.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDotEnv } from './dotenv.js';

export type KeySource = 'environment' | 'timmy-tui.config.json' | 'settings' | 'providers.json';
type Env = Record<string, string | undefined>;

/**
 * The settings file the store keeps (conf's `timmy-tui` project with its `nodejs` suffix, as env-paths places it). R4 (H98):
 * TIMMY_SETTINGS_DIR moves its folder, as it moves the store's (src/utils/config.ts).
 */
export function settingsFile(env: Env = process.env, home: string = homedir(), platform: string = process.platform): string {
  if (env.TIMMY_SETTINGS_DIR?.trim()) return join(resolve(env.TIMMY_SETTINGS_DIR.trim()), 'config.json');
  const dir = platform === 'darwin' ? join(home, 'Library', 'Preferences', 'timmy-tui-nodejs')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'timmy-tui-nodejs', 'Config')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'timmy-tui-nodejs');
  return join(dir, 'config.json');
}

const readJson = (file: string): unknown => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined; } catch { return undefined; }
};
/** A JSON object: not a primitive, an array or null, which loadConfig's spread ignores (the review of row 99). */
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Where the REPL would find its model key, and the key, or null (the one lookup both functions below make). */
function keyLookup(env: Env, cwd: string, home: string, platform: string): { source: KeySource; key: string } | null {
  // config.ts first loads the working folder's .env into the environment, never over a variable already set:
  // its TIMMY_HOME and settings folders steer the lookup below as they steer the REPL's.
  const e: Env = { ...env };
  for (const [key, value] of Object.entries(readDotEnv(cwd))) if (e[key] === undefined) e[key] = value;
  // loadConfig: the environment; else a local timmy-tui.config.json's key; else the providers file `timmy init` writes;
  // else the settings store's (R4 H98, journey-2: providers.json before the settings: the setup keeps the key there).
  if (e.OPENROUTER_API_KEY) return { source: 'environment', key: e.OPENROUTER_API_KEY };
  const local = readJson(resolve(cwd, 'timmy-tui.config.json'));
  if (isObject(local) && typeof local.apiKey === 'string' && local.apiKey) return { source: 'timmy-tui.config.json', key: local.apiKey };
  const providers = readJson(join(e.TIMMY_HOME || join(home, 'timmy'), 'providers.json'));
  if (isObject(providers) && typeof providers.openrouter_api_key === 'string' && providers.openrouter_api_key) return { source: 'providers.json', key: providers.openrouter_api_key };
  // a local file that sets the key to nothing hides the settings' key, as its spread does in loadConfig
  if (isObject(local) && 'apiKey' in local) return null;
  const settings = readJson(settingsFile(e, home, platform));
  return isObject(settings) && typeof settings.apiKey === 'string' && settings.apiKey ? { source: 'settings', key: settings.apiKey } : null;
}

/** Where the REPL would find its model key, or null when it would find none. */
export function modelKeySource(env: Env = process.env, cwd: string = process.cwd(), home: string = homedir(), platform: string = process.platform): KeySource | null {
  return keyLookup(env, cwd, home, platform)?.source ?? null;
}

/**
 * R5 lead (the operator's 22:32 order, item 1): which key the REPL would use, as a fingerprint that is not the key: "key "
 * and the first 12 hex digits of its sha256, or null when there is none. An observation of the key (a check that OpenRouter
 * took or refused it) names this, so a key changed since (timmy init --openrouter -) is not said refused or live for it.
 */
export function modelKeyFingerprint(env: Env = process.env, cwd: string = process.cwd(), home: string = homedir(), platform: string = process.platform): string | null {
  const k = keyLookup(env, cwd, home, platform);
  return k ? `key ${createHash('sha256').update(k.key).digest('hex').slice(0, 12)}` : null;
}
