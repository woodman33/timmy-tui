/**
 * Native creative apps as Timmy jobs (R2): Cinema 4D through c4dpy and After Effects through aerender;
 * R3: Blender through its own Python, headless.
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
 *             After Effects' own scripting through the app: afterfx below.
 *   blender   Blender's own Python, headless (`blender -b --factory-startup --python <script> -- <args>`):
 *             a script that can build or change a scene, save an editable .blend and render a still. Like
 *             c4dpy, the script writes a result file (workers/blender/timmy_blender.py) that decides the run.
 *   afterfx   (R4) After Effects scripting, inside the application (it opens its window): a per-run ExtendScript
 *             harness writes or edits a project and its result file. Built and judged in src/native/ae-author.ts.
 *   openscad  (R4) OpenSCAD's command line, headless: a .scad model exported to a binary STL with -D parameters,
 *             read back by Timmy's own STL reader. Built and judged in src/native/openscad.ts.
 *
 * R3 (an independent review of 40022d9, finding 5): every run has its own folder in the project,
 * .timmy/native/<run>/, holding job.json (written once, at submission: the app, the program, the input's
 * sha256, each expected output's state before the run, the result path, the run token, the time),
 * result.json (the script's result, never shared between runs) and verdicts.jsonl (each judgement,
 * appended beside the submission, never over it). Success is bound to that run: the result must echo its
 * token and the script's sha256, name only files inside the project, each with a sha256 matching the file
 * now; an aerender output must have been created or changed during the run, and an image sequence must be
 * whole. reconcileNative judges a run again from that folder alone, after a restart.
 *
 * R4 (a review of 07f37ec, findings 5 and 6; src/native/provenance.ts): a c4dpy or Blender run runs a
 * read-only copy of its script kept in its folder at submission (source/<name>.py, in job.json as `copy`),
 * checked against the submitted sha256 when made and when judged, so what ran is what was submitted; and each
 * output it may be judged on is inventoried before it starts (job.json `pre`: the expected outputs and, for
 * the scripted apps, every file under out/; `inventory` says what that covered), then classified created,
 * changed or reused. A file there before with the same bytes is never counted as made by the run.
 *
 * Finding a program is not running it: the /tools rows say 'installed' at most, and a row is marked
 * exercised only by a sealed receipt of its own app judged ok (finding 6), never by a shared tool name.
 * Nothing in this module has been run against the real applications here (see tests/native*.test.ts:
 * test doubles only).
 */
import { randomUUID } from 'node:crypto';
import {
  accessSync, appendFileSync, constants, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { packagedPath } from '../utils/asset-dirs.js';
import type { CapabilityRow } from '../capabilities/index.js';
import type { JobRecord, JobSpec, JobState } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import {
  changeOf, checkSource, classifyOutput, inventoryFolders, keepScript, madeByRun, MTIME_SLACK_MS, notMadeWords, notWrittenWords, OUT_FOLDER,
  readSubmittedScript, scriptEnv, sha256File, sourceWords, stateBefore, whyNotInventoried,
  type NativeInventory, type OutputChange, type SourceCheck,
} from './provenance.js';

export type { NativeInventory, OutputChange, SourceCheck } from './provenance.js';

export type NativeApp = 'c4dpy' | 'aerender' | 'blender' | 'afterfx' | 'openscad';
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
  /** an application folder's name starts with this (then its version), or is this plus .app */
  prefix: string;
  /** where the executable sits inside that folder, first match wins; {folder} is the folder's own name */
  inside: string[];
  /** R4: the executable inside a .app bundle named by the environment variable, when it is not the bundle's own name */
  bundleExe?: string;
  program: string;
  name: string;
  setup: string;
  /** whether a result file (written by the script) decides the run; aerender writes none */
  resultFile: boolean;
  /** R4 (openscad): false when /Applications is not scanned: the program is found by its variable or on PATH only */
  applicationsScan?: false;
}

export const NATIVE_APPS: Record<NativeApp, AppInfo> = {
  c4dpy: {
    envVar: 'TIMMY_C4DPY', prefix: 'Maxon Cinema 4D', inside: ['c4dpy.app/Contents/MacOS/c4dpy', 'c4dpy'], program: 'c4dpy',
    name: 'Cinema 4D (c4dpy)',
    setup: 'install Cinema 4D; or set TIMMY_C4DPY to its c4dpy program',
    resultFile: true,
  },
  aerender: {
    envVar: 'TIMMY_AERENDER', prefix: 'Adobe After Effects', inside: ['aerender'], program: 'aerender',
    name: 'After Effects (aerender)',
    setup: 'install After Effects; or set TIMMY_AERENDER to its aerender',
    resultFile: false,
  },
  blender: {
    // macOS: /Applications/Blender.app (or a versioned "Blender 4.2.app") holds Contents/MacOS/Blender
    envVar: 'TIMMY_BLENDER', prefix: 'Blender', inside: ['Contents/MacOS/Blender'], program: 'blender',
    name: 'Blender (Python, headless)',
    setup: 'install Blender; or set TIMMY_BLENDER to its blender program',
    resultFile: true,
  },
  afterfx: {
    // R4 (src/native/ae-author.ts): After Effects scripting, run inside the application itself. macOS keeps
    // /Applications/Adobe After Effects <version>/Adobe After Effects <version>.app/Contents/MacOS/After Effects.
    envVar: 'TIMMY_AFTERFX', prefix: 'Adobe After Effects', inside: ['{folder}.app/Contents/MacOS/After Effects'], bundleExe: 'After Effects',
    program: 'After Effects',
    name: 'After Effects (scripting)',
    setup: 'install After Effects; or set TIMMY_AFTERFX to its .app/AfterFX.exe',
    resultFile: true,
  },
  openscad: {
    // R4 (src/native/openscad.ts): found by TIMMY_OPENSCAD (a program, or an OpenSCAD.app opened to Contents/MacOS/
    // OpenSCAD) or `openscad` on PATH, never by an /Applications scan: the build on PATH is the one meant.
    envVar: 'TIMMY_OPENSCAD', prefix: 'OpenSCAD', inside: [], program: 'openscad', applicationsScan: false,
    name: 'OpenSCAD (command line)',
    setup: 'install OpenSCAD with openscad on PATH, or set TIMMY_OPENSCAD',
    resultFile: false,
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
    if (file.endsWith('.app')) file = path.join(file, 'Contents', 'MacOS', info.bundleExe ?? path.basename(file, '.app'));
    if (isFile(file)) return { found: { app, path: file, how: 'env' } };
    return { found: null, problem: `${info.envVar} is set, but nothing runnable is there` };
  }
  if ((seams.platform ?? process.platform) === 'darwin' && info.applicationsScan !== false) {
    const apps = seams.applications ?? '/Applications';
    const folders = (seams.listDir ?? listDir)(apps)
      .filter((name) => name === info.prefix || name === `${info.prefix}.app` || name.startsWith(`${info.prefix} `))
      .map((name) => ({ name, version: name.slice(info.prefix.length).replace(/\.app$/i, '').trim() }))
      .sort((a, b) => newerFirst(a.version, b.version));
    for (const folder of folders) {
      for (const inside of info.inside) {
        const file = path.join(apps, folder.name, ...inside.replace('{folder}', folder.name).split('/'));
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
export const findBlender = (env: Env = process.env, seams: FinderSeams = {}): NativeFound | null => locateNative('blender', env, seams).found;

// ── job specs ─────────────────────────────────────────────────────────────────

/**
 * An output path's state when the run was submitted: absent, a file (its size, times and sha256), or, for an
 * image sequence ([####] in its name), the frames already there (size, times and, from R4, sha256 each).
 * sha256 '' (or none) means its bytes were not recorded: unreadable then, private by name, or past the
 * inventory's hashing budget (src/native/provenance.ts). ctimeMs from R4.
 */
export type PreState =
  | { state: 'absent' }
  | { state: 'not-a-file' }
  | { state: 'present'; size: number; mtimeMs: number; sha256: string; ctimeMs?: number }
  | { state: 'sequence'; frames: Record<string, { size: number; mtimeMs: number; ctimeMs?: number; sha256?: string }> };

/** What judging a native job needs, carried on its spec (JobManager ignores it) and in its job.json. */
export interface NativeMeta {
  app: NativeApp;
  /** the project folder, resolved */
  root: string;
  /** this run's token (TIMMY_RUN): a result file carrying another token is not this run's */
  run: string;
  /** R3: this run's own folder, <root>/.timmy/native/<run>: job.json, result.json, verdicts.jsonl */
  record?: string;
  /** the result file the script writes (TIMMY_RESULT); per run unless the caller named one */
  result?: string;
  /** aerender: the file it renders to */
  output?: string;
  /** files that must be accounted for when it is judged, relative to root */
  expect: string[];
  /** R3: the script (c4dpy) or project file (aerender) as submitted, relative to root, and its sha256 */
  input?: { path: string; sha256: string };
  /** R4: the read-only copy of the script the app runs, kept in the run's folder, relative to root, and its sha256 */
  copy?: { path: string; sha256: string };
  /** R3: each expected output's state at submission; R4: and every entry under out/ for the scripted apps */
  pre?: Record<string, PreState>;
  /** R4: what the inventory in `pre` covered besides the expected outputs */
  inventory?: NativeInventory;
  /** R3: aerender's frame range (-s, -e), when given */
  frames?: { start?: number; end?: number };
  /** R3: when the run was submitted (ms since the epoch) */
  submittedMs?: number;
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
  // Round R3: one lookup for the checkout, the TypeScript build and the bundled CLI (src/utils/asset-dirs.ts).
  const helper = packagedPath('workers/c4d/timmy_c4d.py', import.meta.url, { kind: 'file' });
  return helper === undefined ? undefined : path.dirname(helper);
}

/**
 * The folder holding timmy_blender.py (workers/blender), for TIMMY_BLENDER_LIB, found the way c4dHelperDir
 * finds workers/c4d. Blender's Python ignores PYTHONPATH unless started with --python-use-system-env, so the
 * scene script puts this folder on sys.path itself (templates/blender-starter/scene.py).
 */
export function blenderHelperDir(): string | undefined {
  const helper = packagedPath('workers/blender/timmy_blender.py', import.meta.url, { kind: 'file' });
  return helper === undefined ? undefined : path.dirname(helper);
}

/** The default limit: a 96-frame turntable on the Standard renderer is minutes, not hours. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** Where each run keeps its own folder, inside the project (classified as history, never as output). */
export const NATIVE_RUNS_DIR = path.join('.timmy', 'native');
const RUN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Re-exported for the After Effects authoring route (src/native/ae-author.ts). */
export { sha256File };

/** An existing input file inside the project, with its sha256 now (the bytes submitted). */
function inputFile(root: string, rel: string, kind: string): { path: string; rel: string; sha256: string } {
  const at = inside(root, rel);
  let isFile = false;
  try { isFile = statSync(at.path).isFile(); } catch { /* missing */ }
  if (!isFile) throw new Error(`no ${kind} at ${at.rel}`);
  const sha256 = sha256File(at.path);
  if (!sha256) throw new Error(`${at.rel} cannot be read`);
  return { ...at, sha256 };
}

// ── image sequences ──────────────────────────────────────────────────────────

const SEQUENCE = /\[#+\]/;
const isSequence = (name: string): boolean => SEQUENCE.test(path.basename(name));
/** The frames of a [####] name present in its folder now: frame number → its file. */
function sequenceFrames(abs: string): Map<number, string> {
  const base = path.basename(abs);
  const [head, tail] = base.split(SEQUENCE);
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${esc(head)}(\\d+)${esc(tail ?? '')}$`);
  const frames = new Map<number, string>();
  for (const name of listDir(path.dirname(abs))) {
    const m = pattern.exec(name);
    if (m) frames.set(Number(m[1]), path.join(path.dirname(abs), name));
  }
  return frames;
}

/**
 * Each expected output's state now: what a later judgement compares against (R3, finding 5c). R4 (finding 6):
 * with its sha256, and each frame of a sequence with its own, so bytes that were there before are told apart.
 */
export function preStates(root: string, names: string[]): Record<string, PreState> {
  const pre: Record<string, PreState> = {};
  for (const name of names) {
    const abs = path.join(root, name);
    if (isSequence(name)) {
      const frames: Record<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }> = {};
      for (const [n, file] of sequenceFrames(abs)) {
        try {
          const s = statSync(file);
          if (s.isFile()) frames[String(n)] = { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, sha256: sha256File(file) ?? '' };
        } catch { /* gone */ }
      }
      pre[name] = { state: 'sequence', frames };
      continue;
    }
    let s;
    try { s = statSync(abs); } catch { pre[name] = { state: 'absent' }; continue; }
    if (!s.isFile()) { pre[name] = { state: 'not-a-file' }; continue; }
    pre[name] = { state: 'present', size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, sha256: sha256File(abs) ?? '' };
  }
  return pre;
}

/** R4 (finding 6): a scripted run's expected outputs and every entry under out/ (TIMMY_OUT), as they are before it. */
function inventoryOutputs(root: string, expect: string[]): { pre: Record<string, PreState>; inventory: NativeInventory } {
  const pre = preStates(root, expect);
  return { pre, inventory: inventoryFolders(root, pre, [OUT_FOLDER]) };
}

// ── each run's own record ────────────────────────────────────────────────────

/** job.json: the submission, written once and never rewritten. Paths in it are relative to the project. */
export interface NativeRunJob {
  record: 'timmy-native-run';
  v: 1;
  app: NativeApp;
  run: string;
  /** the program that runs it */
  program: string;
  label: string;
  project: string;
  /** the job's arguments, the project folder written as "." */
  args: string[];
  input?: { path: string; sha256: string };
  /** R4: the read-only copy of the script the app runs, in this run's folder */
  copy?: { path: string; sha256: string };
  result?: string;
  output?: string;
  expect: string[];
  pre: Record<string, PreState>;
  /** R4: what `pre` covers besides the expected outputs (out/, for the scripted apps) */
  inventory?: NativeInventory;
  frames?: { start?: number; end?: number };
  started_at: string;
  timeout_ms: number;
}
/** A judgement as verdicts.jsonl keeps it, one per line. */
export interface NativeVerdictLine {
  judged_at: string;
  /** the job's id, when a job record was at hand */
  job?: string;
  outcome: NativeJudgement['outcome'];
  why: string;
  exit: NativeJudgement['exit'];
  /** each file's check; R4: with what the run did to it (`change`) */
  files: NativeFileCheck[];
  checked?: SequenceCheck[];
  /** R4: how what ran was bound to the script submitted */
  source?: SourceCheck;
}

const runDir = (root: string, run: string): string => path.join(root, NATIVE_RUNS_DIR, run);
const relTo = (root: string, abs: string): string => (abs === root ? '.' : abs.startsWith(`${root}${path.sep}`) ? abs.slice(root.length + 1).split(path.sep).join('/') : abs);

/** Writes the run's job.json once, refusing to replace one (a run token is never reused). */
export function writeSubmission(spec: NativeJobSpec): void {
  const m = spec.native;
  const dir = m.record ?? runDir(m.root, m.run);
  mkdirSync(dir, { recursive: true });
  const job: NativeRunJob = {
    record: 'timmy-native-run', v: 1, app: m.app, run: m.run, program: spec.command, label: spec.label, project: spec.project,
    args: spec.args.map((a) => (a.startsWith(`${m.root}${path.sep}`) || a === m.root ? `./${relTo(m.root, a)}`.replace(/^\.\/\.$/, '.') : a)),
    ...(m.input ? { input: m.input } : {}),
    ...(m.copy ? { copy: m.copy } : {}),
    ...(m.result ? { result: relTo(m.root, m.result) } : {}),
    ...(m.output ? { output: relTo(m.root, m.output) } : {}),
    expect: m.expect, pre: m.pre ?? {}, ...(m.inventory ? { inventory: m.inventory } : {}), ...(m.frames ? { frames: m.frames } : {}),
    started_at: new Date(m.submittedMs ?? Date.now()).toISOString(), timeout_ms: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  writeFileSync(path.join(dir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`, { flag: 'wx' });
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return undefined; }
}
function readVerdicts(dir: string): NativeVerdictLine[] {
  let text = '';
  try { text = readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf8'); } catch { return []; }
  const out: NativeVerdictLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as NativeVerdictLine); } catch { /* a torn line is skipped, never repaired */ }
  }
  return out;
}

/** Appends a judgement to the run's verdicts.jsonl, unless the last line already says the same. */
function appendVerdict(dir: string, j: NativeJudgement, jobId?: string): void {
  try {
    const last = readVerdicts(dir).at(-1);
    if (last && last.outcome === j.outcome && last.why === j.why && last.job === jobId) return;
    const line: NativeVerdictLine = {
      judged_at: new Date().toISOString(), ...(jobId ? { job: jobId } : {}), outcome: j.outcome, why: j.why, exit: j.exit, files: j.files,
      ...(j.checked ? { checked: j.checked } : {}), ...(j.source ? { source: j.source } : {}),
    };
    appendFileSync(path.join(dir, 'verdicts.jsonl'), `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record; a missing folder is not a verdict */ }
}

/** started.json: which job ran the run, written once when it started (noteNativeStarted). */
export interface NativeRunStart { job: string; started_at: string; pid?: number }

/**
 * Notes, in the run's folder, the job that runs it (started.json, written once): after a restart the
 * run's own record names the job whose record holds its exit. Call it with what JobManager.start returned.
 */
export function noteNativeStarted(spec: NativeJobSpec | NativeMeta, job: JobRecord): void {
  const meta = 'native' in spec ? spec.native : spec;
  if (!meta.record) return;
  const note: NativeRunStart = { job: job.id, started_at: job.startedAt, ...(job.pid ? { pid: job.pid } : {}) };
  try { writeFileSync(path.join(meta.record, 'started.json'), `${JSON.stringify(note)}\n`, { flag: 'wx' }); } catch { /* written already, or the folder is gone */ }
}

/** One run's folder: its submission, its start note, its verdicts so far, its result file. Undefined when there is none. */
export function readNativeRecord(root: string, run: string): { dir: string; job: NativeRunJob; started?: NativeRunStart; verdicts: NativeVerdictLine[]; result: NativeResultRead } | undefined {
  if (!RUN_TOKEN.test(run)) throw new Error(`${run} is not a run token (a run's folder in .timmy/native)`);
  const base = realRoot(root);
  const dir = runDir(base, run);
  const job = readJson(path.join(dir, 'job.json')) as NativeRunJob | undefined;
  if (!job || job.record !== 'timmy-native-run' || job.run !== run || !Object.hasOwn(NATIVE_APPS, job.app)) return undefined;
  const resultAt = job.result ? resolveInside(base, job.result) : undefined;
  const result: NativeResultRead = !resultAt ? { state: 'missing' } : 'error' in resultAt ? { state: 'unreadable', error: resultAt.error } : readNativeResult(resultAt.path);
  const started = readJson(path.join(dir, 'started.json')) as NativeRunStart | undefined;
  return { dir, job, ...(started && typeof started.job === 'string' ? { started } : {}), verdicts: readVerdicts(dir), result };
}

/** Every run recorded in a project, newest first: what a /tools row or a restart reads (no judging). */
export function listNativeRuns(root: string): Array<{ app: NativeApp; run: string; started_at: string; verdicts: NativeVerdictLine[] }> {
  let base: string;
  try { base = realpathSync(root); } catch { return []; }
  const runs: Array<{ app: NativeApp; run: string; started_at: string; verdicts: NativeVerdictLine[] }> = [];
  for (const run of listDir(path.join(base, NATIVE_RUNS_DIR))) {
    if (!RUN_TOKEN.test(run)) continue;
    const rec = readNativeRecord(base, run);
    if (rec) runs.push({ app: rec.job.app, run, started_at: rec.job.started_at, verdicts: rec.verdicts });
  }
  return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Refuses an output another run of this project is writing: a run that started (its started.json), is not
 * judged yet, whose process is still there (or whose pid is unknown) and whose time limit has not passed.
 * aerender writes no result file, so two runs on one output could not be told apart. A run that never
 * started, or whose process is gone (stopped, crashed), does not block.
 */
function refuseBusy(root: string, names: string[], now: number): void {
  for (const r of listNativeRuns(root)) {
    if (r.verdicts.length) continue;
    const rec = readNativeRecord(root, r.run);
    if (!rec?.started) continue;
    if (rec.started.pid !== undefined && !pidAlive(rec.started.pid)) continue;
    const until = Date.parse(rec.job.started_at) + rec.job.timeout_ms + 60_000;
    if (!(until > now)) continue;
    const theirs = new Set([...(rec.job.expect ?? []), ...(rec.job.output ? [rec.job.output] : [])]);
    const clash = names.find((n) => theirs.has(n));
    if (clash) {
      throw new Error(`another run (${r.run.slice(0, 8)}, job ${rec.started.job}, started ${rec.job.started_at}) is writing ${clash} and has not been judged yet; its time limit ends ${new Date(until).toISOString()}: wait for it, stop it, or write to another file`);
    }
  }
}

// ── c4dpy ────────────────────────────────────────────────────────────────────

export interface C4dpyJobInput {
  /** the Python file c4dpy runs, relative to root */
  script: string;
  args?: string[];
  root: string;
  project: string;
  timeoutMs?: number;
  /** where the script writes its result file, relative to root (default .timmy/native/<run>/result.json) */
  result?: string;
  /** files the result must name, or this run must write, relative to root */
  expect?: string[];
  /** the c4dpy to run (default: findC4dpy()) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  label?: string;
}

/**
 * A task job running `c4dpy <copy of script.py> [args]` in the project folder. R4 (finding 5): the app runs a
 * read-only copy of the script kept in the run's folder at submission (.timmy/native/<run>/source/), so what
 * runs is the bytes hashed then. The script learns where to write from its environment: TIMMY_RESULT (this
 * run's own result file), TIMMY_RUN (this run's token, written back into the result), TIMMY_SCRIPT (the copy
 * it runs) and TIMMY_SCRIPT_SHA256 (the sha256 submitted, echoed back), TIMMY_SCRIPT_ORIGINAL and
 * TIMMY_SCRIPT_DIR (the script and folder it was submitted from, for files and modules beside it),
 * TIMMY_ROOT (the project folder), TIMMY_OUT (its out/ folder) and TIMMY_C4D_LIB (the folder with
 * timmy_c4d.py, when this checkout has it). Making the spec inventories the outputs it may be judged on (R4,
 * finding 6), keeps the copy and writes the run's job.json.
 */
export function c4dpyJob(input: C4dpyJobInput): NativeJobSpec {
  const root = realRoot(input.root);
  const script = readSubmittedScript(inside(root, input.script));
  if (!/\.py$/i.test(script.rel)) throw new Error(`${script.rel} is not a Python file (.py)`);
  const run = randomUUID();
  const record = runDir(root, run);
  const result = inside(root, input.result ?? `${NATIVE_RUNS_DIR.split(path.sep).join('/')}/${run}/result.json`);
  const expect = (input.expect ?? []).map((rel) => inside(root, rel).rel);
  const bin = program('c4dpy', input.bin, { ...process.env, ...input.env });
  const lib = input.env?.TIMMY_C4D_LIB ?? c4dHelperDir();
  const submittedMs = Date.now();
  const { pre, inventory } = inventoryOutputs(root, expect);
  const copy = keepScript(root, record, script);
  const spec: NativeJobSpec = {
    kind: 'task', label: input.label ?? `Cinema 4D · ${script.rel}`, project: input.project, root,
    command: bin, args: [copy.path, ...(input.args ?? [])],
    env: {
      ...input.env, ...nativeHome(input.env), TIMMY_RESULT: result.path, TIMMY_RUN: run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, OUT_FOLDER),
      ...scriptEnv(script, copy), ...(lib ? { TIMMY_C4D_LIB: lib } : {}),
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // R2 (the Mac run): without its license, c4dpy asks this and waits for a person, even with its input closed.
    stopWhen: { pattern: /Enter the license method/i, error: 'Cinema 4D asked how to license it and waits for a person: run Cinema 4D once as this user, or set TIMMY_NATIVE_HOME to the home that holds its license' },
    native: {
      app: 'c4dpy', root, run, record, result: result.path, expect, input: { path: script.rel, sha256: script.sha256 }, copy: { path: copy.rel, sha256: copy.sha256 },
      pre, inventory, submittedMs,
    },
  };
  writeSubmission(spec);
  return spec;
}

// ── Blender ──────────────────────────────────────────────────────────────────

export interface BlenderJobInput {
  /** the Python file Blender runs, relative to root */
  script: string;
  /** the script's own arguments: after `--` on Blender's command line (timmy_blender.script_args() reads them) */
  args?: string[];
  root: string;
  project: string;
  timeoutMs?: number;
  /** where the script writes its result file, relative to root (default .timmy/native/<run>/result.json) */
  result?: string;
  /** files the result must name, or this run must write, relative to root */
  expect?: string[];
  /** the blender to run (default: findBlender()) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  label?: string;
}

/**
 * A task job running `blender -b --factory-startup --python-exit-code 1 --python <copy of script.py> -- [args]`
 * in the project folder: Blender headless, with its factory settings (no user preferences or add-ons), the
 * script's arguments after `--`, and an uncaught Python error made a non-zero exit (recorded beside the
 * outcome, never deciding it). R4 (finding 5): like c4dpy, Blender runs the read-only copy kept in the run's
 * folder at submission. The script learns where to write from TIMMY_RESULT, TIMMY_RUN, TIMMY_SCRIPT (the
 * copy), TIMMY_SCRIPT_SHA256, TIMMY_SCRIPT_ORIGINAL, TIMMY_SCRIPT_DIR, TIMMY_ROOT, TIMMY_OUT and
 * TIMMY_BLENDER_LIB (the folder with timmy_blender.py, when this checkout has it). Making the spec inventories
 * the outputs it may be judged on, keeps the copy and writes the run's job.json. It is judged like c4dpy: by
 * this run's result file, bound to its token and to the script as submitted, every file it names with a
 * matching sha256 and made by this run.
 */
export function blenderJob(input: BlenderJobInput): NativeJobSpec {
  const root = realRoot(input.root);
  const script = readSubmittedScript(inside(root, input.script));
  if (!/\.py$/i.test(script.rel)) throw new Error(`${script.rel} is not a Python file (.py)`);
  const run = randomUUID();
  const record = runDir(root, run);
  const result = inside(root, input.result ?? `${NATIVE_RUNS_DIR.split(path.sep).join('/')}/${run}/result.json`);
  const expect = (input.expect ?? []).map((rel) => inside(root, rel).rel);
  const bin = program('blender', input.bin, { ...process.env, ...input.env });
  const lib = input.env?.TIMMY_BLENDER_LIB ?? blenderHelperDir();
  const submittedMs = Date.now();
  const { pre, inventory } = inventoryOutputs(root, expect);
  const copy = keepScript(root, record, script);
  const spec: NativeJobSpec = {
    kind: 'task', label: input.label ?? `Blender · ${script.rel}`, project: input.project, root,
    command: bin, args: ['-b', '--factory-startup', '--python-exit-code', '1', '--python', copy.path, '--', ...(input.args ?? [])],
    env: {
      ...input.env, ...nativeHome(input.env), TIMMY_RESULT: result.path, TIMMY_RUN: run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, OUT_FOLDER),
      ...scriptEnv(script, copy), ...(lib ? { TIMMY_BLENDER_LIB: lib } : {}),
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    native: {
      app: 'blender', root, run, record, result: result.path, expect, input: { path: script.rel, sha256: script.sha256 }, copy: { path: copy.rel, sha256: copy.sha256 },
      pre, inventory, submittedMs,
    },
  };
  writeSubmission(spec);
  return spec;
}

// ── aerender ─────────────────────────────────────────────────────────────────

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
  /** -s: the first frame to render; with endFrame, the whole range an image sequence must have */
  startFrame?: number;
  /** -e: the last frame to render */
  endFrame?: number;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

const frameNumber = (n: unknown, what: string): number | undefined => {
  if (n === undefined) return undefined;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole frame number`);
  return n;
};

/**
 * A task job running `aerender -project <file> -comp "<name>" -output <file> [-s <n>] [-e <n>]` in the
 * project folder. The output's folder is made here, before the job starts; the project file's sha256 and
 * the output's state before the run go into the run's job.json.
 */
export function aerenderJob(input: AerenderJobInput): NativeJobSpec {
  const root = realRoot(input.root);
  const projectAt = inside(root, input.projectFile);
  if (!/\.aepx?$/i.test(projectAt.rel)) throw new Error(`${projectAt.rel} is not an After Effects project (.aep or .aepx)`);
  let isProject = false;
  try { isProject = statSync(projectAt.path).isFile(); } catch { /* missing */ }
  if (!isProject) throw new Error(`no project file at ${projectAt.rel}: aerender renders an existing project, it cannot make one`);
  const project = inputFile(root, input.projectFile, 'project file');
  if (typeof input.comp !== 'string' || !input.comp.trim()) throw new Error('name the composition to render');
  const start = frameNumber(input.startFrame, 'the start frame');
  const end = frameNumber(input.endFrame, 'the end frame');
  if (start !== undefined && end !== undefined && end < start) throw new Error('the end frame comes before the start frame');
  const output = inside(root, input.output);
  const bin = program('aerender', input.bin, { ...process.env, ...input.env });
  const submittedMs = Date.now();
  refuseBusy(root, [output.rel], submittedMs);
  mkdirSync(path.dirname(output.path), { recursive: true });
  const run = randomUUID();
  const frames = start !== undefined || end !== undefined ? { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) } : undefined;
  const spec: NativeJobSpec = {
    kind: 'task', label: input.label ?? `After Effects · ${project.rel} › ${input.comp}`, project: input.project, root,
    command: bin,
    args: [
      '-project', project.path, '-comp', input.comp, '-output', output.path,
      ...(start !== undefined ? ['-s', String(start)] : []),
      ...(end !== undefined ? ['-e', String(end)] : []),
      ...(input.rsTemplate ? ['-RStemplate', input.rsTemplate] : []),
      ...(input.omTemplate ? ['-OMtemplate', input.omTemplate] : []),
    ],
    ...(input.env || nativeHome().HOME ? { env: { ...input.env, ...nativeHome(input.env) } } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    native: {
      app: 'aerender', root, run, record: runDir(root, run), output: output.path, expect: [output.rel],
      input: { path: project.rel, sha256: project.sha256 }, pre: preStates(root, [output.rel]), ...(frames ? { frames } : {}), submittedMs,
    },
  };
  writeSubmission(spec);
  return spec;
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
  /** as the result file or the spec named it (relative to the project); a name outside it is not kept */
  path: string;
  present: boolean;
  /** what the result file recorded */
  recorded?: string;
  /** the file's sha256 now */
  sha256?: string;
  matches?: boolean;
  /** R3: created or changed during this run, from its state at submission. R4: made by this run, by its bytes:
   *  a file there before with the same bytes is never written by this run, whatever its times say */
  written?: boolean;
  /** R4 (finding 6): what this run did to it, against the inventory taken before the run */
  change?: OutputChange;
  /** R4: false when the path was not inventoried before the run (its change told from its times alone) */
  inventoried?: false;
  /** R3: the result named it outside the project */
  outside?: boolean;
}
/** R3: what was checked of an image sequence, exactly. */
export interface SequenceCheck {
  /** the name with [####], relative to the project */
  pattern: string;
  /** the frames required: from -s/-e, or the frames this run wrote; null when neither says */
  range: [number, number] | null;
  range_from: 'arguments' | 'frames written' | 'none';
  /** frames in the range written during this run */
  written: number;
  /** frames in the range not there, or not written during this run (the first 50) */
  missing: number[];
  /** how many frames in the range are missing, all of them */
  missing_count: number;
  /** frames there from before the run and not written by it (at most 50 listed); outside the range they decide nothing */
  stale: number[];
  /** R4 (finding 6): the frames there now, by what this run did to each; only created and changed are its own */
  by_change?: Record<'created' | 'changed' | 'reused' | 'unverified' | 'unrecorded', number>;
}
export interface NativeJudgement {
  outcome: 'ok' | 'failed' | 'unknown';
  why: string;
  /** the process's end, recorded beside the outcome; never the outcome on its own. 'unknown': not recorded */
  exit: { state: JobState | 'unknown'; code: number | null; signal: string | null; error?: string };
  files: NativeFileCheck[];
  /** c4dpy: what the script read from c4d.GetC4DVersion() */
  c4dVersion?: unknown;
  /** blender: what the script read from bpy.app.version_string */
  blenderVersion?: unknown;
  /** R3: the run judged, and the input it was bound to */
  run?: string;
  input?: { path: string; sha256: string };
  /** R3: each image sequence's check */
  checked?: SequenceCheck[];
  /** R4 (finding 5): how what ran was bound to the script submitted, when the result got that far */
  source?: SourceCheck;
}
export interface JudgeOptions {
  /** the project folder: file names are relative to it */
  root: string;
  app?: NativeApp;
  /** this run's token; a result carrying another is from another run */
  run?: string;
  /** files that must be accounted for, relative to root */
  expect?: string[];
  /** false when the app writes no result file (aerender): its expected files and exit decide */
  resultExpected?: boolean;
  /** R3: the input as submitted: the result must echo its sha256 (c4dpy), the project file must still have it (aerender) */
  input?: { path: string; sha256: string };
  /** R4: the copy of the script the app ran, relative to root: it must still hold the submitted bytes. Without one,
   *  the result must report what the script read (script_sha256_read) to be bound to the input as submitted */
  copy?: { path: string; sha256: string };
  /** R3: each expected output's state at submission; R4: and each inventoried path's */
  pre?: Record<string, PreState>;
  /** R4: what the inventory in `pre` covered besides the expected outputs */
  inventory?: NativeInventory;
  /** R3: an image sequence's frame range, when given */
  frames?: { start?: number; end?: number };
  /** R3: when the run was submitted (ms) */
  submittedMs?: number;
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

/** How the process ended, as the judgement needs it; `known: false` after a restart with no exit recorded. */
interface ExitInfo { exit: NativeJudgement['exit']; live: boolean; clean: boolean; known: boolean; text: string; startedMs: number }
function exitOf(job: JobRecord): ExitInfo {
  const startedMs = Date.parse(job.startedAt);
  if (job.stale) return orphanExit(`was left ${job.state} by an earlier session and its process is gone, with no exit status`, startedMs);
  return {
    exit: { state: job.state, code: job.exitCode ?? null, signal: job.signal ?? null, ...(job.error ? { error: job.error } : {}) },
    live: LIVE.has(job.state), clean: job.state === 'completed' && job.exitCode === 0, known: true, text: exitText(job), startedMs,
  };
}
function orphanExit(text: string, startedMs: number): ExitInfo {
  return { exit: { state: 'unknown', code: null, signal: null }, live: false, clean: false, known: false, text, startedMs };
}

/** A name from a result file, as the project knows it: relative and inside, or `outside`. */
function placeName(root: string, name: string): { rel: string; abs: string; real: string } | { outside: string } {
  const abs = path.resolve(root, name);
  const shown = path.isAbsolute(name) ? `(a path outside the project) ${path.basename(name)}` : name;
  if (!(abs === root || abs.startsWith(`${root}${path.sep}`))) return { outside: shown };
  let real = abs;
  try { real = realpathSync(abs); } catch { /* not there: judged missing below */ }
  if (!(real === root || real.startsWith(`${root}${path.sep}`))) return { outside: shown };
  return { rel: relTo(root, abs), abs, real };
}

/**
 * Whether a single output found by its path (not named by a result) was made by this run: R4 (finding 6),
 * created or changed to other bytes than the inventory recorded before the run, not empty, with a time from
 * the run. The same bytes as before, rewritten or not, are never this run's.
 */
function writtenSince(abs: string, pre: PreState | undefined, sinceMs: number): { present: boolean; written: boolean; sha256?: string; change: OutputChange; inventoried: boolean; words: string } {
  const c = classifyOutput(abs, pre, sinceMs);
  const written = madeByRun(c, sinceMs);
  return { present: c.present, written, change: c.change, inventoried: c.inventoried, words: written ? '' : notWrittenWords(c), ...(c.sha256 ? { sha256: c.sha256 } : {}) };
}

/** An image sequence, frame by frame: which frames this run wrote, against the range it must have. R4: by each frame's bytes. */
function checkSequence(root: string, name: string, pre: PreState | undefined, frames: JudgeOptions['frames'], sinceMs: number): SequenceCheck {
  // a sequence with no record of its frames before the run: each frame's times alone speak
  const before = pre?.state === 'sequence' ? pre.frames : undefined;
  const now = sequenceFrames(path.join(root, name));
  const written = new Set<number>();
  const there = new Set<number>();
  const byChange = { created: 0, changed: 0, reused: 0, unverified: 0, unrecorded: 0 };
  for (const [n, file] of now) {
    let s;
    try { s = statSync(file); } catch { continue; }
    if (!s.isFile()) continue;
    there.add(n);
    const change = changeOf(s, before ? before[String(n)] : null, sinceMs, () => sha256File(file));
    if (change in byChange) byChange[change as keyof typeof byChange]++;
    const fresh = s.size > 0 && s.mtimeMs >= sinceMs - MTIME_SLACK_MS;
    if (fresh && (change === 'created' || change === 'changed')) written.add(n);
  }
  const cap = (xs: number[]): number[] => xs.sort((a, b) => a - b).slice(0, 50);
  const sorted = [...written].sort((a, b) => a - b);
  let range: [number, number] | null = null;
  let from: SequenceCheck['range_from'] = 'none';
  if (frames?.start !== undefined && frames?.end !== undefined) { range = [frames.start, frames.end]; from = 'arguments'; }
  else if (sorted.length) {
    range = [frames?.start ?? sorted[0], frames?.end ?? sorted[sorted.length - 1]];
    from = frames?.start !== undefined || frames?.end !== undefined ? 'arguments' : 'frames written';
  }
  const missing: number[] = [];
  let inRange = 0;
  let missingCount = 0;
  if (range) {
    for (let f = range[0]; f <= range[1]; f++) {
      if (written.has(f)) inRange++;
      else { missingCount++; if (missing.length < 50) missing.push(f); }
    }
  }
  const stale = cap([...there].filter((n) => !written.has(n)));
  return { pattern: name, range, range_from: from, written: inRange, missing, missing_count: missingCount, stale, by_change: byChange };
}

/** The judgement of a run with no result file (aerender): what it left, against its state at submission. */
function judgeOutputs(x: ExitInfo, opts: JudgeOptions, who: string, verdict: (o: NativeJudgement['outcome'], why: string, files?: NativeFileCheck[], extra?: Partial<NativeJudgement>) => NativeJudgement): NativeJudgement {
  const names = opts.expect ?? [];
  if (!names.length) return verdict('unknown', `nothing was expected of it to check; ${who} ${x.text}`);
  const since = opts.submittedMs ?? x.startedMs;
  const sinceMs = Number.isNaN(since) ? 0 : since;
  const files: NativeFileCheck[] = [];
  const checked: SequenceCheck[] = [];
  const short: string[] = [];
  for (const name of names) {
    if (isSequence(name)) {
      const c = checkSequence(opts.root, name, opts.pre?.[name], opts.frames, sinceMs);
      checked.push(c);
      const whole = c.range !== null && c.missing.length === 0 && c.written > 0 && !(c.range_from === 'frames written' && c.written < 2);
      files.push({ path: name, present: c.written > 0, written: whole });
      if (!whole) {
        // R4 (finding 6): frames there with the bytes they had before the run are said so, never counted as written
        const kept = c.by_change ? [
          ...(c.by_change.reused ? [`${c.by_change.reused} frame${c.by_change.reused === 1 ? ' was' : 's were'} there before this run with the same bytes (reused)`] : []),
          ...(c.by_change.unverified ? [`${c.by_change.unverified} rewritten with the same size, their bytes before the run not recorded`] : []),
        ].join(', ') : '';
        short.push(c.range === null ? `${name} (no frame was written during this run${kept ? `; ${kept}` : ''})`
          : c.range_from === 'frames written' && c.written < 2 ? `${name} (only one frame, ${c.range[0]}, was written during this run, and no range was given to say that is all: -s and -e would)`
            : `${name} (${c.missing_count} frame${c.missing_count === 1 ? '' : 's'} of ${c.range[0]}–${c.range[1]} missing or not written during this run, first ${c.missing[0]}${kept ? `; ${kept}` : ''})`);
      }
      continue;
    }
    const w = writtenSince(path.join(opts.root, name), stateBefore(name, opts.pre, opts.inventory), sinceMs);
    files.push({ path: name, present: w.present, written: w.written, change: w.change, ...(w.inventoried ? {} : { inventoried: false as const }), ...(w.sha256 ? { sha256: w.sha256 } : {}) });
    if (!w.written) short.push(`${name} (${w.words})`);
  }
  const extra: Partial<NativeJudgement> = checked.length ? { checked } : {};
  // R4: each single output with what the run did to it (created, or changed from other bytes)
  const made = files.map((f) => (f.change ? `${f.path} (${f.change})` : f.path)).join(', ');
  if (!short.length) {
    if (opts.input) {
      const now = sha256File(path.join(opts.root, opts.input.path));
      if (now !== opts.input.sha256) {
        return verdict('unknown', `${made} written during the run, but ${opts.input.path} ${now ? 'changed' : 'is gone'} since it was submitted, so what was rendered cannot be bound to it; ${who} ${x.text}`, files, extra);
      }
    }
    if (x.clean) return verdict('ok', `${made} written during the run${opts.input ? `, from ${opts.input.path} as submitted` : ''}; ${who} exited 0`, files, extra);
    return verdict('unknown', `${made} written during the run, but ${who} ${x.text}: its log says whether it finished`, files, extra);
  }
  if (x.clean || !x.known) return verdict('unknown', `${who} ${x.text}, but ${short.join('; ')} was not written by this run`, files, extra);
  return verdict('failed', `${who} ${x.text} and ${short.join('; ')} was not written by this run`, files, extra);
}

/**
 * The outcome of a native run, from what it left behind. The process's exit is recorded beside the
 * outcome and never decides it alone:
 *   ok       c4dpy, blender: the result file is this run's (its token), echoes the script's sha256 as
 *            submitted, and what ran is shown to be that script (R4: the copy the app ran still holds the
 *            submitted bytes, or, with no copy, the script reports reading them); it says ok:true, names only
 *            files inside the project, each with a sha256 that matches the file now and each made by this run
 *            (R4: created, or changed from other bytes, against the inventory taken before the run), and every
 *            expected file is named or was made by this run. aerender: every expected output was made by this
 *            run (an image sequence whole, frame by frame), the project file is as submitted, and aerender
 *            exited 0.
 *   failed   the result says ok:false; or it says ok but a file is missing, differs, has no sha256 or is
 *            outside the project, or an expected file is not accounted for; or there is no result (no
 *            output) and the process did not exit 0.
 *   unknown  still running; exited 0 with no result file (no output); a result from another run, without
 *            ok, or not bound to the script submitted (R4: a read digest that disagrees, a copy changed or
 *            gone, or neither a copy nor a read digest); R4: a file it names that this run did not make (there
 *            before with the same bytes, or not inventoried); aerender's output there but a non-zero exit.
 * `result` is the parsed result file, or undefined when there was none.
 */
export function judgeNativeRun(job: JobRecord, result: unknown, opts: JudgeOptions): NativeJudgement {
  return judgeExit(exitOf(job), result, opts);
}

function judgeExit(x: ExitInfo, result: unknown, opts: JudgeOptions): NativeJudgement {
  const app = opts.app ?? 'c4dpy';
  const who = NATIVE_APPS[app].program;
  const bound: Partial<NativeJudgement> = { ...(opts.run ? { run: opts.run } : {}), ...(opts.input ? { input: { ...opts.input } } : {}) };
  const verdict = (outcome: NativeJudgement['outcome'], why: string, files: NativeFileCheck[] = [], extra: Partial<NativeJudgement> = {}): NativeJudgement => ({ outcome, why, exit: x.exit, files, ...bound, ...extra });
  if (x.live) return verdict('unknown', `still ${x.exit.state}: it is judged when it ends`);
  const recorded = `${who} ${x.text} (recorded beside the outcome, not deciding it)`;

  if (result === undefined && opts.resultExpected === false) return judgeOutputs(x, opts, who, verdict);

  if (result === undefined) {
    return x.clean
      ? verdict('unknown', `${who} exited 0 but wrote no result file, so nothing says the script finished`)
      : x.known ? verdict('failed', `no result file, and ${who} ${x.text}`) : verdict('unknown', `no result file, and ${who} ${x.text}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return verdict('unknown', `the result file has no ok: true or false; ${recorded}`);
  }
  const r = result as { ok: boolean; run?: unknown; error?: unknown; files?: unknown; c4d_version?: unknown; blender_version?: unknown; script_sha256?: unknown; script_sha256_read?: unknown };
  const version = { ...(r.c4d_version === undefined ? {} : { c4dVersion: r.c4d_version }), ...(r.blender_version === undefined ? {} : { blenderVersion: r.blender_version }) };
  if (opts.run !== undefined && r.run !== opts.run) {
    return verdict('unknown', `the result file is from another run (its run token is not this job's); ${recorded}`, [], version);
  }
  if (!r.ok) {
    const error = typeof r.error === 'string' && r.error.trim() ? r.error.trim() : 'no error given';
    return verdict('failed', `the script reported ok: false: ${error}; ${recorded}`, [], version);
  }
  let source: SourceCheck | undefined;
  if (opts.input) {
    if (typeof r.script_sha256 !== 'string') {
      return verdict('unknown', `the result says ok but does not echo the script's sha256 (TIMMY_SCRIPT_SHA256), so it cannot be bound to ${opts.input.path} as submitted; ${recorded}`, [], version);
    }
    if (r.script_sha256.toLowerCase() !== opts.input.sha256) {
      return verdict('unknown', `the result echoes another script's sha256, not ${opts.input.path} as submitted; ${recorded}`, [], version);
    }
    // R4 (finding 5): what ran is the script submitted only when the copy the app ran still holds the submitted
    // bytes or, with no copy (a run recorded before R4), the script reports reading them; a read digest that
    // disagrees, or a copy changed or gone, rules it out whatever else agrees.
    source = checkSource(opts.root, opts.input, opts.copy, r.script_sha256_read);
    const held = { ...version, source };
    if (source.read === 'differs') {
      return verdict('unknown', `the script reports reading other bytes than ${opts.input.path} as submitted (its script_sha256_read is not the submitted sha256): what ran cannot be shown to be what was submitted; ${recorded}`, [], held);
    }
    if (source.copy_state !== undefined && source.copy_state !== 'intact') {
      return verdict('unknown', `the copy of ${opts.input.path} kept at submission (${source.copy}) ${source.copy_state === 'gone' ? 'is gone' : 'no longer holds the submitted bytes'}, so what ran cannot be shown to be what was submitted; ${recorded}`, [], held);
    }
    if (!source.established_by.length) {
      return verdict('unknown', `the result does not report the sha256 of the script as it was read (script_sha256_read), and no copy kept at submission ran, so what ran cannot be bound to ${opts.input.path} as submitted; ${recorded}`, [], held);
    }
  }
  const extra: Partial<NativeJudgement> = { ...version, ...(source ? { source } : {}) };
  const since = opts.submittedMs ?? x.startedMs;
  const sinceMs = Number.isNaN(since) ? 0 : since;
  const files: NativeFileCheck[] = [];
  const named = r.files && typeof r.files === 'object' && !Array.isArray(r.files) ? Object.entries(r.files as Record<string, unknown>) : [];
  const covered = new Set<string>();
  const unlisted = new Map<string, string>();
  for (const [name, hash] of named) {
    const at = placeName(opts.root, name);
    if ('outside' in at) {
      files.push({ path: at.outside, present: false, outside: true });
      return verdict('failed', `the result says ok, but names ${at.outside}, outside the project; ${recorded}`, files, extra);
    }
    covered.add(at.rel);
    // R4 (finding 6): the bytes the name leads to (through any link), against the inventory taken before the run
    const real = relTo(opts.root, at.real);
    const c = classifyOutput(at.real, stateBefore(real, opts.pre, opts.inventory), sinceMs);
    const check: NativeFileCheck = {
      path: at.rel, present: c.present, written: c.change === 'created' || c.change === 'changed', change: c.change, ...(c.inventoried ? {} : { inventoried: false as const }),
    };
    if (!c.inventoried) unlisted.set(at.rel, `${real === at.rel ? '' : `it leads to ${real}, and `}${whyNotInventoried(real, opts.inventory)}`);
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
      check.recorded = hash.toLowerCase();
      if (c.present) {
        if (c.sha256) check.sha256 = c.sha256;
        check.matches = c.sha256 === check.recorded;
      }
    }
    files.push(check);
  }
  const unwritten = new Map<string, string>();
  for (const name of opts.expect ?? []) {
    if (covered.has(name)) continue;
    const w = writtenSince(path.join(opts.root, name), stateBefore(name, opts.pre, opts.inventory), sinceMs);
    files.push({ path: name, present: w.present, written: w.written, change: w.change, ...(w.inventoried ? {} : { inventoried: false as const }), ...(w.sha256 ? { sha256: w.sha256 } : {}) });
    if (!w.written) unwritten.set(name, w.words);
  }
  const undigested = files.find((f) => covered.has(f.path) && f.recorded === undefined);
  if (undigested) return verdict('failed', `the result says ok, but names ${undigested.path} without its sha256: every file it names must carry one; ${recorded}`, files, extra);
  const missing = files.find((f) => !f.present);
  if (missing) return verdict('failed', `the result says ok, but ${missing.path} is not there; ${recorded}`, files, extra);
  const differs = files.find((f) => f.matches === false);
  if (differs) return verdict('failed', `the result says ok, but ${differs.path} does not match the sha256 it recorded; ${recorded}`, files, extra);
  const unaccounted = files.find((f) => !covered.has(f.path) && !f.written);
  if (unaccounted) {
    return verdict('failed', `the result says ok, but ${unaccounted.path} was expected and the result does not name it, nor did this run write it (${unwritten.get(unaccounted.path) ?? 'not written by this run'}); ${recorded}`, files, extra);
  }
  // R4 (finding 6): a file the result names that this run did not make is not its work, however its bytes match.
  const notMade = files.find((f) => covered.has(f.path) && !f.written);
  if (notMade) return verdict('unknown', `the result says ok, but names ${notMade.path}, which ${notMadeWords(notMade, unlisted.get(notMade.path))}; ${recorded}`, files, extra);
  const list = (fs: NativeFileCheck[]): string => fs.map((f) => `${f.path} ${f.change ?? 'written'}`).join(', ');
  const byName = files.filter((f) => covered.has(f.path));
  const byPath = files.filter((f) => !covered.has(f.path));
  const what = [
    ...(byName.length ? [`${list(byName)} by this run, ${byName.length === 1 ? 'matching the sha256 the result recorded' : 'each matching the sha256 the result recorded'}`] : []),
    ...(byPath.length ? [`${list(byPath)} by this run, though the result does not name ${byPath.length === 1 ? 'it' : 'them'}`] : []),
  ].join('; ') || 'no files named or expected';
  return verdict('ok', `the result file is this run's, from ${source && opts.input ? sourceWords(source, opts.input) : 'its script'}, and says ok: ${what}; ${recorded}`, files, extra);
}

function optionsOf(meta: NativeMeta): JudgeOptions {
  return {
    root: meta.root, app: meta.app, run: meta.run, expect: meta.expect, resultExpected: meta.result !== undefined,
    ...(meta.input ? { input: meta.input } : {}), ...(meta.copy ? { copy: meta.copy } : {}), ...(meta.pre ? { pre: meta.pre } : {}),
    ...(meta.inventory ? { inventory: meta.inventory } : {}), ...(meta.frames ? { frames: meta.frames } : {}),
    ...(meta.submittedMs !== undefined ? { submittedMs: meta.submittedMs } : {}),
  };
}

function judgeMeta(x: ExitInfo, meta: NativeMeta): NativeJudgement {
  const opts = optionsOf(meta);
  if (meta.result === undefined || x.live) return judgeExit(x, undefined, opts);
  const read = readNativeResult(meta.result);
  if (read.state === 'unreadable') {
    const base = judgeExit(x, undefined, opts);
    return { ...base, outcome: 'unknown', why: `the result file cannot be read as JSON (${read.error}); ${NATIVE_APPS[meta.app].program} ${x.text}` };
  }
  return judgeExit(x, read.state === 'read' ? read.data : undefined, opts);
}

/**
 * Judge a finished native job from its spec: reads the result file (c4dpy) or checks the outputs
 * (aerender). An ended job's judgement is appended to the run's verdicts.jsonl (once while it says the
 * same), beside its job.json and never over it.
 */
export function judgeNativeJob(job: JobRecord, spec: NativeJobSpec | NativeMeta): NativeJudgement {
  const meta = 'native' in spec ? spec.native : spec;
  const x = exitOf(job);
  const j = judgeMeta(x, meta);
  if (!x.live && meta.record) appendVerdict(meta.record, j, job.id);
  return j;
}

/**
 * Judges a run again from its own folder after a restart: its job.json, its result file and the files
 * now, with the job's record when the caller has it (`job`, or `findJob` given the id its started.json
 * names; JobManager.get does). A stale job record, or none, means the exit was not recorded: it never
 * decides, and an exit-dependent outcome stays unknown. The judgement is appended to its verdicts.jsonl.
 * Throws when `run` is not a run token or the project has no record of it.
 */
export function reconcileNative(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): NativeJudgement {
  const rec = readNativeRecord(root, run);
  if (!rec) throw new Error(`no record of run ${run} in this project (.timmy/native/${run}/job.json)`);
  const base = realRoot(root);
  const j = rec.job;
  const started = Date.parse(j.started_at);
  // A record is a file in the project: every name in it must still lead inside the project.
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  const expect = Array.isArray(j.expect) ? j.expect.filter((n): n is string => typeof n === 'string') : [];
  for (const name of expect) within(name);
  if (j.input) within(j.input.path);
  // R4: a copy the record names must be a file in the project with a digest; an inventory, a list of folders
  const copy = j.copy && typeof j.copy.path === 'string' && typeof j.copy.sha256 === 'string' ? { path: j.copy.path, sha256: j.copy.sha256 } : undefined;
  if (j.copy && !copy) throw new Error(`the record of run ${run} names its script's copy without a path and a sha256`);
  if (copy) within(copy.path);
  const inventory = j.inventory && Array.isArray(j.inventory.folders) && j.inventory.folders.every((f) => typeof f === 'string') ? j.inventory : undefined;
  const meta: NativeMeta = {
    app: j.app, root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: started,
    ...(j.result ? { result: within(j.result) } : {}), ...(j.output ? { output: within(j.output) } : {}),
    ...(j.input ? { input: j.input } : {}), ...(copy ? { copy } : {}), ...(inventory ? { inventory } : {}), ...(j.frames ? { frames: j.frames } : {}),
  };
  const job = opts.job ?? (rec.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const x = job ? exitOf(job) : orphanExit('ended without a recorded exit status (reconciled from its record after a restart)', started);
  const verdict = judgeMeta(x, meta);
  if (!x.live) appendVerdict(rec.dir, verdict, job?.id);
  return verdict;
}

/**
 * A judgement as a receipt can carry it: names as the result or the spec gave them (relative to the
 * project), the outcome and why, the exit beside them, the run and the input it was bound to; R4: each
 * file's change (created, changed, reused...) and how what ran was bound to the script (`source`). `status`
 * is the receipt status the outcome allows: 'ok' or 'failed', and none for 'unknown' (a receipt must not
 * call an unknown run either).
 */
export function nativeReceiptFields(app: NativeApp, j: NativeJudgement): {
  status?: 'ok' | 'failed';
  native: {
    app: NativeApp; outcome: NativeJudgement['outcome']; why: string; exit_code: number | null; signal: string | null; files: NativeFileCheck[]; c4d_version?: unknown;
    blender_version?: unknown; run?: string; input?: { path: string; sha256: string }; checked?: SequenceCheck[]; source?: SourceCheck;
  };
} {
  return {
    ...(j.outcome === 'unknown' ? {} : { status: j.outcome }),
    native: {
      app, outcome: j.outcome, why: j.why, exit_code: j.exit.code, signal: j.exit.signal, files: j.files.map((f) => ({ ...f })),
      ...(j.c4dVersion === undefined ? {} : { c4d_version: j.c4dVersion }),
      ...(j.blenderVersion === undefined ? {} : { blender_version: j.blenderVersion }),
      ...(j.run ? { run: j.run } : {}), ...(j.input ? { input: { ...j.input } } : {}), ...(j.checked ? { checked: j.checked.map((c) => ({ ...c })) } : {}),
      ...(j.source ? { source: { ...j.source, established_by: [...j.source.established_by] } } : {}),
    },
  };
}

// ── what each app has done: sealed receipts, submissions ─────────────────────

/** One app's runs as the record shows them (R3, finding 6). Only `demonstrated` is exercise. */
export interface NativeRunSummary {
  /** the newest sealed receipt of this app judged ok, with status ok: demonstrated success */
  demonstrated?: { at: string; receipt?: string };
  /** the newest sealed receipt of this app, whatever it was judged */
  last?: { at: string; outcome: NativeJudgement['outcome']; why: string; receipt?: string };
  /** the newest run submitted in a project and not judged there yet (from its job.json) */
  submitted?: { at: string; run: string };
}
export type NativeRunIndex = Map<string, NativeRunSummary>;

const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'failed', 'unknown']);

/**
 * Each app's runs from sealed receipts (kind 'native', carrying native.app and native.outcome) and, when
 * given, a project's run records (listNativeRuns): a submission not judged yet. A turn's shared tool name
 * (run_native) says nothing here: it does not say which app ran, or how the run ended.
 */
export function nativeRunIndex(chain: Array<Record<string, unknown>>, records: Array<{ app: string; run: string; started_at: string; verdicts: unknown[] }> = []): NativeRunIndex {
  const index: NativeRunIndex = new Map();
  const get = (app: string): NativeRunSummary => { let s = index.get(app); if (!s) index.set(app, (s = {})); return s; };
  for (const r of chain) {
    const n = r.native as { app?: unknown; outcome?: unknown; why?: unknown } | undefined;
    if (r.kind !== 'native' || !n || typeof n.app !== 'string' || typeof n.outcome !== 'string' || !OUTCOMES.has(n.outcome) || typeof r.ts !== 'string') continue;
    const s = get(n.app);
    const receipt = typeof r.hash === 'string' ? r.hash.replace(/^sha256_/, '').slice(0, 8) : undefined;
    const mark = { at: r.ts, ...(receipt ? { receipt } : {}) };
    if (!s.last || s.last.at < r.ts) s.last = { ...mark, outcome: n.outcome as NativeJudgement['outcome'], why: typeof n.why === 'string' ? n.why : '' };
    if (n.outcome === 'ok' && r.status === 'ok' && (!s.demonstrated || s.demonstrated.at < r.ts)) s.demonstrated = mark;
  }
  for (const rec of records) {
    if (typeof rec.app !== 'string' || typeof rec.started_at !== 'string' || (rec.verdicts?.length ?? 0) > 0) continue;
    const s = get(rec.app);
    if (!s.submitted || s.submitted.at < rec.started_at) s.submitted = { at: rec.started_at, run: rec.run };
  }
  return index;
}

/** The time a row keyed native:<app> was last exercised: its newest sealed ok, or undefined. */
export function nativeExercisedAt(key: string, index: NativeRunIndex | undefined): string | undefined {
  if (!key.startsWith('native:')) return undefined;
  return index?.get(key.slice('native:'.length))?.demonstrated?.at;
}

/** A row's words for its app's runs: the last judged run, and a newer submission not judged yet. */
function runWords(s: NativeRunSummary | undefined): string | undefined {
  if (!s) return undefined;
  const parts: string[] = [];
  if (s.last) parts.push(`last run ${s.last.outcome}${s.last.outcome === 'ok' || !s.last.why ? '' : `: ${s.last.why}`}, ${s.last.at}`);
  if (s.submitted && (!s.last || s.submitted.at > s.last.at)) parts.push(`submitted ${s.submitted.at}, not judged yet`);
  return parts.length ? parts.join('; ') : undefined;
}

// ── /tools rows ───────────────────────────────────────────────────────────────

/**
 * One /tools row per app (kind 'adapter'). 'installed' when its program is found, with where and how;
 * 'needs setup' otherwise, with the step. Never higher: finding a program is not running it. Each row is
 * keyed `exercisedBy: native:<app>`: only a sealed receipt of that app judged ok marks it exercised (R3,
 * finding 6); `tools` still names run_native, which starts any of them. Given `runs`, the detail says the
 * app's last judged run and a submission not judged yet, without claiming either as exercise.
 */
export function nativeCapabilityRows(env: Env = process.env, seams: FinderSeams = {}, runs?: NativeRunIndex): CapabilityRow[] {
  const mac = (seams.platform ?? process.platform) === 'darwin';
  const apps = seams.applications ?? '/Applications';
  return (Object.keys(NATIVE_APPS) as NativeApp[]).map((app) => {
    const info = NATIVE_APPS[app];
    const { found, problem } = locateNative(app, env, seams);
    const scope = app === 'aerender' ? '; renders existing .aep/.aepx projects only (making or editing one: /ae author, /ae edit, After Effects scripting)'
      : app === 'afterfx' ? '; writes and edits projects inside the application (/ae author, /ae edit, /ae inspect; its window opens)'
        : app === 'openscad' ? '; exports a .scad model to a binary STL (/scad), read back by Timmy\'s own STL reader' : '';
    // R4: After Effects scripting and OpenSCAD say "implemented; not run" until a sealed run of their own says otherwise.
    const words = runWords(runs?.get(app)) ?? (app === 'afterfx' || app === 'openscad' ? 'implemented; not run' : undefined);
    const base = { id: app, kind: 'adapter' as const, name: info.name, tools: ['run_native'], exercisedBy: `native:${app}` };
    if (found) {
      const where = found.how === 'applications'
        ? `in ${path.join(apps, found.folder ?? '')}${found.version ? ` (version ${found.version} by its folder name)` : ''}, by the /Applications scan`
        : found.how === 'env' ? `at ${info.envVar}` : `on PATH at ${found.path}`;
      return { ...base, rung: 'installed' as const, detail: `${info.program} ${where}; ${words ?? 'not run here'}${scope}` };
    }
    const tail = words ? `; ${words}` : '';
    if (problem) return { ...base, rung: 'needs setup' as const, detail: `${problem}${tail}`, setup: `point ${info.envVar} at ${info.program}, or unset it` };
    const looked = [`${info.envVar} is not set`, ...(mac && info.applicationsScan !== false ? [`no ${info.prefix} in ${apps}`] : []), `no ${info.program} on PATH`].join(', ');
    return { ...base, rung: 'needs setup' as const, detail: `not found: ${looked}${tail}`, setup: info.setup };
  });
}
