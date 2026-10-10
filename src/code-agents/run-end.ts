/**
 * Round R4 (helper H59; r18, ledger row 157, defect 4): the end of a code agent's run whose REPL ended before the run did,
 * as a later session's recovery records it in the run's own record, .timmy/agents/<run>/run.json, through the code-agent
 * module's one writer of that file (writeRunRecord).
 *
 * A run reaches its end in its own REPL: the job's end is judged there and sealAgent writes result.json, then run.json
 * "ended". When that REPL is killed first, nothing judges the run: its record said "submitted" forever. Recovery
 * (src/repl/recover.ts for a flow's agent step, src/repl/recover-agents.ts for a plain /agent run, and
 * src/repl/openhands-recover.ts for an OpenHands container) ends or stops the run's job, records that in the job's own
 * record (JobManager.endLeft), and then ends the run's record here:
 *   state "interrupted", ended_at, why in words (recovery stopped its process group with which signals; its process was
 *   found gone, and when it ended is not recorded; or its job's record already said how it ended), and `recovered`: the
 *   job that ran it as its record says now, what recovery stopped, the flow whose step it was, and result "not written".
 * Never a result: no outcome, files, final message, cost or exit status is written, and no result.json. The record is
 * changed only while it says "submitted", names the same job, and has no result.json beside it: once, never over an end.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, RUN_RECORD, writeRunRecord, type AgentRunRecord, type AgentRunRecovered } from './index.js';

const RUN_ID = /^a[0-9a-f]{8}$/;
const RECORD_MAX = 4 * 1024 * 1024;

/** How the run's process ended, as recovery knows it. */
export type LeftRunEnd =
  /** recovery stopped its process group (proven left by an ended REPL): the group, how many processes, the signals */
  | { how: 'stopped'; stopped: { process_group: number; processes: number; signals: string[]; cleanup: 'complete' | 'unresolved' } }
  /** its job's process was gone when recovery looked (its record stale): when it ended is not recorded */
  | { how: 'gone' }
  /** an earlier recovery recorded its job's end (the words of the job's record), but not the run's */
  | { how: 'ended before' }
  /** R4 (H52): recovery stopped its OpenHands container (docker stop, then docker kill), named here */
  | { how: 'container stopped'; container: string; steps: string };

export interface LeftRunInput {
  /** the job that ran it, as its own record says now (after recovery recorded its end) */
  job: { id: string; state: string; error?: string; endedAt?: string };
  end: LeftRunEnd;
  /** the flow whose agent step it was */
  flow?: string;
  now?: () => number;
}

export type LeftRunEnded =
  | { ok: true; path: string; sha256: string; bytes: number; record: AgentRunRecord }
  /** nothing was written: `path` is the record looked at, `why` says why it was left as it is */
  | { ok: false; path: string; why: string };

const count = (n: number, word: string, plural = `${word}s`): string => `${n} ${n === 1 ? word : plural}`;

/** Why the run ended, in words, as its record says it once recovery ended it. */
export function leftRunWhy(input: Pick<LeftRunInput, 'job' | 'end'>): string {
  const e = input.end;
  switch (e.how) {
    case 'stopped': {
      const s = e.stopped;
      return `its REPL ended while it ran; recovery stopped its process group ${s.process_group} (${count(s.processes, 'process', 'processes')}) with ${s.signals.join(', then ')}${s.cleanup === 'unresolved' ? ', and some of it did not stop' : ''}; no result was written`;
    }
    case 'gone': return 'its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written';
    case 'ended before': return `its REPL ended while it ran; its job record says ${input.job.state}${input.job.error ? `: ${input.job.error}` : ''}; no result was written`;
    case 'container stopped': return `its REPL ended while it ran; recovery stopped its container ${e.container} (${e.steps}); no result was written, and nothing was written into the project`;
  }
}

const PROCESS: Record<LeftRunEnd['how'], AgentRunRecovered['process']> = { stopped: 'stopped by recovery', gone: 'gone', 'ended before': 'ended before', 'container stopped': 'container stopped by recovery' };

/** The record's project-relative path. */
export const runRecordRel = (run: string): string => `${AGENTS_DIR}/${run}/${RUN_RECORD}`;

/** A file in the project that is there (as itself, not through a link). */
const lexists = (abs: string): boolean => { try { fs.lstatSync(abs); return true; } catch { return false; } };

/**
 * Ends the record of a run its REPL left unfinished: see the module comment. Returns what was written (the record's path,
 * sha256 and size, for the flow's record and receipt or a recover receipt), or why nothing was. Never throws.
 */
export function endLeftAgentRun(root: string, run: string, input: LeftRunInput): LeftRunEnded {
  const rel = RUN_ID.test(run) ? runRecordRel(run) : `${AGENTS_DIR}/(not a run id)/${RUN_RECORD}`;
  if (!RUN_ID.test(run)) return { ok: false, path: rel, why: 'it does not name an agent run' };
  const dir = path.join(root, AGENTS_DIR, run);
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return { ok: false, path: rel, why: 'its run folder is not a folder' };
    const realRoot = fs.realpathSync(root);
    if (!fs.realpathSync(dir).startsWith(realRoot + path.sep)) return { ok: false, path: rel, why: 'its run folder leads outside the project' };
  } catch { return { ok: false, path: rel, why: 'its run folder is not there' }; }
  if (lexists(path.join(dir, 'result.json'))) return { ok: false, path: rel, why: 'its result was written (result.json): its run reached its end in its REPL' };
  let prev: AgentRunRecord;
  try {
    const file = path.join(dir, RUN_RECORD);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return { ok: false, path: rel, why: 'its record is not a file Timmy reads' };
    prev = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentRunRecord;
  } catch { return { ok: false, path: rel, why: 'its record could not be read' }; }
  if (!prev || typeof prev !== 'object' || prev.run !== run) return { ok: false, path: rel, why: 'its record is not this run\'s' };
  if (prev.job !== input.job.id) return { ok: false, path: rel, why: `its record names job ${String(prev.job || '(none)')}, not ${input.job.id}` };
  if (prev.state !== 'submitted') return { ok: false, path: rel, why: `its record already says ${String(prev.state ?? '(no state)')}` };
  const at = new Date((input.now ?? Date.now)()).toISOString();
  // When its job's record already said how it ended (an earlier recovery), that is when it ended; otherwise now.
  const endedAt = input.end.how === 'ended before' && input.job.endedAt && !Number.isNaN(Date.parse(input.job.endedAt)) ? input.job.endedAt : at;
  const recovered: AgentRunRecovered = {
    at, by: 'recovery', process: PROCESS[input.end.how],
    job: { id: input.job.id, state: input.job.state, ...(input.job.error ? { error: input.job.error } : {}) },
    ...(input.end.how === 'stopped' ? { stopped: { ...input.end.stopped, signals: [...input.end.stopped.signals] } } : {}),
    ...(input.end.how === 'container stopped' ? { container: input.end.container } : {}),
    ...(input.flow ? { flow: input.flow } : {}),
    result: 'not written',
  };
  const record: AgentRunRecord & { state: 'interrupted' } = { ...prev, state: 'interrupted', ended_at: endedAt, why: leftRunWhy(input), recovered };
  try {
    const w = writeRunRecord(dir, record);
    return { ok: true, path: rel, sha256: w.sha256, bytes: w.bytes, record };
  } catch (e) {
    return { ok: false, path: rel, why: `its record could not be written: ${(e as NodeJS.ErrnoException).code ?? 'an error'}` };
  }
}

/**
 * For recover.ts (a flow's agent step): when this pass recorded the end of the step's job (its own record's `ended`, from
 * the stop or from finding its process gone), the agent's run record is ended too; what the flow's record and receipt then
 * name of it, and the words for the recovery line. Nothing when the step is not the agent's or the job's end was not
 * recorded by this pass (another session's recovery, or a job that ended in its own REPL, whose result says how it ended).
 */
export function endFlowAgentStep(root: string, o: {
  step: string;
  run: unknown;
  flow: string;
  /** the step's job as the flow's record keeps it (recover.ts settleJob): its id, and `ended` when this pass recorded the end */
  job: Record<string, unknown> | undefined;
  /** what recovery stopped, when it did */
  stopped?: { process_group: number; processes: number; signals: string[]; cleanup: 'complete' | 'unresolved' };
  now?: () => number;
}): { part?: Record<string, unknown>; source?: { path: string; sha256: string; role: string }; words: string } {
  const ended = o.job?.ended as { state?: unknown; error?: unknown } | undefined;
  if (o.step !== 'agent' || typeof o.run !== 'string' || !RUN_ID.test(o.run) || typeof o.job?.id !== 'string' || typeof ended?.state !== 'string') return { words: '' };
  const run = o.run;
  const w = endLeftAgentRun(root, run, {
    job: { id: o.job.id, state: ended.state, ...(typeof ended.error === 'string' ? { error: ended.error } : {}) },
    end: o.stopped ? { how: 'stopped', stopped: o.stopped } : { how: 'gone' },
    flow: o.flow, ...(o.now ? { now: o.now } : {}),
  });
  if (!w.ok) return { part: { run, record: w.path, not_ended: w.why }, words: `; its agent's record ${w.path} was left as it is: ${w.why}` };
  return {
    part: { run, record: w.path, sha256: w.sha256, state: 'interrupted', result: 'not written' },
    source: { path: w.path, sha256: w.sha256, role: 'the agent\'s run record, ended by this recovery as interrupted (no result was written)' },
    words: `; its agent's record ${w.path} now says interrupted (no result was written)`,
  };
}

/** The sha256 of a record's bytes as they are now (for a reader checking a receipt against it), or undefined. */
export function recordSha256(root: string, rel: string): string | undefined {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return undefined; }
}
