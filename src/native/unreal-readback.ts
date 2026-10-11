/**
 * The second pass of an Unreal run (round R4, helper H63): a separate UnrealEditor-Cmd process opens each level the first
 * pass saved and lists its actors as they load from the file (workers/unreal/unreal_readback.py); Timmy compares that
 * list with what the first pass reported when it saved the level, actor by actor: class, label, location, rotation,
 * scale and bounds, each within a stated tolerance. The verdict is agrees or differs, with the numbers; failed when the
 * second pass could not read what it was asked to (no result, another readback's file, the level not loaded, other bytes
 * read than the first pass recorded). The first pass alone is never trusted: an operation's outcome for an Unreal run is
 * this verdict (unrealRunOutcome, used by src/ops/outcome.ts).
 *
 * What it is, exactly: the same engine reading its own file in a separate process, a second pass and not an independent
 * implementation. Agreement shows the saved file holds the actors the first pass reported; it says nothing of a
 * physical object. Each readback is a line in the run's readbacks.jsonl, beside its verdicts and never over them.
 *
 * Nothing here has run against Unreal Engine (tests/native-unreal.test.ts: a FAKE UnrealEditor-Cmd and a stand-in
 * `unreal` module).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord, JobSpec } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import { listNativeRuns, readNativeRecord, sha256File, type NativeVerdictLine } from './index.js';
import { actorOf, cm, makeUnrealPlace, unrealArgs, unrealPlace, unrealReport, UNREAL_DDC_GRAPH, type UnrealActor } from './unreal.js';
import { checkUnrealOutsideOnce, UNREAL_OUTSIDE_SLACK_MS, unrealOutsideEnv, type UnrealOutsideCheck } from './unreal-outside.js';

/** Each readback of a run, one JSON line each, appended beside its verdicts and never over them. */
export const UNREAL_READBACKS = 'readbacks.jsonl';
/** A readback opens the project again: Unreal's start alone can take minutes. */
export const UNREAL_READBACK_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * How close the two passes must be. Both are Unreal's own numbers for the same actors (the harness and the worker round to
 * 1e-6), so the tolerance only absorbs rounding: 0.001 cm for locations and bounds, 1e-6 for scale, and 1e-6 per element of
 * the two rotations' matrices (about 0.00006 degrees), so equal rotations written differently agree.
 */
export const UNREAL_READBACK_TOLERANCE = { location_cm: 0.001, rotation_matrix: 1e-6, scale: 1e-6, bounds_cm: 0.001 } as const;
export const UNREAL_READBACK_SCOPE = 'A second UnrealEditor-Cmd process opened each saved level and listed its actors as they loaded from the file; Timmy compared them with what the first pass reported when it saved the level. Both are Unreal Engine: agreement shows the saved file holds what the first pass reported, not an independent engine\'s confirmation. Unreal units (centimetres) of a generated scene, never of a physical object.';

const RUN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');
const SHA = /^[0-9a-f]{64}$/i;

// ── which run, which levels ──────────────────────────────────────────────────────

/** A level to read back: the first pass's report of it at its save, and its file as recorded then. */
export interface UnrealPlannedLevel { asset: string; file: string; abs: string; sha256: string; actors: UnrealActor[]; actors_total: number }
/** What a readback opens and compares with. */
export interface UnrealReadbackPlan {
  run: string;
  /** the run's own folder (absolute): its readbacks.jsonl, the readback's file and its kept log go there */
  dir: string;
  root: string;
  /** the first pass's job, from the run's started.json */
  job?: string;
  /** the .uproject the first pass opened: its path now, and whether its bytes have changed since */
  project: { path: string; abs: string; changed: boolean };
  levels: UnrealPlannedLevel[];
  version?: string;
}

/** The project's Unreal runs, newest first: each run's last verdict, and its readbacks so far. */
export function listUnrealRuns(root: string): Array<{ run: string; started_at: string; label: string; verdict?: NativeVerdictLine; readbacks: UnrealReadbackLine[] }> {
  return listNativeRuns(root).filter((r) => r.app === 'unreal').map((r) => {
    const rec = readNativeRecord(root, r.run);
    return { run: r.run, started_at: r.started_at, label: rec?.job.label ?? r.run, ...(r.verdicts.length ? { verdict: r.verdicts.at(-1) } : {}), readbacks: rec ? readUnrealReadbacks(rec.dir) : [] };
  });
}

/**
 * Which run /unreal readback reads, and its levels, or why it starts nothing: the run named (its token or first
 * characters; default the newest Unreal run judged ok), its last verdict ok, its result's levels each with a file named
 * among its files with the sha256 it had at its save, each file's bytes now those, and the project file still there.
 */
export function planUnrealReadback(root: string, o: { run?: string } = {}): { ok: true; plan: UnrealReadbackPlan } | { ok: false; error: string } {
  let base: string;
  try { base = realpathSync(root); } catch { return { ok: false, error: 'the project folder is gone' }; }
  const runs = listNativeRuns(base).filter((r) => r.app === 'unreal');
  let run: string | undefined;
  if (o.run) {
    const want = o.run.toLowerCase();
    if (!/^[0-9a-f-]{4,36}$/.test(want)) return { ok: false, error: `${o.run} is not a run token: name an Unreal run by its first 8 characters (/unreal lists them)` };
    const hits = runs.filter((r) => r.run.toLowerCase().startsWith(want));
    if (!hits.length) return { ok: false, error: `no Unreal run ${o.run} in this project (/unreal lists them)` };
    if (hits.length > 1) return { ok: false, error: `${o.run} names ${hits.length} Unreal runs: give more of the token` };
    run = hits[0].run;
  } else {
    run = runs.find((r) => r.verdicts.at(-1)?.outcome === 'ok')?.run;
    if (!run) return { ok: false, error: runs.length ? 'no Unreal run in this project has been judged ok yet: only a run judged ok is read back' : 'no Unreal run in this project yet: /unreal <project.uproject> <script.py> makes one' };
  }
  if (!RUN_TOKEN.test(run)) return { ok: false, error: `${run} is not a run token` };
  const rec = readNativeRecord(base, run);
  if (!rec) return { ok: false, error: `no record of run ${run.slice(0, 8)} in this project` };
  const run8 = run.slice(0, 8);
  const last = rec.verdicts.at(-1);
  if (!last) return { ok: false, error: `run ${run8} has not been judged yet (it may still be running: /jobs)` };
  if (last.outcome !== 'ok') return { ok: false, error: `run ${run8} was judged ${last.outcome}: ${last.why}; only a run judged ok is read back` };
  if (rec.result.state !== 'read') return { ok: false, error: `run ${run8}'s result file is ${rec.result.state === 'missing' ? 'gone' : 'not readable'} now` };
  const r = obj(rec.result.data);
  const report = unrealReport(r, { root: base, resultFile: rec.job.result ?? '' });
  if (!report.levels.length) return { ok: false, error: `run ${run8} saved no level, so there is nothing to read back: nothing about a scene was checked` };
  let projectMeta: { path?: unknown; sha256?: unknown } | undefined;
  try { projectMeta = obj(obj(JSON.parse(readFileSync(path.join(rec.dir, 'unreal.json'), 'utf8')))?.project); } catch { projectMeta = undefined; }
  if (!projectMeta || typeof projectMeta.path !== 'string') return { ok: false, error: `the record of run ${run8} does not name its project file (unreal.json)` };
  const projectAt = resolveInside(base, projectMeta.path);
  if ('error' in projectAt) return { ok: false, error: `${projectMeta.path}: ${projectAt.error}` };
  const projectNow = sha256File(projectAt.path);
  if (!projectNow) return { ok: false, error: `${projectMeta.path} is gone: Unreal has no project to open` };
  const recorded = obj(r?.files) ?? {};
  const levels: UnrealPlannedLevel[] = [];
  for (const l of report.levels) {
    if (!l.file || !l.sha256) return { ok: false, error: `run ${run8} reports ${l.asset} without its file and sha256` };
    if (recorded[l.file] !== l.sha256) return { ok: false, error: `run ${run8}'s result does not name ${l.file} among its files with the sha256 it had at its save` };
    if (!last.files.find((f) => f.path === l.file)?.written) return { ok: false, error: `${l.file} was not shown to be made by run ${run8} when it was judged` };
    const at = resolveInside(base, l.file);
    if ('error' in at) return { ok: false, error: `${l.file}: ${at.error}` };
    const now = sha256File(at.path);
    if (now !== l.sha256) {
      return { ok: false, error: `${l.file} ${now ? `has changed since run ${run8} (sha256 now ${short(now)}, the run recorded ${short(l.sha256)})` : 'is gone'}: reading it back would not check what the first pass reported; nothing was started` };
    }
    levels.push({ asset: l.asset, file: l.file, abs: at.path, sha256: l.sha256, actors: l.actors, actors_total: l.actors_total });
  }
  return {
    ok: true,
    plan: {
      run, dir: rec.dir, root: base, ...(rec.started?.job ? { job: rec.started.job } : {}),
      project: { path: projectMeta.path, abs: projectAt.path, changed: typeof projectMeta.sha256 !== 'string' || projectMeta.sha256 !== projectNow },
      levels, ...(report.version ? { version: report.version } : {}),
    },
  };
}

/**
 * The readback's job: UnrealEditor-Cmd on the project, running the readback worker; its own token and result file. R4
 * (H72): with the first pass's place for its writes (unrealPlace: its cache beside the .uproject, no Zen, its log in
 * Saved/Logs/Timmy-<run>-readback-<token>.log, its user folders in Timmy's native home when there is one).
 */
export function unrealReadbackJob(plan: UnrealReadbackPlan, o: { bin: string; worker: string; lib: string; project: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; label?: string }):
  { spec: JobSpec; token: string; result: string; place: { cache: string; log: string; ddc: string; native_home: boolean } } {
  const token = randomUUID();
  const result = path.join(plan.dir, `readback-${token.slice(0, 8)}.json`);
  const home = o.env?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME;
  const place = unrealPlace(plan.root, plan.project.abs, `Timmy-${plan.run.slice(0, 8)}-readback-${token.slice(0, 8)}.log`, home ? { TIMMY_NATIVE_HOME: home } : {});
  makeUnrealPlace(plan.root, place);
  const assets = plan.levels.map((l) => l.asset).join(', ');
  return {
    token, result, place: { cache: place.cache, log: place.log, ddc: UNREAL_DDC_GRAPH, native_home: place.nativeHome },
    spec: {
      kind: 'task', label: o.label ?? `Unreal readback · ${assets} · run ${plan.run.slice(0, 8)}`, project: o.project, root: plan.root,
      command: o.bin, args: unrealArgs(plan.project.abs, o.worker, place.flags),
      env: {
        ...o.env, ...place.env, TIMMY_READBACK_RESULT: result, TIMMY_READBACK_TOKEN: token, TIMMY_RUN: plan.run, TIMMY_ROOT: plan.root,
        TIMMY_UNREAL_LEVELS: JSON.stringify(plan.levels.map((l) => ({ asset: l.asset, file: l.abs }))), TIMMY_UNREAL_PROJECT: plan.project.abs, TIMMY_UNREAL_LIB: o.lib,
      },
      timeoutMs: o.timeoutMs ?? UNREAL_READBACK_TIMEOUT_MS,
    },
  };
}

// ── the comparison ───────────────────────────────────────────────────────────────

/** Unreal's rotation matrix for a rotator [pitch, yaw, roll] in degrees (FRotationMatrix: rows are the rotated axes). */
export function rotationMatrix([pitch, yaw, roll]: number[]): number[][] {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const [sp, cp, sy, cy, sr, cr] = [Math.sin(rad(pitch)), Math.cos(rad(pitch)), Math.sin(rad(yaw)), Math.cos(rad(yaw)), Math.sin(rad(roll)), Math.cos(rad(roll))];
  return [
    [cp * cy, cp * sy, sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
    [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
  ];
}

/** One difference found, with both numbers. */
export interface UnrealDifference { what: string; first: number | string; readback: number | string; difference?: number; tolerance: string }
/** One actor of a level, compared. */
export interface UnrealActorCheck {
  name: string;
  label?: string;
  /** 'both': in both passes; 'first pass only': reported saved, not in the level as loaded; 'readback only': loaded, never reported */
  in: 'both' | 'first pass only' | 'readback only';
  passed: boolean;
  /** the largest difference of each kind (in both passes only) */
  max?: { location_cm: number; rotation_matrix: number; scale: number; bounds_cm: number };
  /** what did not agree, with the numbers (the first 12) */
  differences: UnrealDifference[];
}
export interface UnrealLevelCheck {
  asset: string;
  file: string;
  /** the bytes the first pass recorded, the bytes the readback read before and after opening the level, Timmy's after the job */
  sha256: { recorded: string; read_before: string | null; read_after: string | null; timmy_after: string | null };
  loaded: boolean;
  verdict: 'agrees' | 'differs' | 'failed';
  reason?: string;
  actors: { first_pass: number; readback: number; compared: number; agree: number };
  checks: UnrealActorCheck[];
}

const AXES = ['x', 'y', 'z'];
const ROT = ['pitch', 'yaw', 'roll'];

/** Compares the first pass's actors of a level with the readback's, by actor name: every number with its tolerance. */
export function compareUnrealActors(first: UnrealActor[], readback: UnrealActor[], tol = UNREAL_READBACK_TOLERANCE): { checks: UnrealActorCheck[]; agree: number } {
  const later = new Map(readback.map((a) => [a.name, a]));
  const checks: UnrealActorCheck[] = [];
  let agree = 0;
  const tolText = { location: `${tol.location_cm} cm`, bounds: `${tol.bounds_cm} cm`, scale: String(tol.scale), rotation: `${tol.rotation_matrix} per rotation-matrix element` };
  for (const a of first) {
    const b = later.get(a.name);
    later.delete(a.name);
    if (!b) { checks.push({ name: a.name, ...(a.label ? { label: a.label } : {}), in: 'first pass only', passed: false, differences: [{ what: 'actor', first: `${a.label || a.name} (${a.class_name ?? a.class})`, readback: 'not in the level as loaded', tolerance: 'present' }] }); continue; }
    const differences: UnrealDifference[] = [];
    const max = { location_cm: 0, rotation_matrix: 0, scale: 0, bounds_cm: 0 };
    const textual = (what: string, x: string, y: string): void => { if (x !== y) differences.push({ what, first: x, readback: y, tolerance: 'the same' }); };
    textual('class', a.class, b.class);
    textual('label', a.label, b.label);
    if ((a.mesh ?? '') !== (b.mesh ?? '')) differences.push({ what: 'mesh', first: a.mesh ?? '(none)', readback: b.mesh ?? '(none)', tolerance: 'the same' });
    const numbers = (what: string, xs: number[], ys: number[], limit: number, key: keyof typeof max, words: string, names = AXES): void => {
      xs.forEach((x, i) => {
        const d = ys[i] - x;
        max[key] = Math.max(max[key], Math.abs(d));
        if (!(Math.abs(d) <= limit)) differences.push({ what: `${what} ${names[i]}`, first: x, readback: ys[i], difference: Math.round(d * 1e6) / 1e6, tolerance: words });
      });
    };
    numbers('location (cm)', a.location, b.location, tol.location_cm, 'location_cm', tolText.location);
    numbers('scale', a.scale, b.scale, tol.scale, 'scale', tolText.scale);
    numbers('bounds min (cm)', a.bounds.min, b.bounds.min, tol.bounds_cm, 'bounds_cm', tolText.bounds);
    numbers('bounds max (cm)', a.bounds.max, b.bounds.max, tol.bounds_cm, 'bounds_cm', tolText.bounds);
    const ra = rotationMatrix(a.rotation);
    const rb = rotationMatrix(b.rotation);
    const rot = Math.max(...ra.flatMap((row, i) => row.map((v, j) => Math.abs(rb[i][j] - v))));
    max.rotation_matrix = rot;
    if (!(rot <= tol.rotation_matrix)) {
      differences.push({ what: `rotation (${ROT.join(', ')}, degrees)`, first: a.rotation.map(cm).join(', '), readback: b.rotation.map(cm).join(', '), difference: Math.round(rot * 1e9) / 1e9, tolerance: tolText.rotation });
    }
    const passed = differences.length === 0;
    if (passed) agree++;
    const round = (n: number): number => Math.round(n * 1e9) / 1e9;
    checks.push({
      name: a.name, ...(a.label ? { label: a.label } : {}), in: 'both', passed,
      max: { location_cm: round(max.location_cm), rotation_matrix: round(max.rotation_matrix), scale: round(max.scale), bounds_cm: round(max.bounds_cm) },
      differences: differences.slice(0, 12),
    });
  }
  for (const b of later.values()) {
    checks.push({ name: b.name, ...(b.label ? { label: b.label } : {}), in: 'readback only', passed: false, differences: [{ what: 'actor', first: 'not reported by the first pass', readback: `${b.label || b.name} (${b.class_name ?? b.class})`, tolerance: 'present' }] });
  }
  return { checks, agree };
}

/** A difference in a few words: "TimmyCube_0_0 location (cm) x: first pass 0, readback 5 (difference 5; tolerance 0.001 cm)". */
export function differenceWords(c: UnrealActorCheck, d: UnrealDifference): string {
  const who = c.label && c.label !== c.name ? `${c.label} (${c.name})` : c.name;
  return `${who} ${d.what}: first pass ${String(d.first)}, readback ${String(d.readback)}${d.difference !== undefined ? ` (difference ${d.difference}; tolerance ${d.tolerance})` : ''}`;
}

/** What the readback worker wrote, read defensively; `error` when it is not this readback's or not readable. */
export function readUnrealReadbackFile(file: string, token: string, run: string): { ok: true; data: Record<string, unknown>; levels: Map<string, Record<string, unknown>> } | { ok: false; error: string } {
  let data: Record<string, unknown> | undefined;
  try { data = obj(JSON.parse(readFileSync(file, 'utf8'))); } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'the readback wrote no result file' : `the readback's result file is not readable JSON (${(e as Error).message})` };
  }
  if (!data || data.readback !== 'timmy-unreal-readback/1') return { ok: false, error: 'the readback\'s result file is not a Timmy Unreal readback' };
  if (data.token !== token) return { ok: false, error: 'the readback\'s result file carries another readback\'s token: it is not this readback\'s' };
  if (data.run !== run) return { ok: false, error: 'the readback\'s result file names another run' };
  const levels = new Map<string, Record<string, unknown>>();
  for (const l of Array.isArray(data.levels) ? data.levels.slice(0, 50) : []) {
    const o = obj(l);
    if (o && typeof o.asset === 'string') levels.set(o.asset, o);
  }
  return { ok: true, data, levels };
}

/** Each planned level checked against what the readback read: its bytes first, then its actors. */
export function checkUnrealLevels(plan: UnrealReadbackPlan, read: { levels: Map<string, Record<string, unknown>> }, tol = UNREAL_READBACK_TOLERANCE): UnrealLevelCheck[] {
  return plan.levels.map((l): UnrealLevelCheck => {
    const got = read.levels.get(l.asset);
    const sha = (v: unknown): string | null => (typeof v === 'string' && SHA.test(v) ? v.toLowerCase() : null);
    const timmyAfter = sha256File(l.abs) ?? null;
    const base = { asset: l.asset, file: l.file, sha256: { recorded: l.sha256, read_before: sha(got?.sha256_before), read_after: sha(got?.sha256_after), timmy_after: timmyAfter } };
    const listed = Array.isArray(got?.actors) ? got!.actors.slice(0, 2000) : [];
    const actors = listed.map(actorOf).filter((a): a is UnrealActor => !!a);
    const total = typeof got?.actors_total === 'number' && Number.isInteger(got.actors_total) ? got.actors_total : listed.length;
    const counts = { first_pass: l.actors_total, readback: total, compared: 0, agree: 0 };
    const failed = (reason: string): UnrealLevelCheck => ({ ...base, loaded: got?.loaded === true, verdict: 'failed', reason, actors: counts, checks: [] });
    if (!got) return failed('the readback did not report this level');
    if (got.loaded !== true) return failed('LevelEditorSubsystem.load_level did not open it in the second process');
    if (base.sha256.read_before !== l.sha256) return failed(`the readback read other bytes than the first pass recorded (sha256 ${short(base.sha256.read_before ?? undefined)}, recorded ${short(l.sha256)})`);
    if (base.sha256.read_after !== l.sha256 || timmyAfter !== l.sha256) return failed(`${l.file} changed while it was read back (sha256 after: the readback's ${short(base.sha256.read_after ?? undefined)}, Timmy's ${short(timmyAfter ?? undefined)}; recorded ${short(l.sha256)})`);
    if (listed.length !== actors.length) return failed(`the readback reported ${listed.length - actors.length} actors without the numbers Timmy compares`);
    if (total > actors.length || l.actors_total > l.actors.length) return failed(`the level holds more actors than either pass lists (${Math.max(total, l.actors_total)}): a comparison of part of it would not check the level`);
    const { checks, agree } = compareUnrealActors(l.actors, actors, tol);
    const verdict = checks.every((c) => c.passed) ? 'agrees' : 'differs';
    return { ...base, loaded: true, verdict, actors: { ...counts, compared: checks.filter((c) => c.in === 'both').length, agree }, checks };
  });
}

// ── the record ───────────────────────────────────────────────────────────────────

/** One readback of a run, as the run's readbacks.jsonl keeps it. */
export interface UnrealReadbackLine {
  readback: 1;
  app: 'unreal';
  at: string;
  /** the readback's job */
  job?: string;
  run: string;
  token: string;
  state: string;
  levels: UnrealLevelCheck[];
  worker?: { name: string; version: string };
  unreal_version?: string;
  /** the project file had other bytes than when the first pass ran (the readback opened it as it is now) */
  project_changed?: true;
  tolerance: { location_cm: number; rotation_matrix: number; scale: number; bounds_cm: number };
  verdict?: 'agrees' | 'differs' | 'failed';
  reason?: string;
  /** the readback's own output, kept beside the run */
  log?: string;
  receipt?: string;
  scope: string;
  /** R4 (H72): what this readback's Unreal wrote in its user folders outside the project (unreal-outside.ts) */
  outside?: UnrealOutsideCheck;
}

/**
 * The readback's record from its job's end and the file it wrote: stopped (no verdict); failed (no result, another
 * readback's, a level not opened, other bytes); else each level's verdict, and agrees only when every level agrees.
 */
export function judgeUnrealReadback(plan: UnrealReadbackPlan, job: JobRecord, token: string, resultFile: string, o: { env?: NodeJS.ProcessEnv } = {}): UnrealReadbackLine {
  // R4 (H72): after every Unreal job, what it wrote in Unreal's user folders outside the project (stopped or not)
  const outside = readbackOutside(job, o.env);
  const line: UnrealReadbackLine = {
    readback: 1, app: 'unreal', at: new Date().toISOString(), job: job.id, run: plan.run, token, state: job.state, levels: [],
    ...(plan.project.changed ? { project_changed: true as const } : {}), tolerance: { ...UNREAL_READBACK_TOLERANCE }, scope: UNREAL_READBACK_SCOPE,
    ...(outside ? { outside } : {}),
  };
  if (job.state === 'cancelled') return { ...line, reason: 'stopped before it finished: no verdict' };
  const read = readUnrealReadbackFile(resultFile, token, plan.run);
  const ended = job.state === 'completed' ? '' : ` (UnrealEditor-Cmd ${job.error ?? (typeof job.exitCode === 'number' ? `exited ${job.exitCode}` : job.signal ? `ended by ${job.signal}` : job.state)})`;
  if (!read.ok) return { ...line, verdict: 'failed', reason: `${read.error}${ended}` };
  const w = obj(read.data.worker);
  if (w && typeof w.name === 'string' && typeof w.version === 'string') line.worker = { name: w.name.slice(0, 60), version: w.version.slice(0, 30) };
  if (typeof read.data.unreal_version === 'string') line.unreal_version = read.data.unreal_version.slice(0, 120);
  line.levels = checkUnrealLevels(plan, read);
  if (read.data.ok !== true) {
    const error = typeof read.data.error === 'string' ? read.data.error.slice(0, 500) : 'it reported ok: false without an error';
    return { ...line, verdict: 'failed', reason: `the readback could not read every level: ${error}${ended}` };
  }
  const failed = line.levels.find((l) => l.verdict === 'failed');
  if (failed) return { ...line, verdict: 'failed', reason: `${failed.asset}: ${failed.reason}${ended}` };
  if (line.levels.some((l) => l.verdict === 'differs')) {
    const first = line.levels.flatMap((l) => l.checks.filter((c) => !c.passed).map((c) => `${l.asset}: ${differenceWords(c, c.differences[0])}`));
    return { ...line, verdict: 'differs', reason: `${first.slice(0, 3).join('; ')}${first.length > 3 ? `; and ${first.length - 3} more actors differ` : ''}` };
  }
  return { ...line, verdict: 'agrees' };
}

/** R4 (H72): a readback job's outside check, from its start to its end (+ a few seconds); none while its end is not known. */
function readbackOutside(job: JobRecord, env?: NodeJS.ProcessEnv): UnrealOutsideCheck | undefined {
  const sinceMs = Date.parse(job.startedAt);
  const endedMs = job.endedAt ? Date.parse(job.endedAt) : Number.NaN;
  if (job.stale || Number.isNaN(sinceMs) || Number.isNaN(endedMs)) return undefined;
  return checkUnrealOutsideOnce(`readback:${job.id}:${job.startedAt}`, { sinceMs, untilMs: endedMs + UNREAL_OUTSIDE_SLACK_MS, env: unrealOutsideEnv(env) });
}

/** A run's readbacks so far, oldest first (a torn line is skipped, never repaired). */
export function readUnrealReadbacks(dir: string): UnrealReadbackLine[] {
  let body = '';
  try { body = readFileSync(path.join(dir, UNREAL_READBACKS), 'utf8'); } catch { return []; }
  const out: UnrealReadbackLine[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { const l = JSON.parse(line) as UnrealReadbackLine; if (l && l.app === 'unreal') out.push(l); } catch { /* skipped */ }
  }
  return out;
}

/** Appends a readback to the run's readbacks.jsonl; false when it could not be written. */
export function appendUnrealReadback(dir: string, line: UnrealReadbackLine): boolean {
  try { appendFileSync(path.join(dir, UNREAL_READBACKS), `${JSON.stringify(line)}\n`); return true; } catch { return false; }
}

/**
 * An Unreal run as an operation counts it (src/ops/outcome.ts): the first pass's judgement, then its newest readback's
 * verdict, which decides: agrees succeeded, differs differs, failed failed, stopped stopped. A run judged ok with no
 * readback is unknown (counted as not succeeded): the first pass alone is never trusted. Its readback jobs are claimed.
 */
export function unrealRunOutcome(dir: string, last: NativeVerdictLine, result: { state: string; data?: unknown }, claims: string[]):
  { state: 'succeeded' | 'failed' | 'differs' | 'stopped' | 'unknown'; words: string; claims: string[] } {
  const readbacks = readUnrealReadbacks(dir);
  const all = [...claims, ...readbacks.flatMap((r) => (r.job && /^j[0-9a-f]{6}$/.test(r.job) ? [`job:${r.job}`] : []))];
  // R4 u23 (H72): a first pass Timmy stopped is judged when it ends (what it left is recorded), and its operation is stopped
  if (last.exit?.state === 'cancelled') return { state: 'stopped', words: `stopped; its verdict when it ended: ${last.outcome}`, claims: all };
  if (last.outcome !== 'ok') return { state: 'failed', words: `${last.outcome} (judged by its result file)`, claims: all };
  const newest = readbacks.at(-1);
  if (!newest) {
    const levels = result.state === 'read' ? obj(result.data)?.levels : undefined;
    const none = Array.isArray(levels) && levels.length === 0;
    return { state: 'unknown', words: `ok (judged by its result file), but ${none ? 'it saved no level, so nothing was read back' : 'not read back yet'}: the first pass alone is not trusted`, claims: all };
  }
  const words = `ok (judged by its result file); readback ${newest.verdict ?? newest.state}${newest.reason ? `: ${newest.reason.slice(0, 200)}` : ''}`;
  if (newest.verdict === 'agrees') return { state: 'succeeded', words, claims: all };
  if (newest.verdict === 'differs') return { state: 'differs', words, claims: all };
  if (newest.verdict === 'failed') return { state: 'failed', words, claims: all };
  if (newest.state === 'cancelled') return { state: 'stopped', words, claims: all };
  return { state: 'unknown', words, claims: all };
}
