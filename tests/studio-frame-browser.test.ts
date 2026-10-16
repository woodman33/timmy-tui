/**
 * R5 (H133): Timmy Studio draws the shared workspace frame (src/contracts/workspace.ts; DESIGN.md §10 B10 "Layouts") as a strip
 * above tldraw, reopens a canvas with what it holds in view, and marks its panel's scroll edge. In a real headless Chromium at
 * 1400 x 900, against the real canvas server and the real bundle (built here into a temporary folder), with a project of many
 * cards (tests/helpers/canvas-project.ts and 24 more workflow documents). The frame comes from GET /api/workspace with the page's
 * session; the one observation of Studio it reads is a record this test writes (FAKE: no request was made to a Studio), so the
 * frame's next step can be seen to follow it. Skipped, saying so, where no Chromium is found.
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

  /** A page /canvas open opens (a fresh grant), once Timmy is connected and the strip has drawn the frame. */
  async function open(): Promise<{ page: Page; context: BrowserContext; errors: string[]; frames: () => number }> {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
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
      // compact: three rows of 20px
      expect(at.strip).toBeLessThanOrEqual(76);
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

      // a low window (800 x 600): the strip keeps to two rows, the actions and the activity side by side on the second, so the panel
      // keeps room for its lists; the ten tabs are all there (the row scrolls sideways), the next step starts in view, and the
      // canvas still starts under the strip
      await page.setViewportSize({ width: 800, height: 600 });
      await page.waitForFunction(() => document.getElementById('frame')!.getBoundingClientRect().height < 56);
      const low = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { strip: r('#frame').bottom, root: r('#root').top, acts: r('#frame-acts').top, activity: r('#frame-activity').top, tabs: document.querySelectorAll('#frame-tabs li').length,
          primary: r('#frame-acts li.is-primary').left, menu: r('[data-testid="main-menu.button"]').top, side: r('#side').top };
      });
      expect(low.tabs).toBe(10);
      expect(low.activity).toBe(low.acts);
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
});
