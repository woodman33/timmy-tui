/**
 * Round R4 (helper H82; the review of 6fb765a..4338fdb, finding 3): the exit codes of `timmy act` and `timmy md` after a
 * signal, and of boot.cjs after a CLI killed by one. On the Mac (r22) `timmy act … --wait --json` stopped by SIGINT printed
 * exit_code 3 in its JSON while the wrapper that ran it reported exit 0. act and md removed their SIGINT and SIGTERM
 * handlers before the end's JSON was printed and the process exited, so a second signal in that window killed the process
 * by default (a signal's death, not 3); and boot.cjs read a CLI killed by a signal as exit 0 (`r.status ?? 0`).
 *
 * Each runs as the installed command runs: Timmy's own bin (timmy.ts, here through tsx's --import loader, as its dev path
 * does), which starts the CLI as a child, passes its status on, and gives 128 plus the signal for a signal's death; each
 * signal goes to the whole process group, as a terminal's Ctrl+C does (the bin ignores SIGINT; the CLI handles it).
 *
 * FAKE pieces, each labelled: the code agent (tests/fixtures/fake-code-agent.mjs, no model), upmd
 * (tests/fixtures/fake-upmd.mjs; its blocks run through sh), and a slow disk for one read
 * (tests/fixtures/slow-end-read.cjs: it holds act's or md's end, at its read of the receipts store, so a second signal can
 * be sent into the end). Everything else is real: the bin, the CLI, the Workspace, the job manager, the records and signals.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_UPMD, opsKit, REPO, sandbox, until, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
/** Each run's process group, ended with SIGKILL after its test (the kit kills only the bin itself). */
const groups: number[] = [];
afterEach(async () => {
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* ended */ } }
  await kit.cleanup();
}, 60_000);

const LOADER = createRequire(import.meta.url).resolve('tsx');
const BIN = path.join(REPO, 'timmy.ts');
const HOLD = path.join(REPO, 'tests', 'fixtures', 'slow-end-read.cjs');
const F = '```';
const LONG = ['# Long', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'touch long.started', 'sleep 30', F, ''].join('\n');

interface Run { child: ChildProcess; out: () => string; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> }

/** `timmy <args>` through Timmy's own bin, in its own process group (signals go to the group, as a terminal's do). */
function timmy(s: Sandbox, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const child = spawn(process.execPath, ['--import', LOADER, BIN, ...args], { cwd: s.root, env: { ...s.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  kit.children.push(child);
  if (child.pid) groups.push(child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (c: string) => { stdout += c; });
  child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, out: () => `${stdout}${stderr}`, done };
}
/** A signal to the run's process group (its bin and the CLI), as Ctrl+C sends one. */
const group = (r: Run, sig: NodeJS.Signals): void => { try { process.kill(-r.child.pid!, sig); } catch { /* it has ended */ } };
const lastJson = (stdout: string): Record<string, unknown> => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

/** The slow disk's seam for one run: armed from the start (it acts only at the end's read), and the file it writes when it holds. */
function hold(s: Sandbox): { env: NodeJS.ProcessEnv; held: string } {
  const arm = path.join(s.base, 'hold.arm');
  const held = path.join(s.base, 'hold.held');
  fs.writeFileSync(arm, '');
  return { held, env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${HOLD}`.trim(), TIMMY_TEST_HOLD_ARM: arm, TIMMY_TEST_HOLD_HELD: held, TIMMY_TEST_HOLD_MS: '3000' } };
}

describe('timmy act: stopped by SIGINT, it exits 3 and says so; a second SIGINT during its end exits 3, never a signal\'s death or 0', () => {
  it('one SIGINT: exit 3, and its JSON says exit_code 3 (outcome stopped)', async () => {
    const s = sandbox(kit, 'h82-act-int-');
    const r = timmy(s, ['act', '/agent qwen FAKE: SLEEP until stopped', '--wait', '--json']);
    await until(() => /\bj[0-9a-f]{6}\b/.test(r.out()), 60_000, 'the agent\'s job');
    await new Promise((z) => { setTimeout(z, 500); });
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3, why: expect.stringMatching(/^SIGINT received/) });
  }, 120_000);

  it('a second SIGINT while its end reads the receipts (FAKE: a slow disk holds that read 3 s): exit 3, its JSON printed with exit_code 3', async () => {
    const s = sandbox(kit, 'h82-act-int2-');
    const h = hold(s);
    const r = timmy(s, ['act', '/agent qwen FAKE: SLEEP until stopped', '--wait', '--json'], h.env);
    await until(() => /\bj[0-9a-f]{6}\b/.test(r.out()), 60_000, 'the agent\'s job');
    await new Promise((z) => { setTimeout(z, 500); });
    group(r, 'SIGINT');
    await until(() => fs.existsSync(h.held), 60_000, 'act\'s end to read the receipts');
    group(r, 'SIGINT');
    const d = await r.done;
    // b8fcd54: the handlers were gone by then, so the CLI died of SIGINT and the bin exited 130 (a wrapper reading none, 0)
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);
});

describe('timmy md: the same', () => {
  const box = (prefix: string): Sandbox => {
    const s = sandbox(kit, prefix);
    fs.writeFileSync(path.join(s.root, 'LONG.md'), LONG);
    s.env.UPMD_BIN = FAKE_UPMD;
    return s;
  };

  it('one SIGINT while a block runs: exit 3, and its JSON says exit_code 3', async () => {
    const s = box('h82-md-int-');
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json']);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);

  it('a second SIGINT while its end reads the receipts (FAKE: a slow disk holds that read 3 s): exit 3, its JSON printed with exit_code 3', async () => {
    const s = box('h82-md-int2-');
    const h = hold(s);
    const r = timmy(s, ['md', 'LONG.md', 'long', '--json'], h.env);
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, 'the long block');
    group(r, 'SIGINT');
    await until(() => fs.existsSync(h.held), 60_000, 'md\'s end to read the receipts');
    group(r, 'SIGINT');
    const d = await r.done;
    expect(d.code, d.stdout + d.stderr).toBe(3);
    expect(lastJson(d.stdout)).toMatchObject({ outcome: 'stopped', exit_code: 3 });
  }, 120_000);
});

describe('boot.cjs (npm start) passes a CLI\'s end on: its status, or 128 plus the signal that killed it, never 0', () => {
  /** A folder whose dist/cli.js is `body` (boot.cjs runs ./dist/cli.js from the folder it starts in). */
  const folder = (body: string): string => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h82-boot-')));
    kit.dirs.push(d);
    fs.mkdirSync(path.join(d, 'dist'));
    fs.writeFileSync(path.join(d, 'dist', 'cli.js'), body);
    return d;
  };
  const boot = (cwd: string): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [path.join(REPO, 'boot.cjs'), 'act', '/op'], { cwd, encoding: 'utf8', timeout: 30_000 });

  it('a CLI killed by SIGTERM: 143; by SIGKILL: 137; one that exits 3: 3', () => {
    expect(boot(folder("process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 5000);\n")).status).toBe(143);
    expect(boot(folder("process.kill(process.pid, 'SIGKILL');\nsetTimeout(() => {}, 5000);\n")).status).toBe(137);
    expect(boot(folder('process.exit(3);\n')).status).toBe(3);
  });
});
