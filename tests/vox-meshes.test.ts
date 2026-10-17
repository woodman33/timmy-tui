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
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCTRINE_15, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { folderProject, projectId } from '../src/project/index.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { RERUN_SETUP } from '../src/vox/layers.js';
import { listMeshes, MESH_READ_MAX, MESHES_SCHEMA, meshView, VIEW_MAX_TRIANGLES, VIEW_WORDS, viewPick } from '../src/vox/meshes.js';
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
    expect(no(a, 'refs/other.stl')).toEqual([404, 'Refused: refs/other.stl is not a mesh of this project (tab 6 lists its STL files and tessellations), so it is not served.']);
    expect(no(a, 'notes.txt')[0]).toBe(404);
    expect(no(a, 'node_modules/pkg/dep.stl')[0]).toBe(404);
    expect(no(a, 'refs/linked.stl')[0]).toBe(404);
    expect(no(b, 'refs/other.stl')[0]).toBe(200); // the same name, asked of its own project
    expect(no(a, 'refs/cube.stl', { sha: sha(cubeStl(10)) })[0]).toBe(200);
    expect(no(a, 'refs/cube.stl', { sha: 'a'.repeat(64) })).toEqual([409, `Not served: refs/cube.stl changed since the list was read (sha256 ${sha(cubeStl(10)).slice(0, 12)} now): read the list again.`]);
    put(a, 'refs/bad.stl', 'not an STL at all, and long enough to be read as one: '.repeat(4));
    expect(no(a, 'refs/bad.stl')[0]).toBe(422);
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
    expect(list.viewer).toEqual({ name: "Rerun's viewer", state: 'needs setup', words: "Rerun's viewer needs setup here: rerun is not on the PATH and TIMMY_RERUN is not set", setup: RERUN_SETUP });

    // FAKE: a `rerun` that is a shell script; found is not run, and nothing here runs it
    const bin = box();
    const rerun = join(bin, 'rerun');
    writeFileSync(rerun, '#!/bin/sh\necho "FAKE rerun: must never run here" >&2\nexit 9\n');
    chmodSync(rerun, 0o755);
    const found = listMeshes({ root, env: { PATH: bin } }).viewer;
    expect(found).toEqual({ name: "Rerun's viewer", state: 'found (installed here, not run)', words: "Rerun's viewer is found here (rerun on the PATH): found is not run, and this tab runs nothing; `rerun --bind 127.0.0.1 <file>` in a terminal opens a recording in Rerun's own window, listening on this computer only" });
  });
});
