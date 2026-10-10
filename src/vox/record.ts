/**
 * Timmy VoxVision (round R4, helper H49): the record every action leaves, results/vox/<id>.json (schema timmy.vox/1),
 * and the words each value carries. An action is Inspect, Measure, Detect or Compare; its record names the inputs
 * with their sha256, the tool that read them (name and version), every metric with its method, its tier and its
 * label (who measured it, said plainly), the highlight files drawn from those metrics (each with its sha256), the raw
 * output kept, and what failed or needs setup. A receipt of kind `vox` seals the record's bytes and its highlights'.
 *
 * Evidence (AGENTS.md §4): a value is a deterministic computation on the exact bytes named, a native readback (a
 * second pass by the same application), something the file declares, or a model's prediction; the tier says which,
 * and a lower tier never stands for a higher one. A missing tool is "needs setup" with its exact step, never a value.
 * DOCTRINE §15: a measurement of a CAD or mesh file is never a measurement of a physical part (DOCTRINE_15, verbatim).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTRINE_15 } from '../native/stl-readback.js';
import type { VoxKind, VoxTool } from './kinds.js';
// R4 (H61): the status word every value and highlight carries, each input's frame, the checks against a source's own
// report, and the views. Types only: those modules read this one.
import type { VoxWord } from './words.js';
import type { VoxFrame } from './frames.js';
import type { VoxSourceCheck } from './sources.js';

export { DOCTRINE_15 };

export const VOX_SCHEMA = 'timmy.vox/1';
/** Where records and their highlights are kept in the project (results/: an output folder), and the raw output. */
export const VOX_DIR = 'results/vox';
export const VOX_RAW_DIR = '.timmy/vox';
/** A record's id: 'v' and 8 hex digits (a job is 'j' and 6, a flow 'f' and 8). */
export const VOX_ID = /^v[0-9a-f]{8}$/;
export const voxRecordPath = (id: string): string => `${VOX_DIR}/${id}.json`;
export const voxHighlightDir = (id: string): string => `${VOX_DIR}/${id}`;
export const voxRawDir = (id: string): string => `${VOX_RAW_DIR}/${id}`;

export type VoxAction = 'inspect' | 'measure' | 'detect' | 'compare';
export const VOX_ACTIONS: readonly VoxAction[] = ['inspect', 'measure', 'detect', 'compare'];

/** The tiers a value can have (AGENTS.md §4), as records write them. */
export const TIER = {
  computed: 'deterministic computation',
  native: 'native readback: a second pass by the same application',
  declared: 'declared by the file (read, not measured)',
  model: 'model prediction',
} as const;

/** Who measured a value, in a person's words: shown beside every value. */
export const LABEL: Readonly<Record<VoxTool, string>> = {
  look: 'deterministic computation (OpenCV) on these bytes',
  stl: "Timmy's own reading of the STL",
  step: "OCP's reading of the STEP (OpenCascade)",
  blend: 'a second pass by Blender',
  video: "ffprobe's reading of the file; centroids by Timmy's pixel arithmetic on ffmpeg's frames",
  geo: "the geo lane's score: metric unless fitted (exit 2 = untrusted)",
  spatial: "Timmy's spatial module reading an ASCII Gaussian-splat PLY, row by row",
  roboflow: "Roboflow's hosted model: a model's prediction, not a measurement",
  intake: "the file's first bytes and its sha256, read by Timmy",
  // R4 (H61): the viewer layers. Rerun shows files as they are; Viser and FiftyOne are not used by VoxVision yet.
  rerun: "Rerun's viewer: a window on your computer showing the files as they are, measuring nothing",
  viser: 'Viser: VoxVision does not use it yet',
  fiftyone: 'FiftyOne: VoxVision does not use it yet',
};

/** A metric: one value with how it was got, its tier and who measured it. */
export interface VoxMetric {
  /** a stable name: width, sharpness, bbox_size, volume_delta */
  name: string;
  /** the words shown for it */
  title: string;
  value: unknown;
  unit?: string;
  method: string;
  tier: string;
  /** who measured it, said plainly (LABEL) */
  label: string;
  /** the tool and its version: "timmy-look 0.1.0 (OpenCV 5.0.0)" */
  measured_by: string;
  /** for /compare: the input it is of (a, b), or the delta (b − a) */
  of?: 'a' | 'b' | 'delta';
  note?: string;
  /**
   * R4 (H61): the status word a person reads first (src/vox/words.ts) and what it rests on: what it was checked against,
   * the assumption named, or why there is no value. Optional: a record made before has none, and its word is derived.
   */
  status_word?: VoxWord;
  status_note?: string;
}

/** A model's claim (Roboflow): kept apart from the metrics, never drawn as a highlight. */
export interface VoxClaim { name: string; title: string; value: unknown; tier: typeof TIER.model; label: string; claimed_by: string; note?: string; status_word?: VoxWord; status_note?: string }

/** R4 (H61): `frame`, the coordinate frame the input's values are in, in words (src/vox/frames.ts). */
export interface VoxInput { path: string; sha256: string; bytes: number; kind: VoxKind; kind_by: 'bytes' | 'name'; role?: 'a' | 'b'; note?: string; frame?: VoxFrame }

/** R4 (H61): one opening of a record's files in a viewer (`/vox view`), as recorded on the record before its receipt sealed it. */
export interface VoxView {
  viewer: 'rerun';
  at: string;
  /** how the program was found (on the PATH, or TIMMY_RERUN); never its folder */
  program: string;
  /** the files given to the viewer, each with the loader that reads it and its sha256 now (the bytes the record names) */
  passed: Array<{ path: string; sha256: string; loader: string; role?: 'a' | 'b' | 'both' }>;
  /** the record's other files, each with why it was not given */
  not_passed: Array<{ path: string; why: string }>;
  /** started apart from Timmy: a program of the user's, which Timmy does not stop */
  detached: true;
  pid?: number;
  /** the operation (one request) that opened it */
  operation?: string;
  /** R4 (H70): the address it was told to listen on (`--bind`, src/vox/layers.ts RERUN_BIND): this computer only */
  bind?: string;
  /** R4 (H70): files made from the record's inputs for the viewer (a STEP's tessellation), kept in the record's folder */
  derived?: VoxDerived[];
}

/**
 * R4 (H70): a file `/vox view` made from a record's input so the viewer can show it: a STEP's tessellation by OCP
 * (src/vox/tessellate.ts), kept in the record's own folder and sealed with the view. It is a mesh approximating the
 * STEP's surfaces within `tolerance`, never the STEP itself, and measures nothing.
 */
export interface VoxDerived {
  path: string;
  sha256: string;
  bytes: number;
  kind: 'tessellation';
  format: 'stl';
  /** the record's input it was made from, with the sha256 the record names (the bytes meshed) */
  from: { path: string; sha256: string; role?: 'a' | 'b' };
  /** how, as the worker reported it */
  method: string;
  tolerance: { linear_deflection_mm: number; angular_deflection_rad: number; relative: false };
  triangles: number;
  /** the worker and its engine, as they reported themselves: "timmy-step-tessellate 0.1.0 (OCP 7.9.3.1)" */
  made_by: string;
  /** made by this view's job, or an earlier view's file used again (its bytes unchanged) */
  made: 'now' | 'reused';
  job?: string;
  /** the job's output as it came, kept beside the record (private) */
  raw?: { path: string; sha256: string; bytes: number };
  /** Timmy's own reading of the mesh (its triangles and box), and that box against OCP's box of the STEP in the record */
  check: { by: string; triangles: number; box: [number, number, number] | null; against?: { box: [number, number, number]; within_mm: number; max_difference_mm: number }; note?: string };
  /** in a person's words: what it is and is not */
  words: string;
}

/** A file drawn from the metrics: an annotated copy, a heatmap, an SVG of a bounding box. */
export interface VoxHighlight {
  path: string;
  sha256: string;
  bytes: number;
  type: 'annotated' | 'difference-heatmap' | 'bbox-svg' | 'frame';
  /** the metrics it was drawn from (their names) */
  drawn_from: string[];
  drawn_by: string;
  method: string;
  of?: 'a' | 'b' | 'both';
  /** R4 (H61): its status word, from the values it was drawn from (src/vox/words.ts); absent in records made before */
  status_word?: VoxWord;
  status_note?: string;
}

/** Something that did not run or did not give a value: needs setup (with its exact step), failed, or not measured. */
export interface VoxFailure { tool: VoxTool; code: 'needs-setup' | 'failed' | 'cancelled' | 'not-measured' | 'unsupported' | 'untrusted'; message: string; setup?: string; of?: 'a' | 'b' }

export interface VoxToolRun {
  tool: VoxTool;
  /** worker name and version as it reported them; for in-process tools, Timmy's own reader */
  name?: string;
  version?: string;
  engine?: string;
  of?: 'a' | 'b' | 'both';
  /** the job that ran it (absent: in-process) */
  job?: { id: string; state: string; exit_code: number | null; ms?: number; error?: string };
  ran: 'job' | 'in-process';
  /** the job's output, kept as it came (stdout and stderr) */
  raw?: { path: string; sha256: string; bytes: number };
  /** the worker's answer as parsed (bounded), or the in-process reader's */
  output?: unknown;
  /** the geo lane: its exit code's meaning */
  status?: string;
}

export type VoxStatus = 'ok' | 'untrusted' | 'needs-setup' | 'failed' | 'cancelled' | 'partial';

export interface VoxRecord {
  schema: typeof VOX_SCHEMA;
  id: string;
  action: VoxAction;
  /** the command as Timmy reads it (the board's buttons run the same) */
  command: string;
  made_at: string;
  project: string;
  /** Round R4 (H51): the operation (one request) that started the action (src/ops/context.ts); absent before, or outside one */
  operation?: string;
  status: VoxStatus;
  inputs: VoxInput[];
  tools: VoxToolRun[];
  metrics: VoxMetric[];
  claims?: VoxClaim[];
  highlights: VoxHighlight[];
  failures: VoxFailure[];
  notes: string[];
  /** DOCTRINE §15's sentence, on every record of a CAD or mesh file */
  doctrine?: typeof DOCTRINE_15;
  /** R4 (H61): each comparison of a measured value with its source's own report or prediction (src/vox/sources.ts) */
  checks?: VoxSourceCheck[];
  /** R4 (H61): /compare: whether the two inputs share a known frame and unit, so a drawing of both (or a 3D overlay) is made, or why not */
  together?: { drawn: boolean; words: string };
  /** R4 (H61): each time its files were opened in a viewer (/vox view), each sealed by a vox receipt over the record so written */
  views?: VoxView[];
}

/** A new record id, free in this project (its record file and highlight folder do not exist). */
export function newVoxId(root: string): string {
  for (;;) {
    const id = `v${randomBytes(4).toString('hex')}`;
    if (!existsSync(join(root, voxRecordPath(id))) && !existsSync(join(root, voxHighlightDir(id))) && !existsSync(join(root, voxRawDir(id)))) return id;
  }
}

/** Whether a kind is CAD or a mesh (DOCTRINE §15 goes on its card). */
export const isGeometry = (k: VoxKind): boolean => k === 'stl' || k === 'step' || k === 'blend' || k === 'ply';

/** A number for people: seven significant digits, no trailing zeros, -0 as 0. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const s = String(Number(v.toPrecision(7)));
  return s === '-0' ? '0' : s;
}

/** b − a for numbers (and triples), exactly as doubles; null when either side is missing. */
export function delta(a: unknown, b: unknown): number | number[] | null {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) return b - a;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => typeof x === 'number') && b.every((x) => typeof x === 'number')) return a.map((x, i) => (b[i] as number) - (x as number));
  return null;
}

/** b / a for positive numbers; null otherwise. */
export function ratio(a: unknown, b: unknown): number | null {
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? b / a : null;
}

/** The geo lane's exit code, as src/geo/mcp.ts reads it: 0 ok, 2 computed but not trusted (fitted), 3 not configured.
 *  An exit 2 with no JSON is argparse's usage error (nothing computed); with {"status": "refused"} the lane refused. */
export type GeoStatus = 'ok' | 'untrusted' | 'not_configured' | 'refused' | 'usage' | 'failed';
export function geoStatus(code: number | null, result: unknown): { status: GeoStatus; meaning: string } {
  const said = result && typeof result === 'object' ? (result as { status?: unknown; note?: unknown }) : undefined;
  if (code === 0) return { status: 'ok', meaning: 'exit 0: scored, metric (nothing fitted)' };
  if (code === 2 && !said) return { status: 'usage', meaning: 'exit 2 with no result: a usage error, nothing was computed' };
  if (code === 2 && said?.status === 'refused') return { status: 'refused', meaning: `exit 2: the lane refused (${typeof said.note === 'string' ? said.note : 'no reason given'})` };
  if (code === 2) return { status: 'untrusted', meaning: 'exit 2: computed but not trusted (fitted: metric false)' };
  if (code === 3) return { status: 'not_configured', meaning: `exit 3: not configured (${typeof said?.note === 'string' ? said.note : 'numpy and scipy are needed'})` };
  return { status: 'failed', meaning: `exit ${code ?? 'none'}: the lane failed` };
}

/** The receipt status and error class of a record's status (the conventions of src/geo/mcp.ts and roboflow-adapter.ts). */
export function receiptStatus(s: VoxStatus): { status: 'ok' | 'failed' | 'cancelled'; error_class?: string } {
  switch (s) {
    case 'ok': return { status: 'ok' };
    case 'untrusted': return { status: 'ok', error_class: 'untrusted_metric' };
    case 'needs-setup': return { status: 'failed', error_class: 'not_configured' };
    case 'cancelled': return { status: 'cancelled' };
    case 'partial': return { status: 'failed', error_class: 'partial' };
    default: return { status: 'failed', error_class: 'exec' };
  }
}

/** The status of a finished action from what it got. */
export function settleStatus(r: Pick<VoxRecord, 'metrics' | 'failures' | 'claims'>): VoxStatus {
  const f = r.failures;
  if (f.some((x) => x.code === 'cancelled')) return 'cancelled';
  const got = r.metrics.length > 0 || (r.claims?.length ?? 0) > 0;
  const hard = f.filter((x) => x.code === 'failed' || x.code === 'needs-setup' || x.code === 'unsupported');
  if (!hard.length) return f.some((x) => x.code === 'untrusted') ? 'untrusted' : 'ok';
  if (hard.every((x) => x.code === 'unsupported')) return 'partial';
  if (!got || r.metrics.every((m) => m.name.startsWith('file_'))) return hard.every((x) => x.code === 'needs-setup') ? 'needs-setup' : 'failed';
  return 'partial';
}
