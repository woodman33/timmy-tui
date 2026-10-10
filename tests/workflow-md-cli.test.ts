/**
 * Round R4 (helper H74; the plan's F-3 and R1 item 5): `timmy md <workflow.md> [<block>] [--plan] [--json]` as a real child
 * process (the CLI through tsx, as tests/ops-act.test.ts runs `timmy act`), in a temporary project with its own receipt
 * chain, HOME and Timmy home: its plan, its runs (the same Workspace and job as /run: the prediction, a receipt per block,
 * the run's own receipt, one operation recorded as from `timmy md`), its exit codes (0 succeeded or --plan, 1 failed, 2
 * refused or needs a person, 3 stopped), its refusal of a risky run where no one can be asked (and `timmy act`'s), and its
 * NEEDS YOU box in a real terminal (tmux), answered with real keys.
 *
 * FAKE: upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (UPMD_BIN; it is not upmd; its
 * blocks run for real through sh, writing only in the temporary project). Everything else is real.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MD_USAGE, parseMdArgs } from '../src/cli-md.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { UPMD_GATE } from '../src/repl/workflow-gate.js';
import { readChain, verifyChain, verifyReceiptIn } from '../src/utils/receipts.js';
import { BLOCK_RECEIPT_KIND } from '../src/workflows/block-receipts.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';

const REPO = path.resolve(__dirname, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO, 'src', 'cli.ts');
const FAKE_UPMD = path.join(REPO, 'tests', 'fixtures', 'fake-upmd.mjs');
const TMUX = String(spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!TMUX) console.warn('workflow-md-cli: no tmux here, so the NEEDS YOU box in a real terminal is skipped');
const F = '```';
const SAFE = ['# Build', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, '', `${F}bash [name:build, deps:setup]`, 'echo hi > dist/index.html && echo built', F, ''].join('\n');
const FAILS = ['# Fails', '', `${F}bash [name:first]`, 'echo first', F, '', `${F}bash [name:broken, deps:first]`, 'echo nope >&2; exit 3', F, ''].join('\n');
const LONG = ['# Long', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'touch long.started', 'sleep 30', F, ''].join('\n');
const RISKY = ['# Clean build', '', `${F}bash [name:clean]`, 'rm -rf dist', F, '', `${F}bash [name:build, deps:clean]`, 'mkdir -p dist && echo built > dist/out.txt', F, ''].join('\n');

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}, 30_000);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

interface Box { base: string; root: string; home: string; bin: string; env: NodeJS.ProcessEnv }
/** A project with these documents, a home of its own, and a `timmy` on PATH that is the real CLI. */
function sandbox(docs: Record<string, string>): Box {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h74-md-')));
  dirs.push(base);
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  for (const d of [root, home, bin]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, body] of Object.entries(docs)) fs.writeFileSync(path.join(root, rel), body);
  fs.writeFileSync(path.join(bin, 'timmy'), `#!/bin/sh\nexec "${TSX}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...withoutRunner(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, TIMMY_HOME: path.join(home, 'timmy'),
    TIMMY_STORE: path.join(root, '.timmy', 'receipts'), UPMD_BIN: FAKE_UPMD, NO_COLOR: '1',
  };
  delete env.TIMMY_OPERATION;
  return { base, root, home, bin, env };
}

/** `timmy <args>` as a real child process in the project (stdin a pipe: no terminal). */
function timmy(b: Box, args: string[]): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }>; out: () => string } {
  const child = spawn(path.join(b.bin, 'timmy'), args, { cwd: b.root, env: b.env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done, out: () => `${stdout}${stderr}` };
}
const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
const chain = (b: Box) => readChain('runs', b.root);
const jobsIn = (b: Box): string[] => { try { return fs.readdirSync(path.join(b.home, 'timmy', 'jobs')).filter((n) => /^j[0-9a-f]{6}\.json$/.test(n)); } catch { return []; } };

describe('timmy md: its arguments and its help', () => {
  it('reads a document, an optional block, --plan and --json; refuses an unknown option or a third word', () => {
    expect(parseMdArgs(['WORK.md', 'build', '--plan'])).toEqual({ doc: 'WORK.md', block: 'build', plan: true, json: false });
    expect(parseMdArgs(['WORK.md'], { json: true })).toEqual({ doc: 'WORK.md', plan: false, json: true });
    expect(parseMdArgs([])).toEqual({ error: `Name the workflow document. Usage: ${MD_USAGE}` });
    expect(parseMdArgs(['a.md', 'b', 'c'])).toMatchObject({ error: expect.stringContaining('at most one block') });
    expect(parseMdArgs(['--doctor'])).toEqual({ error: `No option --doctor. Usage: ${MD_USAGE}` });
  });

  it('timmy md --help says what it does and its exit codes; timmy --help lists it (a real child process)', async () => {
    const b = sandbox({});
    const help = await timmy(b, ['md', '--help']).done;
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(MD_USAGE);
    expect(help.stdout).toContain('0 succeeded (or --plan)   1 failed   2 refused, needs a person, or usage   3 stopped or interrupted');
    expect(help.stdout).toContain(`  ${UPMD_GATE}.`);
    expect(help.stdout).not.toMatch(/doctor/i);
    const all = await timmy(b, ['--help']).done;
    expect(all.stdout).toContain('md <workflow.md> [<block>]  Run a upmd workflow\'s block as /run does: prediction, block receipts, NEEDS YOU (--plan, --json)');
  }, 60_000);
});

describe('timmy md, a real child process: the same run as /run', () => {
  it('--plan prints the prediction and the risky blocks and runs and seals nothing (exit 0)', async () => {
    const b = sandbox({ 'RISKY.md': RISKY });
    const r = await timmy(b, ['md', 'RISKY.md', 'build', '--plan', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(lastJson(r.stdout)).toMatchObject({
      schema: 'timmy.md/1', operation: null, plan: true, doc: 'RISKY.md', block: 'build', order: ['clean', 'build'], gate: UPMD_GATE, upmd: { version: '0.2.7' }, outcome: 'answered', exit_code: 0,
      risky: [{ name: 'clean', index: 1, command: 'rm -rf dist', reason: 'a destructive shell command on this machine' }],
    });
    expect(r.stderr).toContain('  Plan       clean → build, each exits 0 · --plan: nothing runs and nothing is sealed');
    // the risky block in the words and columns the REPL's /run prints before its box
    expect(r.stderr).toContain('  Needs you  clean: rm -rf dist · a destructive shell command on this machine');
    expect(r.stderr).toContain(`             ${UPMD_GATE}.`);
    expect(chain(b)).toEqual([]);
    expect(jobsIn(b)).toEqual([]);
    expect(fs.existsSync(path.join(b.root, '.timmy', 'operations'))).toBe(false);
  }, 60_000);

  it('runs it (exit 0): its prediction, a receipt per block and the run\'s own, in one operation recorded as from timmy md (--json)', async () => {
    const b = sandbox({ 'BUILD.md': SAFE });
    const r = await timmy(b, ['md', 'BUILD.md', 'build', '--json']).done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const o = lastJson(r.stdout);
    const c = chain(b);
    expect(c.map((x) => x.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, BLOCK_RECEIPT_KIND, 'workflow']);
    expect(verifyChain('runs', b.root).ok).toBe(true);
    for (const x of c) expect(verifyReceiptIn(c, x.hash)).toMatchObject({ ok: true });
    const short = c.map((x) => x.hash.slice(7, 15));
    const op = String(o.operation);
    expect(o).toMatchObject({
      schema: 'timmy.md/1', operation: expect.stringMatching(/^o[0-9a-f]{8}$/), joined: false, request: 'timmy md BUILD.md build', doc: 'BUILD.md', block: 'build', order: ['setup', 'build'],
      outcome: 'succeeded', exit_code: 0, prediction: short[0], receipt: short[3], risky: [],
      blocks: [{ name: 'setup', state: 'completed', exit_code: 0, receipt: short[1] }, { name: 'build', state: 'completed', exit_code: 0, receipt: short[2] }],
      receipts: [{ id: short[0], kind: 'predict', status: 'ok' }, { id: short[1], kind: BLOCK_RECEIPT_KIND, status: 'ok' }, { id: short[2], kind: BLOCK_RECEIPT_KIND, status: 'ok' }, { id: short[3], kind: 'workflow', status: 'ok' }],
    });
    expect(c.every((x) => x.operation_id === op)).toBe(true);
    expect(c[3]).toMatchObject({ child_receipts: [short[1], short[2]] });
    expect(fs.readFileSync(path.join(b.root, 'dist', 'index.html'), 'utf8')).toBe('hi\n');
    const rec = readOperationRecord(b.root, op);
    expect(rec.ok && rec.record).toMatchObject({ via: 'md', request: 'timmy md BUILD.md build', state: 'succeeded' });
    // nothing of the sandbox's folders in what it printed or sealed
    expect(r.stdout).not.toContain(b.base);
    expect(JSON.stringify(c)).not.toContain(b.base);
  }, 90_000);

  it('a failing block: exit 1, its receipt failed with its exit (plain output: the operation, the blocks and the run)', async () => {
    const b = sandbox({ 'FAILS.md': FAILS });
    const r = await timmy(b, ['md', 'FAILS.md', 'broken']).done;
    expect(r.code, r.stdout + r.stderr).toBe(1);
    const c = chain(b);
    expect(c.map((x) => [x.kind, x.block?.name ?? null, x.block?.exit_code ?? null])).toEqual([['predict', null, null], [BLOCK_RECEIPT_KIND, 'first', 0], [BLOCK_RECEIPT_KIND, 'broken', 3], ['workflow', null, null]]);
    expect(r.stdout).toMatch(/operation o[0-9a-f]{8} · \.timmy\/operations\/o[0-9a-f]{8}\.json/);
    expect(r.stdout).toContain(`  Blocks     block first: receipt ${c[1].hash.slice(7, 15)} · block broken: receipt ${c[2].hash.slice(7, 15)}`);
    expect(r.stdout).toContain(`  Run        receipt ${c[3].hash.slice(7, 15)} · /jobs ${String(c[3].job?.id)}`);
    expect(r.stdout).toMatch(/✖ operation o[0-9a-f]{8} failed: job j[0-9a-f]{6} failed/);
  }, 90_000);

  it('a risky run where no one can be asked (--json, or no terminal): refused before anything runs, exit 2, with the command to type; timmy act refuses it alike', async () => {
    const b = sandbox({ 'RISKY.md': RISKY });
    const why = 'Not run: clean (rm -rf dist) in RISKY.md is a destructive shell command on this machine, which needs a person, and timmy md --json cannot ask you. Type this in the REPL instead: /run RISKY.md build';
    const j = await timmy(b, ['md', 'RISKY.md', 'build', '--json']).done;
    expect(j.code, j.stdout + j.stderr).toBe(2);
    expect(lastJson(j.stdout)).toMatchObject({ schema: 'timmy.md/1', operation: null, outcome: 'refused', exit_code: 2, why, risky: [{ name: 'clean', command: 'rm -rf dist' }] });
    const plain = await timmy(b, ['md', 'RISKY.md', 'build']).done;
    expect(plain.code, plain.stdout + plain.stderr).toBe(2);
    expect(plain.stdout).toContain('Not run: clean (rm -rf dist) in RISKY.md is a destructive shell command on this machine, which needs a person, and timmy md with no terminal cannot ask you. Type this in the REPL instead: /run RISKY.md build');
    const act = await timmy(b, ['act', '/run RISKY.md build', '--wait', '--json']).done;
    expect(act.code, act.stdout + act.stderr).toBe(2);
    expect(lastJson(act.stdout)).toMatchObject({ schema: 'timmy.act/1', operation: null, outcome: 'refused', exit_code: 2, why: 'Not run: clean (rm -rf dist) in RISKY.md is a destructive shell command on this machine, which needs a person. Type this in the REPL instead: /run RISKY.md build' });
    // nothing ran, was sealed or recorded
    expect(fs.existsSync(path.join(b.root, 'dist'))).toBe(false);
    expect(chain(b)).toEqual([]);
    expect(jobsIn(b)).toEqual([]);
    expect(fs.existsSync(path.join(b.root, '.timmy', 'operations'))).toBe(false);
  }, 120_000);

  it('SIGTERM while a block runs: exit 3; that block\'s receipt says interrupted, by a stop, in timmy md\'s words', async () => {
    const b = sandbox({ 'LONG.md': LONG });
    const run = timmy(b, ['md', 'LONG.md', 'long', '--json']);
    await until('long to start', () => fs.existsSync(path.join(b.root, 'long.started')));
    // the pty wrapper has said long started once its block file exists; a moment for its line to reach the job
    await sleep(500);
    run.child.kill('SIGTERM');
    const r = await run.done;
    expect(r.code, r.stdout + r.stderr).toBe(3);
    const o = lastJson(r.stdout);
    expect(o).toMatchObject({ outcome: 'stopped', exit_code: 3 });
    const c = chain(b);
    expect(c.map((x) => [x.kind, x.block?.name ?? null])).toEqual([['predict', null], [BLOCK_RECEIPT_KIND, 'first'], [BLOCK_RECEIPT_KIND, 'long'], ['workflow', null]]);
    expect(c[2]).toMatchObject({ status: 'cancelled', block: { outcome: 'interrupted', interrupted_by: 'stop', stop_words: 'by timmy md (SIGTERM received)' } });
    expect(c[3]).toMatchObject({ status: 'cancelled', job: { state: 'cancelled' } });
  }, 120_000);
});

describe.skipIf(!TMUX)('timmy md in a real terminal (tmux): its NEEDS YOU box, answered with real keys', () => {
  /** `timmy md RISKY.md build` in a terminal of its own; the key pressed once its box is on screen; the exit code and the screen. */
  async function press(b: Box, key: string): Promise<{ code: number; screen: string; asked: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h74-tmux-'));
    dirs.push(dir);
    const env = { ...b.env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor' };
    delete env.NO_COLOR;
    const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', 'h74md', ...args], { env, encoding: 'utf8' });
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', b.root, 'bash', '--norc', '-c', `"${path.join(b.bin, 'timmy')}" md RISKY.md build; echo "EXIT=$?"; sleep 60`);
      const screen = (): string => tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', 't');
      await until('the NEEDS YOU box', () => screen().includes('NEEDS YOU'), 60_000);
      const asked = screen();
      await sleep(400); // keys in the first 300 ms after the box appears are ignored (type-ahead guard)
      tmux('send-keys', '-t', 't', key);
      await until('timmy md to end', () => /EXIT=\d+/.test(screen()), 60_000);
      const s = screen();
      return { code: Number(/EXIT=(\d+)/.exec(s)![1]), screen: s, asked };
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }

  it('y runs it once (exit 0): the box named the run and the command; the prediction sealed the risky block and the answer', async () => {
    const b = sandbox({ 'RISKY.md': RISKY });
    const r = await press(b, 'y');
    expect(r.code, r.screen).toBe(0);
    expect(r.asked).toContain('/run RISKY.md build');
    expect(r.asked).toContain('runs a destructive shell command on this machine: clean');
    expect(r.asked).toContain('rm -rf dist');
    expect(r.asked).not.toContain('allow for session');
    expect(r.asked).toContain('Needs you  clean: rm -rf dist');
    expect(r.asked).toContain('Predicted  clean → build, each exits 0 · nothing runs or is sealed until you answer');
    expect(fs.readFileSync(path.join(b.root, 'dist', 'out.txt'), 'utf8')).toBe('built\n');
    const c = chain(b);
    expect(c.map((x) => x.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, BLOCK_RECEIPT_KIND, 'workflow']);
    expect(c[0]).toMatchObject({ prediction: { risky: [{ name: 'clean' }], gate: UPMD_GATE }, decisions: [{ decision: 'allow once' }] });
    expect(verifyChain('runs', b.root).ok).toBe(true);
  }, 150_000);

  it('n denies it (exit 2): nothing runs and nothing is sealed', async () => {
    const b = sandbox({ 'RISKY.md': RISKY });
    const r = await press(b, 'n');
    expect(r.code, r.screen).toBe(2);
    expect(r.screen).toContain('Not run: you denied it in its NEEDS YOU box. Nothing ran, and nothing was sealed.');
    expect(fs.existsSync(path.join(b.root, 'dist'))).toBe(false);
    expect(chain(b)).toEqual([]);
  }, 150_000);
});
