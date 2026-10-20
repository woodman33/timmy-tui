// R5 (H131): the terminal Workbench's ten tabs, their workflow actions and Home's connection cards, all drawn from the one
// workspace frame (src/ops/workspace-frame.ts buildWorkspaceFrame, the frame the companion and Studio draw too), over a real
// Timmy home in a temporary folder: a tray-workflow project made by the starter code, the shared active-project record and
// the REPL's own Workspace. The words checked are the frame's (read back from it), never written out here.
//
// FAKE here, each labelled where it is made: the connection checks (a connections record this test writes; nothing is asked
// over the network), the tools rows, the opener and the server starts (none is pressed).
import React from 'react';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { TABS, type ConnectionState, type TabId } from '../src/contracts/workspace.js';
import { CONNECTIONS_SCHEMA, writeConnections, type ConnectionsRecord } from '../src/ops/workspace-frame.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW_GREEN, HOMEBREW } from '../src/theme/tokens.js';
import { visibleWidth } from '../src/term/width.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import type { SetupDeps } from '../src/workbench/setup-paths.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { frameTabs, tabBar, workspaceOfPage } from '../src/workbench/hub.js';
import type { Frame } from '../src/workbench/screen.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { lineCells, plain, type Role, type Seg } from '../src/workbench/text.js';
import { styleOf } from '../src/workbench/theme.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-tabs-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(() => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
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

/** FAKE: the chat's fixes the Workbench carries out (R5 H131, the finish line item 3): the check, Ollama's list and the writers;
 *  nothing is asked over the network and nothing is written */
const FAKE_SETUP: Partial<SetupDeps> = {
  check: async () => ({ record: { schema: CONNECTIONS_SCHEMA, checks: { ollama: { answer: 'accepted', at: new Date().toISOString(), detail: 'FAKE: 1 model' } } }, path: 'FAKE: no record is written in this test' }),
  ollama: async () => ({ where: 'FAKE Ollama', answered: false, models: [], listed: 0, cloud: 0, why: 'FAKE: no Ollama is asked in this test' }),
  saveModel: async () => { throw new Error('FAKE: no setting is saved in this test'); },
  setLocal: async () => { throw new Error('FAKE: nothing is written in this test'); },
};

function workbench(project: { name: string; root: string; chosen: boolean }): Controller {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, project);
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    // FAKE: no tools rows (no machine is probed)
    capabilities: async () => [], tickMs: 100, slowMs: 400, setup: FAKE_SETUP,
  });
  opened.push(c);
  return c;
}

function inkFrame(c: Controller, columns: number, rows: number) {
  const app = <WorkbenchApp controller={c} colour={false} size={{ columns, rows }} />;
  const r = render(app);
  // ink-testing-library's terminal is always 100 columns wide: give it this frame's size, and Ink lays out again at it
  Object.defineProperty(r.stdout, 'columns', { configurable: true, get: () => columns });
  Object.defineProperty(r.stdout, 'rows', { configurable: true, get: () => rows });
  r.rerender(app);
  return { r, lines: (): string[] => (r.lastFrame() ?? '').split('\n'), text: () => r.lastFrame() ?? '' };
}

async function press(r: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const k of keys) { r.stdin.write(k); await sleep(60); }
  await sleep(80);
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

/** The segments of a composed screen with their cells: x from 0, y the row. */
function cells(f: Frame): Array<Seg & { x: number; y: number; w: number }> {
  const out: Array<Seg & { x: number; y: number; w: number }> = [];
  f.screen.forEach((row, y) => {
    let x = 0;
    for (const s of row) { const w = visibleWidth(s.text); out.push({ ...s, x, y, w }); x += w; }
  });
  return out;
}

/** A region's rows as text, inside its border. */
function regionRows(f: Frame, region: 'center' | 'right' | 'top'): string[] {
  const rect = f.regions[region]?.rect;
  if (!rect) return [];
  const rows = screenText(f.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of rows[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The frame, read by the Workbench (it reads it at start, and at most once a second after a change). */
const frameRead = (c: Controller) => until('the workspace frame read by the Workbench', () => c.data.frame, 15_000);

describe('the terminal Workbench\'s tabs and workflow actions, from the shared workspace frame (R5 H131)', () => {
  it('1 to 9 and 0 open the ten tabs, row 1 marking the active one; a tab\'s key again shows its next workspace (6: 3D Create, Motion; 9: All tools, REA, Templates); a digit typed into a field is text, not a tab', async () => {
    sandbox();
    const p = trayProject('tabs-keys');
    const c = workbench(p);
    const f = inkFrame(c, 160, 45);
    await frameRead(c);
    await sleep(100);
    expect(c.ui.page).toBe('home');
    expect(c.ui.workspace).toBe('connections');
    for (const t of TABS) {
      await press(f.r, t.key);
      expect(c.ui.page, `the key ${t.key}`).toBe(t.id);
      expect(c.ui.workspace, `the key ${t.key}`).toBe(workspaceOfPage(t.id));
      // row 1: the active tab in its heavy (amber) box, with its label from the frame; a waiting count may follow it
      const label = c.data.frame!.tabs.find((x) => x.id === t.id)!.label;
      expect(f.lines()[1], `row 1 with ${t.key} active`).toMatch(new RegExp(`┃\\s*${t.key} ${escape(label)}(?: ⚠\\d+)?\\s*┃`));
      expect(f.lines()[1].match(/┃/g) ?? [], 'one heavy box on row 1').toHaveLength(2);
    }
    // the same key again: the tab's next workspace, then back to its first
    await press(f.r, '6');
    expect([c.ui.page, c.ui.workspace]).toEqual(['create', 'create3d']);
    await press(f.r, '6');
    expect([c.ui.page, c.ui.workspace]).toEqual(['create', 'motion']);
    await press(f.r, '6');
    expect(c.ui.workspace).toBe('create3d');
    await press(f.r, '9');
    expect([c.ui.page, c.ui.workspace]).toEqual(['tools', 'tools']);
    await press(f.r, '9');
    expect(c.ui.workspace).toBe('rea');
    await press(f.r, '9');
    expect(c.ui.workspace).toBe('templates');
    await press(f.r, '9');
    expect(c.ui.workspace).toBe('tools');
    // a digit typed into a field (the workspace finder's search) is its text: no tab opens
    await press(f.r, '3');
    expect(c.ui.page).toBe('workflows');
    await press(f.r, '/', '7');
    expect(c.ui.input).toEqual({ field: 'search', text: '7' });
    expect(c.ui.page).toBe('workflows');
    await press(f.r, '\u001b');
    expect(c.ui.input.field).toBe(null);
    await press(f.r, '7');
    expect(c.ui.page).toBe('control');
  }, 60_000);

  it('row 1 keeps every tab where it is, at every size, whichever tab is active and whatever waits (the QA round\'s defect 4): the same cells, the waiting count in the top edge (boxes) or a cell of its own (one row)', () => {
    const g = glyphsFor(true);
    for (const [w, rows] of [[180, 3], [160, 3], [120, 3], [100, 3], [80, 1], [60, 1], [70, 3], [60, 3]] as const) {
      let first = '';
      let form = '';
      for (const active of TABS.map((t) => t.id)) {
        for (const waiting of [0, 1, 12]) {
          const tabs = frameTabs(undefined).map((t) => ({ ...t, waiting: t.id === 'control' || t.id === 'home' ? waiting : 0 }));
          const bar = tabBar(tabs, active, 'tray-stable', w, rows, g);
          const where = `${w} columns, ${active} active, ${waiting} waiting`;
          const cellsAt = JSON.stringify(bar.hits.map((h) => [h.x0, h.x1]));
          first ||= cellsAt;
          form ||= bar.form;
          expect(cellsAt, where).toBe(first);
          expect(bar.form, where).toBe(form);
          expect(bar.lines).toHaveLength(rows);
          for (const l of bar.lines) expect(lineCells(l), where).toBe(w);
          const text = bar.lines.map(plain);
          // what waits is drawn over its own tab, and nowhere else; the labels' row never carries it on a boxed bar
          for (const h of bar.hits) {
            // a boxed tab's top edge, or a one-row bar's cell (its last cell is kept for the mark)
            const over = text[0].slice(h.x0, h.x1 + 1);
            const waits = waiting > 0 && (h.page === 'control' || h.page === 'home');
            expect(over.includes(g.warn), `${where}: the mark over ${h.page}`).toBe(waits);
            // the count with it where the box has room for both (and an edge cell before them)
            if (waits && rows === 3 && waiting === 1 && h.x1 - h.x0 - 1 >= 3) expect(over, where).toContain(`${g.warn}1`);
          }
          if (rows === 3) expect(text[1], where).not.toContain(g.warn);
        }
      }
    }
  });

  it('row 2 draws each tab\'s workflow actions as the frame names them: at most one primary next step, amber (filled, ▶), exactly the frame\'s; no action is ever green', async () => {
    sandbox();
    const p = trayProject('tabs-actions');
    const c = workbench(p);
    const frame = await frameRead(c);
    let primaries = 0;
    for (const t of TABS) {
      c.selectPage(t.id);
      const f = c.frame(160, 45);
      const acts = frame.actions[t.id];
      expect(acts.filter((a) => a.primary).length, `the frame's primary actions on ${t.label}`).toBeLessThanOrEqual(1);
      // the action boxes: where row 2 draws them (Frame.actions), each with its segments
      expect(f.actions.map((h) => h.i), `row 2's boxes on ${t.label}`).toEqual(acts.map((_, i) => i));
      const y = f.actions[0]?.y ?? -1;
      const segs = cells(f).filter((s) => s.y === y);
      const boxes = f.actions.map((h) => segs.filter((s) => s.x >= h.x0 - 1 && s.x < h.x1 + 1 && s.text.trim()));
      const amber = boxes.map((b) => b.some((s) => s.role === 'accent' && s.inverse === true));
      const want = acts.map((a) => a.primary && a.enabled);
      expect(amber, `the amber box on ${t.label}`).toEqual(want);
      if (want.includes(true)) {
        primaries += 1;
        const i = want.indexOf(true);
        expect(boxes[i].map((s) => s.text).join(''), `the primary on ${t.label}`).toContain(`▶ ${acts[i].n} `);
      }
      // each action's number and label (cut evenly where they do not all fit) as the frame says them
      const row = screenText(f.screen)[y];
      for (const a of acts) expect(row, `${a.n} ${a.label} on ${t.label}`).toContain(`${a.n} ${a.label.slice(0, 6)}`);
      // never green: no action, no command, no tab
      expect(cells(f).filter((s) => s.y <= y && s.role === 'live'), `green on rows 1 and 2 of ${t.label}`).toEqual([]);
    }
    // the tray project, freshly made, has a next step somewhere (its chat is not set up; its workflow has not run)
    expect(primaries).toBeGreaterThan(0);
  }, 60_000);

  it('Enter on a workflow action: a tab or a workspace opens; a key\'s action is that key\'s own path; a command the Workbench has no path for is shown to copy, and nothing runs', async () => {
    sandbox();
    const p = trayProject('tabs-enter');
    const c = workbench(p);
    const f = inkFrame(c, 160, 45);
    const frame = await frameRead(c);
    const jobFiles = (): number => (existsSync(jobsDir) ? readdirSync(jobsDir).length : 0);
    const jobsBefore = jobFiles();
    const enterOn = async (tab: TabId, command: string): Promise<void> => {
      await press(f.r, TABS.find((t) => t.id === tab)!.key);
      const i = frame.actions[tab].findIndex((a) => a.command === command);
      expect(i, `${command} on ${tab}`).toBeGreaterThanOrEqual(0);
      c.ui.focus = 'top';
      c.ui.cursor.top = i;
      await press(f.r, '\r');
    };
    // 6 3D & Motion, "All tools and what each needs" (/tools): All tools opens, on its tab
    await enterOn('create', '/tools');
    expect([c.ui.page, c.ui.workspace]).toEqual(['tools', 'tools']);
    // 1 Home, "Switch project" (/project <name>): the project picker, as p opens it
    await enterOn('home', '/project <name>');
    expect(f.text()).toContain('Switch project');
    await press(f.r, '\u001b');
    // 1 Home, "Check connections" (timmy workspace check): R5 (H131; the finish line, item 3): the check runs here (FAKE: its
    // record is this test's; nothing is asked), and its box says what answered
    await enterOn('home', 'timmy workspace check');
    const center = (): string => regionRows(c.frame(160, 45), 'center').join(' ').replace(/\s+/g, ' ');
    await until('the check\'s words', () => /Checked just now/.test(center()), 10_000, center);
    expect(center()).toContain('Ollama (its list of models) answered: FAKE: 1 model');
    expect(center()).toContain('Timmy Studio not asked this time');
    await press(f.r, '\u001b');
    // 8 Fleet, "Fleet status" (timmy fleet status): no path here: shown to copy, with where it runs; nothing runs
    // (its words wrapped to the body's width, never cut: read from the body's own rows)
    await enterOn('fleet', 'timmy fleet status');
    const shown = center();
    expect(shown).toContain('Run it in a shell');
    expect(shown).toContain('timmy fleet status');
    expect(shown).toContain('Nothing was run from here: the Workbench has no path of its own for it.');
    await press(f.r, '\u001b');
    expect(jobFiles(), 'no job started').toBe(jobsBefore);
  }, 60_000);

  it('Home\'s connection cards, as the frame observed them: each state\'s mark and word (● live, ○ configured, ✕ refused or unreachable, · not set up, ? unknown) with the frame\'s words; green only on the live one', async () => {
    sandbox();
    // FAKE: what a `timmy workspace check` would have recorded (nothing is asked here): Ollama answered 2 minutes ago, the
    // OpenRouter key was refused, the Cloudflare edge did not answer
    const now = Date.now();
    const rec: ConnectionsRecord = {
      schema: CONNECTIONS_SCHEMA,
      checks: {
        ollama: { answer: 'accepted', at: new Date(now - 2 * 60_000).toISOString(), detail: 'FAKE: 2 models' },
        openrouter: { answer: 'refused', at: new Date(now - 60_000).toISOString(), detail: 'FAKE: HTTP 401' },
        cloudflare: { answer: 'no answer', at: new Date(now - 60_000).toISOString(), detail: 'FAKE: timed out' },
      },
    };
    writeConnections(rec, process.env);
    const p = trayProject('tabs-home');
    const c = workbench(p);
    const frame = await frameRead(c);
    const states = new Set(frame.connections.map((x) => x.state));
    // the record's states, as the frame reads them (the words are the frame's: read back, not written here)
    for (const s of ['live', 'refused', 'not set up', 'unknown'] as ConnectionState[]) expect(states, `a ${s} connection in the frame`).toContain(s);
    c.selectPage('home');
    const f = c.frame(160, 70);
    const left = regionRows(f, 'center');
    const MARK: Record<ConnectionState, string> = { live: '● live', configured: '○ configured', 'not set up': '· not set up', unreachable: '✕ unreachable', refused: '✕ refused', unknown: '? unknown' };
    for (const conn of frame.connections) {
      const top = left.findIndex((l) => l.includes(` ${conn.label.slice(0, 12)}`) && l.includes(` ${MARK[conn.state]} `));
      expect(top, `${conn.label}'s card with ${MARK[conn.state]}`).toBeGreaterThanOrEqual(0);
      // its words on the card's first row (cut with an ellipsis where they do not fit)
      expect(left[top + 1], `${conn.label}'s words`).toContain(conn.words.slice(0, 16));
      // a card that is not live says its step (or its detail), never "live"
      if (conn.state !== 'live') expect(left.slice(top, top + 4).join(' ')).not.toMatch(/● live/);
    }
    // green (role live) only on the live card's mark; the failures amber (role failure) with ✕ and their word
    const all = cells(f);
    const green = all.filter((s) => s.role === 'live' && s.text.trim());
    const live = frame.connections.filter((x) => x.state === 'live');
    expect(green.map((s) => s.text.trim())).toEqual(live.map(() => '● live'));
    for (const s of all.filter((x) => x.text.includes('✕ refused') || x.text.includes('✕ unreachable'))) expect(s.role).toBe('failure');
    expect(styleOf({ text: '✕ refused', role: 'failure' }, true).color).toBe(HOMEBREW.failure);

    // nothing live (the record gone): no green anywhere on Home
    rmSync(join(home, 'state', 'connections.json'), { force: true });
    c.refresh();
    await until('the frame read again with nothing live', () => c.data.frame && !c.data.frame.connections.some((x) => x.state === 'live'), 15_000);
    const none = c.frame(160, 70);
    expect(cells(none).filter((s) => s.role === 'live' && s.text.trim())).toEqual([]);
  }, 60_000);

  it('on the selection\'s ground a quiet word takes the text\'s colour (the QA round\'s defect 11: grey on it measured 3.88:1); elsewhere it stays quiet', () => {
    for (const role of ['secondary', 'border'] as const) {
      expect(styleOf({ text: 'x', role, selected: true }, true)).toMatchObject({ color: HOMEBREW.text, backgroundColor: HOMEBREW.accentSoft });
      expect(styleOf({ text: 'x', role }, true).color).not.toBe(HOMEBREW.text);
    }
    // the roles that carry a meaning keep their colour on it (their word says it too)
    for (const role of ['action', 'attention', 'failure', 'live', 'ai', 'link'] as const) expect(styleOf({ text: 'x', role, selected: true }, true).color).toBe(styleOf({ text: 'x', role }, true).color);
  });

  it('only the role `live` is green: every other role\'s colour is not Homebrew\'s green (B10)', () => {
    const roles: Role[] = ['text', 'secondary', 'strong', 'action', 'link', 'attention', 'failure', 'live', 'ai', 'border', 'focus'];
    const greens = new Set([HOMEBREW_GREEN.toLowerCase(), HOMEBREW.liveDim.toLowerCase()]);
    for (const role of roles) {
      const color = (styleOf({ text: 'x', role }, true).color ?? '').toLowerCase();
      if (role === 'live') expect(color).toBe(HOMEBREW_GREEN.toLowerCase());
      else expect(greens.has(color), `the role ${role} (${color})`).toBe(false);
    }
  });

  it('every tab at 160x45, 120x40 and 100x30: the composed screen has exactly that many rows, each exactly that wide; Ink draws no line wider; row 1 says TIMMY, the project and the active tab', async () => {
    sandbox();
    const p = trayProject('tabs-sizes');
    const c = workbench(p);
    await frameRead(c);
    for (const [w, h] of [[160, 45], [120, 40], [100, 30]] as const) {
      for (const t of TABS) {
        c.selectPage(t.id);
        const f = c.frame(w, h);
        const rows = screenText(f.screen);
        expect(rows, `${t.label} at ${w}x${h}`).toHaveLength(h);
        for (const [y, row] of rows.entries()) expect(visibleWidth(row), `${t.label} at ${w}x${h}, row ${y + 1}`).toBe(w);
        // row 1: three rows of boxes from 30 rows; TIMMY and the project on its middle row
        expect(rows[1], `row 1 of ${t.label} at ${w}x${h}`).toContain(`TIMMY · ${p.name}`);
        const label = t.label;
        expect(rows.slice(0, 3).join('\n'), `the active tab at ${w}x${h}`).toMatch(new RegExp(`┃\\s*${t.key}(?: ${escape(label)}| ${escape(label.split(/\s+/)[0])})?(?: ⚠\\d+)?\\s*┃`));
        expect(rows.join('\n'), `Workflow actions at ${w}x${h}`).toContain('Workflow actions');
        expect(rows.join('\n'), `Activity & log at ${w}x${h}`).toContain('Activity & log');
      }
    }
    // Ink, at each size: no line wider than the terminal, and as many lines as it has rows
    for (const [w, h] of [[160, 45], [120, 40], [100, 30]] as const) {
      const f = inkFrame(c, w, h);
      for (const t of TABS) {
        await press(f.r, t.key);
        const lines = f.lines();
        expect(lines, `Ink: ${t.label} at ${w}x${h}`).toHaveLength(h);
        for (const [y, l] of lines.entries()) expect(visibleWidth(l), `Ink: ${t.label} at ${w}x${h}, line ${y + 1}`).toBeLessThanOrEqual(w);
      }
      cleanup();
    }
  }, 120_000);
});
