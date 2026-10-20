/**
 * R7 (H153): the project's meshes and recordings as tab 6 lists them (src/vox/meshes.ts), shared by the companion's panel and
 * the Workbench's tab: which files are meshes (STL by name, its bytes checked when read; a STEP's tessellation that a VoxVision
 * record names), what Timmy's own STL reader measured from the whole file (equal to readStlFile's reading), the caps and what
 * is not measured with why, the view's triangles (all up to the cap, an even and deterministic pick above it, its counts said),
 * the refusals, and the recordings' header facts with what stays unknown and why.
 *
 * FAKE, labelled: the meshes (written by the test), a VoxVision record naming a tessellation (no OCP ran: its made_by says
 * FAKE), a Rerun recording that is not one, and a `rerun` program that is a shell script. Real: Timmy's STL reader, its
 * Rerun header reader over the repository's own recording (studio/ctx-c3w8/…/context.rrd, read, never changed), the
 * receipts on the per-test chain.
 *
 * R9 (H159): beside the header facts, the Rerun CLI's reading (src/vox/rrd-cli.ts). FAKE, labelled: `rerun` is
 * tests/fixtures/fake-rerun.mjs (a TEST DOUBLE replaying outputs CAPTURED from the real rerun-cli 0.38.1 on
 * tests/fixtures/rrd-cli/), first on the PATH.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseObj, readObjFile } from '../src/native/obj-readback.js';
import { parsePly, readPlyFile } from '../src/native/ply-readback.js';
import { DOCTRINE_15, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { folderProject, projectId } from '../src/project/index.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { RERUN_SETUP } from '../src/vox/layers.js';
import { listMeshes, MESH_READ_MAX, MESHES_SCHEMA, meshView, READER_WORDS, VIEW_MAX_TRIANGLES, VIEW_WORDS, viewPick } from '../src/vox/meshes.js';
import { forgetRrdReadings, readRrdWithCli, rrdReadingsIdle } from '../src/vox/rrd-cli.js';
import { cubeObj, cubePly, pointCloudPly } from './helpers/mesh-fakes.js';
import { cubeStl, sha } from './helpers/vox-fakes.js';

const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');

/** A binary STL of `n` triangles in a strip along x (FAKE: written by the test), each triangle's corners known. */
function stripStl(n: number): Buffer {
  const b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i += 1) {
    const x = Math.floor(i / 2);
    const c = i % 2 === 0 ? [[x, 0, 0], [x + 1, 0, 0], [x, 1, 0]] : [[x + 1, 0, 0], [x + 1, 1, 0], [x, 1, 0]];
    c.forEach((p, k) => p.forEach((v, j) => b.writeFloatLE(v + i * 1e-3 * j, 84 + i * 50 + 12 + k * 12 + j * 4)));
  }
  return b;
}
const ASCII_TRI = 'solid FAKE one triangle\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid FAKE\n';

describe('the project\'s meshes and recordings, measured by Timmy\'s own readers (R7 H153)', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const box = (): string => { const d = mkdtempSync(join(tmpdir(), 'r7-meshes-')); made.push(d); return d; };
  const project = (base = box(), name = 'FAKE-project'): string => { const root = join(base, name); mkdirSync(root, { recursive: true }); return root; };
  const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
  const env = { PATH: '' } as NodeJS.ProcessEnv;

  it('lists the project\'s STL files, binary and ASCII, each measured from the whole file exactly as readStlFile measures it', () => {
    const root = project();
    put(root, 'refs/cube.stl', cubeStl(10));
    put(root, 'models/tri.stl', ASCII_TRI);
    put(root, 'UPPER.STL', cubeStl(2));
    put(root, 'notes.txt', 'not a mesh');
    // not the project's meshes: dependencies, git, Timmy's own private folder, a link
    put(root, 'node_modules/pkg/dep.stl', cubeStl(1));
    put(root, '.git/objects/x.stl', cubeStl(1));
    put(root, '.timmy/vox/v00000001/rejected-j1-tessellation.stl', cubeStl(1));
    put(root, '.venv/lib/x.stl', cubeStl(1));
    put(root, 'refs/.hidden.stl', cubeStl(1));
    put(root, 'notes/readme.md', '# FAKE notes: never read by the mesh list\n');
    symlinkSync(join(root, 'refs', 'cube.stl'), join(root, 'link.stl'));

    const list = listMeshes({ root, env });
    expect(list.schema).toBe(MESHES_SCHEMA);
    expect(list.meshes.map((m) => m.path)).toEqual(['UPPER.STL', 'models/tri.stl', 'refs/cube.stl']);
    expect(list.more).toBe(0);
    for (const m of list.meshes) {
      const direct = readStlFile(join(root, m.path), m.path);
      expect(direct.ok, m.path).toBe(true);
      if (!direct.ok) continue;
      expect(m.readback, m.path).toEqual(direct.readback);
      expect(m.topology).toBe(topologyWords(direct.readback));
      expect(m.volume).toBe(volumeWords(direct.readback));
      expect(m.bytes).toBe(direct.readback.bytes);
      expect(m.kind).toBe('stl');
      expect(m.origin.provenance).toBe('not recorded');
    }
    const cube = list.meshes.find((m) => m.path === 'refs/cube.stl')!;
    expect(cube.readback).toMatchObject({ triangles: 12, corners: 8, bbox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] }, volume: 1000, area: 600, manifold: true, oriented: true, format: 'binary', sha256: sha(cubeStl(10)) });
    expect(cube.topology).toBe('edge-manifold: every edge shared by exactly two triangles, consistently oriented');
    expect(cube.volume).toBe('1000 (enclosed; normals outward)');
    expect(cube.view).toEqual({ shown: 12, total: 12, words: 'all 12 triangles' });
    // a binary STL's header and an ASCII STL's solid name are the file's own words, declared and not checked
    expect(cube.declared).toBeUndefined();
    const tri = list.meshes.find((m) => m.path === 'models/tri.stl')!;
    expect(tri.declared).toEqual({ words: 'FAKE one triangle', what: 'its solid\'s name' });
    expect(tri.topology).toBe('not edge-manifold: 3 boundary edges (one triangle: the mesh is open)');
    // what every reading says beside the numbers
    expect(list.doctrine).toBe(DOCTRINE_15);
    expect(list.view).toBe(VIEW_WORDS);
    expect(VIEW_WORDS).toContain('not a render by Blender or any native tool');
    expect(list.cap).toBe(VIEW_MAX_TRIANGLES);
    expect(list.walk).toMatchObject({ truncated: false });
    expect(list.recordings).toEqual([]);
  });

  it('a file that is not measured says why, and is not drawn: not an STL, larger than is read here', () => {
    const root = project();
    put(root, 'bad.stl', 'solid oops\n facet nonsense\nendsolid\n');
    put(root, 'big.stl', '');
    truncateSync(join(root, 'big.stl'), MESH_READ_MAX + 1); // sparse: its size is past the limit, nothing is written
    const list = listMeshes({ root, env });
    expect(list.meshes.map((m) => [m.path, m.readback === undefined, m.view === undefined])).toEqual([['bad.stl', true, true], ['big.stl', true, true]]);
    expect(list.meshes[0].why).toMatch(/^not measured: not a well-formed ASCII STL: line 2: "nonsense" where "normal" was expected$/);
    expect(list.meshes[1].why).toBe(`not measured: it is larger than ${MESH_READ_MAX / 1024 / 1024} MB, more than is read here`);
    expect(list.meshes[1].bytes).toBe(MESH_READ_MAX + 1);
  });

  it('measures within a time budget: what is measured already is kept, at least one new file each reading, the rest said to be measured next', () => {
    const root = project();
    for (const n of ['a', 'b', 'c']) put(root, `parts/${n}.stl`, cubeStl(n === 'a' ? 1 : n === 'b' ? 2 : 3));
    const first = listMeshes({ root, env }, { budgetMs: 0 });
    expect(first.meshes.map((m) => [m.path, m.readback?.triangles ?? null, m.pending ?? false])).toEqual([['parts/a.stl', 12, false], ['parts/b.stl', null, true], ['parts/c.stl', null, true]]);
    expect(first.meshes[1].why).toBe("being measured: Timmy's own STL reader reads it next (the list is read again in a moment)");
    expect(first.meshes[1].view).toBeUndefined();
    expect(first.pending).toBe(2);
    const second = listMeshes({ root, env }, { budgetMs: 0 });
    expect(second.meshes.map((m) => m.pending ?? false)).toEqual([false, false, true]);
    const third = listMeshes({ root, env }, { budgetMs: 0 });
    expect(third.meshes.map((m) => m.pending ?? false)).toEqual([false, false, false]);
    expect(third.pending).toBe(0);
    // with no budget, everything at once
    expect(listMeshes({ root: project(), env }).pending).toBe(0);
  });

  it('caps the list: at most `max` meshes, the rest counted', () => {
    const root = project();
    for (const n of ['a', 'b', 'c', 'd']) put(root, `parts/${n}.stl`, cubeStl(1));
    const list = listMeshes({ root, env }, { max: 2 });
    expect(list.meshes.map((m) => m.path)).toEqual(['parts/a.stl', 'parts/b.stl']);
    expect(list.more).toBe(2);
  });

  it('a STEP\'s tessellation that a VoxVision record names is listed as that tessellation (reconstructed, not the STEP); its bytes changed, it is a plain STL', () => {
    const root = project();
    const id = 'v0fa4e7a1';
    const mesh = `results/vox/${id}/tessellation.stl`;
    put(root, mesh, cubeStl(10));
    const record = {
      schema: 'timmy.vox/1', id, action: 'inspect', command: '/inspect parts/bracket.step', status: 'ok', notes: ['FAKE: a test fixture (tests/vox-meshes.test.ts): no OCP ran'],
      inputs: [{ path: 'parts/bracket.step', sha256: 'f'.repeat(64), bytes: 10, kind: 'step', kind_by: 'name' }],
      views: [{
        viewer: 'rerun', at: '2026-10-16T12:00:00.000Z', program: 'FAKE', passed: [], not_passed: [], detached: true,
        derived: [{
          path: mesh, sha256: sha(cubeStl(10)), bytes: cubeStl(10).length, kind: 'tessellation', format: 'stl', from: { path: 'parts/bracket.step', sha256: 'f'.repeat(64) },
          method: 'OpenCascade BRepMesh_IncrementalMesh', tolerance: { linear_deflection_mm: 0.1, angular_deflection_rad: 0.5, relative: false }, triangles: 12,
          made_by: 'timmy-step-tessellate FAKE (OCP version not reported)', made: 'now', check: { by: 'timmy-stl-readback/1', triangles: 12, box: [10, 10, 10] }, words: 'FAKE',
        }],
      }],
    };
    const text = `${JSON.stringify(record, null, 2)}\n`;
    put(root, `results/vox/${id}.json`, text);

    const t = listMeshes({ root, env }).meshes.find((m) => m.path === mesh)!;
    expect(t.kind).toBe('tessellation');
    expect(t.origin.provenance).toBe('reconstructed');
    expect(t.tessellation).toEqual({ record: id, from: 'parts/bracket.step', made_by: 'timmy-step-tessellate FAKE (OCP version not reported)', tolerance: '0.1 mm (linear deflection) and 0.5 rad (angular)', sealed: null });
    expect(t.origin.words).toBe(`a tessellation of parts/bracket.step by timmy-step-tessellate FAKE (OCP version not reported), within 0.1 mm (linear deflection) and 0.5 rad (angular): a mesh of the STEP's surfaces, not the STEP itself; VoxVision record ${id} names these bytes (no receipt was checked here)`);
    expect(t.readback?.triangles).toBe(12);

    // sealed: a vox receipt of this project names the record and these bytes
    appendReceipt('runs', {
      kind: 'vox', subject: `vox · view · FAKE fixture · ok`, policy: 'human-gated', status: 'ok', project: folderProject(root).name, project_id: projectId(root),
      outputs: [{ path: `results/vox/${id}.json`, sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) }, { path: mesh, sha256: sha(cubeStl(10)), bytes: cubeStl(10).length }],
    } as Parameters<typeof appendReceipt>[1]);
    const sealed = listMeshes({ root, env, chain: readChain('runs') }).meshes.find((m) => m.path === mesh)!;
    expect(sealed.tessellation?.sealed).toBe(true);
    expect(sealed.origin.words).toMatch(new RegExp(`VoxVision record ${id} names these bytes, and vox receipt [0-9a-f]{8} sealed them$`));

    // the file changed since: it is not that tessellation
    put(root, mesh, cubeStl(20));
    const changed = listMeshes({ root, env, chain: readChain('runs') }).meshes.find((m) => m.path === mesh)!;
    expect(changed.kind).toBe('stl');
    expect(changed.origin).toEqual({ provenance: 'not recorded', words: `VoxVision record ${id} names ${mesh} as a tessellation of parts/bracket.step, but these are not the bytes it names (sha256 ${sha(cubeStl(20)).slice(0, 12)} now): where they came from is not recorded` });
    expect(changed.tessellation).toBeUndefined();
  });

  it('the view: every triangle up to the cap; above it an even, deterministic pick through the file\'s order, its counts said; the file\'s own float32 corners', () => {
    const root = project();
    const strip = stripStl(1000);
    put(root, 'strip.stl', strip);
    expect(viewPick(1000, 300).slice(0, 6)).toEqual([0, 3, 6, 10, 13, 16]);
    expect(viewPick(1000, 300)).toHaveLength(300);
    expect(viewPick(12, 300)).toEqual([...Array(12).keys()]);
    const row = listMeshes({ root, env }, { cap: 300 }).meshes[0];
    expect(row.view).toEqual({ shown: 300, total: 1000, words: 'showing 300 of 1000 triangles: an even pick through the file\'s order (triangle ⌊k × 1000 / 300⌋ for k = 0 … 299); the measurements are of all 1000' });
    expect(row.readback?.triangles).toBe(1000);

    const v = meshView(root, 'strip.stl', { cap: 300 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect([v.shown, v.total, v.sha256, v.body.length]).toEqual([300, 1000, sha(strip), 300 * 36]);
    const pick = viewPick(1000, 300);
    for (const k of [0, 1, 150, 299]) {
      for (let j = 0; j < 9; j += 1) expect(v.body.readFloatLE(k * 36 + j * 4), `${k}.${j}`).toBe(strip.readFloatLE(84 + pick[k] * 50 + 12 + j * 4));
    }
    const again = meshView(root, 'strip.stl', { cap: 300 });
    expect(again.ok && again.body.equals(v.body)).toBe(true);
    // up to the cap: every triangle, in the file's order
    const all = meshView(root, 'strip.stl', { cap: 5000 });
    expect(all.ok && [all.shown, all.total, all.body.length]).toEqual([1000, 1000, 36_000]);
  });

  it('refuses: a path outside the project, a file it does not list as a mesh, another project\'s mesh, a link, bytes changed since the list', () => {
    const base = box();
    const a = project(base, 'FAKE-a');
    const b = project(base, 'FAKE-b');
    put(a, 'refs/cube.stl', cubeStl(10));
    put(a, 'notes.txt', 'not a mesh');
    put(a, 'node_modules/pkg/dep.stl', cubeStl(1));
    put(b, 'refs/other.stl', cubeStl(3));
    symlinkSync(join(b, 'refs', 'other.stl'), join(a, 'refs', 'linked.stl'));
    const no = (root: string, rel: string, o: { sha?: string } = {}): [number, string] => { const v = meshView(root, rel, o); return v.ok ? [200, ''] : [v.status, v.error]; };
    expect(no(a, '../FAKE-b/refs/other.stl')).toEqual([400, 'Refused: a mesh is named by its path inside the project, without "..", "." or a leading "/".']);
    expect(no(a, join(b, 'refs', 'other.stl'))[0]).toBe(400);
    expect(no(a, 'refs/other.stl')).toEqual([404, 'Refused: refs/other.stl is not a mesh of this project (tab 6 lists its STL, OBJ and PLY files and its tessellations), so it is not served.']);
    expect(no(a, 'notes.txt')[0]).toBe(404);
    expect(no(a, 'node_modules/pkg/dep.stl')[0]).toBe(404);
    expect(no(a, 'refs/linked.stl')[0]).toBe(404);
    expect(no(b, 'refs/other.stl')[0]).toBe(200); // the same name, asked of its own project
    expect(no(a, 'refs/cube.stl', { sha: sha(cubeStl(10)) })[0]).toBe(200);
    expect(no(a, 'refs/cube.stl', { sha: 'a'.repeat(64) })).toEqual([409, `Not served: refs/cube.stl changed since the list was read (sha256 ${sha(cubeStl(10)).slice(0, 12)} now): read the list again.`]);
    put(a, 'refs/bad.stl', 'not an STL at all, and long enough to be read as one: '.repeat(4));
    expect(no(a, 'refs/bad.stl')[0]).toBe(422);
    // a binary STL whose corner is not a finite number: not measured in the list, and not drawn
    const nan = cubeStl(10);
    nan.writeFloatLE(Number.NaN, 84 + 50 * 3 + 12 + 4);
    put(a, 'refs/nan.stl', nan);
    expect(listMeshes({ root: a, env }).meshes.find((m) => m.path === 'refs/nan.stl')?.why).toBe('not measured: triangle 4 has a coordinate that is not a finite number');
    expect(no(a, 'refs/nan.stl')).toEqual([422, 'Not drawn: triangle 4 of refs/nan.stl has a coordinate that is not a finite number.']);
  });

  // R8 (H154): OBJ and PLY beside STL. FAKE, labelled: the meshes are written by the test (tests/helpers/mesh-fakes.ts), and
  // build/main.obj is a FAKE compiled object file's first bytes (.obj also names those), not a Wavefront OBJ
  it('lists OBJ and PLY files beside STL, each with its kind and reader id, measured from the whole file exactly as readObjFile and readPlyFile measure it (R8 H154)', () => {
    const root = project();
    put(root, 'refs/cube.stl', cubeStl(10));
    put(root, 'refs/cube.obj', cubeObj(10));
    put(root, 'refs/cube.ply', cubePly(10));
    put(root, 'refs/ASCII.PLY', cubePly(2, 'ascii'));
    put(root, 'scans/cloud.ply', pointCloudPly(3));
    put(root, 'scans/big.ply', Buffer.from(cubePly(1).toString('latin1').replace('binary_little_endian', 'binary_big_endian'), 'latin1'));
    put(root, 'build/main.obj', Buffer.from([0x4c, 0x01, 0x00, 0x00, 0x2e, 0x74, 0x65, 0x78, 0x74]));
    put(root, 'models/open.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf 1/1 2/1 3/1\n');

    const list = listMeshes({ root, env });
    expect(list.meshes.map((m) => [m.path, m.kind, m.reader.id])).toEqual([
      ['build/main.obj', 'obj', 'timmy-obj-readback/1'], ['models/open.obj', 'obj', 'timmy-obj-readback/1'], ['refs/ASCII.PLY', 'ply', 'timmy-ply-readback/1'],
      ['refs/cube.obj', 'obj', 'timmy-obj-readback/1'], ['refs/cube.ply', 'ply', 'timmy-ply-readback/1'], ['refs/cube.stl', 'stl', 'timmy-stl-readback/1'],
      ['scans/big.ply', 'ply', 'timmy-ply-readback/1'], ['scans/cloud.ply', 'ply', 'timmy-ply-readback/1'],
    ]);
    const row = (p: string) => list.meshes.find((m) => m.path === p)!;
    // each measured from the whole file exactly as its reader measures it
    for (const p of ['refs/cube.obj', 'models/open.obj']) {
      const direct = readObjFile(join(root, p), p);
      expect(direct.ok && row(p).readback, p).toEqual(direct.ok ? direct.readback : null);
    }
    for (const p of ['refs/cube.ply', 'refs/ASCII.PLY']) {
      const direct = readPlyFile(join(root, p), p);
      expect(direct.ok && row(p).readback, p).toEqual(direct.ok ? direct.readback : null);
    }
    // the same cube, three kinds: the same measures, in the same words
    const stl = row('refs/cube.stl');
    for (const p of ['refs/cube.obj', 'refs/cube.ply']) {
      const m = row(p);
      for (const k of ['triangles', 'corners', 'bbox', 'volume', 'area', 'edges', 'manifold', 'oriented'] as const) expect(m.readback?.[k], `${p} ${k}`).toEqual(stl.readback?.[k]);
      expect([m.topology, m.volume, m.view], p).toEqual([stl.topology, stl.volume, stl.view]);
    }
    expect(row('refs/cube.obj')).toMatchObject({
      format: 'Wavefront OBJ (text)', declared: { words: 'FAKE: a cube written by a test', what: 'its first comment' },
      faces: '6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all',
      ignored: 'ignored: 1 comment, 1 o lines',
      reader: { id: 'timmy-obj-readback/1', name: "Timmy's own OBJ reader", words: "Timmy's own OBJ reader (timmy-obj-readback/1), from the whole file: a deterministic computation on its bytes, in the file's own units" },
    });
    expect(row('refs/cube.ply')).toMatchObject({ format: 'PLY (binary little-endian)', declared: { words: 'FAKE: a cube written by a test', what: "its header's first comment" }, ignored: 'ignored: 1 comment line' });
    expect(row('refs/ASCII.PLY')).toMatchObject({ format: 'PLY (ascii)', readback: { bbox: { size: [2, 2, 2] }, volume: 8 } });
    expect(row('refs/cube.stl')).toMatchObject({ format: 'binary STL', reader: { id: 'timmy-stl-readback/1', name: "Timmy's own STL reader", words: READER_WORDS } });
    expect(row('models/open.obj')).toMatchObject({ topology: 'not edge-manifold: 3 boundary edges (one triangle: the mesh is open)', ignored: 'ignored: 1 vt line', faces: '1 face, every one a triangle' });
    // not measured, with why: a compiled object file, a point cloud, a PLY encoding Timmy does not read yet; and nothing drawn
    expect(row('build/main.obj').why).toBe('not measured: not a Wavefront OBJ: the byte at offset 1 is 0x01, and an OBJ is text (.obj also names compiled object files)');
    expect(row('scans/cloud.ply').why).toBe('not measured: no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read)');
    expect(row('scans/big.ply').why).toBe('not measured: not read by Timmy yet: the data is binary_big_endian, and this reader reads ascii and binary_little_endian');
    for (const p of ['build/main.obj', 'scans/cloud.ply', 'scans/big.ply']) expect([row(p).readback, row(p).view], p).toEqual([undefined, undefined]);
    // who measured, in words: the readers that measured something in this list
    expect(list.reader).toBe("Timmy's own STL reader (timmy-stl-readback/1), OBJ reader (timmy-obj-readback/1) and PLY reader (timmy-ply-readback/1), each from the whole file: a deterministic computation on its bytes, in the file's own units");
    expect(listMeshes({ root: project(), env }).reader).toBe(READER_WORDS);

    // the view: each kind's own triangles, as its reader reads them
    for (const [p, parse] of [['refs/cube.obj', parseObj], ['refs/cube.ply', parsePly]] as const) {
      const v = meshView(root, p);
      if (!v.ok) throw new Error(v.error);
      const tris = parse(readFileSync(join(root, p)));
      if ('error' in tris) throw new Error(tris.error);
      expect([v.shown, v.total, v.sha256], p).toEqual([12, 12, sha(readFileSync(join(root, p)))]);
      for (let i = 0; i < 12 * 9; i += 1) expect(v.body.readFloatLE(i * 4), `${p} ${i}`).toBe(tris.triangles[i]);
    }
    const no = (rel: string): [number, string] => { const v = meshView(root, rel); return v.ok ? [200, ''] : [v.status, v.error]; };
    expect(no('scans/cloud.ply')).toEqual([422, 'Not drawn: scans/cloud.ply: no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read).']);
    expect(no('build/main.obj')[0]).toBe(422);
  });

  it('measures OBJ and PLY files within the time budget too: the one not measured yet says which reader reads it next (R8 H154)', () => {
    const root = project();
    put(root, 'a.obj', cubeObj(1));
    put(root, 'b.ply', cubePly(1));
    const first = listMeshes({ root, env }, { budgetMs: 0 });
    expect(first.meshes.map((m) => [m.path, m.readback?.triangles ?? null, m.pending ?? false])).toEqual([['a.obj', 12, false], ['b.ply', null, true]]);
    expect(first.meshes[1]).toMatchObject({ kind: 'ply', reader: { id: 'timmy-ply-readback/1' }, why: "being measured: Timmy's own PLY reader reads it next (the list is read again in a moment)" });
    expect(listMeshes({ root, env }, { budgetMs: 0 }).pending).toBe(0);
  });

  it('recordings: an .rrd\'s header facts and what stays unknown, with why; Rerun\'s viewer named found or needing setup, never run', () => {
    const root = project();
    mkdirSync(join(root, 'rec'), { recursive: true });
    copyFileSync(RRD, join(root, 'rec', 'context.rrd'));
    put(root, 'rec/fake.rrd', 'FAKE: not a recording');
    const list = listMeshes({ root, env });
    expect(list.meshes).toEqual([]);
    expect(list.recordings.map((r) => r.path)).toEqual(['rec/context.rrd', 'rec/fake.rrd']);
    const [real, fake] = list.recordings;
    expect(real.bytes).toBe(readFileSync(RRD).length);
    expect(real.facts?.writer).toMatch(/^Rerun \d+\.\d+\.\d+$/);
    expect(real.facts?.messages.chunks).toBeGreaterThan(0);
    for (const k of ['entities', 'frames', 'timeRange'] as const) expect(real.facts?.unknown[k]).toBe("inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it");
    expect(fake.facts).toBeUndefined();
    expect(fake.why).toBe("its first bytes are not a Rerun recording's (RRF2)");
    // R9 (H159): the Rerun CLI's reading beside the header's facts: here no rerun at all, and a file that is not a recording is
    // never given to it
    expect(real.sha256).toBe(sha(readFileSync(RRD)));
    expect(real.cli).toMatchObject({ state: 'not read', words: 'not read by the Rerun CLI: rerun is not on the PATH and TIMMY_RERUN is not set', sha256: real.sha256 });
    expect(real.cli.entities).toEqual({ state: 'unknown', reason: 'not-installed', why: 'rerun is not on the PATH and TIMMY_RERUN is not set' });
    const notGiven = "not given to the Rerun CLI: Timmy's own header reader says its first bytes are not a Rerun recording's (RRF2)";
    expect(fake.cli).toMatchObject({ state: 'not read', words: notGiven, calls: [] });
    for (const u of [fake.cli.verify, fake.cli.entities, fake.cli.timelines]) expect(u).toEqual({ state: 'unknown', reason: 'not-a-recording', why: notGiven });
    expect(list.recordingsPending).toBe(0);
    expect(list.viewer).toEqual({ name: "Rerun's viewer", state: 'needs setup', words: "Rerun's viewer needs setup here: rerun is not on the PATH and TIMMY_RERUN is not set", setup: RERUN_SETUP });

    // FAKE: a `rerun` that is a shell script; found is not run, and nothing here runs it
    const bin = box();
    const rerun = join(bin, 'rerun');
    writeFileSync(rerun, '#!/bin/sh\necho "FAKE rerun: must never run here" >&2\nexit 9\n');
    chmodSync(rerun, 0o755);
    const found = listMeshes({ root, env: { PATH: bin } }).viewer;
    expect(found).toEqual({ name: "Rerun's viewer", state: 'found (installed here, not run)', words: "Rerun's viewer is found here (rerun on the PATH): found is not run, and this tab runs nothing; `rerun --bind 127.0.0.1 <file>` in a terminal opens a recording in Rerun's own window, listening on this computer only" });
  });

  // R9 (H159). FAKE, labelled: `rerun` is tests/fixtures/fake-rerun.mjs (a TEST DOUBLE replaying outputs CAPTURED from the
  // real rerun-cli 0.38.1 on tests/fixtures/rrd-cli/probe.rrd and probe-cut.rrd), first on the PATH
  it('recordings: the Rerun CLI\'s reading beside the header facts; not read yet on a draw path, being read once asked, then kept (R9 H159)', async () => {
    forgetRrdReadings();
    const root = project();
    const fix = resolve('tests/fixtures/rrd-cli');
    put(root, 'rec/probe.rrd', readFileSync(join(fix, 'probe.rrd')));
    put(root, 'rec/cut.rrd', readFileSync(join(fix, 'probe-cut.rrd')));
    const bin = box();
    writeFileSync(join(bin, 'rerun'), `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-rerun.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'rerun'), 0o755);
    const fakeEnv = { PATH: `${bin}:/usr/bin:/bin` } as NodeJS.ProcessEnv;
    try {
      // a list on a draw path (no reading asked): the header facts, and "not read yet"; nothing runs
      const drawn = listMeshes({ root, env: fakeEnv });
      expect(drawn.recordings.map((r) => [r.path, r.facts?.format, r.cli.state, r.cli.words])).toEqual([
        ['rec/cut.rrd', 'rrd', 'not read', 'not read yet: rerun-cli reads it in the background once the companion shows tab 6 (c on tab 6 opens it)'],
        ['rec/probe.rrd', 'rrd', 'not read', 'not read yet: rerun-cli reads it in the background once the companion shows tab 6 (c on tab 6 opens it)'],
      ]);
      expect(drawn.recordingsPending).toBe(0);
      // a list that asks for the readings (the companion's): being read, in the background
      const asking = listMeshes({ root, env: fakeEnv }, { rrd: { start: true } });
      expect(asking.recordings.map((r) => [r.path, r.cli.state, r.cli.entities])).toEqual([
        ['rec/cut.rrd', 'being read', { state: 'unknown', reason: 'being-read', why: 'being read by the Rerun CLI, in the background' }],
        ['rec/probe.rrd', 'being read', { state: 'unknown', reason: 'being-read', why: 'being read by the Rerun CLI, in the background' }],
      ]);
      expect(asking.recordingsPending).toBe(2);
      await rrdReadingsIdle();
      // done: every later list, asking or not, holds the reading kept for those bytes
      const after = listMeshes({ root, env: fakeEnv });
      const [cut, probe] = after.recordings;
      const direct = await readRrdWithCli(readFileSync(join(fix, 'probe.rrd')), { env: fakeEnv });
      expect(probe.sha256).toBe(direct.sha256);
      expect(probe.facts?.writer).toBe('Rerun 0.38.1');
      expect([probe.cli.state, probe.cli.words, probe.cli.entities, probe.cli.timelines]).toEqual(['read', 'read by rerun-cli 0.38.1: rrd stats and rrd print', direct.entities, direct.timelines]);
      expect(cut.cli.verify).toMatchObject({ state: 'failed' });
      expect(cut.cli.entities).toMatchObject({ state: 'unknown', reason: 'verify-failed' });
      expect(after.recordingsPending).toBe(0);
      expect(listMeshes({ root, env: fakeEnv }, { rrd: { start: true } }).recordings.map((r) => r.cli.state)).toEqual(['read', 'read']);
    } finally { await rrdReadingsIdle(); forgetRrdReadings(); }
  });

  it('a recording names the run that wrote it and its receipt, when Timmy\'s records say so; else says they do not (R9 H159)', () => {
    const root = project();
    const fix = resolve('tests/fixtures/rrd-cli');
    const probe = readFileSync(join(fix, 'probe.rrd'));
    const edge = readFileSync(join(fix, 'edge.rrd'));
    put(root, 'rec/probe.rrd', probe);
    // no receipts read (no chain given): not checked
    expect(listMeshes({ root, env }).recordings[0].origin).toEqual({ state: 'not checked', words: 'which run wrote it is not checked here: no receipts were read' });
    // receipts read, none naming it: not recorded
    expect(listMeshes({ root, env, chain: [] }).recordings[0].origin).toEqual({ state: 'not recorded', words: 'not recorded: no receipt of this project names this file' });
    // FAKE receipts on the per-test chain: another project's naming the same path, then this project's job that wrote these bytes
    appendReceipt('runs', { kind: 'run', subject: 'FAKE: another project', policy: 'human-gated', status: 'ok', project: 'FAKE-other', project_id: 'f'.repeat(16), outputs: [{ path: 'rec/probe.rrd', sha256: sha(probe), bytes: probe.length }] } as Parameters<typeof appendReceipt>[1]);
    const sealed = appendReceipt('runs', {
      kind: 'run', subject: 'FAKE: python mk-probe.py', policy: 'human-gated', status: 'ok', project: folderProject(root).name, project_id: projectId(root),
      job: { id: 'jFAKE01', kind: 'shell', label: 'FAKE mk-probe.py', state: 'done' }, outputs: [{ path: 'rec/probe.rrd', sha256: sha(probe), bytes: probe.length }],
    } as Parameters<typeof appendReceipt>[1]);
    const short = sealed.hash.replace(/^sha256[:_]/, '').slice(0, 8);
    const row = listMeshes({ root, env, chain: readChain('runs') }).recordings[0];
    expect(row.origin).toEqual({ state: 'recorded', receipt: short, run: 'job jFAKE01', kind: 'run', bytes: 'as sealed', words: `written by job jFAKE01 (FAKE mk-probe.py) · receipt ${short} sealed these bytes` });
    // the file changed since: the run is still named, and that these are not the bytes it sealed
    put(root, 'rec/probe.rrd', edge);
    const changed = listMeshes({ root, env, chain: readChain('runs') }).recordings[0];
    expect(changed.origin).toEqual({
      state: 'recorded', receipt: short, run: 'job jFAKE01', kind: 'run', bytes: 'changed since',
      words: `job jFAKE01 (FAKE mk-probe.py) wrote rec/probe.rrd (receipt ${short}), but not these bytes: it sealed sha256 ${sha(probe).slice(0, 12)}, and they are ${sha(edge).slice(0, 12)} now`,
    });
  });
});
