// R5 (H131): the Inspector's run detail while a later session's recovery ends a run. The recovery PTY test (item 4 of
// tests/workbench-interaction-pty.test.ts) failed under load: recovery ends the job's record first and the operation's record
// after it, and a reading made between the two said "left running" (the operation's record still open, its writer gone).
// That reading stayed drawn beside the job's "ended by recovery": the job's record did not change again, and [r] read the
// detail again while the old one stayed on screen until the new one came (the frame that drew [r]'s notice still drew the
// verdict before it). Here the same order of records, step by step, with a FIXTURE producer whose readings end when the test
// says, so each step is observed rather than timed; each frame is drawn by the test (no Ink app), as the app draws one.
//
// FAKE or FIXTURE here, each labelled where it is made: the job (a real `sleep` in this test's own job store), the operation
// record (written by this test), and the run detail's producer (a FIXTURE: it returns a RunDetail in the contract's shape).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail, type RunVerdict } from '../src/contracts/run-detail.js';
import { JobManager } from '../src/jobs/index.js';
import { inOperation, newOperationId } from '../src/ops/context.js';
import { OPERATION_SCHEMA, writeOperationRecord, type OperationRecord } from '../src/ops/operations.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const managers: JobManager[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-run-detail-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const m of managers.splice(0)) await m.stopAll();
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

// FIXTURE: a run detail in the contract's shape, made by this test (not by src/ops/run-detail.ts), with the verdict asked for
function fixtureDetail(operation: string, root: string, verdict: { state: RunVerdict; words: string }): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation, parent: null, children: [], project: { name: 'fixture', root, id: projectId(root) },
    objective: { value: 'FIXTURE objective of the run', from: 'FIXTURE' }, sourceRevision: null,
    verdict: { ...verdict, from: 'FIXTURE' },
    stage: { current: null, done: 0, total: 1, from: 'FIXTURE' }, exits: [],
    freshness: { state: 'unknown', why: 'FIXTURE: not checked' }, acceptance: { state: 'not reviewed' }, worker: {},
    time: { startedAt: null, endedAt: null, elapsedMs: null }, prediction: null, checks: [], files: [], receipts: [],
    cost: { usd: null, measured: false, why: 'FIXTURE: no request went out' }, summary: { path: null }, next: null, unknown: [],
  };
}

/** One reading of the run detail, waiting for the test to say what it read. */
interface Reading { op: string; answer: (verdict: { state: RunVerdict; words: string }) => void }

function workbench(project: { name: string; root: string; chosen: boolean }, readings: Reading[]): Controller {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, project);
  // FIXTURE: the run detail's producer; each reading ends when the test answers it
  const producers: Producers = {
    runDetail: async () => ({
      ok: true,
      value: (op: string, o: { root: string }) => new Promise<RunDetail>((done) => { readings.push({ op, answer: (v) => done(fixtureDetail(op, o.root, v)) }); }),
    }),
    openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }),
  };
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return c;
}

/** The Inspector's words, its rows joined (the frame the app draws, read by cell); drawing it is what asks for the detail. */
function inspector(c: Controller, columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions.right?.rect;
  if (!rect) return '';
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

/** Waits for what `get` observes, with a deadline that names it. */
async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(25);
  }
}

describe('the Inspector\'s run detail while a later session\'s recovery ends a run (R5 H131: the recovery PTY test\'s flake)', () => {
  it('a reading made between the job\'s end and its operation\'s end is not drawn once either record changed; the operation\'s record changing reads it again; a late older reading never replaces a newer one; [r] says "reading…" until its reading comes', async () => {
    sandbox();
    const p = trayProject('detail-race');
    // FAKE: a job of an operation (a real `sleep`, this test's own job store) and the operation's record, still open
    const jobs = new JobManager({ dir: jobsDir });
    managers.push(jobs);
    const op = newOperationId();
    const started = new Date().toISOString();
    const job = inOperation({ id: op }, () => jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 30', project: p.name, root: p.root, command: 'sleep', args: ['30'] }));
    const rec: OperationRecord = {
      schema: OPERATION_SCHEMA, id: op, request: 'FAKE request (test): sleep 30', via: 'repl', project: p.name, started, ended: null, state: 'running',
      parent: null, runs: [{ kind: 'job', id: job.id, at: started }], owner: { pid: process.pid, started },
    };
    expect(writeOperationRecord(p.root, rec).ok).toBe(true);
    await until('the FAKE job running (its record)', () => jobs.get(job.id)?.state === 'running', 10_000);
    const readings: Reading[] = [];
    const c = workbench(p, readings);
    c.start();
    // the Workbench has read it running before the first frame (a reading is asked for again whenever the record changes)
    await until('the Workbench reading the FAKE job as running', () => c.data.jobs.find((j) => j.id === job.id && j.state === 'running'), 10_000);
    // the Control Room, its job selected, Context on its Inspector (no Ink app here: a frame is drawn only when the test reads one)
    c.selectPage('control');
    c.ui.tab = 'inspector';
    c.ui.sel['center:control'] = `job:${job.id}`;
    (c.ui.chosen ??= {})['center:control'] = true;
    const show = () => inspector(c);

    // 1. the first reading, answered as a reading made while the operation's record was open would say
    await until('the first reading of the run detail', () => { inspector(c); return readings.length === 1; }, 10_000, show);
    expect(readings[0].op).toBe(op);
    readings[0].answer({ state: 'unknown', words: 'left running: FIXTURE, read while its record was open' });
    await until('the first reading drawn', () => /Verdict unknown · left running: FIXTURE/.test(inspector(c)), 5000, show);

    // 2. the job's record ends (recovery's first write): read again; until that reading comes, the Inspector says it is
    // reading, never the verdict read before (the Workbench must have read the record first: observed in its data)
    const ended = await jobs.stop(job.id);
    expect(ended?.state).toBe('cancelled');
    // (between the two, a reading of the jobs folder can see its process gone and its record still running: stale; the
    // Workbench is waited for until it has read the record as the stop wrote it)
    await until('the Workbench reading the job\'s record as cancelled', () => c.data.jobs.find((j) => j.id === job.id && j.state === 'cancelled' && j.endedAt === ended?.endedAt), 10_000);
    // the very frame that sees it asks for the second reading and says "reading…" (never the verdict read before beside it)
    const second = inspector(c);
    expect(readings).toHaveLength(2);
    expect(second).toContain('Run detail: reading…');
    expect(second).not.toContain('left running');

    // 3. the operation's record ends (recovery's second write), the job's record unchanged: read again (a third reading)
    expect(writeOperationRecord(p.root, { ...rec, ended: new Date().toISOString(), state: 'interrupted', why: 'FAKE: ended by this test' }).ok).toBe(true);
    expect(inspector(c)).toContain('Run detail: reading…');
    expect(readings).toHaveLength(3);
    readings[2].answer({ state: 'recovered', words: 'interrupted: FIXTURE, read after both records ended' });
    await until('the third reading drawn', () => /Verdict recovered · interrupted: FIXTURE, read after both/.test(inspector(c)), 5000, show);

    // 4. the second reading ends late, with what it read before the operation's record ended: it is dropped
    readings[1].answer({ state: 'unknown', words: 'left running: FIXTURE, the late reading' });
    await sleep(200);
    const after = inspector(c);
    expect(after).toMatch(/Verdict recovered · interrupted: FIXTURE, read after both records ended/);
    expect(after).not.toContain('left running');
    expect(readings).toHaveLength(3);

    // 5. [r]: read again; until that reading comes, "reading…", not the verdict before it
    c.refresh();
    const reading = inspector(c);
    expect(readings).toHaveLength(4);
    expect(reading).toContain('Run detail: reading…');
    expect(reading).not.toContain('Verdict');
    readings[3].answer({ state: 'recovered', words: 'interrupted: FIXTURE, read after [r]' });
    await until('the fourth reading drawn', () => /Verdict recovered · interrupted: FIXTURE, read after \[r\]/.test(inspector(c)), 5000, show);
    // nothing else asked: the same records are read once
    for (let i = 0; i < 5; i++) { inspector(c); await sleep(50); }
    expect(readings).toHaveLength(4);
  }, 60_000);
});
