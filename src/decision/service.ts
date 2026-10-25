/**
 * Round R4 (H120): decide(input, ctx): one decision, recorded once; decideBatch(inputs, ctx): several, the distinct ones
 * that may be asked together sent as the questions of one request (at most 63 choices plus human_review per request).
 *
 * The order of things, for each input:
 *   1. the recorded decision for its request key, if there is one (or the one in flight here, or another process's): no call
 *   2. the allowed-choice set (src/decision/policy.ts) and the deterministic proposal (src/decision/deterministic.ts)
 *   3. no call, the deterministic path used and its reason recorded, when: the inputs are unresolved, decision-model routing
 *      ("Use Clef routing", as the setting is stored) is off, the revision is stale, fewer than 2 options are permitted, the
 *      provider is unavailable, egress is denied, the pricing is unknown (R9, H162: never taken as free or zero), or a
 *      declared price has no budget for it (the estimate at the declared price and billing); none of these sends a byte
 *   4. the call: an answer that fails a check is malformed; a timeout or an unavailable service is recorded as such; each
 *      is a fallback to the deterministic path
 *   5. the judge (src/decision/judge.ts): a recommendation, or an abstention (a person decides; the deterministic option is
 *      the proposal shown, never applied)
 *   6. independent admission of whatever is proposed, with the caller's checks; "Require review before dispatch" makes it a
 *      NEEDS YOU proposal
 *   7. the record (src/decision/store.ts): bound to the operation, the project revision and the intent and prediction refs
 *
 * The operator's rule it keeps: a model scores options Timmy built; its answer is a recommendation, never evidence and
 * never a permission. Nothing here dispatches, raises a worker count, starts compute, approves a purchase or seals a
 * receipt. The token and the account id never reach a record (the provider redacts every word it returns).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { OPERATION_ID } from '../ops/context.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { redactString } from '../utils/redact.js';
import { checkRequest, CLEF_LIMITS, type ClefQuestion, type ClefRequest, type ClefResponse } from './clef-contract.js';
import { readClefConfig } from './config.js';
import { deterministicProposal, type DeterministicProposal } from './deterministic.js';
import { judge, NEEDS_REVIEW } from './judge.js';
import {
  admission, allowedChoices, budgetRefusal, egressRefusal, estimateInputTokens, NEEDS_REVIEW_LABEL, planMedia, pricingRefusal, staleRefusal,
  type AllowedChoices, type EgressPolicy, type MediaPlan,
} from './policy.js';
import { estimateCost, FIXTURE_PRICING, limitsOf, type ModelLimits, type Pricing } from './pricing.js';
import { ClefOmniProvider, providerFromConfig, sameModel } from './provider.js';
import { readSettings, type DecisionSettings } from './settings.js';
import { claim, DecisionRefused, findRecorded, waitForRecorded, writeDecision } from './store.js';
import {
  DECISION_EVIDENCE_KIND, DECISION_KINDS, DECISION_NOTE, DECISION_SCHEMA,
  type AdmissionChecks, type DecisionInput, type DecisionProvider, type DecisionRecord, type FallbackReason, type ProviderAnswer,
  type ProviderCallOptions, type ProviderDescription, type ProviderFailure,
} from './types.js';

export { DecisionRefused } from './store.js';
export { listDecisions, readDecision } from './store.js';

export const HUMAN_REVIEW = 'human_review';
/** Choice questions per request: Clef reads at most 64 questions, and one is always human_review. */
export const MAX_CHOICES_PER_REQUEST = CLEF_LIMITS.questions.max - 1;
/** How long beyond its timeout a request decided by another process is waited for. */
const CLAIM_GRACE_MS = 5000;

type Env = Record<string, string | undefined>;

export interface DecideContext {
  /** Default: the saved settings (src/decision/settings.ts), TIMMY_CLEF applied. */
  settings?: DecisionSettings;
  /** Default: the fixture transport when `fixture` is named, else the provider clef.json configures. */
  provider?: DecisionProvider;
  /** The fixture transport's response file (tests and the offline slice only). */
  fixture?: string;
  /** For the configured transports (default: globalThis.fetch). */
  fetch?: typeof fetch;
  /** Internal, tests only: a FAKE Workers AI endpoint on 127.0.0.1. */
  baseUrl?: string;
  env?: Env;
  policy?: Partial<EgressPolicy>;
  /** What is left of the inference budget; paid inference without one is refused. */
  budget?: { remainingUsd: number };
  /** The project's revision now; a request bound to another is stale. */
  currentRevision?: string | (() => string | undefined);
  /** Why the project's revision now cannot be read: the inputs are unresolved. */
  revisionUnknown?: string;
  /** The caller's admission checks (project scope, privacy, budget, concurrency, isolation, approvals). */
  checks?: AdmissionChecks;
  /** Options policy forbids, with why. */
  forbid?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DecideResult {
  record: DecisionRecord;
  /** The recorded decision was returned: no call and no record were made now. */
  reused: boolean;
  /** The record, relative to the project. */
  file: string;
}

/** JSON with every object's keys sorted, so equal values write equal text. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x));
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The project's git revision now, and whether it has uncommitted changes; or why it cannot be read. Never touches the network. */
export function projectRevision(root: string): { revision?: string; dirty?: boolean; why?: string } {
  const run = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.error) return { why: `git cannot run here (${(head.error as NodeJS.ErrnoException).code ?? head.error.message})` };
  const rev = (head.stdout ?? '').trim();
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(rev)) return { why: 'the project folder is not a git repository with a commit' };
  const st = run(['status', '--porcelain', '--untracked-files=no']);
  return { revision: rev, ...(st.status === 0 ? { dirty: (st.stdout ?? '').trim().length > 0 } : {}) };
}

interface Prepared {
  index: number;
  input: DecisionInput;
  root: string;
  question: string;
  choices: AllowedChoices;
  proposal: DeterministicProposal;
  media: MediaPlan;
  stateRef: { sha256: string; bytes: number };
  requestKey: string;
  /** Inputs that may share one request share this. */
  batchKey: string;
  problems: string[];
}

/** R9 (H162): the model's limits as the provider describes them (a description without them: the model's own by name). */
const limitsFor = (desc: ProviderDescription): ModelLimits => desc.limits ?? limitsOf(desc.model ?? '');

function prepare(input: DecisionInput, index: number, settings: DecisionSettings, ctx: DecideContext, desc: ProviderDescription): Prepared {
  const problems: string[] = [];
  // the record goes in the project's own folder: one not named is refused, never taken to be the current folder
  if (typeof input.project?.root !== 'string' || !input.project.root.trim()) throw new DecisionRefused('not recorded', 'no project folder was given');
  // one spelling per folder, so a second path to the same project shares its in-flight decision and its claim
  let root: string;
  try { root = realpathSync(resolve(input.project.root)); } catch { throw new DecisionRefused('not recorded', 'the project folder does not exist'); }
  if (!(DECISION_KINDS as readonly string[]).includes(input.kind)) problems.push(`${JSON.stringify(input.kind)} is not a kind of decision (${DECISION_KINDS.join(', ')})`);
  if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) problems.push(`the operation id ${JSON.stringify(input.operationId ?? null)} is not o and 8 hex digits`);
  const revision = typeof input.project?.revision === 'string' ? input.project.revision.trim() : '';
  if (!revision || revision === 'unknown') problems.push('no project revision was given: a decision is bound to the revision it was asked at');
  if (ctx.revisionUnknown) problems.push(`the project's revision cannot be read (${ctx.revisionUnknown}), so the decision cannot be bound to one`);
  if (typeof input.instructions !== 'string' || !input.instructions.trim()) problems.push('the instructions are empty');
  const question = input.questionId ?? input.kind;
  if (!CLEF_LIMITS.questionId.test(String(question)) || question === HUMAN_REVIEW) problems.push(`the question id ${JSON.stringify(question)} must be 1 to 100 letters, digits, _, . or -, and not ${HUMAN_REVIEW}`);
  const choices = allowedChoices(Array.isArray(input.options) ? input.options : [], ctx.forbid);
  problems.push(...choices.problems);
  if (!Array.isArray(input.options) || input.options.length === 0) problems.push('no options were given');
  if (input.deterministic && !(input.options ?? []).some((o) => o?.id === input.deterministic?.option)) {
    problems.push(`the deterministic option ${input.deterministic.option} is not one of the options`);
  }
  const proposal = deterministicProposal(input.deterministic, choices);
  let stateJson: string;
  try {
    stateJson = canonicalJson(input.state ?? null);
    if (stateJson === undefined) throw new Error('no JSON');
  } catch {
    stateJson = '"<not JSON>"';
    problems.push('the state cannot be written as JSON');
  }
  // R9 (H162): media goes only to a model whose media limits are published (Clef-Omni's); any other gets none, said so
  const media = planMedia(input.media, root, settings.allowCloudAnalysis,
    desc.available && !limitsFor(desc).media ? `${desc.model}'s media limits are not published here: no media item is sent` : undefined);
  const sentMedia = media.records.filter((m) => m.sent).map((m) => m.sha256 ?? '');
  const canonical = canonicalJson({
    kind: input.kind, revision, operation: input.operationId, instructions: typeof input.instructions === 'string' ? input.instructions.trim() : '',
    permitted: [...choices.permitted].sort((a, b) => a.id.localeCompare(b.id)).map((o) => ({ id: o.id, label: o.label, description: o.description })),
    state: JSON.parse(stateJson) as unknown,
    ...(sentMedia.length ? { media: sentMedia } : {}),
    // an input that cannot be asked as given is another request than a clean one offering the same options
    ...(problems.length ? { unresolved: [...problems].sort() } : {}),
  });
  return {
    index, input, root, question: String(question), choices, proposal, media,
    stateRef: { sha256: sha256(stateJson), bytes: Buffer.byteLength(stateJson, 'utf8') },
    requestKey: typeof input.requestKey === 'string' && input.requestKey.trim() ? input.requestKey.trim() : sha256(canonical),
    batchKey: sha256(canonicalJson({ kind: input.kind, operation: input.operationId, revision, state: stateJson, media: sentMedia })),
    problems,
  };
}

const currentOf = (ctx: DecideContext): string | undefined => (typeof ctx.currentRevision === 'function' ? ctx.currentRevision() : ctx.currentRevision);

/** The reason no model is asked for this input, or undefined. Budget is weighed per request, once it is built. */
function beforeAnyCall(p: Prepared, settings: DecisionSettings, desc: ProviderDescription, ctx: DecideContext): { kind: FallbackReason; reason: string } | undefined {
  if (p.problems.length) return { kind: 'unresolved-inputs', reason: p.problems.join('; ') };
  if (!settings.useClef) return { kind: 'clef-off', reason: 'Decision-model routing is off: the deterministic path was used and no model was asked' };
  const stale = staleRefusal(p.input.project.revision.trim(), currentOf(ctx));
  if (stale) return { kind: 'stale-revision', reason: stale };
  const n = p.choices.permitted.length;
  if (n < 2) return { kind: 'too-few-options', reason: `${n === 0 ? 'no option is available' : `only 1 option is available (${p.choices.permitted[0].id})`}: nothing to choose between, so no model was asked` };
  if (!desc.available) return { kind: 'unavailable', reason: desc.reason ?? 'the decision provider is unavailable' };
  const egress = egressRefusal(desc, ctx.policy);
  if (egress) return { kind: 'egress-denied', reason: egress };
  // R9 (H162): unknown pricing is refused here, before any byte is sent, whatever the policy and the budget
  const pricing = pricingRefusal(desc, { freeOnly: ctx.policy?.freeOnly, budget: ctx.budget !== undefined });
  if (pricing) return { kind: 'pricing', reason: pricing };
  return undefined;
}

const HUMAN_REVIEW_QUESTION = (n: number): ClefQuestion => ({
  type: 'noul',
  instructions: n > 1 ? 'Should a person review these before anything runs?' : 'Should a person review this before anything runs?',
  criteria: {
    true: 'Yes: the options or the state leave real doubt, or the choice carries a risk a person should weigh',
    false: 'No: the state is clear enough to recommend one of the options',
  },
});

/** One request for the inputs that share it, naming the model clef.json names (R9, H162: never "clef-omni" by default). */
function buildRequest(items: Prepared[], model: string): ClefRequest {
  const questions: Record<string, ClefQuestion> = {};
  for (const p of items) questions[p.question] = { type: 'choice', instructions: p.input.instructions.trim(), criteria: p.choices.criteria };
  questions[HUMAN_REVIEW] = HUMAN_REVIEW_QUESTION(items.length);
  const send = items[0].media.send;
  return {
    model,
    state: items[0].input.state ?? null,
    questions,
    ...(send.images.length ? { images: send.images } : {}),
    ...(send.audio.length ? { audio: send.audio } : {}),
    ...(send.videos.length ? { videos: send.videos } : {}),
  };
}

/**
 * Groups the inputs that may share a request, at most `max` choices each (MAX_CHOICES_PER_REQUEST for Clef-Omni; R9: the
 * model's limit less human_review for another) and no question id twice in one.
 */
function chunk(items: Prepared[], max: number = MAX_CHOICES_PER_REQUEST): Prepared[][] {
  const groups = new Map<string, Prepared[][]>();
  for (const p of items) {
    const chunks = groups.get(p.batchKey) ?? [];
    groups.set(p.batchKey, chunks);
    let home = chunks.find((c) => c.length < max && !c.some((x) => x.question === p.question));
    if (!home) { home = []; chunks.push(home); }
    home.push(p);
  }
  return [...groups.values()].flat();
}

interface Outcome {
  outcome: DecisionRecord['outcome'];
  fallback?: { kind: FallbackReason; reason: string };
  answer?: ProviderAnswer;
  failure?: ProviderFailure;
  called: boolean;
  cost: DecisionRecord['cost'];
  batch?: DecisionRecord['batch'];
}

const NO_CALL_COST: DecisionRecord['cost'] = { measured: false, estimate_usd: 0, basis: 'no call was made' };

function makeRecord(p: Prepared, id: string, settings: DecisionSettings, desc: ProviderDescription, o: Outcome, ctx: DecideContext): DecisionRecord {
  const now = new Date();
  const label = (opt: string): string => p.choices.permitted.find((x) => x.id === opt)?.label ?? opt;
  let distribution: Record<string, number> | undefined;
  let humanReview: number | undefined;
  let judgement: DecisionRecord['judge'];
  let recommendation: DecisionRecord['recommendation'];
  let outcome = o.outcome;
  const response: ClefResponse | undefined = o.answer?.response;
  if (response) {
    const a = response.answers[p.question];
    if (a?.type === 'choice') distribution = { ...a.probabilities };
    const hr = response.answers[HUMAN_REVIEW];
    if (hr?.type === 'noul') humanReview = hr.noul;
    judgement = judge(distribution ?? {}, settings.thresholds);
    if (judgement.kind === 'recommend') {
      outcome = 'recommend';
      recommendation = { option: judgement.option, label: label(judgement.option), top: judgement.top, margin: judgement.margin };
    } else outcome = 'abstain';
  }
  const fallbackUsed = outcome === 'fallback';
  const proposal = outcome === 'recommend' && recommendation
    ? { of: 'recommendation' as const, option: recommendation.option }
    : outcome === 'fallback' && p.proposal.option ? { of: 'fallback' as const, option: p.proposal.option } : { of: 'nothing' as const };
  // R9 (H162): the model the answer names, as the provider received it (redacted); without one, none is claimed
  const observed = o.answer?.identity ?? o.failure?.identity;
  const returned = observed?.returned ?? (typeof response?.model === 'string' && response.model ? response.model : undefined);
  const usage = o.answer?.usageReported && response?.usage
    ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, ...(o.batch ? { sharedBy: o.batch.size } : {}) }
    : undefined;
  const record: DecisionRecord = {
    schema: DECISION_SCHEMA,
    id,
    createdAt: now.toISOString(),
    kind: p.input.kind,
    question: p.question,
    operationId: String(p.input.operationId),
    project: { revision: typeof p.input.project?.revision === 'string' ? p.input.project.revision.trim() : '', ...(typeof p.input.project?.dirty === 'boolean' ? { dirty: p.input.project.dirty } : {}) },
    ...(p.input.intentRef ? { intentRef: p.input.intentRef } : {}),
    ...(p.input.predictionRef ? { predictionRef: p.input.predictionRef } : {}),
    requestKey: p.requestKey,
    instructions: typeof p.input.instructions === 'string' ? p.input.instructions.trim().slice(0, 4000) : '',
    provider: {
      id: desc.id, transport: desc.transport, ...(desc.endpoint ? { endpoint: desc.endpoint } : {}),
      ...(returned ? { model: returned } : {}), paid: desc.paid, local: desc.local,
      // R9 (H162): the pricing as declared, kept with the decision (a record before R9 has none)
      ...(desc.pricing ? { pricing: pricingRecord(desc.pricing) } : {}),
    },
    options: {
      permitted: p.choices.permitted.map((x) => ({ id: x.id, label: x.label, description: x.description })),
      excluded: p.choices.excluded,
      needsReview: { id: NEEDS_REVIEW, label: NEEDS_REVIEW_LABEL },
    },
    thresholds: { ...settings.thresholds },
    ...(distribution ? { distribution } : {}),
    ...(humanReview !== undefined ? { humanReview } : {}),
    ...(judgement ? { judge: judgement } : {}),
    ...(recommendation ? { recommendation } : {}),
    inputs: { state: p.stateRef, media: p.media.records },
    ...(o.answer?.raw ?? o.failure?.raw ? { response: o.answer?.raw ?? o.failure?.raw } : {}),
    ...(o.called ? { latencyMs: o.answer?.latencyMs ?? o.failure?.latencyMs ?? 0 } : {}),
    ...(usage ? { usage } : {}),
    cost: o.cost,
    outcome,
    fallback: {
      used: fallbackUsed,
      ...(fallbackUsed && o.fallback ? { reasonKind: o.fallback.kind, reason: o.fallback.reason } : {}),
      ...(p.proposal.option ? { option: p.proposal.option } : {}),
      rule: p.proposal.rule,
    },
    admission: admission(proposal, ctx.checks, { requireReview: settings.requireReview, now }),
    model: identityOf(desc, o, returned),
    ...(o.batch ? { batch: o.batch } : {}),
    evidence_kind: DECISION_EVIDENCE_KIND,
    note: DECISION_NOTE,
  };
  return record;
}

/**
 * R9 (H162): the model's identity as the record keeps it: the model asked for and what the body named; the model and the
 * version fields the answer names, as received; the local digest, or "not available" with why; a sentence when the answer
 * names another model; and the limits the request was built under.
 */
function identityOf(desc: ProviderDescription, o: Outcome, returned: string | undefined): NonNullable<DecisionRecord['model']> {
  const observed = o.answer?.identity ?? o.failure?.identity;
  const limits = limitsFor(desc);
  const requestModel = desc.requestModel ?? desc.model;
  const differs = returned !== undefined && !sameModel(returned, desc.model) && !sameModel(returned, requestModel)
    ? `asked for ${desc.model}; the answer names ${returned}` : undefined;
  return {
    requested: desc.model, request_model: requestModel,
    ...(returned !== undefined ? { returned } : {}),
    ...(observed?.version ? { version: observed.version } : {}),
    digest: observed?.digest ?? 'not available',
    digest_source: observed?.digest_source ?? (o.called ? 'the provider said nothing of a digest' : 'no call was made, so no model list was read'),
    ...(differs ? { differs } : {}),
    limits: { source: limits.source, questions: limits.questions, words: limits.words },
  };
}

/** The pricing as a record keeps it. */
const pricingRecord = (p: Pricing): NonNullable<DecisionRecord['provider']['pricing']> => ({
  kind: p.kind, ...(p.usd_per_million_input !== undefined ? { usd_per_million_input: p.usd_per_million_input } : {}), ...(p.billing ? { billing: p.billing } : {}), words: p.words,
  ...(p.why ? { why: p.why } : {}),
});

/** The in-flight decisions of this process, by project and request key: a second delivery waits for the first. */
const inFlight = new Map<string, Promise<DecideResult>>();

interface Mine { p: Prepared; id: string; release: () => void; resolve: (r: DecideResult) => void; reject: (e: unknown) => void }

/** Decides several inputs; the distinct ones that may share a request are asked together. Results are in input order. */
export async function decideBatch(inputs: DecisionInput[], ctx: DecideContext = {}): Promise<DecideResult[]> {
  const env = ctx.env ?? process.env;
  const settings = ctx.settings ?? readSettings(env).settings;
  const provider = ctx.provider
    ?? (ctx.fixture ? new ClefOmniProvider({ transport: 'fixture' }) : providerFromConfig(readClefConfig(env), { fetch: ctx.fetch, baseUrl: ctx.baseUrl }));
  const desc = provider.describe();
  const results: DecideResult[] = new Array(inputs.length);
  const waits: Array<Promise<void>> = [];
  const mine: Mine[] = [];
  let firstError: unknown;

  const finish = (m: Mine, o: Outcome): void => {
    try {
      const record = makeRecord(m.p, m.id, settings, desc, o, ctx);
      const file = writeDecision(m.p.root, record);
      m.resolve({ record, reused: false, file });
    } catch (e) {
      firstError ??= e;
      m.reject(e);
    } finally {
      m.release();
    }
  };

  try {
    for (let i = 0; i < inputs.length; i++) {
      const p = prepare(inputs[i], i, settings, ctx, desc);
      if (!isDirectory(p.root)) throw new DecisionRefused('not recorded', 'the project folder does not exist');
      const key = `${p.root}\u0000${p.requestKey}`;
      const recorded = findRecorded(p.root, p.requestKey);
      if (recorded) { results[i] = { ...recorded, reused: true }; continue; }
      const flying = inFlight.get(key);
      if (flying) { waits.push(flying.then((r) => { results[i] = { ...r, reused: true }; }).catch((e: unknown) => { firstError ??= e; })); continue; }
      let resolveFn!: (r: DecideResult) => void;
      let rejectFn!: (e: unknown) => void;
      const promise = new Promise<DecideResult>((res, rej) => { resolveFn = res; rejectFn = rej; });
      promise.catch(() => { /* reported through the decideBatch that owns it */ });
      inFlight.set(key, promise);
      const done = (): void => { if (inFlight.get(key) === promise) inFlight.delete(key); };
      promise.then(done, done);
      let c: ReturnType<typeof claim>;
      try { c = claim(p.root, p.requestKey); } catch (e) { rejectFn(e); throw e; }
      if (c.kind === 'recorded') { const r = { record: c.record, file: c.file, reused: true }; resolveFn(r); results[i] = r; continue; }
      if (c.kind === 'held') {
        const holder = c.pid;
        const w = waitForRecorded(p.root, p.requestKey, settings.timeoutMs + CLAIM_GRACE_MS).then((found) => {
          if (!found) throw new DecisionRefused('in progress elsewhere', `process ${holder} was deciding this request and has not recorded it; ask again`);
          return { ...found, reused: true };
        });
        w.then(resolveFn, rejectFn);
        waits.push(w.then((r) => { results[i] = r; }).catch((e: unknown) => { firstError ??= e; }));
        continue;
      }
      mine.push({ p, id: c.id, release: c.release, resolve: (r) => { results[i] = r; resolveFn(r); }, reject: rejectFn });
    }

    const toAsk: Mine[] = [];
    for (const m of mine) {
      const pre = beforeAnyCall(m.p, settings, desc, ctx);
      if (pre) finish(m, { outcome: 'fallback', fallback: pre, called: false, cost: NO_CALL_COST });
      else toAsk.push(m);
    }
    let remaining = ctx.budget?.remainingUsd;
    const byPrepared = new Map(toAsk.map((m) => [m.p, m]));
    const limits = limitsFor(desc);
    for (const items of chunk(toAsk.map((m) => m.p), Math.max(1, limits.questions - 1))) {
      const group = items.map((p) => byPrepared.get(p)!);
      const all = (o: Outcome): void => { for (const m of group) finish(m, o); };
      const stale = staleRefusal(items[0].input.project.revision.trim(), currentOf(ctx));
      if (stale) { all({ outcome: 'fallback', fallback: { kind: 'stale-revision', reason: stale }, called: false, cost: NO_CALL_COST }); continue; }
      const request = buildRequest(items, desc.requestModel);
      const problems = checkRequest(request, { model: desc.requestModel, maxQuestions: limits.questions });
      if (problems.length) { all({ outcome: 'fallback', fallback: { kind: 'unresolved-inputs', reason: `the request does not match the published schema: ${problems.join('; ')}` }, called: false, cost: NO_CALL_COST }); continue; }
      const est = estimateInputTokens(request, items[0].media.sent, limits);
      const questions = Object.keys(request.questions).length;
      // R9 (H162): the estimate at the declared price and billing; unknown pricing was refused before this, and is again here
      const unknown = pricingRefusal(desc, { freeOnly: ctx.policy?.freeOnly, budget: ctx.budget !== undefined });
      if (unknown) { all({ outcome: 'fallback', fallback: { kind: 'pricing', reason: unknown }, called: false, cost: NO_CALL_COST }); continue; }
      const price = estimateCost(est.tokens, questions, desc.pricing);
      const usdEach = price.usd / items.length;
      if (desc.pricing.kind === 'paid') {
        const refused = budgetRefusal(price.usd, remaining, price.words);
        if (refused) { all({ outcome: 'fallback', fallback: { kind: 'budget', reason: refused }, called: false, cost: NO_CALL_COST }); continue; }
        remaining = (remaining ?? 0) - price.usd;
      }
      const batch = items.length > 1 ? { size: items.length, request_sha256: sha256(canonicalJson(request)) } : undefined;
      const result = await askProvider(provider, request, { timeoutMs: settings.timeoutMs, signal: ctx.signal, fixture: ctx.fixture });
      const cost = costOf(desc, est, questions, usdEach, items.length, result);
      if (!result.ok) {
        all({ outcome: 'fallback', fallback: { kind: result.kind, reason: result.reason }, failure: result, called: true, cost, batch });
        continue;
      }
      for (const m of group) finish(m, { outcome: 'abstain', answer: result, called: true, cost, batch });
    }
  } finally {
    // whatever happened, no claim of this call is left behind and nobody waits on it
    for (const m of mine) {
      m.release();
      m.reject(new DecisionRefused('not recorded', 'the decision stopped before it was recorded'));
    }
  }
  await Promise.all(waits);
  if (firstError) throw firstError;
  return results;
}

/** A provider that throws instead of answering is an unavailable one (its words redacted like any other). */
async function askProvider(provider: DecisionProvider, request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure> {
  const started = Date.now();
  try {
    return await provider.decide(request, o);
  } catch (e) {
    return { ok: false, kind: 'unavailable', reason: `the provider failed: ${scrubHomes(redactString(e instanceof Error ? e.message : String(e))).slice(0, 300)}`, latencyMs: Date.now() - started };
  }
}

/** The record's cost: an estimate at the declared price and billing (R9, H162), never a measured amount; free only as declared. */
function costOf(desc: ProviderDescription, est: { tokens: number; words: string }, questions: number, usdEach: number, n: number, result: ProviderAnswer | ProviderFailure): DecisionRecord['cost'] {
  const pricing: Pricing = desc.pricing ?? FIXTURE_PRICING;
  if (pricing.kind !== 'paid') {
    return {
      measured: false, estimate_usd: 0,
      basis: desc.transport === 'fixture' ? 'the fixture transport: no service was called'
        : 'declared free in clef.json ({"free": "local"}: hardware you control, no per-call charge); the machine\'s own cost is not counted',
    };
  }
  const price = estimateCost(est.tokens, questions, pricing);
  const shared = n > 1 ? `; one of ${n} questions in one request, so a ${n}th of it` : '';
  const reported = result.ok && result.usageReported && result.response.usage
    ? `; the service reported ${result.response.usage.input_tokens} input tokens, $${estimateCost(result.response.usage.input_tokens, questions, pricing).usd.toFixed(6)} at the declared price (still not a billed amount)`
    : !result.ok ? '; the call failed, and whether it was billed is not known' : '; no usage was reported';
  return {
    measured: false,
    estimate_usd: usdEach,
    basis: `an estimate, not a measured cost: ${price.words}, the price clef.json declares (${est.words})${shared}${reported}`,
  };
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** One decision, with whether it was the recorded one and where it is kept. */
export async function decideDetailed(input: DecisionInput, ctx: DecideContext = {}): Promise<DecideResult> {
  const [r] = await decideBatch([input], ctx);
  return r;
}

/** One decision record: recommend, abstain (a person decides) or fallback (the deterministic path, its reason recorded). */
export async function decide(input: DecisionInput, ctx: DecideContext = {}): Promise<DecisionRecord> {
  return (await decideDetailed(input, ctx)).record;
}
