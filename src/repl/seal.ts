/**
 * C-8: every finished REPL turn is sealed as a receipt through `appendReceipt` (AGENTS.md §6), which
 * signs it with this machine's ed25519 key. Nothing raw is sealed (receipt v2.1): the prompt and the
 * answer go in as SHA-256 hashes. The receipt is verified only when the chain verifies after the write
 * and its own signature checks out; anything else is broken, so its line is never green.
 */
import { createHash } from 'node:crypto';
import { appendReceipt, verifyChain, verifySignature, type VerifyResult } from '../utils/receipts.js';

/** How a tool in the turn actually ended; `unknown` = still running when the turn ended. */
export interface ToolOutcome {
  tool: string;
  outcome: 'completed' | 'failed' | 'unknown';
  /** R4 (H30): the tool's own receipt, where it sealed what it spent (describe_image's observe receipt). */
  receipt?: string;
}

/** Where a cancel came: before any tool started, while one ran, or after the tools, before the answer. */
export type CancelStage = 'before-tools' | 'during-tool' | 'after-tools';

export interface TurnFacts {
  prompt: string;
  answer: string;
  steps: number;
  /**
   * What OpenRouter charged for the turn's own requests, in dollars (LIVE-01, ledger row 65). R4 (H30): a tool that
   * asks a model in a request of its own (describe_image) seals that charge on its own receipt, named in `tools`;
   * it is not added here, so no charge is sealed twice.
   */
  spend: number;
  /**
   * True when `spend` is the whole charge OpenRouter reported; false when it is a lower bound (a cancel,
   * or a response with no charge reported). Sealed as `cost_measured`: aggregators never sum a lower
   * bound as measured dollars.
   */
  costMeasured?: boolean;
  ms: number;
  status: 'ok' | 'failed' | 'cancelled';
  tools?: ToolOutcome[];
  cancelledAt?: CancelStage;
  /** R1 workspace direction: the active project, and the files the turn's tools wrote in it (hashes only). */
  project?: string;
  /** the project's identity without its path (src/project projectId) */
  projectId?: string;
  files?: Array<{ path: string; sha256: string; previous_sha256?: string; created: boolean; bytes: number }>;
  /** Fourth order, step 5: the turn's Timmy Canvas jobs, each with the revision and source revision it left. */
  canvas?: Array<{ job: string; revision: number; sourceRevision: string }>;
}

export interface SealedTurn {
  /** The short hash shown on the receipt line. */
  id: string;
  hash: string;
  verified: true | 'broken';
  /** The receipt's page (C-13), when Timmy serves it. */
  url?: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * How this REPL decides a tool step's outcome, sealed into each turn as `outcome_rule`. 2 (round R1):
 * the tool's own answer decides, so success:false, ok:false or an error is sealed failed. Turns with no
 * rule were sealed before R1, when every finished step was sealed completed, mock answers included.
 */
export const OUTCOME_RULE = 2;

export function sealTurn(
  facts: TurnFacts & { model: string },
  dir?: string,
  verify: (stream: string, dir?: string) => Pick<VerifyResult, 'ok'> = verifyChain,
): SealedTurn {
  const cancelled = facts.status === 'cancelled';
  const rec = appendReceipt('runs', {
    kind: 'turn',
    subject: `repl · ${cancelled ? 'cancelled · ' : ''}${facts.steps} ${facts.steps === 1 ? 'step' : 'steps'}`,
    policy: 'human-gated',
    status: facts.status,
    ...(facts.tools?.length ? { tool_outcomes: facts.tools.map((t) => ({ name: t.tool, outcome: t.outcome, ...(t.receipt ? { receipt: t.receipt } : {}) })), outcome_rule: OUTCOME_RULE } : {}),
    // Third order, checkpoint 1: a cancel stops what is left; it never undoes what already ran.
    ...(cancelled ? { cancelled_at: facts.cancelledAt ?? 'before-tools', rollback: 'none' as const } : {}),
    ...(facts.canvas?.length ? { sources: facts.canvas.map((c) => ({ kind: 'timmy-canvas', job: c.job, revision: c.revision, source_revision: c.sourceRevision })) } : {}),
    ...(facts.project ? { project: facts.project } : {}),
    ...(facts.projectId ? { project_id: facts.projectId } : {}),
    ...(facts.files?.length ? { files: facts.files } : {}),
    prompt_hash: sha256(facts.prompt),
    response_hash: sha256(facts.answer),
    model_requested: facts.model,
    cost_usd: facts.spend,
    cost_measured: facts.costMeasured === true,
    ms: Math.round(facts.ms),
  }, dir);
  const verified = verify('runs', dir).ok && verifySignature(rec) ? true : 'broken';
  return { id: rec.hash.slice(7, 15), hash: rec.hash, verified };
}
