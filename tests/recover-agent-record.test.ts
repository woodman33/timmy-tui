/**
 * Round R4 (helper H59; r18, ledger row 157, defect 4): the code agent's own run record after recovery.
 *
 * On the operator's Mac a REPL was killed with SIGKILL in /iterate tray's agent step. The next REPL's /recover stopped the
 * agent's process group with proof and recorded the job cancelled and the flow interrupted, but the agent's own record,
 * .timmy/agents/<run>/run.json, stayed "submitted" with no end, and /room <flow> listed .timmy/agents/<run>/result.json as
 * an output although that file was never written. Now recovery ends the run's record through the code-agent module's one
 * writer of it (writeRunRecord) whenever it ends or stops the job of a flow's agent step or of a plain /agent run left by
 * an ended REPL: its state in words (interrupted), when, why (stopped by recovery with which signal, or its process found
 * gone) and the job that ran it; no result is ever claimed (no outcome, files, final message, cost or result.json). The
 * flow's interrupted record and receipt name that record (path and sha256); a plain run's end is sealed as a recover receipt.
 *
 * The crashes are real: a REPL session runs as its own process (tests/fixtures/recover-crash-fixture.ts, a real Workspace,
 * its `agent` step for /iterate tray, its `plain-agent` step for /agent qwen) and is killed with SIGKILL, never closed. Its
 * agent is a TEST DOUBLE written here, as in tests/recover-orphan.test.ts (no model, nothing sent): it starts a helper in
 * its own process group, writes both pids to a file, prints nothing more and waits until it is stopped. One test ends a job
 * record through the job module's own writer (JobManager.endLeft) by hand, as an earlier recovery did on the Mac (r18).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderProject, projectId } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { GONE_WORDS } from '../src/repl/recover.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { JobManager } from '../src/jobs/index.js';
import { guardRealHome } from './fixtures/home-guard.js';

// The crashed sessions run with their own HOME and TIMMY_HOME (under the test's fixtures folder); nothing here may change
// the real home's timmy folders (tests/fixtures/home-guard.ts reads them before and after).
const realHome = guardRealHome();
afterAll(() => { expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

const FIXTURE = path.resolve('tests/fixtures/recover-crash-fixture.ts');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');

let root: string;
let fixtures: string;
let jobsDir: string;
let agent: string;
let started: string;
const spaces: Workspace[] = [];
const children: ChildProcess[] = [];
type Lines = Array<Array<{ text: string }>>;
const text = (lines: Lines): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const ours = (): Array<{ pid: number; args: string }> => String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && (m[2].includes(root) || m[2].includes(fixtures)))
  .map((m) => ({ pid: Number(m[1]), args: m[2] }));
const noAbsolute = (s: string): void => { for (const p of new Set([root, fixtures, os.tmpdir()])) expect(s).not.toContain(p); };
const runFile = (run: string): string => path.join(root, '.timmy', 'agents', run, 'run.json');
const readRun = (run: string): Record<string, any> => JSON.parse(fs.readFileSync(runFile(run), 'utf8'));
/** The lines of /room <id> from its "Outputs" label up to (not including) the next label. */
const section = (out: string, label: string): string[] => {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`  ${label}`));
  if (at < 0) return [];
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((l) => /^ {2}\S/.test(l));
  return [lines[at], ...(next < 0 ? rest : rest.slice(0, next))];
};

/** The TEST DOUBLE agent (see the header): reports its start, starts its helper, writes both pids, waits until stopped. */
function orphanAgent(): string {
  const file = path.join(fixtures, 'bin', 'orphan-agent.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node
// FAKE code agent (a TEST DOUBLE for tests/recover-agent-record.test.ts): NOT Qwen Code; it calls no model and sends nothing.
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('0.0.0-fake (a FAKE code agent, not a real one)'); process.exit(0); }
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fake-session', model: 'fake', tools: [], qwen_code_version: '0.0.0-fake' }) + '\\n');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
const at = ${JSON.stringify(started)};
fs.writeFileSync(at + '.tmp', JSON.stringify({ agent: process.pid, helper: helper.pid }));
fs.renameSync(at + '.tmp', at);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return file;
}

/** A REPL session in this process, on the test's project and jobs folder; its seals are kept as a chain the room can read. */
function make(o: { recoverAtStart?: boolean } = {}) {
  const notes: string[] = [];
  const sealed: Array<ReceiptInput & { id: string; hash: string }> = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: agent, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: path.join(fixtures, 'fake-python') },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    // FAKE receipts: the inputs, each with a made-up id and hash (no chain is written).
    seal: (input) => { const id = `id${sealed.length + 1}`; sealed.push({ ...input, id, hash: `sha256_${sha(`FAKE receipt ${id}`)}` }); return id; },
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

interface Crashed { child: ChildProcess; job: string; run: string; flow?: string; agentPid: number; helperPid: number }

/** A REPL session as its own process, left with its agent running (a flow's agent step, or a plain /agent run). */
async function crashable(step: 'agent' | 'plain-agent'): Promise<Crashed> {
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({
    root, jobsDir, executor: path.join(fixtures, 'no-executor-needed.mts'), fakePython: path.join(fixtures, 'fake-python'), agent, readback: FAKE_READBACK,
    seals: path.join(fixtures, 'crashed-seals.jsonl'), nativeStarted: path.join(fixtures, 'release-native.runs'), steps: [step], agentStarted: started,
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: path.join(fixtures, 'home'), TIMMY_HOME: path.join(fixtures, 'home', 'timmy') } });
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
  if (step === 'agent') {
    const a = ready.agent as { flow: string; job: string; started: { agent: number; helper: number } };
    const state = JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'flows', a.flow, 'state.json'), 'utf8')) as { agent: { run: string } };
    return { child, job: a.job, run: state.agent.run, flow: a.flow, agentPid: a.started.agent, helperPid: a.started.helper };
  }
  const p = ready.plainAgent as { run: string; job: string; started: { agent: number; helper: number } };
  return { child, job: p.job, run: p.run, agentPid: p.started.agent, helperPid: p.started.helper };
}

/** The crash: the session's process is killed with SIGKILL; its agent's process group (detached, as every job's) stays. */
async function crash(child: ChildProcess): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}

/** What a crash leaves of the run's own record: submitted, no end, no result. */
function expectSubmitted(c: Crashed): void {
  expect(readRun(c.run)).toMatchObject({ run: c.run, job: c.job, state: 'submitted' });
  expect(readRun(c.run).ended_at).toBeUndefined();
  expect(fs.existsSync(path.join(root, '.timmy', 'agents', c.run, 'result.json'))).toBe(false);
}

/** No result is claimed: none of the fields only a judged end writes, and no result.json. */
function expectNoResultClaimed(run: string): void {
  const rec = readRun(run);
  for (const k of ['outcome', 'files', 'judged', 'final_message', 'progress', 'cost_usd', 'cost_basis', 'exit_code', 'signal', 'transcript']) expect(rec, k).not.toHaveProperty(k);
  expect(fs.existsSync(path.join(root, '.timmy', 'agents', run, 'result.json'))).toBe(false);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-agent-record-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-agent-record-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
  started = path.join(fixtures, 'agent-started.json');
  fs.writeFileSync(path.join(fixtures, 'fake-python'), '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  agent = orphanAgent();
});

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { const s = JSON.parse(fs.readFileSync(started, 'utf8')) as { agent: number; helper: number }; for (const p of [s.agent, s.helper]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
  try { await until('the test\'s processes to end', () => ours().length === 0, 20_000); } catch { for (const p of ours()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

describe('a flow\'s agent step left by a REPL killed with SIGKILL: the agent\'s own record ends with the flow (r18 defect 4)', () => {
  it('stopped by recovery: run.json says interrupted, when, why (the signal) and the job; no result is claimed; the flow\'s record and receipt name it; /room says result.json was not written', async () => {
    const s = await crashable('agent');
    await crash(s.child);
    expectSubmitted(s);
    const { ws, sealed, notes } = make();
    const report = (await ws.startRecovery)!;
    await until('the agent group to be gone', () => !alive(s.agentPid) && !alive(s.helperPid), 10_000);
    expect(report.items.find((i) => i.id === s.flow)).toMatchObject({ did: 'interrupted', stopped: { job: s.job, signals: ['SIGTERM'], cleanup: 'complete' } });
    // The run's own record: ended in words, with the job that ran it; the job's own record says the same stop.
    const rec = readRun(s.run);
    const why = `its REPL ended while it ran; recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM; no result was written`;
    expect(rec).toMatchObject({
      agent_run: 1, run: s.run, agent: 'qwen', job: s.job, state: 'interrupted', why,
      recovered: {
        by: 'recovery', process: 'stopped by recovery', flow: s.flow, result: 'not written',
        job: { id: s.job, state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM' },
        stopped: { process_group: s.agentPid, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' },
      },
    });
    expect(Number.isNaN(Date.parse(rec.ended_at))).toBe(false);
    expect(rec.recovered.at).toBe(rec.ended_at);
    expectNoResultClaimed(s.run);
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'cancelled' });
    // The flow's record names the agent's record (its path and sha256 as written); the rest of the record is as before.
    const runBytes = fs.readFileSync(runFile(s.run));
    const flowRecord = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${s.flow}.json`), 'utf8'));
    expect(flowRecord.recovered.agent).toEqual({ run: s.run, record: `.timmy/agents/${s.run}/run.json`, sha256: sha(runBytes), state: 'interrupted', result: 'not written' });
    expect(flowRecord.recovered.job).toEqual({ id: s.job, state: 'running', stopped: { process_group: s.agentPid, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' }, ended: { state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM' } });
    expect(flowRecord).toMatchObject({ outcome: 'interrupted', ended_in: 'agent', agent: { run: s.run, result: `.timmy/agents/${s.run}/result.json` } });
    // Its receipt: one flow receipt, whose sources name the state file and the agent's record with its sha256.
    const flows = sealed.filter((r) => r.kind === 'flow');
    expect(flows).toHaveLength(1);
    expect(flows[0].sources).toEqual([
      expect.objectContaining({ path: `.timmy/flows/${s.flow}/state.json`, role: 'the flow state its session left' }),
      { path: `.timmy/agents/${s.run}/run.json`, sha256: sha(runBytes), role: 'the agent\'s run record, ended by this recovery as interrupted (no result was written)' },
    ]);
    expect(notes.join('\n')).toContain(`its agent's record .timmy/agents/${s.run}/run.json now says interrupted (no result was written)`);
    // /room <flow>: result.json is named as not written, never listed as an output.
    const room = text(await ws.room(s.flow));
    const outputs = section(room, 'Outputs');
    expect(outputs.join('\n')).not.toContain('result.json');
    expect(section(room, 'Missing').join('\n')).toContain(`.timmy/agents/${s.run}/result.json: not written`);
    expect(outputs.join('\n')).toContain(`results/flows/${s.flow}.json`);
    // /room <run>: its state in words, its record (sealed by the flow's receipt), and no result.
    const one = text(await ws.room(s.run));
    expect(one).toContain(`interrupted: ${why}`);
    expect(one).toMatch(/2\. result {2}Timmy \(its result\.json, read by its own rules\) · none written/);
    expect(one).toContain(`.timmy/agents/${s.run}/run.json`);
    expect(section(one, 'Outputs').join('\n')).not.toContain('result.json');
    noAbsolute(`${room}\n${one}\n${notes.join('\n')}`);
    // A later pass changes nothing more: the record is ended once.
    const again = fs.readFileSync(runFile(s.run));
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(fs.readFileSync(runFile(s.run)).equals(again)).toBe(true);
  }, 120_000);

  it('its process gone before recovery: run.json says interrupted, its process found gone (when it ended is not recorded), no result', async () => {
    const s = await crashable('agent');
    await crash(s.child);
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s job record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    const { ws } = make();
    await ws.startRecovery;
    const rec = readRun(s.run);
    expect(rec).toMatchObject({
      state: 'interrupted', job: s.job,
      why: 'its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written',
      recovered: { process: 'gone', flow: s.flow, result: 'not written', job: { id: s.job, state: 'failed', error: GONE_WORDS } },
    });
    expect(rec.recovered.stopped).toBeUndefined();
    expectNoResultClaimed(s.run);
    const flowRecord = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${s.flow}.json`), 'utf8'));
    expect(flowRecord.recovered.agent).toMatchObject({ run: s.run, state: 'interrupted', sha256: sha(fs.readFileSync(runFile(s.run))) });
  }, 120_000);
});

describe('a plain /agent run left by a REPL killed with SIGKILL (no flow)', () => {
  it('its process group is stopped with proof, its job\'s record ended, its own record ended as interrupted, and the end sealed as a recover receipt', async () => {
    const s = await crashable('plain-agent');
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'running', pid: s.agentPid, owner: { pid: s.child.pid } });
    await crash(s.child);
    expect(alive(s.agentPid) && alive(s.helperPid)).toBe(true);
    expectSubmitted(s);
    const { ws, sealed, notes } = make();
    const report = (await ws.startRecovery)!;
    await until('the agent group to be gone', () => !alive(s.agentPid) && !alive(s.helperPid), 10_000);
    const item = report.items.find((i) => i.id === s.run)!;
    expect(item).toMatchObject({ kind: 'agent-run', did: 'interrupted', job: s.job, stopped: { job: s.job, process_group: s.agentPid, processes: 2, signals: ['SIGTERM'], cleanup: 'complete' } });
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM', cleanup: 'complete' });
    const why = `its REPL ended while it ran; recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM; no result was written`;
    const rec = readRun(s.run);
    expect(rec).toMatchObject({ state: 'interrupted', job: s.job, why, recovered: { process: 'stopped by recovery', result: 'not written', job: { id: s.job, state: 'cancelled' }, stopped: { signals: ['SIGTERM'] } } });
    expect(rec.recovered.flow).toBeUndefined();
    expectNoResultClaimed(s.run);
    // One recover receipt, sealing the record's bytes as written.
    const bytes = fs.readFileSync(runFile(s.run));
    const recovers = sealed.filter((r) => r.kind === 'recover');
    expect(recovers).toHaveLength(1);
    expect(recovers[0]).toMatchObject({
      subject: `recover · agent · qwen · ${s.run} · interrupted`, status: 'ok', project_id: projectId(root),
      outputs: [{ path: `.timmy/agents/${s.run}/run.json`, sha256: sha(bytes), bytes: bytes.length }],
    });
    expect((recovers[0].sources as Array<Record<string, unknown>>)[0]).toMatchObject({ operation: s.run, agent: 'qwen', job: s.job, action: 'stopped its process group', why });
    expect(sealed.filter((r) => r.kind === 'flow' || r.kind === 'agent')).toEqual([]);
    // The lines: the stop and the record, at the REPL's start.
    expect(notes[0]).toContain(`1 job left running by a REPL that ended was stopped: ${s.job}`);
    expect(notes[0]).toContain(`1 agent run left by a REPL that ended was recorded as interrupted: ${s.run}`);
    expect(notes.join('\n')).toContain(`agent run ${s.run} (Qwen Code, job ${s.job}) was left running by a REPL that ended: recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM; its job record now says cancelled; its record .timmy/agents/${s.run}/run.json now says interrupted (no result was written); receipt id1`);
    noAbsolute(notes.join('\n'));
    // /room <run>: its state in words, sealed by that receipt.
    const one = text(await ws.room(s.run));
    expect(one).toContain(`interrupted: ${why}`);
    expect(one).toContain(`receipt ${String(recovers[0].hash).slice(7, 15)}`);
    // /agent last and /results say interrupted too, with its record's words, and no result.
    const last = text(await ws.agent('last'));
    expect(last).toMatch(new RegExp(`Agent run {2}${s.run} {2}qwen 0\\.0\\.0-fake.*interrupted`));
    expect(last).toContain(why);
    expect(last).toContain(`.timmy/agents/${s.run}/run.json`);
    expect(text(ws.results(''))).toContain(`${s.run}  qwen  interrupted`);
    // Once: a later pass leaves it as it is.
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(fs.readFileSync(runFile(s.run)).equals(bytes)).toBe(true);
    expect(sealed.filter((r) => r.kind === 'recover')).toHaveLength(1);
  }, 120_000);

  it('its process gone: its job\'s record ended failed, "its REPL ended; its process is gone", and its own record interrupted', async () => {
    const s = await crashable('plain-agent');
    await crash(s.child);
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s job record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    const { ws, sealed } = make();
    const report = (await ws.startRecovery)!;
    expect(report.items.find((i) => i.id === s.run)).toMatchObject({ kind: 'agent-run', did: 'interrupted', job: s.job });
    expect(report.items.find((i) => i.id === s.run)?.stopped).toBeUndefined();
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'failed', error: GONE_WORDS });
    expect(readRun(s.run)).toMatchObject({ state: 'interrupted', why: 'its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written', recovered: { process: 'gone', job: { id: s.job, state: 'failed', error: GONE_WORDS } } });
    expectNoResultClaimed(s.run);
    expect(sealed.filter((r) => r.kind === 'recover')).toEqual([expect.objectContaining({ subject: `recover · agent · qwen · ${s.run} · interrupted`, status: 'ok' })]);
  }, 120_000);

  it('a job an earlier recovery ended (as on the Mac at r18) whose run still says submitted: its record is ended with its job record\'s words', async () => {
    const s = await crashable('plain-agent');
    await crash(s.child);
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s job record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    // What an earlier recovery wrote, through the job module's own writer: the job ended; the run's record left submitted.
    const earlier = new JobManager({ dir: jobsDir }).endLeft(s.job, { state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM', cleanup: 'complete' })!;
    expect(earlier).toMatchObject({ state: 'cancelled' });
    expectSubmitted(s);
    const { ws } = make();
    const report = (await ws.startRecovery)!;
    expect(report.items.find((i) => i.id === s.run)).toMatchObject({ kind: 'agent-run', did: 'interrupted' });
    const rec = readRun(s.run);
    expect(rec).toMatchObject({
      state: 'interrupted', ended_at: earlier.endedAt,
      why: 'its REPL ended while it ran; its job record says cancelled: its REPL ended; recovery stopped its process group with SIGTERM; no result was written',
      recovered: { process: 'ended before', job: { id: s.job, state: 'cancelled', error: 'its REPL ended; recovery stopped its process group with SIGTERM' } },
    });
    expectNoResultClaimed(s.run);
    // The job's own record is left as that recovery wrote it.
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'cancelled', endedAt: earlier.endedAt });
  }, 120_000);

  it('a run another live session runs (its REPL is the agent\'s parent) is left alone and its record unchanged', async () => {
    const first = make({ recoverAtStart: false });
    const said = text(await first.ws.agent('qwen make it 170 mm wide'));
    const m = said.match(/Agent\s+(j[0-9a-f]{6})\s+agent qwen (a[0-9a-f]{8})/)!;
    await until('the agent to start', () => fs.existsSync(started));
    const before = fs.readFileSync(runFile(m[2]));
    const second = make({ recoverAtStart: false });
    const out = text(await second.ws.recover(''));
    expect(out).toContain(`agent run ${m[2]} (Qwen Code, job ${m[1]}) still runs (another session): /recover again once it has ended`);
    expect(fs.readFileSync(runFile(m[2])).equals(before)).toBe(true);
    expect(second.sealed).toEqual([]);
    expect(new JobManager({ dir: jobsDir }).get(m[1])).toMatchObject({ state: 'running' });
  }, 60_000);
});
