/**
 * R6 (H143): a VoxVision record as the browser companion's tab 5 draws it (references 04, 05, 15 and 16), and as the
 * Workbench's tab 5 says it in words: the project's records newest first, and for one record its observed images, what was
 * measured over them (boxes, polygons, points, with their units), its entity tree, its frames on a timeline, its values, its
 * pipeline as the steps it actually ran, the engines this computer has and has not, its meshes drawn as three views, its
 * recordings, its sealed receipt and the commands that act on it. The routes are src/companion/panels/vox.ts; the page side is
 * src/companion/client/panel-vox.js.
 *
 * Everything here is read from the record and the files it names (src/repl/board-vox.ts readVoxRecord, the board's own
 * reading and check), the runs chain (verifyReceiptIn) and the tools' configuration (src/vox/tools.ts, layers.ts): nothing
 * runs, no viewer opens, nothing is asked over the network, and nothing is written. A record, a recording, a mesh and a served
 * image are each read through one descriptor (./read-plain.ts): no link is followed, and the file checked is the file read.
 *
 * Each drawn thing carries its provenance and evidence state (DOCTRINE §15; AGENTS.md §4), told from the record's own words:
 *
 *   provenance  measured       computed by a deterministic tool on the recorded bytes, in the file's own frame (Look's
 *                              corners, boxes and centroids; Timmy's and OCP's readings), never of a physical object
 *               reconstructed  a mesh made from a STEP's surfaces within a stated tolerance (a tessellation)
 *               generated      a model's prediction (Roboflow), or generated CAD (an STL a source report vouches for)
 *               not recorded   the record does not say where a file came from
 *   evidence    constructed    a deterministic computation on these bytes, not checked against an independent source
 *               checked        CAD checked: within tolerance of its source's own report or prediction
 *               declared       as the file declares it (a header, a probe), read and not measured
 *               inferred       an estimate resting on a named assumption, or a model's output
 *               stale          an input changed since the record
 *               unverified     the record is not the one a vox receipt sealed: nothing vouches for its values
 *               unknown        no value, with why
 *
 * Where Timmy has nothing (SAM 3, Depth Anything 3, a voxel grid from masks, an operator verdict, an active-learning queue)
 * it is said in words, never drawn as if it were there.
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseStl } from '../native/stl-readback.js';
import { projectId, resolveInside } from '../project/index.js';
import { hashFile } from '../project/intake.js';
import { readVoxRecord, type ShownWord, type VoxCard, type VoxCardMetric } from '../repl/board-vox.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { voxArg } from './args.js';
import { headBytes, KIND_WORDS, type VoxKind } from './kinds.js';
import { LATER_LAYERS, RERUN_SETUP, rerunReady } from './layers.js';
import { projectMesh, type ProjectionView } from './projection.js';
import { plainRel, readPlainInside, type PlainReadHooks } from './read-plain.js';
import { isRecording, readRecording, type RecordingFacts } from './recording.js';
import { DOCTRINE_15, num, TIER, VOX_DIR, VOX_ID } from './record.js';
import { metricText, roboflowReady, toolStatuses, type ToolEnv } from './tools.js';
import { ASSUMES, WORD_MEANS } from './words.js';

export const PREVIEW_SCHEMA = 'timmy.vox-preview/1';
/** How many records the list reads (the newest), as the Workbench's tab does. */
export const PREVIEW_LIST_MAX = 24;
/** The largest record read (as the board reads them). */
const RECORD_MAX = 1024 * 1024;
/** The largest image the file route serves, and the largest mesh or recording read here. */
export const VOX_FILE_MAX = 32 * 1024 * 1024;
export const MESH_READ_MAX = 64 * 1024 * 1024;

export type Provenance = 'measured' | 'reconstructed' | 'generated' | 'not recorded';
export type Evidence = 'constructed' | 'checked' | 'declared' | 'inferred' | 'stale' | 'unverified' | 'unknown';

/** What each provenance and evidence word means, said once (the page's legend). */
export const PROVENANCE_MEANS: Readonly<Record<Provenance, string>> = {
  measured: "computed by a deterministic tool on the recorded bytes, in the file's own frame; never of a physical object",
  reconstructed: "a mesh made from a STEP's surfaces within a stated tolerance",
  generated: "a model's prediction, or generated CAD a source report vouches for",
  'not recorded': 'the record does not say where the file came from',
};
export const EVIDENCE_MEANS: Readonly<Record<Evidence, string>> = {
  constructed: 'a deterministic computation on these bytes, not checked against an independent source',
  checked: "CAD checked: within tolerance of its source's own report or prediction",
  declared: 'as the file declares it, read and not measured',
  inferred: "an estimate resting on a named assumption, or a model's output",
  stale: 'an input changed since the record',
  unverified: 'the record is not the one a vox receipt sealed: nothing vouches for it',
  unknown: 'no value; why is said',
};

/** The words where Timmy keeps no verdict and no queue (references 05 and 16): one line, no control. */
export const NO_VERDICT = "Operator verdict: not recorded. A VoxVision record (timmy.vox/1) keeps no verdict, and Timmy has no active-learning queue.";

export interface ReceiptState {
  /** the receipt's short id and full hash, and when it was sealed */
  short?: string;
  hash?: string;
  at?: string;
  /** green only when true: a vox receipt sealed exactly this record's bytes for this project, and it verifies where it stands */
  verified: boolean;
  words: string;
}

export interface PreviewImage {
  key: string;
  path: string;
  role: 'input' | 'highlight' | 'frame';
  of?: string;
  title: string;
  type?: string;
  /** the file route serves it (a file the record names, of an image type, inside the project, no link) */
  servable: boolean;
  why?: string;
  /** its bytes now are the ones the record names (an input), or the sealed ones (a highlight); null: not known */
  matches: boolean | null;
  /** the frame its overlays are in (px for an image, video px for a video's frame), when the record says */
  frame?: [number, number];
  unit?: string;
  word?: string;
  note?: string;
  provenance: Provenance;
  evidence: Evidence;
}

export interface PreviewOverlay {
  id: string;
  /** the entity it draws */
  entity: string;
  image: string;
  shape: 'box' | 'polygon' | 'point';
  /** box: x0, y0, x1, y1 (x1 and y1 exclusive); polygon: x, y pairs; point: x, y; in the image's frame */
  points: number[];
  label: string;
  provenance: Provenance;
  evidence: Evidence;
  word: string;
}

export interface PreviewEntity {
  id: string;
  path: string;
  label: string;
  kind: 'record' | 'group' | 'input' | 'observation' | 'value' | 'image' | 'mesh' | 'recording' | 'receipt';
  detail?: string;
  provenance?: Provenance;
  evidence?: Evidence;
  word?: string;
  /** the image it is seen on (selecting it shows that image), and the overlays it highlights */
  image?: string;
  overlays?: string[];
  /** a value's name (its row in the values table) */
  value?: string;
  children?: PreviewEntity[];
}

export interface PreviewFrame { index: number; image: string; frame: number | null; time: number | null; of?: string; label: string; overlays: string[] }

export interface PreviewValue {
  name: string;
  title: string;
  text: string;
  of?: string;
  word: string;
  note?: string;
  provenance: Provenance;
  evidence: Evidence;
  method?: string;
  measured_by?: string;
  claim?: boolean;
}

export interface PipelineStep { name: string; state: string; words: string; tone: 'intent' | 'ran' | 'failed' | 'setup' | 'verified' | 'sealed' | 'none'; setup?: string }
export interface EngineRow { name: string; state: string; words: string; setup?: string; tone: 'here' | 'setup' | 'absent' }

export interface PreviewSpatial {
  key: string;
  source: string;
  what: string;
  provenance: Provenance;
  evidence: Evidence;
  unit: string;
  triangles?: number;
  box?: [number, number, number];
  views?: ProjectionView[];
  scale?: number;
  method?: string;
  why?: string;
  words: string;
}

export interface PreviewRecording { path: string; facts?: RecordingFacts; why?: string; viewer: { state: string; words: string; command: string } }

export interface PreviewAction { label: string; command: string; effect: string; primary: boolean; enabled: boolean; why?: string }

export interface VoxPreview {
  schema: typeof PREVIEW_SCHEMA;
  id: string;
  file: string;
  action: string;
  status: string;
  command?: string;
  madeAt?: string;
  operation?: string;
  fake: { is: boolean; words?: string };
  check: { status: 'verified' | 'stale' | 'unverified'; reasons: string[] };
  receipt: ReceiptState;
  inputs: Array<{ path: string; kind: string; kindWords: string; role?: string; bytes?: number; sha256?: string; frame?: string; matches: boolean | null }>;
  images: PreviewImage[];
  overlays: PreviewOverlay[];
  entities: PreviewEntity[];
  frames: PreviewFrame[];
  values: PreviewValue[];
  pipeline: { steps: PipelineStep[]; absent: EngineRow[] };
  engines: EngineRow[];
  spatial: PreviewSpatial[];
  recordings: PreviewRecording[];
  failures: Array<{ tool: string; code: string; message: string; setup?: string }>;
  notes: string[];
  views: Array<{ at: string; viewer: string; passed: string[]; receipt?: string }>;
  checks: Array<{ words: string; agrees: boolean }>;
  together?: { drawn: boolean; words: string };
  doctrine?: string;
  verdict: string;
  actions: PreviewAction[];
  legend: { provenance: Record<string, string>; evidence: Record<string, string>; words: Record<string, string> };
}

export interface VoxListRow {
  id: string;
  file: string;
  action: string;
  status: string;
  madeAt?: string;
  command?: string;
  inputs: Array<{ path: string; kind?: string; role?: string }>;
  check: { status: 'verified' | 'stale' | 'unverified'; reasons: string[] };
  receipt: ReceiptState;
  fake: boolean;
  counts: { values: number; images: number; overlays: number; frames: number };
}

export interface VoxList { schema: 'timmy.vox-list/1'; records: VoxListRow[]; more: number; unreadable: Array<{ file: string; why: string }> }

export interface PreviewInput {
  root: string;
  /** the runs chain as the caller read it (TIMMY_STORE, else the project's own store) */
  chain: readonly Receipt[];
  /** the tools' configuration (PATH, TIMMY_RERUN, ROBOFLOW_API_KEY …), and the home folders written as "~" */
  env: NodeJS.ProcessEnv;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pts = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length < 3) return null;
  const out: number[] = [];
  for (const p of v) { if (!Array.isArray(p) || p.length < 2 || !finite(p[0]) || !finite(p[1])) return null; out.push(p[0], p[1]); }
  return out;
};
const box4 = (v: unknown): number[] | null => (Array.isArray(v) && v.length === 4 && v.every(finite) && (v[2] as number) >= (v[0] as number) && (v[3] as number) >= (v[1] as number) ? v as number[] : null);
const xy = (v: unknown): number[] | null => (Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null);

/** A PATH lookup of an executable (the companion's own; the REPL's realOnPath does the same). */
export function onPathOf(env: NodeJS.ProcessEnv): (cmd: string) => string | null {
  return (cmd) => {
    for (const dir of (env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const p = join(dir, cmd);
      try { const st = statSync(p); if (st.isFile() && (st.mode & 0o111)) return p; } catch { /* not here */ }
    }
    return null;
  };
}

const toolEnvOf = (i: PreviewInput): ToolEnv => ({ env: i.env, onPath: onPathOf(i.env), root: i.root });

/** A file's sha256 now (null: gone; undefined: not readable), kept while its size and times are unchanged. */
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();
function shaNow(root: string, rel: string): string | null | undefined {
  const at = resolveInside(root, rel);
  if ('error' in at) return undefined;
  try {
    const st = statSync(at.path);
    if (!st.isFile()) return undefined;
    const known = hashes.get(at.path);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && known.ctimeMs === st.ctimeMs) return known.sha256;
    const sha = hashFile(at.path);
    if (hashes.size > 2000) hashes.clear();
    hashes.set(at.path, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha256: sha });
    return sha;
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
}

/** Every string of a value with the project as "." and home folders as "~" (a record keeps what its tools printed). */
function scrubDeep<T>(v: T, scrub: (t: string) => string): T {
  if (typeof v === 'string') return scrub(v) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, scrub)])) as T;
  return v;
}
const scrubberOf = (i: PreviewInput): ((t: string) => string) => (t) => scrubHomes(t.split(i.root).join('.'), i.env);

/** The newest vox receipt of this project that names the record, if any. */
function sealOf(chain: readonly Receipt[], file: string, pid: string): Receipt | undefined {
  for (let k = chain.length - 1; k >= 0; k--) {
    const r = chain[k];
    if (r.kind === 'vox' && r.project_id === pid && r.outputs?.[0]?.path === file) return r;
  }
  return undefined;
}
const shortOf = (hash: string): string => hash.replace(/^sha256[:_]/, '').slice(0, 8);

/** The record's receipt now: verified (green) only when it sealed exactly these bytes and verifies where it stands. */
export function receiptState(card: VoxCard, chain: readonly Receipt[], pid: string): ReceiptState {
  const seal = sealOf(chain, card.file, pid);
  if (!seal) return { verified: false, words: 'not sealed: no vox receipt of this project names this record' };
  const short = shortOf(seal.hash);
  const base = { short, hash: seal.hash, at: seal.ts };
  const v = verifyReceiptIn(chain, seal.hash);
  if (!v.ok) return { ...base, verified: false, words: `receipt ${short} does not verify: ${v.reason}` };
  if (card.check.status === 'unverified') return { ...base, verified: false, words: `receipt ${short} verifies, but ${card.check.reasons[0] ?? 'it does not vouch for this record'}` };
  return { ...base, verified: true, words: `sealed and verified: receipt ${short} sealed exactly this record's bytes, and its chain link, body and signature verify` };
}

/** Whether the record was made by a test double or says it is FAKE, and its words. */
function fakeOf(card: VoxCard): { is: boolean; words?: string } {
  const t = card.tools.find((x) => [x.name, x.version, x.engine].some((s) => typeof s === 'string' && /\bfake\b/i.test(s)));
  if (t) return { is: true, words: `FAKE: made by a test double (${[t.name ?? t.tool, t.version].filter(Boolean).join(' ')}), not by the real tool` };
  const n = card.notes.find((x) => /^FAKE\b/.test(x));
  if (n) return { is: true, words: n };
  if (card.command && /\bFAKE\b/.test(card.command)) return { is: true, words: 'FAKE: the record says so in its command' };
  return { is: false };
}

/** A value's evidence state from its shown word and the record's check. */
function evidenceOf(said: ShownWord | undefined, check: VoxCard['check']): Evidence {
  if (check.status === 'unverified') return 'unverified';
  if (!said) return 'unknown';
  if (said.word === 'stale' || check.status === 'stale') return 'stale';
  if (said.word === 'CAD checked') return 'checked';
  if (said.word === 'measured') return 'constructed';
  if (said.word === 'estimated') return said.note === ASSUMES.declared ? 'declared' : 'inferred';
  if (said.word === 'model prediction') return 'inferred';
  return 'unknown';
}
const provenanceOf = (m: Pick<VoxCardMetric, 'tier'>): Provenance => (m.tier === TIER.model ? 'generated' : 'measured');

/** The image an input's metrics belong to (by role). */
const inputKey = (role?: string, at = 0): string => `input:${role ?? (at ? String(at) : 'a')}`;

const HIGHLIGHT_TITLE: Record<string, string> = { annotated: 'annotated copy', 'difference-heatmap': 'difference heatmap', 'bbox-svg': 'bounding box drawing', frame: 'frame' };
const FRAME_FILE = /\/frame-(\d+)\.png$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** A card read for a record file (scrubbed), or why not. */
function cardOf(i: PreviewInput, file: string): { card: VoxCard; raw: Obj; operation?: string } | { why: string } {
  const read = readPlainInside(i.root, file, RECORD_MAX);
  if (!read.ok) return { why: read.why === 'link' || read.why === 'not-file' ? 'it is not a plain file' : read.words };
  const bytes = read.body;
  const text = bytes.toString('utf8');
  const card = readVoxRecord({ root: i.root, file, text, fileSha256: createHash('sha256').update(bytes).digest('hex'), chain: i.chain, projectId: projectId(i.root) });
  if (!card) return { why: 'it is not a VoxVision record (timmy.vox/1) Timmy can read' };
  let raw: Obj = {};
  try { raw = obj(JSON.parse(text)) ?? {}; } catch { /* read above */ }
  const operation = str(raw.operation);
  return { card: scrubDeep(card, scrubberOf(i)), raw, ...(operation ? { operation } : {}) };
}

/** The sha256 a record's view recorded for a mesh it made (a STEP's tessellation), from the record as written. */
function derivedSha(raw: Obj, path: string): string | undefined {
  const views = Array.isArray(raw.views) ? raw.views : [];
  for (const v of [...views].reverse()) for (const d of Array.isArray(obj(v)?.derived) ? obj(v)!.derived as unknown[] : []) {
    const x = obj(d);
    if (x && x.path === path && typeof x.sha256 === 'string') return x.sha256;
  }
  return undefined;
}

/** The project's record files, newest first by their files' times (the list sorts again by made_at). */
function recordFiles(root: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(join(root, VOX_DIR)).filter((n) => n.endsWith('.json') && VOX_ID.test(n.slice(0, -5))); } catch { names = []; }
  return names.map((n) => { let t = 0; try { t = statSync(join(root, VOX_DIR, n)).mtimeMs; } catch { t = 0; } return { n, t }; })
    .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1)).map((x) => `${VOX_DIR}/${x.n}`);
}

/** The project's records, newest first (made_at, else the file's time): what the page lists. Files only. */
export function listVoxRecords(i: PreviewInput, max = PREVIEW_LIST_MAX): VoxList {
  const files = recordFiles(i.root);
  const pid = projectId(i.root);
  const rows: Array<VoxListRow & { at: number }> = [];
  const unreadable: VoxList['unreadable'] = [];
  for (const file of files.slice(0, max)) {
    const read = cardOf(i, file);
    if ('why' in read) { unreadable.push({ file, why: read.why }); continue; }
    const c = read.card;
    const p = buildPreview(i, c, read.operation, { light: true }, read.raw);
    const made = Date.parse(c.madeAt ?? '');
    let mtime = 0;
    try { mtime = statSync(join(i.root, file)).mtimeMs; } catch { mtime = 0; }
    rows.push({
      id: c.id, file, action: c.action, status: c.status, ...(c.madeAt ? { madeAt: c.madeAt } : {}), ...(c.command ? { command: c.command } : {}),
      inputs: c.inputs.map((x) => ({ path: x.path, ...(x.kind ? { kind: x.kind } : {}), ...(x.role ? { role: x.role } : {}) })),
      check: { status: c.check.status, reasons: c.check.reasons }, receipt: receiptState(c, i.chain, pid), fake: p.fake.is,
      counts: { values: p.values.length, images: p.images.length, overlays: p.overlays.length, frames: p.frames.length },
      at: Number.isFinite(made) ? made : mtime,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return { schema: 'timmy.vox-list/1', records: rows.map(({ at: _at, ...r }) => r), more: Math.max(0, files.length - max), unreadable };
}

/** One record's preview by its id, or why there is none (a 404's words). */
export function voxPreview(i: PreviewInput, id: string): { ok: true; preview: VoxPreview } | { ok: false; status: 400 | 404; error: string } {
  if (!VOX_ID.test(id)) return { ok: false, status: 400, error: `${id.slice(0, 40)} is not a VoxVision record id (v and 8 hex digits).` };
  const file = `${VOX_DIR}/${id}.json`;
  const read = cardOf(i, file);
  if ('why' in read) return { ok: false, status: 404, error: `No VoxVision record ${id} is shown for this project (${file}: ${/ENOENT/.test(read.why) ? 'there is no such file' : read.why}).` };
  return { ok: true, preview: buildPreview(i, read.card, read.operation, { light: false }, read.raw) };
}

/**
 * A record's preview from a card the caller has read already (the Workbench's tab 5: src/workbench/voxvision-tab.ts readVox),
 * light: no mesh drawn and no recording read (the companion draws those), everything else as the page has it.
 */
export function previewOfCard(i: PreviewInput, card: VoxCard, raw: Record<string, unknown> = {}, operation?: string): VoxPreview {
  return buildPreview(i, card, operation, { light: true }, raw);
}

/** The preview of a card. `light`: the list's reading (no mesh drawn, no recording read). */
function buildPreview(i: PreviewInput, c: VoxCard, operation: string | undefined, o: { light: boolean }, raw: Obj): VoxPreview {
  const pid = projectId(i.root);
  const t = toolEnvOf(i);
  const receipt = receiptState(c, i.chain, pid);
  const fake = fakeOf(c);
  const check = { status: c.check.status, reasons: c.check.reasons };

  // the inputs, with whether their bytes now are the recorded ones
  const inputs = c.inputs.map((x) => {
    const now = x.sha256 ? shaNow(i.root, x.path) : undefined;
    return {
      path: x.path, kind: x.kind ?? 'other', kindWords: KIND_WORDS[(x.kind ?? 'other') as VoxKind] ?? x.kind ?? 'other', ...(x.role ? { role: x.role } : {}),
      ...(typeof x.bytes === 'number' ? { bytes: x.bytes } : {}), ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.frame ? { frame: x.frame.words } : {}),
      matches: now === undefined || !x.sha256 ? null : now === x.sha256,
    };
  });

  // the images: each image input (the observed image), then each highlight (annotated copy, heatmap, drawing, frames)
  const images: PreviewImage[] = [];
  c.inputs.forEach((x, k) => {
    if (x.kind !== 'image') return;
    const m = inputs[k];
    const size = x.frame?.size;
    images.push({
      key: inputKey(x.role, k), path: x.path, role: 'input', ...(x.role ? { of: x.role } : {}),
      title: `${x.path}: the observed image${x.role ? ` (${x.role})` : ''}`,
      servable: IMAGE_EXT.test(x.path), ...(IMAGE_EXT.test(x.path) ? {} : { why: 'its name is not an image\'s (.png, .jpg, .gif, .webp)' }),
      matches: m.matches, ...(size ? { frame: [size[0], size[1]] as [number, number], unit: 'px' } : {}),
      ...(m.matches === false ? { note: 'it changed since the record: what was measured is not drawn over it' } : {}),
      provenance: 'not recorded', evidence: c.check.status === 'unverified' ? 'unverified' : m.matches === false ? 'stale' : 'declared',
    });
  });
  const video = c.inputs.find((x) => x.kind === 'video');
  for (const h of c.highlights) {
    const n = FRAME_FILE.exec(h.path);
    const isFrame = h.type === 'frame';
    const of = h.of ?? undefined;
    const sized = isFrame ? (c.inputs.find((x) => x.kind === 'video' && (!of || x.role === of)) ?? video)?.frame?.size
      : c.inputs.find((x) => x.kind === 'image' && (!of || of === 'both' || x.role === of))?.frame?.size;
    images.push({
      key: `${isFrame ? 'frame' : 'highlight'}:${h.path}`, path: h.path, role: isFrame ? 'frame' : 'highlight', ...(of ? { of } : {}),
      title: isFrame ? `frame ${n ? Number(n[1]) : '?'}${of ? ` (${of})` : ''}` : `${HIGHLIGHT_TITLE[h.type ?? ''] ?? h.type ?? 'highlight'}${of && of !== 'both' ? ` (${of})` : ''}`,
      ...(h.type ? { type: h.type } : {}),
      servable: h.shown, ...(h.shown ? {} : { why: h.why ?? 'not checked' }), matches: h.shown ? true : null,
      ...(sized && (isFrame || h.type !== 'bbox-svg') ? { frame: [sized[0], sized[1]] as [number, number], unit: isFrame ? 'video px' : 'px' } : {}),
      ...(h.said ? { word: h.said.word, note: h.said.note } : {}),
      provenance: 'measured', evidence: evidenceOf(h.said, c.check),
    });
  }

  // what was measured over the images: QR codes and ArUco markers (corners), a colour region (box and centroid), a
  // video's colour region at each sampled time, and a model's boxes (Roboflow)
  const overlays: PreviewOverlay[] = [];
  const obsEntities: PreviewEntity[] = [];
  const valueOf = (m: VoxCardMetric): { word: string; evidence: Evidence; provenance: Provenance } => ({ word: m.said?.word ?? 'unknown', evidence: evidenceOf(m.said, c.check), provenance: provenanceOf(m) });
  const imageFor = (of?: string): PreviewImage | undefined => images.find((x) => x.role === 'input' && (x.of ?? undefined) === (of ?? undefined)) ?? (of ? undefined : images.find((x) => x.role === 'input'));
  const drawable = (im: PreviewImage | undefined): im is PreviewImage => !!im && im.matches !== false;
  const add = (entity: string, im: PreviewImage, shape: PreviewOverlay['shape'], points: number[], label: string, v: { word: string; evidence: Evidence; provenance: Provenance }): string => {
    const id = `${entity}#${overlays.filter((x) => x.entity === entity).length + 1}`;
    overlays.push({ id, entity, image: im.key, shape, points, label, ...v });
    return id;
  };
  /** provenance and evidence state, and the record's word where it says more than they do */
  const words = (v: { provenance: Provenance; evidence: Evidence; word: string }): string => `provenance ${v.provenance} · evidence ${v.evidence}${v.word !== 'measured' && v.word !== 'model prediction' ? ` · ${v.word}` : ''}`;
  for (const m of c.metrics) {
    if (m.malformed) continue;
    const base = m.name.split(':')[0];
    const v = valueOf(m);
    const im = imageFor(m.of);
    if ((base === 'qr_codes_decoded' || base === 'aruco_markers') && Array.isArray(m.value)) {
      m.value.forEach((x, k) => {
        const e = obj(x);
        const p = pts(e?.corners);
        if (!e || !p || !drawable(im)) return;
        const name = base === 'qr_codes_decoded' ? `QR ${k + 1}${str(e.text) ? ` "${str(e.text)!.slice(0, 60)}"` : ''}` : `ArUco id ${String(e.id ?? '?')}`;
        const entity = `${base === 'qr_codes_decoded' ? 'qr' : 'aruco'}${m.of ? `-${m.of}` : ''}-${k + 1}`;
        const id = add(entity, im, 'polygon', p, name, v);
        obsEntities.push({ id: entity, path: `/observations/${m.of ? `${m.of}/` : ''}${base === 'qr_codes_decoded' ? 'qr' : 'aruco'}/${k + 1}`, label: name, kind: 'observation', detail: `${p.length / 2} corners in px (${m.title}) · ${words(v)}`, ...v, image: im.key, overlays: [id], value: m.name });
      });
    } else if (base === 'color_region' && obj(m.value)) {
      const r = obj(m.value)!;
      const b = box4(r.box);
      const ctr = xy(r.centroid);
      if (!drawable(im) || (!b && !ctr)) continue;
      const rgb = Array.isArray(r.rgb) ? `rgb(${(r.rgb as unknown[]).join(', ')})` : 'the colour asked';
      const ids = [
        ...(b ? [add('color-region', im, 'box', b, `colour region ${rgb}`, v)] : []),
        ...(ctr ? [add('color-region', im, 'point', ctr, 'centroid', v)] : []),
      ];
      obsEntities.push({ id: 'color-region', path: `/observations/${m.of ? `${m.of}/` : ''}color_region`, label: `colour region ${rgb}`, kind: 'observation',
        detail: `${typeof r.pixels === 'number' ? `${r.pixels} px` : '? px'}${typeof r.share === 'number' ? ` (${num(r.share)} of the image)` : ''}${b ? ` · box ${b.join(', ')} px` : ''}${ctr ? ` · centroid ${ctr.map((z) => num(z)).join(', ')} px` : ''} · ${words(v)}`, ...v, image: im.key, overlays: ids, value: m.name });
    }
  }
  // a video's colour region at each sampled time: on that time's frame (frame N of the readback)
  const frames: PreviewFrame[] = [];
  const frameImages = images.filter((x) => x.role === 'frame').map((x) => ({ x, n: Number(FRAME_FILE.exec(x.path)?.[1] ?? NaN) }))
    .sort((a, b) => (a.x.of ?? '').localeCompare(b.x.of ?? '') || a.n - b.n);
  for (const [k, f] of frameImages.entries()) {
    const m = c.metrics.find((x) => !x.malformed && x.name.startsWith('color_at:') && (x.of ?? undefined) === (f.x.of && f.x.of !== 'both' ? f.x.of : undefined) && new RegExp(`\\(frame ${f.n}\\)$`).test(x.title));
    const time = m ? Number(m.name.slice('color_at:'.length)) : NaN;
    const ids: string[] = [];
    if (m && obj(m.value) && f.x.matches !== false) {
      const r = obj(m.value)!;
      const v = valueOf(m);
      const b = box4(r.box_px);
      const ctr = xy(r.centroid_px);
      const entity = `frame-${f.x.of ? `${f.x.of}-` : ''}${f.n}`;
      if (b) ids.push(add(entity, f.x, 'box', b, `colour region at ${num(time)} s`, v));
      if (ctr) ids.push(add(entity, f.x, 'point', ctr, 'centroid', v));
      obsEntities.push({ id: entity, path: `/observations/${f.x.of ? `${f.x.of}/` : ''}frames/${f.n}`, label: `t = ${Number.isFinite(time) ? num(time) : '?'} s (frame ${f.n})`, kind: 'observation',
        detail: r.found === false ? `the colour was not found in this frame · ${words(v)}` : `${b ? `box ${b.join(', ')}` : 'no box'}${ctr ? ` · centroid ${ctr.map((z) => num(z)).join(', ')}` : ''} (video px) · ${words(v)}`, ...v, image: f.x.key, overlays: ids, value: m.name });
    }
    frames.push({ index: k, image: f.x.key, frame: Number.isFinite(f.n) ? f.n : null, time: Number.isFinite(time) ? time : null, ...(f.x.of ? { of: f.x.of } : {}), label: `${Number.isFinite(time) ? `${num(time)} s` : 'time not recorded'} · frame ${Number.isFinite(f.n) ? f.n : '?'}${f.x.of ? ` (${f.x.of})` : ''}`, overlays: ids });
  }
  // a model's boxes (Roboflow's predictions: centre x, y, width and height in px): generated, never measured
  for (const cl of c.claims) {
    if (cl.malformed || cl.name !== 'roboflow_predictions' || !Array.isArray(cl.value)) continue;
    const im = imageFor(undefined);
    if (!drawable(im)) continue;
    const v = { word: 'model prediction', evidence: (c.check.status === 'unverified' ? 'unverified' : c.check.status === 'stale' ? 'stale' : 'inferred') as Evidence, provenance: 'generated' as Provenance };
    cl.value.forEach((x, k) => {
      const p = obj(x);
      if (!p || !finite(p.x) || !finite(p.y) || !finite(p.width) || !finite(p.height)) return;
      const b = [p.x - p.width / 2, p.y - p.height / 2, p.x + p.width / 2, p.y + p.height / 2];
      const name = `${str(p.class) ?? 'class not given'}${finite(p.confidence) ? ` ${num(p.confidence)}` : ''}`;
      const entity = `prediction-${k + 1}`;
      const id = add(entity, im, 'box', b, `${name} (a model's prediction)`, v);
      obsEntities.push({ id: entity, path: `/observations/roboflow/${k + 1}`, label: name, kind: 'observation', detail: `a model's prediction (Roboflow), not a measurement · ${words(v)}`, ...v, image: im.key, overlays: [id], value: cl.name });
    });
  }

  // the values, each with its word, provenance and evidence state
  const valueRow = (m: VoxCardMetric, claim: boolean): PreviewValue => {
    const v = m.malformed ? { word: 'unknown', evidence: 'unknown' as Evidence, provenance: 'not recorded' as Provenance } : claim ? { word: 'model prediction', evidence: evidenceOf(m.said, c.check), provenance: 'generated' as Provenance } : valueOf(m);
    const text = m.malformed ? 'a malformed entry of the record' : metricText({ name: m.name, value: m.value, ...(m.unit ? { unit: m.unit } : {}) });
    return {
      name: m.name, title: m.title, text: text.length > 240 ? `${text.slice(0, 239)}…` : text, ...(m.of ? { of: m.of } : {}), word: v.word, ...(m.said?.note ? { note: m.said.note } : {}),
      provenance: v.provenance, evidence: v.evidence, ...(m.method ? { method: m.method } : {}), ...(m.measured_by ? { measured_by: m.measured_by } : {}), ...(claim ? { claim: true } : {}),
    };
  };
  const values = [...c.metrics.map((m) => valueRow(m, false)), ...c.claims.map((m) => valueRow(m, true))];

  // meshes: an STL input drawn from its own triangles; a STEP from its tessellation, once /vox view made one
  const spatial: PreviewSpatial[] = [];
  const cadChecked = (c.checks ?? []).some((x) => x.agrees);
  c.inputs.forEach((x, k) => {
    if (x.kind === 'stl') {
      const m = inputs[k];
      const base: Omit<PreviewSpatial, 'words'> = { key: `mesh:${x.path}`, source: x.path, what: `${x.path}${x.role ? ` (${x.role})` : ''}: the STL's own triangles`, provenance: cadChecked ? 'generated' : 'not recorded', evidence: c.check.status === 'unverified' ? 'unverified' : m.matches === false ? 'stale' : 'declared', unit: "the file's units (an STL declares none)" };
      spatial.push(o.light ? { ...base, words: 'drawn when the record is opened' } : drawMesh(i, x.path, x.sha256, m.matches, base));
    } else if (x.kind === 'step') {
      const d = [...(c.views ?? [])].reverse().flatMap((v) => v.derived ?? []).find((y) => y.from === x.path);
      const base: Omit<PreviewSpatial, 'words'> = { key: `mesh:${d?.path ?? x.path}`, source: d?.path ?? x.path, what: d ? `${d.path}: a tessellation of ${x.path} (OCP), not the STEP itself` : `${x.path}: a STEP`, provenance: d ? 'reconstructed' : 'not recorded', evidence: c.check.status === 'unverified' ? 'unverified' : 'constructed', unit: 'mm' };
      if (!d) spatial.push({ ...base, why: `no tessellation of this STEP yet: \`/vox view ${c.id}\` has OCP make one (it needs TIMMY_CADQUERY_PYTHON), and then it is drawn here`, words: 'not drawn: Rerun and this page draw meshes, not STEP surfaces' });
      else spatial.push(o.light ? { ...base, words: 'drawn when the record is opened' } : drawMesh(i, d.path, derivedSha(raw, d.path), null, { ...base, what: `${base.what}: ${d.words}` }));
    }
  });

  // recordings: what Timmy reads of a Rerun recording the record names
  const rr = rerunReady(t);
  const viewer = { state: rr.ready ? 'found (installed here, not run)' : 'needs setup', words: rr.ready ? `Rerun's viewer is found (${rr.via}); found is not run: /vox view ${c.id} starts it, a window on this computer` : `Rerun's viewer needs setup: ${rr.setup}`, command: `/vox view ${c.id}` };
  const recordings: PreviewRecording[] = [];
  for (const x of c.inputs) {
    const at = resolveInside(i.root, x.path);
    if ('error' in at) continue;
    if (!/\.rrd$/i.test(x.path) && !isRecording(headBytes(at.path, 4))) continue;
    if (o.light) { recordings.push({ path: x.path, why: 'read when the record is opened', viewer }); continue; }
    let facts: RecordingFacts | undefined;
    let why: string | undefined;
    const read = readPlainInside(i.root, at.rel, MESH_READ_MAX);
    if (!read.ok) why = read.why === 'too-large' ? `it is larger than ${MESH_READ_MAX / 1024 / 1024} MB, more than is read here` : read.words;
    else { const r = readRecording(read.body); if ('error' in r) why = r.error; else facts = r; }
    recordings.push({ path: x.path, ...(facts ? { facts } : {}), ...(why ? { why } : {}), viewer });
  }

  // the pipeline as the record ran it: .intent, each tool, each tool that needed setup, .receipt; then what Timmy has not
  const steps: PipelineStep[] = [{ name: '.intent', state: 'asked', words: c.command ?? `${c.action} (no command recorded)`, tone: 'intent' }];
  for (const x of c.tools) {
    const failed = x.ran === 'job' && x.state !== undefined && x.state !== 'completed';
    steps.push({
      name: x.name && x.tool !== 'look' ? `${x.tool} (${x.name})` : x.tool === 'look' ? 'Look (OpenCV)' : x.tool,
      state: x.ran === 'in-process' ? "ran in Timmy's process" : x.job ? `job ${x.job} ${x.state ?? ''}`.trim() : 'ran',
      words: [x.name, x.version, x.engine ? `(${x.engine})` : ''].filter(Boolean).join(' ') || x.tool, tone: failed ? 'failed' : 'ran',
    });
  }
  for (const f of c.failures) {
    if (f.code !== 'needs-setup' && f.code !== 'failed') continue;
    steps.push({ name: f.tool, state: f.code === 'needs-setup' ? 'needs setup' : 'failed', words: f.message, tone: f.code === 'needs-setup' ? 'setup' : 'failed', ...(f.setup ? { setup: f.setup } : {}) });
  }
  steps.push({ name: '.receipt', state: receipt.verified ? 'sealed and verified' : receipt.short ? 'sealed, not verified' : 'not sealed', words: receipt.words, tone: receipt.verified ? 'verified' : receipt.short ? 'sealed' : 'none' });
  const engines = enginesOf(t);
  const absent = engines.filter((e) => e.tone !== 'here' && ['SAM 3', 'Depth Anything 3', 'Voxel grid from masks', 'Roboflow (hosted model)', 'FiftyOne', 'Viser'].includes(e.name));

  // the entity tree: the record, its inputs, what was observed, its images, meshes, recordings, values and receipt
  const tree: PreviewEntity[] = [];
  const kids: PreviewEntity[] = [];
  kids.push({
    id: 'inputs', path: '/inputs', label: `inputs (${c.inputs.length})`, kind: 'group', children: c.inputs.map((x, k): PreviewEntity => {
      const im = images.find((y) => y.role === 'input' && y.path === x.path);
      const size = x.frame?.size ? `${x.frame.size[0]} × ${x.frame.size[1]} ${x.frame.unit ?? 'px'}` : x.frame?.unit ? `in ${x.frame.unit}` : '';
      return { id: `input-${k + 1}`, path: `/inputs/${x.role ?? k + 1}`, label: `${x.role ? `${x.role}: ` : ''}${x.path}`, kind: 'input', detail: [inputs[k].kindWords, size, inputs[k].matches === false ? 'changed since the record' : inputs[k].matches ? 'its bytes the recorded ones' : ''].filter(Boolean).join(' · '), ...(im ? { image: im.key } : {}) };
    }),
  });
  if (obsEntities.length) kids.push({ id: 'observations', path: '/observations', label: `observed (${obsEntities.length})`, kind: 'group', children: obsEntities });
  else kids.push({ id: 'observations', path: '/observations', label: 'observed (none drawn)', kind: 'group', detail: noOverlayWhy(c, images) });
  const hl = images.filter((x) => x.role !== 'input');
  if (hl.length) kids.push({ id: 'images', path: '/images', label: `images (${hl.length})`, kind: 'group', children: hl.map((x, k): PreviewEntity => ({ id: `image-${k + 1}`, path: `/images/${x.path.split('/').pop()}`, label: x.title, kind: 'image', detail: x.servable ? `provenance ${x.provenance} · evidence ${x.evidence}${x.word && x.word !== 'measured' ? ` · ${x.word}` : ''}` : `not shown: ${x.why ?? 'not checked'}`, image: x.key, provenance: x.provenance, evidence: x.evidence })) });
  if (spatial.length) kids.push({ id: 'meshes', path: '/meshes', label: `meshes (${spatial.length})`, kind: 'group', children: spatial.map((s, k): PreviewEntity => ({ id: `mesh-${k + 1}`, path: `/meshes/${s.source.split('/').pop()}`, label: s.what, kind: 'mesh', detail: s.why ?? `${s.triangles ?? '?'} triangles · provenance ${s.provenance} · evidence ${s.evidence}`, provenance: s.provenance, evidence: s.evidence })) });
  if (recordings.length) kids.push({ id: 'recordings', path: '/recordings', label: `recordings (${recordings.length})`, kind: 'group', children: recordings.map((r, k): PreviewEntity => ({ id: `recording-${k + 1}`, path: `/recordings/${r.path.split('/').pop()}`, label: r.path, kind: 'recording', detail: r.facts ? `${r.facts.writer} · ${r.facts.messages.chunks} chunks · entities: unknown to Timmy` : r.why ?? '' })) });
  kids.push({ id: 'values', path: '/values', label: `values (${values.length})`, kind: 'group', children: values.map((v, k): PreviewEntity => ({ id: `value-${k + 1}`, path: `/values/${v.of ? `${v.of}/` : ''}${v.name}`, label: `${v.title}: ${v.text}`, kind: 'value', detail: `provenance ${v.provenance} · evidence ${v.evidence}${v.word !== 'measured' && v.word !== 'model prediction' ? ` · ${v.word}` : ''}`, word: v.word, provenance: v.provenance, evidence: v.evidence, value: v.name })) });
  kids.push({ id: 'receipt', path: '/receipt', label: receipt.verified ? `✓ receipt ${receipt.short}` : receipt.short ? `receipt ${receipt.short}, not verified` : 'no receipt', kind: 'receipt', detail: receipt.words });
  tree.push({ id: 'record', path: `/${c.id}`, label: `${c.id} · ${c.action} · ${c.status === 'needs-setup' ? 'needs setup' : c.status}`, kind: 'record', children: kids });

  // the commands that act on it: copied for Timmy's terminal, each with its effect; one primary next step
  const actions: PreviewAction[] = [];
  const first = c.inputs[0];
  const arg = first ? voxArg(first.path) ?? first.path : '';
  const viewable = c.check.status !== 'unverified';
  actions.push(rr.ready
    ? { label: 'Open in Rerun', command: `/vox view ${c.id}`, effect: "opens Rerun's own viewer, a window on this computer that Timmy does not stop; it shows the record's files and measures nothing; a vox receipt records the view", primary: false, enabled: viewable, ...(viewable ? {} : { why: `the record is not verified (${c.check.reasons[0] ?? 'no receipt'}), so /vox view passes nothing of it` }) }
    : { label: 'Open in Rerun', command: `/vox view ${c.id}`, effect: "opens Rerun's own viewer", primary: false, enabled: false, why: `Rerun's viewer needs setup here: ${rr.setup}` });
  if (first && first.kind !== 'other') {
    actions.push({ label: 'Measure it', command: `/measure ${arg}`, effect: `runs ${first.kind === 'image' ? 'Look (OpenCV)' : 'its tool'} on ${first.path} as a job, and writes a new record with a vox receipt (a local change)`, primary: false, enabled: true });
    if (first.kind === 'image') actions.push({ label: 'Observe it', command: `/observe ${arg}`, effect: "Look's observation of the image, written to results/observations with a receipt (a local change)", primary: false, enabled: true });
  }
  if (c.command) actions.push({ label: 'Do it again', command: c.command, effect: 'the same action on the same files: a new record and a new vox receipt (a local change)', primary: false, enabled: true });
  actions.push({ label: 'Open the record', command: `/open ${c.file}`, effect: "shows the record's JSON in the REPL; changes nothing", primary: false, enabled: true });
  const primary = actions.find((a) => a.enabled && a.label === 'Open in Rerun') ?? actions.find((a) => a.enabled && a.label === 'Measure it') ?? actions.find((a) => a.enabled);
  if (primary) primary.primary = true;

  return {
    schema: PREVIEW_SCHEMA, id: c.id, file: c.file, action: c.action, status: c.status, ...(c.command ? { command: c.command } : {}), ...(c.madeAt ? { madeAt: c.madeAt } : {}), ...(operation ? { operation } : {}),
    fake, check, receipt, inputs, images, overlays, entities: tree, frames, values, pipeline: { steps, absent }, engines, spatial, recordings,
    failures: c.failures.map((f) => ({ tool: f.tool, code: f.code, message: f.message, ...(f.setup ? { setup: f.setup } : {}) })), notes: c.notes,
    views: (c.views ?? []).map((v) => ({ at: v.at, viewer: v.viewer, passed: v.passed, ...(v.receipt ? { receipt: v.receipt } : {}) })), checks: c.checks ?? [], ...(c.together ? { together: c.together } : {}),
    ...(c.doctrine || c.inputs.some((x) => x.kind === 'stl' || x.kind === 'step' || x.kind === 'blend' || x.kind === 'ply') ? { doctrine: DOCTRINE_15 } : {}),
    verdict: NO_VERDICT, actions,
    legend: { provenance: { ...PROVENANCE_MEANS }, evidence: { ...EVIDENCE_MEANS }, words: { ...WORD_MEANS } },
  };
}

/** Why nothing is drawn over a record's images, in words (never left blank). */
function noOverlayWhy(c: VoxCard, images: readonly PreviewImage[]): string {
  if (!images.some((x) => x.role === 'input' || x.role === 'frame')) return c.inputs.some((x) => x.kind === 'stl' || x.kind === 'step') ? 'a mesh, not an image: its three views are under meshes' : `no image: this record observed ${c.inputs.map((x) => KIND_WORDS[(x.kind ?? 'other') as VoxKind] ?? x.kind).join(' and ') || 'nothing'}`;
  if (images.some((x) => x.role === 'input' && x.matches === false)) return 'the image changed since the record, so what was measured is not drawn over it';
  if (c.action === 'inspect') return "/inspect counts QR codes and markers; /detect and /measure record their corners, which are drawn";
  if (c.failures.some((f) => f.code === 'needs-setup')) return 'its tool needed setup, so nothing was measured';
  return 'nothing with a place in the image was found (no QR code, marker or colour region)';
}

/** A mesh file the record names, drawn as three views, or why not. */
function drawMesh(i: PreviewInput, rel: string, sha256: string | undefined, matches: boolean | null, base: Omit<PreviewSpatial, 'words'>): PreviewSpatial {
  const at = resolveInside(i.root, rel);
  if ('error' in at) return { ...base, why: at.error, words: 'not drawn' };
  const read = readPlainInside(i.root, at.rel, MESH_READ_MAX);
  if (!read.ok) return { ...base, why: read.why === 'too-large' ? `it is larger than ${MESH_READ_MAX / 1024 / 1024} MB, more than is drawn here: Rerun's viewer draws it (/vox view)` : read.words, words: 'not drawn' };
  const buf = read.body;
  if (sha256 && createHash('sha256').update(buf).digest('hex') !== sha256) matches = false;
  if (matches === false) return { ...base, evidence: 'stale', why: 'it changed since the record, so it is not drawn as the record\'s', words: 'not drawn' };
  const parsed = parseStl(buf);
  if ('error' in parsed) return { ...base, why: parsed.error, words: 'not drawn' };
  const p = projectMesh(parsed.triangles);
  if ('error' in p) return { ...base, why: p.error, words: 'not drawn' };
  const cut = p.views.filter((v) => v.drawn < v.total);
  return {
    ...base, triangles: p.triangles, box: p.box.size, views: p.views, scale: p.scale, method: p.method,
    words: `${p.triangles} triangles · box ${p.box.size.map((z) => num(z)).join(' × ')} · ${p.edges.feature} feature edges${p.edges.boundary ? `, ${p.edges.boundary} open` : ''}${cut.length ? ` · ${cut.map((v) => `${v.name}: ${v.drawn} of ${v.total} lines drawn`).join(', ')}` : ''}; a drawing of the file, measuring nothing`,
  };
}

/** The engines this computer has and has not for VoxVision, in the panel's words. */
export function enginesOf(t: ToolEnv): EngineRow[] {
  const rows: EngineRow[] = [];
  let statuses: ReturnType<typeof toolStatuses> = [];
  try { statuses = toolStatuses(t); } catch { statuses = []; }
  for (const s of statuses) {
    if (s.tool === 'viser' || s.tool === 'fiftyone') continue;
    if (s.tool === 'roboflow') {
      const r = roboflowReady(t);
      rows.push(r.ready ? { name: 'Roboflow (hosted model)', state: 'found, not run', words: "a network call to Roboflow's hosted model, made only when /detect … --roboflow asks; its boxes are a model's prediction", tone: 'here' }
        : { name: 'Roboflow (hosted model)', state: 'needs setup', words: r.why, setup: r.setup, tone: 'setup' });
      continue;
    }
    rows.push({ name: s.name, state: s.state, words: `${s.reads} · ${s.detail}`, ...(s.setup ? { setup: s.setup } : {}), tone: s.state === 'needs setup' ? 'setup' : 'here' });
  }
  rows.push({ name: 'SAM 3', state: 'not installed', words: 'Timmy has no SAM 3 (Segment Anything) adapter, so no mask is segmented here', tone: 'absent' });
  rows.push({ name: 'Depth Anything 3', state: 'not installed', words: 'Timmy has no Depth Anything adapter, so no depth is estimated here', tone: 'absent' });
  rows.push({ name: 'Voxel grid from masks', state: 'not in Timmy', words: 'no fusion of 2D masks into a voxel grid (the geo lane scores two point clouds; it builds no grid from images)', tone: 'absent' });
  for (const l of LATER_LAYERS) rows.push({ name: l.name, state: 'not used by VoxVision', words: `VoxVision has no ${l.name} layer yet, so whether it is installed is not checked here; it would add ${l.adds}`, setup: l.setup, tone: 'absent' });
  return rows;
}

// ── the file route's rules ─────────────────────────────────────────────────────

/** An image's type by its first bytes (and its name must agree): PNG, JPEG, GIF, WebP; SVG only for Timmy's own drawings. */
function imageType(rel: string, head: Buffer, svgOk: boolean): string | null {
  const at = (s: string, off = 0): boolean => head.length >= off + s.length && head.subarray(off, off + s.length).toString('latin1') === s;
  const ext = rel.toLowerCase().split('.').pop() ?? '';
  if (at('\x89PNG\r\n\x1a\n')) return ext === 'png' ? 'image/png' : null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null;
  if (at('GIF87a') || at('GIF89a')) return ext === 'gif' ? 'image/gif' : null;
  if (at('RIFF') && at('WEBP', 8)) return ext === 'webp' ? 'image/webp' : null;
  if (svgOk && ext === 'svg' && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(head.toString('utf8'))) return 'image/svg+xml';
  return null;
}

export type VoxFileAnswer = { ok: true; type: string; body: Buffer } | { ok: false; status: 400 | 403 | 404 | 413 | 415; error: string };

/**
 * A file of a record for the page: only an image the record names (an input, a highlight the board would show, a frame), a
 * regular file inside the project reached without a link and without "..", of a type its bytes and name agree on, at most
 * VOX_FILE_MAX bytes, read through one descriptor so the file checked is the file served (./read-plain.ts: a file swapped
 * between the checks and the read is refused). Anything else is refused with why. `hooks` is for tests only.
 */
export function voxFile(i: PreviewInput, id: string, rel: string, hooks: PlainReadHooks = {}): VoxFileAnswer {
  if (typeof rel !== 'string' || rel.length > 512 || !plainRel(rel)) {
    return { ok: false, status: 400, error: 'Refused: a file is named by its path inside the project, without "..", "." or a leading "/".' };
  }
  const p = voxPreview(i, id);
  if (!p.ok) return { ok: false, status: p.status === 400 ? 400 : 404, error: p.error };
  const named = p.preview.images.find((x) => x.path === rel);
  if (!named) return { ok: false, status: 404, error: `Refused: ${rel} is not an image record ${id} names, so it is not served.` };
  if (!named.servable) return { ok: false, status: 404, error: `Not served: ${rel} is not shown (${named.why ?? 'not checked'}).` };
  const at = resolveInside(i.root, rel);
  if ('error' in at) return { ok: false, status: 403, error: `Refused: ${at.error}.` };
  const read = readPlainInside(i.root, rel, VOX_FILE_MAX, hooks);
  if (!read.ok) {
    switch (read.why) {
      case 'link': case 'not-file': case 'changed': return { ok: false, status: 403, error: `Refused: ${rel} ${read.words.replace(/^it /, '')}, so it is not served.` };
      case 'too-large': return { ok: false, status: 413, error: `Not served: ${rel} is larger than ${VOX_FILE_MAX / 1024 / 1024} MB.` };
      case 'path': return { ok: false, status: 400, error: 'Refused: a file is named by its path inside the project, without "..", "." or a leading "/".' };
      default: return { ok: false, status: 404, error: `Not served: ${rel} (${read.words}).` };
    }
  }
  const body = read.body;
  const type = imageType(rel, body.subarray(0, 512), named.type === 'bbox-svg');
  if (!type) return { ok: false, status: 415, error: `Refused: ${rel} is not an image of a type served here (PNG, JPEG, GIF, WebP, or Timmy's own SVG drawing), by its bytes and its name.` };
  return { ok: true, type, body };
}
