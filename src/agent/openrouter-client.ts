import { OpenRouterClient } from './openrouter-lean.js';
import type { AgentConfig } from '../types/index.js';
// R10 (H169): one data path for OpenRouter's models (src/models/catalog.ts): its fetch (no key, a timeout, never throws)
import { fetchOpenRouterCatalog } from '../models/catalog.js';

let clientInstance: OpenRouterClient | null = null;

export function getOpenRouterClient(apiKey: string): OpenRouterClient {
  if (!clientInstance || clientInstance === null) {
    // OpenRouter's own server, never OPENROUTER_BASE_URL from the environment (./openrouter-lean.ts)
    clientInstance = new OpenRouterClient({ apiKey });
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

/**
 * R11 (H169, Phase 0 item 1): there is no default model: '' (none). A model is chosen by a person (Models in the Workbench,
 * /model <id> in the REPL, timmy init --chat openrouter --model <id>); nothing picks one from the catalog.
 */
export async function getDefaultModel(): Promise<string> {
  return '';
}

export function resetClient(): void {
  clientInstance = null;
}
