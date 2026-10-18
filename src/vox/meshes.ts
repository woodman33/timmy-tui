/**
 * R7 (H153): the project's meshes and recordings as tab 6 (3D & Motion; the 3D part of reference 06) lists them, read once
 * here for both surfaces: the companion's panel (src/companion/panels/create.ts, drawn by src/companion/client/panel-create.js)
 * and the Workbench's tab (src/workbench/create-tab.ts). Only readers Timmy already has are used; nothing runs, nothing is
 * installed, no model is asked:
 *
 *   STL           each .stl file of the project (as its file list walks it: no dependencies, git, dot folders, links or
 *                 private files), named so (an STL has no magic number) and its bytes checked when read: measured
 *                 by Timmy's own STL reader (src/native/stl-readback.ts readbackOf, the reading readStlFile makes) from the
 *                 whole file, read once through one descriptor (./read-plain.ts: no link, no "..", at most MESH_READ_MAX)
 *   OBJ, PLY      R8 (H154): each .obj and .ply file, found and read the same way, measured from the whole file by Timmy's own
 *                 OBJ reader (src/native/obj-readback.ts, timmy-obj-readback/1) or PLY reader (src/native/ply-readback.ts,
 *                 timmy-ply-readback/1), which measure with the STL reader's own measure: the same measurements and words.
 *                 Each row names its kind and its reader; what a reader does not read yet, or a file with no faces, says why
 *   tessellation  an STL a VoxVision record's view names as a STEP's tessellation (src/vox/tessellate.ts writes them into
 *                 results/vox/<id>/), when its bytes are the ones the record names: a mesh of the STEP's surfaces within the
 *                 record's tolerance, never the STEP itself. Nothing is tessellated here (that worker needs OCP).
 *   recording     each .rrd file: its header facts (./recording.ts readRecording). Its chunks are not decoded, so its
 *                 entities, frames and time range stay unknown, with why; Rerun's own viewer is named found or needing
 *                 setup, and never started from here.
 *
 * meshView gives one listed mesh's own triangles (the file's float32 corners, nine per triangle) for Timmy's drawing on the
 * companion: every triangle up to the cap, above it an even, deterministic pick through the file's order (viewPick), with its
 * counts said. The measurements are always of the whole file, and a drawing measures nothing (DOCTRINE §15).
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { OBJ_READBACK, objReadbackOf, parseObj, type ObjReadback } from '../native/obj-readback.js';
import { parsePly, PLY_READBACK, plyReadbackOf, type PlyReadback } from '../native/ply-readback.js';
import { DOCTRINE_15, num, parseStl, readbackOf, STL_READBACK, topologyWords, volumeWords, type StlReadback } from '../native/stl-readback.js';
import { privatePath, projectId } from '../project/index.js';
import type { Receipt } from '../utils/receipts.js';
import { rerunBindArgs, rerunReady, RERUN_SETUP } from './layers.js';
import { onPathOf } from './preview.js';
import { plainRel, readPlainInside } from './read-plain.js';
import { readRecording, type RecordingFacts } from './recording.js';
import { VOX_DIR, VOX_ID } from './record.js';

export const MESHES_SCHEMA = 'timmy.meshes/1';
/** The most meshes and recordings one list names (the rest are counted). */
export const MESH_LIST_MAX = 48;
export const RECORDING_LIST_MAX = 24;
/** The largest mesh or recording read here (as the VoxVision panel reads them). */
export const MESH_READ_MAX = 64 * 1024 * 1024;
/** The most triangles the view draws; above it, an even pick of this many (viewPick). */
export const VIEW_MAX_TRIANGLES = 40_000;
/** The most entries of the project's folders the walk looks at, and how deep it goes. */
const WALK_MAX = 50_000;
const WALK_DEPTH = 12;
/** The folders the project's file list never walks (src/project/index.ts listProjectFiles' SKIP_DIRS), and every dot folder. */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'coverage']);
/** The most VoxVision records read for their tessellations, and the largest one read. */
const RECORDS_MAX = 200;
const RECORD_MAX = 1024 * 1024;

/** What the view is, in the words every surface shows beside it. */
export const VIEW_WORDS = "Timmy's own view of the file's triangles, drawn on a plain canvas (orthographic, flat shading by each face's normal under one fixed light, painter's order): not a render by Blender or any native tool, and it measures nothing";
/** The mesh files tab 6 reads, by their names' endings. */
export type MeshFileKind = 'stl' | 'obj' | 'ply';
/** A measurement by one of Timmy's own mesh readers. */
export type MeshReadback = StlReadback | ObjReadback | PlyReadback;
/** A reader as every surface names it: its id, its name, and who measured in words. */
export interface MeshReader { id: string; name: string; words: string }

const READERS: Record<MeshFileKind, { id: string; name: string }> = {
  stl: { id: STL_READBACK, name: "Timmy's own STL reader" },
  obj: { id: OBJ_READBACK, name: "Timmy's own OBJ reader" },
  ply: { id: PLY_READBACK, name: "Timmy's own PLY reader" },
};
const FROM_THE_FILE = "from the whole file: a deterministic computation on its bytes, in the file's own units";
/** Who measured an STL, in words. */
export const READER_WORDS = `Timmy's own STL reader (${STL_READBACK}), ${FROM_THE_FILE}`;
/** The reader of a kind of mesh file. */
export function readerOf(kind: MeshFileKind): MeshReader {
  const r = READERS[kind];
  return { id: r.id, name: r.name, words: `${r.name} (${r.id}), ${FROM_THE_FILE}` };
}
/** Who measured the meshes of a list, in words: the readers that measured any (the STL reader's words when none did). */
function readersWords(kinds: ReadonlySet<MeshFileKind>): string {
  const ks = (['stl', 'obj', 'ply'] as const).filter((k) => kinds.has(k));
  if (ks.length <= 1) return readerOf(ks[0] ?? 'stl').words;
  const named = ks.map((k) => `${k.toUpperCase()} reader (${READERS[k].id})`);
  return `Timmy's own ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}, each ${FROM_THE_FILE}`;
}

/** Where a mesh file came from, as far as Timmy's records say. */
export interface MeshOrigin { provenance: 'not recorded' | 'reconstructed'; words: string }

export interface MeshRow {
  /** the file, relative to the project */
  path: string;
  kind: MeshFileKind | 'tessellation';
  bytes: number;
  origin: MeshOrigin;
  /** the reader that measures it (a tessellation's is the STL reader) */
  reader: MeshReader;
  /** the file's form, in words: binary STL, ASCII STL, Wavefront OBJ (text), PLY (ascii or binary little-endian) */
  format?: string;
  /** the file's own words, declared and not checked: a binary STL's 80-byte header, an ASCII STL's solid name, an OBJ's first
   *  comment (else its first object's name), a PLY header's first comment */
  declared?: { words: string; what: string };
  /** Timmy's own reader of its kind, of the whole file; absent when it was not measured (`why` says why) */
  readback?: MeshReadback;
  /** the readback's topology and volume in words (src/native/stl-readback.ts topologyWords, volumeWords) */
  topology?: string;
  volume?: string;
  /** an OBJ's or PLY's faces (a polygon split as a fan) and what its reader ignored, in words */
  faces?: string;
  ignored?: string;
  why?: string;
  /** what the view draws of it: every triangle, or an even pick of them */
  view?: { shown: number; total: number; words: string };
  /** not measured yet: a reading with a time budget measures it next (`why` says so) */
  pending?: true;
  /** a tessellation: the VoxVision record that names these bytes, what it was made from and how */
  tessellation?: { record: string; from: string; made_by: string; tolerance: string; sealed: boolean | null };
}

export interface RecordingRow { path: string; bytes: number; facts?: RecordingFacts; why?: string }

export interface MeshList {
  schema: typeof MESHES_SCHEMA;
  meshes: MeshRow[];
  more: number;
  /** how many listed meshes are still to be measured (a reading with a time budget leaves them for the next) */
  pending: number;
  recordings: RecordingRow[];
  recordingsMore: number;
  /** Rerun's own viewer as this computer has it: found (never run here) or needing setup */
  viewer: { name: string; state: 'found (installed here, not run)' | 'needs setup'; words: string; setup?: string };
  /** how much of the project was walked */
  walk: { files: number; truncated: boolean };
  cap: number;
  view: string;
  reader: string;
  doctrine: string;
}

export interface MeshListInput {
  root: string;
  /** PATH and TIMMY_RERUN, for Rerun's viewer (found or not; nothing is run) */
  env: NodeJS.ProcessEnv;
  /** the runs chain (or how to read it, read only when a tessellation is named), to say whether a vox receipt sealed a
   *  tessellation's bytes; absent: not checked */
  chain?: readonly Receipt[] | (() => readonly Receipt[]);
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const isStl = (rel: string): boolean => /\.stl$/i.test(rel);
const isRrd = (rel: string): boolean => /\.rrd$/i.test(rel);
/** A mesh file's kind by its name's ending (.stl, .obj, .ply in any case), or null. */
const meshKindOf = (rel: string): MeshFileKind | null => { const m = /\.(stl|obj|ply)$/i.exec(rel); return m ? m[1].toLowerCase() as MeshFileKind : null; };
const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

interface MeshFile { path: string; bytes: number; kind: MeshFileKind }

/**
 * The project's mesh and recording files (sorted by path), by the project's file list's rules (src/project/index.ts
 * listProjectFiles): no dependencies, no git, no link, no private file (keys, .env), no dot file; and no dot folder at all, so
 * Timmy's own .timmy and .sessions (a record's private files, a rejected tessellation kept as written) are not the project's
 * meshes. Only .stl, .obj, .ply and .rrd names are looked at further (one stat each): nothing else is read.
 */
function filesOf(root: string): { meshes: MeshFile[]; rrd: Array<{ path: string; bytes: number }>; walked: number; truncated: boolean } {
  const meshes: MeshFile[] = [];
  const rrd: Array<{ path: string; bytes: number }> = [];
  let walked = 0;
  let truncated = false;
  const walk = (dirRel: string, depth: number): void => {
    if (truncated || depth > WALK_DEPTH) return;
    let entries: Dirent[];
    try { entries = readdirSync(dirRel ? join(root, dirRel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (walked >= WALK_MAX) { truncated = true; return; }
      walked += 1;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink() || e.name.startsWith('.') || privatePath(rel)) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, depth + 1); continue; }
      if (!e.isFile()) continue;
      const kind = meshKindOf(rel);
      if (!kind && !isRrd(rel)) continue;
      try {
        const bytes = statSync(join(root, rel)).size;
        if (kind) meshes.push({ path: rel, bytes, kind }); else rrd.push({ path: rel, bytes });
      } catch { /* gone since */ }
    }
  };
  walk('', 0);
  return { meshes: meshes.sort(byPath), rrd: rrd.sort(byPath), walked, truncated };
}

/**
 * The view's pick of a mesh's triangles: every one up to `cap`; above it, triangle ⌊k × total / cap⌋ for k = 0 … cap − 1, an
 * even spread through the file's order, the same every time.
 */
export function viewPick(total: number, cap = VIEW_MAX_TRIANGLES): number[] {
  if (total <= cap) return Array.from({ length: total }, (_, k) => k);
  return Array.from({ length: cap }, (_, k) => Math.floor((k * total) / cap));
}

function viewOf(total: number, cap: number): MeshRow['view'] {
  if (total <= cap) return { shown: total, total, words: `all ${total} triangle${total === 1 ? '' : 's'}` };
  return { shown: cap, total, words: `showing ${cap} of ${total} triangles: an even pick through the file's order (triangle ⌊k × ${total} / ${cap}⌋ for k = 0 … ${cap - 1}); the measurements are of all ${total}` };
}

/** A binary STL's header or an ASCII STL's solid name, as the file says it (printable characters only). */
function declaredOf(body: Buffer, format: 'binary' | 'ascii'): MeshRow['declared'] {
  if (format === 'binary') {
    const words = [...body.subarray(0, 80)].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('').replace(/\.+$/, '').trim();
    return words ? { words, what: 'its 80-byte header' } : undefined;
  }
  const m = /^\s*solid[ \t]*([^\r\n]*)/i.exec(body.subarray(0, 512).toString('latin1'));
  const words = (m?.[1] ?? '').replace(/[^\x20-\x7e]/g, '.').trim().slice(0, 200);
  return words ? { words, what: 'its solid\'s name' } : undefined;
}

/** A file's identity now (device, inode, size and times), or null when it is not a regular file reached without a link. */
function sigOf(root: string, rel: string): string | null {
  try {
    const st = lstatSync(join(root, rel), { bigint: true });
    return st.isFile() ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : null;
  } catch { return null; }
}

/** What a file was measured as, kept while its identity is unchanged (the list is read every few seconds). */
interface Measured { sha256?: string; readback?: MeshReadback; declared?: MeshRow['declared']; format?: string; faces?: string; ignored?: string; why?: string }
const measured = new Map<string, { sig: string; m: Measured }>();
/** What is kept of a file measured before, while its identity is unchanged; undefined when it is to be measured. */
function measuredBefore(root: string, rel: string): Measured | undefined {
  const known = measured.get(`${root}\0${rel}`);
  const sig = known ? sigOf(root, rel) : null;
  return known && sig && known.sig === sig ? known.m : undefined;
}
const recorded = new Map<string, { sig: string; r: { facts?: RecordingFacts; why?: string } }>();
const keep = <V>(map: Map<string, V>, key: string, value: V): void => { if (map.size > 500) map.clear(); map.set(key, value); };

const notRead = (why: string, words: string): string => (why === 'too-large' ? `it is larger than ${MESH_READ_MAX / 1024 / 1024} MB, more than is read here` : words);

/** A file's bytes measured by the reader of its kind, with its form and its own words. */
function measuredOf(kind: MeshFileKind, body: Buffer, rel: string, sha: string): Measured {
  if (kind === 'stl') {
    const r = readbackOf(body, rel, sha);
    if (!r.ok) return { sha256: sha, why: `not measured: ${r.error}` };
    const declared = declaredOf(body, r.readback.format);
    return { sha256: sha, readback: r.readback, format: `${r.readback.format === 'binary' ? 'binary' : 'ASCII'} STL`, ...(declared ? { declared } : {}) };
  }
  if (kind === 'obj') {
    const r = objReadbackOf(body, rel, sha);
    if (!r.ok) return { sha256: sha, why: `not measured: ${r.error}` };
    const declared = r.comment ? { words: r.comment, what: 'its first comment' } : r.object ? { words: r.object, what: 'its first object\'s name (o)' } : undefined;
    return { sha256: sha, readback: r.readback, format: 'Wavefront OBJ (text)', ...(declared ? { declared } : {}), faces: r.readback.obj.faces_words, ignored: r.readback.obj.ignored_words };
  }
  const r = plyReadbackOf(body, rel, sha);
  if (!r.ok) return { sha256: sha, why: `not measured: ${r.error}` };
  return {
    sha256: sha, readback: r.readback, format: `PLY (${r.readback.ply.encoding === 'ascii' ? 'ascii' : 'binary little-endian'})`,
    ...(r.comment ? { declared: { words: r.comment, what: 'its header\'s first comment' } } : {}), faces: r.readback.ply.faces_words, ignored: r.readback.ply.ignored_words,
  };
}

function measure(root: string, rel: string, kind: MeshFileKind): Measured {
  const key = `${root}\0${rel}`;
  const sig = sigOf(root, rel);
  const known = measured.get(key);
  if (sig && known && known.sig === sig) return known.m;
  const read = readPlainInside(root, rel, MESH_READ_MAX);
  const m: Measured = read.ok ? measuredOf(kind, read.body, rel, sha256(read.body)) : { why: `not measured: ${notRead(read.why, read.words)}` };
  if (sig) keep(measured, key, { sig, m });
  return m;
}

function recordingOf(root: string, rel: string): { facts?: RecordingFacts; why?: string } {
  const key = `${root}\0${rel}`;
  const sig = sigOf(root, rel);
  const known = recorded.get(key);
  if (sig && known && known.sig === sig) return known.r;
  const read = readPlainInside(root, rel, MESH_READ_MAX);
  let r: { facts?: RecordingFacts; why?: string };
  if (!read.ok) r = { why: notRead(read.why, read.words) };
  else { const f = readRecording(read.body); r = 'error' in f ? { why: f.error } : { facts: f }; }
  if (sig) keep(recorded, key, { sig, r });
  return r;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const HEX64 = /^[0-9a-f]{64}$/;

/** A tessellation a VoxVision record's view names: its record, the STEP it was made from, how, and the bytes it names. */
interface Named { record: string; recordFile: string; recordSha: string; path: string; sha256: string; from: string; made_by: string; tolerance: string }

/** The tessellations the project's VoxVision records name (results/vox/v*.json, views[].derived[]), by mesh path. */
function tessellationsOf(root: string): Map<string, Named> {
  const out = new Map<string, Named>();
  let names: string[] = [];
  try { names = readdirSync(join(root, VOX_DIR)).filter((f) => f.endsWith('.json') && VOX_ID.test(f.slice(0, -5))).sort().slice(-RECORDS_MAX); } catch { return out; }
  for (const f of names) {
    const file = `${VOX_DIR}/${f}`;
    const read = readPlainInside(root, file, RECORD_MAX);
    if (!read.ok) continue;
    let rec: Obj | undefined;
    try { rec = obj(JSON.parse(read.body.toString('utf8'))); } catch { continue; }
    if (!rec || rec.schema !== 'timmy.vox/1') continue;
    const id = f.slice(0, -5);
    for (const v of Array.isArray(rec.views) ? rec.views : []) {
      for (const x of Array.isArray(obj(v)?.derived) ? obj(v)!.derived as unknown[] : []) {
        const d = obj(x);
        const from = obj(d?.from);
        const tol = obj(d?.tolerance);
        const path = str(d?.path);
        if (!d || d.kind !== 'tessellation' || !path || !path.startsWith(`${VOX_DIR}/${id}/`) || !isStl(path) || typeof d.sha256 !== 'string' || !HEX64.test(d.sha256) || !str(from?.path)) continue;
        const tolerance = tol && finite(tol.linear_deflection_mm) && finite(tol.angular_deflection_rad)
          ? `${num(tol.linear_deflection_mm)} mm (linear deflection) and ${num(tol.angular_deflection_rad)} rad (angular)` : 'a tolerance the record does not say';
        out.set(path, { record: id, recordFile: file, recordSha: sha256(read.body), path, sha256: d.sha256, from: str(from?.path)!, made_by: str(d.made_by) ?? 'a worker the record does not name', tolerance });
      }
    }
  }
  return out;
}

/** The newest vox receipt of this project that seals the record and these bytes of the mesh, if any. */
function sealOf(chain: readonly Receipt[], pid: string, n: Named): Receipt | undefined {
  for (let k = chain.length - 1; k >= 0; k -= 1) {
    const r = chain[k];
    if (r.kind !== 'vox' || r.project_id !== pid || r.outputs?.[0]?.path !== n.recordFile) continue;
    if (r.outputs.some((o) => o.path === n.path && o.sha256 === n.sha256)) return r;
  }
  return undefined;
}
/** A receipt's short id as /receipts prints it (the store writes sha256_<hex>). */
const shortOf = (r: Receipt): string => (r.hash ?? '').replace(/^sha256[:_]/, '').slice(0, 8);

/** The project's meshes (measured) and recordings (their header facts), and Rerun's viewer as this computer has it. */
export function listMeshes(i: MeshListInput, o: { max?: number; cap?: number; budgetMs?: number } = {}): MeshList {
  const max = o.max ?? MESH_LIST_MAX;
  const cap = o.cap ?? VIEW_MAX_TRIANGLES;
  // a reading with a time budget (a server's, a terminal's frame) measures what it can in that time, at least one new file,
  // and says the others are measured next: Timmy's reader is synchronous, and a large mesh takes seconds
  const until = o.budgetMs === undefined ? Infinity : Date.now() + o.budgetMs;
  let newly = 0;
  let pending = 0;
  const found = filesOf(i.root);
  const named = found.meshes.some((f) => f.kind === 'stl' && f.path.startsWith(`${VOX_DIR}/`)) ? tessellationsOf(i.root) : new Map<string, Named>();
  const pid = i.chain ? projectId(i.root) : '';
  let chain: readonly Receipt[] | undefined;
  const chainNow = (): readonly Receipt[] | undefined => { if (!chain && i.chain) chain = typeof i.chain === 'function' ? i.chain() : i.chain; return chain; };
  const readers = new Set<MeshFileKind>();

  const meshes = found.meshes.slice(0, max).map((f): MeshRow => {
    const reader = readerOf(f.kind);
    let m = measuredBefore(i.root, f.path);
    if (!m && newly > 0 && Date.now() >= until) {
      pending += 1;
      return { path: f.path, kind: f.kind, bytes: f.bytes, origin: { provenance: 'not recorded', words: 'not read yet' }, reader, pending: true, why: `being measured: ${reader.name} reads it next (the list is read again in a moment)` };
    }
    if (!m) { m = measure(i.root, f.path, f.kind); newly += 1; }
    if (m.readback) readers.add(f.kind);
    const n = f.kind === 'stl' ? named.get(f.path) : undefined;
    let origin: MeshOrigin = { provenance: 'not recorded', words: "where the file came from is not recorded: Timmy's records do not say what made it" };
    let tessellation: MeshRow['tessellation'];
    if (n && m.sha256 === n.sha256) {
      const c = chainNow();
      const seal = c ? sealOf(c, pid, n) : undefined;
      const sealed = i.chain ? Boolean(seal) : null;
      tessellation = { record: n.record, from: n.from, made_by: n.made_by, tolerance: n.tolerance, sealed };
      origin = {
        provenance: 'reconstructed',
        words: `a tessellation of ${n.from} by ${n.made_by}, within ${n.tolerance}: a mesh of the STEP's surfaces, not the STEP itself; VoxVision record ${n.record} names these bytes${sealed === null ? ' (no receipt was checked here)' : seal ? `, and vox receipt ${shortOf(seal)} sealed them` : ', but no vox receipt of this project seals them'}`,
      };
    } else if (n) {
      origin = { provenance: 'not recorded', words: `VoxVision record ${n.record} names ${n.path} as a tessellation of ${n.from}, but these are not the bytes it names (sha256 ${m.sha256 ? m.sha256.slice(0, 12) : 'not read'} now): where they came from is not recorded` };
    }
    const r = m.readback;
    return {
      path: f.path, kind: tessellation ? 'tessellation' : f.kind, bytes: r?.bytes ?? f.bytes, origin, reader,
      ...(m.format ? { format: m.format } : {}),
      ...(m.declared ? { declared: m.declared } : {}),
      ...(r ? { readback: r, topology: topologyWords(r), volume: volumeWords(r), view: viewOf(r.triangles, cap) } : { why: m.why ?? 'not measured' }),
      ...(m.faces ? { faces: m.faces } : {}), ...(m.ignored ? { ignored: m.ignored } : {}),
      ...(tessellation ? { tessellation } : {}),
    };
  });

  const recordings = found.rrd.slice(0, RECORDING_LIST_MAX).map((f): RecordingRow => {
    const r = recordingOf(i.root, f.path);
    return { path: f.path, bytes: r.facts?.bytes ?? f.bytes, ...(r.facts ? { facts: r.facts } : {}), ...(r.why ? { why: r.why } : {}) };
  });

  const rr = rerunReady({ env: i.env, onPath: onPathOf(i.env), root: i.root });
  const viewer: MeshList['viewer'] = rr.ready
    ? { name: "Rerun's viewer", state: 'found (installed here, not run)', words: `Rerun's viewer is found here (${rr.via}): found is not run, and this tab runs nothing; \`rerun ${rerunBindArgs().join(' ')} <file>\` in a terminal opens a recording in Rerun's own window, listening on this computer only` }
    : { name: "Rerun's viewer", state: 'needs setup', words: `Rerun's viewer needs setup here: ${rr.why}`, setup: rr.setup ?? RERUN_SETUP };

  return {
    schema: MESHES_SCHEMA, meshes, more: Math.max(0, found.meshes.length - max), pending, recordings, recordingsMore: Math.max(0, found.rrd.length - RECORDING_LIST_MAX),
    viewer, walk: { files: found.walked, truncated: found.truncated }, cap, view: VIEW_WORDS, reader: readersWords(readers), doctrine: DOCTRINE_15,
  };
}

export type MeshViewAnswer =
  | { ok: true; path: string; body: Buffer; shown: number; total: number; sha256: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 413 | 422; error: string };

/**
 * One mesh the list names, as the view draws it: its triangles' corners as little-endian float32, nine per triangle (every
 * triangle up to `cap`, else viewPick's), read through one descriptor. Anything the list does not name as this project's
 * mesh is refused with why; `sha`, when given, must be the bytes' sha256 now (the list's), else 409.
 */
export function meshView(root: string, rel: string, o: { cap?: number; sha?: string } = {}): MeshViewAnswer {
  if (typeof rel !== 'string' || rel.length > 512 || !plainRel(rel)) return { ok: false, status: 400, error: 'Refused: a mesh is named by its path inside the project, without "..", "." or a leading "/".' };
  const file = filesOf(root).meshes.find((f) => f.path === rel);
  if (!file) return { ok: false, status: 404, error: `Refused: ${rel} is not a mesh of this project (tab 6 lists its STL, OBJ and PLY files and its tessellations), so it is not served.` };
  const read = readPlainInside(root, rel, MESH_READ_MAX);
  if (!read.ok) {
    switch (read.why) {
      case 'link': case 'not-file': case 'changed': return { ok: false, status: 403, error: `Refused: ${rel} ${read.words.replace(/^it /, '')}, so it is not served.` };
      case 'too-large': return { ok: false, status: 413, error: `Not served: ${rel} is larger than ${MESH_READ_MAX / 1024 / 1024} MB, more than is read here.` };
      default: return { ok: false, status: 404, error: `Not served: ${rel} (${read.words}).` };
    }
  }
  const sha = sha256(read.body);
  if (o.sha !== undefined && o.sha !== sha) return { ok: false, status: 409, error: `Not served: ${rel} changed since the list was read (sha256 ${sha.slice(0, 12)} now): read the list again.` };
  // the corners, read by the reader that measured them (parseStl, parseObj or parsePly, which their readbacks use); the view
  // measures nothing
  const p = file.kind === 'stl' ? parseStl(read.body) : file.kind === 'obj' ? parseObj(read.body) : parsePly(read.body);
  if ('error' in p) return { ok: false, status: 422, error: file.kind === 'stl' ? `Not drawn: ${rel} is ${p.error}.` : `Not drawn: ${rel}: ${p.error}.` };
  const tris = p.triangles;
  const total = tris.length / 9;
  const pick = viewPick(total, o.cap ?? VIEW_MAX_TRIANGLES);
  const body = Buffer.alloc(pick.length * 36);
  for (let k = 0; k < pick.length; k += 1) {
    for (let j = 0; j < 9; j += 1) {
      const v = tris[pick[k] * 9 + j];
      if (!Number.isFinite(v)) return { ok: false, status: 422, error: `Not drawn: triangle ${pick[k] + 1} of ${rel} has a coordinate that is not a finite number.` };
      body.writeFloatLE(v, k * 36 + j * 4);
    }
  }
  return { ok: true, path: rel, body, shown: pick.length, total, sha256: sha };
}
