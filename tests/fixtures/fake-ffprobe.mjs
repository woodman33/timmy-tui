#!/usr/bin/env node
// fake-ffprobe.mjs: a TEST DOUBLE of FFmpeg's ffprobe, for the video readback (workers/readback/video_readback.py) and
// /iterate ae. It is NOT ffprobe and decodes nothing. It reads only the FAKE videos tests/fixtures/fake-aerender.mjs
// writes (a first line naming that fake, then JSON: width, height, fps, frames, duration...) and answers the one command
// line the worker builds:
//   ffprobe -v error -select_streams v:0 -count_packets -show_entries <entries> -of json <file>
// with JSON shaped like ffprobe's own (-of json): {"programs": [], "streams": [{...}], "format": {...}}, each number as
// ffprobe writes it (a string where ffprobe writes a string). `ffprobe -version` says it is this fake.
// Any other file: "Invalid data found when processing input" on stderr and exit 1, as ffprobe says it.
// FAKE_FFPROBE_MODE: ok (the default); garbage (prints a line that is not JSON, exits 0); no-frames (leaves out
// nb_frames and nb_read_packets); sleep (waits 30 s, for /stop).
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_FFPROBE_MODE || 'ok';
if (argv[0] === '-version') {
  process.stdout.write('ffprobe version 0.0.0-fake (tests/fixtures/fake-ffprobe.mjs, a TEST DOUBLE; not FFmpeg\'s ffprobe) Copyright (c) nobody\n');
  process.exit(0);
}
if (mode === 'sleep') setTimeout(() => process.exit(0), 30_000);
else {
  const file = argv.at(-1);
  let video;
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('FAKE-VIDEO')) throw new Error('not a fake video');
    video = JSON.parse(text.slice(text.indexOf('\n') + 1));
  } catch {
    process.stderr.write(`${file}: Invalid data found when processing input (fake-ffprobe)\n`);
    process.exit(1);
  }
  if (mode === 'garbage') { process.stdout.write('this is not JSON (fake-ffprobe, FAKE_FFPROBE_MODE=garbage)\n'); process.exit(0); }
  const fixed = (n) => n.toFixed(6);
  const stream = {
    codec_name: video.codec, width: video.width, height: video.height, pix_fmt: video.pix_fmt,
    r_frame_rate: `${video.fps[0]}/${video.fps[1]}`, avg_frame_rate: `${video.fps[0]}/${video.fps[1]}`,
    start_time: fixed(0), duration: fixed(video.duration),
    ...(mode === 'no-frames' ? {} : { nb_frames: String(video.frames), nb_read_packets: String(video.frames) }),
  };
  process.stdout.write(`${JSON.stringify({ programs: [], streams: [stream], format: { format_name: video.container, start_time: fixed(0), duration: fixed(video.duration) } }, null, 4)}\n`);
  process.exit(0);
}
