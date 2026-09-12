import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// pi adapter — pi-crew; model via `--model` (+ `--provider`, default ollama local);
// not OpenRouter-routable (provider enum is local/ollama), so source=harness-config.
export const name = 'pi';
export const canOpenRouter = (): boolean => false;
export const spawnArgs = (modelId: string): string[] => ['--model', modelId];
export const spawnEnv = (): Record<string, string> => ({});
export const readConfigModel = (): string | null => {
  try {
    const p = join(homedir(), '.pi', 'agent', 'settings.json');
    if (existsSync(p)) { const c = JSON.parse(readFileSync(p, 'utf8')); return typeof c.defaultModel === 'string' ? c.defaultModel : null; }
  } catch { /* none */ }
  return 'pi-crew:default';
};
