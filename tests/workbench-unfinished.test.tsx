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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
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

function workbench(name: string): Controller {
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
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
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
