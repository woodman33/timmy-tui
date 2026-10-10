// Timmy VoxVision's viewer layers (round R4, helper H61): `/vox view <record id> [rerun]` opens a record's inputs and
// highlights in Rerun's viewer, started detached; the launch is recorded on the record and sealed as a vox receipt event.
// Rerun here is a FAKE `rerun` on the PATH (tests/helpers/vox-fakes.ts fakeRerun: a labelled test double that logs its
// arguments, its folder and its process group, and opens no window). Without it: needs setup. Viser and FiftyOne are
// /tools rows that need setup. Real records, receipts and files; Timmy's STL reader is real; Look and the STEP readback
// are the FAKE workers of the same helper.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilities, type ProbeDeps } from '../src/capabilities/index.js';
import { capabilityLines } from '../src/capabilities/render.js';
import { needsPerson } from '../src/ops/act.js';
import { projectId } from '../src/project/index.js';
import { readVoxRecord } from '../src/repl/board-vox.js';
import { realOnPath } from '../src/repl/center.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { planView, rerunLoaderFor } from '../src/vox/layers.js';
import { DOCTRINE_15, type VoxRecord } from '../src/vox/record.js';
import { cubeStl, fakeRerun, fakeTools, png, put, settled, sha, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const SYSTEM_PATH = '/usr/bin:/bin';
const chainOf = (sealed: unknown[]): Receipt[] => sealed.map((r, i) => ({ ...(r as object), hash: `sha256:${String(i + 1).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[];
const recordsIn = (root: string): VoxRecord[] => readdirSync(join(root, 'results', 'vox')).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(root, 'results', 'vox', f), 'utf8')) as VoxRecord);
const recordOf = (root: string, test: (r: VoxRecord) => boolean): VoxRecord => recordsIn(root).find(test)!;
const fileSha = (root: string, rel: string): string => sha(readFileSync(join(root, rel)));
/** What the FAKE rerun logged: its process group, its folder and its arguments; null while it has not run. */
async function rerunLog(path: string, ms = 5000): Promise<{ pgid: string; cwd: string; args: string[] } | null> {
  const end = Date.now() + ms;
  while (!existsSync(path) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  return { pgid: lines.find((l) => l.startsWith('pgid '))!.slice(5), cwd: lines.find((l) => l.startsWith('cwd '))!.slice(4), args: lines.filter((l) => l.startsWith('arg ')).map((l) => l.slice(4)) };
}
const myPgid = (): string => spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim();

/** A project with an image, an STL, a second STL and a STEP, each recorded, and a FAKE rerun on the PATH. */
async function viewProject() {
  const root = realpathSync(kit.temp('vox-view-'));
  put(root, 'refs/photo.png', png(4, 2, (x) => (x < 2 ? [200, 10, 10] : [10, 10, 200])));
  put(root, 'models/cube.stl', cubeStl(1));
  put(root, 'models/cube2.stl', cubeStl(2));
  put(root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
  const fake = fakeTools(kit.temp('vox-fake-'));
  const bin = kit.temp('vox-rerun-');
  const rerun = fakeRerun(bin);
  const log = join(kit.temp('vox-rerun-log-'), 'rerun.log');
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${SYSTEM_PATH}`, FAKE_RERUN_LOG: log, TIMMY_VISION_PYTHON: fake.look, FAKE_QR: 'FAKE-QR', TIMMY_CADQUERY_PYTHON: fake.step };
  const w = workspace(root, kit, { env, onPath: (c) => realOnPath(c, env) });
  await w.ws.inspect('refs/photo.png');
  await w.ws.measure('models/cube.stl');
  await w.ws.measure('cad/part.step');
  await w.ws.compare('models/cube.stl models/cube2.stl');
  await settled(w.ws);
  const id = (test: (r: VoxRecord) => boolean): string => recordOf(root, test).id;
  return {
    root, log, rerun, ...w,
    image: id((r) => r.inputs[0].kind === 'image'), stl: id((r) => r.action === 'measure' && r.inputs[0].kind === 'stl'),
    step: id((r) => r.inputs[0].kind === 'step'), pair: id((r) => r.action === 'compare'),
  };
}

describe('/vox view: a record\'s files in Rerun\'s viewer (FAKE rerun on the PATH)', () => {
  it('passes the files its loaders read and says why each other one is not; starts detached; records the view and seals it', async () => {
    const p = await viewProject();
    const rel = `results/vox/${p.stl}.json`;
    const before = JSON.parse(readFileSync(join(p.root, rel), 'utf8')) as VoxRecord;
    const out = text(await p.ws.voxView(`view ${p.stl}`));
    // Said before it starts: a window on the user's computer, apart from Timmy.
    expect(out).toContain("Rerun      opens a window on your computer: Rerun's own viewer, started apart from Timmy (detached), which Timmy does not stop; close its window when done. It shows the files as they are and measures nothing.");
    expect(out).toContain('passed     models/cube.stl (mesh, stl)');
    expect(out).toContain(`not passed results/vox/${p.stl}/bbox.svg: an SVG drawing: Rerun's viewer reads no SVG (the board shows it)`);
    expect(out).toMatch(new RegExp(`started    pid \\d+ · rerun on the PATH · recorded on results/vox/${p.stl}\\.json · receipt r\\d+`));
    expect(out).toContain(`notice     ${DOCTRINE_15}`);
    // What the viewer was given, from its own log: one absolute path, in the project's folder, in a process group of its own.
    const got = (await rerunLog(p.log))!;
    expect(got.args).toEqual([join(p.root, 'models/cube.stl')]);
    expect(got.cwd).toBe(p.root);
    expect(got.pgid).not.toBe(myPgid());
    // The launch on the record, its values unchanged, and the vox receipt event over the record as now written.
    const after = JSON.parse(readFileSync(join(p.root, rel), 'utf8')) as VoxRecord;
    expect(after.metrics).toEqual(before.metrics);
    expect(after.views).toEqual([{
      viewer: 'rerun', at: expect.any(String), program: 'rerun on the PATH', detached: true, pid: expect.any(Number),
      passed: [{ path: 'models/cube.stl', sha256: sha(cubeStl(1)), loader: 'mesh (stl)' }],
      not_passed: [{ path: `results/vox/${p.stl}/bbox.svg`, why: "an SVG drawing: Rerun's viewer reads no SVG (the board shows it)" }],
    }]);
    const rc = p.sealed.at(-1)!;
    expect(rc).toMatchObject({ kind: 'vox', subject: `vox · view · ${p.stl} · rerun · started`, status: 'ok', project_id: projectId(p.root), files: [{ path: 'models/cube.stl', sha256: sha(cubeStl(1)), kind: 'mesh' }] });
    expect(rc.outputs).toEqual([{ path: rel, sha256: fileSha(p.root, rel), bytes: readFileSync(join(p.root, rel)).length }]);
    expect(rc.sources![0]).toMatchObject({ vox: p.stl, event: 'view', viewer: 'rerun', detached: true, passed: ['models/cube.stl'], not_passed: [`results/vox/${p.stl}/bbox.svg`], at: after.views![0].at });
    // The record stays verified (by the receipt that sealed it as written), and its card names the view and its receipt.
    const card = readVoxRecord({ root: p.root, file: rel, text: readFileSync(join(p.root, rel), 'utf8'), fileSha256: fileSha(p.root, rel), chain: chainOf(p.sealed), projectId: projectId(p.root) })!;
    expect(card.check.status).toBe('verified');
    expect(card.views).toEqual([{ at: after.views![0].at, viewer: 'rerun', program: 'rerun on the PATH', passed: ['models/cube.stl'], notPassed: [{ path: `results/vox/${p.stl}/bbox.svg`, why: expect.any(String) }], pid: after.views![0].pid, receipt: String(p.sealed.length).padStart(8, '0') }]);
    expect(JSON.stringify(rc)).not.toContain(p.root);

    // An image record: the image and its annotated copy, both PNGs by their bytes and names.
    rmSync(p.log, { force: true });
    const img = text(await p.ws.voxView(`view ${p.image} rerun`));
    expect(img).toContain(`passed     refs/photo.png (image, png) · results/vox/${p.image}/annotated.png (image, png)`);
    expect(img).not.toContain(DOCTRINE_15);
    expect((await rerunLog(p.log))!.args).toEqual([join(p.root, 'refs/photo.png'), join(p.root, `results/vox/${p.image}/annotated.png`)]);
  });

  it('starts nothing and writes nothing when no file can be passed: a STEP and its drawing, an input changed since, a record not verified', async () => {
    const p = await viewProject();
    const unchanged = (id: string) => { const rel = `results/vox/${id}.json`; const s = fileSha(p.root, rel); return () => expect(fileSha(p.root, rel)).toBe(s); };
    const n = p.sealed.length;
    const stepSame = unchanged(p.step);
    const out = text(await p.ws.voxView(`view ${p.step}`));
    expect(out).toContain(`Nothing of ${p.step} can be opened in Rerun's viewer (it reads images (PNG, JPEG, GIF, WebP), meshes (.stl, .obj, .glb, .gltf), point clouds (.ply), video (.mp4)):`);
    expect(out).toContain("not passed cad/part.step: Rerun's viewer has no STEP loader (a STEP is CAD, not a mesh): /measure reads it with OCP");
    expect(out).toContain('Nothing was started and nothing was written.');
    stepSame();
    // An input changed since: it is not passed (Rerun would show other bytes than were measured); the drawing is SVG.
    put(p.root, 'models/cube.stl', cubeStl(3));
    const stale = text(await p.ws.voxView(`view ${p.stl}`));
    expect(stale).toMatch(/not passed models\/cube\.stl: it changed since the record \(sha256 [0-9a-f]{12} now, [0-9a-f]{12} recorded\): Rerun would show other bytes than the record's/);
    expect(stale).toContain('Nothing was started and nothing was written.');
    // A record edited since its receipt: refused, as nothing vouches for the files it names.
    const rel = `results/vox/${p.image}.json`;
    writeFileSync(join(p.root, rel), readFileSync(join(p.root, rel), 'utf8').replace('"value": 4', '"value": 5'));
    expect(text(await p.ws.voxView(`view ${p.image}`))).toContain(`${p.image} is not verified (the record is not the file its receipt`);
    expect(await rerunLog(p.log, 300)).toBeNull();
    expect(p.sealed).toHaveLength(n);
    // Not a record id, and a record that is not there.
    expect(text(await p.ws.voxView('view nothing'))).toContain('nothing is not a VoxVision record id: v and 8 hex digits');
    expect(text(await p.ws.voxView('view v00000000'))).toContain('No record v00000000 in this project (results/vox/v00000000.json)');
    expect(text(await p.ws.voxView('look'))).toContain('Usage: /vox view <record id> [rerun]');
  });

  it('two STLs are not overlaid: they share no known unit, so the record of their compare shows a alone and says why b is not passed', async () => {
    const p = await viewProject();
    const out = text(await p.ws.voxView(`view ${p.pair}`));
    expect(out).toContain('passed     models/cube.stl (mesh, stl)');
    expect(out).toContain("not passed models/cube2.stl: in one Rerun view with models/cube.stl it would be a 3D overlay, and neither STL declares a unit, so the two STLs share no known unit; their numbers are compared in the files' own units and marked estimated, never given millimetres; /inspect it and view that record to see it alone");
    expect((await rerunLog(p.log))!.args).toEqual([join(p.root, 'models/cube.stl')]);
  });

  it('needs setup without rerun on the PATH or TIMMY_RERUN; TIMMY_RERUN names it; Viser and FiftyOne need setup; /vox lists the layers', async () => {
    const root = kit.temp('vox-view-setup-');
    put(root, 'models/cube.stl', cubeStl(1));
    const env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH };
    const { ws, sealed } = workspace(root, kit, { env, onPath: (c) => realOnPath(c, env) });
    await ws.measure('models/cube.stl');
    const id = recordsIn(root)[0].id;
    const rel = `results/vox/${id}.json`;
    const s = fileSha(root, rel);
    const n = sealed.length;
    const out = text(await ws.voxView(`view ${id}`));
    expect(out).toContain("needs setup Rerun's viewer (/vox view): rerun is not on the PATH and TIMMY_RERUN is not set · cargo install rerun-cli --locked, or Rerun's release from its site");
    expect(out).toContain('Nothing was started and nothing was written.');
    expect([fileSha(root, rel), sealed.length]).toEqual([s, n]);
    expect(text(await ws.voxView(`view ${id} viser`))).toContain('needs setup Viser: VoxVision has no Viser layer yet · pip install viser · it would add an interactive 3D scene');
    expect(text(await ws.voxView(`view ${id} fiftyone`))).toContain('needs setup FiftyOne: VoxVision has no FiftyOne layer yet · pip install fiftyone');
    const layers = text(await ws.voxView(''));
    expect(layers).toContain('VoxVision viewers  advanced and opt-in');
    expect(layers).toContain("Rerun's viewer (/vox view)  needs setup");
    expect(layers).toContain('Viser  needs setup · pip install viser');
    expect(layers).toContain('FiftyOne  needs setup · pip install fiftyone');
    expect(layers).toContain('CAD checked: a value of generated CAD');

    // TIMMY_RERUN: an absolute path to a runnable file names the program; a relative one is refused.
    const log = join(kit.temp('vox-rerun-log-'), 'rerun.log');
    const fake = fakeRerun(kit.temp('vox-rerun-'));
    env.TIMMY_RERUN = 'rerun';
    expect(text(await ws.voxView(`view ${id}`))).toContain('TIMMY_RERUN is set, but not to an absolute path');
    env.TIMMY_RERUN = fake;
    env.FAKE_RERUN_LOG = log;
    expect(text(await ws.voxView(`view ${id}`))).toMatch(/started {4}pid \d+ · set by TIMMY_RERUN · recorded on/);
    expect((await rerunLog(log))!.args).toEqual([join(realpathSync(root), 'models/cube.stl')]);
    // `timmy act` never opens a window for a person who did not ask: /vox view is refused there, with the line to type.
    expect(needsPerson(`/vox view ${id}`)).toBe("/vox view opens Rerun's viewer, a window on your computer");
    expect(needsPerson('/vox')).toBeUndefined();
  });
});

describe('which files Rerun\'s loaders read', () => {
  const PNG = png(1, 1, () => [0, 0, 0]);
  it('by the name and the bytes together: Rerun picks its loader by the name', () => {
    expect(rerunLoaderFor('a.png', PNG)).toEqual({ loader: 'image', format: 'png' });
    expect(rerunLoaderFor('a.jpg', PNG)).toEqual({ why: "its name says .jpg but its bytes are a PNG: Rerun picks a loader by the name, so it is not passed" });
    expect(rerunLoaderFor('a.stl', cubeStl(1))).toEqual({ loader: 'mesh', format: 'stl' });
    expect(rerunLoaderFor('a.stl', PNG)).toMatchObject({ why: expect.stringContaining('its bytes are a PNG') });
    expect(rerunLoaderFor('a.ply', Buffer.from('ply\nformat ascii 1.0\n'))).toEqual({ loader: 'point cloud', format: 'ply' });
    expect(rerunLoaderFor('a.glb', Buffer.from('glTF\x02\x00\x00\x00', 'latin1'))).toEqual({ loader: 'mesh', format: 'glb' });
    expect(rerunLoaderFor('a.gltf', Buffer.from('  {"asset":{}}'))).toEqual({ loader: 'mesh', format: 'gltf' });
    expect(rerunLoaderFor('clip.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1')]))).toEqual({ loader: 'video', format: 'mp4' });
    expect(rerunLoaderFor('clip.mov', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypqt  ', 'latin1')]))).toEqual({ why: "a QuickTime movie by its bytes: Rerun's video loader reads MP4 only" });
    expect(rerunLoaderFor('a.blend', Buffer.from('BLENDER-v402'))).toMatchObject({ why: expect.stringContaining('no .blend loader') });
    expect(rerunLoaderFor('notes.txt', Buffer.from('hi'))).toEqual({ why: "Rerun's viewer has no loader for .txt files" });
  });

  it('a plan passes only bytes the record names, and one 3D file unless two share a known frame and unit', () => {
    const plan = planView([
      { path: 'a.png', sha256: 'x', now: 'x', head: PNG },
      { path: 'b.png', sha256: 'x', now: 'y', head: PNG },
      { path: 'c.png', sha256: 'x', now: null, head: Buffer.alloc(0) },
      { path: 'h.png', sha256: 'x', now: 'x', head: PNG, highlight: { shown: false, why: 'its file is not the bytes the record and its receipt name' } },
    ]);
    expect(plan.pass.map((p) => p.path)).toEqual(['a.png']);
    expect(plan.refused).toEqual([
      { path: 'b.png', why: "it changed since the record (sha256 y now, x recorded): Rerun would show other bytes than the record's" },
      { path: 'c.png', why: 'it is gone since the record' },
      { path: 'h.png', why: 'a highlight not shown on the board: its file is not the bytes the record and its receipt name' },
    ]);
  });
});

describe('/tools: VoxVision\'s rows', () => {
  const none: ProbeDeps = {
    env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
    ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
    lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
  };
  it('lists its readers and its viewer layers: Rerun found or needs setup, Viser and FiftyOne needing setup with their steps', async () => {
    const rows = await capabilities({ ...none, voxRoot: () => kit.temp('vox-tools-') });
    const vox = rows.filter((r) => r.kind === 'vox');
    expect(vox.map((r) => r.id)).toEqual(['vox:stl', 'vox:spatial', 'vox:look', 'vox:step', 'vox:blend', 'vox:video', 'vox:geo', 'vox:roboflow', 'vox:rerun', 'vox:viser', 'vox:fiftyone']);
    const by = Object.fromEntries(vox.map((r) => [r.id, r]));
    expect(by['vox:stl']).toMatchObject({ rung: 'installed', detail: expect.stringMatching(/^built in: /) });
    expect(by['vox:rerun']).toMatchObject({ name: 'Rerun viewer (/vox view)', rung: 'needs setup', detail: 'rerun is not on the PATH and TIMMY_RERUN is not set', setup: "cargo install rerun-cli --locked, or Rerun's release from its site" });
    expect(by['vox:viser']).toMatchObject({ rung: 'needs setup', setup: 'pip install viser', detail: expect.stringContaining('it would add an interactive 3D scene in a browser tab') });
    expect(by['vox:fiftyone']).toMatchObject({ rung: 'needs setup', setup: 'pip install fiftyone', detail: expect.stringContaining('it would add a browsable dataset') });
    const found = await capabilities({ ...none, env: { TIMMY_RERUN: fakeRerun(kit.temp('vox-rerun-')) }, voxRoot: () => kit.temp('vox-tools-') });
    expect(found.find((r) => r.id === 'vox:rerun')).toMatchObject({ rung: 'installed', detail: expect.stringMatching(/^set by TIMMY_RERUN; found is not run/) });
    const onPath = await capabilities({ ...none, onPath: (b) => b === 'rerun', voxRoot: () => kit.temp('vox-tools-') });
    expect(onPath.find((r) => r.id === 'vox:rerun')).toMatchObject({ rung: 'installed', detail: expect.stringMatching(/^rerun on the PATH/) });
    const lines = capabilityLines(rows, glyphSet(true), 80).map((l) => l.map((s) => s.text).join(''));
    expect(lines).toContain('  VOXVISION (/inspect, /measure, /detect, /compare, /vox view)');
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80);
    expect(lines.some((l) => l.includes("do: cargo install rerun-cli --locked, or Rerun's release from its site"))).toBe(true);
    expect(lines.some((l) => l.includes('do: pip install viser'))).toBe(true);
    expect(lines.some((l) => l.includes('do: pip install fiftyone'))).toBe(true);
  });
});
