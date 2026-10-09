/**
 * Native creative apps as Timmy jobs (R2): Cinema 4D through c4dpy and After Effects through aerender.
 * Each run is an ordinary background job (src/jobs) in the project's folder, so it has a process group,
 * a time limit, a record, a private log, /stop and a receipt like any other job, and what it makes stays
 * where it was written: editable native files (.c4d) and renders, in the project.
 *
 * What each path can do, exactly:
 *   c4dpy     Cinema 4D's own Python, headless: runs a .py file that can build or change a document,
 *             save it as an editable .c4d and render through Cinema 4D's renderer. The script writes a
 *             result file (workers/c4d/timmy_c4d.py) and that file, not c4dpy's exit status, says how
 *             the run went: a retained run on the operator's machine wrote ok:true while c4dpy exited 1.
 *   aerender  renders an EXISTING .aep/.aepx headless. It does not make or edit a project; that needs
 *             After Effects' own scripting through the app, which these jobs do not do.
 *
 * Finding a program is not running it: the /tools rows say 'installed' at most. Nothing in this module
 * has been run against the real applications here (see tests/native.test.ts: test doubles only).
 */
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityRow } from '../capabilities/index.js';
import type { JobRecord, JobSpec, JobState } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';

export type NativeApp = 'c4dpy' | 'aerender';
type Env = Record<string, string | undefined>;

export interface NativeFound {
  app: NativeApp;
  /** the executable */
  path: string;
  /** how it was found: its environment variable, the /Applications scan, or PATH */
  how: 'env' | 'applications' | 'path';
  /** from the application folder's name, e.g. '2026' */
  version?: string;
  /** the application folder it was found in (the /Applications scan) */
  folder?: string;
}

/** What the finder reads, so a test can stand in for the machine. */
export interface FinderSeams {
  platform?: NodeJS.Platform;
  /** where macOS keeps applications (default /Applications) */
  applications?: string;
  /** an executable regular file */
  isFile?: (file: string) => boolean;
  /** the names in a folder; [] when it cannot be read */
  listDir?: (dir: string) => string[];
  /** the program's path in a PATH folder, or null */
  onPath?: (program: string) => string | null;
}

interface AppInfo {
  envVar: string;
  /** an application folder's name starts with this (then its version) */
  prefix: string;
  /** where the executable sits inside that folder, first match wins */
  inside: string[];
  program: string;
  name: string;
  setup: string;
}

export const NATIVE_APPS: Record<NativeApp, AppInfo> = {
  c4dpy: {
    envVar: 'TIMMY_C4DPY', prefix: 'Maxon Cinema 4D', inside: ['c4dpy.app/Contents/MacOS/c4dpy', 'c4dpy'], program: 'c4dpy',
    name: 'Cinema 4D (c4dpy)',
    setup: 'install Cinema 4D; or set TIMMY_C4DPY to its c4dpy program',
  },
  aerender: {
    envVar: 'TIMMY_AERENDER', prefix: 'Adobe After Effects', inside: ['aerender'], program: 'aerender',
    name: 'After Effects (aerender)',
    setup: 'install After Effects; or set TIMMY_AERENDER to its aerender',
  },
};

const executable = (file: string): boolean => {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
};
const listDir = (dir: string): string[] => {
  try { return readdirSync(dir); } catch { return []; }
};
function whichPath(program: string, env: Env): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const at = path.join(dir, program);
    if (executable(at)) return at;
  }
  return null;
}

/** '2026' → [2026]; '2025.2' → [2025, 2]; anything without a leading number sorts after the numbered. */
function versionKey(version: string): number[] | null {
  const m = /^(\d+(?:\.\d+)*)/.exec(version);
  return m ? m[1].split('.').map(Number) : null;
}
function newerFirst(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  if (ka && !kb) return -1;
  if (!ka && kb) return 1;
  if (ka && kb) {
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d) return d;
    }
  }
  return b.localeCompare(a);
}

/**
 * Where the app's program is: its environment variable first (TIMMY_C4DPY, TIMMY_AERENDER; a .app bundle
 * is opened to the executable inside it), then on macOS the /Applications folders newest version first,
 * then PATH. A variable that names nothing runnable stops the search with `problem`: an explicit setting
 * is not silently replaced by another copy.
 */
export function locateNative(app: NativeApp, env: Env = process.env, seams: FinderSeams = {}): { found: NativeFound | null; problem?: string } {
  const info = NATIVE_APPS[app];
  const isFile = seams.isFile ?? executable;
  const raw = env[info.envVar]?.trim();
  if (raw) {
    let file = raw.replace(/\/+$/, '');
    if (file.endsWith('.app')) file = path.join(file, 'Contents', 'MacOS', path.basename(file, '.app'));
    if (isFile(file)) return { found: { app, path: file, how: 'env' } };
    return { found: null, problem: `${info.envVar} is set, but nothing runnable is there` };
  }
  if ((seams.platform ?? process.platform) === 'darwin') {
    const apps = seams.applications ?? '/Applications';
    const folders = (seams.listDir ?? listDir)(apps)
      .filter((name) => name === info.prefix || name.startsWith(`${info.prefix} `))
      .map((name) => ({ name, version: name.slice(info.prefix.length).trim() }))
      .sort((a, b) => newerFirst(a.version, b.version));
    for (const folder of folders) {
      for (const inside of info.inside) {
        const file = path.join(apps, folder.name, ...inside.split('/'));
        if (isFile(file)) return { found: { app, path: file, how: 'applications', folder: folder.name, ...(folder.version ? { version: folder.version } : {}) } };
      }
    }
  }
  const onPath = seams.onPath ?? ((program: string) => whichPath(program, env));
  const fromPath = onPath(info.program);
  return { found: fromPath ? { app, path: fromPath, how: 'path' } : null };
}

export const findC4dpy = (env: Env = process.env, seams: FinderSeams = {}): NativeFound | null => locateNative('c4dpy', env, seams).found;
export const findAerender = (env: Env = process.env, seams: FinderSeams = {}): NativeFound | null => locateNative('aerender', env, seams).found;

// ── job specs ─────────────────────────────────────────────────────────────────

/** What judging a native job needs, carried on its spec (JobManager ignores it). */
export interface NativeMeta {
  app: NativeApp;
  /** the project folder, resolved */
  root: string;
  /** this run's token (TIMMY_RUN): a result file carrying another token is not this run's */
  run: string;
  /** c4dpy: the result file the script writes (TIMMY_RESULT) */
  result?: string;
  /** aerender: the file it renders to */
  output?: string;
  /** files that must exist when it is judged, relative to root */
  expect: string[];
}
export interface NativeJobSpec extends JobSpec { native: NativeMeta }

export class NativeNotFound extends Error {
  constructor(readonly app: NativeApp, readonly setup: string, problem?: string) {
    super(`${NATIVE_APPS[app].name} was not found on this machine${problem ? ` (${problem})` : ''}`);
    this.name = 'NativeNotFound';
  }
}

/**
 * The folder holding timmy_c4d.py (workers/c4d), for TIMMY_C4D_LIB: found from this module's own place in
 * a checkout (src/native) or a build (dist/src/native); undefined when neither has it.
 */
export function c4dHelperDir(): string | undefined {
  let here: string;
  try { here = path.dirname(fileURLToPath(import.meta.url)); } catch { return undefined; }
  for (const up of ['../..', '../../..']) {
    const dir = path.resolve(here, up, 'workers', 'c4d');
    try { if (statSync(path.join(dir, 'timmy_c4d.py')).isFile()) return dir; } catch { /* not here */ }
  }
  return undefined;
}

/** The default limit: a 96-frame turntable on the Standard renderer is minutes, not hours. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * R2: a native app finds its license and preferences in HOME. When Timmy itself runs with a separate HOME
 * (a sandbox), TIMMY_NATIVE_HOME names the home that holds them; it becomes the native job's HOME.
 */
function nativeHome(extra?: NodeJS.ProcessEnv): { HOME?: string } {
  const home = extra?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME;
  return home ? { HOME: home } : {};
}

function realRoot(root: string): string {
  try { return realpathSync(root); } catch { throw new Error('the project folder is gone'); }
}
function inside(root: string, rel: string): { path: string; rel: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) throw new Error(at.error);
  return at;
}
function program(app: NativeApp, bin: string | undefined, env: Env): string {
  if (bin) return bin;
  const { found, problem } = locateNative(app, env);
  if (!found) throw new NativeNotFound(app, NATIVE_APPS[app].setup, problem);
  return found.path;
}

export interface C4dpyJobInput {
  /** the Python file c4dpy runs, relative to root */
  script: string;
  args?: string[];
  root: string;
  project: string;
  timeoutMs?: number;
  /** where the script writes its result file, relative to root (default out/timmy-result.json) */
  result?: string;
  /** files that must exist besides those the result file names, relative to root */
  expect?: string[];
  /** the c4dpy to run (default: findC4dpy()) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  label?: string;
}

/**
 * A task job running `c4dpy <script.py> [args]` in the project folder. The script learns where to write
 * from its environment: TIMMY_RESULT (the result file), TIMMY_RUN (this run's token, written back into
 * the result), TIMMY_ROOT (the project folder), TIMMY_OUT (its out/ folder) and TIMMY_C4D_LIB (the folder
 * with timmy_c4d.py, when this checkout has it).
 */
export function c4dpyJob(input: C4dpyJobInput): NativeJobSpec {
  const root = realRoot(input.root);
  const script = inside(root, input.script);
  let isScript = false;
  try { isScript = statSync(script.path).isFile(); } catch { /* missing */ }
  if (!isScript) throw new Error(`no script at ${script.rel}`);
  if (!/\.py$/i.test(script.rel)) throw new Error(`${script.rel} is not a Python file (.py)`);
  const result = inside(root, input.result ?? 'out/timmy-result.json');
  const expect = (input.expect ?? []).map((rel) => inside(root, rel).rel);
  const bin = program('c4dpy', input.bin, { ...process.env, ...input.env });
  const run = randomUUID();
  const lib = input.env?.TIMMY_C4D_LIB ?? c4dHelperDir();
  return {
    kind: 'task', label: input.label ?? `Cinema 4D · ${script.rel}`, project: input.project, root,
    command: bin, args: [script.path, ...(input.args ?? [])],
    env: { ...input.env, ...nativeHome(input.env), TIMMY_RESULT: result.path, TIMMY_RUN: run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, 'out'), ...(lib ? { TIMMY_C4D_LIB: lib } : {}) },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // R2 (the Mac run): without its license, c4dpy asks this and waits for a person, even with its input closed.
    stopWhen: { pattern: /Enter the license method/i, error: 'Cinema 4D asked how to license it and waits for a person: run Cinema 4D once as this user, or set TIMMY_NATIVE_HOME to the home that holds its license' },
    native: { app: 'c4dpy', root, run, result: result.path, expect },
  };
}

export interface AerenderJobInput {
  /** the existing .aep or .aepx, relative to root */
  projectFile: string;
  /** the composition to render, by name */
  comp: string;
  /** the file to render to, relative to root; [####] in its name is a frame number (an image sequence) */
  output: string;
  root: string;
  project: string;
  timeoutMs?: number;
  /** -RStemplate: a render settings template by name */
  rsTemplate?: string;
  /** -OMtemplate: an output module template by name */
  omTemplate?: string;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

/**
 * A task job running `aerender -project <file> -comp "<name>" -output <file>` in the project folder.
 * The output's folder is made here, before the job starts.
 */
export function aerenderJob(input: AerenderJobInput): NativeJobSpec {
  const root = realRoot(input.root);
  const project = inside(root, input.projectFile);
  if (!/\.aepx?$/i.test(project.rel)) throw new Error(`${project.rel} is not an After Effects project (.aep or .aepx)`);
  let isProject = false;
  try { isProject = statSync(project.path).isFile(); } catch { /* missing */ }
  if (!isProject) throw new Error(`no project file at ${project.rel}: aerender renders an existing project, it cannot make one`);
  if (typeof input.comp !== 'string' || !input.comp.trim()) throw new Error('name the composition to render');
  const output = inside(root, input.output);
  const bin = program('aerender', input.bin, { ...process.env, ...input.env });
  mkdirSync(path.dirname(output.path), { recursive: true });
  return {
    kind: 'task', label: input.label ?? `After Effects · ${project.rel} › ${input.comp}`, project: input.project, root,
    command: bin,
    args: [
      '-project', project.path, '-comp', input.comp, '-output', output.path,
      ...(input.rsTemplate ? ['-RStemplate', input.rsTemplate] : []),
      ...(input.omTemplate ? ['-OMtemplate', input.omTemplate] : []),
    ],
    ...(input.env || nativeHome().HOME ? { env: { ...input.env, ...nativeHome(input.env) } } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    native: { app: 'aerender', root, run: randomUUID(), output: output.path, expect: [output.rel] },
  };
}

// ── judging a run ─────────────────────────────────────────────────────────────

export type NativeResultRead = { state: 'missing' } | { state: 'unreadable'; error: string } | { state: 'read'; data: unknown };

/** The script's result file: missing, unreadable (not JSON), or read. */
export function readNativeResult(file: string): NativeResultRead {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', error: (e as Error).message };
  }
  try { return { state: 'read', data: JSON.parse(text) as unknown }; } catch (e) { return { state: 'unreadable', error: (e as Error).message }; }
}

export interface NativeFileCheck {
  /** as the result file or the spec named it */
  path: string;
  present: boolean;
  /** what the result file recorded */
  recorded?: string;
  /** the file's sha256 now, when the result recorded one */
  sha256?: string;
  matches?: boolean;
}
export interface NativeJudgement {
  outcome: 'ok' | 'failed' | 'unknown';
  why: string;
  /** the process's end, recorded beside the outcome; never the outcome on its own */
  exit: { state: JobState; code: number | null; signal: string | null; error?: string };
  files: NativeFileCheck[];
  /** c4dpy: what the script read from c4d.GetC4DVersion() */
  c4dVersion?: unknown;
}
export interface JudgeOptions {
  /** the project folder: file names are relative to it */
  root: string;
  app?: NativeApp;
  /** this run's token; a result carrying another is from another run */
  run?: string;
  /** files that must exist, relative to root */
  expect?: string[];
  /** false when the app writes no result file (aerender): its expected files and exit decide */
  resultExpected?: boolean;
}

const LIVE: ReadonlySet<JobState> = new Set<JobState>(['queued', 'running', 'ready']);

function exitText(job: JobRecord): string {
  if (job.error === 'timed out') return 'timed out (its time limit stopped it)';
  if (job.error && job.state === 'failed') return `was stopped: ${job.error}`;
  if (job.state === 'cancelled') return 'was stopped';
  if (job.signal) return `ended by ${job.signal}`;
  if (typeof job.exitCode === 'number') return `exited ${job.exitCode}`;
  return job.error ? `did not run (${job.error})` : 'ended without an exit status';
}

function sha256File(file: string): string | undefined {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return undefined; }
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
    return hash.digest('hex');
  } catch { return undefined; } finally { closeSync(fd); }
}

/** Whether a file (or, for a name with [####], any frame of the sequence) exists, written since `since`. */
function presentSince(root: string, name: string, since: number): boolean {
  const abs = path.isAbsolute(name) ? name : path.join(root, name);
  const fresh = (file: string): boolean => {
    try { const s = statSync(file); return s.isFile() && s.size > 0 && s.mtimeMs >= since; } catch { return false; }
  };
  const base = path.basename(abs);
  if (!/\[#+\]/.test(base)) return fresh(abs);
  const pattern = new RegExp(`^${base.split(/\[#+\]/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+')}$`);
  return listDir(path.dirname(abs)).some((name) => pattern.test(name) && fresh(path.join(path.dirname(abs), name)));
}

/**
 * The outcome of a native run, from what it left behind. The process's exit is recorded beside the
 * outcome and never decides it alone:
 *   ok       c4dpy: the result file is this run's, says ok:true, and every file it names (and every
 *            expected file) is there, with the sha256 it recorded. aerender: the output was written
 *            during the run and aerender exited 0.
 *   failed   the result says ok:false; or it says ok but a file is missing or differs; or there is no
 *            result (no output) and the process did not exit 0.
 *   unknown  still running; exited 0 with no result file (no output); a result from another run, or
 *            one without ok; aerender's output there but a non-zero exit.
 * `result` is the parsed result file, or undefined when there was none.
 */
export function judgeNativeRun(job: JobRecord, result: unknown, opts: JudgeOptions): NativeJudgement {
  const app = opts.app ?? 'c4dpy';
  const who = NATIVE_APPS[app].program;
  const exit: NativeJudgement['exit'] = { state: job.state, code: job.exitCode ?? null, signal: job.signal ?? null, ...(job.error ? { error: job.error } : {}) };
  const verdict = (outcome: NativeJudgement['outcome'], why: string, files: NativeFileCheck[] = [], extra: Partial<NativeJudgement> = {}): NativeJudgement => ({ outcome, why, exit, files, ...extra });
  if (LIVE.has(job.state)) return verdict('unknown', `still ${job.state}: it is judged when it ends`);
  const cleanExit = job.state === 'completed' && job.exitCode === 0;
  const recorded = `${who} ${exitText(job)} (recorded beside the outcome, not deciding it)`;
  const since = Date.parse(job.startedAt) - 2000;

  if (result === undefined && opts.resultExpected === false) {
    const files = (opts.expect ?? []).map((name) => ({ path: name, present: presentSince(opts.root, name, Number.isNaN(since) ? 0 : since) }));
    const missing = files.filter((f) => !f.present).map((f) => f.path);
    if (!files.length) return verdict('unknown', `nothing was expected of it to check; ${who} ${exitText(job)}`);
    if (!missing.length) {
      return cleanExit
        ? verdict('ok', `${files.map((f) => f.path).join(', ')} written during the run; ${who} exited 0`, files)
        : verdict('unknown', `${files.map((f) => f.path).join(', ')} written during the run, but ${who} ${exitText(job)}: its log says whether it finished`, files);
    }
    return cleanExit
      ? verdict('unknown', `${who} exited 0, but ${missing.join(', ')} is not there`, files)
      : verdict('failed', `${who} ${exitText(job)} and ${missing.join(', ')} is not there`, files);
  }

  if (result === undefined) {
    return cleanExit
      ? verdict('unknown', `${who} exited 0 but wrote no result file, so nothing says the script finished`)
      : verdict('failed', `no result file, and ${who} ${exitText(job)}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return verdict('unknown', `the result file has no ok: true or false; ${recorded}`);
  }
  const r = result as { ok: boolean; run?: unknown; error?: unknown; files?: unknown; c4d_version?: unknown };
  const version = r.c4d_version === undefined ? {} : { c4dVersion: r.c4d_version };
  if (opts.run !== undefined && r.run !== opts.run) {
    return verdict('unknown', `the result file is from another run (its run token is not this job's); ${recorded}`, [], version);
  }
  if (!r.ok) {
    const error = typeof r.error === 'string' && r.error.trim() ? r.error.trim() : 'no error given';
    return verdict('failed', `the script reported ok: false: ${error}; ${recorded}`, [], version);
  }
  const files: NativeFileCheck[] = [];
  const named = r.files && typeof r.files === 'object' && !Array.isArray(r.files) ? Object.entries(r.files as Record<string, unknown>) : [];
  for (const [name, hash] of named) {
    const abs = path.isAbsolute(name) ? name : path.join(opts.root, name);
    let present = false;
    try { present = statSync(abs).isFile(); } catch { /* missing */ }
    const check: NativeFileCheck = { path: name, present };
    if (typeof hash === 'string' && hash) {
      check.recorded = hash;
      if (present) {
        const now = sha256File(abs);
        if (now) check.sha256 = now;
        check.matches = now === hash.toLowerCase();
      }
    }
    files.push(check);
  }
  for (const name of opts.expect ?? []) {
    if (files.some((f) => f.path === name)) continue;
    let present = false;
    try { present = statSync(path.join(opts.root, name)).isFile(); } catch { /* missing */ }
    files.push({ path: name, present });
  }
  const missing = files.find((f) => !f.present);
  if (missing) return verdict('failed', `the result says ok, but ${missing.path} is not there; ${recorded}`, files, version);
  const differs = files.find((f) => f.matches === false);
  if (differs) return verdict('failed', `the result says ok, but ${differs.path} does not match the sha256 it recorded; ${recorded}`, files, version);
  const hashed = files.filter((f) => f.matches).length;
  const what = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} there${hashed ? `, ${hashed} matching the sha256 it recorded` : ''}` : 'no files named or expected';
  return verdict('ok', `the result file says ok, ${what}; ${recorded}`, files, version);
}

/** Judge a finished native job from its spec: reads the result file (c4dpy) or checks the output (aerender). */
export function judgeNativeJob(job: JobRecord, spec: NativeJobSpec | NativeMeta): NativeJudgement {
  const meta = 'native' in spec ? spec.native : spec;
  const opts: JudgeOptions = { root: meta.root, app: meta.app, run: meta.run, expect: meta.expect, resultExpected: meta.result !== undefined };
  if (meta.result === undefined || LIVE.has(job.state)) return judgeNativeRun(job, undefined, opts);
  const read = readNativeResult(meta.result);
  if (read.state === 'unreadable') {
    const base = judgeNativeRun(job, undefined, opts);
    return { ...base, outcome: 'unknown', why: `the result file cannot be read as JSON (${read.error}); ${NATIVE_APPS[meta.app].program} ${exitText(job)}` };
  }
  return judgeNativeRun(job, read.state === 'read' ? read.data : undefined, opts);
}

/**
 * A judgement as a receipt can carry it: names as the result or the spec gave them (relative to the
 * project), the outcome and why, the exit beside them. `status` is the receipt status the outcome allows:
 * 'ok' or 'failed', and none for 'unknown' (a receipt must not call an unknown run either).
 */
export function nativeReceiptFields(app: NativeApp, j: NativeJudgement): {
  status?: 'ok' | 'failed';
  native: { app: NativeApp; outcome: NativeJudgement['outcome']; why: string; exit_code: number | null; signal: string | null; files: NativeFileCheck[]; c4d_version?: unknown };
} {
  return {
    ...(j.outcome === 'unknown' ? {} : { status: j.outcome }),
    native: {
      app, outcome: j.outcome, why: j.why, exit_code: j.exit.code, signal: j.exit.signal, files: j.files.map((f) => ({ ...f })),
      ...(j.c4dVersion === undefined ? {} : { c4d_version: j.c4dVersion }),
    },
  };
}

// ── /tools rows ───────────────────────────────────────────────────────────────

/**
 * One /tools row per app (kind 'adapter'). 'installed' when its program is found, with where and how;
 * 'needs setup' otherwise, with the step. Never higher: finding a program is not running it, and the
 * rows' `tools` let the capability list show when run_native last completed in a sealed turn.
 */
export function nativeCapabilityRows(env: Env = process.env, seams: FinderSeams = {}): CapabilityRow[] {
  const mac = (seams.platform ?? process.platform) === 'darwin';
  const apps = seams.applications ?? '/Applications';
  return (Object.keys(NATIVE_APPS) as NativeApp[]).map((app) => {
    const info = NATIVE_APPS[app];
    const { found, problem } = locateNative(app, env, seams);
    const scope = app === 'aerender' ? '; renders existing .aep/.aepx projects only (making or editing one needs After Effects scripting in the app)' : '';
    const base = { id: app, kind: 'adapter' as const, name: info.name, tools: ['run_native'] };
    if (found) {
      const where = found.how === 'applications'
        ? `in ${path.join(apps, found.folder ?? '')}${found.version ? ` (version ${found.version} by its folder name)` : ''}, by the /Applications scan`
        : found.how === 'env' ? `at ${info.envVar}` : `on PATH at ${found.path}`;
      return { ...base, rung: 'installed' as const, detail: `${info.program} ${where}; not run here${scope}` };
    }
    if (problem) return { ...base, rung: 'needs setup' as const, detail: problem, setup: `point ${info.envVar} at ${info.program}, or unset it` };
    const looked = [`${info.envVar} is not set`, ...(mac ? [`no ${info.prefix} in ${apps}`] : []), `no ${info.program} on PATH`].join(', ');
    return { ...base, rung: 'needs setup' as const, detail: `not found: ${looked}`, setup: info.setup };
  });
}
