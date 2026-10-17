/**
 * R7 (H151): Studio in small and ordinary windows, and its unfinished tabs, in a real headless Chromium against the real canvas
 * server, the real frame and the real bundle (built here).
 *
 * H147's R6 finding 3 (review/H147/caps/studio/12-canvas-800x600.png, 26-board-800x600.png): at 800 x 600 the tabs were cut at
 * "7 Contro" and the panels buried the board. The operator's order of 2026-10-16, 22:08 PT: "Prioritize readable text, usable
 * preview space, non-overlapping Studio cards, responsive panels"; "Keep 3D/Motion, Control Room, Fleet/Clef and Logs/Receipts
 * visibly unfinished until their intended interactions work" (src/contracts/workspace.ts TabDef.unfinished, on the frame's tabs[]).
 *
 * At 800 x 600, 1024 x 768, 1376 x 768 and 1440 x 900: every tab whole, on one line, with its key (the row wraps between tabs);
 * every action whole; the activity line inside the window; no panel over the board's own toolbar; Timmy's text 11 px or more; and
 * the board's visible area at least BOARD_FLOOR of the window. The floor is the brief's own words, stated before measuring: "the
 * board keeps most of the window", so at least half of it. The board's visible area is measured as a person sees it: points of
 * the window, 8 px apart, where what is on top is tldraw's canvas (its drawing surface: nothing of Timmy's strip or panel, and none
 * of tldraw's own menus, style panel, toolbar or navigation, is over it). The project and its cards are FAKE
 * (tests/helpers/canvas-project.ts and 24 workflow documents written here). Skipped, saying so, where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { CONNECTIONS_SCHEMA, writeConnections } from '../src/ops/workspace-frame.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-small-window-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** The brief: "the board keeps most of the window": at least half of the window shows the board, at every size. */
const BOARD_FLOOR = 0.5;
const SIZES = [{ width: 800, height: 600 }, { width: 1024, height: 768 }, { width: 1376, height: 768 }, { width: 1440, height: 900 }] as const;
const AMBER = 'rgb(255, 176, 0)';
const HX = 'd'.repeat(32);

describe.skipIf(!browserPath)('Studio in small and ordinary windows, and its unfinished tabs (R7 H151)', () => {
  let p: CanvasProject;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-small-');
    for (let i = 1; i <= 24; i++) p.write(`WF${String(i).padStart(2, '0')}.md`, `# Workflow number ${i}, with a title long enough to wrap in the panel\n\n\`\`\`bash [name:a]\necho ${i}\n\`\`\`\n`);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-small-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-small-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await nameProject(port, server.projectToken, { root: p.root, name: 'small-window', holder: HX, jobs: p.jobs, receipts: p.store });
    // Studio observed (a FAKE check record, written here: no request was made to a Studio), so the frame's Studio primary is the one a
    // person sees with Studio open, "Open the canvas for Timmy (then ask it to draw)": the longest of its labels
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date().toISOString(), detail: 'FAKE: written by the test' } } }, { TIMMY_HOME: home });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(viewport: { width: number; height: number }): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#frame-tabs li').length === 10 && Boolean(document.getElementById('frame')?.dataset.revision), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    // the strip and the canvas settle (the canvas follows the strip's height a frame later)
    await page.waitForFunction(() => Math.abs(document.getElementById('root')!.getBoundingClientRect().top - document.getElementById('frame')!.getBoundingClientRect().bottom) <= 1, null, { timeout: 5_000 });
    await page.waitForTimeout(300);
    return { page, context, errors };
  }

  /** What the window shows, measured as a person sees it (see this file's comment). */
  const measure = (page: Page) => page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const inside = (b: DOMRect): boolean => b.width > 0 && b.height > 0 && b.left >= -0.5 && b.right <= vw + 0.5 && b.top >= -0.5 && b.bottom <= vh + 0.5;
    const unclipped = (e: Element): boolean => {
      const b = e.getBoundingClientRect();
      for (let a = e.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        if (b.left < c.left - 0.5 || b.right > c.right + 0.5 || b.top < c.top - 0.5 || b.bottom > c.bottom + 0.5) return false;
      }
      return true;
    };
    const shown = (e: Element): boolean => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
    const lineHeight = (e: Element): number => parseFloat(getComputedStyle(e).lineHeight) || 18;
    // every tab whole, with its key, on one line (never broken inside its label)
    const tabs = [...document.querySelectorAll('#frame-tabs li')].map((li) => ({
      text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(), key: li.querySelector('.fr-key')?.textContent ?? '',
      whole: inside(li.getBoundingClientRect()) && unclipped(li), oneLine: li.getBoundingClientRect().height <= lineHeight(li) + 4,
    }));
    // every action whole: its number, its label, and its command and Copy (or the draft's Go to the draft)
    const acts = [...document.querySelectorAll('#frame-acts li')].map((li) => ({
      text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
      whole: [...li.querySelectorAll('.fr-n, .fr-label, code.fr-cmd, button.fr-copy, button.fr-go')].every((x) => inside(x.getBoundingClientRect()) && unclipped(x)),
    }));
    // the activity line inside the window; its counts whole; what it shortens says itself whole in its title
    const line = document.getElementById('frame-activity')!;
    const counts = [...line.querySelectorAll('.fr-running, .fr-waiting')].map((x) => ({ text: x.textContent, whole: inside(x.getBoundingClientRect()) && unclipped(x) }));
    const shortened = [...line.querySelectorAll('.fr-turn, .fr-stop, .fr-log')].filter((x) => (x as HTMLElement).scrollWidth > (x as HTMLElement).clientWidth + 1).map((x) => ({ titled: x.getAttribute('title') === x.textContent }));
    // Timmy's text: 11 px or more, everywhere it shows (the strip, the panel, the board's blank guide)
    const small = [...document.querySelectorAll('#frame *, #side *, #guide, #guide *')].filter((e) => shown(e) && [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim()))
      .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => `${e.tagName}.${(e as HTMLElement).className}: ${getComputedStyle(e).fontSize} "${(e.textContent ?? '').trim().slice(0, 30)}"`);
    // no panel over the board's own toolbar (tldraw's main toolbar as drawn, and its navigation panel)
    const r = (s: string): DOMRect | null => { const e = document.querySelector(s); return e && shown(e) ? e.getBoundingClientRect() : null; };
    const over = (a: DOMRect | null, b: DOMRect | null): boolean => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const toolbar = r('.tlui-main-toolbar__inner');
    const panels = { side: r('#side'), strip: r('#frame'), style: r('.tlui-style-panel__wrapper'), menu: r('.tlui-menu-zone') };
    const overToolbar = Object.entries(panels).filter(([, b]) => over(b, toolbar)).map(([k]) => k);
    // the blank board's guide, where it shows, covers neither Timmy's panel nor tldraw's style panel
    const guide = r('#guide');
    const guideOver = guide ? (['side', 'style'] as const).filter((k) => over(guide, panels[k])) : [];
    // the board's visible area: points 8 px apart where tldraw's canvas is what is on top
    let all = 0;
    let board = 0;
    for (let y = 4; y < vh; y += 8) {
      for (let x = 4; x < vw; x += 8) {
        all += 1;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest('.tl-canvas') && !hit.closest('.tlui-layout')) board += 1;
      }
    }
    return { tabs, acts, counts, shortened, lineInside: inside(line.getBoundingClientRect()) || line.getBoundingClientRect().right <= vw + 0.5, small, overToolbar, guideOver, guide: !!guide,
      boardShare: Math.round((board / all) * 1000) / 1000, folded: document.getElementById('side')!.dataset.folded, toolbar: !!toolbar,
      strip: Math.round(document.getElementById('frame')!.getBoundingClientRect().height) };
  });

  for (const size of SIZES) {
    it(`at ${size.width} x ${size.height}: every tab whole on one line with its key, every action whole, the activity inside the window, no panel over the board's toolbar, Timmy's text 11 px or more, and the board at least ${BOARD_FLOOR * 100}% of the window`, async () => {
      const { page, context, errors } = await open(size);
      const where = `${size.width}x${size.height}`;
      try {
        const m = await measure(page);
        console.info(`studio-small-window ${where}: board ${Math.round(m.boardShare * 100)}% of the window, strip ${m.strip} px, lists ${m.folded === 'true' ? 'folded' : 'open'}`);
        await shoot(page, `small-window-${where}.png`);
        expect(m.tabs.map((t) => t.key), where).toEqual(TABS.map((t) => t.key));
        expect(m.tabs.filter((t) => !t.whole || !t.oneLine).map((t) => t.text), where).toEqual([]);
        // each tab's whole label, from the frame (the unfinished ones with their mark)
        expect(m.tabs.map((t) => t.text), where).toEqual(TABS.map((t) => `${t.key} ${t.label}${t.unfinished ? ' ◌' : ''}`));
        expect(m.acts.length, where).toBe(4);
        expect(m.acts.filter((a) => !a.whole).map((a) => a.text), where).toEqual([]);
        expect(m.counts.every((c) => c.whole), where).toBe(true);
        expect(m.lineInside, where).toBe(true);
        expect(m.shortened.every((s) => s.titled), where).toBe(true);
        expect(m.small, where).toEqual([]);
        expect(m.toolbar, `${where}: tldraw's toolbar found`).toBe(true);
        expect(m.overToolbar, where).toEqual([]);
        expect(m.guide, `${where}: the blank board's guide shows`).toBe(true);
        expect(m.guideOver, where).toEqual([]);
        expect(m.boardShare, `${where}: the board's visible share of the window`).toBeGreaterThanOrEqual(BOARD_FLOOR);
        // below 1100 px the panel's lists start folded behind a control; at 1100 px and wider they start open
        expect(m.folded, where).toBe(size.width < 1100 ? 'true' : 'false');
        expect(errors, where).toEqual([]);
      } finally {
        await context.close();
      }
    }, 120_000);
  }

  it('at 800 x 600 the folded lists open from their control and fold again; what waits on you (the save line, the drafts) is never folded', async () => {
    const { page, context, errors } = await open({ width: 800, height: 600 });
    try {
      const state = () => page.evaluate(() => ({
        folded: document.getElementById('side')!.dataset.folded, expanded: document.getElementById('side-fold')!.getAttribute('aria-expanded'), words: document.getElementById('side-fold')!.textContent,
        lists: getComputedStyle(document.getElementById('side-scroll')!).display, boards: getComputedStyle(document.getElementById('boards')!).display, save: getComputedStyle(document.getElementById('save')!).display,
      }));
      expect(await state()).toEqual({ folded: 'true', expanded: 'false', words: "▸ Show Timmy's lists", lists: 'none', boards: 'none', save: 'flex' });
      await page.click('#side-fold');
      expect(await state()).toMatchObject({ folded: 'false', expanded: 'true', words: '▾ Fold', save: 'flex' });
      expect((await state()).lists).not.toBe('none');
      // open, the lists reach their rows (a Place button is under nothing), and the panel still ends above tldraw's toolbar
      // a narrow window starts with the Project list closed (R4): a person opens it
      if (!(await page.$eval('#project', (d) => (d as HTMLDetailsElement).open))) await page.click('#project > summary');
      // (brought to the region's middle, and read in the same step: at its top edge the list's own heading, which stays there as
      // the list scrolls, is over it; and the list may be drawn again between two steps)
      const open = await page.evaluate(() => {
        const b0 = document.querySelector('#project-groups li.pcard .pcard-place')!;
        b0.scrollIntoView({ block: 'center' });
        const b = b0.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const side = document.getElementById('side')!.getBoundingClientRect();
        const bar = document.querySelector('.tlui-main-toolbar__inner')!.getBoundingClientRect();
        return { reach: !!hit && !!hit.closest('.pcard-place'), clear: !(side.left < bar.right && bar.left < side.right && side.top < bar.bottom && bar.top < side.bottom) };
      });
      expect(open).toEqual({ reach: true, clear: true });
      // a resize does not take back the person's choice
      await page.setViewportSize({ width: 820, height: 600 });
      await page.waitForTimeout(200);
      expect((await state()).folded).toBe('false');
      await page.click('#side-fold');
      expect(await state()).toMatchObject({ folded: 'true', lists: 'none' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('below 1100 px tldraw\'s style panel folds while the board is idle and shows, with its own swatches, while there is something to style (a tool that draws, or shapes selected); at 1440 px it is always shown', async () => {
    const swatches = (page: Page) => page.$$eval('.tlui-style-panel__wrapper [data-testid^="style.color."]', (b) => b.length);
    for (const size of [{ width: 800, height: 600 }, { width: 1440, height: 900 }]) {
      const { page, context, errors } = await open(size);
      const where = `${size.width}x${size.height}`;
      try {
        const small = size.width < 1100;
        expect(await page.locator('.tlui-style-panel__wrapper').count(), `${where}: idle`).toBe(small ? 0 : 1);
        await page.click('[data-testid="tools.draw"]');
        await page.waitForSelector('.tlui-style-panel__wrapper', { timeout: 5_000 });
        // its swatches are tldraw's own (the board's content colours), as many as tldraw offers
        expect(await swatches(page), where).toBeGreaterThanOrEqual(12);
        await page.click('[data-testid="tools.select"]');
        if (small) await page.waitForSelector('.tlui-style-panel__wrapper', { state: 'detached', timeout: 5_000 });
        // a shape selected: shown again, for that shape
        await page.evaluate(() => {
          const e = (window as never as { timmyCanvas: { editor: { createShape: (s: unknown) => void; getCurrentPageShapes: () => Array<{ id: string }>; select: (...ids: string[]) => void } } }).timmyCanvas.editor;
          e.createShape({ type: 'geo', x: 4000, y: 4000, props: { w: 60, h: 40 } });
          const all = e.getCurrentPageShapes();
          e.select(all[all.length - 1].id);
        });
        await page.waitForSelector('.tlui-style-panel__wrapper', { timeout: 5_000 });
        expect(errors, where).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  it('the unfinished tabs (6, 7, 8 and 0) carry a mark that is not colour alone, and the strip\'s own description says, in the frame\'s words, what works on each now and what does not yet', async () => {
    for (const size of [{ width: 1440, height: 900 }, { width: 800, height: 600 }]) {
      const { page, context, errors } = await open(size);
      const where = `${size.width}x${size.height}`;
      try {
        const marks = await page.$$eval('#frame-tabs li', (ls) => ls.map((l) => ({
          key: l.querySelector('.fr-key')?.textContent, mark: l.querySelector('.fr-unf-mark')?.textContent ?? null, described: l.getAttribute('aria-describedby'),
          style: getComputedStyle(l).borderTopStyle, color: getComputedStyle(l).color, title: l.getAttribute('title'),
        })));
        const unfinished = TABS.filter((t) => t.unfinished);
        expect(marks.filter((m) => m.mark).map((m) => m.key), where).toEqual(unfinished.map((t) => t.key));
        expect(marks.filter((m) => m.mark).every((m) => m.mark === '◌' && m.style === 'dashed' && m.color !== AMBER), where).toBe(true);
        // their colour is the other tabs' (structure and text colours only): the mark and the dashed edge say it, not a colour
        expect(new Set(marks.filter((m) => m.key !== '4').map((m) => m.color)).size, where).toBe(1);
        // the description: closed at first, its button says how many; open, every unfinished tab's words, as the frame gives them
        expect(await page.textContent('#frame-unf-toggle'), where).toBe('▸ ◌ 4 unfinished');
        expect(await page.isHidden('#frame-unf'), where).toBe(true);
        await page.click('#frame-unf-toggle');
        await page.waitForSelector('#frame-unf', { state: 'visible' });
        expect(await page.getAttribute('#frame-unf-toggle', 'aria-expanded'), where).toBe('true');
        const entries = await page.$$eval('#frame-unf li', (ls) => ls.map((l) => {
          const b = l.getBoundingClientRect();
          return { id: l.id, tab: l.querySelector('.fr-unf-tab')?.textContent, works: l.querySelector('.fr-unf-works')?.textContent, missing: l.querySelector('.fr-unf-missing')?.textContent,
            text: (l.textContent ?? '').replace(/\s+/g, ' ').trim(), inside: b.left >= 0 && b.right <= innerWidth + 0.5 && b.top >= 0 && b.bottom <= innerHeight, size: parseFloat(getComputedStyle(l).fontSize) };
        }));
        expect(entries.map((e) => [e.tab, e.works, e.missing]), where).toEqual(unfinished.map((t) => [`◌ ${t.key} ${t.label}`, t.unfinished!.works, t.unfinished!.missing]));
        expect(entries.map((e) => e.text), where).toEqual(unfinished.map((t) => `◌ ${t.key} ${t.label} unfinished. Works now: ${t.unfinished!.works}. Not yet: ${t.unfinished!.missing}.`));
        expect(entries.every((e) => e.inside && e.size >= 11), where).toBe(true);
        // each marked tab names its own entry (aria-describedby)
        expect(marks.filter((m) => m.mark).map((m) => m.described), where).toEqual(entries.map((e) => e.id));
        // the canvas starts under the opened strip; Escape in the strip closes the description, the focus back on its button
        await page.waitForFunction(() => Math.abs(document.getElementById('root')!.getBoundingClientRect().top - document.getElementById('frame')!.getBoundingClientRect().bottom) <= 1, null, { timeout: 5_000 });
        await shoot(page, `unfinished-tabs-${where}.png`);
        await page.focus('#frame-unf-toggle');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#frame-unf', { state: 'hidden' });
        expect(await page.evaluate(() => document.activeElement?.id), where).toBe('frame-unf-toggle');
        expect(errors, where).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);

  /** A screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind otherwise). */
  async function shoot(page: Page, name: string): Promise<void> {
    const shots = process.env.TIMMY_CANVAS_SHOTS;
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.evaluate(() => {
      const label = document.createElement('div');
      label.id = 'fake-shot-label';
      label.textContent = 'FAKE test data (tests/helpers/canvas-project.ts and this test), not a real project';
      label.setAttribute('style', 'position:fixed;right:8px;bottom:100px;z-index:2147483647;pointer-events:none;max-width:calc(100vw - 16px);box-sizing:border-box;'
        + 'padding:2px 6px;font:12px/16px ui-monospace,monospace;color:#F2EFE9;background:#070707;border:1px solid #444444;border-radius:4px');
      document.body.append(label);
    });
    try {
      await page.screenshot({ path: join(shots, name) });
    } finally {
      await page.evaluate(() => document.getElementById('fake-shot-label')?.remove());
    }
  }
});
