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
 *
 * Round R4 (helper H67, ledger row 162, r20 on the Mac): the record says only what is known. The pty wrapper stops upmd
 * itself as soon as its REPL has ended, and writes what it saw to its stop file (`--stop-file`, in the run's own folder:
 * src/workflows/pty-stop.ts). Its record is then ended with that account: the blocks whose end it saw and the REPL did not
 * are recorded as it saw them (marked seen by the wrapper), the block running when it stopped upmd is interrupted, and the
 * blocks after it are 'not run' only where the file proves upmd could not start them; a run upmd ended by itself while its
 * REPL no longer followed it is recorded completed or failed as the wrapper saw it (did 'judged'). Without such a file (a run over a
 * pipe, a wrapper that was itself killed, a record from before), the blocks after the running one are 'not seen': its REPL
 * had ended, and upmd may have gone on until it ended.
 *
 * Round R4 (helper H74): once a run's record is ended, the block receipts it still needs are sealed (`blocks`, the
 * Workspace's src/repl/workflow-blocks.ts sealLeftBlocks): the block that was running is sealed interrupted (its REPL ended),
 * and each block whose end only its pty wrapper saw is sealed as the wrapper saw it; a block the REPL sealed before it ended
 * is not sealed again, and a block that never started gets none. Each names the run's operation.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { sameFolder } from '../project/index.js';
import { groupLive } from '../runtime/process-group.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import { mergePtyStop, readPtyStop, wrapperDid, type PtyStop } from '../workflows/pty-stop.js';
import { parseWorkflow, type WorkflowBlock } from '../workflows/upmd.js';
import { isLiveRun, wrapperStopFile } from '../workflows/upmd-live.js';
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
  /** R4 (H74): seals the block receipts a run ended here still needs, from its record as written; the receipts sealed */
  blocks?: (job: JobRecord) => Array<{ name: string; receipt: string }>;
}

/** R4 (H74): the block receipts a run ended here still needs, sealed from its record as recovery wrote it, in words. */
function sealBlocks(d: WorkflowRecoverDeps, recorded: JobRecord | undefined): string {
  if (!recorded || !d.blocks) return '';
  let sealed: Array<{ name: string; receipt: string }> = [];
  try { sealed = d.blocks(recorded); } catch { sealed = []; }
  return sealed.length ? `; ${sealed.map((b) => `block ${b.name}: receipt ${b.receipt}`).join(', ')}` : '';
}

/** After SIGKILL, how long the group is given to go (the job manager's own wait). */
const KILL_WAIT_MS = 3000;
/** A run's document is read for its blocks' names only up to this size. */
const DOC_MAX = 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const LIVE: ReadonlySet<string> = new Set(['running', 'ready']);
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

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

/** R4 (H67): the blocks the run was to run (its record's order, sealed before it ran) that it has no step of. */
function unrecorded(j: Pick<JobRecord, 'expected'>, steps: JobRecord['steps']): string[] {
  return (j.expected?.steps ?? []).filter((name) => !steps.some((s) => s.name === name));
}

/** R4 (H67): the run's pty wrapper's stop file, read and checked, or why there is none to go by. */
function wrapperFile(j: JobRecord): { stop: PtyStop } | { why: string } {
  if (!isLiveRun(j.args)) return { why: 'it ran over a pipe, with no pty wrapper to tell' };
  const file = wrapperStopFile(j.args);
  if (!file || !isAbsolute(file)) return { why: 'its pty wrapper was given no stop file' };
  const read = readPtyStop(file, j);
  return read.ok ? { stop: read.stop } : { why: read.why };
}

/** R4 (H67): names a block by its number from the run's document, when upmd's count is the document's count of blocks. */
function blockNamer(j: JobRecord): (n: number, count?: number) => string | undefined {
  let blocks: WorkflowBlock[] | undefined;
  return (n, count) => {
    if (!blocks) {
      blocks = [];
      const file = j.args.at(-1);
      try { if (file && isAbsolute(file) && statSync(file).size <= DOC_MAX) blocks = parseWorkflow(readFileSync(file, 'utf8')); } catch { blocks = []; }
    }
    return count !== undefined && count === blocks.length ? blocks[n - 1]?.name : undefined;
  };
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

/** A stale run (its process gone): its record ended with its wrapper's account when it left one, else as interrupted,
 *  failed. Nothing when it is no longer stale. */
function endGone(d: WorkflowRecoverDeps, job: JobRecord): RecoveryItem | undefined {
  const now = d.jobs.get(job.id);
  if (!now?.stale) return undefined;
  const told = wrapperFile(now);
  if ('stop' in told) return endFromWrapper(d, now, told.stop);
  const w = what(now);
  const at = whileWords(now);
  // R4 (H67): what came after the block it showed running is not known
  const unseen = unrecorded(now, now.steps);
  const error = `interrupted: its REPL ended ${at.words}; its process is gone${notSeen(told.why, unseen)}`;
  let recorded: JobRecord | undefined;
  try { recorded = d.jobs.endLeft?.(now.id, { state: 'failed', error, interrupted: { rest: 'not seen' } }); } catch { recorded = undefined; }
  if (!recorded) return { kind: 'workflow', id: now.id, did: 'failed', job: now.id, text: `${w.name} was interrupted ${at.words} (its REPL ended; its process is gone), but its job record could not be written: /jobs ${now.id} still shows it as it was left` };
  const sealed = sealBlocks(d, recorded); // R4 (H74)
  return {
    kind: 'workflow', id: now.id, did: 'interrupted', job: now.id, state: recorded.state,
    text: `${w.name} was interrupted ${at.words}: its REPL ended and its process is gone; its job record now says ${recorded.state}: ${d.scrub(error)}${sealed}; nothing was run again: ${w.again} runs it again`,
  };
}

/** R4 (H67): why nothing proves what came after (the wrapper's file missing or not usable), in words for a record. */
function notSeen(why: string | undefined, unseen: readonly string[]): string {
  const after = unseen.length ? `whether upmd went on to ${listed(unseen)}` : 'whether upmd went on';
  return `; ${why ? `${why}, so ` : ''}${after} is not known`;
}

/**
 * R4 (H67): a run whose REPL ended, recorded from its wrapper's stop file (the wrapper having ended; `recovery` when this
 * pass stopped what was left of its group first). See the module comment.
 */
function endFromWrapper(d: WorkflowRecoverDeps, job: JobRecord, stop: PtyStop, recovery?: Omit<LeftStop, 'recorded'>): RecoveryItem {
  const w = what(job);
  const m = mergePtyStop(job.steps, stop, blockNamer(job));
  const did = wrapperDid(m.account);
  const seen = m.ended.length ? `; it saw ${listed(m.ended.map((name) => `${name} ${m.steps.find((s) => s.name === name)?.state ?? 'end'}`))}, which Timmy did not see itself` : '';
  const also = recovery ? `; this recovery also stopped its process group ${recovery.process_group} with ${recovery.signals.join(', then ')}` : '';
  const unknown = m.steps.some((s) => s.state === 'running');
  let recorded: JobRecord | undefined;
  let item: Pick<RecoveryItem, 'did' | 'text'> & { outcome?: string };
  if (m.upmdEnded && !unknown) {
    // upmd ended by itself, its REPL not following it any more: what the wrapper saw is the run's end
    const ok = stop.exit === 0 && m.steps.every((s) => s.state === 'completed');
    const state = ok ? 'completed' as const : 'failed' as const;
    const note = `its REPL did not see it end: ${did}${seen} (its wrapper's stop file)${also}`;
    const error = ok ? undefined : `upmd exited ${stop.exit} (seen by its pty wrapper, not by its REPL)`;
    try { recorded = d.jobs.endLeft?.(job.id, { state, note, steps: m.steps, ...(error ? { error } : {}) }); } catch { recorded = undefined; }
    item = { did: 'judged', outcome: ok ? 'ok' : 'failed', text: `${w.name} ended unseen by its REPL: ${did}${seen}; ${recorded ? `its job record now says ${recorded.state}, from its wrapper's stop file${sealBlocks(d, recorded)}` : 'its job record could not be written'}; nothing was run again` };
  } else {
    const at = m.running ? `while ${m.running} was running` : 'while no block was running';
    const after = unrecorded(job, m.steps);
    const started = stop.command_pid !== null;
    const rest = !started ? '' : m.rest === 'not run' ? (after.length ? `, so ${listed(after)} did not start` : '') : notSeen(m.account.left ? `${m.account.left} process group${m.account.left === 1 ? '' : 's'} of upmd's still ran after its SIGKILL` : undefined, after);
    const error = `interrupted: its REPL ended ${at}; ${did}${seen}${rest}${also}`;
    const cleanup = recovery ? recovery.cleanup : stop.stopped ? (stop.left.length ? 'unresolved' as const : 'complete' as const) : undefined;
    try {
      recorded = d.jobs.endLeft?.(job.id, {
        // stopped by its wrapper (or never started, its REPL gone first): cancelled; else upmd ended with a block's end unseen
        state: stop.stopped || !started ? 'cancelled' : 'failed', error, steps: m.steps, ...(cleanup ? { cleanup } : {}),
        interrupted: { ...(m.running ? { step: m.running } : {}), rest: m.rest, wrapper: m.account },
      });
    } catch { recorded = undefined; }
    item = { did: 'interrupted', text: `${w.name} was interrupted ${at}: ${did}${seen}${rest}; ${recorded ? `its job record now says ${recorded.state}: ${d.scrub(error)}${sealBlocks(d, recorded)}` : 'its job record could not be written'}; nothing was run again: ${w.again} runs it again` };
  }
  if (!recorded) return { kind: 'workflow', id: job.id, did: 'failed', job: job.id, text: item.text };
  const unresolved = stop.left.length > 0 || recovery?.cleanup === 'unresolved';
  return {
    kind: 'workflow', id: job.id, job: job.id, state: recorded.state, ...item, ...(unresolved ? { attention: true } : {}),
    ...(recovery ? { stopped: { ...recovery, recorded: { state: recorded.state, error: recorded.error ?? recorded.note ?? '' } } } : {}),
  };
}

/**
 * A live run its ended REPL left, proven just before (the table read again now): SIGTERM to its group, SIGKILL after
 * STOP_GRACE_MS when some of it still runs, then its record ended as interrupted, cancelled. R4 (H67): when its wrapper
 * left a stop file meanwhile (it stops upmd itself once its REPL has ended), the record is ended with that account.
 */
async function stopLeftRun(d: WorkflowRecoverDeps, job: JobRecord): Promise<RecoveryItem | undefined> {
  const now = d.jobs.get(job.id) ?? job;
  const w = what(now);
  if (now.stale) return endGone(d, now);
  if (!LIVE.has(now.state)) return undefined;
  const left = leftBehind(now, (d.table ?? processTable)());
  if (left.kind === 'unproven') return { kind: 'workflow', id: now.id, did: 'left', attention: true, job: now.id, text: unprovenText(d, now, left) };
  if (left.kind !== 'orphan') {
    // R4 (the lead, ledger row 164): its pty wrapper stops upmd itself once its REPL has ended (H67), so this pass can
    // meet the run just as its last process exits: its record is read again for a moment and ended from what it left.
    if (left.kind === 'gone' && await waitFor(() => d.jobs.get(now.id)?.stale === true, SETTLE_MS)) return endGone(d, now);
    return { kind: 'workflow', id: now.id, did: 'left', job: now.id, text: left.kind === 'gone' ? `${w.name}: the processes of its job have just ended: /recover again to record it` : `${w.name} still runs (another session)` };
  }
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
  const told = wrapperFile(now);
  if ('stop' in told) return endFromWrapper(d, now, told.stop, { job: now.id, process_group: pgid, processes: left.members.length, signals, cleanup });
  const at = whileWords(now);
  const unseen = unrecorded(now, now.steps);
  const error = `interrupted: its REPL ended ${at.words}; recovery stopped its process group with ${signals.join(', then ')}${gone ? '' : '; some processes it started did not stop'}${notSeen(told.why, unseen)}`;
  let recorded: JobRecord | undefined;
  try { recorded = d.jobs.endLeft?.(now.id, { state: 'cancelled', error, cleanup, interrupted: { rest: 'not seen' } }); } catch { recorded = undefined; }
  const stopped: LeftStop = { job: now.id, process_group: pgid, processes: left.members.length, signals, cleanup, ...(recorded ? { recorded: { state: recorded.state, error: recorded.error ?? error } } : {}) };
  const n = `${left.members.length} process${left.members.length === 1 ? '' : 'es'}`;
  return {
    kind: 'workflow', id: now.id, did: 'interrupted', job: now.id, stopped, ...(recorded ? { state: recorded.state } : {}), ...(gone ? {} : { attention: true }),
    text: `${w.name} was interrupted ${at.words}: its REPL ended and it still ran, so recovery stopped its process group ${pgid} (${n}) with ${signals.join(', then ')}`
      + `${gone ? '' : `, and some of it did not stop: kill -KILL -- -${pgid}`}; ${recorded ? `its job record now says ${recorded.state}: ${d.scrub(error)}${sealBlocks(d, recorded)}` : 'its job record could not be written'}; nothing was run again: ${w.again} runs it again`,
  };
}
