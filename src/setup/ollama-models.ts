/**
 * R4 (H103): what an Ollama server lists, for the setup's chat question (./chat-question.ts) and the REPL's /model
 * (src/agent/chat-route.ts). GET /api/tags only: read-only, nothing is loaded and nothing is downloaded. Each model is
 * labelled local weights or cloud-backed (its name says cloud, or Ollama names a remote host or model for it: Ollama then
 * sends what it is given to another computer), and the server's own address is told apart: this computer (a loopback
 * address) or another one. Node only, and nothing outside src/setup: the setup runs before anything else is resolved
 * (./home.ts; tests/init-package-paths.test.ts compiles only this folder beside init).
 */

export const OLLAMA_DEFAULT_ORIGIN = 'http://127.0.0.1:11434';

/**
 * A model name that says it is a cloud model (":cloud", "-cloud", "/cloud" and the like): Timmy's one rule for it, used by
 * src/agent/providers.ts too (its fallback refuses such names as local ones).
 */
export const cloudModelTag = (model: string): boolean => /(?:^|[:/_-])cloud(?:$|[:/_-])/i.test(model);

/** A model name Timmy reads (one word, 512 characters at most, no control characters): src/agent/providers.ts's rule too. */
export const validOllamaModelName = (model: string): boolean =>
  typeof model === 'string' && model.length > 0 && model.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(model);

/** Where an Ollama server is: its origin, its host as the words show it, and whether it is this computer. */
export interface OllamaAt {
  origin: string;
  host: string;
  /** a loopback address (127.0.0.1, localhost, ::1): this computer */
  loopback: boolean;
}

const CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

/** The address as the setup recorded it (a host, or a URL), checked: http(s), no user name, password, path or query. */
export function ollamaAt(raw?: string | null): OllamaAt | { error: string } {
  const v = (raw ?? '').trim() || OLLAMA_DEFAULT_ORIGIN;
  if (CONTROL.test(v) || v.length > 300) return { error: 'the address has control characters, or is too long' };
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`); } catch { return { error: `${v} is not an address` }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `${url.protocol} is not http or https` };
  if (url.username || url.password) return { error: 'an address with a user name or a password is not used' };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return { error: 'an address with a path or a query is not used (Ollama answers at its root)' };
  const name = url.hostname;
  const loopback = name === 'localhost' || name === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(name);
  return { origin: url.origin, host: url.host, loopback };
}

/** One model Ollama lists. */
export interface ListedModel {
  name: string;
  /** cloud-backed: Ollama sends what it is given to another computer (its name says cloud, or Ollama names a remote host or model) */
  cloud: boolean;
  /** the bytes Ollama reports for it; null when it reports none */
  size: number | null;
  parameterSize: string | null;
  quantization: string | null;
}

export type ModelList =
  | { ok: true; at: OllamaAt; models: ListedModel[] }
  | { ok: false; at?: OllamaAt; state: 'not asked' | 'no answer' | 'not sent' | 'unreadable'; why: string };

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 80 && !CONTROL.test(v) ? v.trim() : null);
const named = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** Why a request got no answer, in words, and whether it ever left this computer (fetch refuses some ports itself). */
export function failure(err: unknown, timedOut: boolean, timeoutMs: number): { state: 'no answer' | 'not sent'; why: string } {
  if (timedOut) return { state: 'no answer', why: `no answer within ${timeoutMs / 1000} s` };
  const cause = (err as { cause?: { code?: unknown; syscall?: unknown; message?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : (err as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code)) return { state: 'no answer', why: `the connection failed (${code})` };
  if (cause && typeof cause === 'object' && cause.code === undefined && cause.syscall === undefined && typeof cause.message === 'string' && cause.message.trim()) {
    return { state: 'not sent', why: `Node's fetch refused it before it left this computer (${cause.message.trim().slice(0, 120)})` };
  }
  return { state: 'no answer', why: 'the request failed' };
}

/** A response body, read up to `limit` bytes (a longer one is refused, not cut). */
export async function boundedText(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel().catch(() => undefined); throw new Error(`its answer is longer than ${limit} bytes`); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** GET /api/tags at the address given (the setup's, else 127.0.0.1:11434): the models, each labelled; never more than 256. */
export async function listOllamaModels(raw?: string | null, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ModelList> {
  const at = ollamaAt(raw);
  if ('error' in at) return { ok: false, state: 'not asked', why: at.error };
  const timeoutMs = o.timeoutMs ?? 3000;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
  let res: Response;
  try {
    res = await fetch(`${at.origin}/api/tags`, { signal, redirect: 'error' });
  } catch (err) {
    return { ok: false, at, ...failure(err, timer.aborted, timeoutMs) };
  }
  let body: string;
  try { body = await boundedText(res, 2 * 1024 * 1024); } catch (err) {
    if (timer.aborted) return { ok: false, at, state: 'no answer', why: `no answer within ${timeoutMs / 1000} s` };
    return { ok: false, at, state: 'unreadable', why: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, at, state: 'unreadable', why: `HTTP ${res.status}` };
  let data: Record<string, unknown>;
  try { data = obj(JSON.parse(body)); } catch { return { ok: false, at, state: 'unreadable', why: 'its answer is not JSON' }; }
  if (!Array.isArray(data.models)) return { ok: false, at, state: 'unreadable', why: 'its answer has no list of models' };
  if (data.models.length > 256) return { ok: false, at, state: 'unreadable', why: `it lists ${data.models.length} models, more than the 256 Timmy reads` };
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const item of data.models) {
    const m = obj(item);
    const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '';
    if (!validOllamaModelName(name) || CONTROL.test(name) || seen.has(name)) continue;
    seen.add(name);
    const details = obj(m.details);
    const size = typeof m.size === 'number' && Number.isSafeInteger(m.size) && m.size >= 0 ? m.size : null;
    models.push({
      name, cloud: cloudModelTag(name) || named(m.remote_host) || named(m.remote_model),
      size, parameterSize: word(details.parameter_size), quantization: word(details.quantization_level),
    });
  }
  return { ok: true, at, models };
}

/** "Ollama at 127.0.0.1:11434", and for another computer's address, that it is not this one. */
export const atWords = (at: OllamaAt): string => (at.loopback ? `Ollama at ${at.host}` : `Ollama at ${at.host} (not this computer)`);

/** Bytes as a person reads them. */
export function sizeWords(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${bytes} bytes`;
}

/** What one listed model is, in words: local weights (where they run) with their size, or cloud-backed. */
export function modelFacts(m: ListedModel, at: OllamaAt): string {
  if (m.cloud) return 'cloud-backed: Ollama sends the chat off this computer';
  const where = at.loopback ? 'local weights' : `weights on ${at.host}, not this computer`;
  return [where, m.parameterSize, m.quantization, sizeWords(m.size)].filter(Boolean).join(' · ');
}

/** Why there is no list, in words. */
export function listProblem(list: Extract<ModelList, { ok: false }>, raw?: string | null): string {
  const where = list.at ? atWords(list.at) : `Ollama (${(raw ?? '').trim() || OLLAMA_DEFAULT_ORIGIN})`;
  switch (list.state) {
    case 'not asked': return `${where} was not asked: ${list.why}`;
    case 'not sent': return `the request to ${where} was not sent: ${list.why}`;
    case 'no answer': return `${where} did not answer (${list.why})`;
    case 'unreadable': return `something answered for ${where}, but not as Ollama (${list.why})`;
  }
}

/** How a person gets a model: Timmy never downloads one. */
export const PULL_WORDS = 'Timmy downloads nothing: install one yourself with ollama pull <model>.';
