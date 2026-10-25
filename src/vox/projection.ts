/**
 * R6 (H143): a mesh's triangles as three orthographic views (front, top, side), for the companion's VoxVision panel
 * (src/vox/preview.ts) where a record holds an STL or a STEP's tessellation (src/vox/tessellate.ts). Drawn from the file's
 * own triangles by Timmy, in plain TypeScript: no 3D library, no GPU, nothing run.
 *
 *   front   seen from −y: x to the right, z up
 *   top     seen from +z: x to the right, y up
 *   side    seen from +x: y to the right, z up
 *
 * Each view draws the mesh's feature edges (where two faces meet at more than FEATURE_ANGLE_DEG, an open boundary, or an edge
 * of more than two faces) and its outline in that view (an edge between a face turned toward the viewer and one turned away),
 * hidden ones too: there is no hidden-line removal, and the drawing says so. All three views share one scale, so their sizes
 * read against each other; coordinates are view units (VIEW_UNITS on the longest side of the box), y down as SVG draws it.
 * A drawing of a file's geometry measures nothing and is never a measurement of a physical part (DOCTRINE §15).
 */

/** Feature edges: faces meeting at more than this many degrees. */
export const FEATURE_ANGLE_DEG = 30;
/** The most triangles drawn here; a larger mesh is said to be too large (Rerun's viewer draws it). */
export const PROJECTION_MAX_TRIANGLES = 250_000;
/** The most segments one view carries (the rest are counted). */
export const PROJECTION_MAX_SEGMENTS = 8_000;
/** View units on the longest side of the mesh's box. */
export const VIEW_UNITS = 1000;

export type ViewName = 'front' | 'top' | 'side';

export interface ProjectionView {
  name: ViewName;
  /** the file's axes along the view's right and up */
  axes: [string, string];
  /** where it is seen from, in words */
  from: string;
  /** the drawing's extent in view units: width and height (its origin is 0, 0 at the top left) */
  size: [number, number];
  /** the segments as an SVG path (M x y L x y …), in view units */
  d: string;
  /** segments drawn, and how many there were (more than PROJECTION_MAX_SEGMENTS are counted, not drawn) */
  drawn: number;
  total: number;
}

export interface MeshProjection {
  triangles: number;
  /** the box of the mesh's corners in the file's own units: min, max and size on x, y and z */
  box: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  /** file units per view unit (one scale for the three views) */
  scale: number;
  edges: { feature: number; boundary: number; nonManifold: number };
  views: ProjectionView[];
  /** how it was drawn, in words */
  method: string;
}

const VIEWS: ReadonlyArray<{ name: ViewName; axes: [string, string]; from: string; toViewer: [number, number, number]; u: 0 | 1 | 2; w: 0 | 1 | 2 }> = [
  { name: 'front', axes: ['x', 'z'], from: 'seen from −y: x to the right, z up', toViewer: [0, -1, 0], u: 0, w: 2 },
  { name: 'top', axes: ['x', 'y'], from: 'seen from +z: x to the right, y up', toViewer: [0, 0, 1], u: 0, w: 1 },
  { name: 'side', axes: ['y', 'z'], from: 'seen from +x: y to the right, z up', toViewer: [1, 0, 0], u: 1, w: 2 },
];

export const PROJECTION_METHOD = `orthographic views of the file's own triangles: feature edges (faces meeting at more than ${FEATURE_ANGLE_DEG}°, open boundaries, edges of more than two faces) and each view's outline, hidden edges included (no hidden-line removal); one scale for the three views`;

/**
 * The three views of a mesh given as nine float32 values per triangle (src/native/stl-readback.ts parseStl's `triangles`).
 * Refuses, with why, a mesh with no triangles, a coordinate that is not finite, or more than PROJECTION_MAX_TRIANGLES.
 */
export function projectMesh(tris: Float32Array, o: { maxTriangles?: number; maxSegments?: number } = {}): MeshProjection | { error: string } {
  const n = Math.floor(tris.length / 9);
  const maxT = o.maxTriangles ?? PROJECTION_MAX_TRIANGLES;
  const maxS = o.maxSegments ?? PROJECTION_MAX_SEGMENTS;
  if (n === 0) return { error: 'the mesh holds no triangles, so there is nothing to draw' };
  if (n > maxT) return { error: `the mesh holds ${n} triangles, more than the ${maxT} drawn here: Rerun's viewer draws it (/vox view)` };
  for (let i = 0; i < n * 9; i++) if (!Number.isFinite(tris[i])) return { error: 'a coordinate of the mesh is not a finite number, so it is not drawn' };

  // corners joined by their exact float32 values (as Timmy's STL reader joins them)
  const ids = new Map<string, number>();
  const xyz: number[] = [];
  const corner = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const at = t * 9 + k * 3;
      const key = `${tris[at]},${tris[at + 1]},${tris[at + 2]}`;
      let id = ids.get(key);
      if (id === undefined) { id = xyz.length / 3; ids.set(key, id); xyz.push(tris[at], tris[at + 1], tris[at + 2]); }
      corner[t * 3 + k] = id;
    }
  }
  const nv = xyz.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let a = 0; a < 3; a++) { const c = xyz[v * 3 + a]; if (c < min[a]) min[a] = c; if (c > max[a]) max[a] = c; }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  // each face's unit normal (null: no area)
  const normal = new Float64Array(n * 3);
  const flat = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [corner[t * 3], corner[t * 3 + 1], corner[t * 3 + 2]];
    const ux = xyz[b * 3] - xyz[a * 3]; const uy = xyz[b * 3 + 1] - xyz[a * 3 + 1]; const uz = xyz[b * 3 + 2] - xyz[a * 3 + 2];
    const vx = xyz[c * 3] - xyz[a * 3]; const vy = xyz[c * 3 + 1] - xyz[a * 3 + 1]; const vz = xyz[c * 3 + 2] - xyz[a * 3 + 2];
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) { flat[t] = 1; continue; }
    normal[t * 3] = nx / len; normal[t * 3 + 1] = ny / len; normal[t * 3 + 2] = nz / len;
  }

  // edges by their two corners, with the faces that have them (a face with no area adds none)
  const faces = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    if (flat[t]) continue;
    for (let k = 0; k < 3; k++) {
      const p = corner[t * 3 + k];
      const q = corner[t * 3 + ((k + 1) % 3)];
      if (p === q) continue;
      const key = p < q ? p * nv + q : q * nv + p;
      const list = faces.get(key);
      if (list) list.push(t); else faces.set(key, [t]);
    }
  }
  const cosFeature = Math.cos((FEATURE_ANGLE_DEG * Math.PI) / 180);
  const always: number[] = [];
  const pairs: Array<[number, number, number]> = [];
  const edges = { feature: 0, boundary: 0, nonManifold: 0 };
  for (const [key, list] of faces) {
    if (list.length === 1) { edges.boundary++; always.push(key); continue; }
    if (list.length > 2) { edges.nonManifold++; always.push(key); continue; }
    const [f, g] = list;
    const dot = normal[f * 3] * normal[g * 3] + normal[f * 3 + 1] * normal[g * 3 + 1] + normal[f * 3 + 2] * normal[g * 3 + 2];
    if (dot < cosFeature) { edges.feature++; always.push(key); continue; }
    pairs.push([key, f, g]);
  }

  const longest = Math.max(size[0], size[1], size[2]);
  const scale = longest > 0 ? longest / VIEW_UNITS : 1;
  const views = VIEWS.map((view): ProjectionView => {
    const [dx, dy, dz] = view.toViewer;
    const facing = (t: number): number => normal[t * 3] * dx + normal[t * 3 + 1] * dy + normal[t * 3 + 2] * dz;
    const keys = [...always];
    // the outline in this view: one face toward the viewer, the other away
    for (const [key, f, g] of pairs) { const a = facing(f); const b = facing(g); if ((a > 0 && b < 0) || (a < 0 && b > 0)) keys.push(key); }
    const width = Math.round(size[view.u] / scale);
    const height = Math.round(size[view.w] / scale);
    const at = (v: number): [number, number] => [Math.round((xyz[v * 3 + view.u] - min[view.u]) / scale), Math.round((max[view.w] - xyz[v * 3 + view.w]) / scale)];
    const parts: string[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const key of keys) {
      const p = Math.floor(key / nv);
      const q = key - p * nv;
      const [x1, y1] = at(p);
      const [x2, y2] = at(q);
      if (x1 === x2 && y1 === y2) continue; // an edge seen end on: a point
      const s = x1 < x2 || (x1 === x2 && y1 <= y2) ? `M${x1} ${y1}L${x2} ${y2}` : `M${x2} ${y2}L${x1} ${y1}`;
      if (seen.has(s)) continue; // the same line in this view (a front edge over a back one)
      seen.add(s);
      total++;
      if (parts.length < maxS) parts.push(s);
    }
    return { name: view.name, axes: view.axes, from: view.from, size: [Math.max(1, width), Math.max(1, height)], d: parts.join(''), drawn: parts.length, total };
  });
  return { triangles: n, box: { min, max, size }, scale, edges, views, method: PROJECTION_METHOD };
}

/** An SVG path of view units only: M and L, whole numbers and spaces (what projectMesh writes; the page checks it again). */
export const PATH_DATA = /^(?:M-?\d+ -?\d+L-?\d+ -?\d+)*$/;
