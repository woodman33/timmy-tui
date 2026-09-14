// hermes adapter — model via `-m <model> --provider <provider>`; OpenRouter-capable.
export const name = 'hermes';
export const canOpenRouter = (): boolean => true; // hermes routes --provider openrouter
export const spawnArgs = (modelId: string): string[] => ['-m', modelId, '--provider', 'openrouter'];
export const spawnEnv = (): Record<string, string> => (process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {});
export const readConfigModel = (): string | null => null; // resolved at spawn via -m
