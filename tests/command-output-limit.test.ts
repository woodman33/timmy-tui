/**
 * R2 output limit: what a command prints reaches the model as a bounded view (the first and the last
 * part of each stream, with a marker that says how much was left out and where the rest is), and the
 * full output goes to a log under the working folder's .timmy/runs/. Large output alone no longer stops
 * a command; the time limit still does, and a hard cap on the log stops it with that reason.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserSnapshotTool, daytonaWorkspaceTool, stressTestTool } from '../src/agent/tools.js';
import { boundOutput, runLocalCommand } from '../src/agent/command-output.js';
import { killProcessGroup } from '../src/runtime/spawn-runtime.js';

type Exec = (args: Record<string, unknown>) => Promise<any>;
const run = (t: unknown, args: Record<string, unknown> = {}): Promise<any> => (t as { function: { execute: Exec } }).function.execute(args);

/** About 4.7 MB of numbered lines: every line differs, so a dropped, doubled or reordered piece shows. */
const BIG = 'seq 1 700000';
/** What both streams together may return to the model: 32 KiB of output and room for two markers. */
const BOUND = 32 * 1024 + 1024;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** The bytes `script` prints, run directly, to compare with the log. */
const expected = (script: string): Buffer => execFileSync('sh', ['-c', script], { maxBuffer: 64 * 1024 * 1024 });

let dir: string;
let before: string;

beforeEach(() => {
  // The working folder is where the command runs and where its log goes: a fresh one, never this checkout.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-output-')));
  before = process.cwd();
  process.chdir(dir);
  vi.stubEnv('DAYTONA_API_KEY', '');
});

afterEach(() => {
  process.chdir(before);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('the workspace command on this machine returns a bounded view and keeps the full output', () => {
  it('a command printing ~5 MB: bounded, marked, successful, and the log holds every byte', async () => {
    const out = await run(daytonaWorkspaceTool, { command: BIG });
    const full = expected(BIG);
    expect(full.length).toBeGreaterThan(4_000_000);
    expect(out.success).toBe(true);
    expect(out.where).toBe('this machine');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(out.stdout).toMatch(/\[… [\d,]+ bytes not shown; the full output is in \.timmy\/runs\/command-[^ ]+\.log …\]/);
    // The view is the start and the end of the output.
    expect(out.stdout.startsWith('1\n2\n3\n')).toBe(true);
    expect(out.stdout.endsWith('699999\n700000\n')).toBe(true);
    // The path is relative to the working folder, and the counts are the real ones.
    expect(out.log).toMatch(/^\.timmy\/runs\/command-.+\.log$/);
    expect(out.stdout).toContain(out.log);
    expect(out.stdoutBytes).toBe(full.length);
    expect(out.stderrBytes).toBe(0);
    const log = join(dir, out.log);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    const kept = readFileSync(log);
    expect(kept.length).toBe(full.length);
    expect(sha(kept)).toBe(sha(full));
    // The marker counts exactly the bytes the view left out.
    const omitted = Number(/\[… ([\d,]+) bytes not shown/.exec(out.stdout)![1].replace(/,/g, ''));
    const shown = out.stdout.replace(/\n?\[… [^\]]+ …\]\n/, '');
    expect(omitted + bytes(shown)).toBe(full.length);
    expect(full.toString('utf8')).toContain(shown.slice(0, 2000));
    expect(out.message).toContain(out.log);
  });

  it('a command printing a little returns it unchanged, with no marker and no log', async () => {
    const out = await run(daytonaWorkspaceTool, { command: 'echo hello; echo oops >&2' });
    expect(out.success).toBe(true);
    expect(out.stdout).toBe('hello\n');
    expect(out.stderr).toBe('oops\n');
    expect(out.stdout + out.stderr).not.toContain('not shown');
    expect(out.log).toBe('');
    expect(out.stdoutBytes).toBe(6);
    expect(out.stderrBytes).toBe(5);
    expect(existsSync(join(dir, '.timmy'))).toBe(false);
    expect(out.message).toBe('Ran on this machine, not in Daytona: DAYTONA_API_KEY is not set.');
  });

  it('stderr is bounded too, and its bytes are in the log', async () => {
    const script = `${BIG} >&2`;
    const out = await run(daytonaWorkspaceTool, { command: script });
    const full = expected(`${BIG}`);
    expect(out.success).toBe(true);
    expect(out.stdout).toBe('');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(out.stderr).toMatch(/\[… [\d,]+ bytes not shown; the full output is in \.timmy\/runs\/command-[^ ]+\.log …\]/);
    expect(out.stderrBytes).toBe(full.length);
    expect(sha(readFileSync(join(dir, out.log)))).toBe(sha(full));
  });

  it('a failing command with large output is still a failure, with its exit code', async () => {
    const out = await run(daytonaWorkspaceTool, { command: `${BIG}; exit 3` });
    expect(out.success).toBe(false);
    expect(out.message).toContain('Exit 3.');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(readFileSync(join(dir, out.log)).length).toBe(expected(BIG).length);
  });

  it('the time limit still stops a command with large output, and the log keeps what it printed', async () => {
    vi.stubEnv('TIMMY_WORKSPACE_TIMEOUT_MS', '1500');
    const started = Date.now();
    const out = await run(daytonaWorkspaceTool, { command: `${BIG}; sleep 30` });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/^Stopped after 2 s on this machine, with its process group\./);
    expect(out.message).toContain('/preview');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(out.stdout).toContain('bytes not shown');
    const full = expected(BIG);
    expect(sha(readFileSync(join(dir, out.log)))).toBe(sha(full));
  });

  it('when no log can be written, the command still runs and the answer says no full copy was kept', async () => {
    writeFileSync(join(dir, '.timmy'), 'a file where the folder would go');
    const out = await run(daytonaWorkspaceTool, { command: BIG });
    expect(out.success).toBe(true);
    expect(out.log).toBe('');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(out.stdout).toMatch(/\[… [\d,]+ bytes not shown; no full copy was kept: could not create a log in \.timmy\/runs: .+ …\]/);
    expect(out.message).toContain('no full copy was kept');
  });

  it('two commands never share a log', async () => {
    const [a, b] = await Promise.all([run(daytonaWorkspaceTool, { command: BIG }), run(daytonaWorkspaceTool, { command: BIG })]);
    expect(a.log).not.toBe(b.log);
    expect(readFileSync(join(dir, a.log)).length).toBe(readFileSync(join(dir, b.log)).length);
  });
});

describe('the hard cap on the log', () => {
  it('stops a command whose output reaches the cap, with that reason, and the log holds exactly the cap', async () => {
    const cap = 1024 * 1024;
    const started = Date.now();
    const r = await runLocalCommand('yes 0123456789', { cwd: dir, timeoutMs: 30_000, logCapBytes: cap });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.logFull).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(statSync(join(dir, r.log)).size).toBe(cap);
    expect(r.stdoutBytes).toBe(cap);
    expect(bytes(r.stdout)).toBeLessThanOrEqual(BOUND);
    expect(r.stdout).toMatch(/\[… [\d,]+ bytes not shown; the log holds only the first 1,048,576 bytes \(its limit\), in \.timmy\/runs\/command-[^ ]+\.log …\]/);
  });

  it('the workspace tool says a full log is why it stopped (TIMMY_WORKSPACE_LOG_CAP_BYTES lowers the 256 MiB cap)', async () => {
    vi.stubEnv('TIMMY_WORKSPACE_LOG_CAP_BYTES', String(512 * 1024));
    const out = await run(daytonaWorkspaceTool, { command: 'yes 0123456789' });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/^Stopped on this machine, with its process group: its output reached the 524,288-byte log limit\./);
    expect(out.message).toContain(out.log);
    expect(statSync(join(dir, out.log)).size).toBe(512 * 1024);
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
  });

  it('a command that ends by itself is never reported as stopped by the cap', async () => {
    const out = await run(daytonaWorkspaceTool, { command: BIG });
    expect(out.message).not.toMatch(/log limit/);
  });

  // Round R3 (the independent review of 40022d9, finding 1): the cap's stop sent only SIGTERM, so a command
  // that ignores it kept the run pending for ever. Now SIGKILL follows the grace period, as for the time limit.
  it('stops a command that ignores SIGTERM: SIGKILL follows the grace period, and the run says so', async () => {
    const pidFile = join(dir, 'leader.pid');
    const started = Date.now();
    const pending = runLocalCommand(`echo $$ > leader.pid; trap "" TERM; yes 0123456789`, { cwd: dir, timeoutMs: 30_000, logCapBytes: 64 * 1024, killGraceMs: 300 });
    const r = await Promise.race([pending, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), 8000).unref(); })]);
    try {
      expect(r, 'the run never settled').not.toBe('pending');
      if (r === 'pending') return;
      expect(Date.now() - started).toBeLessThan(8000);
      expect(r.logFull).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.signal).toBe('SIGKILL');
      expect(r.killed).toBe('SIGKILL');
      expect(statSync(join(dir, r.log)).size).toBe(64 * 1024);
    } finally {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 1) killProcessGroup(pid, 'SIGKILL');
    }
  });

  it('the time limit kills a command that ignores SIGTERM, with its process group', async () => {
    const pidFile = join(dir, 'leader.pid');
    const pending = runLocalCommand('echo $$ > leader.pid; trap "" TERM; while :; do sleep 0.1; done', { cwd: dir, timeoutMs: 400, killGraceMs: 300 });
    const r = await Promise.race([pending, new Promise<'pending'>((resolve) => { setTimeout(() => resolve('pending'), 8000).unref(); })]);
    try {
      expect(r, 'the run never settled').not.toBe('pending');
      if (r === 'pending') return;
      expect(r.timedOut).toBe(true);
      expect(r.signal).toBe('SIGKILL');
      expect(r.killed).toBe('SIGKILL');
    } finally {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (pid > 1) killProcessGroup(pid, 'SIGKILL');
    }
  });
});

describe('other tools that return a program\'s output to the model are bounded too', () => {
  function fakeProgram(name: string, body: string): void {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  }

  it('browser_get_snapshot: a very large page tree comes back bounded, with a marker', async () => {
    fakeProgram('agent-browser', BIG);
    const out = await run(browserSnapshotTool);
    expect(out.success).toBe(true);
    expect(bytes(out.accessibilityTree)).toBeLessThanOrEqual(16 * 1024 + 512);
    expect(out.accessibilityTree).toMatch(/\[… [\d,]+ bytes not shown …\]/);
    expect(out.accessibilityTree.startsWith('1\n2\n')).toBe(true);
    expect(out.accessibilityTree.endsWith('700000\n')).toBe(true);
  });

  it('stress_test_endpoint: oha\'s report is bounded the same way', async () => {
    fakeProgram('oha', BIG);
    const out = await run(stressTestTool, { url: 'http://127.0.0.1:9/' });
    expect(out.success).toBe(true);
    expect(bytes(out.data)).toBeLessThanOrEqual(16 * 1024 + 512);
    expect(out.data).toContain('bytes not shown');
  });

  it('Daytona: a reply with a very large output is bounded before it reaches the model', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'dtn_synthetic');
    const big = expected(BIG).toString('utf8');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exitCode: 0, stdout: big, stderr: big }), { status: 200 })));
    const out = await run(daytonaWorkspaceTool, { command: BIG });
    expect(out.success).toBe(true);
    expect(out.where).toBe('daytona');
    expect(bytes(out.stdout) + bytes(out.stderr)).toBeLessThanOrEqual(BOUND);
    expect(out.stdout).toMatch(/\[… [\d,]+ bytes not shown …\]/);
    expect(out.stderr).toMatch(/\[… [\d,]+ bytes not shown …\]/);
  });

  it('boundOutput leaves short text alone and never splits a character', () => {
    expect(boundOutput('short')).toBe('short');
    // One byte, then two-byte characters: the 4,096-byte head would end inside one.
    const wide = 'a' + 'é'.repeat(20_000);
    const view = boundOutput(wide);
    expect(view).not.toContain('�');
    const shown = view.replace(/\n?\[… [^\]]+ …\]\n/, '');
    const omitted = Number(/\[… ([\d,]+) bytes not shown/.exec(view)![1].replace(/,/g, ''));
    expect(omitted + bytes(shown)).toBe(40_001);
    expect(shown.startsWith('aé')).toBe(true);
  });
});
