/**
 * FreeCAD as a Timmy job (round R4, helper H28): FreeCAD's command-line program, freecadcmd, runs a Python script
 * headless as a judged native job, with the rules Blender's runs follow (src/native/index.ts): a run token, the
 * script's sha256 echoed, a read-only copy of the script kept in the run's folder and run instead of the original,
 * the outputs under out/ inventoried before the run and classified after it, and a result file written by the
 * script (workers/freecad/timmy_freecad.py) that decides the run, never freecadcmd's exit status.
 *
 * How freecadcmd takes a script. From FreeCAD's own command-line file handling (App::Application::processFiles,
 * as FreeCAD's source reads; no FreeCAD runs in this repository, so this is not yet observed here):
 *   - every word after its options is a file to process: an .FCStd is opened, a .FCMacro is run, and a .py file has
 *     its folder appended to sys.path and is IMPORTED as a module named after the file; only when that import raises
 *     is the file run a second time, in __main__. Then freecadcmd exits with status 0, whatever the script did;
 *   - so the copy is the only word on the command line, `freecadcmd <copy>`, and the script's own arguments go in
 *     TIMMY_SCRIPT_ARGS (a JSON list of strings): more words would be taken as more files to open;
 *   - the copy is named timmy_<run8>_<stem>.py, a module name no other file on FreeCAD's path has: under its own name
 *     a script called test.py would import Python's own test package instead, and never run;
 *   - a module import does not run code under `if __name__ == "__main__":`. timmy_freecad.run_script(main) is called at
 *     the top level (templates/freecad-starter/plate.py does), never lets an exception out (which would make FreeCAD
 *     run the whole file again) and runs main once per process. Its result says whether the code that ran came from
 *     the copy (script_is_copy); a result that does not say is not bound to the script submitted.
 *   - the values Timmy passes are environment variables, as for the other scripted apps: TIMMY_RESULT, TIMMY_RUN,
 *     TIMMY_SCRIPT, TIMMY_SCRIPT_SHA256, TIMMY_SCRIPT_ORIGINAL, TIMMY_SCRIPT_DIR, TIMMY_ROOT, TIMMY_OUT, TIMMY_SCRIPT_ARGS
 *     and TIMMY_FREECAD_LIB (the folder with timmy_freecad.py).
 *
 * The result lists FreeCAD's own report of its own document (objects, their types, shape validity, volume and bounding
 * box in mm, the shapes each STEP export holds) and the files written (.FCStd, STEP) with sha256. That report is a
 * claim FreeCAD makes about its document in the process that built it. Timmy computes each file's sha256 itself after
 * the run, and offers a separate check of the STEP: the readback worker /iterate uses (workers/readback/step_readback.py,
 * OCP's STEP reader in its own process, with TIMMY_CADQUERY_PYTHON) measures the file, and its numbers are compared with
 * FreeCAD's report. Both are OpenCascade, so agreement shows the STEP file holds the geometry FreeCAD reported; it is not
 * an independent kernel's confirmation. DOCTRINE §15 goes wherever dimensions are shown.
 *
 * Nothing here has run against FreeCAD: tests/native-freecad.test.ts runs the job, the helper and the starter with a
 * FAKE freecadcmd (tests/fixtures/fake-freecadcmd.mjs) and stand-in FreeCAD and Part modules (tests/fixtures/freecad-stub).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import type { Segment } from '../term/theme.js';
import { packagedPath } from '../utils/asset-dirs.js';
import { DOCTRINE_15, mm3Text, mmText, READBACK_TOLERANCE, type ReadbackMeasured } from '../flows/iterate.js';
import {
  judgeNativeJob, listNativeRuns, locateNative, NATIVE_APPS, NATIVE_RUNS_DIR, NativeNotFound, nativeReceiptFields, preStates, readNativeRecord, readNativeResult,
  sha256File, writeSubmission, type FinderSeams, type NativeFileCheck, type NativeJobSpec, type NativeJudgement, type NativeMeta, type NativeVerdictLine,
} from './index.js';
import { inventoryFolders, keepScript, OUT_FOLDER, readSubmittedScript, scriptEnv } from './provenance.js';

export { DOCTRINE_15 };

type Env = Record<string, string | undefined>;
type Line = Segment[];

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const RUN_DIR = NATIVE_RUNS_DIR.split(path.sep).join('/');
const RUN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);
/** The run's own FreeCAD record, beside job.json: the module name freecadcmd was given and the script's arguments. */
export const FREECAD_RECORD = 'freecad.json';
/** Each STEP readback of the run, one JSON line each, appended beside its verdicts and never over them. */
export const FREECAD_READBACKS = 'readbacks.jsonl';
/** Who reported what the result lists. */
export const FREECAD_REPORTED_BY = "FreeCAD's own report of its own document, in the process that built it";
/** What the STEP readback measures, said once: on the record, in the receipt, in the notices. */
export const FREECAD_READBACK_SCOPE = "The readback measures the exported STEP file, in its own process, with OpenCascade's STEP reader (OCP). FreeCAD is OpenCascade too: agreement shows the file holds the geometry FreeCAD reported, not an independent kernel's confirmation. Neither is a measurement of a physical part.";
/** Why a run with no result file may have written none (said only beside such an outcome; not checked). */
export const FREECAD_NO_RESULT_HINT = 'a possible cause, not checked: freecadcmd loads a .py file as a module named after it, so code under `if __name__ == "__main__":` does not run (call timmy_freecad.run_script(main) at the top level, as templates/freecad-starter/plate.py does); freecadcmd\'s own output is in the job\'s log';

export const FREECAD_USAGE = [
  '/freecad <script.py> [args]            run a FreeCAD Python script headless (freecadcmd) as a judged job; args reach it in TIMMY_SCRIPT_ARGS',
  '/freecad readback [<run>] [<file.step>]  read a run\'s exported STEP back in its own process and compare it with FreeCAD\'s report',
];

// ── finding freecadcmd, and the helper ───────────────────────────────────────────

/** freecadcmd: TIMMY_FREECADCMD (a FreeCAD.app is opened to Contents/Resources/bin/freecadcmd), then /Applications on macOS, then PATH. */
export const findFreecad = (env: Env = process.env, seams: FinderSeams = {}) => locateNative('freecad', env, seams).found;

/** The folder holding timmy_freecad.py (workers/freecad), for TIMMY_FREECAD_LIB, found as the Blender helper is. */
export function freecadHelperDir(): string | undefined {
  const helper = packagedPath('workers/freecad/timmy_freecad.py', import.meta.url, { kind: 'file' });
  return helper === undefined ? undefined : path.dirname(helper);
}

/** The copy's module name: timmy_<the run token's first 8>_<the script's stem, letters, digits and _ only>. */
export function freecadModuleName(run: string, rel: string): string {
  const stem = path.posix.basename(rel.split(path.sep).join('/')).replace(/\.py$/i, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'script';
  return `timmy_${run.slice(0, 8).toLowerCase()}_${stem}`;
}

// ── the job ──────────────────────────────────────────────────────────────────────

export interface FreecadJobInput {
  /** the Python file freecadcmd runs, relative to root */
  script: string;
  /** the script's own arguments: in TIMMY_SCRIPT_ARGS, a JSON list (timmy_freecad.script_args() reads them) */
  args?: string[];
  root: string;
  project: string;
  timeoutMs?: number;
  /** where the script writes its result file, relative to root (default .timmy/native/<run>/result.json) */
  result?: string;
  /** files the result must name, or this run must write, relative to root */
  expect?: string[];
  /** the freecadcmd to run (default: found by locateNative('freecad'), TIMMY_FREECADCMD first) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  /** where the finder looks (default: this process's environment with `env` over it) */
  findEnv?: Env;
  seams?: FinderSeams;
  label?: string;
}

/** What a FreeCAD run carries beyond the native module's meta, on its spec and in its freecad.json. */
export interface FreecadRunMeta {
  /** the module name freecadcmd imports the copy as (its file name without .py) */
  module: string;
  /** the script's own arguments, as TIMMY_SCRIPT_ARGS gives them */
  args: string[];
}
export interface FreecadJobSpec extends NativeJobSpec { freecad: FreecadRunMeta }

export function isFreecadJobSpec(spec: unknown): spec is FreecadJobSpec {
  return Boolean(spec && typeof spec === 'object' && 'freecad' in spec && 'native' in spec && (spec as { native?: { app?: unknown } }).native?.app === 'freecad');
}

function realRoot(root: string): string {
  try { return realpathSync(root); } catch { throw new Error('the project folder is gone'); }
}
function inside(root: string, rel: string): { path: string; rel: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) throw new Error(at.error);
  return at;
}
/** As for the other native apps: TIMMY_NATIVE_HOME names the home that holds the app's settings (a sandboxed Timmy). */
function nativeHome(extra?: NodeJS.ProcessEnv): { HOME?: string } {
  const home = extra?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME;
  return home ? { HOME: home } : {};
}
function findProgram(input: FreecadJobInput): string {
  if (input.bin) return input.bin;
  const { found, problem } = locateNative('freecad', input.findEnv ?? { ...process.env, ...input.env }, input.seams);
  if (!found) throw new NativeNotFound('freecad', NATIVE_APPS.freecad.setup, problem);
  return found.path;
}

/**
 * A task job running `freecadcmd <copy>` in the project folder, the copy alone on its command line. The copy is the
 * script as submitted, byte for byte, kept read-only in the run's folder (.timmy/native/<run>/source/<module>.py, its
 * sha256 checked when made and again when the run is judged). Making the spec inventories every file under out/
 * and the expected outputs, keeps the copy, and writes the run's job.json and freecad.json.
 */
export function freecadJob(input: FreecadJobInput): FreecadJobSpec {
  const root = realRoot(input.root);
  const script = readSubmittedScript(inside(root, input.script));
  if (!/\.py$/i.test(script.rel)) throw new Error(`${script.rel} is not a Python file (.py)`);
  const args = (input.args ?? []).map((a) => String(a));
  const bin = findProgram(input);
  const run = randomUUID();
  const record = path.join(root, NATIVE_RUNS_DIR, run);
  const result = inside(root, input.result ?? `${RUN_DIR}/${run}/result.json`);
  const expect = (input.expect ?? []).map((rel) => inside(root, rel).rel);
  const lib = input.env?.TIMMY_FREECAD_LIB ?? freecadHelperDir();
  const submittedMs = Date.now();
  const pre = preStates(root, expect);
  const inventory = inventoryFolders(root, pre, [OUT_FOLDER]);
  const module = freecadModuleName(run, script.rel);
  const copy = keepScript(root, record, script, `${module}.py`);
  const spec: FreecadJobSpec = {
    kind: 'task', label: input.label ?? `FreeCAD · ${script.rel}`, project: input.project, root,
    command: bin, args: [copy.path],
    env: {
      ...input.env, ...nativeHome(input.env), TIMMY_RESULT: result.path, TIMMY_RUN: run, TIMMY_ROOT: root, TIMMY_OUT: path.join(root, OUT_FOLDER),
      ...scriptEnv(script, copy), TIMMY_SCRIPT_ARGS: JSON.stringify(args), ...(lib ? { TIMMY_FREECAD_LIB: lib } : {}),
    },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    native: {
      app: 'freecad', root, run, record, result: result.path, expect, input: { path: script.rel, sha256: script.sha256 }, copy: { path: copy.rel, sha256: copy.sha256 },
      pre, inventory, submittedMs,
    },
    freecad: { module, args },
  };
  writeSubmission(spec);
  writeFileSync(path.join(record, FREECAD_RECORD), `${JSON.stringify({ record: 'timmy-freecad-run', v: 1, run, module, script_args: args }, null, 2)}\n`, { flag: 'wx' });
  return spec;
}

// ── what the result reports ──────────────────────────────────────────────────────

export interface FreecadBounds { min: number[]; max: number[]; size: number[]; method?: string }
/** A shape as FreeCAD measured it (its internal length unit, mm): FreeCAD's claim, never Timmy's measurement. */
export interface FreecadShape { type?: string; valid: boolean | null; solids?: number; volume_mm3?: number; bounds?: FreecadBounds }
export interface FreecadObjectReport { document?: string; name: string; label?: string; type?: string; state?: string[]; shape?: FreecadShape }
export interface FreecadExportReport { path: string; format: string; objects: string[]; shape?: FreecadShape }
/** FreeCAD's part of a run: what its result reported (FreeCAD's own words about its own document), and the run's own record. */
export interface FreecadReport {
  module?: string;
  args?: string[];
  version?: string;
  build?: string;
  /** whether the code that ran came from the copy kept at submission, as the helper saw it (main's own file) */
  script_is_copy?: boolean;
  /** the file the code that ran came from, relative to the project, when the helper named one */
  script_ran?: string;
  documents: Array<{ name: string; label?: string; file?: string; objects?: number }>;
  objects: FreecadObjectReport[];
  /** how many objects the documents held, when more were there than the result lists */
  objects_total?: number;
  exports: FreecadExportReport[];
  /** the script's own checks, as it reported them */
  checks?: Array<{ label: string; passed: boolean }>;
  /** the error the script reported (ok: false), as written */
  error?: string;
  result_file: string;
}
export interface FreecadJudgement extends NativeJudgement { freecad: FreecadReport }

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length ? v.slice(0, max) : undefined);
const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** A name the result gave, as the project knows it: relative and inside it, or "(outside the project) <name>"; never a full path. */
function projectName(root: string, v: unknown): string | undefined {
  const s = text(v, 400);
  if (!s) return undefined;
  if (!path.isAbsolute(s)) return s.split(path.sep).join('/');
  const rel = path.relative(root, s);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : `(outside the project) ${path.basename(s)}`;
}

/** A shape as reported; the size is computed here from min and max, never taken from the report. */
export function shapeOf(v: unknown): FreecadShape | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const b = obj(o.bounds);
  const bounds = b && triple(b.min) && triple(b.max)
    ? { min: [...b.min], max: [...b.max], size: b.max.map((m, i) => m - (b.min as number[])[i]), ...(text(b.method) ? { method: text(b.method) } : {}) }
    : undefined;
  return {
    ...(text(o.type, 40) ? { type: text(o.type, 40) } : {}),
    valid: typeof o.valid === 'boolean' ? o.valid : null,
    ...(finite(o.solids) && Number.isInteger(o.solids) && o.solids >= 0 ? { solids: o.solids } : {}),
    ...(finite(o.volume_mm3) ? { volume_mm3: o.volume_mm3 } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

/**
 * The FreeCAD part of a result file (parsed JSON), defensively: names capped, numbers finite, paths relative to the
 * project or said to be outside it. `run` gives the run's own record (module name, arguments) when known.
 */
export function freecadReport(r: Record<string, unknown> | undefined, o: { root: string; resultFile: string; run?: FreecadRunMeta }): FreecadReport {
  const documents = Array.isArray(r?.documents) ? r.documents.slice(0, 20).flatMap((d) => {
    const x = obj(d);
    const name = text(x?.name, 120);
    if (!x || !name) return [];
    const file = projectName(o.root, x.file);
    return [{ name, ...(text(x.label, 120) ? { label: text(x.label, 120) } : {}), ...(file ? { file } : {}), ...(finite(x.objects) ? { objects: x.objects } : {}) }];
  }) : [];
  const objects = Array.isArray(r?.objects) ? r.objects.slice(0, 200).flatMap((v) => {
    const x = obj(v);
    const name = text(x?.name, 120);
    if (!x || !name) return [];
    const state = Array.isArray(x.state) ? x.state.filter((s): s is string => typeof s === 'string').slice(0, 8).map((s) => s.slice(0, 40)) : undefined;
    const shape = shapeOf(x.shape);
    return [{
      name, ...(text(x.document, 120) ? { document: text(x.document, 120) } : {}), ...(text(x.label, 120) ? { label: text(x.label, 120) } : {}),
      ...(text(x.type, 80) ? { type: text(x.type, 80) } : {}), ...(state ? { state } : {}), ...(shape ? { shape } : {}),
    }];
  }) : [];
  const exports = Array.isArray(r?.exports) ? r.exports.slice(0, 50).flatMap((v) => {
    const x = obj(v);
    const at = projectName(o.root, x?.path);
    if (!x || !at) return [];
    const shape = shapeOf(x.shape);
    const names = Array.isArray(x.objects) ? x.objects.filter((n): n is string => typeof n === 'string').slice(0, 50).map((n) => n.slice(0, 120)) : [];
    return [{ path: at, format: text(x.format, 20) ?? (/\.(step|stp)$/i.test(at) ? 'STEP' : 'unknown'), objects: names, ...(shape ? { shape } : {}) }];
  }) : [];
  const checks = Array.isArray(r?.checks) ? r.checks.slice(0, 50).flatMap((v) => {
    const x = obj(v);
    return x && text(x.label) && typeof x.passed === 'boolean' ? [{ label: text(x.label)!, passed: x.passed }] : [];
  }) : undefined;
  const ran = projectName(o.root, r?.script_ran);
  const total = r?.objects_total;
  return {
    ...(o.run ? { module: o.run.module, args: [...o.run.args] } : {}),
    ...(text(r?.freecad_version, 40) ? { version: text(r?.freecad_version, 40) } : {}),
    ...(text(r?.freecad_build, 80) ? { build: text(r?.freecad_build, 80) } : {}),
    ...(typeof r?.script_is_copy === 'boolean' ? { script_is_copy: r.script_is_copy } : {}),
    ...(ran ? { script_ran: ran } : {}),
    documents, objects,
    ...(finite(total) && total > objects.length ? { objects_total: total } : {}),
    exports,
    ...(checks && checks.length ? { checks } : {}),
    ...(r?.ok === false && text(r.error, 2000) ? { error: text(r.error, 2000) } : {}),
    result_file: o.resultFile,
  };
}

// ── judging a run ────────────────────────────────────────────────────────────────

/** Appends the final judgement to the run's verdicts.jsonl, unless its last line already says the same. */
function appendVerdict(dir: string | undefined, j: NativeJudgement, jobId?: string): void {
  if (!dir) return;
  const file = path.join(dir, 'verdicts.jsonl');
  try {
    let last: NativeVerdictLine | undefined;
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      last = lines.length ? JSON.parse(lines[lines.length - 1]) as NativeVerdictLine : undefined;
    } catch { /* none yet, or a torn line: a new line follows */ }
    if (last && last.outcome === j.outcome && last.why === j.why && last.job === jobId) return;
    const line: NativeVerdictLine = {
      judged_at: new Date().toISOString(), ...(jobId ? { job: jobId } : {}), outcome: j.outcome, why: j.why, exit: j.exit, files: j.files,
      ...(j.checked ? { checked: j.checked } : {}), ...(j.source ? { source: j.source } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record */ }
}

/**
 * A finished FreeCAD run, judged: first by the native module's rules (judgeNativeJob, not let to record: the result is
 * this run's, echoes the script's sha256 as submitted, the copy that ran still holds those bytes and the script read
 * them; it says ok; every file it names is in the project, with a sha256 matching the file now, made by this run), then
 * by FreeCAD's import of the copy: an ok whose result says the code that ran came from another file than the copy
 * (script_is_copy false), or does not say (no script_is_copy), is unknown: freecadcmd imports a .py by module name, and
 * only the script's own helper can see which file that import found. The final judgement alone is appended to the run's
 * verdicts.jsonl. A job still going is judged unknown and not recorded.
 */
export function judgeFreecadJob(job: JobRecord, spec: FreecadJobSpec): FreecadJudgement {
  const base = judgeNativeJob(job, { ...spec.native, record: undefined });
  const read = spec.native.result ? readNativeResult(spec.native.result) : { state: 'missing' as const };
  const r = read.state === 'read' ? obj(read.data) : undefined;
  const report = freecadReport(r, { root: spec.root, resultFile: relTo(spec.root, spec.native.result ?? ''), run: spec.freecad });
  if (!job.stale && LIVE.has(job.state)) return { ...base, freecad: report };
  let outcome = base.outcome;
  let why = base.why;
  if (outcome === 'ok' && report.script_is_copy === false) {
    outcome = 'unknown';
    why = `the result says ok, but the code that ran came from ${report.script_ran ?? 'another file'}, not the copy kept at submission (${spec.native.copy?.path ?? 'the copy'}): freecadcmd imports a .py by its module name and found another file; ${why}`;
  } else if (outcome === 'ok' && report.script_is_copy === undefined) {
    outcome = 'unknown';
    why = `the result says ok, but does not say whether the code that ran came from the copy kept at submission (script_is_copy): freecadcmd imports a .py by its module name, so only the script's helper (workers/freecad/timmy_freecad.py) can say which file ran; ${why}`;
  }
  if (read.state === 'missing' && outcome !== 'ok') why = `${why}; ${FREECAD_NO_RESULT_HINT}`;
  const j: FreecadJudgement = { ...base, outcome, why, freecad: report };
  appendVerdict(spec.native.record, j, job.id);
  return j;
}

/** A run's spec rebuilt from its folder (job.json and freecad.json), every name in them checked to lead inside the project. */
export function freecadSpecFromRecord(root: string, run: string): FreecadJobSpec {
  const base = realRoot(root);
  const rec = readNativeRecord(base, run);
  if (!rec || rec.job.app !== 'freecad') throw new Error(`no record of a FreeCAD run ${run} in this project`);
  let meta: FreecadRunMeta;
  try {
    const f = JSON.parse(readFileSync(path.join(rec.dir, FREECAD_RECORD), 'utf8')) as { record?: unknown; run?: unknown; module?: unknown; script_args?: unknown };
    if (f.record !== 'timmy-freecad-run' || f.run !== run || typeof f.module !== 'string' || !Array.isArray(f.script_args)) throw new Error('malformed');
    meta = { module: f.module, args: f.script_args.map((a) => String(a)) };
  } catch { throw new Error(`the record of run ${run} has no FreeCAD part (${FREECAD_RECORD})`); }
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  const j = rec.job;
  const expect = Array.isArray(j.expect) ? j.expect.filter((n): n is string => typeof n === 'string') : [];
  for (const n of expect) within(n);
  if (j.input) within(j.input.path);
  const copy = j.copy && typeof j.copy.path === 'string' && typeof j.copy.sha256 === 'string' ? { path: j.copy.path, sha256: j.copy.sha256 } : undefined;
  if (copy) within(copy.path);
  const inventory = j.inventory && Array.isArray(j.inventory.folders) && j.inventory.folders.every((f) => typeof f === 'string') ? j.inventory : undefined;
  const native: NativeMeta = {
    app: 'freecad', root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: Date.parse(j.started_at),
    ...(j.result ? { result: within(j.result) } : {}), ...(j.input ? { input: j.input } : {}), ...(copy ? { copy } : {}), ...(inventory ? { inventory } : {}),
  };
  return { kind: 'task', label: j.label, project: j.project, root: base, command: j.program, args: j.args, timeoutMs: j.timeout_ms, native, freecad: meta };
}

/**
 * Judges a FreeCAD run again from its folder after a restart: with the job's record when the caller has it (`job`, or
 * `findJob` given the id its started.json names), else as a run whose exit was not recorded, which never decides.
 */
export function reconcileFreecad(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): FreecadJudgement {
  const spec = freecadSpecFromRecord(root, run);
  const rec = readNativeRecord(spec.root, run);
  const found = opts.job ?? (rec?.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const job: JobRecord = found ?? {
    id: rec?.started?.job ?? 'j000000', kind: 'task', label: spec.label, project: spec.project, root: spec.root, command: spec.command, args: spec.args,
    state: 'running', startedAt: rec?.job.started_at ?? new Date(0).toISOString(), steps: [], logPath: '', lines: 0, stale: true,
  };
  return judgeFreecadJob(job, spec);
}

/** A shape as a receipt carries it: its numbers, who measured them and DOCTRINE §15's tags (generated, constructed). */
function sealedShape(s: FreecadShape): Record<string, unknown> {
  return {
    ...s, ...(s.bounds ? { bounds: { ...s.bounds, min: [...s.bounds.min], max: [...s.bounds.max], size: [...s.bounds.size] } } : {}),
    units: 'mm', measured_by: 'FreeCAD (its own report)', geometry: { provenance: 'generated', evidence: 'constructed' },
  };
}

/** A judgement as a receipt carries it: the native fields (app freecad) and FreeCAD's report, project-relative names only. */
export function freecadReceiptFields(j: FreecadJudgement): ReturnType<typeof nativeReceiptFields> & { native: { freecad: Record<string, unknown> } } {
  const base = nativeReceiptFields('freecad', j);
  const f = j.freecad;
  return {
    ...base,
    native: {
      ...base.native,
      freecad: {
        ...(f.version ? { freecad_version: f.version } : {}), ...(f.build ? { freecad_build: f.build } : {}),
        ...(f.module ? { module: f.module } : {}), ...(f.args ? { args: f.args.slice(0, 40) } : {}),
        ...(f.script_is_copy !== undefined ? { script_is_copy: f.script_is_copy } : {}),
        documents: f.documents.map((d) => ({ ...d })),
        objects: f.objects_total ?? f.objects.length,
        exports: f.exports.map((e) => ({ path: e.path, format: e.format, objects: [...e.objects], ...(e.shape ? { reported: sealedShape(e.shape) } : {}) })),
        ...(f.checks ? { checks: { passed: f.checks.filter((c) => c.passed).length, of: f.checks.length } } : {}),
        reported_by: FREECAD_REPORTED_BY,
        doctrine: DOCTRINE_15,
      },
    },
  };
}

// ── what the REPL and the agent are told ─────────────────────────────────────────

const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');
const size = (n: number | undefined): string => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const isStep = (p: string): boolean => /\.(step|stp)$/i.test(p);

/** A shape in words: "a valid solid, 100 x 60 x 6 mm, 33,215.8 mm3" (FreeCAD's numbers; the caller says whose). */
export function shapeWords(s: FreecadShape | undefined): string {
  if (!s) return 'no shape reported';
  const validity = s.valid === true ? 'valid' : s.valid === false ? 'NOT valid' : 'validity not reported';
  const kind = s.solids !== undefined ? `${s.solids} ${validity} solid${s.solids === 1 ? '' : 's'}` : `a ${validity} ${s.type ?? 'shape'}`;
  return [kind, s.bounds ? `${mmText(s.bounds.size)} mm` : 'no bounding box', s.volume_mm3 !== undefined ? `${mm3Text(s.volume_mm3)} mm3` : 'no volume'].join(', ');
}

/** Said before the run: how freecadcmd runs the copy, and where the script's arguments are. */
export function freecadStartLines(spec: FreecadJobSpec, sep: string): Line[] {
  const f = spec.freecad;
  return [
    [{ text: '  App        ', role: 'secondary' }, { text: `freecadcmd, headless${sep}it runs ${spec.native.copy?.path ?? 'a copy of the script'}, a read-only copy of ${spec.native.input?.path ?? 'the script'}, as module ${f.module}` }],
    [{ text: '  Note       ', role: 'secondary' }, { text: `freecadcmd imports the copy, so nothing under if __name__ == "__main__" runs: a script calls timmy_freecad.run_script(main) at the top level${sep}arguments: ${f.args.length ? `${f.args.length} in TIMMY_SCRIPT_ARGS` : 'none'}`, role: 'secondary' }],
  ];
}

/** A judged-ok run's STEP exports that the run made and its result names with a sha256: what /freecad readback can read. */
function readableSteps(j: FreecadJudgement): FreecadExportReport[] {
  if (j.outcome !== 'ok') return [];
  const made = new Map(j.files.map((f) => [f.path, f]));
  return j.freecad.exports.filter((e) => isStep(e.path) && made.get(e.path)?.written === true && made.get(e.path)?.recorded !== undefined);
}

/**
 * Said when the run ends: the outcome, each file the result names with Timmy's sha256 and what the run did to it,
 * FreeCAD's report of what its STEP exports hold (labelled as its own report, with DOCTRINE §15), the script's own
 * checks, and the next step: the STEP readback (or why it cannot start yet: `readback.why`).
 */
export function freecadEndLines(j: FreecadJudgement, spec: FreecadJobSpec, o: {
  id: string; label: string; glyphs: { ok: string; fail: string }; sep: string; scrub: (s: string) => string; receipt?: string; readback?: { ready: boolean; why?: string };
}): Line[] {
  const f = j.freecad;
  const mark = j.outcome === 'ok' ? o.glyphs.ok : j.outcome === 'failed' ? o.glyphs.fail : '?';
  const lines: Line[] = [[
    { text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined },
    { text: `${o.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' },
    { text: `  ${o.label}: ${o.scrub(j.why)}${o.receipt ? `${o.sep}receipt ${o.receipt}` : ''}${o.sep}/results`, role: 'secondary' },
  ]];
  for (const file of j.files.filter((x): x is NativeFileCheck & { recorded: string } => x.recorded !== undefined).slice(0, 12)) {
    const word = isStep(file.path) ? 'exported ' : /\.fcstd$/i.test(file.path) ? 'saved    ' : 'wrote    ';
    let bytes: number | undefined;
    try { bytes = statSync(path.join(spec.root, file.path)).size; } catch { bytes = undefined; }
    const did = file.written ? `${file.change ?? 'written'} by this run` : `not made by this run (${file.change ?? 'not shown'})`;
    const how = !file.present ? 'not there' : `${did}${o.sep}sha256 ${short(file.sha256)} (Timmy's, after the run)${bytes !== undefined ? `${o.sep}${size(bytes)}` : ''}`;
    lines.push([{ text: `      ${word}`, role: 'secondary' }, { text: `${file.path}${o.sep}${how}`, role: file.present && file.written ? undefined : 'failure' }]);
  }
  const shown = f.exports.filter((e) => e.shape);
  if (f.version || shown.length || f.objects.length) {
    const docs = f.documents.length ? ` in ${f.documents.map((d) => d.name).slice(0, 3).join(', ')}` : '';
    lines.push([{ text: '      reported ', role: 'secondary' }, { text: `FreeCAD ${f.version ?? '(version not reported)'}: ${f.objects_total ?? f.objects.length} object${(f.objects_total ?? f.objects.length) === 1 ? '' : 's'}${docs}${o.sep}${FREECAD_REPORTED_BY}`, role: 'secondary' }]);
  }
  for (const e of shown.slice(0, 4)) {
    lines.push([{ text: '               ', role: 'secondary' }, { text: `${e.path} holds ${e.objects.slice(0, 4).join(', ') || 'its objects'}: ` }, { text: shapeWords(e.shape), role: 'strong' }, { text: `${o.sep}FreeCAD's numbers`, role: 'secondary' }]);
  }
  if (!shown.length) {
    const last = [...f.objects].reverse().find((x) => x.shape?.bounds);
    if (last) lines.push([{ text: '               ', role: 'secondary' }, { text: `${last.name}${last.type ? ` (${last.type})` : ''}: ` }, { text: shapeWords(last.shape), role: 'strong' }, { text: `${o.sep}FreeCAD's numbers`, role: 'secondary' }]);
  }
  if (f.checks) {
    const passed = f.checks.filter((c) => c.passed).length;
    const failing = f.checks.filter((c) => !c.passed).map((c) => c.label).slice(0, 4);
    lines.push([{ text: '      checks   ', role: 'secondary' }, { text: `the script's own: ${passed} of ${f.checks.length} passed${failing.length ? ` (failed: ${o.scrub(failing.join(', '))})` : ''}${o.sep}FreeCAD's measurements against the script's own expectations`, role: failing.length ? 'failure' : 'secondary' }]);
  }
  if (shown.length || f.objects.some((x) => x.shape?.bounds)) lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
  if (f.error) {
    lines.push([{ text: '      error    ', role: 'secondary' }, { text: `${o.scrub(f.error)}${o.sep}${f.result_file}${o.sep}/jobs ${o.id} for freecadcmd's own output`, role: 'failure' }]);
  } else if (j.outcome !== 'ok') {
    lines.push([{ text: '      look     ', role: 'secondary' }, { text: `${f.result_file}${o.sep}/jobs ${o.id} for freecadcmd's own output`, role: 'secondary' }]);
  }
  const steps = readableSteps(j);
  if (steps.length) {
    const run8 = spec.native.run.slice(0, 8);
    const target = steps.length === 1 ? '' : ` ${steps[0].path}`;
    const blocked = o.readback && !o.readback.ready ? ` (first: ${o.readback.why ?? 'set TIMMY_CADQUERY_PYTHON'})` : '';
    lines.push([{ text: '      next     ', role: 'secondary' }, { text: `/freecad readback ${run8}${target} reads ${steps[0].path} back in its own process (OCP's STEP reader) and compares it with FreeCAD's report${blocked}` }]);
  }
  return lines;
}

/** The agent's note on a started run. */
export function freecadToolNote(spec: FreecadJobSpec, jobId: string): string {
  return [
    `Started, not finished: freecadcmd runs ${spec.native.copy?.path ?? 'a copy of the script'} (a read-only copy of ${spec.native.input?.path}) headless; /jobs ${jobId} follows it.`,
    `It is judged when it ends, by the script's result file (${relTo(spec.root, spec.native.result ?? '')}), which must come from workers/freecad/timmy_freecad.py's run_script (it says which file ran).`,
    'freecadcmd imports a .py as a module: the script must call run_script(main) at the top level, not under if __name__ == "__main__". Its arguments are in TIMMY_SCRIPT_ARGS.',
    'Do not claim the part is made or measured until the job is judged ok; what the result lists is FreeCAD\'s own report. Then /freecad readback reads its STEP back in a separate process.',
  ].join(' ');
}

// ── the STEP readback: which file, and the comparison ────────────────────────────

/** What a readback reads and compares with: a judged-ok run's STEP export, its bytes now as the run recorded them. */
export interface FreecadReadbackPlan {
  run: string;
  /** the run's own folder (absolute): its readbacks.jsonl and the readback's kept output go there */
  dir: string;
  /** the FreeCAD job's id, from the run's started.json */
  job?: string;
  step: { path: string; abs: string; sha256: string };
  /** FreeCAD's measurement of the shapes the STEP holds, as its result reported it */
  reported: FreecadShape & { valid: boolean; solids: number; volume_mm3: number; bounds: FreecadBounds };
  objects: string[];
  version?: string;
  /** the run's other STEP exports */
  others: string[];
}

/** The project's FreeCAD runs, newest first: each run's last verdict, and its readbacks so far. */
export function listFreecadRuns(root: string): Array<{ run: string; started_at: string; label: string; verdict?: NativeVerdictLine; readbacks: FreecadReadbackLine[] }> {
  return listNativeRuns(root).filter((r) => r.app === 'freecad').map((r) => {
    const rec = readNativeRecord(root, r.run);
    return { run: r.run, started_at: r.started_at, label: rec?.job.label ?? r.run, ...(r.verdicts.length ? { verdict: r.verdicts.at(-1) } : {}), readbacks: rec ? readReadbacks(rec.dir) : [] };
  });
}

/**
 * Which run and which STEP file /freecad readback reads, or why it starts nothing: the run named (a run token or its
 * first characters; default the newest FreeCAD run judged ok), its last verdict ok, a STEP export its result names with
 * a sha256 (the one named, or the only one), that file's bytes now the ones the run recorded, and FreeCAD's report of
 * the shapes in it (validity, solids, volume and bounds) to compare with.
 */
export function planFreecadReadback(root: string, o: { run?: string; step?: string } = {}): { ok: true; plan: FreecadReadbackPlan } | { ok: false; error: string } {
  let base: string;
  try { base = realRoot(root); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const runs = listNativeRuns(base).filter((r) => r.app === 'freecad');
  let run: string | undefined;
  if (o.run) {
    const want = o.run.toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(want)) return { ok: false, error: `${o.run} is not a run token: name a FreeCAD run by its first 8 characters (/freecad lists them)` };
    const hits = runs.filter((r) => r.run.toLowerCase().startsWith(want));
    if (!hits.length) return { ok: false, error: `no FreeCAD run ${o.run} in this project (/freecad lists them)` };
    if (hits.length > 1) return { ok: false, error: `${o.run} names ${hits.length} FreeCAD runs: give more of the token` };
    run = hits[0].run;
  } else {
    run = runs.find((r) => r.verdicts.at(-1)?.outcome === 'ok')?.run;
    if (!run) return { ok: false, error: runs.length ? 'no FreeCAD run in this project has been judged ok yet: only a run judged ok is read back' : 'no FreeCAD run in this project yet: /freecad <script.py> makes one' };
  }
  if (!RUN_TOKEN.test(run)) return { ok: false, error: `${run} is not a run token` };
  const rec = readNativeRecord(base, run);
  if (!rec) return { ok: false, error: `no record of run ${run.slice(0, 8)} in this project` };
  const last = rec.verdicts.at(-1);
  if (!last) return { ok: false, error: `run ${run.slice(0, 8)} has not been judged yet (it may still be running: /jobs)` };
  if (last.outcome !== 'ok') return { ok: false, error: `run ${run.slice(0, 8)} was judged ${last.outcome}: ${last.why}; only a run judged ok is read back` };
  if (rec.result.state !== 'read') return { ok: false, error: `run ${run.slice(0, 8)}'s result file is ${rec.result.state === 'missing' ? 'gone' : 'not readable'} now` };
  const r = obj(rec.result.data);
  const report = freecadReport(r, { root: base, resultFile: rec.job.result ?? '' });
  const recorded = obj(r?.files) ?? {};
  const steps = report.exports.filter((e) => isStep(e.path));
  if (!steps.length) return { ok: false, error: `run ${run.slice(0, 8)} exported no STEP file its result names (exports)` };
  let pick: FreecadExportReport | undefined;
  if (o.step) {
    const want = o.step.split(path.sep).join('/').replace(/^\.\//, '');
    pick = steps.find((e) => e.path === want);
    if (!pick) return { ok: false, error: `run ${run.slice(0, 8)} exported no ${o.step}: its STEP exports are ${steps.map((e) => e.path).join(', ')}` };
  } else if (steps.length > 1) {
    return { ok: false, error: `run ${run.slice(0, 8)} exported ${steps.length} STEP files (${steps.map((e) => e.path).join(', ')}): name one, /freecad readback ${run.slice(0, 8)} <file.step>` };
  } else pick = steps[0];
  const sha = typeof recorded[pick.path] === 'string' && /^[0-9a-f]{64}$/i.test(recorded[pick.path] as string) ? (recorded[pick.path] as string).toLowerCase() : undefined;
  if (!sha) return { ok: false, error: `run ${run.slice(0, 8)}'s result does not name ${pick.path} in its files with a sha256, so its bytes cannot be bound to FreeCAD's report` };
  const checked = last.files.find((x) => x.path === pick!.path);
  if (!checked?.written) return { ok: false, error: `${pick.path} was not shown to be made by run ${run.slice(0, 8)} when it was judged` };
  const at = resolveInside(base, pick.path);
  if ('error' in at) return { ok: false, error: `${pick.path}: ${at.error}` };
  const now = sha256File(at.path);
  if (now !== sha) {
    return { ok: false, error: `${pick.path} ${now ? `has changed since run ${run.slice(0, 8)} (sha256 now ${short(now)}, the run recorded ${short(sha)})` : 'is gone'}: reading it back would not measure what FreeCAD reported; nothing was started` };
  }
  const s = pick.shape;
  const lacks = !s ? ['a measurement'] : [
    ...(typeof s.valid !== 'boolean' ? ['validity'] : []), ...(s.solids === undefined ? ['a solid count'] : []),
    ...(s.volume_mm3 === undefined ? ['a volume'] : []), ...(s.bounds === undefined ? ['a bounding box'] : []),
  ];
  if (lacks.length) return { ok: false, error: `FreeCAD's result reports no ${lacks.join(', ')} for ${pick.path}: there is nothing to compare the readback with` };
  return {
    ok: true,
    plan: {
      run, dir: rec.dir, ...(rec.started?.job ? { job: rec.started.job } : {}), step: { path: pick.path, abs: at.path, sha256: sha },
      reported: s as FreecadReadbackPlan['reported'], objects: pick.objects, ...(report.version ? { version: report.version } : {}),
      others: steps.filter((e) => e !== pick).map((e) => e.path),
    },
  };
}

export interface FreecadReadbackCheck { name: string; reported: number | boolean; measured: number | boolean; difference: number | null; tolerance: string; passed: boolean }

/**
 * The readback's measurement against FreeCAD's report of the same shapes: both valid, the same number of solids, each
 * bounding-box corner coordinate within the tolerance in mm, the volume within the relative tolerance. The tolerance is
 * /iterate's readback gate (READBACK_TOLERANCE, the CadQuery recipe's own), not loosened: between the two measurements
 * stand only OpenCascade's STEP writer (in FreeCAD) and reader (in the worker). Every check is kept with its numbers.
 */
export function compareFreecadReadback(reported: FreecadReadbackPlan['reported'], m: ReadbackMeasured, tol: { bounds_mm: number; volume_relative: number } = READBACK_TOLERANCE): { verdict: 'matches' | 'differs'; checks: FreecadReadbackCheck[] } {
  const corner = (which: 'min' | 'max'): FreecadReadbackCheck[] => ['x', 'y', 'z'].map((axis, i) => {
    const d = m.bounds[which][i] - reported.bounds[which][i];
    return { name: `bounds ${which} ${axis} (mm)`, reported: reported.bounds[which][i], measured: m.bounds[which][i], difference: d, tolerance: `${tol.bounds_mm} mm`, passed: Math.abs(d) <= tol.bounds_mm };
  });
  const d = m.volume_mm3 - reported.volume_mm3;
  const rel = reported.volume_mm3 ? Math.abs(d) / Math.abs(reported.volume_mm3) : Number.POSITIVE_INFINITY;
  const checks: FreecadReadbackCheck[] = [
    { name: 'valid shape', reported: reported.valid, measured: m.valid, difference: null, tolerance: 'both valid', passed: reported.valid === true && m.valid === true },
    { name: 'solids', reported: reported.solids, measured: m.solids, difference: m.solids - reported.solids, tolerance: 'exact', passed: m.solids === reported.solids },
    ...corner('min'), ...corner('max'),
    { name: 'volume (mm3)', reported: reported.volume_mm3, measured: m.volume_mm3, difference: d, tolerance: `${tol.volume_relative} relative`, passed: rel <= tol.volume_relative },
  ];
  return { verdict: checks.every((c) => c.passed) ? 'matches' : 'differs', checks };
}

/** One readback of a run's STEP, as the run's readbacks.jsonl keeps it. */
export interface FreecadReadbackLine {
  readback: 1;
  at: string;
  job?: string;
  run: string;
  state: string;
  step: { path: string; sha256: string };
  worker?: { name: string; version: string };
  engine?: Record<string, unknown>;
  /** FreeCAD's report of the shapes in the file (generated CAD, constructed) */
  reported: Record<string, unknown>;
  /** the readback's measurement of the file, when it gave one */
  measured?: Record<string, unknown>;
  tolerance: { bounds_mm: number; volume_relative: number };
  checks?: FreecadReadbackCheck[];
  verdict?: 'matches' | 'differs' | 'failed';
  reason?: string;
  log?: string;
  receipt?: string;
  scope: string;
  doctrine: string;
}

/** A run's readbacks so far, oldest first (a torn line is skipped, never repaired). */
export function readReadbacks(dir: string): FreecadReadbackLine[] {
  let body = '';
  try { body = readFileSync(path.join(dir, FREECAD_READBACKS), 'utf8'); } catch { return []; }
  const out: FreecadReadbackLine[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as FreecadReadbackLine); } catch { /* skipped */ }
  }
  return out;
}

/** Appends a readback to the run's readbacks.jsonl; false when it could not be written. */
export function appendReadback(dir: string, line: FreecadReadbackLine): boolean {
  try { appendFileSync(path.join(dir, FREECAD_READBACKS), `${JSON.stringify(line)}\n`); return true; } catch { return false; }
}
