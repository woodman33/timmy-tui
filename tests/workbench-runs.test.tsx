// R4 (H112): the terminal Workbench's runs under pressure (the operator's slice C, items 2, 3 and 5), drawn by Ink through
// ink-testing-library at 180x50 over a real Timmy home in a temporary folder: projects made by the starter code, the shared
// active-project record, the REPL's own Workspace (its /run, its job store, its operation log and receipt chain, sealed for
// real into this test's store), upmd on a pty through Timmy's own wrapper (workers/upmd/pty_run.py, this machine's python3).
//
// FAKE or FIXTURE here, each labelled where it is made: upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7,
// pty mode included; the blocks run for real through sh); the workflow documents SLOW.md and STREAM.md are this test's
// (FAKE workflows: they sleep and print); the tools rows, the browser opener and the server starts; the run detail's and
// the chat session's producers (none is needed here); the second Workbench is a second Workspace and Controller in this
// process (its own job store over the same jobs folder: to it, the first is another live Timmy session).
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

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FIXTURE producers: no run detail and no chat session are needed here
const NO_PRODUCERS: Producers = { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: async () => ({ ok: false, why: 'FIXTURE: none in this test' }) };
// FAKE workflows (this test's): blocks that sleep, and one that prints a line every 200 ms for 6 s
const SLOW = '# Slow (FAKE workflow, this test)\n\nIts blocks only wait.\n\n```bash [name:wait]\nsleep 8\n```\n\n```bash [name:long]\nsleep 30\n```\n';
/**
 * R4 lead (full suite 38): it printed its 30 lines in 6 s on its own, and on a loaded machine they could all have arrived before
 * the test counted the lines it had (this test and the Workbench share one process): "five more lines" then never came. It
 * now prints in three parts, 200 ms a line: lines 11 and 21 each wait for a file of the test's (`.stream-go-11`,
 * `.stream-go-21` in the project), at most 30 s, so lines arrive while the test watches, and the run still runs when it
 * presses End.
 */
const stream = (root: string): string => `# Stream (FAKE workflow, this test)\n\nIt prints a line every 200 ms, in three parts the test releases.\n\n\`\`\`bash [name:talk]\nfor i in $(seq 1 30); do if [ $i -eq 11 ] || [ $i -eq 21 ]; then n=0; while [ ! -f '${root}/.stream-go-'$i ] && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done; fi; echo "line $i"; sleep 0.2; done\n\`\`\`\n`;

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-runs-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('TIMMY_STORE', join(box, 'store'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  writeFileSync(join(made.root, 'SLOW.md'), SLOW);
  writeFileSync(join(made.root, 'STREAM.md'), stream(made.root));
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
  // python3 from PATH: /run runs upmd on a pty through Timmy's wrapper (live block states and output as it comes)
  const onPath = (cmd: string) => realOnPath(cmd, process.env);
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
    capabilities: async () => [], tickMs: 100, slowMs: 400,
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
  return { r, text: () => r.lastFrame() ?? '', lines: () => (r.lastFrame() ?? '').split('\n') };
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
    await sleep(50);
  }
}

/** One region's words as the app drew it, read by cell (its wrapped rows joined), so other zones' rows do not mix in. */
function regionText(c: Controller, region: 'center' | 'right' | 'bottom' | 'top', columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[region]?.rect;
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

/** The rows of a region as drawn (inside its border), one string a row. */
function regionRows(c: Controller, region: 'bottom' | 'center', columns = 180, rows = 50): string[] {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[region]!.rect;
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out;
}

const TAB = '\t';
const ENTER = '\r';
const DOWN = '\u001b[B';
const UP = '\u001b[A';
const END = '\u001b[F';

/** Selects a block of the Workflows list by its name (the center has the keyboard). */
async function selectBlock(c: Controller, r: ReturnType<typeof render>, doc: string, name: string): Promise<void> {
  c.selectWorkspace('workflows');
  c.ui.focus = 'center';
  const on = () => { const s = c.selected(); return s?.kind === 'block' && s.doc.rel === doc && s.block.name === name; };
  for (let i = 0; i < 20 && !on(); i++) await press(r, DOWN);
  if (!on()) throw new Error(`${doc} › ${name} is not in the Workflows list`);
}

const runsOf = (root: string, label: string) => (existsSync(jobsDir) ? readdirSync(jobsDir) : []).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(join(jobsDir, n), 'utf8')) as { id: string; label: string; root: string; state: string; operation?: string })
  .filter((j) => j.root === root && j.label === label);
const operationsOf = (root: string, request: string) => {
  const dir = join(root, '.timmy', 'operations');
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as { id: string; request: string; via: string })
    .filter((o) => o.request === request);
};

describe('duplicates and retries (R4 H112, slice C item 2)', () => {
  it('two Enters at once on the Run confirm start one job and one operation; Run again on a block whose job runs says so and starts nothing; so does the confirm', async () => {
    sandbox();
    const p = trayProject('twice');
    const { c } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await selectBlock(c, f.r, 'SLOW.md', 'wait');
    await press(f.r, ENTER);
    expect(c.ui.overlay?.kind).toBe('confirm-run');
    // two Enters in one write (a key held, or two presses faster than a frame: Ink hands them over as one chunk, which
    // before this round was taken for text and did nothing at all); the first runs it, the second starts nothing
    f.r.stdin.write(`${ENTER}${ENTER}`);
    await until('the run', () => runsOf(p.root, 'SLOW.md › wait').length > 0, 10_000, f.text);
    await sleep(500);
    expect(runsOf(p.root, 'SLOW.md › wait')).toHaveLength(1);
    expect(operationsOf(p.root, '/run SLOW.md wait')).toHaveLength(1);
    expect(readChain('runs').filter((r) => r.kind === 'predict')).toHaveLength(1);
    expect(c.ui.overlay).toBe(null);
    // Run again on the same block while its job runs: said, and nothing starts (no confirm, no operation, no job)
    await press(f.r, ENTER);
    expect(c.ui.overlay).toBe(null);
    const [job] = runsOf(p.root, 'SLOW.md › wait');
    // its words (the controls row shows the newest notice; Activity keeps each one whole)
    expect(c.data.activity.events.map((e) => e.words)).toContain(`Not started: it is running now as ${job.id}, started by this Workbench, operation ${job.operation}: Run starts nothing until it ends (x stops it).`);
    // the Tools tab says the same, before anything is pressed (R5 H136: Workflows draws its own columns; Context is the i drawer)
    await press(f.r, 'i');
    c.ui.tab = 'tools';
    expect(regionText(c, 'right')).toContain(`needs: it is running now as ${job.id}`);
    await press(f.r, 'i');
    await sleep(300);
    expect(runsOf(p.root, 'SLOW.md › wait')).toHaveLength(1);
    expect(operationsOf(p.root, '/run SLOW.md wait')).toHaveLength(1);
    // once it ends, Run asks again
    await until('the run to end', () => runsOf(p.root, 'SLOW.md › wait')[0]?.state === 'completed', 15_000, f.text);
    await sleep(300);
    await press(f.r, ENTER);
    expect(c.ui.overlay?.kind).toBe('confirm-run');
  }, 60_000);

  it('Enter, Enter, then y and Enter at once at the NEEDS YOU box: one job, one operation (the Enter after the answer starts nothing)', async () => {
    sandbox();
    const p = trayProject('answered');
    const { c } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await selectBlock(c, f.r, 'APPROVAL.md', 'tidy');
    const sealedBefore = readChain('runs').length;
    await press(f.r, ENTER, ENTER);
    await until('the NEEDS YOU box', () => c.ui.overlay?.kind === 'needs-you', 10_000, f.text);
    await sleep(400); // past the type-ahead guard
    f.r.stdin.write('y');
    f.r.stdin.write(ENTER);
    await sleep(200);
    f.r.stdin.write(ENTER);
    await until('the run to end', () => runsOf(p.root, 'APPROVAL.md › tidy')[0]?.state === 'completed', 15_000, f.text);
    await sleep(800);
    expect(runsOf(p.root, 'APPROVAL.md › tidy')).toHaveLength(1);
    expect(operationsOf(p.root, '/run APPROVAL.md tidy')).toHaveLength(1);
    expect(readChain('runs').slice(sealedBefore).map((r) => r.kind)).toEqual(['predict', 'workflow-block', 'workflow']);
    // the Enter that followed may have opened a confirm once the run had ended (it asks; nothing more ran)
    expect([null, 'confirm-run']).toContain(c.ui.overlay?.kind ?? null);
  }, 60_000);

  it('a second Workbench on the same project shows the first one\'s running job in its Control Room and Activity, and starts nothing (Run there says who runs it)', async () => {
    sandbox();
    const p = trayProject('second');
    const one = workbench(p);
    one.c.start();
    const f1 = frameOf(one.c, 180, 50);
    await sleep(150);
    await selectBlock(one.c, f1.r, 'SLOW.md', 'long');
    await press(f1.r, ENTER, ENTER);
    await until('the run', () => runsOf(p.root, 'SLOW.md › long')[0]?.state === 'running', 10_000, f1.text);
    const [job] = runsOf(p.root, 'SLOW.md › long');
    const jobsBefore = readdirSync(jobsDir).length;
    const opsBefore = readdirSync(join(p.root, '.timmy', 'operations')).length;
    const chainBefore = readChain('runs').length;
    cleanup();
    // the second Workbench (FAKE second session in this process: its own Workspace and job store over the same folder)
    const two = workbench(p);
    two.c.start();
    two.c.selectWorkspace('control');
    const f2 = frameOf(two.c, 180, 50);
    await until('the first one\'s job', () => two.c.data.jobs.some((j) => j.id === job.id && j.live), 5000, f2.text);
    expect(f2.text()).toMatch(new RegExp(`RUNNING NOW \\(1\\)[\\s\\S]*${job.id}\\s+running\\s+SLOW\\.md › long[^\\n]*${job.operation}[^\\n]*another session`));
    await press(f2.r, 'a');
    expect(regionText(two.c, 'bottom')).toContain(`${job.id} started: SLOW.md › long`);
    // opening it started nothing
    await sleep(500);
    expect(readdirSync(jobsDir).length).toBe(jobsBefore);
    expect(readdirSync(join(p.root, '.timmy', 'operations')).length).toBe(opsBefore);
    expect(readChain('runs').length).toBe(chainBefore);
    // Run there on the same block: who runs it is said, and nothing starts
    await selectBlock(two.c, f2.r, 'SLOW.md', 'long');
    await press(f2.r, ENTER);
    expect(two.c.ui.overlay).toBe(null);
    expect(two.c.data.activity.events.some((e) => e.words.startsWith(`Not started: it is running now as ${job.id}, started by another Timmy session, operation ${job.operation}`))).toBe(true);
    await sleep(300);
    expect(runsOf(p.root, 'SLOW.md › long')).toHaveLength(1);
    expect(readdirSync(join(p.root, '.timmy', 'operations')).length).toBe(opsBefore);
    // Stop there names it and leaves it to the session that started it
    two.c.selectWorkspace('control');
    await press(f2.r, 'x');
    await until('the answer', () => two.c.data.activity.events.some((e) => /^Nothing stopped: .* belongs to another Timmy session that is still running/.test(e.words)), 5000, f2.text);
    expect(runsOf(p.root, 'SLOW.md › long')[0].state).toBe('running');
  }, 60_000);
});

describe('a project switch during a run (R4 H112, slice C item 3)', () => {
  it('p to project B while A\'s block runs: it keeps running; the top line\'s Stop names it with A; Activity and Control Room say where it runs; back in A it ends normally, once', async () => {
    sandbox();
    const a = trayProject('tray-a');
    const b = trayProject('tray-b');
    saveActiveProject(a);
    const { c } = workbench(a);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await selectBlock(c, f.r, 'SLOW.md', 'wait');
    await press(f.r, ENTER, ENTER);
    await until('the run', () => runsOf(a.root, 'SLOW.md › wait')[0]?.state === 'running', 10_000, f.text);
    const [job] = runsOf(a.root, 'SLOW.md › wait');
    // p, then B by its name
    await press(f.r, 'p', ...'tray-b', ENTER);
    await until('tray-b', () => c.data.project.name === 'tray-b', 5000, f.text);
    expect(regionText(c, 'top')).toContain(`[x] Stop current: ${job.id} SLOW.md › wait (in tray-a)`);
    expect(regionText(c, 'top')).toContain('run: 1 running in tray-a');
    expect(regionText(c, 'bottom')).toMatch(/Activity \S* ?1 running \(1 in tray-a\)/);
    // the switch's own words (the controls row shows their start; Activity keeps them whole)
    expect(c.data.activity.events.some((e) => e.words.startsWith('Now in tray-b') && e.words.includes(`: ${job.id} (SLOW.md › wait) keeps running in tray-a. Stop still names it.`))).toBe(true);
    c.selectWorkspace('control');
    await sleep(200);
    expect(regionText(c, 'center')).toMatch(new RegExp(`RUNNING IN ANOTHER PROJECT, STARTED HERE \\(1\\) (?:\\S+ )*${job.id} running SLOW\\.md › wait · in tray-a`));
    expect(runsOf(a.root, 'SLOW.md › wait')[0].state).toBe('running');
    // back in A: it ends there, normally, and once
    await press(f.r, 'p', ...'tray-a', ENTER);
    await until('tray-a', () => c.data.project.name === 'tray-a', 5000, f.text);
    await until('the run to end', () => runsOf(a.root, 'SLOW.md › wait')[0]?.state === 'completed', 15_000, f.text);
    await sleep(500);
    expect(runsOf(a.root, 'SLOW.md › wait')).toHaveLength(1);
    expect(runsOf(b.root, 'SLOW.md › wait')).toHaveLength(0);
    expect(operationsOf(a.root, '/run SLOW.md wait')).toHaveLength(1);
    expect(c.data.activity.events.filter((e) => e.key === `job:${job.id}:end`)).toHaveLength(1);
    expect(regionText(c, 'top')).toContain('Stop current: idle');
  }, 60_000);
});

describe('Activity while lines arrive (R4 H112, slice C item 5)', () => {
  it('a FAKE block prints a line every 200 ms, in three parts the test releases (upmd on a pty): each line once, in order; Activity follows the newest; a row selected higher up stays selected, on the same row, with the rows above it, while lines arrive; End follows again', async () => {
    sandbox();
    const p = trayProject('stream');
    const { c } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    await selectBlock(c, f.r, 'STREAM.md', 'talk');
    await press(f.r, ENTER, ENTER);
    await until('the run', () => runsOf(p.root, 'STREAM.md › talk')[0]?.state === 'running', 10_000, f.text);
    const [job] = runsOf(p.root, 'STREAM.md › talk');
    // Activity, expanded, with the keyboard (R5 H136: Tab from the list, past Context where it is a column)
    await press(f.r, 'a');
    for (let i = 0; i < 4 && c.ui.focus !== 'bottom'; i++) await press(f.r, TAB);
    expect(c.ui.focus).toBe('bottom');
    await until('a few lines', () => c.data.activity.events.some((e) => e.words === `${job.id} │ line 4`), 10_000, f.text);
    // following: the newest row is selected (its marker on it) and shown
    expect(c.ui.activityFollow).toBe(true);
    const drawnSel = () => regionRows(c, 'bottom').findIndex((r) => /^\s?▸ /.test(r));
    const following = regionRows(c, 'bottom');
    expect(following[drawnSel()]).toContain(c.data.activity.events[0].words.slice(0, 30));
    // three rows up: held there
    await press(f.r, UP, UP, UP);
    expect(c.ui.activityFollow).toBe(false);
    const heldKey = c.ui.sel.bottom;
    const heldRow = drawnSel();
    const before = regionRows(c, 'bottom');
    const above = before.slice(3, heldRow + 1);
    const seen = c.data.activity.events.filter((e) => e.output).length;
    // five more lines (a second or so): the second part released
    writeFileSync(join(p.root, '.stream-go-11'), '');
    await until('five more lines', () => c.data.activity.events.filter((e) => e.output).length >= seen + 5, 10_000, f.text);
    await sleep(150);
    const after = regionRows(c, 'bottom');
    expect(c.ui.sel.bottom).toBe(heldKey);
    expect(drawnSel()).toBe(heldRow);
    expect(after.slice(3, heldRow + 1)).toEqual(above);
    // End: following the newest again; the view moves with what arrives
    await press(f.r, END);
    expect(c.ui.activityFollow).toBe(true);
    const newest = c.ui.sel.bottom;
    expect(runsOf(p.root, 'STREAM.md › talk')[0].state).toBe('running');
    // the third part released: newer lines arrive
    writeFileSync(join(p.root, '.stream-go-21'), '');
    await until('the selection to follow a newer line', () => c.ui.sel.bottom !== newest, 10_000, f.text);
    expect(drawnSel()).toBeGreaterThan(-1);
    // the run ends; every line of it was shown once, in order (upmd redrew its block for each one)
    await until('the run to end', () => runsOf(p.root, 'STREAM.md › talk')[0]?.state === 'completed', 20_000, f.text);
    await sleep(600);
    const out = c.data.activity.events.filter((e) => e.output && e.job === job.id).reverse().map((e) => e.words.replace(`${job.id} │ `, ''));
    const lines = out.filter((w) => /^line \d+$/.test(w));
    expect(lines).toEqual(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
    // and nothing of upmd's drawing is taken for output: not its code, not its exit line
    expect(out.some((w) => /for i in|exited with code/.test(w))).toBe(false);
  }, 60_000);
});
