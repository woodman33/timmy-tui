// jcode adapter — provider selector `-p/--provider` includes `openrouter`, so it
// CAN be pointed at OpenRouter; otherwise subscription-backed (Claude Max /
// ChatGPT Pro) and receipts record source=harness-config.
export const name = 'jcode';
export const canOpenRouter = (): boolean => true; // jcode -p openrouter
export const spawnArgs = (modelId: string): string[] => ['-p', 'openrouter', 'run'];
export const spawnEnv = (): Record<string, string> => (process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {});
export const readConfigModel = (): string | null => 'subscription:claude-max|chatgpt-pro';
