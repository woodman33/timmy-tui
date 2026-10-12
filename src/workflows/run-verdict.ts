/**
 * Round R4 (helper H107; r25, the scripted rehearsal on the operator's Mac at 5e5cbb3, findings D2 and D3): a /run's one
 * outcome, read here once for every place a person reads it. Each view used to decide "no change" by itself, and they did
 * not agree: the end line and /jobs said no change, while the block's progress line said "change failed", the block receipt
 * kept state "failed", the run's receipt said "failed", `timmy md --json` gave job state failed, and the board's Jobs section
 * listed a run that made no change as COMPLETED.
 *
 * Kept apart, as the operator asked: Timmy's verdict (the outcome said in every view: "no change" here) and upmd's own
 * verdict (the runner's: it counts any non-zero exit of a block as a failed block and stops its chain there). upmd's verdict
 * stays on record as its own field (`upmd: { state, exit_code }`, in the receipts and in `timmy md --json`) and in words as
 * "upmd counted it as failed: exit 4", never as the run's outcome. The job's own record keeps upmd's states as they came
 * (src/jobs), so nothing written before changes meaning; every reader asks noChangeOf.
 *
 * The rule (R4 H99 and the lead's decision after its review): a /run whose blocks made no change (Timmy's block sealer notes
 * such a block on its step, from the flows the block ran: src/workflows/block-receipts.ts blockOutcome) is "no change"
 *   - when it completed: upmd ran every block and each exited 0 (the last build still matched, so the blocks after it ran on
 *     that build): `current` when every such block found the last build current;
 *   - when upmd stopped at such a block: every block upmd counted as failed made no change (its `timmy act` exited 4: the
 *     last build did not match, so nothing ran on it).
 * Any other run reads as its job's own state. Nothing here reads a file.
 */
import type { JobRecord, JobStep } from '../jobs/index.js';

/** A /run that made no change, as noChangeOf reads it. */
export interface NoChangeRun {
  /** upmd stopped its chain at a block that made no change (it counted that block as failed); false: every block exited 0 */
  stopped: boolean;
  /** the blocks that made no change, in the order they ran */
  steps: JobStep[];
  /** the block its reason names: where upmd stopped, else the first block that made no change */
  at: JobStep;
  /** every block that made no change found the last build current (so the blocks after it ran on that build) */
  current: boolean;
}

/** Whether a /run made no change, and how (see the module comment); undefined for any other job or run. */
export function noChangeOf(j: Pick<JobRecord, 'kind' | 'state' | 'steps'>): NoChangeRun | undefined {
  if (j.kind !== 'workflow') return undefined;
  const still = j.steps.filter((s) => s.outcome === 'no change');
  if (!still.length) return undefined;
  if (j.state === 'completed') return { stopped: false, steps: still, at: still[0], current: still.every((s) => s.current === true) };
  const failed = j.steps.filter((s) => s.state === 'failed');
  if (j.state === 'failed' && failed.length && failed.every((s) => s.outcome === 'no change')) return { stopped: true, steps: still, at: failed[0], current: false };
  return undefined;
}

/** A /run's outcome word, as every view says it: "no change", else its job's own state. */
export const runWord = (j: Pick<JobRecord, 'kind' | 'state' | 'steps'>): string => (noChangeOf(j) ? 'no change' : j.state);

/** A block's word, as every view says it: "no change" for a block that made no change, else its step's own state. */
export const blockWord = (s: Pick<JobStep, 'state' | 'outcome'>): string => (s.outcome === 'no change' ? 'no change' : s.state);

/** upmd's own verdict on a run or a block: its state as upmd gave it and its exit code (null when none was seen). */
export interface UpmdVerdict { state: string; exit_code: number | null }

/** upmd's verdict on a block: its end line (completed, exit 0; failed, any other exit); null when upmd gave none (a block
 *  stopped, interrupted, or still running when its run ended). */
export function upmdBlockVerdict(s: Pick<JobStep, 'state' | 'code'>): UpmdVerdict | null {
  return s.state === 'completed' || s.state === 'failed' ? { state: s.state, exit_code: s.code ?? null } : null;
}

/** upmd's verdict on its run: how its process ended (completed, failed, cancelled) and its exit code, as its job records it. */
export const upmdRunVerdict = (j: Pick<JobRecord, 'state' | 'exitCode'>): UpmdVerdict => ({ state: j.state, exit_code: j.exitCode ?? null });

/** upmd's own word beside "no change" for a block whose exit was not 0: "upmd counted it as failed: exit 4". */
export const upmdCounted = (code: number | undefined | null): string => `upmd counted it as failed: exit ${code ?? '?'}`;
