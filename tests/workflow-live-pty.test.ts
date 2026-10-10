// Round R4 (H58, ledger row 157): a workflow run on a real pseudo-terminal. workers/upmd/pty_run.py runs under this
// machine's python3 as a real job (src/jobs JobManager: its own process group, its stop path), with
// tests/fixtures/fake-upmd.mjs in its pty mode: a labelled TEST DOUBLE of upmd 0.2.7 (it is not upmd) that writes the
// format upmd 0.2.7 was observed to write on a terminal and runs each block for real (sh, in a session of its own), so the
// delays here are real. Processes are read from the real process table (ps). The fake python3 in the last test is FAKE
// (a shell script that refuses), labelled where it is written. No network, no paid call.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord, type JobStep } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { kit } from '../src/repl/board-kit.js';
import { renderWorkflowCard, workflowForBoard } from '../src/repl/board-nodes.js';
import { connectWorkflow } from '../src/repl/board-workflows.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { isLiveRun, PTY_RUN_SCRIPT, ptyReady, upmdJob, upmdLineParser } from '../src/workflows/upmd-live.js';
import { parseWorkflow, upmdRunArgs } from '../src/workflows/upmd.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('workflow-live-pty: no python3 here, so the pty runs are skipped');
const F = '```';
/** The probe document of ledger row 157: first; second needs first, fails with exit 3; third needs second. */
const PROBE = [
  '# Probe', '',
  `${F}bash [name:first]`, 'echo "first says hello"', 'sleep 1', 'echo "first done"', F, '',
  `${F}bash [name:second, deps:first]`, 'echo "second starts"', 'sleep 1', 'echo "second fails" >&2', 'exit 3', F, '',
  `${F}bash [name:third, deps:second]`, 'echo "third never runs"', F, '',
].join('\n');
/** A block that runs until it is stopped, after a quick one. */
const LONG = ['# Long', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'echo started', 'sleep 30', F, ''].join('\n');

const dirs: string[] = [];
const managers: Array<{ m: JobManager; ids: string[] }> = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until<T>(what: string, get: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
interface Proc { pid: number; ppid: number; pgid: number; sid: number; stat: string; args: string }
/** The real process table (ps; Linux and macOS keywords). */
function table(): Proc[] {
  const out = String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'sess=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '');
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), sid: Number(m[4]), stat: m[5], args: m[6].trim() }));
}
/** Whether any process of the group runs (a zombie runs nothing). */
const groupRuns = (pgid: number): boolean => table().some((p) => p.pgid === pgid && !p.stat.startsWith('Z'));

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const { m, ids } of managers.splice(0)) for (const id of ids) await m.stop(id);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function start(doc: string, target: string, onChange?: (j: JobRecord) => void) {
  const root = temp('h58-pty-');
  writeFileSync(join(root, 'WORK.md'), doc);
  const m = new JobManager({ dir: join(temp('h58-jobs-'), 'jobs'), ...(onChange ? { onChange } : {}) });
  return { root, m, go: async () => {
    const pty = await ptyReady(PYTHON3);
    expect(pty).toMatchObject({ ok: true, script: PTY_RUN_SCRIPT });
    const how = upmdJob(FAKE_UPMD, upmdRunArgs(join(root, 'WORK.md'), target, root), pty);
    const parse = upmdLineParser(parseWorkflow(doc), 'pty');
    const job = m.start({ kind: 'workflow', label: `WORK.md › ${target}`, project: 'demo', root, command: how.command, args: how.args, parseLine: (line, j) => parse(line, j.steps) });
    managers.push({ m, ids: [job.id] });
    return job;
  } };
}
const ownMs = (s: JobStep | undefined): number => Date.parse(s!.endedAt!) - Date.parse(s!.startedAt!);

describe.skipIf(!PYTHON3)('upmd on a pty of its own (the wrapper, a real job; the test double in its pty mode)', () => {
  it('a block is seen running before it ends; its own time is over 1 s for a 1 s block; the failing block and the rest not run', async () => {
    const seen: Array<{ at: number; steps: JobStep[] }> = [];
    const { root, m, go } = start(PROBE, 'third', (j) => seen.push({ at: Date.now(), steps: j.steps.map((s) => ({ ...s })) }));
    const job = await go();
    expect(isLiveRun(job.args)).toBe(true);
    const done = await m.done(job.id);
    // while first ran: running, with no end yet, a second before it ended
    const running = seen.find((x) => x.steps[0]?.name === 'first' && x.steps[0].state === 'running');
    const ended = seen.find((x) => x.steps[0]?.state === 'completed');
    expect(running?.steps[0].endedAt).toBeUndefined();
    expect(ended!.at - running!.at).toBeGreaterThanOrEqual(900);
    expect(seen.some((x) => x.steps[1]?.state === 'running')).toBe(true);
    // its end: first completed, second failed with exit 3, third never started; upmd's exit 1 is the job's
    expect(done).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(done.steps.map((s) => [s.name, s.index, s.state, s.code])).toEqual([['first', 1, 'completed', 0], ['second', 2, 'failed', 3]]);
    expect(ownMs(done.steps[0])).toBeGreaterThanOrEqual(1000);
    expect(ownMs(done.steps[0])).toBeLessThan(5000);
    expect(ownMs(done.steps[1])).toBeGreaterThanOrEqual(1000);
    // the card: each block's own time, the rest not run
    const w = connectWorkflow(workflowForBoard('WORK.md', { text: PROBE }), { root, jobs: [done], chain: [], files: ['WORK.md'], upmd: true });
    expect(w.connected!.nodes.map((n) => [n.name, n.word])).toEqual([['first', 'completed'], ['second', 'failed'], ['third', 'not run']]);
    expect(w.connected!.nodes[0].detail).toMatch(/^exit 0 · [1-4]\.\d s$/);
    expect(w.connected!.nodes[1].detail).toMatch(/^exit 3 · [1-4]\.\d s$/);
    expect(renderWorkflowCard(w, kit({ live: true, base: '../../' }))).not.toContain('were not live');
    // the log keeps the terminal's bytes as they came, and the wrapper's own line
    const log = readFileSync(done.logPath, 'utf8');
    expect(log).toContain('\x1b[?25l');
    expect(log).toContain('==> second [block 2]');
    expect(log).toMatch(/^pty_run: fake-upmd\.mjs runs as process \d+, the leader of its own session, on a terminal of its own$/m);
  }, 30_000);

  it("Stop while a block runs: the block reads stopped; the wrapper, upmd's group and the block's own group are gone", async () => {
    const { root, m, go } = start(LONG, 'long');
    const job = await go();
    await until('long to run', () => m.get(job.id)?.steps.find((s) => s.name === 'long' && s.state === 'running'));
    // the processes: the wrapper (the job's), upmd (the double, its child, a session of its own) and the block (a session of its own)
    const wrapper = job.pid ?? m.get(job.id)!.pid!;
    const upmd = await until('upmd under the wrapper', () => table().find((p) => p.ppid === wrapper));
    const block = await until('the block under upmd', () => table().find((p) => p.ppid === upmd.pid && p.args.includes('sleep 30')));
    // its sleep: the block's shell itself once the shell has exec'd it, or its child
    const sleeper = await until('the block\'s sleep', () => table().find((p) => (p.pid === block.pid || p.ppid === block.pid) && /^sleep 30$/.test(p.args)));
    expect(new Set([wrapper, upmd.pgid, block.pgid]).size).toBe(3);
    expect([upmd.sid, block.sid]).toEqual([upmd.pid, block.pid]);
    expect(sleeper.pgid).toBe(block.pgid);
    const t0 = Date.now();
    const stopped = (await m.stop(job.id))!;
    // the wrapper ended it all within the job manager's grace: no SIGKILL to the job's group was needed
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(stopped).toMatchObject({ state: 'cancelled', cleanup: 'complete' });
    expect(stopped.error).toBeUndefined();
    const long = stopped.steps.find((s) => s.name === 'long')!;
    expect(long).toMatchObject({ state: 'stopped' });
    expect(ownMs(long)).toBeGreaterThanOrEqual(0);
    for (const g of [wrapper, upmd.pgid, block.pgid]) expect(groupRuns(g), `process group ${g}`).toBe(false);
    const log = readFileSync(stopped.logPath, 'utf8');
    expect(log).toContain(`pty_run: SIGTERM received: stopping fake-upmd.mjs (process group ${upmd.pid}) and the 1 process group it started (${block.pgid}) with SIGTERM`);
    expect(log).toContain('pty_run: stopped: no process of those groups runs');
    const w = connectWorkflow(workflowForBoard('WORK.md', { text: LONG }), { root, jobs: [stopped], chain: [], files: ['WORK.md'], upmd: true });
    expect(w.connected!.nodes.map((n) => [n.name, n.word])).toEqual([['first', 'completed'], ['long', 'stopped']]);
  }, 30_000);
});

describe('where upmd cannot run on a pty: the pipe, as before, said', () => {
  function workspace(onPath: (cmd: string) => string | null) {
    const root = temp('h58-fallback-');
    writeFileSync(join(root, 'WORK.md'), PROBE);
    const sealed: ReceiptInput[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env: { UPMD_BIN: FAKE_UPMD }, onPath, notify: () => {}, openWeb: (u) => u, link: (t) => t,
      seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
      jobsDir: join(temp('h58-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
      receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
    }, folderProject(root));
    spaces.push(ws);
    return ws;
  }

  it('no python3: /run says live states are not available and why, runs upmd itself over a pipe, and the card and /workflows say so', async () => {
    const ws = workspace(() => null);
    const said = text(await ws.run('WORK.md third'));
    expect(said).toContain("Live block states are not available: no python3 on PATH, so upmd's output is a pipe and it prints each block only when the block ends.");
    const job = ws.jobs.list().find((j) => j.label === 'WORK.md › third')!;
    expect(job.command).toBe(FAKE_UPMD);
    expect(isLiveRun(job.args)).toBe(false);
    const done = await ws.jobs.done(job.id);
    expect(done.steps.map((s) => [s.name, s.state, s.code])).toEqual([['first', 'completed', 0], ['second', 'failed', 3]]);
    expect(done.steps.every((s) => s.startedAt === undefined)).toBe(true);
    const lines = text(await ws.workflows('WORK.md'));
    // no own time for a block seen only as it ended
    expect(lines).toMatch(/1 first +bash +✓ completed exit 0 · j[0-9a-f]{6} /);
    expect(lines).toContain('its block states were not live: upmd wrote to a pipe and printed each block only when it ended');
    expect(lines).toContain('Live      not available here: no python3 on PATH');
  }, 30_000);

  it('a python3 that cannot run the wrapper: not ready, with what it said; /run falls back to the pipe', async () => {
    const fakes = temp('h58-fakes-');
    const fake = join(fakes, 'python3');
    // FAKE python3: a shell script that refuses to run anything
    writeFileSync(fake, '#!/bin/sh\necho "FAKE python3: refuses to run" >&2\nexit 1\n', { mode: 0o755 });
    expect(await ptyReady(fake)).toEqual({ ok: false, why: 'python3 could not run its pty wrapper (exit 1: FAKE python3: refuses to run)' });
    const ws = workspace((cmd) => (cmd === 'python3' ? fake : null));
    expect(text(await ws.run('WORK.md first'))).toContain('Live block states are not available: python3 could not run its pty wrapper (exit 1: FAKE python3: refuses to run), so');
    const job = ws.jobs.list().find((j) => j.label === 'WORK.md › first')!;
    expect(isLiveRun(job.args)).toBe(false);
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
  }, 30_000);

  it.skipIf(!PYTHON3)('with python3: /run runs upmd through the wrapper, and /jobs shows its output without the terminal\'s escape sequences', async () => {
    const ws = workspace((cmd) => (cmd === 'python3' ? PYTHON3 : null));
    const said = text(await ws.run('WORK.md first'));
    expect(said).not.toContain('Live block states are not available');
    const job = ws.jobs.list().find((j) => j.label === 'WORK.md › first')!;
    expect(job.command).toBe(PYTHON3);
    expect(isLiveRun(job.args)).toBe(true);
    const done = await ws.jobs.done(job.id);
    expect(done.state).toBe('completed');
    expect(readFileSync(done.logPath, 'utf8')).toContain('\x1b[');
    const shown = text(ws.jobsView(job.id));
    expect(shown).toContain('first says hello');
    expect(shown).not.toMatch(/\x1b|\r/);
  }, 30_000);
});

