/**
 * The model route for images (round R2, look): which OpenRouter models take an image as input, read from
 * OpenRouter's public models list (GET /api/v1/models: data[].id, data[].architecture.input_modalities),
 * and a model's interpretation of one image through chat completions with the image as a data URI.
 *
 * An interpretation is a claim, tier "model interpretation", never a measurement: it records the model
 * that answered and the cost the response reports (unknown, null, when it reports none). A model that
 * does not take images is refused before anything is sent, with the reason and a few that do.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { INTERPRETATION } from './look.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** The models list is read again after this long. */
export const MODEL_LIST_TTL_MS = 60 * 60 * 1000;
/** The largest image sent to a model. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Round R3: the most of a model's answer kept (UTF-8 bytes): a hard cap on the record, not a display size.
 *  A longer answer is cut on a character and flagged (answer_truncated, answer_bytes); a view shortens it. */
export const ANSWER_MAX_BYTES = 64 * 1024;
/** Offered first when they are on the list and take images. */
const PREFERRED = ['anthropic/claude-haiku-4.5', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5'];

interface ListedModel { id: string; input: string[] | null }
let cache: { at: number; models: ListedModel[] } | null = null;

/** Forgets the models list (tests; or to read it again now). */
export function resetImageModelCache(): void { cache = null; }

async function modelList(fetchImpl: typeof fetch, now: number): Promise<{ ok: true; models: ListedModel[] } | { ok: false; error: string }> {
  if (cache && now - cache.at < MODEL_LIST_TTL_MS) return { ok: true, models: cache.models };
  let body: unknown;
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, error: `OpenRouter's models list answered ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: `OpenRouter's models list could not be read (${err instanceof Error ? err.message : 'error'})` };
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { ok: false, error: "OpenRouter's models list had no data" };
  const models: ListedModel[] = [];
  for (const m of data) {
    if (!m || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string') continue;
    const input = (m as { architecture?: { input_modalities?: unknown } }).architecture?.input_modalities;
    models.push({ id: (m as { id: string }).id, input: Array.isArray(input) ? input.filter((x): x is string => typeof x === 'string') : null });
  }
  cache = { at: now, models };
  return { ok: true, models };
}

/** The ids of the models that take images, from OpenRouter's public list (cached for an hour). */
export async function imageInputModels(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const list = await modelList(fetchImpl, now);
  if (!list.ok) return list;
  return { ok: true, models: list.models.filter((m) => m.input?.includes('image')).map((m) => m.id) };
}

export type ImageSupport = { accepts: true } | { accepts: false; reason: string } | { accepts: null; reason: string };

/** Whether a model takes images: yes, no (with why), or unknown (null) when the list cannot be read. */
export async function acceptsImages(modelId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<ImageSupport> {
  const list = await modelList(fetchImpl, now);
  if (!list.ok) return { accepts: null, reason: list.error };
  const m = list.models.find((x) => x.id === modelId);
  if (!m) return { accepts: false, reason: `${modelId} is not in OpenRouter's models list` };
  if (!m.input) return { accepts: null, reason: `OpenRouter's list does not say what ${modelId} takes as input` };
  return m.input.includes('image') ? { accepts: true } : { accepts: false, reason: `${modelId} takes ${m.input.join(', ') || 'no listed input'}, not images` };
}

/** A few image-capable models to offer instead: the preferred ones first, when listed. */
export async function imageAlternatives(fetchImpl: typeof fetch = fetch, n = 4): Promise<string[]> {
  const r = await imageInputModels(fetchImpl);
  if (!r.ok) return [];
  return [...PREFERRED.filter((id) => r.models.includes(id)), ...r.models.filter((id) => !PREFERRED.includes(id))].slice(0, n);
}

/** The image type the first bytes say, among those a chat model takes; HEIC and the rest are not sent. */
export function imageMime(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

function readBounded(path: string, max: number): Buffer | { error: string } {
  let size: number;
  try { size = statSync(path).size; } catch { return { error: 'the image cannot be read' }; }
  if (size > max) return { error: `the image is larger than ${Math.round(max / 1024 / 1024)} MB` };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) { const n = readSync(fd, buf, off, size - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

export interface Interpretation {
  ok: true;
  tier: typeof INTERPRETATION;
  /** the model that answered, as the response names it */
  model: string;
  model_requested: string;
  question: string;
  /** the answer as it came, whole up to ANSWER_MAX_BYTES; past that cut on a character, and flagged below */
  answer: string;
  /** the answer was longer than ANSWER_MAX_BYTES: `answer` is its start, `answer_bytes` its whole length */
  answer_truncated?: true;
  answer_bytes?: number;
  /** what the response reports it cost, in USD; null: not reported, so unknown */
  cost_usd: number | null;
  /** sha256 of the exact bytes the model was sent: the claim is about these bytes */
  image_sha256: string;
  tokens?: number;
}
export interface DescribeFailure {
  ok: false;
  /** refused before anything was sent: nothing can have been charged */
  refused?: true;
  error: string;
  alternatives?: string[];
  /** Round R3: the request went out, so it may have been charged though no answer is kept */
  sent?: true;
  /** with `sent`: what the response reported it cost, in USD; null when it reported none or none came (unknown) */
  cost_usd?: number | null;
  tokens?: number;
  /** the model the response names, when a response came */
  model?: string;
}
export type DescribeResult = Interpretation | DescribeFailure;

const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * What a response's usage says the call cost, in USD; null when it does not say (unknown, never 0).
 * R2 (the Mac run): on the operator's own provider key (BYOK) `cost` is only OpenRouter's fee and the
 * provider's charge is upstream_inference_cost (as src/agent/core.ts counts a turn); missing means unknown.
 */
function reportedCost(usage: unknown): number | null {
  const u = usage && typeof usage === 'object' ? usage as { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } } : undefined;
  if (!u || !money(u.cost)) return null;
  if (u.is_byok !== true) return u.cost;
  const upstream = u.cost_details?.upstream_inference_cost;
  return money(upstream) ? u.cost + upstream : null;
}

/** The answer as the record keeps it: whole up to ANSWER_MAX_BYTES; past that cut on a character boundary, and flagged. */
function keptAnswer(text: string): { answer: string; answer_truncated?: true; answer_bytes?: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= ANSWER_MAX_BYTES) return { answer: text };
  const buf = Buffer.from(text, 'utf8');
  let end = ANSWER_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // buf[end] is the first byte left out: never inside a character
  return { answer: buf.subarray(0, end).toString('utf8'), answer_truncated: true, answer_bytes: bytes };
}

/**
 * A model's interpretation of one image. It spends money: the caller asks first. Refused without a key,
 * for a file that is not a PNG, JPEG, WebP or GIF, and for a model that does not take images.
 */
export async function describeImage(o: { model: string; imagePath: string; question: string; apiKey: string | undefined; fetch?: typeof fetch; maxBytes?: number; timeoutMs?: number }): Promise<DescribeResult> {
  const f = o.fetch ?? fetch;
  if (!o.apiKey) return { ok: false, refused: true, error: 'no OPENROUTER_API_KEY: a model interpretation needs one' };
  const bytes = readBounded(o.imagePath, o.maxBytes ?? MAX_IMAGE_BYTES);
  if (!Buffer.isBuffer(bytes)) return { ok: false, refused: true, error: bytes.error };
  const mime = imageMime(bytes.subarray(0, 16));
  if (!mime) return { ok: false, refused: true, error: 'not a PNG, JPEG, WebP or GIF image, so it is not sent to a model' };
  const support = await acceptsImages(o.model, f);
  if (support.accepts !== true) {
    return { ok: false, refused: true, error: support.accepts === false ? `${o.model} does not take images: ${support.reason}` : `whether ${o.model} takes images is unknown: ${support.reason}`, alternatives: await imageAlternatives(f) };
  }
  const question = o.question.trim() || 'Describe this image.';
  let res: Response;
  let body: Record<string, unknown>;
  try {
    res = await f(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }] }],
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
    const parsed: unknown = await res.json().catch(() => ({}));
    body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (err) {
    // Round R3: the request went out; whether it was charged is unknown, so the cost is null, never 0.
    return { ok: false, sent: true, cost_usd: null, error: `the request did not complete (${err instanceof Error ? err.message : 'error'})` };
  }
  // Round R3: what the response reported it cost is kept with any outcome, an answer or none.
  const usage = body.usage as { total_tokens?: unknown } | undefined;
  const reported = {
    sent: true as const, cost_usd: reportedCost(body.usage),
    ...(typeof usage?.total_tokens === 'number' ? { tokens: usage.total_tokens } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
  };
  if (!res.ok) {
    const msg = (body.error as { message?: unknown } | undefined)?.message;
    return { ok: false, ...reported, error: `OpenRouter answered ${res.status}${typeof msg === 'string' ? `: ${msg.slice(0, 300)}` : ''}` };
  }
  const content = (body.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
  const answer = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('') : '';
  if (!answer) return { ok: false, ...reported, error: 'the model returned no answer' };
  return {
    ok: true, tier: INTERPRETATION, model: typeof body.model === 'string' ? body.model : o.model, model_requested: o.model, question,
    ...keptAnswer(answer), cost_usd: reported.cost_usd,
    image_sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(reported.tokens !== undefined ? { tokens: reported.tokens } : {}),
  };
}
