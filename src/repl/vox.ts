/**
 * Timmy VoxVision in the REPL (round R4, helper H49): four actions over the spatial tools Timmy supports.
 *
 *   /inspect <file>            what the file is (its kind by its bytes, its size and sha256) and its facts from the tool
 *                              that reads it: Look for an image, Timmy's own reader for an STL, OCP for a STEP, a second
 *                              pass by Blender for a .blend, ffprobe for a video, the spatial module for a splat PLY
 *   /measure <file> [what]     the measured values, each with its method, its tier and who measured it
 *   /detect <image|video> …    QR codes and ArUco markers (Look); a colour region's centroid and box in an image (Look)
 *                              or in a video's frames at given times (the video readback); Roboflow only with its key
 *   /compare <a> <b> …         two files of the same kind: Look side by side with a pixel difference (images), bounding
 *                              box, volume and area deltas (meshes, STEP), the geo lane's score (point clouds, a = the
 *                              truth), probe facts and sampled centroids (videos)
 *
 * Each action that needs a worker runs it as a Timmy job (an id, /jobs, /stop, a log) and keeps the job's output as it
 * came (.timmy/vox/<id>/); the STL reader and the spatial module run in Timmy's own process, said as such. Every action
 * writes results/vox/<id>.json (timmy.vox/1, src/vox/record.ts) with its highlight files beside it (results/vox/<id>/,
 * each with its sha256), and seals one `vox` receipt over the record's bytes and the highlights'. A missing tool is a
 * "needs setup" row with its exact step, never a value. DOCTRINE §15 goes with every CAD or mesh result.
 *
 * Round R4 (H61): every value and highlight carries one status word (src/vox/words.ts: CAD checked, measured, estimated,
 * model prediction, stale, unknown), shown first in the lines below, the tier and method kept as the advanced detail;
 * generated CAD is checked against its source's own report or prediction (src/vox/sources.ts); each input names its
 * frame, and a compare draws its two together only in a shared known frame and unit (src/vox/frames.ts), else says why.
 * `/vox view <record id> [rerun]` opens a record's files in Rerun's viewer (src/repl/vox-view.ts).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseVideoReadback, VIDEO_READBACK_MAX_OUTPUT, VIDEO_READBACK_SCRIPT, VIDEO_READBACK_TIMEOUT_MS, type VideoReadback } from '../flows/iterate-ae.js';
import { BLEND_READBACK_MAX_OUTPUT, BLEND_READBACK_SCRIPT, BLEND_READBACK_TIMEOUT_MS, parseBlendReadback } from '../flows/iterate-blender.js';
import { parseReadbackOutput, READBACK_MAX_OUTPUT, READBACK_SCRIPT, READBACK_TIMEOUT_MS, type ReadbackMeasured } from '../flows/iterate.js';
import type { JobManager, JobRecord, JobSpec } from '../jobs/index.js';
import { readStlFile, STL_READBACK, type StlReadback } from '../native/stl-readback.js';
import { projectId, resolveInside, writeProjectFile } from '../project/index.js';
import { hashFile, splitArgs } from '../project/intake.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { Receipt, ReceiptInput } from '../utils/receipts.js';
import { checkOpenCv, LOOK_MAX_OUTPUT, LOOK_SCRIPT, LOOK_TIMEOUT_MS, lookEnv, parseLookOutput, type LookObservation } from '../vision/look.js';
import { buildGaussianPlyContext } from '../vision/spatial/gaussian-ply-context.js';
import { headBytes, KIND_WORDS, voxKindOf, type VoxKind, type VoxTool } from '../vox/kinds.js';
import {
  DOCTRINE_15, geoStatus, isGeometry, LABEL, newVoxId, receiptStatus, settleStatus, TIER, VOX_SCHEMA, voxHighlightDir, voxRawDir, voxRecordPath,
  type VoxAction, type VoxFailure, type VoxHighlight, type VoxInput, type VoxMetric, type VoxRecord, type VoxToolRun,
} from '../vox/record.js';
import { bboxSvg } from '../vox/svg.js';
import {
  blendMetrics, blendReady, colorRegionMetric, deltaMetrics, differenceMetric, GEO_SCRIPT, geoMetrics, geoReady, IMAGE_SELECT, lookBy, lookMetrics, lookReady,
  plyHeaderMetrics, ROBOFLOW_BRIDGE, roboflowClaims, roboflowReady, SETUP, splatMetrics, stepMetrics, stepReady, stlMetrics, valueWords, videoMetrics, videoReady,
  videoSampleMetrics, type ToolEnv,
} from '../vox/tools.js';
// R4 (H51): each record names the operation (one request) that started its action.
import { operationField } from '../ops/context.js';
// R4 (H61): the status word of every value and highlight, each input's frame, the checks of generated CAD against its
// source's own report or prediction, and /vox view (Rerun's viewer, src/repl/vox-view.ts).
import { settleWords, wordText, type VoxWord } from '../vox/words.js';
import { apart, blendFrame, frameFromRecord, imageFrame, noFrame, plyFrame, stepFrame, stlFrame, together, videoFrame, type VoxFrame } from '../vox/frames.js';
import { checkWords, flowPredictionCheck, scadSummaryCheck } from '../vox/sources.js';
import { voxArg } from '../vox/args.js';
import { voxCommand } from './vox-view.js';

type Line = Segment[];

export interface VoxDeps {
  glyphs: GlyphSet;
  /** The REPL's environment, read at each action. */
  env: () => NodeJS.ProcessEnv;
  onPath: (cmd: string) => string | null;
  notify: (line: Line) => void;
  seal: (input: ReceiptInput) => string | undefined;
  jobs: JobManager;
  /** Starts a job as this REPL's own (/stop and /stop all reach it); `selfSealed`: VoxVision seals its own receipt. */
  startJob: (spec: JobSpec, o?: { selfSealed?: boolean }) => JobRecord;
  /** Writes the project's folder as "." and the home folder as "~". */
  scrub: (text: string, root: string) => string;
  /** R4 (H61): the runs chain, read when an action checks generated CAD against its source and when /vox view checks a record; absent: none */
  receipts?: () => readonly Receipt[];
}

export const VOX_USAGE: Readonly<Record<VoxAction, string>> = {
  inspect: '/inspect <file>   what it is (by its bytes) and its facts from the tool that reads it',
  measure: '/measure <file> [what]   measured values with method, tier and who measured them; for an image, [what] is size, color, sharpness, edges, qr or aruco',
  detect: '/detect <image|video> [qr] [aruco] [color r,g,b] [--at t,…] [--tolerance n] [roboflow <project>/<version>]',
  compare: '/compare <a> <b> [--voxel n] [--tau n] [--normalize] [--fit] [--color r,g,b --at t,…]   two files of the same kind; a is the reference (the truth, for point clouds)',
};

/** The most times a video detect samples, and the most a record lists of a long list. */
const MAX_TIMES = 12;
const MAX_INPUT_BYTES = 2 * 1024 ** 3;
const OUTPUT_KEEP = 60_000;
const GEO_TIMEOUT_MS = 600_000;
const GEO_MAX_OUTPUT = 4 * 1024 * 1024;
const ROBOFLOW_TIMEOUT_MS = 300_000;
/** Runs the unchanged Roboflow bridge with its JSON request on stdin (a job's stdin is not written): the request is in TIMMY_ROBOFLOW_REQUEST. */
const ROBOFLOW_LAUNCHER = "import io, os, runpy, sys; sys.stdin = io.StringIO(os.environ['TIMMY_ROBOFLOW_REQUEST']); bridge = sys.argv[1]; sys.argv = [bridge]; runpy.run_path(bridge, run_name='__main__')";

interface Opts {
  qr?: boolean; aruco?: boolean; color?: [number, number, number]; at?: number[]; tolerance?: number;
  voxel?: number; tau?: number; normalize?: boolean; fit?: boolean; roboflow?: string; what?: string[];
}
interface Resolved { input: VoxInput; abs: string }
interface Op {
  id: string; action: VoxAction; root: string; project: string; command: string; opts: Opts;
  inputs: Resolved[]; record: VoxRecord; abort: AbortController; jobs: JobRecord[];
  first: (j: JobRecord | null) => void;
}

/** R4 (H61): an input's frame, as the tool that read it found it (set once; the rest are told from the record at the end). */
function setFrame(r: Resolved, frame: VoxFrame): void { r.input.frame ??= frame; }
/** R4 (H61): the line a status word is shown on: its word, and what it rests on. */
const WORD_ROLE: Readonly<Record<VoxWord, Segment['role']>> = { 'CAD checked': undefined, measured: undefined, estimated: undefined, 'model prediction': undefined, stale: 'estimate', unknown: undefined };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const short = (h?: string): string => (h ? `${h.slice(0, 12)}…` : 'none');
/** A project path written so splitArgs reads it back exactly (src/vox/args.ts since R4 H61; exported here as before). */
export { voxArg };

/** A parsed command line, or why it cannot be read. */
export function parseVoxArgs(action: VoxAction, args: string): { files: string[]; opts: Opts } | { error: string } {
  const words = splitArgs(args.trim());
  const files: string[] = [];
  const opts: Opts = {};
  const usage = { error: `Usage: ${VOX_USAGE[action]}` };
  const number = (w: string | undefined): number | undefined => (w !== undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(w) ? Number(w) : undefined);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = (): string | undefined => words[++i];
    if (action === 'detect' && (w === 'qr' || w === 'aruco') && files.length) { opts[w] = true; continue; }
    if ((action === 'detect' || action === 'compare') && (w === 'color' || w === 'colour' || w === '--color' || w === '--colour') && files.length) {
      const c = next();
      const m = c?.match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
      if (!m || m.slice(1).some((x) => Number(x) > 255)) return { error: 'A colour is r,g,b: three whole numbers from 0 to 255, such as color 255,0,0' };
      opts.color = [Number(m[1]), Number(m[2]), Number(m[3])];
      continue;
    }
    if ((action === 'detect' || action === 'compare') && w === '--at') {
      const list = (next() ?? '').split(',').map((x) => number(x.trim()));
      if (!list.length || list.length > MAX_TIMES || list.some((x) => x === undefined || x < 0)) return { error: `--at takes up to ${MAX_TIMES} times in seconds, comma-separated, such as --at 0,1.5` };
      opts.at = list as number[];
      continue;
    }
    if (action === 'detect' && w === '--tolerance') {
      const t = number(next());
      if (t === undefined || t < 0 || t > 442) return { error: '--tolerance is a distance in 8-bit RGB from 0 to 442 (the default is 48)' };
      opts.tolerance = t;
      continue;
    }
    if (action === 'detect' && w === 'roboflow' && files.length) {
      const model = next();
      if (!model || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/\d{1,4}$/.test(model)) return { error: 'roboflow takes a model as <project>/<version>, such as roboflow cards/3' };
      opts.roboflow = model;
      continue;
    }
    if (action === 'compare' && (w === '--voxel' || w === '--tau')) {
      const v = number(next());
      if (v === undefined || !(v > 0)) return { error: `${w} takes a positive number (in the clouds' own unit)` };
      opts[w === '--voxel' ? 'voxel' : 'tau'] = v;
      continue;
    }
    if (action === 'compare' && (w === '--normalize' || w === '--fit')) { opts[w === '--fit' ? 'fit' : 'normalize'] = true; continue; }
    if (w.startsWith('--')) return usage;
    if (action === 'measure' && files.length === 1) { (opts.what ??= []).push(w.toLowerCase()); continue; }
    files.push(w);
  }
  const want = action === 'compare' ? 2 : 1;
  if (files.length !== want) return usage;
  return { files, opts };
}

export class VoxActions {
  /** The actions under way, by record id: each settles once its record and receipt are made. */
  private readonly running = new Map<string, { op: Op; done: Promise<Line[]> }>();

  constructor(private readonly d: VoxDeps) {}

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }
  private toolEnv(root: string): ToolEnv { return { env: this.d.env(), onPath: this.d.onPath, root }; }

  /** /stop all and the REPL's end: no action starts its next step. */
  abortAll(): number {
    for (const r of this.running.values()) r.op.abort.abort();
    return this.running.size;
  }

  /** Waits (at most `ms`) for every action under way to write its record. */
  async settle(ms = 20_000): Promise<void> {
    const all = Promise.allSettled([...this.running.values()].map((r) => r.done));
    await Promise.race([all, new Promise((r) => { setTimeout(r, ms).unref?.(); })]);
  }

  /** The record ids of the actions under way in a project. */
  runningIn(root: string): string[] { return [...this.running.values()].filter((r) => r.op.root === root).map((r) => r.op.id); }

  /** R4 (H61): `/vox` (its usage and the viewer layers) and `/vox view <record id> [rerun]` (src/repl/vox-view.ts). */
  vox(args: string, at: { root: string; project: string }): Promise<Line[]> {
    return voxCommand({
      glyphs: this.d.glyphs, env: this.d.env, onPath: this.d.onPath, seal: this.d.seal, scrub: this.d.scrub,
      receipts: () => this.chain(), running: (root) => this.runningIn(root),
    }, args, at);
  }

  /** R4 (H61): the runs chain now (none when it cannot be read). */
  private chain(): readonly Receipt[] {
    try { return this.d.receipts?.() ?? []; } catch { return []; }
  }

  /** `/inspect`, `/measure`, `/detect`, `/compare`: starts the action; with a job, its end arrives as a notice. */
  async command(action: VoxAction, args: string, at: { root: string; project: string }): Promise<Line[]> {
    const parsed = parseVoxArgs(action, args);
    if ('error' in parsed) return this.say(parsed.error);
    const resolved: Resolved[] = [];
    for (const [i, f] of parsed.files.entries()) {
      const r = this.resolve(at.root, f, action === 'compare' ? (i === 0 ? 'a' : 'b') : undefined);
      if ('error' in r) return this.say(r.error, 'failure');
      resolved.push(r);
    }
    const refused = this.refuse(action, resolved, parsed.opts);
    if (refused) return this.say(refused, 'estimate');
    const id = newVoxId(at.root);
    const command = `/${action} ${[...resolved.map((r) => voxArg(r.input.path) ?? r.input.path), ...optionWords(action, parsed.opts)].join(' ')}`;
    const record: VoxRecord = {
      schema: VOX_SCHEMA, id, action, command, made_at: new Date().toISOString(), project: at.project, status: 'ok',
      ...operationField('vox', id), // R4 (H51): the request that started it
      inputs: resolved.map((r) => r.input), tools: [], metrics: [], highlights: [], failures: [], notes: [],
      ...(resolved.some((r) => isGeometry(r.input.kind)) ? { doctrine: DOCTRINE_15 } : {}),
    };
    let first!: (j: JobRecord | null) => void;
    const started = new Promise<JobRecord | null>((r) => { first = r; });
    const op: Op = { id, action, root: at.root, project: at.project, command, opts: parsed.opts, inputs: resolved, record, abort: new AbortController(), jobs: [], first };
    const done = this.execute(op).finally(() => { this.running.delete(id); first(null); });
    this.running.set(id, { op, done });
    const job = await started;
    if (!job) return done;
    const r = resolved.map((x) => `${x.input.path} (${KIND_WORDS[x.input.kind]}, by its ${x.input.kind_by})`).join(' and ');
    return [
      [{ text: '  VoxVision  ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  ${action} ${r}`, role: 'secondary' }],
      [{ text: '  Job        ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  ${this.d.scrub(job.label, at.root)}${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }],
      [{ text: '  Record     ', role: 'secondary' }, { text: `${voxRecordPath(id)} when it ends, with a vox receipt${this.sep}/board shows it`, role: 'secondary' }],
    ];
  }

  /** A project file as an input: inside the project, a regular file, its kind by its bytes, its sha256. */
  private resolve(root: string, rel: string, role?: 'a' | 'b'): Resolved | { error: string } {
    const at = resolveInside(root, rel);
    if ('error' in at) return { error: at.error };
    let bytes: number;
    try {
      const st = statSync(at.path);
      if (!st.isFile()) return { error: `${at.rel} is not a file` };
      if (st.size > MAX_INPUT_BYTES) return { error: `${at.rel} is larger than 2 GB, more than VoxVision reads` };
      bytes = st.size;
    } catch { return { error: `${at.rel} does not exist` }; }
    const k = voxKindOf(at.rel, headBytes(at.path));
    let sha256: string;
    try { sha256 = hashFile(at.path); } catch { return { error: `${at.rel} cannot be read` }; }
    return { abs: at.path, input: { path: at.rel, sha256, bytes, kind: k.kind, kind_by: k.by, ...(role ? { role } : {}), ...(k.note ? { note: k.note } : {}) } };
  }

  /** Why an action cannot run on these inputs at all (nothing is written then), or undefined. */
  private refuse(action: VoxAction, r: Resolved[], o: Opts): string | undefined {
    const kinds = r.map((x) => x.input.kind);
    const reads = 'VoxVision reads images, STL, STEP, .blend, videos and PLY point clouds';
    if (action === 'measure' || action === 'detect') {
      if (kinds[0] === 'other') return `${r[0].input.path} is ${r[0].input.note ?? `not a kind VoxVision reads (by its ${r[0].input.kind_by})`}: ${reads}.`;
    }
    if (action === 'measure' && o.what?.length) {
      if (kinds[0] !== 'image') return `/measure <file> [what] selects only for an image; ${r[0].input.path} is measured whole.`;
      const unknown = o.what.filter((w) => !IMAGE_SELECT[w]);
      if (unknown.length) return `Not a measurement of an image: ${unknown.join(', ')}. One of: size, color, sharpness, edges, qr, aruco.`;
    }
    if (action === 'detect') {
      if (kinds[0] !== 'image' && kinds[0] !== 'video') return `/detect reads images and videos; ${r[0].input.path} is ${KIND_WORDS[kinds[0]]}. /measure it instead.`;
      if (kinds[0] === 'video' && !o.color) return `In a video /detect finds a colour region: /detect ${voxArg(r[0].input.path) ?? r[0].input.path} color r,g,b [--at t,…] (QR codes and markers are found in images).`;
      if (kinds[0] === 'video' && (o.qr || o.aruco || o.roboflow)) return 'QR codes, ArUco markers and Roboflow are read in images; in a video /detect finds a colour region.';
      if (kinds[0] === 'image' && o.at) return '--at names times in a video; an image has one frame.';
    }
    if (action === 'compare') {
      if (r[0].input.path === r[1].input.path) return '/compare needs two different files.';
      // R4 (H61): and why by their frames: an STL and a STEP share no known unit; a video and an image share no frame.
      if (kinds[0] !== kinds[1]) return `/compare needs two files of the same kind: ${r[0].input.path} is ${KIND_WORDS[kinds[0]]}, ${r[1].input.path} is ${KIND_WORDS[kinds[1]]}.${kinds.includes('other') ? '' : ` ${apart(kinds[0], kinds[1])}`}`;
      if (kinds[0] === 'other') return `${reads}; these are not one of them.`;
      if (kinds[0] === 'blend') return 'Two .blend files are not compared here: /measure each (a second pass by Blender) and read their object sizes side by side.';
      if (kinds[0] !== 'ply' && (o.voxel !== undefined || o.tau !== undefined || o.normalize || o.fit)) return '--voxel, --tau, --normalize and --fit are the geo lane\'s, for two PLY point clouds.';
      if (kinds[0] !== 'video' && (o.color || o.at)) return '--color and --at sample two videos at the same times.';
      if (kinds[0] === 'video' && (o.at && !o.color)) return '--at needs --color: the colour whose region is sampled at those times.';
    }
    return undefined;
  }

  // ── the actions ───────────────────────────────────────────────────────────────

  private async execute(op: Op): Promise<Line[]> {
    const k = op.inputs[0].input.kind;
    try {
      if (op.action === 'inspect') this.intake(op);
      if (k === 'other') {
        for (const r of op.inputs) setFrame(r, noFrame());
        op.record.failures.push({ tool: 'intake', code: 'unsupported', message: `${op.inputs[0].input.note ?? 'not a kind VoxVision reads'}: no supported tool reads it, so only what its bytes say is recorded` });
      } else if (op.action === 'compare') {
        if (k === 'image') await this.lookDiff(op);
        else if (k === 'stl') this.stlCompare(op);
        else if (k === 'step') await this.stepCompare(op);
        else if (k === 'video') await this.videoCompare(op);
        else if (k === 'ply') await this.geoCompare(op);
      } else if (k === 'image') {
        await this.lookDetect(op);
        if (op.opts.roboflow) await this.roboflow(op);
      } else if (k === 'stl') this.stlRead(op);
      else if (k === 'step') await this.stepRead(op, op.inputs[0]);
      else if (k === 'blend') await this.blendRead(op);
      else if (k === 'video') await this.videoRead(op, op.inputs[0], op.action === 'detect');
      else if (k === 'ply') this.plyRead(op);
    } catch (e) {
      op.record.failures.push({ tool: 'intake', code: 'failed', message: this.d.scrub(`VoxVision could not finish the action: ${e instanceof Error ? e.message : String(e)}`, op.root) });
    }
    return this.finish(op);
  }

  /** /inspect: what the bytes say, read by Timmy: the kind, the size, the sha256. */
  private intake(op: Op): void {
    for (const r of op.inputs) {
      const base = { tier: TIER.computed, label: LABEL.intake, measured_by: 'Timmy (src/vox/kinds.ts, src/project/intake.ts)' };
      op.record.metrics.push(
        { name: 'file_kind', title: 'Kind', value: KIND_WORDS[r.input.kind], method: r.input.kind_by === 'bytes' ? 'the first bytes (a magic number)' : 'the file name: its bytes carry no magic number', ...base, ...(r.input.note ? { note: r.input.note } : {}) },
        { name: 'file_bytes', title: 'Size', value: r.input.bytes, unit: 'bytes', method: 'the file system\'s size of the file', ...base },
        { name: 'file_sha256', title: 'sha256', value: r.input.sha256, method: 'sha256 of the bytes read', ...base },
      );
    }
  }

  /** A failure row for a tool that cannot run here: needs setup, with its exact step. */
  private needsSetup(op: Op, tool: VoxTool, why: string, setup: string, of?: 'a' | 'b'): void {
    op.record.failures.push({ tool, code: 'needs-setup', message: why, setup, ...(of ? { of } : {}) });
  }

  /** Runs one worker as a job and waits for it: its output as text, or null (stopped, not started, too much output). */
  private async job(op: Op, tool: VoxTool, spec: Omit<JobSpec, 'kind' | 'project' | 'root'>, maxOutput: number, of?: 'a' | 'b' | 'both'): Promise<{ done: JobRecord; output: string; run: VoxToolRun } | null> {
    const fail = (code: VoxFailure['code'], message: string): null => {
      op.record.failures.push({ tool, code, message: this.d.scrub(message, op.root), ...(of && of !== 'both' ? { of } : {}) });
      return null;
    };
    if (op.abort.signal.aborted) return fail('cancelled', 'stopped before it started');
    let job: JobRecord;
    try {
      // Every worker runs with the REPL's environment (TIMMY_FFPROBE, TIMMY_NATIVE_HOME, …), as Look does.
      job = this.d.startJob({ kind: 'task', project: op.project, root: op.root, env: this.d.env(), ...spec }, { selfSealed: true });
    } catch (e) { return fail('failed', `the job did not start (${e instanceof Error ? e.message : String(e)})`); }
    op.jobs.push(job);
    op.first(job);
    const done = await this.d.jobs.done(job.id);
    const ms = done.endedAt ? Date.parse(done.endedAt) - Date.parse(done.startedAt) : undefined;
    const run: VoxToolRun = {
      tool, ran: 'job', ...(of ? { of } : {}),
      job: { id: done.id, state: done.state, exit_code: done.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(done.error ? { error: this.d.scrub(done.error, op.root) } : {}) },
    };
    // The job's output as it came, kept beside the record (private: .timmy/vox/<id>/<tool>-<job>.log).
    try {
      const dir = resolveInside(op.root, voxRawDir(op.id));
      if (!('error' in dir)) {
        mkdirSync(dir.path, { recursive: true });
        const name = `${tool}${of && of !== 'both' ? `-${of}` : ''}-${done.id}.log`;
        copyFileSync(done.logPath, path.join(dir.path, name));
        const b = readFileSync(path.join(dir.path, name));
        run.raw = { path: `${voxRawDir(op.id)}/${name}`, sha256: sha(b), bytes: b.length };
      }
    } catch { /* the job's own log stays in the jobs folder */ }
    op.record.tools.push(run);
    if (done.state === 'cancelled') return fail('cancelled', 'stopped with /stop before it finished: nothing it measured is recorded');
    let size = 0;
    try { size = statSync(done.logPath).size; } catch { size = 0; }
    if (size > maxOutput) return fail('failed', `the worker printed more than ${maxOutput} bytes`);
    return { done, output: this.d.jobs.tail(done.id, 400).join('\n'), run };
  }

  /** The worker's answer kept in the record, bounded. */
  private keep(run: VoxToolRun, output: unknown): void {
    const text = JSON.stringify(output);
    run.output = text.length <= OUTPUT_KEEP ? output : { truncated: true, bytes: text.length, note: 'the whole answer is in the raw output kept beside the record' };
  }

  /** A highlight a worker wrote: listed only when the file on disk is the bytes it reported. */
  private checkWritten(op: Op, rel: string, said: { sha256?: unknown; bytes?: unknown }, h: Omit<VoxHighlight, 'path' | 'sha256' | 'bytes'>): void {
    const at = resolveInside(op.root, rel);
    let now: string | undefined;
    let bytes = 0;
    try { if (!('error' in at)) { const b = readFileSync(at.path); now = sha(b); bytes = b.length; } } catch { now = undefined; }
    if (!now || now !== said.sha256) {
      op.record.failures.push({ tool: 'look', code: 'failed', message: `the highlight ${rel} on disk is not the file the worker reported writing (sha256 ${short(now)}, reported ${short(String(said.sha256 ?? ''))}): it is not listed` });
      return;
    }
    op.record.highlights.push({ path: rel, sha256: now, bytes, ...h });
  }

  /** An SVG highlight of measured bounding boxes, written by Timmy. */
  private svg(op: Op, name: string, o: Parameters<typeof bboxSvg>[0], of: VoxHighlight['of']): void {
    let text: string;
    try { text = bboxSvg(o); } catch (e) { op.record.notes.push(`No bounding-box drawing: ${e instanceof Error ? e.message : String(e)}`); return; }
    const rel = `${voxHighlightDir(op.id)}/${name}`;
    const w = writeProjectFile(op.root, rel, text);
    if (!w.ok) { op.record.failures.push({ tool: 'intake', code: 'failed', message: `the drawing ${rel} could not be written: ${w.error}` }); return; }
    op.record.highlights.push({
      path: w.rel, sha256: w.sha256, bytes: w.bytes, type: 'bbox-svg', drawn_from: ['bbox_size'], drawn_by: 'Timmy (src/vox/svg.ts), from the measured sizes only',
      method: 'an oblique view of each axis-aligned bounding box from its minimum corner, one scale for all, with the measured dimensions written on it', ...(of ? { of } : {}),
    });
  }

  private highlightFolder(op: Op): string | null {
    const dir = resolveInside(op.root, voxHighlightDir(op.id));
    if ('error' in dir) return null;
    try { mkdirSync(dir.path, { recursive: true }); return dir.path; } catch { return null; }
  }

  /** Look's Python, checked to import OpenCV, or a needs-setup row (false). */
  private async lookPython(op: Op): Promise<string | false> {
    const ready = lookReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'look', ready.why, ready.setup); return false; }
    const cv = await checkOpenCv(ready.command, lookEnv(this.d.env()));
    if (!cv.ok) { this.needsSetup(op, 'look', cv.error, SETUP.look); return false; }
    return ready.command;
  }

  /** Images: Look's observation, with the colour region and the annotated copy (--vox detect). */
  private async lookDetect(op: Op): Promise<void> {
    const python = await this.lookPython(op);
    if (!python) return;
    const r = op.inputs[0];
    const folder = this.highlightFolder(op);
    const o = op.opts;
    const only = op.action === 'detect' && (o.qr || o.aruco);
    const args = [
      LOOK_SCRIPT, r.abs, '--as', r.input.path, '--vox', 'detect',
      ...(folder ? ['--out', path.join(folder, 'annotated.png')] : []),
      ...(o.color ? ['--color', o.color.join(','), ...(o.tolerance !== undefined ? ['--tolerance', String(o.tolerance)] : [])] : []),
      ...(only && !o.qr ? ['--no-qr'] : []), ...(only && !o.aruco ? ['--no-aruco'] : []),
    ];
    const j = await this.job(op, 'look', { label: `vox ${op.action} ${r.input.path} · Look (OpenCV)`, command: python, args, timeoutMs: LOOK_TIMEOUT_MS, env: lookEnv(this.d.env()) }, LOOK_MAX_OUTPUT);
    if (!j) return;
    const line = lastWorkerLine(j.output, 'timmy-look');
    if (!line || line.ok !== true || line.mode !== 'vox detect') {
      const err = line && typeof (line.error as { message?: unknown } | undefined)?.message === 'string' ? (line.error as { message: string }).message : j.done.state !== 'completed' ? (j.done.error ?? `exit ${j.done.exitCode ?? '?'}`) : "Look's answer could not be read";
      op.record.failures.push({ tool: 'look', code: 'failed', message: this.d.scrub(err, op.root) });
      return;
    }
    this.keep(j.run, line);
    const parsed = parseLookOutput(JSON.stringify(line.observation), r.input.path);
    if (!parsed.ok) { op.record.failures.push({ tool: 'look', code: 'failed', message: parsed.error }); return; }
    const obs = parsed.observation;
    Object.assign(j.run, { name: obs.worker.name, version: obs.worker.version, engine: `OpenCV ${obs.opencv}, Python ${obs.python}` });
    if (obs.source.sha256 !== r.input.sha256) { op.record.failures.push({ tool: 'look', code: 'failed', message: `${r.input.path} changed while Look read it (sha256 ${short(obs.source.sha256)}, recorded ${short(r.input.sha256)})` }); return; }
    setFrame(r, imageFrame([obs.image.width, obs.image.height]));
    const select = op.action === 'measure' && o.what?.length ? new Set(o.what.flatMap((w) => IMAGE_SELECT[w] ?? [])) : undefined;
    let metrics = lookMetrics(obs, op.action, select);
    if (op.action === 'detect') metrics = metrics.filter((m) => (only ? (o.qr && m.name === 'qr_codes_decoded') || (o.aruco && m.name === 'aruco_markers') : m.name === 'qr_codes_decoded' || m.name === 'aruco_markers'));
    op.record.metrics.push(...metrics);
    if (line.color_region && typeof line.color_region === 'object') op.record.metrics.push(colorRegionMetric(line.color_region as Record<string, unknown>, lookBy(obs)));
    op.record.notes.push(...obs.uncertainty);
    const h = line.highlight as Record<string, unknown> | null | undefined;
    if (h && typeof h === 'object') {
      this.checkWritten(op, `${voxHighlightDir(op.id)}/annotated.png`, h, {
        type: 'annotated', drawn_from: Array.isArray(h.drawn_from) ? (h.drawn_from as unknown[]).map(String) : [], drawn_by: `${obs.worker.name} ${obs.worker.version} --vox detect (OpenCV ${obs.opencv})`,
        method: typeof h.method === 'string' ? h.method : 'outlines drawn at the measured pixels',
      });
    } else if (typeof line.highlight_note === 'string') op.record.notes.push(`No annotated copy: ${line.highlight_note}.`);
  }

  /** Two images: Look's observation of each, side by side, and their pixel difference with its heatmap (--vox diff). */
  private async lookDiff(op: Op): Promise<void> {
    const python = await this.lookPython(op);
    if (!python) return;
    const [a, b] = op.inputs;
    const folder = this.highlightFolder(op);
    const args = [LOOK_SCRIPT, a.abs, '--as', a.input.path, '--vox', 'diff', '--other', b.abs, '--other-as', b.input.path, ...(folder ? ['--out', path.join(folder, 'difference.png')] : [])];
    const j = await this.job(op, 'look', { label: `vox compare ${a.input.path} ${b.input.path} · Look (OpenCV)`, command: python, args, timeoutMs: LOOK_TIMEOUT_MS * 2, env: lookEnv(this.d.env()) }, LOOK_MAX_OUTPUT * 2, 'both');
    if (!j) return;
    const line = lastWorkerLine(j.output, 'timmy-look');
    if (!line || line.ok !== true || line.mode !== 'vox diff') {
      const err = line && typeof (line.error as { message?: unknown } | undefined)?.message === 'string' ? (line.error as { message: string }).message : "Look's answer could not be read";
      op.record.failures.push({ tool: 'look', code: 'failed', message: this.d.scrub(err, op.root) });
      return;
    }
    this.keep(j.run, line);
    const pa = parseLookOutput(JSON.stringify(line.a), a.input.path);
    const pb = parseLookOutput(JSON.stringify(line.b), b.input.path);
    if (!pa.ok || !pb.ok) { op.record.failures.push({ tool: 'look', code: 'failed', message: !pa.ok ? pa.error : (pb as { error: string }).error }); return; }
    Object.assign(j.run, { name: pa.observation.worker.name, version: pa.observation.worker.version, engine: `OpenCV ${pa.observation.opencv}, Python ${pa.observation.python}` });
    for (const [p, r] of [[pa.observation, a], [pb.observation, b]] as Array<[LookObservation, Resolved]>) {
      if (p.source.sha256 !== r.input.sha256) { op.record.failures.push({ tool: 'look', code: 'failed', message: `${r.input.path} changed while Look read it`, of: r.input.role }); return; }
      setFrame(r, imageFrame([p.image.width, p.image.height]));
    }
    // R4 (H61): the two images are compared pixel by pixel (and the heatmap drawn) only in one pixel frame: Look's own rule.
    op.record.together = together({ kind: 'image', frame: a.input.frame! }, { kind: 'image', frame: b.input.frame! });
    const ma = lookMetrics(pa.observation, 'measure', undefined, 'a');
    const mb = lookMetrics(pb.observation, 'measure', undefined, 'b');
    op.record.metrics.push(...ma, ...mb, ...deltaMetrics(ma, mb, ['width', 'height', 'sharpness', 'edge_density']));
    if (line.difference && typeof line.difference === 'object') op.record.metrics.push(differenceMetric(line.difference as Record<string, unknown>, lookBy(pa.observation)));
    const h = line.highlight as Record<string, unknown> | null | undefined;
    if (h && typeof h === 'object') {
      this.checkWritten(op, `${voxHighlightDir(op.id)}/difference.png`, h, {
        type: 'difference-heatmap', drawn_from: ['pixel_difference'], drawn_by: `${pa.observation.worker.name} ${pa.observation.worker.version} --vox diff (OpenCV ${pa.observation.opencv})`,
        method: typeof h.method === 'string' ? h.method : 'the per-pixel difference on a fixed scale', of: 'both',
      });
    } else if (typeof line.highlight_note === 'string') op.record.notes.push(`No heatmap: ${line.highlight_note}.`);
  }

  /** Timmy's own STL reading, in this process. */
  private stlOne(op: Op, r: Resolved): StlReadback | null {
    const read = readStlFile(r.abs, r.input.path);
    const run: VoxToolRun = { tool: 'stl', name: STL_READBACK, ran: 'in-process', ...(r.input.role ? { of: r.input.role } : {}) };
    op.record.tools.push(run);
    if (!read.ok) { op.record.failures.push({ tool: 'stl', code: 'failed', message: `${r.input.path}: ${read.kind}: ${read.error}`, ...(r.input.role ? { of: r.input.role } : {}) }); return null; }
    this.keep(run, read.readback);
    if (read.readback.sha256 !== r.input.sha256) { op.record.failures.push({ tool: 'stl', code: 'failed', message: `${r.input.path} changed while it was read` }); return null; }
    setFrame(r, stlFrame());
    // R4 (H61): an STL OpenSCAD wrote is checked against OpenSCAD's own summary of that run (its receipt names these bytes).
    const check = scadSummaryCheck({ root: op.root, chain: this.chain(), projectId: projectId(op.root), input: { path: r.input.path, sha256: r.input.sha256, ...(r.input.role ? { role: r.input.role } : {}) }, readback: read.readback });
    if (check) { (op.record.checks ??= []).push(check); op.record.notes.push(this.d.scrub(`${r.input.role ? `${r.input.role}: ` : ''}${checkWords(check)}`, op.root)); }
    return read.readback;
  }

  private stlRead(op: Op): void {
    const r = op.inputs[0];
    const read = this.stlOne(op, r);
    if (!read) return;
    op.record.metrics.push(...stlMetrics(read, op.action));
    if (read.bbox) this.svg(op, 'bbox.svg', { title: r.input.path, boxes: [{ label: r.input.path, size: read.bbox.size }], unit: 'file units', measuredBy: `${STL_READBACK} (Timmy's reader)`, frame: "the STL's own model frame; the file's units, not declared" }, undefined);
  }

  private stlCompare(op: Op): void {
    const [a, b] = op.inputs;
    const ra = this.stlOne(op, a);
    const rb = this.stlOne(op, b);
    if (!ra || !rb) return;
    const ma = stlMetrics(ra, 'measure', 'a');
    const mb = stlMetrics(rb, 'measure', 'b');
    // R4 (H61): the deltas compare numbers in each file's own units: estimated (units not declared), never millimetres.
    op.record.metrics.push(...ma, ...mb, ...deltaMetrics(ma, mb, ['bbox_size', 'volume', 'area', 'triangles'], ['volume', 'area']));
    if (!ra.oriented || !rb.oriented) op.record.notes.push('A mesh that is not closed and consistently oriented has a signed volume, not an enclosed one: its volume delta compares signed sums.');
    // R4 (H61): both boxes are drawn at one scale only when the two files share a known unit, which two STLs never do.
    const t = together({ kind: 'stl', frame: a.input.frame ?? stlFrame() }, { kind: 'stl', frame: b.input.frame ?? stlFrame() });
    op.record.together = t;
    if (t.drawn && ra.bbox && rb.bbox) {
      this.svg(op, 'bbox.svg', { title: `${a.input.path} and ${b.input.path}`, boxes: [{ label: `a: ${a.input.path}`, size: ra.bbox.size }, { label: `b: ${b.input.path}`, size: rb.bbox.size }], unit: 'file units', measuredBy: `${STL_READBACK} (Timmy's reader)` }, 'both');
    } else op.record.notes.push(`No bounding-box drawing of both: ${t.words.replace(/^no drawing of both: /, '')}.`);
  }

  /** The STEP readback (OCP), as a job; null when it gave nothing. */
  private async stepRead(op: Op, r: Resolved): Promise<ReadbackMeasured | null> {
    const ready = stepReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'step', ready.why, ready.setup, r.input.role); return null; }
    const j = await this.job(op, 'step', { label: `vox ${op.action} ${r.input.path} · STEP readback (OCP)`, command: ready.command, args: [READBACK_SCRIPT, r.abs, '--as', r.input.path], timeoutMs: READBACK_TIMEOUT_MS }, READBACK_MAX_OUTPUT, r.input.role);
    if (!j) return null;
    const m = parseReadbackOutput(j.output);
    if (!m.ok) {
      // OCP missing is the worker's exit 3: a needs-setup row with the step, not a failure of the tool.
      if (m.code === 'no-ocp') this.needsSetup(op, 'step', m.error, SETUP.step, r.input.role);
      else op.record.failures.push({ tool: 'step', code: 'failed', message: this.d.scrub(`${m.code}: ${m.error}`, op.root), ...(r.input.role ? { of: r.input.role } : {}) });
      return null;
    }
    this.keep(j.run, m);
    Object.assign(j.run, { name: m.worker.name, version: m.worker.version, engine: `OCP ${String((m.engine as { ocp?: unknown } | undefined)?.ocp ?? 'version not reported')}` });
    if (m.source.sha256 !== r.input.sha256) { op.record.failures.push({ tool: 'step', code: 'failed', message: `the worker read bytes other than ${r.input.path} as recorded (sha256 ${short(m.source.sha256)})` }); return null; }
    const frame = stepFrame(m);
    setFrame(r, frame);
    // R4 (H61): a STEP a flow delivered is checked against the recipe's prediction sealed before that flow's build.
    const check = flowPredictionCheck({ root: op.root, chain: this.chain(), projectId: projectId(op.root), input: { path: r.input.path, sha256: r.input.sha256, ...(r.input.role ? { role: r.input.role } : {}) }, measured: m });
    if (check) { (op.record.checks ??= []).push(check); op.record.notes.push(this.d.scrub(`${r.input.role ? `${r.input.role}: ` : ''}${checkWords(check)}`, op.root)); }
    if (op.action !== 'compare') {
      op.record.metrics.push(...stepMetrics(m, op.action));
      this.svg(op, 'bbox.svg', { title: r.input.path, boxes: [{ label: r.input.path, size: m.bounds.size as [number, number, number] }], unit: 'mm', measuredBy: `${m.worker.name} ${m.worker.version} (OCP)`, frame: frame.unit_by === 'reported' ? "the STEP's own model frame, in millimetres (OCP reported MM in effect)" : "the STEP's own model frame, millimetres assumed (OCP did not report the unit)" }, undefined);
    }
    return m;
  }

  private async stepCompare(op: Op): Promise<void> {
    const [a, b] = op.inputs;
    const ma = await this.stepRead(op, a);
    if (op.abort.signal.aborted && !ma) return;
    const mb = await this.stepRead(op, b);
    if (!ma || !mb) return;
    const xa = stepMetrics(ma, 'measure', 'a');
    const xb = stepMetrics(mb, 'measure', 'b');
    op.record.metrics.push(...xa, ...xb, ...deltaMetrics(xa, xb, ['bbox_size', 'volume', 'solids'], ['volume']));
    // R4 (H61): both boxes at one scale only when both files are in millimetres as OCP reported them.
    const t = together({ kind: 'step', frame: a.input.frame ?? stepFrame(ma) }, { kind: 'step', frame: b.input.frame ?? stepFrame(mb) });
    op.record.together = t;
    if (t.drawn) {
      this.svg(op, 'bbox.svg', { title: `${a.input.path} and ${b.input.path}`, boxes: [{ label: `a: ${a.input.path}`, size: ma.bounds.size as [number, number, number] }, { label: `b: ${b.input.path}`, size: mb.bounds.size as [number, number, number] }], unit: 'mm', measuredBy: `${ma.worker.name} ${ma.worker.version} (OCP)`, frame: "each STEP's own model frame, in millimetres; each box from its own minimum corner" }, 'both');
    } else op.record.notes.push(`No bounding-box drawing of both: ${t.words.replace(/^no drawing of both: /, '')}.`);
  }

  /** The .blend readback: a second pass by Blender, as a job. Timmy hashes the file after it, to say the bytes held. */
  private async blendRead(op: Op): Promise<void> {
    const r = op.inputs[0];
    const ready = blendReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'blend', ready.why, ready.setup); return; }
    const env = this.d.env();
    const j = await this.job(op, 'blend', {
      label: `vox ${op.action} ${r.input.path} · a second pass by Blender`, command: ready.command,
      args: ['-b', r.abs, '--factory-startup', '--python-exit-code', '1', '--python', BLEND_READBACK_SCRIPT, '--', '--as', r.input.path],
      env: { ...env, ...(env.TIMMY_NATIVE_HOME ? { HOME: env.TIMMY_NATIVE_HOME } : {}) }, timeoutMs: BLEND_READBACK_TIMEOUT_MS,
    }, BLEND_READBACK_MAX_OUTPUT);
    if (!j) return;
    const b = parseBlendReadback(j.output);
    if (!b.ok) { op.record.failures.push({ tool: 'blend', code: 'failed', message: this.d.scrub(`${b.code}: ${b.error}`, op.root) }); return; }
    this.keep(j.run, b);
    Object.assign(j.run, { name: b.worker.name, version: b.worker.version, engine: `Blender ${b.blender_version ?? 'version not reported'}` });
    let after: string | undefined;
    try { after = hashFile(r.abs); } catch { after = undefined; }
    if (after !== r.input.sha256) { op.record.failures.push({ tool: 'blend', code: 'failed', message: `${r.input.path} changed during the second pass (sha256 ${short(after)} after, ${short(r.input.sha256)} before)` }); return; }
    setFrame(r, blendFrame(b.read.units));
    op.record.metrics.push(...blendMetrics(b, op.action));
    if (b.read.bounds_error) op.record.notes.push(`Blender gave no object sizes: ${b.read.bounds_error}`);
    op.record.notes.push('A second pass: Blender read its own file in a separate process (the same application, not an independent implementation). Lengths are Blender units of a generated scene; the scene\'s unit settings are reported, never applied.');
  }

  /** The video readback (ffprobe, and ffmpeg's frames when colours are sampled), as a job. */
  private async videoOne(op: Op, r: Resolved, sample: boolean): Promise<VideoReadback | null> {
    const ready = videoReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'video', ready.why, ready.setup, r.input.role); return null; }
    const raw = resolveInside(op.root, voxRawDir(op.id));
    if ('error' in raw) { op.record.failures.push({ tool: 'video', code: 'failed', message: raw.error }); return null; }
    mkdirSync(raw.path, { recursive: true });
    const c = op.opts.color;
    // The plan's comp is the unit square: the worker's centroid_comp is then the centroid as a fraction of the frame.
    const plan = { schema: 'timmy.video-readback-plan/1', comp: { width: 1, height: 1, start: 0 }, targets: sample && c ? [{ layer: `colour ${c.join(',')}`, colour: c.map((x) => x / 255), times: op.opts.at ?? [0] }] : [] };
    const planName = `plan${r.input.role ? `-${r.input.role}` : ''}.json`;
    const w = writeProjectFile(op.root, `${voxRawDir(op.id)}/${planName}`, `${JSON.stringify(plan, null, 2)}\n`);
    if (!w.ok) { op.record.failures.push({ tool: 'video', code: 'failed', message: w.error }); return null; }
    const frames = sample ? this.highlightFolder(op) : null;
    const framesDir = frames ? path.join(frames, `frames${r.input.role ? `-${r.input.role}` : ''}`) : null;
    const args = [VIDEO_READBACK_SCRIPT, r.abs, '--plan', path.join(raw.path, planName), ...(framesDir ? ['--frames-dir', framesDir] : []), '--as', r.input.path];
    const j = await this.job(op, 'video', { label: `vox ${op.action} ${r.input.path} · video readback (ffprobe${sample ? ', ffmpeg' : ''})`, command: ready.command, args, timeoutMs: VIDEO_READBACK_TIMEOUT_MS }, VIDEO_READBACK_MAX_OUTPUT, r.input.role);
    if (!j) return null;
    const v = parseVideoReadback(j.output);
    if (!v.ok) {
      if (v.code === 'no-ffmpeg' || v.code === 'no-ffprobe') this.needsSetup(op, 'video', v.error, SETUP.video, r.input.role);
      else op.record.failures.push({ tool: 'video', code: 'failed', message: this.d.scrub(`${v.code}: ${v.error}`, op.root), ...(r.input.role ? { of: r.input.role } : {}) });
      return null;
    }
    this.keep(j.run, v);
    Object.assign(j.run, { name: v.worker.name, version: v.worker.version, engine: [v.tools.ffprobe?.version, sample ? v.tools.ffmpeg?.version : undefined].filter(Boolean).join('; ') || undefined });
    if (v.source.sha256 !== r.input.sha256 || !v.unchanged_during_read) { op.record.failures.push({ tool: 'video', code: 'failed', message: `${r.input.path} is not the bytes recorded, or changed during the read` }); return null; }
    setFrame(r, videoFrame(typeof v.probe.width === 'number' && typeof v.probe.height === 'number' ? [v.probe.width, v.probe.height] : null));
    if (framesDir) {
      const folder = `${voxHighlightDir(op.id)}/frames${r.input.role ? `-${r.input.role}` : ''}`;
      for (const f of v.frames.filter((x) => x.written && x.png && x.sha256).slice(0, MAX_TIMES)) {
        this.checkWritten(op, `${folder}/${f.png}`, f, {
          type: 'frame', drawn_from: ['color_at'], drawn_by: `${v.worker.name} ${v.worker.version} (ffmpeg's decoded frame, scaled by 1/${v.scale})`,
          method: `the frame shown at ${f.time} s, as ffmpeg decoded it and the worker wrote it; the measured box and centroid are in the table, not drawn`, ...(r.input.role ? { of: r.input.role } : {}),
        });
      }
    }
    return v;
  }

  private async videoRead(op: Op, r: Resolved, sample: boolean): Promise<void> {
    const v = await this.videoOne(op, r, sample);
    if (!v) return;
    op.record.metrics.push(...(sample ? videoSampleMetrics(v) : videoMetrics(v)));
  }

  private async videoCompare(op: Op): Promise<void> {
    const [a, b] = op.inputs;
    const sample = !!op.opts.color;
    const va = await this.videoOne(op, a, sample);
    if (op.abort.signal.aborted && !va) return;
    const vb = await this.videoOne(op, b, sample);
    if (!va || !vb) return;
    const ma = videoMetrics(va, 'a');
    const mb = videoMetrics(vb, 'b');
    op.record.metrics.push(...ma, ...mb, ...deltaMetrics(ma, mb, ['width', 'height', 'fps', 'duration', 'frames']));
    // R4 (H61): centroids are compared only in one pixel frame (two videos of the same size).
    const t = together({ kind: 'video', frame: a.input.frame ?? videoFrame() }, { kind: 'video', frame: b.input.frame ?? videoFrame() });
    op.record.together = t;
    if (sample) {
      const sa = videoSampleMetrics(va, 'a');
      const sb = videoSampleMetrics(vb, 'b');
      op.record.metrics.push(...sa, ...sb);
      if (!t.drawn) { op.record.notes.push(`No centroid differences: ${t.words.replace(/^no drawing of both: /, '')}.`); return; }
      for (const x of sa) {
        const y = sb.find((m) => m.name === x.name);
        const ca = (x.value as { centroid_px?: number[] | null } | null)?.centroid_px;
        const cb = (y?.value as { centroid_px?: number[] | null } | null | undefined)?.centroid_px;
        if (ca && cb) op.record.metrics.push({ ...x, name: `${x.name}_delta`, title: `${x.title}: centroid (b − a)`, value: [cb[0] - ca[0], cb[1] - ca[1]], unit: 'video pixels', method: 'b − a of the two measured centroids', of: 'delta' });
      }
    }
  }

  /** Two point clouds: the geo lane's score (a is the truth, b the prediction), as a job; its exit code read as the lane means it. */
  private async geoCompare(op: Op): Promise<void> {
    const [a, b] = op.inputs;
    // R4 (H61): a PLY declares no unit: the lane's numbers are estimated (it reads the coordinates as metres), never drawn together.
    setFrame(a, plyFrame());
    setFrame(b, plyFrame());
    op.record.together = together({ kind: 'ply', frame: plyFrame() }, { kind: 'ply', frame: plyFrame() });
    const ready = geoReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'geo', ready.why, ready.setup); return; }
    const o = op.opts;
    const args = [GEO_SCRIPT, '--truth', a.abs, '--pred', b.abs, ...(o.voxel !== undefined ? ['--voxel', String(o.voxel)] : []), ...(o.tau !== undefined ? ['--tau', String(o.tau)] : []), ...(o.normalize ? ['--normalize'] : []), ...(o.fit ? ['--fit'] : [])];
    const j = await this.job(op, 'geo', { label: `vox compare ${a.input.path} ${b.input.path} · geo lane (voxel_score.py)`, command: ready.command, args, timeoutMs: GEO_TIMEOUT_MS }, GEO_MAX_OUTPUT, 'both');
    if (!j) return;
    const last = j.output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    let result: Record<string, unknown> | null = null;
    try { result = last ? JSON.parse(last) as Record<string, unknown> : null; } catch { result = null; }
    const st = geoStatus(j.done.exitCode ?? null, result);
    j.run.status = `${st.status}: ${st.meaning}`;
    Object.assign(j.run, { name: 'lanes/geo/voxel_score.py', version: 'geo.voxel-score' });
    if (result) this.keep(j.run, result);
    if (st.status === 'not_configured') { this.needsSetup(op, 'geo', st.meaning, SETUP.geo); return; }
    if (st.status !== 'ok' && st.status !== 'untrusted') { op.record.failures.push({ tool: 'geo', code: 'failed', message: st.meaning }); return; }
    if (!result || result.kind !== 'geo.voxel-score') { op.record.failures.push({ tool: 'geo', code: 'failed', message: 'the lane\'s answer is not a geo.voxel-score result' }); return; }
    op.record.metrics.push(...geoMetrics(result, st.meaning));
    if (st.status === 'untrusted') op.record.failures.push({ tool: 'geo', code: 'untrusted', message: `${st.meaning}: a shape score, never a metric one` });
    const notes = Array.isArray(result.note) ? (result.note as unknown[]).map(String) : [];
    op.record.notes.push(...notes, 'a is the truth and b the prediction, read as one frame in metres: an assumption, since a PLY declares no unit (each value says so); DOCTRINE §15: a computed score of files, not a measurement of a physical object.');
  }

  /** A PLY in Timmy's process: the spatial module's facts for an ASCII Gaussian splat, else the header as declared. */
  private plyRead(op: Op): void {
    const r = op.inputs[0];
    setFrame(r, plyFrame());
    const run: VoxToolRun = { tool: 'spatial', name: 'gaussian-ply-context', ran: 'in-process' };
    op.record.tools.push(run);
    try {
      const ctx = buildGaussianPlyContext(r.abs);
      if (ctx.source.sha256 !== r.input.sha256) { op.record.failures.push({ tool: 'spatial', code: 'failed', message: `${r.input.path} changed while it was read` }); return; }
      op.record.metrics.push(...splatMetrics(ctx.facts as Array<{ key: string; value: unknown; epistemic: string; source: { method: string } }>));
      op.record.notes.push(...ctx.limitations);
      this.keep(run, { facts: ctx.facts.length, limitations: ctx.limitations.length });
      return;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      op.record.notes.push(`The spatial module did not read it as a Gaussian splat: ${why}`);
    }
    let text = '';
    try { text = readFileSync(r.abs).subarray(0, 64 * 1024).toString('latin1'); } catch { text = ''; }
    const header = plyHeaderMetrics(text);
    if ('error' in header) { op.record.failures.push({ tool: 'spatial', code: 'failed', message: header.error }); return; }
    if (op.action === 'inspect') op.record.metrics.push(...header);
    else op.record.failures.push({ tool: 'spatial', code: 'not-measured', message: 'no supported tool measures a generic point cloud here: the spatial module reads ASCII Gaussian-splat PLY only. /compare <truth.ply> <this.ply> scores it with the geo lane.' });
  }

  /** Roboflow's hosted model, only with its key: a model's prediction, kept as a claim. */
  private async roboflow(op: Op): Promise<void> {
    const r = op.inputs[0];
    const model = op.opts.roboflow!;
    const ready = roboflowReady(this.toolEnv(op.root));
    if (!ready.ready) { this.needsSetup(op, 'roboflow', ready.why, ready.setup); return; }
    const [project, version] = model.split('/');
    const request = { action: 'detect', project, version: Number(version), path: r.abs };
    const env = { ...this.d.env(), TIMMY_ROBOFLOW_REQUEST: JSON.stringify(request) };
    const j = await this.job(op, 'roboflow', { label: `vox detect ${r.input.path} · Roboflow model ${model} (a network call)`, command: ready.command, args: ['-c', ROBOFLOW_LAUNCHER, ROBOFLOW_BRIDGE], env, timeoutMs: ROBOFLOW_TIMEOUT_MS }, 1024 * 1024);
    if (!j) return;
    const last = j.output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
    let out: Record<string, unknown> | null = null;
    try { out = last ? JSON.parse(last) as Record<string, unknown> : null; } catch { out = null; }
    Object.assign(j.run, { name: 'scripts/roboflow-bridge.py', version: `model ${model}` });
    if (!out || out.ok !== true) {
      const note = typeof out?.note === 'string' ? out.note : 'the bridge gave no answer';
      if (out?.state === 'not_configured') this.needsSetup(op, 'roboflow', note, SETUP.roboflowVenv);
      else op.record.failures.push({ tool: 'roboflow', code: 'failed', message: this.d.scrub(note, op.root) });
      return;
    }
    this.keep(j.run, out);
    (op.record.claims ??= []).push(...roboflowClaims(out, model));
  }

  // ── the end: record, receipt, notice ─────────────────────────────────────────

  private finish(op: Op): Line[] {
    const rec = op.record;
    rec.status = settleStatus(rec);
    // R4 (H61): each input's frame (as its tool found it, else as the record tells it), whether a compare's two share one,
    // and the status word of every value, claim and highlight.
    for (const i of rec.inputs) i.frame ??= frameFromRecord(i, rec.metrics);
    if (rec.action === 'compare' && !rec.together && rec.inputs.length === 2 && rec.inputs[0].kind === rec.inputs[1].kind && rec.inputs[0].kind !== 'other') {
      rec.together = together({ kind: rec.inputs[0].kind, frame: rec.inputs[0].frame! }, { kind: rec.inputs[1].kind, frame: rec.inputs[1].frame! });
    }
    settleWords(rec);
    const w = writeProjectFile(op.root, voxRecordPath(op.id), `${JSON.stringify(rec, null, 2)}\n`);
    let receipt: string | undefined;
    const rs = receiptStatus(rec.status);
    const main = op.jobs[0];
    const files = rec.inputs.map((i) => ({ path: i.path, sha256: i.sha256, bytes: i.bytes, kind: i.kind, kind_by: i.kind_by }));
    try {
      receipt = this.d.seal({
        kind: 'vox', subject: `vox · ${op.action} · ${rec.inputs.map((i) => i.path).join(' vs ')} · ${rec.status}`, policy: 'human-gated',
        status: w.ok ? rs.status : 'failed', ...(rs.error_class || !w.ok ? { error_class: w.ok ? rs.error_class : 'storage' } : {}),
        project: op.project, project_id: projectId(op.root), files,
        outputs: [
          ...(w.ok ? [{ path: w.rel, sha256: w.sha256, bytes: w.bytes }] : []),
          ...rec.highlights.map((h) => ({ path: h.path, sha256: h.sha256, bytes: h.bytes })),
          ...rec.tools.flatMap((t) => (t.raw ? [{ path: t.raw.path, sha256: t.raw.sha256, bytes: t.raw.bytes }] : [])),
        ],
        ...(main ? { job: { id: main.id, kind: main.kind, label: this.d.scrub(main.label, op.root), state: rec.tools.find((t) => t.job?.id === main.id)?.job?.state ?? main.state, exit_code: rec.tools.find((t) => t.job?.id === main.id)?.job?.exit_code ?? null } } : {}),
        sources: [{
          vox: op.id, schema: VOX_SCHEMA, action: op.action, command: rec.command, status: rec.status,
          tools: rec.tools.map((t) => ({ tool: t.tool, ran: t.ran, ...(t.name ? { name: t.name } : {}), ...(t.version ? { version: t.version } : {}), ...(t.job ? { job: t.job.id } : {}), ...(t.status ? { status: t.status } : {}) })),
          metrics: rec.metrics.length, claims: rec.claims?.length ?? 0, highlights: rec.highlights.length, ...(rec.doctrine ? { doctrine: rec.doctrine } : {}),
        }],
        ...(rec.failures.length || !w.ok ? { discrepancies: [...(w.ok ? [] : [`the record could not be written: ${w.error}`]), ...rec.failures.slice(0, 12).map((f) => `${f.tool} ${f.code}: ${f.message}`)] } : {}),
      });
    } catch { receipt = undefined; }
    const lines = this.endLines(op, w.ok ? w.rel : null, w.ok ? undefined : w.error, receipt);
    if (op.jobs.length) for (const l of lines) this.d.notify(l);
    return lines;
  }

  private endLines(op: Op, file: string | null, storage: string | undefined, receipt: string | undefined): Line[] {
    const g = this.d.glyphs;
    const rec = op.record;
    const good = rec.status === 'ok' || rec.status === 'untrusted';
    const mark = good ? g.ok : rec.status === 'cancelled' ? ' ' : rec.status === 'needs-setup' ? '!' : g.fail;
    const role: Segment['role'] = good ? 'strong' : rec.status === 'needs-setup' || rec.status === 'cancelled' ? 'estimate' : 'failure';
    const what = rec.inputs.map((i) => i.path).join(' and ');
    const counts = [`${rec.metrics.length} metric${rec.metrics.length === 1 ? '' : 's'}`, ...(rec.claims?.length ? [`${rec.claims.length} model claim`] : []), `${rec.highlights.length} highlight${rec.highlights.length === 1 ? '' : 's'}`];
    const lines: Line[] = [[
      { text: `  ${mark} `, role: good ? undefined : role }, { text: `${op.id} ${op.action} ${rec.status}`, role },
      { text: `  ${what}${file ? ` ${g.arrow} ${file}` : `: the record could not be written (${this.d.scrub(storage ?? 'error', op.root)})`}${this.sep}${counts.join(', ')}${receipt ? `${this.sep}receipt ${receipt}` : ''}`, role: 'secondary' },
    ]];
    // R4 (H61): each input's frame, and for a compare whether the two share one; then each value with its status word first
    // (and what it rests on), who measured it after; the tier and method stay in the record and on the board.
    for (const i of rec.inputs) if (i.frame) lines.push([{ text: `      frame     ${i.role ? `${i.role}: ` : ''}`, role: 'secondary' }, { text: this.d.scrub(i.frame.words, op.root), role: 'secondary' }]);
    if (rec.together && !rec.together.drawn) lines.push([{ text: '      together  ', role: 'secondary' }, { text: rec.together.words }]);
    for (const c of rec.checks ?? []) lines.push([{ text: '      CAD check ', role: 'secondary' }, { text: this.d.scrub(`${c.role ? `${c.role}: ` : ''}${checkWords(c)}`, op.root) }]);
    // A comparison leads with its differences (b − a), as the board does; then each input's own values.
    const shownMetrics = rec.metrics.filter((x) => !x.name.startsWith('file_'));
    const ordered = rec.action === 'compare' ? [...shownMetrics.filter((x) => x.of === 'delta'), ...shownMetrics.filter((x) => x.of !== 'delta')] : shownMetrics;
    for (const m of ordered.slice(0, 8)) {
      const v = valueWords(m.value, m.unit, m.name);
      const said = { word: m.status_word ?? 'unknown', note: m.status_note ?? '' };
      lines.push([
        { text: `      ${m.of ? `${m.of === 'delta' ? 'Δ' : m.of} ` : ''}${m.title}`.padEnd(34) }, { text: ` ${v}`, role: 'strong' },
        { text: `  ${said.word}`, role: WORD_ROLE[said.word] }, { text: `${wordText(said).slice(said.word.length)}${this.sep}${m.label}`, role: 'secondary' },
      ]);
    }
    if (rec.metrics.length > 8) lines.push(this.say(`    and ${rec.metrics.length - 8} more in the record`)[0]);
    for (const c of rec.claims ?? []) lines.push([{ text: `      ${c.title}`, role: 'ai' }, { text: '  model prediction' }, { text: `: a model's output, not a measurement${this.sep}${valueWords(c.value)}`, role: 'secondary' }]);
    for (const h of rec.highlights) lines.push([{ text: '      highlight ', role: 'secondary' }, { text: h.path }, { text: `  ${h.status_word ?? 'unknown'}` }, { text: `${this.sep}sha256 ${short(h.sha256)}${this.sep}drawn from ${h.drawn_from.join(', ') || 'the frame'}`, role: 'secondary' }]);
    for (const f of rec.failures) {
      lines.push(f.code === 'needs-setup'
        ? [{ text: '      needs setup ', role: 'estimate' }, { text: `${f.tool}${f.of ? ` (${f.of})` : ''}: ${this.d.scrub(f.message, op.root)}` }, { text: `${this.sep}${f.setup ?? ''}`, role: 'secondary' }]
        : [{ text: `      ${f.code} `, role: f.code === 'untrusted' || f.code === 'not-measured' || f.code === 'cancelled' ? 'estimate' : 'failure' }, { text: `${f.tool}${f.of ? ` (${f.of})` : ''}: ${this.d.scrub(f.message, op.root)}`, role: 'secondary' }]);
    }
    if (rec.doctrine) lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
    return lines;
  }
}

/** The last line of a worker's output that is its JSON answer (by its worker's name). */
function lastWorkerLine(output: string, worker: string): Record<string, unknown> | null {
  for (const line of output.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o && typeof o === 'object' && (o.worker as { name?: unknown } | undefined)?.name === worker) return o;
    } catch { /* not the worker's line */ }
  }
  return null;
}

/** The options as a record's command writes them (so the command, run again, does the same). */
function optionWords(action: VoxAction, o: Opts): string[] {
  return [
    ...(o.what ?? []),
    ...(o.qr ? ['qr'] : []), ...(o.aruco ? ['aruco'] : []),
    ...(o.color ? [`color ${o.color.join(',')}`] : []), ...(o.at ? [`--at ${o.at.join(',')}`] : []),
    ...(o.tolerance !== undefined ? [`--tolerance ${o.tolerance}`] : []), ...(o.roboflow ? [`roboflow ${o.roboflow}`] : []),
    ...(action === 'compare' ? [...(o.voxel !== undefined ? [`--voxel ${o.voxel}`] : []), ...(o.tau !== undefined ? [`--tau ${o.tau}`] : []), ...(o.normalize ? ['--normalize'] : []), ...(o.fit ? ['--fit'] : [])] : []),
  ];
}

