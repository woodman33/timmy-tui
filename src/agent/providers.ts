// OpenRouter is primary. The fallback accepts only installed local Ollama
// weights: a localhost endpoint can also advertise cloud-backed models.
import { cloudModelTag, validOllamaModelName } from '../setup/ollama-models.js';

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

function deadline(timeoutMs: number): AbortSignal {
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

// R4 (H103): one rule for each, kept with the chat's model list (src/setup/ollama-models.ts: the setup imports nothing outside
// its folder), the same regular expressions as were here.
function cloudTag(model: string): boolean {
  return cloudModelTag(model);
}

function validModelName(model: string): boolean {
  return validOllamaModelName(model);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Read-only verification; does not load or download model weights. */
export async function assertLocalOllamaModel(
  model: string,
  timeoutMs = 1500,
  options: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<LocalOllamaModelInfo> {
  if (!validModelName(model) || cloudTag(model)) {
    throw new Error('Local Ollama fallback refuses cloud-backed or invalid model tags');
  }
  const ownDeadline = deadline(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, ownDeadline]) : ownDeadline;
  const base = getLocalOllamaBaseUrl(options.baseUrl);
  const response = await fetch(`${base}/api/show`, {
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

/** Only verified local completion models are reported as fallback candidates. */
export async function probeOllama(timeoutMs = 1500): Promise<OllamaProbeResult> {
  let base: string;
  let signal: AbortSignal;
  try { base = getLocalOllamaBaseUrl(); signal = deadline(timeoutMs); } catch (err) {
    return { ok: false, models: [], answer: { state: 'not asked', why: err instanceof Error ? err.message : String(err) } };
  }
  const start = Date.now();
  let response: Response;
  try { response = await fetch(`${base}/api/tags`, { signal, redirect: 'error' }); } catch (err) {
    // R4 (H88; r23): a request fetch refused itself was never sent: said so, never "nothing answered"
    const unsent = notSentWhy(err, signal);
    return { ok: false, models: [], base, answer: unsent ? { state: 'not sent', why: unsent } : { state: 'no answer', why: noAnswerWhy(err, signal, timeoutMs) } };
  }
  const unreadable = (why: string): OllamaProbeResult => ({ ok: false, models: [], base, answer: { state: 'unreadable', why } });
  if (!response.ok) { try { await response.body?.cancel(); } catch { /* nothing to read */ } return unreadable(`HTTP ${response.status}`); }
  let data: Record<string, unknown>;
  try { data = record(await response.json()); } catch (err) {
    return signal.aborted ? { ok: false, models: [], base, answer: { state: 'no answer', why: noAnswerWhy(err, signal, timeoutMs) } } : unreadable('its answer is not JSON');
  }
  if (!Array.isArray(data.models)) return unreadable('its answer has no list of models');
  if (data.models.length > 256) return unreadable(`it lists ${data.models.length} models, more than the 256 Timmy reads`);
  const names = [...new Set(data.models.map(value => record(value).name).filter((name): name is string => typeof name === 'string' && validModelName(name)))];
  const candidates = names.filter((name) => !cloudTag(name));
  const outcomes = await Promise.all(candidates.map(async (model): Promise<'checked' | 'failed' | 'late'> => {
    try {
      await assertLocalOllamaModel(model, timeoutMs, { baseUrl: base, signal });
      return 'checked';
    } catch { return signal.aborted ? 'late' : 'failed'; }
  }));
  const models = candidates.filter((_, i) => outcomes[i] === 'checked');
  const count = (o: string): number => outcomes.filter((x) => x === o).length;
  return {
    ok: models.length > 0, models, latencyMs: Date.now() - start, base,
    answer: { state: 'listed', listed: data.models.length, cloud: names.length - candidates.length, checked: models.length, failed: count('failed'), late: count('late'), deadlineMs: timeoutMs },
  };
}

/** Input should come from probeOllama; completion rechecks metadata before use. */
export function pickOllamaModel(models: string[], preferredPrefixes: string[]): string | null {
  const candidates = models.filter(model => validModelName(model) && !cloudTag(model));
  for (const prefix of preferredPrefixes) {
    const hit = candidates.find(model => model.startsWith(prefix));
    if (hit) return hit;
  }
  return candidates[0] || null;
}

export async function ollamaChatCompletion(
  model: string,
  messages: { role: string; content: string }[],
  timeoutMs = 60_000,
): Promise<string> {
  const signal = deadline(timeoutMs);
  const base = getLocalOllamaBaseUrl();
  await assertLocalOllamaModel(model, Math.min(timeoutMs, 1500), { baseUrl: base, signal });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: 2048 }),
    signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Ollama chat failed: HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}
