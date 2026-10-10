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
 *
 * Round R4 (H67, ledger row 162, r20): the wrapper now stops upmd itself as soon as the REPL has ended, and writes what it
 * saw to its stop file; recovery records the run from that account: the block running then interrupted, the block after it
 * not run (the file proves upmd was stopped before it could start), and /jobs, /workflows and the card say the same. A
 * wrapper that leaves no account (here: stopped with SIGSTOP before the kill, then killed with its run) proves nothing:
 * the block after reads "not seen".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { kit } from '../src/repl/board-kit.js';
import { renderWorkflowCard, workflowForBoard } from '../src/repl/board-nodes.js';
import { connectWorkflow } from '../src/repl/board-workflows.js';
import { Workspace } from '../src/repl/workspace.js';
import { wrapperStopFile } from '../src/workflows/upmd-live.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FIXTURE = path.resolve('tests/fixtures/workflow-crash-fixture.ts');
const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('workflow-recover: no python3 here, so the crash cases (which run /run on a pty) are skipped');
const F = '```';
/** first; long needs first and runs until it is stopped; after needs long (and marks its own start in the project). */
const DOC = ['# Work', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'echo started', 'sleep 60', F, '', `${F}bash [name:after, deps:long]`, 'touch after.started', 'echo after', F, ''].join('\n');

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
async function crashable(o: { doc?: string; block?: string; running?: string; blockArgs?: string } = {}): Promise<{ child: ChildProcess; job: string; wrapper: number; upmd: number; block: number }> {
  const config = path.join(fixtures, 'crashed-session.json');
  fs.writeFileSync(config, JSON.stringify({ root, jobsDir, upmd: FAKE_UPMD, python3: PYTHON3, doc: o.doc ?? 'WORK.md', block: o.block ?? 'after', running: o.running ?? 'long', seals: path.join(fixtures, 'crashed-seals.jsonl') }));
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
  const block = await until('the block under upmd', () => table().find((p) => p.ppid === upmd.pid && p.args.includes(o.blockArgs ?? 'sleep 60')));
  groups.push(ready.pid, upmd.pgid, block.pgid);
  return { child, job: ready.job, wrapper: ready.pid, upmd: upmd.pgid, block: block.pgid };
}

/** The crash: the session's process is killed with SIGKILL; its run's process groups are detached, as every job's. */
async function crash(child: ChildProcess): Promise<void> {
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
}
const words = (job: { steps: Array<{ name: string; state: string; code?: number }> }): unknown[] => job.steps.map((x) => [x.name, x.state, x.code ?? null]);
/** The card's words for the run, as the board draws them from its record. */
const card = (job: ReturnType<JobManager['get']>) => connectWorkflow(workflowForBoard('WORK.md', { text: DOC }), { root, jobs: [job!], chain: [], files: ['WORK.md'], upmd: true, mine: () => false });

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

describe.skipIf(!PYTHON3)('a /run left running by a REPL that was killed (R4 H58, row 157; H67, row 162)', () => {
  it("the wrapper stops upmd itself as the REPL is killed and says what it saw; the next REPL's recovery records the run from that: long interrupted, after not run, the same in /jobs, /workflows and the card", async () => {
    const s = await crashable();
    const record0 = new JobManager({ dir: jobsDir }).get(s.job)!;
    // The run's own folder and the order its prediction sealed, in its record from the start.
    const stopFile = wrapperStopFile(record0.args)!;
    expect(path.dirname(path.dirname(stopFile))).toBe(path.join(jobsDir, 'runs'));
    expect(record0.args).toEqual(expect.arrayContaining(['--parent', String(s.child.pid), '--stop-file', stopFile]));
    expect(record0.expected).toEqual({ steps: ['first', 'long', 'after'], receipt: 'crashed1' });
    // The crash. The wrapper sees its REPL end and stops upmd and the block at once: every group of the run ends within 3 s.
    const killed = Date.now();
    await crash(s.child);
    await until('every process group of the run to end', () => ![s.wrapper, s.upmd, s.block].some(groupRuns), 3000);
    expect(Date.now() - killed).toBeLessThan(3000);
    // Its stop file, mode 0600: long was running when it stopped upmd (SIGTERM), first had ended.
    expect(fs.statSync(stopFile).mode & 0o777).toBe(0o600);
    const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    expect(stop).toMatchObject({ schema: 'timmy.pty-stop/1', wrapper_pid: s.wrapper, why: `its parent (process ${s.child.pid}) ended`, stopped: true, signals: ['SIGTERM'], left: [] });
    expect(stop.blocks.map((b: { n: number; name?: string; state: string; code?: number }) => [b.n, b.name ?? null, b.state, b.code ?? null])).toEqual([[1, 'first', 'completed', 0], [2, null, 'stopped', null]]);
    expect(fs.existsSync(path.join(root, 'after.started'))).toBe(false);
    // What the crash left in the record: running, long running (the REPL never wrote more); stale once the wrapper's
    // process is reaped by its new parent.
    await until('the run\'s record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true);
    const left = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(left).toMatchObject({ state: 'running', pid: s.wrapper, stale: true });
    expect(words(left)).toEqual([['first', 'completed', 0], ['long', 'running', null]]);

    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === s.job)!;
    const did = 'its pty wrapper saw its REPL end and stopped upmd at once (SIGTERM)';
    const error = `interrupted: its REPL ended while long was running; ${did}, so after did not start`;
    expect(item).toMatchObject({ did: 'interrupted', job: s.job, state: 'cancelled' });
    expect(item.stopped).toBeUndefined();
    expect(item.text).toBe(`run ${s.job} of WORK.md › after was interrupted while long was running: ${did}, so after did not start; its job record now says cancelled: ${error}; nothing was run again: /run WORK.md after runs it again`);
    // The run's own record, through the job module's writer: what is known, and from where.
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({
      state: 'cancelled', cleanup: 'complete', exitCode: null, signal: null, error,
      interrupted: { step: 'long', rest: 'not run', wrapper: { why: `its parent (process ${s.child.pid}) ended`, at: stop.stopping_at, stopped: true, signals: ['SIGTERM'], left: 0, exit: stop.exit } },
    });
    expect(words(job)).toEqual([['first', 'completed', 0], ['long', 'interrupted', null]]);
    expect(job.steps[1]).toMatchObject({ seen: 'wrapper', endedAt: stop.stopping_at });
    expect(job.stale).toBeUndefined();
    expect(notes[0]).toContain(`1 workflow run was interrupted: ${s.job} (job record ended)`);
    expect(notes[0]).not.toContain('was stopped');
    noAbsolute(notes.join('\n'));
    expect(sealed).toEqual([]);
    // /jobs: three blocks (its sealed order), not two; each block with its word, and an own time where the card has one.
    const listed = text(ws.jobsView('')).split('\n').find((l) => l.includes(s.job))!;
    expect(listed).toContain('cancelled');
    expect(listed).toContain(' · 2 of 3 steps · ');
    expect(listed).toContain(`interrupted: its session ended while long ran; ${did}`);
    const shown = text(ws.jobsView(s.job)).split('\n');
    expect(shown[1]).toMatch(/^ {6}✓ first {2}exit 0 · (<0\.1|\d+\.\d) s$/);
    expect(shown[2]).toMatch(/^ {6}● long {2}interrupted · (<0\.1|\d+\.\d) s · seen by its pty wrapper \(its stop file\), not by Timmy$/);
    expect(shown[3]).toBe('      ● after  not run');
    // /workflows and the card: the same words.
    const lines = text(await ws.workflows('WORK.md'));
    expect(lines).toContain(`Interrupted ${s.job}`);
    expect(lines).toContain(`its session ended while long ran; ${did}; after did not start. Nothing resumes it: /run WORK.md after runs it again.`);
    expect(lines).toMatch(/ 3 after +bash +needs long +– not run · /);
    const w = card(job);
    expect(w.connected!.nodes.map((n) => [n.name, n.word])).toEqual([['first', 'completed'], ['long', 'interrupted'], ['after', 'not run']]);
    expect(w.connected!.runs[0]).toMatchObject({ orderFrom: 'record', order: ['first', 'long', 'after'] });
    const html = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(html).toContain(`The session that ran ${s.job} ended while long was running; ${did}, so how long would have ended is not known; after did not start. upmd does not resume a run, and Timmy does not either: /run WORK.md after runs it again from first.`);
    // Once: a later pass finds nothing more to do, and the record stays as it was written.
    const again = JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job));
    expect(text(await ws.recover(''))).toContain('nothing to pick up');
    expect(JSON.stringify(new JobManager({ dir: jobsDir }).get(s.job))).toBe(again);
  }, 120_000);

  it('a wrapper that left no account (stopped, then killed with its run): long interrupted, after not seen, in the record, /jobs, /workflows and the card', async () => {
    const s = await crashable();
    // The wrapper cannot see anything once stopped; then the REPL and every group of the run are killed: no stop file.
    process.kill(s.wrapper, 'SIGSTOP');
    await crash(s.child);
    for (const g of [s.wrapper, s.upmd, s.block]) process.kill(-g, 'SIGKILL');
    await until('the run\'s record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true);
    const stopFile = wrapperStopFile(new JobManager({ dir: jobsDir }).get(s.job)!.args)!;
    expect(fs.existsSync(stopFile)).toBe(false);
    const { ws, notes } = make();
    const report = (await ws.startRecovery)!;
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === s.job)!;
    const error = 'interrupted: its REPL ended while long was running; its process is gone; its pty wrapper wrote no stop file, so whether upmd went on to after is not known';
    expect(item).toMatchObject({ did: 'interrupted', state: 'failed' });
    expect(item.stopped).toBeUndefined();
    expect(item.text).toBe(`run ${s.job} of WORK.md › after was interrupted while long was running: its REPL ended and its process is gone; its job record now says failed: ${error}; nothing was run again: /run WORK.md after runs it again`);
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({ state: 'failed', error, interrupted: { step: 'long', rest: 'not seen' }, exitCode: null, signal: null });
    expect(job.interrupted!.wrapper).toBeUndefined();
    expect(notes[0]).toContain(`1 workflow run was interrupted: ${s.job} (job record ended)`);
    const listed = text(ws.jobsView('')).split('\n').find((l) => l.includes(s.job))!;
    expect(listed).toContain('failed');
    expect(listed).toContain(' · 2 of 3 steps · ');
    expect(listed).toContain('interrupted: its session ended while long ran');
    expect(listed).not.toContain('its process is gone');
    expect(text(ws.jobsView(s.job)).split('\n')[3]).toBe('      ● after  not seen: its REPL had ended, and upmd may have gone on until it ended');
    const lines = text(await ws.workflows('WORK.md'));
    expect(lines).toContain('its session ended while long ran; its process was gone; recovery recorded its end; after not seen: its REPL had ended, and upmd may have gone on until it ended. Nothing resumes it: /run WORK.md after runs it again.');
    expect(lines).toMatch(/ 3 after +bash +needs long +◌ not seen · /);
    const w = card(job);
    expect(w.connected!.nodes.map((n) => [n.name, n.word])).toEqual([['first', 'completed'], ['long', 'interrupted'], ['after', 'not seen']]);
    expect(renderWorkflowCard(w, kit({ live: true, base: '../../' }))).toContain('Not seen in ' + s.job + ': its REPL had ended, and upmd may have gone on until it ended. Nothing resumes it: /run WORK.md after runs it again.');
  }, 120_000);

  it("a REPL that stopped following (frozen with SIGSTOP), then killed after upmd ended: the blocks only its wrapper saw end are recorded as it saw them, and the run completed, unseen by its REPL", async () => {
    // first; mid needs first and runs 2 s; last needs mid (and marks its own start in the project).
    fs.writeFileSync(path.join(root, 'QUICK.md'), ['# Quick', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:mid, deps:first]`, 'echo mid starts', 'sleep 2', 'echo mid done', F, '', `${F}bash [name:last, deps:mid]`, 'touch last.started', 'echo last', F, ''].join('\n'));
    const s = await crashable({ doc: 'QUICK.md', block: 'last', running: 'mid', blockArgs: 'sleep 2' });
    const stopFile = wrapperStopFile(new JobManager({ dir: jobsDir }).get(s.job)!.args)!;
    // The REPL stops reading (its process stopped) while mid runs; upmd goes on, runs last and ends; the wrapper writes its stop file.
    process.kill(s.child.pid!, 'SIGSTOP');
    await until('the wrapper to write its stop file', () => fs.existsSync(stopFile), 20_000);
    expect(fs.existsSync(path.join(root, 'last.started'))).toBe(true);
    const stop = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    expect(stop).toMatchObject({ why: 'fake-upmd.mjs ended by itself', stopped: false, exit: 0, parent: { ended: false } });
    expect(stop.blocks.map((b: { n: number; name?: string; state: string; code?: number }) => [b.n, b.name, b.state, b.code])).toEqual([[1, 'first', 'completed', 0], [2, 'mid', 'completed', 0], [3, 'last', 'completed', 0]]);
    // The REPL is killed now: its record shows what it saw before it stopped (mid running).
    await crash(s.child);
    await until('the run\'s record to be stale', () => new JobManager({ dir: jobsDir }).get(s.job)?.stale === true);
    expect(words(new JobManager({ dir: jobsDir }).get(s.job)!)).toEqual([['first', 'completed', 0], ['mid', 'running', null]]);

    const { ws, notes } = make();
    const report = (await ws.startRecovery)!;
    const item = report.items.find((i) => i.kind === 'workflow' && i.id === s.job)!;
    const note = "its REPL did not see it end: its pty wrapper saw upmd end by itself (exit 0); it saw mid completed and last completed, which Timmy did not see itself (its wrapper's stop file)";
    expect(item).toMatchObject({ did: 'judged', outcome: 'ok', state: 'completed' });
    expect(item.text).toBe(`run ${s.job} of QUICK.md › last ended unseen by its REPL: its pty wrapper saw upmd end by itself (exit 0); it saw mid completed and last completed, which Timmy did not see itself; its job record now says completed, from its wrapper's stop file; nothing was run again`);
    const job = new JobManager({ dir: jobsDir }).get(s.job)!;
    expect(job).toMatchObject({ state: 'completed', note, exitCode: null, signal: null });
    expect(job.error).toBeUndefined();
    expect(job.interrupted).toBeUndefined();
    expect(job.steps.map((x) => [x.name, x.index, x.state, x.code, x.seen ?? null])).toEqual([['first', 1, 'completed', 0, null], ['mid', 2, 'completed', 0, 'wrapper'], ['last', 3, 'completed', 0, 'wrapper']]);
    expect(notes[0]).toContain(`1 workflow run ended unseen by its REPL: ${s.job} (recorded from its pty wrapper's stop file)`);
    // /jobs, /workflows and the card: every block completed; the two the wrapper saw say so.
    const listed = text(ws.jobsView('')).split('\n').find((l) => l.includes(s.job))!;
    expect(listed).toContain('completed');
    expect(listed).toContain(' · 3 of 3 steps · ');
    expect(listed).toContain(note);
    const shown = text(ws.jobsView(s.job)).split('\n');
    expect(shown[2]).toMatch(/^ {6}✓ mid {2}exit 0 · \d+\.\d s · seen by its pty wrapper \(its stop file\), not by Timmy$/);
    expect(shown[3]).toMatch(/^ {6}✓ last {2}exit 0 · (<0\.1|\d+\.\d) s · seen by its pty wrapper \(its stop file\), not by Timmy$/);
    const lines = text(await ws.workflows('QUICK.md'));
    expect(lines).toContain(`Last run  ${s.job}  last (first → mid → last) · completed · first completed, mid completed, last completed`);
    expect(lines).toContain(`             ${note}`);
    const w = connectWorkflow(workflowForBoard('QUICK.md', { text: fs.readFileSync(path.join(root, 'QUICK.md'), 'utf8') }), { root, jobs: [job], chain: [], files: ['QUICK.md'], upmd: true, mine: () => false });
    expect(w.connected!.nodes.map((n) => [n.name, n.word, n.detail.endsWith('seen by its wrapper')])).toEqual([['first', 'completed', false], ['mid', 'completed', true], ['last', 'completed', true]]);
    const html = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(html).toContain(`<p class="wfx-run-say">Its REPL did not see it end: its pty wrapper saw upmd end by itself (exit 0); it saw mid completed and last completed, which Timmy did not see itself (its wrapper&#39;s stop file).</p>`);
    expect(html).toContain('Its end is what the run&#39;s pty wrapper saw (its stop file); Timmy did not see it itself, its REPL no longer following the run.');
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
