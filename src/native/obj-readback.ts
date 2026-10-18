/**
 * R8 (H154): Timmy's own reading of a Wavefront OBJ mesh, in TypeScript, with no CAD engine or library involved: an
 * implementation independent of the program that exported the file.
 *
 * The file is read once: its bytes are hashed, and those same bytes are parsed and measured (src/native/mesh-common.ts
 * readMeshBytes), so the sha256 recorded is of the bytes measured. An OBJ is text, read statement by statement; a line that
 * ends in "\" goes on into the next, and "#" begins a comment to the end of its line:
 *   v x y z        a vertex: three finite numbers, each read as a 32-bit float (Math.fround) as Timmy's STL reader reads an
 *                  ASCII STL, so one mesh written as STL and as OBJ measures the same; then nothing more, a weight (one number,
 *                  used by curves and surfaces) or a colour (red, green, blue: a common extension), read past and not used
 *   f c1 c2 c3 …   a face of three or more corners, each v, v/vt, v//vn or v/vt/vn (whole numbers): a positive index counts
 *                  from 1 at the beginning of the file, a negative one back from the vertices given so far. A face of more than
 *                  three corners is split as a fan from its first corner, (c1, ck, ck+1) for k = 2 … n − 1: exact for a flat,
 *                  convex polygon, while a non-convex or non-flat polygon's fan is not the polygon's own surface
 *   anything else  vt, vn, vp, g, o, s, usemtl, mtllib, l, p, curves and surfaces, comments: ignored, and counted by their first
 *                  word ("ignored: 12 vt, 12 vn lines"); a line whose first word is not a word (a letter or "_" first) is refused
 * Refused, with the line and why, never guessed: a vertex without three finite numbers (or with a count of them that is none of
 * the three forms), a coordinate beyond a 32-bit float, a face of fewer than three corners, a corner of no known form, an index
 * 0, a count back past the first, or a corner naming a vertex, texture coordinate or normal past the file's own. A file with a
 * NUL or another control byte is refused as not text (.obj also names compiled object files). A file with no face has no
 * triangles to measure, and says so.
 *
 * What is measured is what Timmy's STL reader measures, by its own measure (src/native/stl-readback.ts measureMesh) over the
 * triangles' corners: triangles, corners joined where bit-identical as 32-bit floats, the bounding box, the surface area, the
 * edge-manifold check and the signed volume (the enclosed volume only for a closed, consistently oriented mesh); with DOCTRINE
 * §15's tags and sentence: provenance `generated`, evidence state `checked`, in the file's own units, never a physical object's.
 */
import { DOCTRINE_15, measureMesh, type MeshMeasure } from './stl-readback.js';
import { facesWords, GrowF32, GrowU32, readMeshBytes, trianglesOf, unusedOf, type MeshFailKind, type MeshReadFailure } from './mesh-common.js';

/** This reader's name and version, recorded with each measurement. */
export const OBJ_READBACK = 'timmy-obj-readback/1';
/** The largest file read back; a larger one is reported as not measured. */
export const OBJ_MAX_BYTES = 256 * 1024 * 1024;

/** What a file's statements other than v and f were, counted by their first word, in the order first met. */
export interface ObjIgnored { what: string; lines: number }

/** A parsed OBJ: each triangle's three corners (nine float32 values per triangle), and what the file held. */
export interface ObjParsed {
  format: 'obj';
  triangles: Float32Array;
  /** v lines */
  vertices: number;
  /** f lines, and how many of them had four or more corners (split as fans) */
  faces: number;
  polygons: number;
  /** vertices no face names */
  unused: number;
  ignored: ObjIgnored[];
  /** v lines with a weight, and with a colour, after x, y and z: read past, not used */
  extras: { weights: number; colours: number };
  /** the file's first comment before any statement, and its first object's name (o): its own words, not checked */
  comment?: string;
  object?: string;
}
export interface ObjParseFailure { kind: Extract<MeshFailKind, 'malformed' | 'no faces'>; error: string }

/** A measurement as Timmy records it: the file it read, how, and DOCTRINE §15's tags and sentence. */
export interface ObjReadback extends MeshMeasure {
  measured_by: typeof OBJ_READBACK;
  tier: 'deterministic computation';
  scope: string;
  independent_of: string;
  file: string;
  sha256: string;
  bytes: number;
  format: 'obj';
  units: string;
  joining: string;
  precision: string;
  methods: { bbox: string; area: string; volume: string; edges: string; faces: string };
  obj: { vertices: number; faces: number; polygons: number; unused_vertices: number; ignored: ObjIgnored[]; extras: { weights: number; colours: number }; faces_words: string; ignored_words: string };
  provenance: 'generated';
  evidence: 'checked';
  notice: typeof DOCTRINE_15;
}

export type ObjReadResult = { ok: true; readback: ObjReadback } | MeshReadFailure;

// ── parsing ───────────────────────────────────────────────────────────────────

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const KEYWORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A face's corner: v, v/vt, v/vt/vn or v//vn. */
const CORNER = /^([+-]?\d+)(?:\/([+-]?\d+)(?:\/([+-]?\d+))?|\/\/([+-]?\d+))?$/;
const clip = (t: string): string => t.slice(0, 40);
const printable = (t: string): string => t.replace(/[^\x20-\x7e]/g, '.').trim().slice(0, 200);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

type RefKind = 'v' | 'vt' | 'vn';
const NOUN: Record<RefKind, [string, string]> = { v: ['vertex', 'vertices'], vt: ['texture coordinate', 'texture coordinates'], vn: ['normal', 'normals'] };
/** A corner naming what the file had not given yet at its line: checked against the whole file at its end. */
interface Ahead { line: number; word: string; index: number; digits: string }

/** The triangles of an OBJ's bytes, and what else it held; or why it is not read (with its line). */
export function parseObj(buf: Buffer): ObjParsed | ObjParseFailure {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 9 || (b > 13 && b < 32)) return { kind: 'malformed', error: `not a Wavefront OBJ: the byte at offset ${i} is 0x${b.toString(16).padStart(2, '0')}, and an OBJ is text (.obj also names compiled object files)` };
  }
  const fail = (line: number, what: string): ObjParseFailure => ({ kind: 'malformed', error: `not a well-formed OBJ: line ${line}: ${what}` });
  const text = buf.toString('latin1');
  const coords = new GrowF32();
  const corners = new GrowU32();
  const have: Record<RefKind, number> = { v: 0, vt: 0, vn: 0 };
  let faces = 0, polygons = 0, weights = 0, colours = 0, statements = 0;
  const ignored = new Map<string, number>();
  const count = (what: string): void => { ignored.set(what, (ignored.get(what) ?? 0) + 1); };
  let comment: string | undefined;
  let object: string | undefined;
  // a corner past what is given so far: only each one larger than every one before it is kept, for the first of them past the
  // file's end is the first line that names what the file does not have
  const ahead: Record<RefKind, Ahead[]> = { v: [], vt: [], vn: [] };
  const furthest: Record<RefKind, number> = { v: 0, vt: 0, vn: 0 };

  /** A corner's index as a 0-based place, or why it is refused (a place past the end is checked at the file's end). */
  const place = (digits: string, kind: RefKind, word: string, line: number): number | string => {
    const i = Number(digits);
    const [one, many] = NOUN[kind];
    if (i === 0) return `corner "${clip(word)}" names ${one} 0; OBJ numbers its ${many} from 1 (and back from -1)`;
    if (i < 0) {
      const j = have[kind] + i;
      if (j < 0) return `corner "${clip(word)}" counts back past the first ${one} (${have[kind]} ${kind} ${plural(have[kind], 'line comes', 'lines come')} before it)`;
      return j;
    }
    if (i > have[kind] && i > furthest[kind]) { furthest[kind] = i; ahead[kind].push({ line, word, index: i, digits: digits.replace(/^\+/, '') }); }
    return Number.isSafeInteger(i) ? i - 1 : 0xffffffff;
  };

  let at = 0;
  let lineNo = 0;
  while (at < text.length) {
    // one statement: its physical lines joined where one ends in "\"
    const start = lineNo + 1;
    let line = '';
    for (;;) {
      const end = text.indexOf('\n', at);
      let phys = text.slice(at, end < 0 ? text.length : end);
      at = end < 0 ? text.length : end + 1;
      lineNo++;
      if (phys.endsWith('\r')) phys = phys.slice(0, -1);
      if (phys.endsWith('\\')) { line += `${phys.slice(0, -1)} `; if (at < text.length) continue; } else line += phys;
      break;
    }
    const hash = line.indexOf('#');
    const body = (hash < 0 ? line : line.slice(0, hash)).trim();
    if (!body) {
      if (hash >= 0) {
        count('comment');
        if (!statements && comment === undefined) { const c = printable(line.slice(hash + 1)); if (c) comment = c; }
      }
      continue;
    }
    statements++;
    const w = body.split(/\s+/);
    const key = w[0];
    if (key === 'v') {
      const n = w.length - 1;
      if (n !== 3 && n !== 4 && n !== 6) return fail(start, `a vertex (v) has ${n} ${plural(n, 'number', 'numbers')}; it needs x, y and z, then nothing more, a weight, or a colour (red, green, blue)`);
      for (let k = 1; k <= n; k++) {
        const t = w[k];
        if (!NUMBER.test(t)) return fail(start, k <= 3 ? `"${clip(t)}" is not a coordinate (a finite number)` : `"${clip(t)}" is not a number`);
        const value = Number(t);
        if (!Number.isFinite(value)) return fail(start, `${clip(t)} is not a finite number`);
        if (k > 3) continue;
        const f = Math.fround(value);
        if (!Number.isFinite(f)) return fail(start, `${clip(t)} is beyond a 32-bit float, the precision Timmy's mesh measure works in`);
        coords.push(f);
      }
      if (n === 4) weights++;
      else if (n === 6) colours++;
      have.v++;
    } else if (key === 'f') {
      const n = w.length - 1;
      if (n < 3) return fail(start, `a face (f) names ${n} ${plural(n, 'corner', 'corners')}; a face needs at least three`);
      const ids: number[] = [];
      for (let k = 1; k <= n; k++) {
        const t = w[k];
        const m = CORNER.exec(t);
        if (!m) return fail(start, `"${clip(t)}" is not a face corner (v, v/vt, v//vn or v/vt/vn, each a whole number)`);
        const v = place(m[1], 'v', t, start);
        if (typeof v === 'string') return fail(start, v);
        if (m[2] !== undefined) { const vt = place(m[2], 'vt', t, start); if (typeof vt === 'string') return fail(start, vt); }
        const vn = m[3] ?? m[4];
        if (vn !== undefined) { const r = place(vn, 'vn', t, start); if (typeof r === 'string') return fail(start, r); }
        ids.push(v);
      }
      for (let k = 1; k + 1 < n; k++) { corners.push(ids[0]); corners.push(ids[k]); corners.push(ids[k + 1]); }
      faces++;
      if (n > 3) polygons++;
    } else {
      if (!KEYWORD.test(key)) return fail(start, `"${clip(key)}" does not begin an OBJ statement (a statement begins with a word such as v, f or vt)`);
      if (key === 'vt' || key === 'vn') have[key]++;
      if (key === 'o' && object === undefined && w.length > 1) { const o = printable(body.slice(1)); if (o) object = o; }
      count(key);
    }
  }

  // a corner that named what the file had not given yet at its line, and the file does not have at its end: the first such line
  let late: { a: Ahead; kind: RefKind } | undefined;
  for (const kind of ['v', 'vt', 'vn'] as const) {
    const a = ahead[kind].find((x) => x.index > have[kind]);
    if (a && (!late || a.line < late.a.line)) late = { a, kind };
  }
  if (late) return fail(late.a.line, `corner "${clip(late.a.word)}" names ${NOUN[late.kind][0]} ${late.a.digits}, but the file has ${have[late.kind]} (${late.kind} lines)`);
  if (!faces) return { kind: 'no faces', error: `no face (f line) in the file, so no triangles to measure (${have.v ? `it has ${have.v} ${plural(have.v, 'vertex', 'vertices')}` : 'it has no vertices'})` };

  const cs = corners.view;
  return {
    format: 'obj', triangles: trianglesOf(coords.view, cs), vertices: have.v, faces, polygons, unused: unusedOf(have.v, cs),
    ignored: [...ignored].map(([what, lines]) => ({ what, lines })), extras: { weights, colours },
    ...(comment ? { comment } : {}), ...(object ? { object } : {}),
  };
}

// ── reading a file ────────────────────────────────────────────────────────────

const METHODS = {
  bbox: 'the least and greatest corner coordinate on each axis, over the corners the faces name',
  area: 'the sum of |(b - a) × (c - a)| / 2 over the triangles, in double precision',
  volume: 'the sum of (a - r) · ((b - r) × (c - r)) / 6 over the triangles, r the bounding box\'s centre; the enclosed volume only for an edge-manifold, consistently oriented mesh',
  edges: 'corners joined where bit-identical as 32-bit floats (two v lines of the same coordinates are one corner); every edge of the triangles with three distinct corners, counted by how many triangles share it and which way each runs along it',
  faces: 'a face of more than three corners split as a fan from its first corner: (c1, ck, ck+1) for k = 2 … n − 1',
} as const;

/** What an OBJ held besides its triangles, in words: the statements ignored, and what of its vertices is not used. */
export function ignoredWords(ignored: readonly ObjIgnored[], extras: { weights: number; colours: number }): string {
  const total = ignored.reduce((a, x) => a + x.lines, 0);
  const head = total ? `ignored: ${ignored.map((x) => `${x.lines} ${x.what}`).join(', ')} ${plural(total, 'line', 'lines')}` : 'nothing ignored: every statement is a v or an f';
  const unused = [
    ...(extras.weights ? [`the weight on ${extras.weights} v ${plural(extras.weights, 'line', 'lines')}`] : []),
    ...(extras.colours ? [`the colour on ${extras.colours} v ${plural(extras.colours, 'line', 'lines')}`] : []),
  ];
  return unused.length ? `${head}; not used: ${unused.join(' and ')}` : head;
}

/** The measurement of an OBJ's bytes (already read and hashed), as Timmy records it. */
export function objReadbackOf(buf: Buffer, file: string, sha256: string): ObjReadResult {
  const parsed = parseObj(buf);
  if ('error' in parsed) return { ok: false, kind: parsed.kind, error: parsed.error, file, sha256, bytes: buf.length };
  let measure: MeshMeasure;
  try { measure = measureMesh(parsed.triangles); } catch (e) {
    return { ok: false, kind: 'malformed', error: (e as Error).message, file, sha256, bytes: buf.length };
  }
  return {
    ok: true,
    readback: {
      measured_by: OBJ_READBACK, tier: 'deterministic computation',
      scope: 'measured from the OBJ file, in its own units; not a measurement of a physical part',
      independent_of: 'the program that exported it: Timmy\'s own TypeScript reads the file\'s bytes (no CAD engine, no library)',
      file, sha256, bytes: buf.length, format: 'obj',
      units: 'the file\'s own: OBJ records no unit',
      joining: 'exact: corners bit-identical as 32-bit floats are one corner (-0 as +0); no tolerance',
      precision: 'each coordinate read as a 32-bit float (Math.fround), as Timmy\'s STL reader reads an ASCII STL, so one mesh written as STL and as OBJ measures the same',
      methods: { ...METHODS },
      ...measure,
      obj: {
        vertices: parsed.vertices, faces: parsed.faces, polygons: parsed.polygons, unused_vertices: parsed.unused, ignored: parsed.ignored, extras: parsed.extras,
        faces_words: facesWords(parsed.faces, parsed.polygons, measure.triangles, parsed.unused), ignored_words: ignoredWords(parsed.ignored, parsed.extras),
      },
      provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15,
    },
  };
}

/**
 * Reads an OBJ once (a regular file, never a FIFO waited on, at most `maxBytes`), hashes the bytes read and measures those
 * same bytes. `file` is the name recorded (relative to the project).
 */
export function readObjFile(abs: string, file: string, opts: { maxBytes?: number } = {}): ObjReadResult {
  const read = readMeshBytes(abs, file, opts.maxBytes ?? OBJ_MAX_BYTES);
  return read.ok ? objReadbackOf(read.buf, file, read.sha256) : read;
}
