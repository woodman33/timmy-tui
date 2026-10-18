// R7 (H150; the operator, 2026-10-16: "Keep 3D/Motion, Control Room, Fleet/Clef and Logs/Receipts visibly unfinished until
// their intended interactions work"): each of tabs 6, 7, 8 and 0 says on its page, from the workspace frame's
// tabs[].unfinished (src/contracts/workspace.ts TabDef.unfinished, never a copy of its words here), "Unfinished", with what
// works on it now and what it does not do yet, in structure and text colours (no amber, no green), visible at 100×30; the
// tab strip marks those tabs with a mark and a word (◌ on the tab, "unfinished" where it fits and beside the active tab's
// name on row 2), so no colour is needed. The other tabs say nothing of it.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code and the REPL's own Workspace. The run detail's and the chat session's
// producers have none; the browser opener and the server starts are FAKE.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { JobManager } from '../src/jobs/index.js';
import { createProject, projectId, projectsHome, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { styleOf } from '../src/workbench/theme.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-unfinished-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

/** R7 lead: FAKE (test) native tools for tab 6's list (the ids src/workbench/nav.ts FAMILY_ROWS puts there), each "needs setup". */
const FAKE_TOOLS = ['c4dpy', 'blender', 'openscad', 'freecad', 'unreal', 'recipe-tray', 'aerender', 'afterfx'].map((id) => ({
  id, kind: 'tool' as const, name: `FAKE (test) ${id}`, rung: 'needs setup' as const, detail: `FAKE (test): ${id} is not found here`, setup: `FAKE (test): install ${id}, then check again`,
}));

function workbench(name: string, tools: typeof FAKE_TOOLS = []): Controller {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const p = createProject(name);
  if ('error' in p) throw new Error(p.error);
  const copied = copyStarter('tray-workflow', p.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(p);
  mkdirSync(join(p.root, '.timmy'), { recursive: true });
  writeFileSync(join(p.root, '.timmy', 'store-pin'), join(p.root, '.timmy', 'receipts'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => tools, tickMs: 100, slowMs: 3_600_000,
  });
  opened.push(c);
  return c;
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The centre region's rows as drawn (inside its border), and its segments. */
function center(c: Controller, cols: number, rows: number): { text: string; segs: Array<{ text: string; role?: string; selected?: boolean; inverse?: boolean; bold?: boolean }> } {
  const fr = c.frame(cols, rows);
  const rect = fr.regions.center!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row.replace(/[│┃]/g, ' '));
  }
  const segs = fr.screen.slice(rect.y + 1, rect.y + rect.h - 1).flat();
  return { text: out.join(' ').replace(/\s+/g, ' '), segs };
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('the unfinished tabs say so (R7 H150; the operator\'s order of 2026-10-16)', () => {
  it('tabs 6, 7, 8 and 0 say Unfinished with the frame\'s words, whole, in structure and text colours, at 100x30 and 160x45; the others say nothing of it', async () => {
    const c = workbench('page-boxes');
    c.start();
    await until('the frame', () => c.data.frame);
    const tabs = c.data.frame!.tabs;
    expect(tabs.filter((t) => t.unfinished).map((t) => t.key)).toEqual(['6', '7', '8', '0']);
    for (const [cols, rows] of [[100, 30], [160, 45]] as const) {
      for (const t of tabs) {
        c.key(t.key, {});
        await sleep(100);
        const v = center(c, cols, rows);
        if (!t.unfinished) { expect(v.text, `tab ${t.key} at ${cols}x${rows}`).not.toMatch(/Unfinished/); continue; }
        expect(v.text, `tab ${t.key} at ${cols}x${rows}`).toContain('◌ Unfinished');
        expect(v.text, `tab ${t.key} at ${cols}x${rows}: what works`).toContain(squash(`Works now: ${t.unfinished.works}`));
        expect(v.text, `tab ${t.key} at ${cols}x${rows}: what does not yet`).toContain(squash(`Not yet: ${t.unfinished.missing}`));
        // structure and text colours: none of its segments amber or green
        const start = v.segs.findIndex((s) => s.text.includes('Unfinished'));
        const words = v.segs.slice(Math.max(0, start - 2), start + 40).filter((s) => s.text.trim() && (/Unfinished|Works now|Not yet/.test(s.text) || t.unfinished!.works.includes(s.text.trim()) || t.unfinished!.missing.includes(s.text.trim())));
        expect(words.length).toBeGreaterThan(0);
        for (const s of words) {
          const st = styleOf(s as never, true, 'truecolor');
          expect([HOMEBREW.text, HOMEBREW.textSecondary, HOMEBREW.lineStrong], `tab ${t.key}: "${s.text}"`).toContain(st.color);
        }
      }
    }
  }, 60_000);

  it('only on the tab\'s own workspaces: tab 0\'s Files (the project tree every tab reaches) and tab 8\'s God\'s Eye View (Home\'s too) say nothing of it', async () => {
    const c = workbench('own-workspaces');
    c.start();
    await until('the frame', () => c.data.frame);
    c.key('0', {});
    expect(c.ui.workspace).toBe('logs');
    expect(center(c, 100, 30).text).toContain('◌ Unfinished');
    c.key('0', {});
    expect(c.ui.workspace).toBe('files');
    expect(center(c, 100, 30).text).not.toContain('Unfinished');
    c.key('8', {});
    c.key('8', {});
    expect(c.ui.workspace).toBe('overview');
    expect(center(c, 100, 30).text).not.toContain('Unfinished');
    c.key('6', {});
    c.key('6', {});
    expect(c.ui.workspace).toBe('motion');
    expect(center(c, 100, 30).text).toContain('◌ Unfinished');
  }, 30_000);

  // R7 lead (the package rehearsal's dry run on 3453b3b): with what fills a page below its box (the demo's mesh on tab 6, ended
  // runs on tab 7), the page opened at its first selectable item and the box went above the window: tab 6 at 160x45 showed
  // its box from its third row, and tab 7 at 100x30 none of it. The page now opens at its top; a cursor moved down the list
  // is kept in view as before.
  it('an unfinished tab whose page is full still opens with its box in view: tab 6 with a mesh, tab 7 with ended runs, at 160x45 and 100x30, also with the keyboard in the body; a moved cursor is kept in view', async () => {
    const c = workbench('full-pages', FAKE_TOOLS);
    const root = join(projectsHome(), 'full-pages');
    expect(existsSync(root)).toBe(true);
    mkdirSync(join(root, 'refs'), { recursive: true });
    copyFileSync(join(process.cwd(), 'examples', 'visual-tools', 'demo-tray.stl'), join(root, 'refs', 'demo-tray.stl'));
    // FAKE jobs (test): two that print 60 lines and end, so the Control Room's newest ended runs fill its page
    const jobs = new JobManager({ dir: jobsDir });
    try {
    for (const n of ['A', 'B']) {
      const j = jobs.start({ kind: 'task', label: `FAKE job (test): 60 lines ${n}`, project: 'full-pages', root, command: 'sh', args: ['-c', 'i=0; while [ $i -lt 60 ]; do i=$((i+1)); echo "FAKE line $i"; done'] });
      await jobs.done(j.id);
    }
    c.start();
    await until('the frame', () => c.data.frame);
    // each look opens the tab afresh (from Home), so a second 6 never turns tab 6 to its Motion view
    await until('the mesh and the tools listed', () => { c.key('1', {}); c.key('6', {}); const t = center(c, 160, 45).text; return /MESHES IN THIS PROJECT \(1\)/.test(t) && c.data.caps.state === 'ready'; }, 15_000);
    await until('the ended runs', () => { c.key('1', {}); c.key('7', {}); return /NEWEST ENDED RUNS \(2\)/.test(center(c, 160, 45).text); }, 15_000);
    for (const [cols, rows] of [[160, 45], [100, 30]] as const) {
      for (const key of ['6', '7']) {
        c.key('1', {});
        c.key(key, {});
        await sleep(100);
        const t = c.data.frame!.tabs.find((x) => x.key === key)!;
        const v = center(c, cols, rows);
        expect(v.text, `tab ${key} at ${cols}x${rows}, as it opens`).toContain('◌ Unfinished');
        // R8 (H157; item G): its words begin in view, or (no room left by the first item) its title names where they are
        if (!v.text.includes(squash(`Works now: ${t.unfinished!.works}`).slice(0, 60))) expect(v.text, `tab ${key} at ${cols}x${rows}, as it opens`).toContain('◌ Unfinished · [i] Context shows what works and what does not yet');
      }
    }
    // with the keyboard in the body (tab 6 at 120x40, as the rehearsal had it; tab 7 at 100x30): the page still opens at its
    // top, and a cursor moved down the list is in view
    c.key('1', {});
    c.key('6', {});
    for (let i = 0; i < 6 && c.ui.focus !== 'center'; i++) c.key('', { tab: true });
    expect(c.ui.focus).toBe('center');
    // R8 (H157; item G): its box's title on the window's first row, and its first item in view (the page scrolls to it
    // under the title where the box would leave it no room: tests below)
    const six = c.frame(120, 40);
    expect(screenText(six.screen)[six.regions.center!.rect.y + 1], 'tab 6 at 120x40 with the keyboard in its body').toContain('◌ Unfinished');
    expect(six.regions.center!.items[0].line, 'tab 6 at 120x40 with the keyboard in its body: its first item in view').toBeLessThan(six.regions.center!.scroll + six.regions.center!.height);
    expect(center(c, 120, 40).text).toContain('◌ Unfinished');
    c.key('1', {});
    c.key('7', {});
    expect(c.ui.focus).toBe('center');
    const opened = c.frame(100, 30).regions.center!;
    expect(opened.scroll, 'tab 7 at 100x30 with the keyboard in its body').toBe(0);
    c.key('', { downArrow: true });
    const moved = c.frame(100, 30).regions.center!;
    const cur = c.ui.cursor[moved.list] ?? 0;
    expect(cur, 'the cursor moved down the list').toBeGreaterThan(0);
    expect(moved.items[cur].line, 'the moved cursor\'s row in view').toBeGreaterThanOrEqual(moved.scroll);
    expect(moved.items[cur].line, 'the moved cursor\'s row in view').toBeLessThan(moved.scroll + moved.height);
    } finally { await jobs.stopAll(); }
  }, 60_000);

  // R8 (H157; the R7 package's open item G): with the cursor on the first item, a full unfinished page opened at its top and
  // its first item began below the window (tab 6 with the demo's mesh and its tools: the first tool at row 29 of a 28-row
  // window at 160x45, row 35 of 23 at 120x40, row 29 of 14 at 100x30), so the selection the Inspector described was out of
  // sight. Now the first item's first row is in view as the page opens, and the box stays first: shortened only as much as
  // the first item needs (its closing rule, then its last rows, its title then naming Context, [i], where the rest is), and
  // where even its title leaves no room, the title stays on the window's first row while the page scrolls under it. Context
  // shows the box's words whole while the page does not. Where both fit (tab 7 at 160x45), the box is whole.
  it('a full unfinished page opens with its first item in view and its box first; the words the box leaves out are in Context ([i]); tab 6 and tab 7 at 100x30, 120x40 and 160x45', async () => {
    const c = workbench('first-in-view', FAKE_TOOLS);
    const root = join(projectsHome(), 'first-in-view');
    mkdirSync(join(root, 'refs'), { recursive: true });
    copyFileSync(join(process.cwd(), 'examples', 'visual-tools', 'demo-tray.stl'), join(root, 'refs', 'demo-tray.stl'));
    const jobs = new JobManager({ dir: jobsDir });
    try {
    for (const n of ['A', 'B']) {
      const j = jobs.start({ kind: 'task', label: `FAKE job (test): 60 lines ${n}`, project: 'first-in-view', root, command: 'sh', args: ['-c', 'i=0; while [ $i -lt 60 ]; do i=$((i+1)); echo "FAKE line $i"; done'] });
      await jobs.done(j.id);
    }
    c.start();
    await until('the frame', () => c.data.frame);
    await until('the mesh and the tools listed', () => { c.key('1', {}); c.key('6', {}); const t = center(c, 160, 45).text; return /MESHES IN THIS PROJECT \(1\)/.test(t) && c.data.caps.state === 'ready'; }, 15_000);
    await until('the ended runs', () => { c.key('1', {}); c.key('7', {}); return /NEWEST ENDED RUNS \(2\)/.test(center(c, 160, 45).text); }, 15_000);
    const seen: string[] = [];
    for (const [cols, rows] of [[100, 30], [120, 40], [160, 45]] as const) {
      for (const key of ['6', '7']) {
        const at = `tab ${key} at ${cols}x${rows}, as it opens`;
        c.key('1', {});
        c.key(key, {});
        await sleep(100);
        const t = c.data.frame!.tabs.find((x) => x.key === key)!;
        const fr = c.frame(cols, rows);
        const reg = fr.regions.center!;
        expect(c.ui.cursor[reg.list] ?? 0, at).toBe(0);
        expect(reg.items.length, at).toBeGreaterThan(0);
        // the first item's first row in the window
        expect(reg.items[0].line, `${at}: the first item's row (the window shows ${reg.scroll} to ${reg.scroll + reg.height - 1})`).toBeGreaterThanOrEqual(reg.scroll);
        expect(reg.items[0].line, `${at}: the first item's row (the window shows ${reg.scroll} to ${reg.scroll + reg.height - 1})`).toBeLessThan(reg.scroll + reg.height);
        // the box first: its title on the window's first row
        const text = screenText(fr.screen);
        expect(text[reg.rect.y + 1], at).toContain('◌ Unfinished');
        const v = center(c, cols, rows).text;
        const works = squash(`Works now: ${t.unfinished!.works}`);
        const missing = squash(`Not yet: ${t.unfinished!.missing}`);
        if (v.includes(works) && v.includes(missing)) { seen.push(`${at}: whole`); continue; }
        seen.push(`${at}: shortened`);
        // shortened: its title says where the rest is, and Context shows it whole
        expect(text[reg.rect.y + 1], at).toMatch(/\[i\] Context shows/);
        const drawer = fr.layout.rightAs !== 'column';
        if (drawer) c.key('i', {});
        const f = c.frame(cols, rows);
        const r = f.regions.right!;
        const ctxRows = screenText(f.screen).slice(r.rect.y, r.rect.y + r.rect.h).map((l) => [...l].slice(r.rect.x + 1, r.rect.x + r.rect.w - 1).join('').replace(/[│┃]/g, ' '));
        const ctxText = squash(ctxRows.join(' '));
        // first in Context, under its tabs: the words whole where Context's rows hold them, else their start and Context's
        // range (the rest of Context below, as for any long reading there)
        expect(ctxText, `${at}: Context`).toMatch(/Tools.*Inspector.*Files ◌ UNFINISHED · THIS TAB Works now:/);
        if (r.total <= r.height) {
          expect(ctxText, `${at}: Context`).toContain(works);
          expect(ctxText, `${at}: Context`).toContain(missing);
        } else {
          expect(ctxText, `${at}: Context`).toContain(works.slice(0, 40));
          expect(ctxRows[0], `${at}: Context's range`).toMatch(/1–\d+ of \d+/);
        }
        if (drawer) c.key('', { escape: true });
      }
    }
    // tab 6 needs the room its box would take at every size here; tab 7's box is whole where both fit
    expect(seen).toContain('tab 7 at 160x45, as it opens: whole');
    expect(seen).toContain('tab 6 at 100x30, as it opens: shortened');
    } finally { await jobs.stopAll(); }
  }, 60_000);

  it('the words are the frame\'s own: a frame with other words shows those', async () => {
    const c = workbench('frame-words');
    c.start();
    await until('the frame', () => c.data.frame);
    const f = c.data.frame!;
    c.data.frame = { ...f, tabs: f.tabs.map((t) => (t.id === 'fleet' ? { ...t, unfinished: { works: 'FIXTURE: what the frame says works', missing: 'FIXTURE: what the frame says is missing' } } : t)) };
    c.key('8', {});
    const v = center(c, 160, 45);
    expect(v.text).toContain('Works now: FIXTURE: what the frame says works');
    expect(v.text).toContain('Not yet: FIXTURE: what the frame says is missing');
    expect(v.text).not.toContain(TABS.find((t) => t.id === 'fleet')!.unfinished!.works);
  }, 30_000);

  it('the tab strip marks the unfinished tabs with ◌ and says "unfinished" (a mark and a word, no colour needed), at 160x45 and 100x30; row 2 says it beside the active tab\'s name', async () => {
    const c = workbench('strip-marks');
    c.start();
    await until('the frame', () => c.data.frame);
    for (const [cols, rows] of [[160, 45], [100, 30]] as const) {
      c.key('1', {});
      const fr = c.frame(cols, rows);
      const strip = screenText(fr.screen).slice(0, 3);
      for (const t of fr.pages) {
        const cells = strip.map((l) => [...l].slice(t.x0, t.x1 + 1).join('')).join('\n');
        const tab = c.data.frame!.tabs.find((x) => x.id === t.page)!;
        if (tab.unfinished) expect(cells, `tab ${tab.key} at ${cols}x${rows}`).toContain('◌');
        else expect(cells, `tab ${tab.key} at ${cols}x${rows}`).not.toContain('◌');
      }
      expect(strip.join('\n'), `the word at ${cols}x${rows}`).toMatch(/unfinished/);
      // the active unfinished tab's name on row 2, with the word
      c.key('7', {});
      const top = screenText(c.frame(cols, rows).screen).slice(3, 4).join('');
      expect(top, `row 2 at ${cols}x${rows}`).toMatch(/7 Control Room · unfinished/);
      c.key('3', {});
      expect(screenText(c.frame(cols, rows).screen).slice(3, 4).join('')).not.toMatch(/unfinished/);
    }
  }, 30_000);
});
