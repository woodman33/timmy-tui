/**
 * Round R4 (helper H27): Timmy's own reading of an STL mesh, in TypeScript, with no OpenSCAD (or any other CAD
 * engine) involved: an implementation independent of the program that exported the file.
 *
 * The file is read once: its bytes are hashed, and those same bytes are parsed and measured, so the sha256
 * recorded is of the bytes measured. Both STL encodings are read:
 *   binary  an 80-byte header, a little-endian uint32 triangle count N, then N records of 50 bytes (a normal,
 *           three corners as float32, a 2-byte attribute). Told by its size: exactly 84 + 50 × N bytes.
 *   ASCII   solid <name> { facet normal nx ny nz / outer loop / vertex x y z (three) / endloop / endfacet } endsolid.
 *           Each coordinate is read as a 32-bit float (Math.fround), the precision of the binary form, so one
 *           mesh written both ways measures the same.
 * The normals stored in the file are not used: every measure follows the order of each triangle's corners.
 *
 * What is measured (deterministic computation on the file; DOCTRINE §15: provenance `generated`, evidence state
 * `checked`, in the file's own units, never a physical object's):
 *   triangles, and distinct corners after joining: corners are joined only where their three coordinates are
 *     bit-identical as 32-bit floats (-0 and +0 are the same); no tolerance is applied.
 *   bounding box: the least and greatest corner coordinate on each axis.
 *   surface area: the sum of |(b - a) × (c - a)| / 2.
 *   signed volume: the sum of the tetrahedra (a - r) · ((b - r) × (c - r)) / 6 about r, the bounding box's centre
 *     (for a closed mesh the same for any r). It is the enclosed volume only when the mesh is edge-manifold and
 *     consistently oriented; positive when the corners run counter-clockwise seen from outside (normals out).
 *   edge manifoldness: every edge (a pair of joined corners) shared by exactly two triangles. Boundary edges
 *     (one triangle) and non-manifold edges (three or more) are counted; an edge shared by two triangles that run
 *     along it the same way is a misoriented edge. A triangle with a repeated corner after joining has no edges
 *     and is counted as collapsed; a triangle with three distinct corners on one line has zero area.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** DOCTRINE §15's sentence, verbatim (AGENTS.md §4): shown wherever these measurements are shown. */
export const DOCTRINE_15 = 'Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.';
/** This reader's name and version, recorded with each measurement. */
export const STL_READBACK = 'timmy-stl-readback/1';
/** The largest file read back; a larger one is reported as not measured. */
export const STL_MAX_BYTES = 256 * 1024 * 1024;
/** Beyond this many distinct corners the edge keys would not be exact doubles: refused as not measured. */
const MAX_CORNERS = 60_000_000;

export type Vec3 = [number, number, number];

/** A parsed STL: each triangle's three corners, nine float32 values per triangle. */
export interface StlParsed {
  format: 'binary' | 'ascii';
  triangles: Float32Array;
  /** binary: the 80-byte header, printable characters only (others as '.') */
  header?: string;
  /** ascii: how many solid … endsolid blocks the file holds, and the first one's name */
  solids?: number;
  name?: string;
}

/** The measurements of a mesh, all from its corners. */
export interface MeshMeasure {
  triangles: number;
  /** distinct corners after joining (bit-identical float32 coordinates) */
  corners: number;
  /** null when the mesh has no triangles */
  bbox: { min: Vec3; max: Vec3; size: Vec3 } | null;
  /** signed: see the module's header */
  volume: number;
  area: number;
  /** distinct edges, of the triangles with three distinct corners */
  edges: number;
  /** edges of exactly one triangle */
  boundary_edges: number;
  /** edges of three or more triangles */
  non_manifold_edges: number;
  /** edges of exactly two triangles that run along it the same way */
  misoriented_edges: number;
  /** triangles with a repeated corner after joining: they have no edges */
  collapsed_triangles: number;
  /** triangles with three distinct corners and zero area (on one line) */
  zero_area_triangles: number;
  /** at least one triangle, none collapsed, and every edge shared by exactly two triangles */
  manifold: boolean;
  /** manifold, and every edge run once each way: the volume is the enclosed volume */
  oriented: boolean;
}

/** A measurement as Timmy records it: the file it read, how, and DOCTRINE §15's tags and sentence. */
export interface StlReadback extends MeshMeasure {
  measured_by: typeof STL_READBACK;
  tier: 'deterministic computation';
  /** what was measured: the exported file, never a physical part */
  scope: string;
  independent_of: string;
  /** the file as the caller named it (relative to the project) */
  file: string;
  sha256: string;
  bytes: number;
  format: 'binary' | 'ascii';
  units: string;
  joining: string;
  methods: { bbox: string; area: string; volume: string; edges: string };
  /** DOCTRINE §15: a dimension carries its provenance and evidence state */
  provenance: 'generated';
  evidence: 'checked';
  notice: typeof DOCTRINE_15;
}

export type StlReadResult =
  | { ok: true; readback: StlReadback }
  /** missing: no regular file; too large: past the limit; malformed: not a well-formed STL; unreadable: an error reading it */
  | { ok: false; kind: 'missing' | 'too large' | 'malformed' | 'unreadable'; error: string; file: string; sha256?: string; bytes?: number };

// ── parsing ───────────────────────────────────────────────────────────────────

const printable = (b: Buffer): string => [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('').replace(/\.+$/, '');

function parseBinary(buf: Buffer, n: number): StlParsed {
  const triangles = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const at = 84 + i * 50 + 12; // past the stored normal
    for (let k = 0; k < 9; k++) triangles[i * 9 + k] = buf.readFloatLE(at + k * 4);
  }
  return { format: 'binary', triangles, header: printable(buf.subarray(0, 80)) };
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * ASCII STL, strictly: every facet has a normal (three words, not used), an outer loop of exactly three vertices of
 * three finite numbers each, then endloop and endfacet; each solid ends with endsolid. Keywords in any case.
 */
function parseAscii(text: string): StlParsed | { error: string } {
  const lineAt = (index: number): number => { let n = 1; for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++; return n; };
  const words = /\S+/g;
  let m: RegExpExecArray | null;
  const next = (): { word: string; at: number } | null => { m = words.exec(text); return m ? { word: m[0], at: m.index } : null; };
  /** Skips the rest of the line a word is on (a solid's name). */
  const skipLine = (from: number): string => {
    const end = text.indexOf('\n', from);
    const rest = text.slice(from, end < 0 ? text.length : end).trim();
    words.lastIndex = end < 0 ? text.length : end;
    return rest;
  };
  const out: number[] = [];
  let solids = 0;
  let name: string | undefined;
  const fail = (at: number, what: string): { error: string } => ({ error: `line ${lineAt(at)}: ${what}` });
  const expectWord = (want: string): { at: number } | { error: string } => {
    const w = next();
    if (!w) return { error: `the file ends where "${want}" was expected` };
    if (w.word.toLowerCase() !== want) return fail(w.at, `"${w.word.slice(0, 40)}" where "${want}" was expected`);
    return { at: w.at };
  };
  for (let w = next(); w; w = next()) {
    if (w.word.toLowerCase() !== 'solid') return fail(w.at, `"${w.word.slice(0, 40)}" where "solid" was expected`);
    solids++;
    const solidName = skipLine(w.at + w.word.length);
    if (solids === 1 && solidName) name = solidName.slice(0, 200);
    for (;;) {
      const f = next();
      if (!f) return { error: `the file ends inside solid ${solids} (no endsolid)` };
      const word = f.word.toLowerCase();
      if (word === 'endsolid') { skipLine(f.at + f.word.length); break; }
      if (word !== 'facet') return fail(f.at, `"${f.word.slice(0, 40)}" where "facet" or "endsolid" was expected`);
      const normal = expectWord('normal');
      if ('error' in normal) return normal;
      for (let k = 0; k < 3; k++) if (!next()) return { error: 'the file ends inside a facet normal' };
      for (const want of ['outer', 'loop']) { const r = expectWord(want); if ('error' in r) return r; }
      for (let v = 0; v < 3; v++) {
        const vertex = expectWord('vertex');
        if ('error' in vertex) return vertex;
        for (let k = 0; k < 3; k++) {
          const c = next();
          if (!c) return { error: 'the file ends inside a vertex' };
          if (!NUMBER.test(c.word)) return fail(c.at, `"${c.word.slice(0, 40)}" is not a coordinate (a finite number)`);
          const value = Number(c.word);
          if (!Number.isFinite(value)) return fail(c.at, `${c.word.slice(0, 40)} is not a finite number`);
          out.push(Math.fround(value));
        }
      }
      for (const want of ['endloop', 'endfacet']) { const r = expectWord(want); if ('error' in r) return r; }
    }
  }
  if (!solids) return { error: 'no solid in the file' };
  return { format: 'ascii', triangles: Float32Array.from(out), solids, ...(name ? { name } : {}) };
}

/**
 * The triangles of an STL's bytes. A file of exactly 84 + 50 × N bytes, N the count its header declares, is
 * binary (whatever its header says: many binary files begin with "solid"); one that starts with "solid" is ASCII.
 */
export function parseStl(buf: Buffer): StlParsed | { error: string } {
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : -1;
  if (n >= 0 && 84 + n * 50 === buf.length) return parseBinary(buf, n);
  if (/^\s*solid\b/i.test(buf.subarray(0, Math.min(buf.length, 512)).toString('latin1'))) {
    const r = parseAscii(buf.toString('latin1'));
    if ('error' in r) return { error: `not a well-formed ASCII STL: ${r.error}` };
    return r;
  }
  if (buf.length < 84) return { error: `${buf.length} bytes: too short for a binary STL (84 bytes come before the first triangle), and it does not start with "solid" as an ASCII STL does` };
  return { error: `not an STL: a binary STL with the ${n} triangles its header declares is ${84 + n * 50} bytes, this file is ${buf.length}; and it does not start with "solid" as an ASCII STL does` };
}

// ── measuring ─────────────────────────────────────────────────────────────────

/** Neumaier's compensated sum: the measures stay exact where the terms are. */
class Sum {
  private s = 0;
  private c = 0;
  add(x: number): void {
    const t = this.s + x;
    this.c += Math.abs(this.s) >= Math.abs(x) ? (this.s - t) + x : (x - t) + this.s;
    this.s = t;
  }
  get value(): number { return this.s + this.c; }
}

/**
 * Measures a mesh given as nine float32 values per triangle (parseStl's `triangles`). Throws when a coordinate is
 * not a finite number or the mesh has more distinct corners than the edge keys can hold exactly.
 */
export function measureMesh(tris: Float32Array): MeshMeasure {
  if (tris.length % 9 !== 0) throw new Error('a mesh holds nine coordinates per triangle');
  const count = tris.length / 9;
  for (let i = 0; i < tris.length; i++) if (!Number.isFinite(tris[i])) throw new Error(`triangle ${Math.floor(i / 9) + 1} has a coordinate that is not a finite number`);
  const empty: MeshMeasure = {
    triangles: 0, corners: 0, bbox: null, volume: 0, area: 0, edges: 0, boundary_edges: 0, non_manifold_edges: 0, misoriented_edges: 0,
    collapsed_triangles: 0, zero_area_triangles: 0, manifold: false, oriented: false,
  };
  if (!count) return empty;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  // Corners joined by their exact float32 bits (-0 as +0): six 16-bit halves make the key.
  const bits = new Uint32Array(1);
  const f32 = new Float32Array(bits.buffer);
  const bitsOf = (v: number): number => { f32[0] = v; return bits[0] === 0x80000000 ? 0 : bits[0]; };
  const ids = new Uint32Array(count * 3);
  const index = new Map<string, number>();
  for (let c = 0; c < count * 3; c++) {
    const x = bitsOf(tris[c * 3]), y = bitsOf(tris[c * 3 + 1]), z = bitsOf(tris[c * 3 + 2]);
    const key = String.fromCharCode(x & 0xffff, x >>> 16, y & 0xffff, y >>> 16, z & 0xffff, z >>> 16);
    let id = index.get(key);
    if (id === undefined) { id = index.size; index.set(key, id); }
    ids[c] = id;
  }
  const corners = index.size;
  index.clear();
  if (corners > MAX_CORNERS) throw new Error(`${corners} distinct corners: more than this reader measures (${MAX_CORNERS})`);

  // Each directed edge as one exact double: ((low · corners + high) · 2 + forward). Sorted, equal edges are adjacent.
  const keys = new Float64Array(count * 3);
  let n = 0;
  const edge = (u: number, v: number): void => { keys[n++] = u < v ? (u * corners + v) * 2 + 1 : (v * corners + u) * 2; };
  let collapsed = 0;
  for (let t = 0; t < count; t++) {
    const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
    if (a === b || b === c || a === c) { collapsed++; continue; }
    edge(a, b); edge(b, c); edge(c, a);
  }
  const sorted = keys.subarray(0, n).sort();
  let edges = 0, boundary = 0, nonManifold = 0, misoriented = 0;
  for (let i = 0; i < n;) {
    const which = Math.floor(sorted[i] / 2);
    let uses = 0, forward = 0;
    while (i < n && Math.floor(sorted[i] / 2) === which) { uses++; forward += sorted[i] % 2; i++; }
    edges++;
    if (uses === 1) boundary++;
    else if (uses > 2) nonManifold++;
    else if (forward !== 1) misoriented++;
  }

  // Area and signed volume in double precision, about the bounding box's centre.
  const r: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const area = new Sum();
  const volume = new Sum();
  let zeroArea = 0;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ax = tris[o] - r[0], ay = tris[o + 1] - r[1], az = tris[o + 2] - r[2];
    const bx = tris[o + 3] - r[0], by = tris[o + 4] - r[1], bz = tris[o + 5] - r[2];
    const cx = tris[o + 6] - r[0], cy = tris[o + 7] - r[1], cz = tris[o + 8] - r[2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const twice = Math.sqrt(nx * nx + ny * ny + nz * nz);
    area.add(twice / 2);
    const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
    if (twice === 0 && a !== b && b !== c && a !== c) zeroArea++;
    volume.add((ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6);
  }
  const manifold = collapsed === 0 && boundary === 0 && nonManifold === 0;
  return {
    triangles: count, corners, bbox: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    volume: volume.value, area: area.value, edges, boundary_edges: boundary, non_manifold_edges: nonManifold, misoriented_edges: misoriented,
    collapsed_triangles: collapsed, zero_area_triangles: zeroArea, manifold, oriented: manifold && misoriented === 0,
  };
}

// ── reading a file ────────────────────────────────────────────────────────────

const METHODS = {
  bbox: 'the least and greatest corner coordinate on each axis',
  area: 'the sum of |(b - a) × (c - a)| / 2 over the triangles, in double precision',
  volume: 'the sum of (a - r) · ((b - r) × (c - r)) / 6 over the triangles, r the bounding box\'s centre; the enclosed volume only for an edge-manifold, consistently oriented mesh',
  edges: 'corners joined where bit-identical as 32-bit floats; every edge of the triangles with three distinct corners, counted by how many triangles share it and which way each runs along it',
} as const;

/** The measurement of a file's bytes (already read and hashed), as Timmy records it. */
export function readbackOf(buf: Buffer, file: string, sha256: string): StlReadResult {
  const parsed = parseStl(buf);
  if ('error' in parsed) return { ok: false, kind: 'malformed', error: parsed.error, file, sha256, bytes: buf.length };
  let measure: MeshMeasure;
  try { measure = measureMesh(parsed.triangles); } catch (e) {
    return { ok: false, kind: 'malformed', error: (e as Error).message, file, sha256, bytes: buf.length };
  }
  return {
    ok: true,
    readback: {
      measured_by: STL_READBACK, tier: 'deterministic computation',
      scope: 'measured from the exported STL file, in its own units; not a measurement of a physical part',
      independent_of: 'the program that exported it: Timmy\'s own TypeScript reads the file\'s bytes (no OpenSCAD, no CAD engine)',
      file, sha256, bytes: buf.length, format: parsed.format,
      units: 'the file\'s own: STL records no unit (OpenSCAD models are millimetres by convention)',
      joining: 'exact: corners bit-identical as 32-bit floats are one corner (-0 as +0); no tolerance',
      methods: { ...METHODS },
      ...measure,
      provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15,
    },
  };
}

/**
 * Reads an STL once (a regular file, never a FIFO waited on, at most `maxBytes`), hashes the bytes read and
 * measures those same bytes. `file` is the name recorded (relative to the project).
 */
export function readStlFile(abs: string, file: string, opts: { maxBytes?: number } = {}): StlReadResult {
  const limit = opts.maxBytes ?? STL_MAX_BYTES;
  let fd: number;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: false, kind: 'missing', error: 'not there', file } : { ok: false, kind: 'unreadable', error: (e as Error).message, file };
  }
  let buf: Buffer;
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) return { ok: false, kind: 'missing', error: 'not a regular file', file };
    if (s.size > limit) return { ok: false, kind: 'too large', error: `${s.size} bytes: larger than the readback reads (${limit})`, file, bytes: s.size };
    buf = Buffer.alloc(s.size);
    let got = 0;
    while (got < s.size) {
      const r = readSync(fd, buf, got, s.size - got, got);
      if (r <= 0) break;
      got += r;
    }
    if (got !== s.size) buf = buf.subarray(0, got);
  } catch (e) {
    return { ok: false, kind: 'unreadable', error: (e as Error).message, file };
  } finally { closeSync(fd); }
  return readbackOf(buf, file, createHash('sha256').update(buf).digest('hex'));
}

// ── words ─────────────────────────────────────────────────────────────────────

/** A measure for people: seven significant digits, no trailing zeros, -0 as 0. */
export function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const s = String(Number(v.toPrecision(7)));
  return s === '-0' ? '0' : s;
}

/** The mesh's topology in a few words: edge-manifold or not, and why not. */
export function topologyWords(m: MeshMeasure): string {
  if (!m.triangles) return 'no triangles';
  if (m.manifold) {
    return m.oriented
      ? 'edge-manifold: every edge shared by exactly two triangles, consistently oriented'
      : `edge-manifold, but ${m.misoriented_edges} edge${m.misoriented_edges === 1 ? '' : 's'} shared by two triangles running the same way (inconsistent orientation)`;
  }
  const why = [
    ...(m.boundary_edges ? [`${m.boundary_edges} boundary edge${m.boundary_edges === 1 ? '' : 's'} (one triangle: the mesh is open)`] : []),
    ...(m.non_manifold_edges ? [`${m.non_manifold_edges} non-manifold edge${m.non_manifold_edges === 1 ? '' : 's'} (three or more triangles)`] : []),
    ...(m.collapsed_triangles ? [`${m.collapsed_triangles} collapsed triangle${m.collapsed_triangles === 1 ? '' : 's'} (a repeated corner)`] : []),
  ];
  return `not edge-manifold: ${why.join(', ')}`;
}

/** The signed volume in words, after the word "volume": enclosed (normals out or in), or not an enclosed volume. */
export function volumeWords(m: MeshMeasure): string {
  if (!m.triangles) return 'none: no triangles';
  if (!m.oriented) return `${num(m.volume)}, signed: not an enclosed volume (the mesh is not closed and consistently oriented)`;
  return m.volume >= 0 ? `${num(m.volume)} (enclosed; normals outward)` : `${num(m.volume)} (enclosed, negative: the normals face inward)`;
}
