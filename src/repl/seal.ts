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
}

/** Where a cancel came: before any tool started, while one ran, or after the tools, before the answer. */
export type CancelStage = 'before-tools' | 'during-tool' | 'after-tools';

export interface TurnFacts {
  prompt: string;
  answer: string;
  steps: number;
  spend: number;
  ms: number;
  status: 'ok' | 'failed' | 'cancelled';
  tools?: ToolOutcome[];
  cancelledAt?: CancelStage;
  /** Fourth order, step 5: the turn's Timmy Canvas job, and the revision and source revision it left. */
  canvas?: { job: string; revision: number; sourceRevision: string };
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
    ...(facts.tools?.length ? { tool_outcomes: facts.tools.map((t) => ({ name: t.tool, outcome: t.outcome })) } : {}),
    // Third order, checkpoint 1: a cancel stops what is left; it never undoes what already ran.
    ...(cancelled ? { cancelled_at: facts.cancelledAt ?? 'before-tools', rollback: 'none' as const } : {}),
    ...(facts.canvas ? { sources: [{ kind: 'timmy-canvas', job: facts.canvas.job, revision: facts.canvas.revision, source_revision: facts.canvas.sourceRevision }] } : {}),
    prompt_hash: sha256(facts.prompt),
    response_hash: sha256(facts.answer),
    model_requested: facts.model,
    cost_usd: facts.spend,
    ms: Math.round(facts.ms),
  }, dir);
  const verified = verify('runs', dir).ok && verifySignature(rec) ? true : 'broken';
  return { id: rec.hash.slice(7, 15), hash: rec.hash, verified };
}
