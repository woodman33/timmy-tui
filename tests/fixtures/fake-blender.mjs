#!/usr/bin/env node
// fake-blender.mjs: a TEST DOUBLE of Blender, for tests/native-blender.test.ts. It is not Blender: it has
// no bpy and renders nothing. It reproduces only the command line and the contract Timmy's Blender jobs
// rely on:
//   blender -b --factory-startup --python-exit-code 1 --python <script.py> -- [args]
// run in the job's folder with TIMMY_RESULT, TIMMY_RUN, TIMMY_SCRIPT, TIMMY_SCRIPT_SHA256 and TIMMY_ROOT in
// its environment. Like workers/blender/timmy_blender.py, it echoes TIMMY_SCRIPT_SHA256 as script_sha256
// and the script's bytes as it read them as script_sha256_read.
// FAKE_BLENDER_MODE picks what it does:
//   ok          (the default) writes out/scene.blend and out/render.png and an ok result naming both with
//               their sha256 and blender_version; exits 0
//   python      runs the script with python3 (FAKE_BLENDER_PYTHON, default python3) as `<script> -- [args]`,
//               the stand-in bpy found through the job's PYTHONPATH; exits with python's status
//   no-result   writes nothing; exits 0
//   fail        writes an ok:false result with an error; exits 0 (the helper catches; the exit decides nothing)
//   wrong-run   an ok result carrying another run's token; exits 0
//   wrong-sha   an ok result echoing another script's sha256; exits 0
//   no-digest   an ok result naming out/render.png without its sha256; exits 0
//   outside     an ok result also naming ../outside.blend, written beside the project; exits 0
//   sleep       (R4, /iterate blender) waits 30 s, writing nothing, then exits 0 (for /stop)
// A command line that is not the one above exits 2, as a mistyped Blender call would fail to run the script.
//
// R4 (/iterate blender, H26): Blender started with a .blend to open, `-b <file.blend> --factory-startup ...
// --python <script> -- [args]`, is /iterate's second pass. FAKE_BLENDER_READBACK picks what it does then:
//   python  (the default) runs the script (workers/readback/blend_readback.py) with python3 (FAKE_BLENDER_PYTHON)
//           and the stand-in bpy (the job's PYTHONPATH) told to open the file (BPY_STUB_OPEN): the stand-in's
//           .blend is JSON, so this reads back what the stand-in saved; exits with python's status
//   sleep   waits 30 s, printing nothing, then exits 0 (for /stop)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_BLENDER_MODE || 'ok';
const at = argv.indexOf('--python');
const script = at >= 0 ? argv[at + 1] : undefined;
const dashes = argv.indexOf('--');
const args = dashes >= 0 ? argv.slice(dashes + 1) : [];
// R4: the file Blender is told to open, right after -b (/iterate blender's second pass)
const opened = argv[0] === '-b' && /\.blend$/i.test(argv[1] ?? '') ? argv[1] : undefined;
process.stdout.write(`fake-blender: ${argv.slice(0, dashes >= 0 ? dashes : argv.length).map((a) => (a === script || a === opened ? path.basename(a) : a)).join(' ')}\n`);
if (argv[0] !== '-b' || !argv.includes('--factory-startup') || !script || (dashes >= 0 && dashes < at)) {
  process.stderr.write('fake-blender: expected -b --factory-startup ... --python <script.py> [-- args]\n');
  process.exit(2);
}

if (opened) {
  const readback = process.env.FAKE_BLENDER_READBACK || 'python';
  if (readback === 'sleep') {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    process.exit(0);
  }
  if (readback !== 'python') {
    process.stderr.write(`fake-blender: unknown FAKE_BLENDER_READBACK ${readback}\n`);
    process.exit(2);
  }
  const py = spawnSync(process.env.FAKE_BLENDER_PYTHON || 'python3', [script, '--', ...args], { stdio: 'inherit', env: { ...process.env, BPY_STUB_OPEN: opened } });
  process.exit(py.status ?? 1);
}

if (mode === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  process.exit(0);
}

if (mode === 'python') {
  const py = spawnSync(process.env.FAKE_BLENDER_PYTHON || 'python3', [script, '--', ...args], { stdio: 'inherit', env: process.env });
  process.exit(py.status ?? 1);
}

const root = process.env.TIMMY_ROOT || process.cwd();
const resultPath = process.env.TIMMY_RESULT;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let read;
try { read = sha(readFileSync(script)); } catch { read = undefined; }
const writeResult = (body) => {
  if (!resultPath) return;
  mkdirSync(path.dirname(resultPath), { recursive: true });
  const bound = { script_sha256: mode === 'wrong-sha' ? '0'.repeat(64) : process.env.TIMMY_SCRIPT_SHA256, script_sha256_read: read, blender_version: '4.2.0 (fake)', ...body };
  writeFileSync(`${resultPath}.tmp`, `${JSON.stringify(bound, null, 2)}\n`);
  renameSync(`${resultPath}.tmp`, resultPath);
};
const blend = Buffer.from('fake blend bytes\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const writeOutputs = () => {
  mkdirSync(path.join(root, 'out'), { recursive: true });
  writeFileSync(path.join(root, 'out', 'scene.blend'), blend);
  writeFileSync(path.join(root, 'out', 'render.png'), png);
};
const run = mode === 'wrong-run' ? 'another-run' : process.env.TIMMY_RUN;
const both = () => ({ 'out/scene.blend': sha(blend), 'out/render.png': sha(png) });

switch (mode) {
  case 'ok':
  case 'wrong-run':
  case 'wrong-sha':
    writeOutputs();
    writeResult({ ok: true, run, files: both() });
    break;
  case 'no-result':
    break;
  case 'fail':
    writeResult({ ok: false, run, files: {}, error: 'RuntimeError: render.render returned CANCELLED (fake)' });
    break;
  case 'no-digest':
    writeOutputs();
    writeResult({ ok: true, run, files: { 'out/scene.blend': sha(blend), 'out/render.png': '' } });
    break;
  case 'outside': {
    writeOutputs();
    const away = Buffer.from('beside the project\n');
    writeFileSync(path.join(root, '..', 'outside.blend'), away);
    writeResult({ ok: true, run, files: { ...both(), '../outside.blend': sha(away) } });
    break;
  }
  default:
    process.stderr.write(`fake-blender: unknown FAKE_BLENDER_MODE ${mode}\n`);
    process.exit(2);
}
process.exit(0);
