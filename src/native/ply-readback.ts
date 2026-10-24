/**
 * R8 (H154): Timmy's own reading of a PLY mesh (Stanford's polygon file format), in TypeScript, with no CAD engine or library
 * involved: an implementation independent of the program that exported the file.
 *
 * The file is read once: its bytes are hashed, and those same bytes are parsed and measured (src/native/mesh-common.ts
 * readMeshBytes), so the sha256 recorded is of the bytes measured. What is read:
 *   the header   "ply", "format ascii 1.0" or "format binary_little_endian 1.0", then element and property lines (comment and
 *                obj_info lines counted) up to "end_header"; the types char, uchar, short, ushort, int, uint, float and double
 *                and their sized names (int8 … float64)
 *   vertices     the vertex element's x, y and z, stored as float or double (text in ascii): each read as a 32-bit float
 *                (Math.fround), the precision Timmy's mesh measure works in (a float is read as it is; a double's digits past
 *                a 32-bit float are not used, and that is said)
 *   faces        the face element's corners: a list of whole numbers counted by a whole number (list uchar int vertex_indices,
 *                and its variants: uint, int, ushort and the like, or the name vertex_index), each a vertex counted from 0; a
 *                face of more than three corners is split as a fan from its first corner, (c1, ck, ck+1) for k = 2 … n − 1
 *   the rest     every other property of the vertices and faces (normals, colours, texture lists), every other element and
 *                every comment: read past by its declared type and counted, its values not checked
 * Said plainly as not read by Timmy yet, with why: binary_big_endian, a format version other than 1.0, a property type it does
 * not know, a vertex element without x, y or z (or with them stored as whole numbers), a face element without a list of whole
 * numbers for its corners. Refused as malformed, with where and why: a header that is not PLY's, data that ends early or goes
 * on past the header's elements, a coordinate that is not a finite number (or is beyond a 32-bit float), a face of fewer than
 * three corners or naming a vertex the file does not have. A file with no faces (a point cloud) has no triangles to measure,
 * and its data is not read.
 *
 * What is measured is what Timmy's STL reader measures, by its own measure (src/native/stl-readback.ts measureMesh) over the
 * triangles' corners, with DOCTRINE §15's tags and sentence: provenance `generated`, evidence state `checked`, in the file's
 * own units, never a physical object's.
 */
import { DOCTRINE_15, measureMesh, type MeshMeasure } from './stl-readback.js';
import { facesWords, GrowU32, readMeshBytes, trianglesOf, unusedOf, type MeshFailKind, type MeshReadFailure } from './mesh-common.js';

/** This reader's name and version, recorded with each measurement. */
export const PLY_READBACK = 'timmy-ply-readback/1';
/** The largest file read back; a larger one is reported as not measured. */
export const PLY_MAX_BYTES = 256 * 1024 * 1024;
/** The most of a file looked through for its header's end. */
const HEADER_MAX = 1024 * 1024;

export interface PlyIgnored { properties: string[]; elements: Array<{ name: string; count: number }>; comments: number; obj_info: number }

/** A parsed PLY: each triangle's three corners (nine float32 values per triangle), and what the file held. */
export interface PlyParsed {
  format: 'ply';
  encoding: 'ascii' | 'binary_little_endian';
  triangles: Float32Array;
  vertices: number;
  faces: number;
  /** faces of four or more corners (split as fans) */
  polygons: number;
  /** vertices no face names */
  unused: number;
  /** how x, y and z are stored, and the corners' list, as the header names them */
  coordinates: string;
  indices: string;
  precision: string;
  ignored: PlyIgnored;
  /** the header's first comment: the file's own words, not checked */
  comment?: string;
}
export interface PlyParseFailure { kind: Extract<MeshFailKind, 'malformed' | 'not read yet' | 'no faces'>; error: string }

/** A measurement as Timmy records it: the file it read, how, and DOCTRINE §15's tags and sentence. */
export interface PlyReadback extends MeshMeasure {
  measured_by: typeof PLY_READBACK;
  tier: 'deterministic computation';
  scope: string;
  independent_of: string;
  file: string;
  sha256: string;
  bytes: number;
  format: 'ply';
  units: string;
  joining: string;
  precision: string;
  methods: { bbox: string; area: string; volume: string; edges: string; faces: string };
  ply: {
    encoding: 'ascii' | 'binary_little_endian'; vertices: number; faces: number; polygons: number; unused_vertices: number;
    coordinates: string; indices: string; ignored: PlyIgnored; faces_words: string; ignored_words: string;
  };
  provenance: 'generated';
  evidence: 'checked';
  notice: typeof DOCTRINE_15;
}

/** A reading: the measurement, and the file's own words (its header's first comment), declared and not checked. */
export type PlyReadResult = { ok: true; readback: PlyReadback; comment?: string } | MeshReadFailure;

// ── the header ────────────────────────────────────────────────────────────────

interface PlyType { size: number; whole: boolean; read: (b: Buffer, at: number) => number }
const t = (size: number, whole: boolean, read: (b: Buffer, at: number) => number): PlyType => ({ size, whole, read });
const TYPES = new Map<string, PlyType>([
  ['char', t(1, true, (b, a) => b.readInt8(a))], ['int8', t(1, true, (b, a) => b.readInt8(a))],
  ['uchar', t(1, true, (b, a) => b[a])], ['uint8', t(1, true, (b, a) => b[a])],
  ['short', t(2, true, (b, a) => b.readInt16LE(a))], ['int16', t(2, true, (b, a) => b.readInt16LE(a))],
  ['ushort', t(2, true, (b, a) => b.readUInt16LE(a))], ['uint16', t(2, true, (b, a) => b.readUInt16LE(a))],
  ['int', t(4, true, (b, a) => b.readInt32LE(a))], ['int32', t(4, true, (b, a) => b.readInt32LE(a))],
  ['uint', t(4, true, (b, a) => b.readUInt32LE(a))], ['uint32', t(4, true, (b, a) => b.readUInt32LE(a))],
  ['float', t(4, false, (b, a) => b.readFloatLE(a))], ['float32', t(4, false, (b, a) => b.readFloatLE(a))],
  ['double', t(8, false, (b, a) => b.readDoubleLE(a))], ['float64', t(8, false, (b, a) => b.readDoubleLE(a))],
]);
const type = (name: string): PlyType => TYPES.get(name)!;

interface PlyProperty { name: string; type: string; list?: { count: string; item: string } }
interface PlyElement { name: string; count: number; properties: PlyProperty[]; line: number }
interface PlyHeader { encoding: 'ascii' | 'binary_little_endian'; elements: PlyElement[]; dataAt: number; lines: number; comments: number; obj_info: number; comment?: string }

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const clip = (s: string): string => s.slice(0, 40);
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '.').trim().slice(0, 200);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const bad = (what: string): PlyParseFailure => ({ kind: 'malformed', error: `not a well-formed PLY: ${what}` });
const notYet = (what: string): PlyParseFailure => ({ kind: 'not read yet', error: `not read by Timmy yet: ${what}` });

function headerOf(buf: Buffer): PlyHeader | PlyParseFailure {
  let at = 0;
  let no = 0;
  let encoding: PlyHeader['encoding'] | undefined;
  const elements: PlyElement[] = [];
  let comments = 0;
  let objInfo = 0;
  let comment: string | undefined;
  for (;;) {
    if (at >= buf.length || at > HEADER_MAX) return no === 0 ? { kind: 'malformed', error: 'not a PLY: the file is empty' } : bad('its header does not end (no end_header line)');
    const end = buf.indexOf(0x0a, at);
    const stop = end < 0 ? buf.length : end;
    const text = buf.toString('latin1', at, Math.min(stop, at + 4096)).replace(/\r$/, '');
    at = end < 0 ? buf.length : end + 1;
    no++;
    if (no === 1) {
      if (text.trimEnd() !== 'ply') return { kind: 'malformed', error: `not a PLY: its first line is "${clip(printable(text))}", not "ply"` };
      continue;
    }
    const line = text.trim();
    if (!line) continue;
    const w = line.split(/\s+/);
    switch (w[0]) {
      case 'comment': {
        comments++;
        if (comment === undefined) { const c = printable(line.slice(7)); if (c) comment = c; }
        continue;
      }
      case 'obj_info': objInfo++; continue;
      case 'format': {
        if (encoding !== undefined) return bad(`header line ${no}: a second format line`);
        if (w.length !== 3) return bad(`header line ${no}: "${clip(line)}" is not a format line (format ascii 1.0, or binary_little_endian, or binary_big_endian)`);
        if (w[1] === 'binary_big_endian') return notYet('the data is binary_big_endian, and this reader reads ascii and binary_little_endian');
        if (w[1] !== 'ascii' && w[1] !== 'binary_little_endian') return bad(`header line ${no}: "${clip(w[1])}" is not a PLY format (ascii, binary_little_endian or binary_big_endian)`);
        if (w[2] !== '1.0') return notYet(`PLY format version ${clip(w[2])} (this reader reads 1.0)`);
        encoding = w[1];
        continue;
      }
      case 'element': {
        if (encoding === undefined) return bad(`header line ${no}: an element before the format line`);
        if (w.length !== 3) return bad(`header line ${no}: "${clip(line)}" is not an element line (element <name> <count>)`);
        if (!/^\d+$/.test(w[2]) || !Number.isSafeInteger(Number(w[2]))) return bad(`header line ${no}: the element ${clip(w[1])} has the count "${clip(w[2])}", not a whole number`);
        elements.push({ name: w[1], count: Number(w[2]), properties: [], line: no });
        continue;
      }
      case 'property': {
        const el = elements[elements.length - 1];
        if (!el) return bad(`header line ${no}: a property before any element`);
        if (w[1] === 'list') {
          if (w.length !== 5) return bad(`header line ${no}: "${clip(line)}" is not a list property (property list <count type> <item type> <name>)`);
          for (const ty of [w[2], w[3]]) if (!TYPES.has(ty)) return notYet(`header line ${no} names the property type "${clip(ty)}", which this reader does not know`);
          el.properties.push({ name: w[4], type: 'list', list: { count: w[2], item: w[3] } });
        } else {
          if (w.length !== 3) return bad(`header line ${no}: "${clip(line)}" is not a property line (property <type> <name>)`);
          if (!TYPES.has(w[1])) return notYet(`header line ${no} names the property type "${clip(w[1])}", which this reader does not know`);
          el.properties.push({ name: w[2], type: w[1] });
        }
        continue;
      }
      case 'end_header':
        if (encoding === undefined) return bad(`header line ${no}: end_header before the format line`);
        return { encoding, elements, dataAt: at, lines: no, comments, obj_info: objInfo, ...(comment ? { comment } : {}) };
      default:
        return bad(`header line ${no}: "${clip(line)}" is not a PLY header line (comment, obj_info, element, property or end_header)`);
    }
  }
}

// ── the data ──────────────────────────────────────────────────────────────────

/** One property as the data walk uses it: its item (or scalar) type, its count type for a list, and what it is read for. */
interface Step { p: PlyProperty; item: PlyType; count: PlyType | null; axis: number; corners: boolean }

/** The triangles of a PLY's bytes, and what else it held; or why it is not read (with where). */
export function parsePly(buf: Buffer): PlyParsed | PlyParseFailure {
  const h = headerOf(buf);
  if ('kind' in h) return h;
  const vertexEl = h.elements.find((e) => e.name === 'vertex');
  const faceEl = h.elements.find((e) => e.name === 'face');
  if (!faceEl) {
    const what = vertexEl ? `a point cloud of ${vertexEl.count} ${plural(vertexEl.count, 'vertex', 'vertices')}; its data is not read` : `its elements: ${h.elements.map((e) => `${e.name} (${e.count})`).join(', ') || 'none'}`;
    return { kind: 'no faces', error: `no face element in its header, so no triangles to measure (${what})` };
  }
  if (!vertexEl) return notYet("the header has a face element but no vertex element (Timmy reads the faces' corners from the vertex element)");
  const xyz: PlyProperty[] = [];
  for (const n of ['x', 'y', 'z']) {
    const p = vertexEl.properties.find((q) => q.name === n);
    if (!p) return notYet(`the vertex element has no ${n} property (Timmy reads a vertex's x, y and z)`);
    if (p.list) return notYet(`vertex ${n} is a list (Timmy reads x, y and z stored as float or double)`);
    if (type(p.type).whole) return notYet(`vertex ${n} is ${p.type} (Timmy reads x, y and z stored as float or double)`);
    xyz.push(p);
  }
  const idx = faceEl.properties.find((p) => p.name === 'vertex_indices' || p.name === 'vertex_index');
  const LIST_WORDS = "(Timmy reads a face's corners as a list of whole numbers counted by a whole number, such as list uchar int)";
  if (!idx) return notYet("the face element has no vertex_indices list (Timmy reads a face's corners from it)");
  if (!idx.list) return notYet(`face ${idx.name} is ${idx.type}, not a list ${LIST_WORDS}`);
  if (!type(idx.list.count).whole || !type(idx.list.item).whole) return notYet(`face ${idx.name} is list ${idx.list.count} ${idx.list.item} ${LIST_WORDS}`);
  if (faceEl.count === 0) return { kind: 'no faces', error: 'its face element is empty (0 faces), so no triangles to measure' };

  for (const el of h.elements) if (el.count && !el.properties.length) return bad(`header line ${el.line}: the element ${el.name} has ${el.count} entries but no properties`);
  // the vertices' count against the data there is, before room is set aside for their coordinates (the least a vertex takes:
  // its properties' sizes, or in ascii a value and a space or line end for each); the rest is read as it comes
  const remaining = buf.length - h.dataAt;
  const nv = vertexEl.count;
  const per = h.encoding === 'ascii' ? 2 * vertexEl.properties.length : vertexEl.properties.reduce((a, p) => a + type(p.list ? p.list.count : p.type).size, 0);
  if (nv * per > remaining + (h.encoding === 'ascii' ? 1 : 0)) return bad(`the header names ${nv} vertex entries, more than the file's ${remaining} bytes of data hold`);

  const coords = new Float32Array(nv * 3);
  const corners = new GrowU32();
  const ids: number[] = [];
  let faces = 0;
  let polygons = 0;
  const fan = (n: number): void => {
    for (let k = 1; k + 1 < n; k++) { corners.push(ids[0]); corners.push(ids[k]); corners.push(ids[k + 1]); }
    faces++;
    if (n > 3) polygons++;
  };
  const stepsOf = (el: PlyElement): Step[] => el.properties.map((p) => ({
    p, item: type(p.list ? p.list.item : p.type), count: p.list ? type(p.list.count) : null, axis: el === vertexEl ? xyz.indexOf(p) : -1, corners: el === faceEl && p === idx,
  }));
  const corner = (v: number, face: number, where: string): string | null =>
    (v >= 0 && v < nv ? null : `${where}face ${face} names vertex ${v}, but the file has ${nv} ${plural(nv, 'vertex', 'vertices')} (PLY counts them from 0)`);
  const coordinate = (v: number, shown: string, vertex: number, name: string, where: string): number | string => {
    if (!Number.isFinite(v)) return `${where}vertex ${vertex}'s ${name} is ${shown}, not a finite number`;
    const f = Math.fround(v);
    return Number.isFinite(f) ? f : `${where}vertex ${vertex}'s ${name} is ${shown}, beyond a 32-bit float, the precision Timmy's mesh measure works in`;
  };

  if (h.encoding === 'binary_little_endian') {
    let at = h.dataAt;
    for (const el of h.elements) {
      const steps = stepsOf(el);
      const ends = (i: number): PlyParseFailure => bad(`the file ends inside ${el.name} ${i + 1} of ${el.count}`);
      for (let i = 0; i < el.count; i++) {
        for (const s of steps) {
          if (s.count) {
            if (at + s.count.size > buf.length) return ends(i);
            const n = s.count.read(buf, at);
            at += s.count.size;
            if (n < 0) return bad(`${el.name} ${i + 1}'s ${s.p.name} counts ${n} entries`);
            if (at + n * s.item.size > buf.length) return ends(i);
            if (s.corners) {
              if (n < 3) return bad(`face ${i + 1} names ${n} ${plural(n, 'corner', 'corners')}; a face needs at least three`);
              ids.length = 0;
              for (let k = 0; k < n; k++) {
                const v = s.item.read(buf, at + k * s.item.size);
                const no = corner(v, i + 1, '');
                if (no) return bad(no);
                ids.push(v);
              }
              fan(n);
            }
            at += n * s.item.size;
          } else {
            if (at + s.item.size > buf.length) return ends(i);
            if (s.axis >= 0) {
              const v = s.item.read(buf, at);
              const f = coordinate(v, String(v), i + 1, s.p.name, '');
              if (typeof f === 'string') return bad(f);
              coords[i * 3 + s.axis] = f;
            }
            at += s.item.size;
          }
        }
      }
    }
    if (at !== buf.length) return bad(`${buf.length - at} ${plural(buf.length - at, 'byte', 'bytes')} after the last element its header names`);
  } else {
    const text = buf.toString('latin1', h.dataAt);
    let pos = 0;
    let lineNo = h.lines;
    const next = (): { text: string; no: number } | null => {
      while (pos < text.length) {
        const end = text.indexOf('\n', pos);
        const l = text.slice(pos, end < 0 ? text.length : end);
        pos = end < 0 ? text.length : end + 1;
        lineNo++;
        if (l.trim()) return { text: l, no: lineNo };
      }
      return null;
    };
    for (const el of h.elements) {
      const steps = stepsOf(el);
      for (let i = 0; i < el.count; i++) {
        const line = next();
        if (!line) return bad(`the file ends after ${i} of the ${el.count} ${el.name} entries its header names`);
        const where = `line ${line.no}: `;
        const tok = line.text.trim().split(/\s+/);
        let at = 0;
        for (const s of steps) {
          if (at >= tok.length) return bad(`${where}${el.name} ${i + 1} ends before its property ${s.p.name}`);
          if (s.count) {
            const c = tok[at++];
            if (!/^\d+$/.test(c)) return bad(`${where}${el.name} ${i + 1}'s ${s.p.name} count is "${clip(c)}", not a whole number`);
            const n = Number(c);
            if (at + n > tok.length) return bad(`${where}${el.name} ${i + 1} ends inside its property ${s.p.name} (${n} named, ${tok.length - at} there)`);
            if (s.corners) {
              if (n < 3) return bad(`${where}face ${i + 1} names ${n} ${plural(n, 'corner', 'corners')}; a face needs at least three`);
              ids.length = 0;
              for (let k = 0; k < n; k++) {
                const word = tok[at + k];
                if (!/^[+-]?\d+$/.test(word)) return bad(`${where}face ${i + 1}'s corner "${clip(word)}" is not a whole number`);
                const v = Number(word);
                const no = corner(v, i + 1, where);
                if (no) return bad(no);
                ids.push(v);
              }
              fan(n);
            }
            at += n;
          } else {
            const word = tok[at++];
            if (s.axis >= 0) {
              if (!NUMBER.test(word)) return bad(`${where}vertex ${i + 1}'s ${s.p.name} is "${clip(word)}", not a finite number`);
              const f = coordinate(Number(word), clip(word), i + 1, s.p.name, where);
              if (typeof f === 'string') return bad(f);
              coords[i * 3 + s.axis] = f;
            }
          }
        }
        if (at < tok.length) return bad(`${where}${el.name} ${i + 1} has ${tok.length} values, more than its header's properties take (${at})`);
      }
    }
    const extra = next();
    if (extra) return bad(`line ${extra.no}: data after the last element its header names`);
  }

  const cs = corners.view;
  const types = xyz.map((p) => p.type);
  const doubles = types.filter((ty) => type(ty).size === 8).length;
  const precision = h.encoding === 'ascii'
    ? "each coordinate read as a 32-bit float (Math.fround), as Timmy's STL reader reads an ASCII STL, so one mesh written as STL and as PLY measures the same"
    : doubles === 0 ? 'x, y and z stored as 32-bit floats, read as they are'
      : `${doubles === 3 ? 'x, y and z' : 'some of x, y and z'} stored as 64-bit doubles, each read as a 32-bit float (Math.fround), the precision Timmy's mesh measure works in: digits past a 32-bit float are not used`;
  return {
    format: 'ply', encoding: h.encoding, triangles: trianglesOf(coords, cs), vertices: nv, faces, polygons, unused: unusedOf(nv, cs),
    coordinates: types.every((ty) => ty === types[0]) ? `x, y and z as ${types[0]}` : `x as ${types[0]}, y as ${types[1]}, z as ${types[2]}`,
    indices: `list ${idx.list.count} ${idx.list.item} ${idx.name}`, precision,
    ignored: {
      properties: [...vertexEl.properties.filter((p) => !xyz.includes(p)).map((p) => `vertex ${p.name}`), ...faceEl.properties.filter((p) => p !== idx).map((p) => `face ${p.name}`)],
      elements: h.elements.filter((e) => e !== vertexEl && e !== faceEl).map((e) => ({ name: e.name, count: e.count })),
      comments: h.comments, obj_info: h.obj_info,
    },
    ...(h.comment ? { comment: h.comment } : {}),
  };
}

// ── reading a file ────────────────────────────────────────────────────────────

const METHODS = {
  bbox: 'the least and greatest corner coordinate on each axis, over the corners the faces name',
  area: 'the sum of |(b - a) × (c - a)| / 2 over the triangles, in double precision',
  volume: 'the sum of (a - r) · ((b - r) × (c - r)) / 6 over the triangles, r the bounding box\'s centre; the enclosed volume only for an edge-manifold, consistently oriented mesh',
  edges: 'corners joined where bit-identical as 32-bit floats (two vertices of the same coordinates are one corner); every edge of the triangles with three distinct corners, counted by how many triangles share it and which way each runs along it',
  faces: 'a face of more than three corners split as a fan from its first corner: (c1, ck, ck+1) for k = 2 … n − 1',
} as const;

/** What a PLY held besides its triangles, in words. */
export function plyIgnoredWords(ig: PlyIgnored): string {
  const parts: string[] = [];
  for (const el of ['vertex', 'face']) {
    const names = ig.properties.filter((p) => p.startsWith(`${el} `)).map((p) => p.slice(el.length + 1));
    if (names.length) parts.push(`${el} ${names.join(', ')}`);
  }
  for (const e of ig.elements) parts.push(`element ${e.name} (${e.count})`);
  const lines = ig.comments + ig.obj_info;
  if (lines) parts.push(`${[...(ig.comments ? [`${ig.comments} comment`] : []), ...(ig.obj_info ? [`${ig.obj_info} obj_info`] : [])].join(', ')} ${plural(lines, 'line', 'lines')}`);
  return parts.length ? `ignored: ${parts.join('; ')}` : "nothing ignored: the header names only x, y, z and the faces' corners";
}

/** The measurement of a PLY's bytes (already read and hashed), as Timmy records it. */
export function plyReadbackOf(buf: Buffer, file: string, sha256: string): PlyReadResult {
  const parsed = parsePly(buf);
  if ('error' in parsed) return { ok: false, kind: parsed.kind, error: parsed.error, file, sha256, bytes: buf.length };
  let measure: MeshMeasure;
  try { measure = measureMesh(parsed.triangles); } catch (e) {
    return { ok: false, kind: 'malformed', error: (e as Error).message, file, sha256, bytes: buf.length };
  }
  return {
    ok: true,
    readback: {
      measured_by: PLY_READBACK, tier: 'deterministic computation',
      scope: 'measured from the PLY file, in its own units; not a measurement of a physical part',
      independent_of: 'the program that exported it: Timmy\'s own TypeScript reads the file\'s bytes (no CAD engine, no library)',
      file, sha256, bytes: buf.length, format: 'ply',
      units: 'the file\'s own: PLY records no unit',
      joining: 'exact: corners bit-identical as 32-bit floats are one corner (-0 as +0); no tolerance',
      precision: parsed.precision,
      methods: { ...METHODS },
      ...measure,
      ply: {
        encoding: parsed.encoding, vertices: parsed.vertices, faces: parsed.faces, polygons: parsed.polygons, unused_vertices: parsed.unused,
        coordinates: parsed.coordinates, indices: parsed.indices, ignored: parsed.ignored,
        faces_words: facesWords(parsed.faces, parsed.polygons, measure.triangles, parsed.unused), ignored_words: plyIgnoredWords(parsed.ignored),
      },
      provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15,
    },
    ...(parsed.comment ? { comment: parsed.comment } : {}),
  };
}

/**
 * Reads a PLY once (a regular file, never a FIFO waited on, at most `maxBytes`), hashes the bytes read and measures those
 * same bytes. `file` is the name recorded (relative to the project).
 */
export function readPlyFile(abs: string, file: string, opts: { maxBytes?: number } = {}): PlyReadResult {
  const read = readMeshBytes(abs, file, opts.maxBytes ?? PLY_MAX_BYTES);
  return read.ok ? plyReadbackOf(read.buf, file, read.sha256) : read;
}
