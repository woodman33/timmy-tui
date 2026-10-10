/**
 * Round R4 (helper H58, ledger row 157, defect 5): recovery of `/run` jobs a session left running when it ended without
 * its own stop path (a crash, a kill, a closed terminal). src/repl/recover.ts asks this during its pass, at a REPL's start
 * and on /recover; before, such a job's record said "running" for ever and /jobs said its process was gone.
 *
 * A workflow job of this project (kind workflow, its folder this project's) that this REPL did not start, whose record
 * still says it runs:
 *   - its record is stale (no final state, and no process of its group runs; read again after a short wait, since a live
 *     session records its job's end at once): its own record is ended through the job module's writer (JobManager
 *     endLeft) as interrupted: failed, "interrupted: its REPL ended while <block> was running; its process is gone", and
 *     the block its output showed running (its record's running step) is marked interrupted;
 *   - its process group still runs, and the process table proves both that the REPL which started it has ended and that
 *     the group is the job's (recover.ts leftBehind: the record's owner, pid and start time, the rule recovery applies to
 *     a flow's step): the group is stopped (SIGTERM, then SIGKILL after 2 s when some of it still runs; a run on a pty is
 *     the wrapper's group, and the wrapper stops upmd and the blocks it started itself, workers/upmd/pty_run.py), then
 *     its record is ended as interrupted the same way, cancelled, saying the stop;
 *   - a live group that cannot be proven the job's is left alone: the lines say what runs and how to stop it;
 *   - a job a live session still runs is left alone.
 * Nothing is run again: upmd does not resume a run, and neither does Timmy. Each item names `/run <file> <block>`.
 */
import type { JobRecord } from '../jobs/index.js';
import { sameFolder } from '../project/index.js';
import { groupLive } from '../runtime/process-group.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import { runOf } from './board-workflows.js';
import { leftBehind, processTable, SETTLE_MS, STOP_GRACE_MS, type LeftJob, type LeftStop, type Proc, type RecoverDeps, type RecoveryItem } from './recover.js';

export interface WorkflowRecoverDeps {
  /** the project folder looked at */
  root: string;
  /** this REPL's jobs (JobManager: list, get, endLeft) */
  jobs: RecoverDeps['jobs'];
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string) => string;
  /** whether this REPL started the job */
  mine: (jobId: string) => boolean;
  /** false once this REPL is ending: nothing more is stopped or written */
  open: () => boolean;
  settleMs?: number;
  /** test seam: the process table (recover.ts processTable) */
  table?: () => Proc[] | undefined;
}

/** After SIGKILL, how long the group is given to go (the job manager's own wait). */
const KILL_WAIT_MS = 3000;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const LIVE: ReadonlySet<string> = new Set(['running', 'ready']);

/** The run's document and block as /run named them, and the command that runs it again. */
function what(j: JobRecord): { name: string; again: string } {
  const r = runOf(j);
  return r ? { name: `run ${j.id} of ${r.doc} › ${r.target}`, again: `/run ${r.doc} ${r.target}` } : { name: `run ${j.id} (${j.label})`, again: '/run again' };
}

/** What its output showed running when its session ended: the block, or why none can be named. */
function whileWords(j: JobRecord): { words: string; step?: string } {
  const step = j.steps.filter((s) => s.state === 'running').at(-1)?.name;
  if (step) return { words: `while ${step} was running`, step };
  return { words: isLiveRun(j.args) ? 'while no block was running' : 'while it ran (which block was running is not known: upmd wrote to a pipe)' };
}

/** Waits until `done` holds or `ms` pass, on timers that hold the event loop (a typed /recover may be all that runs). */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= end) return false;
    await sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
  return true;
}

/** A live run whose group could not be proven the job's: what runs, why nothing was stopped, and how to stop it. */
function unprovenText(d: WorkflowRecoverDeps, j: JobRecord, left: Extract<LeftJob, { kind: 'unproven' }>): string {
  const cut = (s: string): string => (s.length > 72 ? `${s.slice(0, 71)}…` : s);
  const shown = left.members.slice(0, 4).map((p) => `pid ${p.pid} (${cut(d.scrub(p.args))})`).join(', ');
  const more = left.members.length > 4 ? ` and ${left.members.length - 4} more` : '';
  const runs = left.members.length
    ? `${left.members.length} process${left.members.length === 1 ? '' : 'es'} of its process group ${left.pgid} still run${left.members.length === 1 ? 's' : ''}: ${shown}${more}`
    : `its process group ${left.pgid} may still run`;
  return `${what(j).name} was left running by a REPL that has ended; ${runs}. Nothing was stopped, because ${left.why}: kill -TERM -- -${left.pgid} stops the group (then kill -KILL -- -${left.pgid} if any of it is left), and /recover records it once it has ended`;
}

type Plan = { act: 'gone'; job: JobRecord } | { act: 'stop'; job: JobRecord };

/** Finds and ends the `/run` jobs an ended session left in this project; see the module comment. Never throws for one job. */
export async function recoverWorkflowJobs(d: WorkflowRecoverDeps): Promise<RecoveryItem[]> {
  let all: JobRecord[] = [];
  try { all = d.jobs.list(); } catch { return []; }
  const runs = all.filter((j) => j.kind === 'workflow' && !d.mine(j.id) && (LIVE.has(j.state) || j.stale) && sameFolder(j.root, d.root));
  if (!runs.length) return [];
  let table: Proc[] | undefined | null = null;
  const tableOnce = (): Proc[] | undefined => (table === null ? (table = (d.table ?? processTable)()) : table);
  const items: RecoveryItem[] = [];
  const plans: Plan[] = [];
  for (const j of runs) {
    const w = what(j);
    if (j.stale) { plans.push({ act: 'gone', job: j }); continue; }
    const left = leftBehind(j, tableOnce());
    if (left.kind === 'orphan') { plans.push({ act: 'stop', job: j }); continue; }
    if (left.kind === 'unproven') { items.push({ kind: 'workflow', id: j.id, did: 'left', attention: true, job: j.id, text: unprovenText(d, j, left) }); continue; }
    if (left.kind === 'gone') { items.push({ kind: 'workflow', id: j.id, did: 'left', job: j.id, text: `${w.name}: the processes of its job have just ended: /recover again to record it` }); continue; }
    items.push({ kind: 'workflow', id: j.id, did: 'left', job: j.id, text: `${w.name} still runs (another session${left.why ? `, as far as Timmy can tell: ${left.why}` : ''})` });
  }
  // A stale record is believed only when it is still stale after a moment: a live session records its job's end at once.
  if (plans.some((p) => p.act === 'gone')) await sleep(d.settleMs ?? SETTLE_MS);
  for (const p of plans) {
    const w = what(p.job);
    if (!d.open()) { items.push({ kind: 'workflow', id: p.job.id, did: 'left', job: p.job.id, text: `${w.name}: not recorded, because this REPL is ending` }); continue; }
    try {
      const item = p.act === 'gone' ? endGone(d, p.job) : await stopLeftRun(d, p.job);
      if (item) items.push(item);
    } catch (e) {
      items.push({ kind: 'workflow', id: p.job.id, did: 'failed', job: p.job.id, text: `${w.name} could not be recorded: ${d.scrub(e instanceof Error ? e.message : String(e))}` });
    }
  }
  return items;
}

/** A stale run (its process gone): its record ended as interrupted, failed. Nothing when it is no longer stale. */
function endGone(d: WorkflowRecoverDeps, job: JobRecord): RecoveryItem | undefined {
  const now = d.jobs.get(job.id);
  if (!now?.stale) return undefined;
  const w = what(now);
  const at = whileWords(now);
  const error = `interrupted: its REPL ended ${at.words}; its process is gone`;
  let recorded: JobRecord | undefined;
  try { recorded = d.jobs.endLeft?.(now.id, { state: 'failed', error, interrupted: true }); } catch { recorded = undefined; }
  if (!recorded) return { kind: 'workflow', id: now.id, did: 'failed', job: now.id, text: `${w.name} was interrupted ${at.words} (its REPL ended; its process is gone), but its job record could not be written: /jobs ${now.id} still shows it as it was left` };
  return {
    kind: 'workflow', id: now.id, did: 'interrupted', job: now.id, state: recorded.state,
    text: `${w.name} was interrupted ${at.words}: its REPL ended and its process is gone; its job record now says ${recorded.state}: ${error}; nothing was run again: ${w.again} runs it again`,
  };
}

/**
 * A live run its ended REPL left, proven just before (the table read again now): SIGTERM to its group, SIGKILL after
 * STOP_GRACE_MS when some of it still runs, then its record ended as interrupted, cancelled.
 */
async function stopLeftRun(d: WorkflowRecoverDeps, job: JobRecord): Promise<RecoveryItem | undefined> {
  const now = d.jobs.get(job.id) ?? job;
  const w = what(now);
  if (now.stale) return endGone(d, now);
  if (!LIVE.has(now.state)) return undefined;
  const left = leftBehind(now, (d.table ?? processTable)());
  if (left.kind === 'unproven') return { kind: 'workflow', id: now.id, did: 'left', attention: true, job: now.id, text: unprovenText(d, now, left) };
  if (left.kind !== 'orphan') return { kind: 'workflow', id: now.id, did: 'left', job: now.id, text: left.kind === 'gone' ? `${w.name}: the processes of its job have just ended: /recover again to record it` : `${w.name} still runs (another session)` };
  const pgid = left.pgid;
  const signals: LeftStop['signals'] = ['SIGTERM'];
  killProcessGroup(pgid, 'SIGTERM', { leaderExited: !left.leader });
  let gone = await waitFor(() => !groupLive(pgid), STOP_GRACE_MS);
  if (!gone) {
    signals.push('SIGKILL');
    killProcessGroup(pgid, 'SIGKILL', { leaderExited: !left.leader });
    gone = await waitFor(() => !groupLive(pgid), KILL_WAIT_MS);
  }
  const cleanup = gone ? 'complete' as const : 'unresolved' as const;
  const at = whileWords(now);
  const error = `interrupted: its REPL ended ${at.words}; recovery stopped its process group with ${signals.join(', then ')}${gone ? '' : '; some processes it started did not stop'}`;
  let recorded: JobRecord | undefined;
  try { recorded = d.jobs.endLeft?.(now.id, { state: 'cancelled', error, cleanup, interrupted: true }); } catch { recorded = undefined; }
  const stopped: LeftStop = { job: now.id, process_group: pgid, processes: left.members.length, signals, cleanup, ...(recorded ? { recorded: { state: recorded.state, error: recorded.error ?? error } } : {}) };
  const n = `${left.members.length} process${left.members.length === 1 ? '' : 'es'}`;
  return {
    kind: 'workflow', id: now.id, did: 'interrupted', job: now.id, stopped, ...(recorded ? { state: recorded.state } : {}), ...(gone ? {} : { attention: true }),
    text: `${w.name} was interrupted ${at.words}: its REPL ended and it still ran, so recovery stopped its process group ${pgid} (${n}) with ${signals.join(', then ')}`
      + `${gone ? '' : `, and some of it did not stop: kill -KILL -- -${pgid}`}; ${recorded ? `its job record now says ${recorded.state}: ${error}` : 'its job record could not be written'}; nothing was run again: ${w.again} runs it again`,
  };
}
