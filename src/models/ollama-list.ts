/**
 * R10 (H169; the lead's note of 2026-10-22, 17:2x: "the catalog should not import the agent core ... move what it needs below
 * both"): what an Ollama lists, read below both the Models rail's catalog (src/models/catalog.ts) and the agent
 * (src/agent/providers.ts, which re-exports the probe from here, unchanged). It imports node and src/setup only (no agent,
 * capability or workbench module), so the catalog, a data module that src/agent/model-price.ts reads, pulls nothing else in.
 *
 *   probeOllama / assertLocalOllamaModel   the probe every surface used (moved here from src/agent/providers.ts as it was):
 *                                          a loopback address only; each local model's /api/show check (local completion
 *                                          weights, never a cloud model)
 *   listLocalOllama                        the probe's models with their /api/show and /api/tags facts, and /api/ps's running
 *   listOllamaCloudModels                  Ollama's hosted list (https://ollama.com/api/tags, the key in the header only)
 *   ollamaCloudKey                         the key for it, from the setup's key store (src/setup/provider-keys.ts keyInUse)
 *   ollamaAddressNow                       the address the chat asks (src/capabilities/ollama-route.ts ollamaAddress's rule)
 *
 * Read only: nothing is loaded, downloaded or run.
 */
import { cloudModelTag, ollamaAt, validOllamaModelName } from '../setup/ollama-models.js';
import { keyInUse } from '../setup/provider-keys.js';
import { knownAnswers, OLLAMA_DEFAULT, readSetupState } from '../setup/questions.js';

type Env = Record<string, string | undefined>;

export interface OllamaProbeResult {
  ok: boolean;
  models: string[];
  latencyMs?: number;
  /**
   * R4 (H82; the review of 6fb765a..4338fdb, finding 2): the address asked and what came back, told apart. `ok: false`
   * alone lumped together no answer, an answer that is not Ollama's, only cloud models, and models whose /api/show check
   * did not finish within the probe's time: the /tools row said "not installed" while Ollama answered (r22).
   */
  base?: string;
  answer?: OllamaAnswer;
}

/** What GET /api/tags (and each local model's /api/show) gave. */
export type OllamaAnswer =
  /** nothing was asked: the address (OLLAMA_HOST) is not one the probe may ask, or its time is not a valid one */
  | { state: 'not asked'; why: string }
  /** nothing answered within the probe's time, or the connection was refused */
  | { state: 'no answer'; why: string }
  /**
   * R4 (H88; the Mac run r23): the request never left this computer: Node's fetch refused it itself, before any connection
   * (`why`: its own words, such as "bad port" for OLLAMA_HOST=127.0.0.1:9, a port fetch never asks). Nothing was asked, so
   * nothing can have answered.
   */
  | { state: 'not sent'; why: string }
  /** something answered, and its answer is not Ollama's list of models (an HTTP error, another body, too long a list) */
  | { state: 'unreadable'; why: string }
  /**
   * Ollama listed `listed` models: `cloud` of them cloud models (never used as local ones); of the local ones, `checked`
   * passed the /api/show check, `failed` did not (its answer did not establish local completion weights), and `late` were
   * not checked within `deadlineMs`, the probe's one deadline for the list and every check.
   */
  | { state: 'listed'; listed: number; cloud: number; checked: number; failed: number; late: number; deadlineMs: number };

export interface LocalOllamaModelInfo {
  name: string;
  capabilities: string[];
  contextLength: number | null;
  format: string;
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
}

/** What Timmy reads of one Ollama model for the Models rail (src/models/catalog.ts ollamaRow): its /api/show facts and size. */
export interface OllamaModelFacts {
  name: string;
  capabilities?: string[] | null;
  contextLength?: number | null;
  family?: string | null;
  parameterSize?: string | null;
  quantizationLevel?: string | null;
  sizeBytes?: number | null;
  running?: boolean | null;
  description?: string;
}

/** A probe's one deadline (1 ms to 120 s). */
export function ollamaDeadline(timeoutMs: number): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Ollama timeout must be an integer from 1 to 120000 milliseconds');
  }
  return AbortSignal.timeout(timeoutMs);
}

/** Resolve a local client endpoint without permitting credentials or redirects. R4 (H82): 127.0.0.1 by default, the address
 *  Ollama listens on (localhost may be tried as ::1 first). */
export function getLocalOllamaBaseUrl(base?: string): string {
  const configured = base ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const url = new URL(configured.includes('://') ? configured : `http://${configured}`);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Local Ollama requires a loopback HTTP(S) origin without credentials, path or query');
  }
  return url.origin;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Read-only verification; does not load or download model weights. */
export async function assertLocalOllamaModel(
  model: string,
  timeoutMs = 1500,
  options: { baseUrl?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<LocalOllamaModelInfo> {
  if (!validOllamaModelName(model) || cloudModelTag(model)) {
    throw new Error('Local Ollama fallback refuses cloud-backed or invalid model tags');
  }
  const ownDeadline = ollamaDeadline(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, ownDeadline]) : ownDeadline;
  const base = getLocalOllamaBaseUrl(options.baseUrl);
  // R10 (H169): the request's own fetch when a caller gives one (the catalog's tests: a FAKE), else the global one
  const response = await (options.fetch ?? fetch)(`${base}/api/show`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }), signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Ollama model verification failed: HTTP ${response.status}`);
  const data = record(await response.json());
  if ((data.remote_host !== undefined && data.remote_host !== null && data.remote_host !== '') ||
      (data.remote_model !== undefined && data.remote_model !== null && data.remote_model !== '')) {
    throw new Error('Local Ollama fallback refuses cloud-backed model metadata');
  }
  const details = record(data.details);
  const format = details.format;
  const capabilities = Array.isArray(data.capabilities)
    ? data.capabilities.filter((value): value is string => typeof value === 'string') : [];
  if ((format !== 'gguf' && format !== 'safetensors') || !capabilities.includes('completion')) {
    throw new Error('Ollama model metadata does not establish installed local completion weights');
  }
  const contextLengths = Object.entries(record(data.model_info))
    .filter(([key, value]) => key.endsWith('.context_length') && Number.isSafeInteger(value) && Number(value) > 0)
    .map(([, value]) => Number(value));
  const stringField = (key: string) => typeof details[key] === 'string' ? details[key] as string : null;
  return {
    name: model, capabilities, format,
    contextLength: contextLengths.length ? Math.min(...contextLengths) : null,
    family: stringField('family'), parameterSize: stringField('parameter_size'),
    quantizationLevel: stringField('quantization_level'),
  };
}

/** Why a request got no answer, in a few words: its time ran out, or the error's own code (ECONNREFUSED). */
function noAnswerWhy(err: unknown, signal: AbortSignal, timeoutMs: number): string {
  if (signal.aborted) return `no answer within ${timeoutMs / 1000} s`;
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z_]{3,40}$/.test(code) ? `the connection failed (${code})` : 'the request failed';
}

/**
 * R4 (H88; r23): why a request that failed never left this computer, or undefined when it may have: fetch's own refusal has a
 * cause with no error code and no system call (undici's "bad port"); a connection that was tried has both (ECONNREFUSED).
 */
function notSentWhy(err: unknown, signal: AbortSignal): string | undefined {
  if (signal.aborted) return undefined;
  const cause = (err as { cause?: { code?: unknown; syscall?: unknown; message?: unknown } } | undefined)?.cause;
  if (!cause || typeof cause !== 'object' || cause.code !== undefined || cause.syscall !== undefined) return undefined;
  const said = typeof cause.message === 'string' ? cause.message.trim().slice(0, 120) : '';
  return said ? `Node's fetch refused it before it left this computer (${said})` : undefined;
}

/** What /api/tags said of one model (its bytes and details), kept beside its /api/show check. */
interface TagFacts { size: number | null; family: string | null; parameterSize: string | null; quantization: string | null }

/** The probe, with what each local model's /api/show check returned (R10, H169: the catalog's local rows read it). */
async function probeCore(timeoutMs: number, baseUrl: string | undefined, f: typeof fetch, outer?: AbortSignal): Promise<{ result: OllamaProbeResult; infos: LocalOllamaModelInfo[]; tags: Map<string, TagFacts> }> {
  const none = { infos: [] as LocalOllamaModelInfo[], tags: new Map<string, TagFacts>() };
  let base: string;
  let signal: AbortSignal;
  try { base = getLocalOllamaBaseUrl(baseUrl); signal = ollamaDeadline(timeoutMs); } catch (err) {
    return { result: { ok: false, models: [], answer: { state: 'not asked', why: err instanceof Error ? err.message : String(err) } }, ...none };
  }
  if (outer) signal = AbortSignal.any([outer, signal]);
  const start = Date.now();
  let response: Response;
  try { response = await f(`${base}/api/tags`, { signal, redirect: 'error' }); } catch (err) {
    // R4 (H88; r23): a request fetch refused itself was never sent: said so, never "nothing answered"
    const unsent = notSentWhy(err, signal);
    return { result: { ok: false, models: [], base, answer: unsent ? { state: 'not sent', why: unsent } : { state: 'no answer', why: noAnswerWhy(err, signal, timeoutMs) } }, ...none };
  }
  const unreadable = (why: string) => ({ result: { ok: false, models: [], base, answer: { state: 'unreadable' as const, why } }, ...none });
  if (!response.ok) { try { await response.body?.cancel(); } catch { /* nothing to read */ } return unreadable(`HTTP ${response.status}`); }
  let data: Record<string, unknown>;
  try { data = record(await response.json()); } catch (err) {
    return signal.aborted ? { result: { ok: false, models: [], base, answer: { state: 'no answer', why: noAnswerWhy(err, signal, timeoutMs) } }, ...none } : unreadable('its answer is not JSON');
  }
  if (!Array.isArray(data.models)) return unreadable('its answer has no list of models');
  if (data.models.length > 256) return unreadable(`it lists ${data.models.length} models, more than the 256 Timmy reads`);
  const tags = new Map<string, TagFacts>();
  const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : null);
  for (const value of data.models) {
    const m = record(value);
    if (typeof m.name !== 'string' || !validOllamaModelName(m.name) || tags.has(m.name)) continue;
    const d = record(m.details);
    tags.set(m.name, { size: typeof m.size === 'number' && Number.isSafeInteger(m.size) && m.size >= 0 ? m.size : null, family: word(d.family), parameterSize: word(d.parameter_size), quantization: word(d.quantization_level) });
  }
  const names = [...tags.keys()];
  const candidates = names.filter((name) => !cloudModelTag(name));
  const infos: Array<LocalOllamaModelInfo | null> = [];
  const outcomes = await Promise.all(candidates.map(async (model, i): Promise<'checked' | 'failed' | 'late'> => {
    try {
      infos[i] = await assertLocalOllamaModel(model, timeoutMs, { baseUrl: base, signal, fetch: f });
      return 'checked';
    } catch { infos[i] = null; return signal.aborted ? 'late' : 'failed'; }
  }));
  const models = candidates.filter((_, i) => outcomes[i] === 'checked');
  const count = (o: string): number => outcomes.filter((x) => x === o).length;
  return {
    result: {
      ok: models.length > 0, models, latencyMs: Date.now() - start, base,
      answer: { state: 'listed', listed: data.models.length, cloud: names.length - candidates.length, checked: models.length, failed: count('failed'), late: count('late'), deadlineMs: timeoutMs },
    },
    infos: candidates.map((_, i) => (outcomes[i] === 'checked' ? infos[i] : null)).filter((x): x is LocalOllamaModelInfo => x !== null),
    tags,
  };
}

/** Only verified local completion models are reported as fallback candidates. */
/** `baseUrl`: the address to ask (R5 lead: the one the local chat asks, as `timmy workspace check` does); absent, OLLAMA_HOST or
 *  127.0.0.1:11434. Only a loopback address is asked (getLocalOllamaBaseUrl), another is said "not asked" with why. */
export async function probeOllama(timeoutMs = 1500, baseUrl?: string): Promise<OllamaProbeResult> {
  return (await probeCore(timeoutMs, baseUrl, fetch)).result;
}

/** What the Models rail's Ollama Local rows come from (src/models/catalog.ts loadCatalog('ollama-local')). */
export interface LocalOllamaListing {
  /** Ollama answered with its list of models (an empty list included) */
  answered: boolean;
  /** a request was made (false: the address is not one the probe asks, or fetch refused it before it left) */
  asked: boolean;
  base?: string;
  answer?: OllamaAnswer;
  /** the local models that passed /api/show's check, with their facts; never a cloud model */
  models: OllamaModelFacts[];
  /**
   * R11 Phase 2 (H169, item c): the ":cloud" names Ollama lists: models that run on Ollama's servers under the person's Ollama
   * account, reached through this Ollama (no /api/show is asked of them; what /api/tags says of each). Never in `models`.
   */
  cloud: OllamaModelFacts[];
  /** why there is no list, or what was left out of it, in words */
  why?: string;
}

/**
 * R10 (H169): the local Ollama's models for the Models rail: the probe's (a loopback address only; each model's /api/show
 * check, never a cloud model), with what /api/show and /api/tags say of each, and whether it is loaded now where /api/ps says
 * (an Ollama that does not answer /api/ps leaves it unknown). Read only: nothing is loaded and nothing is downloaded.
 */
export async function listLocalOllama(o: { baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<LocalOllamaListing> {
  const f = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 3000;
  const { result, infos, tags } = await probeCore(timeoutMs, o.baseUrl, f, o.signal);
  const a = result.answer;
  if (!a || a.state !== 'listed') {
    const why = !a ? 'Ollama was not asked'
      : a.state === 'not asked' ? `Ollama was not asked: ${a.why}`
        : a.state === 'not sent' ? `the request to Ollama was not sent: ${a.why}`
          : a.state === 'no answer' ? `Ollama at ${result.base ?? 'its address'} did not answer (${a.why})`
            : `something answered at ${result.base ?? 'its address'}, but not as Ollama (${a.why})`;
    return { answered: false, asked: a?.state === 'no answer' || a?.state === 'unreadable', ...(result.base ? { base: result.base } : {}), ...(a ? { answer: a } : {}), models: [], cloud: [], why };
  }
  // which models are loaded now (GET /api/ps): unknown when Ollama does not say
  let running: Set<string> | null = null;
  try {
    const limit = ollamaDeadline(Math.min(timeoutMs, 1500));
    const res = await f(`${result.base}/api/ps`, { signal: o.signal ? AbortSignal.any([o.signal, limit]) : limit, redirect: 'error' });
    if (res.ok) {
      const data = record(await res.json());
      if (Array.isArray(data.models)) {
        running = new Set(data.models.flatMap((m) => [record(m).name, record(m).model]).filter((n): n is string => typeof n === 'string'));
      }
    } else { try { await res.body?.cancel(); } catch { /* nothing to read */ } }
  } catch { running = null; }
  const models: OllamaModelFacts[] = infos.map((info) => {
    const t = tags.get(info.name);
    return {
      name: info.name, capabilities: info.capabilities, contextLength: info.contextLength, family: info.family ?? t?.family ?? null,
      parameterSize: info.parameterSize ?? t?.parameterSize ?? null, quantizationLevel: info.quantizationLevel ?? t?.quantization ?? null,
      sizeBytes: t?.size ?? null, running: running ? running.has(info.name) : null,
    };
  });
  const cloud: OllamaModelFacts[] = [...tags.entries()].filter(([name]) => cloudModelTag(name)).map(([name, t]) => ({
    name, capabilities: null, contextLength: null, family: t.family, parameterSize: t.parameterSize, quantizationLevel: t.quantization, sizeBytes: t.size, running: null,
  }));
  const left = [a.cloud ? `${a.cloud} cloud ${a.cloud === 1 ? 'model is' : 'models are'} not local` : '', a.failed ? `${a.failed} did not pass Ollama's /api/show check as local weights` : '', a.late ? `${a.late} not checked within ${a.deadlineMs / 1000} s` : ''].filter(Boolean);
  return { answered: true, asked: true, base: result.base, answer: a, models, cloud, ...(left.length ? { why: `Ollama lists ${a.listed}: ${left.join('; ')}` } : {}) };
}

/**
 * The Ollama address the chat asks: the chat setup's record when the chat is set to the local model, else OLLAMA_HOST (or
 * OLLAMA_BASE_URL), else Ollama's default. The same rule as src/capabilities/ollama-route.ts ollamaAddress (a test keeps the
 * two equal), read from the setup's files directly so that this module needs no chat-route module.
 */
export function ollamaAddressNow(env: Env = process.env): string {
  try {
    const s = readSetupState(env);
    if (knownAnswers(s).chat === 'local') {
      const at = ollamaAt(s.providers.ollama ?? s.recorded?.answers.ollama ?? OLLAMA_DEFAULT);
      if (!('error' in at)) return at.origin;
    }
  } catch { /* the setup's record not readable: the address below */ }
  const raw = env.OLLAMA_HOST || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  return String(raw).replace(/\/+$/, '');
}

// ── Ollama's cloud (its hosted API) ──────────────────────────────────────────────────────────────────────────────────

/** Ollama's hosted API (its documented base: docs.ollama.com/cloud). */
export const OLLAMA_CLOUD_BASE = 'https://ollama.com';

/**
 * The Ollama Cloud key, or null: the setup's key store reads it (H170's src/setup/provider-keys.ts keyInUse('ollama-cloud')):
 * OLLAMA_API_KEY in the environment (the variable Ollama's own clients read) first, else the Timmy home's providers.json
 * `ollama_cloud_api_key` (0600, beside the OpenRouter key), where the setup saves the key a person pastes. Never logged,
 * shown, or put in a URL.
 */
export function ollamaCloudKey(env: Env = process.env): string | null {
  try { return keyInUse('ollama-cloud', env)?.key ?? null; } catch { return null; }
}

/** Where the key was found, in words (never the key). */
export function ollamaCloudKeyFrom(env: Env = process.env): 'OLLAMA_API_KEY' | 'providers.json' | null {
  const k = (() => { try { return keyInUse('ollama-cloud', env); } catch { return null; } })();
  return k ? (k.from === 'environment' ? 'OLLAMA_API_KEY' : 'providers.json') : null;
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** A fetch's failure in words, and whether a connection was even made (no address, refused: never sent). */
export function cloudFailure(err: unknown, timedOut: boolean, timeoutMs: number): { why: string; sent: boolean } {
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
 * https://ollama.com; a test gives a FAKE fetch.
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
    const w = cloudFailure(err, timer.aborted, timeoutMs);
    return { ok: false, why: w.why, sent: w.sent };
  }
  if (res.status === 401 || res.status === 403) { try { await res.body?.cancel(); } catch { /* none */ } return { ok: false, why: `Ollama refused the key (HTTP ${res.status})`, status: res.status, sent: true }; }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* none */ } return { ok: false, why: `Ollama answered HTTP ${res.status}`, status: res.status, sent: true }; }
  let data: Record<string, unknown>;
  try { data = record(await res.json()); } catch { return { ok: false, why: 'its answer is not JSON', sent: true }; }
  if (!Array.isArray(data.models)) return { ok: false, why: 'its answer has no list of models', sent: true };
  const seen = new Set<string>();
  const models: OllamaModelFacts[] = [];
  for (const item of data.models.slice(0, 1000)) {
    const m = record(item);
    const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '';
    if (!name || name.length > 300 || CONTROL.test(name) || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const d = record(m.details);
    const word = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : null);
    models.push({ name, family: word(d.family), parameterSize: word(d.parameter_size), quantizationLevel: word(d.quantization_level), sizeBytes: null, capabilities: null });
  }
  return { ok: true, models };
}
