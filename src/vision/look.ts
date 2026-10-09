/**
 * Look (round R2, look): runs workers/look/look.py, Timmy's OpenCV worker, on one project image and reads
 * back its structured observation — deterministic computations on the pixels (tier "deterministic
 * computation"), never a claim about what the image shows. Any agent, a text-only one included, can use
 * the numbers.
 *
 * The Python is explicit configuration first, as for the vision integrations (registry.ts): an absolute
 * TIMMY_VISION_PYTHON, else an absolute TIMMY_VISUAL_PYTHON, else `python3` on the PATH. Whether it can
 * import cv2 is checked by running it; a success is remembered. An observation is written into the project
 * as an editable file, results/observations/<stem>-<YYYYMMDD-HHMMSS>.json, with paths relative to the
 * project only.
 */
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProjectFile } from '../project/index.js';
import { spawnProcess } from '../runtime/spawn-runtime.js';

export const DETERMINISTIC = 'deterministic computation';
export const INTERPRETATION = 'model interpretation';
export const OBSERVATIONS_DIR = 'results/observations';
/** How long one Look may run, and how much it may print, unless told otherwise. */
export const LOOK_TIMEOUT_MS = 60_000;
export const LOOK_MAX_OUTPUT = 256 * 1024;
/** The largest file Look reads (workers/look/look.py MAX_BYTES). */
export const LOOK_MAX_IMAGE = 64 * 1024 * 1024;

/** workers/look/look.py stays at the package root for both the src and the dist/src layouts. */
function packaged(rel: string): string {
  const candidates = ['../../', '../../../'].map((prefix) => fileURLToPath(new URL(`${prefix}${rel}`, import.meta.url)));
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}
export const LOOK_SCRIPT = packaged('workers/look/look.py');

export interface Measurement { name: string; value: unknown; unit: string; tier: typeof DETERMINISTIC; note: string }
export interface LookObservation {
  ok: true;
  worker: { name: 'timmy-look'; version: string };
  opencv: string;
  python: string;
  source: { path: string; sha256: string; bytes: number };
  image: { width: number; height: number; channels: number };
  measurements: Measurement[];
  uncertainty: string[];
}
export type LookOutcome = { ok: true; observation: LookObservation } | { ok: false; error: string; code?: string };

/** Searches the PATH for an executable (the REPL passes its own onPath). */
function searchPath(cmd: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

export type PythonChoice = { python: string; from: 'TIMMY_VISION_PYTHON' | 'TIMMY_VISUAL_PYTHON' | 'PATH' } | { error: string };

/** The interpreter Look runs with: explicit configuration first, then python3 on the PATH. */
export function lookPython(env: NodeJS.ProcessEnv = process.env, onPath?: (cmd: string) => string | null): PythonChoice {
  for (const key of ['TIMMY_VISION_PYTHON', 'TIMMY_VISUAL_PYTHON'] as const) {
    const v = env[key];
    if (v) return isAbsolute(v) ? { python: v, from: key } : { error: `${key} must be an absolute interpreter path` };
  }
  const found = onPath ? onPath('python3') : searchPath('python3', env);
  return found ? { python: found, from: 'PATH' } : { error: 'no python3 on the PATH (or set TIMMY_VISION_PYTHON to one with OpenCV)' };
}

export const OPENCV_SETUP = 'python3 -m pip install opencv-python-headless numpy';

/**
 * R2 (the Mac run): Python finds packages a user installed with pip --user under HOME. A Timmy run with a
 * separate HOME (a sandbox) hides them, so OpenCV looked missing; TIMMY_NATIVE_HOME, when set, is the home
 * local runtimes use (the same setting native apps use for their licenses).
 */
export function lookEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return env.TIMMY_NATIVE_HOME ? { ...env, HOME: env.TIMMY_NATIVE_HOME } : env;
}
const checks = new Map<string, Promise<{ ok: true; opencv: string } | { ok: false; error: string }>>();

/** Whether this Python imports cv2 and numpy, by running it: a success is remembered per interpreter. */
export function checkOpenCv(python: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; opencv: string } | { ok: false; error: string }> {
  const known = checks.get(python);
  if (known) return known;
  const run = spawnProcess(python, ['-c', 'import cv2, numpy; print(cv2.__version__)'], { env, timeoutMs: 30_000, maxBuffer: 64 * 1024 }).outcome.then((o) => {
    if (o.status === 0) {
      const version = o.stdout.trim().split('\n').at(-1) ?? '';
      return version ? { ok: true as const, opencv: version } : { ok: false as const, error: 'the import check printed no OpenCV version' };
    }
    const why = o.error ? `it could not run (${o.error.replace(python, 'the interpreter')})` : o.timedOut ? 'the import check timed out' : 'cv2 or numpy is not importable';
    // A failure is not remembered: once the operator installs OpenCV, the next /observe finds it.
    checks.delete(python);
    return { ok: false as const, error: `OpenCV is not available to this Python: ${why}` };
  });
  checks.set(python, run);
  return run;
}

/** Forgets the import checks (tests; or after the operator installs OpenCV). */
export function resetLookChecks(): void { checks.clear(); }

/** The arguments a Look run takes: the script, the image's real path, and the name to report it by. */
export const lookArgs = (imagePath: string, rel: string): string[] => [LOOK_SCRIPT, imagePath, '--as', rel];

/** Reads Look's answer: the last line of its output that is a Look observation (or its error). */
export function parseLookOutput(text: string, rel: string): LookOutcome {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const worker = o.worker as { name?: unknown } | undefined;
    if (o.ok === false && o.error && typeof o.error === 'object') {
      const e = o.error as { code?: unknown; message?: unknown };
      return { ok: false, error: typeof e.message === 'string' ? e.message : 'Look failed', ...(typeof e.code === 'string' ? { code: e.code } : {}) };
    }
    if (o.ok !== true || worker?.name !== 'timmy-look') continue;
    const source = o.source as { sha256?: unknown; bytes?: unknown } | undefined;
    const measurements = o.measurements;
    if (typeof source?.sha256 !== 'string' || !Array.isArray(measurements) || !Array.isArray(o.uncertainty)) return { ok: false, error: "Look's answer is missing its source, measurements or uncertainty" };
    // A measurement is a deterministic computation, or it is not taken: the worker cannot claim another tier.
    if (measurements.some((m) => !m || typeof m !== 'object' || (m as { tier?: unknown }).tier !== DETERMINISTIC)) return { ok: false, error: `a Look measurement is not marked "${DETERMINISTIC}"` };
    const observation = o as unknown as LookObservation;
    // The source is named by its place in the project only.
    observation.source = { path: rel, sha256: source.sha256, bytes: typeof source.bytes === 'number' ? source.bytes : 0 };
    return { ok: true, observation };
  }
  return { ok: false, error: "Look's output could not be read" };
}

/** Runs Look directly (no job): with a time limit and a cap on what it may print. */
export async function runLook(o: { python: string; imagePath: string; rel: string; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv }): Promise<LookOutcome> {
  const { outcome } = spawnProcess(o.python, lookArgs(o.imagePath, o.rel), { env: o.env ?? process.env, timeoutMs: o.timeoutMs ?? LOOK_TIMEOUT_MS, maxBuffer: o.maxBytes ?? LOOK_MAX_OUTPUT, detached: true });
  const r = await outcome;
  if (r.timedOut) return { ok: false, error: `Look did not finish within ${Math.round((o.timeoutMs ?? LOOK_TIMEOUT_MS) / 1000)} s` };
  if (r.error && r.status === null) return { ok: false, error: r.error.includes('maxBuffer') ? 'Look printed more than it may' : 'Look could not start' };
  return parseLookOutput(r.stdout, o.rel);
}

const stamp = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

/** results/observations/<stem>-<YYYYMMDD-HHMMSS>.json (UTC); the stem keeps letters, digits, dot, dash, underscore. */
export function observationPath(rel: string, now: Date, n = 1): string {
  const base = posix.basename(rel.split('\\').join('/'));
  const stem = (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'image';
  return `${OBSERVATIONS_DIR}/${stem}-${stamp(now)}${n > 1 ? `-${n}` : ''}.json`;
}

/** Writes an observation record into the project, never over another one. */
export function writeObservation(root: string, rel: string, record: unknown, now: Date): { ok: true; path: string; sha256: string; bytes: number } | { ok: false; error: string } {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  for (let n = 1; n < 100; n++) {
    const path = observationPath(rel, now, n);
    if (existsSync(join(root, path))) continue;
    const w = writeProjectFile(root, path, body);
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, path: w.rel, sha256: w.sha256, bytes: w.bytes };
  }
  return { ok: false, error: 'no free name in results/observations/' };
}
