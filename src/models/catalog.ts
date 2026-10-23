/**
 * R10 (H169; the operator's order of 2026-10-22, 16:01: "RIGHT: OpenRouter/Ollama model selection, descriptions, capabilities
 * and pricing ... OpenRouter defaults to Recently added, with search and Sort/Maker/Capability/Cost/Context controls"): the one
 * model catalog the Models rail draws on every surface (the terminal Workbench's, the companion's). Its rows come from:
 *
 *   openrouter     OpenRouter's public catalog, GET https://openrouter.ai/api/v1/models (no key, no model, no charge). Its
 *                  default answer is the text-output models; `output: 'all'` asks for every output kind (images, speech,
 *                  embeddings ...), kept in a file of its own. The answer is kept in the Timmy home with the time it was
 *                  fetched; a refresh that fails keeps the last good copy (else the snapshot shipped with Timmy), dated.
 *   ollama-local   the Ollama on this computer (a loopback address only, the probe in src/models/ollama-list.ts): the models it lists that
 *                  pass its own /api/show check as local completion weights, with what /api/show says of them, and which
 *                  are loaded now where /api/ps says. A cloud model is never a local row (its name says cloud, or Ollama
 *                  names a remote host for it).
 *   ollama-cloud   Ollama's hosted API (src/models/ollama-list.ts; its chat: src/agent/ollama-cloud.ts): its catalog, remote
 *                  inference, no local weights.
 *
 * What a row says is what its source said, and nothing else: `created` is when OpenRouter ADDED the model (never its release),
 * a price is free only when the catalog's prices are all zero ('unknown' when one is missing or variable, never free), and a
 * capability the catalog does not list is unknown (undefined), never guessed from a name. The maker is the id's prefix (its
 * label the name's "Maker: " prefix): who made the model, never who serves a request.
 *
 * One data path: src/models/registry.ts (the picker's list, `timmy models`), src/agent/openrouter-client.ts and
 * src/agent/model-price.ts read OpenRouter's models through this module's fetch, cache and price rule.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timmyHome } from '../setup/home.js';
// R10 (H169; the lead's note of 2026-10-22): the Ollama lists below both this data module and the agent; nothing of the agent,
// a capability or a surface is imported here (src/agent/model-price.ts reads this module)
import { listLocalOllama, listOllamaCloudModels, ollamaAddressNow, ollamaCloudKey, type OllamaModelFacts } from './ollama-list.js';

export type { OllamaModelFacts };

type Env = Record<string, string | undefined>;

// ── the shared contract (R10 chat checkpoint: H167 and H171 draw from it) ─────────────────────────────────────────────

export type ModelSource = 'openrouter' | 'ollama-local' | 'ollama-cloud';

export interface CatalogRow {
  source: ModelSource;
  /** the id a request names (OpenRouter's "anthropic/claude-haiku-5.5", Ollama's "qwen3:8b") */
  id: string;
  /** the name as the source gives it ("Anthropic: Claude Haiku 5.5") */
  name: string;
  /** who made it, from the id's prefix ("anthropic"); Ollama: the family /api/show reports, else "unknown" */
  maker: string;
  description?: string;
  /** epoch seconds: when OpenRouter ADDED it (not its release date); absent for Ollama */
  created?: number;
  contextLength?: number;
  price: {
    /** USD per million input and output tokens, from the catalog */
    inPerM?: number;
    outPerM?: number;
    /** true only when every price the catalog lists is zero; 'unknown' when one is missing or variable (never free) */
    free: boolean | 'unknown';
    /** R10 (H169): the catalog's other charges that are not zero (web_search, image, request, internal_reasoning ...) */
    other?: string[];
    /** R10 (H169): the catalog gives other prices for some hours or prompt sizes (its overrides): these are the base ones */
    varies?: boolean;
    /** R10 (H169): why the price is unknown, in words */
    why?: string;
  };
  /** undefined: the source does not say (unknown, never false) */
  caps: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  inputModalities?: string[];
  /** Ollama: weights on this computer (local rows: true; cloud rows: false) */
  installed?: boolean;
  /** Ollama Local: loaded now, as /api/ps says (undefined when it did not say) */
  running?: boolean;
  /** Ollama: the weights' bytes as /api/tags reports them (a download's size, not the memory it needs) */
  sizeBytes?: number;
  // R10 (H169): additive fields beyond the contract, for the rail's words
  /** the maker's label, from the name's "Maker: " prefix ("Anthropic"); else the maker */
  makerLabel?: string;
  /** the name without the maker's prefix ("Claude Haiku 5.5") */
  shortName?: string;
  /** OpenRouter: what it answers with (text, image, audio ...) */
  outputModalities?: string[];
  /** OpenRouter: an alias ("~unbiased/pareto-latest") names the model it points at now */
  aliasOf?: string;
  /** Ollama: the parameter size and quantization /api/show reports ("8.2B", "Q4_K_M") */
  parameterSize?: string;
  quantization?: string;
}

export type CatalogSort = 'recent' | 'name' | 'price' | 'context';
export type CatalogCapability = 'tools' | 'vision' | 'reasoning';

export interface CatalogQuery {
  source: ModelSource;
  /** words matched against the name, the id and the maker (each word must match); separate from the filters */
  search?: string;
  /** recent: newest first ("Recently added": when OpenRouter added it); name; price (cheapest first); context (largest first) */
  sort: CatalogSort;
  maker?: string;
  capability?: CatalogCapability;
  /** free: known free; paid: known to cost (an unknown price is neither) */
  cost?: 'free' | 'paid';
  minContext?: number;
  /** R10 (H169): text (the default) keeps the models that answer in text; all keeps every output kind */
  output?: 'text' | 'all';
}

export interface MakerOption { id: string; label: string; count: number }

export interface CatalogResult {
  rows: CatalogRow[];
  /** the source's rows before the search and the filters (the output kind applied): "12 of 468" */
  total: number;
  /** the makers of the source's rows, for the Maker control (label order), with how many rows each has */
  makers: MakerOption[];
}

export interface CatalogLoad {
  rows: CatalogRow[];
  /** live: fetched now; cache: a copy kept before (dated); none: nothing to show */
  from: 'live' | 'cache' | 'none';
  /** when the rows were fetched (ISO), when known */
  fetchedAt?: string;
  /** why the refresh failed, or why there is nothing, in words */
  error?: string;
  /** R10 (H169): whether a request was made (false: the cache was read only) */
  asked?: boolean;
  /** R10 (H169): a cache's kind: the copy this computer fetched, or the snapshot shipped with Timmy */
  cache?: 'fetched' | 'shipped';
}

// ── OpenRouter's catalog: the raw model, its fetch and its cache ──────────────────────────────────────────────────────

/** A model as OpenRouter's /api/v1/models gives it: the fields Timmy reads, every one optional (the API may leave any out). */
export interface OpenRouterCatalogModel {
  id: string;
  name?: string;
  canonical_slug?: string;
  description?: string;
  created?: number;
  context_length?: number;
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[]; tokenizer?: string; input_modality?: string };
  /** USD per token (and per image, request, search ...), as strings; "-1" is a router's variable price */
  pricing?: Record<string, unknown> & { prompt?: string; completion?: string; image?: string; overrides?: unknown };
  top_provider?: { name?: string; context_length?: number; max_completion_tokens?: number; is_moderated?: boolean; throughput?: number };
  supported_parameters?: string[];
  alias_target?: { name?: string; slug?: string } | null;
}

/** OpenRouter's public catalog (no key: a request that names no account and runs no model). */
export const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';
/** How long a fetch of the catalog may take (about 0.8 MB). */
export const CATALOG_TIMEOUT_MS = 20_000;
/** A kept copy younger than this is used without asking again (the same bound `timmy models` keeps). */
export const CATALOG_MAX_AGE_MS = 24 * 3600 * 1000;
/** At most this many models are read from one answer. */
const MAX_MODELS = 5000;

const here = dirname(fileURLToPath(import.meta.url));

/** The snapshot shipped with Timmy, dated by its fetchedAt: what Timmy knows when this computer has fetched no catalog. */
export function cachePath(): string { return join(here, 'cache.json'); }
/**
 * The catalog this computer fetched, kept in the Timmy home (R5 lead: never the shipped snapshot, which may sit in a read-only
 * package folder). `output: 'all'` (every output kind) is kept apart from the default text-output one.
 */
export function catalogPath(env: Env = process.env, output: 'text' | 'all' = 'text'): string {
  return join(timmyHome(env), 'models', output === 'all' ? 'openrouter-catalog-all.json' : 'openrouter-catalog.json');
}

export interface ModelCache { fetchedAt: string; models: OpenRouterCatalogModel[] }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const goodModel = (m: unknown): m is OpenRouterCatalogModel => isObject(m) && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 300;

function readCacheAt(path: string): ModelCache | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (Array.isArray(j)) return { fetchedAt: '1970-01-01T00:00:00.000Z', models: j.filter(goodModel) }; // a legacy shape
    if (isObject(j) && Array.isArray(j.models)) return { fetchedAt: typeof j.fetchedAt === 'string' ? j.fetchedAt : '1970-01-01T00:00:00.000Z', models: j.models.filter(goodModel) };
    return null;
  } catch { return null; }
}

/** The catalog this computer fetched, else the shipped snapshot (text output only), else none. */
export function readCache(env: Env = process.env, output: 'text' | 'all' = 'text'): ModelCache | null {
  return readCatalogCache(env, output)?.cache ?? null;
}

/** The same, saying which copy it is. */
export function readCatalogCache(env: Env = process.env, output: 'text' | 'all' = 'text'): { cache: ModelCache; kind: 'fetched' | 'shipped' } | null {
  const fetched = readCacheAt(catalogPath(env, output));
  if (fetched) return { cache: fetched, kind: 'fetched' };
  if (output === 'all') return null; // the shipped snapshot is the text-output catalog
  const shipped = readCacheAt(cachePath());
  return shipped ? { cache: shipped, kind: 'shipped' } : null;
}

/** Keeps a fetched catalog in the Timmy home, whole or not at all (written beside it, then renamed over it). */
export function writeCatalogCache(cache: ModelCache, env: Env = process.env, output: 'text' | 'all' = 'text'): string {
  const path = catalogPath(env, output);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, path);
  return path;
}

export type CatalogFetch =
  | { ok: true; models: OpenRouterCatalogModel[]; fetchedAt: string }
  | { ok: false; why: string; asked: boolean };

/**
 * GET OpenRouter's public catalog once: no key and no account are sent, and no model is run. `output: 'all'` asks for every
 * output kind (OpenRouter's output_modalities=all); the default answer holds the text-output models. Never throws.
 */
export async function fetchOpenRouterCatalog(o: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; output?: 'text' | 'all'; now?: () => number } = {}): Promise<CatalogFetch> {
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  const url = o.output === 'all' ? `${OPENROUTER_CATALOG_URL}?output_modalities=all` : OPENROUTER_CATALOG_URL;
  let res: Response;
  try {
    res = await f(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
  } catch (err) {
    if (o.signal?.aborted) return { ok: false, why: 'the request was cancelled', asked: true };
    if (timer.aborted) return { ok: false, why: `no answer within ${Math.round(timeoutMs / 1000)} s`, asked: true };
    const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
    const code = typeof cause?.code === 'string' ? cause.code : (err as { code?: unknown } | undefined)?.code;
    return { ok: false, why: typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code) ? `the connection failed (${code})` : 'the request failed (no network?)', asked: true };
  }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to read */ } return { ok: false, why: `OpenRouter answered HTTP ${res.status}`, asked: true }; }
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, why: timer.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} s` : 'its answer is not JSON', asked: true }; }
  const list = isObject(data) ? data.data : undefined;
  if (!Array.isArray(list)) return { ok: false, why: 'its answer has no list of models', asked: true };
  if (list.length > MAX_MODELS) return { ok: false, why: `it lists ${list.length} models, more than the ${MAX_MODELS} Timmy reads`, asked: true };
  const models = list.filter(goodModel);
  if (!models.length) return { ok: false, why: 'its answer lists no model', asked: true };
  return { ok: true, models, fetchedAt: new Date((o.now ?? Date.now)()).toISOString() };
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A catalog price (USD per token, a string) per million tokens; undefined when missing, not a number, or variable ("-1"). */
export function perMillion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined;
}

/** The parts of an OpenRouter price, read once by every reader (the rows, src/agent/model-price.ts). */
export function openRouterPrice(pricing: OpenRouterCatalogModel['pricing']): CatalogRow['price'] {
  const p = isObject(pricing) ? pricing : {};
  const inPerM = perMillion(p.prompt);
  const outPerM = perMillion(p.completion);
  // every listed charge that is not zero: a cache's rate is another price for the same tokens (it keeps a model from being
  // free, and is not named as a charge of its own); the rest (a request, an image, a search, reasoning) are named
  const nonZero = Object.entries(p)
    .filter(([k, v]) => k !== 'prompt' && k !== 'completion' && k !== 'overrides' && (typeof v === 'string' || typeof v === 'number') && Number(v) !== 0)
    .map(([k]) => k).sort();
  const other = nonZero.filter((k) => !/cache/.test(k));
  const varies = Array.isArray(p.overrides) && p.overrides.length > 0;
  const extra = { ...(other.length ? { other } : {}), ...(varies ? { varies: true as const } : {}) };
  if (inPerM === undefined || outPerM === undefined) {
    const variable = Number(p.prompt) < 0 || Number(p.completion) < 0;
    return { ...(inPerM !== undefined ? { inPerM } : {}), ...(outPerM !== undefined ? { outPerM } : {}), free: 'unknown', ...extra,
      why: variable ? 'the catalog gives no fixed price (a router\'s price varies with the model it picks)' : 'the catalog lists no price for it' };
  }
  // a charge that is not zero, or not a fixed number, means it is not free, whatever its token prices
  const otherUnknown = Object.entries(p).some(([k, v]) => k !== 'prompt' && k !== 'completion' && k !== 'overrides' && (typeof v === 'string' || typeof v === 'number') && !(Number(v) >= 0));
  const free = inPerM === 0 && outPerM === 0 && !nonZero.length && !varies;
  if (inPerM === 0 && outPerM === 0 && otherUnknown) return { inPerM, outPerM, free: 'unknown', ...extra, why: 'one of its other charges has no fixed price' };
  return { inPerM, outPerM, free, ...extra };
}

/** "Anthropic: Claude Haiku 5.5" as its maker's label and its own name. */
export function splitName(name: string): { label: string | null; short: string } {
  const m = /^([^:]{1,40}):\s+(.+)$/.exec(name.trim());
  return m ? { label: m[1].trim(), short: m[2].trim() } : { label: null, short: name.trim() };
}

/** The maker of an id: its prefix ("anthropic/…" → anthropic; an alias "~unbiased/…" → unbiased). */
export function makerOf(id: string): string {
  const head = id.includes('/') ? id.split('/')[0] : '';
  return head.replace(/^~/, '').trim().toLowerCase() || 'unknown';
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(CONTROL, ' ').trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** An OpenRouter model as a catalog row: what the catalog says of it, nothing guessed. */
export function openRouterRow(m: OpenRouterCatalogModel): CatalogRow {
  const name = clean(m.name, 200) ?? m.id;
  const split = splitName(name);
  const params = strings(m.supported_parameters);
  const inputs = strings(m.architecture?.input_modalities);
  const outputs = strings(m.architecture?.output_modalities);
  const description = clean(m.description, 4000);
  const created = positive(m.created);
  const contextLength = positive(m.context_length);
  const alias = isObject(m.alias_target) && typeof m.alias_target.slug === 'string' ? clean(m.alias_target.slug, 300) : undefined;
  return {
    source: 'openrouter', id: m.id, name, maker: makerOf(m.id),
    ...(description ? { description } : {}), ...(created ? { created: Math.floor(created) } : {}), ...(contextLength ? { contextLength: Math.floor(contextLength) } : {}),
    price: openRouterPrice(m.pricing),
    caps: {
      ...(params ? { tools: params.includes('tools'), reasoning: params.includes('reasoning') || params.includes('include_reasoning') } : {}),
      ...(inputs ? { vision: inputs.includes('image') } : {}),
    },
    ...(inputs ? { inputModalities: inputs } : {}),
    ...(split.label ? { makerLabel: split.label } : {}), shortName: split.short,
    ...(outputs ? { outputModalities: outputs } : {}), ...(alias ? { aliasOf: alias } : {}),
  };
}

/**
 * An Ollama model as a catalog row. Local: weights on this computer, no charge. Cloud: remote inference, no local weights,
 * its price unknown (Ollama's plans, not a per-token price), so free-only never takes it as free.
 */
export function ollamaRow(m: OllamaModelFacts, source: 'ollama-local' | 'ollama-cloud'): CatalogRow {
  const caps = Array.isArray(m.capabilities) ? m.capabilities : null;
  const family = clean(m.family ?? undefined, 60);
  const description = clean(m.description, 2000);
  return {
    source, id: m.name, name: m.name, maker: family?.toLowerCase() ?? 'unknown', ...(family ? { makerLabel: family } : {}), shortName: m.name,
    ...(description ? { description } : {}),
    ...(positive(m.contextLength) ? { contextLength: Math.floor(m.contextLength as number) } : {}),
    price: source === 'ollama-local'
      ? { inPerM: 0, outPerM: 0, free: true }
      : { free: 'unknown', why: 'Ollama\'s cloud is billed by its plans, not by a price per token this computer knows' },
    caps: caps ? { tools: caps.includes('tools'), vision: caps.includes('vision'), reasoning: caps.includes('thinking') } : {},
    installed: source === 'ollama-local',
    ...(source === 'ollama-local' && typeof m.running === 'boolean' ? { running: m.running } : {}),
    ...(typeof m.sizeBytes === 'number' && Number.isSafeInteger(m.sizeBytes) && m.sizeBytes > 0 ? { sizeBytes: m.sizeBytes } : {}),
    ...(clean(m.parameterSize ?? undefined, 40) ? { parameterSize: clean(m.parameterSize ?? undefined, 40) } : {}),
    ...(clean(m.quantizationLevel ?? undefined, 40) ? { quantization: clean(m.quantizationLevel ?? undefined, 40) } : {}),
  };
}

// ── the query (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a row answers in text: what the rail shows unless every output kind is asked for. */
export const answersInText = (r: CatalogRow): boolean => r.outputModalities === undefined || r.outputModalities.includes('text');

const fold = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const byName = (a: CatalogRow, b: CatalogRow): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
/** Missing values sort last, whatever the direction. */
const last = (a: number | undefined, b: number | undefined, dir: 1 | -1): number => (a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : (a - b) * dir);

const SORTS: Readonly<Record<CatalogSort, (a: CatalogRow, b: CatalogRow) => number>> = {
  recent: (a, b) => last(a.created, b.created, -1) || byName(a, b),
  name: byName,
  price: (a, b) => last(a.price.free === 'unknown' ? undefined : a.price.inPerM, b.price.free === 'unknown' ? undefined : b.price.inPerM, 1)
    || last(a.price.free === 'unknown' ? undefined : a.price.outPerM, b.price.free === 'unknown' ? undefined : b.price.outPerM, 1) || byName(a, b),
  context: (a, b) => last(a.contextLength, b.contextLength, -1) || byName(a, b),
};

/** The makers of these rows, each with its label (the label its rows' names give most often) and its count, in label order. */
export function makersOf(rows: readonly CatalogRow[]): MakerOption[] {
  const by = new Map<string, { count: number; labels: Map<string, number> }>();
  for (const r of rows) {
    const e = by.get(r.maker) ?? { count: 0, labels: new Map<string, number>() };
    e.count++;
    if (r.makerLabel) e.labels.set(r.makerLabel, (e.labels.get(r.makerLabel) ?? 0) + 1);
    by.set(r.maker, e);
  }
  return [...by.entries()].map(([id, e]) => {
    const label = [...e.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? id;
    return { id, label, count: e.count };
  }).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

/**
 * The rows of a source, searched, filtered and sorted (pure: the same rows and query give the same answer). The search
 * matches the name, the id and the maker; the filters are the Maker, Capability, Cost and Context controls; the sort never
 * changes the filters (a query carries all of them, and a sort change is a new sort on the same query: withSort).
 */
export function queryCatalog(rows: readonly CatalogRow[], q: CatalogQuery): CatalogResult {
  const ofSource = rows.filter((r) => r.source === q.source && (q.output === 'all' || answersInText(r)));
  const terms = fold(q.search ?? '').split(/\s+/).filter(Boolean);
  const minContext = typeof q.minContext === 'number' && Number.isFinite(q.minContext) && q.minContext > 0 ? q.minContext : undefined;
  const out = ofSource.filter((r) => {
    if (q.maker && r.maker !== q.maker) return false;
    if (q.capability && r.caps[q.capability] !== true) return false;
    if (q.cost === 'free' && r.price.free !== true) return false;
    if (q.cost === 'paid' && r.price.free !== false) return false;
    if (minContext !== undefined && !(r.contextLength !== undefined && r.contextLength >= minContext)) return false;
    if (terms.length) {
      const hay = fold([r.name, r.id, r.maker, r.makerLabel ?? ''].join(' '));
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  out.sort(SORTS[q.sort] ?? SORTS.recent);
  return { rows: out, total: ofSource.length, makers: makersOf(ofSource) };
}

/** A sort change: the same query with another sort, every filter and the search kept. */
export const withSort = (q: CatalogQuery, sort: CatalogSort): CatalogQuery => ({ ...q, sort });

/** The query the rail opens with for a source: OpenRouter's "Recently added", no filter. */
export const defaultQuery = (source: ModelSource): CatalogQuery => ({ source, sort: source === 'openrouter' ? 'recent' : 'name' });

/** Whether a query has a filter or a search set (the rail's Clear filters). */
export const filtered = (q: CatalogQuery): boolean => Boolean(q.search?.trim() || q.maker || q.capability || q.cost || q.minContext);

/** The same query without its search and filters (Clear filters keeps the source, the sort and the output kind). */
export const clearFilters = (q: CatalogQuery): CatalogQuery => ({ source: q.source, sort: q.sort, ...(q.output ? { output: q.output } : {}) });

/** The sort's label as the rail says it. */
export const SORT_LABEL: Readonly<Record<CatalogSort, string>> = { recent: 'Recently added', name: 'Name', price: 'Price (lowest first)', context: 'Context (largest first)' };

// ── words for the rail ───────────────────────────────────────────────────────────────────────────────────────────────

/** Dollars as the rail shows them: $0 for zero, two figures under a cent, cents otherwise. */
export const money = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(2)}` : `$${Number(n.toFixed(2))}`);
/** A context window in words: "262k", "1.05M". */
export const contextWords = (n: number): string => (n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M` : `${Math.round(n / 1000)}k`);
/** Bytes as a person reads them (a download's size). */
export const bytesWords = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${n} bytes`);

/** A row's price in words: "free", "$0.15 in / $0.60 out per 1M tokens", "price unknown", with what else it charges. */
export function priceWords(r: Pick<CatalogRow, 'price' | 'source'>): string {
  const p = r.price;
  if (r.source === 'ollama-local') return 'no charge (local)';
  const base = p.free === true ? 'free'
    : p.inPerM !== undefined && p.outPerM !== undefined && p.free === false ? `${money(p.inPerM)} in / ${money(p.outPerM)} out per 1M tokens`
      : `price unknown${p.why ? ` (${p.why})` : ''}`;
  const other = p.other?.length ? `; also charges ${p.other.map((k) => k.replace(/_/g, ' ')).join(', ')}` : '';
  return `${base}${p.varies ? '; other prices at some hours or prompt sizes' : ''}${other}`;
}

/** A row's capabilities in words, each said or unknown: "tools · vision · reasoning", "no tools", "tools unknown". */
export function capsWords(r: Pick<CatalogRow, 'caps'>): string {
  const one = (k: CatalogCapability, word: string): string => (r.caps[k] === true ? word : r.caps[k] === false ? `no ${word}` : `${word} unknown`);
  return [one('tools', 'tools'), one('vision', 'vision'), one('reasoning', 'reasoning')].join(' · ');
}

/** When OpenRouter added it, as a date (never the model's release). */
export const addedWords = (r: Pick<CatalogRow, 'created'>): string | null => (r.created ? `added to OpenRouter ${new Date(r.created * 1000).toISOString().slice(0, 10)}` : null);

// ── loading ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CatalogCtx {
  env?: Env;
  /** the network; a test passes a FAKE (one that fails when called shows nothing was asked) */
  fetch?: typeof fetch;
  /** never: the kept copy only; if-stale (the default): ask when the copy is older than maxAgeMs; always: ask now */
  refresh?: 'never' | 'if-stale' | 'always';
  maxAgeMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** OpenRouter: every output kind, kept apart (the default: text output) */
  output?: 'text' | 'all';
  /** Ollama Local: the address asked (default: the one the chat asks: src/capabilities/ollama-route.ts) */
  ollamaHost?: string;
  /** Ollama Cloud: the key (H170's store); never logged, never put in a URL */
  ollamaCloudKey?: () => string | null | Promise<string | null>;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const shortAt = (at: string): string => at.replace('T', ' ').slice(0, 16);

/** OpenRouter's rows: fetched now, else the last good copy (dated), else none. The selected model is never touched here. */
async function loadOpenRouter(ctx: CatalogCtx): Promise<CatalogLoad> {
  const env = ctx.env ?? process.env;
  const output = ctx.output ?? 'text';
  const now = (ctx.now ?? Date.now)();
  const kept = readCatalogCache(env, output);
  const rowsOf = (c: ModelCache): CatalogRow[] => c.models.map(openRouterRow);
  const keptLoad = (error?: string, asked = false): CatalogLoad => (kept
    ? { rows: rowsOf(kept.cache), from: 'cache', fetchedAt: kept.cache.fetchedAt, cache: kept.kind, asked, ...(error ? { error } : {}) }
    : { rows: [], from: 'none', asked, error: error ?? 'no catalog is kept on this computer yet' });
  const refresh = ctx.refresh ?? 'if-stale';
  if (refresh === 'never') return keptLoad();
  const age = kept && kept.kind === 'fetched' ? now - Date.parse(kept.cache.fetchedAt) : Number.POSITIVE_INFINITY;
  if (refresh === 'if-stale' && Number.isFinite(age) && age >= 0 && age < (ctx.maxAgeMs ?? CATALOG_MAX_AGE_MS)) return keptLoad();
  const got = await fetchOpenRouterCatalog({ fetch: ctx.fetch, timeoutMs: ctx.timeoutMs, signal: ctx.signal, output, now: () => now });
  if (!got.ok) {
    const keptWords = kept ? `; showing the copy ${kept.kind === 'shipped' ? 'shipped with Timmy' : 'fetched'} ${shortAt(kept.cache.fetchedAt)}` : '';
    return keptLoad(`the catalog could not be fetched: ${got.why}${keptWords}`, got.asked);
  }
  const cache: ModelCache = { fetchedAt: got.fetchedAt, models: got.models };
  try { writeCatalogCache(cache, env, output); } catch (err) {
    return { rows: rowsOf(cache), from: 'live', fetchedAt: got.fetchedAt, asked: true, error: `fetched, but not kept for next time (${(err as NodeJS.ErrnoException).code ?? 'write failed'})` };
  }
  return { rows: rowsOf(cache), from: 'live', fetchedAt: got.fetchedAt, asked: true };
}

/** The local Ollama's rows (src/models/ollama-list.ts listLocalOllama): live when it answered, none (with why) when not. */
async function loadOllamaLocal(ctx: CatalogCtx): Promise<CatalogLoad> {
  const env = ctx.env ?? process.env;
  const host = ctx.ollamaHost ?? ollamaAddressNow(env);
  const listing = await listLocalOllama({ baseUrl: host, timeoutMs: ctx.timeoutMs ?? 3000, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
  const at = iso((ctx.now ?? Date.now)());
  if (!listing.answered) return { rows: [], from: 'none', asked: listing.asked, error: listing.why };
  return { rows: listing.models.map((m) => ollamaRow(m, 'ollama-local')), from: 'live', fetchedAt: at, asked: true, ...(listing.why ? { error: listing.why } : {}) };
}

/** Ollama Cloud's rows (its hosted list, with the key): none until a key is set up; nothing is kept (read when asked). */
async function loadOllamaCloud(ctx: CatalogCtx): Promise<CatalogLoad> {
  const env = ctx.env ?? process.env;
  const key = ctx.ollamaCloudKey ? await ctx.ollamaCloudKey() : ollamaCloudKey(env);
  if (!key) return { rows: [], from: 'none', asked: false, error: 'Ollama Cloud is not set up: no key (an Ollama account\'s key, from ollama.com/settings/keys)' };
  if (ctx.refresh === 'never') return { rows: [], from: 'none', asked: false, error: 'Ollama Cloud\'s list is read when asked (it keeps no copy here)' };
  const got = await listOllamaCloudModels({ key, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
  if (!got.ok) return { rows: [], from: 'none', asked: got.sent, error: `Ollama Cloud's list could not be read: ${got.why}` };
  return { rows: got.models.map((m) => ollamaRow(m, 'ollama-cloud')), from: 'live', fetchedAt: iso((ctx.now ?? Date.now)()), asked: true };
}

/**
 * A source's rows: OpenRouter's catalog (fetched when the kept copy is stale, kept when the fetch fails), the local Ollama's
 * models, or Ollama's cloud catalog (with the key the setup keeps). Never throws; never changes the chat's model.
 */
export async function loadCatalog(source: ModelSource, ctx: CatalogCtx = {}): Promise<CatalogLoad> {
  try {
    if (source === 'openrouter') return await loadOpenRouter(ctx);
    if (source === 'ollama-local') return await loadOllamaLocal(ctx);
    return await loadOllamaCloud(ctx);
  } catch (err) {
    return { rows: [], from: 'none', asked: false, error: `the catalog could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
