/**
 * Round R4 (helper H58, ledger row 157, defect 5): a `/run` job left running by a REPL that was killed.
 *
 * On the operator's Mac (r18) a REPL was killed during a /run; its job's record said "running" for ever and /jobs said its
 * process was gone. Recovery (src/repl/workflow-recover.ts, asked by src/repl/recover.ts) now ends such a job in its own
 * record through the job module's writer, as interrupted, naming the block its output showed running:
 *   - its process group still running and proven the job's (the record's owner, pid and start: recover.ts leftBehind):
 *     stopped first (SIGTERM; the pty wrapper stops upmd and the block it started), then recorded cancelled;
 *   - its process gone: recorded failed;
 *   - not proven: nothing is stopped or recorded; the lines say what runs and how to stop it.
 *
 * The crash is real: a REPL session runs as its own process (tests/fixtures/workflow-crash-fixture.ts, a real Workspace
 * running /run through workers/upmd/pty_run.py with this machine's python3) and is killed with SIGKILL, never closed. upmd
 * is the TEST DOUBLE tests/fixtures/fake-upmd.mjs in its pty mode (it is not upmd; its blocks run for real, each in a
 * session of its own). One test writes a SYNTHETIC job record by hand, labelled where it is written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FIXTURE = path.resolve('tests/fixtures/workflow-crash-fixture.ts');
const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('workflow-recover: no python3 here, so the crash cases (which run /run on a pty) are skipped');
const F = '```';
/** first; long needs first and runs until it is stopped; after needs long. */
const DOC = ['# Work', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'echo started', 'sleep 60', F, '', `${F}bash [name:after, deps:long]`, 'echo after', F, ''].join('\n');

let root: string;
let fixtures: string;
let jobsDir: string;
const spaces: Workspace[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until<T>(what: string, get: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
interface Proc { pid: number; ppid: number; pgid: number; stat: string; args: string }
function table(): Proc[] {
  const out = String(spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8' }).stdout ?? '');
  return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], args: m[5].trim() }));
}
const groupRuns = (pgid: number): boolean => table().some((p) => p.pgid === pgid && !p.stat.startsWith('Z'));
const noAbsolute = (s: string): void => { for (const p of new Set([root, fixtures, os.tmpdir()])) expect(s).not.toContain(p); };

/** A REPL session in this process, on the test's project and jobs folder (recovery runs as it starts). */
function make() {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: FAKE_UPMD }, onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir, chdir: () => {}, receipts: () => sealed as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

/** A REPL session as its own process, in /run WORK.md after while `long` runs; then the processes of that run. */
async function crashable(): Promise<{ child: ChildProcess; job: string; wrapper: number; upmd: number; block: number }> {
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({ root, jobsDir, upmd: FAKE_UPMD, python3: PYTHON3, doc: 'WORK.md', block: 'after', running: 'long', seals: path.join(fixtures, 'crashed-seals.jsonl') }));
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TIMMY_HOME: path.join(fixtures, 'home') } });
  children.push(child);
  let out = '';
  let err = '';
  const ready = await new Promise<{ job: string; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session did not get ready: ${out}${err}`)), 90_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      const m = out.match(/^READY (.*)$/m);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); } else if (/^FAILED /m.test(out)) { clearTimeout(timer); reject(new Error(`${out}${err}`)); }
    });
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the session ended (${code ?? signal}) before it was ready: ${out}${err}`)); });
  });
  const upmd = await until('upmd under the wrapper', () => table().find((p) => p.ppid === ready.pid));
  const block = await until('the block under upmd', () => table().find((p) => p.ppid === upmd.pid && p.args.includes('sleep 60')));
  groups.push(ready.pid, upmd.pgid, block.pgid);
  return { child, job: ready.job, wrapper: ready.pid, upmd: upmd.pgid, block: block.pgid };
}

/** The crash: the session's process is killed with SIGKILL; its run's process groups (detached, as every job's) stay. */
async function crash(child: ChildProcess): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h58-recover-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h58-recover-fixtures-')));
  jobsDir = path.join(fixtures, 'jobs');
  fs.writeFileSync(path.join(root, 'WORK.md'), DOC);
});

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  // What a failed test may leave of a run: its process groups are ended.
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!PYTHON3)('a /run left running by a REPL that was killed (R4 H58, row 157)', () => {
  it("the next REPL's recovery stops what was left (proven the run's) and ends its record as interrupted at the block that ran", async () => {
    const s = await crashable();
    // What a crash leaves: its record says running, long running; the wrapper, upmd and the block run on.
    await crash(s.child);
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'running', pid: s.wrapper });
    expect(new JobManager({ dir: jobsDir }).get(s.job)?.stale).toBeUndefined();
    for (const g of [s.wrapper, s.upmd, s.block]) expect(groupRuns(g), `group ${g} before`).toBe(true);

    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === s.job)!;
    expect(item).toMatchObject({ did: 'interrupted', job: s.job, state: 'cancelled', stopped: { job: s.job, process_group: s.wrapper, processes: 1, signals: ['SIGTERM'], cleanup: 'complete' } });
    const error = 'interrupted: its REPL ended while long was running; recovery stopped its process group with SIGTERM';
    expect(item.text).toBe(`run ${s.job} of WORK.md › after was interrupted while long was running: its REPL ended and it still ran, so recovery stopped its process group ${s.wrapper} (1 process) with SIGTERM; its job record now says cancelled: ${error}; nothing was run again: /run WORK.md after runs it again`);
    // The run's own record, through the job module's writer: ended, interrupted at long.
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({ state: 'cancelled', cleanup: 'complete', exitCode: null, signal: null, error, interrupted: { step: 'long' } });
    expect(job.steps.map((x) => [x.name, x.state])).toEqual([['first', 'completed'], ['long', 'interrupted']]);
    expect(job.stale).toBeUndefined();
    // Everything of the run is gone: the wrapper's group, upmd's and the block's (the wrapper stopped those two itself).
    for (const g of [s.wrapper, s.upmd, s.block]) expect(groupRuns(g), `group ${g} after`).toBe(false);
    // The lines at the start: what was stopped and recorded.
    expect(notes[0]).toContain(`1 job left running by a REPL that ended was stopped: ${s.job}`);
    expect(notes[0]).toContain(`1 workflow run was interrupted: ${s.job} (job record ended)`);
    noAbsolute(notes.join('\n'));
    expect(sealed).toEqual([]);
    // /jobs no longer says it runs with its process gone.
    const listed = text(ws.jobsView('')).split('\n').find((l) => l.includes(s.job))!;
    expect(listed).toContain('cancelled');
    expect(listed).toContain('interrupted: its session ended while long ran');
    expect(listed).not.toContain('its process is gone');
    // The card and /workflows name the block, and how the run's end was found.
    const lines = text(await ws.workflows('WORK.md'));
    expect(lines).toContain(`Interrupted ${s.job}`);
    expect(lines).toContain('its session ended while long ran; recovery stopped its process group. Nothing resumes it: /run WORK.md after runs it again.');
    // Once: a later pass finds nothing more to do, and the record stays as it was written.
    const again = JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job));
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job))).toBe(again);
  }, 120_000);

  it('its processes gone (ended by hand after the kill): its record is ended, failed, interrupted at the block that ran', async () => {
    const s = await crashable();
    await crash(s.child);
    for (const g of [s.wrapper, s.upmd, s.block]) process.kill(-g, 'SIGKILL');
    await until('the run\'s record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true);
    const { ws, notes } = make();
    const report = (await ws.startRecovery)!;
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === s.job)!;
    const error = 'interrupted: its REPL ended while long was running; its process is gone';
    expect(item).toMatchObject({ did: 'interrupted', state: 'failed' });
    expect(item.stopped).toBeUndefined();
    expect(item.text).toBe(`run ${s.job} of WORK.md › after was interrupted while long was running: its REPL ended and its process is gone; its job record now says failed: ${error}; nothing was run again: /run WORK.md after runs it again`);
    expect(new JobManager({ dir: jobsDir }).get(s.job)).toMatchObject({ state: 'failed', error, interrupted: { step: 'long' }, exitCode: null, signal: null });
    expect(notes[0]).toContain(`1 workflow run was interrupted: ${s.job} (job record ended)`);
    const listed = text(ws.jobsView('')).split('\n').find((l) => l.includes(s.job))!;
    expect(listed).toContain('failed');
    expect(listed).toContain('interrupted: its session ended while long ran');
    expect(listed).not.toContain('its process is gone');
    expect(text(await ws.workflows('WORK.md'))).toContain('its session ended while long ran; its process was gone; recovery recorded its end.');
  }, 120_000);
});

describe('what is not proven is not stopped', () => {
  it("a live group whose oldest process did not start when the run did: left alone, named with how to stop it; nothing recorded", async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    groups.push(other.pid!);
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    // SYNTHETIC: a /run job's record naming that process, left running by a REPL whose process is gone.
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'j0bad58.json'), JSON.stringify({
      id: 'j0bad58', kind: 'workflow', label: 'WORK.md › after', project: 'demo', root, command: 'python3',
      args: ['-I', path.join(root, 'pty_run.py'), '--', FAKE_UPMD, '--ci', '-b', 'after', '-d', root, path.join(root, 'WORK.md')],
      state: 'running', pid: other.pid, startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), lines: 0,
      steps: [{ name: 'first', index: 1, state: 'completed', code: 0 }, { name: 'long', index: 2, state: 'running' }],
      owner: { pid: gone, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() },
    }));
    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    expect(groupRuns(other.pid!)).toBe(true);
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === 'j0bad58')!;
    expect(item).toMatchObject({ did: 'left', attention: true });
    expect(item.text).toContain(`run j0bad58 of WORK.md › after was left running by a REPL that has ended; 1 process of its process group ${other.pid} still runs: pid ${other.pid} (`);
    expect(item.text).toContain(`kill -TERM -- -${other.pid} stops the group (then kill -KILL -- -${other.pid} if any of it is left), and /recover records it once it has ended`);
    expect(notes[0]).toContain('1 job left running by a REPL that ended was not stopped: what runs, and how to stop it, below');
    expect(new JobManager({ dir: jobsDir }).get('j0bad58')).toMatchObject({ state: 'running' });
    expect(sealed).toEqual([]);
    // Once that group has ended (stopped as the line says), its record is stale, and the next pass records it.
    process.kill(-other.pid!, 'SIGTERM');
    await until('that record to be stale', () => new JobManager({ dir: jobsDir }).get('j0bad58')?.stale === true);
    expect(text(await ws.recover(''))).toContain('1 workflow run was interrupted: j0bad58 (job record ended)');
    expect(new JobManager({ dir: jobsDir }).get('j0bad58')).toMatchObject({ state: 'failed', interrupted: { step: 'long' } });
  }, 60_000);
});
