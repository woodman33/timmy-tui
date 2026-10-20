/**
 * R7 (H153): the 3D & Motion panel's routes (tab 6; src/companion/panels/create.ts over src/vox/meshes.ts), through the real
 * companion server on 127.0.0.1 and its token: the shown project's meshes, each measured by Timmy's own STL reader from the
 * whole file (equal to readStlFile's reading), and its recordings; one mesh's triangles for the view (the file's own float32
 * corners, every one up to the cap, its counts and sha256 said); and the refusals: no token, a project the companion does not
 * know, a path outside the project, another project's mesh, a file that is not a listed mesh, bytes changed since the list.
 *
 * R8 (H154): OBJ and PLY files beside STL, each with its kind and reader id, measured by its own reader, and drawn from the
 * triangles that reader reads.
 *
 * FAKE, labelled: the projects and their meshes (written by the test; the OBJ and PLY cubes by tests/helpers/mesh-fakes.ts). Real: the server, its token check, Timmy's STL reader,
 * the Rerun header reader over the repository's own recording (studio/ctx-c3w8/…/context.rrd, read, never changed).
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { parseObj, readObjFile } from '../src/native/obj-readback.js';
import { readPlyFile } from '../src/native/ply-readback.js';
import { readStlFile } from '../src/native/stl-readback.js';
import { projectId } from '../src/project/index.js';
import { VIEW_MAX_TRIANGLES, type MeshList } from '../src/vox/meshes.js';
import { forgetRrdReadings, readRrdWithCli, rrdReadingsIdle } from '../src/vox/rrd-cli.js';
import { cubeObj, cubePly } from './helpers/mesh-fakes.js';
import { cubeStl, sha } from './helpers/vox-fakes.js';

const TOKEN = 'b2'.repeat(32);
const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');

describe('the 3D & Motion panel\'s routes (R7 H153)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r7-create-panel-'));
    process.env.TIMMY_HOME = join(box, 'home');
    delete process.env.TIMMY_REPO;
    mkdirSync(join(box, 'home', 'projects'), { recursive: true });
    companion = await startCompanionServer(0, { token: TOKEN, workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
  }, 60_000);
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const project = (name: string): { root: string; id: string } => {
    const root = join(process.env.TIMMY_HOME!, 'projects', name);
    mkdirSync(root, { recursive: true });
    return { root, id: projectId(root) };
  };
  const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
  const get = (path: string, token: string | null = TOKEN): Promise<Response> => fetch(new URL(path, companion.address), { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('lists the shown project\'s meshes measured from the whole file, and its recordings; another project\'s are not in it', async () => {
    const a = project('FAKE-create-a');
    const b = project('FAKE-create-b');
    put(a.root, 'refs/cube.stl', cubeStl(10));
    put(a.root, 'refs/cube.obj', cubeObj(10));
    put(a.root, 'refs/cube.ply', cubePly(10));
    mkdirSync(join(a.root, 'rec'), { recursive: true });
    copyFileSync(RRD, join(a.root, 'rec', 'context.rrd'));
    put(b.root, 'refs/other.stl', cubeStl(3));

    const r = await get(`/api/panel/create/meshes?project=${a.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const list = await r.json() as MeshList & { ok: true; project: { id: string; name: string } };
    expect(list.ok).toBe(true);
    expect(list.schema).toBe('timmy.meshes/1');
    expect(list.project).toEqual({ id: a.id, name: 'FAKE-create-a' });
    expect(list.meshes.map((m) => [m.path, m.kind, m.reader.id])).toEqual([['refs/cube.obj', 'obj', 'timmy-obj-readback/1'], ['refs/cube.ply', 'ply', 'timmy-ply-readback/1'], ['refs/cube.stl', 'stl', 'timmy-stl-readback/1']]);
    const [obj, ply, stl] = list.meshes;
    const direct = readStlFile(join(a.root, 'refs', 'cube.stl'), 'refs/cube.stl');
    expect(direct.ok && stl.readback).toEqual(direct.ok ? direct.readback : null);
    const directObj = readObjFile(join(a.root, 'refs', 'cube.obj'), 'refs/cube.obj');
    expect(directObj.ok && obj.readback).toEqual(directObj.ok ? directObj.readback : null);
    const directPly = readPlyFile(join(a.root, 'refs', 'cube.ply'), 'refs/cube.ply');
    expect(directPly.ok && ply.readback).toEqual(directPly.ok ? directPly.readback : null);
    for (const m of list.meshes) expect([m.path, m.view, m.volume]).toEqual([m.path, { shown: 12, total: 12, words: 'all 12 triangles' }, '1000 (enclosed; normals outward)']);
    expect(list.reader).toBe("Timmy's own STL reader (timmy-stl-readback/1), OBJ reader (timmy-obj-readback/1) and PLY reader (timmy-ply-readback/1), each from the whole file: a deterministic computation on its bytes, in the file's own units");
    expect(list.cap).toBe(VIEW_MAX_TRIANGLES);
    expect(list.recordings.map((x) => [x.path, x.facts?.format])).toEqual([['rec/context.rrd', 'rrd']]);
    expect(list.viewer.state).toBe('needs setup');
    // the strings carry no folder of this computer
    expect(JSON.stringify(list)).not.toContain(box);

    const other = await (await get(`/api/panel/create/meshes?project=${b.id}`)).json() as MeshList;
    expect(other.meshes.map((m) => m.path)).toEqual(['refs/other.stl']);
  });

  it('serves one listed mesh\'s triangles as the file\'s own float32 corners, with its counts and sha256', async () => {
    const a = project('FAKE-create-c');
    put(a.root, 'refs/cube.stl', cubeStl(10));
    const r = await get(`/api/panel/create/mesh?path=${encodeURIComponent('refs/cube.stl')}&sha=${sha(cubeStl(10))}&project=${a.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-timmy-triangles')).toBe('12/12');
    expect(r.headers.get('x-timmy-sha256')).toBe(sha(cubeStl(10)));
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBe(12 * 36);
    const file = cubeStl(10);
    for (let t = 0; t < 12; t += 1) for (let j = 0; j < 9; j += 1) expect(body.readFloatLE(t * 36 + j * 4)).toBe(file.readFloatLE(84 + t * 50 + 12 + j * 4));

    // R8 (H154): an OBJ's triangles, as Timmy's own OBJ reader reads them (its quads split as fans)
    put(a.root, 'refs/cube.obj', cubeObj(10));
    const o = await get(`/api/panel/create/mesh?path=${encodeURIComponent('refs/cube.obj')}&sha=${sha(cubeObj(10))}&project=${a.id}`);
    expect([o.status, o.headers.get('x-timmy-triangles'), o.headers.get('x-timmy-sha256')]).toEqual([200, '12/12', sha(cubeObj(10))]);
    const tris = parseObj(Buffer.from(cubeObj(10)));
    if ('error' in tris) throw new Error(tris.error);
    const ob = Buffer.from(await o.arrayBuffer());
    expect(ob.length).toBe(12 * 36);
    for (let i = 0; i < 12 * 9; i += 1) expect(ob.readFloatLE(i * 4)).toBe(tris.triangles[i]);
  });

  it('refuses: no token, an unknown project, a path outside the project, another project\'s mesh, a file that is not a listed mesh, changed bytes', async () => {
    const a = project('FAKE-create-d');
    const b = project('FAKE-create-e');
    put(a.root, 'refs/cube.stl', cubeStl(10));
    put(a.root, 'notes.txt', 'FAKE: not a mesh');
    put(b.root, 'refs/theirs.stl', cubeStl(3));
    const mesh = (p: string, project: string, extra = '') => get(`/api/panel/create/mesh?path=${encodeURIComponent(p)}${extra}&project=${project}`);
    const said = async (res: Response): Promise<[number, string]> => [res.status, ((await res.json()) as { error: string }).error];

    const no = await get(`/api/panel/create/meshes?project=${a.id}`, null);
    expect(no.status).toBe(401);
    expect(await no.text()).toContain('Refused: this needs the browser companion\'s token');
    expect((await get(`/api/panel/create/mesh?path=refs%2Fcube.stl&project=${a.id}`, null)).status).toBe(401);
    expect((await get('/api/panel/create/meshes?project=0123456789abcdef')).status).toBe(404);
    expect((await get('/api/panel/create/mesh?path=refs%2Fcube.stl&project=0123456789abcdef')).status).toBe(404);
    expect(await said(await get(`/api/panel/create/mesh?project=${a.id}`))).toEqual([400, 'Name one mesh of this project: ?path=<its path in the project>.']);
    expect(await said(await mesh('../FAKE-create-e/refs/theirs.stl', a.id))).toEqual([400, 'Refused: a mesh is named by its path inside the project, without "..", "." or a leading "/".']);
    expect((await mesh(join(b.root, 'refs', 'theirs.stl'), a.id)).status).toBe(400);
    // another project's mesh, named by its path, asked of the project the page shows: not this project's, refused
    expect(await said(await mesh('refs/theirs.stl', a.id))).toEqual([404, 'Refused: refs/theirs.stl is not a mesh of this project (tab 6 lists its STL, OBJ and PLY files and its tessellations), so it is not served.']);
    expect((await mesh('refs/theirs.stl', b.id)).status).toBe(200); // asked of its own project
    expect((await mesh('notes.txt', a.id)).status).toBe(404);
    expect(await said(await mesh('refs/cube.stl', a.id, `&sha=${'0'.repeat(64)}`))).toEqual([409, `Not served: refs/cube.stl changed since the list was read (sha256 ${sha(cubeStl(10)).slice(0, 12)} now): read the list again.`]);
    expect((await mesh('refs/cube.stl', a.id, '&sha=nonsense')).status).toBe(400);
    // nothing of b's folder reached a's answers
    expect(readFileSync(join(b.root, 'refs', 'theirs.stl')).equals(cubeStl(3))).toBe(true);
  });
});

// R9 (H159). FAKE, labelled: `rerun` is tests/fixtures/fake-rerun.mjs (a TEST DOUBLE replaying outputs CAPTURED from the real
// rerun-cli 0.38.1 on tests/fixtures/rrd-cli/probe.rrd), first on the companion's PATH. Real: the server, its token, the route,
// src/vox/rrd-cli.ts and its background reading.
describe('the 3D & Motion panel\'s recordings, read through the Rerun CLI in the background (R9 H159)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let bin = '';
  let companion: CompanionServer;
  const PROBE = readFileSync(resolve('tests/fixtures/rrd-cli/probe.rrd'));

  beforeAll(async () => {
    forgetRrdReadings();
    box = mkdtempSync(join(tmpdir(), 'r9-create-rrd-'));
    bin = join(box, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'rerun'), `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-rerun.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'rerun'), 0o755);
    process.env.TIMMY_HOME = join(box, 'home');
    delete process.env.TIMMY_REPO;
    mkdirSync(join(box, 'home', 'projects'), { recursive: true });
    companion = await startCompanionServer(0, { token: TOKEN, workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings'), PATH: `${bin}:/usr/bin:/bin` }, shareMs: 0 } });
  }, 60_000);
  afterAll(async () => {
    await companion?.shutdown();
    await rrdReadingsIdle();
    forgetRrdReadings();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });
  const get = (path: string): Promise<Response> => fetch(new URL(path, companion.address), { headers: { Authorization: `Bearer ${TOKEN}` } });

  it('the first list says "being read" and starts the reading; a later list holds the entities and ranges, with who read them', async () => {
    const root = join(process.env.TIMMY_HOME!, 'projects', 'FAKE-rrd');
    mkdirSync(join(root, 'rec'), { recursive: true });
    writeFileSync(join(root, 'rec', 'probe.rrd'), PROBE);
    const id = projectId(root);
    const first = await (await get(`/api/panel/create/meshes?project=${id}`)).json() as MeshList;
    expect(first.recordings.map((r) => [r.path, r.cli.state])).toEqual([['rec/probe.rrd', 'being read']]);
    expect(first.recordingsPending).toBe(1);
    expect(first.viewer.state).toBe('found (installed here, not run)');
    let list = first;
    for (const end = Date.now() + 20_000; list.recordings[0].cli.state !== 'read' && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 100));
      list = await (await get(`/api/panel/create/meshes?project=${id}`)).json() as MeshList;
    }
    const direct = await readRrdWithCli(PROBE, { env: { PATH: `${bin}:/usr/bin:/bin` } });
    const row = list.recordings[0];
    expect(row.cli.state).toBe('read');
    expect([row.cli.words, row.cli.verify, row.cli.entities, row.cli.timelines]).toEqual([direct.words, direct.verify, direct.entities, direct.timelines]);
    expect(row.facts?.writer).toBe('Rerun 0.38.1');
    expect(list.recordingsPending).toBe(0);
    // the answer carries no folder of this computer
    expect(JSON.stringify(list)).not.toContain(box);
  });
});
