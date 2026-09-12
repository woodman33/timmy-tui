import Conf from 'conf';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

// Zero-dependency .env loader: the repo ships a .env but nothing ever loaded
// it, so OPENROUTER_API_KEY (and friends) never reached process.env and the
// provider health check died on "API key is missing". Real env vars win.
export function loadEnvFile(dir: string = process.cwd()): void {
  try {
    const envPath = resolve(dir, '.env');
    if (!existsSync(envPath)) return;
    for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.slice(7).trim();
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
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
  apiKey: process.env.OPENROUTER_API_KEY || '',
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

const store = new Conf<TuiConfig>({
  projectName: 'timmy-tui',
  defaults: DEFAULT_CONFIG,
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

export function saveConfig(config: Partial<TuiConfig>): void {
  store.set(config);
}

export function getConfig(): Conf<TuiConfig> {
  return store;
}
