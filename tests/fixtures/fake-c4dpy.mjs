#!/usr/bin/env node
// fake-c4dpy.mjs: a TEST DOUBLE of Cinema 4D's c4dpy, for tests/native.test.ts. It is not c4dpy: it runs
// no Python and has no Cinema 4D in it. It reproduces only the contract Timmy's native jobs rely on:
//   c4dpy <script.py> [args]   run in the job's folder, with TIMMY_RESULT (where the script writes its
//                              result file), TIMMY_RUN (this run's token), TIMMY_SCRIPT_SHA256 (the
//                              script's sha256 at submission, echoed back) and TIMMY_ROOT (the project
//                              folder) in its environment
// and one behaviour retained from an earlier real run on the operator's machine: the script's result
// file said ok:true while the c4dpy process exited with code 1. Like workers/c4d/timmy_c4d.py it echoes
// TIMMY_SCRIPT_SHA256 as script_sha256 and records the script's bytes as it read them (script_sha256_read).
// FAKE_C4DPY_MODE picks what it does:
//   ok-exit-1  (the default) writes out/scene.c4d and out/still.png under TIMMY_ROOT and a result file
//              that says ok, with their sha256, then exits 1
//   no-result  writes nothing and exits 0
//   fail       writes a result file with ok:false and the error, then exits 1
//   lie        writes a result file that says ok and names out/scene.c4d without writing it; exits 0
//   stale      writes an ok result file with another run's token, and both files; exits 0
//   no-sha     as ok-exit-1, but the result does not echo the script's sha256; exits 0
//   wrong-sha  as ok-exit-1, but the result echoes another script's sha256; exits 0
//   no-digest  as ok-exit-1, but out/still.png is named without its sha256; exits 0
//   outside    as ok-exit-1, and also names ../outside.bin (a file it writes beside the project); exits 0
//   one-named  writes both files but names only out/scene.c4d in the result; exits 0
//   hang       prints a line and waits until it is stopped
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_C4DPY_MODE || 'ok-exit-1';
const [script, ...args] = process.argv.slice(2);
const root = process.env.TIMMY_ROOT || process.cwd();
const resultPath = process.env.TIMMY_RESULT;
const run = process.env.TIMMY_RUN;
const echo = process.env.TIMMY_SCRIPT_SHA256;
const started = new Date().toISOString();

process.stdout.write(`fake-c4dpy: ${path.basename(script ?? '(no script)')} ${args.join(' ')}\n`);
if (!script) { process.stderr.write('fake-c4dpy: no script given\n'); process.exit(2); }

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let read;
try { read = sha(readFileSync(script)); } catch { read = undefined; }
const writeResult = (body) => {
  if (!resultPath) return;
  mkdirSync(path.dirname(resultPath), { recursive: true });
  const temp = `${resultPath}.tmp`;
  const bound = { ...(mode === 'no-sha' ? {} : { script_sha256: mode === 'wrong-sha' ? 'f'.repeat(64) : echo, script_sha256_read: read }), ...body };
  writeFileSync(temp, `${JSON.stringify(bound, null, 2)}\n`);
  renameSync(temp, resultPath);
};
const scene = Buffer.from('fake c4d document bytes\n');
// the PNG signature and nothing else: enough bytes to hash, not an image
const still = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const writeOutputs = () => {
  mkdirSync(path.join(root, 'out'), { recursive: true });
  writeFileSync(path.join(root, 'out', 'scene.c4d'), scene);
  writeFileSync(path.join(root, 'out', 'still.png'), still);
};
const timing = () => ({ started, ended: new Date().toISOString() });
const both = () => ({ 'out/scene.c4d': sha(scene), 'out/still.png': sha(still) });

switch (mode) {
  case 'ok-exit-1':
    writeOutputs();
    writeResult({ ok: true, run, files: both(), c4d_version: 2026000, timing: timing() });
    process.stderr.write('fake-c4dpy: exiting with code 1, as the retained real run did\n');
    process.exit(1);
    break;
  case 'no-result':
    process.exit(0);
    break;
  case 'fail':
    writeResult({ ok: false, run, error: 'RenderDocument returned 1 (fake)', files: {}, c4d_version: 2026000, timing: timing() });
    process.exit(1);
    break;
  case 'lie':
    writeResult({ ok: true, run, files: { 'out/scene.c4d': sha(scene) }, c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  case 'stale':
    writeOutputs();
    writeResult({ ok: true, run: 'another-run', files: both(), c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  case 'no-sha':
  case 'wrong-sha':
    writeOutputs();
    writeResult({ ok: true, run, files: both(), c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  case 'no-digest':
    writeOutputs();
    writeResult({ ok: true, run, files: { 'out/scene.c4d': sha(scene), 'out/still.png': null }, c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  case 'outside': {
    writeOutputs();
    const away = Buffer.from('written beside the project\n');
    writeFileSync(path.join(root, '..', 'outside.bin'), away);
    writeResult({ ok: true, run, files: { ...both(), '../outside.bin': sha(away) }, c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  }
  case 'one-named':
    writeOutputs();
    writeResult({ ok: true, run, files: { 'out/scene.c4d': sha(scene) }, c4d_version: 2026000, timing: timing() });
    process.exit(0);
    break;
  case 'hang':
    setInterval(() => undefined, 1000);
    break;
  default:
    process.stderr.write(`fake-c4dpy: unknown FAKE_C4DPY_MODE ${mode}\n`);
    process.exit(2);
}
