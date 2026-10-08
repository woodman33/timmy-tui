// Whether a model key is configured, and where: the doctor's REPL line (the operator's 22:23 order). It
// looks where loadConfig() in ./config.ts looks, in the same order, but read only. It never returns or
// prints the key, never writes a file, and never builds the settings store: building it writes the
// settings file, with the environment's key in it, which a read-only check must not do.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDotEnv } from './dotenv.js';

export type KeySource = 'environment' | 'timmy-tui.config.json' | 'settings' | 'providers.json';
type Env = Record<string, string | undefined>;

/** The settings file the store keeps (conf's `timmy-tui` project with its `nodejs` suffix, as env-paths places it). */
export function settingsFile(env: Env = process.env, home: string = homedir(), platform: string = process.platform): string {
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

/** Where the REPL would find its model key, or null when it would find none. */
export function modelKeySource(env: Env = process.env, cwd: string = process.cwd(), home: string = homedir(), platform: string = process.platform): KeySource | null {
  // config.ts first loads the working folder's .env into the environment, never over a variable already set:
  // its TIMMY_HOME and settings folders steer the lookup below as they steer the REPL's.
  const e: Env = { ...env };
  for (const [key, value] of Object.entries(readDotEnv(cwd))) if (e[key] === undefined) e[key] = value;
  // loadConfig: the settings store, then a local timmy-tui.config.json over it, then the environment over both;
  // the providers file `timmy init` writes only when all of those are empty.
  let source: KeySource | null = null;
  const settings = readJson(settingsFile(e, home, platform));
  if (isObject(settings) && typeof settings.apiKey === 'string' && settings.apiKey) source = 'settings';
  const local = readJson(resolve(cwd, 'timmy-tui.config.json'));
  if (isObject(local) && 'apiKey' in local) source = typeof local.apiKey === 'string' && local.apiKey ? 'timmy-tui.config.json' : null;
  if (e.OPENROUTER_API_KEY) source = 'environment';
  if (source) return source;
  const providers = readJson(join(e.TIMMY_HOME || join(home, 'timmy'), 'providers.json'));
  return isObject(providers) && typeof providers.openrouter_api_key === 'string' && providers.openrouter_api_key ? 'providers.json' : null;
}
