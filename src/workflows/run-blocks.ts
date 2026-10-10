/**
 * Round R4 (helper H67, ledger row 162, r20 on the Mac): one reading of a /run job's blocks for each view of it (the board's
 * connected workflow card and `/workflows <file>` through src/repl/board-workflows.ts, and `/jobs <id>`): every block of
 * the order the run was to run, in that order, with its state in words, its exit code, its own time and who saw its end.
 * Before, the card read them itself and `/jobs` listed only the steps Timmy had seen, without their own times.
 *
 * A block with no step of its own in the record:
 *   waiting     the run goes on and no block has failed
 *   not run     the run ended with Timmy following it (upmd's own output showed every block it ran, and a failed block
 *               stops upmd's chain), or its REPL ended and the wrapper's stop file proved upmd was stopped (or had ended)
 *               before the block could start (src/workflows/pty-stop.ts; the record's interrupted.rest)
 *   not seen    its REPL ended while the run went on, and nothing proves upmd did not go on: "its REPL had ended, and upmd
 *               may have gone on until it ended" (a stale record, or one recovery ended without such proof)
 */
import type { JobRecord, JobStep } from '../jobs/index.js';
import { isLiveRun } from './upmd-live.js';

export type RunBlockWord = 'waiting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'not run' | 'not seen' | 'unknown';
/** R4 (H74): `receipt`, the block's own receipt (its short id; src/workflows/block-receipts.ts), when the caller gave them. */
export interface RunBlock { name: string; word: RunBlockWord; code?: number; ms?: number; seen?: 'wrapper'; receipt?: string }
type RunRecord = Pick<JobRecord, 'state' | 'stale' | 'interrupted' | 'steps' | 'args'>;

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Why a block reads 'not seen'. */
export const NOT_SEEN_WHY = 'its REPL had ended, and upmd may have gone on until it ended';
/** What a block whose end only the wrapper saw is said with. */
export const SEEN_BY_WRAPPER = 'seen by its pty wrapper (its stop file), not by Timmy';

/** A step's own time, from the moments its start and its end were seen (both recorded by a run with live states). */
export function stepMs(s: JobStep): number | undefined {
  const a = s.startedAt ? Date.parse(s.startedAt) : Number.NaN;
  const b = s.endedAt ? Date.parse(s.endedAt) : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined;
}

/** A duration as the card says it. */
export const secondsText = (ms: number): string => (ms < 100 ? '<0.1 s' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** Whether the REPL that ran it ended while it ran: its record stale, or ended so by a later session's recovery. */
export const replEnded = (j: Pick<JobRecord, 'stale' | 'interrupted'>): boolean => !!j.stale || !!j.interrupted;

/**
 * The run's blocks: those of `order` (the order it was to run them), then any other step it recorded, each with its state.
 * `clock` gives a step's own time where its record has no moments (this REPL's own runs; src/repl/board-workflows.ts
 * StepClock). Only a run on a pty has own times: over a pipe each block was seen only as it ended. R4 (H74): `receipts`,
 * the run's block receipts by block name (src/workflows/block-receipts.ts blockReceiptsOf): each block names its own.
 */
export function runBlocks(j: RunRecord, order: readonly string[], clock?: (i: number) => number | undefined, receipts?: ReadonlyMap<string, { receipt: string }>): RunBlock[] {
  const steps = j.steps;
  const live = !j.stale && !TERMINAL.has(j.state);
  const ended = replEnded(j);
  const pty = isLiveRun(j.args);
  // upmd stops the chain at a failing block: no block after it runs, even before the run has ended
  const chainStopped = steps.some((s) => s.state === 'failed');
  const rest: RunBlockWord = !ended || chainStopped || (!j.stale && j.interrupted?.rest === 'not run') ? 'not run' : 'not seen';
  const names = [...order, ...steps.map((s) => s.name).filter((n) => !order.includes(n))];
  return names.map((name) => {
    let at = -1;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].name === name) { at = i; break; }
    const s = at >= 0 ? steps[at] : undefined;
    const ms = !pty || !s ? undefined : stepMs(s) ?? clock?.(at);
    let word: RunBlockWord;
    if (!s) word = live && !chainStopped ? 'waiting' : rest;
    else if (s.state !== 'running') word = s.state;
    else word = live ? 'running' : ended ? 'interrupted' : j.state === 'cancelled' ? 'stopped' : 'unknown';
    // R4 (H74): a block that started has its own receipt once it has ended (a block that never started has none)
    const receipt = s ? receipts?.get(name)?.receipt : undefined;
    return { name, word, ...(s?.code !== undefined ? { code: s.code } : {}), ...(ms !== undefined ? { ms } : {}), ...(s?.seen ? { seen: s.seen } : {}), ...(receipt ? { receipt } : {}) };
  });
}

/** A block's few words after its state: its exit code, its own time, and who saw its end when Timmy did not. */
export function blockDetail(b: Pick<RunBlock, 'code' | 'ms' | 'seen'>, o: { seen?: 'short' | 'long' } = {}): string {
  return [
    b.code !== undefined ? `exit ${b.code}` : '', b.ms !== undefined ? secondsText(b.ms) : '',
    b.seen === 'wrapper' ? (o.seen === 'long' ? SEEN_BY_WRAPPER : 'seen by its wrapper') : '',
  ].filter(Boolean).join(' · ');
}
