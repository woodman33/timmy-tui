/**
 * Round R4 (H120): what a decision model may be asked, and what may follow from its answer.
 *
 *   the allowed-choice set   the caller's options that are available and not forbidden by policy, plus needs_review ("A
 *                            person should decide"), always; the rest are listed with their reasons and never shown
 *   egress                   local only refuses a model that runs off this computer (another computer, or a cloud model tag
 *                            at a loopback address); free only refuses a declared price; there is no silent switch to paid
 *                            inference
 *   pricing (R9, H162)       unknown pricing (none declared, or declared free for a cloud model tag) is refused: under free
 *                            only, whenever a budget applies, and when neither does (a call that may cost money needs a
 *                            budget); it never becomes zero
 *   budget                   a declared price needs a budget; an estimate (the request's JSON characters / 4, plus the
 *                            media's documented tokens, at the declared price and billing, src/decision/pricing.ts) above
 *                            what is left is refused
 *   media                    sent only when "Allow cloud analysis" is on, the item is marked not private and checkMedia()
 *                            accepts it; the record keeps each item's sha256 and size, never its bytes
 *   staleness                a request bound to a revision the project has moved on from is not asked
 *   admission                independent of the model: the caller's own checks (project scope, privacy, budget,
 *                            concurrency, isolation, required approvals), each supplied and passing, or not admitted
 *
 * The operator's rule it keeps: a recommendation can never raise a worker count, approve a purchase, start compute, skip a
 * review or seal a receipt. Admission only answers admitted or not, with reasons; "Require review before dispatch" turns
 * every recommendation into a NEEDS YOU proposal. Nothing here calls a provider or writes a file.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { checkMedia, CLEF_LIMITS, type ClefMedia, type ClefRequest, type MediaCandidate } from './clef-contract.js';
import { NEEDS_REVIEW } from './judge.js';
import { priceWords, type ModelLimits } from './pricing.js';
import { scrubHomes } from '../utils/home-scrub.js';
import {
  ADMISSION_CHECKS, type Admission, type AdmissionCheckName, type AdmissionChecks, type DecisionOption, type MediaRecord, type MediaRef,
  type ProviderDescription,
} from './types.js';

export const NEEDS_REVIEW_LABEL = 'A person should decide';
export const NEEDS_REVIEW_DESCRIPTION = 'A person should decide: none of the options clearly fits, or the state is not enough to choose';
/** An option id as Timmy offers it (the CLI's `--option id[:label]` keeps ':' for the label). */
export const OPTION_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** A question offers at most 255 options; one is always needs_review. */
export const MAX_REAL_OPTIONS = CLEF_LIMITS.choiceOptions.max - 1;

export interface AllowedChoices {
  permitted: DecisionOption[];
  excluded: Array<{ id: string; label: string; reason: string }>;
  /** What the model reads: each permitted option's description, then needs_review. */
  criteria: Record<string, string>;
  /** Inputs that cannot be offered as given (an id repeated, reserved or malformed). */
  problems: string[];
}

/** Problems with the option ids as given, in words: malformed, reserved, repeated. */
export function optionIdProblems(options: Array<{ id: unknown }>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const o of options) {
    const id = o?.id;
    if (typeof id !== 'string' || !OPTION_ID.test(id)) { problems.push(`option id ${JSON.stringify(id ?? null)} must be 1 to 64 letters, digits, _, . or -`); continue; }
    if (id === NEEDS_REVIEW) { problems.push(`option id ${NEEDS_REVIEW} is reserved for "${NEEDS_REVIEW_LABEL}", which every question offers`); continue; }
    if (seen.has(id)) problems.push(`option ${id} is given more than once`);
    seen.add(id);
  }
  return problems;
}

/** The allowed-choice set: available, not forbidden, needs_review added; everything left out listed with why. */
export function allowedChoices(options: DecisionOption[], forbid: Record<string, string> = {}): AllowedChoices {
  const problems = optionIdProblems(options);
  const permitted: DecisionOption[] = [];
  const excluded: AllowedChoices['excluded'] = [];
  const seen = new Set<string>();
  for (const o of options) {
    if (typeof o?.id !== 'string' || !OPTION_ID.test(o.id) || o.id === NEEDS_REVIEW || seen.has(o.id)) continue;
    seen.add(o.id);
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : o.id;
    if (o.available !== true) { excluded.push({ id: o.id, label, reason: o.unavailableReason?.trim() || 'unavailable (no reason was given)' }); continue; }
    if (Object.prototype.hasOwnProperty.call(forbid, o.id)) { excluded.push({ id: o.id, label, reason: forbid[o.id]?.trim() || 'forbidden by policy (no reason was given)' }); continue; }
    permitted.push({ id: o.id, label, description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : label, available: true });
  }
  if (permitted.length > MAX_REAL_OPTIONS) problems.push(`${permitted.length} options: a question offers at most ${MAX_REAL_OPTIONS} besides "${NEEDS_REVIEW_LABEL}"`);
  const criteria: Record<string, string> = {};
  for (const o of permitted) criteria[o.id] = o.description;
  criteria[NEEDS_REVIEW] = NEEDS_REVIEW_DESCRIPTION;
  return { permitted, excluded, criteria, problems };
}

export interface EgressPolicy {
  /** Nothing leaves this computer. */
  localOnly: boolean;
  /** Nothing that costs money; a paid transport is never used in place of a free one. */
  freeOnly: boolean;
}

const transportWords = (d: ProviderDescription): string =>
  d.transport === 'workers-ai' ? 'the Workers AI transport (Cloudflare\'s hosted model)'
    : d.transport === 'systemone' ? `the SystemOne deployment${d.local ? ' on this computer' : ' on another computer'}`
      : d.transport === 'fixture' ? 'the fixture transport' : 'no transport';

/** Where the model is asked, in words: never its address. */
export const whereWords = (d: ProviderDescription): string =>
  d.transport === 'workers-ai' ? 'Workers AI (Cloudflare\'s hosted service)'
    : d.transport === 'systemone' ? `the SystemOne endpoint ${d.endpoint === 'systemone-loopback' ? 'on this computer' : 'on another computer'}`
      : d.transport === 'fixture' ? 'the fixture transport' : 'no transport';

/** Why the policy refuses this transport, or undefined when it may be asked. */
export function egressRefusal(d: ProviderDescription, p: Partial<EgressPolicy> = {}): string | undefined {
  if (p.localOnly && !d.local) {
    // a loopback address is this computer, but a cloud model tag sends what it is given to a cloud from there
    if (d.cloudModel && d.endpoint === 'systemone-loopback') return `local only: ${d.model} is a cloud model tag: ${whereWords(d)} sends it to a cloud, so it is not asked`;
    return `local only: ${transportWords(d)} runs off this computer, so it is not asked`;
  }
  const pr = d.pricing;
  if (p.freeOnly && pr?.kind === 'paid' && pr.usd_per_million_input !== undefined && pr.billing) {
    return `free only: ${d.model} on ${whereWords(d)} is declared paid (${priceWords(pr.usd_per_million_input, pr.billing)}); it is never used in place of a free route`;
  }
  return undefined;
}

/**
 * R9 (H162): why unknown pricing refuses this call, or undefined when the pricing is declared (or no call is made). Unknown is
 * never taken as free or as zero: free only refuses it, a budget cannot be checked against it, and with neither, a call that
 * may cost money still needs a budget. A description without a pricing is unknown.
 */
export function pricingRefusal(d: ProviderDescription, ctx: { freeOnly?: boolean; budget: boolean }): string | undefined {
  if (d.pricing && d.pricing.kind !== 'unknown') return undefined;
  const of = `the pricing of ${d.model} on ${whereWords(d)} is unknown (${d.pricing?.why ?? 'the provider describes no pricing'})`;
  if (ctx.freeOnly) return `free only: ${of}, so it cannot be shown to be free; unknown pricing is never taken as free, and no call is made`;
  if (ctx.budget) return `unknown pricing cannot be checked against the budget, so no call is made: ${of}`;
  return `${of}: a call that may cost money needs a budget, and unknown pricing cannot be checked against one, so no call is made`;
}

/** Documented token counts: an image is 64 to 1024 input tokens (the top is used); a video at most 256 per second. */
const IMAGE_TOKENS = 1024;
const VIDEO_TOKENS_PER_SECOND = 256;

/**
 * Input tokens a request may be billed, estimated before the call: the JSON body's characters / 4, plus each media item's
 * documented tokens (audio has no published rate, so it counts as the whole context window), never more than the context
 * the model reads: Clef-Omni's 64,000 tokens by default; R9 (H162) `limits` gives the model's own (none stated: no cap).
 */
export function estimateInputTokens(request: ClefRequest, media: MediaCandidate[] = [], limits?: Pick<ModelLimits, 'contextTokens'>): { tokens: number; words: string } {
  const cap = limits ? limits.contextTokens : CLEF_LIMITS.contextTokens;
  const { images: _i, audio: _a, videos: _v, ...text } = request;
  const textTokens = Math.ceil(JSON.stringify(text).length / 4);
  let mediaTokens = 0;
  const parts: string[] = [`${textTokens} for the JSON body (characters / 4)`];
  const images = media.filter((m) => m.kind === 'image').length;
  if (images) { mediaTokens += images * IMAGE_TOKENS; parts.push(`${images * IMAGE_TOKENS} for ${images} image${images === 1 ? '' : 's'} (${IMAGE_TOKENS} each, the documented top)`); }
  const videoSeconds = media.filter((m) => m.kind === 'video').reduce((s, m) => s + (m.seconds ?? 0), 0);
  if (videoSeconds) { mediaTokens += Math.ceil(videoSeconds * VIDEO_TOKENS_PER_SECOND); parts.push(`${Math.ceil(videoSeconds * VIDEO_TOKENS_PER_SECOND)} for ${videoSeconds} s of video (${VIDEO_TOKENS_PER_SECOND} a second at most)`); }
  if (media.some((m) => m.kind === 'audio')) { mediaTokens += CLEF_LIMITS.contextTokens; parts.push('the whole context window for audio (no per-second rate is published)'); }
  const tokens = cap === undefined ? textTokens + mediaTokens : Math.min(cap, textTokens + mediaTokens);
  return { tokens, words: `${parts.join(', ')}${cap !== undefined && textTokens + mediaTokens > cap ? `, capped at the ${cap}-token context` : ''}` };
}

const usd = (n: number): string => `$${n.toFixed(6)}`;

/**
 * Why paid inference is refused for this estimate, or undefined when it fits what is left. R9 (H162): the estimate is at the
 * declared price and billing (src/decision/pricing.ts estimateCost), and `basis` says how it was made.
 */
export function budgetRefusal(estimate: number, remainingUsd: number | undefined, basis?: string): string | undefined {
  if (remainingUsd === undefined || !Number.isFinite(remainingUsd)) return 'paid inference needs a budget; none was given, so no paid call is made';
  if (estimate > remainingUsd) return `the estimate ${usd(estimate)}${basis ? ` (${basis})` : ''} is more than the ${usd(Math.max(0, remainingUsd))} left of the budget`;
  return undefined;
}

const shortRev = (r: string): string => (r.length > 12 ? r.slice(0, 12) : r);

/** Why a request bound to `asked` is stale against the project's `current` revision, or undefined. */
export function staleRefusal(asked: string, current: string | undefined): string | undefined {
  if (current === undefined || current === asked) return undefined;
  return `the project is at ${shortRev(current)} now, not ${shortRev(asked)} as the request says, so it was not asked`;
}

export interface MediaPlan {
  records: MediaRecord[];
  send: { images: ClefMedia[]; audio: ClefMedia[]; videos: ClefMedia[] };
  /** What is sent, as checkMedia saw it (for the token estimate). */
  sent: MediaCandidate[];
}

/** Bytes hashed for the record at most; a larger file is recorded by its size alone (it is over every limit anyway). */
const MAX_HASHED = 64 * 1024 * 1024;

/**
 * A regular file (never through a link): its size and sha256, and its bytes only when `keep` (an item that may be sent).
 * Bytes not kept are hashed a megabyte at a time.
 */
function readRegular(file: string, keep: boolean): { bytes?: Buffer; size: number; sha256: string } | { size?: number; why: string } {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: 'not a regular file' };
    if (st.size > MAX_HASHED) return { size: st.size, why: `larger than ${MAX_HASHED / 1024 / 1024} MiB` };
    const hash = createHash('sha256');
    const bytes = keep ? Buffer.alloc(st.size) : undefined;
    const chunk = keep ? undefined : Buffer.alloc(Math.min(st.size, 1024 * 1024) || 1);
    let at = 0;
    while (at < st.size) {
      const n = bytes ? readSync(fd, bytes, at, st.size - at, at) : readSync(fd, chunk!, 0, Math.min(chunk!.length, st.size - at), at);
      if (n <= 0) break;
      if (chunk) hash.update(chunk.subarray(0, n));
      at += n;
    }
    if (bytes) hash.update(bytes.subarray(0, at));
    return { ...(bytes ? { bytes: bytes.subarray(0, at) } : {}), size: at, sha256: hash.digest('hex') };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === 'ELOOP' ? 'a symbolic link (only regular files are read)' : `${code ?? 'error'}` };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * Which media items go with the question. In this order: "Allow cloud analysis" off sends nothing; an item not marked
 * `private: false` is never sent; an unreadable item is not sent; then the published limits (checkMedia).
 */
export function planMedia(refs: MediaRef[] | undefined, root: string, allowCloudAnalysis: boolean): MediaPlan {
  const records: MediaRecord[] = [];
  const send: MediaPlan['send'] = { images: [], audio: [], videos: [] };
  const eligible: Array<{ rec: MediaRecord; cand: MediaCandidate; bytes: Buffer }> = [];
  for (const m of refs ?? []) {
    const rec: MediaRecord = { ref: scrubHomes(String(m.path)), kind: m.kind, contentType: String(m.contentType), sent: false };
    records.push(rec);
    const mayBeSent = allowCloudAnalysis && m.private === false;
    const read = readRegular(isAbsolute(m.path) ? m.path : join(root, m.path), mayBeSent);
    if ('sha256' in read) { rec.bytes = read.size; rec.sha256 = read.sha256; } else if (read.size !== undefined) rec.bytes = read.size;
    if (!allowCloudAnalysis) { rec.reason = 'Allow cloud analysis is off: no media item is sent'; continue; }
    if (m.private !== false) { rec.reason = 'marked private (only items marked not private are ever sent)'; continue; }
    if (!('sha256' in read) || !read.bytes) { rec.reason = `cannot be read: ${'why' in read ? read.why : 'no bytes'}`; continue; }
    eligible.push({ rec, bytes: read.bytes, cand: { kind: m.kind, contentType: m.contentType, bytes: read.size, width: m.width, height: m.height, seconds: m.seconds } });
  }
  const checked = checkMedia(eligible.map((e) => e.cand));
  const sent: MediaCandidate[] = [];
  for (const e of eligible) {
    const refused = checked.refused.find((r) => r.item === e.cand);
    if (refused) { e.rec.reason = refused.reason; continue; }
    e.rec.sent = true;
    sent.push(e.cand);
    const item: ClefMedia = { content_type: e.cand.contentType, base64: e.bytes.toString('base64') };
    if (e.cand.kind === 'image') send.images.push(item);
    else if (e.cand.kind === 'audio') send.audio.push(item);
    else send.videos.push(item);
  }
  return { records, send, sent };
}

const CHECK_WORDS: Record<AdmissionCheckName, string> = {
  projectScope: 'project scope', privacy: 'privacy', budget: 'budget', concurrency: 'concurrency', isolation: 'isolation', approvals: 'required approvals',
};

/**
 * Independent admission of a proposal (a recommendation, or the fallback's option) before any dispatch. Every check must be
 * supplied by the caller and pass; a check not supplied is never taken as passed. "Require review before dispatch" makes a
 * person approve even an admitted proposal. The answer is admitted or not, with reasons: nothing else.
 */
export function admission(
  proposal: { of: Admission['of']; option?: string },
  checks: AdmissionChecks | undefined,
  o: { requireReview: boolean; now?: Date },
): Admission {
  const checked = {} as Admission['checked'];
  const reasons: string[] = [];
  const missing: string[] = [];
  let allOk = true;
  for (const name of ADMISSION_CHECKS) {
    const c = checks?.[name];
    if (!c || typeof c.ok !== 'boolean') { checked[name] = 'not supplied'; missing.push(CHECK_WORDS[name]); allOk = false; continue; }
    checked[name] = c.ok ? 'ok' : 'refused';
    if (!c.ok) { allOk = false; reasons.push(`${CHECK_WORDS[name]}: ${c.words}`); }
  }
  const nothing = proposal.of === 'nothing' || !proposal.option;
  if (nothing) reasons.unshift('nothing to admit: a person chooses');
  if (missing.length) reasons.push(`not supplied: ${missing.join(', ')} (the caller checks these before any dispatch; a check not supplied never counts as met)`);
  const admitted = !nothing && allOk;
  if (o.requireReview) reasons.push('Require review before dispatch is on: a person approves before anything runs');
  return {
    of: nothing ? 'nothing' : proposal.of,
    option: nothing ? undefined : proposal.option,
    admitted,
    needsReview: o.requireReview || !admitted,
    reasons,
    checked,
    at: (o.now ?? new Date()).toISOString(),
  };
}
