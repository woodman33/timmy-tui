// R4 (H112): the terminal Workbench's interaction proof (the operator's slice C), drawn by Ink through ink-testing-library at
// 180x50 over a real Timmy home in a temporary folder: a tray-workflow project made by the starter code, the shared
// active-project record, the REPL's own Workspace (its /run and NEEDS YOU gate, its job store and receipt chain, sealed for
// real into this test's store). Keys and mouse reports go in through Ink's own input (stdin), as a terminal sends them: a
// click is an SGR report (ESC [ < 0 ; x ; y M, then m), the wheel is button 64 or 65.
//
// FAKE or FIXTURE here, each labelled where it is made: upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7;
// its blocks run for real through sh); the tools rows (no program is probed); the browser opener and the server starts (no
// Show is pressed); the run detail's and the chat session's producers (none is needed here); the person is this test's keys
// and clicks.
import React from 'react';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { JOB_CANCELLED } from '../src/contracts/stop-words.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FAKE: sixty rows in the /tools ladder's shape (no program is run to find them), so All tools scrolls
// (R11 phase 2: the Tools & integrations screen groups the rows by the rail's groups; one kind keeps these sixty in one list, in order)
const FAKE_ROWS: CapabilityRow[] = Array.from({ length: 60 }, (_, i) => ({ id: `fake-${i}`, kind: 'adapter', name: i === 1 ? 'FAKE quartz press' : i === 3 ? 'FAKE quartz saw' : `FAKE tool ${String(i + 1).padStart(2, '0')}`, rung: 'installed', detail: 'FAKE row for the interaction test' }));
// FIXTURE producers: no run detail and no chat session are needed here
const NO_PRODUCERS: Producers = { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: async () => ({ ok: false, why: 'FIXTURE: none in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-interaction-'));
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
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }, o: { mouse?: boolean; setMouse?: (on: boolean) => void; onExit?: (code: number, after: string[]) => void } = {}): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers: NO_PRODUCERS,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => FAKE_ROWS, tickMs: 100, slowMs: 400, ...(o.setMouse ? { setMouse: o.setMouse } : {}), ...(o.onExit ? { onExit: o.onExit } : {}),
  });
  // as `timmy workbench` starts it (TIMMY_MOUSE unset): the Workbench takes the mouse
  if (o.mouse !== false) c.ui.mouse = true;
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

/** The 1-based cell of `needle` on the screen as the Workbench drew it last (its `nth` match), for a click. */
function cellOf(c: Controller, needle: string, nth = 0, from = 0): { x: number; y: number } {
  const rows = screenText(c.frame(180, 50).screen);
  let seen = 0;
  for (let y = from; y < rows.length; y++) {
    const at = rows[y].indexOf(needle);
    if (at < 0) continue;
    if (seen++ < nth) continue;
    return { x: visibleWidth(rows[y].slice(0, at)) + 1, y: y + 1 };
  }
  throw new Error(`"${needle}" is not on the screen:\n${rows.join('\n')}`);
}

/** One region's words as the app drew it, read by cell (its wrapped rows joined), so other zones' rows do not mix in. */
function regionText(c: Controller, region: 'center' | 'right' | 'bottom' | 'nav' | 'top', columns = 180, rows = 50): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[region]?.rect;
  if (!rect) return '';
  const out: string[] = [];
  // R5 (H131): row 2 draws the run state and Stop current in its bottom edge, so the top region is read to that edge
  const last = region === 'top' ? rect.y + rect.h - 1 : rect.y + rect.h - 2;
  for (let y = rect.y + 1; y <= last; y++) {
    let x = 0;
    let row = '';
    for (const seg of fr.screen[y] ?? []) for (const ch of seg.text) { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(y === rect.y + rect.h - 1 ? row.replace(/[─━]/g, ' ') : row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

const click = (r: ReturnType<typeof render>, p: { x: number; y: number }) => press(r, `\x1b[<0;${p.x};${p.y}M`, `\x1b[<0;${p.x};${p.y}m`);
const wheel = (r: ReturnType<typeof render>, p: { x: number; y: number }, down: boolean) => press(r, `\x1b[<${down ? 65 : 64};${p.x};${p.y}M`);

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 20_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

const TAB = '\t';
const ENTER = '\r';
const ESC = '\u001b';

describe('the terminal Workbench\'s mouse (R4 H112, slice C item 1)', () => {
  it('a click opens a tab, picks a right-dock tab, selects a workflow action and a row (twice: still only selected); a click never runs: not an action, not a block, not [Enter] in the Run confirm', async () => {
    sandbox();
    const p = trayProject('mouse-a');
    const { c, ws } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    // R5 (H131): row 1's tabs: a click on 7 Control Room opens it, then on 3 Workflows
    await click(f.r, cellOf(c, 'Control Room'));
    expect(c.ui.workspace).toBe('control');
    expect(f.text()).toContain('mouse-a / Control Room');
    await click(f.r, cellOf(c, 'Workflows'));
    expect(c.ui.workspace).toBe('workflows');
    expect(c.ui.page).toBe('workflows');
    // R5 (H131): a workflow action of row 2 is selected by its click, never run (its Run confirm does not open)
    await click(f.r, cellOf(c, 'Receipts of this project'));
    expect(c.ui.focus).toBe('top');
    expect(c.ui.cursor.top).toBe(3);
    await click(f.r, cellOf(c, 'Run APPROVAL.md › tidy'));
    expect(c.ui.cursor.top).toBe(0);
    expect(c.ui.overlay).toBe(null);
    expect(ws.jobs.list()).toEqual([]);
    // a right-dock tab: Files, then Tools
    // (R5, H136: tab 3's body takes the whole width; i opens Context as a drawer, and i again closes it)
    await press(f.r, 'i');
    await click(f.r, cellOf(c, 'Files', 0, 6));
    expect(c.ui.tab).toBe('files');
    await click(f.r, cellOf(c, 'Tools │'));
    expect(c.ui.tab).toBe('tools');
    await press(f.r, 'i');
    expect(c.ui.rightOpen).toBe(false);
    // a row: WORKFLOW.md's inspect block is selected, and nothing more, however often it is clicked
    const row = cellOf(c, ' inspect ');
    await click(f.r, row);
    expect(c.ui.focus).toBe('center');
    expect(c.selected()).toMatchObject({ kind: 'block', block: { name: 'inspect' } });
    await click(f.r, row);
    await click(f.r, row);
    expect(c.ui.overlay).toBe(null);
    expect(ws.jobs.list()).toEqual([]);
    // Enter, the key, asks first; in the confirm, a click on [Enter] Run it runs nothing and says the key
    await press(f.r, ENTER);
    expect(c.ui.overlay?.kind).toBe('confirm-run');
    await click(f.r, cellOf(c, '[Enter] Run it'));
    expect(c.ui.overlay?.kind).toBe('confirm-run');
    expect(f.text()).toContain('A click never starts a run: press Enter, the key, to run it (or Esc).');
    await sleep(300);
    expect(ws.jobs.list()).toEqual([]);
    expect(readChain('runs')).toEqual([]);
    // [Esc] Do not run, clicked, closes it
    await click(f.r, cellOf(c, '[Esc] Do not run'));
    expect(c.ui.overlay).toBe(null);
    expect(ws.jobs.list()).toEqual([]);
  });

  it('a NEEDS YOU box: a click on [y] never allows (the box waits for a key); a click on [n] denies; nothing runs or is sealed', async () => {
    sandbox();
    const p = trayProject('mouse-b');
    const { c, ws } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    // 3 Workflows: APPROVAL.md's tidy, selected first: Enter, Enter: its NEEDS YOU box
    await press(f.r, '3', TAB, ENTER, ENTER);
    await until('the NEEDS YOU box', () => c.ui.overlay?.kind === 'needs-you', 10_000, f.text);
    await sleep(400); // past the box's type-ahead guard: a key now would answer it
    await click(f.r, cellOf(c, '[y] allow once'));
    expect(c.ui.overlay?.kind).toBe('needs-you');
    expect(f.text()).toContain('A click never allows: press y to allow once');
    await sleep(300);
    expect(ws.jobs.list()).toEqual([]);
    await click(f.r, cellOf(c, '[n] / Esc / Enter deny'));
    await until('the denial', () => /Not run: you denied it in its NEEDS YOU box/.test(f.text()), 10_000, f.text);
    expect(c.ui.overlay).toBe(null);
    expect(ws.jobs.list()).toEqual([]);
    expect(readChain('runs')).toEqual([]);
    expect(existsSync(join(p.root, 'scratch'))).toBe(false);
  });

  it('the wheel scrolls the list under the pointer by rows: no selection, focus or workspace moves (over the tabs it opens none); m gives the mouse back and takes it again', async () => {
    sandbox();
    const p = trayProject('mouse-c');
    const asked: boolean[] = [];
    const { c } = workbench(p, { setMouse: (on) => asked.push(on) });
    c.start();
    c.selectWorkspace('tools');
    const f = frameOf(c, 180, 50);
    await until('the tools', () => /FAKE quartz press/.test(f.text()), 5000, f.text);
    const before = { focus: c.ui.focus, cursor: c.ui.cursor['center:tools'] ?? 0, sel: c.selected() };
    const over = cellOf(c, 'FAKE tool 06');
    for (let i = 0; i < 4; i++) await wheel(f.r, over, true);
    expect(c.ui.scroll['center:tools']).toBe(4);
    expect(c.ui.focus).toBe(before.focus);
    expect(c.ui.cursor['center:tools'] ?? 0).toBe(before.cursor);
    expect(c.selected()).toEqual(before.sel);
    // what the list shows moved by four rows; its range note says so
    expect(f.text()).toMatch(/5–\d+ of \d+/);
    // the view stays where the wheel left it through the Workbench's ticks
    await sleep(500);
    expect(c.ui.scroll['center:tools']).toBe(4);
    await wheel(f.r, over, false);
    expect(c.ui.scroll['center:tools']).toBe(3);
    // over the tabs (row 1), the wheel opens no workspace (R4: over the navigation it once switched workspaces)
    for (let i = 0; i < 3; i++) await wheel(f.r, cellOf(c, 'Studio'), true);
    expect(c.ui.workspace).toBe('tools');
    // a key moves the selection again: the view lets the wheel go and shows it
    await press(f.r, TAB, '\u001b[B');
    expect(c.ui.wheel['center:tools']).toBeUndefined();
    // m: the mouse back to the terminal (the Workbench asks the terminal to stop reporting it); a click then does nothing
    await press(f.r, 'm');
    expect(asked).toEqual([false]);
    expect(c.ui.mouse).toBe(false);
    expect(f.text()).toContain('Mouse: the terminal\'s again');
    const control = cellOf(c, 'Control Room');
    await click(f.r, control);
    expect(c.ui.workspace).toBe('tools');
    await press(f.r, 'm');
    expect(asked).toEqual([false, true]);
    await click(f.r, control);
    expect(c.ui.workspace).toBe('control');
  });

  it('while a field has the keyboard, a click on a one-letter key\'s hint is not typed into it; [/] in the navigation drawer, clicked from All tools, finds a workspace (not the tools)', async () => {
    sandbox();
    const p = trayProject('mouse-d');
    const { c } = workbench(p);
    c.start();
    c.selectWorkspace('tools');
    const f = frameOf(c, 180, 50);
    await until('the tools', () => /FAKE quartz press/.test(f.text()), 5000, f.text);
    await press(f.r, TAB, '/', 'f', 'a');
    expect(c.ui.input).toEqual({ field: 'tools', text: 'fa' });
    // (R5, H131: a one-letter key's hint, as R4's test clicked the navigation's [p]; R11 phase 2: the inventory's [r] checks again)
    await click(f.r, cellOf(c, '[r] checks again'));
    expect(c.ui.input).toEqual({ field: 'tools', text: 'fa' });
    expect(c.ui.overlay).toBe(null);
    await press(f.r, ESC);
    // [/] Find a workspace, in the navigation's drawer (g): a click gives the navigation the keyboard first, so / is the finder
    await press(f.r, 'g');
    await click(f.r, cellOf(c, 'Find a workspace'));
    expect(c.ui.input.field).toBe('search');
    await press(f.r, ...'Templ', ENTER);
    expect(c.ui.workspace).toBe('templates');
  });
});

describe('All tools and the workspace finder (R4 H112, slice C item 6; the r26 dry run)', () => {
  it('while the tools search holds /, its hint says how to reach the finder (R5: the navigation is a drawer, so Esc, then g, then /); Esc clears it and says g, then /; Enter keeps the matches', async () => {
    sandbox();
    const p = trayProject('finder');
    const { c } = workbench(p);
    c.start();
    c.selectWorkspace('tools');
    const f = frameOf(c, 180, 50);
    await until('the tools', () => /FAKE quartz press/.test(f.text()), 5000, f.text);
    // the list has the keyboard: / searches the tools, and the list says how to reach the finder (R5, H131: the navigation
    // is a drawer at every size, so the way is g, then /)
    await press(f.r, TAB);
    expect(f.text()).toContain('[/] Search the tools by name, kind or what they need');
    expect(f.text()).toContain('a workspace: g, then /');
    expect(f.text()).not.toContain('[/] Find a workspace');
    await press(f.r, '/');
    expect(c.ui.input.field).toBe('tools');
    expect(f.text()).toContain('find a workspace: Esc, then g, then /  · Esc clears the search  · Enter keeps the matches');
    expect(f.text()).not.toContain('[/] Find a workspace');
    // Enter keeps the matches, the first selected; / changes them
    await press(f.r, ...'quartz', ENTER);
    expect(c.ui.input.field).toBe(null);
    expect(c.ui.toolsQuery).toBe('quartz');
    expect(f.text()).toMatch(/Matching "quartz"/);
    expect(f.text()).toMatch(/2 tools match "quartz"/);
    expect(c.selected()).toMatchObject({ kind: 'inventory', row: { name: 'FAKE quartz press' } });
    await press(f.r, '\u001b[B');
    expect(c.selected()).toMatchObject({ kind: 'inventory', row: { name: 'FAKE quartz saw' } });
    // Esc (in the search): cleared; the list keeps the keyboard and says the way to the finder: g, then /
    await press(f.r, '/', ESC);
    expect(c.ui.toolsQuery).toBe('');
    expect(c.ui.focus).toBe('center');
    expect(f.text()).toContain('Tools search cleared. g, then / finds a workspace.');
    await press(f.r, 'g');
    expect(f.text()).toContain('[/] Find a workspace');
    await press(f.r, '/', ...'Templates', ENTER);
    expect(c.ui.workspace).toBe('templates');
  });

  it('at 80 columns (the navigation a drawer): the hint says Esc, then g, then /, shown even when a row far down was selected; Esc keeps the keyboard on the list, from its top', async () => {
    sandbox();
    const p = trayProject('finder-narrow');
    const { c } = workbench(p);
    c.start();
    c.selectWorkspace('tools');
    const f = frameOf(c, 80, 24);
    await until('the tools', () => /FAKE quartz press/.test(f.text()), 5000, f.text);
    // a row far down selected: the list's first rows are scrolled away (Tab: the list has the keyboard); R11 phase 2 (H167):
    // the search's row is pinned at the window's top, so it stays in view (the header below it scrolls away)
    await press(f.r, TAB, '\u001b[6~', '\u001b[6~', '\u001b[6~');
    expect(f.text()).toContain('Search the tools');
    expect(f.text()).not.toContain('what this installation has');
    await press(f.r, '/');
    expect(c.ui.input.field).toBe('tools');
    // the search's own row and its hint are shown (found in tmux: they were scrolled away with the list)
    expect(f.text()).toMatch(/Search: /);
    expect(f.text()).toMatch(/find a workspace: Esc, then g, then \//);
    await press(f.r, ESC);
    expect(c.ui.focus).toBe('center');
    expect(f.text()).toContain('Tools search cleared. g, then / finds a workspace.');
    expect(f.text()).toContain('a workspace: g, then /');
    await press(f.r, 'g', '/', ...'Files', ENTER);
    expect(c.ui.workspace).toBe('files');
  });
});

describe('keys that arrive together (R4 H112; found in tmux under load)', () => {
  it('text and Enter in one chunk: the text, then Enter (the finder opens what was typed; the picker switches); the composer keeps its text and takes no Enter from a chunk (a paste never sends)', async () => {
    sandbox();
    const a = trayProject('chunk-a');
    trayProject('chunk-b');
    saveActiveProject(a);
    const { c } = workbench(a);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    // one write: the search key, a name and Enter (as a loaded terminal delivers fast typing)
    await press(f.r, '/Templates\r');
    expect(c.ui.workspace).toBe('templates');
    expect(c.ui.input.field).toBe(null);
    await press(f.r, '/');
    await press(f.r, 'Control\r');
    expect(c.ui.workspace).toBe('control');
    // the picker: a project's name and Enter at once
    await press(f.r, 'p');
    await press(f.r, 'chunk-b\r');
    await until('chunk-b', () => c.data.project.name === 'chunk-b', 5000, f.text);
    // the composer (FIXTURE producer missing here: nothing could be sent anyway) keeps the text and is still typing
    c.selectWorkspace('chat');
    c.ui.focus = 'center';
    await press(f.r, '\r');
    expect(c.ui.input.field).toBe('composer');
    await press(f.r, 'hello\r');
    expect(c.ui.input).toEqual({ field: 'composer', text: 'hello' });
    // a chunk of other keys is still never taken as keys (a paste never presses x, Stop, or anything else)
    await press(f.r, '\u001b');
    await press(f.r, 'xq\r');
    expect(c.ui.workspace).toBe('chat');
  });

  // R4 lead (2026-10-12; tests/workbench-interaction-pty.test.ts failed under load at the integrated head: "a" then "/", and
  // "a" then Tab, sent a quarter second apart, reached the Workbench as one chunk, and neither key acted)
  it('keys typed one after another that arrive as one chunk act in turn: "a/" expands Activity and opens the finder, "a" and Tab expand it and move the focus; x, c, s, C and S only alone; a paste is never keys', async () => {
    sandbox();
    const a = trayProject('chunk-keys');
    const { c } = workbench(a);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    c.ui.focus = 'center';
    const open = c.ui.activityOpen;
    await press(f.r, 'a/');
    expect(c.ui.activityOpen).toBe(!open);
    expect(c.ui.input.field).toBe('search');
    await press(f.r, 'Control\r');
    expect(c.ui.workspace).toBe('control');
    c.ui.focus = 'center';
    await press(f.r, 'a\t');
    expect(c.ui.activityOpen).toBe(open);
    expect(c.ui.focus).not.toBe('center');
    // x (Stop) and the servers' keys are taken only alone: the chunk is taken up to it, and that is said
    await press(f.r, 'ax');
    expect(c.ui.activityOpen).toBe(!open);
    expect(regionText(c, 'bottom')).toContain('Keys that arrived together were taken up to x: x stops the current job, so it is taken only when pressed alone. Press it again.');
    // a paste the terminal marks (bracketed paste) is never keys: outside a field nothing is done with it, and that is said
    await press(f.r, '\u001b[200~xq/a\u001b[201~');
    expect(c.ui.activityOpen).toBe(!open);
    expect(c.ui.input.field).toBe(null);
    expect(regionText(c, 'bottom')).toContain('Pasted text is taken only into a field (the composer, a search, a name): nothing was done with it.');
    // into a field it is text, its lines joined, never an Enter
    await press(f.r, '/');
    await press(f.r, '\u001b[200~Temp\nlates\u001b[201~');
    expect(c.ui.input).toEqual({ field: 'search', text: 'Temp lates' });
  });

  // R10 (H167): CI-like load in the captures PTY test: the colour probe's answers (src/term/probe.ts: OSC 11 and OSC 4, then
  // DA1) came after its 200 ms wait, and "4;7;rgb:c0c0/c0c0/c0c0" was taken as the keys 4, 7, r, g… up to its c
  it('a terminal\'s late answers to the colour probe are never keys: not outside a field (no tab opens, no drawer), not typed into one', async () => {
    sandbox();
    const a = trayProject('late-replies');
    const { c } = workbench(a);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(150);
    const before = { page: c.ui.page, focus: c.ui.focus, nav: c.ui.navOpen, activity: c.ui.activityOpen };
    // as the terminal writes them, each whole; and as a read may split them, after Ink has taken the ESC and the ]
    for (const reply of ['\u001b]11;rgb:0000/0000/0000\u0007', '\u001b]4;7;rgb:c0c0/c0c0/c0c0\u0007', '\u001b[?62;22c', '4;7;rgb:c0c0/c0c0/c0c0', '11;rgb:aaaa/aaaa/aaaa\u0007']) {
      await press(f.r, reply);
    }
    expect({ page: c.ui.page, focus: c.ui.focus, nav: c.ui.navOpen, activity: c.ui.activityOpen }).toEqual(before);
    expect(regionText(c, 'bottom')).not.toContain('Keys that arrived together');
    // in a field: nothing of them is typed into it
    await press(f.r, '/');
    await press(f.r, '4;7;rgb:c0c0/c0c0/c0c0');
    expect(c.ui.input).toEqual({ field: 'search', text: '' });
  });
});

describe('a selection is an item, not a place (R4 H112, slice C items 1 and 5)', () => {
  it('in the Control Room, a job that starts above the selected one moves nothing: the selection, the Inspector and Stop\'s named target stay on it; a Control Room opened again starts on its newest row unless the person chose a row', async () => {
    sandbox();
    const p = trayProject('identity');
    writeFileSync(join(p.root, 'SLOW.md'), '# Slow (FAKE workflow, this test)\n\n```bash [name:wait]\nsleep 20\n```\n\n```bash [name:nap]\nsleep 20\n```\n\n```bash [name:doze]\nsleep 20\n```\n');
    const { c, ws } = workbench(p);
    c.start();
    const f = frameOf(c, 180, 50);
    await sleep(200);
    // two runs, one after the other, each from the Workflows list through the Workbench's own Run (the REPL's /run; FAKE
    // upmd; the blocks sleep for real)
    const runBlock = async (name: string) => {
      c.selectWorkspace('workflows');
      c.ui.focus = 'center';
      for (let i = 0; i < 12 && !(c.selected()?.kind === 'block' && (c.selected() as { block: { name: string } }).block.name === name); i++) await press(f.r, '\u001b[B');
      expect(c.selected()).toMatchObject({ kind: 'block', block: { name } });
      await press(f.r, ENTER, ENTER);
      await until(`the run of ${name}`, () => c.data.jobs.some((j) => j.live && j.label === `SLOW.md › ${name}`), 10_000, f.text);
    };
    await runBlock('wait');
    c.selectWorkspace('control');
    await sleep(200);
    const first = c.selected();
    expect(first).toMatchObject({ kind: 'job', job: { label: 'SLOW.md › wait' } });
    const firstId = first!.kind === 'job' ? first!.job.id : '';
    // a second run starts; the Control Room opened again starts on its first row, the newest (nobody chose a row)
    await runBlock('nap');
    c.selectWorkspace('control');
    await sleep(300);
    expect(c.data.jobs.filter((j) => j.live).map((j) => j.label)).toEqual(['SLOW.md › nap', 'SLOW.md › wait']);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { label: 'SLOW.md › nap' } });
    // the person chooses the first run (a click on its row); a third run starts above it: the selection stays on the chosen
    await click(f.r, cellOf(c, `─ ${firstId} `)); // (R5 H137: its pane, by the id on its edge)
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: firstId } });
    await runBlock('doze');
    c.selectWorkspace('control');
    await sleep(300);
    expect(c.data.jobs.filter((j) => j.live).map((j) => j.label)).toEqual(['SLOW.md › doze', 'SLOW.md › nap', 'SLOW.md › wait']);
    expect(c.selected()).toMatchObject({ kind: 'job', job: { id: firstId } });
    expect(f.text()).toMatch(new RegExp(`┏━ ${firstId} ━[^\\n]*\\n[^\\n]*▶ running {2}SLOW\\.md › wait`)); // (the selected pane: heavy)
    expect(f.text()).toContain(`[x] Stop current: ${firstId} SLOW.md › wait`);
    // x stops exactly what was named
    await press(f.r, 'x');
    await until('the stop', () => ws.jobs.get(firstId)?.state === 'cancelled', 15_000, f.text);
    expect(ws.jobs.list().filter((j) => j.root === p.root && j.label !== 'SLOW.md › wait').map((j) => j.state)).toEqual(['running', 'running']);
  }, 60_000);
});

describe('jobs a session left, in recovery\'s words (R4 H112, slice C item 4)', () => {
  it('a stale record (it says it runs; nothing of it does) and a record recovery ended: each named so in the Control Room and the Inspector; Stop names neither (nothing of them runs)', async () => {
    sandbox();
    const p = trayProject('left');
    // FAKE records, made with Timmy's own job store in a session of this test's own: two runs that ended, each record then
    // rewritten to say it still runs, with a pid that runs nothing (as a session killed outright leaves one)
    const { JobManager } = await import('../src/jobs/index.js');
    const other = new JobManager({ dir: jobsDir });
    const leftBehind = async (label: string): Promise<string> => {
      const j = other.start({ kind: 'workflow', label, project: p.name, root: p.root, command: 'true', args: [] });
      await other.done(j.id);
      const file = join(jobsDir, `${j.id}.json`);
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      delete rec.endedAt; delete rec.exitCode; delete rec.signal;
      writeFileSync(file, JSON.stringify({ ...rec, state: 'running', pid: 2 ** 22 + 12345 }));
      return j.id;
    };
    const quick = { id: await leftBehind('FAKE.md › stale') };
    const ended = { id: await leftBehind('FAKE.md › recovered') };
    // a later session's job store ends the second with the words recovery writes (src/repl/workflow-recover.ts), through the
    // writer recovery uses (JobManager endLeft)
    expect(new JobManager({ dir: jobsDir }).endLeft(ended.id, { state: 'failed', error: 'interrupted: its Workbench ended while wait was running; its process is gone', interrupted: true })).toBeTruthy();
    const { c } = workbench(p);
    c.start();
    c.selectWorkspace('control');
    const f = frameOf(c, 180, 50);
    await until('the records', () => c.data.jobs.length >= 2, 5000, f.text);
    const stale = c.data.jobs.find((j) => j.id === quick.id)!;
    expect(stale).toMatchObject({ live: false, stale: true, word: 'stale', mark: 'unknown', recovery: { state: 'stale' } });
    const recovered = c.data.jobs.find((j) => j.id === ended.id)!;
    expect(recovered.recovery?.state).toBe('ended by recovery');
    // (R5 H137: with nothing running, each is a quiet pane: its id on the edge, its word and label, recovery's words below)
    expect(f.text()).toMatch(new RegExp(`${quick.id} [━─][^\\n]*\\n[^\\n]*stale {2}FAKE\\.md › stale`));
    expect(f.text()).toMatch(new RegExp(`${ended.id} [━─][^\\n]*\\n[^\\n]*failed {2}FAKE\\.md › recovered[^\\n]*\\n[^\\n]*ended by recovery`));
    expect(f.text()).toContain('Stop current: idle');
    // the Inspector, on the stale one, says it in recovery's words, with what settles it
    await press(f.r, TAB);
    for (let i = 0; i < 6 && c.selected()?.kind !== 'job'; i++) await press(f.r, '\u001b[B');
    const pick = async (id: string) => { for (let i = 0; i < 8 && !(c.selected()?.kind === 'job' && (c.selected() as { job: { id: string } }).job.id === id); i++) await press(f.r, '\u001b[B'); };
    await pick(quick.id);
    await press(f.r, 'i'); // (R5 H137: tab 7's Inspector is Context's drawer: i opens it, i again closes it)
    expect(regionText(c, 'right')).toContain('stale: its record says it runs, and no process of it runs: the session that started it ended without recording how it ended. /recover in the REPL records it');
    await press(f.r, 'i');
    await press(f.r, '\u001b[A', '\u001b[A', '\u001b[A');
    await pick(ended.id);
    await press(f.r, 'i');
    expect(regionText(c, 'right')).toContain('ended by recovery: a later session\'s recovery wrote its end from what it found (interrupted: its Workbench ended while wait was running; its process is gone)');
  });
});

describe('quitting as a run ends (R4 H112, slice C items 2 and 4; found in tmux)', () => {
  it('Ctrl+C reads the job store as it is then: while a run of its own goes on, the box names it; a run that ends while the box waits is said to have ended, and Ctrl+C then quits stopping nothing (exit 0); a Ctrl+C just after a run ended, before the next read, quits at once (exit 0); a quit that stops a run of its own exits 130 (R6 H141)', async () => {
    sandbox();
    const p = trayProject('quitting');
    writeFileSync(join(p.root, 'NAP.md'), '# Nap (FAKE workflow, this test)\n\n```bash [name:nap]\nsleep 2\n```\n\n```bash [name:long-nap]\nsleep 30\n```\n');
    const runNap = async (c: Controller, f: ReturnType<typeof frameOf>, block = 'nap'): Promise<string> => {
      c.selectWorkspace('workflows');
      c.ui.focus = 'center';
      for (let i = 0; i < 12 && !(c.selected()?.kind === 'block' && (c.selected() as { block: { name: string } }).block.name === block); i++) await press(f.r, '\u001b[B');
      expect(c.selected()).toMatchObject({ kind: 'block', block: { name: block } });
      const before = new Set(c.data.jobs.map((j) => j.id));
      await press(f.r, ENTER, ENTER);
      const job = await until('the run', () => c.data.jobs.find((j) => j.live && j.label === `NAP.md › ${block}` && !before.has(j.id)), 10_000, f.text);
      return job.id;
    };

    // 1. the box names the run; the run ends while it waits: said so; Ctrl+C quits, and the run's record says completed
    const exits: number[] = [];
    const one = workbench(p, { onExit: (code) => { exits.push(code); } });
    one.c.start();
    const f1 = frameOf(one.c, 180, 50);
    await sleep(150);
    const first = await runNap(one.c, f1);
    await press(f1.r, '\u0003');
    expect(one.c.ui.overlay?.kind).toBe('quit');
    expect(regionText(one.c, 'center')).toContain(`1 job this Workbench started will stop with it (its runner ends when the Workbench does): ${first} NAP.md › nap`);
    expect(regionText(one.c, 'center')).toContain('[Ctrl+C] Quit and stop it [Esc] Stay');
    await until('the run to end', () => one.ws.jobs.get(first)?.state === 'completed', 15_000, f1.text);
    await until('the box to say so', () => regionText(one.c, 'center').includes(`1 job it started ended while this box waited (nothing of it to stop): ${first} NAP.md › nap`), 5000, f1.text);
    expect(regionText(one.c, 'center')).not.toContain('will stop with it');
    expect(regionText(one.c, 'center')).toContain('[Ctrl+C] Quit [Esc] Stay');
    await press(f1.r, '\u0003');
    await until('the quit', () => exits.length > 0, 10_000, f1.text);
    // R6 (H141; the interaction review of a77d80d, defect 15): it stopped nothing, so it reports no interruption
    expect(exits).toEqual([0]);
    expect(JSON.parse(readFileSync(join(jobsDir, `${first}.json`), 'utf8'))).toMatchObject({ state: 'completed' });

    // 2. a run that has just ended, while the Workbench's last read still has it running (set here: as a tick that has not
    // come yet would leave it): Ctrl+C reads the job store and quits at once, with no box
    const quits: number[] = [];
    const two = workbench(p, { onExit: (code) => { quits.push(code); } });
    two.c.start();
    const f2 = frameOf(two.c, 180, 50);
    await sleep(150);
    const second = await runNap(two.c, f2);
    await until('the second run to end', () => two.ws.jobs.get(second)?.state === 'completed', 15_000, f2.text);
    const stale = two.c.data.jobs.map((j) => (j.id === second ? { ...j, state: 'running' as const, live: true } : j));
    two.c.data.jobs = stale;
    expect(two.c.data.jobs.find((j) => j.id === second)?.live).toBe(true);
    await press(f2.r, '\u0003');
    expect(two.c.ui.overlay?.kind).not.toBe('quit');
    await until('the quit', () => quits.length > 0, 10_000, f2.text);
    expect(quits).toEqual([0]);
    expect(JSON.parse(readFileSync(join(jobsDir, `${second}.json`), 'utf8'))).toMatchObject({ state: 'completed' });

    // 3. R6 (H141): a run of its own goes on: the box names it; Ctrl+C again quits and stops it, and the exit says the quit
    // interrupted it (130); the words after the quit say it was stopped, and its record says so
    const ends: Array<{ code: number; after: string[] }> = [];
    const three = workbench(p, { onExit: (code, after) => { ends.push({ code, after }); } });
    three.c.start();
    const f3 = frameOf(three.c, 180, 50);
    await sleep(150);
    const third = await runNap(three.c, f3, 'long-nap');
    await press(f3.r, '\u0003');
    expect(three.c.ui.overlay?.kind).toBe('quit');
    expect(regionText(three.c, 'center')).toContain('[Ctrl+C] Quit and stop it [Esc] Stay');
    await press(f3.r, '\u0003');
    await until('the quit', () => ends.length > 0, 15_000, f3.text);
    // (the stop-words table's word for a job, R6 H140: cancelled)
    expect(ends).toEqual([{ code: 130, after: [`${third} (NAP.md › long-nap) was ${JOB_CANCELLED} as the Workbench ended.`] }]);
    await until('its record ended', () => JSON.parse(readFileSync(join(jobsDir, `${third}.json`), 'utf8')).state !== 'running', 15_000);
    expect(JSON.parse(readFileSync(join(jobsDir, `${third}.json`), 'utf8'))).toMatchObject({ state: 'cancelled' });
  }, 90_000);
});

// R10 (H167; the lead's 12:23 finding, rehearsing the Mac journey: on Home, i opened the Inspector and i again closed it with the
// keyboard on recent work, not on the action strip that had it, so the next Enter opened the selected recent item instead of the
// strip's step): the Inspector drawer gives the keyboard back to the zone that had it, whether i or Escape closes it.
describe('the Inspector drawer gives the keyboard back (R10 H167)', () => {
  it('on Home: from the action strip, i then i again (or Escape) leaves the strip with the keyboard; from recent work, recent work', async () => {
    sandbox();
    const p = trayProject('inspector-back');
    const { c } = workbench(p);
    c.start();
    const f = frameOf(c, 122, 37);
    await sleep(150);
    expect(c.ui.page).toBe('home');
    expect(c.ui.focus).toBe('top');
    await press(f.r, 'i');
    expect(c.ui.rightOpen).toBe(true);
    expect(c.ui.focus).toBe('right');
    await press(f.r, 'i');
    expect(c.ui.rightOpen).toBe(false);
    expect(c.ui.focus).toBe('top');
    await press(f.r, 'i');
    expect(c.ui.focus).toBe('right');
    await press(f.r, ESC);
    expect(c.ui.rightOpen).toBe(false);
    expect(c.ui.focus).toBe('top');
    // from recent work (Tab gives it the keyboard), back to recent work
    await press(f.r, TAB);
    expect(c.ui.focus).toBe('center');
    await press(f.r, 'i');
    expect(c.ui.focus).toBe('right');
    await press(f.r, 'i');
    expect(c.ui.focus).toBe('center');
  }, 30_000);
});
