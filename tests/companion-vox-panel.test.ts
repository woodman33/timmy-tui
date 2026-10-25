/**
 * R6 (H143): the VoxVision panel's routes (src/companion/panels/vox.ts; src/vox/preview.ts makes what they answer), through
 * the real companion server on 127.0.0.1 and its token: the project's records newest first; one record's preview (its
 * images, what was measured over them, its entity tree, frames, pipeline, engines, mesh views, recording, receipt, verdict
 * and commands); and the file route, which serves only an image the record names and refuses everything else, with why, and
 * reads it through one descriptor (src/vox/read-plain.ts): a file swapped between its checks and its read is refused.
 *
 * FAKE, labelled: Look (tests/helpers/vox-fakes.ts, a test double, not OpenCV; its records say "fake" and the preview says
 * FAKE), and the records tests/helpers/vox-panel-kit.ts writes (a video's frames, a record naming a link or a file that is
 * not an image), each saying FAKE. Real: the server and its token check, the REPL's record writer (src/repl/vox.ts) for
 * /detect and /measure, Timmy's STL reader, the receipts on the per-test chain and their verification (verifyReceiptIn),
 * the Rerun recording in the repository (studio/ctx-c3w8/…/context.rrd, read, never changed).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';
import { PATH_DATA } from '../src/vox/projection.js';
import { NO_VERDICT, voxFile, type VoxFileAnswer, type VoxList, type VoxPreview } from '../src/vox/preview.js';
import { act, chainNow, cubeStl, fakeImageRecord, fakeVideoRecord, png, put, sha, SMALL, tempKit, writeFile } from './helpers/vox-panel-kit.js';

const TOKEN = 'a1'.repeat(32);
const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');

describe('the VoxVision panel\'s routes (R6 H143)', () => {
  const kit = tempKit();
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r6-vox-panel-'));
    process.env.TIMMY_HOME = join(box, 'home');
    delete process.env.TIMMY_REPO;
    mkdirSync(join(box, 'home', 'projects'), { recursive: true });
    companion = await startCompanionServer(0, { token: TOKEN, workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
  }, 60_000);
  afterEach(async () => { await kit.cleanup(); });
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  let n = 0;
  /** A project under the Timmy home (the companion finds it by its id), with the FAKE images a test needs. */
  const project = (): { root: string; id: string } => {
    const root = join(process.env.TIMMY_HOME!, 'projects', `FAKE-project-${++n}`);
    mkdirSync(root, { recursive: true });
    put(root, 'refs/photo.png', SMALL);
    return { root, id: projectId(root) };
  };
  const get = (path: string, token: string | null = TOKEN): Promise<Response> => fetch(new URL(path, companion.address), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const json = async <T>(path: string): Promise<T> => { const r = await get(path); expect(r.status, path).toBe(200); return await r.json() as T; };
  const listOf = (p: { id: string }) => json<VoxList & { ok: true }>(`/api/panel/voxvision/records?project=${p.id}`);
  const previewOf = async (p: { id: string }, id: string): Promise<VoxPreview> => (await json<{ ok: true; preview: VoxPreview }>(`/api/panel/voxvision/record?id=${id}&project=${p.id}`)).preview;
  const fileOf = (p: { id: string }, id: string, path: string, token: string | null = TOKEN) => get(`/api/panel/voxvision/file?id=${id}&path=${encodeURIComponent(path)}&project=${p.id}`, token);

  it('lists the project\'s records newest first, each with its check, its receipt verified now, its counts and FAKE said', async () => {
    const p = project();
    const detect = await act(kit, p.root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    put(p.root, 'refs/cube.stl', cubeStl(10));
    const measure = await act(kit, p.root, (ws) => ws.measure('refs/cube.stl'));
    const list = await listOf(p);
    expect(list.schema).toBe('timmy.vox-list/1');
    expect(list.records.map((r) => r.id)).toEqual([measure, detect]);
    const [m, d] = list.records;
    expect(d).toMatchObject({ action: 'detect', status: 'ok', command: '/detect refs/photo.png color 200,10,10', inputs: [{ path: 'refs/photo.png', kind: 'image' }], check: { status: 'verified' }, fake: true });
    expect(d.receipt.verified).toBe(true);
    expect(d.receipt.words).toMatch(/^sealed and verified: receipt [0-9a-f]{8} sealed exactly this record's bytes, and its chain link, body and signature verify$/);
    expect(d.counts).toEqual({ values: 3, images: 2, overlays: 3, frames: 0 });
    expect(m).toMatchObject({ action: 'measure', status: 'ok', fake: false, check: { status: 'verified' }, receipt: { verified: true } });
    // a request without the token reads nothing
    const r = await get(`/api/panel/voxvision/records?project=${p.id}`, null);
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('Refused: this needs the browser companion\'s token');
    // a project the companion does not know
    const u = await get('/api/panel/voxvision/records?project=0123456789abcdef');
    expect(u.status).toBe(404);
  });

  it('a record\'s preview: the observed image, what was measured over it with provenance and evidence, the tree, the pipeline, the engines, the receipt, the verdict and one primary command', async () => {
    const p = project();
    const id = await act(kit, p.root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    const v = await previewOf(p, id);
    expect(v).toMatchObject({ schema: 'timmy.vox-preview/1', id, action: 'detect', status: 'ok', check: { status: 'verified', reasons: [] }, receipt: { verified: true } });
    expect(v.fake.is).toBe(true);
    expect(v.fake.words).toBe('FAKE: made by a test double (timmy-look fake), not by the real tool');
    // the images: the observed file (its bytes the record's), then the annotated copy the record sealed
    expect(v.images.map((x) => [x.key, x.path, x.role, x.servable, x.matches, x.frame])).toEqual([
      ['input:a', 'refs/photo.png', 'input', true, true, [4, 2]],
      [`highlight:results/vox/${id}/annotated.png`, `results/vox/${id}/annotated.png`, 'highlight', true, true, [4, 2]],
    ]);
    // drawn over it: the QR code's corners as the record holds them, the colour region's box and centroid
    expect(v.overlays.map((o) => [o.entity, o.image, o.shape, o.points, o.label, o.provenance, o.evidence, o.word])).toEqual([
      ['qr-1', 'input:a', 'polygon', [0, 0, 3, 0, 3, 1, 0, 1], 'QR 1 "hello vox"', 'measured', 'constructed', 'measured'],
      ['color-region', 'input:a', 'box', [1, 0, 3, 1], 'colour region rgb(200, 10, 10)', 'measured', 'constructed', 'measured'],
      ['color-region', 'input:a', 'point', [1.5, 0.5], 'centroid', 'measured', 'constructed', 'measured'],
    ]);
    // the entity tree: the record, its input, what was observed (selecting one highlights its overlays), its images, values and receipt
    const root = v.entities[0];
    expect(root).toMatchObject({ id: 'record', path: `/${id}`, label: `${id} · detect · ok`, kind: 'record' });
    const kids = Object.fromEntries((root.children ?? []).map((k) => [k.id, k]));
    expect(Object.keys(kids)).toEqual(['inputs', 'observations', 'images', 'values', 'receipt']);
    expect(kids.inputs.children?.[0]).toMatchObject({ path: '/inputs/1', label: 'refs/photo.png', kind: 'input', image: 'input:a', detail: 'image · 4 × 2 px · its bytes the recorded ones' });
    expect(kids.observations.children?.map((e) => [e.id, e.path, e.label, e.overlays, e.provenance, e.evidence])).toEqual([
      ['qr-1', '/observations/qr/1', 'QR 1 "hello vox"', ['qr-1#1'], 'measured', 'constructed'],
      ['color-region', '/observations/color_region', 'colour region rgb(200, 10, 10)', ['color-region#1', 'color-region#2'], 'measured', 'constructed'],
    ]);
    expect(kids.observations.children?.[1].detail).toBe('2 px (0.25 of the image) · box 1, 0, 3, 1 px · centroid 1.5, 0.5 px · provenance measured · evidence constructed');
    expect(kids.receipt.label).toBe(`✓ receipt ${v.receipt.short}`);
    // the pipeline as the record ran: .intent, Look as a job, the receipt sealed and verified; what this computer has not
    expect(v.pipeline.steps.map((s) => [s.name, s.state, s.tone])).toEqual([
      ['.intent', 'asked', 'intent'], ['Look (OpenCV)', expect.stringMatching(/^job j[0-9a-f]{6} completed$/), 'ran'], ['.receipt', 'sealed and verified', 'verified'],
    ]);
    expect(v.pipeline.steps[0].words).toBe('/detect refs/photo.png color 200,10,10');
    const absent = Object.fromEntries(v.pipeline.absent.map((e) => [e.name, e.state]));
    expect(absent).toEqual({ 'Roboflow (hosted model)': 'needs setup', 'SAM 3': 'not installed', 'Depth Anything 3': 'not installed', 'Voxel grid from masks': 'not in Timmy', Viser: 'not used by VoxVision', FiftyOne: 'not used by VoxVision' });
    // the engines as the companion's own environment has them (the test gave it no Python): not as the record's job had them
    expect(v.engines.find((e) => e.name === 'Look (OpenCV)')).toMatchObject({ state: 'needs setup', tone: 'setup', setup: 'python3 -m pip install opencv-python-headless numpy, or set TIMMY_VISION_PYTHON to the absolute path of a Python that has OpenCV' });
    expect(v.engines.find((e) => e.name === "Timmy's STL reader")).toMatchObject({ state: 'built in', tone: 'here' });
    expect(v.engines.find((e) => e.name === "Rerun's viewer (/vox view)")).toMatchObject({ state: 'needs setup', tone: 'setup', setup: "cargo install rerun-cli --locked, or Rerun's release from its site" });
    expect(v.verdict).toBe(NO_VERDICT);
    // the commands: copied for the terminal with their effect; Rerun is not found here, so Measure is the one primary
    expect(v.actions.map((a) => [a.label, a.command, a.primary, a.enabled])).toEqual([
      ['Open in Rerun', `/vox view ${id}`, false, false], ['Measure it', '/measure refs/photo.png', true, true], ['Observe it', '/observe refs/photo.png', false, true],
      ['Do it again', '/detect refs/photo.png color 200,10,10', false, true], ['Open the record', `/open results/vox/${id}.json`, false, true],
    ]);
    expect(v.actions[0].why).toBe("Rerun's viewer needs setup here: cargo install rerun-cli --locked, or Rerun's release from its site");
    expect(v.values.map((x) => [x.name, x.word, x.provenance, x.evidence])).toEqual([
      ['qr_codes_decoded', 'measured', 'measured', 'constructed'], ['aruco_markers', 'measured', 'measured', 'constructed'], ['color_region', 'measured', 'measured', 'constructed'],
    ]);

    // changed after it was sealed: not verified, and nothing it says is drawn as constructed
    const file = join(p.root, 'results', 'vox', `${id}.json`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"status": "ok"', '"status": "ok" '));
    const t = await previewOf(p, id);
    expect(t.check.status).toBe('unverified');
    expect(t.receipt.verified).toBe(false);
    expect(t.receipt.words).toMatch(/^receipt [0-9a-f]{8} verifies, but the record is not the file its receipt [0-9a-f]{8} sealed: it was changed after it was written$/);
    expect(new Set(t.overlays.map((o) => o.evidence))).toEqual(new Set(['unverified']));
    expect(t.images.find((x) => x.role === 'highlight')).toMatchObject({ servable: false, why: 'the record is not verified' });
    expect(t.pipeline.steps.at(-1)).toMatchObject({ name: '.receipt', state: 'sealed, not verified', tone: 'sealed' });
  });

  it('a video\'s sampled frames are its timeline, each frame with the box and centroid measured at its time', async () => {
    const p = project();
    const { id } = fakeVideoRecord(p.root);
    const v = await previewOf(p, id);
    expect(v.fake.is).toBe(true);
    expect(v.frames.map((f) => [f.index, f.frame, f.time, f.label, f.overlays.length])).toEqual([
      [0, 5, 0.5, '0.5 s · frame 5', 2], [1, 10, 1, '1 s · frame 10', 2], [2, 15, 1.5, '1.5 s · frame 15', 2],
    ]);
    const second = v.images.find((x) => x.key === v.frames[1].image)!;
    expect(second).toMatchObject({ role: 'frame', path: `results/vox/${id}/frames/frame-000010.png`, frame: [160, 120], unit: 'video px', servable: true });
    expect(v.overlays.filter((o) => o.image === second.key).map((o) => [o.shape, o.points, o.label, o.evidence, o.word])).toEqual([
      ['box', [64, 40, 96, 72], 'colour region at 1 s', 'inferred', 'estimated'], ['point', [80, 56], 'centroid', 'inferred', 'estimated'],
    ]);
    expect(v.pipeline.steps[1]).toMatchObject({ name: 'video (timmy-video-readback)', state: 'job j0fa4e1 completed' });
  });

  it('an STL is drawn as three views from its own triangles; a recording is read for what Timmy knows of it; neither through a link', async () => {
    const p = project();
    put(p.root, 'refs/cube.stl', cubeStl(10));
    const id = await act(kit, p.root, (ws) => ws.measure('refs/cube.stl'));
    const v = await previewOf(p, id);
    expect(v.spatial).toHaveLength(1);
    const s = v.spatial[0];
    expect(s).toMatchObject({ source: 'refs/cube.stl', provenance: 'not recorded', evidence: 'declared', unit: "the file's units (an STL declares none)", triangles: 12, box: [10, 10, 10] });
    expect(s.views?.map((x) => [x.name, x.axes, x.size, x.drawn])).toEqual([['front', ['x', 'z'], [1000, 1000], 4], ['top', ['x', 'y'], [1000, 1000], 4], ['side', ['y', 'z'], [1000, 1000], 4]]);
    for (const x of s.views ?? []) expect(x.d).toMatch(PATH_DATA);
    expect(s.words).toBe('12 triangles · box 10 × 10 × 10 · 12 feature edges; a drawing of the file, measuring nothing');
    expect(v.doctrine).toBe('Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.');
    expect(v.entities[0].children?.find((k) => k.id === 'observations')?.detail).toBe('a mesh, not an image: its three views are under meshes');

    // a Rerun recording the record names (the repository's, copied in): its header and messages as Timmy reads them
    const q = project();
    copyFileSync(RRD, join(q.root, 'refs', 'context.rrd'));
    const rid = await act(kit, q.root, (ws) => ws.inspect('refs/context.rrd'));
    const r = await previewOf(q, rid);
    expect(r.recordings).toHaveLength(1);
    expect(r.recordings[0].facts).toMatchObject({
      format: 'rrd', writer: 'Rerun 0.37.2', compression: 'LZ4', serializer: 'Protobuf', messages: { storeInfo: 4, chunks: 13, blueprint: 1, other: 0 }, ended: true, footer: true,
      stores: [{ kind: 'blueprint', application: 'timmy-context-evidence' }, { kind: 'recording', application: 'timmy-context-evidence', recording: 'ctx-389daef66d2290542d313254' }],
    });
    expect(r.recordings[0].facts?.unknown.entities).toBe("inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it");
    expect(r.recordings[0].viewer).toEqual({ state: 'needs setup', words: "Rerun's viewer needs setup: cargo install rerun-cli --locked, or Rerun's release from its site", command: `/vox view ${rid}` });

    // reached through a link (even one to a folder inside the project), a mesh and a recording are not read for the page
    for (const root of [p.root, q.root]) { renameSync(join(root, 'refs'), join(root, 'refs-real')); symlinkSync(join(root, 'refs-real'), join(root, 'refs')); }
    expect((await previewOf(p, id)).spatial[0]).toMatchObject({ source: 'refs/cube.stl', why: 'it is reached through a link', words: 'not drawn' });
    expect((await previewOf(q, rid)).recordings[0]).toMatchObject({ path: 'refs/context.rrd', why: 'it is reached through a link' });
    expect((await previewOf(q, rid)).recordings[0].facts).toBeUndefined();
    expect(sha(readFileSync(RRD))).toBe('8304232f8a69dba530c246f2b47f5de99f9c23312dd8ff0509b1a75c29d3d36f'); // the repository's file, unchanged
  });

  it('the file route serves only an image the record names; a path it does not name, "..", a link, a non-image and no token are refused', async () => {
    const p = project();
    const id = await act(kit, p.root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    const ok = await fileOf(p, id, 'refs/photo.png');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await ok.arrayBuffer()).equals(SMALL)).toBe(true);
    const hl = await fileOf(p, id, `results/vox/${id}/annotated.png`);
    expect(hl.status).toBe(200);

    put(p.root, 'refs/other.png', SMALL);
    const notNamed = await fileOf(p, id, 'refs/other.png');
    expect(notNamed.status).toBe(404);
    expect((await notNamed.json()).error).toBe(`Refused: refs/other.png is not an image record ${id} names, so it is not served.`);
    const dots = await fileOf(p, id, 'refs/../refs/photo.png');
    expect(dots.status).toBe(400);
    expect((await dots.json()).error).toBe('Refused: a file is named by its path inside the project, without "..", "." or a leading "/".');
    expect((await fileOf(p, id, '/etc/hosts')).status).toBe(400);

    // a record naming a link (to an image inside the project, even): refused as a link
    symlinkSync(join(p.root, 'refs', 'photo.png'), join(p.root, 'refs', 'link.png'));
    fakeImageRecord(p.root, 'vfa4e0002', 'refs/link.png', { sha256: sha(SMALL), bytes: SMALL.length });
    const link = await fileOf(p, 'vfa4e0002', 'refs/link.png');
    expect(link.status).toBe(403);
    expect((await link.json()).error).toBe('Refused: refs/link.png is reached through a link, so it is not served.');
    // a record naming a file whose bytes are not an image's
    const text = writeFile(p.root, 'refs/notes.png', 'FAKE: words, not a PNG');
    fakeImageRecord(p.root, 'vfa4e0003', 'refs/notes.png', text);
    const notImage = await fileOf(p, 'vfa4e0003', 'refs/notes.png');
    expect(notImage.status).toBe(415);
    expect((await notImage.json()).error).toBe("Refused: refs/notes.png is not an image of a type served here (PNG, JPEG, GIF, WebP, or Timmy's own SVG drawing), by its bytes and its name.");
    // no token: nothing is read
    const noToken = await fileOf(p, id, 'refs/photo.png', null);
    expect(noToken.status).toBe(401);
    // an unknown record, and a record id that is not one
    expect((await fileOf(p, 'v00000000', 'refs/photo.png')).status).toBe(404);
    const bad = await get(`/api/panel/voxvision/record?id=..%2Fx&project=${p.id}`);
    expect(bad.status).toBe(400);
  });

  // the lead's review of dcce794: what is checked must be what is read (the operator's R5 22:32 rule: running as the same OS
  // user does not by itself make a project-scoped read safe). Each swap runs in the gap between voxFile's checks and its
  // read (the beforeOpen hook), where a file checked by name and then read by name would be read through the swap.
  it('a file swapped between the checks and the read is refused: for a link, for another file, for a FIFO, or its folder for a link', async () => {
    const p = project();
    const id = await act(kit, p.root, (ws) => ws.detect('refs/photo.png color 200,10,10'));
    const input = { root: p.root, chain: chainNow(), env: {} };
    const photo = join(p.root, 'refs', 'photo.png');
    // outside the project: a PNG of other bytes, what a swap would have served
    const outside = join(box, `outside-${n}`);
    const OTHER = png(6, 3, () => [1, 2, 3]);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'photo.png'), OTHER);
    const served = (a: VoxFileAnswer): Buffer | null => (a.ok ? a.body : null);

    // nothing swapped: served, its own bytes
    expect(served(voxFile(input, id, 'refs/photo.png', { beforeOpen: () => undefined }))?.equals(SMALL)).toBe(true);
    const notChecked = 'Refused: refs/photo.png changed while it was read (it is not the file that was checked), so it is not served.';

    // 1. the file swapped for a link to the outside file: the open does not follow it
    const a = voxFile(input, id, 'refs/photo.png', { beforeOpen: () => { rmSync(photo); symlinkSync(join(outside, 'photo.png'), photo); } });
    expect(a).toEqual({ ok: false, status: 403, error: 'Refused: refs/photo.png changed while it was read (it is a link now), so it is not served.' });
    rmSync(photo);
    writeFileSync(photo, SMALL);
    // 2. its folder swapped for a link to an outside folder holding a photo.png: opened, but not the file checked
    const b = voxFile(input, id, 'refs/photo.png', { beforeOpen: () => { renameSync(join(p.root, 'refs'), join(p.root, 'refs-kept')); symlinkSync(outside, join(p.root, 'refs')); } });
    expect(b).toEqual({ ok: false, status: 403, error: notChecked });
    rmSync(join(p.root, 'refs'));
    renameSync(join(p.root, 'refs-kept'), join(p.root, 'refs'));
    // 3. another file renamed over it
    const c = voxFile(input, id, 'refs/photo.png', { beforeOpen: () => { writeFileSync(join(p.root, 'refs', 'next.png'), OTHER); renameSync(join(p.root, 'refs', 'next.png'), photo); } });
    expect(c).toEqual({ ok: false, status: 403, error: notChecked });
    // 4. a FIFO in its place: the open does not wait for a writer (O_NONBLOCK), and a FIFO is not the file checked
    writeFileSync(photo, SMALL);
    const d = voxFile(input, id, 'refs/photo.png', { beforeOpen: () => { rmSync(photo); execFileSync('mkfifo', [photo]); } });
    expect(d).toEqual({ ok: false, status: 403, error: notChecked });
    rmSync(photo);

    // the outside bytes were never served; with the file back, it is served again
    for (const x of [a, b, c, d]) expect(served(x)).toBeNull();
    writeFileSync(photo, SMALL);
    expect(served(voxFile(input, id, 'refs/photo.png'))?.equals(SMALL)).toBe(true);
    expect(readFileSync(join(outside, 'photo.png')).equals(OTHER)).toBe(true);
  });
});
