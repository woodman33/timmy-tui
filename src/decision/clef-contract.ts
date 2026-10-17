/**
 * Round R4 (lead): Cloudflare Clef-Omni's request and answer, exactly as its official sources describe them, checked
 * without a call.
 *
 * Sources, read on 2026-10-15 (no model call, no weight download):
 *   - the Workers AI model page developers.cloudflare.com/workers-ai/models/clef-omni/, with its raw schemas
 *     schema-input.json and schema-output.json;
 *   - the Hugging Face model card Cloudflare/clef-omni (Apache-2.0), which says a Jev/SystemOne `POST /v1/systemone`
 *     request body gets the same response body from a self-hosted deployment.
 * The hosted model is `@cf/cloudflare/clef-omni`; a request's own `model` field is "clef-omni".
 *
 * What the model does: it reads a state and a schema of typed questions and returns a probability for every allowed
 * option of every question. Timmy uses it only to score options Timmy built from its own capabilities and policy. It
 * never writes code and never grants anything. A probability here is the model's own number: not calibrated confidence,
 * not verified geometry, and never evidence.
 *
 * Nothing in this file reads the network, a file or a secret.
 */

export const CLEF_OMNI_MODEL_ID = '@cf/cloudflare/clef-omni';
export const CLEF_OMNI_MODEL = 'clef-omni';

/** Limits from schema-input.json and the model page. */
export const CLEF_LIMITS = {
  questions: { min: 1, max: 64 },
  questionId: /^[A-Za-z0-9_.-]{1,100}$/,
  choiceOptions: { min: 2, max: 255 },
  scoreLevels: { min: 2, max: 10 },
  images: { max: 4, bytesEach: 4 * 1024 * 1024, megapixelsEach: 16, bytesTotal: 8 * 1024 * 1024, types: ['image/png', 'image/jpeg', 'image/webp'] },
  audio: { max: 4, bytesEach: 8 * 1024 * 1024, secondsEach: 300 },
  videos: { max: 2, bytesEach: 16 * 1024 * 1024, secondsEach: 60 },
  audioAndVideoBytesTotal: 16 * 1024 * 1024,
  contextTokens: 64_000,
} as const;

/** The documented hosted price: per million input tokens, media billed as input; output tokens are not charged. */
export const CLEF_OMNI_HOSTED_USD_PER_MILLION_INPUT = 0.15;

export type ClefQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

/** A media item as schema-input.json's object form: never a remote URL. */
export interface ClefMedia {
  content_type: string;
  base64: string;
}

export interface ClefRequest {
  model: typeof CLEF_OMNI_MODEL;
  state: unknown;
  questions: Record<string, ClefQuestion>;
  images?: ClefMedia[];
  audio?: ClefMedia[];
  videos?: ClefMedia[];
}

export type ClefAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number };

export interface ClefResponse {
  model: string;
  answers: Record<string, ClefAnswer>;
  /** Required by schema-output.json; kept optional here so a missing one is recorded as not reported, not as a decision. */
  usage?: { input_tokens: number; output_tokens: number };
}

/** A media item Timmy may consider sending, with what Timmy knows about it (dimensions and duration are not guessed). */
export interface MediaCandidate {
  kind: 'image' | 'audio' | 'video';
  contentType: string;
  bytes: number;
  width?: number;
  height?: number;
  seconds?: number;
}

const finite01 = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** Problems with a request before it is sent, in words. An empty list means the request matches the published schema. */
export function checkRequest(req: ClefRequest): string[] {
  const problems: string[] = [];
  if (!/^\s*clef-omni\s*$/.test(String(req.model))) problems.push(`model must be "clef-omni", not "${String(req.model)}"`);
  if (req.state === undefined) problems.push('state is required');
  const ids = Object.keys(req.questions ?? {});
  if (ids.length < CLEF_LIMITS.questions.min || ids.length > CLEF_LIMITS.questions.max) {
    problems.push(`questions must number ${CLEF_LIMITS.questions.min} to ${CLEF_LIMITS.questions.max}, not ${ids.length}`);
  }
  for (const id of ids) {
    const q = req.questions[id];
    if (!CLEF_LIMITS.questionId.test(id)) problems.push(`question id "${id}" must be 1-100 letters, digits, _, . or -`);
    if (!q || typeof q.instructions !== 'string' || q.instructions.trim() === '') problems.push(`question "${id}" needs instructions`);
    if (q?.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < CLEF_LIMITS.choiceOptions.min || n > CLEF_LIMITS.choiceOptions.max) problems.push(`question "${id}" must offer 2 to 255 options, not ${n}`);
      for (const opt of Object.keys(q.criteria ?? {})) if (opt.trim() === '') problems.push(`question "${id}" has an empty option id`);
    } else if (q?.type === 'score') {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < CLEF_LIMITS.scoreLevels.min || n > CLEF_LIMITS.scoreLevels.max) problems.push(`question "${id}" must have 2 to 10 levels, not ${n}`);
    } else if (q?.type !== 'noul') {
      problems.push(`question "${id}" has unknown type "${String((q as { type?: unknown } | undefined)?.type)}"`);
    }
  }
  return problems;
}

/** Decoded bytes of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/**
 * Which media items fit the published limits, and why the others do not. Dimensions or durations that are not known are
 * refused, never assumed small: a limit Timmy cannot check is a limit Timmy does not claim to meet.
 */
export function checkMedia(items: MediaCandidate[]): { accepted: MediaCandidate[]; refused: Array<{ item: MediaCandidate; reason: string }> } {
  const accepted: MediaCandidate[] = [];
  const refused: Array<{ item: MediaCandidate; reason: string }> = [];
  let imageBytes = 0;
  let avBytes = 0;
  const counts = { image: 0, audio: 0, video: 0 };
  for (const item of items) {
    const refuse = (reason: string) => refused.push({ item, reason });
    if (item.kind === 'image') {
      if (!(CLEF_LIMITS.images.types as readonly string[]).includes(item.contentType)) { refuse(`image type ${item.contentType} is not PNG, JPEG or WebP`); continue; }
      if (item.bytes > CLEF_LIMITS.images.bytesEach) { refuse('image over 4 MiB'); continue; }
      if (item.width === undefined || item.height === undefined) { refuse('image size unknown, so the 16-megapixel limit cannot be checked'); continue; }
      if (item.width * item.height > CLEF_LIMITS.images.megapixelsEach * 1_000_000) { refuse('image over 16 megapixels'); continue; }
      if (counts.image + 1 > CLEF_LIMITS.images.max) { refuse('more than 4 images'); continue; }
      if (imageBytes + item.bytes > CLEF_LIMITS.images.bytesTotal) { refuse('images over 8 MiB in total'); continue; }
      counts.image += 1;
      imageBytes += item.bytes;
    } else if (item.kind === 'audio') {
      if (!item.contentType.startsWith('audio/')) { refuse(`audio type ${item.contentType} is not audio/*`); continue; }
      if (item.bytes > CLEF_LIMITS.audio.bytesEach) { refuse('audio clip over 8 MiB'); continue; }
      if (item.seconds === undefined) { refuse('audio length unknown, so the 300-second limit cannot be checked'); continue; }
      if (item.seconds > CLEF_LIMITS.audio.secondsEach) { refuse('audio clip over 300 seconds'); continue; }
      if (counts.audio + 1 > CLEF_LIMITS.audio.max) { refuse('more than 4 audio clips'); continue; }
      if (avBytes + item.bytes > CLEF_LIMITS.audioAndVideoBytesTotal) { refuse('audio and video over 16 MiB in total'); continue; }
      counts.audio += 1;
      avBytes += item.bytes;
    } else {
      if (!item.contentType.startsWith('video/')) { refuse(`video type ${item.contentType} is not video/*`); continue; }
      if (item.bytes > CLEF_LIMITS.videos.bytesEach) { refuse('video over 16 MiB'); continue; }
      if (item.seconds === undefined) { refuse('video length unknown, so the 60-second limit cannot be checked'); continue; }
      if (item.seconds > CLEF_LIMITS.videos.secondsEach) { refuse('video over 60 seconds'); continue; }
      if (counts.video + 1 > CLEF_LIMITS.videos.max) { refuse('more than 2 videos'); continue; }
      if (avBytes + item.bytes > CLEF_LIMITS.audioAndVideoBytesTotal) { refuse('audio and video over 16 MiB in total'); continue; }
      counts.video += 1;
      avBytes += item.bytes;
    }
    accepted.push(item);
  }
  return { accepted, refused };
}

/**
 * The response body, whether it came bare (a Workers binding, a SystemOne deployment) or in Cloudflare's REST envelope
 * ({success, result, errors}). The envelope is Cloudflare's general REST convention; the model page does not show it, so
 * both shapes are accepted and anything else is refused.
 */
export function unwrapBody(body: unknown): { ok: true; response: unknown } | { ok: false; problem: string } {
  if (!body || typeof body !== 'object') return { ok: false, problem: 'the answer is not a JSON object' };
  const b = body as Record<string, unknown>;
  if ('success' in b && ('result' in b || 'errors' in b)) {
    if (b.success !== true) {
      const errs = Array.isArray(b.errors) ? b.errors.map((e) => (e && typeof e === 'object' ? String((e as { message?: unknown }).message ?? JSON.stringify(e)) : String(e))) : [];
      return { ok: false, problem: `the service answered success=false${errs.length ? `: ${errs.join('; ')}` : ''}` };
    }
    return b.result && typeof b.result === 'object' ? { ok: true, response: b.result } : { ok: false, problem: 'the envelope has no result' };
  }
  return { ok: true, response: b };
}

const SUM_TOLERANCE = 0.01;

function checkDistribution(where: string, probs: unknown, allowed: string[], problems: string[]): Record<string, number> | undefined {
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) { problems.push(`${where}: probabilities missing`); return undefined; }
  const p = probs as Record<string, unknown>;
  const keys: string[] = Object.keys(p);
  const extra = keys.filter((k) => !allowed.includes(k));
  const missing = allowed.filter((k) => !keys.includes(k));
  if (extra.length) problems.push(`${where}: options Timmy did not offer: ${extra.join(', ')}`);
  if (missing.length) problems.push(`${where}: no probability for: ${missing.join(', ')}`);
  let sum = 0;
  for (const k of keys) {
    if (!finite01(p[k])) problems.push(`${where}: probability of ${k} is not a number from 0 to 1`);
    else sum += p[k] as number;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) problems.push(`${where}: probabilities sum to ${sum.toFixed(3)}, not 1`);
  return extra.length || missing.length ? undefined : (p as Record<string, number>);
}

/**
 * Checks an answer against schema-output.json and against the questions Timmy asked: every asked question answered with
 * its own type, a choice only from the options offered and equal to the highest probability, probabilities over exactly
 * the offered options, each from 0 to 1, summing to 1. Any problem makes the whole answer malformed; nothing is repaired.
 */
export function checkAnswer(response: unknown, asked: Record<string, ClefQuestion>): { ok: true; response: ClefResponse; usageReported: boolean } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!response || typeof response !== 'object') return { ok: false, problems: ['the answer is not a JSON object'] };
  const r = response as Record<string, unknown>;
  if (typeof r.model !== 'string' || r.model.trim() === '') problems.push('model missing');
  const answers = r.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, problems: [...problems, 'answers missing'] };
  const a = answers as Record<string, unknown>;
  for (const [id, q] of Object.entries(asked)) {
    const ans = a[id] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== 'object') { problems.push(`no answer for "${id}"`); continue; }
    if (ans.type !== q.type) { problems.push(`"${id}" answered as ${String(ans.type)}, asked as ${q.type}`); continue; }
    if (q.type === 'noul') {
      if (!finite01(ans.noul)) problems.push(`"${id}": noul is not a number from 0 to 1`);
    } else if (q.type === 'choice') {
      const allowed: string[] = Object.keys(q.criteria);
      const dist = checkDistribution(`"${id}"`, ans.probabilities, allowed, problems);
      if (typeof ans.choice !== 'string' || !allowed.includes(ans.choice)) problems.push(`"${id}": choice ${String(ans.choice)} was not offered`);
      else if (dist) {
        const top = Math.max(...Object.values(dist));
        if ((dist[ans.choice] ?? -1) < top - 1e-9) problems.push(`"${id}": choice ${ans.choice} is not the highest probability`);
      }
      if (!finite01(ans.confidence)) problems.push(`"${id}": confidence is not a number from 0 to 1`);
    } else {
      const levels = q.criteria.map((_, i) => String(i));
      checkDistribution(`"${id}"`, ans.probabilities, levels, problems);
      if (typeof ans.score !== 'number' || !Number.isFinite(ans.score) || ans.score < 0 || ans.score > levels.length - 1) problems.push(`"${id}": score is not a level from 0 to ${levels.length - 1}`);
      if (!ans.legend || typeof ans.legend !== 'object') problems.push(`"${id}": legend missing`);
      if (!finite01(ans.confidence)) problems.push(`"${id}": confidence is not a number from 0 to 1`);
    }
  }
  const usage = r.usage as Record<string, unknown> | undefined;
  const usageReported = !!usage && Number.isInteger(usage.input_tokens) && Number.isInteger(usage.output_tokens);
  if (usage !== undefined && !usageReported) problems.push('usage is not input_tokens and output_tokens counts');
  return problems.length ? { ok: false, problems } : { ok: true, response: r as unknown as ClefResponse, usageReported };
}
