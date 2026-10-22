import { OpenRouter } from '@openrouter/sdk';
import type { AgentConfig } from '../types/index.js';
// R10 (H169): one data path for OpenRouter's models (src/models/catalog.ts): its fetch (no key, a timeout, never throws)
import { fetchOpenRouterCatalog } from '../models/catalog.js';

let clientInstance: OpenRouter | null = null;

export function getOpenRouterClient(apiKey: string): OpenRouter {
  if (!clientInstance || clientInstance === null) {
    clientInstance = new OpenRouter({ apiKey });
  }
  return clientInstance;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    image?: string;
  };
  top_provider?: {
    is_moderated: boolean;
    context_length?: number;
    max_completion_tokens?: number;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  created?: number;
}

let modelCache: OpenRouterModel[] = [];
let modelCacheTimestamp = 0;
const CACHE_TTL = 60_000;

export async function fetchModels(force = false): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (!force && modelCache.length > 0 && now - modelCacheTimestamp < CACHE_TTL) {
    return modelCache;
  }
  // a failed fetch keeps what this process had (as before); the catalog's own copy is src/models/catalog.ts loadCatalog's
  const got = await fetchOpenRouterCatalog();
  if (!got.ok) return modelCache;
  modelCache = got.models as OpenRouterModel[];
  modelCacheTimestamp = now;
  return modelCache;
}

export async function findModels(filter: {
  author?: string;
  minContext?: number;
  maxPromptPrice?: number;
  limit?: number;
}): Promise<OpenRouterModel[]> {
  const models = await fetchModels();
  let results = models.filter((m) => {
    if (filter.author && !m.id.startsWith(filter.author + '/')) return false;
    if (filter.minContext && m.context_length < filter.minContext) return false;
    if (filter.maxPromptPrice) {
      const price = parseFloat(m.pricing.prompt);
      if (price > filter.maxPromptPrice) return false;
    }
    return true;
  });
  if (filter.limit) results = results.slice(0, filter.limit);
  return results;
}

export async function getDefaultModel(): Promise<string> {
  try {
    const models = await fetchModels();
    const claude = models.find(m => m.id.includes('claude-opus'));
    if (claude) return claude.id;
    return 'anthropic/claude-opus-4.7';
  } catch {
    return 'anthropic/claude-opus-4.7';
  }
}

export function resetClient(): void {
  clientInstance = null;
}
