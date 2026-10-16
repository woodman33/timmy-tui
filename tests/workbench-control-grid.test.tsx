// R5 (H137): tab 7 Control Room's panes as the operator's references lay them out (07, 14): a 2×2 grid from 160 terminal
// columns, two running FAKE jobs first, then the two newest ended ones. Drawn by Ink through ink-testing-library at 160x45 over
// a real Timmy home in a temporary folder: a tray-workflow project made by the starter code, the REPL's own Workspace and
// Timmy's job store. What is checked: the grid's rows on the screen; a running pane's lines following its log as the
// Workbench reads it at each tick (and saying so: "log read every 0.1 s", this test's tick); the arrows moving the selection
// in the grid's order (← → inside a row, ↑ ↓ between rows); x naming the selected running pane's job; with Context's drawer
// open (i), the panes stacked again.
//
// FAKE or FIXTURE here, each labelled where it is made:
// - the four jobs are FAKE jobs (test) of Timmy's own job store in this process, started apart from the Workbench (so they
//   are another session's to it): two that end at once, one that prints a line every 0.1 s, one that sleeps;
// - the run detail's and the chat session's producers are FIXTUREs that have none; the browser opener and the server starts
//   (nothing here presses Show).
import React from 'react';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { JobManager } from '../src/jobs/index.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
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
const spaces: Workspace[] = [];
const managers: JobManager[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-control-grid-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
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

const NONE: Producers = {
  runDetail: async () => ({ ok: false, why: 'FIXTURE: no run detail in this test' }),
  openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }),
};

function workbench(project: { name: string; root: string; chosen: boolean }): Controller {
  let c: Controller | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers: NONE,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return c;
}

function frameOf(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  return { r, text: () => r.lastFrame() ?? '', lines: () => (r.lastFrame() ?? '').split('\n') };
}

async function press(r: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const k of keys) { r.stdin.write(k); await sleep(60); }
  await sleep(80);
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

const ENTER = '\r';
const [UP, DOWN, RIGHT, LEFT] = ['\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D'];

/** The screen row (its index) where both ids are on a pane's edge, or -1. */
const rowWith = (lines: readonly string[], a: string, b: string): number => lines.findIndex((l) => new RegExp(`[━─] ${a} [━─]`).test(l) && new RegExp(`[━─] ${b} [━─]`).test(l));

/** The newest "FAKE line N" the screen shows. */
const newestLine = (screen: string): number => Math.max(0, ...[...screen.matchAll(/FAKE line (\d+)/g)].map((m) => Number(m[1])));

describe('tab 7 Control Room: the panes as a 2×2 grid from 160 columns (R5 H137, references 07 and 14)', () => {
  it('two running FAKE jobs first, then the two newest ended ones, two to a row; a running pane follows its log and says how often it is read; the arrows move in the grid; x names the selected running pane\'s job; with Context\'s drawer open the panes stack', async () => {
    sandbox();
    const p = trayProject('grid-a');
    // FAKE jobs (test), another session's to the Workbench: two that end at once, then one that prints and one that sleeps
    const jobs = new JobManager({ dir: jobsDir });
    managers.push(jobs);
    const doneA = jobs.start({ kind: 'task', label: 'FAKE job (test): done A', project: p.name, root: p.root, command: 'sh', args: ['-c', 'echo "FAKE done A"'] });
    await jobs.done(doneA.id);
    await sleep(20);
    const doneB = jobs.start({ kind: 'task', label: 'FAKE job (test): done B', project: p.name, root: p.root, command: 'sh', args: ['-c', 'echo "FAKE done B"; exit 3'] });
    await jobs.done(doneB.id);
    await sleep(20);
    const talk = jobs.start({ kind: 'task', label: 'FAKE job (test): a line every 0.1 s', project: p.name, root: p.root, command: 'sh', args: ['-c', 'i=0; while [ $i -lt 900 ]; do i=$((i+1)); echo "FAKE line $i"; sleep 0.1; done'] });
    await sleep(20);
    const nap = jobs.start({ kind: 'task', label: 'FAKE job (test): sleep 60', project: p.name, root: p.root, command: 'sleep', args: ['60'] });
    await until('both running', () => jobs.get(talk.id)?.state === 'running' && jobs.get(nap.id)?.state === 'running');

    const c = workbench(p);
    c.start();
    const f = frameOf(c, 160, 45);
    await sleep(150);
    await press(f.r, '/', ...'Control', ENTER);
    expect(c.ui.workspace).toBe('control');
    // the grid: the running ones (the newest first) on one row of panes, the newest ended ones on the row below
    const top = await until('the running panes side by side', () => { const y = rowWith(f.lines(), nap.id, talk.id); return y >= 0 ? y : null; }, 10_000, f.text);
    const below = rowWith(f.lines(), doneB.id, doneA.id);
    expect(below).toBeGreaterThan(top);
    expect(f.text()).toMatch(/RUNNING NOW \(2\) {2}· {2}NEWEST ENDED RUNS \(2\)/);
    expect(f.lines().every((l) => visibleWidth(l) === 160)).toBe(true);
    // a running pane says how often its log is read (this test's tick, 0.1 s); an ended one says how it ended
    expect(f.text()).toContain('log read every 0.1 s');
    expect(f.text()).toMatch(/exit 3/);
    // the printing pane follows its log: its newest line, then a later one
    const n1 = await until('a printed line in its pane', () => newestLine(f.text()) || null, 10_000, f.text);
    const n2 = await until('a later line in its pane', () => { const n = newestLine(f.text()); return n >= n1 + 5 ? n : null; }, 10_000, f.text);
    expect(n2).toBeGreaterThanOrEqual(n1 + 5);
    // the arrows, in the grid's order: → inside the row, ↓ to the row below, ← inside it, ↑ back up
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: nap.id } });
    expect(f.text()).toMatch(new RegExp(`┏━ ${nap.id} `));
    await press(f.r, RIGHT);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: talk.id } });
    await until('the heavy frame on the printing pane', () => new RegExp(`┏━ ${talk.id} `).test(f.text()), 5000, f.text);
    await press(f.r, DOWN);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: doneA.id } });
    await press(f.r, LEFT);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: doneB.id } });
    await press(f.r, UP);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: nap.id } });
    // x names the selected running pane's job (another session's here: it says so and leaves it running)
    await press(f.r, RIGHT);
    expect(f.text()).toContain(`Stop current: ${talk.id} FAKE job (test): a line every 0.1 s`);
    await press(f.r, 'x');
    await until('the answer', () => c.data.activity.events.some((e) => e.words.startsWith(`Nothing stopped: ${talk.id} belongs to another Timmy session that is still running`)), 5000, f.text);
    expect(jobs.get(talk.id)?.state).toBe('running');
    // Context's drawer open: the body narrower, the panes stacked again (no two on one row), the grid back once it is shut
    await press(f.r, 'i');
    expect(c.ui.rightOpen).toBe(true);
    await until('the panes stacked beside the drawer', () => rowWith(f.lines(), nap.id, talk.id) < 0 && f.text().includes(`${nap.id} `), 5000, f.text);
    await press(f.r, 'i');
    await until('the grid again', () => rowWith(f.lines(), nap.id, talk.id) >= 0, 5000, f.text);
    await jobs.stop(talk.id);
    await jobs.stop(nap.id);
  }, 60_000);
});
