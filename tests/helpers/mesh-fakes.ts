/**
 * Test helpers for tab 6's OBJ and PLY meshes (round R8, helper H154). FAKE, labelled: every mesh made here is written by a
 * test, never exported by a tool. The cube is tests/helpers/vox-fakes.ts cubeStl(s) as eight vertices and six quads, in the STL's
 * triangle order (each quad's fan from its first corner gives the STL's two triangles, their corners turned), so the cube read
 * as STL, OBJ and PLY measures the same.
 */

/** The cube's corners, as cubeStl(s) has them. */
export const cubeVertices = (s: number): number[][] => [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
/** The cube's six faces as quads (0-based), in cubeStl's triangle order. */
export const CUBE_QUADS = [[2, 1, 0, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

/** FAKE: the cube as an OBJ of six quads, with a first comment and an object name. */
export function cubeObj(s: number, comment = 'FAKE: a cube written by a test'): string {
  return [`# ${comment}`, 'o FAKE-cube', ...cubeVertices(s).map((v) => `v ${v.join(' ')}`), ...CUBE_QUADS.map((f) => `f ${f.map((i) => i + 1).join(' ')}`), ''].join('\n');
}

/** FAKE: the cube as a PLY (float x, y, z; list uchar int vertex_indices), ascii or binary_little_endian. */
export function cubePly(s: number, encoding: 'ascii' | 'binary_little_endian' = 'binary_little_endian', comment = 'FAKE: a cube written by a test'): Buffer {
  const header = ['ply', `format ${encoding} 1.0`, `comment ${comment}`, 'element vertex 8', 'property float x', 'property float y', 'property float z',
    'element face 6', 'property list uchar int vertex_indices', 'end_header', ''].join('\n');
  if (encoding === 'ascii') return Buffer.from(header + [...cubeVertices(s).map((v) => v.join(' ')), ...CUBE_QUADS.map((f) => `4 ${f.join(' ')}`), ''].join('\n'));
  const data = Buffer.alloc(8 * 12 + 6 * 17);
  let at = 0;
  for (const v of cubeVertices(s)) for (const x of v) { data.writeFloatLE(x, at); at += 4; }
  for (const f of CUBE_QUADS) { data.writeUInt8(4, at); at += 1; for (const i of f) { data.writeInt32LE(i, at); at += 4; } }
  return Buffer.concat([Buffer.from(header), data]);
}

/** FAKE: a PLY of `n` vertices and no faces (a point cloud), binary_little_endian. */
export function pointCloudPly(n: number): Buffer {
  const header = ['ply', 'format binary_little_endian 1.0', 'comment FAKE: a point cloud written by a test', `element vertex ${n}`, 'property float x', 'property float y', 'property float z', 'end_header', ''].join('\n');
  return Buffer.concat([Buffer.from(header), Buffer.alloc(n * 12)]);
}
