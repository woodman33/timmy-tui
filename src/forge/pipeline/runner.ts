// Thin I/O layer over the pure pipeline state machine (states.ts).
// All persistence goes through appendLedger; the runner never generates or
// judges — Task 10+ wires the actors.
//
// Admission and closure serialize across processes under a store-scoped pipeline
// lock, separate from the ledger append lock. New closes name the exact open
// sequence. Transitions without that identity refuse ambiguous multi-segment
// exits before writing; legacy closes match their complete submission triple.
//
// Crash-recovery contract (v1):
// - recordRunStarted appends a pipeline_run_started record BEFORE the
//   generation call, so a crash during generation leaves evidence that a
//   run was in flight. On resume the operator inspects unmatched
//   run_started records (no subsequent pipeline_stage record for the run)
//   and reconciles with the provider (cancel/refund path).
// - A crash can also leave a submission open with no close record. There is
//   NO automatic reaping in v1: after a crash, the operator/orchestrator
//   determines the last-known-good ledger seq and calls
//   closeStaleSubmissions(dir, beforeSeq) to reap stale opens before
//   resuming — reaping is an operator-authorized action because a close
//   asserts the run is dead.
//
// Failure semantics:
// - recordTransition writes 1–3 records non-atomically (pipeline_stage,
//   optionally pipeline_toxic, optionally a submission close). If
//   appendLedger throws mid-write, the in-memory state may be ahead of the
//   ledger. Callers must treat a throw as 'ledger state unknown' and
//   reconcile before retrying — never blind-retry a paid run.
// - Reads request verified chains. Complete malformed-line refusal additionally
//   depends on the strict ledger repair; this module never repairs history.
//
// Limitations (v1): no counters or snapshots are persisted; at_seq values
// in the pure machine's history are history.length, and recordTransition
// returns the ledger seq of the pipeline_stage record it wrote — callers
// pair that seq with the next state themselves when building snapshots.
import { join } from 'node:path';
import { rootStoreDir, withLockDir } from '../../utils/receipts.js';
import { appendLedger, readLedger, type LedgerRecord } from '../ledger.js';
import type { EventName, PipelineState, Stage } from './states.js';
import type { OrchestratorMode } from './orchestrator.js';

export interface Submission {
  mission_id: string;
  prompt_version_id: string;
  segment: string;
}

export type SubmitResult = { ok: true; at_seq: number } | { ok: false; reason: string };

export interface RunStarted {
  mission_id: string;
  prompt_version_id: string;
  segment: string;
  stage: 'probe' | 'full_render';
  endpoint: string;
  plan_seq: number;
}

interface OpenSubmission {
  mission_id: string;
  prompt_version_id: string;
  segment: string;
  seq: number; // ledger seq of the open record
}

function withPipelineLock<T>(dir: string, action: () => T): T {
  const store = process.env.TIMMY_STORE && dir === process.cwd()
    ? process.env.TIMMY_STORE : (rootStoreDir(dir) ?? join(dir, '.timmy'));
  return withLockDir(join(store, 'forge', '.pipeline-lock'), action);
}

function tuple(s: Submission): string {
  return JSON.stringify([s.mission_id, s.prompt_version_id, s.segment]);
}
function validateSubmission(s: Submission): void {
  for (const key of ['mission_id', 'prompt_version_id', 'segment'] as const) {
    if (typeof s[key] !== 'string' || !s[key].trim()) throw new Error(`invalid submission ${key}`);
  }
}

function openSubmissions(dir: string): OpenSubmission[] {
  const rows = readLedger(dir, { verify: true }).filter(r => r.kind === 'pipeline_submission');
  const opens = new Map<number, OpenSubmission>();
  for (const r of rows) {
    const submission = { mission_id: r.mission_id, prompt_version_id: r.prompt_version_id, segment: r.segment } as Submission;
    validateSubmission(submission);
    if (r.action === 'open') {
      opens.set(r.seq, { ...submission, seq: r.seq });
    } else if (r.action === 'close') {
      if (Object.hasOwn(r, 'open_seq')) {
        if (typeof r.open_seq !== 'number' || !Number.isSafeInteger(r.open_seq) || r.open_seq < 0 || r.open_seq >= r.seq) {
          throw new Error('invalid submission close sequence');
        }
        const open = opens.get(Number(r.open_seq));
        if (open && tuple(open) !== tuple(submission)) throw new Error('submission close identity mismatch');
        opens.delete(Number(r.open_seq));
      } else {
        // Retained legacy closes carry a triple but no unique open sequence.
        const matches = [...opens.values()].filter(o => tuple(o) === tuple(submission));
        if (matches.length > 1) throw new Error('ambiguous legacy submission close');
        if (matches[0]) opens.delete(matches[0].seq);
      }
    } else throw new Error('invalid submission action');
  }
  return [...opens.values()];
}

export function submitMission(dir: string, mission: Submission): SubmitResult {
  validateSubmission(mission);
  return withPipelineLock(dir, () => {
    const rows = readLedger(dir, { verify: true });
    if (rows.some(r => r.prompt_version_id === mission.prompt_version_id &&
        (r.kind === 'pipeline_toxic' || (r.kind === 'pipeline_stage' && r.event === 'nsfw')))) {
      return { ok: false, reason: 'toxic prompt version — refusing to rerun' };
    }
    if (openSubmissions(dir).some(o => tuple(o) === tuple(mission))) {
      return { ok: false, reason: 'duplicate submission in flight' };
    }
    const rec = appendLedger({ kind: 'pipeline_submission', ...mission, action: 'open' }, dir);
    return { ok: true, at_seq: rec.seq };
  });
}

// Crash-recovery (v1, operator-authorized): append close records for every
// open submission whose open-record seq is strictly < beforeSeq, and return
// the count closed. A close asserts the run is dead — the operator
// determines the last-known-good ledger seq after a crash; there is no
// automatic reaping.
export function closeStaleSubmissions(dir: string, beforeSeq: number, reason = 'reaped'): number {
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) throw new Error('invalid reap sequence');
  return withPipelineLock(dir, () => {
    const stale = openSubmissions(dir).filter(o => o.seq < beforeSeq);
    for (const o of stale) {
      appendLedger({ kind: 'pipeline_submission', mission_id: o.mission_id,
        prompt_version_id: o.prompt_version_id, segment: o.segment,
        action: 'close', open_seq: o.seq, reason }, dir);
    }
    return stale.length;
  });
}

// Pre-spend evidence (v1 crash-recovery contract): write BEFORE the
// generation call so a crash during generation leaves a record that a run
// was in flight. On resume the operator inspects unmatched run_started
// records (no subsequent pipeline_stage record) and reconciles with the
// provider (cancel/refund path).
export function recordRunStarted(dir: string, r: RunStarted): number {
  return appendLedger({ kind: 'pipeline_run_started', ...r }, dir).seq;
}

// Orchestrator mode transitions (Task 10): entering autonomous on operator
// plan approval, the balance hard stop back to approval, and operator
// reapproval after a stop. Callers own the in-memory OrchestratorState; this
// is the receipt that the switch happened.
export interface ModeSwitch {
  mission_id: string;
  from: OrchestratorMode;
  to: OrchestratorMode;
  reason: string;
}

export function recordModeSwitch(dir: string, sw: ModeSwitch): LedgerRecord {
  return appendLedger({ kind: 'orchestrator_mode', ...sw }, dir);
}

// The in-flight region spans the whole paid path: probe, probe_judging (the
// probe result is being judged with spend already incurred), and
// full_render. Moves within the region (probe→probe_judging, probe_judging→
// full_render) keep the submission open; any exit out of the region —
// including probe_judging→iterate, a routine judge rejection — closes it.
const IN_FLIGHT_REGION: ReadonlySet<Stage> = new Set(['probe', 'probe_judging', 'full_render']);

export function recordTransition(
  dir: string,
  prev: PipelineState,
  next: PipelineState,
  event: EventName,
  submissionSeq?: number
): number {
  if (prev.mission_id !== next.mission_id || prev.prompt_version_id !== next.prompt_version_id) {
    throw new Error('transition identity mismatch');
  }
  return withPipelineLock(dir, () => {
    const exits = IN_FLIGHT_REGION.has(prev.stage) && !IN_FLIGHT_REGION.has(next.stage);
    let closing: OpenSubmission | undefined;
    if (exits) {
      const opens = openSubmissions(dir).filter(o => o.mission_id === next.mission_id &&
        o.prompt_version_id === next.prompt_version_id);
      if (submissionSeq !== undefined) {
        if (!Number.isSafeInteger(submissionSeq) || submissionSeq < 0) throw new Error('invalid submission sequence');
        closing = opens.find(o => o.seq === submissionSeq);
        if (!closing) throw new Error('submission is no longer open');
      } else {
        if (opens.length > 1) throw new Error('ambiguous submission: exact open sequence required');
        closing = opens[0];
      }
    }
    const rec = appendLedger(
      {
        kind: 'pipeline_stage',
        mission_id: next.mission_id,
        prompt_version_id: next.prompt_version_id,
        from: prev.stage,
        to: next.stage,
        event,
      },
      dir
    );
    if (event === 'nsfw') {
      appendLedger({ kind: 'pipeline_toxic', prompt_version_id: next.prompt_version_id }, dir);
    }
    if (closing) {
      appendLedger({ kind: 'pipeline_submission', mission_id: closing.mission_id,
        prompt_version_id: closing.prompt_version_id, segment: closing.segment,
        action: 'close', open_seq: closing.seq }, dir);
    }
    return rec.seq;
  });
}
