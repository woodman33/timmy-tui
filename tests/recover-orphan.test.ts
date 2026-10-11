/**
 * Round R4 (helper H46, ledger row 153): the job of a flow's agent step, left by a REPL that was killed.
 *
 * On the operator's Mac a REPL was killed during /iterate's agent step; the next REPL wrote the flow's interrupted record
 * and receipt, but the agent's job record said "running" forever, and the agent's process group, which had survived the
 * kill, kept calling its model until it was stopped by hand. Recovery (src/repl/recover.ts) now handles the step's job:
 *   - its process gone: the job's own record is ended through the job module's writer (failed, "its REPL ended; its
 *     process is gone");
 *   - its process group still running: the group is stopped (SIGTERM, then SIGKILL after 2 s) before the interrupted
 *     record is written, and the stop is said in the recovery lines, the job's record and the flow's record; only when
 *     the process table proves that the job's REPL has ended and that the group is the job's;
 *   - not proven: nothing is stopped, and the lines say what still runs and how to stop it.
 *
 * The crash is real: a REPL session runs as its own process (tests/fixtures/recover-crash-fixture.ts, a real Workspace,
 * its `agent` step) and is killed with SIGKILL, never closed. Its agent is a TEST DOUBLE written here (no model, nothing
 * sent) that starts a helper process in its own process group, writes both pids to a file, prints nothing more (its REPL
 * is gone) and waits until it is stopped; with NOTERM in its task, it and its helper ignore SIGTERM. Two tests write
 * SYNTHETIC durable state by hand (a flow's state file and a job record), labelled where they are written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { GONE_WORDS } from '../src/repl/recover.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { JobManager } from '../src/jobs/index.js';

const FIXTURE = path.resolve('tests/fixtures/recover-crash-fixture.ts');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');

let root: string;
let fixtures: string;
let jobsDir: string;
let agent: string;
let started: string;
const spaces: Workspace[] = [];
const children: ChildProcess[] = [];
const extra: number[] = [];
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  // A zombie (ended, not yet reaped) runs nothing: read its state where /proc has it.
  try { return !/^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
/** The live processes whose command line names this test's project or fixtures (read from the process table). */
const ours = (): Array<{ pid: number; args: string }> => String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && (m[2].includes(root) || m[2].includes(fixtures)))
  .map((m) => ({ pid: Number(m[1]), args: m[2] }));
const noAbsolute = (s: string): void => { for (const p of new Set([root, fixtures, os.tmpdir()])) expect(s).not.toContain(p); };

/** The TEST DOUBLE agent (see the header): reports its start, starts its helper, writes both pids, waits until stopped. */
function orphanAgent(): string {
  const file = path.join(fixtures, 'bin', 'orphan-agent.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node
// FAKE code agent (a TEST DOUBLE for tests/recover-orphan.test.ts): NOT Qwen Code; it calls no model and sends nothing.
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('0.0.0-fake (a FAKE code agent, not a real one)'); process.exit(0); }
const noterm = (argv.at(-1) ?? '').includes('NOTERM');
if (noterm) process.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fake-session', model: 'fake', tools: [], qwen_code_version: '0.0.0-fake' }) + '\\n');
// Its helper stays in its process group (no detached): what a real agent's tool or model call would be.
const helper = spawn(process.execPath, ['-e', (noterm ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
const at = ${JSON.stringify(started)};
fs.writeFileSync(at + '.tmp', JSON.stringify({ agent: process.pid, helper: helper.pid }));
fs.renameSync(at + '.tmp', at);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return file;
}

/** A REPL session in this process, on the test's project and jobs folder. */
function make(o: { recoverAtStart?: boolean } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: agent, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: path.join(fixtures, 'fake-python') },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir,
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    iterateTest: { readback: (step) => ({ command: process.execPath, args: [FAKE_READBACK, 'match', step.abs, '--as', step.rel] }), settleMs: 15_000 },
    ...(o.recoverAtStart === undefined ? {} : { recoverAtStart: o.recoverAtStart }),
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

/** A REPL session as its own process, left in /iterate tray's agent step; resolves with the flow, the agent's job and pids. */
async function crashable(words = ''): Promise<{ child: ChildProcess; flow: string; job: string; pid: number; agentPid: number; helperPid: number }> {
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({
    root, jobsDir, executor: path.join(fixtures, 'no-executor-needed.mts'), fakePython: path.join(fixtures, 'fake-python'), agent, readback: FAKE_READBACK,
    seals: path.join(fixtures, 'crashed-seals.jsonl'), nativeStarted: path.join(fixtures, 'release-native.runs'), steps: ['agent'], agentStarted: started, agentWords: words,
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TIMMY_HOME: path.join(fixtures, 'home') } });
  children.push(child);
  let out = '';
  let err = '';
  const ready = await new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session did not get ready: ${out}${err}`)), 90_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      const m = out.match(/^READY (.*)$/m);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1]) as Record<string, any>); } else if (/^FAILED /m.test(out)) { clearTimeout(timer); reject(new Error(`${out}${err}`)); }
    });
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the session ended (${code ?? signal}) before it was ready: ${out}${err}`)); });
  });
  const a = ready.agent as { flow: string; job: string; pid: number; started: { agent: number; helper: number } };
  return { child, flow: a.flow, job: a.job, pid: a.pid, agentPid: a.started.agent, helperPid: a.started.helper };
}

/** The crash: the session's process is killed with SIGKILL; its agent's process group (detached, as every job's) stays. */
async function crash(child: ChildProcess): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-orphan-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-orphan-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
  started = path.join(fixtures, 'agent-started.json');
  fs.writeFileSync(path.join(fixtures, 'fake-python'), '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  agent = orphanAgent();
});

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const pid of extra.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  // What a test left of its agents (a failed test may leave one): its process group is ended.
  try { const s = JSON.parse(fs.readFileSync(started, 'utf8')) as { agent: number; helper: number }; for (const p of [s.agent, s.helper]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
  try { await until('the test\'s processes to end', () => ours().length === 0, 20_000); } catch { for (const p of ours()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

describe('an agent step\'s job left running by a REPL that was killed (R4 H46, row 153)', () => {
  it('its process group is stopped (SIGTERM ends it) before the flow is recorded interrupted; the stop is said in the lines, the job\'s record and the flow\'s', async () => {
    const s = await crashable();
    // What a crash leaves: its record says running; its agent and the agent's helper run on, the agent no child of the REPL now.
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'running', pid: s.agentPid, owner: { pid: s.child.pid } });
    await crash(s.child);
    expect(alive(s.agentPid) && alive(s.helperPid)).toBe(true);
    expect(new JobManager({ dir: jobsDir }).get(s.job)?.stale).toBeUndefined();

    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    // The agent and its helper are stopped: SIGTERM was enough.
    await until('the agent group to be gone', () => !alive(s.agentPid) && !alive(s.helperPid), 10_000);
    const item = report.items.find((i) => i.id === s.flow)!;
    expect(item).toMatchObject({ kind: 'flow', did: 'interrupted', state: 'agent', stopped: { job: s.job, process_group: s.agentPid, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' } });
    // The job's own record: ended, cancelled, saying why (through JobManager.endLeft).
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({ state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM', cleanup: 'complete', exitCode: null, signal: null });
    expect(job.stale).toBeUndefined();
    expect(typeof job.endedAt).toBe('string');
    // The flow's record says it, once.
    const record = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${s.flow}.json`), 'utf8'));
    expect(record).toMatchObject({ outcome: 'interrupted', ended_in: 'agent' });
    expect(record.why).toBe(`the REPL running it ended while its agent ran (its job ${s.job} was still running after its REPL ended: recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM); nothing was built; recorded after a restart, and nothing was run again`);
    expect(record.recovered.job).toEqual({
      id: s.job, state: 'running',
      stopped: { process_group: s.agentPid, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' },
      ended: { state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM' },
    });
    expect(sealed.filter((r) => r.kind === 'flow')).toHaveLength(1);
    // The lines: the summary first, then the item.
    expect(notes[0]).toContain(`1 job left running by a REPL that ended was stopped: ${s.job}`);
    expect(notes[0]).toContain(`1 flow was interrupted: ${s.flow} (record written)`);
    expect(notes.join('\n')).toContain(`flow ${s.flow} was interrupted in its agent step (its job ${s.job} was still running after its REPL ended: recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM); its job record now says cancelled: its REPL ended; recovery stopped its process group with SIGTERM: record results/flows/${s.flow}.json`);
    noAbsolute(notes.join('\n'));
    // A later pass finds nothing more to do.
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
  }, 120_000);

  it('an agent that ignores SIGTERM: SIGKILL after the grace period; the record says both signals', async () => {
    const s = await crashable('NOTERM');
    await crash(s.child);
    const { ws, notes } = make();
    const t0 = Date.now();
    const report = (await ws.startRecovery)!;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(alive(s.agentPid) || alive(s.helperPid)).toBe(false);
    expect(report.items.find((i) => i.id === s.flow)).toMatchObject({ did: 'interrupted', stopped: { signals: ['SIGTERM', 'SIGKILL'], cleanup: 'complete', processes: 2 } });
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM, then SIGKILL', cleanup: 'complete' });
    const record = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${s.flow}.json`), 'utf8'));
    expect(record.recovered.job.stopped).toEqual({ process_group: s.agentPid, processes: 2, signals: ['SIGTERM', 'SIGKILL'], cleanup: 'complete' });
    expect(notes.join('\n')).toContain('with SIGTERM, then SIGKILL');
  }, 120_000);

  it('an agent whose process is gone (stopped by hand after the kill): the job\'s record is ended, failed, "its REPL ended; its process is gone"', async () => {
    const s = await crashable();
    await crash(s.child);
    // Stopped by hand, as on the Mac: then its record is stale (running, its process and group gone).
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    const { ws, notes } = make();
    const report = (await ws.startRecovery)!;
    expect(report.items.find((i) => i.id === s.flow)).toMatchObject({ did: 'interrupted', state: 'agent' });
    expect(report.items.find((i) => i.id === s.flow)?.stopped).toBeUndefined();
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({ state: 'failed', error: GONE_WORDS, exitCode: null, signal: null });
    expect(GONE_WORDS).toBe('its REPL ended; its process is gone');
    expect(job.stale).toBeUndefined();
    const record = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${s.flow}.json`), 'utf8'));
    expect(record.recovered.job).toEqual({ id: s.job, state: 'running', stale: true, ended: { state: 'failed', error: GONE_WORDS } });
    expect(notes.join('\n')).toContain(`(its job ${s.job} was left running and its process is gone); its job record now says failed: its REPL ended; its process is gone: record results/flows/${s.flow}.json`);
    // The job's end is recorded once: a later pass leaves its record as it is.
    const again = JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job));
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job))).toBe(again);
  }, 120_000);
});

describe('the job module\'s side: each record names its owner; endLeft ends only a live record another session left', () => {
  it('owner is this process (its pid and start); endLeft writes once, never this manager\'s own job, never an ended record', async () => {
    const mine = new JobManager({ dir: jobsDir });
    const job = mine.start({ kind: 'task', label: 'sleeps', project: 'demo', root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] });
    expect(job.owner?.pid).toBe(process.pid);
    expect(Math.abs(Date.parse(job.owner!.startedAt) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2000);
    expect(JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), 'utf8')).owner).toEqual(job.owner);
    // This manager's own job is never ended from here.
    expect(mine.endLeft(job.id, { state: 'failed', error: GONE_WORDS })).toBeUndefined();
    // Another manager on the same folder (another session) may end it: once, as a live record, with null exit facts.
    const other = new JobManager({ dir: jobsDir });
    const ended = other.endLeft(job.id, { state: 'failed', error: GONE_WORDS });
    expect(ended).toMatchObject({ id: job.id, state: 'failed', error: GONE_WORDS, exitCode: null, signal: null, owner: job.owner });
    expect(ended?.stale).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), 'utf8'))).toMatchObject({ state: 'failed', error: GONE_WORDS });
    expect(other.endLeft(job.id, { state: 'cancelled', error: 'again' })).toBeUndefined();
    expect(other.endLeft('j000000', { state: 'failed', error: GONE_WORDS })).toBeUndefined();
    await mine.stop(job.id);
  });
});

describe('what is not proven is not stopped', () => {
  /** SYNTHETIC: a flow's state file as /iterate writes it while its agent runs, naming the agent's job. */
  const writeState = (id: string, job: string): void => {
    const dir = path.join(root, '.timmy', 'flows', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), `${JSON.stringify({
      flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it 160 mm wide', project: 'demo', started_at: new Date().toISOString(), outcome: 'running',
      parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
      agent: { run: 'a0123abcd', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: 'qwen3:4b', job, result: '.timmy/agents/a0123abcd/result.json', progress: '.timmy/agents/a0123abcd/progress.log' },
      receipts: {}, child_receipts: [], step: 'agent',
    }, null, 2)}\n`);
  };

  it('a record whose process did not start when the job did: nothing is stopped; the lines say what runs and how to stop it; nothing is recorded', async () => {
    // A process in its own group that is not that job's: it started now, the record says ten minutes ago.
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    extra.push(other.pid!);
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    // SYNTHETIC: a job record naming that process, left running by a REPL whose process is gone.
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'j0bad01.json'), JSON.stringify({
      id: 'j0bad01', kind: 'task', label: 'agent qwen a0123abcd: make it 160 mm wide', project: 'demo', root, command: agent, args: ['-p', 'x'], state: 'running', pid: other.pid,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), steps: [], lines: 0, owner: { pid: gone, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() },
    }));
    writeState('f0000bbbb', 'j0bad01');
    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    expect(alive(other.pid!)).toBe(true);
    const item = report.items.find((i) => i.id === 'f0000bbbb')!;
    expect(item).toMatchObject({ kind: 'flow', did: 'left', attention: true, job: 'j0bad01' });
    expect(item.text).toContain(`flow f0000bbbb is in its agent step, and its job j0bad01 was left running by a REPL that has ended; 1 process of its process group ${other.pid} still runs: pid ${other.pid} (`);
    expect(item.text).toMatch(new RegExp(`Nothing was stopped, because the oldest process of its group \\(pid ${other.pid}\\) started at \\S+, not when the job did \\(\\S+\\): kill -TERM -- -${other.pid} stops the group \\(then kill -KILL -- -${other.pid} if any of it is left\\), and /recover records the flow once it has ended`));
    // Said at the start (it needs the operator), and nothing recorded or sealed.
    expect(notes[0]).toContain('1 job left running by a REPL that ended was not stopped: what runs, and how to stop it, below');
    expect(fs.existsSync(path.join(root, 'results', 'flows', 'f0000bbbb.json'))).toBe(false);
    expect(sealed).toEqual([]);
    expect(new JobManager({ dir: jobsDir }).get('j0bad01')).toMatchObject({ state: 'running' });
    // Once that group has ended (stopped as the line says), its record is stale, and the next pass records the flow.
    process.kill(-other.pid!, 'SIGTERM');
    await until('that job\'s record to be stale', () => new JobManager({ dir: jobsDir }).get('j0bad01')?.stale === true, 10_000);
    expect(text(await ws.recover(''))).toContain('1 flow was interrupted: f0000bbbb (record written)');
    expect(new JobManager({ dir: jobsDir }).get('j0bad01')).toMatchObject({ state: 'failed', error: GONE_WORDS });
  }, 60_000);

  it('a session that is still running (its REPL is the agent\'s parent): its agent is left alone and said to run in another session', async () => {
    const first = make({ recoverAtStart: false });
    const out = text(await first.ws.iterate('tray "make it 180 mm wide"'));
    const flow = out.match(/Flow\s+(f[0-9a-f]{8})/)![1];
    const job = out.match(/Agent\s+(j[0-9a-f]{6})/)![1];
    await until('the agent to start', () => fs.existsSync(started));
    const pids = JSON.parse(fs.readFileSync(started, 'utf8')) as { agent: number; helper: number };
    const second = make({ recoverAtStart: false });
    const said = text(await second.ws.recover(''));
    expect(said).toContain(`flow ${flow} is in its agent step and its job ${job} still runs (another session): /recover again once it has ended`);
    expect(alive(pids.agent) && alive(pids.helper)).toBe(true);
    expect(second.sealed).toEqual([]);
    expect(new JobManager({ dir: jobsDir }).get(job)).toMatchObject({ state: 'running' });
    expect(fs.existsSync(path.join(root, 'results', 'flows', `${flow}.json`))).toBe(false);
  }, 60_000);
});
