// Whether a model key is configured, and where: the doctor's REPL line (the operator's 22:23 order). It
// looks where loadConfig() in ./config.ts looks, in the same order, but read only. It never returns or
// prints the key, never writes a file, and never builds the settings store: building it writes the
// settings file, with the environment's key in it, which a read-only check must not do.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type KeySource = 'environment' | 'timmy-tui.config.json' | 'settings' | 'providers.json';
type Env = Record<string, string | undefined>;

/** The settings file the store keeps (conf's `timmy-tui` project with its `nodejs` suffix, as env-paths places it). */
export function settingsFile(env: Env = process.env, home: string = homedir(), platform: string = process.platform): string {
  const dir = platform === 'darwin' ? join(home, 'Library', 'Preferences', 'timmy-tui-nodejs')
    : platform === 'win32' ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'timmy-tui-nodejs', 'Config')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'timmy-tui-nodejs');
  return join(dir, 'config.json');
}

const readJson = (file: string): Record<string, unknown> | null => {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null; } catch { return null; }
};
/** OPENROUTER_API_KEY from a `.env` in `cwd`, which ./config.ts loads into the environment when it is unset there. */
function dotEnvKey(cwd: string): string {
  try {
    const file = resolve(cwd, '.env');
    if (!existsSync(file)) return '';
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim().replace(/^export\s+/, '');
      const m = /^OPENROUTER_API_KEY\s*=\s*(.*)$/.exec(line);
      if (m) return m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* unreadable: no key from it */ }
  return '';
}

/** Where the REPL would find its model key, or null when it would find none. */
export function modelKeySource(env: Env = process.env, cwd: string = process.cwd(), home: string = homedir(), platform: string = process.platform): KeySource | null {
  const envKey = env.OPENROUTER_API_KEY !== undefined ? env.OPENROUTER_API_KEY : dotEnvKey(cwd);
  // loadConfig: the settings store, then a local timmy-tui.config.json over it, then the environment over both;
  // the providers file `timmy init` writes only when all of those are empty.
  let source: KeySource | null = null;
  const settings = readJson(settingsFile(env, home, platform));
  if (typeof settings?.apiKey === 'string' && settings.apiKey) source = 'settings';
  const local = readJson(resolve(cwd, 'timmy-tui.config.json'));
  if (local && 'apiKey' in local) source = typeof local.apiKey === 'string' && local.apiKey ? 'timmy-tui.config.json' : null;
  if (envKey) source = 'environment';
  if (source) return source;
  const providers = readJson(join(env.TIMMY_HOME || join(home, 'timmy'), 'providers.json'));
  return typeof providers?.openrouter_api_key === 'string' && providers.openrouter_api_key ? 'providers.json' : null;
}
