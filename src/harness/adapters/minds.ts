// minds adapter — Animoca Minds Builder CLI; model via builder config/key; not OpenRouter.
export const name = 'minds';
export const canOpenRouter = (): boolean => false;
export const spawnArgs = (_modelId: string): string[] => ['run'];
export const spawnEnv = (): Record<string, string> => (process.env.MINDS_BUILDER_API_KEY ? { MINDS_BUILDER_API_KEY: process.env.MINDS_BUILDER_API_KEY } : {});
export const readConfigModel = (): string | null => 'minds-builder:default';
