import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio, rgbToHex } from '../src/term/color.js';
import { startStudioServer } from '../src/studio/server.js';

// Fourth order, step 5, the acceptance pass: Timmy Canvas in a real browser, against the real
// server and the real bundle. Every request goes to 127.0.0.1; Timmy's own panel stays on screen and
// clear of tldraw's menus at desktop, tablet and phone sizes; it works from the keyboard; its own text
// clears 4.5:1; and it says when it is loading or cannot start. Skipped, saying so, where no Chromium
// or Chrome is found (a GitHub runner has Chrome at /usr/bin/google-chrome).
const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-canvas-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const hex = (css: string): string => {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return rgbToHex([r, g, b]);
};

describe.skipIf(!browserPath)('Timmy Canvas in a real browser', () => {
  let root = '';
  let home = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let base = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-canvas-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function open(size = { width: 1280, height: 800 }, wait = /Timmy connected/): Promise<{ page: Page; context: BrowserContext; origins: Set<string>; errors: string[] }> {
    const context = await browser!.newContext({ viewport: size });
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('status')?.textContent ?? ''), wait.source, { timeout: 30_000 });
    return { page, context, origins, errors };
  }

  it('loads nothing from any host but 127.0.0.1, and says it is ready, saved', async () => {
    const { page, context, origins, errors } = await open();
    expect([...origins]).toEqual([base]);
    expect(await page.textContent('#status')).toMatch(/^Canvas ready · tldraw 5\.5\.2 · .+ · Timmy connected · revision 0, saved$/);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it("keeps its panel on screen and clear of tldraw's menu, style panel and toolbar at desktop, tablet and phone sizes, its text unclipped", async () => {
    for (const size of [{ width: 1280, height: 800 }, { width: 768, height: 600 }, { width: 390, height: 740 }]) {
      const { page, context } = await open(size);
      // A long page name widens tldraw's menu: it must not run under Timmy's panel.
      await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { renamePage: (id: string, n: string) => void; getCurrentPageId: () => string } } }).timmyCanvas.editor; e.renamePage(e.getCurrentPageId(), 'A page with a rather long name for the menu'); });
      await page.waitForTimeout(300);
      // Timmy's own elements: the status and the panel. tldraw's zones present at this size (no waiting for absent ones).
      const zones: Array<[string, Box]> = [];
      for (const zone of ['.tlui-menu-zone', '.tlui-style-panel__wrapper', '.tlui-main-toolbar', '.tlui-navigation-panel']) {
        const box = await (await page.$(zone))?.boundingBox();
        if (box) zones.push([zone, box]);
      }
      expect(zones.length, `tldraw zones found at ${size.width}`).toBeGreaterThanOrEqual(2);
      for (const own of ['#status', '#side']) {
        const box = (await (await page.$(own))!.boundingBox())!;
        expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height, `${own} inside ${size.width}x${size.height}`).toBe(true);
        for (const [zone, other] of zones) expect(overlaps(box, other), `${own} over ${zone} at ${size.width}x${size.height}`).toBe(false);
      }
      expect(await page.$eval('#status', (el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await context.close();
    }
  }, 120_000);

  it('works from the keyboard: the jobs fold, a template opens, and tldraw takes its own keys', async () => {
    const { page, context } = await open();
    await page.focus('#jobs > summary');
    await page.keyboard.press('Enter');
    expect(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.keyboard.press('Enter');
    expect(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open)).toBe(true);
    await page.focus('#board-pick');
    await page.keyboard.press('ArrowDown'); // the first template, after "Blank board"
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-open');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { getCurrentPage: () => { name: string }; getCurrentPageShapes: () => Array<{ type: string }> } } }).timmyCanvas.editor; return { page: e.getCurrentPage().name, frames: e.getCurrentPageShapes().filter((s) => s.type === 'frame').length }; });
    expect(board).toEqual({ page: 'Prompt Lab', frames: 4 });
    // tldraw's own keys, once the canvas has focus: r picks the rectangle (geo) tool, Escape goes back.
    await page.mouse.click(700, 500);
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('geo');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('select');
    await context.close();
  }, 60_000);

  it("its own text clears 4.5:1 on what is behind it: the panel, the job marks, links, controls, the guide", async () => {
    const { page, context } = await open();
    const pairs = await page.evaluate(() => {
      const bgOf = (el: Element | null): string => {
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)) return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const canvasBg = getComputedStyle(document.querySelector('.tl-background') ?? document.body).backgroundColor;
      const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = '✓ done';
      const bad = document.createElement('span'); bad.className = 'bad'; bad.textContent = '✖ failed';
      const link = document.createElement('a'); link.href = '#'; link.textContent = 'receipt';
      const list = document.getElementById('job-list')!;
      list.append(ok, bad, link);
      const els: Array<[string, Element, string?]> = [['status', document.getElementById('status')!], ['jobs', document.querySelector('#jobs summary')!], ['done', ok], ['failed', bad], ['link', link],
        ['label', document.querySelector('label[for="board-pick"]')!], ['select', document.getElementById('board-pick')!], ['button', document.getElementById('board-open')!], ['guide', document.getElementById('guide')!, canvasBg]];
      return els.map(([name, el, behind]) => ({ name, fg: getComputedStyle(el).color, bg: behind ?? bgOf(el) }));
    });
    const low = pairs.map((p) => ({ ...p, ratio: contrastRatio(hex(p.fg), hex(p.bg)) })).filter((p) => p.ratio < 4.5);
    expect(low).toEqual([]);
    await context.close();
  }, 60_000);

  it('says it is loading while it loads, and why it cannot start when it cannot', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/studio-config.json', async (route) => { await held; await route.continue(); });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => /^Loading the canvas/.test(document.getElementById('status')?.textContent ?? ''));
    expect(await page.getAttribute('#status', 'data-kind')).toBe('loading');
    release();
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    // A bundle built from another tldraw than the one Timmy pins: it says so, and how to rebuild.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.fulfill({ json: { licenseKey: null, tldrawVersion: '9.9.9' } }));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toBe('The canvas could not start: this canvas was built with tldraw 5.5.2, but Timmy pins 9.9.9. Rebuild it: npm run build:canvas');
    // Timmy not answering at all.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.abort());
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toMatch(/^The canvas could not start: /);
    await context.close();
  }, 60_000);
});
