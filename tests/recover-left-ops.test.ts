/**
 * Round R4 (helper H68; r20, ledger row 162, findings 2 and 3): what a REPL that ended left, in "Waiting on you"
 * (`/decisions` and the Control Room), and the operations recovery settles.
 *
 * On the operator's Mac (r20) a REPL killed with SIGKILL during a plain `/agent qwen` run left the agent's process group
 * running; "Waiting on you" showed nothing, though `/recover` then stopped that group and recorded the run interrupted. A
 * workflow run `/recover` had recorded interrupted dropped off the list. And the operation's record still said "running",
 * its card "…it was left as it was", after `/recover` had ended its runs.
 *
 * The crashes are real: a REPL session runs as its own process (tests/fixtures/recover-crash-fixture.ts, a real Workspace,
 * each command run as the REPL runs a typed line, in an operation of its own; tests/fixtures/workflow-crash-fixture.ts for
 * a /run) and is killed with SIGKILL, never closed. Every record is written by its own writer (the job manager, the code
 * agent's run record, the flow's state and record, the operation log), and the recovery is the real /recover. What is not
 * real, each labelled where it is used:
 *   - the code agent is a TEST DOUBLE (as in tests/recover-agent-record.test.ts): it calls no model and sends nothing; it
 *     starts a helper in its own process group, writes both pids to a file and waits until it is stopped;
 *   - upmd is the TEST DOUBLE tests/fixtures/fake-upmd.mjs (it is not upmd; its blocks run for real);
 *   - the receipts are FAKE (each input kept with a made-up id and hash; no chain is written);
 *   - the /tools rows are FAKE (none: nothing on this machine is probed for them);
 *   - the OpenHands test writes its job's record by hand (SYNTHETIC: docker cannot run here); its run's record goes through
 *     the code agent's own writer, and its "docker client" is a plain waiting process (FAKE).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRunRecord, type AgentRunRecord } from '../src/code-agents/index.js';
import { JobManager } from '../src/jobs/index.js';
import { endLeftOperation, OperationLog, parseOperationRecord, readOperationRecord, writeOperationRecord, type OperationRecord } from '../src/ops/operations.js';
import { THIS_PROCESS } from '../src/ops/process-proof.js';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { guardRealHome } from './fixtures/home-guard.js';

// The crashed sessions run with their own HOME and TIMMY_HOME (under the test's fixtures folder); nothing here may change
// the real home's timmy folders (tests/fixtures/home-guard.ts reads them before and after).
const realHome = guardRealHome();
afterAll(() => { expect(realHome.check(), 'changed under the real home\'s timmy folders while these tests ran').toEqual([]); });

const FIXTURE = path.resolve('tests/fixtures/recover-crash-fixture.ts');
const RUN_FIXTURE = path.resolve('tests/fixtures/workflow-crash-fixture.ts');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');
const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('recover-left-ops: no python3 here, so the /run crash case (upmd on a pty) is skipped');
const F = '```';
/** first; long needs first and runs until it is stopped; after needs long. */
const DOC = ['# Work', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'echo started', 'sleep 60', F, '', `${F}bash [name:after, deps:long]`, 'echo after', F, ''].join('\n');

let root: string;
let fixtures: string;
let jobsDir: string;
let agent: string;
let started: string;
const spaces: Workspace[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
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
const opFile = (id: string): string => path.join(root, '.timmy', 'operations', `${id}.json`);
const readOp = (id: string): Record<string, any> => JSON.parse(fs.readFileSync(opFile(id), 'utf8'));
const runsOf = (rec: Record<string, any>): string[] => (rec.runs as Array<{ kind: string; id: string }>).map((r) => `${r.kind}:${r.id}`).sort();
/** The board's card of one operation (the snapshot's HTML). */
const cardHtml = (html: string, op: string): string => {
  const at = html.indexOf(`data-op="${op}"`);
  expect(at, `the board has no card of ${op}`).toBeGreaterThan(0);
  return html.slice(at, html.indexOf('</article>', at));
};
/** A pid that is not running: a process that has already exited. */
const gonePid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

/** The TEST DOUBLE agent (see the header): reports its start, starts its helper, writes both pids, waits until stopped. */
function orphanAgent(): string {
  const file = path.join(fixtures, 'bin', 'orphan-agent.mjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node
// FAKE code agent (a TEST DOUBLE for tests/recover-left-ops.test.ts): NOT Qwen Code; it calls no model and sends nothing.
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

/** A REPL session in this process, on the test's project and jobs folder; no recovery at its start unless asked. */
function make(o: { python3?: string | null } = {}) {
  const notes: string[] = [];
  const sealed: Array<ReceiptInput & { id: string; hash: string }> = [];
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: agent, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: path.join(fixtures, 'fake-python'), UPMD_BIN: FAKE_UPMD },
    onPath: (cmd) => (cmd === 'python3' && o.python3 ? o.python3 : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    // FAKE receipts: the inputs, each with a made-up id and hash (no chain is written).
    seal: (input) => { const id = `id${sealed.length + 1}`; sealed.push({ ...input, id, hash: `sha256_${sha(`FAKE receipt ${id}`)}` }); return id; },
    jobsDir,
    chdir: () => {},
    receipts: () => sealed as unknown as Receipt[],
    // FAKE /tools rows: none (nothing on this machine is probed for the Control Room's setup part).
    roomTools: async () => [],
    iterateTest: { readback: (step) => ({ command: process.execPath, args: [FAKE_READBACK, 'match', step.abs, '--as', step.rel] }), settleMs: 15_000 },
    recoverAtStart: false,
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

interface Crashed { child: ChildProcess; job: string; run: string; flow?: string; agentPid: number; helperPid: number }

/** A REPL session as its own process, each command typed (in an operation of its own), left with its agent running. */
async function crashable(step: 'agent' | 'plain-agent'): Promise<Crashed> {
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({
    root, jobsDir, executor: path.join(fixtures, 'no-executor-needed.mts'), fakePython: path.join(fixtures, 'fake-python'), agent, readback: FAKE_READBACK,
    seals: path.join(fixtures, 'crashed-seals.jsonl'), nativeStarted: path.join(fixtures, 'release-native.runs'), steps: [step], agentStarted: started, operate: true,
  }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: path.join(fixtures, 'home'), TIMMY_HOME: path.join(fixtures, 'home', 'timmy') } });
  children.push(child);
  const ready = await readyLine(child);
  if (step === 'agent') {
    const a = ready.agent as { flow: string; job: string; started: { agent: number; helper: number } };
    const state = JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'flows', a.flow, 'state.json'), 'utf8')) as { agent: { run: string } };
    groups.push(a.started.agent);
    return { child, job: a.job, run: state.agent.run, flow: a.flow, agentPid: a.started.agent, helperPid: a.started.helper };
  }
  const p = ready.plainAgent as { run: string; job: string; started: { agent: number; helper: number } };
  groups.push(p.started.agent);
  return { child, job: p.job, run: p.run, agentPid: p.started.agent, helperPid: p.started.helper };
}

/** The READY line a crash fixture prints once what it started is under way. */
function readyLine(child: ChildProcess): Promise<Record<string, any>> {
  let out = '';
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session did not get ready: ${out}${err}`)), 90_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      const m = out.match(/^READY (.*)$/m);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1]) as Record<string, any>); } else if (/^FAILED /m.test(out)) { clearTimeout(timer); reject(new Error(`${out}${err}`)); }
    });
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the session ended (${code ?? signal}) before it was ready: ${out}${err}`)); });
  });
}

/** The crash: the session's process is killed with SIGKILL; what its jobs started (each its own process group) stays. */
async function crash(child: ChildProcess): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h68-left-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h68-left-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
  started = path.join(fixtures, 'agent-started.json');
  fs.writeFileSync(path.join(fixtures, 'fake-python'), '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'WORK.md'), DOC);
  agent = orphanAgent();
});

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  try { const s = JSON.parse(fs.readFileSync(started, 'utf8')) as { agent: number; helper: number }; for (const p of [s.agent, s.helper]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  try { await until('the test\'s processes to end', () => ours().length === 0, 20_000); } catch { for (const p of ours()) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

const NOTHING_WAITS = 'Waiting on you  nothing in ';

describe('a plain /agent run left by a REPL killed with SIGKILL (r20 findings 2 and 3)', () => {
  it('still running in its own process group: Waiting on you lists it with /recover; /recover stops it, and its operation\'s record ends interrupted', async () => {
    const s = await crashable('plain-agent');
    await crash(s.child);
    expect(alive(s.agentPid) && alive(s.helperPid)).toBe(true);
    const op = String(readRun(s.run).operation);
    expect(op).toMatch(/^o[0-9a-f]{8}$/);
    // What the crash left of the operation: its record says it runs, written by the REPL that was killed.
    const before = readOp(op);
    expect(before).toMatchObject({ schema: 'timmy.operation/1', id: op, request: '/agent qwen make it 180 mm wide', via: 'repl', state: 'running', ended: null, parent: null, owner: { pid: s.child.pid } });
    expect(before.why).toBeUndefined();
    expect(runsOf(before)).toEqual([`agent:${s.run}`, `job:${s.job}`].sort());
    const { ws, sealed } = make();
    expect(text(ws.op(op))).toContain('its record says it runs, and the Timmy that wrote it has ended: it was left as it was');

    // Waiting on you, before /recover: the run, still running in its own process group, with /recover as the action.
    const waiting = text(await ws.decisions(''));
    const why = `agent run ${s.run} (Qwen Code, job ${s.job}) is still running in its own process group ${s.agentPid}, and the REPL that started it has ended`;
    expect(waiting).toContain('    ! 1 run was left by a Timmy session that ended  left by a session that ended');
    expect(waiting).toContain(`why     ${why}`);
    expect(waiting).toContain(`record  .timmy/agents/${s.run}/run.json`);
    expect(waiting).toContain('type    /recover');
    expect(waiting).toContain('a code agent run\'s record is ended as interrupted, with no result claimed');
    expect(waiting).toContain('a process group that still runs is stopped (SIGTERM, then SIGKILL) only when it is proven the job\'s');
    // The Control Room says it, and the operation's card is marked as waiting on you.
    expect(text(await ws.room(''))).toContain(`why     ${why}`);
    expect(text(ws.op(op))).toContain('Waiting    on you: 1 run was left by a Timmy session that ended');
    noAbsolute(waiting);

    // /recover: the group is stopped with proof, the run's record ended, and then the operation's.
    const out = text(await ws.recover(''));
    await until('the agent group to be gone', () => !alive(s.agentPid) && !alive(s.helperPid), 10_000);
    expect(out).toContain(`1 job left running by a REPL that ended was stopped: ${s.job}`);
    expect(out).toContain(`1 operation left open by a Timmy that ended was recorded as interrupted: ${op}`);
    expect(out).toContain(`operation ${op} (/agent qwen make it 180 mm wide): the REPL that began it has ended and each of its runs has ended, so its record .timmy/operations/${op}.json now says interrupted (no run's result is claimed for it)`);
    noAbsolute(out);

    // Waiting on you, after: nothing (the run's own record says interrupted).
    const after = text(await ws.decisions(''));
    expect(after).toContain(NOTHING_WAITS);
    expect(after).not.toContain(s.run);

    // The operation's record: ended now, interrupted, why in words; everything else as its REPL wrote it.
    const runWhy = `its REPL ended while it ran; recovery stopped its process group ${s.agentPid} (2 processes) with SIGTERM; no result was written`;
    expect(readRun(s.run)).toMatchObject({ state: 'interrupted', why: runWhy });
    const ended = readOp(op);
    expect(ended).toEqual({ ...before, state: 'interrupted', ended: ended.ended, why: `its REPL ended before it did; recovery ended its runs: agent run ${s.run} interrupted (${runWhy})` });
    expect(Number.isNaN(Date.parse(ended.ended))).toBe(false);
    expect(Date.parse(ended.ended)).toBeGreaterThanOrEqual(Date.parse(before.started));

    // /op, /ops and the board's card show it ended: its state, when, why; not "left as it was", nothing waiting.
    const card = text(ws.op(op));
    expect(card).toContain(`Operation ${op}  interrupted`);
    expect(card).toMatch(/ · ended \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(card).toContain(`Why        its REPL ended before it did; recovery ended its runs: agent run ${s.run} interrupted (`);
    expect(card).not.toContain('left as it was');
    expect(card).not.toContain('Waiting');
    expect(text(ws.opsView('')).split('\n').find((l) => l.includes(op))).toMatch(new RegExp(`${op}  interrupted `));
    ws.board('');
    const html = cardHtml(fs.readFileSync(path.join(root, '.timmy', 'board', 'index.html'), 'utf8'), op);
    expect(html).toContain(`<strong class="op-id">Operation ${op}</strong> <span class="op-state op-stopped">interrupted</span>`);
    expect(html).toContain(`<p class="op-why">its REPL ended before it did; recovery ended its runs: agent run ${s.run} interrupted (`);
    expect(html).toMatch(/<p class="op-meta">from repl · started [^<]* · ended [^<]*<\/p>/);
    expect(html).not.toContain('op-note');
    expect(html).not.toContain('op-waiting');

    // Nothing new is sealed for the operation (its records are never sealed): the one recover receipt is the agent run's.
    expect(sealed.filter((r) => r.kind === 'recover').map((r) => r.subject)).toEqual([`recover · agent · qwen · ${s.run} · interrupted`]);
    expect(JSON.stringify(sealed)).not.toContain('.timmy/operations');
    // Once: a later pass finds nothing more, and the record stays as it was written.
    const bytes = fs.readFileSync(opFile(op));
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(fs.readFileSync(opFile(op)).equals(bytes)).toBe(true);
  }, 120_000);

  it('its process gone before recovery: listed as gone; /recover ends its records and its operation\'s', async () => {
    const s = await crashable('plain-agent');
    await crash(s.child);
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s job record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    const op = String(readRun(s.run).operation);
    const { ws } = make();
    const waiting = text(await ws.decisions(''));
    expect(waiting).toContain(`why     agent run ${s.run} (Qwen Code, job ${s.job}): its process is gone and the REPL that started it has ended, so its record still says submitted, with no result`);
    expect(waiting).not.toContain('a process group that still runs is stopped');
    expect(text(ws.op(op))).toContain('Waiting    on you: 1 run was left by a Timmy session that ended');
    const out = text(await ws.recover(''));
    expect(out).toContain(`1 agent run left by a REPL that ended was recorded as interrupted: ${s.run}`);
    expect(out).toContain(`1 operation left open by a Timmy that ended was recorded as interrupted: ${op}`);
    expect(text(await ws.decisions(''))).toContain(NOTHING_WAITS);
    expect(readOp(op)).toMatchObject({
      state: 'interrupted',
      why: `its REPL ended before it did; recovery ended its runs: agent run ${s.run} interrupted (its REPL ended while it ran, and its process is gone (when it ended is not recorded); no result was written)`,
    });
  }, 120_000);
});

describe('a flow\'s agent step left running by a REPL killed with SIGKILL', () => {
  it('listed once, as the flow\'s step still running in its own process group; after /recover the flow waits as interrupted and its operation has ended', async () => {
    const s = await crashable('agent');
    await crash(s.child);
    expect(alive(s.agentPid)).toBe(true);
    const op = String(readRun(s.run).operation);
    expect(readOp(op)).toMatchObject({ request: '/iterate tray "make it 180 mm wide"', state: 'running', ended: null });
    const { ws } = make();
    const waiting = text(await ws.decisions(''));
    expect(waiting).toContain('    ! 1 run was left by a Timmy session that ended  left by a session that ended');
    expect(waiting).toContain(`why     flow ${s.flow} (/iterate tray): its state file says its agent step runs, and that step's job ${s.job} is still running in its own process group ${s.agentPid} while the REPL that started it has ended`);
    expect(waiting).toContain(`record  .timmy/flows/${s.flow}/state.json`);
    // The flow's own agent run is the flow's: not listed again on its own.
    expect(waiting).not.toContain(`agent run ${s.run}`);

    const out = text(await ws.recover(''));
    await until('the agent group to be gone', () => !alive(s.agentPid) && !alive(s.helperPid), 10_000);
    expect(out).toContain(`1 flow was interrupted: ${s.flow} (record written)`);
    expect(out).toContain(`1 operation left open by a Timmy that ended was recorded as interrupted: ${op}`);
    const after = text(await ws.decisions(''));
    expect(after).not.toContain('left by a Timmy session that ended');
    expect(after).toContain(`    ! flow ${s.flow} (/iterate tray) was interrupted in its agent step  interrupted`);
    expect(readOp(op)).toMatchObject({ state: 'interrupted', why: `its REPL ended before it did; recovery ended its runs: flow ${s.flow} interrupted in its agent step` });
  }, 120_000);

  it('its process gone before recovery: the flow is listed with its step\'s job\'s process gone; /recover records it and ends its operation', async () => {
    const s = await crashable('agent');
    await crash(s.child);
    process.kill(-s.agentPid, 'SIGKILL');
    await until('the agent\'s job record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true, 10_000);
    const op = String(readRun(s.run).operation);
    const { ws } = make();
    const waiting = text(await ws.decisions(''));
    expect(waiting).toContain(`why     flow ${s.flow} (/iterate tray): its state file says its agent step runs, and that step's job ${s.job} was left running by a session that ended: the job's process is gone`);
    expect(waiting).not.toContain(`agent run ${s.run}`);
    expect(waiting).not.toContain('a process group that still runs is stopped');
    const out = text(await ws.recover(''));
    expect(out).toContain(`1 flow was interrupted: ${s.flow} (record written)`);
    expect(out).toContain(`1 operation left open by a Timmy that ended was recorded as interrupted: ${op}`);
    expect(text(await ws.decisions(''))).toContain(`    ! flow ${s.flow} (/iterate tray) was interrupted in its agent step  interrupted`);
    expect(readOp(op)).toMatchObject({ state: 'interrupted', why: `its REPL ended before it did; recovery ended its runs: flow ${s.flow} interrupted in its agent step` });
  }, 120_000);
});

describe.skipIf(!PYTHON3)('a /run left running by a REPL killed with SIGKILL', () => {
  it('listed as still running; once /recover records it interrupted it stays listed, until a later run of the same block settles it', async () => {
    const config = path.join(fixtures, 'crashed-run.json');
    fs.writeFileSync(config, JSON.stringify({ root, jobsDir, upmd: FAKE_UPMD, python3: PYTHON3, doc: 'WORK.md', block: 'after', running: 'long', seals: path.join(fixtures, 'crashed-seals.jsonl') }));
    const child = spawn(process.execPath, ['--import', 'tsx', RUN_FIXTURE, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: path.join(fixtures, 'home'), TIMMY_HOME: path.join(fixtures, 'home', 'timmy') } });
    children.push(child);
    const ready = await readyLine(child) as { job: string; pid: number };
    groups.push(ready.pid);
    await crash(child);
    expect(new JobManager({ dir: jobsDir }).get(ready.job)).toMatchObject({ state: 'running', pid: ready.pid });
    const { ws } = make({ python3: PYTHON3 });

    // Before /recover: still running in its own process group (not yet interrupted: nothing has ended it).
    const waiting = text(await ws.decisions(''));
    expect(waiting).toContain(`why     workflow run ${ready.job} (WORK.md › after) is still running in its own process group ${ready.pid}, and the REPL that started it has ended`);
    expect(waiting).toContain('a workflow run\'s job record is ended as interrupted');
    expect(waiting).not.toContain(`workflow run ${ready.job} (WORK.md › after) was interrupted`);

    // /recover stops it and records it interrupted: it stays listed, as an interrupted flow does, with its record's words.
    await ws.recover('');
    const listed = (out: string): string[] => out.split('\n').filter((l) => l.startsWith(`    ! workflow run ${ready.job} `));
    const after = text(await ws.decisions(''));
    expect(listed(after)).toEqual([`    ! workflow run ${ready.job} (WORK.md › after) was interrupted  interrupted`]);
    expect(after).toContain('why     its job record says cancelled: interrupted: its REPL ended while long was running; recovery stopped its process group with SIGTERM');
    expect(after).toContain(`type    /run WORK.md after · /jobs ${ready.job}`);
    expect(after).not.toContain('left by a Timmy session that ended');
    // Still there on a later look, and in the Control Room.
    expect(listed(text(await ws.decisions('')))).toHaveLength(1);
    expect(text(await ws.room(''))).toContain(`    ! workflow run ${ready.job} (WORK.md › after) was interrupted  interrupted`);

    // A later run of the same block, which completes, settles it.
    fs.writeFileSync(path.join(root, 'WORK.md'), DOC.replace('sleep 60', 'echo quick'));
    const again = text(await ws.run('WORK.md after')).match(/Running\s+(j[0-9a-f]{6})/)![1];
    await until('the later run to complete', () => ws.jobs.get(again)?.state === 'completed', 30_000);
    expect(text(await ws.decisions(''))).not.toContain(ready.job);
  }, 120_000);
});

describe('an operation is ended only when the Timmy that began it is gone and nothing of it runs', () => {
  it('left open while its REPL runs, and while a live process that joined it runs a job under it; ended once that job has ended', async () => {
    const s = await crashable('plain-agent');
    const op = String(readRun(s.run).operation);
    // A live process (this one) joins the operation while its REPL still runs, and runs a /run under it.
    const joiner = make();
    const h = joiner.ws.beginOperation('/run WORK.md long', { join: op });
    expect(h).toMatchObject({ id: op, joined: true });
    const job = text(await joiner.ws.ops.run(h, () => joiner.ws.run('WORK.md long'))).match(/Running\s+(j[0-9a-f]{6})/)![1];
    await until('the joined run to start', () => !!joiner.ws.jobs.get(job)?.pid);
    groups.push(joiner.ws.jobs.get(job)!.pid!);
    expect(new JobManager({ dir: jobsDir }).get(job)).toMatchObject({ operation: op, state: 'running' });
    const { ws } = make();

    // Its REPL runs: /recover leaves its run and its operation as they are.
    const before = fs.readFileSync(opFile(op));
    await ws.recover('');
    expect(fs.readFileSync(opFile(op)).equals(before)).toBe(true);
    expect(text(await ws.decisions(''))).not.toContain(s.run);

    // Its REPL is killed: /recover ends the agent run, but the joined process's run still runs, so the operation stays open.
    await crash(s.child);
    const out = text(await ws.recover(''));
    await until('the agent group to be gone', () => !alive(s.agentPid), 10_000);
    expect(out).toContain(`1 agent run left by a REPL that ended was recorded as interrupted: ${s.run}`);
    expect(out).not.toContain('operation left open');
    expect(readOp(op)).toMatchObject({ state: 'running', ended: null });
    // The joined run is the live process's own: not listed as left.
    expect(text(await ws.decisions(''))).not.toContain(job);

    // The joined run ends (stopped by its own REPL): now nothing of the operation runs, and the next pass ends it.
    await joiner.ws.stop(job);
    await until('the joined run to be stopped', () => joiner.ws.jobs.get(job)?.state === 'cancelled', 15_000);
    const closed = text(await ws.recover(''));
    expect(closed).toContain(`1 operation left open by a Timmy that ended was recorded as interrupted: ${op}`);
    const rec = readOp(op);
    expect(rec).toMatchObject({ state: 'interrupted' });
    expect(rec.why).toMatch(new RegExp(`^its REPL ended before it did; recovery ended its runs: agent run ${s.run} interrupted \\(its REPL ended while it ran; recovery stopped its process group ${s.agentPid} \\(2 processes\\) with SIGTERM; no result was written\\); its other runs had ended: workflow run ${job} \\(WORK\\.md › long\\) cancelled`));
  }, 120_000);
});

describe('runs an ended REPL left, from records (SYNTHETIC job records: docker cannot run here)', () => {
  /** SYNTHETIC: a job record as a REPL's job manager writes one, left behind when that REPL was killed. */
  function leftJob(rec: Record<string, unknown>): void {
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, `${String(rec.id)}.json`), JSON.stringify({ project: 'p', root, command: 'docker', args: [], state: 'running', steps: [], lines: 0, startedAt: new Date(Date.now() - 60_000).toISOString(), ...rec }));
  }
  /** The run's own record through the code agent's writer, as /agent writes it at its start (submitted). */
  function submitted(run: string, job: string, o: { agent?: AgentRunRecord['agent']; container?: string } = {}): void {
    const dir = path.join(root, '.timmy', 'agents', run);
    fs.mkdirSync(dir, { recursive: true });
    writeRunRecord(dir, {
      agent_run: 1, run, agent: o.agent ?? 'openhands', agent_version: null, model: 'qwen3:4b', endpoint: 'local', where: '127.0.0.1', task: 'fix it', job, started_at: new Date(Date.now() - 60_000).toISOString(),
      ...(o.container ? { openhands: { container: { name: o.container, labels: { 'timmy.run': run } } } as unknown as AgentRunRecord['openhands'] } : {}),
      state: 'submitted',
    });
  }

  it('an OpenHands run whose docker client still runs or is gone; a pid reused by another process is no proof its REPL runs; a run of a REPL that runs is not listed', async () => {
    // FAKE docker clients: plain waiting processes, each the leader of its own process group.
    const client = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    groups.push(client.pid!, reused.pid!);
    leftJob({ id: 'j0a0001', kind: 'task', label: 'agent openhands a00000001: fix it', pid: client.pid, owner: { pid: gonePid(), startedAt: new Date(Date.now() - 120_000).toISOString() }, operation: 'o00000001' });
    submitted('a00000001', 'j0a0001', { container: 'timmy-oh-a00000001' });
    leftJob({ id: 'j0a0002', kind: 'task', label: 'agent openhands a00000002: fix it', pid: gonePid(), owner: { pid: gonePid(), startedAt: new Date(Date.now() - 120_000).toISOString() } });
    submitted('a00000002', 'j0a0002', { container: 'timmy-oh-a00000002' });
    // A process runs with the pid its record names for its REPL, but it started at another time: that REPL is gone.
    leftJob({ id: 'j0a0003', kind: 'task', label: 'agent qwen a00000003: fix it', pid: gonePid(), owner: { pid: reused.pid, startedAt: new Date(Date.now() - 3600_000).toISOString() } });
    submitted('a00000003', 'j0a0003', { agent: 'qwen' });
    // This process started the job (as its own REPL's jobs say): not left.
    leftJob({ id: 'j0a0004', kind: 'task', label: 'agent qwen a00000004: fix it', pid: client.pid, owner: { pid: process.pid, startedAt: THIS_PROCESS.started } });
    submitted('a00000004', 'j0a0004', { agent: 'qwen' });
    await until('the waiting processes to run', () => alive(client.pid!) && alive(reused.pid!));
    const { ws } = make();
    const out = text(await ws.decisions(''));
    expect(out).toContain('    ! 3 runs were left by a Timmy session that ended  left by a session that ended');
    expect(out).toContain(`OpenHands run a00000001 (job j0a0001, container timmy-oh-a00000001): its docker client is still running in its own process group ${client.pid}, and the REPL that started it has ended`);
    expect(out).toContain('OpenHands run a00000002 (job j0a0002, container timmy-oh-a00000002): its docker client\'s process is gone and the REPL that started it has ended (whether its container still runs, /recover asks docker)');
    expect(out).toContain('agent run a00000003 (Qwen Code, job j0a0003): its process is gone and the REPL that started it has ended, so its record still says submitted, with no result');
    expect(out).not.toContain('a00000004');
    expect(out).toContain('an OpenHands run\'s container is stopped by its name and labels');
    // The operation each names is marked on its card (here: one with no record of its own, known by its runs).
    expect(text(ws.op('o00000001'))).toContain('Waiting    on you: 3 runs were left by a Timmy session that ended');
  }, 60_000);
});

describe('the operation record\'s end, as recovery writes it (src/ops/operations.ts endLeftOperation)', () => {
  it('only a record that says it runs and whose Timmy is proven gone; its state interrupted, ended and why; the rest as written', async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const base: OperationRecord = { schema: 'timmy.operation/1', id: 'o0000aaaa', request: '/agent qwen x', via: 'repl', project: 'p', started: at, ended: null, state: 'running', parent: null, runs: [{ kind: 'job', id: 'j000001', at }], owner: { pid: gonePid(), started: at } };
    expect(writeOperationRecord(root, base)).toEqual({ ok: true, rel: '.timmy/operations/o0000aaaa.json' });
    const r = endLeftOperation(root, 'o0000aaaa', { why: 'its REPL ended before it did; recovery ended its runs: job j000001 cancelled' });
    expect(r).toMatchObject({ ok: true, rel: '.timmy/operations/o0000aaaa.json' });
    const read = readOperationRecord(root, 'o0000aaaa');
    const { ended: _open, ...kept } = base;
    expect(read).toMatchObject({ ok: true, record: { ...kept, state: 'interrupted', why: 'its REPL ended before it did; recovery ended its runs: job j000001 cancelled' } });
    expect(read.ok && read.record.ended && !Number.isNaN(Date.parse(read.record.ended))).toBe(true);
    // Ended once: an ended record is left as it is.
    const bytes = fs.readFileSync(opFile('o0000aaaa'));
    expect(endLeftOperation(root, 'o0000aaaa', { why: 'again' })).toMatchObject({ ok: false, error: 'its record already says interrupted' });
    expect(fs.readFileSync(opFile('o0000aaaa')).equals(bytes)).toBe(true);
    // A record this process writes (its Timmy runs) is never ended by it.
    const log = new OperationLog({ scrub: (t) => t, live: () => true, outcome: () => ({ state: 'running', words: 'running' }) });
    const mine = log.begin({ request: '/agent qwen y', via: 'repl', root, project: 'p', record: true });
    expect(endLeftOperation(root, mine.id, { why: 'x' })).toMatchObject({ ok: false, error: 'the Timmy that began it still runs' });
    expect(readOperationRecord(root, mine.id)).toMatchObject({ ok: true, record: { state: 'running', ended: null } });
    log.closeAll();
    // The state reads back as one Timmy writes; an unknown one is still refused.
    expect(parseOperationRecord({ ...base, state: 'interrupted', ended: at })).toMatchObject({ ok: true, record: { state: 'interrupted' } });
    expect(parseOperationRecord({ ...base, state: 'paused' })).toEqual({ ok: false, error: 'its state "paused" is not one Timmy writes' });
  });
});
