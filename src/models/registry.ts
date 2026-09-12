import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readChain } from '../utils/receipts.js';

// CONTROL PLANE (ORDER control-plane-k3e7) — MODEL REGISTRY (data only).
// Extends the /models slimming with architecture, supported_parameters and
// top-provider throughput; src/models/notes.json carries Timmy descriptors
// (role, notes, pinned) + measured throughput; per-model spend is computed
// from the receipt chain. `timmy models --json` consumes this for the picker.
export interface ModelEntry {
  id: string;
  name?: string;
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
export const notesPath = (): string => join(here, 'notes.json');

export function readNotes(): Record<string, { role?: string; notes?: string; pinned?: boolean; throughput_tps?: number }> {
  try { return JSON.parse(readFileSync(notesPath(), 'utf8')); } catch { return {}; }
}

interface ORModel {
  id: string; name?: string; architecture?: ModelEntry['architecture']; supported_parameters?: string[];
  top_provider?: { name?: string; throughput?: number };
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

// FIX 1 (director, close): the registry is populated from the OpenRouter
// catalog and cached WITH a fetched-at timestamp; dashes only for models the
// API doesn't list.
const CACHE_MAX_AGE_MS = 24 * 3600 * 1000;
export function cachePath(): string { return join(here, 'cache.json'); }
export interface ModelCache { fetchedAt: string; models: ORModel[] }
export function readCache(): ModelCache | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), 'utf8')) as ModelCache | ORModel[];
    if (Array.isArray(j)) return { fetchedAt: '1970-01-01T00:00:00.000Z', models: j }; // legacy shape
    if (j && Array.isArray(j.models)) return j;
    return null;
  } catch { return null; }
}

export async function fetchOpenRouterModels(): Promise<ORModel[]> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    if (!r.ok) return [];
    const j = await r.json() as { data?: ORModel[] };
    return j.data ?? [];
  } catch { return []; }
}

export async function refreshModels(): Promise<{ ok: boolean; count: number; fetchedAt: string }> {
  const models = await fetchOpenRouterModels();
  if (!models.length) return { ok: false, count: 0, fetchedAt: readCache()?.fetchedAt ?? '' };
  const fetchedAt = new Date().toISOString();
  writeFileSync(cachePath(), JSON.stringify({ fetchedAt, models }, null, 2));
  return { ok: true, count: models.length, fetchedAt };
}

export function spendByModel(dir?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of readChain('runs', dir)) {
    const r = rec as unknown as Record<string, unknown>;
    const model = String(r.model ?? r.harness_model ?? '');
    const cost = Number(r.cost_usd ?? r.spend_usd ?? 0);
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
      id, name: rm?.name, architecture: rm?.architecture, supported_parameters: rm?.supported_parameters,
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
