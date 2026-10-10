// Timmy VoxVision (round R4, helper H49): /inspect, /measure, /detect and /compare through the REPL's Workspace, each
// leaving results/vox/<id>.json (timmy.vox/1) and one `vox` receipt over the record and its highlights.
// The tools are FAKE (tests/helpers/vox-fakes.ts): labelled test doubles of Look --vox, the STEP, .blend and video
// readbacks, the geo lane and the Roboflow bridge. They are not OpenCV, OCP, Blender, ffmpeg, numpy or Roboflow; real
// OpenCV runs in tests/vox-look-real.test.ts. Timmy's STL reader is real here (it is TypeScript, in process).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCTRINE_15, type VoxRecord } from '../src/vox/record.js';
import { SETUP } from '../src/vox/tools.js';
import { resetLookChecks } from '../src/vision/look.js';
import { cubeStl, fakeTools, png, put, settled, sha, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const IMG = png(4, 2, (x) => (x < 2 ? [200, 10, 10] : [10, 10, 200]));
const IMG2 = png(4, 2, (x) => (x < 3 ? [200, 10, 10] : [10, 10, 200]));

/** Every record the project holds now, read back. */
function records(root: string): VoxRecord[] {
  const dir = join(root, 'results', 'vox');
  return readdirSync(dir).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as VoxRecord);
}
/** The one record the project holds now (or the one with this id), read back. */
function recordOf(root: string, id?: string): VoxRecord {
  const list = records(root).filter((r) => !id || r.id === id);
  expect(list).toHaveLength(1);
  return list[0];
}
const fileSha = (root: string, rel: string): string => sha(readFileSync(join(root, rel)));

function project(): string {
  const root = kit.temp('vox-actions-');
  put(root, 'refs/photo.png', IMG);
  put(root, 'refs/photo2.png', IMG2);
  return root;
}

describe('each action leaves a record and a vox receipt', () => {
  it('/inspect an image: its kind by its bytes, Look\'s facts as labelled metrics, the annotated copy with its sha256, the raw output kept', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, notes, sealed } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, FAKE_QR: 'hello vox' } });
    const started = text(await ws.inspect('refs/photo.png'));
    expect(started).toMatch(/VoxVision {2}v[0-9a-f]{8} {2}inspect refs\/photo\.png \(image, by its bytes\)/);
    expect(started).toMatch(/Job {8}j[0-9a-f]{6} {2}vox inspect refs\/photo\.png · Look \(OpenCV\) · \/jobs j[0-9a-f]{6} · \/stop j[0-9a-f]{6}/);
    await settled(ws);
    const r = recordOf(root);
    expect(r).toMatchObject({ schema: 'timmy.vox/1', action: 'inspect', command: '/inspect refs/photo.png', status: 'ok', project: ws.project.name });
    expect(r.inputs).toEqual([{ path: 'refs/photo.png', sha256: sha(IMG), bytes: IMG.length, kind: 'image', kind_by: 'bytes' }]);
    // The kind, size and sha256 by Timmy; Look's facts by Look, each with its method, tier and label.
    expect(r.metrics.map((m) => m.name)).toEqual(['file_kind', 'file_bytes', 'file_sha256', 'width', 'height', 'channels', 'qr_codes_decoded', 'aruco_markers']);
    for (const m of r.metrics) {
      expect(m.method.length).toBeGreaterThan(5);
      expect(m.tier).toBe('deterministic computation');
    }
    const width = r.metrics.find((m) => m.name === 'width')!;
    expect(width).toMatchObject({ value: 4, unit: 'px', label: 'deterministic computation (OpenCV) on these bytes', measured_by: 'timmy-look fake (OpenCV 5.0.0-fake, Python fake)' });
    expect(r.metrics.find((m) => m.name === 'qr_codes_decoded')).toMatchObject({ value: 1, unit: 'found' });
    // The highlight is listed with the sha256 of the file on disk.
    expect(r.highlights).toHaveLength(1);
    const h = r.highlights[0];
    expect(h).toMatchObject({ path: `results/vox/${r.id}/annotated.png`, type: 'annotated', drawn_from: ['qr_codes_decoded'] });
    expect(h.sha256).toBe(fileSha(root, h.path));
    // The tool ran as a job; its output is kept beside the record, hashed.
    const tool = r.tools[0];
    expect(tool).toMatchObject({ tool: 'look', ran: 'job', name: 'timmy-look', version: 'fake', job: { state: 'completed', exit_code: 0 } });
    expect(tool.raw!.path).toBe(`.timmy/vox/${r.id}/look-${tool.job!.id}.log`);
    expect(tool.raw!.sha256).toBe(fileSha(root, tool.raw!.path));
    expect(readFileSync(join(root, tool.raw!.path), 'utf8')).toContain('"mode":"vox detect"');
    // One vox receipt: the record's bytes first, then the highlight and the raw output; the input by its sha256.
    const receipts = sealed.filter((x) => x.kind === 'vox');
    expect(receipts).toHaveLength(1);
    const rc = receipts[0];
    expect(rc).toMatchObject({ status: 'ok', policy: 'human-gated', subject: 'vox · inspect · refs/photo.png · ok' });
    expect(rc.outputs![0]).toEqual({ path: `results/vox/${r.id}.json`, sha256: fileSha(root, `results/vox/${r.id}.json`), bytes: readFileSync(join(root, `results/vox/${r.id}.json`)).length });
    expect(rc.outputs!.map((o) => o.path)).toEqual([`results/vox/${r.id}.json`, h.path, tool.raw!.path]);
    expect(rc.files).toEqual([{ path: 'refs/photo.png', sha256: sha(IMG), bytes: IMG.length, kind: 'image', kind_by: 'bytes' }]);
    expect(rc.job).toMatchObject({ id: tool.job!.id, state: 'completed' });
    // The job is sealed once, by VoxVision (no plain task receipt).
    expect(sealed.filter((x) => x.kind === 'task')).toHaveLength(0);
    expect(notes.join('\n')).toMatch(new RegExp(`✓ ${r.id} inspect ok {2}refs/photo\\.png → results/vox/${r.id}\\.json · 8 metrics, 1 highlight · receipt r1`));
  });

  it('/measure an image selects what was asked; /detect adds the colour region and draws only measured things', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look } });
    await ws.measure('refs/photo.png sharpness');
    await settled(ws);
    const m = recordOf(root);
    expect(m.metrics.map((x) => x.name)).toEqual(['sharpness']);
    expect(m.metrics[0]).toMatchObject({ value: 12.5, method: 'the variance of the Laplacian of the grayscale image' });
    // Nothing detected and no colour asked: no annotated copy, and the record says why.
    expect(m.highlights).toEqual([]);
    expect(m.notes.join(' ')).toContain('No annotated copy: nothing was detected to outline');
    expect(text(await ws.measure('refs/photo.png loudness'))).toContain('Not a measurement of an image: loudness');

    const root2 = project();
    const { ws: ws2 } = workspace(root2, kit, { env: { TIMMY_VISION_PYTHON: fake.look } });
    await ws2.detect('refs/photo.png color 200,10,10');
    await settled(ws2);
    const d = recordOf(root2);
    expect(d.command).toBe('/detect refs/photo.png color 200,10,10');
    expect(d.metrics.map((x) => x.name)).toEqual(['qr_codes_decoded', 'aruco_markers', 'color_region']);
    expect(d.metrics[2]).toMatchObject({ value: { rgb: [200, 10, 10], pixels: 2, centroid: [1.5, 0.5], box: [1, 0, 3, 1] }, label: 'deterministic computation (OpenCV) on these bytes' });
    expect(d.highlights.map((x) => [x.type, x.drawn_from])).toEqual([['annotated', ['color_region']]]);
    const job = ws2.jobs.list()[0];
    expect(job.args).toEqual(expect.arrayContaining(['--vox', 'detect', '--color', '200,10,10']));
  });

  it('/compare two images: both observed side by side, the deltas, the pixel difference and its heatmap', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, sealed } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look } });
    await ws.compare('refs/photo.png refs/photo2.png');
    await settled(ws);
    const r = recordOf(root);
    expect(r.inputs.map((i) => [i.path, i.role, i.sha256])).toEqual([['refs/photo.png', 'a', sha(IMG)], ['refs/photo2.png', 'b', sha(IMG2)]]);
    expect(r.metrics.filter((m) => m.of === 'a').length).toBe(r.metrics.filter((m) => m.of === 'b').length);
    expect(r.metrics.find((m) => m.name === 'sharpness_delta')).toMatchObject({ value: 0, of: 'delta' });
    expect(r.metrics.find((m) => m.name === 'pixel_difference')).toMatchObject({ value: { changed: 2, changed_share: 0.25 }, of: 'delta' });
    const heat = r.highlights.find((h) => h.type === 'difference-heatmap')!;
    expect(heat.sha256).toBe(fileSha(root, heat.path));
    expect(sealed.filter((x) => x.kind === 'vox')[0].subject).toBe('vox · compare · refs/photo.png vs refs/photo2.png · ok');
  });

  it('compares two STL meshes made here, a unit cube and the cube scaled by 2: exact deltas, an SVG of both boxes, DOCTRINE §15', async () => {
    const root = kit.temp('vox-stl-');
    put(root, 'models/cube.stl', cubeStl(1));
    put(root, 'models/cube2.stl', cubeStl(2));
    const { ws, sealed } = workspace(root, kit);
    // Timmy's reader runs in Timmy's process: no job, so the whole result comes back at once.
    const lines = text(await ws.compare('models/cube.stl models/cube2.stl'));
    expect(ws.jobs.list()).toEqual([]);
    const r = recordOf(root);
    expect(lines).toContain(`${r.id} compare ok`);
    expect(lines).toContain(DOCTRINE_15);
    const v = (name: string, of?: 'a' | 'b'): unknown => r.metrics.find((m) => m.name === name && (!of || m.of === of))?.value;
    expect([v('bbox_size', 'a'), v('volume', 'a'), v('area', 'a')]).toEqual([[1, 1, 1], 1, 6]);
    expect([v('bbox_size', 'b'), v('volume', 'b'), v('area', 'b')]).toEqual([[2, 2, 2], 8, 24]);
    expect(v('bbox_size_delta')).toEqual([1, 1, 1]);
    expect(v('volume_delta')).toBe(7);
    expect(v('volume_ratio')).toBe(8);
    expect(v('area_delta')).toBe(18);
    expect(v('area_ratio')).toBe(4);
    expect(v('triangles_delta')).toBe(0);
    expect(r.metrics.find((m) => m.name === 'volume_delta')).toMatchObject({ label: "Timmy's own reading of the STL", tier: 'deterministic computation', measured_by: "timmy-stl-readback/1 (Timmy's TypeScript reader)" });
    expect(r.tools.map((t) => [t.tool, t.ran, t.of])).toEqual([['stl', 'in-process', 'a'], ['stl', 'in-process', 'b']]);
    expect(r.doctrine).toBe(DOCTRINE_15);
    const svg = r.highlights[0];
    expect(svg).toMatchObject({ type: 'bbox-svg', path: `results/vox/${r.id}/bbox.svg`, of: 'both', drawn_from: ['bbox_size'] });
    expect(svg.sha256).toBe(fileSha(root, svg.path));
    const drawn = readFileSync(join(root, svg.path), 'utf8');
    expect(drawn).toContain('a: models/cube.stl: 1 × 1 × 1 file units');
    expect(drawn).toContain('b: models/cube2.stl: 2 × 2 × 2 file units');
    expect(sealed.find((x) => x.kind === 'vox')!.outputs!.map((o) => o.path)).toEqual([`results/vox/${r.id}.json`, svg.path]);
  });

  it('reads a STEP through the readback job (FAKE OCP) and a .blend through a second pass (FAKE Blender)', async () => {
    const root = kit.temp('vox-cad-');
    put(root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
    put(root, 'scenes/a.blend', Buffer.from('BLENDER-v402 (fake bytes)', 'latin1'));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_CADQUERY_PYTHON: fake.step, TIMMY_BLENDER: fake.blender } });
    await ws.measure('cad/part.step');
    await settled(ws);
    const s = recordOf(root);
    expect(s.metrics.map((m) => [m.name, m.value])).toEqual([['valid', true], ['solids', 1], ['bbox_size', [10, 20, 30]], ['bbox_min', [0, 0, 0]], ['bbox_max', [10, 20, 30]], ['volume', 6000]]);
    expect(s.metrics.every((m) => m.label === "OCP's reading of the STEP (OpenCascade)")).toBe(true);
    expect(s.doctrine).toBe(DOCTRINE_15);
    expect(s.highlights.map((h) => h.type)).toEqual(['bbox-svg']);
    await ws.inspect('scenes/a.blend');
    await settled(ws);
    const b = records(root).find((x) => x.inputs[0].kind === 'blend')!;
    expect(b.tools[0]).toMatchObject({ tool: 'blend', ran: 'job', name: 'timmy-blend-readback', engine: 'Blender 4.2 (FAKE)' });
    expect(b.metrics.find((m) => m.name === 'objects_total')).toMatchObject({ value: 1, tier: 'native readback: a second pass by the same application', label: 'a second pass by Blender' });
    expect(b.doctrine).toBe(DOCTRINE_15);
  });
});

describe('a missing tool is "needs setup" with its exact step, never a value', () => {
  it('says so for each tool, writes the record and seals it as not configured', async () => {
    const root = kit.temp('vox-setup-');
    put(root, 'refs/photo.png', IMG);
    put(root, 'cad/part.step', 'ISO-10303-21;\n');
    put(root, 'scenes/a.blend', 'BLENDER-v402');
    put(root, 'refs/clip.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]));
    put(root, 'scans/a.ply', 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n');
    put(root, 'scans/b.ply', 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 1 1\n');
    // No interpreter anywhere: nothing on the PATH, no TIMMY_* settings, no Roboflow key.
    const { ws, sealed } = workspace(root, kit, { env: { PATH: '/nonexistent' } });
    const cases: Array<[string, string, string, string]> = [
      ['measure', 'refs/photo.png', 'look', SETUP.look],
      ['measure', 'cad/part.step', 'step', SETUP.step],
      ['inspect', 'scenes/a.blend', 'blend', SETUP.blend],
      ['inspect', 'refs/clip.mp4', 'video', SETUP.python],
      ['compare', 'scans/a.ply scans/b.ply', 'geo', SETUP.python],
      ['detect', 'refs/photo.png roboflow cards/3', 'roboflow', SETUP.roboflowKey],
    ];
    for (const [action, args, tool, setup] of cases) {
      const lines = text(await ws.voxAction(action as never, args));
      await settled(ws);
      expect(lines).toContain('needs setup');
      expect(lines).toContain(setup);
      const rc = sealed.at(-1)!;
      expect(rc.kind).toBe('vox');
      const r = recordOf(root, (rc.sources![0] as { vox: string }).vox);
      const row = r.failures.find((f) => f.tool === tool)!;
      expect(row).toMatchObject({ code: 'needs-setup', setup });
      // No value from the missing tool: only Timmy's own intake facts (for /inspect) or nothing.
      expect(r.metrics.every((m) => m.name.startsWith('file_'))).toBe(true);
      expect(r.status).toBe('needs-setup');
      expect(rc).toMatchObject({ status: 'failed', error_class: 'not_configured' });
    }
    expect(sealed.find((x) => x.subject?.includes('roboflow'))).toBeUndefined();
  });

  it('a Python without OpenCV, and a readback that reports OCP missing (exit 3), are needs setup too', async () => {
    const root = project();
    put(root, 'cad/part.step', 'ISO-10303-21;\n');
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, FAKE_NO_CV2: '1', TIMMY_CADQUERY_PYTHON: fake.step, FAKE_NO_OCP: '1' } });
    const lines = text(await ws.inspect('refs/photo.png'));
    expect(lines).toContain('needs setup look: OpenCV is not available to this Python');
    await ws.measure('cad/part.step');
    await settled(ws);
    const step = records(root).find((r) => r.action === 'measure')!;
    expect(step.failures).toEqual([{ tool: 'step', code: 'needs-setup', message: 'OCP is not importable (FAKE)', setup: SETUP.step }]);
    expect(step.status).toBe('needs-setup');
  });
});

describe("the geo lane's exit codes, through /compare of two point clouds (a = the truth)", () => {
  const ply = (z: number): string => `ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 ${z}\n`;
  const run = async (exit: '0' | '2' | '3', extra: NodeJS.ProcessEnv = {}) => {
    const root = kit.temp('vox-geo-');
    put(root, 'scans/truth.ply', ply(0));
    put(root, 'scans/pred.ply', ply(1));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, sealed } = workspace(root, kit, { env: { FAKE_GEO_EXIT: exit, ...extra }, onPath: (c) => (c === 'python3' ? fake.python3 : null) });
    await ws.compare(`scans/truth.ply scans/pred.ply${exit === '2' ? ' --fit' : ''}`);
    await settled(ws);
    return { r: recordOf(root), rc: sealed.find((x) => x.kind === 'vox')!, ws };
  };

  it('0: scored and metric', async () => {
    const { r, rc } = await run('0');
    expect(r.status).toBe('ok');
    expect(r.tools[0]).toMatchObject({ tool: 'geo', status: 'ok: exit 0: scored, metric (nothing fitted)', job: { exit_code: 0 } });
    expect(r.metrics.find((m) => m.name === 'voxel_f1')).toMatchObject({ value: 0.847, label: "the geo lane's score: metric unless fitted (exit 2 = untrusted)", note: 'metric: nothing was fitted' });
    expect(rc.status).toBe('ok');
    expect(r.doctrine).toBe(DOCTRINE_15);
  });

  it('2: computed but untrusted (fitted), its values kept and marked not metric', async () => {
    const { r, rc } = await run('2');
    expect(r.status).toBe('untrusted');
    expect(r.command).toBe('/compare scans/truth.ply scans/pred.ply --fit');
    expect(r.failures).toEqual([{ tool: 'geo', code: 'untrusted', message: 'exit 2: computed but not trusted (fitted: metric false): a shape score, never a metric one' }]);
    expect(r.metrics.find((m) => m.name === 'voxel_f1')!.note).toBe('not metric: exit 2: computed but not trusted (fitted: metric false)');
    expect(rc).toMatchObject({ status: 'ok', error_class: 'untrusted_metric' });
  });

  it('3: not configured, so needs setup with the lane\'s step', async () => {
    const { r, rc } = await run('3');
    expect(r.status).toBe('needs-setup');
    expect(r.metrics).toEqual([]);
    expect(r.failures[0]).toMatchObject({ tool: 'geo', code: 'needs-setup', setup: SETUP.geo });
    expect(r.failures[0].message).toContain('exit 3: not configured');
    expect(rc).toMatchObject({ status: 'failed', error_class: 'not_configured' });
  });

  it('2 with no result (argparse\'s usage error) is a failure, never untrusted', async () => {
    const { r } = await run('2', { FAKE_GEO_USAGE: '1' });
    expect(r.status).toBe('failed');
    expect(r.failures[0].message).toBe('exit 2 with no result: a usage error, nothing was computed');
  });
});

describe('refusals, stops and a tampered highlight', () => {
  it('refuses kinds an action does not read before writing anything', async () => {
    const root = project();
    put(root, 'models/cube.stl', cubeStl(1));
    const { ws, sealed } = workspace(root, kit);
    expect(text(await ws.compare('refs/photo.png models/cube.stl'))).toContain('/compare needs two files of the same kind: refs/photo.png is image, models/cube.stl is STL mesh.');
    expect(text(await ws.detect('models/cube.stl'))).toContain('/detect reads images and videos');
    expect(text(await ws.compare('refs/photo.png refs/photo.png'))).toContain('two different files');
    expect(text(await ws.inspect('../outside.png'))).toContain('outside the project');
    expect(text(await ws.inspect('refs/none.png'))).toContain('refs/none.png does not exist');
    expect(text(await ws.inspect(''))).toContain('Usage: /inspect <file>');
    expect(existsSync(join(root, 'results', 'vox'))).toBe(false);
    expect(sealed).toEqual([]);
  });

  it('/stop on its job: the record says cancelled, and the receipt is sealed cancelled', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, sealed } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, FAKE_SLEEP: 'look' } });
    await ws.inspect('refs/photo.png');
    const job = ws.jobs.list()[0];
    for (let i = 0; i < 100 && ws.jobs.get(job.id)?.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(text(await ws.stop(job.id))).toContain(`${job.id} cancelled`);
    await settled(ws);
    const r = recordOf(root);
    expect(r.status).toBe('cancelled');
    expect(r.failures).toEqual([{ tool: 'look', code: 'cancelled', message: 'stopped with /stop before it finished: nothing it measured is recorded' }]);
    expect(r.metrics.every((m) => m.name.startsWith('file_'))).toBe(true);
    expect(sealed.find((x) => x.kind === 'vox')!.status).toBe('cancelled');
  });

  it('lists no highlight whose bytes are not the ones the worker reported', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, FAKE_QR: 'x', FAKE_BAD_SHA: '1' } });
    await ws.detect('refs/photo.png');
    await settled(ws);
    const r = recordOf(root);
    expect(r.highlights).toEqual([]);
    expect(r.failures[0].message).toMatch(/is not the file the worker reported writing/);
    expect(r.status).toBe('partial');
  });

  it('a Roboflow detection with its key is a model\'s claim, apart from the metrics, and never drawn', async () => {
    const root = project();
    const fake = fakeTools(kit.temp('vox-fake-'));
    // The FAKE stands in for the project's venv python, where roboflow-adapter.ts looks for it (the real bridge would
    // call Roboflow's hosted model over the network; nothing here does).
    mkdirSync(join(root, '.timmy/venv-roboflow/bin'), { recursive: true });
    copyFileSync(fake.roboflow, join(root, '.timmy/venv-roboflow/bin/python'));
    chmodSync(join(root, '.timmy/venv-roboflow/bin/python'), 0o755);
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, ROBOFLOW_API_KEY: 'fake-key' } });
    await ws.detect('refs/photo.png roboflow cards/3');
    await settled(ws);
    const r = recordOf(root);
    expect(r.claims).toEqual([expect.objectContaining({ name: 'roboflow_predictions', tier: 'model prediction', label: "Roboflow's hosted model: a model's prediction, not a measurement", claimed_by: 'Roboflow hosted model cards/3' })]);
    expect((r.claims![0].value as Array<{ class: string }>)[0].class).toBe('card');
    expect(r.metrics.some((m) => m.tier === 'model prediction')).toBe(false);
    expect(r.highlights.every((h) => !h.drawn_from.includes('roboflow_predictions'))).toBe(true);
    const job = ws.jobs.list().find((j) => j.label.includes('Roboflow'))!;
    expect(job.args[0]).toBe('-c');
    expect(job.args[2]).toMatch(/scripts\/roboflow-bridge\.py$/);
  });
});
