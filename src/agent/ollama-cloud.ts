/**
 * R10 (H169; the operator's order of 2026-10-22: "Support ... Ollama Cloud"): Ollama's hosted API as a route of its own, apart
 * from the local one (src/agent/providers.ts and src/agent/local-chat.ts keep a loopback address only, and refuse cloud
 * models). Direct: https://ollama.com/api with the person's key as a Bearer token (Ollama's documentation, docs.ollama.com/cloud
 * and /api/authentication): no local install, no local server and no weights on this computer. Everything it does is remote
 * inference, labelled cloud on every surface, and excluded by local-only (src/agent/route-policy.ts).
 *
 * The key: the one the setup keeps (H170's store, src/setup/), read through `ollamaCloudKey` below until that store lands,
 * else OLLAMA_API_KEY (the variable Ollama's own clients read). It is sent to ollama.com only, in the Authorization header:
 * never in a URL, a log, a prompt, a receipt or a page. Nothing here runs without the person's own step: a catalog read is a
 * list of models (no inference); a chat is a turn they sent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timmyHome } from '../setup/home.js';
import { ollamaRow, type CatalogCtx, type CatalogLoad, type OllamaModelFacts } from '../models/catalog.js';

type Env = Record<string, string | undefined>;

/** Ollama's hosted API (its documented base). */
export const OLLAMA_CLOUD_BASE = 'https://ollama.com';

/**
 * The Ollama Cloud key, or null: OLLAMA_API_KEY in the environment, else the Timmy home's providers.json `ollama_api_key`
 * (0600, beside the OpenRouter key; the field H170's store writes is switched here at the merge). Never logged or shown.
 */
export function ollamaCloudKey(env: Env = process.env): string | null {
  const fromEnv = env.OLLAMA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const file = join(timmyHome(env), 'providers.json');
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const k = j && typeof j === 'object' ? j.ollama_api_key : undefined;
    return typeof k === 'string' && k.trim() ? k.trim() : null;
  } catch { return null; }
}

/** Where the key was found, in words (never the key). */
export function ollamaCloudKeyFrom(env: Env = process.env): 'OLLAMA_API_KEY' | 'providers.json' | null {
  if (env.OLLAMA_API_KEY?.trim()) return 'OLLAMA_API_KEY';
  return ollamaCloudKey(env) ? 'providers.json' : null;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** A request to Ollama's cloud failed: what, why, and whether it ever left this computer. */
export class OllamaCloudError extends Error {
  readonly route = 'ollama-cloud' as const;
  constructor(what: string, reason: string, next: string, readonly sent: boolean, readonly status?: number) {
    super(`${what}\nReason: ${reason}\nNext: ${next}`);
    this.name = 'OllamaCloudError';
  }
}

/** A fetch's failure in words, and whether a connection was even made (no address, refused: never sent). */
function failed(err: unknown, timedOut: boolean, timeoutMs: number): { why: string; sent: boolean } {
  if (timedOut) return { why: `no answer within ${Math.round(timeoutMs / 1000)} s`, sent: true };
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : (err as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code)) {
    return { why: `the connection failed (${code})`, sent: !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(code) };
  }
  return { why: 'the request failed (no network?)', sent: false };
}

/**
 * The cloud's model list: GET <base>/api/tags with the key (a list of models; no inference, no charge). `base` is
 * https://ollama.com; a test gives a FAKE server's address on 127.0.0.1.
 */
export async function listOllamaCloudModels(o: { key: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; base?: string }): Promise<{ ok: true; models: OllamaModelFacts[] } | { ok: false; why: string; status?: number; sent: boolean }> {
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  let res: Response;
  try {
    res = await f(`${(o.base ?? OLLAMA_CLOUD_BASE).replace(/\/+$/, '')}/api/tags`, { headers: { Authorization: `Bearer ${o.key}`, Accept: 'application/json' }, signal, redirect: 'error' });
  } catch (err) {
    const w = failed(err, timer.aborted, timeoutMs);
    return { ok: false, why: w.why, sent: w.sent };
  }
  if (res.status === 401 || res.status === 403) { try { await res.body?.cancel(); } catch { /* none */ } return { ok: false, why: `Ollama refused the key (HTTP ${res.status})`, status: res.status, sent: true }; }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* none */ } return { ok: false, why: `Ollama answered HTTP ${res.status}`, status: res.status, sent: true }; }
  let data: Record<string, unknown>;
  try { data = obj(await res.json()); } catch { return { ok: false, why: 'its answer is not JSON', sent: true }; }
  if (!Array.isArray(data.models)) return { ok: false, why: 'its answer has no list of models', sent: true };
  const seen = new Set<string>();
  const models: OllamaModelFacts[] = [];
  for (const item of data.models.slice(0, 1000)) {
    const m = obj(item);
    const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '';
    if (!name || name.length > 300 || CONTROL.test(name) || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const d = obj(m.details);
    const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : null);
    models.push({ name, family: word(d.family), parameterSize: word(d.parameter_size), quantizationLevel: word(d.quantization_level), sizeBytes: null, capabilities: null });
  }
  return { ok: true, models };
}

/** The Models rail's Ollama Cloud rows (src/models/catalog.ts loadCatalog('ollama-cloud')): none until a key is set up. */
export async function loadOllamaCloudCatalog(ctx: CatalogCtx): Promise<CatalogLoad> {
  const env = ctx.env ?? process.env;
  const key = ctx.ollamaCloudKey ? await ctx.ollamaCloudKey() : ollamaCloudKey(env);
  if (!key) return { rows: [], from: 'none', asked: false, error: 'Ollama Cloud is not set up: no key (an Ollama account\'s key, from ollama.com/settings/keys)' };
  if (ctx.refresh === 'never') return { rows: [], from: 'none', asked: false, error: 'Ollama Cloud\'s list is read when asked (it keeps no copy here)' };
  const got = await listOllamaCloudModels({ key, ...(ctx.fetch ? { fetch: ctx.fetch } : {}), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
  if (!got.ok) return { rows: [], from: 'none', asked: got.sent, error: `Ollama Cloud's list could not be read: ${got.why}` };
  return { rows: got.models.map((m) => ollamaRow(m, 'ollama-cloud')), from: 'live', fetchedAt: new Date((ctx.now ?? Date.now)()).toISOString(), asked: true };
}
