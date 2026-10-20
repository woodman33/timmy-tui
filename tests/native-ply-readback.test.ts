/**
 * R8 (H154): Timmy's own PLY reader (src/native/ply-readback.ts, timmy-ply-readback/1): ascii and binary_little_endian PLY,
 * the vertex element's x, y and z (float or double) and the face element's corners (a list of whole numbers: list uchar int
 * vertex_indices and its uint/int variants), a polygon split as a fan; every other property, element and comment ignored and
 * counted; measured by the STL reader's own measure, so one mesh written as STL and as PLY measures the same. What it does not
 * read yet (binary_big_endian, a missing x, y or z, a list it does not know, a type it does not know) is said plainly, with
 * why; malformed data is refused with where and why; a file with no faces (a point cloud) has no triangles to measure.
 *
 * FAKE, labelled: every mesh here is written by the test. Real: Timmy's PLY and STL readers.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePly, PLY_READBACK, plyReadbackOf, readPlyFile } from '../src/native/ply-readback.js';
import { DOCTRINE_15, readbackOf as stlReadbackOf, type MeshMeasure } from '../src/native/stl-readback.js';
import { cubeStl, sha } from './helpers/vox-fakes.js';

const MEASURES = ['triangles', 'corners', 'bbox', 'volume', 'area', 'edges', 'boundary_edges', 'non_manifold_edges', 'misoriented_edges', 'collapsed_triangles', 'zero_area_triangles', 'manifold', 'oriented'] as const;
const measures = (m: MeshMeasure) => Object.fromEntries(MEASURES.map((k) => [k, m[k]]));

/** FAKE: the cube of tests/helpers/vox-fakes.ts cubeStl(10), as eight vertices and six quads in the STL's triangle order. */
const CUBE_V = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const CUBE_F = [[2, 1, 0, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const head = (format: string, lines: string[]): string => ['ply', `format ${format} 1.0`, ...lines, 'end_header', ''].join('\n');
const CUBE_HEAD = ['comment FAKE: a cube of side 10, written by the test', 'element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices'];

/** Little-endian values, written by the test. */
class W {
  parts: Buffer[] = [];
  private put(n: number, f: (b: Buffer) => void): this { const b = Buffer.alloc(n); f(b); this.parts.push(b); return this; }
  f32(...v: number[]): this { for (const x of v) this.put(4, (b) => b.writeFloatLE(x)); return this; }
  f64(...v: number[]): this { for (const x of v) this.put(8, (b) => b.writeDoubleLE(x)); return this; }
  u8(...v: number[]): this { for (const x of v) this.put(1, (b) => b.writeUInt8(x)); return this; }
  i16(...v: number[]): this { for (const x of v) this.put(2, (b) => b.writeInt16LE(x)); return this; }
  u16(...v: number[]): this { for (const x of v) this.put(2, (b) => b.writeUInt16LE(x)); return this; }
  i32(...v: number[]): this { for (const x of v) this.put(4, (b) => b.writeInt32LE(x)); return this; }
  u32(...v: number[]): this { for (const x of v) this.put(4, (b) => b.writeUInt32LE(x)); return this; }
  get bytes(): Buffer { return Buffer.concat(this.parts); }
}
function cubeBinary(faces = CUBE_F, vertices = CUBE_V, header = CUBE_HEAD): Buffer {
  const w = new W();
  for (const v of vertices) w.f32(...v);
  for (const f of faces) { w.u8(f.length); w.i32(...f); }
  return Buffer.concat([Buffer.from(head('binary_little_endian', header)), w.bytes]);
}
const cubeAscii = (vertexLines = CUBE_V.map((v) => v.join(' ')), faceLines = CUBE_F.map((f) => `${f.length} ${f.join(' ')}`)): string =>
  head('ascii', CUBE_HEAD) + [...vertexLines, ...faceLines, ''].join('\n');
const said = (b: Buffer | string): [string, string] => {
  const p = parsePly(Buffer.isBuffer(b) ? b : Buffer.from(b));
  return 'error' in p ? [p.kind, p.error] : ['read', ''];
};

describe("Timmy's own PLY reader (R8 H154)", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r8-ply-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('a cube of six quads, binary_little_endian and ascii, measures exactly as the same cube written as a binary STL', () => {
    const stl = stlReadbackOf(cubeStl(10), 'cube.stl', sha(cubeStl(10)));
    if (!stl.ok) throw new Error(stl.error);
    for (const [encoding, bytes] of [['binary_little_endian', cubeBinary()], ['ascii', Buffer.from(cubeAscii())]] as const) {
      const r = plyReadbackOf(bytes, 'cube.ply', sha(bytes));
      if (!r.ok) throw new Error(`${encoding}: ${r.error}`);
      expect(measures(r.readback), encoding).toEqual(measures(stl.readback));
      expect(r.readback).toMatchObject({
        measured_by: PLY_READBACK, tier: 'deterministic computation', file: 'cube.ply', sha256: sha(bytes), bytes: bytes.length, format: 'ply',
        triangles: 12, corners: 8, volume: 1000, area: 600, manifold: true, oriented: true, provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15,
      });
      expect(r.readback.ply).toEqual({
        encoding, vertices: 8, faces: 6, polygons: 6, unused_vertices: 0, coordinates: 'x, y and z as float', indices: 'list uchar int vertex_indices',
        ignored: { properties: [], elements: [], comments: 1, obj_info: 0 },
        faces_words: '6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all',
        ignored_words: 'ignored: 1 comment line',
      });
    }
    expect(PLY_READBACK).toBe('timmy-ply-readback/1');
    const r = plyReadbackOf(cubeBinary(), 'cube.ply', 'x');
    if (!r.ok) throw new Error(r.error);
    expect(r.readback.scope).toBe('measured from the PLY file, in its own units; not a measurement of a physical part');
    expect(r.readback.units).toBe("the file's own: PLY records no unit");
    expect(r.readback.precision).toBe('x, y and z stored as 32-bit floats, read as they are');
    const a = plyReadbackOf(Buffer.from(cubeAscii()), 'cube.ply', 'x');
    expect(a.ok && a.readback.precision).toBe("each coordinate read as a 32-bit float (Math.fround), as Timmy's STL reader reads an ASCII STL, so one mesh written as STL and as PLY measures the same");
    // the file's own words: its header's first comment (declared, not checked)
    const p = parsePly(cubeBinary());
    expect('error' in p ? null : p.comment).toBe('FAKE: a cube of side 10, written by the test');
  });

  it('reads past what it does not use (normals, colours, other elements, other face lists), says so, and reads doubles as 32-bit floats', () => {
    const header = ['comment FAKE: written by the test', 'obj_info FAKE', 'element vertex 3', 'property double x', 'property double y', 'property double z',
      'property float nx', 'property float ny', 'property float nz', 'property uchar red', 'property uchar green', 'property uchar blue',
      'element edge 2', 'property int vertex1', 'property int vertex2',
      'element face 1', 'property uchar flags', 'property list uint8 uint32 vertex_indices', 'property list uchar float texcoord'];
    const w = new W();
    for (const [x, y] of [[0, 0], [1, 0], [0.1, 1]]) { w.f64(x, y, 0).f32(0, 0, 1).u8(200, 100, 50); }
    w.i32(0, 1, 1, 2);
    w.u8(7).u8(3).u32(0, 1, 2).u8(6).f32(0, 0, 1, 0, 0, 1);
    const binary = Buffer.concat([Buffer.from(head('binary_little_endian', header)), w.bytes]);
    const ascii = head('ascii', header) + ['0 0 0 0 0 1 200 100 50', '1 0 0 0 0 1 200 100 50', '0.1 1 0 0 0 1 200 100 50', '0 1', '1 2', '7 3 0 1 2 6 0 0 1 0 0 1', ''].join('\n');
    for (const bytes of [binary, Buffer.from(ascii)]) {
      const r = plyReadbackOf(bytes, 'rich.ply', 'x');
      if (!r.ok) throw new Error(r.error);
      expect(r.readback.triangles).toBe(1);
      expect(r.readback.bbox?.max).toEqual([1, 1, 0]);
      expect(r.readback.bbox?.min).toEqual([0, 0, 0]);
      expect(r.readback.ply).toMatchObject({
        vertices: 3, faces: 1, polygons: 0, coordinates: 'x, y and z as double', indices: 'list uint8 uint32 vertex_indices',
        ignored: { properties: ['vertex nx', 'vertex ny', 'vertex nz', 'vertex red', 'vertex green', 'vertex blue', 'face flags', 'face texcoord'], elements: [{ name: 'edge', count: 2 }], comments: 1, obj_info: 1 },
        faces_words: '1 face, every one a triangle',
        ignored_words: 'ignored: vertex nx, ny, nz, red, green, blue; face flags, texcoord; element edge (2); 1 comment, 1 obj_info lines',
      });
    }
    // a double is read as a 32-bit float (the precision of Timmy's measure), and said so
    const p = parsePly(binary);
    expect('error' in p ? null : p.triangles[6]).toBe(Math.fround(0.1));
    const r = plyReadbackOf(binary, 'rich.ply', 'x');
    expect(r.ok && r.readback.precision).toBe("x, y and z stored as 64-bit doubles, each read as a 32-bit float (Math.fround), the precision Timmy's mesh measure works in: digits past a 32-bit float are not used");
    // the variants of the corners' list: int counts and indices, a short index, the name vertex_index
    const variants = [
      ['list int int vertex_index', (w2: W, f: number[]) => { w2.i32(f.length, ...f); }],
      ['list ushort short vertex_indices', (w2: W, f: number[]) => { w2.u16(f.length); w2.i16(...f); }],
      ['list uchar uint vertex_indices', (w2: W, f: number[]) => { w2.u8(f.length); w2.u32(...f); }],
    ] as const;
    for (const [list, write] of variants) {
      const w2 = new W();
      for (const v of CUBE_V) w2.f32(...v);
      for (const f of CUBE_F) write(w2, f);
      const hd = [...CUBE_HEAD.slice(0, -1), `property ${list}`];
      const v = plyReadbackOf(Buffer.concat([Buffer.from(head('binary_little_endian', hd)), w2.bytes]), 'v.ply', 'x');
      expect(v.ok && [v.readback.volume, v.readback.ply.indices], list).toEqual([1000, list]);
    }
  });

  it('says plainly what it does not read yet, with why: binary_big_endian, a missing x, y or z, x as int, a list it does not know, a type it does not know', () => {
    const notYet = (lines: string[], format = 'binary_little_endian') => said(head(format, lines));
    expect(notYet(CUBE_HEAD, 'binary_big_endian')).toEqual(['not read yet', 'not read by Timmy yet: the data is binary_big_endian, and this reader reads ascii and binary_little_endian']);
    expect(said(['ply', 'format ascii 2.0', 'end_header', ''].join('\n'))).toEqual(['not read yet', 'not read by Timmy yet: PLY format version 2.0 (this reader reads 1.0)']);
    expect(notYet(['element vertex 8', 'property float x', 'property float y', 'element face 6', 'property list uchar int vertex_indices'])).toEqual(['not read yet', "not read by Timmy yet: the vertex element has no z property (Timmy reads a vertex's x, y and z)"]);
    expect(notYet(['element vertex 8', 'property int x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices'])).toEqual(['not read yet', 'not read by Timmy yet: vertex x is int (Timmy reads x, y and z stored as float or double)']);
    expect(notYet(['element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property list uchar float vertex_indices'])).toEqual(['not read yet', "not read by Timmy yet: face vertex_indices is list uchar float (Timmy reads a face's corners as a list of whole numbers counted by a whole number, such as list uchar int)"]);
    expect(notYet(['element vertex 8', 'property int64 x', 'property float y', 'property float z', 'element face 6', 'property list uchar int vertex_indices'])).toEqual(['not read yet', 'not read by Timmy yet: header line 4 names the property type "int64", which this reader does not know']);
    expect(notYet(['element vertex 8', 'property float x', 'property float y', 'property float z', 'element face 6', 'property uchar flags'])).toEqual(['not read yet', "not read by Timmy yet: the face element has no vertex_indices list (Timmy reads a face's corners from it)"]);
    expect(notYet(['element face 6', 'property list uchar int vertex_indices'])).toEqual(['not read yet', "not read by Timmy yet: the header has a face element but no vertex element (Timmy reads the faces' corners from the vertex element)"]);
  });

  it('refuses malformed data with where and why; a file with no faces (a point cloud) has no triangles to measure', () => {
    expect(said('solid x\nendsolid x\n')).toEqual(['malformed', 'not a PLY: its first line is "solid x", not "ply"']);
    expect(said('ply\nformat ascii 1.0\nelement vertex 1\n')).toEqual(['malformed', 'not a well-formed PLY: its header does not end (no end_header line)']);
    expect(said(head('ascii', ['element vertex 1', 'foo bar']))).toEqual(['malformed', 'not a well-formed PLY: header line 4: "foo bar" is not a PLY header line (comment, obj_info, element, property or end_header)']);
    expect(said(head('ascii', ['property float x']))).toEqual(['malformed', 'not a well-formed PLY: header line 3: a property before any element']);
    expect(said(head('ascii', ['element vertex many']))).toEqual(['malformed', 'not a well-formed PLY: header line 3: the element vertex has the count "many", not a whole number']);
    expect(said(['ply', 'element vertex 1', 'end_header', ''].join('\n'))).toEqual(['malformed', 'not a well-formed PLY: header line 2: an element before the format line']);
    // binary
    expect(said(cubeBinary().subarray(0, cubeBinary().length - 1))).toEqual(['malformed', 'not a well-formed PLY: the file ends inside face 6 of 6']);
    expect(said(Buffer.concat([cubeBinary(), Buffer.from([1, 2, 3])]))).toEqual(['malformed', 'not a well-formed PLY: 3 bytes after the last element its header names']);
    expect(said(cubeBinary([CUBE_F[0], [0, 1, 8], ...CUBE_F.slice(2)]))).toEqual(['malformed', 'not a well-formed PLY: face 2 names vertex 8, but the file has 8 vertices (PLY counts them from 0)']);
    expect(said(cubeBinary([[0, 1], ...CUBE_F.slice(1)]))).toEqual(['malformed', 'not a well-formed PLY: face 1 names 2 corners; a face needs at least three']);
    expect(said(cubeBinary(CUBE_F, CUBE_V.map((v, i) => (i === 3 ? [0, Number.NaN, 0] : v))))).toEqual(['malformed', "not a well-formed PLY: vertex 4's y is NaN, not a finite number"]);
    const tooMany = Buffer.concat([Buffer.from(head('binary_little_endian', CUBE_HEAD.map((l) => (l === 'element vertex 8' ? 'element vertex 1000000' : l)))), cubeBinary().subarray(Buffer.byteLength(head('binary_little_endian', CUBE_HEAD)))]);
    expect(said(tooMany)).toEqual(['malformed', "not a well-formed PLY: the header names 1000000 vertex entries, more than the file's 198 bytes of data hold"]);
    // ascii: the cube's header is 10 lines, so vertex 1 is line 11 and the faces lines 19 to 24
    const vs = CUBE_V.map((v) => v.join(' '));
    expect(said(cubeAscii([vs[0], 'abc 0 0', ...vs.slice(2)]))).toEqual(['malformed', 'not a well-formed PLY: line 12: vertex 2\'s x is "abc", not a finite number']);
    expect(said(cubeAscii(['0 0', ...vs.slice(1)]))).toEqual(['malformed', 'not a well-formed PLY: line 11: vertex 1 ends before its property z']);
    expect(said(cubeAscii(['0 0 0 0', ...vs.slice(1)]))).toEqual(['malformed', "not a well-formed PLY: line 11: vertex 1 has 4 values, more than its header's properties take (3)"]);
    expect(said(cubeAscii(vs.slice(0, 7), []))).toEqual(['malformed', 'not a well-formed PLY: the file ends after 7 of the 8 vertex entries its header names']);
    expect(said(`${cubeAscii()}1 2 3\n`)).toEqual(['malformed', 'not a well-formed PLY: line 25: data after the last element its header names']);
    expect(said(cubeAscii(vs, ['3 0 1 9', ...CUBE_F.slice(1).map((f) => `${f.length} ${f.join(' ')}`)]))).toEqual(['malformed', 'not a well-formed PLY: line 19: face 1 names vertex 9, but the file has 8 vertices (PLY counts them from 0)']);
    // no faces: a point cloud's data is not read
    expect(said(head('binary_little_endian', ['element vertex 3', 'property float x', 'property float y', 'property float z']))).toEqual(['no faces', 'no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read)']);
    expect(said(head('ascii', ['element vertex 0', 'property float x', 'property float y', 'property float z', 'element face 0', 'property list uchar int vertex_indices']))).toEqual(['no faces', 'its face element is empty (0 faces), so no triangles to measure']);
    // the refusal is the readback's, with the bytes' sha256
    expect(plyReadbackOf(Buffer.from('solid x\n'), 'bad.ply', 'f'.repeat(64))).toEqual({ ok: false, kind: 'malformed', error: 'not a PLY: its first line is "solid x", not "ply"', file: 'bad.ply', sha256: 'f'.repeat(64), bytes: 8 });
  });

  it('reads a file once: the sha256 of the bytes it measured; a missing file is said so', () => {
    const file = join(tmp, 'cube.ply');
    const bytes = cubeBinary();
    writeFileSync(file, bytes);
    const r = readPlyFile(file, 'cube.ply');
    if (!r.ok) throw new Error(r.error);
    expect(r.readback).toMatchObject({ measured_by: PLY_READBACK, file: 'cube.ply', sha256: sha(bytes), bytes: bytes.length, triangles: 12, volume: 1000 });
    expect(readPlyFile(join(tmp, 'none.ply'), 'none.ply')).toEqual({ ok: false, kind: 'missing', error: 'not there', file: 'none.ply' });
    expect(readPlyFile(file, 'cube.ply', { maxBytes: 10 })).toMatchObject({ ok: false, kind: 'too large' });
  });
});
