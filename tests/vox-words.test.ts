// Timmy VoxVision's status words (round R4, helper H61): every value and highlight carries one of the brief's words,
// "CAD checked", "measured", "estimated", "model prediction", "stale", "unknown", derived from what the record knows.
// Real records and receipts throughout: OpenSCAD's route runs with tests/fixtures/fake-openscad.mjs (a labelled test
// double of OpenSCAD's command line that writes a known box and its summary), the STEP readback and Roboflow are the
// FAKE workers of tests/helpers/vox-fakes.ts, Timmy's STL reader is real, and the image and video parts run the real Look
// worker (OpenCV) and real ffmpeg where they are installed (skipped, with the reason, where they are not).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { readVoxRecord } from '../src/repl/board-vox.js';
import type { Receipt } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { DOCTRINE_15, LABEL, TIER, type VoxRecord } from '../src/vox/record.js';
import { deriveMetricWord, highlightWord, settleWords, shownWord, VOX_WORDS } from '../src/vox/words.js';
import { cubeStl, fakeTools, png, put, settled, sha, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const FAKE_OPENSCAD = join(__dirname, 'fixtures', 'fake-openscad.mjs');
const which = (c: string): string | null => spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim() || null;
const python = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0 ? which('python3') : null;
if (!python) console.warn('vox-words: python3 cannot import cv2 and numpy here, so the real Look checks are skipped');
const ffmpeg = which('ffmpeg') && which('ffprobe') && which('python3');
if (!ffmpeg) console.warn('vox-words: ffmpeg, ffprobe or python3 is missing here, so the real video check is skipped');

/** The project's records now, read back, newest last (by their time). */
function records(root: string): VoxRecord[] {
  const dir = join(root, 'results', 'vox');
  return readdirSync(dir).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as VoxRecord).sort((a, b) => a.made_at.localeCompare(b.made_at));
}
const newest = (root: string, test: (r: VoxRecord) => boolean = () => true): VoxRecord => records(root).filter(test).at(-1)!;
const metric = (r: VoxRecord, name: string, of?: string) => r.metrics.find((m) => m.name === name && (of === undefined || m.of === of))!;
/** The chain the helper's workspace reads (its sealed receipts with their stand-in hashes). */
const chainOf = (sealed: unknown[]): Receipt[] => sealed.map((r, i) => ({ ...(r as object), hash: `sha256:${String(i + 1).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[];
const until = async (ok: () => boolean, ms = 10_000): Promise<void> => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); };

describe('CAD checked: generated CAD against its source\'s own report or prediction', () => {
  it('an STL OpenSCAD wrote: its bounding box is CAD checked against OpenSCAD\'s summary of that run; the rest is measured; a summary changed since is not compared', async () => {
    const root = realpathSync(kit.temp('vox-words-scad-'));
    put(root, 'box.scad', 'width = 10;\ndepth = 20;\nheight = 30;\ncube([width, depth, height]);\n');
    const bin = join(kit.temp('vox-words-bin-'), 'openscad');
    copyFileSync(FAKE_OPENSCAD, bin);
    chmodSync(bin, 0o755);
    const { ws, sealed } = workspace(root, kit, { env: { TIMMY_OPENSCAD: bin } });
    await ws.scad('box.scad');
    await settled(ws);
    await until(() => sealed.some((r) => r.kind === 'native'));
    const native = sealed.find((r) => r.kind === 'native')!;
    expect(native.native).toMatchObject({ app: 'openscad', outcome: 'ok' });
    const stl = native.native!.files[0].path;
    expect(stl).toMatch(/^out\/scad\/[0-9a-f]{8}\/box\.stl$/);

    await ws.measure(stl);
    const r = newest(root);
    expect(metric(r, 'bbox_size')).toMatchObject({
      value: [10, 20, 30], status_word: 'CAD checked',
      status_note: expect.stringMatching(/^checked against OpenSCAD's own summary of the run [0-9a-f]{8} that wrote these bytes \(out\/scad\/[0-9a-f]{8}\/box\.stl\): within float32's precision/),
    });
    for (const n of ['bbox_min', 'bbox_max']) expect(metric(r, n).status_word).toBe('CAD checked');
    for (const n of ['area', 'volume', 'triangles', 'manifold', 'format']) expect([n, metric(r, n).status_word]).toEqual([n, 'measured']);
    expect(r.checks).toHaveLength(1);
    expect(r.checks![0]).toMatchObject({ input: stl, agrees: true, source: { kind: 'openscad-summary', path: expect.stringMatching(/^\.timmy\/native\/[0-9a-f-]{36}\/openscad-summary\.json$/), receipt: expect.any(String) } });
    expect(r.checks![0].compared.map((c) => c.what)).toEqual(['bounding box min x', 'bounding box max x', 'bounding box size x', 'bounding box min y', 'bounding box max y', 'bounding box size y', 'bounding box min z', 'bounding box max z', 'bounding box size z']);
    // The drawing of the box carries the word of the values it was drawn from, and names its frame.
    expect(r.highlights[0]).toMatchObject({ type: 'bbox-svg', status_word: 'CAD checked' });
    expect(readFileSync(join(root, r.highlights[0].path), 'utf8')).toContain('frame: the STL&#39;s own model frame; the file&#39;s units, not declared');
    expect(r.doctrine).toBe(DOCTRINE_15);
    // The operation card (src/ops/card.ts) shows the same word: /measure as one request, then /op.
    await ws.operate(`/measure ${stl}`, 'repl', () => ws.measure(stl));
    const h = ws.ops.latest!;
    await ws.ops.done(h);
    expect(text(ws.op(h.id))).toMatch(/Bounding box size: 10 x 20 x 30 file units · CAD checked: checked against OpenSCAD's own summary of the run [0-9a-f]{8} that wrote these bytes/);

    // OpenSCAD's summary changed after its run's receipt sealed it: nothing is compared, the values stay measured, and why is said.
    writeFileSync(join(root, r.checks![0].source.path!), '{"geometry":{"bounding_box":{"min":[0,0,0],"max":[10,20,30]}}}\n');
    await ws.measure(stl);
    const again = newest(root);
    expect(again.id).not.toBe(r.id);
    expect(again.checks![0]).toMatchObject({ agrees: false, why: expect.stringContaining('is not the file its receipt sealed'), compared: [] });
    expect(metric(again, 'bbox_size').status_word).toBe('measured');
    // An STL no OpenSCAD run of this project wrote has no check at all.
    put(root, 'models/cube.stl', cubeStl(1));
    await ws.measure('models/cube.stl');
    const plain = newest(root, (x) => x.inputs[0].path === 'models/cube.stl');
    expect(plain.checks).toBeUndefined();
    expect(metric(plain, 'bbox_size').status_word).toBe('measured');
  });

  /** A project whose flow delivered out/tray.step, with the recipe's prediction sealed on the chain as /recipe seals it. */
  function flowProject(env: NodeJS.ProcessEnv = {}) {
    const root = kit.temp('vox-words-flow-');
    put(root, 'out/tray.step', 'ISO-10303-21;\nHEADER;\n/* FAKE tray: read by the FAKE OCP readback */\nENDSEC;\n');
    const step = readFileSync(join(root, 'out/tray.step'));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const w = workspace(root, kit, { env: { TIMMY_CADQUERY_PYTHON: fake.step, ...env } });
    w.sealed.push({ kind: 'predict', subject: 'recipe · predict · enclosure-tray · FAKE', policy: 'human-gated', status: 'ok', project: w.ws.project.name, project_id: projectId(root), sources: [{ recipe: 'enclosure-tray', bounds_mm: [10, 20, 30], volume_mm3: 6000, units: 'mm' }] });
    const receipt = String(w.sealed.length).padStart(8, '0');
    put(root, 'results/flows/f0a1b2c3d.json', `${JSON.stringify({
      flow: 1, schema: 'timmy.flow/1', id: 'f0a1b2c3d', kind: 'iterate', recipe: 'enclosure-tray', instruction: 'make it 10 by 20 by 30 (a test record)', project: w.ws.project.name,
      started_at: '2026-10-10T07:00:00.000Z', ended_at: '2026-10-10T07:01:00.000Z', outcome: 'succeeded', parameters: { path: 'tray.params.json', created: false, before: { sha256: '0'.repeat(64), values: {} } },
      rebuild: { state: 'succeeded', predicted: { bounds_mm: [10, 20, 30], volume_mm3: 6000 }, prediction_receipt: receipt, outputs: [{ path: 'out/tray.step', sha256: sha(step), bytes: step.length }] },
      receipts: { prediction: receipt }, child_receipts: [], doctrine: DOCTRINE_15,
    }, null, 2)}\n`);
    return { root, receipt, ...w };
  }

  it('a STEP a flow delivered: CAD checked against the prediction sealed before its build, within the flow\'s own tolerance', async () => {
    const { root, ws, receipt } = flowProject();
    await ws.measure('out/tray.step');
    await settled(ws);
    const r = newest(root);
    expect(metric(r, 'bbox_size')).toMatchObject({ value: [10, 20, 30], status_word: 'CAD checked', status_note: `checked against the recipe's prediction sealed before flow f0a1b2c3d's build (receipt ${receipt}): within the flow's own tolerance (1e-6 mm and 1e-8 relative)` });
    for (const n of ['volume', 'valid', 'solids']) expect([n, metric(r, n).status_word]).toEqual([n, 'CAD checked']);
    // Its position is not part of the prediction: measured.
    for (const n of ['bbox_min', 'bbox_max']) expect([n, metric(r, n).status_word]).toEqual([n, 'measured']);
    expect(r.checks![0]).toMatchObject({ agrees: true, source: { kind: 'flow-prediction', flow: 'f0a1b2c3d', receipt, path: 'results/flows/f0a1b2c3d.json' } });
    expect(r.inputs[0].frame).toMatchObject({ space: 'model', unit: 'mm', unit_by: 'reported' });
  });

  it('a STEP that differs from its sealed prediction stays measured and says by how much; one whose prediction receipt is not on the chain is not compared', async () => {
    const { root, ws } = flowProject({ FAKE_STEP_SIZE: '10,20,31' });
    await ws.measure('out/tray.step');
    await settled(ws);
    const r = newest(root);
    expect(r.checks![0].agrees).toBe(false);
    expect(metric(r, 'bbox_size')).toMatchObject({ status_word: 'measured', status_note: expect.stringMatching(/^computed from these exact bytes; not CAD checked: it differs from the recipe's prediction .* by up to 1, beyond the flow's own tolerance/) });
    expect(metric(r, 'valid').status_word).toBe('CAD checked');
    expect(r.notes.join(' ')).toMatch(/not CAD checked: 2 of 6 values differ from the recipe's prediction/);

    const other = flowProject();
    other.sealed.splice(0, other.sealed.length);
    await other.ws.measure('out/tray.step');
    await settled(other.ws);
    const r2 = newest(other.root);
    expect(r2.checks![0]).toMatchObject({ agrees: false, why: `its prediction receipt ${other.receipt} is not on this project's runs chain` });
    expect(metric(r2, 'bbox_size').status_word).toBe('measured');
  });
});

describe('measured, estimated, model prediction, stale and unknown on real records', () => {
  it('estimated: two STLs compared (units not declared), an STL told by its name, and a STEP whose unit in effect OCP did not report', async () => {
    const root = kit.temp('vox-words-est-');
    put(root, 'models/cube.stl', cubeStl(1));
    put(root, 'models/cube2.stl', cubeStl(2));
    put(root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_CADQUERY_PYTHON: fake.step, FAKE_STEP_NO_UNIT: '1' } });
    await ws.compare('models/cube.stl models/cube2.stl');
    const c = newest(root);
    for (const n of ['bbox_size_delta', 'volume_delta', 'volume_ratio', 'area_delta', 'area_ratio', 'triangles_delta']) {
      expect([n, metric(c, n).status_word, metric(c, n).status_note]).toEqual([n, 'estimated', "units not declared: an STL carries no unit, so the two files' numbers are compared in their own units, never as millimetres"]);
    }
    expect([metric(c, 'volume', 'a').status_word, metric(c, 'volume', 'b').status_word]).toEqual(['measured', 'measured']);
    await ws.inspect('models/cube.stl');
    const i = newest(root, (x) => x.action === 'inspect');
    expect(metric(i, 'file_kind')).toMatchObject({ value: 'STL mesh', status_word: 'estimated', status_note: 'its kind by its name: its bytes carry no magic number' });
    expect(metric(i, 'file_sha256').status_word).toBe('measured');
    await ws.measure('cad/part.step');
    await settled(ws);
    const s = newest(root, (x) => x.inputs[0].kind === 'step');
    for (const n of ['bbox_size', 'bbox_min', 'volume']) expect([n, metric(s, n).status_word, metric(s, n).status_note]).toEqual([n, 'estimated', 'millimetres assumed: OCP did not report the unit in effect']);
    expect(metric(s, 'valid').status_word).toBe('measured');
    expect(s.inputs[0].frame).toMatchObject({ unit: 'mm', unit_by: 'assumed' });
    expect(readFileSync(join(root, s.highlights[0].path), 'utf8')).toContain('frame: the STEP&#39;s own model frame, millimetres assumed (OCP did not report the unit)');
  });

  it('model prediction: a FAKE Roboflow detection is a claim worded as one; its image\'s values keep their own words', async () => {
    const root = kit.temp('vox-words-rf-');
    put(root, 'refs/photo.png', png(4, 2, () => [200, 10, 10]));
    const fake = fakeTools(kit.temp('vox-fake-'));
    mkdirSync(join(root, '.timmy/venv-roboflow/bin'), { recursive: true });
    copyFileSync(fake.roboflow, join(root, '.timmy/venv-roboflow/bin/python'));
    chmodSync(join(root, '.timmy/venv-roboflow/bin/python'), 0o755);
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, ROBOFLOW_API_KEY: 'fake-key' } });
    await ws.detect('refs/photo.png roboflow cards/3');
    await settled(ws);
    const r = newest(root);
    expect(r.claims![0]).toMatchObject({ status_word: 'model prediction', status_note: "Roboflow hosted model cards/3: a model's output, not a measurement" });
    expect(r.metrics.every((m) => m.status_word === 'measured')).toBe(true);
    expect(r.metrics.some((m) => m.status_word === 'model prediction')).toBe(false);
  });

  it('stale and unknown on the card: an input changed since, a record edited since, and back', async () => {
    const root = kit.temp('vox-words-stale-');
    put(root, 'models/cube.stl', cubeStl(1));
    const { ws, sealed } = workspace(root, kit);
    await ws.measure('models/cube.stl');
    const rel = sealed.find((r) => r.kind === 'vox')!.outputs![0].path;
    const read = () => readVoxRecord({ root, file: rel, text: readFileSync(join(root, rel), 'utf8'), fileSha256: sha(readFileSync(join(root, rel))), chain: chainOf(sealed), projectId: projectId(root) })!;
    expect(read().metrics.find((m) => m.name === 'volume')!.said).toEqual({ word: 'measured', note: 'computed from these exact bytes', derived: false });
    put(root, 'models/cube.stl', cubeStl(2));
    const stale = read();
    expect(stale.check.status).toBe('stale');
    for (const m of stale.metrics) expect([m.name, m.said?.word, m.said?.recorded]).toEqual([m.name, 'stale', 'measured']);
    expect(stale.metrics[0].said!.note).toMatch(/^models\/cube\.stl changed since \(sha256 [0-9a-f]{12} now, [0-9a-f]{12} measured\)$/);
    expect(stale.highlights[0].said).toMatchObject({ word: 'stale', recorded: 'measured' });
    put(root, 'models/cube.stl', cubeStl(1));
    expect(read().metrics.every((m) => m.said?.word === 'measured')).toBe(true);
    const text0 = readFileSync(join(root, rel), 'utf8');
    writeFileSync(join(root, rel), text0.replace('"value": 12', '"value": 13'));
    const edited = read();
    expect(edited.check.status).toBe('unverified');
    expect(edited.metrics.every((m) => m.said?.word === 'unknown' && /^not verified: the record is not the file its receipt 00000001 sealed/.test(m.said.note))).toBe(true);
  });
});

describe.skipIf(!python)('measured and unknown with the real Look worker (OpenCV)', () => {
  it('every value of an image is measured; a compare of two sizes has no pixel difference: unknown, with why, and no pixel frame shared', async () => {
    const root = kit.temp('vox-words-look-');
    put(root, 'refs/a.png', png(40, 30, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 15 ? [255, 0, 0] : [30, 30, 30])));
    put(root, 'refs/small.png', png(8, 8, () => [0, 0, 0]));
    const { ws } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: python! } });
    await ws.measure('refs/a.png');
    await settled(ws);
    const m = newest(root);
    expect(m.status).toBe('ok');
    // Every value Look gave is measured; one this OpenCV build cannot give (ArUco without its module) is unknown.
    expect(m.metrics.map((x) => [x.name, x.status_word])).toEqual(m.metrics.map((x) => [x.name, x.value === null ? 'unknown' : 'measured']));
    expect(m.metrics.filter((x) => x.status_word === 'measured').length).toBeGreaterThanOrEqual(8);
    expect(m.inputs[0].frame).toMatchObject({ space: 'pixels', size: [40, 30] });
    await ws.compare('refs/a.png refs/small.png');
    await settled(ws);
    const c = newest(root, (x) => x.action === 'compare');
    expect(metric(c, 'pixel_difference')).toMatchObject({ value: null, status_word: 'unknown', status_note: 'the images differ in size (40x30 and 8x8); a pixel difference needs the same size, and neither image was resized.' });
    expect(metric(c, 'width_delta')).toMatchObject({ value: -32, status_word: 'measured' });
    expect(c.together).toEqual({ drawn: false, words: 'no drawing of both: the two images are different pixel frames (40 × 30 px and 8 × 8 px)' });
  });
});

describe.skipIf(!ffmpeg)('estimated with the real video readback (ffprobe, ffmpeg)', () => {
  it('a colour region in a video is one sampled frame, and what the container declares is estimated', async () => {
    const root = kit.temp('vox-words-video-');
    const make = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=1:r=10', '-f', 'lavfi', '-i', 'color=c=red:s=20x20:d=1:r=10',
      '-filter_complex', '[0][1]overlay=x=t*30:y=40', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')]);
    expect(make.status).toBe(0);
    const { ws } = workspace(root, kit, { env: { PATH: process.env.PATH }, onPath: which });
    await ws.detect('clip.mp4 color 255,0,0 --at 0.5');
    await settled(ws);
    const d = newest(root);
    expect(metric(d, 'color_at:0.5')).toMatchObject({ status_word: 'estimated', status_note: 'one sampled frame (the frame shown at 0.5 s), as ffmpeg decoded it' });
    expect(d.highlights[0]).toMatchObject({ type: 'frame', status_word: 'estimated', status_note: 'drawn from estimated values: one sampled frame (the frame shown at 0.5 s), as ffmpeg decoded it' });
    expect(d.inputs[0].frame).toMatchObject({ space: 'video pixels', size: [160, 120], unit_by: 'declared' });
    await ws.inspect('clip.mp4');
    await settled(ws);
    const i = newest(root, (x) => x.action === 'inspect');
    expect(metric(i, 'codec')).toMatchObject({ value: 'h264', status_word: 'estimated', status_note: 'as the file declares it: read from its header, not counted or decoded' });
  });
});

describe('a record made before H61: its words derived from what it holds', () => {
  it('an older STL compare, image detect and geo score are worded as their tiers, values and inputs say, never CAD checked', () => {
    const root = kit.temp('vox-words-old-');
    put(root, 'models/cube.stl', cubeStl(1));
    put(root, 'models/cube2.stl', cubeStl(2));
    const m = (name: string, value: unknown, extra: Record<string, unknown> = {}) => ({ name, title: name, value, method: 'm', tier: TIER.computed, label: LABEL.stl, measured_by: 'timmy-stl-readback/1', ...extra });
    // As H49 wrote it: no status words, no frames, the two boxes drawn together.
    const old = {
      schema: 'timmy.vox/1', id: 'v0000aaaa', action: 'compare', command: '/compare models/cube.stl models/cube2.stl', made_at: '2026-10-09T10:00:00.000Z', project: 'p', status: 'ok',
      inputs: [{ path: 'models/cube.stl', sha256: sha(cubeStl(1)), bytes: 684, kind: 'stl', kind_by: 'name', role: 'a' }, { path: 'models/cube2.stl', sha256: sha(cubeStl(2)), bytes: 684, kind: 'stl', kind_by: 'name', role: 'b' }],
      tools: [], metrics: [m('bbox_size', [1, 1, 1], { of: 'a', unit: 'file units' }), m('bbox_size', [2, 2, 2], { of: 'b', unit: 'file units' }), m('volume_delta', 7, { of: 'delta' }), m('voxel_f1', null, { label: LABEL.geo, note: 'not measured: no points' })],
      claims: [{ name: 'roboflow_predictions', title: 'p', value: [], tier: TIER.model, label: LABEL.roboflow, claimed_by: 'Roboflow hosted model x/1' }],
      highlights: [{ path: 'results/vox/v0000aaaa/bbox.svg', sha256: '0'.repeat(64), bytes: 1, type: 'bbox-svg', drawn_from: ['bbox_size'], drawn_by: 'Timmy', method: 'm', of: 'both' }],
      failures: [], notes: [], doctrine: DOCTRINE_15,
    };
    const text = `${JSON.stringify(old, null, 2)}\n`;
    put(root, 'results/vox/v0000aaaa.json', text);
    const chain = [{ kind: 'vox', project_id: projectId(root), outputs: [{ path: 'results/vox/v0000aaaa.json', sha256: sha(text), bytes: text.length }], hash: `sha256:0000beef${'0'.repeat(56)}` }] as unknown as Receipt[];
    const card = readVoxRecord({ root, file: 'results/vox/v0000aaaa.json', text, fileSha256: sha(text), chain, projectId: projectId(root) })!;
    expect(card.check.status).toBe('verified');
    const said = (name: string, of?: string) => card.metrics.find((x) => x.name === name && (!of || x.of === of))!.said;
    expect(said('bbox_size', 'a')).toEqual({ word: 'measured', note: 'computed from these exact bytes', derived: true });
    expect(said('volume_delta')).toMatchObject({ word: 'estimated', note: expect.stringContaining('units not declared'), derived: true });
    expect(said('voxel_f1')).toMatchObject({ word: 'unknown', note: 'no points' });
    expect(card.claims[0].said).toMatchObject({ word: 'model prediction' });
    expect(card.highlights[0].said).toMatchObject({ word: 'measured', derived: true });
    expect(card.inputs.map((i) => i.frame?.words)).toEqual(["the STL's own model frame, in the file's units: not declared (an STL carries no unit)", "the STL's own model frame, in the file's units: not declared (an STL carries no unit)"]);
    expect(card.together).toEqual({ drawn: false, words: expect.stringContaining('neither STL declares a unit') });
    expect([...card.metrics, ...card.claims].some((x) => x.said?.word === 'CAD checked')).toBe(false);
  });

  it('derives each word from a tier, a value and a method, and a highlight takes the weakest word it was drawn from', () => {
    const ctx = { action: 'measure', kinds: ['video'] };
    expect(deriveMetricWord({ name: 'codec', value: 'h264', tier: TIER.declared }, ctx)).toEqual({ word: 'estimated', note: 'as the file declares it: read from its header, not counted or decoded' });
    expect(deriveMetricWord({ name: 'objects_total', value: 1, tier: TIER.native }, ctx)).toEqual({ word: 'measured', note: 'a second pass of the same application over these exact bytes' });
    expect(deriveMetricWord({ name: 'color_at:1.5', value: {}, tier: TIER.computed, method: 'frames decoded by ffmpeg, scaled by 1/4 (area averaging)' }, ctx).note).toBe('one sampled frame (the frame shown at 1.5 s), as ffmpeg decoded it, scaled by 1/4 before its pixels were counted');
    expect(deriveMetricWord({ name: 'voxel_f1', value: 0.8, tier: TIER.computed, label: LABEL.geo, note: 'not metric: exit 2' }, ctx).note).toMatch(/^fitted:/);
    expect(deriveMetricWord({ name: 'chamfer_mean_dist', value: 0.1, tier: TIER.computed, label: LABEL.geo, unit: 'unit-cube', note: 'metric: nothing was fitted' }, ctx).note).toMatch(/^scaled:/);
    expect(deriveMetricWord({ name: 'voxel_f1', value: 0.8, tier: TIER.computed, label: LABEL.geo, note: 'metric: nothing was fitted' }, ctx).note).toMatch(/^units not declared: a PLY carries no unit/);
    const values = [{ name: 'a', said: { word: 'CAD checked' as const, note: 'x' } }, { name: 'b', said: { word: 'estimated' as const, note: 'a scale' } }];
    expect(highlightWord({ drawn_from: ['a'] }, values)).toMatchObject({ word: 'CAD checked' });
    expect(highlightWord({ drawn_from: ['a', 'b'] }, values)).toMatchObject({ word: 'estimated', note: 'drawn from estimated values: a scale' });
    expect(highlightWord({ drawn_from: ['nothing'] }, values)).toMatchObject({ word: 'unknown' });
    expect(shownWord({ word: 'measured', note: 'n' }, { status: 'stale', reasons: ['x changed'] })).toEqual({ word: 'stale', note: 'x changed', recorded: 'measured' });
    expect(VOX_WORDS).toEqual(['CAD checked', 'measured', 'estimated', 'model prediction', 'stale', 'unknown']);
  });

  it('settles a new record once: a disagreeing check keeps the value measured and says by how much; a worded value keeps its word', () => {
    const rec = {
      schema: 'timmy.vox/1', id: 'v00000001', action: 'measure', command: 'x', made_at: 'now', project: 'p', status: 'ok',
      inputs: [{ path: 'a.stl', sha256: 'x', bytes: 1, kind: 'stl', kind_by: 'name' }], tools: [], highlights: [], failures: [], notes: [],
      metrics: [
        { name: 'bbox_max', title: 't', value: [1, 1, 1], method: 'm', tier: TIER.computed, label: LABEL.stl, measured_by: 'b' },
        { name: 'bbox_min', title: 't', value: [0, 0, 0], method: 'm', tier: TIER.computed, label: LABEL.stl, measured_by: 'b' },
        { name: 'area', title: 't', value: 6, method: 'm', tier: TIER.computed, label: LABEL.stl, measured_by: 'b', status_word: 'estimated' as const, status_note: 'kept' },
      ],
      checks: [{ input: 'a.stl', against: "OpenSCAD's own summary", source: { kind: 'openscad-summary' as const }, tolerance: 'float32', agrees: false, compared: [
        { metric: 'bbox_max', what: 'max x', reported: 1.5, measured: 1, difference: -0.5, within: false }, { metric: 'bbox_min', what: 'min x', reported: 0, measured: 0, difference: 0, within: true }] }],
    } as unknown as VoxRecord;
    settleWords(rec);
    expect(rec.metrics.map((x) => [x.name, x.status_word])).toEqual([['bbox_max', 'measured'], ['bbox_min', 'CAD checked'], ['area', 'estimated']]);
    expect(rec.metrics[0].status_note).toBe("computed from these exact bytes; not CAD checked: it differs from OpenSCAD's own summary by up to 0.5, beyond float32");
    expect(rec.metrics[2].status_note).toBe('kept');
  });
});
