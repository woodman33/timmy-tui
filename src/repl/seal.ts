/**
 * C-8: every finished REPL turn is sealed as a receipt through `appendReceipt` (AGENTS.md §6), which
 * signs it with this machine's ed25519 key. Nothing raw is sealed (receipt v2.1): the prompt and the
 * answer go in as SHA-256 hashes. The receipt is verified only when the chain verifies after the write
 * and its own signature checks out; anything else is broken, so its line is never green.
 */
import { createHash } from 'node:crypto';
import type { ChatSurface } from '../contracts/chat-session.js';
import { noteChatTurn } from '../ops/context.js';
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
  /**
   * R4 (H103): the chat's local route (src/agent/local-chat.ts): the Ollama it asked (this computer, or another one), whether
   * tools were offered, the model that answered and the cost's basis. Sealed as via "ollama", model_resolved and a source of
   * kind "ollama"; absent on the OpenRouter route, whose receipts stay as they were.
   */
  route?: {
    host: string; endpoint: 'local' | 'remote'; tools: 'on' | 'off' | 'unknown'; modelResolved?: string; costBasis: 'local endpoint' | 'unknown';
    /** R4 (H113): the last-resort fallback answered after OpenRouter failed: its role, and OpenRouter's failure in a line */
    role?: 'last-resort fallback'; openrouterFailed?: string;
  };
  /**
   * R4 (H113): which surface sent the turn (src/contracts/chat-session.ts ChatSurface): the REPL, the monitor, the terminal
   * Workbench or the companion, named in the subject (sealTurn); absent: the REPL, as every turn before.
   */
  surface?: 'repl' | 'monitor' | 'workbench' | 'companion';
  /** R4 (H113): the model that answered, when the surface knows it apart from a route (the chat session's OpenRouter turns) */
  modelResolved?: string;
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
  const steps = `${facts.steps} ${facts.steps === 1 ? 'step' : 'steps'}`;
  // R4 (H113): one seal for every surface's turn. The REPL's keep kind `turn` ("repl · 2 steps"), as the Control Room, the run
  // detail and the tools ladder read them; another surface's keep kind `chat` (the monitor's CHAT tab reads those), its subject
  // naming the surface, how it ended when not answered, its steps and the model: "chat.turn · workbench · 2 steps · qwen3:8b".
  // src/companion/client/companion.js reads both back for its mirror.
  const surface = facts.surface ?? 'repl';
  const answeredBy = facts.route?.modelResolved ?? facts.modelResolved ?? facts.model;
  const rec = appendReceipt('runs', {
    kind: surface === 'repl' ? 'turn' : 'chat',
    subject: surface === 'repl'
      ? `repl · ${cancelled ? 'cancelled · ' : ''}${steps}`
      : `chat.turn · ${surface} · ${facts.status === 'ok' ? '' : `${facts.status} · `}${steps} · ${answeredBy}`,
    policy: 'human-gated',
    status: facts.status,
    ...(facts.tools?.length ? { tool_outcomes: facts.tools.map((t) => ({ name: t.tool, outcome: t.outcome, ...(t.receipt ? { receipt: t.receipt } : {}) })), outcome_rule: OUTCOME_RULE } : {}),
    // Third order, checkpoint 1: a cancel stops what is left; it never undoes what already ran.
    ...(cancelled ? { cancelled_at: facts.cancelledAt ?? 'before-tools', rollback: 'none' as const } : {}),
    ...(facts.canvas?.length || facts.route ? { sources: [
      ...(facts.route ? [{
        kind: 'ollama', host: facts.route.host, endpoint: facts.route.endpoint, tools: facts.route.tools, cost_basis: facts.route.costBasis,
        ...(facts.route.role ? { role: facts.route.role } : {}), ...(facts.route.openrouterFailed ? { openrouter_failed: facts.route.openrouterFailed } : {}),
      }] : []),
      ...(facts.canvas ?? []).map((c) => ({ kind: 'timmy-canvas', job: c.job, revision: c.revision, source_revision: c.sourceRevision })),
    ] } : {}),
    ...(facts.route ? { via: 'ollama', ...(facts.route.modelResolved ? { model_resolved: facts.route.modelResolved } : {}) } : {}),
    ...(!facts.route?.modelResolved && facts.modelResolved ? { model_resolved: facts.modelResolved } : {}),
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
  // R4 lead: the operation the turn was sealed in ends as the turn did (src/ops/operations.ts decideState), when it started
  // nothing else: a failed turn's request is failed, a stopped one's stopped, never "answered"
  noteChatTurn({ status: facts.status, receipt: rec.hash.slice(7, 15), surface });
  const verified = verify('runs', dir).ok && verifySignature(rec) ? true : 'broken';
  return { id: rec.hash.slice(7, 15), hash: rec.hash, verified };
}

/** R4 lead: the surface a chat turn's receipt names in its subject (kind chat): one of ChatSurface, then a separator or the end. */
const TURN_SURFACE = /^chat\.turn · (repl|monitor|workbench|companion)(?: · |$)/;

/**
 * R4 lead (2026-10-12): a chat turn's receipt, whichever surface sealed it, with that surface: the REPL's (kind turn, "repl ·
 * 2 steps"), another surface's (kind chat: "chat.turn · workbench · 2 steps · qwen3:8b" as sealTurn names it since H113, and
 * "chat.turn · monitor · <model>" as H103's chat session sealed it). Null for any other receipt: the old monitor commander's
 * "chat.turn · commander" is no surface's turn of a project. The Control Room, the run detail and the tools ladder read every
 * surface's turns through this, so a Workbench's turn is counted, costed and named as a REPL's is.
 */
export function chatTurnOf(r: { kind?: unknown; subject?: unknown } | null | undefined): { surface: ChatSurface } | null {
  if (!r) return null;
  if (r.kind === 'turn') return { surface: 'repl' };
  if (r.kind !== 'chat') return null;
  const m = TURN_SURFACE.exec(String(r.subject ?? ''));
  return m ? { surface: m[1] as ChatSurface } : null;
}

/** R4 lead: where a chat turn was sent from, in words (the Control Room's harness, the run detail's). */
export const TURN_FROM: Readonly<Record<ChatSurface, string>> = {
  repl: 'Timmy REPL', monitor: 'Timmy monitor (timmy watch)', workbench: 'Timmy Workbench (timmy workbench)', companion: 'a Timmy companion page',
};
