#!/usr/bin/env node
// fake-aerender.mjs: a TEST DOUBLE of After Effects' aerender, for tests/native.test.ts. It is not
// aerender and renders nothing. It reproduces only the command line Timmy builds:
//   aerender -project <file.aep|file.aepx> -comp "<name>" -output <file> [-s <frame>] [-e <frame>]
//            [-RStemplate <t>] [-OMtemplate <t>]
// aerender renders an EXISTING project; it cannot make or edit one. A missing project file is an error.
// An output named with [####] is an image sequence: the fake writes one file per frame, the frame number
// zero-padded to the width of the #s, from -s to -e (default 0 to 3).
// FAKE_AERENDER_MODE picks what it does once the project file is found:
//   ok           (the default) writes a few bytes to the -output file (each frame of a sequence); exits 0
//   no-output    writes nothing and exits 0
//   error        prints an error and exits 1
//   one-frame    a sequence: writes only its first frame; exits 0
//   gap          a sequence: writes every frame but the middle one; exits 0
// R4 (H41), as After Effects 2026 was seen to do (asked for out/promo-v2.mov, it wrote out/promo-v2.mp4, H.264):
//   mp4-for-mov  asked for <stem>.mov, writes <stem>.mp4 instead (any other name as asked); exits 0
//   mov-for-mp4  asked for <stem>.mp4, writes <stem>.mov instead (as a QuickTime output module would); exits 0
//   two-files    writes <stem>.mp4 and <stem>.avi, not the file asked for; exits 0
// R4 (H41): it prints the -OMtemplate it was given (recorded, never applied: it has no output modules). When the
// project is a FAKE project saved by tests/fixtures/fake-afterfx.mjs, what it writes is a FAKE video: a first line
// naming this fake, then JSON describing the comp named by -comp (its size, frame rate, frame count, its background
// solid's colour and each other solid as a coloured rectangle with its Position keys and in and out points), which
// tests/fixtures/fake-ffprobe.mjs and fake-ffmpeg.mjs read as if it were a movie. Text layers are not drawn.
// FAKE_AERENDER_SHIFT=<pixels> moves every rectangle that many pixels to the right of where the project puts it
// (a render that disagrees with its project, for the readback's "differs").
// R4 (H46): FAKE_AERENDER_LOGS=1 also writes a FAKE log into "<project file name> Logs/" beside the project (making the
// folder when it is not there), as aerender was seen to on the operator's Mac (ledger row 153).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const project = flag('-project');
const comp = flag('-comp');
const output = flag('-output');
const om = flag('-OMtemplate');
const mode = process.env.FAKE_AERENDER_MODE || 'ok';

process.stdout.write(`PROGRESS: fake-aerender ${comp ?? '(no comp)'}\n`);
if (om !== undefined) process.stdout.write(`PROGRESS: output module template "${om}" (fake-aerender: recorded, not applied; it has no output modules)\n`);
if (!project || !existsSync(project)) {
  process.stderr.write(`aerender ERROR: no project file at ${project ?? '(none given)'} (fake)\n`);
  process.exit(1);
}
if (mode === 'error') { process.stderr.write('aerender ERROR: render failed (fake)\n'); process.exit(1); }
if (process.env.FAKE_AERENDER_LOGS === '1') {
  const logs = `${project} Logs`;
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, `${path.basename(project)} RenderLog.txt`), 'FAKE render log (fake-aerender; not aerender)\n');
}

/** What to write: a FAKE video of the comp when the project is a FAKE project, else a few bytes. */
function body() {
  let text = '';
  try { text = readFileSync(project, 'utf8'); } catch { return 'fake movie bytes\n'; }
  if (!text.startsWith('FAKE-AEP')) return 'fake movie bytes\n';
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
  const c = data.comps.find((x) => x.name === comp);
  if (!c) {
    process.stderr.write(`aerender ERROR: No comp was found with the given name. (fake: ${comp})\n`);
    process.exit(1);
  }
  const shift = Number(process.env.FAKE_AERENDER_SHIFT ?? 0) || 0;
  const position = (l) => l.props.find((p) => p.at === 'ADBE Transform Group/ADBE Position');
  const solids = c.layers.filter((l) => l.kind === 'solid' && l.solid);
  // The bottom layer filling the frame is the background; every other solid is drawn as a rectangle, bottom first.
  const bottom = solids.at(-1);
  const background = bottom && bottom.solid.width >= c.width && bottom.solid.height >= c.height ? bottom.solid.color : [0, 0, 0];
  const squares = [...c.layers].reverse().filter((l) => l.kind === 'solid' && l.solid && l !== bottom).map((l) => {
    const p = position(l);
    const keys = p && p.keys.length ? p.keys.map((k) => [k.t, [k.v[0] + shift, k.v[1]]]) : [[0, [(p ? p.value[0] : c.width / 2) + shift, p ? p.value[1] : c.height / 2]]];
    return { name: l.name, color: l.solid.color, size: [l.solid.width, l.solid.height], keys, in: l.inPoint ?? 0, out: l.outPoint ?? c.duration };
  });
  const frames = Math.round(c.duration * c.frameRate);
  const video = {
    width: c.width, height: c.height, fps: [c.frameRate, 1], frames, duration: frames / c.frameRate, codec: 'h264', pix_fmt: 'yuv420p',
    container: 'mov,mp4,m4a,3gp,3g2,mj2', background, squares,
  };
  return `FAKE-VIDEO 1 (written by tests/fixtures/fake-aerender.mjs, a test double; not a video)\n${JSON.stringify(video)}\n`;
}

if (mode !== 'no-output' && output) {
  mkdirSync(path.dirname(output), { recursive: true });
  const seq = /\[(#+)\]/.exec(path.basename(output));
  const ext = path.extname(output);
  const stem = output.slice(0, output.length - ext.length);
  if (mode === 'two-files') {
    for (const e of ['.mp4', '.avi']) writeFileSync(`${stem}${e}`, body());
  } else if (mode === 'mp4-for-mov' && ext.toLowerCase() === '.mov') {
    writeFileSync(`${stem}.mp4`, body());
    process.stdout.write(`PROGRESS: wrote ${path.basename(stem)}.mp4 (fake-aerender, FAKE_AERENDER_MODE=mp4-for-mov: as an H.264 output module would)\n`);
  } else if (mode === 'mov-for-mp4' && ext.toLowerCase() === '.mp4') {
    writeFileSync(`${stem}.mov`, body());
    process.stdout.write(`PROGRESS: wrote ${path.basename(stem)}.mov (fake-aerender, FAKE_AERENDER_MODE=mov-for-mp4: as a QuickTime output module would)\n`);
  } else if (!seq) writeFileSync(output, body());
  else {
    const width = seq[1].length;
    const s = Number(flag('-s') ?? 0);
    const e = Number(flag('-e') ?? s + 3);
    const middle = Math.floor((s + e) / 2);
    for (let f = s; f <= e; f++) {
      if (mode === 'one-frame' && f !== s) continue;
      if (mode === 'gap' && f === middle) continue;
      const name = path.basename(output).replace(/\[#+\]/, String(f).padStart(width, '0'));
      writeFileSync(path.join(path.dirname(output), name), `fake frame ${f}\n`);
    }
  }
}
process.stdout.write('PROGRESS: Total Time Elapsed: 1 Seconds (fake)\n');
process.exit(0);
