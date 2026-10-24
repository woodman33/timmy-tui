/**
 * R5 lead (the completion order, Onboarding, Home and Chat): what a chat model costs and can do, as far as this computer
 * knows, and the free-only policy. "Expose model selection and capability/cost information; offer local Ollama and
 * free-only routing explicitly. Unknown pricing must not silently pass a free-only policy."
 *
 * The price comes from OpenRouter's catalog (src/models/registry.ts: the one this computer fetched with `timmy models
 * --refresh`, else the snapshot shipped with Timmy), named with its date; a model the catalog does not list is unknown,
 * never free. OpenRouter's free variants end in `:free`, and the name alone is taken as free only when the catalog does
 * not say otherwise (then it says so). Reads files only: no request to anything.
 *
 * Free-only (off by default): TIMMY_CHAT_FREE_ONLY=1 or 0 in the environment, else the settings' `freeOnly` (the REPL's
 * `/model free-only on|off` keeps it). When on, a message to a model not known to be free is not sent, on every surface
 * that reads the one chat route (src/agent/chat-route.ts chatRouteNow).
 */
import { readFileSync } from 'node:fs';
import { readCache, type ModelCache } from '../models/registry.js';
// R10 (H169): the catalog's one price rule (src/models/catalog.ts openRouterPrice): free only when every price it lists is zero
import { contextWords, money as moneyWords, openRouterPrice } from '../models/catalog.js';
import { settingsFile } from '../utils/model-key.js';

type Env = Record<string, string | undefined>;

export interface ModelPrice {
  id: string;
  /** true: free by the catalog (or by its :free name, the catalog silent); false: costs; null: unknown */
  free: boolean | null;
  /** USD per million tokens, from the catalog */
  inPerM?: number;
  outPerM?: number;
  /** the context window in tokens */
  ctx?: number;
  /** whether the catalog lists tool calling among its parameters (null: the catalog does not list the model) */
  tools: boolean | null;
  from: 'catalog' | 'name' | 'none';
  /** the catalog's date (YYYY-MM-DD), or null with no catalog */
  catalogAt: string | null;
  /** one line: "free (OpenRouter catalog of 2026-09-07) · 128k context · tools" */
  words: string;
}

const money = moneyWords;
const ctxWords = contextWords;

/** What this computer knows of a model's price and abilities. */
export function modelPrice(id: string, cache: ModelCache | null = safeCache()): ModelPrice {
  const at = cache?.fetchedAt ? cache.fetchedAt.slice(0, 10) : null;
  const of = at ? `OpenRouter catalog of ${at}` : 'no catalog on this computer';
  const m = cache?.models.find((x) => x.id === id);
  if (m) {
    // R10 (H169): OpenRouter's "-1" (a router's variable price) and a missing price are unknown; a model whose token prices
    // are zero and that charges for something else (a request, an image, a search) is not free (src/models/catalog.ts)
    const p = openRouterPrice(m.pricing);
    const inPerM = p.inPerM;
    const outPerM = p.outPerM;
    const known = inPerM !== undefined && outPerM !== undefined && p.free !== 'unknown';
    const free = p.free === 'unknown' ? null : p.free;
    const tools = Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null;
    const price = free === true ? 'free' : known ? `${money(inPerM!)} in / ${money(outPerM!)} out per 1M tokens` : 'price unknown (the catalog gives no fixed price)';
    const extra = [m.context_length ? `${ctxWords(m.context_length)} context` : null, tools === true ? 'tools' : tools === false ? 'no tools' : null].filter(Boolean);
    return { id, free, ...(inPerM !== undefined ? { inPerM } : {}), ...(outPerM !== undefined ? { outPerM } : {}), ...(m.context_length ? { ctx: m.context_length } : {}), tools, from: 'catalog', catalogAt: at, words: `${price} (${of})${extra.length ? ` · ${extra.join(' · ')}` : ''}` };
  }
  const unlisted = at ? `the ${of} does not list it` : 'this computer has no catalog to look in';
  if (id.endsWith(':free')) {
    return { id, free: true, tools: null, from: 'name', catalogAt: at, words: `free by its :free name; ${unlisted} (timmy models --refresh)` };
  }
  return { id, free: null, tools: null, from: 'none', catalogAt: at, words: `price unknown: ${unlisted} (timmy models --refresh)` };
}

/** The catalog's free models (both prices 0), by id. */
export function freeModels(cache: ModelCache | null = safeCache()): Array<{ id: string; ctx?: number; tools: boolean | null }> {
  return (cache?.models ?? [])
    .filter((m) => openRouterPrice(m.pricing).free === true)
    .map((m) => ({ id: m.id, ...(m.context_length ? { ctx: m.context_length } : {}), tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function safeCache(): ModelCache | null { try { return readCache(); } catch { return null; } }

/** Whether free-only is on: TIMMY_CHAT_FREE_ONLY (1/true/on or 0/false/off) wins, else the settings' freeOnly, else off. */
export function freeOnlyOn(env: Env = process.env): boolean {
  const v = env.TIMMY_CHAT_FREE_ONLY?.trim().toLowerCase();
  if (v) return ['1', 'true', 'on', 'yes'].includes(v);
  try {
    const s = JSON.parse(readFileSync(settingsFile(env), 'utf8')) as { freeOnly?: unknown };
    return s?.freeOnly === true;
  } catch { return false; }
}

/**
 * Under free-only, why a message to `model` is not sent, or null when it may go. Unknown is refused, never passed.
 * `away`: a surface other than the REPL, whose fix is a command any terminal runs.
 */
export function freeOnlyRefusal(model: string | null, price: ModelPrice | null, away = false): string[] | null {
  if (model && price?.free === true) return null;
  const why = !model ? 'no model is named for this surface, so its price cannot be known'
    : price?.free === false ? `${model} costs ${price.words.split(' (')[0]}` : `${model}: ${price?.words ?? 'price unknown'}`;
  return [
    `Error: free-only is on, and ${model ?? 'this chat'} is not known to be free, so this message was not sent.`,
    `Cause: ${why}.`,
    away ? 'Try: choose a free model: /model free in the REPL lists them, then /model <id>:free (free-only stays on)'
      : 'Try: /model free (lists the free models this computer knows), then /model <id>:free (free-only stays on)',
    'Nothing was sent to any model.',
  ];
}
