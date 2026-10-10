#!/usr/bin/env node
// fake-native-app.mjs: a TEST DOUBLE standing in for c4dpy or Blender, for tests/native-provenance-r4.test.ts.
// It is neither: it runs no Python and has no Cinema 4D or Blender in it. It finds the script it runs on its
// command line the way each app does:
//   c4dpy <script.py> [args]
//   blender -b --factory-startup --python-exit-code 1 --python <script.py> -- [args]
// "Running" the script is reading that file once, as Python reads a script when it starts it. The result
// reports what it read under `fixture` (the test's ground truth for what ran, which the judgement ignores).
// It reproduces the windows round R4 closes (review of 07f37ec, findings 5 and 6):
//   FAKE_READY_FILE, FAKE_GO_FILE  once started, it writes FAKE_READY_FILE and waits (at most 10 s) for
//                    FAKE_GO_FILE before it reads its script: a test edits the original script in that
//                    window, after the run has started (as an editor saving during c4dpy's long start would)
//   always           it also reads the ORIGINAL script's path while it runs (TIMMY_SCRIPT_ORIGINAL, or
//                    TIMMY_SCRIPT where that is unset) and reports that file's sha256 as it saw it
//   FAKE_READ_DIGEST omit (the default): the result carries no script_sha256_read
//                    executed: script_sha256_read is the sha256 of the file it ran
//                    original: script_sha256_read is the sha256 of the original path as it read it
//   FAKE_TAMPER=1    after reading its script, it makes that file writable and rewrites it
//   FAKE_OUTPUT      a file under TIMMY_ROOT the result names with its sha256 (default out/scene.bin)
//   FAKE_WRITE       write (the default): writes FAKE_BYTES (default "fake scene bytes\n") to FAKE_OUTPUT first
//                    keep: writes nothing and names FAKE_OUTPUT as it already is (an old file, its correct sha256)
//                    link: makes FAKE_OUTPUT a symbolic link to FAKE_LINK_TO (a file under TIMMY_ROOT) and names
//                    it with the sha256 of the bytes it leads to
//                    none: names no file
// It writes an ok result with this run's token (TIMMY_RUN) and the submitted sha256 echoed
// (TIMMY_SCRIPT_SHA256), then exits 0.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const at = argv.indexOf('--python');
const script = at >= 0 ? argv[at + 1] : argv[0];
process.stdout.write(`fake-native-app: ${path.basename(script ?? '(no script)')}\n`);
if (!script) { process.stderr.write('fake-native-app: no script given\n'); process.exit(2); }

const env = process.env;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaOf = (file) => { try { return sha(readFileSync(file)); } catch { return null; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (env.FAKE_READY_FILE) writeFileSync(env.FAKE_READY_FILE, `${process.pid}\n`);
if (env.FAKE_GO_FILE) {
  const until = Date.now() + 10_000;
  while (!existsSync(env.FAKE_GO_FILE)) {
    if (Date.now() > until) { process.stderr.write('fake-native-app: no go file within 10 s\n'); process.exit(3); }
    sleep(20);
  }
}

// What runs: the bytes of the file the command line names, read once.
const executed = shaOf(script);
// The original script's path, read while the run goes on.
const original = env.TIMMY_SCRIPT_ORIGINAL || env.TIMMY_SCRIPT;
const originalSeen = original ? shaOf(original) : null;
if (env.FAKE_TAMPER === '1') {
  chmodSync(script, 0o644);
  writeFileSync(script, '# rewritten by the app while it ran\n');
}

const root = env.TIMMY_ROOT || process.cwd();
const output = env.FAKE_OUTPUT || 'out/scene.bin';
const outAbs = path.join(root, output);
const files = {};
const write = env.FAKE_WRITE || 'write';
if (write === 'write') {
  mkdirSync(path.dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, env.FAKE_BYTES ?? 'fake scene bytes\n');
}
if (write === 'link') {
  mkdirSync(path.dirname(outAbs), { recursive: true });
  symlinkSync(path.join(root, env.FAKE_LINK_TO || 'missing'), outAbs);
}
if (write !== 'none') {
  const now = shaOf(outAbs);
  if (now) files[output] = now;
}

const readMode = env.FAKE_READ_DIGEST || 'omit';
const read = readMode === 'executed' ? { script_sha256_read: executed } : readMode === 'original' ? { script_sha256_read: originalSeen } : {};
const result = {
  ok: true, run: env.TIMMY_RUN, script_sha256: env.TIMMY_SCRIPT_SHA256, ...read, files,
  fixture: { executed_sha256: executed, original_sha256_seen: originalSeen, executed_name: path.basename(script) },
};
if (env.TIMMY_RESULT) {
  mkdirSync(path.dirname(env.TIMMY_RESULT), { recursive: true });
  writeFileSync(`${env.TIMMY_RESULT}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(`${env.TIMMY_RESULT}.tmp`, env.TIMMY_RESULT);
}
process.exit(0);
