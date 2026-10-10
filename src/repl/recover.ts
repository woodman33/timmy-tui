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
 *         snapshot), sealed as a recover receipt; not when its copy folder is already in the project, or when a
 *         recover receipt of this project delivered it before (a copy the operator removed is not put back);
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
 *     judged by the native part below, as any run is.
 *   native runs (.timmy/native/<run>; src/native)
 *     A run that started (started.json) and has no judgement is judged from its result file (reconcileNative, or
 *     reconcileAe for an After Effects script run) once its job no longer runs; the judgement goes to the run's
 *     verdicts.jsonl. A run stopped with /stop is not judged, as before.
 *
 * A stale job record is read again after a short wait before anything acts on it: a session that is alive records
 * its job's end well within that time. Nothing here starts a recipe, an agent, a native app or a readback, signals a
 * process or reads a PID; the one process it may start is a recipe watcher, which reads status and copies verified
 * bytes.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { jobDirectory, status, type Job, type JobStatus } from '../../lanes/recipes/jobs.js';
import { deliver, DOCTRINE_15, isRecipeJobId, outcomeLines, outDir, RECIPE_ID, short, watcherSpec } from '../recipes/index.js';
import { diffText, FLOW_ID, FLOW_SCHEMA, FLOW_WORK_DIR, flowRecordPath, flowWorkDir, type FlowRecord, type FlowStep } from '../flows/iterate.js';
import { scadDiffText, type ScadParamChange } from '../flows/iterate-scad.js';
import { listNativeRuns, readNativeRecord, reconcileNative, type NativeApp } from '../native/index.js';
import { reconcileAe } from '../native/ae-author.js';
import { reconcileScad } from '../native/openscad.js';
import { reconcileFreecad } from '../native/freecad.js';
import { projectId } from '../project/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';

type Line = Segment[];

/** A recipe whose worker last answered longer ago than this is not followed again: /recipe recover reads it. */
export const WORKER_SILENT_MS = 30_000;
/** A flow with no job of its step running is interrupted once nothing about it has changed for this long. */
export const FLOW_QUIET_MS = 10 * 60_000;
/** How long a stale job record is given to be recorded by a session that is still alive, before it is believed. */
export const SETTLE_MS = 1500;

/** The watcher's entry on its command line (src/recipes/watch.ts, or watch.js once built), before the root and the UUID. */
const WATCH_ENTRY = /[\\/]recipes[\\/]watch\.(?:ts|js)$/;
const JOB_ID = /^j[0-9a-f]{6}$/;
const STEPS: ReadonlySet<string> = new Set<FlowStep>(['prepare', 'agent', 'checks', 'build', 'readback', 'record']);
/**
 * R4 (H33): the flows with a `target`: their app's name, the step the app's job runs in, and the file the agent was asked
 * to change (where the state keeps it). The tray flow has no target and keeps its own words below.
 */
const TARGETS: Record<string, { app: string; appStep: string; command: string; file: 'parameters' | 'script' }> = {
  scad: { app: 'OpenSCAD', appStep: 'openscad', command: '/scad', file: 'parameters' },
  freecad: { app: 'FreeCAD', appStep: 'freecad', command: '/freecad', file: 'script' },
  blender: { app: 'Blender', appStep: 'blender', command: '/blender', file: 'script' },
};
const TARGET_STEPS: ReadonlySet<string> = new Set(['prepare', 'agent', 'checks', 'openscad', 'freecad', 'blender', 'readback', 'record']);
const APP_WORDS: Record<NativeApp, string> = { c4dpy: 'Cinema 4D', aerender: 'After Effects render', blender: 'Blender', afterfx: 'After Effects script', openscad: 'OpenSCAD', freecad: 'FreeCAD' };
/** A recipe job's state now, as a flow's record says it (lanes/recipes/jobs.ts states, and unreadable). */
const RECIPE_NOW: Record<string, string> = { running: 'still runs', succeeded: 'has succeeded', failed: 'has failed', cancelled: 'was cancelled', interrupted: 'was interrupted', queued: 'is queued', unreadable: 'could not be read' };

export interface RecoverDeps {
  /** the project folder looked at, and its name */
  root: string;
  project: string;
  /** this REPL's jobs: its own and the records earlier sessions left in the same jobs folder (JobManager.list/get) */
  jobs: { list(): JobRecord[]; get(id: string): JobRecord | undefined };
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
}

/** What one pass did about one operation, or saw and left (did 'left'). */
export interface RecoveryItem {
  kind: 'recipe' | 'flow' | 'native';
  /** the operation's own ID: a recipe job's UUID, a flow's id, a native run's token */
  id: string;
  did: 'followed' | 'delivered' | 'interrupted' | 'judged' | 'failed' | 'left';
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
}
export interface RecoveryReport { project: string; items: RecoveryItem[] }

type Phase = 'live' | 'pending' | 'stale' | 'ended';
/** A job record's phase: stale (no final state and its process gone: its session ended), live, queued, or ended. */
const phase = (j: JobRecord): Phase => (j.stale ? 'stale' : j.state === 'running' || j.state === 'ready' ? 'live' : j.state === 'queued' ? 'pending' : 'ended');

/** A flow's state as its session left it; `target` (R4, H33) for an OpenSCAD, FreeCAD or Blender flow, absent for the tray's. */
interface FlowState { value: FlowRecord & { step: FlowStep; target?: string } & Record<string, unknown>; rel: string; sha256: string; mtimeMs: number }
type Plan =
  | { kind: 'recipe'; key: string; uuid: string; act: 'follow' | 'deliver'; viaStale: boolean }
  | { kind: 'flow'; key: string; id: string; viaStale: boolean; job?: JobRecord; state: FlowState }
  | { kind: 'native'; key: string; run: string; app: NativeApp; viaStale: boolean; job?: JobRecord };
interface Survey { plans: Plan[]; left: RecoveryItem[] }

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });
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

/** The job of the step a flow's state says runs: the agent's, the recipe watcher's, the app's (R4, H33) or the readback's. */
function stepJob(v: FlowState['value']): string | undefined {
  const step = String(v.step);
  const app = v.target !== undefined && TARGETS[String(v.target)]?.appStep === step ? (v[step] as { job?: unknown } | undefined)?.job : undefined;
  const id = step === 'agent' ? v.agent?.job : step === 'build' ? v.rebuild?.job : step === 'readback' ? v.readback?.job : app;
  return typeof id === 'string' && JOB_ID.test(id) ? id : undefined;
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
    // Cheap checks first, so a pass does not verify every finished recipe again: a copy folder only a delivery makes
    // means it succeeded and was delivered; a recipe no watcher followed matters here only while it runs.
    if (newest && lexists(path.join(d.root, outDir(uuid)))) continue;
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
      left.push({ kind: 'flow', id, did: 'left', job: job.id, text: `flow ${id} is in its ${step} step and its job ${job.id} still runs (${d.mine(job.id) ? 'this REPL' : 'another session'}): /recover again once it has ended` });
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
    const item = act(d, 'flow', p.id, () => actFlow(d, p, recipes));
    if (item) done.push(item);
  }
  for (const p of s.plans) {
    if (p.kind !== 'native') continue;
    const item = act(d, 'native', p.run, () => actNative(d, p));
    if (item) done.push(item);
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
  // It succeeded (perhaps while it was surveyed): its exports are delivered once, never over a copy already there.
  if (lexists(path.join(d.root, outDir(uuid)))) return undefined;
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

/** Writes a JSON file in the project only where nothing is: a temporary file, then a hard link that fails when a file is there. */
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
    try { fs.linkSync(tmp, path.join(dir, path.basename(abs))); } finally { fs.unlinkSync(tmp); }
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EEXIST' ? `${rel} is already there; it was left as it is` : message(e) };
  }
  return { ok: true, path: rel, sha256: sha(body), bytes: Buffer.byteLength(body) };
}

function actFlow(d: RecoverDeps, p: Extract<Plan, { kind: 'flow' }>, recipes: Map<string, RecoveryItem>): RecoveryItem | undefined {
  const rel = flowRecordPath(p.id);
  // Read again: the flow's own session may have written its record, or moved on, since the survey.
  if (lexists(path.join(d.root, rel))) return undefined;
  const state = readState(d.root, p.id);
  if (!state || state.value.outcome !== 'running' || state.sha256 !== p.state.sha256) return undefined;
  const v = state.value;
  const step = v.step;
  const job = p.job ? d.jobs.get(p.job.id) ?? p.job : undefined;
  if (job && (phase(job) === 'live' || phase(job) === 'pending')) return undefined;
  const jobWords = !job ? (stepJob(v) ? `its job ${stepJob(v)} has no record in this Timmy's jobs folder` : 'no job of that step was recorded')
    : job.stale ? `its job ${job.id} was left ${job.state} and its process is gone`
      : `its job ${job.id} ${job.state}, and the flow did not go on for ${ago(FLOW_QUIET_MS)}`;
  // R4 (H33): an OpenSCAD, FreeCAD or Blender flow, with its own steps and words.
  if (v.target !== undefined) return actTargetFlow(d, p, state, job, jobWords);
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
      ...(job ? { job: { id: job.id, state: job.state, ...(job.stale ? { stale: true } : {}) } } : {}),
      next,
    },
  };
  const w = createProjectJson(d.root, rel, record);
  if (!w.ok) return { kind: 'flow', id: p.id, did: 'failed', text: `flow ${p.id} was interrupted in its ${step} step, but its record could not be written: ${d.scrub(w.error)}` };
  const cost = v.agent?.cost_usd;
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'flow', subject: `flow · iterate · tray · ${p.id} · interrupted`, policy: 'human-gated', status: 'failed',
      project: typeof v.project === 'string' ? v.project : d.project, project_id: projectId(d.root),
      prompt_hash: `sha256:${sha(v.instruction)}`,
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{ path: state.rel, sha256: state.sha256, role: 'the flow state its session left' }],
      ...(children.length ? { child_receipts: children } : {}),
      discrepancies: [`interrupted: ${why}`],
      // The agent's cost as its own receipt sealed it, when it got that far; unknown is never written as 0.
      ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
    });
  } catch { receipt = undefined; }
  const shortNext = uuid ? `/recipe recover ${uuid}, or /iterate tray again` : '/iterate tray again';
  return {
    kind: 'flow', id: p.id, did: 'interrupted', state: step, record: w.path, ...(receipt ? { receipt } : {}), next,
    text: `flow ${p.id} was interrupted in its ${step} step (${jobWords}): record ${w.path}${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}; next: ${shortNext}`,
  };
}

/**
 * R4 (H33): an interrupted OpenSCAD, FreeCAD or Blender flow: its record, written once as the tray's is (outcome
 * interrupted, the step it ended in, why and what to do next), sealed as a flow receipt. The app's own run, when it
 * started, is judged from its own record by the native part of the pass, as any run is; nothing is run again here.
 */
function actTargetFlow(d: RecoverDeps, p: Extract<Plan, { kind: 'flow' }>, state: FlowState, job: JobRecord | undefined, jobWords: string): RecoveryItem | undefined {
  const v = state.value;
  const target = String(v.target);
  const t = TARGETS[target];
  const step = String(v.step);
  const fileOf = v[t.file] as { path: string; before: { sha256: string }; after?: { sha256: string }; diff?: unknown } ;
  const file = fileOf.path;
  const app = (v[t.appStep] ?? undefined) as { run?: unknown; job?: unknown } | undefined;
  const run8 = typeof app?.run === 'string' ? app.run.slice(0, 8) : undefined;
  const readback = v.readback as { job?: unknown } | undefined;
  const words: Record<string, [string, string]> = {
    prepare: ['before its agent started', 'nothing was run'],
    agent: ['while its agent ran', `${t.app} did not run`],
    checks: ['after its agent ran, before its checks were recorded', `${t.app} did not run`],
    [t.appStep]: [`during its ${t.app} run`, `${run8 ? `${t.app} run ${run8} is judged from its own record (a native run, below)` : `whether ${t.app} started is not recorded`}; nothing was ${target === 'scad' ? 'compared' : 'read back'}`],
    readback: ['during its readback', 'there is no verdict'],
    record: ['as it was being recorded', 'its outcome was not kept'],
  };
  const [when, left] = words[step] ?? [`in its ${step} step`, 'nothing more was recorded'];
  const why = `the REPL running it ended ${when} (${jobWords}); ${left}; recorded after a restart, and nothing was run again`;
  const next: string[] = [];
  const agent = v.agent as { run?: string; progress?: string } | undefined;
  if (step === 'agent' && agent?.progress) next.push(`the agent's run ${agent.run} keeps its progress in ${agent.progress}; ${file} may hold its change (sha256 before it: ${short(fileOf.before.sha256)})`);
  if (step === t.appStep && run8) next.push(`${t.app} run ${run8} keeps its own record in .timmy/native/${String(app?.run)}/; /recover judges it once its job has ended`);
  if (step === 'readback' && typeof readback?.job === 'string') next.push(`/jobs ${readback.job} shows the readback's output while this Timmy's jobs folder keeps it`);
  if (step === 'readback' && target === 'freecad' && run8) next.push(`/freecad readback ${run8} reads its STEP back again`);
  const model = (v.model as { path?: unknown } | undefined)?.path;
  if (fileOf.after) {
    const change = target === 'scad' && Array.isArray(fileOf.diff) ? ` (${scadDiffText(fileOf.diff as ScadParamChange[])})` : '';
    next.push(`${file} holds the agent's change${change}: ${t.command} ${target === 'scad' && typeof model === 'string' ? model : file} runs it`);
  }
  next.push(`/iterate ${target} ${target === 'scad' && typeof model === 'string' ? model : file} "${v.instruction}" starts a new flow from ${file} as it is now`);
  const receipts = (v.receipts ?? {}) as Record<string, unknown>;
  const children = ['agent', t.appStep, 'readback'].map((k) => receipts[k]).filter((x): x is string => typeof x === 'string');
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
      ...(job ? { job: { id: job.id, state: job.state, ...(job.stale ? { stale: true } : {}) } } : {}),
      next,
    },
  };
  const rel = flowRecordPath(p.id);
  const w = createProjectJson(d.root, rel, record);
  if (!w.ok) return { kind: 'flow', id: p.id, did: 'failed', text: `flow ${p.id} was interrupted in its ${step} step, but its record could not be written: ${d.scrub(w.error)}` };
  const cost = (v.agent as { cost_usd?: unknown } | undefined)?.cost_usd;
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'flow', subject: `flow · iterate · ${target} · ${p.id} · interrupted`, policy: 'human-gated', status: 'failed',
      project: typeof v.project === 'string' ? v.project : d.project, project_id: projectId(d.root),
      prompt_hash: `sha256:${sha(v.instruction)}`,
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{ path: state.rel, sha256: state.sha256, role: 'the flow state its session left' }],
      ...(children.length ? { child_receipts: children } : {}),
      discrepancies: [`interrupted: ${why}`],
      ...(typeof cost === 'number' ? { cost_usd: cost } : cost === null ? { cost_measured: false } : {}),
    });
  } catch { receipt = undefined; }
  return {
    kind: 'flow', id: p.id, did: 'interrupted', state: step, record: w.path, ...(receipt ? { receipt } : {}), next,
    text: `flow ${p.id} was interrupted in its ${step} step (${jobWords}): record ${w.path}${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}; next: /iterate ${target} again`,
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
  const flows = of((i) => i.did === 'interrupted');
  if (flows.length) parts.push(`${count(flows.length, 'flow')} ${flows.length === 1 ? 'was' : 'were'} interrupted: ${flows.map((i) => i.id).join(', ')} (record${flows.length === 1 ? '' : 's'} written)`);
  const judged = of((i) => i.did === 'judged');
  if (judged.length) parts.push(`${count(judged.length, 'native run')} judged from ${judged.length === 1 ? 'its result file' : 'their result files'}`);
  const failed = of((i) => i.did === 'failed');
  if (failed.length) parts.push(`${failed.length} could not be picked up`);
  const attention = of((i) => i.did === 'left' && i.attention === true);
  if (attention.length) parts.push(`${count(attention.length, 'recipe job')} ${attention.length === 1 ? 'needs' : 'need'} /recipe recover`);
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
    const bad = i.did === 'failed' || i.attention === true || (i.did === 'judged' && i.outcome === 'failed');
    const mark = bad ? g.fail : i.did === 'left' || (i.did === 'judged' && i.outcome !== 'ok') ? g.bullet : g.ok;
    lines.push([{ text: `    ${mark} `, role: bad ? 'failure' : undefined }, { text: i.text, role: bad ? 'failure' : 'secondary' }]);
    for (const x of i.extra ?? []) lines.push([{ text: `      ${x}`, role: x === DOCTRINE_15 ? 'strong' : 'secondary' }]);
  }
  return lines;
}
