import Conf from 'conf';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { readDotEnv } from './dotenv.js';

// Zero-dependency .env loader: the repo ships a .env but nothing ever loaded
// it, so OPENROUTER_API_KEY (and friends) never reached process.env and the
// provider health check died on "API key is missing". Real env vars win.
export function loadEnvFile(dir: string = process.cwd()): void {
  try {
    // The parser lives in ./dotenv.ts, without side effects, so the doctor can read the same variables.
    for (const [key, value] of Object.entries(readDotEnv(dir))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Never crash startup on env parsing
  }
}
loadEnvFile();

export interface TuiConfig {
  apiKey: string;
  model: string;
  theme: 'light' | 'dark' | 'auto';
  graphics: 'auto' | 'kitty' | 'iterm2' | 'companion' | 'ansi';
  modes: string[];
  rive: {
    enabled: boolean;
    fps: number;
    width: number;
    height: number;
  };
  companion: {
    enabled: boolean;
    port: number;
    autoOpen: boolean;
  };
}

const DEFAULT_CONFIG: TuiConfig = {
  // Never the environment's key: the store writes its defaults to the settings file on first use, and
  // a key written there outlives the shell that exported it. loadConfig() applies the environment's key
  // when it reads the config. R4 (H98, journey-2): no key reaches the file now; saveApiKey() keeps it in providers.json.
  apiKey: '',
  model: 'anthropic/claude-opus-4.7',
  theme: 'dark',
  graphics: 'auto',
  modes: ['chat', 'code-review', 'dashboard', 'model-explorer'],
  rive: {
    enabled: true,
    fps: 20,
    width: 400,
    height: 300,
  },
  companion: {
    enabled: true,
    port: 3001,
    autoOpen: true,
  },
};

// The settings file can hold a key saved on purpose, so every write of it is private (0600), also over
// a file an older version left 0644. R4 (H98): TIMMY_SETTINGS_DIR moves its folder (the tests give every file one of its
// own: tests/isolation-setup.ts); without it, conf's own folder for the `timmy-tui` project.
const settingsDir = process.env.TIMMY_SETTINGS_DIR?.trim();
const store = new Conf<TuiConfig>({
  projectName: 'timmy-tui',
  defaults: DEFAULT_CONFIG,
  configFileMode: 0o600,
  ...(settingsDir ? { cwd: resolve(settingsDir) } : {}),
});

/**
 * Narrows the settings file to 0600 if it exists. conf rewrites the file only when its contents change, and
 * under SNAP, or its EXDEV fallback, it writes with fs.writeFileSync, which never narrows a file that exists.
 * The contents are never touched.
 */
function keepPrivate(): void {
  try {
    if (existsSync(store.path)) chmodSync(store.path, 0o600);
  } catch {
    // A file Timmy cannot change (another owner, a read-only folder) stays as it is.
  }
}
keepPrivate();

/** The OpenRouter key `timmy init` and the guided setup keep in <Timmy home>/providers.json (0600), or undefined. */
function providersKey(): string | undefined {
  try {
    const home = process.env.TIMMY_HOME || join(homedir(), 'timmy');
    const pj = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf-8')) as { openrouter_api_key?: unknown };
    return typeof pj.openrouter_api_key === 'string' && pj.openrouter_api_key ? pj.openrouter_api_key : undefined;
  } catch { return undefined; /* no wizard file */ }
}

/**
 * The settings, with the model key in effect. The key: the environment's OPENROUTER_API_KEY, else a timmy-tui.config.json's
 * here, else the one in providers.json (blank-slate-v1k9: `timmy init` keeps it there, 0600, never in the tree), else a key
 * an older version kept in the settings file. R4 (H98, journey-2): providers.json comes before the settings file: the setup
 * writes a key only there (and moves one the settings held), so a new key given to `timmy init` or /setup key is the one
 * used (before, an old key in the settings won and the new one was ignored).
 */
export function loadConfig(): TuiConfig {
  let config = store.store;

  let localKey = false;
  const localPath = resolve(process.cwd(), 'timmy-tui.config.json');
  if (existsSync(localPath)) {
    try {
      const localConfig = JSON.parse(readFileSync(localPath, 'utf-8'));
      config = { ...config, ...localConfig };
      localKey = typeof localConfig?.apiKey === 'string' && localConfig.apiKey !== '';
    } catch (e) {
      // ignore invalid local config
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    config.apiKey = process.env.OPENROUTER_API_KEY;
  } else if (!localKey) {
    const key = providersKey();
    if (key) config.apiKey = key;
  }
  if (process.env.OPENROUTER_MODEL) {
    config.model = process.env.OPENROUTER_MODEL;
  }

  return config;
}

/** Saves settings. Never a model key: a config read back from loadConfig() carries the environment's key. */
export function saveConfig(config: Partial<Omit<TuiConfig, 'apiKey'>>): void {
  const { apiKey: _transient, ...settings } = config as Partial<TuiConfig>;
  store.set(settings);
}

/**
 * Saves a model key the user gave on purpose (the legacy v1 shell's setup panel). R4 (H98, journey-2): in providers.json
 * (0600, in the Timmy home), the one place the setup keeps the key, and no longer in the settings file (a key left there by
 * an older version is removed from it once providers.json holds the new one).
 */
export function saveApiKey(apiKey: string): void {
  const home = process.env.TIMMY_HOME || join(homedir(), 'timmy');
  const file = join(home, 'providers.json');
  let body: Record<string, unknown> = {};
  try { const v = JSON.parse(readFileSync(file, 'utf-8')) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) body = v as Record<string, unknown>; } catch { /* a new file */ }
  mkdirSync(home, { recursive: true });
  if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, `${JSON.stringify({ ...body, openrouter_api_key: apiKey }, null, 1)}\n`, { mode: 0o600 });
  keepPrivate();
  if (store.has('apiKey') && store.get('apiKey')) store.set('apiKey', '');
  keepPrivate();
}

export function getConfig(): Conf<TuiConfig> {
  return store;
}
