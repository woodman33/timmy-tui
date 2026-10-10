// Timmy VoxVision (round R4, helper H49) with the real workers: Look's --vox modes (OpenCV) on generated PNGs, and the
// video readback (ffprobe, ffmpeg) on a generated clip. Each part is skipped, with its reason, where its tool is absent
// (as tests/look.test.ts skips the real Look worker): CI has no OpenCV.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOOK_SCRIPT, resetLookChecks } from '../src/vision/look.js';
import type { VoxRecord } from '../src/vox/record.js';
import { png, put, settled, sha, tempKit, workspace } from './helpers/vox-fakes.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

const which = (c: string): string | null => spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim() || null;
const python = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0 ? which('python3') : null;
if (!python) console.warn('vox-look-real: python3 cannot import cv2 and numpy here, so the real Look worker checks are skipped');
const ffmpeg = which('ffmpeg') && which('ffprobe') && which('python3');
if (!ffmpeg) console.warn('vox-look-real: ffmpeg, ffprobe or python3 is missing here, so the real video readback checks are skipped');

const records = (root: string): VoxRecord[] => readdirSync(join(root, 'results', 'vox')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(root, 'results', 'vox', f), 'utf8')) as VoxRecord);
const look = (args: string[]): { status: number | null; out: Record<string, unknown> } => {
  const r = spawnSync(python!, [LOOK_SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown> };
};
/** 40 × 30, dark grey, with a red block x 10..19, y 5..14 (100 pixels). */
const CARD = png(40, 30, (x, y) => (x >= 10 && x < 20 && y >= 5 && y < 15 ? [255, 0, 0] : [30, 30, 30]));
/** The same size; a 5 × 4 block 100 levels brighter, and 3 pixels 5 levels darker. */
const CARD_B = png(40, 30, (x, y) => {
  if (x >= 30 && x < 35 && y >= 20 && y < 24) return [130, 130, 130];
  if (y === 0 && x < 3) return [25, 30, 30];
  return x >= 10 && x < 20 && y >= 5 && y < 15 ? [255, 0, 0] : [30, 30, 30];
});

describe.skipIf(!python)('Look --vox with real OpenCV', () => {
  it('without --vox prints the same observation the vox modes carry, key for key (the default output is unchanged)', () => {
    const dir = kit.temp('vox-real-');
    put(dir, 'card.png', CARD);
    const plain = spawnSync(python!, [LOOK_SCRIPT, join(dir, 'card.png'), '--as', 'refs/card.png'], { encoding: 'utf8' });
    expect(plain.status).toBe(0);
    const line = JSON.parse(plain.stdout.trim()) as Record<string, unknown>;
    expect(Object.keys(line)).toEqual(['ok', 'worker', 'opencv', 'python', 'source', 'image', 'measurements', 'uncertainty']);
    expect((line.measurements as Array<{ name: string }>).map((m) => m.name)).toEqual(['mean_color', 'dominant_colors', 'sharpness', 'edge_density', 'qr_codes_decoded', 'aruco_markers']);
    expect(line.worker).toEqual({ name: 'timmy-look', version: '0.1.0' });
    const vox = look([join(dir, 'card.png'), '--as', 'refs/card.png', '--vox', 'detect']);
    expect(vox.status).toBe(0);
    expect(vox.out.observation).toEqual(line);
    // --vox given as the name to report is a name, not the mode.
    const named = spawnSync(python!, [LOOK_SCRIPT, join(dir, 'card.png'), '--as', '--vox'], { encoding: 'utf8' });
    expect((JSON.parse(named.stdout) as { source: { path: string } }).source.path).toBe('--vox');
  });

  it('measures a colour region exactly and draws only what it measured; never writes over a file', () => {
    const dir = kit.temp('vox-real-');
    put(dir, 'card.png', CARD);
    const r = look([join(dir, 'card.png'), '--as', 'card.png', '--vox', 'detect', '--color', '255,0,0', '--out', join(dir, 'annotated.png')]);
    expect(r.status).toBe(0);
    const region = r.out.color_region as { value: Record<string, unknown>; tier: string; method: string };
    expect(region.value).toEqual({ rgb: [255, 0, 0], tolerance: 48, pixels: 100, share: Number((100 / 1200).toFixed(6)), centroid: [15, 10], box: [10, 5, 20, 15] });
    expect(region.tier).toBe('deterministic computation');
    const h = r.out.highlight as { file: string; sha256: string; drawn_from: string[] };
    expect(h.file).toBe('annotated.png');
    expect(h.drawn_from).toEqual(['color_region']);
    expect(h.sha256).toBe(sha(readFileSync(join(dir, 'annotated.png'))));
    // Nothing found in a colour that is not there: no box, no drawing.
    const none = look([join(dir, 'card.png'), '--vox', 'detect', '--color', '0,0,255', '--out', join(dir, 'none.png')]);
    expect((none.out.color_region as { value: { pixels: number; box: unknown } }).value).toMatchObject({ pixels: 0, box: null });
    expect(none.out.highlight).toBeNull();
    expect(none.out.highlight_note).toBe('nothing was detected to outline, so no annotated copy was written');
    // The same output name again: left as it is, and said.
    const again = look([join(dir, 'card.png'), '--vox', 'detect', '--color', '255,0,0', '--out', join(dir, 'annotated.png')]);
    expect(again.out.highlight).toBeNull();
    expect(again.out.highlight_note).toBe('a file of that name was already there; it was left as it is');
    expect(look([join(dir, 'card.png'), '--vox', 'detect', '--color', '255,0']).status).toBe(64);
  });

  it('outlines a decoded QR code in the annotated copy', () => {
    const dir = kit.temp('vox-real-');
    const gen = "import cv2, sys\nq = cv2.QRCodeEncoder.create().encode('timmy vox')\nq = cv2.resize(q, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)\nq = cv2.copyMakeBorder(q, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)\ncv2.imwrite(sys.argv[1], q)";
    expect(spawnSync(python!, ['-c', gen, join(dir, 'qr.png')]).status).toBe(0);
    const r = look([join(dir, 'qr.png'), '--vox', 'detect', '--out', join(dir, 'a.png')]);
    const qr = ((r.out.observation as { measurements: Array<{ name: string; value: unknown }> }).measurements.find((m) => m.name === 'qr_codes_decoded')!.value) as Array<{ text: string }>;
    expect(qr.map((c) => c.text)).toEqual(['timmy vox']);
    expect((r.out.highlight as { drawn_from: string[]; drawn: Record<string, unknown> })).toMatchObject({ drawn_from: ['qr_codes_decoded'], drawn: { qr_codes: 1, aruco_markers: 0, color_region: false } });
  });

  it('/compare of two generated PNGs through the workspace: the exact share of changed pixels, a heatmap with its sha256', async () => {
    const root = kit.temp('vox-real-proj-');
    put(root, 'refs/a.png', CARD);
    put(root, 'refs/b.png', CARD_B);
    put(root, 'refs/small.png', png(8, 8, () => [0, 0, 0]));
    const { ws, sealed } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: python! } });
    await ws.compare('refs/a.png refs/b.png');
    await settled(ws);
    const r = records(root)[0];
    expect(r.status).toBe('ok');
    const diff = r.metrics.find((m) => m.name === 'pixel_difference')!;
    expect(diff.value).toEqual({ pixels: 1200, changed: 23, changed_share: Number((23 / 1200).toFixed(6)), changed_over_16: 20, changed_over_16_share: Number((20 / 1200).toFixed(6)), max: 100, mean: Number(((20 * 100 + 3 * 5) / 1200).toFixed(4)) });
    expect(diff).toMatchObject({ tier: 'deterministic computation', label: 'deterministic computation (OpenCV) on these bytes', of: 'delta' });
    expect(r.metrics.filter((m) => m.name === 'width').map((m) => [m.of, m.value])).toEqual([['a', 40], ['b', 40]]);
    const heat = r.highlights.find((h) => h.type === 'difference-heatmap')!;
    expect(heat.sha256).toBe(sha(readFileSync(join(root, heat.path))));
    expect(readFileSync(join(root, heat.path)).subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(sealed.find((x) => x.kind === 'vox')!.outputs!.some((o) => o.path === heat.path && o.sha256 === heat.sha256)).toBe(true);
    // Different sizes: no pixel difference and no heatmap, said.
    await ws.compare('refs/a.png refs/small.png');
    await settled(ws);
    const r2 = records(root).find((x) => x.inputs[1]?.path === 'refs/small.png')!;
    expect(r2.metrics.find((m) => m.name === 'pixel_difference')!.value).toBeNull();
    expect(r2.highlights).toEqual([]);
    expect(r2.notes.join(' ')).toContain('No heatmap: the images were not compared pixel by pixel');
  });
});

describe.skipIf(!ffmpeg)('the video readback with real ffprobe and ffmpeg', () => {
  it('/inspect probes a generated clip, and /detect finds a moving red square at the times asked', async () => {
    const root = kit.temp('vox-video-');
    const make = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=2:r=10', '-f', 'lavfi', '-i', 'color=c=red:s=20x20:d=2:r=10',
      '-filter_complex', '[0][1]overlay=x=t*30:y=40', '-pix_fmt', 'yuv420p', join(root, 'clip.mp4')]);
    expect(make.status).toBe(0);
    const { ws } = workspace(root, kit, { env: { PATH: process.env.PATH }, onPath: which });
    await ws.inspect('clip.mp4');
    await settled(ws);
    const i = records(root)[0];
    const v = (n: string): unknown => i.metrics.find((m) => m.name === n)?.value;
    expect([v('width'), v('height'), v('fps'), v('frames'), v('codec')]).toEqual([160, 120, 10, 20, 'h264']);
    expect(i.metrics.find((m) => m.name === 'codec')).toMatchObject({ tier: 'declared by the file (read, not measured)', label: "ffprobe's reading of the file; centroids by Timmy's pixel arithmetic on ffmpeg's frames" });
    await ws.detect('clip.mp4 color 255,0,0 --at 0,1');
    await settled(ws);
    const d = records(root).find((x) => x.action === 'detect')!;
    expect(d.status).toBe('ok');
    const at = (t: number) => d.metrics.find((m) => m.name === `color_at:${t}`)!.value as { found: boolean; centroid_px: number[] };
    expect(at(0).found).toBe(true);
    expect(at(0).centroid_px[0]).toBeCloseTo(10, 0);
    expect(at(0).centroid_px[1]).toBeCloseTo(50, 0);
    expect(at(1).centroid_px[0]).toBeCloseTo(40, 0);
    // The frames read are kept as highlights, each with the sha256 of its file.
    expect(d.highlights.map((h) => h.path)).toEqual([`results/vox/${d.id}/frames/frame-000000.png`, `results/vox/${d.id}/frames/frame-000010.png`]);
    for (const h of d.highlights) expect(h.sha256).toBe(sha(readFileSync(join(root, h.path))));
  });
});
