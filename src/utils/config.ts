import Conf from 'conf';
import { existsSync, readFileSync } from 'fs';
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
  // when it reads the config; saveApiKey() is the one way a key reaches the file.
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
// a file an older version left 0644.
const store = new Conf<TuiConfig>({
  projectName: 'timmy-tui',
  defaults: DEFAULT_CONFIG,
  configFileMode: 0o600,
});

export function loadConfig(): TuiConfig {
  let config = store.store;

  const localPath = resolve(process.cwd(), 'timmy-tui.config.json');
  if (existsSync(localPath)) {
    try {
      const localConfig = JSON.parse(readFileSync(localPath, 'utf-8'));
      config = { ...config, ...localConfig };
    } catch (e) {
      // ignore invalid local config
    }
  }

  if (process.env.OPENROUTER_API_KEY) {
    config.apiKey = process.env.OPENROUTER_API_KEY;
  }
  if (!config.apiKey) {
    // blank-slate-v1k9: `timmy init` keeps provider keys in ~/timmy/providers.json (0600), never in the tree
    try {
      const home = process.env.TIMMY_HOME || join(homedir(), 'timmy');
      const pj = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf-8'));
      if (typeof pj.openrouter_api_key === 'string' && pj.openrouter_api_key) config.apiKey = pj.openrouter_api_key;
    } catch { /* no wizard file */ }
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

/** Saves a model key the user gave on purpose (setup, onboarding) in the settings file, which is 0600. */
export function saveApiKey(apiKey: string): void {
  store.set('apiKey', apiKey);
}

export function getConfig(): Conf<TuiConfig> {
  return store;
}
