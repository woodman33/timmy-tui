/**
 * OpenSCAD as a judged native route (round R4, helper H27): `/scad <model.scad> [name=value ...] [--png]` and the
 * agent's run_native app 'openscad'. OpenSCAD runs headless from its command line; no window opens.
 *
 * A run is an ordinary Timmy job in the project, with the native module's per-run folder (.timmy/native/<run>/:
 * job.json, started.json, verdicts.jsonl), to which this module adds:
 *   source/<model>.scad    the model as submitted, copied byte for byte, read-only, its sha256 checked when made and
 *                          again when the run is judged: OpenSCAD runs this copy (src/native/provenance.ts keepScript)
 *   runner-config.json     read-only, its sha256 recorded: the program and each step's exact arguments
 *   runner.json, logs/     written by workers/scad/timmy_scad_run.mjs, the job's own program: each step's exit
 *                          status and its stdout and stderr, kept separately and hashed
 *   scad.json              this module's record: the model, its copy, the parameters and where each came from, the
 *                          exact -D arguments, the outputs, OPENSCADPATH
 *   openscad-summary.json  OpenSCAD's own summary (--summary all), when its build has that option
 *   readback.json          Timmy's own reading of the STL (src/native/stl-readback.ts), written at the first judgement
 * The STL (binary, --export-format binstl) and the optional PNG preview go to a new folder for each run,
 * out/scad/<the run token's first 8 characters>/<model>.stl.
 *
 * use <file> and include <file>: OpenSCAD looks for such a file beside the file that names it (the copy, alone in
 * its folder), then in each folder on OPENSCADPATH, then in its library folders. Timmy puts the model's own folder
 * first on OPENSCADPATH (before any the environment already has), so files beside the original resolve as they
 * would for the original; running in another folder would not help, since OpenSCAD resolves them by the file, not
 * the working folder. import() and surface() are different: OpenSCAD resolves their files beside the file that
 * calls them and never on OPENSCADPATH, so a file named that way from the model itself is looked for beside the
 * copy; /scad says so before the run when the model calls them.
 *
 * Judged (judgeScadJob), the exit recorded beside the outcome and never deciding it alone:
 *   ok       the copy still holds the submitted bytes; the STL was created (or changed) by this run, by the R4
 *            provenance rules; openscad's export exited 0 (runner.json); OpenSCAD wrote no ERROR line; and Timmy's
 *            own reading parsed the file (or it was too large to read, which is said)
 *   failed   no STL was made by this run and the export exited non-zero, reported errors, or was stopped; or the
 *            file OpenSCAD wrote is not a well-formed STL
 *   unknown  still running; the copy changed or gone; an STL written but the export exited non-zero or reported
 *            ERROR lines, or its exit was not recorded; a file at the STL's path not made by this run
 * ERROR and WARNING lines (and OpenSCAD's other error and warning kinds) are kept verbatim from the export's own
 * stderr; the dimensions are Timmy's measurement of the exported mesh, shown with DOCTRINE §15's sentence.
 *
 * Nothing here has been run against OpenSCAD here: tests/native-openscad.test.ts runs the real runner on a stand-in
 * program (tests/fixtures/fake-openscad.mjs, a labelled test double that writes known meshes).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import type { Segment } from '../term/theme.js';
import { packagedPath } from '../utils/asset-dirs.js';
import {
  locateNative, NATIVE_APPS, NATIVE_RUNS_DIR, NativeNotFound, nativeReceiptFields, preStates, readNativeRecord, sha256File, writeSubmission,
  type FinderSeams, type NativeFileCheck, type NativeJobSpec, type NativeJudgement, type NativeMeta, type NativeVerdictLine, type OutputChange,
} from './index.js';
import { checkSource, classifyOutput, keepScript, madeByRun, notWrittenWords, readSubmittedScript, stateBefore, type Classified, type SourceCheck, type SubmittedScript } from './provenance.js';
import { checkScadParams, mergeScadParams, paramsFileFor, readScadParams, SCAD_WORDS_USAGE, scadLiteral, unassignedNames, type ScadParam, type ScadValue } from './scad-params.js';
import { DOCTRINE_15, num, readStlFile, topologyWords, volumeWords, type StlReadback, type StlReadResult, type Vec3 } from './stl-readback.js';

type Env = Record<string, string | undefined>;
type Line = Segment[];

/** Where each run's STL and preview go, relative to the project: a new folder per run under it. */
export const SCAD_OUT_DIR = 'out/scad';
/** The job's program: Timmy's runner, which runs OpenSCAD's steps and records each (package-relative). */
export const SCAD_RUNNER = 'workers/scad/timmy_scad_run.mjs';
/** The preview's default size, in pixels. */
export const SCAD_IMGSIZE: readonly [number, number] = [800, 600];
/** The usage lines /scad shows. */
export const SCAD_USAGE = [
  `${SCAD_WORDS_USAGE}   OpenSCAD exports out/scad/<run>/<model>.stl; Timmy reads it back`,
  '  name=value   a number, true or false, or text in quotes (label="Lid"); over <model>.params.json beside the model',
  '  --png        also a preview, rendered by OpenSCAD: <model>.png, 800x600',
];
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** each step's stdout and stderr are kept up to this many bytes (the rest passes through to the job's output) */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** OpenSCAD's message kinds (its message groups), at the start of a line */
const MESSAGE = /^(ERROR|WARNING|UI-WARNING|FONT-WARNING|EXPORT-WARNING|EXPORT-ERROR|UI-ERROR|PARSER-ERROR|TRACE|DEPRECATED|ECHO):/;
const ERROR_KINDS: ReadonlySet<string> = new Set(['ERROR', 'EXPORT-ERROR', 'UI-ERROR', 'PARSER-ERROR']);
const WARNING_KINDS: ReadonlySet<string> = new Set(['WARNING', 'UI-WARNING', 'FONT-WARNING', 'EXPORT-WARNING', 'DEPRECATED']);
/** error and warning lines kept, and each one's length kept */
const KEEP_LINES = 50;
const LINE_CHARS = 2000;

/** The runner's place in this Timmy (a checkout, the TypeScript build or the bundled CLI), or undefined. */
export function scadRunnerPath(): string | undefined {
  return packagedPath(SCAD_RUNNER, import.meta.url, { kind: 'file' });
}

// ── a run ────────────────────────────────────────────────────────────────────────

export interface ScadJobInput {
  /** the .scad model, relative to root */
  model: string;
  /** name=value parameters (the words, or the agent's): over the model's parameter file */
  params?: Record<string, unknown>;
  /** also a PNG preview, rendered by OpenSCAD */
  png?: boolean;
  root: string;
  project: string;
  timeoutMs?: number;
  /** the openscad program (default: locateNative('openscad'): TIMMY_OPENSCAD, then PATH) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  /** where the finder looks (default: this process's environment with `env` over it) */
  findEnv?: Env;
  seams?: FinderSeams;
  /** false: the model's parameter file is not read */
  paramsFile?: false;
  /** the output folder, relative to root; by default a new one per run, out/scad/<the run token's first 8 characters> */
  outDir?: string;
  /** the preview's size in pixels (default 800x600) */
  imgsize?: [number, number];
  label?: string;
}

/** What judging a run needs beyond the native module's meta, carried on its spec and in its scad.json. Paths absolute, rel project-relative. */
export interface ScadRunMeta {
  model: { path: string; rel: string; sha256: string; bytes: number };
  copy: { path: string; rel: string; sha256: string };
  params: Record<string, ScadParam>;
  /** the -D arguments, exactly as given to OpenSCAD */
  defines: string[];
  paramsFile?: { path: string; sha256: string };
  out: { path: string; rel: string };
  stl: { path: string; rel: string };
  png?: { path: string; rel: string; size: [number, number] };
  summary: { path: string; rel: string };
  runner: {
    worker: string; sha256: string;
    config: { path: string; rel: string; sha256: string };
    record: { path: string; rel: string };
    logs: { path: string; rel: string };
  };
  program: { path: string; how: 'given' | 'env' | 'applications' | 'path' };
  /** the folders Timmy put first on OPENSCADPATH (absolute) */
  openscadPath: string[];
  /** said before the run: parameter names the model does not assign, import() or surface() calls */
  notes: string[];
}
export interface ScadJobSpec extends NativeJobSpec { scad: ScadRunMeta }

export function isScadJobSpec(spec: unknown): spec is ScadJobSpec {
  return Boolean(spec && typeof spec === 'object' && 'scad' in spec && 'native' in spec && (spec as { native?: { app?: unknown } }).native?.app === 'openscad');
}

/** scad.json: this module's part of a run's record, written once at submission. Project paths relative. */
interface ScadRunRecord {
  record: 'timmy-scad-run';
  v: 1;
  run: string;
  model: { path: string; sha256: string; bytes: number };
  copy: { path: string; sha256: string };
  params: Record<string, ScadParam>;
  defines: string[];
  params_file?: { path: string; sha256: string };
  out: string;
  stl: string;
  png?: { path: string; size: [number, number] };
  summary: string;
  runner: { worker: string; sha256: string; config: string; config_sha256: string; record: string; logs: string };
  program: { path: string; how: ScadRunMeta['program']['how'] };
  openscadpath: string[];
  notes: string[];
}

function realRoot(root: string): string {
  try { return realpathSync(root); } catch { throw new Error('the project folder is gone'); }
}
function inside(root: string, rel: string): { path: string; rel: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) throw new Error(at.error);
  return at;
}
const createHashHex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
const isThere = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

function readModel(at: { path: string; rel: string }): SubmittedScript {
  try { return readSubmittedScript(at); } catch (e) { throw new Error((e as Error).message.replace(/^no script at /, 'no model at ')); }
}

function findProgram(input: ScadJobInput): ScadRunMeta['program'] {
  if (input.bin) return { path: input.bin, how: 'given' };
  const { found, problem } = locateNative('openscad', input.findEnv ?? { ...process.env, ...input.env }, input.seams ?? {});
  if (!found) throw new NativeNotFound('openscad', NATIVE_APPS.openscad.setup, problem);
  return { path: found.path, how: found.how };
}

/** The model's text without its comments, for the hints said before a run. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

/**
 * A task job running Timmy's runner (Node, workers/scad/timmy_scad_run.mjs) on this run's configuration: OpenSCAD's
 * --version, then the export (`openscad -o <stl> --export-format binstl [-D name=value]... [--summary all
 * --summary-file <file>] <copy>`, again without the summary options when OpenSCAD refuses them), then, with
 * png, the preview (`openscad -o <png> --render --imgsize=W,H --autocenter --viewall [-D ...] <copy>`).
 * Making the spec reads the model and its parameter file, keeps the read-only copy, records the outputs' state
 * before the run, makes the run's output folder and writes the run's folder (runner-config.json, scad.json and the
 * native module's job.json). Nothing else is written. Throws, with nothing started, when something is refused.
 */
export function scadJob(input: ScadJobInput): ScadJobSpec {
  const root = realRoot(input.root);
  if (typeof input.model !== 'string' || !input.model.trim()) throw new Error(`name the model: ${SCAD_WORDS_USAGE}`);
  const at = inside(root, input.model);
  if (!/\.scad$/i.test(at.rel)) throw new Error(`${at.rel} is not an OpenSCAD model (.scad)`);
  const model = readModel(at);
  const words = checkScadParams(input.params ?? {}, 'the parameters');
  if (!words.ok) throw new Error(words.error);
  let fileParams: Record<string, ScadValue> = {};
  let paramsFile: ScadRunMeta['paramsFile'];
  if (input.paramsFile !== false) {
    const read = readScadParams(root, at.rel);
    if (!read.ok) throw new Error(`the parameter file ${read.path} is refused: ${read.error}; fix it, or move it away to run without it`);
    if (read.exists) { fileParams = read.parameters; paramsFile = { path: read.path, sha256: read.sha256 }; }
  }
  const { params, defines } = mergeScadParams(fileParams, words.parameters);
  const size: [number, number] = input.imgsize ? [input.imgsize[0], input.imgsize[1]] : [SCAD_IMGSIZE[0], SCAD_IMGSIZE[1]];
  if (!size.every((n) => Number.isInteger(n) && n >= 16 && n <= 8192)) throw new Error('the preview size is two whole numbers of pixels, 16 to 8192');
  const program = findProgram(input);
  const worker = scadRunnerPath();
  if (!worker) throw new Error(`the OpenSCAD runner (${SCAD_RUNNER}) is not in this Timmy`);
  const workerSha = sha256File(worker);
  if (!workerSha) throw new Error(`the OpenSCAD runner (${SCAD_RUNNER}) cannot be read`);

  // A new output folder for each run, named by the run token, unless the caller names one.
  let run = randomUUID();
  if (!input.outDir) {
    for (let i = 0; isThere(path.join(root, SCAD_OUT_DIR, run.slice(0, 8))); i++) {
      if (i >= 8) throw new Error(`no new folder could be found under ${SCAD_OUT_DIR}/`);
      run = randomUUID();
    }
  }
  const out = inside(root, input.outDir ?? `${SCAD_OUT_DIR}/${run.slice(0, 8)}`);
  const stem = path.posix.basename(at.rel).replace(/\.scad$/i, '');
  const stl = inside(root, `${out.rel}/${stem}.stl`);
  const png = input.png ? { ...inside(root, `${out.rel}/${stem}.png`), size } : undefined;
  const expect = [stl.rel, ...(png ? [png.rel] : [])];
  const submittedMs = Date.now();
  // R4 provenance: each output's state before the run (absent in a new folder), what the judgement compares against.
  const pre = preStates(root, expect);
  const record = path.join(root, NATIVE_RUNS_DIR, run);
  mkdirSync(record, { recursive: true });
  const copy = keepScript(root, record, model);
  mkdirSync(out.path, { recursive: true });

  const summary = path.join(record, 'openscad-summary.json');
  const runnerRecord = path.join(record, 'runner.json');
  const logs = path.join(record, 'logs');
  const D = defines.flatMap((d) => ['-D', d]);
  const exportArgs = ['-o', stl.path, '--export-format', 'binstl', ...D];
  const config = {
    record: 'timmy-scad-runner-config', v: 1, run, program: program.path, cwd: root, out: runnerRecord, logs, max_log_bytes: MAX_LOG_BYTES,
    steps: {
      version: { args: ['--version'] },
      export: { args: [...exportArgs, '--summary', 'all', '--summary-file', summary, copy.path], fallback: { args: [...exportArgs, copy.path] } },
      ...(png ? { png: { args: ['-o', png.path, '--render', `--imgsize=${size[0]},${size[1]}`, '--autocenter', '--viewall', ...D, copy.path] } } : {}),
    },
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  const configPath = path.join(record, 'runner-config.json');
  writeFileSync(configPath, configText, { flag: 'wx', mode: 0o444 });

  // use<> and include<>: the model's own folder first on OPENSCADPATH, then whatever the environment had.
  const modelDir = path.dirname(model.path);
  const had = (input.env?.OPENSCADPATH ?? process.env.OPENSCADPATH ?? '').split(path.delimiter).filter(Boolean);
  const openscadPath = [modelDir, ...had.filter((p) => p !== modelDir)];
  const home = input.env?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME;
  const env: NodeJS.ProcessEnv = { ...input.env, OPENSCADPATH: openscadPath.join(path.delimiter), ...(home ? { HOME: home } : {}) };

  const text = model.bytes.toString('utf8');
  const notes: string[] = [];
  const unassigned = unassignedNames(text, Object.keys(params));
  if (unassigned.length) {
    notes.push(`${unassigned.join(', ')}: no "name = …" line in ${at.rel}'s own text; OpenSCAD defines a -D name whether or not the model uses it, so a misspelt one changes nothing (an included file may use it)`);
  }
  if (/\b(?:import|surface)\s*\(/.test(code(text))) {
    notes.push(`${at.rel} calls import() or surface(): OpenSCAD looks for a file named there beside the copy it runs, not beside ${at.rel} and not on OPENSCADPATH; name such a file by its absolute path, or call import() in a file the model includes (paths there resolve beside that file)`);
  }

  const scad: ScadRunMeta = {
    model: { path: model.path, rel: at.rel, sha256: model.sha256, bytes: model.bytes.length },
    copy: { path: copy.path, rel: copy.rel, sha256: copy.sha256 },
    params, defines, ...(paramsFile ? { paramsFile } : {}),
    out, stl, ...(png ? { png } : {}), summary: { path: summary, rel: relTo(root, summary) },
    runner: {
      worker, sha256: workerSha, config: { path: configPath, rel: relTo(root, configPath), sha256: createHashHex(configText) },
      record: { path: runnerRecord, rel: relTo(root, runnerRecord) }, logs: { path: logs, rel: relTo(root, logs) },
    },
    program, openscadPath: [modelDir], notes,
  };
  const native: NativeMeta = {
    app: 'openscad', root, run, record, expect, input: { path: at.rel, sha256: model.sha256 }, copy: { path: copy.rel, sha256: copy.sha256 }, pre, submittedMs,
  };
  const spec: ScadJobSpec = {
    kind: 'task', label: input.label ?? `OpenSCAD · ${at.rel} → ${stl.rel}`, project: input.project, root,
    command: process.execPath, args: [worker, configPath], env, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS, native, scad,
  };
  const rec: ScadRunRecord = {
    record: 'timmy-scad-run', v: 1, run,
    model: { path: at.rel, sha256: model.sha256, bytes: model.bytes.length }, copy: { path: copy.rel, sha256: copy.sha256 },
    params, defines, ...(paramsFile ? { params_file: paramsFile } : {}),
    out: out.rel, stl: stl.rel, ...(png ? { png: { path: png.rel, size } } : {}), summary: scad.summary.rel,
    runner: { worker, sha256: workerSha, config: scad.runner.config.rel, config_sha256: scad.runner.config.sha256, record: scad.runner.record.rel, logs: scad.runner.logs.rel },
    program, openscadpath: openscadPath, notes,
  };
  writeFileSync(path.join(record, 'scad.json'), `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
  writeSubmission(spec);
  return spec;
}

// ── judging a run ────────────────────────────────────────────────────────────────

/** A stream as runner.json records it. */
interface RunnerStream { file: string; bytes: number; kept: number; sha256: string; truncated: boolean }
/** A step as runner.json records it. */
interface RunnerStep {
  name: string; attempt: number; args: string[]; started_at: string; ended_at?: string;
  exit_code: number | null; signal: string | null; error?: string; interrupted?: string; stdout?: RunnerStream; stderr?: RunnerStream;
}
interface RunnerRecord {
  record: 'timmy-scad-runner'; v: 1; run: string; config_sha256: string; started_at: string; ended_at?: string; steps: RunnerStep[];
  summary?: { state?: string; line?: string }; png?: { state?: string; why?: string }; exit_code?: number; interrupted?: string; error?: string;
}
type RunnerRead = { state: 'read'; data: RunnerRecord } | { state: 'missing' | 'unreadable' | 'not this run'; why: string };

const isStep = (s: unknown): s is RunnerStep => Boolean(s && typeof s === 'object' && typeof (s as RunnerStep).name === 'string');

/** runner.json, bound to this run: its token, and the configuration Timmy wrote for it (by sha256). */
function readRunner(m: ScadRunMeta, run: string): RunnerRead {
  let text: string;
  try { text = readFileSync(m.runner.record.path, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing', why: `the runner's record (${m.runner.record.rel}) is missing` }
      : { state: 'unreadable', why: `the runner's record (${m.runner.record.rel}) cannot be read` };
  }
  let data: RunnerRecord;
  try { data = JSON.parse(text) as RunnerRecord; } catch { return { state: 'unreadable', why: `the runner's record (${m.runner.record.rel}) is not JSON` }; }
  if (!data || data.record !== 'timmy-scad-runner' || data.v !== 1 || !Array.isArray(data.steps)) return { state: 'unreadable', why: `${m.runner.record.rel} is not a runner record` };
  if (data.run !== run) return { state: 'not this run', why: `${m.runner.record.rel} carries another run's token` };
  if (data.config_sha256 !== m.runner.config.sha256) return { state: 'not this run', why: 'the runner read a configuration whose sha256 is not the one Timmy wrote for this run' };
  return { state: 'read', data: { ...data, steps: data.steps.filter(isStep) } };
}

/** A step's end in a few words (after the program's name). */
function stepWords(s: RunnerStep): string {
  if (s.interrupted) return `was stopped (${s.interrupted}) before it ended`;
  if (s.error && s.exit_code === null) return `could not be started (${s.error})`;
  if (s.signal) return `ended by ${s.signal}`;
  if (s.ended_at === undefined) return 'has no recorded end';
  return `exited ${s.exit_code}`;
}

/** A recorded step's end in a few words, as stepWords says it. */
function reportWords(s: { exit_code: number | null; signal: string | null; error?: string; interrupted?: string; ended?: false }): string {
  if (s.interrupted) return `was stopped (${s.interrupted}) before it ended`;
  if (s.error && s.exit_code === null) return `could not be started (${s.error})`;
  if (s.signal) return `ended by ${s.signal}`;
  if (s.ended === false) return 'has no recorded end';
  return `exited ${s.exit_code}`;
}

/** A file's first `max` bytes as text (a regular file only, never a FIFO waited on), and whether it was longer. */
function readBounded(file: string, max = MAX_LOG_BYTES): { text: string; truncated: boolean } | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) return undefined;
    const n = Math.min(s.size, max);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) { const r = readSync(fd, buf, got, n - got, got); if (r <= 0) break; got += r; }
    return { text: buf.subarray(0, got).toString('utf8'), truncated: s.size > max };
  } catch { return undefined; } finally { closeSync(fd); }
}

/** One of OpenSCAD's error or warning lines, verbatim (cut only past LINE_CHARS, and then marked). */
export interface ScadMessageLine { kind: string; text: string; cut?: true }
/** OpenSCAD's messages from one step: counted by kind, the error and warning lines kept verbatim. */
export interface ScadMessages {
  /** where they were read: the step's own stderr (kept by the runner), the job's combined output, or nowhere */
  from: 'stderr' | 'job output' | 'none';
  /** ERROR, EXPORT-ERROR, UI-ERROR, PARSER-ERROR lines */
  errors: number;
  /** WARNING, UI-WARNING, FONT-WARNING, EXPORT-WARNING, DEPRECATED lines */
  warnings: number;
  echo: number;
  trace: number;
  /** in their order: up to 40 error lines and 40 warning lines */
  lines: ScadMessageLine[];
  /** error or warning lines not kept */
  more?: number;
  /** the text read was cut at its limit: lines past it were not read */
  truncated?: true;
}

/** OpenSCAD's message lines in a text: each line that starts with one of its kinds (ERROR:, WARNING:, …). */
export function scanMessages(text: string, from: ScadMessages['from'], truncated = false): ScadMessages {
  const out: ScadMessages = { from, errors: 0, warnings: 0, echo: 0, trace: 0, lines: [] };
  let keptErrors = 0;
  let keptWarnings = 0;
  let more = 0;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = MESSAGE.exec(line);
    if (!m) continue;
    const kind = m[1];
    if (kind === 'ECHO') { out.echo++; continue; }
    if (kind === 'TRACE') { out.trace++; continue; }
    const isError = ERROR_KINDS.has(kind);
    if (isError) out.errors++; else if (WARNING_KINDS.has(kind)) out.warnings++;
    if ((isError ? keptErrors : keptWarnings) >= KEEP_LINES * 0.8) { more++; continue; }
    if (isError) keptErrors++; else keptWarnings++;
    out.lines.push(line.length > LINE_CHARS ? { kind, text: line.slice(0, LINE_CHARS), cut: true } : { kind, text: line });
  }
  if (more) out.more = more;
  if (truncated) out.truncated = true;
  return out;
}

function stepMessages(m: ScadRunMeta, s: RunnerStep | undefined): ScadMessages {
  if (!s?.stderr?.file) return scanMessages('', 'none');
  const read = readBounded(path.join(m.runner.logs.path, path.basename(s.stderr.file)));
  return read ? scanMessages(read.text, 'stderr', read.truncated || s.stderr.truncated) : scanMessages('', 'none');
}

/** OpenSCAD's own answer to --version, from the version step's kept output. */
function versionOf(m: ScadRunMeta, s: RunnerStep | undefined): string | undefined {
  if (!s) return undefined;
  for (const stream of [s.stderr, s.stdout]) {
    if (!stream?.file) continue;
    const read = readBounded(path.join(m.runner.logs.path, path.basename(stream.file)), 64 * 1024);
    const hit = read ? /OpenSCAD version\s+([^\r\n]+)/i.exec(read.text) : null;
    if (hit) return hit[1].trim().slice(0, 120);
  }
  return undefined;
}

const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** OpenSCAD's own summary file: its state, and its bounding box (when the file has one) against Timmy's reading. */
function summaryOf(m: ScadRunMeta, runner: RunnerRead, readback: StlReadback | undefined): ScadReadout['summary'] {
  if (runner.state !== 'read') return { state: 'unknown' };
  const s = runner.data.summary;
  if (s?.state === 'refused') return { state: 'refused', ...(typeof s.line === 'string' ? { line: s.line.slice(0, LINE_CHARS) } : {}) };
  if (s?.state !== 'requested') return { state: 'not requested' };
  const read = readBounded(m.summary.path, 4 * 1024 * 1024);
  if (!read) return { state: 'not written', path: m.summary.rel };
  const sha256 = sha256File(m.summary.path);
  let bbox: { min: Vec3; max: Vec3 } | undefined;
  try {
    const b = (JSON.parse(read.text) as { geometry?: { bounding_box?: { min?: unknown; max?: unknown } } })?.geometry?.bounding_box;
    if (b && vec3(b.min) && vec3(b.max)) bbox = { min: b.min, max: b.max };
  } catch { /* not JSON, or another shape: kept, not read */ }
  const compare = bbox && readback?.bbox ? [...bbox.min.map((v, i) => Math.abs(v - readback.bbox!.min[i])), ...bbox.max.map((v, i) => Math.abs(v - readback.bbox!.max[i]))] : undefined;
  // float32 coordinates in the STL against OpenSCAD's doubles: agreement within float32's precision
  const tolerance = (v: number): number => 1e-6 * Math.max(1, Math.abs(v));
  const agrees = compare && bbox ? compare.every((d, i) => d <= tolerance((i < 3 ? bbox!.min : bbox!.max)[i % 3])) : undefined;
  return {
    state: 'written', path: m.summary.rel, ...(sha256 ? { sha256 } : {}),
    ...(bbox ? { bbox } : {}), ...(agrees !== undefined ? { agrees, differs_by: Math.max(...compare!) } : {}),
  };
}

/** Timmy's readings, by file and bytes: a run judged twice (its receipt, then its notice) reads the file once. */
const READBACKS = new Map<string, StlReadResult>();
function readbackOnce(abs: string, rel: string, c: Classified): StlReadResult {
  const key = `${abs}\0${c.size}\0${c.mtimeMs}\0${c.sha256 ?? ''}`;
  const hit = READBACKS.get(key);
  if (hit) return hit;
  const r = readStlFile(abs, rel);
  READBACKS.set(key, r);
  if (READBACKS.size > 8) READBACKS.delete(READBACKS.keys().next().value as string);
  return r;
}

/** readback.json in the run's folder: the first judgement's reading, written once, never over another. */
function keepReadback(record: string | undefined, r: StlReadResult): void {
  if (!record) return;
  try { writeFileSync(path.join(record, 'readback.json'), `${JSON.stringify(r, null, 2)}\n`, { flag: 'wx' }); } catch { /* written by an earlier judgement, or the folder is gone */ }
}

/** One output path as a run's verdict and receipt carry it. */
export interface ScadOutputReport { path: string; present: boolean; change: OutputChange; made: boolean; sha256?: string; bytes?: number }
export interface ScadStepReport {
  name: string; attempt: number; exit_code: number | null; signal: string | null; error?: string; interrupted?: string;
  /** false when the runner recorded no end for it (it was under way when the record was last written) */
  ended?: false;
  stderr?: { file: string; sha256: string; bytes: number; truncated: boolean };
}

/** What a run left, beside the outcome. */
export interface ScadReadout {
  model: { path: string; sha256: string };
  /** the read-only copy OpenSCAD ran: still the submitted bytes, other bytes, or gone */
  copy: { path: string; state: 'intact' | 'changed' | 'gone' };
  /** the model at its own path is not the submitted bytes now; it did not change what ran */
  original_changed?: true;
  params: Record<string, ScadParam>;
  /** the -D arguments, exactly as given to OpenSCAD */
  defines: string[];
  params_file?: { path: string; sha256: string };
  /** OpenSCAD's own answer to --version */
  version?: string;
  /** runner.json: read, missing, unreadable, or another run's */
  runner: RunnerRead['state'];
  steps: ScadStepReport[];
  /** the export's messages */
  messages: ScadMessages;
  stl: ScadOutputReport;
  /** Timmy's own reading of the STL */
  readback?: StlReadback;
  /** why there is no reading (not there, too large, not an STL, …) */
  readback_error?: { kind: string; error: string };
  png?: ScadOutputReport & { size: [number, number]; why?: string; messages?: ScadMessages };
  /** OpenSCAD's own summary (its report, not Timmy's) */
  summary: {
    state: 'written' | 'not written' | 'refused' | 'not requested' | 'unknown';
    /** refused: OpenSCAD's line saying so */
    line?: string; path?: string; sha256?: string;
    bbox?: { min: Vec3; max: Vec3 };
    /** its bounding box against Timmy's reading, within float32's precision */
    agrees?: boolean; differs_by?: number;
  };
}
export interface ScadJudgement extends NativeJudgement { scad: ScadReadout }

const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);
interface ExitInfo { exit: NativeJudgement['exit']; live: boolean; clean: boolean; known: boolean; text: string; startedMs: number }

function exitOf(job: JobRecord): ExitInfo {
  const startedMs = Date.parse(job.startedAt);
  if (job.stale) {
    return { exit: { state: 'unknown', code: null, signal: null }, live: false, clean: false, known: false, text: `was left ${job.state} by an earlier session and its process is gone, with no exit status`, startedMs };
  }
  const text = job.error === 'timed out' ? 'timed out (its time limit stopped it)'
    : job.error && job.state === 'failed' ? `was stopped: ${job.error}`
      : job.state === 'cancelled' ? 'was stopped'
        : job.signal ? `ended by ${job.signal}`
          : typeof job.exitCode === 'number' ? `exited ${job.exitCode}`
            : job.error ? `did not run (${job.error})` : 'ended without an exit status';
  return {
    exit: { state: job.state, code: job.exitCode ?? null, signal: job.signal ?? null, ...(job.error ? { error: job.error } : {}) },
    live: LIVE.has(job.state), clean: job.state === 'completed' && job.exitCode === 0, known: true, text, startedMs,
  };
}

/** Appends the judgement to the run's verdicts.jsonl, unless its last line already says the same. */
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
      ...(j.source ? { source: j.source } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record */ }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function outputReport(rel: string, c: Classified, made: boolean): ScadOutputReport {
  return { path: rel, present: c.present, change: c.change, made, ...(c.sha256 ? { sha256: c.sha256 } : {}), ...(c.size !== undefined && c.present ? { bytes: c.size } : {}) };
}
function fileCheck(rel: string, c: Classified, made: boolean): NativeFileCheck {
  return { path: rel, present: c.present, written: made, change: c.change, ...(c.inventoried ? {} : { inventoried: false as const }), ...(c.sha256 ? { sha256: c.sha256 } : {}) };
}

/**
 * A finished OpenSCAD run, judged (the rules are in the module's header). The judgement is appended to the run's
 * verdicts.jsonl (once while it says the same) and the first reading of the STL is kept as readback.json; a job
 * still going is unknown and nothing is recorded.
 */
export function judgeScadJob(job: JobRecord, spec: ScadJobSpec): ScadJudgement {
  const s = spec.scad;
  const n = spec.native;
  const x = exitOf(job);
  const since = n.submittedMs ?? x.startedMs;
  const sinceMs = Number.isNaN(since) ? 0 : since;
  const runner = readRunner(s, n.run);
  const steps = runner.state === 'read' ? runner.data.steps : [];
  const last = (name: string): RunnerStep | undefined => [...steps].reverse().find((st) => st.name === name);
  const exp = last('export');
  const pngStep = last('png');
  const input = n.input ?? { path: s.model.rel, sha256: s.model.sha256 };
  const source: SourceCheck = checkSource(n.root, input, n.copy ?? { path: s.copy.rel, sha256: s.copy.sha256 }, undefined);
  const copyState = source.copy_state ?? 'gone';
  const stlC = classifyOutput(s.stl.path, stateBefore(s.stl.rel, n.pre, n.inventory), sinceMs);
  const stlMade = madeByRun(stlC, sinceMs);
  const result = !x.live && stlC.present ? readbackOnce(s.stl.path, s.stl.rel, stlC) : undefined;
  const readback = result?.ok ? result.readback : undefined;
  const messages = exp ? stepMessages(s, exp) : runner.state === 'read' ? scanMessages('', 'none') : (() => {
    const log = job.logPath ? readBounded(job.logPath) : undefined;
    return log ? scanMessages(log.text, 'job output', log.truncated) : scanMessages('', 'none');
  })();

  const exportKnown = runner.state === 'read' && !!exp && exp.ended_at !== undefined && !exp.interrupted;
  const exportClean = exportKnown && exp!.exit_code === 0 && !exp!.signal && !exp!.error;
  const exportText = exp ? `openscad ${stepWords(exp)}` : runner.state === 'read' ? 'openscad\'s export never ran' : `OpenSCAD's exit is not recorded (${runner.why})`;
  const tail = exportKnown ? exportText : `${exportText}; the job ${x.text}`;
  const firstError = messages.lines.find((l) => ERROR_KINDS.has(l.kind))?.text;
  const errWords = messages.errors ? `OpenSCAD reported ${plural(messages.errors, 'ERROR line')}${firstError ? ` (first: ${firstError})` : ''}` : '';

  // The preview: secondary to the STL, reported beside it and never deciding the outcome.
  let png: ScadReadout['png'];
  if (s.png) {
    const c = classifyOutput(s.png.path, stateBefore(s.png.rel, n.pre, n.inventory), sinceMs);
    const made = madeByRun(c, sinceMs);
    const pm = pngStep ? stepMessages(s, pngStep) : undefined;
    const exitedClean = pngStep?.exit_code === 0 && !pngStep.signal && !pngStep.interrupted;
    const why = made ? undefined
      : pngStep ? `openscad ${stepWords(pngStep)}${exitedClean ? `, but ${s.png.rel}: ${notWrittenWords(c)}` : ''}${pm?.errors ? `; ${pm.lines.find((l) => ERROR_KINDS.has(l.kind))?.text ?? ''}` : ''}`
        : runner.state === 'read' && runner.data.png?.state === 'skipped' ? 'skipped: the export did not exit 0' : 'the preview step did not run';
    png = { ...outputReport(s.png.rel, c, made), size: s.png.size, ...(why ? { why } : {}), ...(pm ? { messages: pm } : {}) };
  }
  const summary = summaryOf(s, runner, readback);

  let outcome: NativeJudgement['outcome'];
  let why: string;
  const wrote = `${s.stl.rel} was ${stlC.change} by this run`;
  if (x.live) { outcome = 'unknown'; why = `still ${x.exit.state}: it is judged when it ends`; }
  else if (copyState !== 'intact') {
    outcome = 'unknown';
    why = `the copy of ${s.model.rel} kept at submission (${s.copy.rel}) ${copyState === 'gone' ? 'is gone' : 'no longer holds the submitted bytes'}, so what ran cannot be shown to be what was submitted; ${tail}`;
  } else if (runner.state === 'not this run') {
    outcome = 'unknown';
    why = `${runner.why}, so the exits it records are not this run's; the job ${x.text}`;
  } else if (stlMade) {
    if (!exportKnown) { outcome = 'unknown'; why = `${wrote}, but ${tail}: whether OpenSCAD finished is not known`; }
    else if (!exportClean) { outcome = 'unknown'; why = `${wrote}, but ${exportText}${errWords ? `; ${errWords}` : ''}: the STL may not hold the whole model`; }
    else if (messages.errors) { outcome = 'unknown'; why = `${wrote} and openscad exited 0, but ${errWords}: the STL may not hold the whole model`; }
    else if (result && !result.ok && result.kind === 'malformed') { outcome = 'failed'; why = `${wrote} and openscad exited 0, but Timmy cannot read it as an STL: ${result.error}`; }
    else if (result && !result.ok && result.kind !== 'too large') { outcome = 'unknown'; why = `${wrote} and openscad exited 0, but Timmy could not read it back: ${result.error}`; }
    else {
      outcome = 'ok';
      why = [
        `${wrote} from ${s.model.rel} as submitted (OpenSCAD ran the read-only copy kept at submission; its sha256 was checked when it was made and again after the run)`,
        `openscad exited 0 with no ERROR line${messages.warnings ? ` and ${plural(messages.warnings, 'warning line')}` : ''}`,
        readback
          ? `Timmy's own reading: ${readback.format} STL, ${plural(readback.triangles, 'triangle')}, ${readback.manifold ? (readback.oriented ? 'edge-manifold' : 'edge-manifold but inconsistently oriented') : 'not edge-manifold'}`
          : `not read back by Timmy: ${result && !result.ok ? result.error : 'no reading'}`,
      ].join('; ');
    }
  } else if (stlC.present) {
    outcome = 'unknown';
    why = `${s.stl.rel}: ${notWrittenWords(stlC)}; ${tail}`;
  } else if (!exportKnown && !x.known) {
    outcome = 'unknown';
    why = `no STL was written, and ${tail}`;
  } else {
    outcome = 'failed';
    why = `no STL was written by this run: ${tail}${errWords ? `; ${errWords}` : ''}`;
  }
  if (!x.live) {
    if (png && outcome !== 'failed') why += png.made ? `; the preview ${png.path} was ${png.change} by this run` : `; no preview: ${png.why}`;
    if (summary.state === 'refused') why += '; this OpenSCAD refused the summary options, so the export ran again without them';
    if (source.original_changed && copyState === 'intact') why += `; ${s.model.rel} itself has changed since it was submitted, which did not change what ran`;
  }

  const readout: ScadReadout = {
    model: { path: s.model.rel, sha256: s.model.sha256 }, copy: { path: s.copy.rel, state: copyState },
    ...(source.original_changed ? { original_changed: true as const } : {}),
    params: s.params, defines: [...s.defines], ...(s.paramsFile ? { params_file: { ...s.paramsFile } } : {}),
    ...(() => { const v = versionOf(s, last('version')); return v ? { version: v } : {}; })(),
    runner: runner.state,
    steps: steps.map((st) => ({
      name: st.name, attempt: typeof st.attempt === 'number' ? st.attempt : 1, exit_code: st.exit_code ?? null, signal: st.signal ?? null,
      ...(st.ended_at === undefined ? { ended: false as const } : {}),
      ...(st.error ? { error: st.error } : {}), ...(st.interrupted ? { interrupted: st.interrupted } : {}),
      ...(st.stderr ? { stderr: { file: `${s.runner.logs.rel}/${path.basename(st.stderr.file)}`, sha256: st.stderr.sha256, bytes: st.stderr.bytes, truncated: Boolean(st.stderr.truncated) } } : {}),
    })),
    messages, stl: outputReport(s.stl.rel, stlC, stlMade),
    ...(readback ? { readback } : result && !result.ok ? { readback_error: { kind: result.kind, error: result.error } } : {}),
    ...(png ? { png } : {}), summary,
  };
  const files = [fileCheck(s.stl.rel, stlC, stlMade), ...(png && s.png ? [{ path: png.path, present: png.present, written: png.made, change: png.change, ...(png.sha256 ? { sha256: png.sha256 } : {}) }] : [])];
  const j: ScadJudgement = { outcome, why, exit: x.exit, files, run: n.run, input: { ...input }, source, scad: readout };
  if (!x.live) {
    appendVerdict(n.record, j, job.id);
    if (result) keepReadback(n.record, result);
  }
  return j;
}

// ── receipts ─────────────────────────────────────────────────────────────────────

/** Text bound for a receipt: the project folder written as ".", the home folder as "~". */
export function scrubPaths(text: string, root: string): string {
  let out = text;
  const roots = [root];
  try { roots.push(realpathSync(root)); } catch { /* gone */ }
  for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) if (r.length > 1) out = out.split(r).join('.');
  const home = homedir();
  if (home.length > 1) out = out.split(home).join('~');
  return out;
}

/**
 * A judgement as a receipt carries it: the native fields (app openscad, the outcome, why, the exit, the files, the
 * run and the model it was bound to) and this run's own: the parameters and -D arguments, each step's exit, the
 * error and warning lines (the first 20), the STL and preview, Timmy's reading of the STL with DOCTRINE §15's tags
 * and sentence, and OpenSCAD's summary state. Project-relative names only; free text with the project folder
 * written as "." and the home folder as "~".
 */
export function scadReceiptFields(j: ScadJudgement, root: string): ReturnType<typeof nativeReceiptFields> & { native: { scad: Record<string, unknown> } } {
  const base = nativeReceiptFields('openscad', j);
  const clean = (t: string): string => scrubPaths(t, root);
  const r = j.scad;
  const params = Object.fromEntries(Object.entries(r.params).map(([k, p]) => [k, { value: typeof p.value === 'string' ? clean(p.value) : p.value, from: p.from }]));
  const lines = (m: ScadMessages, max: number) => ({
    from: m.from, errors: m.errors, warnings: m.warnings, echo: m.echo, trace: m.trace,
    lines: m.lines.slice(0, max).map((l) => ({ kind: l.kind, text: clean(l.text), ...(l.cut ? { cut: true } : {}) })),
    ...(m.lines.length > max || m.more ? { more: m.lines.length - Math.min(max, m.lines.length) + (m.more ?? 0) } : {}),
    ...(m.truncated ? { truncated: true } : {}),
  });
  return {
    ...base,
    native: {
      ...base.native, why: clean(base.native.why),
      scad: {
        model: { ...r.model }, copy: { ...r.copy }, ...(r.original_changed ? { original_changed: true } : {}),
        params, defines: r.defines.map(clean), ...(r.params_file ? { params_file: { ...r.params_file } } : {}),
        ...(r.version ? { openscad_version: clean(r.version) } : {}),
        runner: r.runner,
        steps: r.steps.map((st) => ({
          name: st.name, attempt: st.attempt, exit_code: st.exit_code, signal: st.signal, ...(st.error ? { error: clean(st.error) } : {}),
          ...(st.interrupted ? { interrupted: st.interrupted } : {}), ...(st.stderr ? { stderr_sha256: st.stderr.sha256, stderr_bytes: st.stderr.bytes } : {}),
        })),
        messages: lines(r.messages, 20),
        stl: { ...r.stl },
        ...(r.png ? { png: { path: r.png.path, present: r.png.present, change: r.png.change, made: r.png.made, size: r.png.size, ...(r.png.sha256 ? { sha256: r.png.sha256 } : {}), ...(r.png.why ? { why: clean(r.png.why) } : {}) } } : {}),
        readback: r.readback ? { ...r.readback } : { status: 'not measured', ...(r.readback_error ? { kind: r.readback_error.kind, error: clean(r.readback_error.error) } : {}) },
        summary: { ...r.summary, ...(r.summary.line ? { line: clean(r.summary.line) } : {}) },
      },
    },
  };
}

// ── after a restart ──────────────────────────────────────────────────────────────

/** A run's spec rebuilt from its folder (job.json and scad.json), every name in them checked to lead inside the project. */
export function scadSpecFromRecord(root: string, run: string): ScadJobSpec {
  const base = realRoot(root);
  const rec = readNativeRecord(base, run);
  if (!rec || rec.job.app !== 'openscad') throw new Error(`no record of an OpenSCAD run ${run} in this project`);
  let s: ScadRunRecord;
  try { s = JSON.parse(readFileSync(path.join(rec.dir, 'scad.json'), 'utf8')) as ScadRunRecord; } catch { throw new Error(`the record of run ${run} has no readable OpenSCAD part (scad.json)`); }
  if (!s || s.record !== 'timmy-scad-run' || s.run !== run) throw new Error(`the record of run ${run} has no OpenSCAD part (scad.json)`);
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  const j = rec.job;
  const expect = Array.isArray(j.expect) ? j.expect.filter((e): e is string => typeof e === 'string') : [];
  for (const e of expect) within(e);
  const scad: ScadRunMeta = {
    model: { path: within(s.model.path), rel: s.model.path, sha256: s.model.sha256, bytes: s.model.bytes },
    copy: { path: within(s.copy.path), rel: s.copy.path, sha256: s.copy.sha256 },
    params: s.params ?? {}, defines: Array.isArray(s.defines) ? s.defines : [], ...(s.params_file ? { paramsFile: s.params_file } : {}),
    out: { path: within(s.out), rel: s.out }, stl: { path: within(s.stl), rel: s.stl },
    ...(s.png ? { png: { path: within(s.png.path), rel: s.png.path, size: s.png.size } } : {}),
    summary: { path: within(s.summary), rel: s.summary },
    runner: {
      worker: s.runner.worker, sha256: s.runner.sha256, config: { path: within(s.runner.config), rel: s.runner.config, sha256: s.runner.config_sha256 },
      record: { path: within(s.runner.record), rel: s.runner.record }, logs: { path: within(s.runner.logs), rel: s.runner.logs },
    },
    program: s.program, openscadPath: Array.isArray(s.openscadpath) ? s.openscadpath.slice(0, 1) : [], notes: Array.isArray(s.notes) ? s.notes : [],
  };
  const native: NativeMeta = {
    app: 'openscad', root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: Date.parse(j.started_at),
    ...(j.input ? { input: j.input } : {}), ...(j.copy ? { copy: j.copy } : {}),
  };
  return { kind: 'task', label: j.label, project: j.project, root: base, command: j.program, args: j.args, timeoutMs: j.timeout_ms, native, scad };
}

/**
 * Judges an OpenSCAD run again from its folder after a restart: with the job's record when the caller has it
 * (`job`, or `findJob` given the id its started.json names), else as a job whose exit was not recorded. The
 * runner's own record (runner.json) still says how each OpenSCAD step ended.
 */
export function reconcileScad(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): ScadJudgement {
  const spec = scadSpecFromRecord(root, run);
  const rec = readNativeRecord(spec.root, run);
  const found = opts.job ?? (rec?.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const job: JobRecord = found ?? {
    id: rec?.started?.job ?? 'j000000', kind: 'task', label: spec.label, project: spec.project, root: spec.root, command: spec.command, args: spec.args,
    state: 'running', startedAt: rec?.job.started_at ?? new Date(0).toISOString(), steps: [], logPath: '', lines: 0, stale: true,
  };
  return judgeScadJob(job, spec);
}

// ── what the REPL and the agent are told ─────────────────────────────────────────

const quoteArg = (s: string): string => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');
const bytesWords = (n: number | undefined): string => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Said before the run: what runs, on what, with which parameters, how includes resolve and what it saves. */
export function scadStartLines(spec: ScadJobSpec, sep: string): Line[] {
  const s = spec.scad;
  const label = (w: string): Segment => ({ text: `  ${w.padEnd(11)}`, role: 'secondary' });
  const where = s.program.how === 'env' ? 'at TIMMY_OPENSCAD' : s.program.how === 'path' ? `on PATH (${s.program.path})` : s.program.path;
  const params = Object.entries(s.params);
  const folder = path.posix.dirname(s.model.rel);
  return [
    [label('App'), { text: `OpenSCAD ${where}: headless, no window; Timmy's runner (${SCAD_RUNNER}) runs it and records each step`, role: 'estimate' }],
    [label('Model'), { text: `${s.model.rel}${sep}sha256 ${short(s.model.sha256)}${sep}OpenSCAD runs a read-only copy kept at ${s.copy.rel}` }],
    [label('Params'), { text: params.length
      ? params.map(([k, p]) => `${k}=${scadLiteral(p.value)}${p.from === 'file' ? ` (${s.paramsFile?.path ?? 'file'})` : ''}`).join(sep)
      : `none: the model's own values${s.paramsFile ? '' : ` (no ${paramsFileFor(s.model.rel)})`}` }],
    [label('Includes'), { text: `use <…> and include <…> resolve beside ${s.model.rel}: ${folder === '.' ? 'the project folder' : folder} is first on OPENSCADPATH`, role: 'secondary' }],
    ...s.notes.map((n): Line => [label('Note'), { text: n, role: 'estimate' }]),
    [label('Saves'), { text: `${s.stl.rel} (binary STL)${s.png ? `${sep}${s.png.rel} (a ${s.png.size[0]}x${s.png.size[1]} preview)` : ''}${sep}then Timmy reads the STL back itself` }],
  ];
}

/** The next steps after a good run: open the preview (or the STL), and run again with a parameter changed. */
export function scadNextSteps(j: ScadJudgement, spec: ScadJobSpec): string[] {
  if (j.outcome !== 'ok') return [];
  const s = spec.scad;
  const steps = [`/open ${quoteArg(s.png && j.scad.png?.made ? s.png.rel : s.stl.rel)}`];
  const first = Object.entries(s.params)[0];
  const file = paramsFileFor(s.model.rel);
  const keep = s.paramsFile ? `a word overrides ${file}` : `or keep the values in ${file}`;
  steps.push(first
    ? `/scad ${quoteArg(s.model.rel)} ${first[0]}=${typeof first[1].value === 'string' ? `"${first[1].value.replace(/"/g, '')}"` : String(first[1].value)}   runs it again with a value changed (${keep})`
    : `/scad ${quoteArg(s.model.rel)} name=value   runs it again with a parameter set (${keep})`);
  return steps;
}

/** Said when the run ends: the outcome, the STL with Timmy's sha256, Timmy's reading with DOCTRINE §15, OpenSCAD's lines. */
export function scadEndLines(j: ScadJudgement, spec: ScadJobSpec, o: { id: string; label: string; glyphs: { ok: string; fail: string; sep?: string }; sep: string; scrub: (s: string) => string; receipt?: string }): Line[] {
  const r = j.scad;
  const S = o.sep;
  const mark = j.outcome === 'ok' ? o.glyphs.ok : j.outcome === 'failed' ? o.glyphs.fail : '?';
  const head = (word: string): Segment => ({ text: `      ${word.padEnd(9)}`, role: 'secondary' });
  const lines: Line[] = [[
    { text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined },
    { text: `${o.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' },
    { text: `  ${o.label}: ${o.scrub(j.why)}${o.receipt ? `${S}receipt ${o.receipt}` : ''}${S}/results`, role: 'secondary' },
  ]];
  const st = r.stl;
  lines.push([head('stl'), {
    text: `${st.path}${S}${st.made ? `${st.change} by this run` : st.present ? 'not made by this run' : 'not there'}${st.present ? `${S}sha256 ${short(st.sha256)} (Timmy's, after the run)${st.bytes !== undefined ? `${S}${bytesWords(st.bytes)}` : ''}` : ''}`,
    role: st.made ? undefined : 'failure',
  }]);
  const m = r.readback;
  if (m) {
    lines.push([head('mesh'), { text: `${m.format} STL${S}${plural(m.triangles, 'triangle')}${S}${plural(m.corners, 'corner')}${S}${topologyWords(m)}`, role: m.manifold ? undefined : 'estimate' }]);
    if (m.bbox) {
      lines.push([head('size'), { text: `${num(m.bbox.size[0])} × ${num(m.bbox.size[1])} × ${num(m.bbox.size[2])} (x × y × z in the file's units: STL records none; OpenSCAD models are millimetres by convention)${S}from (${m.bbox.min.map(num).join(', ')}) to (${m.bbox.max.map(num).join(', ')})` }]);
      lines.push([head('volume'), { text: `${volumeWords(m)}${S}surface area ${num(m.area)}` }]);
    }
    lines.push([head('measured'), { text: `by Timmy's own reading of the exported STL (its own TypeScript, independent of OpenSCAD's engine)${S}provenance generated${S}evidence checked`, role: 'secondary' }]);
    lines.push([head('notice'), { text: DOCTRINE_15, role: 'estimate' }]);
  } else if (r.readback_error) {
    lines.push([head('readback'), { text: `not measured: ${o.scrub(r.readback_error.error)}`, role: r.readback_error.kind === 'too large' ? 'estimate' : 'failure' }]);
  }
  const exp = [...r.steps].reverse().find((x) => x.name === 'export');
  const counts = `${plural(r.messages.errors, 'ERROR line')}, ${plural(r.messages.warnings, 'warning line')}${r.messages.echo ? `, ${r.messages.echo} ECHO` : ''}`;
  lines.push([head('openscad'), {
    text: `${r.version ? `OpenSCAD ${o.scrub(r.version)}` : 'its version was not reported'}${S}${exp ? `export ${reportWords(exp)}` : 'no export recorded'}${S}${counts}${r.messages.from === 'job output' ? ' (read from the job\'s combined output: the runner\'s record is missing)' : ''}`,
    role: r.messages.errors ? 'failure' : 'secondary',
  }]);
  const shown = r.messages.lines.slice(0, 8);
  for (const l of shown) lines.push([{ text: `        ${o.glyphs.sep ?? '|'} `, role: 'secondary' }, { text: o.scrub(l.text), role: ERROR_KINDS.has(l.kind) ? 'failure' : 'estimate' }]);
  const hidden = r.messages.lines.length - shown.length + (r.messages.more ?? 0);
  if (hidden > 0) lines.push([head(''), { text: `${hidden} more such line${hidden === 1 ? '' : 's'}: ${exp?.stderr?.file ?? r.steps.at(-1)?.stderr?.file ?? 'the job\'s output'}`, role: 'secondary' }]);
  if (r.summary.state === 'refused') {
    lines.push([head('summary'), { text: `this OpenSCAD refused --summary (${o.scrub(r.summary.line ?? 'its line was not kept')}), so the export ran again without it`, role: 'estimate' }]);
  } else if (r.summary.state === 'written') {
    const bbox = r.summary.bbox ? `${S}its bounding box ${r.summary.agrees ? 'agrees with' : 'differs from'} Timmy's reading${r.summary.agrees || r.summary.differs_by === undefined ? '' : ` (by up to ${num(r.summary.differs_by)})`}` : '';
    lines.push([head('summary'), { text: `${r.summary.path}${S}OpenSCAD's own report, not Timmy's${bbox}`, role: 'secondary' }]);
  } else if (r.summary.state === 'not written' && st.made) {
    lines.push([head('summary'), { text: 'OpenSCAD accepted --summary but wrote no summary file', role: 'secondary' }]);
  }
  if (r.png) {
    lines.push([head('png'), { text: `${r.png.path}${S}${r.png.made ? `${r.png.change} by this run${S}${r.png.size.join('x')}` : `not made: ${o.scrub(r.png.why ?? 'not run')}`}`, role: r.png.made ? undefined : 'failure' }]);
  }
  if (j.outcome !== 'ok') {
    lines.push([head('look'), { text: `${exp?.stderr?.file ?? spec.scad.runner.logs.rel}${S}/jobs ${o.id} for the raw output`, role: 'secondary' }]);
  } else {
    for (const step of scadNextSteps(j, spec)) lines.push([head('next'), { text: step }]);
  }
  return lines;
}

/** The agent's note on a started run. */
export function scadToolNote(spec: ScadJobSpec, jobId: string): string {
  const s = spec.scad;
  return [
    `Started, not finished: OpenSCAD runs headless on a read-only copy of ${s.model.rel}${s.defines.length ? ` with ${s.defines.map((d) => `-D ${d}`).join(' ')}` : ''}, exporting ${s.stl.rel}${s.png ? ` and the preview ${s.png.rel}` : ''}; /jobs ${jobId} follows it.`,
    'It is judged when it ends: openscad\'s exit, the STL created by this run, OpenSCAD\'s ERROR lines (kept verbatim with its warning lines), and Timmy\'s own reading of the STL (triangles, bounding box, signed volume, surface area, manifold edges).',
    `Do not claim the STL or its dimensions until it is judged ok. ${DOCTRINE_15}`,
  ].join(' ');
}
