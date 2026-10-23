/**
 * R8 (H154): what Timmy's own OBJ and PLY readers share (src/native/obj-readback.ts, src/native/ply-readback.ts): reading a
 * mesh file once through one descriptor (a regular file, never a FIFO waited on, at most a limit) and hashing those bytes,
 * growable typed arrays for the corners and triangles, the triangles' corners as the measure takes them (nine float32 values
 * per triangle: src/native/stl-readback.ts measureMesh, the STL reader's own measure), and the words for faces split as fans.
 * The STL reader keeps its own reading (src/native/stl-readback.ts readStlFile), unchanged.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** Why a mesh was not measured: missing (no regular file), too large, malformed, not read by Timmy yet, no faces, unreadable. */
export type MeshFailKind = 'missing' | 'too large' | 'malformed' | 'not read yet' | 'no faces' | 'unreadable';
export interface MeshReadFailure { ok: false; kind: MeshFailKind; error: string; file: string; sha256?: string; bytes?: number }

/** A file's bytes read once (a regular file, never a FIFO waited on, at most `limit`), and their sha256. */
export function readMeshBytes(abs: string, file: string, limit: number): { ok: true; buf: Buffer; sha256: string } | MeshReadFailure {
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
  return { ok: true, buf, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** A Float32Array that grows as values are pushed. */
export class GrowF32 {
  private a = new Float32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get view(): Float32Array { return this.a.subarray(0, this.n); }
}

/** A Uint32Array that grows as values are pushed. */
export class GrowU32 {
  private a = new Uint32Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get view(): Uint32Array { return this.a.subarray(0, this.n); }
}

/** The triangles' corners as the measure takes them: nine float32 values per triangle, from three per vertex and three per triangle. */
export function trianglesOf(coords: Float32Array, corners: Uint32Array): Float32Array {
  const out = new Float32Array(corners.length * 3);
  for (let c = 0; c < corners.length; c++) {
    const v = corners[c] * 3;
    out[c * 3] = coords[v];
    out[c * 3 + 1] = coords[v + 1];
    out[c * 3 + 2] = coords[v + 2];
  }
  return out;
}

/** How many of `vertices` vertices no triangle names. */
export function unusedOf(vertices: number, corners: Uint32Array): number {
  const used = new Uint8Array(vertices);
  let n = 0;
  for (let c = 0; c < corners.length; c++) if (!used[corners[c]]) { used[corners[c]] = 1; n++; }
  return vertices - n;
}

const s = (n: number): string => (n === 1 ? '' : 's');

/** The faces in words: how many, how many were polygons split as fans, how many triangles, and the vertices no face names. */
export function facesWords(faces: number, polygons: number, triangles: number, unused: number): string {
  const head = polygons
    ? `${faces} face${s(faces)}: ${polygons} with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); ${triangles} triangle${s(triangles)} in all`
    : `${faces} face${s(faces)}, every one a triangle`;
  return unused ? `${head}; ${unused} vert${unused === 1 ? 'ex' : 'ices'} no face names (not measured)` : head;
}

/** The precision words of a reader whose coordinates are text or doubles: each read as a 32-bit float, as measureMesh takes it. */
export const FLOAT32_WORDS = 'each coordinate read as a 32-bit float (Math.fround)';
