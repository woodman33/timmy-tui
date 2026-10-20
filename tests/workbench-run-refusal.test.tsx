// R9 (H161; R8's open item M): one Enter on a running workflow block always says "Not started: it is running now as j…" in
// Activity and starts nothing, whichever reading of the jobs is newer, and the words stay on screen.
//
// R8's rehearsal (its stop step, 2 of 4 runs on the package): an Enter on the running LONG.md › wait showed no refusal in
// Activity within 10 s, while the body's RUN box said it was running. The cause established here: the refusal was said, and
// within a second a notice of the run itself (the REPL's run follower, src/repl/run-progress.ts, says a block's start at its
// first look, 1 s after the job starts: R8's Enter came 0.8 s in) took both places the collapsed Activity shows a notice in,
// the controls row and the strip's "last:" (its other rows are the shared log's). So the refusal was in Activity's events and
// on no screen. A second way to the same silence, the hypothesis of the R9 brief, is checked too: the fresh reading of the job
// store at the Enter without the job the tick's reading had running (a record unreadable at that moment, or a reading that
// failed), which opened the Run confirm instead of refusing.
//
// Drawn by Ink through ink-testing-library at 180x50 over a real Timmy home in a temporary folder, with the REPL's own
// Workspace (its /run, its job store, its operation log and receipt chain, sealed into this test's store). FAKE or FIXTURE
// here, each labelled where it is made: upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7; its blocks run
// for real through sh, on a pty through Timmy's wrapper, this machine's python3); CHAIN.md is this test's FAKE workflow (its
// blocks wait, each for a file of the test's); the browser opener, the server starts and the run detail's and chat's
// producers; the job store's reading that misses a job (a stand-in for a record unreadable at that moment).
import React from 'react';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { realOnPath } from '../src/repl/center.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import type { JobRecord } from '../src/jobs/index.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FIXTURE producers: no run detail and no chat session are needed here
const NO_PRODUCERS: Producers = { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: async () => ({ ok: false, why: 'FIXTURE: none in this test' }) };
/** FAKE workflow (this test's): a, b and c wait for their files in turn, then wait waits for its own; running wait runs all four. */
const chain = (box: string): string => ['# Chain (FAKE workflow, this test)', '', 'Each block waits for a file of the test\'s, at most 60 s.', '',
  ...['a', 'b', 'c', 'wait'].flatMap((name, i, all) => [
    `\`\`\`bash [name:${name}${i ? `, deps:${all[i - 1]}` : ''}]`,
    `i=0; while [ ! -f '${join(box, `go-${name}`)}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`, '```', '',
  ])].join('\n');

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-refusal-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  // each block is released, so a run a failed test left ends here
  for (const name of ['a', 'b', 'c', 'wait']) writeFileSync(join(box, `go-${name}`), '');
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of ['a', 'b', 'c', 'wait']) rmSync(join(box, `go-${name}`), { force: true });
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('TIMMY_STORE', join(box, 'store'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function chainProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  writeFileSync(join(made.root, 'CHAIN.md'), chain(box));
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }, tickMs = 100): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
  const onPath = (cmd: string) => realOnPath(cmd, process.env);
  // the Workspace's notices reach the Workbench as run.ts wires them: each one said, as it comes
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath, glyphs: glyphsFor(true), workspace: ws, producers: NO_PRODUCERS,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs, slowMs: 400,
  });
  opened.push(c);
  return { c, ws };
}

function frameOf(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  return { r, text: () => r.lastFrame() ?? '' };
}

async function press(r: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const k of keys) { r.stdin.write(k); await sleep(60); }
  await sleep(80);
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 20_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(25);
  }
}

/** Activity's box as the app draws it (its rows inside its border, the controls row too), as one line of words. */
function activityText(c: Controller, columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions.bottom?.rect;
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

const ENTER = '\r';
const DOWN = '\u001b[B';

async function selectBlock(c: Controller, r: ReturnType<typeof render>, doc: string, name: string): Promise<void> {
  c.selectWorkspace('workflows');
  c.ui.focus = 'center';
  const on = () => { const s = c.selected(); return s?.kind === 'block' && s.doc.rel === doc && s.block.name === name; };
  for (let i = 0; i < 30 && !on(); i++) await press(r, DOWN);
  if (!on()) throw new Error(`${doc} › ${name} is not in the Workflows list`);
}

const runsOf = (root: string, label: string) => (existsSync(jobsDir) ? readdirSync(jobsDir) : []).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(join(jobsDir, n), 'utf8')) as { id: string; label: string; root: string; state: string; operation?: string; steps?: Array<{ name: string; state: string }> })
  .filter((j) => j.root === root && j.label === label);
const operationsOf = (root: string) => { const d = join(root, '.timmy', 'operations'); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).length : 0; };
const refusalOf = (job: { id: string }) => new RegExp(`Not started: it is running now as ${job.id}\\b`);
const refusals = (c: Controller, job: { id: string }) => c.data.activity.events.filter((e) => refusalOf(job).test(e.words)).length;

/** CHAIN.md › wait started from the Workbench (Enter, the confirm's Enter), running block a; its job once this Workbench names it. */
async function startChain(c: Controller, f: ReturnType<typeof frameOf>, root: string): Promise<{ id: string; operation?: string }> {
  await selectBlock(c, f.r, 'CHAIN.md', 'wait');
  await press(f.r, ENTER);
  expect(c.ui.overlay?.kind).toBe('confirm-run');
  await press(f.r, ENTER);
  const job = await until('the run of CHAIN.md › wait, block a running', () => runsOf(root, 'CHAIN.md › wait').find((j) => j.state === 'running' && (j.steps ?? []).some((s) => s.name === 'a' && s.state === 'running')), 15_000, f.text);
  // the press is over (its start is no longer "being started here") and the Workbench's reading has the job running
  await until('the Workbench to read the job as its own and running', () => !(c.ui.starting ?? []).length && c.data.jobs.some((j) => j.id === job.id && j.live && j.owner === 'workbench'), 10_000, f.text);
  return job;
}

describe('Enter on a running workflow block (R9 H161, R8\'s item M)', () => {
  it('the refusal stays on screen in Activity when the run\'s own notices come right after the Enter, at each of several Enters, and nothing starts', async () => {
    sandbox();
    const p = chainProject('chain');
    const { c } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    const job = await startChain(c, f, p.root);
    // (the run follower's first line, block a's start, is said 1 s after the job began: past it, so what follows is the test's)
    await sleep(1500);
    const jobs = runsOf(p.root, 'CHAIN.md › wait').length;
    const ops = operationsOf(p.root);
    for (const [i, block] of ['a', 'b', 'c'].entries()) {
      const before = refusals(c, job);
      await press(f.r, ENTER);
      const saidAt = Date.now();
      // said, in Activity's events and on screen
      expect(refusals(c, job), `Enter ${i + 1}: one refusal more in Activity`).toBe(before + 1);
      expect(c.ui.overlay, `Enter ${i + 1}: no Run confirm`).toBe(null);
      expect(activityText(c)).toMatch(refusalOf(job));
      // the run moves on right after the Enter (block `block` ends, the next starts): its own notices are said
      writeFileSync(join(box, `go-${block}`), '');
      const newest = () => c.data.activity.events.find((e) => !e.output);
      await until(`a notice of the run itself after Enter ${i + 1} (block ${block} ended)`, () => newest() && !refusalOf(job).test(newest()!.words) && Date.parse(newest()!.at) >= saidAt - 1000, 8000, f.text);
      const late = Date.now() - saidAt;
      expect(late, 'the run\'s notice came while the refusal is still fresh (6 s)').toBeLessThan(5500);
      // R8's M: the refusal is no longer on screen once a later notice has taken the controls row and the strip
      expect(activityText(c), `Enter ${i + 1}: the refusal ${late} ms after it was said, after the run's notice "${newest()!.words}"`).toMatch(refusalOf(job));
    }
    // nothing started: one job and one operation, as before the Enters
    expect(runsOf(p.root, 'CHAIN.md › wait')).toHaveLength(jobs);
    expect(operationsOf(p.root)).toBe(ops);
    writeFileSync(join(box, 'go-wait'), '');
    await until('the run to end', () => runsOf(p.root, 'CHAIN.md › wait')[0]?.state === 'completed', 15_000, f.text);
  }, 90_000);

  it('the fresh reading at the Enter misses the job the last reading had running (unreadable, or the reading failed): refused all the same, no confirm', async () => {
    sandbox();
    const p = chainProject('missed');
    const { c, ws } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    const job = await startChain(c, f, p.root);
    const jobs = runsOf(p.root, 'CHAIN.md › wait').length;
    const ops = operationsOf(p.root);
    const real = ws.jobs.list.bind(ws.jobs);
    // FAKE: the job store's reading during the one Enter: without the job (a record unreadable at that moment), then failing
    for (const miss of ['without the job', 'the reading fails'] as const) {
      let during = false;
      vi.spyOn(ws.jobs, 'list').mockImplementation(() => {
        if (!during) return real();
        if (miss === 'the reading fails') throw new Error('FAKE: the job store could not be read');
        return real().filter((j: JobRecord) => j.id !== job.id);
      });
      expect(c.data.jobs.some((j) => j.id === job.id && j.live), 'the last reading has it running').toBe(true);
      const before = refusals(c, job);
      // (the key is taken synchronously, so the one reading of the jobs this Enter makes is the FAKE one)
      during = true;
      c.key(ENTER, { return: true });
      during = false;
      expect(c.ui.overlay, `${miss}: no Run confirm`).toBe(null);
      expect(refusals(c, job), `${miss}: the refusal is said`).toBe(before + 1);
      expect(c.data.activity.events[0].words).toMatch(new RegExp(`^Not started: it is running now as ${job.id}, started by this Workbench, operation ${job.operation}: Run starts nothing until it ends`));
      vi.restoreAllMocks();
      await sleep(300);
    }
    expect(runsOf(p.root, 'CHAIN.md › wait')).toHaveLength(jobs);
    expect(operationsOf(p.root)).toBe(ops);
  }, 60_000);

  it('the fresh reading saw the run end since the last reading: the newer reading wins, and Run asks again', async () => {
    sandbox();
    const p = chainProject('ended');
    const { c, ws } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    const job = await startChain(c, f, p.root);
    const real = ws.jobs.list.bind(ws.jobs);
    let during = false;
    // FAKE: the reading during the Enter has the job's record ended (as a reading taken just after its end would)
    vi.spyOn(ws.jobs, 'list').mockImplementation(() => (during ? real().map((j: JobRecord) => (j.id === job.id ? { ...j, state: 'completed', endedAt: new Date().toISOString(), exitCode: 0 } : j)) : real()));
    const before = refusals(c, job);
    during = true;
    c.key(ENTER, { return: true });
    during = false;
    expect(refusals(c, job)).toBe(before);
    expect(c.ui.overlay?.kind).toBe('confirm-run');
    // Esc: nothing runs
    vi.restoreAllMocks();
    await press(f.r, '\u001b');
    expect(c.ui.overlay).toBe(null);
    expect(runsOf(p.root, 'CHAIN.md › wait')).toHaveLength(1);
  }, 60_000);
});
