#!/usr/bin/env node
// fake-rerun.mjs: a FAKE rerun, a TEST DOUBLE of the Rerun CLI for src/vox/rrd-cli.ts (tests/rrd-cli.test.ts and the tab 6
// tests). It is NOT Rerun and decodes nothing. Installed as `rerun` first on a test's PATH (or named by TIMMY_RERUN).
//
// By default it REPLAYS outputs CAPTURED from the real rerun-cli 0.38.1 (tests/fixtures/rrd-cli/CAPTURED.json names each
// capture with its version and its command), byte for byte, with the captured exit: `rerun --version`, and
// `rerun rrd verify|stats|print -vv|print -vvv` with a recording on its standard input. It answers only for the bytes it has
// captures of (their sha256: probe.rrd, probe-cut.rrd, edge.rrd, and verify and stats of the repository's own context.rrd);
// any other input or command: exit 3, and it says so.
//
// FAKE_RERUN_MODE, one of these, each optionally for one command only (":verify", ":stats", ":print-vv", ":print-vvv"):
//   replay        the default, as above
//   version=<x>   `--version` says `rerun-cli <x> (FAKE …)`; the rest replays
//   sleep         the command starts a child (sleep 30; its pid appended to FAKE_RERUN_PIDS) and waits 30 s: a timeout
//   huge          the command writes 6 MiB to its stdout and exits 0: more than the cap
//   bad-exit      the command writes "FAKE rerun: failed on purpose" to its stderr and exits 2
//   garbage       the command writes lines that are not rerun's output and exits 0
// FAKE_RERUN_CALLS, when set: a file each call appends one JSON line to (its arguments, its mode, the sha256 of its input and
// its CI variable), so a test sees what ran and how.
// FAKE_RERUN_DELAY_MS, when set: each rrd command waits that long before it answers (so a page can be seen while it reads).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), 'rrd-cli');
const manifest = JSON.parse(readFileSync(join(here, 'CAPTURED.json'), 'utf8'));
const argv = process.argv.slice(2);
const [mode, only] = (process.env.FAKE_RERUN_MODE || 'replay').split(':');
const NAMES = { 'rrd verify': 'verify', 'rrd stats': 'stats', 'rrd print -vv': 'print-vv', 'rrd print -vvv': 'print-vvv' };
const name = NAMES[argv.join(' ')];
const applies = (m) => mode === m && (!only || only === name);

function record(sha) {
  if (!process.env.FAKE_RERUN_CALLS) return;
  appendFileSync(process.env.FAKE_RERUN_CALLS, `${JSON.stringify({ argv, mode: process.env.FAKE_RERUN_MODE || 'replay', input: sha, ci: process.env.CI ?? null })}\n`);
}
const out = (file) => (file ? readFileSync(join(here, file)) : Buffer.alloc(0));
function finish(stdout, stderr, code) {
  process.exitCode = code;
  if (stderr.length) process.stderr.write(stderr);
  if (stdout.length) process.stdout.write(stdout);
}
async function input() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks);
}

if (argv.length === 1 && argv[0] === '--version') {
  record(null);
  const m = /^version=(.+)$/.exec(mode);
  if (m) finish(Buffer.from(`rerun-cli ${m[1]} (FAKE: tests/fixtures/fake-rerun.mjs, a TEST DOUBLE; not Rerun)\n`), Buffer.alloc(0), 0);
  else {
    const call = manifest.calls.find((c) => c.command === 'rerun --version');
    finish(out(call.stdout), out(call.stderr), call.exit);
  }
} else if (!name) {
  record(null);
  finish(Buffer.alloc(0), Buffer.from(`FAKE rerun (tests/fixtures/fake-rerun.mjs): no capture for \`rerun ${argv.join(' ')}\`\n`), 3);
} else if (applies('sleep')) {
  record(null);
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  if (process.env.FAKE_RERUN_PIDS) appendFileSync(process.env.FAKE_RERUN_PIDS, `${child.pid}\n`);
  setTimeout(() => process.exit(0), 30_000);
} else {
  const body = await input();
  const sha = createHash('sha256').update(body).digest('hex');
  record(sha);
  const delay = Number(process.env.FAKE_RERUN_DELAY_MS || 0);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  if (applies('huge')) finish(Buffer.alloc(6 * 1024 * 1024, 'FAKE huge output\n'), Buffer.alloc(0), 0);
  else if (applies('bad-exit')) finish(Buffer.alloc(0), Buffer.from('FAKE rerun: failed on purpose\n'), 2);
  else if (applies('garbage')) finish(Buffer.from('FAKE: these lines are not rerun\'s output\n┆ ┆ ┆\nChunk(nothing) with many rows\n'), Buffer.alloc(0), 0);
  else {
    const file = Object.entries(manifest.files).find(([, f]) => f.sha256 === sha)?.[0];
    const call = file && manifest.calls.find((c) => c.command === `rerun ${argv.join(' ')}` && c.input === file);
    if (!call) finish(Buffer.alloc(0), Buffer.from(`FAKE rerun (tests/fixtures/fake-rerun.mjs): no capture of \`rerun ${argv.join(' ')}\` for these bytes (sha256 ${sha.slice(0, 12)})\n`), 3);
    else finish(out(call.stdout), out(call.stderr), call.exit);
  }
}
