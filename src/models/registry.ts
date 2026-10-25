import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readChain, measuredCostUsd } from '../utils/receipts.js';
// R10 (H169): one data path for OpenRouter's models: the catalog's raw model, its fetch and its kept copies (src/models/catalog.ts)
import { cachePath, catalogPath, fetchOpenRouterCatalog, homePinned, readCache, writeCatalogCache, type ModelCache, type OpenRouterCatalogModel } from './catalog.js';

export { cachePath, catalogPath, readCache, type ModelCache };

// CONTROL PLANE (ORDER control-plane-k3e7) — MODEL REGISTRY (data only).
// Extends the /models slimming with architecture, supported_parameters and
// top-provider throughput; src/models/notes.json carries Timmy descriptors
// (role, notes, pinned) + measured throughput; per-model spend is computed
// from the receipt chain. `timmy models --json` consumes this for the picker.
export interface ModelEntry {
  id: string;
  name?: string;
  /** R10 (H169): the catalog's description of it (undefined = the catalog does not list it, or says none) */
  description?: string;
  /** R10 (H169): when OpenRouter added it (epoch seconds; not its release date) */
  created?: number;
  architecture?: { modality?: string; input_modality?: string; tokenizer?: string };
  supported_parameters?: string[];
  /** context window in tokens from the OpenRouter catalog (undefined = unlisted) */
  ctx?: number;
  /** USD per token from the OpenRouter catalog (undefined = unlisted) */
  price_in?: number;
  price_out?: number;
  top_provider?: { name?: string; throughput_tps?: number | null };
  role?: string;
  notes?: string;
  pinned?: boolean;
  spend_usd?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The model notes the LIBRARY picker reads and writes (role, notes, pinned). TIMMY_MODEL_NOTES names
 * another file, as TIMMY_POLICY_DIR moves the policy: a test points it at a temporary copy, so the
 * picker's pin and note never write this file in the repo (fourth order, step 4).
 */
export const notesPath = (): string => process.env.TIMMY_MODEL_NOTES || join(here, 'notes.json');

export function readNotes(): Record<string, { role?: string; notes?: string; pinned?: boolean; throughput_tps?: number }> {
  try { return JSON.parse(readFileSync(notesPath(), 'utf8')); } catch { return {}; }
}

type ORModel = OpenRouterCatalogModel;

// FIX 1 (director, close): the registry is populated from the OpenRouter
// catalog and cached WITH a fetched-at timestamp; dashes only for models the
// API doesn't list. R10 (H169): the catalog's own fetch and kept copies (src/models/catalog.ts): the Timmy home's
// openrouter-catalog.json (`timmy models --refresh` and the Models rail keep it), else the snapshot shipped with Timmy.
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;

/** OpenRouter's public catalog (no key), or [] when it could not be fetched. */
export async function fetchOpenRouterModels(): Promise<ORModel[]> {
  const got = await fetchOpenRouterCatalog();
  return got.ok ? got.models : [];
}

export async function refreshModels(): Promise<{ ok: boolean; count: number; fetchedAt: string }> {
  // R10 (H169): the Timmy home resolved before the request, so the catalog is kept where the call was made (catalog.ts homePinned)
  const env = homePinned();
  const got = await fetchOpenRouterCatalog();
  if (!got.ok) return { ok: false, count: 0, fetchedAt: readCache(env)?.fetchedAt ?? '' };
  writeCatalogCache({ fetchedAt: got.fetchedAt, models: got.models }, env);
  return { ok: true, count: got.models.length, fetchedAt: got.fetchedAt };
}

export function spendByModel(dir?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of readChain('runs', dir)) {
    const r = rec as unknown as Record<string, unknown>;
    // evidence-rule accounting: declared-unknown receipts (cost_measured:false)
    // carry a placeholder cost and are EXCLUDED here — their cost is unknown,
    // so there is nothing measurable to attribute to a model (they contribute
    // 0 via measuredCostUsd and are dropped by the !cost guard below).
    const model = String(r.model ?? r.harness_model ?? '');
    const costField = typeof rec.cost_usd === 'number' ? rec.cost_usd : (r.spend_usd as number | undefined);
    const cost = measuredCostUsd({ cost_usd: costField, cost_measured: rec.cost_measured });
    if (!model || !cost) continue;
    out[model] = (out[model] ?? 0) + cost;
  }
  return out;
}

export function listModelsSync(dir?: string): ModelEntry[] {
  const notes = readNotes();
  const spend = spendByModel(dir);
  let remote: ORModel[] = [];
  try { const c = readCache(); if (c) remote = c.models; } catch { /* no cache */ }
  const ids = new Set<string>([...Object.keys(notes), ...remote.map(m => m.id)]);
  const entries: ModelEntry[] = [];
  for (const id of ids) {
    const rm = remote.find(m => m.id === id);
    const n = notes[id] ?? {};
    entries.push({
      id, name: rm?.name, ...(typeof rm?.description === 'string' && rm.description ? { description: rm.description } : {}),
      ...(typeof rm?.created === 'number' && rm.created > 0 ? { created: rm.created } : {}),
      architecture: rm?.architecture, supported_parameters: rm?.supported_parameters,
      ctx: rm?.context_length,
      price_in: rm?.pricing?.prompt !== undefined ? Number(rm.pricing.prompt) : undefined,
      price_out: rm?.pricing?.completion !== undefined ? Number(rm.pricing.completion) : undefined,
      top_provider: { name: rm?.top_provider?.name, throughput_tps: n.throughput_tps ?? rm?.top_provider?.throughput ?? null },
      role: n.role, notes: n.notes, pinned: n.pinned, spend_usd: spend[id] ?? 0,
    });
  }
  return entries.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || a.id.localeCompare(b.id));
}

export async function listModels(dir?: string): Promise<ModelEntry[]> {
  // fresh cache wins; stale/missing cache triggers a catalog refresh first
  const c = readCache();
  if (!c || Date.now() - new Date(c.fetchedAt).getTime() > CACHE_MAX_AGE_MS) await refreshModels();
  return listModelsSync(dir);
}
