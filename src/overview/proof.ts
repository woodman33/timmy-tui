/**
 * Round R4 (helper H78): what God's Eye View may say of a run's life, by the proofs recovery and "Waiting on you" already
 * use, never by age alone and never by a record's word alone:
 *   - a job's own process: its record is stale when its process (and its process group) is gone (src/jobs readPersisted);
 *   - the Timmy that started it: the job's record names that REPL by its pid and when it started, and it has ended when no
 *     process with that pid runs now, or the one that does started at another time (src/room/left-runs.ts starterGone,
 *     src/ops/process-proof.ts writerState);
 *   - an operation's record names the process that writes it the same way (writerState);
 *   - a flow that runs has a state file and no record; it is proven running only when this REPL runs it or the job of the
 *     step its state file names is proven running; a flow whose state says running with no such job is stale after
 *     FLOW_QUIET_MS of quiet (recovery's own rule), else unknown.
 * Nothing here signals, stops, writes or seals anything; a process table that cannot be read leaves a run as its record
 * says, never "gone".
 */
import type { JobRecord } from '../jobs/index.js';
import { writerState } from '../ops/process-proof.js';
import { FLOW_QUIET_MS } from '../repl/recover.js';
import { starterGone } from '../room/left-runs.js';
import type { Life } from './model.js';

export const LIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);

/** What is proven of a job: running, left (it runs, its starter has ended), stale (its process is gone), ended, unknown. */
export function jobLife(j: JobRecord | undefined): { life: Life; why?: string } {
  if (!j) return { life: 'unknown', why: 'its job record is not in this Timmy\'s jobs folder, so whether it runs cannot be proven here' };
  if (j.stale) return { life: 'stale', why: `its job record says ${j.state}, and its process is gone (an ended session left it): /recover records it` };
  if (!LIVE_STATES.has(j.state)) return { life: 'ended' };
  if (starterGone(j)) {
    return { life: 'left', why: `it still runs${typeof j.pid === 'number' ? ` in its own process group ${j.pid}` : ''}, and the Timmy that started it has ended (its pid and start, from its job record): /recover settles it` };
  }
  return { life: 'running' };
}

/** What is proven of an operation that its record says runs: the process that writes its record, by pid and start. */
export function operationLife(owner: { pid?: unknown; started?: unknown } | undefined, ended: boolean): { life: Life; why?: string } {
  if (ended) return { life: 'ended' };
  const w = writerState(owner);
  if (w === 'gone') return { life: 'left', why: 'its record says it runs, and the Timmy that began it has ended (no process with its pid and start runs now): /recover ends its record' };
  if (w === 'unknown') return { life: 'unknown', why: 'a process with its pid runs, and the process table could not be read to prove it is the one that began it' };
  return { life: 'running' };
}

/** The record part each flow step keeps its job in (src/repl/iterate*.ts; src/room/decisions.ts STEP_JOB). */
const STEP_JOB: Readonly<Record<string, string>> = { agent: 'agent', build: 'rebuild', blender: 'blender', openscad: 'openscad', freecad: 'freecad', author: 'author', render: 'render', readback: 'readback' };

/**
 * What is proven of a flow whose state file says it runs (it has no record yet): running when this REPL runs it, or when
 * the job of its step is proven running; left or stale as that job is; otherwise stale after FLOW_QUIET_MS without a change,
 * else unknown.
 */
export function flowLife(o: { id: string; record: Record<string, unknown>; written?: string; jobs: ReadonlyMap<string, JobRecord>; activeFlows: readonly string[]; now: number }): { life: Life; why?: string } {
  if (o.activeFlows.includes(o.id)) return { life: 'running', why: 'this REPL runs it' };
  const step = typeof o.record.step === 'string' ? o.record.step : undefined;
  const part = step ? o.record[STEP_JOB[step] ?? ''] : undefined;
  const jobId = part && typeof part === 'object' && typeof (part as Record<string, unknown>).job === 'string' ? (part as Record<string, unknown>).job as string : undefined;
  const job = jobId ? o.jobs.get(jobId) : undefined;
  if (job) {
    const l = jobLife(job);
    if (l.life === 'running') return { life: 'running', why: `the job of its ${step} step (${job.id}) runs, in a Timmy that still runs` };
    if (l.life === 'left' || l.life === 'stale') return { life: l.life, why: `its state file says its ${step} step runs; that step's job ${job.id}: ${l.why}` };
  }
  const written = o.written ? Date.parse(o.written) : Number.NaN;
  const ended = job?.endedAt ? Date.parse(job.endedAt) : Number.NaN;
  const last = Math.max(Number.isFinite(written) ? written : 0, Number.isFinite(ended) ? ended : 0);
  if (last && o.now - last >= FLOW_QUIET_MS) {
    return { life: 'stale', why: `its state file says its ${step ?? '?'} step runs, no job of that step runs here, and nothing about it has changed for ${Math.round((o.now - last) / 60_000)} min: /recover records it` };
  }
  return { life: 'unknown', why: `its state file says its ${step ?? '?'} step runs, and ${jobId ? `that step's job ${jobId} ${job ? 'has ended' : 'is not in this Timmy\'s jobs folder'}` : 'it names no job for that step'}: whether it still runs cannot be proven here` };
}
