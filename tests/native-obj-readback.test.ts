/**
 * R8 (H154): Timmy's own OBJ reader (src/native/obj-readback.ts, timmy-obj-readback/1): ASCII Wavefront OBJ, its `v` and `f`
 * statements (a polygon split as a fan from its first corner; the v, v/vt, v//vn and v/vt/vn corner forms; negative indices
 * counted back), everything else ignored and counted; measured by the STL reader's own measure (measureMesh), so one mesh
 * written as STL and as OBJ measures the same; malformed input refused in words (which line, why), never guessed.
 *
 * FAKE, labelled: every mesh here is written by the test. Real: Timmy's OBJ and STL readers.
 */
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OBJ_READBACK, objReadbackOf, parseObj, readObjFile } from '../src/native/obj-readback.js';
import { DOCTRINE_15, readbackOf as stlReadbackOf, type MeshMeasure } from '../src/native/stl-readback.js';
import { cubeStl, sha } from './helpers/vox-fakes.js';

const MEASURES = ['triangles', 'corners', 'bbox', 'volume', 'area', 'edges', 'boundary_edges', 'non_manifold_edges', 'misoriented_edges', 'collapsed_triangles', 'zero_area_triangles', 'manifold', 'oriented'] as const;
const measures = (m: MeshMeasure) => Object.fromEntries(MEASURES.map((k) => [k, m[k]]));

/** FAKE: the cube of tests/helpers/vox-fakes.ts cubeStl(10), written by the test as six quads in the STL's triangle order. */
const CUBE_OBJ = [
  '# FAKE: a cube of side 10, written by the test',
  'o FAKE-cube',
  'v 0 0 0', 'v 10 0 0', 'v 10 10 0', 'v 0 10 0', 'v 0 0 10', 'v 10 0 10', 'v 10 10 10', 'v 0 10 10',
  'f 3 2 1 4', 'f 5 6 7 8', 'f 1 2 6 5', 'f 2 3 7 6', 'f 3 4 8 7', 'f 4 1 5 8', '',
].join('\n');
const V3 = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0'];
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0];
/** The parse of OBJ lines: what was refused (its kind and words), or 'read'. */
const said = (lines: string[] | Buffer): [string, string] => {
  const p = parseObj(Buffer.isBuffer(lines) ? lines : Buffer.from(lines.join('\n')));
  return 'error' in p ? [p.kind, p.error] : ['read', ''];
};

describe("Timmy's own OBJ reader (R8 H154)", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r8-obj-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('a cube of six quads measures exactly as the same cube written as a binary STL, with the same tags and words', () => {
    const obj = objReadbackOf(Buffer.from(CUBE_OBJ), 'cube.obj', sha(CUBE_OBJ));
    const stl = stlReadbackOf(cubeStl(10), 'cube.stl', sha(cubeStl(10)));
    if (!obj.ok) throw new Error(obj.error);
    if (!stl.ok) throw new Error(stl.error);
    expect(measures(obj.readback)).toEqual(measures(stl.readback));
    expect(obj.readback).toMatchObject({
      measured_by: OBJ_READBACK, tier: 'deterministic computation', file: 'cube.obj', sha256: sha(CUBE_OBJ), bytes: Buffer.byteLength(CUBE_OBJ), format: 'obj',
      triangles: 12, corners: 8, volume: 1000, area: 600, manifold: true, oriented: true, provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15,
    });
    expect(OBJ_READBACK).toBe('timmy-obj-readback/1');
    expect(obj.readback.scope).toBe('measured from the OBJ file, in its own units; not a measurement of a physical part');
    expect(obj.readback.independent_of).toBe("the program that exported it: Timmy's own TypeScript reads the file's bytes (no CAD engine, no library)");
    expect(obj.readback.units).toBe("the file's own: OBJ records no unit");
    expect(obj.readback.precision).toBe("each coordinate read as a 32-bit float (Math.fround), as Timmy's STL reader reads an ASCII STL, so one mesh written as STL and as OBJ measures the same");
    expect(obj.readback.obj).toEqual({
      vertices: 8, faces: 6, polygons: 6, unused_vertices: 0, ignored: [{ what: 'comment', lines: 1 }, { what: 'o', lines: 1 }], extras: { weights: 0, colours: 0 },
      faces_words: '6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all',
      ignored_words: 'ignored: 1 comment, 1 o lines',
    });
    // the file's own words: its first comment, before any statement (declared, not checked)
    const p = parseObj(Buffer.from(CUBE_OBJ));
    expect('error' in p ? null : [p.comment, p.object]).toEqual(['FAKE: a cube of side 10, written by the test', 'FAKE-cube']);
  });

  it('the corner forms v, v/vt, v//vn and v/vt/vn and negative indices name the same corners; vt and vn are ignored and counted', () => {
    const p = parseObj(Buffer.from([...V3, 'vt 0 0', 'vt 1 0', 'vt 0 1', 'vn 0 0 1',
      'f 1/1 2/2 3/3', 'f 1//1 2//1 3//1', 'f 1/1/1 2/2/1 3/3/1', 'f -3 -2 -1', 'f -3/-3/-1 -2/-2/-1 -1/-1/-1', ''].join('\n')));
    if ('error' in p) throw new Error(p.error);
    expect([...p.triangles]).toEqual([...TRI, ...TRI, ...TRI, ...TRI, ...TRI]);
    expect(p.ignored).toEqual([{ what: 'vt', lines: 3 }, { what: 'vn', lines: 1 }]);
    expect([p.vertices, p.faces, p.polygons, p.unused]).toEqual([3, 5, 0, 0]);
    // a negative index counts back from the vertices given so far, not from the file's end
    const back = parseObj(Buffer.from([...V3, 'f -3 -2 -1', 'v 5 5 5', 'v 6 5 5', 'v 5 6 5', 'f -3 -2 -1', ''].join('\n')));
    if ('error' in back) throw new Error(back.error);
    expect([...back.triangles]).toEqual([...TRI, 5, 5, 5, 6, 5, 5, 5, 6, 5]);
  });

  it('a polygon is split as a fan from its first corner; what the faces were is said; a vertex no face names is counted', () => {
    // a flat, convex hexagon of area 6 and a triangle beside it; one vertex no face names
    const p = parseObj(Buffer.from(['v 0 0 0', 'v 2 0 0', 'v 3 1 0', 'v 2 2 0', 'v 0 2 0', 'v -1 1 0', 'v 9 9 9', 'f 1 2 3 4 5 6', 'f 1 2 3', ''].join('\n')));
    if ('error' in p) throw new Error(p.error);
    expect(p.triangles.length / 9).toBe(5);
    expect([...p.triangles.subarray(0, 36)]).toEqual([0, 0, 0, 2, 0, 0, 3, 1, 0, 0, 0, 0, 3, 1, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 0, 0, 2, 0, -1, 1, 0]);
    const r = objReadbackOf(Buffer.from(['v 0 0 0', 'v 2 0 0', 'v 3 1 0', 'v 2 2 0', 'v 0 2 0', 'v -1 1 0', 'v 9 9 9', 'f 1 2 3 4 5 6', ''].join('\n')), 'hex.obj', 'x');
    if (!r.ok) throw new Error(r.error);
    expect(r.readback.area).toBe(6);
    expect(r.readback.bbox).toEqual({ min: [-1, 0, 0], max: [3, 2, 0], size: [4, 2, 0] }); // of the triangles' corners: the unused vertex is not in it
    expect(r.readback.obj.faces_words).toBe('1 face: 1 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 4 triangles in all; 1 vertex no face names (not measured)');
    expect(r.readback.obj.ignored_words).toBe('nothing ignored: every statement is a v or an f');
    const tris = objReadbackOf(Buffer.from([...V3, 'v 0 0 1', 'f 1 2 3', 'f 1 2 4', ''].join('\n')), 'two.obj', 'x');
    expect(tris.ok && tris.readback.obj.faces_words).toBe('2 faces, every one a triangle');
  });

  it('a weight or a colour after x, y and z is read past and said not used; continued lines, inline comments, CRLF and exponents are read', () => {
    const p = objReadbackOf(Buffer.from(['v 0 0 0 1', 'v 1 0 0 0.5 0.25 0.125', 'v 0 \\', '  1.0e0 0', 'f 1 2 3 # the only face', ''].join('\r\n')), 'w.obj', 'x');
    if (!p.ok) throw new Error(p.error);
    expect([p.readback.triangles, p.readback.area]).toEqual([1, 0.5]);
    expect(p.readback.obj.extras).toEqual({ weights: 1, colours: 1 });
    expect(p.readback.obj.ignored_words).toBe('nothing ignored: every statement is a v or an f; not used: the weight on 1 v line and the colour on 1 v line');
    const q = parseObj(Buffer.from(['v 0 0 0', 'v 1 0 0', 'v 0 1 \\', '0', 'v 0 0 1', 'f 1 2 3 x', ''].join('\n')));
    // the statement continued over two lines is one vertex; the face after it is on line 6
    expect('error' in q ? q.error : '').toBe('not a well-formed OBJ: line 6: "x" is not a face corner (v, v/vt, v//vn or v/vt/vn, each a whole number)');
  });

  it('refuses what is not a well-formed OBJ, with the line and why; a face may name a vertex given later in the file', () => {
    expect(said(['v 1 2'])).toEqual(['malformed', 'not a well-formed OBJ: line 1: a vertex (v) has 2 numbers; it needs x, y and z, then nothing more, a weight, or a colour (red, green, blue)']);
    expect(said(['v 1 2 3 4 5'])).toEqual(['malformed', 'not a well-formed OBJ: line 1: a vertex (v) has 5 numbers; it needs x, y and z, then nothing more, a weight, or a colour (red, green, blue)']);
    expect(said(['v 0 0 0', 'v 1 abc 0'])).toEqual(['malformed', 'not a well-formed OBJ: line 2: "abc" is not a coordinate (a finite number)']);
    expect(said(['v 0 0 0', 'v 1 nan 0'])).toEqual(['malformed', 'not a well-formed OBJ: line 2: "nan" is not a coordinate (a finite number)']);
    expect(said(['v 0 0 0', 'v 1e39 0 0'])).toEqual(['malformed', 'not a well-formed OBJ: line 2: 1e39 is beyond a 32-bit float, the precision Timmy\'s mesh measure works in']);
    expect(said([...V3, 'f 1 2'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: a face (f) names 2 corners; a face needs at least three']);
    expect(said([...V3, 'f 1 2 4'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: corner "4" names vertex 4, but the file has 3 (v lines)']);
    expect(said([...V3, 'f 0 1 2'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: corner "0" names vertex 0; OBJ numbers its vertices from 1 (and back from -1)']);
    expect(said([...V3, 'f -4 1 2'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: corner "-4" counts back past the first vertex (3 v lines come before it)']);
    expect(said([...V3, 'f 1/a 2 3'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: "1/a" is not a face corner (v, v/vt, v//vn or v/vt/vn, each a whole number)']);
    expect(said([...V3, 'f 1/2/3/4 2 3'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: "1/2/3/4" is not a face corner (v, v/vt, v//vn or v/vt/vn, each a whole number)']);
    expect(said([...V3, 'vt 0 0', 'f 1/2 2/1 3/1'])).toEqual(['malformed', 'not a well-formed OBJ: line 5: corner "1/2" names texture coordinate 2, but the file has 1 (vt lines)']);
    expect(said([...V3, 'f 1//1 2//1 3//1'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: corner "1//1" names normal 1, but the file has 0 (vn lines)']);
    expect(said([...V3, '1.5 2 3', 'f 1 2 3'])).toEqual(['malformed', 'not a well-formed OBJ: line 4: "1.5" does not begin an OBJ statement (a statement begins with a word such as v, f or vt)']);
    // OBJ numbers its vertices from the beginning of the file: a face before its vertices is read, an index past them is not
    expect(said(['f 1 2 3', ...V3])).toEqual(['read', '']);
    expect(said(['f 1 2 3', 'f 1 2 5', ...V3, 'f 1 2 4'])).toEqual(['malformed', 'not a well-formed OBJ: line 2: corner "5" names vertex 5, but the file has 3 (v lines)']);
    // binary bytes are not text (a compiled object file is also named .obj)
    expect(said(Buffer.concat([Buffer.from('v 0 0 0\n'), Buffer.from([0, 1, 2])]))).toEqual(['malformed', 'not a Wavefront OBJ: the byte at offset 8 is 0x00, and an OBJ is text (.obj also names compiled object files)']);
    // no face: no triangles to measure
    expect(said(V3)).toEqual(['no faces', 'no face (f line) in the file, so no triangles to measure (it has 3 vertices)']);
    expect(said([''])).toEqual(['no faces', 'no face (f line) in the file, so no triangles to measure (it has no vertices)']);
    expect(said(['# FAKE: only a comment', 'o nothing'])).toEqual(['no faces', 'no face (f line) in the file, so no triangles to measure (it has no vertices)']);
    // the refusal is the readback's, with the bytes' sha256
    expect(objReadbackOf(Buffer.from('v 1 2\n'), 'bad.obj', 'f'.repeat(64))).toEqual({ ok: false, kind: 'malformed', error: 'not a well-formed OBJ: line 1: a vertex (v) has 2 numbers; it needs x, y and z, then nothing more, a weight, or a colour (red, green, blue)', file: 'bad.obj', sha256: 'f'.repeat(64), bytes: 6 });
  });

  it('reads a file once: the sha256 of the bytes it measured; a missing, too large or not regular file is said so', () => {
    const file = join(tmp, 'cube.obj');
    writeFileSync(file, CUBE_OBJ);
    const r = readObjFile(file, 'cube.obj');
    if (!r.ok) throw new Error(r.error);
    expect(r.readback).toMatchObject({ measured_by: OBJ_READBACK, file: 'cube.obj', sha256: sha(CUBE_OBJ), bytes: Buffer.byteLength(CUBE_OBJ), triangles: 12, volume: 1000 });
    expect(readObjFile(file, 'cube.obj', { maxBytes: 100 })).toMatchObject({ ok: false, kind: 'too large', error: `${Buffer.byteLength(CUBE_OBJ)} bytes: larger than the readback reads (100)` });
    expect(readObjFile(join(tmp, 'none.obj'), 'none.obj')).toEqual({ ok: false, kind: 'missing', error: 'not there', file: 'none.obj' });
    mkdirSync(join(tmp, 'folder.obj'));
    expect(readObjFile(join(tmp, 'folder.obj'), 'folder.obj')).toEqual({ ok: false, kind: 'missing', error: 'not a regular file', file: 'folder.obj' });
    const big = join(tmp, 'big.obj');
    writeFileSync(big, '');
    truncateSync(big, 2048);
    expect(readObjFile(big, 'big.obj', { maxBytes: 1024 })).toMatchObject({ ok: false, kind: 'too large', bytes: 2048 });
  });
});
