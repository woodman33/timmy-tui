/**
 * R5 (H133): Timmy Studio draws the shared workspace frame (src/contracts/workspace.ts; DESIGN.md §10 B10 "Layouts") as a strip
 * above tldraw (and keeps a frame it cannot read now as last read, saying so), reopens a canvas with what it holds in view, and
 * marks its panel's scroll edge. In a real headless Chromium at
 * 1400 x 900, against the real canvas server and the real bundle (built here into a temporary folder), with a project of many
 * cards (tests/helpers/canvas-project.ts and 24 more workflow documents). The frame comes from GET /api/workspace with the page's
 * session; the one observation of Studio it reads is a record this test writes (FAKE: no request was made to a Studio), so the
 * frame's next step can be seen to follow it. Skipped, saying so, where no Chromium is found.
 *
 * R5 (H137): the strip's actions whole on screen at 1440 x 900, 1376 x 768, 1280 x 720, 800 x 600 and 390 x 844 (never cut or
 * scrolled sideways); the activity's disclosure, with FAKE log entries and FAKE chat turns put into the frame the server sent (the
 * merge the companion makes); the panel between the strip and the window's foot. Screenshots go to TIMMY_CANVAS_SHOTS when it names
 * a folder.
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
if (!browserPath) console.warn('studio-frame-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HX = 'c'.repeat(32);
/** R5 (H137): the parts of the frame JSON a test edits (FAKE content: the log, the chat turns, the activity). */
type FrameJson = { log: unknown[]; chat?: { turns: unknown[] }; activity: Record<string, unknown> };
const AMBER = 'rgb(255, 176, 0)';
const GREENS = ['rgb(40, 254, 20)', 'rgb(0, 215, 0)'];
type Win = { timmyCanvas: { document: { revision: number; savedRevision: number }; editor: {
  getCurrentToolId: () => string; getCamera: () => { z: number }; getCurrentPageShapes: () => Array<{ id: string }>;
  getShapePageBounds: (id: string) => { minX: number; minY: number; maxX: number; maxY: number }; pageToScreen: (p: { x: number; y: number }) => { x: number; y: number };
  createShapes: (s: unknown[]) => void;
} } };

describe.skipIf(!browserPath)('Timmy Studio: the shared workspace frame above the canvas, the canvas reopened in view, the panel\'s scroll edge', () => {
  let p: CanvasProject;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-frame-');
    for (let i = 1; i <= 24; i++) p.write(`WF${String(i).padStart(2, '0')}.md`, `# Workflow number ${i}, with a title long enough to wrap in the panel\n\n\`\`\`bash [name:a]\necho ${i}\n\`\`\`\n`);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-frame-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-frame-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // the frame reads Timmy's settings: this file's own folder (tests/isolation-setup.ts), never the account's
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await nameProject(port, server.projectToken, { root: p.root, name: 'demo', holder: HX, jobs: p.jobs, receipts: p.store });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A page /canvas open opens (a fresh grant), once Timmy is connected and the strip has drawn the frame. R5 (H137): at a window of
   * `viewport`; `edit`, when given, changes each frame the server sends before the page reads it (FAKE content, said where used).
   */
  async function open(viewport = { width: 1400, height: 900 }, edit?: (frame: FrameJson) => void): Promise<{ page: Page; context: BrowserContext; errors: string[]; frames: () => number }> {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    if (edit) {
      await context.route('**/api/workspace', async (route) => {
        const r = await route.fetch();
        const j = await r.json() as { ok?: boolean; frame?: FrameJson };
        if (j.ok && j.frame) edit(j.frame);
        await route.fulfill({ response: r, json: j });
      });
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    let read = 0;
    page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/workspace') read += 1; });
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#frame-tabs li').length === 10, null, { timeout: 30_000 });
    return { page, context, errors, frames: () => read };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** A screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind otherwise). */
  const shoot = async (page: Page, name: string): Promise<void> => {
    const shots = process.env.TIMMY_CANVAS_SHOTS;
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, name) });
  };

  it('draws TIMMY · the project, the ten tabs with Studio active, Studio\'s actions with the frame\'s one primary in amber and each command to copy, and one activity line; green only where it is earned; two rows on a low window', async () => {
    const { page, context, errors, frames } = await open();
    try {
      expect(await text(page, '#frame-brand')).toBe('TIMMY · demo');
      const tabs = await page.$$eval('#frame-tabs li', (ls) => ls.map((l) => ({
        text: (l.textContent ?? '').replace(/\s+/g, ' ').trim(), current: l.getAttribute('aria-current'), title: l.getAttribute('title') ?? '',
        controls: l.querySelectorAll('a, button, [tabindex]').length, border: `${getComputedStyle(l).borderTopWidth} ${getComputedStyle(l).borderTopStyle} ${getComputedStyle(l).borderTopColor}`,
      })));
      expect(tabs.map((t) => t.text)).toEqual(TABS.map((t) => `${t.key} ${t.label}`));
      // 4 Studio is this page: a 1px amber border; the others are labels, never links (this page cannot hold the companion's token)
      expect(tabs.filter((t) => t.current === 'page').map((t) => t.text)).toEqual(['4 Studio']);
      expect(tabs.find((t) => t.current === 'page')!.border).toBe(`1px solid ${AMBER}`);
      expect(tabs.every((t) => t.controls === 0)).toBe(true);
      for (const t of tabs.filter((x) => x.current !== 'page')) expect(t.title).toMatch(/: c in the Workbench shows the companion$/);
      // the Studio tab's actions, as the frame gives them: nothing observed Studio yet, so its next step is to open it
      const acts = () => page.$$eval('#frame-acts li', (ls) => ls.map((l) => ({
        primary: l.classList.contains('is-primary'), label: l.querySelector('.fr-label')?.textContent ?? '', command: l.querySelector('code.fr-cmd')?.textContent ?? '',
        copy: l.querySelector('button.fr-copy')?.getAttribute('data-copy') ?? '', border: getComputedStyle(l).borderTopColor, color: getComputedStyle(l.querySelector('.fr-label')!).color,
      })));
      let shown = await acts();
      expect(shown.map((a) => a.command)).toEqual(['/studio', '/canvas', '/project new <name> --from <starter>', '/board']);
      expect(shown.every((a) => a.copy === a.command)).toBe(true);
      expect(shown.filter((a) => a.primary)).toEqual([expect.objectContaining({ label: 'Open Studio', command: '/studio', border: AMBER, color: AMBER })]);
      expect(shown.filter((a) => !a.primary).every((a) => a.border !== AMBER && a.color !== AMBER)).toBe(true);
      expect(await text(page, '#frame-activity')).toMatch(/^0 running · 0 waiting on you · Stop current: idle · newest: /);

      // redrawn only for a new revision: the same records give the same revision, and the strip is left as it was
      const revision = await page.getAttribute('#frame', 'data-revision');
      await page.evaluate(() => { (document.querySelector('#frame-tabs li') as HTMLElement & { kept?: boolean }).kept = true; });
      // two more readings came (the first is drawn, or not, before the second is asked: the strip reads one at a time)
      const before = frames();
      await expect.poll(frames, { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 2);
      expect(await page.getAttribute('#frame', 'data-revision')).toBe(revision);
      expect(await page.evaluate(() => (document.querySelector('#frame-tabs li') as HTMLElement & { kept?: boolean }).kept)).toBe(true);

      // Studio observed live (the FAKE check record): the frame's next step is now to have Timmy draw on it, and the strip follows
      writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date().toISOString(), detail: 'FAKE: written by the test' } } }, { TIMMY_HOME: home });
      await page.waitForFunction((r) => document.getElementById('frame')?.dataset.revision !== r, revision, { timeout: 20_000 });
      shown = await acts();
      expect(shown.filter((a) => a.primary)).toEqual([expect.objectContaining({ label: 'Ask Timmy to draw: /canvas open in the REPL, then ask', command: '/canvas open', border: AMBER })]);
      expect(await page.evaluate(() => (document.querySelector('#frame-tabs li') as HTMLElement & { kept?: boolean }).kept)).toBeUndefined();
      // a new revision that changes nothing the strip shows is read, and nothing is redrawn: a focused Copy button stays where
      // it is. R5 lead: the frame's time words change at most once a minute now (58ee2d5), so the check's age no longer makes a
      // new revision within the wait; the check's own words do (they are in the frame's connections, not in the strip)
      const live = await page.getAttribute('#frame', 'data-revision');
      await page.evaluate(() => { (document.querySelector('#frame-tabs li') as HTMLElement & { kept?: boolean }).kept = true; });
      writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { studio: { answer: 'accepted', at: new Date().toISOString(), detail: 'FAKE: written by the test, a second time' } } }, { TIMMY_HOME: home });
      await page.waitForFunction((r) => document.getElementById('frame')?.dataset.revision !== r, live, { timeout: 20_000 });
      expect(await page.evaluate(() => (document.querySelector('#frame-tabs li') as HTMLElement & { kept?: boolean }).kept)).toBe(true);
      expect(await page.getAttribute('#frame', 'data-stale')).toBe('false');

      // each command is there to copy: Copy puts it on the clipboard
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await page.click('#frame-acts li.is-primary button.fr-copy');
      await page.waitForFunction(() => document.querySelector('#frame-acts li.is-primary button.fr-copy')?.textContent === 'Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/canvas open');
      await shoot(page, 'frame-strip-1400x900.png');

      // green is earned: in the strip, only what the frame says is live (.is-live) or verified (.is-verified) may be green
      const green = await page.evaluate((greens) => [...document.querySelectorAll('#frame, #frame *')].flatMap((e) => {
        const s = getComputedStyle(e);
        const used = [s.color, s.backgroundColor, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor, s.outlineColor].filter((c) => greens.includes(c));
        return used.length && !e.closest('.is-live, .is-verified') ? [`${e.tagName}.${(e as HTMLElement).className}: ${used.join(', ')}`] : [];
      }), GREENS);
      expect(green).toEqual([]);

      // the strip ends where tldraw's box begins: it covers none of tldraw's menus, panels or toolbar
      const at = await page.evaluate(() => ({
        strip: document.getElementById('frame')!.getBoundingClientRect().bottom, root: document.getElementById('root')!.getBoundingClientRect().top,
        menu: document.querySelector('[data-testid="main-menu.button"]')!.getBoundingClientRect().top, side: document.getElementById('side')!.getBoundingClientRect().top,
      }));
      expect(Math.abs(at.root - at.strip)).toBeLessThanOrEqual(1);
      expect(at.menu).toBeGreaterThanOrEqual(at.strip);
      expect(at.side).toBeGreaterThanOrEqual(at.strip);
      // compact: rows of 20px (R5 H137: the actions take a second row at 1400 px rather than run past the edge)
      expect(at.strip).toBeLessThanOrEqual(100);
      // tldraw's toolbar and main menu still take a click (Playwright clicks only what nothing covers)
      await page.click('[data-testid="tools.draw"]');
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentToolId())).toBe('draw');
      await page.click('[data-testid="tools.select"]');
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentToolId())).toBe('select');
      await page.click('[data-testid="main-menu.button"]');
      await page.waitForSelector('.tlui-menu', { state: 'visible' });
      // and the menu opens over Timmy's panel, not under it: its Preferences row, which lies over the panel, takes the pointer
      await page.hover('[data-testid="main-menu-sub.preferences-button"]', { timeout: 5_000 });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // no number key is the strip's: tldraw keeps its keys, and Studio stays the tab this page is
      await page.mouse.click(900, 500);
      await page.keyboard.press('1');
      expect(await page.$eval('#frame-tabs li[aria-current="page"]', (l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim())).toBe('4 Studio');

      // a low window (800 x 600): R5 (H137) the actions wrap onto more rows (never past the edge), the commands shortened where two
      // can then share a row, so the strip stays short and the panel keeps room for its lists; the ten tabs are all there (that
      // row scrolls sideways), the next step is first, and the canvas still starts under the strip
      await page.setViewportSize({ width: 800, height: 600 });
      await page.waitForFunction(() => document.getElementById('frame')!.getBoundingClientRect().height < 130);
      const low = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const acts = document.getElementById('frame-acts')!;
        return { strip: r('#frame').bottom, root: r('#root').top, tabs: document.querySelectorAll('#frame-tabs li').length, sideways: acts.scrollWidth - acts.clientWidth,
          primary: r('#frame-acts li.is-primary').left, first: acts.firstElementChild === acts.querySelector('li.is-primary'), menu: r('[data-testid="main-menu.button"]').top, side: r('#side').top };
      });
      expect(low.tabs).toBe(10);
      expect(low.sideways).toBeLessThanOrEqual(0);
      expect(low.first).toBe(true);
      expect(low.primary).toBeGreaterThanOrEqual(0);
      expect(low.primary).toBeLessThan(40);
      expect(Math.abs(low.root - low.strip)).toBeLessThanOrEqual(1);
      expect(low.menu).toBeGreaterThanOrEqual(low.strip);
      expect(low.side).toBeGreaterThanOrEqual(low.strip);
      await shoot(page, 'frame-strip-800x600.png');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a canvas reopened by /canvas open shows what it holds: every shape inside the area beside the panel and under the strip, at 100 % or farther', async () => {
    const first = await open();
    try {
      const made = await first.page.evaluate(() => {
        const w = window as never as Win;
        const from = w.timmyCanvas.document.revision;
        w.timmyCanvas.editor.createShapes([
          { type: 'geo', x: -900, y: -650, props: { w: 220, h: 140 } },
          { type: 'geo', x: 1700, y: 1350, props: { w: 220, h: 140 } },
          { type: 'geo', x: 2600, y: -500, props: { w: 220, h: 140 } },
          { type: 'geo', x: 40, y: 60, props: { w: 160, h: 100 } },
        ]);
        return from;
      });
      // saved by the page's own save path before it closes
      await first.page.waitForFunction((from) => { const d = (window as never as Win).timmyCanvas.document; return d.revision > from && d.savedRevision === d.revision; }, made, { timeout: 20_000 });
      expect(first.errors).toEqual([]);
    } finally {
      await first.context.close();
    }
    const again = await open();
    try {
      const view = await again.page.evaluate(() => {
        const e = (window as never as Win).timmyCanvas.editor;
        const bar = document.querySelector('.tlui-main-toolbar')?.getBoundingClientRect();
        const shapes = e.getCurrentPageShapes().map((s) => {
          const b = e.getShapePageBounds(s.id);
          const a = e.pageToScreen({ x: b.minX, y: b.minY });
          const z = e.pageToScreen({ x: b.maxX, y: b.maxY });
          return { left: a.x, top: a.y, right: z.x, bottom: z.y };
        });
        return { panel: document.getElementById('side')!.getBoundingClientRect().right, top: document.getElementById('root')!.getBoundingClientRect().top, width: innerWidth, bottom: bar && bar.height > 0 ? bar.top : innerHeight, zoom: e.getCamera().z, shapes };
      });
      await shoot(again.page, 'frame-reopened-1400x900.png');
      expect(view.shapes.length).toBeGreaterThanOrEqual(4);
      expect(view.zoom).toBeLessThanOrEqual(1);
      for (const s of view.shapes) {
        expect(s.left).toBeGreaterThanOrEqual(view.panel);
        expect(s.top).toBeGreaterThanOrEqual(view.top);
        expect(s.right).toBeLessThanOrEqual(view.width);
        expect(s.bottom).toBeLessThanOrEqual(view.bottom);
      }
      expect(again.errors).toEqual([]);
    } finally {
      await again.context.close();
    }
  }, 120_000);

  it('the panel\'s list region shows its end: a thin scrollbar and a fade at the bottom edge while more is below, none at the end', async () => {
    const { page, context, errors } = await open();
    try {
      await page.waitForFunction(() => document.querySelectorAll('#project-groups li.pcard').length >= 20, null, { timeout: 15_000 });
      await page.waitForFunction(() => document.getElementById('side-scroll')?.dataset.more === 'below', null, { timeout: 10_000 });
      await shoot(page, 'frame-panel-edge-1400x900.png');
      const edge = await page.$eval('#side-scroll', (e) => { const s = getComputedStyle(e); return { mask: s.maskImage || s.getPropertyValue('-webkit-mask-image'), bar: s.scrollbarWidth }; });
      expect(edge.mask).toMatch(/linear-gradient/);
      expect(edge.bar).toBe('thin');
      await page.$eval('#side-scroll', (e) => { e.scrollTop = e.scrollHeight; });
      await page.waitForFunction(() => document.getElementById('side-scroll')?.dataset.more === 'none');
      expect(await page.$eval('#side-scroll', (e) => { const s = getComputedStyle(e); return s.maskImage || s.getPropertyValue('-webkit-mask-image'); })).toBe('none');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** demo named again (a test before may have named another project to the canvas) */
  const demo = (): Promise<unknown> => nameProject(port, server.projectToken, { root: p.root, name: 'demo', holder: HX, jobs: p.jobs, receipts: p.store });

  it('R5 (H137): at 1440 x 900, 1376 x 768, 1280 x 720, 800 x 600 and 390 x 844 every action is whole on screen, its number, label, command and Copy, none past the edge and none scrolled sideways; the one primary amber and first; a command shown shortened is copied whole, and is whole in its title and in Copy\'s name', async () => {
    await demo();
    const shortened: Record<string, string[]> = {};
    for (const [width, height] of [[1440, 900], [1376, 768], [1280, 720], [800, 600], [390, 844]] as const) {
      const { page, context, errors } = await open({ width, height });
      const where = `${width}x${height}`;
      try {
        const seen = await page.evaluate(() => {
          const vw = innerWidth;
          const vh = innerHeight;
          const inside = (b: DOMRect): boolean => b.width > 0 && b.height > 0 && b.left >= -0.5 && b.right <= vw + 0.5 && b.top >= -0.5 && b.bottom <= vh + 0.5;
          // nothing of it is hidden by an ancestor that clips (a scrolled or cut row) either
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
          const acts = document.getElementById('frame-acts')!;
          return {
            sideways: acts.scrollWidth - acts.clientWidth,
            first: acts.firstElementChild?.classList.contains('is-primary') ?? false,
            acts: [...acts.querySelectorAll('li')].map((li) => {
              const code = li.querySelector('code.fr-cmd') as HTMLElement;
              const copy = li.querySelector('button.fr-copy') as HTMLButtonElement;
              const parts = [li.querySelector('.fr-n')!, li.querySelector('.fr-label')!, code, copy];
              return {
                text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(), command: code.textContent ?? '', shortened: code.scrollWidth > code.clientWidth + 1,
                title: code.title, name: copy.getAttribute('aria-label'), copies: copy.dataset.copy, whole: parts.every((x) => inside(x.getBoundingClientRect()) && unclipped(x)),
                primary: li.classList.contains('is-primary'), border: getComputedStyle(li).borderTopColor, color: getComputedStyle(li.querySelector('.fr-label')!).color,
              };
            }),
          };
        });
        expect(seen.acts.length, where).toBe(4);
        expect(seen.sideways, where).toBeLessThanOrEqual(0);
        expect(seen.acts.filter((a) => !a.whole).map((a) => a.text), where).toEqual([]);
        expect(seen.first, where).toBe(true);
        expect(seen.acts.filter((a) => a.primary).map((a) => [a.border, a.color]), where).toEqual([[AMBER, AMBER]]);
        for (const a of seen.acts) {
          expect(a.title, where).toBe(a.command);
          expect(a.name, where).toBe(`Copy ${a.command}`);
          expect(a.copies, where).toBe(a.command);
        }
        shortened[where] = seen.acts.filter((a) => a.shortened).map((a) => a.command);
        await shoot(page, `studio-${where}.png`);
        expect(errors, where).toEqual([]);
      } finally {
        await context.close();
      }
    }
    // shortened only where the window is narrow (1000 px and less), the longest command first
    expect(shortened).toMatchObject({ '1440x900': [], '1376x768': [], '1280x720': [] });
    expect(shortened['800x600']).toEqual(['/project new <name> --from <starter>']);
    expect(shortened['390x844']).toContain('/project new <name> --from <starter>');
    // Copy copies the whole command where it is shown shortened
    const { page, context } = await open({ width: 390, height: 844 });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      const copy = '#frame-acts li:has(code.fr-cmd[title="/project new <name> --from <starter>"]) button.fr-copy';
      await page.click(copy);
      await page.waitForFunction((s) => document.querySelector(s)?.textContent === 'Copied', copy);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/project new <name> --from <starter>');
    } finally {
      await context.close();
    }
  }, 240_000);

  it('R5 (H137): the activity is a disclosure, collapsed at first and reached by the keyboard; open, it lists the frame\'s newest entries (its log and the project\'s sealed chat turns merged, the newest first, at most 8: time, tag, words), and its button or Escape closes it; a chat turn being answered is named on the line (FAKE log and turns in the frame)', async () => {
    await demo();
    const now = Date.now();
    const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
    // FAKE (written by this test into the frame the server sent): five log entries and five sealed turns, interleaved in time
    const log = [1, 2, 3, 4, 5].map((i) => ({ at: ago(i * 2), tag: 'job', words: `FAKE log entry ${i} (test)`, tone: i === 2 ? 'failure' : 'neutral', source: 'job jfake00' }));
    const turns = [1, 2, 3, 4, 5].map((i) => ({ receipt: `fa0000${i}0`, surface: i % 2 ? 'workbench' : 'repl', state: i === 1 ? 'failed' : 'answered', model: 'FAKE-model', at: ago(i * 2 - 1), operation: i === 3 ? 'o1234abcd' : null, route: 'openrouter', words: `FAKE turn ${i} (test)` }));
    const turnNow = 'a chat turn is being answered in the Workbench (since 12:00:00 UTC) [FAKE]';
    const { page, context, errors } = await open({ width: 1440, height: 900 }, (f) => {
      f.log = log;
      f.chat = { turns };
      f.activity.running = 1;
      f.activity.chatTurn = { surface: 'workbench', since: ago(0), words: turnNow };
    });
    try {
      await page.waitForFunction((w) => (document.getElementById('frame-activity')?.textContent ?? '').includes(w), turnNow, { timeout: 20_000 });
      // collapsed at first: the line names the turn being answered, and its newest is the merge's newest (a turn that failed, amber)
      expect(await page.getAttribute('#frame-activity-toggle', 'aria-expanded')).toBe('false');
      expect(await page.isHidden('#frame-log')).toBe(true);
      expect(await text(page, '#frame-activity')).toMatch(new RegExp(`^1 running · ▶ ${esc(turnNow)} · 0 waiting on you · .+ · newest: \\d\\d:\\d\\d:\\d\\d ✕ FAKE turn 1 \\(test\\)$`));
      expect(await page.$eval('#frame-activity .fr-log', (e) => getComputedStyle(e).color)).toBe(AMBER);
      const closed = await page.evaluate(() => ({ strip: document.getElementById('frame')!.getBoundingClientRect().bottom, side: document.getElementById('side')!.getBoundingClientRect() }));
      // the keyboard: Tab reaches its button, Enter opens it
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let i = 0; i < 30 && (await page.evaluate(() => document.activeElement?.id)) !== 'frame-activity-toggle'; i++) await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('frame-activity-toggle');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#frame-log', { state: 'visible' });
      expect(await page.getAttribute('#frame-activity-toggle', 'aria-expanded')).toBe('true');
      const entries = await page.$$eval('#frame-log li', (ls) => ls.map((l) => ({
        time: l.querySelector('time')?.textContent ?? '', tag: l.querySelector('.fr-tag')?.textContent ?? '', words: l.querySelector('.fr-words')?.textContent ?? '', op: l.querySelector('.fr-op')?.textContent ?? '',
      })));
      expect(entries.map((e) => e.words)).toEqual(['FAKE turn 1 (test)', 'FAKE log entry 1 (test)', 'FAKE turn 2 (test)', 'FAKE log entry 2 (test)', 'FAKE turn 3 (test)', 'FAKE log entry 3 (test)', 'FAKE turn 4 (test)', 'FAKE log entry 4 (test)']);
      expect(entries.map((e) => e.tag)).toEqual(['✕ [chat]', '[job]', '[chat]', '✕ [job]', '[chat]', '[job]', '[chat]', '[job]']);
      expect(entries.every((e) => /^\d\d:\d\d:\d\d$/.test(e.time))).toBe(true);
      expect(entries[4].op).toBe('o1234abcd');
      // open, the strip is taller: the canvas and the panel start under it, and the panel's foot stays where it was
      const opened = await page.evaluate(() => ({ strip: document.getElementById('frame')!.getBoundingClientRect().bottom, root: document.getElementById('root')!.getBoundingClientRect().top, side: document.getElementById('side')!.getBoundingClientRect() }));
      expect(opened.strip).toBeGreaterThan(closed.strip);
      expect(Math.abs(opened.root - opened.strip)).toBeLessThanOrEqual(1);
      expect(Math.abs((opened.side.top - closed.side.top) - (opened.strip - closed.strip))).toBeLessThanOrEqual(1);
      expect(Math.abs(opened.side.bottom - closed.side.bottom)).toBeLessThanOrEqual(1);
      await shoot(page, 'studio-1440x900-activity-open.png');
      // Escape closes it while the focus is in the strip, the focus back on its button
      await page.keyboard.press('Escape');
      await page.waitForSelector('#frame-log', { state: 'hidden' });
      expect(await page.getAttribute('#frame-activity-toggle', 'aria-expanded')).toBe('false');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('frame-activity-toggle');
      // its button opens and closes it too
      await page.click('#frame-activity-toggle');
      await page.waitForSelector('#frame-log', { state: 'visible' });
      await page.click('#frame-activity-toggle');
      await page.waitForSelector('#frame-log', { state: 'hidden' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('R5 (H137): the panel fits between the strip and the window\'s foot: 52 px under the strip (its height taken off once), and 8 px above what of tldraw\'s bottom is under it (on a wide window its navigation panel, not 116 px above the foot as before; on a narrow one its toolbar); its list scrolls inside, with the scroll edge', async () => {
    await demo();
    for (const [width, height] of [[1440, 900], [1376, 768], [800, 600], [390, 844]] as const) {
      const { page, context, errors } = await open({ width, height });
      const where = `${width}x${height}`;
      try {
        await page.waitForFunction(() => document.querySelectorAll('#project-groups li.pcard').length >= 20, null, { timeout: 15_000 });
        // a narrow window starts with the lists folded: a person opens them
        await page.evaluate(() => { for (const id of ['jobs', 'project']) (document.getElementById(id) as HTMLDetailsElement).open = true; });
        const read = () => page.evaluate(() => {
          const side = document.getElementById('side')!.getBoundingClientRect();
          const under = [...document.querySelectorAll('.tlui-navigation-panel, .tlui-minimap, .tlui-main-toolbar__inner, .tlui-help-menu')].map((e) => e.getBoundingClientRect())
            .filter((b) => b.width > 0 && b.height > 0 && b.right > side.left && b.left < side.right);
          const region = document.getElementById('side-scroll')!;
          return {
            top: side.top, bottom: side.bottom, strip: document.getElementById('frame')!.getBoundingClientRect().bottom, foot: under.length ? Math.min(...under.map((b) => b.top)) : innerHeight,
            overflows: region.scrollHeight > region.clientHeight + 1, more: region.dataset.more, scrolls: document.getElementById('side')!.scrollHeight <= document.getElementById('side')!.clientHeight + 1,
          };
        });
        // the panel follows tldraw's layout (it is measured as tldraw lays out): waited for
        await expect.poll(async () => { const g = await read(); return g.foot - g.bottom; }, { timeout: 10_000 }).toBeGreaterThanOrEqual(7);
        const g = await read();
        expect(g.foot - g.bottom, where).toBeLessThanOrEqual(9);
        expect(Math.abs(g.top - g.strip - 52), where).toBeLessThanOrEqual(1);
        if (width >= 1376) expect(g.bottom, `${where}: lower than the 116 px it kept free before`).toBeGreaterThan(height - 116 + 30);
        expect(g.overflows, where).toBe(true);
        expect(g.more, where).toBe('below');
        expect(g.scrolls, `${where}: the panel itself never scrolls`).toBe(true);
        // New board's controls are whole, inside the panel, and nothing of tldraw covers them
        const reach = await page.evaluate(() => ['label[for="board-pick"]', '#board-pick', '#board-open'].map((s) => {
          const b = document.querySelector(s)!.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!hit && (hit === document.querySelector(s) || document.querySelector(s)!.contains(hit));
        }));
        expect(reach, where).toEqual([true, true, true]);
        if (width === 1440) await shoot(page, 'studio-panel-1440x900.png');
        expect(errors, where).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 240_000);

  it('a frame not read now stays as last read, and says why and when: another REPL named another project to the canvas', async () => {
    const { page, context, errors } = await open();
    try {
      await page.waitForFunction(() => document.getElementById('frame')?.dataset.stale === 'false');
      // this page's session was given for demo; another project named now (by another REPL) is not this page's to read
      const other = join(p.base, 'other-project');
      mkdirSync(other, { recursive: true });
      await nameProject(port, server.projectToken, { root: other, name: 'beta', holder: 'd'.repeat(32) });
      await page.waitForFunction(() => document.getElementById('frame')?.dataset.stale === 'true', null, { timeout: 20_000 });
      expect(await text(page, '#frame-note')).toMatch(/^· Workspace not read now: Refused: this canvas page's session was given for another project than the one the canvas shows now\. .* Shown as last read at \d\d:\d\d:\d\d\.$/);
      // the last frame stays drawn: demo's, and nothing of the project named now
      expect(await text(page, '#frame-brand')).toBe('TIMMY · demo');
      expect(await page.$$eval('#frame-tabs li', (ls) => ls.length)).toBe(10);
      const strip = await page.$eval('#frame', (e) => e.outerHTML);
      expect(strip).not.toContain('beta');
      expect(strip).not.toContain(other);
      // R5 (H137): the page's own readings of a session paused this way are answered with a plain 200 that says why (it had been a
      // 401, which Chromium logs as a console error): nothing went wrong, and nothing was logged
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
