/**
 * R4 lead (2026-10-11, the operator's Workbench direction): the ONE run detail every surface renders: the terminal Workbench
 * (src/workbench/**), the companion, Timmy Studio's operation cards and the live board. "Use one shared Run detail view,
 * linkable from Chat, Studio nodes, Activity, Control Room, God's Eye View and result cards."
 *
 * Made only by src/ops/run-detail.ts, from the records that exist (operations, jobs, receipts, flows, evidence by id); no
 * surface computes its own. Every value says where it came from (`from`: a record path relative to the project, or a receipt
 * id). What no record says is listed in `unknown` with why, never guessed. Kept apart, as the operator asked: the workflow
 * stage, each process's or runner's exit, Timmy's verdict, the artifact's freshness and a person's acceptance. A change of a
 * field's meaning bumps RUN_DETAIL_VERSION; the producer and every renderer change together, through the lead.
 */
export const RUN_DETAIL_VERSION = 1 as const;

/** Timmy's verdict, in src/ops/outcome.ts's words. Never derived from an exit code alone. */
export type RunVerdict = 'queued' | 'running' | 'needs you' | 'completed' | 'no change' | 'failed' | 'cancelling' | 'cancelled' | 'recovered' | 'unknown';

/** A value and the record it was read from. */
export interface Sourced<T> { value: T; from: string }

export type RunFileRole = 'input' | 'reference' | 'source' | 'native' | 'preview' | 'output' | 'log' | 'record';

export interface RunDetail {
  version: typeof RUN_DETAIL_VERSION;
  /** o + 8 hex */
  operation: string;
  parent: string | null;
  children: string[];
  project: { name: string; root: string; id: string };
  /** the request's own words */
  objective: Sourced<string> | null;
  /** the project's revision the run started from, where a record names one */
  sourceRevision: Sourced<string> | null;
  /** Timmy's verdict */
  verdict: { state: RunVerdict; words: string; from: string };
  /** the workflow stage: steps done of total, never a percentage */
  stage: { current: string | null; done: number; total: number | null; from: string };
  /** each process's or runner's own exit (upmd's count included): kept apart from the verdict */
  exits: Array<{ who: string; code: number | null; state?: string; from: string }>;
  /** the artifact against its recorded inputs */
  freshness: { state: 'current' | 'stale' | 'unknown'; why: string; from?: string };
  /** a person's review of the result */
  acceptance: { state: 'not reviewed' | 'accepted' | 'rejected'; by?: string; at?: string; from?: string };
  worker: { model?: Sourced<string>; harness?: Sourced<string>; environment?: Sourced<string> };
  time: { startedAt: string | null; endedAt: string | null; elapsedMs: number | null };
  /** frozen before the result; never shown as an observed receipt */
  prediction: { words: string; receipt: string; frozenAt: string | null } | null;
  checks: Array<{ name: string; predicted: string | null; actual: string; differs: boolean | null; from: string }>;
  files: Array<{ path: string; role: RunFileRole; sha256?: string; from: string }>;
  receipts: Array<{ id: string; kind: string; subject?: string }>;
  /** a reported number, or unknown with why; never an invented 0 */
  cost: { usd: number; measured: true; from: string } | { usd: null; measured: false; why: string };
  /** the executive summary in Markdown, when one was saved beside the records */
  summary: { path: string | null };
  next: { words: string; command?: string } | null;
  unknown: Array<{ field: string; why: string }>;
}
