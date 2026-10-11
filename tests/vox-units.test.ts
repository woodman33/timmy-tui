// Timmy VoxVision (round R4, helper H49), the parts without a process: which tool reads a file (its kind by its bytes,
// then its name), the geo lane's exit codes as VoxVision reads them (0 ok, 2 untrusted, 3 not configured), the record's
// status and the receipt's, the bounding-box drawing, the command line, and the words a value is shown in.
import { describe, expect, it } from 'vitest';
import { parseVoxArgs, voxArg } from '../src/repl/vox.js';
import { TOOL_OF, voxKindOf } from '../src/vox/kinds.js';
import { delta, DOCTRINE_15, geoStatus, ratio, receiptStatus, settleStatus } from '../src/vox/record.js';
import { bboxSvg } from '../src/vox/svg.js';
import { metricText, plyHeaderMetrics } from '../src/vox/tools.js';
import { cubeStl, png } from './helpers/vox-fakes.js';

const head = (s: string | Buffer): Buffer => (typeof s === 'string' ? Buffer.from(s, 'latin1') : s).subarray(0, 64);

describe('kind dispatch: the bytes first, then the name', () => {
  it('reads each supported kind and names its tool', () => {
    const cases: Array<[string, Buffer, string, 'bytes' | 'name']> = [
      ['refs/photo.png', png(2, 2, () => [1, 2, 3]), 'image', 'bytes'],
      ['refs/clip.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]), 'video', 'bytes'],
      ['refs/clip.webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), 'video', 'bytes'],
      ['models/cube.stl', cubeStl(1), 'stl', 'name'],
      ['models/part.step', Buffer.from('ISO-10303-21;\nHEADER;\n', 'latin1'), 'step', 'bytes'],
      ['models/part.stp', Buffer.from('not a header', 'latin1'), 'step', 'name'],
      ['scenes/a.blend', Buffer.from('BLENDER-v402RENDH', 'latin1'), 'blend', 'bytes'],
      ['scenes/zipped.blend', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2]), 'blend', 'name'],
      ['scans/cloud.ply', Buffer.from('ply\nformat ascii 1.0\n', 'latin1'), 'ply', 'bytes'],
      ['notes.txt', Buffer.from('hello', 'latin1'), 'other', 'name'],
    ];
    for (const [name, bytes, kind, by] of cases) {
      const k = voxKindOf(name, head(bytes));
      expect([name, k.kind, k.by]).toEqual([name, kind, by]);
    }
    expect(TOOL_OF).toEqual({ image: 'look', stl: 'stl', step: 'step', blend: 'blend', video: 'video', ply: 'spatial', other: null });
  });

  it('lets the bytes win over the name, and says so', () => {
    const k = voxKindOf('refs/mesh.stl', head(png(1, 1, () => [0, 0, 0])));
    expect(k).toMatchObject({ kind: 'image', by: 'bytes' });
    expect(k.note).toMatch(/name says stl.*bytes say image/);
    const p = voxKindOf('refs/cloud.xyz', head('ply\nformat ascii 1.0\n'));
    expect(p).toMatchObject({ kind: 'ply', by: 'bytes' });
    expect(p.note).toMatch(/the bytes say PLY/);
    // A 3D format by its bytes that no supported tool reads: other, said.
    const g = voxKindOf('refs/model.glb', head('glTF\x02\x00\x00\x00'));
    expect(g).toMatchObject({ kind: 'other', by: 'bytes' });
    expect(g.note).toMatch(/does not read/);
  });
});

describe("the geo lane's exit codes", () => {
  it('maps 0, 2 and 3 as the lane means them (src/geo/mcp.ts), and a usage error apart', () => {
    expect(geoStatus(0, { kind: 'geo.voxel-score', metric: true }).status).toBe('ok');
    const two = geoStatus(2, { kind: 'geo.voxel-score', metric: false });
    expect(two).toEqual({ status: 'untrusted', meaning: 'exit 2: computed but not trusted (fitted: metric false)' });
    const three = geoStatus(3, { ok: false, status: 'not_configured', note: 'voxel_score needs numpy and scipy: pip install numpy scipy' });
    expect(three.status).toBe('not_configured');
    expect(three.meaning).toContain('pip install numpy scipy');
    expect(geoStatus(2, null).status).toBe('usage');
    expect(geoStatus(2, { ok: false, status: 'refused', note: 'the truth has no points' }).status).toBe('refused');
    expect(geoStatus(1, null).status).toBe('failed');
    expect(geoStatus(null, null).status).toBe('failed');
  });
});

describe("a record's status and its receipt's", () => {
  it('needs setup is not a value; untrusted is sealed ok with its class; a cancel is a cancel', () => {
    const m = (name: string) => ({ name, title: name, value: 1, method: 'm', tier: 't', label: 'l', measured_by: 'b' });
    expect(settleStatus({ metrics: [m('width')], failures: [] })).toBe('ok');
    expect(settleStatus({ metrics: [m('file_kind')], failures: [{ tool: 'step', code: 'needs-setup', message: 'x', setup: 'y' }] })).toBe('needs-setup');
    expect(settleStatus({ metrics: [], failures: [{ tool: 'look', code: 'failed', message: 'x' }] })).toBe('failed');
    expect(settleStatus({ metrics: [m('f1')], failures: [{ tool: 'geo', code: 'untrusted', message: 'fitted' }] })).toBe('untrusted');
    expect(settleStatus({ metrics: [m('a')], failures: [{ tool: 'step', code: 'needs-setup', message: 'x' }] })).toBe('partial');
    expect(settleStatus({ metrics: [m('a')], failures: [{ tool: 'look', code: 'cancelled', message: 'x' }] })).toBe('cancelled');
    expect(receiptStatus('ok')).toEqual({ status: 'ok' });
    expect(receiptStatus('untrusted')).toEqual({ status: 'ok', error_class: 'untrusted_metric' });
    expect(receiptStatus('needs-setup')).toEqual({ status: 'failed', error_class: 'not_configured' });
    expect(receiptStatus('cancelled')).toEqual({ status: 'cancelled' });
    expect(delta([1, 1, 1], [2, 2, 2])).toEqual([1, 1, 1]);
    expect(delta(1, 8)).toBe(7);
    expect(delta('a', 1)).toBeNull();
    expect(ratio(1, 8)).toBe(8);
    expect(ratio(0, 8)).toBeNull();
  });
});

describe('the bounding-box drawing', () => {
  it('writes the measured dimensions, escapes the labels, carries DOCTRINE §15, and refuses sizes that are not numbers', () => {
    const svg = bboxSvg({ title: 'a <b>&"', boxes: [{ label: 'a: <script>', size: [1, 2, 3] }, { label: 'b', size: [2, 4, 6] }], unit: 'mm', measuredBy: 'Timmy' });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('x 1');
    expect(svg).toContain('z 3');
    expect(svg).toContain('a: &lt;script&gt;: 1 × 2 × 3 mm');
    expect(svg).toContain('b: 2 × 4 × 6 mm');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain(DOCTRINE_15);
    expect(() => bboxSvg({ title: 't', boxes: [{ label: 'x', size: [1, Number.NaN, 1] }], unit: 'mm', measuredBy: 'x' })).toThrow();
    expect(() => bboxSvg({ title: 't', boxes: [{ label: 'x', size: [1, -1, 1] }], unit: 'mm', measuredBy: 'x' })).toThrow();
  });
});

describe('the command line', () => {
  it('reads files (quoted or not) and each action\'s options, and refuses what it cannot read', () => {
    expect(parseVoxArgs('inspect', 'refs/a.png')).toEqual({ files: ['refs/a.png'], opts: {} });
    expect(parseVoxArgs('inspect', '"refs/my  photo.png"')).toEqual({ files: ['refs/my  photo.png'], opts: {} });
    expect(parseVoxArgs('measure', 'refs/a.png sharpness size')).toEqual({ files: ['refs/a.png'], opts: { what: ['sharpness', 'size'] } });
    expect(parseVoxArgs('detect', 'refs/a.png qr color 255,0,10 --tolerance 30')).toEqual({ files: ['refs/a.png'], opts: { qr: true, color: [255, 0, 10], tolerance: 30 } });
    expect(parseVoxArgs('detect', 'clip.mp4 color 0,255,0 --at 0,1.5')).toEqual({ files: ['clip.mp4'], opts: { color: [0, 255, 0], at: [0, 1.5] } });
    expect(parseVoxArgs('detect', 'a.png roboflow cards/3')).toEqual({ files: ['a.png'], opts: { roboflow: 'cards/3' } });
    expect(parseVoxArgs('compare', 'a.ply b.ply --voxel 0.1 --tau 0.05 --fit')).toEqual({ files: ['a.ply', 'b.ply'], opts: { voxel: 0.1, tau: 0.05, fit: true } });
    expect(parseVoxArgs('detect', 'a.png color 256,0,0')).toHaveProperty('error');
    expect(parseVoxArgs('detect', 'a.png --at -1')).toHaveProperty('error');
    expect(parseVoxArgs('compare', 'only-one.png')).toHaveProperty('error');
    expect(parseVoxArgs('inspect', 'a.png b.png')).toHaveProperty('error');
    expect(parseVoxArgs('inspect', '--rm a.png')).toHaveProperty('error');
    expect(parseVoxArgs('detect', 'a.png roboflow ../x')).toHaveProperty('error');
  });

  it('writes a file name so the command reads it back exactly', () => {
    for (const name of ['refs/a.png', 'refs/my photo.png', 'refs/it\'s "x".png', 'refs/back\\slash.png']) {
      const arg = voxArg(name)!;
      expect(parseVoxArgs('inspect', arg)).toEqual({ files: [name], opts: {} });
    }
  });
});

describe('the words a value is shown in', () => {
  it('says sizes, points, codes, regions and differences plainly', () => {
    expect(metricText({ name: 'bbox_size', value: [1, 2, 3], unit: 'mm' })).toBe('1 × 2 × 3 mm');
    expect(metricText({ name: 'bbox_min', value: [0, -0, 1.23456789], unit: 'mm' })).toBe('0, 0, 1.234568 mm');
    expect(metricText({ name: 'qr_codes_decoded', value: [] })).toMatch(/^none decoded/);
    expect(metricText({ name: 'qr_codes_decoded', value: [{ text: 'hi' }] })).toBe('"hi"');
    expect(metricText({ name: 'aruco_markers', value: [{ id: 7 }] })).toBe('ids 7');
    expect(metricText({ name: 'color_region', value: { pixels: 1200, share: 0.0625, centroid: [120, 55], box: [100, 40, 140, 70] } })).toBe('1200 px (0.0625 of the image) · centroid 120, 55 · box 100, 40, 140, 70');
    expect(metricText({ name: 'pixel_difference', value: { pixels: 10, changed: 2, changed_share: 0.2, changed_over_16: 1, changed_over_16_share: 0.1, max: 9, mean: 1 } })).toContain('2 of 10 px differ');
    expect(metricText({ name: 'manifold', value: true })).toBe('yes');
    expect(metricText({ name: 'x', value: null })).toBe('not measured');
  });

  it('reads a PLY header as declared, and refuses a file without one', () => {
    const m = plyHeaderMetrics('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n');
    expect(Array.isArray(m) && m.map((x) => [x.name, x.value])).toEqual([['ply_format', 'binary_little_endian 1.0'], ['ply_elements', [{ name: 'vertex', count: 3 }]], ['ply_properties', ['float x', 'float y', 'float z']]]);
    expect(Array.isArray(m) && m.every((x) => x.tier === 'declared by the file (read, not measured)')).toBe(true);
    expect(plyHeaderMetrics('solid x')).toHaveProperty('error');
  });
});
