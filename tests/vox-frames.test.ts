// Timmy VoxVision's coordinate frames (round R4, helper H61): each spatial record names its frame in words, and a 3D
// overlay or a geometric compare is drawn only when both inputs share a known frame and unit; otherwise the record says
// why there is none. Real files and records; Timmy's STL reader is real; the STEP readback and the geo lane are the
// FAKE workers of tests/helpers/vox-fakes.ts (labelled test doubles, not OCP or numpy).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOMEBREW } from '../src/theme/tokens.js';
import { resetLookChecks } from '../src/vision/look.js';
import { apart, blendFrame, frameFromRecord, imageFrame, kindFrame, plyFrame, stepFrame, stlFrame, together, videoFrame } from '../src/vox/frames.js';
import type { VoxRecord } from '../src/vox/record.js';
import { bboxSvg } from '../src/vox/svg.js';
import { cubeStl, fakeTools, png, put, settled, tempKit, text, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const records = (root: string): VoxRecord[] => readdirSync(join(root, 'results', 'vox')).filter((f) => /^v[0-9a-f]{8}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(root, 'results', 'vox', f), 'utf8')) as VoxRecord);
const metric = (r: VoxRecord, name: string, of?: string) => r.metrics.find((m) => m.name === name && (of === undefined || m.of === of))!;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]);

describe('the refusals to overlay or compare: no shared frame and unit', () => {
  it('an STL and a STEP, and a video and an image, are refused with the frames\' reason, and nothing is written', async () => {
    const root = kit.temp('vox-frames-refuse-');
    put(root, 'models/cube.stl', cubeStl(1));
    put(root, 'cad/part.step', 'ISO-10303-21;\nHEADER;\nENDSEC;\n');
    put(root, 'refs/clip.mp4', MP4);
    put(root, 'refs/photo.png', png(4, 2, () => [1, 2, 3]));
    const { ws, sealed } = workspace(root, kit);
    expect(text(await ws.compare('models/cube.stl cad/part.step'))).toContain('/compare needs two files of the same kind: models/cube.stl is STL mesh, cad/part.step is STEP (CAD). They share no known frame and unit either: an STL declares no unit and a STEP is in millimetres as OCP reports them, so no overlay or geometric compare is drawn; /measure each.');
    expect(text(await ws.compare('refs/clip.mp4 refs/photo.png'))).toContain("A video's pixel frame changes with time and an image has one frame: they share no frame, so no overlay or geometric compare is drawn; /detect each.");
    expect(existsSync(join(root, 'results', 'vox'))).toBe(false);
    expect(sealed).toEqual([]);
  });

  it('two STLs: each in its own model frame with no unit declared; numbers compared as estimated, never drawn together, said in the terminal', async () => {
    const root = kit.temp('vox-frames-stl-');
    put(root, 'models/a.stl', cubeStl(1));
    put(root, 'models/b.stl', cubeStl(3));
    const { ws } = workspace(root, kit);
    const lines = text(await ws.compare('models/a.stl models/b.stl'));
    const [r] = records(root);
    expect(r.inputs.map((i) => [i.role, i.frame])).toEqual([
      ['a', { space: 'model', unit: null, unit_by: 'not declared', words: "the STL's own model frame, in the file's units: not declared (an STL carries no unit)" }],
      ['b', { space: 'model', unit: null, unit_by: 'not declared', words: "the STL's own model frame, in the file's units: not declared (an STL carries no unit)" }],
    ]);
    expect(r.together).toEqual({ drawn: false, words: "no drawing of both: neither STL declares a unit, so the two STLs share no known unit; their numbers are compared in the files' own units and marked estimated, never given millimetres" });
    expect(r.highlights).toEqual([]);
    expect(metric(r, 'bbox_size_delta')).toMatchObject({ value: [2, 2, 2], unit: 'file units', status_word: 'estimated' });
    expect(lines).toContain("frame     a: the STL's own model frame, in the file's units: not declared (an STL carries no unit)");
    expect(lines).toContain('together  no drawing of both: neither STL declares a unit');
    expect(lines).toMatch(/Δ Bounding box size \(b − a\) +2 × 2 × 2 file units {2}estimated: units not declared/);
  });

  it('two STEPs in millimetres as OCP reported them are drawn at one scale, named as such; with a unit not reported they are not', async () => {
    const root = kit.temp('vox-frames-step-');
    put(root, 'cad/a.step', 'ISO-10303-21;\nHEADER;\n/* a */\nENDSEC;\n');
    put(root, 'cad/b.step', 'ISO-10303-21;\nHEADER;\n/* b */\nENDSEC;\n');
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { TIMMY_CADQUERY_PYTHON: fake.step } });
    await ws.compare('cad/a.step cad/b.step');
    await settled(ws);
    const [r] = records(root);
    expect(r.inputs.map((i) => i.frame?.unit_by)).toEqual(['reported', 'reported']);
    expect(r.together).toEqual({ drawn: true, words: 'the two STEPs are both in millimetres, each in its own model frame: their boxes are drawn at one scale, each from its own minimum corner (sizes compared, not positions)' });
    expect(metric(r, 'volume_delta')).toMatchObject({ value: 0, status_word: 'measured' });
    const svg = r.highlights.find((h) => h.type === 'bbox-svg')!;
    expect(svg).toMatchObject({ of: 'both', status_word: 'measured' });
    expect(readFileSync(join(root, svg.path), 'utf8')).toContain('frame: each STEP&#39;s own model frame, in millimetres; each box from its own minimum corner');

    const root2 = kit.temp('vox-frames-step2-');
    put(root2, 'cad/a.step', 'ISO-10303-21;\nHEADER;\n/* a */\nENDSEC;\n');
    put(root2, 'cad/b.step', 'ISO-10303-21;\nHEADER;\n/* b */\nENDSEC;\n');
    const { ws: ws2 } = workspace(root2, kit, { env: { TIMMY_CADQUERY_PYTHON: fake.step, FAKE_STEP_NO_UNIT: '1' } });
    await ws2.compare('cad/a.step cad/b.step');
    await settled(ws2);
    const [r2] = records(root2);
    expect(r2.together?.drawn).toBe(false);
    expect(r2.together?.words).toContain('millimetres assumed: OCP did not report the unit in effect');
    expect(r2.highlights).toEqual([]);
    expect(metric(r2, 'volume_delta').status_word).toBe('estimated');
  });

  it('two PLY clouds through the geo lane (FAKE): their coordinates declare no unit, so every score is estimated and nothing is drawn together', async () => {
    const root = kit.temp('vox-frames-ply-');
    const ply = (z: number): string => `ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 ${z}\n`;
    put(root, 'scans/truth.ply', ply(0));
    put(root, 'scans/pred.ply', ply(1));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws } = workspace(root, kit, { env: { FAKE_GEO_EXIT: '0' }, onPath: (c) => (c === 'python3' ? fake.python3 : null) });
    await ws.compare('scans/truth.ply scans/pred.ply');
    await settled(ws);
    const [r] = records(root);
    expect(r.status).toBe('ok');
    expect(r.inputs.map((i) => i.frame?.words)).toEqual(["the PLY's own coordinates, in the file's units: not declared (a PLY carries no unit)", "the PLY's own coordinates, in the file's units: not declared (a PLY carries no unit)"]);
    expect(r.together?.drawn).toBe(false);
    for (const m of r.metrics) expect([m.name, m.status_word, m.status_note]).toEqual([m.name, 'estimated', "units not declared: a PLY carries no unit, and the geo lane reads both clouds' coordinates as metres"]);
  });
});

describe('frames in words, and whether two share one', () => {
  it('names each kind\'s frame and its unit with how it is known', () => {
    expect(stlFrame()).toMatchObject({ unit: null, unit_by: 'not declared' });
    expect(plyFrame()).toMatchObject({ space: 'points', unit: null });
    expect(stepFrame({ unit_in_effect: 'MM' })).toMatchObject({ unit: 'mm', unit_by: 'reported' });
    expect(stepFrame({ unit_in_effect: null })).toMatchObject({ unit: 'mm', unit_by: 'assumed', words: "the STEP's own model frame, in millimetres assumed: OCP did not report the unit in effect" });
    expect(stepFrame(null)).toMatchObject({ unit: null, unit_by: 'not read' });
    expect(blendFrame({ system: 'METRIC', scale_length: 1, length_unit: 'METERS' }).words).toBe("the scene's world frame, in Blender units (its unit settings say METRIC, scale 1, METERS: reported, never applied)");
    expect(imageFrame([40, 30]).words).toBe("the image's pixel frame: 40 × 30 px, x to the right and y down from its top-left corner");
    expect(imageFrame(null)).toMatchObject({ unit_by: 'not read' });
    expect(videoFrame([160, 120])).toMatchObject({ space: 'video pixels', size: [160, 120], unit_by: 'declared' });
    expect(kindFrame('other')).toMatchObject({ space: 'none' });
  });

  it('shares a frame only in one kind of frame with one known unit (and, for pixels, one size)', () => {
    expect(together({ kind: 'image', frame: imageFrame([4, 2]) }, { kind: 'image', frame: imageFrame([4, 2]) })).toEqual({ drawn: true, words: 'the two images share one 4 × 2 px pixel frame: they are compared pixel by pixel' });
    expect(together({ kind: 'image', frame: imageFrame([4, 2]) }, { kind: 'image', frame: imageFrame(null) }).drawn).toBe(false);
    expect(together({ kind: 'stl', frame: stlFrame() }, { kind: 'step', frame: stepFrame({ unit_in_effect: 'MM' }) })).toEqual({ drawn: false, words: "no drawing of both: an STL declares no unit, so an STL and a STEP share no known unit; their numbers are compared in the files' own units and marked estimated, never given millimetres" });
    expect(together({ kind: 'video', frame: videoFrame([8, 8]) }, { kind: 'image', frame: imageFrame([8, 8]) }).drawn).toBe(false);
    expect(together({ kind: 'video', frame: videoFrame([8, 8]) }, { kind: 'video', frame: videoFrame([8, 8]) })).toEqual({ drawn: true, words: 'the two videos share one 8 × 8 px pixel frame: centroids sampled at the same times can be compared in it' });
    expect(together({ kind: 'video', frame: videoFrame([8, 8]) }, { kind: 'video', frame: videoFrame([8, 6]) }).drawn).toBe(false);
    expect(together({ kind: 'blend', frame: blendFrame({}) }, { kind: 'blend', frame: blendFrame({}) }).drawn).toBe(false);
    expect(apart('stl', 'ply')).toBe('They share no known frame and unit either: an STL declares no unit and a PLY declares no unit, so no overlay or geometric compare is drawn; /measure each.');
    // A record from before H61: its frames told from its kind and the values its tool recorded.
    expect(frameFromRecord({ kind: 'image' }, [{ name: 'width', value: 640 }, { name: 'height', value: 480 }]).size).toEqual([640, 480]);
    expect(frameFromRecord({ kind: 'step' }, [{ name: 'bbox_size', value: [1, 2, 3], unit: 'mm (the unit in effect was not reported)' }]).unit_by).toBe('assumed');
    expect(frameFromRecord({ kind: 'step' }, []).unit_by).toBe('not read');
  });

  it('the bounding-box drawing names its frame', () => {
    const svg = bboxSvg({ title: 't', boxes: [{ label: 'a', size: [1, 2, 3] }], unit: 'file units', measuredBy: 'Timmy', frame: "the STL's own model frame; the file's units, not declared" });
    expect(svg).toContain(`<text x="16" y="57" fill="${HOMEBREW.textSecondary}" font-size="10">frame: the STL&#39;s own model frame; the file&#39;s units, not declared</text>`);
    expect(svg).toContain('Frame: the STL&#39;s own model frame; the file&#39;s units, not declared.');
    expect(bboxSvg({ title: 't', boxes: [{ label: 'a', size: [1, 2, 3] }], unit: 'mm', measuredBy: 'x' })).not.toContain('frame:');
  });
});
