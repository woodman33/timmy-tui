/**
 * The unified Workspace order (2026-10-27): the Workspace's executable operation nodes. One validated operation model for a
 * person's own edits and an agent's: an operation declares typed inputs, parameters and outputs; a run is validated first
 * (its inputs connected to compatible project files, its parameters in range) and then dispatched to the app's OWN durable
 * job through Timmy's mini-app host (the same worker, gateway secret, receipts and Files delivery the page's apps use). No new
 * execution engine: the app runs its job; this file starts it, follows it, cancels it and collects what it delivered.
 *
 *   GET  /api/workflow/operations       the operations, each with its app, ports, parameters and the adapter that routes it
 *   POST /api/workflow/validate         { op, inputs, params }: what would run, or each reason it would not (nothing starts)
 *   POST /api/workflow/runs             { op, inputs, params, board, node }: validated, then started; the run's record
 *   GET  /api/workflow/runs/:id         one run as its record says, followed now (the app's own word for its job)
 *   GET  /api/workflow/runs?board&node  the runs of a node (the current attempt marked)
 *   POST /api/workflow/runs/:id/cancel  the app is asked to cancel its job; the record keeps the app's own end word
 *   POST /api/workflow/runs/:id/recover a run whose follower this companion lost (a restart): read the app's job again
 *
 * A run's record (<TIMMY_HOME>/workflow/<project id>/runs/<id>.json, rewritten through a temp file and a rename) names the
 * operation, the node and its ATTEMPT, the inputs by path and hash, the app's job id, the state as Timmy words it from the
 * app's (queued, running, held, failed, cancelled, completed, interrupted), its progress (null when the app gives none:
 * the page shows indeterminate activity, never a made-up bar), the receipts sealed for the job and every file it delivered.
 * A newer attempt on the same node supersedes the older: the older keeps its record but is never the node's current result
 * (current-result fencing), and a still-running older attempt is asked to cancel.
 *
 * The spatial tools order (2026-10-28): an operation whose executor is 'local' is not a hosted app's job but Timmy's own
 * durable process job (src/spatial/jobs.ts on src/jobs/index.ts JobManager: Brush, KIRI in Blender; gsplat awaits an NVIDIA
 * worker). The same records, validation, supersede/fencing, follow, cancel, recover and collection apply; only the engine
 * that starts, reads, cancels and seals differs. Its receipt is Timmy's (kind `spatial`), sealed from the tool's own result.
 */
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectId } from '../project/index.js';
import { readChain } from '../utils/receipts.js';
import type { HostedApp } from './miniapps/host.js';
import { KIRI_KEEP, type SpatialExecutor } from '../spatial/jobs.js';
import type { SpatialToolId } from '../spatial/tools.js';

type Env = Record<string, string | undefined>;

// ── the operation model ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A port's type: what a display node of the Workspace carries (./display-node.jsx kinds), or a scene file. */
export type PortType = 'image' | 'video' | 'model' | 'html' | 'svg' | 'rive' | 'animate-scene' | 'splat' | 'dataset' | 'file';
export interface Port { name: string; label: string; type: PortType; required: boolean; accepts: string[] }
export interface Param { name: string; label: string; kind: 'choice' | 'number' | 'text'; choices?: string[]; min?: number; max?: number; maxLength?: number; default: string | number }
export interface OperationSpec {
  id: string; app: string; label: string; lead: string;
  inputs: Port[]; params: Param[]; outputs: Array<{ name: string; label: string; type: PortType }>;
  /** the app's own job route it dispatches to (the adapter, in words) */
  adapter: string;
  /** an operation that runs a native engine or a model on this computer (Blender, a local model): said before it runs */
  heavy?: string;
  /** who runs it: the app's own job (absent: 'app'), or Timmy's own process job ('local', a spatial tool) */
  executor?: 'app' | 'local';
  /** the spatial tool a local operation runs (src/spatial/tools.ts) */
  tool?: SpatialToolId;
}

const IMG = ['png', 'jpg', 'jpeg', 'webp'];
export const OPERATIONS: readonly OperationSpec[] = Object.freeze([
  {
    id: 'stream-studio.animate-image', app: 'stream-studio', label: 'Animate an image', lead: 'Stream Studio places the image in a 960 × 600 scene with a motion, then exports an HTML player or an SVG frame (its own export job).',
    inputs: [{ name: 'image', label: 'Image', type: 'image', required: true, accepts: IMG }],
    params: [
      { name: 'motion', label: 'Motion', kind: 'choice', choices: ['float', 'sway', 'spin', 'pulse', 'flicker', 'orbit', 'still'], default: 'float' },
      { name: 'format', label: 'Export', kind: 'choice', choices: ['html', 'svg'], default: 'html' },
      { name: 'duration', label: 'Seconds', kind: 'number', min: 1, max: 12, default: 4 },
      { name: 'title', label: 'Caption', kind: 'text', maxLength: 80, default: '' },
    ],
    outputs: [{ name: 'export', label: 'Export', type: 'html' }],
    adapter: 'Stream Studio: POST /api/assets/image, then its export job POST /api/jobs (GET /api/jobs/:id, POST /api/jobs/:id/cancel)',
  },
  {
    id: 'animate.export', app: 'animate', label: 'Export a scene with Blender', lead: 'Timmy Animate exports the scene natively with Blender (scene.blend, USD, previews) as its own job.',
    inputs: [{ name: 'scene', label: 'Scene (JSON)', type: 'animate-scene', required: true, accepts: ['json'] }],
    params: [],
    outputs: [{ name: 'artifacts', label: 'Artifacts', type: 'file' }],
    adapter: 'Timmy Animate: POST /api/jobs (GET /api/jobs/:id, POST /api/jobs/:id/cancel)',
    heavy: 'runs Blender on this computer',
  },
  // the spatial tools (2026-10-28): 3D Model Studio's splat work, run as Timmy's own jobs (src/spatial/jobs.ts)
  {
    id: 'spatial.kiri-crop-export', app: 'spatial', executor: 'local', tool: 'kiri', label: 'Crop and export a splat (KIRI in Blender)',
    lead: 'KIRI’s own importer brings the Gaussian PLY into Blender; Timmy’s bounded route keeps one side of it, saves and reopens a native .blend, exports raw Gaussian PLY and reimports it. Every coordinate and Gaussian value is compared after each step (rtol 1e-5).',
    inputs: [{ name: 'splat', label: 'Gaussian splat', type: 'splat', required: true, accepts: ['ply'] }],
    params: [{ name: 'keep', label: 'Keep', kind: 'choice', choices: Object.keys(KIRI_KEEP), default: 'all' }],
    outputs: [{ name: 'ply', label: 'Edited splat', type: 'splat' }, { name: 'blend', label: 'Native .blend', type: 'file' }],
    adapter: 'Timmy job: Blender 5.1/5.2 in the background with workers/spatial/kiri_worker.py (KIRI 5.1.0 from the spatial tools folder)',
    heavy: 'runs Blender on this computer',
  },
  {
    id: 'spatial.brush-train', app: 'spatial', executor: 'local', tool: 'brush', label: 'Reconstruct a splat (Brush)',
    lead: 'Brush trains Gaussian splats from a posed dataset (COLMAP or Nerfstudio, zipped: photographs with their cameras) and exports Gaussian PLY. It does not solve camera poses from loose photos.',
    inputs: [{ name: 'dataset', label: 'Posed dataset (.zip)', type: 'dataset', required: true, accepts: ['zip'] }],
    params: [
      { name: 'steps', label: 'Steps', kind: 'number', min: 100, max: 30000, default: 3000 },
      { name: 'max_resolution', label: 'Max image size', kind: 'choice', choices: ['512', '1024', '1920'], default: '1024' },
      { name: 'max_splats', label: 'Max splats', kind: 'choice', choices: ['100000', '250000', '1000000'], default: '250000' },
    ],
    outputs: [{ name: 'export', label: 'Gaussian splat', type: 'splat' }],
    adapter: 'Timmy job: brush 0.3.0 (the spatial tools folder) with bounded steps, size and splat count; its final export must parse',
    heavy: 'trains on this computer’s GPU (minutes to hours)',
  },
  {
    id: 'spatial.gsplat-smoke', app: 'spatial', executor: 'local', tool: 'gsplat', label: 'Check gsplat on an NVIDIA worker',
    lead: 'gsplat’s prepared check renders one synthetic Gaussian at 16 × 16 on CUDA and runs its gradients. It needs a powered NVIDIA worker.',
    inputs: [], params: [], outputs: [{ name: 'render', label: 'Fixture render', type: 'file' }],
    adapter: 'awaiting an NVIDIA worker (gsplat 1.5.3, CUDA): not runnable on this Mac',
  },
]);
export const operationOf = (id: string): OperationSpec | undefined => OPERATIONS.find((o) => o.id === id);

/** What a project file can be connected as, by its extension. */
export function portTypeOf(path: string): PortType {
  const e = (/\.([a-z0-9]+)$/i.exec(path) || [])[1]?.toLowerCase() ?? '';
  if (IMG.includes(e) || e === 'gif') return 'image';
  if (e === 'svg') return 'svg';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(e)) return 'video';
  if (e === 'glb') return 'model';
  if (['html', 'htm'].includes(e)) return 'html';
  if (e === 'riv') return 'rive';
  if (e === 'json') return 'animate-scene';
  if (e === 'ply') return 'splat';
  if (e === 'zip') return 'dataset';
  return 'file';
}
/** Whether a file can feed a port: its extension among the port's (types are words; the extension decides). */
export function compatible(port: Port, path: string): boolean {
  const e = (/\.([a-z0-9]+)$/i.exec(path) || [])[1]?.toLowerCase() ?? '';
  return port.accepts.includes(e);
}

export interface Validation { ok: boolean; problems: string[]; op?: OperationSpec; inputs: Record<string, { path: string; sha256: string; bytes: Buffer }>; params: Record<string, string | number> }

/** A run validated before anything starts: the operation, each input connected to a compatible file of the project, the parameters in range. */
export function validateRun(root: string, raw: { op?: unknown; inputs?: unknown; params?: unknown }, readFile: (root: string, rel: string) => { ok: true; rel: string; bytes: Buffer; sha256: string } | { ok: false; error: string }): Validation {
  const problems: string[] = [];
  const op = typeof raw.op === 'string' ? operationOf(raw.op) : undefined;
  const out: Validation = { ok: false, problems, inputs: {}, params: {} };
  if (!op) { problems.push(`No such operation: ${JSON.stringify(String(raw.op ?? '')).slice(0, 60)}.`); return out; }
  out.op = op;
  const given = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs as Record<string, unknown> : {};
  for (const port of op.inputs) {
    const p = given[port.name];
    if (typeof p !== 'string' || !p) { if (port.required) problems.push(`${port.label}: not connected (it takes ${port.accepts.map((x) => `.${x}`).join(', ')}).`); continue; }
    if (!compatible(port, p)) { problems.push(`${port.label}: ${p.split('/').pop()} is not one of ${port.accepts.map((x) => `.${x}`).join(', ')}.`); continue; }
    const f = readFile(root, p);
    if (!f.ok) { problems.push(`${port.label}: ${f.error}`); continue; }
    out.inputs[port.name] = { path: f.rel, sha256: f.sha256, bytes: f.bytes };
  }
  for (const k of Object.keys(given)) if (!op.inputs.some((p) => p.name === k)) problems.push(`${op.label} has no input ${JSON.stringify(k).slice(0, 40)}.`);
  const checked = checkParams(op, raw.params);
  problems.push(...checked.problems);
  out.params = checked.params;
  out.ok = problems.length === 0;
  return out;
}

/** An operation's parameters checked (each choice among its choices, each number in its range, each text within its length);
 *  a missing one takes its default. The same check for a person's run and an agent's plan. */
export function checkParams(op: OperationSpec, raw: unknown): { problems: string[]; params: Record<string, string | number> } {
  const problems: string[] = []; const out: Record<string, string | number> = {};
  const params = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  for (const prm of op.params) {
    const v = params[prm.name] ?? prm.default;
    if (prm.kind === 'choice') { if (typeof v !== 'string' || !prm.choices!.includes(v)) problems.push(`${prm.label}: choose one of ${prm.choices!.join(', ')}.`); else out[prm.name] = v; }
    else if (prm.kind === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < prm.min! || n > prm.max!) problems.push(`${prm.label}: ${prm.min}–${prm.max}.`); else out[prm.name] = n; }
    else { const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; if (t.length > (prm.maxLength ?? 200)) problems.push(`${prm.label}: at most ${prm.maxLength} characters.`); else out[prm.name] = t; }
  }
  for (const k of Object.keys(params)) if (!op.params.some((p) => p.name === k)) problems.push(`${op.label} has no parameter ${JSON.stringify(k).slice(0, 40)}.`);
  return { problems, params: out };
}

// ── the adapters: each starts, reads and cancels the app's own job ──────────────────────────────────────────────────────

export type RunState = 'queued' | 'running' | 'held' | 'failed' | 'cancelled' | 'completed' | 'interrupted';
const TERMINAL: ReadonlySet<RunState> = new Set(['failed', 'cancelled', 'completed', 'interrupted']);
export interface AppJobView { state: RunState; appWord: string; progress: number | null; error?: string }
interface Adapter {
  start(app: HostedApp, v: Validation, label: string): Promise<{ job: string } | { error: string }>;
  read(app: HostedApp, job: string): Promise<AppJobView | null>;
  cancel(app: HostedApp, job: string): Promise<void>;
}
const errOf = (r: { status: number; json: unknown }): string => `the app answered ${r.status}${r.json && typeof (r.json as { error?: unknown }).error === 'string' ? `: ${(r.json as { error: string }).error}` : ''}`;
const progressOf = (p: unknown): number | null => (typeof p === 'number' && Number.isFinite(p) && p > 0 ? Math.min(100, Math.max(0, Math.round(p))) : null);

const ADAPTERS: Record<string, Adapter> = {
  'stream-studio.animate-image': {
    async start(app, v, label) {
      const img = v.inputs.image!;
      const mime = mimeOf(img.bytes);
      if (!mime) return { error: 'the image is not a PNG, JPEG or WebP by its bytes' };
      const up = await app.request('POST', '/api/assets/image', img.bytes, { 'content-type': mime, 'x-file-name': img.path.split('/').pop()!.slice(0, 120) });
      const asset = up.json as { id?: string } | null;
      if (up.status !== 201 || !asset || typeof asset.id !== 'string') return { error: `Stream Studio did not take the image (${errOf(up)})` };
      const title = String(v.params.title || '');
      const id = `timmy-${randomBytes(4).toString('hex')}`;
      const scene = {
        schemaVersion: 1, id, name: (label || 'Animated image').slice(0, 80), width: 960, height: 600, duration: Number(v.params.duration), fps: 24, background: '#050607',
        layers: [
          { id: 'image', name: img.path.split('/').pop()!.slice(0, 60), type: 'image', x: 240, y: 90, w: 480, h: 360, rotation: 0, scaleX: 1, scaleY: 1, motion: String(v.params.motion), speed: 1, amount: 1, assetId: asset.id },
          ...(title ? [{ id: 'caption', name: 'Caption', type: 'text', x: 240, y: 480, w: 480, h: 60, rotation: 0, scaleX: 1, scaleY: 1, motion: 'still', speed: 1, amount: 1, text: title, fontSize: 32, fill: '#F1F3F5' }] : []),
        ],
      };
      const r = await app.request('POST', '/api/jobs', { scene, format: String(v.params.format), time: 0 });
      const j = r.json as { id?: string } | null;
      if (r.status !== 202 || !j || typeof j.id !== 'string') return { error: `Stream Studio did not start the export (${errOf(r)})` };
      return { job: j.id };
    },
    async read(app, job) {
      const r = await app.request('GET', `/api/jobs/${encodeURIComponent(job)}`);
      const j = r.json as { status?: string; progress?: number; error?: string } | null;
      if (r.status !== 200 || !j) return null;
      const w = String(j.status ?? 'unknown');
      const state: RunState = w === 'queued' ? 'held' : w === 'running' ? 'running' : w === 'succeeded' ? 'completed' : w === 'cancelled' ? 'cancelled' : w === 'interrupted' ? 'interrupted' : 'failed';
      return { state, appWord: w, progress: w === 'succeeded' ? 100 : progressOf(j.progress), ...(j.error ? { error: j.error } : {}) };
    },
    async cancel(app, job) { await app.request('POST', `/api/jobs/${encodeURIComponent(job)}/cancel`, {}); },
  },
  'animate.export': {
    async start(app, v) {
      let scene: unknown;
      try { scene = JSON.parse(v.inputs.scene!.bytes.toString('utf8')); } catch { return { error: 'the scene file is not JSON' }; }
      const r = await app.request('POST', '/api/jobs', { scene });
      const j = r.json as { id?: string; jobId?: string } | null;
      const id = j?.jobId ?? j?.id;
      if (r.status >= 400 || typeof id !== 'string') return { error: `Timmy Animate did not start the export (${errOf(r)})` };
      return { job: id };
    },
    async read(app, job) {
      const r = await app.request('GET', `/api/jobs/${encodeURIComponent(job)}`);
      const j = r.json as { status?: string; progress?: number; error?: string } | null;
      if (r.status !== 200 || !j) return null;
      const w = String(j.status ?? 'unknown');
      const state: RunState = w === 'queued' ? 'held' : w === 'running' ? 'running' : w === 'succeeded' ? 'completed' : w === 'cancelled' ? 'cancelled' : 'failed';
      return { state, appWord: w, progress: w === 'succeeded' ? 100 : progressOf(j.progress), ...(j.error ? { error: j.error } : {}) };
    },
    async cancel(app, job) { await app.request('POST', `/api/jobs/${encodeURIComponent(job)}/cancel`, {}); },
  },
};
function mimeOf(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ── the records ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RUN_SCHEMA = 'timmy.workflow-run/1' as const;
export interface RunRecord {
  schema: typeof RUN_SCHEMA;
  id: string; op: string; app: string; label: string;
  board: string; node: string; attempt: number;
  /** by: 'person' (a press on the node) or 'agent' (the canvas agent, under the same validation) */
  by: 'person' | 'agent';
  inputs: Record<string, { path: string; sha256: string }>;
  params: Record<string, string | number>;
  plan_sha256: string;
  state: RunState; appWord: string | null; progress: number | null; error: string | null;
  job: string | null;
  startedAt: string; endedAt: string | null;
  cancelAsked: boolean; supersededBy: string | null;
  receipts: string[];
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  /** whether the ended job's receipt was read (sealed), or why not; absent while it runs */
  collected?: string;
  /** each delivered file read back from the project after the receipt was read: its bytes hashed again and compared with the
   *  receipt's sha256 (matched), or not there (missing), or different (mismatched); absent until collected */
  readback?: { checked: number; matched: number; missing: string[]; mismatched: string[]; at: string };
  principal: string;
}
const RUN_ID = /^w[0-9a-f]{12}$/;
const runsDir = (home: string, root: string): string => join(home, 'workflow', projectId(root), 'runs');
function write(home: string, root: string, r: RunRecord): void {
  const dir = runsDir(home, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${r.id}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, `${r.id}.json`));
}
export function readRun(home: string, root: string, id: string): RunRecord | null {
  if (!RUN_ID.test(id)) return null;
  try { const r = JSON.parse(readFileSync(join(runsDir(home, root), `${id}.json`), 'utf8')) as RunRecord; return r.schema === RUN_SCHEMA ? r : null; } catch { return null; }
}
export function listRuns(home: string, root: string): RunRecord[] {
  let names: string[] = [];
  try { names = readdirSync(runsDir(home, root)).filter((n) => /^w[0-9a-f]{12}\.json$/.test(n)); } catch { return []; }
  return names.map((n) => readRun(home, root, n.slice(0, -5))).filter((r): r is RunRecord => Boolean(r)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => String(a).localeCompare(String(b)))) : x));

// ── the runner (follows each run while this companion lives) ────────────────────────────────────────────────────────────

export interface WorkflowScope { principal: string; home: string; project: { name: string; root: string } }
export interface WorkflowDeps {
  withToken: express.RequestHandler;
  withUser: express.RequestHandler;
  scopeOf: (req: express.Request) => WorkflowScope | null;
  /** the request's principal's hosted copy of an app (started when it is not running), or why not */
  appFor: (req: express.Request, appId: string) => Promise<HostedApp | { error: string; status: number }>;
  /** the request's principal's app when it is running now, or null (a cancel never starts an app) */
  runningApp: (req: express.Request, appId: string) => HostedApp | null;
  /** a project file read whole (inside the project only), with its hash */
  readFile: (root: string, rel: string) => { ok: true; rel: string; bytes: Buffer; sha256: string } | { ok: false; error: string };
  /** the spatial tools' executor (Timmy's own process jobs); absent: local operations are refused as not set up */
  spatial?: SpatialExecutor;
  /** how often a run is followed (ms) */
  everyMs?: number;
}

/** What starts, reads, cancels and seals a run's job: a hosted app's own job, or Timmy's own process job. */
export interface Engine {
  read(r: RunRecord): Promise<AppJobView | null>;
  cancel(r: RunRecord): Promise<void>;
  /** the ended job's receipts and delivered files (asked again for a while where the app seals later); `note`: 'sealed' or why not */
  collect(r: RunRecord): Promise<{ ids: string[]; outputs: RunRecord['outputs']; note: string }>;
}
export function hostedEngine(app: HostedApp, root: string, ms = 15_000): Engine {
  return {
    read: async (r) => (r.job && ADAPTERS[r.op] ? ADAPTERS[r.op]!.read(app, r.job).catch(() => null) : null),
    cancel: async (r) => { if (r.job && ADAPTERS[r.op]) await ADAPTERS[r.op]!.cancel(app, r.job); },
    collect: async (r) => {
      // the app's ended job is sealed by the host from the app's own record (its receipt names every file it delivered into
      // from-apps/); an app's API can say "ended" before its record does, so the sealing is asked again for a while
      const end = Date.now() + ms;
      let found = receiptsFor(root, r.app, r.job!);
      while (!found.ids.length && Date.now() < end) {
        await app.sealNow().catch(() => []);
        found = receiptsFor(root, r.app, r.job!);
        if (!found.ids.length) await new Promise((x) => setTimeout(x, 400));
      }
      return { ...found, note: found.ids.length ? 'sealed' : 'no receipt: the app never reported this job ended in its record' };
    },
  };
}
export function localEngine(spatial: SpatialExecutor, scope: WorkflowScope): Engine {
  const { home } = scope; const root = scope.project.root;
  const tool = (r: RunRecord): SpatialToolId => operationOf(r.op)!.tool!;
  return {
    read: async (r) => (r.job ? spatial.read(home, root, r.id, tool(r), r.job) : null),
    cancel: async (r) => { if (r.job) await spatial.cancel(home, root, r.job); },
    collect: async (r) => {
      const view = spatial.read(home, root, r.id, tool(r), r.job!) ?? { state: r.state, appWord: r.appWord ?? '', progress: null, ...(r.error ? { error: r.error } : {}) };
      const input = Object.values(r.inputs)[0] ?? null;
      return spatial.collect({ home, root, project: scope.project.name, principal: r.principal, run: r.id, op: r.op, tool: tool(r), label: r.label, attempt: r.attempt, job: r.job!, input, view });
    },
  };
}
const isLocal = (op: string): boolean => operationOf(op)?.executor === 'local';

export class WorkflowRunner {
  private followers = new Map<string, NodeJS.Timeout>();
  private collecting = new Set<string>();
  constructor(private readonly everyMs = 700) {}
  following(id: string): boolean { return this.followers.has(id); }
  /** whether this companion is collecting a completed run's receipts now */
  isCollecting(id: string): boolean { return this.collecting.has(id); }
  stopAll(): void { for (const t of this.followers.values()) clearInterval(t); this.followers.clear(); }
  follow(scope: WorkflowScope, id: string, engine: Engine): void {
    if (this.followers.has(id)) return;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return; busy = true;
      try {
        const r = readRun(scope.home, scope.project.root, id);
        if (!r || !r.job || TERMINAL.has(r.state)) { this.unfollow(id); return; }
        const v = await engine.read(r).catch(() => null);
        if (!v) return;
        // (read again after the engine answered: another request may have written the record meanwhile — a supersede, a
        // cancel — and only the follower's own fields are written over it)
        const now = readRun(scope.home, scope.project.root, id) ?? r;
        const next: RunRecord = { ...now, state: v.state, appWord: v.appWord, progress: v.progress, error: v.error ?? now.error };
        if (TERMINAL.has(v.state)) {
          next.endedAt = new Date().toISOString();
          this.unfollow(id);
          write(scope.home, scope.project.root, next);
          void this.collect(scope, id, engine);
          return;
        }
        write(scope.home, scope.project.root, next);
      } finally { busy = false; }
    };
    this.followers.set(id, setInterval(() => { void tick(); }, this.everyMs));
    void tick();
  }
  /** Seals the ended job and records its receipts and delivered files. */
  async collect(scope: WorkflowScope, id: string, engine: Engine): Promise<void> {
    if (this.collecting.has(id)) return;
    this.collecting.add(id);
    try {
      const r0 = readRun(scope.home, scope.project.root, id);
      if (!r0 || !r0.job) return;
      const found = await engine.collect(r0).catch((e: unknown) => ({ ids: [] as string[], outputs: [] as RunRecord['outputs'], note: `not collected: ${e instanceof Error ? e.message : String(e)}` }));
      const r = readRun(scope.home, scope.project.root, id);
      if (r) write(scope.home, scope.project.root, { ...r, receipts: found.ids, outputs: found.outputs, collected: found.ids.length ? 'sealed' : found.note, ...(found.ids.length ? { readback: readBack(scope.project.root, found.outputs) } : {}) } as RunRecord);
    } finally { this.collecting.delete(id); }
  }
  private unfollow(id: string): void { const t = this.followers.get(id); if (t) clearInterval(t); this.followers.delete(id); }
}

/** The receipts sealed for an app's job in this project, and every file they name as delivered (newest receipt last). */
/** The delivered files read back from the project: each hashed again and compared with what its receipt says. */
export function readBack(root: string, outputs: RunRecord['outputs']): NonNullable<RunRecord['readback']> {
  const out = { checked: outputs.length, matched: 0, missing: [] as string[], mismatched: [] as string[], at: new Date().toISOString() };
  const base = resolve(root);
  for (const o of outputs) {
    const abs = resolve(base, o.path);
    if (!abs.startsWith(base + sep)) { out.missing.push(o.path); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(abs); } catch { out.missing.push(o.path); continue; }
    if (createHash('sha256').update(bytes).digest('hex') === o.sha256) out.matched += 1; else out.mismatched.push(o.path);
  }
  return out;
}

export function receiptsFor(root: string, app: string, job: string): { ids: string[]; outputs: RunRecord['outputs'] } {
  let chain: ReturnType<typeof readChain> = [];
  try { chain = readChain('runs', root); } catch { return { ids: [], outputs: [] }; }
  const mine = chain.filter((r) => r.kind === 'miniapp' && r.miniapp?.app === app && (r.job?.id === job || String(r.job?.id ?? '').startsWith(`${job}/`)));
  const outputs = new Map<string, RunRecord['outputs'][number]>();
  for (const r of mine) for (const o of r.outputs ?? []) if (typeof o.path === 'string' && /^from-apps\//.test(o.path)) outputs.set(o.path, { path: o.path, sha256: String(o.sha256), bytes: Number(o.bytes ?? 0) });
  return { ids: mine.map((r) => r.hash.slice(7, 15)), outputs: [...outputs.values()] };
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function mountWorkflowOps(app: express.Express, deps: WorkflowDeps): WorkflowRunner {
  const runner = new WorkflowRunner(deps.everyMs);
  const json = express.json({ limit: '32kb' });
  const scoped = (h: (req: express.Request, res: express.Response, s: WorkflowScope) => Promise<void> | void, body = false): express.RequestHandler[] => [deps.withToken, deps.withUser, ...(body ? [json] : []), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = deps.scopeOf(req);
    if (!s) { res.status(404).json({ ok: false, error: 'No project is open for this page, so no workflow can run in it.' }); return; }
    try { await h(req, res, s); } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }];
  const view = (s: WorkflowScope, r: RunRecord) => ({ ...r, following: runner.following(r.id), current: !r.supersededBy, terminal: TERMINAL.has(r.state) });
  /** why a local operation cannot start here now, or null */
  const localRefusal = (op: OperationSpec): string | null => (!deps.spatial ? 'the spatial tools are not set up in this companion' : deps.spatial.refusal(op.tool!));
  /** the engine that answers for a run now without starting anything: a local job's, or its app's when the app runs */
  const engineNow = (req: express.Request, s: WorkflowScope, r: RunRecord): Engine | null => {
    if (isLocal(r.op)) return deps.spatial ? localEngine(deps.spatial, s) : null;
    const hosted = deps.runningApp(req, r.app);
    return hosted ? hostedEngine(hosted, s.project.root) : null;
  };

  app.get('/api/workflow/operations', ...scoped((_req, res) => {
    // a local operation says whether it can run here now (its tool installed, its Blender found, a CUDA worker), and why not
    const operations = OPERATIONS.map((o) => (o.executor === 'local' ? { ...o, available: (() => { const why = localRefusal(o); return why ? { ok: false, why } : { ok: true, why: null }; })() } : o));
    res.json({ ok: true, operations, ports: { image: IMG } });
  }));
  app.post('/api/workflow/validate', ...scoped((req, res, s) => {
    const v = validateRun(s.project.root, req.body ?? {}, deps.readFile);
    res.json({ ok: v.ok, problems: v.problems, op: v.op?.id ?? null, inputs: Object.fromEntries(Object.entries(v.inputs).map(([k, x]) => [k, { path: x.path, sha256: x.sha256 }])), params: v.params });
  }, true));
  app.get('/api/workflow/runs', ...scoped((req, res, s) => {
    const board = typeof req.query.board === 'string' ? req.query.board : null;
    const node = typeof req.query.node === 'string' ? req.query.node : null;
    const runs = listRuns(s.home, s.project.root).filter((r) => r.principal === s.principal && (!board || r.board === board) && (!node || r.node === node));
    res.json({ ok: true, runs: runs.slice(0, 50).map((r) => view(s, r)) });
  }));
  app.post('/api/workflow/runs', ...scoped(async (req, res, s) => {
    const b = (req.body ?? {}) as { op?: unknown; inputs?: unknown; params?: unknown; board?: unknown; node?: unknown; label?: unknown; by?: unknown };
    const board = typeof b.board === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(b.board) ? b.board : null;
    // a node is a canvas shape, or the Control Room's own place for an app's operation (control:<operation>, board control-room)
    const node = typeof b.node === 'string' && (/^shape:[\w-]{1,80}$/.test(b.node) || (board === 'control-room' && /^control:[\w.-]{1,80}$/.test(b.node))) ? b.node : null;
    if (!board || !node) { res.status(400).json({ ok: false, error: 'A run names its board and its node.' }); return; }
    const v = validateRun(s.project.root, b, deps.readFile);
    if (!v.ok || !v.op) { res.status(422).json({ ok: false, refused: 'invalid', problems: v.problems, error: v.problems.join(' ') }); return; }
    const local = v.op.executor === 'local';
    let hosted: HostedApp | null = null;
    if (local) {
      const why = localRefusal(v.op);
      if (why) { res.status(409).json({ ok: false, refused: 'setup', error: why }); return; }
    } else {
      const h = await deps.appFor(req, v.op.app);
      if ('error' in h) { res.status(h.status).json({ ok: false, refused: 'setup', error: h.error }); return; }
      hosted = h;
    }
    const engineOf = (r: RunRecord): Engine | null => (isLocal(r.op) ? (deps.spatial ? localEngine(deps.spatial, s) : null) : hosted && r.app === v.op!.app ? hostedEngine(hosted, s.project.root) : engineNow(req, s, r));
    // the node's earlier attempts: superseded (a still-running one asked to cancel); this run is the current one
    const earlier = listRuns(s.home, s.project.root).filter((r) => r.principal === s.principal && r.board === board && r.node === node);
    const attempt = earlier.reduce((m, r) => Math.max(m, r.attempt), 0) + 1;
    const id = `w${randomBytes(6).toString('hex')}`;
    for (const r of earlier) if (!r.supersededBy) {
      write(s.home, s.project.root, { ...r, supersededBy: id });
      if (!TERMINAL.has(r.state) && r.job) { const e = engineOf(r); if (e) await e.cancel(r).catch(() => undefined); write(s.home, s.project.root, { ...readRun(s.home, s.project.root, r.id)!, cancelAsked: true }); }
    }
    const label = typeof b.label === 'string' ? b.label.replace(/\s+/g, ' ').trim().slice(0, 80) : v.op.label;
    const inputs = Object.fromEntries(Object.entries(v.inputs).map(([k, x]) => [k, { path: x.path, sha256: x.sha256 }]));
    const rec: RunRecord = {
      schema: RUN_SCHEMA, id, op: v.op.id, app: v.op.app, label, board, node, attempt, by: b.by === 'agent' ? 'agent' : 'person',
      inputs, params: v.params, plan_sha256: createHash('sha256').update(canon({ op: v.op.id, inputs, params: v.params })).digest('hex'),
      state: 'queued', appWord: null, progress: null, error: null, job: null,
      startedAt: new Date().toISOString(), endedAt: null, cancelAsked: false, supersededBy: null, receipts: [], outputs: [], principal: s.principal,
    };
    write(s.home, s.project.root, rec);
    const first = Object.entries(v.inputs)[0];
    const started = local
      ? deps.spatial!.start({ home: s.home, root: s.project.root, project: s.project.name, principal: s.principal, run: id, op: v.op.id, tool: v.op.tool!, label, input: first ? { name: first[0], ...first[1] } : null, params: v.params })
      : await ADAPTERS[v.op.id]!.start(hosted!, v, label).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    if ('error' in started) {
      const failed: RunRecord = { ...rec, state: 'failed', error: started.error, endedAt: new Date().toISOString() };
      write(s.home, s.project.root, failed);
      res.status(502).json({ ok: false, refused: local ? 'tool' : 'app', error: started.error, run: view(s, failed) });
      return;
    }
    const running: RunRecord = { ...rec, job: started.job, state: 'running' };
    write(s.home, s.project.root, running);
    runner.follow(s, id, local ? localEngine(deps.spatial!, s) : hostedEngine(hosted!, s.project.root));
    res.json({ ok: true, run: view(s, running) });
  }, true));
  app.get('/api/workflow/runs/:id', ...scoped((req, res, s) => {
    const r = readRun(s.home, s.project.root, String(req.params.id));
    if (!r || r.principal !== s.principal) { res.status(404).json({ ok: false, error: 'No such run in this project.' }); return; }
    // a run that is not terminal and that no follower here follows was left by an earlier companion: interrupted, Recover reads it
    // again; so is a completed run whose receipts no collection here is reading (the companion stopped while it collected)
    const left = (!TERMINAL.has(r.state) && !runner.following(r.id)) || (r.state === 'completed' && Boolean(r.job) && !r.collected && !runner.isCollecting(r.id));
    res.json({ ok: true, run: { ...view(s, r), ...(left ? { left: true } : {}) } });
  }));
  app.post('/api/workflow/runs/:id/cancel', ...scoped(async (req, res, s) => {
    const r = readRun(s.home, s.project.root, String(req.params.id));
    if (!r || r.principal !== s.principal) { res.status(404).json({ ok: false, error: 'No such run in this project.' }); return; }
    if (TERMINAL.has(r.state) || !r.job) { res.status(409).json({ ok: false, error: `The run has ended (${r.state}); nothing to cancel.` }); return; }
    const engine = engineNow(req, s, r);
    if (!engine) { res.status(409).json({ ok: false, error: isLocal(r.op) ? 'The spatial tools are not set up in this companion.' : 'The app that runs this job is not running here: Recover reads what it left.' }); return; }
    // the cancel is recorded first (the node shows it at once), then the engine stops the job: a local job's whole process group
    write(s.home, s.project.root, { ...readRun(s.home, s.project.root, r.id)!, cancelAsked: true });
    await engine.cancel(r);
    runner.follow(s, r.id, engine);
    res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) });
  }));
  app.post('/api/workflow/runs/:id/recover', ...scoped(async (req, res, s) => {
    const r = readRun(s.home, s.project.root, String(req.params.id));
    if (!r || r.principal !== s.principal) { res.status(404).json({ ok: false, error: 'No such run in this project.' }); return; }
    let engine: Engine | null;
    if (isLocal(r.op)) engine = deps.spatial ? localEngine(deps.spatial, s) : null;
    else if (r.job && !(TERMINAL.has(r.state) && r.state !== 'completed')) {
      // the app is opened (its record of the job survives a restart of Timmy): its own word for the job is read again
      const hosted = await deps.appFor(req, r.app);
      if ('error' in hosted) { res.status(hosted.status).json({ ok: false, error: hosted.error }); return; }
      engine = hostedEngine(hosted, s.project.root);
    } else engine = null;
    // a completed run left uncollected: its receipts read (the app's watcher seals what its record says ended; a local
    // job's own result is judged and sealed once)
    if (r.state === 'completed' && r.job && !r.collected) {
      if (!engine) { res.status(409).json({ ok: false, error: 'Nothing here can collect this run now.' }); return; }
      void runner.collect(s, r.id, engine);
      res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) });
      return;
    }
    if (TERMINAL.has(r.state)) { res.json({ ok: true, run: view(s, r) }); return; }
    if (!r.job) { write(s.home, s.project.root, { ...r, state: 'interrupted', error: 'The job never started (no job id).', endedAt: new Date().toISOString() }); res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) }); return; }
    if (!engine) { res.status(409).json({ ok: false, error: 'The spatial tools are not set up in this companion.' }); return; }
    const v = await engine.read(r).catch(() => null);
    if (!v) { write(s.home, s.project.root, { ...r, state: 'interrupted', error: isLocal(r.op) ? 'Timmy has no record of this job any more.' : 'The app no longer knows this job (it was not kept across its restart).', endedAt: new Date().toISOString() }); res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) }); return; }
    if (TERMINAL.has(v.state)) {
      // ended while no companion followed it (a local job's own result decides; never re-run): recorded, then collected
      write(s.home, s.project.root, { ...r, state: v.state, appWord: v.appWord, progress: v.progress, error: v.error ?? r.error, endedAt: new Date().toISOString() });
      void runner.collect(s, r.id, engine);
      res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) });
      return;
    }
    write(s.home, s.project.root, { ...r, state: v.state, appWord: v.appWord, progress: v.progress });
    runner.follow(s, r.id, engine);
    res.json({ ok: true, run: view(s, readRun(s.home, s.project.root, r.id)!) });
  }));
  return runner;
}

export type { Env };
