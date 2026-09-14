// opencode adapter — model via config file model field / `--model`; OpenRouter-capable.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
export const name = 'opencode';
export const canOpenRouter = (): boolean => Boolean(process.env.OPENROUTER_API_KEY);
export const spawnArgs = (modelId: string): string[] => ['run', '--model', modelId];
export const spawnEnv = (): Record<string, string> => (process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {});
export const readConfigModel = (): string | null => {
  const p = join(homedir(), '.config', 'opencode', 'opencode.json');
  try { if (existsSync(p)) { const c = JSON.parse(readFileSync(p, 'utf8')); return typeof c.model === 'string' ? c.model : null; } } catch { /* none */ }
  return null;
};
