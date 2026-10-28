/**
 * The spatial tools order (2026-10-28): the Workspace's spatial operations run as Timmy's own durable process jobs
 * (src/jobs/index.ts JobManager: a process group per job, its log, its time limit, SIGTERM then SIGKILL on a stop), never
 * through another scheduler, receipt store, login or MCP server. src/companion/workflow-ops.ts starts, follows, cancels,
 * recovers and collects them exactly as it does a hosted app's job, with the same run records and current-result fencing.
 *
 * Each run has its own folder (<TIMMY_HOME>/spatial/<project id>/runs/<run>/): the request, the exact input bytes it was
 * validated with (copied, hashed), the worker's output folder and Blender's own config folder. The tools' raw output is
 * never handed to a parser as if it were a result:
 *
 *   KIRI     Timmy's worker (workers/spatial/kiri_worker.py) prints one JSON event per stage and writes result.json. A
 *            run is completed only when Blender exited 0 AND result.json says success AND its three value checks
 *            (crop, native reopen, export reimport) are present AND both artifacts parse: a Gaussian PLY and a .blend.
 *   Brush    prints terminal progress and logs (no JSON switch in 0.3.0). It is completed only when it exited 0 AND its
 *            final export (export_<steps>.ply) exists and parses as a Gaussian PLY with vertices; its exit code alone,
 *            or a warning about an export, is not success. Its progress is unknown (indeterminate), never a made-up bar.
 *   gsplat   never starts here: it awaits an NVIDIA worker. Its NDJSON (doctor, smoke) is the worker's, kept raw.
 *
 * On the run's end its files are delivered into the project (from-apps/spatial/<run>/…, never over other bytes) and ONE
 * receipt is sealed into the project's `runs` chain (appendReceipt): kind `spatial`, the tool and its version, the input's
 * hash, each output's hash, the checks that passed, and the raw log's and result's hashes. A failed or cancelled run keeps
 * its raw log and result the same way. A Gaussian splat is an appearance reconstruction: not measured geometry.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JobManager, type JobRecord, type JobSpec } from '../jobs/index.js';
import { deliveredPath, deliverInto } from '../companion/miniapps/receipts.js';
import { projectId } from '../project/index.js';
import { packagedPath } from '../utils/asset-dirs.js';
import { appendReceipt, type Receipt } from '../utils/receipts.js';
import { gaussianPlyHeader, SPATIAL_TOOLS, spatialToolStates, type SpatialToolId, type SpatialToolState } from './tools.js';

type Env = Record<string, string | undefined>;
export type SpatialRunState = 'queued' | 'running' | 'held' | 'failed' | 'cancelled' | 'completed' | 'interrupted';
export interface SpatialView { state: SpatialRunState; appWord: string; progress: number | null; error?: string }

/** The KIRI worker's stages, in order (its progress is how many it has written of these). */
export const KIRI_STAGES = ['registered', 'imported', 'cropped', 'crop_values_verified', 'native_saved', 'native_reopened', 'native_values_verified', 'exported', 'export_reimported', 'export_values_verified'] as const;
const KIRI_CHECKS = ['crop_values_verified', 'native_values_verified', 'export_values_verified'];
/** a KIRI run is small and bounded (the package's own cap was 300 s) */
const KIRI_LIMIT_MS = 180_000;
/** a Brush run's whole limit (a bounded number of steps on this computer's GPU) */
const BRUSH_LIMIT_MS = 45 * 60_000;

/** The keep choices of the KIRI crop (in the splat's own local coordinates; ±1e6 stands for "no limit"). */
export const KIRI_KEEP: Record<string, [[number, number, number], [number, number, number]] | null> = {
  all: null,
  'x ≤ 0': [[-1e6, -1e6, -1e6], [0, 1e6, 1e6]], 'x ≥ 0': [[0, -1e6, -1e6], [1e6, 1e6, 1e6]],
  'y ≤ 0': [[-1e6, -1e6, -1e6], [1e6, 0, 1e6]], 'y ≥ 0': [[-1e6, 0, -1e6], [1e6, 1e6, 1e6]],
  'z ≤ 0': [[-1e6, -1e6, -1e6], [1e6, 1e6, 0]], 'z ≥ 0': [[-1e6, -1e6, 0], [1e6, 1e6, 1e6]],
};

/** Where Timmy's KIRI worker is (a source checkout or the installed package). */
export function kiriWorkerPath(): string | null {
  return packagedPath('workers/spatial/kiri_worker.py', import.meta.url, { kind: 'file' }) ?? null;
}

export interface SpatialStart {
  home: string; root: string; project: string; principal: string;
  run: string; op: string; tool: SpatialToolId; label: string;
  input: { name: string; path: string; sha256: string; bytes: Buffer } | null;
  params: Record<string, string | number>;
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const fileSha = (p: string): string | null => { try { return sha(readFileSync(p)); } catch { return null; } };
const readJson = (p: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; } };

export class SpatialExecutor {
  private readonly managers = new Map<string, JobManager>();
  constructor(private readonly o: { env?: Env; states?: () => SpatialToolState[]; seal?: (root: string, r: Parameters<typeof appendReceipt>[1]) => Receipt } = {}) {}

  private env(): Env { return this.o.env ?? process.env; }
  states(): SpatialToolState[] { return this.o.states ? this.o.states() : spatialToolStates(this.env()); }
  state(tool: SpatialToolId): SpatialToolState | undefined { return this.states().find((s) => s.id === tool); }
  base(home: string, root: string): string { return join(home, 'spatial', projectId(root)); }
  runDir(home: string, root: string, run: string): string { return join(this.base(home, root), 'runs', run); }
  manager(home: string, root: string): JobManager {
    const dir = join(this.base(home, root), 'jobs');
    let m = this.managers.get(dir);
    if (!m) { m = new JobManager({ dir }); this.managers.set(dir, m); }
    return m;
  }

  /** Why an operation of this tool cannot start here now, or null when it can. */
  refusal(tool: SpatialToolId): string | null {
    const s = this.state(tool);
    if (!s) return 'no such spatial tool';
    if (!s.callable.ok) return `${SPATIAL_TOOLS[tool].name}: ${s.blocker ?? s.callable.words}`;
    if (tool === 'kiri' && !kiriWorkerPath()) return 'Timmy’s KIRI worker (workers/spatial/kiri_worker.py) is not in this installation';
    return null;
  }

  /** Starts the run's job (or says why not). The run's folder holds the request and the exact input bytes. */
  start(s: SpatialStart): { job: string } | { error: string } {
    const why = this.refusal(s.tool);
    if (why) return { error: why };
    const st = this.state(s.tool)!;
    const dir = this.runDir(s.home, s.root, s.run);
    const out = join(dir, 'out');
    mkdirSync(join(dir, 'input'), { recursive: true, mode: 0o700 });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    let inputPath: string | null = null;
    if (s.input) {
      inputPath = join(dir, 'input', basename(s.input.path).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120));
      writeFileSync(inputPath, s.input.bytes, { flag: 'wx', mode: 0o600 });
      if (fileSha(inputPath) !== s.input.sha256) return { error: 'the input copied for the run does not hash as validated' };
    }
    const baseEnv: Env = { HOME: this.env().HOME, TMPDIR: this.env().TMPDIR, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: this.env().LANG ?? 'en_US.UTF-8' };
    let spec: JobSpec;
    let request: Record<string, unknown>;
    if (s.tool === 'kiri') {
      const keep = String(s.params.keep ?? 'all');
      const header = s.input ? gaussianPlyHeader(s.input.bytes) : null;
      if (!header?.ok) return { error: `the input is ${header?.why ?? 'missing'}` };
      request = { operation: 'import-crop-export', fixture: header.fixture, input_ply: inputPath, output_dir: out, crop_aabb: KIRI_KEEP[keep] ?? null, keep, run: s.run };
      const req = join(dir, 'request.json');
      writeFileSync(req, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
      mkdirSync(join(dir, 'blender-config'), { recursive: true, mode: 0o700 });
      spec = {
        kind: 'task', label: `${s.label} (KIRI in Blender)`, project: s.project, root: dir,
        command: st.paths.blender!, args: ['--background', '--factory-startup', '--disable-autoexec', '-noaudio', '--threads', '1', '--python-exit-code', '11', '--python', kiriWorkerPath()!, '--', req],
        env: { ...baseEnv, BLENDER_USER_CONFIG: join(dir, 'blender-config'), PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', TIMMY_KIRI_ADDON: join(st.root!, 'kiri', 'versions', '5.1.0') },
        envExact: true, stdin: 'closed', timeoutMs: KIRI_LIMIT_MS,
        // each stage the worker prints is a step (its progress); any other line stays in the log only
        parseLine: (line, job) => {
          if (!line.startsWith('{"event"')) return;
          try { const e = JSON.parse(line) as { event?: unknown }; if (typeof e.event === 'string' && (KIRI_STAGES as readonly string[]).includes(e.event)) job.steps.push({ name: e.event, state: 'completed' }); } catch { /* not a stage line */ }
        },
      };
    } else if (s.tool === 'brush') {
      const steps = Number(s.params.steps);
      request = { operation: 'train', dataset: inputPath, total_steps: steps, max_resolution: Number(s.params.max_resolution), max_splats: Number(s.params.max_splats), export_path: out, run: s.run };
      writeFileSync(join(dir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
      spec = {
        kind: 'task', label: `${s.label} (Brush)`, project: s.project, root: dir,
        command: st.paths.entry!, args: [inputPath!, '--total-steps', String(steps), '--max-resolution', String(s.params.max_resolution), '--max-splats', String(s.params.max_splats),
          '--export-every', String(steps), '--eval-every', String(steps), '--export-path', out, '--export-name', 'export_{iter}.ply'],
        env: { ...baseEnv, RUST_LOG: 'info' }, envExact: true, stdin: 'closed', timeoutMs: BRUSH_LIMIT_MS,
      };
    } else {
      return { error: this.refusal('gsplat') ?? 'gsplat does not run on this computer' };
    }
    const job = this.manager(s.home, s.root).start(spec);
    writeFileSync(join(dir, 'job.json'), `${JSON.stringify({ job: job.id, tool: s.tool, op: s.op, run: s.run, version: SPATIAL_TOOLS[s.tool].version, command: basename(spec.command), args: spec.args.map((a) => (a.startsWith(dir) ? `<run>${a.slice(dir.length)}` : a.includes('/') ? basename(a) : a)) }, null, 2)}\n`, { mode: 0o600 });
    return { job: job.id };
  }

  /** The run's state as Timmy words it from the job's record and the tool's own result (never from the exit code alone). */
  read(home: string, root: string, run: string, tool: SpatialToolId, job: string): SpatialView | null {
    const rec = this.manager(home, root).get(job);
    if (!rec) return null;
    const dir = this.runDir(home, root, run);
    if (rec.state === 'queued') return { state: 'queued', appWord: 'queued', progress: null };
    if (rec.state === 'running' || rec.state === 'ready') {
      if (rec.stale) return this.judge(dir, tool, rec, true);
      const done = tool === 'kiri' ? rec.steps.filter((x) => (KIRI_STAGES as readonly string[]).includes(x.name)).length : 0;
      return { state: 'running', appWord: tool === 'kiri' ? (rec.steps.at(-1)?.name ?? 'starting Blender') : 'training (its own progress is not read)', progress: tool === 'kiri' && done ? Math.round((done / KIRI_STAGES.length) * 100) : null };
    }
    return this.judge(dir, tool, rec, false);
  }

  /** An ended (or left) job judged by the tool's own result and its artifacts. */
  judge(dir: string, tool: SpatialToolId, rec: JobRecord, left: boolean): SpatialView {
    const exit = rec.exitCode === null || rec.exitCode === undefined ? (rec.signal ? `signal ${rec.signal}` : 'no exit code') : `exit ${rec.exitCode}`;
    if (rec.state === 'cancelled') return { state: 'cancelled', appWord: `cancelled (${exit}${rec.cleanup ? `; process group ${rec.cleanup === 'complete' ? 'gone' : 'NOT all stopped'}` : ''})`, progress: null, ...(rec.error ? { error: rec.error } : {}) };
    const out = join(dir, 'out');
    if (tool === 'kiri') {
      const r = readJson(join(out, 'result.json'));
      const stages = Array.isArray(r?.stages) ? (r!.stages as Array<{ stage?: string }>).map((x) => String(x.stage)) : [];
      const checks = KIRI_CHECKS.filter((c) => stages.includes(c));
      const ply = join(out, 'edited.ply'); const blend = join(out, 'edited.blend');
      const plyOk = existsSync(ply) && gaussianPlyHeader(readFileSync(ply)).ok;
      const blendOk = existsSync(blend) && /^(BLENDER|\x28\xb5\x2f\xfd)/.test(readFileSync(blend).subarray(0, 8).toString('latin1'));
      const ok = r?.status === 'success' && checks.length === KIRI_CHECKS.length && plyOk && blendOk;
      if (left) return ok ? { state: 'completed', appWord: `recovered: the worker’s own result says success (${checks.length}/3 value checks); Timmy did not see Blender end`, progress: 100 } : { state: 'interrupted', appWord: 'the companion that followed it stopped; its result is incomplete', progress: null, error: 'interrupted' };
      if (rec.state === 'completed' && ok) return { state: 'completed', appWord: `Blender ${exit}; KIRI worker: success, ${checks.length}/3 value checks`, progress: 100 };
      const why = typeof r?.error === 'string' ? r.error : rec.error ?? (r ? `worker status ${String(r.status)}` : 'no result.json from the worker');
      return { state: 'failed', appWord: `Blender ${exit}; KIRI worker: ${String(r?.status ?? 'no result')}`, progress: null, error: `${why}${!plyOk && r?.status === 'success' ? '; the exported PLY did not parse as a Gaussian splat' : ''}`.slice(0, 400) };
    }
    if (tool === 'brush') {
      const req = readJson(join(dir, 'request.json'));
      const final = join(out, `export_${Number(req?.total_steps)}.ply`);
      const h = existsSync(final) ? gaussianPlyHeader(readFileSync(final)) : null;
      if (left) return { state: 'interrupted', appWord: 'the companion that followed it stopped (a Brush run is not resumed: --start-iter is not exact optimizer resume)', progress: null, error: 'interrupted' };
      if (rec.state === 'completed' && h?.ok) return { state: 'completed', appWord: `Brush ${exit}; final export ${h.vertices} Gaussians`, progress: 100 };
      return { state: 'failed', appWord: `Brush ${exit}`, progress: null, error: (h ? `the final export is ${h.why}` : rec.error ?? 'no final export (an exit code alone is not success)').slice(0, 400) };
    }
    return { state: 'failed', appWord: 'not run here', progress: null, error: 'gsplat awaits an NVIDIA worker' };
  }

  /** Stops the job's whole process group (SIGTERM, then SIGKILL after the grace). A job another companion left is not signalled. */
  async cancel(home: string, root: string, job: string): Promise<boolean> {
    const m = this.manager(home, root);
    const before = m.get(job);
    if (!before || !['queued', 'running', 'ready'].includes(before.state)) return false;
    const after = await m.stop(job);
    return after?.state === 'cancelled';
  }

  /**
   * The ended run delivered and sealed: its files into the project (from-apps/spatial/<run>/), ONE receipt in the project's
   * chain. Idempotent by the run's folder (sealed.json): a second call returns what the first sealed.
   */
  collect(c: { home: string; root: string; project: string; principal: string; run: string; op: string; tool: SpatialToolId; label: string; attempt: number; job: string; input: { path: string; sha256: string } | null; view: SpatialView }): { ids: string[]; outputs: Array<{ path: string; sha256: string; bytes: number }>; note: string } {
    const dir = this.runDir(c.home, c.root, c.run);
    const sealedFile = join(dir, 'sealed.json');
    const prior = readJson(sealedFile);
    if (prior && Array.isArray(prior.ids)) return { ids: prior.ids as string[], outputs: (prior.outputs ?? []) as Array<{ path: string; sha256: string; bytes: number }>, note: 'sealed' };
    const rec = this.manager(c.home, c.root).get(c.job);
    const out = join(dir, 'out');
    const names: string[] = [];
    try { for (const n of readdirSync(out)) if (statSync(join(out, n)).isFile()) names.push(n); } catch { /* no output folder */ }
    const deliver = deliverInto(c.root);
    const outputs: Array<{ path: string; sha256: string; bytes: number }> = [];
    const unhashed: string[] = [];
    const give = (name: string, bytes: Buffer): void => {
      const rel = deliveredPath('spatial', c.run, name);
      if (!rel || !deliver(rel, bytes)) { unhashed.push(name); return; }
      outputs.push({ path: rel, sha256: sha(bytes), bytes: bytes.length });
    };
    for (const n of names.sort()) give(n, readFileSync(join(out, n)));
    // the raw evidence: the job's whole log (stdout and stderr as the tool wrote them) and Timmy's request
    if (rec?.logPath && existsSync(rec.logPath)) give('job.log', readFileSync(rec.logPath));
    if (existsSync(join(dir, 'request.json'))) give('request.json', readFileSync(join(dir, 'request.json')));
    const result = c.tool === 'kiri' ? readJson(join(out, 'result.json')) : null;
    const stages = Array.isArray(result?.stages) ? (result!.stages as Array<Record<string, unknown>>) : [];
    const checks = stages.filter((x) => typeof x.stage === 'string' && /_values_verified$/.test(x.stage)).map((x) => ({ stage: String(x.stage), rows: x.rows ?? null, rtol: x.rtol ?? null, atol: x.atol ?? null, max_abs_difference: x.max_abs_difference ?? null }));
    const status: 'ok' | 'failed' | 'cancelled' = c.view.state === 'completed' ? 'ok' : c.view.state === 'cancelled' ? 'cancelled' : 'failed';
    const def = SPATIAL_TOOLS[c.tool];
    const receipt = (this.o.seal ?? ((root, r) => appendReceipt('runs', r, root)))(c.root, {
      kind: 'spatial', subject: `${c.tool}.${c.op}`, policy: 'person-or-agent-started',
      status, project: c.project, project_id: projectId(c.root),
      job: { id: c.run, kind: c.op, label: c.label, state: c.view.state, exit_code: rec?.exitCode ?? null, ...(c.view.error ? { error: c.view.error } : {}) },
      outputs,
      spatial: {
        tool: c.tool, name: def.name, version: def.version, operation: c.op, run: c.run, job: c.job, attempt: c.attempt, principal: c.principal,
        fixture: Boolean(result?.fixture), input: c.input, word: c.view.appWord, checks,
        blender: typeof result?.blender === 'string' ? result.blender : null,
        result_sha256: fileSha(join(out, 'result.json')), log_sha256: rec?.logPath ? fileSha(rec.logPath) : null,
        worker_sha256: c.tool === 'kiri' && kiriWorkerPath() ? fileSha(kiriWorkerPath()!) : null,
        ...(unhashed.length ? { not_delivered: unhashed } : {}),
        appearance_only: 'a Gaussian splat is an appearance reconstruction: not measured geometry, a watertight mesh or verified CAD',
      },
    });
    const ids = [receipt.hash.slice(7, 15)];
    writeFileSync(sealedFile, `${JSON.stringify({ ids, outputs, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { ids, outputs, note: 'sealed' };
  }
}

