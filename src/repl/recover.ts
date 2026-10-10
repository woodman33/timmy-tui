/**
 * Recovery after a restart (round R4, helper H32): a new REPL session picks up what an earlier session left in the
 * project when that session ended without its own stop path (a crash, a kill, a closed terminal; every normal stop
 * path cancels the REPL's recipes first, src/repl/recipe-stop.ts). It runs when an interactive REPL starts
 * (Workspace construction) and on /recover. AGENTS.md §8: it reads the durable state first, acts only on what
 * verifies, keeps each operation's own ID, and runs nothing again.
 *
 *   recipe jobs (.timmy/recipe-jobs; lanes/recipes/jobs.ts)
 *     Whether a recipe runs is the recipe's own status; whether a REPL follows it is in the jobs folder: each recipe
 *     watcher job (src/recipes/watch.ts) names the recipe's UUID on its command line. When the newest watcher of a
 *     recipe was left running by a session whose process is gone (its record is stale: no final state, and no
 *     process), that session ended while following it, and:
 *       - a recipe still running, whose worker answered within 30 s (its heartbeat), is followed again: a new watcher
 *         job of this REPL follows its UUID as /recipe tray's does (it copies the exports once the signed result
 *         verifies; /stop and this REPL's end cancel the recipe through its own path);
 *       - a recipe that succeeded meanwhile has its verified exports delivered (src/recipes deliver: one verified
 *         snapshot), sealed as a recover receipt; not when a whole copy is already in the project, or when a recover
 *         receipt of this project delivered it before (a copy the operator removed is not put back). A copy folder is
 *         checked file by file against the verified result, never taken as delivered for being there (the review's
 *         R4-8): an incomplete one is named with /recipe copy <uuid>, and nothing in it is deleted or replaced;
 *       - a recipe that says it runs while its worker stopped answering is named with /recipe recover <uuid> (the
 *         recipe's own recover reads it again and records its end; nothing is rerun).
 *     A recipe that a live watcher follows (this REPL's, or another session's sharing this jobs folder), or that no
 *     watcher in this jobs folder ever followed (the recipe CLI, another Timmy home), is left as it is.
 *   flows (.timmy/flows/<id>/state.json; src/repl/iterate.ts)
 *     A flow whose state says a step runs, and that has no record in results/flows/, is interrupted when the job of
 *     that step was left by a session whose process is gone, or when no job of the step runs and nothing about the
 *     flow has changed for 10 minutes. Its final record is written once, never over a file already there, with the
 *     outcome interrupted, the step it ended in, why, and what to do next; it is sealed as a flow receipt. The state
 *     file stays as its session wrote it. R4 (H33): the OpenSCAD, FreeCAD and Blender flows (their state names a
 *     `target`) are recovered the same way, each with its own steps and words; the app's own run in .timmy/native is
 *     judged by the native part below, as any run is. R4 (H41, H46): /iterate ae's too, its After Effects run (author
 *     step) and its aerender run (render step) each the step's job, with the render's receipt among the children.
 *   native runs (.timmy/native/<run>; src/native)
 *     A run that started (started.json) and has no judgement is judged from its result file (reconcileNative, or
 *     reconcileAe for an After Effects script run) once its job no longer runs; the judgement goes to the run's
 *     verdicts.jsonl. A run stopped with /stop is not judged, as before.
 *
 * A stale job record is read again after a short wait before anything acts on it: a session that is alive records
 * its job's end well within that time. Nothing here starts a recipe, an agent, a native app or a readback; the one
 * process it may start is a recipe watcher, which reads status and copies verified bytes.
 *
 *   the step's job (R4, H46; ledger row 153: an agent kept calling its model after its REPL was killed)
 *     A flow's agent or readback step runs as a job of its REPL (no other part of a pass follows those). When that job's
 *     record is stale (its process gone), the job's own record is ended through the job module's writer (JobManager
 *     endLeft: failed, "its REPL ended; its process is gone") as its flow is recorded interrupted. When its process group
 *     still runs, the group is stopped (SIGTERM, then SIGKILL after 2 s) before the interrupted record is written, and
 *     the stop is said in the recovery lines, the job's record and the flow's record; only when the process table
 *     (ps) proves both that the REPL which started the job has ended (the job's first process is no longer that REPL's
 *     child, or no process has its pid) and that the group is the job's (the recorded pid is the group, and its oldest
 *     process started when the job did). This reads PIDs from the job's record and the process table, and signals
 *     only such a group. When it cannot be proven, nothing is stopped: the lines say what still runs and how to stop it.
 *
 *   the agent's own record (R4, H59; ledger row 157, r18 defect 4)
 *     When the step's job is the agent's and this pass recorded its end, the agent's run record (.timmy/agents/<run>/run.json)
 *     is ended too, through the code-agent module's writer: interrupted, when, why and the job, never a result
 *     (src/code-agents/run-end.ts); the flow's record (recovered.agent) and its receipt (a source) name it with its sha256.
 *     A plain /agent run an ended REPL left is the Workspace's other part of the pass (src/repl/recover-agents.ts).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobManager, JobRecord, JobSpec } from '../jobs/index.js';
import { groupLive } from '../runtime/process-group.js';
import { killProcessGroup } from '../runtime/spawn-runtime.js';
import { jobDirectory, status, type Job, type JobStatus } from '../../lanes/recipes/jobs.js';
import { checkCopyOf, deliver, DOCTRINE_15, isRecipeJobId, outcomeLines, outDir, RECIPE_ID, short, verifiedResult, watcherSpec } from '../recipes/index.js';
import { diffText, FLOW_ID, FLOW_SCHEMA, FLOW_WORK_DIR, flowRecordPath, flowWorkDir, type FlowRecord, type FlowStep } from '../flows/iterate.js';
import { scadDiffText, type ScadParamChange } from '../flows/iterate-scad.js';
import { listNativeRuns, readNativeRecord, reconcileNative, type NativeApp } from '../native/index.js';
import { reconcileAe } from '../native/ae-author.js';
import { reconcileIllustrator } from '../native/illustrator.js';
import { reconcileScad } from '../native/openscad.js';
import { reconcileFreecad } from '../native/freecad.js';
import { projectId } from '../project/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { placeNew } from '../utils/place-new.js';
import { lessonsPart } from '../memory/retrieve.js'; // R4 (H50): the lessons an interrupted flow's agent was given, named by its receipt
import { OPERATION_ID } from '../ops/context.js';
// R4 (H59): the agent's own run record, ended with its step's job (src/code-agents/run-end.ts); plain /agent runs: recover-agents.ts
import { endFlowAgentStep } from '../code-agents/run-end.js';

type Line = Segment[];

/** A recipe whose worker last answered longer ago than this is not followed again: /recipe recover reads it. */
export const WORKER_SILENT_MS = 30_000;
/** A flow with no job of its step running is interrupted once nothing about it has changed for this long. */
export const FLOW_QUIET_MS = 10 * 60_000;
/** How long a stale job record is given to be recorded by a session that is still alive, before it is believed. */
export const SETTLE_MS = 1500;
/** R4 (H46): the steps whose job recovery ends or stops: no other part of a pass follows them (a recipe's watcher and an app's run have their own). */
const ENDS_JOB: ReadonlySet<string> = new Set(['agent', 'readback']);
/** R4 (H46): what a step job's record says once recovery has found its process gone. */
export const GONE_WORDS = 'its REPL ended; its process is gone';
/** R4 (H46): how long a group recovery stops is given after SIGTERM, then after SIGKILL (the job manager's own times). */
export const STOP_GRACE_MS = 2000;
const KILL_WAIT_MS = 3000;
/** R4 (H46): a group is the job's when its oldest process started this close to the job's start (ps reads whole seconds). */
const STARTED_BEFORE_MS = 3000;
const STARTED_AFTER_MS = 10_000;
/** R4 (H46): a live process is a job's owner when it started this close to the owner's recorded start. */
const OWNER_SLACK_MS = 3000;

/** The watcher's entry on its command line (src/recipes/watch.ts, or watch.js once built), before the root and the UUID. */
const WATCH_ENTRY = /[\\/]recipes[\\/]watch\.(?:ts|js)$/;
const JOB_ID = /^j[0-9a-f]{6}$/;
const STEPS: ReadonlySet<string> = new Set<FlowStep>(['prepare', 'agent', 'checks', 'build', 'readback', 'record']);
/**
 * R4 (H33): the flows with a `target`: their app's name, the step the app's job runs in, and the file the agent was asked
 * to change (where the state keeps it). The tray flow has no target and keeps its own words below.
 */
const TARGETS: Record<string, { app: string; appStep: string; command: string; file: 'parameters' | 'script'; render?: { step: string; app: string } }> = {
  scad: { app: 'OpenSCAD', appStep: 'openscad', command: '/scad', file: 'parameters' },
  freecad: { app: 'FreeCAD', appStep: 'freecad', command: '/freecad', file: 'script' },
  blender: { app: 'Blender', appStep: 'blender', command: '/blender', file: 'script' },
  // R4 (H41): /iterate ae. R4 (H46): its render step runs aerender as a job and a native run too: that job is the step's,
  // and its receipt is one of an interrupted record's children (agent, author, render, readback, as the flow's own end).
  ae: { app: 'After Effects', appStep: 'author', command: '/ae author', file: 'script', render: { step: 'render', app: 'aerender' } },
};
const TARGET_STEPS: ReadonlySet<string> = new Set(['prepare', 'agent', 'checks', 'openscad', 'freecad', 'blender', 'author', 'render', 'readback', 'record']);
const APP_WORDS: Record<NativeApp, string> = { c4dpy: 'Cinema 4D', aerender: 'After Effects render', blender: 'Blender', afterfx: 'After Effects script', openscad: 'OpenSCAD', freecad: 'FreeCAD', illustrator: 'Illustrator script' };
/** A recipe job's state now, as a flow's record says it (lanes/recipes/jobs.ts states, and unreadable). */
const RECIPE_NOW: Record<string, string> = { running: 'still runs', succeeded: 'has succeeded', failed: 'has failed', cancelled: 'was cancelled', interrupted: 'was interrupted', queued: 'is queued', unreadable: 'could not be read' };

export interface RecoverDeps {
  /** the project folder looked at, and its name */
  root: string;
  project: string;
  /** this REPL's jobs: its own and the records earlier sessions left in the same jobs folder (JobManager.list/get); R4
   *  (H46): endLeft records the end of a job an ended session left (absent: no job record is changed) */
  jobs: { list(): JobRecord[]; get(id: string): JobRecord | undefined; endLeft?: JobManager['endLeft'] };
  seal: (input: ReceiptInput) => string | undefined;
  /** the runs chain: read only when a delivery is checked against earlier recover receipts */
  receipts: () => Receipt[];
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string) => string;
  /** whether this REPL started the job */
  mine: (jobId: string) => boolean;
  /** whether the job is a watcher recovery started in this REPL */
  reattached: (jobId: string) => boolean;
  /** the flows this REPL runs */
  flowsHere: () => readonly string[];
  /** starts a watcher job of this REPL following the recipe (followSpec), or throws when it cannot */
  follow: (uuid: string, job: Job) => JobRecord;
  /** false once this REPL is ending: nothing more is started or written */
  open: () => boolean;
  now?: () => number;
  settleMs?: number;
  /** R4 (H52): OpenHands containers an ended session left running (src/repl/openhands-recover.ts), asked after the rest */
  agents?: () => Promise<RecoveryItem[]>;
  /** R4 (H58): /run jobs an ended session left running (src/repl/workflow-recover.ts), asked after the native runs */
  workflows?: () => Promise<RecoveryItem[]>;
}

/** What one pass did about one operation, or saw and left (did 'left'). */
export interface RecoveryItem {
  /** R4 (H58): 'workflow' is a /run job (its id the job's); 'agent': an OpenHands container (R4, H52); 'agent-run': a code agent's run and its record (R4, H59: recover-agents.ts) */
  kind: 'recipe' | 'flow' | 'native' | 'agent' | 'workflow' | 'agent-run';
  /** the operation's own ID: a recipe job's UUID, a flow's id, a native run's token */
  id: string;
  /** 'incomplete' (R4-8): a succeeded recipe's copy is in the project but not whole; named with /recipe copy, left as it is */
  did: 'followed' | 'delivered' | 'interrupted' | 'judged' | 'failed' | 'incomplete' | 'left' | 'stopped';
  /** left as it is, but the operator must act (a recipe whose worker stopped answering) */
  attention?: boolean;
  /** one plain sentence: what was found, and what was done */
  text: string;
  /** lines under it (a delivered recipe's verified outcome, DOCTRINE §15 last) */
  extra?: string[];
  job?: string;
  state?: string;
  outcome?: string;
  record?: string;
  receipt?: string;
  next?: string[];
  /** R4 (H46): the step's job left running by a REPL that ended, whose process group this pass stopped */
  stopped?: LeftStop;
}
export interface RecoveryReport { project: string; items: RecoveryItem[] }

/** R4 (H46): one process in the process table: its parent, its group, its state, when it started, its command line. */
export interface Proc { pid: number; ppid: number; pgid: number; stat: string; startMs: number; args: string }

/** R4 (H46): what the process table says about a live job another session started. */
export type LeftJob =
  /** that session still runs (the job's first process is still its child), or which session started it cannot be told (why) */
  | { kind: 'theirs'; why?: string }
  /** no process of its group runs now (its record turns stale; the next pass ends it) */
  | { kind: 'gone' }
  /** the REPL that started it has ended, and the group is the job's: proven, so it may be stopped */
  | { kind: 'orphan'; pgid: number; members: Proc[]; leader: boolean }
  /** the REPL that started it has ended, but the group could not be proven the job's (why): nothing is stopped */
  | { kind: 'unproven'; pgid: number; members: Proc[]; why: string };

/** R4 (H46): a stop of a step's job left running by a REPL that ended, as recovery did it. */
export interface LeftStop {
  job: string;
  /** the process group signalled (the job's recorded pid) and how many of its processes ran */
  process_group: number;
  processes: number;
  signals: Array<'SIGTERM' | 'SIGKILL'>;
  /** 'complete': no process of the group ran after the stop; 'unresolved': some still did after the SIGKILL wait */
  cleanup: 'complete' | 'unresolved';
  /** what the job's own record says now (JobManager endLeft), when it was written */
  recorded?: { state: string; error: string };
}

type Phase = 'live' | 'pending' | 'stale' | 'ended';
/** A job record's phase: stale (no final state and its process gone: its session ended), live, queued, or ended. */
const phase = (j: JobRecord): Phase => (j.stale ? 'stale' : j.state === 'running' || j.state === 'ready' ? 'live' : j.state === 'queued' ? 'pending' : 'ended');

/** A flow's state as its session left it; `target` (R4, H33) for an OpenSCAD, FreeCAD or Blender flow, absent for the tray's. */
interface FlowState { value: FlowRecord & { step: FlowStep; target?: string } & Record<string, unknown>; rel: string; sha256: string; mtimeMs: number }
type Plan =
  | { kind: 'recipe'; key: string; uuid: string; act: 'follow' | 'deliver'; viaStale: boolean }
  /** `orphan` (R4, H46): the step's job still runs and its group was proven left by a REPL that ended: stopped first */
  | { kind: 'flow'; key: string; id: string; viaStale: boolean; job?: JobRecord; state: FlowState; orphan?: true }
  | { kind: 'native'; key: string; run: string; app: NativeApp; viaStale: boolean; job?: JobRecord };
interface Survey { plans: Plan[]; left: RecoveryItem[] }

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** R4 (H51): an interrupted flow's receipt names the operation its state names (the request that started it), whichever request recovers it. */
const operationOf = (v: { operation?: unknown }): { operation_id?: string } => (typeof v.operation === 'string' && OPERATION_ID.test(v.operation) ? { operation_id: v.operation } : {});
/**
 * R4 (H46, ledger row 153): a plain timer, which holds Node's event loop. While a typed command runs the REPL's input is
 * paused, so /recover's settle wait may be the only thing left; an unref'd timer let Node exit (code 13, an unsettled
 * top-level await) in the middle of /recover, with nothing written.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const lexists = (abs: string): boolean => { try { fs.lstatSync(abs); return true; } catch { return false; } };
/** "40 s", "3 min", "2 h": how long ago. */
export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};

/** The watcher job that follows a recipe again: /recipe tray's watcher (src/recipes watcherSpec), its label marked re-attached. */
export function followSpec(o: { root: string; project: string; uuid: string; job: Job; pollMs?: number }): JobSpec {
  const label = `recipe ${RECIPE_ID} ${o.uuid} · request ${short(o.job.requestHash)} · source ${short(o.job.sourceHash)} · re-attached`;
  return watcherSpec({ root: o.root, id: o.uuid, label, project: o.project, ...(o.pollMs ? { pollMs: o.pollMs } : {}) });
}

/** Each recipe UUID's watcher jobs in the jobs folder, newest first (the order of JobManager.list). */
function watchers(all: JobRecord[]): Map<string, JobRecord[]> {
  const out = new Map<string, JobRecord[]>();
  for (const j of all) {
    const uuid = j.args.at(-1);
    const entry = j.args.at(-3);
    if (!uuid || !isRecipeJobId(uuid) || !entry || !WATCH_ENTRY.test(entry)) continue;
    const list = out.get(uuid) ?? [];
    list.push(j);
    out.set(uuid, list);
  }
  return out;
}

/** Whether a recipe job has recorded its end (lanes/recipes/jobs.ts terminal.json, or recovered.json after its own recover). */
function ended(root: string, uuid: string): boolean {
  const dir = jobDirectory(root, uuid);
  return lexists(path.join(dir, 'terminal.json')) || lexists(path.join(dir, 'recovered.json'));
}

/** How long ago a running recipe's worker last answered: its heartbeat, else its claim (lanes/recipes/jobs.ts writes both). */
function workerAge(root: string, uuid: string, now: number): number | undefined {
  const dir = jobDirectory(root, uuid);
  for (const [name, field] of [['heartbeat.json', 'at'], ['claim.json', 'started']] as const) {
    try {
      const file = path.join(dir, name);
      if (!fs.lstatSync(file).isFile()) continue;
      const at = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)[field];
      if (typeof at === 'number' && Number.isFinite(at)) return now - at;
    } catch { /* not written */ }
  }
  return undefined;
}

/** A flow's state file as its session left it: a regular file in the project, a flow state whose step is known. */
function readState(root: string, id: string): FlowState | undefined {
  const rel = `${flowWorkDir(id)}/state.json`;
  const abs = path.join(root, rel);
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > 1024 * 1024) return undefined;
    const realRoot = fs.realpathSync(root);
    if (!fs.realpathSync(path.dirname(abs)).startsWith(realRoot + path.sep)) return undefined;
    const buf = fs.readFileSync(abs);
    const value = JSON.parse(buf.toString('utf8')) as FlowState['value'];
    if (!value || typeof value !== 'object' || value.schema !== FLOW_SCHEMA || value.id !== id || typeof value.instruction !== 'string') return undefined;
    // R4 (H33): a flow with a target keeps the file its agent may change under `parameters` (OpenSCAD) or `script`.
    const t = value.target === undefined ? undefined : TARGETS[String(value.target)];
    if (value.target !== undefined && !t) return undefined;
    if (!(t ? TARGET_STEPS : STEPS).has(value.step)) return undefined;
    const p = (t ? value[t.file] : value.parameters) as { path?: unknown; before?: { sha256?: unknown } } | undefined;
    if (!p || typeof p.path !== 'string' || typeof p.before?.sha256 !== 'string') return undefined;
    return { value, rel, sha256: sha(buf), mtimeMs: st.mtimeMs };
  } catch { return undefined; }
}

/** The job of the step a flow's state says runs: the agent's, the recipe watcher's, the app's (R4, H33; H46: aerender's for /iterate ae's render step) or the readback's. */
function stepJob(v: FlowState['value']): string | undefined {
  const step = String(v.step);
  const t = v.target !== undefined ? TARGETS[String(v.target)] : undefined;
  const app = t && (t.appStep === step || t.render?.step === step) ? (v[step] as { job?: unknown } | undefined)?.job : undefined;
  const id = step === 'agent' ? v.agent?.job : step === 'build' ? v.rebuild?.job : step === 'readback' ? v.readback?.job : app;
  return typeof id === 'string' && JOB_ID.test(id) ? id : undefined;
}

// ── the step's job left running by a REPL that ended (R4, H46) ──────────────────

/** ps's elapsed time ([[dd-]hh:]mm:ss) in seconds, or undefined. */
function etimeSeconds(t: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : undefined;
}

/**
 * The process table, read once with ps (POSIX keywords, each -o on its own, as macOS needs; wide, so command lines are
 * whole), or undefined when it cannot be read. A process's start is now less how long it has run (whole seconds).
 */
export function processTable(): Proc[] | undefined {
  let out: string;
  try {
    const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'etime=', '-o', 'args='],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    out = r.stdout;
  } catch { return undefined; }
  const now = Date.now();
  const rows: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/.exec(line);
    const secs = m ? etimeSeconds(m[5]) : undefined;
    if (!m || secs === undefined) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], startMs: now - secs * 1000, args: m[6] });
  }
  return rows.length ? rows : undefined;
}

const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * What the process table says about a live job another session started (its record running, its process there): whether
 * the REPL that started it has ended (its owner, R4 H46: the job's first process is no longer that REPL's child, or, that
 * process gone, no process has the REPL's pid), and whether the process group is the job's (the recorded pid is the
 * group's, and its oldest process started when the job did). Both are needed before anything is stopped.
 */
export function leftBehind(job: JobRecord, table: Proc[] | undefined): LeftJob {
  const pgid = job.pid;
  if (typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 1) return { kind: 'theirs', why: 'its record names no process' };
  const owner = job.owner;
  if (!table) {
    // No start time can be compared without the table: only an owner whose pid is gone is known to have ended.
    if (!owner || pidAlive(owner.pid)) return { kind: 'theirs', why: 'the process table (ps) could not be read' };
    return { kind: 'unproven', pgid, members: [], why: 'the process table (ps) could not be read, so its group\'s processes could not be checked' };
  }
  const members = table.filter((p) => p.pgid === pgid && !p.stat.startsWith('Z')).sort((a, b) => a.startMs - b.startMs || a.pid - b.pid);
  if (!members.length) return { kind: 'gone' };
  const leader = members.find((p) => p.pid === pgid);
  if (!owner) return { kind: 'theirs', why: 'its record does not name the REPL that started it (written before job records did)' };
  let ended: boolean | undefined;
  if (leader) ended = leader.ppid !== owner.pid;
  else {
    const o = table.find((p) => p.pid === owner.pid);
    const at = Date.parse(owner.startedAt);
    ended = !o ? true : Number.isFinite(at) && Math.abs(o.startMs - at) <= OWNER_SLACK_MS ? false : undefined;
  }
  if (ended === false) return { kind: 'theirs' };
  if (ended === undefined) return { kind: 'theirs', why: `a process has the pid of the REPL that started it (${owner.pid}) but did not start when that REPL did, so whether that REPL has ended cannot be told` };
  const started = Date.parse(job.startedAt);
  const first = members[0];
  if (Number.isFinite(started) && first.startMs >= started - STARTED_BEFORE_MS && first.startMs <= started + STARTED_AFTER_MS) return { kind: 'orphan', pgid, members, leader: !!leader };
  return { kind: 'unproven', pgid, members, why: `the oldest process of its group (pid ${first.pid}) started at ${iso(first.startMs)}, not when the job did (${job.startedAt})` };
}

/** Waits until `done` holds or `ms` pass, on timers that hold the event loop (the command awaiting it may be all that runs). */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= end) return false;
    await sleep(Math.min(50, Math.max(1, end - Date.now())));
  }
  return true;
}

/**
 * Stops a step's job its ended REPL left running: proven again just before (the table read now), SIGTERM to its group,
 * SIGKILL after STOP_GRACE_MS when some of it still runs, then its end recorded in its own record (JobManager endLeft:
 * cancelled, saying so). Returns what was done, or the job's state now when nothing was signalled. R4 (H59): also a plain
 * /agent run's job (src/repl/recover-agents.ts).
 */
export async function stopLeft(d: Pick<RecoverDeps, 'jobs'>, job: JobRecord): Promise<LeftStop | LeftJob> {
  const now = d.jobs.get(job.id) ?? job;
  if (now.stale || (now.state !== 'running' && now.state !== 'ready')) return { kind: 'gone' };
  const left = leftBehind(now, processTable());
  if (left.kind !== 'orphan') return left;
  const pgid = left.pgid;
  const signals: LeftStop['signals'] = ['SIGTERM'];
  killProcessGroup(pgid, 'SIGTERM', { leaderExited: !left.leader });
  let gone = await waitFor(() => !groupLive(pgid), STOP_GRACE_MS);
  if (!gone) {
    signals.push('SIGKILL');
    killProcessGroup(pgid, 'SIGKILL', { leaderExited: !left.leader });
    gone = await waitFor(() => !groupLive(pgid), KILL_WAIT_MS);
  }
  const cleanup = gone ? 'complete' : 'unresolved';
  const error = `its REPL ended; recovery stopped its process group with ${signals.join(', then ')}${gone ? '' : '; some processes it started did not stop'}`;
  let recorded: JobRecord | undefined;
  try { recorded = d.jobs.endLeft?.(job.id, { state: 'cancelled', error, cleanup }); } catch { recorded = undefined; }
  return { job: job.id, process_group: pgid, processes: left.members.length, signals, cleanup, ...(recorded ? { recorded: { state: recorded.state, error: recorded.error ?? error } } : {}) };
}

/** The words for a stop: what still ran, what was sent, and what is left when some of it did not stop. */
function stoppedWords(s: LeftStop): string {
  const n = `${s.processes} process${s.processes === 1 ? '' : 'es'}`;
  return `its job ${s.job} was still running after its REPL ended: recovery stopped its process group ${s.process_group} (${n}) with ${s.signals.join(', then ')}`
    + (s.cleanup === 'unresolved' ? `, and some of it did not stop: kill -KILL -- -${s.process_group}` : '');
}

/** A live step job left by an ended REPL whose group could not be proven the job's: what runs, why nothing was stopped, how to stop it. */
function unprovenText(d: RecoverDeps, id: string, step: string, job: JobRecord, left: Extract<LeftJob, { kind: 'unproven' }>): string {
  const cut = (s: string): string => (s.length > 72 ? `${s.slice(0, 71)}…` : s);
  const shown = left.members.slice(0, 4).map((p) => `pid ${p.pid} (${cut(d.scrub(p.args))})`).join(', ');
  const more = left.members.length > 4 ? ` and ${left.members.length - 4} more` : '';
  const runs = left.members.length
    ? `${left.members.length} process${left.members.length === 1 ? '' : 'es'} of its process group ${left.pgid} still run${left.members.length === 1 ? 's' : ''}: ${shown}${more}`
    : `its process group ${left.pgid} may still run`;
  return `flow ${id} is in its ${step} step, and its job ${job.id} was left running by a REPL that has ended; ${runs}. Nothing was stopped, because ${left.why}: kill -TERM -- -${left.pgid} stops the group (then kill -KILL -- -${left.pgid} if any of it is left), and /recover records the flow once it has ended`;
}

// ── the survey: what the durable state says (reads only) ───────────────────────

function survey(d: RecoverDeps): Survey {
  const now = (d.now ?? Date.now)();
  const plans: Plan[] = [];
  const left: RecoveryItem[] = [];
  let all: JobRecord[] = [];
  try { all = d.jobs.list(); } catch { all = []; }
  // A lane that cannot be read is skipped whole; the others are still looked at.
  try { surveyRecipes(d, all, now, plans, left); } catch { /* .timmy/recipe-jobs unreadable: /recipe status says why */ }
  try { surveyFlows(d, now, plans, left); } catch { /* .timmy/flows unreadable */ }
  try { surveyNatives(d, now, plans, left); } catch { /* .timmy/native unreadable */ }
  return { plans, left };
}

function surveyRecipes(d: RecoverDeps, all: JobRecord[], now: number, plans: Plan[], left: RecoveryItem[]): void {
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(d.root, '.timmy', 'recipe-jobs')).filter(isRecipeJobId).sort(); } catch { return; }
  const index = watchers(all);
  for (const uuid of ids) {
    const list = index.get(uuid) ?? [];
    const newest = list[0];
    // A watcher follows it now (any of them: a recipe is never followed twice). This REPL's own (/recipe tray) is no
    // recovery; one that recovery started here, or another session's, is said by /recover.
    const live = list.find((j) => phase(j) === 'live' || phase(j) === 'pending');
    if (live) {
      if (d.mine(live.id) && !d.reattached(live.id)) continue;
      left.push({ kind: 'recipe', id: uuid, did: 'left', job: live.id, text: `recipe ${uuid}: followed by ${live.id} (${d.mine(live.id) ? 'this REPL, re-attached' : 'another session'})` });
      continue;
    }
    // Its newest watcher ended with its end recorded: the session that ran it saw that and said so.
    if (newest && phase(newest) === 'ended') continue;
    // A copy folder means a delivery started; whether it finished is the copy's own check (the review's R4-8: checkCopy,
    // file by file against the verified result), never the folder alone. A whole copy was delivered; an incomplete one is
    // named with /recipe copy and left as it is. A copy whose result does not verify now is decided by the status below.
    if (newest && lexists(path.join(d.root, outDir(uuid)))) {
      const copy = copyOf(d.root, uuid);
      if (copy.state === 'whole') continue;
      if (copy.state === 'incomplete') { left.push(incompleteCopy(d, uuid, copy.why)); continue; }
    }
    // A recipe no watcher followed matters here only while it runs.
    if (!newest && ended(d.root, uuid)) continue;
    let s: JobStatus;
    try { s = status(d.root, uuid); } catch (e) {
      left.push({ kind: 'recipe', id: uuid, did: 'left', text: `recipe ${uuid} could not be read: ${d.scrub(message(e))}; /recipe status shows it` });
      continue;
    }
    if (!newest) {
      // No watcher in this jobs folder ever followed it: the recipe CLI, another Timmy home, or a launch whose watcher is about to start.
      if (s.state === 'running') left.push({ kind: 'recipe', id: uuid, did: 'left', state: s.state, text: `recipe ${uuid} is running (${s.progress}) and no REPL of this Timmy follows it: /recipe status shows it; /recipe cancel ${uuid} cancels it` });
      continue;
    }
    // The newest watcher's session ended while following it.
    if (s.state === 'running') {
      const age = workerAge(d.root, uuid, now);
      if (age === undefined || age > WORKER_SILENT_MS) {
        left.push({ kind: 'recipe', id: uuid, did: 'left', attention: true, state: s.state, text: `recipe ${uuid} says it is running (${s.progress}), but its worker ${age === undefined ? 'never answered' : `last answered ${ago(age)} ago`}, and the REPL that followed it ended: /recipe recover ${uuid} reads it again; nothing is rerun` });
        continue;
      }
      plans.push({ kind: 'recipe', key: `recipe:${uuid}`, uuid, act: 'follow', viaStale: true });
      continue;
    }
    if (s.state === 'succeeded' && !lexists(path.join(d.root, outDir(uuid)))) plans.push({ kind: 'recipe', key: `recipe:${uuid}`, uuid, act: 'deliver', viaStale: true });
    // Anything else (failed, cancelled, interrupted, a copy folder already there): /recipe status shows it as it is.
  }
}

function surveyFlows(d: RecoverDeps, now: number, plans: Plan[], left: RecoveryItem[]): void {
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(d.root, FLOW_WORK_DIR)).filter((n) => FLOW_ID.test(n)).sort(); } catch { return; }
  const here = new Set(d.flowsHere());
  // R4 (H46): the process table, read at most once a survey, and only when a step's job of another session still runs.
  let table: Proc[] | undefined | null = null;
  const tableOnce = (): Proc[] | undefined => (table === null ? (table = processTable()) : table);
  for (const id of ids) {
    if (here.has(id)) continue;
    // A flow with a file at its record's place has ended (its record is the last word); nothing is written over it.
    if (lexists(path.join(d.root, flowRecordPath(id)))) continue;
    const state = readState(d.root, id);
    if (!state || state.value.outcome !== 'running') continue;
    const step = state.value.step;
    const jobId = stepJob(state.value);
    const job = jobId ? d.jobs.get(jobId) : undefined;
    const ph = job ? phase(job) : undefined;
    if (job && (ph === 'live' || ph === 'pending')) {
      // R4 (H46): an agent's or readback's job left running by a REPL that ended (proven) is stopped before the record.
      const lb = ph === 'live' && !d.mine(job.id) && ENDS_JOB.has(String(step)) ? leftBehind(job, tableOnce()) : undefined;
      if (lb?.kind === 'orphan') { plans.push({ kind: 'flow', key: `flow:${id}`, id, viaStale: true, job, state, orphan: true }); continue; }
      if (lb?.kind === 'unproven') { left.push({ kind: 'flow', id, did: 'left', attention: true, job: job.id, text: unprovenText(d, id, String(step), job, lb) }); continue; }
      if (lb?.kind === 'gone') { left.push({ kind: 'flow', id, did: 'left', job: job.id, text: `flow ${id} is in its ${step} step and the processes of its job ${job.id} have just ended: /recover again to record it` }); continue; }
      const who = d.mine(job.id) ? 'this REPL' : `another session${lb?.kind === 'theirs' && lb.why ? `, as far as Timmy can tell: ${lb.why}` : ''}`;
      left.push({ kind: 'flow', id, did: 'left', job: job.id, text: `flow ${id} is in its ${step} step and its job ${job.id} still runs (${who}): /recover again once it has ended` });
      continue;
    }
    if (job && ph === 'stale') { plans.push({ kind: 'flow', key: `flow:${id}`, id, viaStale: true, job, state }); continue; }
    const jobEnded = job?.endedAt ? Date.parse(job.endedAt) : 0;
    const quiet = now - Math.max(state.mtimeMs, Number.isFinite(jobEnded) ? jobEnded : 0);
    if (quiet >= FLOW_QUIET_MS) { plans.push({ kind: 'flow', key: `flow:${id}`, id, viaStale: false, ...(job ? { job } : {}), state }); continue; }
    left.push({ kind: 'flow', id, did: 'left', text: `flow ${id} says its ${step} step runs; no job of that step runs here, and it last changed ${ago(quiet)} ago: it is recorded as interrupted once nothing about it has changed for ${ago(FLOW_QUIET_MS)}` });
  }
}

function surveyNatives(d: RecoverDeps, now: number, plans: Plan[], left: RecoveryItem[]): void {
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(d.root); } catch { return; }
  for (const r of runs) {
    if (r.verdicts.length) continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(d.root, r.run); } catch { continue; }
    // A run with no start note never started (or its start was not noted): there is nothing of it to judge.
    if (!rec?.started || typeof rec.started.job !== 'string') continue;
    const app = r.app;
    const job = JOB_ID.test(rec.started.job) ? d.jobs.get(rec.started.job) : undefined;
    if (job) {
      const ph = phase(job);
      if (ph === 'live' || ph === 'pending') {
        if (!d.mine(job.id)) left.push({ kind: 'native', id: r.run, did: 'left', job: job.id, text: `${APP_WORDS[app]} run ${r.run.slice(0, 8)} still runs as ${job.id} (another session); it is judged when it ends` });
        continue;
      }
      // Stopped with /stop: the REPL does not judge a stopped run, and neither does this.
      if (ph === 'ended' && job.state === 'cancelled') continue;
      plans.push({ kind: 'native', key: `native:${r.run}`, run: r.run, app, viaStale: ph === 'stale', job });
      continue;
    }
    // No record of its job in this jobs folder: judged once its own time limit has passed, when it can no longer be running.
    const until = Date.parse(rec.job.started_at) + (typeof rec.job.timeout_ms === 'number' ? rec.job.timeout_ms : 0) + 60_000;
    if (Number.isFinite(until) && now < until) {
      left.push({ kind: 'native', id: r.run, did: 'left', text: `${APP_WORDS[app]} run ${r.run.slice(0, 8)}: its job ${rec.started.job} is not in this Timmy's jobs folder and its time limit ends ${new Date(until).toISOString()}; it is judged after that` });
      continue;
    }
    plans.push({ kind: 'native', key: `native:${r.run}`, run: r.run, app, viaStale: false });
  }
}

// ── acting on what verifies ─────────────────────────────────────────────────────

/** Finds and picks up what an ended session left in the project; see the module comment. Never throws for one operation. */
export async function recoverProject(d: RecoverDeps): Promise<RecoveryReport> {
  let s = survey(d);
  if (s.plans.some((p) => p.viaStale)) {
    // A stale record is believed only when it is still stale after a moment: an alive session records its job's end at once.
    await sleep(d.settleMs ?? SETTLE_MS);
    const before = new Set(s.plans.map((p) => p.key));
    s = survey(d);
    s.plans = s.plans.filter((p) => !p.viaStale || before.has(p.key));
  }
  const done: RecoveryItem[] = [];
  const recipes = new Map<string, RecoveryItem>();
  // Recipes first, so an interrupted flow's record can say what became of its rebuild.
  for (const p of s.plans) {
    if (p.kind !== 'recipe') continue;
    const item = act(d, 'recipe', p.uuid, () => actRecipe(d, p));
    if (item) { done.push(item); recipes.set(p.uuid, item); }
  }
  for (const p of s.plans) {
    if (p.kind !== 'flow') continue;
    // R4 (H46): a step's job its ended REPL left running is stopped first (proven again just before), then the record.
    let stop: LeftStop | undefined;
    if (p.orphan && p.job && d.open()) {
      let r: LeftStop | LeftJob;
      try { r = await stopLeft(d, p.job); } catch (e) { done.push({ kind: 'flow', id: p.id, did: 'failed', job: p.job.id, text: `flow ${p.id}: its job ${p.job.id} could not be stopped: ${d.scrub(message(e))}` }); continue; }
      if ('kind' in r) {
        // Not stopped: what runs now is said (or, its group gone meanwhile, its record is stale and it is recorded as such).
        if (r.kind === 'unproven') { done.push({ kind: 'flow', id: p.id, did: 'left', attention: true, job: p.job.id, text: unprovenText(d, p.id, String(p.state.value.step), p.job, r) }); continue; }
        if (r.kind === 'theirs') { done.push({ kind: 'flow', id: p.id, did: 'left', job: p.job.id, text: `flow ${p.id} is in its ${p.state.value.step} step and its job ${p.job.id} still runs (another session): /recover again once it has ended` }); continue; }
      } else stop = r;
    }
    const item = act(d, 'flow', p.id, () => actFlow(d, p, recipes, stop));
    if (item) done.push(item);
  }
  for (const p of s.plans) {
    if (p.kind !== 'native') continue;
    const item = act(d, 'native', p.run, () => actNative(d, p));
    if (item) done.push(item);
  }
  // R4 (H58): /run jobs left running: each ended in its own record as interrupted (its group stopped first when proven).
  if (d.workflows && d.open()) {
    try { done.push(...await d.workflows()); } catch (e) { done.push({ kind: 'workflow', id: 'workflows', did: 'failed', text: `workflow runs could not be checked: ${d.scrub(message(e))}` }); }
  }
  // R4 (H52): OpenHands containers left running, each found by its labels and its run's record (never by a name alone).
  if (d.agents && d.open()) {
    try { done.push(...await d.agents()); } catch (e) { done.push({ kind: 'agent', id: 'openhands', did: 'failed', text: `OpenHands containers could not be checked: ${d.scrub(message(e))}` }); }
  }
  return { project: d.project, items: [...done, ...s.left] };
}

/** One operation picked up: nothing once this REPL is ending, and a failure said, never thrown into the others. */
function act(d: RecoverDeps, kind: RecoveryItem['kind'], id: string, run: () => RecoveryItem | undefined): RecoveryItem | undefined {
  if (!d.open()) return { kind, id, did: 'left', text: `${kind} ${id}: not picked up, because this REPL is ending` };
  try { return run(); } catch (e) {
    return { kind, id, did: 'failed', text: `${kind} ${id} could not be picked up: ${d.scrub(message(e))}` };
  }
}

/**
 * A succeeded recipe's copy in the project, checked file by file against its verified result (checkCopy's two steps):
 * whole, incomplete (why: a file missing or different), or unchecked when its result does not verify now.
 */
function copyOf(root: string, uuid: string): { state: 'whole' } | { state: 'incomplete' | 'unchecked'; why: string } {
  const got = verifiedResult(root, uuid);
  if (!got.ok) return { state: 'unchecked', why: got.error };
  const c = checkCopyOf(root, got.v);
  return c.ok ? { state: 'whole' } : { state: 'incomplete', why: c.error };
}

/** An incomplete copy, said and left as it is: /recipe copy completes it in place (nothing there is deleted or replaced). */
function incompleteCopy(d: RecoverDeps, uuid: string, why: string): RecoveryItem {
  return {
    kind: 'recipe', id: uuid, did: 'incomplete', text: `the copy of ${uuid} is incomplete: /recipe copy ${uuid}`,
    extra: [`${d.scrub(why)}; nothing in ${outDir(uuid)}/ was deleted or replaced`],
  };
}

/** Whether a recover receipt of this project delivered the recipe before (its copy is then the operator's to keep or remove). */
function deliveredBefore(d: RecoverDeps, uuid: string): boolean {
  let chain: Receipt[] = [];
  try { chain = d.receipts(); } catch { return false; }
  const pid = projectId(d.root);
  return chain.some((r) => r.kind === 'recover' && r.project_id === pid && Array.isArray(r.sources)
    && r.sources.some((x) => !!x && typeof x === 'object' && (x as Record<string, unknown>).operation === uuid && (x as Record<string, unknown>).action === 'delivered'));
}

function actRecipe(d: RecoverDeps, p: Extract<Plan, { kind: 'recipe' }>): RecoveryItem | undefined {
  const uuid = p.uuid;
  let s: JobStatus;
  try { s = status(d.root, uuid); } catch (e) {
    return { kind: 'recipe', id: uuid, did: 'failed', text: `recipe ${uuid} could not be read again: ${d.scrub(message(e))}; /recipe status shows it` };
  }
  if (p.act === 'follow' && s.state === 'running') {
    try {
      const w = d.follow(uuid, s.job);
      return { kind: 'recipe', id: uuid, did: 'followed', job: w.id, state: s.state, text: `recipe ${uuid} was running (${s.progress}) with no REPL following it: following it as ${w.id}; /jobs ${w.id} shows it, /stop ${w.id} cancels it` };
    } catch (e) {
      return { kind: 'recipe', id: uuid, did: 'failed', state: s.state, text: `recipe ${uuid} is running with no REPL following it, and a new watcher did not start (${d.scrub(message(e))}): /recipe status shows it; /recipe cancel ${uuid} cancels it` };
    }
  }
  if (s.state !== 'succeeded') return undefined;
  // It succeeded (perhaps while it was surveyed): its exports are delivered once, never over a copy already there; a copy
  // that appeared meanwhile is checked as the survey checks one (R4-8).
  if (lexists(path.join(d.root, outDir(uuid)))) {
    const copy = copyOf(d.root, uuid);
    return copy.state === 'incomplete' ? incompleteCopy(d, uuid, copy.why) : undefined;
  }
  if (deliveredBefore(d, uuid)) {
    return { kind: 'recipe', id: uuid, did: 'left', text: `recipe ${uuid} succeeded; a recover receipt delivered it before and ${outDir(uuid)}/ is not in the project now, so nothing was copied: /recipe copy ${uuid} copies it again` };
  }
  const r = deliver(d.root, uuid);
  if (!r.ok) return { kind: 'recipe', id: uuid, did: 'failed', state: s.state, text: `recipe ${uuid} succeeded while no REPL followed it, but its exports were not delivered: ${d.scrub(r.error)}; /recipe copy ${uuid}` };
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'recover', subject: `recover · recipe · ${RECIPE_ID} · ${uuid} · delivered`, policy: 'human-gated', status: 'ok', project: d.project, project_id: projectId(d.root),
      outputs: r.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
      sources: [{ operation: uuid, recipe: RECIPE_ID, action: 'delivered', result_receipt: r.v.resultReceipt, result_receipt_hash: r.v.resultHash, why: 'the recipe succeeded while no REPL followed it; its exports were copied after its signed result verified' }],
      cost_usd: 0,
    });
  } catch { receipt = undefined; }
  return {
    kind: 'recipe', id: uuid, did: 'delivered', state: s.state, ...(receipt ? { receipt } : {}),
    text: `recipe ${uuid} succeeded while no REPL followed it: ${r.files.length} files delivered to ${r.dir}/, each sha256 checked against its signed result${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}`,
    extra: outcomeLines(r.v, r.dir).slice(1),
  };
}

/**
 * Writes a JSON file in the project only where nothing is: a temporary file, then a hard link that fails when a file is
 * there; on a disk without hard links (exFAT, FAT, some network shares), a rename once nothing is there (the review's
 * R4-7: src/utils/place-new.ts, the fallback kept.ts has).
 */
function createProjectJson(root: string, rel: string, value: unknown): { ok: true; path: string; sha256: string; bytes: number } | { ok: false; error: string } {
  const abs = path.join(root, rel);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const realRoot = fs.realpathSync(root);
    const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep);
    // Containment first, before any folder is made: the nearest folder that exists on the way must be in the project.
    let existing = path.dirname(abs);
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    if (!inside(fs.realpathSync(existing))) return { ok: false, error: `${path.dirname(rel)} leads outside the project` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const dir = fs.realpathSync(path.dirname(abs));
    if (!inside(dir)) return { ok: false, error: `${path.dirname(rel)} leads outside the project` };
    const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    // After a link the temporary name is a second name for the record; after a rename it is gone already.
    try { placeNew(tmp, path.join(dir, path.basename(abs))); } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EEXIST' ? `${rel} is already there; it was left as it is` : message(e) };
  }
  return { ok: true, path: rel, sha256: sha(body), bytes: Buffer.byteLength(body) };
}

/**
 * R4 (H46): the step's job as an interrupted flow's record keeps it: as its session left it (the survey's reading), what
 * recovery stopped, and what its own record says now. A stale agent's or readback's job has its end recorded in its own
 * record here, before the flow's (JobManager endLeft: failed, GONE_WORDS); a stopped one had it recorded by its stop.
 */
function settleJob(d: RecoverDeps, step: string, left: JobRecord | undefined, job: JobRecord | undefined, stop: LeftStop | undefined): Record<string, unknown> | undefined {
  if (!job) return undefined;
  const as = left ?? job;
  const part: Record<string, unknown> = { id: job.id, state: as.state, ...(as.stale ? { stale: true } : {}) };
  if (stop) {
    part.stopped = { process_group: stop.process_group, processes: stop.processes, signals: stop.signals, cleanup: stop.cleanup };
    if (stop.recorded) part.ended = stop.recorded;
    return part;
  }
  if (job.stale && ENDS_JOB.has(step)) {
    let ended: JobRecord | undefined;
    try { ended = d.jobs.endLeft?.(job.id, { state: 'failed', error: GONE_WORDS }); } catch { ended = undefined; }
    if (ended) part.ended = { state: ended.state, error: ended.error ?? GONE_WORDS };
  }
  return part;
}

/** R4 (H46): the end recovery recorded in the step's job record, for the recovery line ('' when none). */
function endedText(part: Record<string, unknown> | undefined): string {
  const e = part?.ended as { state?: string; error?: string } | undefined;
  return e?.state ? `; its job record now says ${e.state}: ${e.error ?? ''}` : '';
}

function actFlow(d: RecoverDeps, p: Extract<Plan, { kind: 'flow' }>, recipes: Map<string, RecoveryItem>, stop?: LeftStop): RecoveryItem | undefined {
  const rel = flowRecordPath(p.id);
  // Read again: the flow's own session may have written its record, or moved on, since the survey.
  if (lexists(path.join(d.root, rel))) return undefined;
  const state = readState(d.root, p.id);
  if (!state || state.value.outcome !== 'running' || state.sha256 !== p.state.sha256) return undefined;
  const v = state.value;
  const step = v.step;
  const job = p.job ? d.jobs.get(p.job.id) ?? p.job : undefined;
  if (job && !stop && (phase(job) === 'live' || phase(job) === 'pending')) return undefined;
  const jobWords = stop ? stoppedWords(stop)
    : !job ? (stepJob(v) ? `its job ${stepJob(v)} has no record in this Timmy's jobs folder` : 'no job of that step was recorded')
      : job.stale ? `its job ${job.id} was left ${job.state} and its process is gone`
        : `its job ${job.id} ${job.state}, and the flow did not go on for ${ago(FLOW_QUIET_MS)}`;
  // R4 (H46): the step's job: its end recorded in its own record first, when it is the agent's or the readback's.
  const jobPart = settleJob(d, String(step), p.job, job, stop);
  // R4 (H59): then the agent's own run record, when this pass recorded its job's end; the record and receipt below name it.
  const agentEnd = endFlowAgentStep(d.root, { step: String(step), run: (v.agent as { run?: unknown } | undefined)?.run, flow: p.id, job: jobPart, ...(stop ? { stopped: stop } : {}), ...(d.now ? { now: d.now } : {}) });
  // R4 (H33): an OpenSCAD, FreeCAD or Blender flow, with its own steps and words.
  if (v.target !== undefined) return actTargetFlow(d, p, state, jobPart, jobWords, stop, agentEnd);
  const uuid = typeof v.rebuild?.operation === 'string' && isRecipeJobId(v.rebuild.operation) ? v.rebuild.operation : undefined;
  let rebuild: Record<string, unknown> | undefined;
  if (uuid) {
    try {
      const s = status(d.root, uuid);
      rebuild = { state: s.state, progress: s.progress, ...(s.reason ? { reason: d.scrub(s.reason) } : {}) };
    } catch (e) { rebuild = { state: 'unreadable', error: d.scrub(message(e)) }; }
    const r = recipes.get(uuid);
    if (r?.did === 'followed' && r.job) rebuild.followed_again = r.job;
    if (r?.did === 'delivered') rebuild.delivered = `${outDir(uuid)}/`;
  }
  // When it ended, the job evidence, then what that left.
  const words: Record<FlowStep, [string, string]> = {
    prepare: ['before its agent started', 'nothing was run'],
    agent: ['while its agent ran', 'nothing was built'],
    checks: ['after its agent ran, before its rebuild was recorded', 'whether a rebuild started is not recorded: /recipe status lists the recipe jobs'],
    build: ['during its rebuild', `${uuid ? `recipe job ${uuid} ${RECIPE_NOW[String(rebuild?.state)] ?? `says ${String(rebuild?.state)}`}; ` : ''}nothing was read back`],
    readback: ['during its readback', 'there is no verdict'],
    record: ['as it was being recorded', 'its outcome was not kept'],
  };
  const why = `the REPL running it ended ${words[step][0]} (${jobWords}); ${words[step][1]}; recorded after a restart, and nothing was run again`;
  const next: string[] = [];
  if (uuid) {
    const r = recipes.get(uuid);
    if (r?.did === 'followed') next.push(`recipe job ${uuid} is followed again as ${r.job}: its exports reach ${outDir(uuid)}/ once its signed result verifies`);
    else if (r?.did === 'delivered') next.push(`recipe job ${uuid} succeeded: its exports were delivered to ${outDir(uuid)}/`);
    else if (rebuild?.state === 'succeeded') next.push(`recipe job ${uuid} succeeded: /recipe status shows whether its exports are in ${outDir(uuid)}/, and /recipe copy ${uuid} copies them when they are not`);
    next.push(`/recipe recover ${uuid} reads recipe job ${uuid} again; nothing is rerun`);
  }
  if (step === 'agent' && v.agent?.progress) next.push(`the agent's run ${v.agent.run} keeps its progress in ${v.agent.progress}; ${v.parameters.path} may hold its change (sha256 before it: ${short(v.parameters.before.sha256)})`);
  if (step === 'readback' && v.readback?.job) next.push(`/jobs ${v.readback.job} shows the readback's output while this Timmy's jobs folder keeps it`);
  if (v.parameters?.after && Array.isArray(v.parameters.diff)) next.push(`${v.parameters.path} holds the agent's change (${diffText(v.parameters.diff)}): /recipe tray builds from it`);
  next.push(`/iterate tray "${v.instruction}" starts a new flow from ${v.parameters?.path ?? 'the parameter file'} as it is now`);
  const receipts = v.receipts ?? {};
  const children = [receipts.agent, receipts.prediction, receipts.build, receipts.readback].filter((x): x is string => typeof x === 'string');
  const { step: _step, ...kept } = v;
  const record = {
    ...kept,
    outcome: 'interrupted',
    ended_in: step,
    ended_at: new Date((d.now ?? Date.now)()).toISOString(),
    why,
    ...(v.rebuild && rebuild ? { rebuild: { ...v.rebuild, ...rebuild } } : {}),
    child_receipts: children,
    recovered: {
      at: new Date((d.now ?? Date.now)()).toISOString(), step,
      state_file: { path: state.rel, sha256: state.sha256 },
      ...(jobPart ? { job: jobPart } : {}),
      ...(agentEnd.part ? { agent: agentEnd.part } : {}), // R4 (H59)
      next,
    },
  };
  const w = createProjectJson(d.root, rel, record);
  if (!w.ok) return { kind: 'flow', id: p.id, did: 'failed', ...(stop ? { stopped: stop } : {}), text: `flow ${p.id} was interrupted in its ${step} step${stop ? ` (${jobWords})` : ''}, but its record could not be written: ${d.scrub(w.error)}${agentEnd.words}` };
  const cost = v.agent?.cost_usd;
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'flow', subject: `flow · iterate · tray · ${p.id} · interrupted`, policy: 'human-gated', status: 'failed',
      ...operationOf(v), // R4 (H51): the request the flow belonged to, not the one that recovered it
      project: typeof v.project === 'string' ? v.project : d.project, project_id: projectId(d.root),
      prompt_hash: `sha256:${sha(v.instruction)}`,
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{ path: state.rel, sha256: state.sha256, role: 'the flow state its session left' }, ...(agentEnd.source ? [agentEnd.source] : [])],
      ...(children.length ? { child_receipts: children } : {}),
      discrepancies: [`interrupted: ${why}`],
      // The agent's cost as its own receipt sealed it, when it got that far; unknown is never written as 0.
      ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
      ...lessonsPart(v.lessons), // R4 (H50)
    });
  } catch { receipt = undefined; }
  const shortNext = uuid ? `/recipe recover ${uuid}, or /iterate tray again` : '/iterate tray again';
  return {
    kind: 'flow', id: p.id, did: 'interrupted', state: step, record: w.path, ...(receipt ? { receipt } : {}), next, ...(stop ? { stopped: stop } : {}),
    text: `flow ${p.id} was interrupted in its ${step} step (${jobWords})${endedText(jobPart)}: record ${w.path}${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}${agentEnd.words}; next: ${shortNext}`,
  };
}

/**
 * R4 (H33): an interrupted OpenSCAD, FreeCAD or Blender flow: its record, written once as the tray's is (outcome
 * interrupted, the step it ended in, why and what to do next), sealed as a flow receipt. The app's own run, when it
 * started, is judged from its own record by the native part of the pass, as any run is; nothing is run again here.
 */
function actTargetFlow(d: RecoverDeps, p: Extract<Plan, { kind: 'flow' }>, state: FlowState, jobPart: Record<string, unknown> | undefined, jobWords: string, stop: LeftStop | undefined, agentEnd: ReturnType<typeof endFlowAgentStep>): RecoveryItem | undefined {
  const v = state.value;
  const target = String(v.target);
  const t = TARGETS[target];
  const step = String(v.step);
  const fileOf = v[t.file] as { path: string; before: { sha256: string }; after?: { sha256: string }; diff?: unknown } ;
  const file = fileOf.path;
  const app = (v[t.appStep] ?? undefined) as { run?: unknown; job?: unknown } | undefined;
  const run8 = typeof app?.run === 'string' ? app.run.slice(0, 8) : undefined;
  const readback = v.readback as { job?: unknown } | undefined;
  // R4 (H46): /iterate ae's render step: aerender's run, judged from its own record as After Effects' run is.
  const render = t.render ? (v[t.render.step] ?? undefined) as { run?: unknown } | undefined : undefined;
  const render8 = typeof render?.run === 'string' ? render.run.slice(0, 8) : undefined;
  const words: Record<string, [string, string]> = {
    prepare: ['before its agent started', 'nothing was run'],
    agent: ['while its agent ran', `${t.app} did not run`],
    checks: ['after its agent ran, before its checks were recorded', `${t.app} did not run`],
    [t.appStep]: [`during its ${t.app} run`, `${run8 ? `${t.app} run ${run8} is judged from its own record (a native run, below)` : `whether ${t.app} started is not recorded`}; nothing was ${target === 'scad' ? 'compared' : 'read back'}`],
    ...(t.render ? { [t.render.step]: [`during its ${t.render.app} run`, `${render8 ? `${t.render.app} run ${render8} is judged from its own record (a native run, below)` : `whether ${t.render.app} started is not recorded`}; nothing was read back`] as [string, string] } : {}),
    readback: ['during its readback', 'there is no verdict'],
    record: ['as it was being recorded', 'its outcome was not kept'],
  };
  const [when, left] = words[step] ?? [`in its ${step} step`, 'nothing more was recorded'];
  const why = `the REPL running it ended ${when} (${jobWords}); ${left}; recorded after a restart, and nothing was run again`;
  const next: string[] = [];
  const agent = v.agent as { run?: string; progress?: string } | undefined;
  if (step === 'agent' && agent?.progress) next.push(`the agent's run ${agent.run} keeps its progress in ${agent.progress}; ${file} may hold its change (sha256 before it: ${short(fileOf.before.sha256)})`);
  if (step === t.appStep && run8) next.push(`${t.app} run ${run8} keeps its own record in .timmy/native/${String(app?.run)}/; /recover judges it once its job has ended`);
  if (t.render && step === t.render.step && render8) next.push(`${t.render.app} run ${render8} keeps its own record in .timmy/native/${String(render?.run)}/; /recover judges it once its job has ended`);
  if (step === 'readback' && typeof readback?.job === 'string') next.push(`/jobs ${readback.job} shows the readback's output while this Timmy's jobs folder keeps it`);
  if (step === 'readback' && target === 'freecad' && run8) next.push(`/freecad readback ${run8} reads its STEP back again`);
  const model = (v.model as { path?: unknown } | undefined)?.path;
  if (fileOf.after) {
    const change = target === 'scad' && Array.isArray(fileOf.diff) ? ` (${scadDiffText(fileOf.diff as ScadParamChange[])})` : '';
    next.push(`${file} holds the agent's change${change}: ${t.command} ${target === 'scad' && typeof model === 'string' ? model : file} runs it`);
  }
  next.push(`/iterate ${target} ${target === 'scad' && typeof model === 'string' ? model : file} "${v.instruction}" starts a new flow from ${file} as it is now`);
  const receipts = (v.receipts ?? {}) as Record<string, unknown>;
  const children = ['agent', t.appStep, ...(t.render ? [t.render.step] : []), 'readback'].map((k) => receipts[k]).filter((x): x is string => typeof x === 'string');
  const { step: _step, ...kept } = v;
  const record = {
    ...kept,
    outcome: 'interrupted',
    ended_in: step,
    ended_at: new Date((d.now ?? Date.now)()).toISOString(),
    why,
    child_receipts: children,
    recovered: {
      at: new Date((d.now ?? Date.now)()).toISOString(), step,
      state_file: { path: state.rel, sha256: state.sha256 },
      ...(jobPart ? { job: jobPart } : {}),
      ...(agentEnd.part ? { agent: agentEnd.part } : {}), // R4 (H59)
      next,
    },
  };
  const rel = flowRecordPath(p.id);
  const w = createProjectJson(d.root, rel, record);
  if (!w.ok) return { kind: 'flow', id: p.id, did: 'failed', ...(stop ? { stopped: stop } : {}), text: `flow ${p.id} was interrupted in its ${step} step${stop ? ` (${jobWords})` : ''}, but its record could not be written: ${d.scrub(w.error)}${agentEnd.words}` };
  const cost = (v.agent as { cost_usd?: unknown } | undefined)?.cost_usd;
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'flow', subject: `flow · iterate · ${target} · ${p.id} · interrupted`, policy: 'human-gated', status: 'failed',
      ...operationOf(v), // R4 (H51)
      project: typeof v.project === 'string' ? v.project : d.project, project_id: projectId(d.root),
      prompt_hash: `sha256:${sha(v.instruction)}`,
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{ path: state.rel, sha256: state.sha256, role: 'the flow state its session left' }, ...(agentEnd.source ? [agentEnd.source] : [])],
      ...(children.length ? { child_receipts: children } : {}),
      discrepancies: [`interrupted: ${why}`],
      ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
      ...lessonsPart(v.lessons), // R4 (H50)
    });
  } catch { receipt = undefined; }
  return {
    kind: 'flow', id: p.id, did: 'interrupted', state: step, record: w.path, ...(receipt ? { receipt } : {}), next, ...(stop ? { stopped: stop } : {}),
    text: `flow ${p.id} was interrupted in its ${step} step (${jobWords})${endedText(jobPart)}: record ${w.path}${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}${agentEnd.words}; next: /iterate ${target} again`,
  };
}

function actNative(d: RecoverDeps, p: Extract<Plan, { kind: 'native' }>): RecoveryItem | undefined {
  const name = `${APP_WORDS[p.app]} run ${p.run.slice(0, 8)}`;
  let rec: ReturnType<typeof readNativeRecord>;
  try { rec = readNativeRecord(d.root, p.run); } catch (e) { return { kind: 'native', id: p.run, did: 'failed', text: `${name} could not be read: ${d.scrub(message(e))}` }; }
  // Judged once: a judgement that appeared since the survey (its own session's) is not repeated.
  if (!rec || rec.verdicts.length) return undefined;
  const job = p.job ? d.jobs.get(p.job.id) ?? p.job : undefined;
  if (job && (phase(job) === 'live' || phase(job) === 'pending')) return undefined;
  try {
    // R4 merge: each app's own re-judgement (After Effects scripts, OpenSCAD and FreeCAD runs have their own).
    const j = p.app === 'afterfx' ? reconcileAe(d.root, p.run, job ? { job } : {})
      : p.app === 'openscad' ? reconcileScad(d.root, p.run, job ? { job } : {})
      : p.app === 'freecad' ? reconcileFreecad(d.root, p.run, job ? { job } : {})
      : p.app === 'illustrator' ? reconcileIllustrator(d.root, p.run, job ? { job } : {}) // R4 (H64)
        : reconcileNative(d.root, p.run, job ? { job } : {});
    return { kind: 'native', id: p.run, did: 'judged', outcome: j.outcome, ...(job ? { job: job.id } : {}), text: `${name}${job ? ` (job ${job.id})` : ''} judged ${j.outcome} from its result file: ${d.scrub(j.why)}` };
  } catch (e) {
    return { kind: 'native', id: p.run, did: 'failed', text: `${name} could not be judged: ${d.scrub(message(e))}` };
  }
}

// ── what the REPL says ───────────────────────────────────────────────────────────

/** One sentence for the pass: what was found and done, kind by kind. */
function summary(items: RecoveryItem[]): string {
  const of = (pred: (i: RecoveryItem) => boolean): RecoveryItem[] => items.filter(pred);
  const parts: string[] = [];
  const followed = of((i) => i.did === 'followed');
  if (followed.length) parts.push(`${count(followed.length, 'recipe job')} still running: following ${followed.length === 1 ? 'it' : 'them'} as ${followed.map((i) => i.job).join(', ')}`);
  const delivered = of((i) => i.did === 'delivered');
  if (delivered.length) parts.push(`${count(delivered.length, 'recipe job')} finished while no REPL followed ${delivered.length === 1 ? 'it' : 'them'}: exports delivered`);
  // R4 (H46): the step jobs an ended REPL left running, stopped before their flows were recorded.
  const stopped = of((i) => !!i.stopped);
  if (stopped.length) parts.push(`${count(stopped.length, 'job')} left running by a REPL that ended ${stopped.length === 1 ? 'was' : 'were'} stopped: ${stopped.map((i) => i.stopped!.job).join(', ')}`);
  const flows = of((i) => i.kind === 'flow' && i.did === 'interrupted');
  if (flows.length) parts.push(`${count(flows.length, 'flow')} ${flows.length === 1 ? 'was' : 'were'} interrupted: ${flows.map((i) => i.id).join(', ')} (record${flows.length === 1 ? '' : 's'} written)`);
  // R4 (H58): /run jobs whose session ended while they ran, each ended in its own job record
  const wfRuns = of((i) => i.did === 'interrupted' && i.kind === 'workflow');
  if (wfRuns.length) parts.push(`${count(wfRuns.length, 'workflow run')} ${wfRuns.length === 1 ? 'was' : 'were'} interrupted: ${wfRuns.map((i) => i.id).join(', ')} (job record${wfRuns.length === 1 ? '' : 's'} ended)`);
  // R4 (H59): code agent runs an ended REPL left (not a flow's step), each run's own record ended as interrupted.
  const agentRuns = of((i) => i.kind === 'agent-run' && i.did === 'interrupted');
  if (agentRuns.length) parts.push(`${count(agentRuns.length, 'agent run')} left by a REPL that ended ${agentRuns.length === 1 ? 'was' : 'were'} recorded as interrupted: ${agentRuns.map((i) => i.id).join(', ')} (no result written)`);
  const judged = of((i) => i.did === 'judged');
  if (judged.length) parts.push(`${count(judged.length, 'native run')} judged from ${judged.length === 1 ? 'its result file' : 'their result files'}`);
  const failed = of((i) => i.did === 'failed');
  if (failed.length) parts.push(`${failed.length} could not be picked up`);
  const incomplete = of((i) => i.did === 'incomplete');
  if (incomplete.length) parts.push(`${incomplete.length} recipe ${incomplete.length === 1 ? 'copy is' : 'copies are'} incomplete: /recipe copy`);
  const attention = of((i) => i.kind === 'recipe' && i.did === 'left' && i.attention === true);
  if (attention.length) parts.push(`${count(attention.length, 'recipe job')} ${attention.length === 1 ? 'needs' : 'need'} /recipe recover`);
  // R4 (H46): a step's job left running by a REPL that ended, not stopped (its group could not be proven the job's).
  const running = of((i) => (i.kind === 'flow' || i.kind === 'workflow' || i.kind === 'agent-run') && i.did === 'left' && i.attention === true);
  if (running.length) parts.push(`${count(running.length, 'job')} left running by a REPL that ended ${running.length === 1 ? 'was' : 'were'} not stopped: what runs, and how to stop it, below`);
  // R4 (H52): OpenHands containers an ended session left running: stopped, or left with what to do.
  const containers = of((i) => i.kind === 'agent' && i.did === 'stopped');
  if (containers.length) parts.push(`${count(containers.length, 'OpenHands container')} left running by a REPL that ended ${containers.length === 1 ? 'was' : 'were'} stopped`);
  const agentsLeft = of((i) => i.kind === 'agent' && i.did === 'left' && i.attention === true);
  if (agentsLeft.length) parts.push(`${count(agentsLeft.length, 'OpenHands container')} ${agentsLeft.length === 1 ? 'was' : 'were'} not stopped: what runs, and how to stop it, below`);
  const left = of((i) => i.did === 'left' && !i.attention);
  if (left.length) parts.push(`${left.length} left as ${left.length === 1 ? 'it is' : 'they are'}`);
  return parts.join('; ');
}

/**
 * The lines a pass prints. At start ('start'): only what was done or needs the operator, and nothing at all when
 * there is none. On /recover ('command'): everything seen, or one sentence saying there was nothing.
 */
export function recoveryLines(r: RecoveryReport, o: { glyphs: GlyphSet; mode: 'start' | 'command' }): Line[] {
  const shown = o.mode === 'start' ? r.items.filter((i) => i.did !== 'left' || i.attention) : r.items;
  if (!shown.length) {
    return o.mode === 'start' ? [] : [[{ text: '  Recovery   ', role: 'secondary' }, { text: `nothing to pick up in ${r.project}: no recipe job, flow or native run was left by a REPL that ended`, role: 'secondary' }]];
  }
  const g = o.glyphs;
  const lines: Line[] = [[{ text: o.mode === 'start' ? '  Recovered  ' : '  Recovery   ', role: 'secondary' }, { text: summary(shown), role: 'strong' }]];
  for (const i of shown) {
    const bad = i.did === 'failed' || i.did === 'incomplete' || i.attention === true || (i.did === 'judged' && i.outcome === 'failed') || i.stopped?.cleanup === 'unresolved';
    const mark = bad ? g.fail : i.did === 'left' || (i.did === 'judged' && i.outcome !== 'ok') ? g.bullet : g.ok;
    lines.push([{ text: `    ${mark} `, role: bad ? 'failure' : undefined }, { text: i.text, role: bad ? 'failure' : 'secondary' }]);
    for (const x of i.extra ?? []) lines.push([{ text: `      ${x}`, role: x === DOCTRINE_15 ? 'strong' : 'secondary' }]);
  }
  return lines;
}
