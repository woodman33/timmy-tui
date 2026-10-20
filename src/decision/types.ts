/**
 * Round R4 (H120): the words of Timmy's decision provider: a question Timmy asks about choices it built itself, what a
 * provider may answer, and the record kept of each decision.
 *
 * The operator's rule it keeps: a decision model scores predefined choices and nothing else. It never writes code, grants a
 * permission, buys anything, raises a worker count, starts compute, skips a review or seals a receipt; OpenRouter stays the
 * conversational agent and the fleet backend the executor. What it answers is a recommendation, labelled one everywhere,
 * and a record of it is never evidence (evidence_kind machine_inference, src/evidence/admission.ts).
 *
 * Nothing here runs, reads or writes; these are types and a few constants.
 */
import type { ClefRequest, ClefResponse } from './clef-contract.js';
import type { Judgement, Thresholds } from './judge.js';
import type { EvidenceKind } from '../evidence/admission.js';
import type { ModelLimits, Pricing } from './pricing.js';

export const DECISION_SCHEMA = 'timmy.decision/1';
export const DECISION_NOTE = 'a model recommendation, not evidence';
export const DECISION_EVIDENCE_KIND = 'machine_inference' satisfies EvidenceKind;

/** route: an available harness or runtime; queue: a queued task's priority; mode: sandbox | review | clarify; vox-review: flag a VoxVision observation for a person. */
export const DECISION_KINDS = ['route', 'queue', 'mode', 'vox-review'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** One choice Timmy offers, from its own capabilities; an unavailable one is never shown to the model. */
export interface DecisionOption {
  id: string;
  label: string;
  /** What the model reads about this option (Clef's criteria). */
  description: string;
  available: boolean;
  unavailableReason?: string;
}

/** A file Timmy might show the model; read only when policy allows sending it, and never kept in a record. */
export interface MediaRef {
  /** Relative to the project, or absolute. */
  path: string;
  kind: 'image' | 'audio' | 'video';
  contentType: string;
  width?: number;
  height?: number;
  seconds?: number;
  /** Private unless marked `false`: only an item marked not private is ever sent. */
  private?: boolean;
}

/** The existing manual or deterministic path the caller names: the option it would pick without a model, and its rule in words. */
export interface DeterministicRule {
  option: string;
  rule: string;
}

export interface DecisionInput {
  kind: DecisionKind;
  /** The Timmy operation this decision belongs to ('o' and 8 hex digits). */
  operationId: string;
  project: { root: string; revision: string; dirty?: boolean };
  intentRef?: string;
  predictionRef?: string;
  instructions: string;
  options: DecisionOption[];
  /** A non-private summary of the situation (Clef's `state`). */
  state: unknown;
  media?: MediaRef[];
  deterministic?: DeterministicRule;
  /** The question's id in the request (default: the kind). Inputs decided in one batch each need their own. */
  questionId?: string;
  /** Idempotency key (default: the sha256 of the canonical input). The same key returns the recorded decision. */
  requestKey?: string;
}

export type TransportKind = 'workers-ai' | 'systemone' | 'fixture';
/** Which kind of endpoint answered: never its address (the Workers AI address holds the account id). */
export type EndpointKind = 'workers-ai-rest' | 'systemone-loopback' | 'systemone-remote' | 'fixture-file';

export interface ProviderDescription {
  /** The transport and the model, as `<transport>:<model>` (systemone:clef-flash:latest); clef-omni only for Clef-Omni. */
  id: string;
  available: boolean;
  reason?: string;
  transport: TransportKind | 'none';
  endpoint?: EndpointKind;
  /** R9 (H162): the model asked for, as clef.json names it (Workers AI's default: @cf/cloudflare/clef-omni). */
  model: string;
  /** What the request body's `model` says: "clef-omni" for Workers AI's Clef-Omni (its published body), else `model`. */
  requestModel: string;
  /** May cost money per call: declared paid, or pricing unknown. False only for a declared {"free": "local"}, or no call at all. */
  paid: boolean;
  /** The model runs on this computer: a loopback address (or a file), and a model tag that is not a cloud tag. */
  local: boolean;
  /** The model's tag is a cloud tag: what it is given leaves this computer, from a loopback address too. */
  cloudModel: boolean;
  /** As declared in clef.json (src/decision/pricing.ts): free: local, paid, unknown, or no call. */
  pricing: Pricing;
  /** The model's limits: Clef-Omni's published ones, those clef.json states, or a conservative default. */
  limits: ModelLimits;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  /** The fixture transport's response file (tests and the offline slice only). */
  fixture?: string;
}

/** A response as kept: its digest and size, and its body redacted when it is small enough to keep. */
export interface RawRef {
  sha256: string;
  bytes: number;
  body?: string;
}

export interface ProviderAnswer {
  ok: true;
  response: ClefResponse;
  usageReported: boolean;
  latencyMs: number;
  raw: RawRef;
}

export interface ProviderFailure {
  ok: false;
  kind: 'unavailable' | 'timeout' | 'malformed';
  /** In words, with every secret taken out. */
  reason: string;
  latencyMs: number;
  raw?: RawRef;
}

export interface DecisionProvider {
  readonly id: string;
  describe(): ProviderDescription;
  decide(request: ClefRequest, o: ProviderCallOptions): Promise<ProviderAnswer | ProviderFailure>;
}

/** Why the deterministic path was used instead of asking, or instead of the answer. */
export type FallbackReason =
  | 'clef-off' | 'unavailable' | 'timeout' | 'malformed' | 'egress-denied' | 'budget' | 'stale-revision' | 'unresolved-inputs' | 'too-few-options'
  /** R9 (H162): the pricing is unknown (none declared, or declared free for a cloud model tag): never taken as free or zero. */
  | 'pricing';

export const ADMISSION_CHECKS = ['projectScope', 'privacy', 'budget', 'concurrency', 'isolation', 'approvals'] as const;
export type AdmissionCheckName = (typeof ADMISSION_CHECKS)[number];
/** A check the caller made, in its own words. A check not supplied is never taken as passed. */
export interface AdmissionCheck { ok: boolean; words: string }
export type AdmissionChecks = Partial<Record<AdmissionCheckName, AdmissionCheck>>;

/** Admission answers only whether a proposal may go on to dispatch, with reasons; it never grants anything itself. */
export interface Admission {
  of: 'recommendation' | 'fallback' | 'nothing';
  option?: string;
  admitted: boolean;
  /** A person approves before anything is dispatched. */
  needsReview: boolean;
  reasons: string[];
  checked: Record<AdmissionCheckName, 'ok' | 'refused' | 'not supplied'>;
  at: string;
}

export interface MediaRecord {
  ref: string;
  kind: MediaRef['kind'];
  contentType: string;
  bytes?: number;
  sha256?: string;
  sent: boolean;
  reason?: string;
}

export interface DecisionRecord {
  schema: typeof DECISION_SCHEMA;
  id: string;
  createdAt: string;
  kind: DecisionKind;
  /** The question's id in the request. */
  question: string;
  operationId: string;
  project: { revision: string; dirty?: boolean };
  intentRef?: string;
  predictionRef?: string;
  requestKey: string;
  instructions: string;
  provider: { id: string; transport: TransportKind | 'none'; endpoint?: EndpointKind; model?: string; paid: boolean; local: boolean };
  options: {
    permitted: Array<{ id: string; label: string; description: string }>;
    excluded: Array<{ id: string; label: string; reason: string }>;
    needsReview: { id: string; label: string };
  };
  thresholds: Thresholds;
  /** The model's probabilities over the permitted options and needs_review (only from an answer that passed the checks). */
  distribution?: Record<string, number>;
  /** The model's probability that a person should review this (the human_review question). */
  humanReview?: number;
  judge?: Judgement;
  recommendation?: { option: string; label: string; top: number; margin: number };
  inputs: { state: { sha256: string; bytes: number }; media: MediaRecord[] };
  response?: RawRef;
  latencyMs?: number;
  usage?: { input_tokens: number; output_tokens: number; sharedBy?: number };
  cost: { measured: false; estimate_usd: number; basis: string };
  outcome: 'recommend' | 'abstain' | 'fallback';
  /** The deterministic path: used for a fallback; for a recommendation or an abstention, the proposal shown beside it. */
  fallback: { used: boolean; reasonKind?: FallbackReason; reason?: string; option?: string; rule: string };
  admission: Admission;
  /** When several questions went in one request. */
  batch?: { size: number; request_sha256: string };
  evidence_kind: typeof DECISION_EVIDENCE_KIND;
  note: typeof DECISION_NOTE;
}
