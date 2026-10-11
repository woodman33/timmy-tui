/**
 * Timmy VoxVision (round R4, helper H70): a STEP record's input as a mesh Rerun's viewer reads. Rerun has no STEP
 * loader, so `/vox view` has OCP tessellate the STEP (workers/readback/step_tessellate.py, run with the Python /inspect
 * reads a STEP with: TIMMY_CADQUERY_PYTHON) into a binary STL kept in the record's own folder
 * (results/vox/<id>/tessellation[-a|-b].stl), with its sha256 and the tessellation's tolerance said, and gives Rerun that
 * file. Its words say what it is: a tessellation of the STEP within that tolerance, not the STEP itself.
 *
 *   - The worker runs as a Timmy job (an id, /jobs, its log kept beside the record in .timmy/vox/<id>/) and meshes the
 *     exact bytes the record names (it reports their sha256). It never replaces a file; Timmy names a free one.
 *   - Timmy checks what it wrote before anything is passed: the sha256 and size are the ones reported, Timmy's own STL
 *     reader reads it with the same number of triangles, and its bounding box is within twice the linear deflection of
 *     OCP's box of the STEP as the record measured it (when the record has one). A file that fails a check is moved to
 *     the record's private folder (.timmy/vox/<id>/), kept as written, and not passed.
 *   - A tessellation an earlier view made of the same bytes at the same tolerance, whose file is still those bytes, is
 *     used again (nothing runs), and checked again the same way.
 *   - Without that Python: needs setup, with its step.
 */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { readStlFile } from '../native/stl-readback.js';
import { resolveInside } from '../project/index.js';
import { hashFile } from '../project/intake.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';
import { headBytes } from './kinds.js';
import { num, voxHighlightDir, voxRawDir, type VoxDerived } from './record.js';
import { SETUP, stepReady, type Readiness, type ToolEnv } from './tools.js';

function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? path.join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
/** The worker, at the package root (as the STEP readback is found). */
export const TESSELLATE_SCRIPT = packaged('workers/readback/step_tessellate.py');
/**
 * The tessellation's tolerance, in one place: BRepMesh's absolute linear deflection (the most a triangle strays from the
 * surface, in millimetres) and its angular deflection (radians). Fine enough to see a part's shape; never a measurement.
 */
export const TESSELLATION = { linear_deflection_mm: 0.1, angular_deflection_rad: 0.5 } as const;
/** Its time limit as a job, and the most it may print (one JSON line). */
export const TESSELLATE_TIMEOUT_MS = 120_000;
export const TESSELLATE_MAX_OUTPUT = 64 * 1024;
/** Slack for float32 coordinates in an STL (a 1 m part's last bit is about 0.06 µm): far below any deflection used. */
const FLOAT32_SLACK_MM = 1e-3;

/** What the worker reported for a mesh it wrote. */
export interface TessellationRead {
  ok: true;
  worker: { name: string; version: string };
  engine?: Record<string, unknown>;
  source: { name: string; sha256: string; bytes: number };
  unit_in_effect?: string | null;
  tessellation: { method: string; linear_deflection_mm: number; angular_deflection_rad: number; relative: false; triangles: number };
  output: { file: string; format: 'stl-binary' | 'stl-ascii'; sha256: string; bytes: number; triangles: number; writer?: string };
}
export interface TessellationFailure { ok: false; worker?: { name: string; version: string }; code: string; error: string }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 1;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);

/**
 * The worker's output (stdout and stderr as the job logged them): its one JSON line is the last line that parses as an
 * object naming a worker. A success must carry every value it claims; anything less is a failure with the reason.
 */
export function parseTessellation(output: string): TessellationRead | TessellationFailure {
  let found: Record<string, unknown> | undefined;
  for (const line of output.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = objOf(JSON.parse(t));
      if (o && objOf(o.worker) && typeof o.ok === 'boolean') { found = o; break; }
    } catch { /* not the worker's line */ }
  }
  if (!found) return { ok: false, code: 'no-output', error: output.trim() ? 'the worker printed no result line (its output is kept in the log)' : 'the worker printed nothing' };
  const w = objOf(found.worker)!;
  const worker = text(w.name) && text(w.version) ? { name: w.name, version: w.version } : undefined;
  if (!worker) return { ok: false, code: 'malformed', error: 'the result line names no worker version' };
  if (found.ok !== true) {
    const e = objOf(found.error);
    return { ok: false, worker, code: text(e?.code) ? e!.code as string : 'failed', error: text(e?.message) ? (e!.message as string).slice(0, 400) : 'the worker reported a failure without a message' };
  }
  const src = objOf(found.source);
  const t = objOf(found.tessellation);
  const o = objOf(found.output);
  if (!src || !hex64(src.sha256) || !finite(src.bytes)) return { ok: false, worker, code: 'malformed', error: 'the result line has no sha256 of the STEP it read' };
  if (found.units !== 'mm') return { ok: false, worker, code: 'malformed', error: `the result line's units are ${String(found.units)}, not mm` };
  if (!t || !finite(t.linear_deflection_mm) || !finite(t.angular_deflection_rad) || t.relative !== false || !count(t.triangles)) return { ok: false, worker, code: 'malformed', error: 'the result line does not say the tessellation\'s tolerance and triangles' };
  if (!o || !text(o.file) || !hex64(o.sha256) || !count(o.bytes) || !count(o.triangles) || (o.format !== 'stl-binary' && o.format !== 'stl-ascii')) return { ok: false, worker, code: 'malformed', error: 'the result line does not name the STL it wrote with its sha256, size and triangles' };
  return {
    ok: true, worker, ...(objOf(found.engine) ? { engine: objOf(found.engine) } : {}),
    source: { name: text(src.name) ? src.name : '', sha256: src.sha256, bytes: src.bytes },
    ...(found.unit_in_effect === null || text(found.unit_in_effect) ? { unit_in_effect: found.unit_in_effect as string | null } : {}),
    tessellation: { method: text(t.method) ? t.method : 'OpenCascade BRepMesh_IncrementalMesh', linear_deflection_mm: t.linear_deflection_mm, angular_deflection_rad: t.angular_deflection_rad, relative: false, triangles: t.triangles },
    output: { file: o.file, format: o.format, sha256: o.sha256, bytes: o.bytes, triangles: o.triangles, ...(text(o.writer) ? { writer: o.writer } : {}) },
  };
}

/** A STEP input of a record, as /vox view tessellates it: its path, the sha256 the record names, its role, OCP's box of it. */
export interface StepInput { path: string; sha256: string; abs: string; role?: 'a' | 'b'; box?: [number, number, number] | null }

/** OCP's box of a STEP input as the record measured it (bbox_size in mm), or null. */
export function stepBoxOf(metrics: ReadonlyArray<{ name: string; value: unknown; unit?: string; of?: string; malformed?: boolean }>, role?: 'a' | 'b'): [number, number, number] | null {
  const m = metrics.find((x) => !x.malformed && x.name === 'bbox_size' && (role ? x.of === role : !x.of) && typeof x.unit === 'string' && x.unit.startsWith('mm'));
  return m && triple(m.value) ? [m.value[0], m.value[1], m.value[2]] : null;
}

/** Whether a STEP can be tessellated here: TIMMY_CADQUERY_PYTHON (as for /inspect) and the worker. */
export function tessellationReady(t: ToolEnv): Readiness {
  const r = stepReady(t);
  if (!r.ready) return r;
  try { if (!statSync(TESSELLATE_SCRIPT).isFile()) throw new Error('not a file'); } catch {
    return { ready: false, why: 'the STEP tessellation worker (workers/readback/step_tessellate.py) is missing from this Timmy', setup: SETUP.worker };
  }
  return r;
}

const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

/** A free name for a tessellation in the record's own folder (never one that is there, link or not), or null. */
export function freeTessellationPath(root: string, id: string, role?: 'a' | 'b'): { rel: string; abs: string } | null {
  const stem = `tessellation${role ? `-${role}` : ''}`;
  for (let n = 1; n <= 99; n++) {
    const rel = `${voxHighlightDir(id)}/${stem}${n === 1 ? '' : `-${n}`}.stl`;
    const at = resolveInside(root, rel);
    if ('error' in at) return null;
    if (!exists(at.path) && !exists(path.join(path.dirname(at.path), `.${path.basename(at.path)}.part`))) return { rel: at.rel, abs: at.path };
  }
  return null;
}

const tolWords = (t: VoxDerived['tolerance']): string => `${num(t.linear_deflection_mm)} mm (linear deflection) and ${num(t.angular_deflection_rad)} rad (angular)`;
const boxText = (b: readonly number[]): string => `${b.map(num).join(' × ')} mm`;

/**
 * Timmy's own check of a mesh file before it is passed: its bytes now are the reported ones, Timmy's STL reader reads it
 * with that many triangles, and its box is within twice the linear deflection of OCP's box of the STEP (when known).
 */
export function checkMesh(o: { root: string; rel: string; sha256: string; bytes?: number; triangles: number; tolerance: VoxDerived['tolerance']; stepBox?: [number, number, number] | null }):
  { ok: true; check: VoxDerived['check']; head: Buffer; bytes: number } | { ok: false; why: string } {
  const at = resolveInside(o.root, o.rel);
  if ('error' in at) return { ok: false, why: at.error };
  let now: string;
  try { now = hashFile(at.path); } catch { return { ok: false, why: `${o.rel} cannot be read` }; }
  if (now !== o.sha256) return { ok: false, why: `${o.rel} is not the bytes reported (sha256 ${now.slice(0, 12)} now, ${o.sha256.slice(0, 12)} reported)` };
  const read = readStlFile(at.path, o.rel);
  if (!read.ok) return { ok: false, why: `Timmy's STL reader did not read ${o.rel}: ${read.kind}: ${read.error}` };
  const r = read.readback;
  if (o.bytes !== undefined && r.bytes !== o.bytes) return { ok: false, why: `${o.rel} is ${r.bytes} bytes, not the ${o.bytes} reported` };
  if (r.sha256 !== o.sha256) return { ok: false, why: `${o.rel} changed while Timmy read it` };
  if (r.triangles !== o.triangles) return { ok: false, why: `Timmy's STL reader counts ${r.triangles} triangles in ${o.rel}, not the ${o.triangles} reported` };
  if (!r.triangles || !r.bbox) return { ok: false, why: `${o.rel} holds no triangles` };
  const box: [number, number, number] = [r.bbox.size[0], r.bbox.size[1], r.bbox.size[2]];
  const check: VoxDerived['check'] = { by: `${r.measured_by} (Timmy's own STL reader)`, triangles: r.triangles, box };
  if (o.stepBox) {
    const within = 2 * o.tolerance.linear_deflection_mm + FLOAT32_SLACK_MM;
    const most = Math.max(...box.map((x, i) => Math.abs(x - o.stepBox![i])));
    if (!(most <= within)) return { ok: false, why: `its box (${boxText(box)}) is ${num(most)} mm from OCP's box of the STEP (${boxText(o.stepBox)}), more than ${num(within)} mm (twice the linear deflection): it does not show that STEP` };
    check.against = { box: o.stepBox, within_mm: within, max_difference_mm: most };
  } else check.note = "the record has no box of the STEP in millimetres, so the mesh's box was not compared with it";
  return { ok: true, check, head: headBytes(at.path, 512), bytes: r.bytes };
}

/** The words a derived mesh is said with: what it is and is not, how it was made, and what was checked. */
export function derivedWords(d: Omit<VoxDerived, 'words'>, at?: string): string {
  const box = d.check.against
    ? `Timmy's reading of it (${boxText(d.check.box ?? [])}) is within ${num(d.check.against.within_mm)} mm of OCP's box of the STEP (${boxText(d.check.against.box)})`
    : `its box ${d.check.box ? boxText(d.check.box) : 'not read'}; ${d.check.note ?? 'not compared with the STEP'}`;
  return [
    `${d.path} is a tessellation of ${d.from.path}, not the STEP itself: ${d.made_by} meshed its surfaces within ${tolWords(d.tolerance)}${d.made === 'reused' ? `; made by an earlier view${at ? ` (${at})` : ''}, its bytes unchanged` : ''}`,
    `${d.triangles} triangles`, `sha256 ${d.sha256.slice(0, 12)}…`, box,
  ].join(' · ');
}

/** The newest earlier view's tessellation of these bytes at this tolerance whose file is still those bytes, if any. */
export function reusableTessellation(views: unknown, input: StepInput, root: string, id: string): { derived: VoxDerived; at?: string } | undefined {
  const list = Array.isArray(views) ? views : [];
  for (const v of [...list].reverse()) {
    const view = objOf(v);
    for (const x of Array.isArray(view?.derived) ? view!.derived as unknown[] : []) {
      const d = objOf(x);
      const from = objOf(d?.from);
      const tol = objOf(d?.tolerance);
      if (!d || d.kind !== 'tessellation' || !from || from.path !== input.path || from.sha256 !== input.sha256 || (from.role ?? undefined) !== input.role) continue;
      if (!tol || tol.linear_deflection_mm !== TESSELLATION.linear_deflection_mm || tol.angular_deflection_rad !== TESSELLATION.angular_deflection_rad || tol.relative !== false) continue;
      if (!text(d.path) || !d.path.startsWith(`${voxHighlightDir(id)}/`) || !d.path.endsWith('.stl') || !hex64(d.sha256) || !count(d.triangles)) continue;
      const at = resolveInside(root, d.path);
      if ('error' in at) continue;
      let now: string | undefined;
      try { now = hashFile(at.path); } catch { now = undefined; }
      if (now !== d.sha256) continue;
      return { derived: d as unknown as VoxDerived, ...(text(view?.at) ? { at: view!.at as string } : {}) };
    }
  }
  return undefined;
}

export interface TessDeps {
  env: () => NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  startJob: (spec: JobSpec, o?: { selfSealed?: boolean }) => JobRecord;
  jobs: { done(id: string): Promise<JobRecord>; tail(id: string, n?: number): string[] };
  scrub: (text: string, root: string) => string;
}

export type TessOutcome =
  | { ok: true; derived: VoxDerived; head: Buffer }
  /** `setup`: needs setup (OCP is missing in that Python); `kept`: where a file that failed its check is kept */
  | { ok: false; why: string; setup?: string; job?: string; kept?: string; raw?: VoxDerived['raw'] };

/** Keeps a job's output as it came, beside the record (private): its path, sha256 and size. */
function keepLog(root: string, id: string, name: string, logPath: string): VoxDerived['raw'] | undefined {
  try {
    const dir = resolveInside(root, voxRawDir(id));
    if ('error' in dir) return undefined;
    mkdirSync(dir.path, { recursive: true });
    const to = path.join(dir.path, name);
    copyFileSync(logPath, to);
    const b = readFileSync(to);
    return { path: `${voxRawDir(id)}/${name}`, sha256: hashFile(to), bytes: b.length };
  } catch { return undefined; }
}

/** A file that failed its check, moved into the record's private folder as written (never deleted). */
function keepRejected(root: string, id: string, rel: string, job: string): string | undefined {
  const from = resolveInside(root, rel);
  const dir = resolveInside(root, voxRawDir(id));
  if ('error' in from || 'error' in dir) return undefined;
  try {
    mkdirSync(dir.path, { recursive: true });
    const name = `rejected-${job}-${path.basename(from.path)}`;
    if (exists(path.join(dir.path, name))) return undefined;
    renameSync(from.path, path.join(dir.path, name));
    return `${voxRawDir(id)}/${name}`;
  } catch { return undefined; }
}

/**
 * A STEP input as a mesh for the viewer: an earlier view's tessellation used again when its file is still the same bytes,
 * else OCP's tessellation made now as a job (`started` is told the job as it starts) and checked by Timmy.
 */
export async function tessellateForView(d: TessDeps, o: { root: string; project: string; id: string; input: StepInput; views: unknown; started?: (job: JobRecord) => void }): Promise<TessOutcome> {
  const tolerance = { ...TESSELLATION, relative: false as const };
  const from = { path: o.input.path, sha256: o.input.sha256, ...(o.input.role ? { role: o.input.role } : {}) };
  const again = reusableTessellation(o.views, o.input, o.root, o.id);
  if (again) {
    const e = again.derived;
    const c = checkMesh({ root: o.root, rel: e.path, sha256: e.sha256, triangles: e.triangles, tolerance, stepBox: o.input.box ?? null });
    if (c.ok) {
      const derived: Omit<VoxDerived, 'words'> = {
        path: e.path, sha256: e.sha256, bytes: c.bytes, kind: 'tessellation', format: 'stl', from,
        method: text(e.method) ? e.method : 'OpenCascade BRepMesh_IncrementalMesh', tolerance, triangles: c.check.triangles,
        made_by: text(e.made_by) ? e.made_by : "an earlier view's tessellation worker", made: 'reused', check: c.check,
      };
      return { ok: true, derived: { ...derived, words: derivedWords(derived, again.at) }, head: c.head };
    }
  }
  const ready = tessellationReady({ env: d.env(), onPath: d.onPath, root: o.root });
  if (!ready.ready) return { ok: false, why: ready.why, setup: ready.setup };
  const out = freeTessellationPath(o.root, o.id, o.input.role);
  if (!out) return { ok: false, why: `no free name for its tessellation in ${voxHighlightDir(o.id)}/` };
  try { mkdirSync(path.dirname(out.abs), { recursive: true }); } catch { return { ok: false, why: `${voxHighlightDir(o.id)}/ cannot be made` }; }
  let job: JobRecord;
  try {
    job = d.startJob({
      kind: 'task', project: o.project, root: o.root, env: d.env(), timeoutMs: TESSELLATE_TIMEOUT_MS,
      label: `vox view ${o.id} · tessellate ${o.input.path} (OCP)`, command: ready.command,
      args: [TESSELLATE_SCRIPT, o.input.abs, '--out', out.abs, '--as', o.input.path, '--linear', String(tolerance.linear_deflection_mm), '--angular', String(tolerance.angular_deflection_rad)],
    }, { selfSealed: true });
  } catch (e) { return { ok: false, why: `its tessellation did not start (${d.scrub(e instanceof Error ? e.message : String(e), o.root)})` }; }
  o.started?.(job);
  const done = await d.jobs.done(job.id);
  const raw = keepLog(o.root, o.id, `tessellate${o.input.role ? `-${o.input.role}` : ''}-${done.id}.log`, done.logPath);
  const fail = (why: string, extra: { setup?: string; kept?: string } = {}): TessOutcome => {
    // A worker stopped while it wrote leaves its temporary file beside the name Timmy gave it: Timmy's own, removed.
    try { unlinkSync(path.join(path.dirname(out.abs), `.${path.basename(out.abs)}.part`)); } catch { /* none */ }
    return { ok: false, why, job: done.id, ...(raw ? { raw } : {}), ...extra };
  };
  if (done.state === 'cancelled') return fail(`its tessellation (job ${done.id}) was stopped before it finished`);
  let size = 0;
  try { size = statSync(done.logPath).size; } catch { size = 0; }
  if (size > TESSELLATE_MAX_OUTPUT) return fail(`its tessellation worker printed more than ${TESSELLATE_MAX_OUTPUT} bytes (job ${done.id})`);
  const t = parseTessellation(d.jobs.tail(done.id, 200).join('\n'));
  if (!t.ok) {
    if (t.code === 'no-ocp') return fail(d.scrub(t.error, o.root), { setup: SETUP.step });
    return fail(d.scrub(`its tessellation failed (job ${done.id}, ${done.state === 'failed' ? (done.error ?? `exit ${done.exitCode ?? '?'}`) : 'exit 0'}): ${t.code}: ${t.error}`, o.root));
  }
  const reject = (why: string): TessOutcome => {
    const kept = exists(out.abs) ? keepRejected(o.root, o.id, out.rel, done.id) : undefined;
    return fail(`${why}${kept ? `; the file is kept as written in ${kept}` : exists(out.abs) ? `; the file is left as written at ${out.rel}` : ''}`, kept ? { kept } : {});
  };
  // A result line alone decides nothing: the job must have ended well too (exit 0, within its time).
  if (done.state !== 'completed' || done.exitCode !== 0) return reject(d.scrub(`its tessellation job ${done.id} ended ${done.state}${done.error ? ` (${done.error})` : ''}, exit ${done.exitCode ?? 'none'}`, o.root));
  if (t.source.sha256 !== o.input.sha256) return reject(`the worker meshed bytes other than ${o.input.path} as recorded (sha256 ${t.source.sha256.slice(0, 12)}, recorded ${o.input.sha256.slice(0, 12)})`);
  if (t.tessellation.linear_deflection_mm !== tolerance.linear_deflection_mm || t.tessellation.angular_deflection_rad !== tolerance.angular_deflection_rad) {
    return reject(`the worker reports a tolerance (${num(t.tessellation.linear_deflection_mm)} mm, ${num(t.tessellation.angular_deflection_rad)} rad) other than the one asked`);
  }
  if (t.output.file !== path.basename(out.abs)) return reject(`the worker names ${t.output.file}, not the file it was asked to write`);
  const c = checkMesh({ root: o.root, rel: out.rel, sha256: t.output.sha256, bytes: t.output.bytes, triangles: t.output.triangles, tolerance, stepBox: o.input.box ?? null });
  if (!c.ok) return reject(c.why);
  const engine = t.engine as { ocp?: unknown } | undefined;
  const derived: Omit<VoxDerived, 'words'> = {
    path: out.rel, sha256: t.output.sha256, bytes: c.bytes, kind: 'tessellation', format: 'stl', from,
    method: `${t.tessellation.method}; written by ${t.output.writer ?? 'StlAPI_Writer'}`, tolerance, triangles: t.output.triangles,
    made_by: `${t.worker.name} ${t.worker.version} (OCP ${typeof engine?.ocp === 'string' ? engine.ocp : 'version not reported'})`,
    made: 'now', job: done.id, ...(raw ? { raw } : {}), check: c.check,
  };
  return { ok: true, derived: { ...derived, words: derivedWords(derived) }, head: c.head };
}
