#!/usr/bin/env node
// fake-ffmpeg.mjs: a TEST DOUBLE of FFmpeg's ffmpeg, for the video readback (workers/readback/video_readback.py) and
// /iterate ae. It is NOT ffmpeg: it decodes nothing and encodes nothing. It reads only the FAKE videos
// tests/fixtures/fake-aerender.mjs writes (JSON describing a comp: its size, frame rate, frame count, a background colour
// and coloured rectangles with Position keys) and answers the one command line the worker builds:
//   ffmpeg -v error -nostdin [-ss <seconds>] -i <file> -map 0:v:0 -frames:v 1 -vf scale=<w>:<h>:flags=area
//          -f rawvideo -pix_fmt rgb24 -
// It picks the frame as ffmpeg's input seeking does (the first frame at or after -ss; frame 0 without it), draws that
// frame at <w> x <h>: the background, then each rectangle shown at that time (in <= t < out), bottom first, at its
// Position linearly interpolated between keys (held before the first and after the last), each pixel the area-weighted
// mix of what covers it (as an area scale of a full-size frame would give), and writes its raw RGB bytes to stdout.
// Past the last frame it writes nothing and exits 0 (ffmpeg's "Output file is empty, nothing was encoded").
// `ffmpeg -version` says it is this fake. Any other file: "Invalid data found when processing input", exit 1.
// FAKE_FFMPEG_MODE: ok (the default); error (exit 1 with a message); short (half a frame's bytes); sleep (waits 30 s).
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_FFMPEG_MODE || 'ok';
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv[0] === '-version') {
  process.stdout.write('ffmpeg version 0.0.0-fake (tests/fixtures/fake-ffmpeg.mjs, a TEST DOUBLE; not FFmpeg\'s ffmpeg) Copyright (c) nobody\n');
  process.exit(0);
}
if (mode === 'sleep') setTimeout(() => process.exit(0), 30_000);
else run();

function run() {
  const file = flag('-i');
  let video;
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('FAKE-VIDEO')) throw new Error('not a fake video');
    video = JSON.parse(text.slice(text.indexOf('\n') + 1));
  } catch {
    process.stderr.write(`${file}: Invalid data found when processing input (fake-ffmpeg)\n`);
    process.exit(1);
  }
  if (mode === 'error') { process.stderr.write('Error while decoding stream #0:0: Invalid data found when processing input (fake-ffmpeg, FAKE_FFMPEG_MODE=error)\n'); process.exit(1); }
  const scale = /^scale=(\d+):(\d+)(?::flags=area)?$/.exec(flag('-vf') ?? '');
  if (!scale || flag('-f') !== 'rawvideo' || flag('-pix_fmt') !== 'rgb24' || argv.at(-1) !== '-') {
    process.stderr.write('fake-ffmpeg: expected -vf scale=<w>:<h>:flags=area -f rawvideo -pix_fmt rgb24 - (the command line the readback builds)\n');
    process.exit(2);
  }
  const [w, h] = [Number(scale[1]), Number(scale[2])];
  const fps = video.fps[0] / video.fps[1];
  const ss = flag('-ss') === undefined ? 0 : Number(flag('-ss'));
  const n = Math.max(0, Math.ceil(ss * fps - 1e-9));
  if (n >= video.frames) process.exit(0);
  const t = n / fps;
  const sx = video.width / w;
  const sy = video.height / h;
  const to8 = (c) => c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  const px = new Float64Array(w * h * 3);
  const bg = to8(video.background);
  for (let i = 0; i < w * h; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
  for (const sq of video.squares) {
    if (!(t >= sq.in && t < sq.out)) continue;
    const [cx, cy] = at(sq.keys, t);
    const [x0, y0, x1, y1] = [cx - sq.size[0] / 2, cy - sq.size[1] / 2, cx + sq.size[0] / 2, cy + sq.size[1] / 2];
    const col = to8(sq.color);
    for (let j = Math.max(0, Math.floor(y0 / sy)); j < Math.min(h, Math.ceil(y1 / sy)); j++) {
      const oy = Math.max(0, Math.min(y1, (j + 1) * sy) - Math.max(y0, j * sy));
      for (let i = Math.max(0, Math.floor(x0 / sx)); i < Math.min(w, Math.ceil(x1 / sx)); i++) {
        const ox = Math.max(0, Math.min(x1, (i + 1) * sx) - Math.max(x0, i * sx));
        const f = (ox * oy) / (sx * sy);
        if (f <= 0) continue;
        for (let c = 0; c < 3; c++) px[(j * w + i) * 3 + c] = px[(j * w + i) * 3 + c] * (1 - f) + col[c] * f;
      }
    }
  }
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(px[i]);
  process.stdout.write(mode === 'short' ? out.subarray(0, Math.floor(out.length / 2)) : out, () => process.exit(0));
}

/** A rectangle's centre at time t: linear between keys, held before the first and after the last. */
function at(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let k = 1; k < keys.length; k++) {
    if (t <= keys[k][0]) {
      const [t0, a] = keys[k - 1];
      const [t1, b] = keys[k];
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
  }
  return keys.at(-1)[1];
}
