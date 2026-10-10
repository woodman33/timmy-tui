/**
 * Round R4 (helper H41): the video readback worker, workers/readback/video_readback.py, run as Timmy runs it (python3 -I,
 * the real script) with ffprobe and ffmpeg given by TIMMY_FFPROBE and TIMMY_FFMPEG.
 *
 * FAKE pieces, each labelled: tests/fixtures/fake-ffprobe.mjs and fake-ffmpeg.mjs (TEST DOUBLES: they read the FAKE
 * videos tests/fixtures/fake-aerender.mjs writes, JSON describing coloured rectangles at known positions, and draw the
 * frames the worker asks for as raw RGB). So these tests check the worker's own parsing, frame choice, scaling and
 * centroid arithmetic against frames whose content is known, not FFmpeg.
 *
 * One test runs the REAL ffprobe and ffmpeg when both are on PATH (skipped otherwise): ffmpeg encodes a synthetic H.264
 * file of a square moving 3 pixels a frame, and the worker reads it back. That checks the worker against FFmpeg's own
 * output; it is not After Effects, and no After Effects render is read anywhere here.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsync } from './helpers/run-async.js';

const REPO = path.resolve(__dirname, '..');
const WORKER = path.join(REPO, 'workers', 'readback', 'video_readback.py');
const FIXTURES = path.join(__dirname, 'fixtures');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';
const onPath = (cmd: string): string | null => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, cmd))) return path.join(dir, cmd);
  }
  return null;
};
const realFfmpeg = onPath('ffmpeg') && onPath('ffprobe') ? { ffmpeg: onPath('ffmpeg')!, ffprobe: onPath('ffprobe')! } : null;

let tmp = '';
beforeEach(() => { tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-video-readback-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** An executable copy of a FAKE tool. */
function tool(fixture: string, name: string): string {
  const at = path.join(tmp, 'bin', name);
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(path.join(FIXTURES, fixture), at);
  chmodSync(at, 0o755);
  return at;
}
/** A FAKE video, as tests/fixtures/fake-aerender.mjs writes one: the starter's Mover crossing the frame, moved `shift` pixels. */
function fakeVideo(name: string, o: { shift?: number; frames?: number } = {}): string {
  const s = o.shift ?? 0;
  const v = {
    width: 1920, height: 1080, fps: [30, 1], frames: o.frames ?? 300, duration: (o.frames ?? 300) / 30, codec: 'h264', pix_fmt: 'yuv420p', container: 'mov,mp4,m4a,3gp,3g2,mj2',
    background: [0.07, 0.07, 0.08], squares: [{ name: 'Mover', color: [0.2, 0.75, 0.4], size: [160, 160], keys: [[0, [240 + s, 760]], [2, [1680 + s, 760]]], in: 0, out: 10 }],
  };
  const at = path.join(tmp, name);
  writeFileSync(at, `FAKE-VIDEO 1 (written by tests/video-readback.test.ts, a test double; not a video)\n${JSON.stringify(v)}\n`);
  return at;
}
function plan(targets: Array<{ layer: string; colour: number[]; times: number[] }>, comp = { width: 1920, height: 1080, start: 0 }): string {
  const at = path.join(tmp, `plan-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(at, JSON.stringify({ schema: 'timmy.video-readback-plan/1', comp, targets }));
  return at;
}
const MOVER = { layer: 'Mover', colour: [0.2, 0.75, 0.4], times: [0, 1, 2] };
async function worker(args: string[], env: Record<string, string | undefined> = {}): Promise<{ status: number | null; out: Record<string, any>; stderr: string }> {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  const r = await runAsync(python, ['-I', WORKER, ...args], { env: e, timeout: 60_000 });
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  return { status: r.status, out: JSON.parse(line || '{}'), stderr: r.stderr };
}
const fakes = (): Record<string, string> => ({ TIMMY_FFPROBE: tool('fake-ffprobe.mjs', 'ffprobe'), TIMMY_FFMPEG: tool('fake-ffmpeg.mjs', 'ffmpeg') });

describe.skipIf(!python)('the video readback worker, with the FAKE ffprobe and ffmpeg', () => {
  it('reports the probe, the scale it read at, and each centroid in video and comp pixels; writes each frame as a PNG', async () => {
    const video = fakeVideo('promo-v2.mp4');
    const frames = path.join(tmp, 'frames');
    const { status, out } = await worker([video, '--plan', plan([MOVER, { layer: 'Late', colour: [1, 0, 0], times: [12] }]), '--frames-dir', frames, '--as', 'out/ae/promo-v2.mp4'], fakes());
    expect(status).toBe(0);
    expect(out).toMatchObject({
      ok: true, worker: { name: 'timmy-video-readback', version: '0.1.0' }, unchanged_during_read: true,
      source: { name: 'out/ae/promo-v2.mp4', sha256: sha(readFileSync(video)), bytes: readFileSync(video).length },
      tools: { ffprobe: { found: 'env', version: expect.stringContaining('0.0.0-fake') }, ffmpeg: { found: 'env', version: expect.stringContaining('0.0.0-fake') } },
      probe: { codec: 'h264', width: 1920, height: 1080, fps: [30, 1], fps_value: 30, duration: 10, frames: 300, frames_from: "nb_frames (the container's count)" },
      scale: 4, scaled: [480, 270], scale_factors: [4, 4], scale_filter: 'scale=480:270:flags=area', colour_tolerance: 48, colour_metric: 'Euclidean distance in 8-bit RGB',
      scope: "measured from the rendered file by ffprobe, ffmpeg and Timmy's pixel reading, outside After Effects; it checks the render against After Effects' own report, not After Effects' renderer itself",
    });
    expect(out.samples).toEqual([
      { layer: 'Mover', time: 0, frame: 0, frame_time: 0, colour_rgb8: [51, 191, 102], pixels: 1600, found: true, centroid_video: [240, 760], centroid_comp: [240, 760], box_video: [160, 680, 320, 840] },
      { layer: 'Mover', time: 1, frame: 30, frame_time: 1, colour_rgb8: [51, 191, 102], pixels: 1600, found: true, centroid_video: [960, 760], centroid_comp: [960, 760], box_video: [880, 680, 1040, 840] },
      { layer: 'Mover', time: 2, frame: 60, frame_time: 2, colour_rgb8: [51, 191, 102], pixels: 1600, found: true, centroid_video: [1680, 760], centroid_comp: [1680, 760], box_video: [1600, 680, 1760, 840] },
      { layer: 'Late', time: 12, frame: 360, frame_time: 12, colour_rgb8: [255, 0, 0], why: "past the render's last frame (frame 299)" },
    ]);
    expect(out.frames.map((f: { frame: number }) => f.frame)).toEqual([0, 30, 60]);
    for (const f of out.frames) {
      const png = readFileSync(path.join(frames, f.png));
      expect(f).toMatchObject({ written: true, sha256: sha(png), bytes: png.length });
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.readUInt32BE(16)).toBe(480);
      expect(png.readUInt32BE(20)).toBe(270);
    }
    expect(JSON.stringify(out)).not.toContain(tmp);
    // A second read into the same folder leaves the frames there as they are, and says so.
    const again = await worker([video, '--plan', plan([MOVER]), '--frames-dir', frames], fakes());
    expect(again.out.frames[0]).toMatchObject({ png: 'frame-000000.png', written: false, why: 'a file of that name was already there; it was left as it is' });
  });

  it('a render that puts the square elsewhere is measured where it is; a comp twice the render\'s size is measured in comp pixels', async () => {
    const shifted = await worker([fakeVideo('shifted.mp4', { shift: 200 }), '--plan', plan([{ ...MOVER, times: [1] }])], fakes());
    expect(shifted.out.samples[0]).toMatchObject({ found: true, centroid_video: [1160, 760], centroid_comp: [1160, 760] });
    const big = await worker([fakeVideo('a.mp4'), '--plan', plan([{ ...MOVER, times: [0] }], { width: 3840, height: 2160, start: 0 })], fakes());
    expect(big.out.samples[0]).toMatchObject({ centroid_video: [240, 760], centroid_comp: [480, 1520] });
    // A colour nobody drew: zero pixels, not found (never a centroid made up)
    const none = await worker([fakeVideo('b.mp4'), '--plan', plan([{ layer: 'Blue', colour: [0, 0, 1], times: [0] }])], fakes());
    expect(none.out.samples[0]).toEqual({ layer: 'Blue', time: 0, frame: 0, frame_time: 0, colour_rgb8: [0, 0, 255], pixels: 0, found: false });
  });

  it('a work area that starts later: frame n shows comp time start + n / fps', async () => {
    const { out } = await worker([fakeVideo('c.mp4'), '--plan', plan([{ ...MOVER, times: [1.5, 0.5] }], { width: 1920, height: 1080, start: 0.5 })], fakes());
    expect(out.samples.map((s: { frame: number; frame_time: number }) => [s.frame, s.frame_time])).toEqual([[30, 1.5], [0, 0.5]]);
  });

  it('what fails is said, never filled in: no tools, a setting that names nothing, not JSON, a frame ffmpeg cannot give, a bad plan, usage', async () => {
    const video = fakeVideo('d.mp4');
    const p = plan([MOVER]);
    const empty = path.join(tmp, 'empty-bin');
    mkdirSync(empty);
    const none = await worker([video, '--plan', p], { TIMMY_FFPROBE: undefined, TIMMY_FFMPEG: undefined, PATH: empty });
    expect(none).toMatchObject({ status: 3, out: { ok: false, error: { code: 'no-ffmpeg', message: 'ffprobe and ffmpeg were not found: TIMMY_FFPROBE and TIMMY_FFMPEG are not set, and neither is on PATH. Setup: brew install ffmpeg (it brings both)' } } });
    const broken = await worker([video, '--plan', p], { ...fakes(), TIMMY_FFMPEG: path.join(tmp, 'nothing-here') });
    expect(broken).toMatchObject({ status: 3, out: { ok: false, error: { code: 'no-ffmpeg', message: 'TIMMY_FFMPEG is set, but nothing runnable is there' } } });
    const garbage = await worker([video, '--plan', p], { ...fakes(), FAKE_FFPROBE_MODE: 'garbage' });
    expect(garbage).toMatchObject({ status: 2, out: { ok: false, error: { code: 'ffprobe-output' } } });
    const notVideo = path.join(tmp, 'notes.mp4');
    writeFileSync(notVideo, 'not a video at all');
    const bad = await worker([notVideo, '--plan', p, '--as', 'out/notes.mp4'], fakes());
    expect(bad).toMatchObject({ status: 2, out: { ok: false, error: { code: 'ffprobe-failed', message: 'ffprobe exited 1: out/notes.mp4: Invalid data found when processing input (fake-ffprobe)' } } });
    expect(JSON.stringify(bad.out)).not.toContain(tmp);
    const decode = await worker([video, '--plan', p], { ...fakes(), FAKE_FFMPEG_MODE: 'error' });
    expect(decode.status).toBe(0);
    expect(decode.out.samples[0]).toMatchObject({ frame: 0, why: expect.stringMatching(/^ffmpeg gave no frame for frame 0 \(it exited 1\): Error while decoding stream/) });
    expect(decode.out.samples[0].centroid_comp).toBeUndefined();
    const short = await worker([video, '--plan', p], { ...fakes(), FAKE_FFMPEG_MODE: 'short' });
    expect(short.out.samples[1].why).toBe('ffmpeg gave 194400 bytes, not 480 x 270 x 3 = 388800 for frame 30');
    const counted = await worker([video, '--plan', p], { ...fakes(), FAKE_FFPROBE_MODE: 'no-frames' });
    expect(counted.out.probe).toMatchObject({ frames: null, frames_from: null, duration: 10 });
    writeFileSync(path.join(tmp, 'bad-plan.json'), JSON.stringify({ schema: 'timmy.video-readback-plan/1', comp: { width: 1920, height: 1080 }, targets: [{ layer: 'X', colour: [2, 0, 0], times: [0] }] }));
    expect(await worker([video, '--plan', path.join(tmp, 'bad-plan.json')], fakes())).toMatchObject({ status: 2, out: { error: { code: 'plan', message: 'the target "X" has no colour as [r, g, b] in 0..1' } } });
    expect(await worker([video], fakes())).toMatchObject({ status: 64, out: { error: { code: 'usage' } } });
  });
});

/** Raw RGB frames of a 320x180 synthetic clip: a dark ground and a 40x40 green square whose left edge is 20 + 3n at frame n. */
function synthetic(frames: number): Buffer {
  const [w, h] = [320, 180];
  const out = Buffer.alloc(w * h * 3 * frames);
  for (let n = 0; n < frames; n++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((n * h + y) * w + x) * 3;
        const inSquare = x >= 20 + 3 * n && x < 60 + 3 * n && y >= 100 && y < 140;
        out[i] = inSquare ? 51 : 18; out[i + 1] = inSquare ? 191 : 18; out[i + 2] = inSquare ? 102 : 20;
      }
    }
  }
  return out;
}

describe.skipIf(!python || !realFfmpeg)('the video readback worker with the REAL ffprobe and ffmpeg (when on PATH), on a clip ffmpeg encodes itself', () => {
  it('finds a moving square within a pixel of where it was drawn, frame by frame, in an H.264 file', async () => {
    const clip = path.join(tmp, 'square.mp4');
    await new Promise<void>((resolve, reject) => {
      const p = spawn(realFfmpeg!.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x180', '-r', '30', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', clip], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (b: Buffer) => { err += b.toString(); });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
      p.stdin.end(synthetic(60));
    });
    const { status, out } = await worker([clip, '--plan', plan([{ layer: 'Square', colour: [0.2, 0.75, 0.4], times: [0, 0.5, 1, 59 / 30] }], { width: 320, height: 180, start: 0 })], { TIMMY_FFPROBE: realFfmpeg!.ffprobe, TIMMY_FFMPEG: realFfmpeg!.ffmpeg });
    expect(status).toBe(0);
    expect(out.tools.ffmpeg.version).toMatch(/^ffmpeg version /);
    expect(out.probe).toMatchObject({ codec: 'h264', width: 320, height: 180, fps: [30, 1], frames: 60 });
    expect(out.scale).toBe(1);
    for (const s of out.samples) {
      expect(s.found, `frame ${s.frame}`).toBe(true);
      expect(Math.abs(s.centroid_comp[0] - (40 + 3 * s.frame)), `frame ${s.frame} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(s.centroid_comp[1] - 120), `frame ${s.frame} y`).toBeLessThanOrEqual(1);
    }
    expect(out.samples.map((s: { frame: number }) => s.frame)).toEqual([0, 15, 30, 59]);
  }, 60_000);
});
