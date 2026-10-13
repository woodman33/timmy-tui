#!/usr/bin/env node
/**
 * timmy_scad_run.mjs: runs OpenSCAD for one Timmy run (round R4, helper H27). src/native/openscad.ts writes this
 * run's configuration and judges what this program records. Plain Node, no dependencies.
 *
 * Usage: node timmy_scad_run.mjs <runner-config.json>
 *
 * The configuration (written by Timmy at submission, read-only, its sha256 in the run's scad.json) names the
 * program, the folder to run in and each step's arguments. The steps run one after another, each OpenSCAD in its
 * own process inside this job's process group, so /stop and the time limit reach it:
 *   version  `openscad --version`; its answer is kept and decides nothing (a failure is recorded, the run goes on)
 *   export   the STL, first with the summary options (--summary all --summary-file <file>); when OpenSCAD refuses
 *            them (a build without them answers "unrecognised option '--summary'" and exits non-zero), that line
 *            is kept and the export runs again without them
 *   png      the preview, when asked, and only after the export exited 0
 * Each step's stdout and stderr pass through to this job's output and are kept, each in its own file in the run's
 * folder (up to max_log_bytes; past it the rest passes through and is counted, not kept), with the sha256 of what
 * was kept. runner.json records every step: its arguments, its exit status or signal, an error starting it, and
 * those files. It is rewritten (a temporary file renamed over it) as each step starts and ends; a stop (SIGTERM,
 * SIGINT, SIGHUP) records itself before this process ends.
 *
 * Exit status: the export's own, or 127 when OpenSCAD could not be started, 1 when the export ended by a signal,
 * 64 when the configuration cannot be used.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const iso = () => new Date().toISOString();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** How a build without the summary options refuses them (Boost's wording, either spelling). */
const REFUSED = /(?:unrecogni[sz]ed|unknown) option[^\n]*--summary/i;

function refuse(message) {
  process.stderr.write(`timmy_scad_run: ${message}\n`);
  process.exit(64);
}

const configPath = process.argv[2];
if (!configPath) refuse('usage: timmy_scad_run.mjs <runner-config.json>');
let configBytes;
let config;
try {
  configBytes = readFileSync(configPath);
  config = JSON.parse(configBytes.toString('utf8'));
} catch (e) {
  refuse(`the configuration cannot be read: ${e instanceof Error ? e.message : String(e)}`);
}
const text = (s) => typeof s === 'string' && s.length > 0;
const words = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
const steps = config && typeof config.steps === 'object' ? config.steps : undefined;
if (!config || config.record !== 'timmy-scad-runner-config' || config.v !== 1 || !text(config.run) || !text(config.program)
  || !text(config.out) || !text(config.logs) || !steps || !steps.export || !words(steps.export.args)
  || (steps.export.fallback !== undefined && !words(steps.export.fallback.args))
  || (steps.version !== undefined && !words(steps.version.args)) || (steps.png !== undefined && !words(steps.png.args))) {
  refuse('the configuration is not a timmy-scad-runner-config, version 1');
}
const limit = Number.isInteger(config.max_log_bytes) && config.max_log_bytes > 0 ? config.max_log_bytes : 8 * 1024 * 1024;
try { mkdirSync(config.logs, { recursive: true }); } catch (e) { refuse(`the log folder cannot be made: ${e instanceof Error ? e.message : String(e)}`); }

const record = {
  record: 'timmy-scad-runner', v: 1, run: config.run, config_sha256: sha(configBytes), pid: process.pid, started_at: iso(),
  steps: [], summary: { state: steps.export.fallback ? 'requested' : 'not requested' },
};

function save() {
  const tmp = `${config.out}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, config.out);
  } catch (e) {
    process.stderr.write(`timmy_scad_run: runner.json could not be written: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** One stream kept in a file: everything counted, up to `limit` bytes kept and hashed. */
function keeper(file) {
  const fd = openSync(file, 'wx', 0o600);
  return { file, fd, bytes: 0, kept: 0, hash: createHash('sha256'), closed: undefined };
}
function keep(k, chunk) {
  k.bytes += chunk.length;
  const room = limit - k.kept;
  if (room <= 0 || k.closed) return;
  const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
  try { writeSync(k.fd, part); k.hash.update(part); k.kept += part.length; } catch { /* a full disk loses kept text, not the run */ }
}
function close(k) {
  if (!k.closed) {
    try { closeSync(k.fd); } catch { /* closed already */ }
    k.closed = { file: path.basename(k.file), bytes: k.bytes, kept: k.kept, sha256: k.hash.digest('hex'), truncated: k.bytes > k.kept };
  }
  return k.closed;
}

/** The step under way, for a stop that lands during it. */
let current;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    record.interrupted = sig;
    if (current) {
      current.step.interrupted = sig;
      current.step.ended_at = iso();
      current.step.stdout = close(current.out);
      current.step.stderr = close(current.err);
    }
    record.ended_at = iso();
    save();
    process.exit(sig === 'SIGTERM' ? 143 : sig === 'SIGINT' ? 130 : 129);
  });
}

function runStep(name, args, attempt) {
  return new Promise((resolve) => {
    const tag = attempt > 1 ? `${name}-${attempt}` : name;
    let out;
    let err;
    try {
      out = keeper(path.join(config.logs, `${tag}.stdout`));
      err = keeper(path.join(config.logs, `${tag}.stderr`));
    } catch (e) {
      refuse(`the ${tag} log files cannot be made (each run's are new): ${e instanceof Error ? e.message : String(e)}`);
    }
    const step = { name, attempt, args, started_at: iso(), exit_code: null, signal: null };
    record.steps.push(step);
    current = { step, out, err };
    save();
    process.stdout.write(`timmy-scad: ${name}${attempt > 1 ? `, again without the summary options (attempt ${attempt})` : ''}\n`);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      step.ended_at = iso();
      step.stdout = close(out);
      step.stderr = close(err);
      current = undefined;
      save();
      process.stdout.write(`timmy-scad: ${name} ${step.error ? `did not start (${step.error})` : step.signal ? `ended by ${step.signal}` : `exited ${step.exit_code}`}\n`);
      resolve(step);
    };
    let child;
    try {
      child = spawn(config.program, args, { cwd: text(config.cwd) ? config.cwd : process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      step.error = e instanceof Error ? e.message : String(e);
      finish();
      return;
    }
    child.stdout.on('data', (c) => { keep(out, c); process.stdout.write(c); });
    child.stderr.on('data', (c) => { keep(err, c); process.stderr.write(c); });
    child.on('error', (e) => {
      step.error = e && e.code ? `${e.code}: ${e.message}` : String(e && e.message ? e.message : e);
      if (child.pid === undefined) finish();
    });
    child.on('close', (code, signal) => {
      if (done) return; // a start that failed has ended the step already
      step.exit_code = typeof code === 'number' ? code : null;
      step.signal = signal ?? null;
      finish();
    });
  });
}

/** The first line of a step's kept output that says OpenSCAD refused the summary options. */
function refusedLine(step) {
  for (const stream of [step.stderr, step.stdout]) {
    if (!stream) continue;
    let body = '';
    try { body = readFileSync(path.join(config.logs, stream.file), 'utf8'); } catch { continue; }
    const line = body.split(/\r?\n/).find((l) => REFUSED.test(l));
    if (line) return line;
  }
  return undefined;
}

async function main() {
  if (steps.version) await runStep('version', steps.version.args, 1);
  let exported = await runStep('export', steps.export.args, 1);
  if (steps.export.fallback && exported.exit_code !== 0 && !exported.error) {
    const line = refusedLine(exported);
    if (line) {
      record.summary = { state: 'refused', line };
      exported = await runStep('export', steps.export.fallback.args, 2);
    }
  }
  if (steps.png) {
    if (exported.exit_code === 0 && !exported.signal) await runStep('png', steps.png.args, 1);
    else record.png = { state: 'skipped', why: 'the export did not exit 0' };
  }
  const code = exported.error && exported.exit_code === null ? 127 : exported.signal ? 1 : exported.exit_code ?? 1;
  record.exit_code = code;
  record.ended_at = iso();
  save();
  // Not process.exit: on macOS a pipe's last writes are asynchronous, and the job's log should hold them.
  process.exitCode = code;
}

main().catch((e) => {
  record.error = e instanceof Error ? e.message : String(e);
  record.exit_code = 1;
  record.ended_at = iso();
  save();
  process.stderr.write(`timmy_scad_run: ${record.error}\n`);
  process.exitCode = 1;
});
