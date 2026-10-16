/**
 * R5 (H133): Timmy Canvas's chrome on Timmy's palette in a real browser (DESIGN.md §10 B10, the operator's order of 2026-10-15:
 * "pure black canvas, #070707 panels, off-white text, amber focus and selection, no white/cyan/blue/violet chrome"; "Imported
 * images, videos, reference artwork and scientifically meaningful data colors retain their content"). tldraw's palette for what
 * is drawn stays tldraw's; the color scheme stays dark. The real server and bundle; skipped where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-theme-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Theme = { colors: { dark: Record<string, unknown>; light: Record<string, unknown> } };
type Win = { timmyCanvas: { editor: { getCurrentTheme: () => Theme; getColorMode: () => string; user: { getIsDarkMode: () => boolean } } } };

describe.skipIf(!browserPath)("Timmy Canvas's chrome on B10, in a real browser", () => {
  let root = '';
  let home = '';
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  const port = (): number => (server!.address() as AddressInfo).port;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-theme-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-theme-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root });
    base = `http://127.0.0.1:${port()}`;
    mkdirSync(join(home, 'project'));
    await nameProject(port(), server.projectToken, { root: join(home, 'project'), name: 'theme-browser' });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  async function open(colorScheme: 'light' | 'dark' = 'dark'): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 }, colorScheme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }

  it('draws the canvas black, tldraw\'s panels and Timmy\'s in #070707 wells, the active tool amber with black ink, tooltips dark with off-white words', async () => {
    const { page, context, errors } = await open();
    try {
      const seen = await page.evaluate(() => {
        const bg = (sel: string) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
        const tool = document.querySelector('[data-testid="tools.select"]')!;
        return {
          canvas: bg('.tl-background'), menu: bg('.tlui-menu-zone'), style: bg('[data-testid="style.panel"]'), toolbar: bg('.tlui-main-toolbar__tools'), side: bg('#side'),
          toolOn: tool.getAttribute('aria-pressed') ?? tool.getAttribute('data-state'), toolFill: getComputedStyle(tool, '::after').backgroundColor, toolInk: getComputedStyle(tool).color,
          text: getComputedStyle(document.querySelector('.tl-container')!).color,
        };
      });
      expect(seen).toEqual({
        canvas: 'rgb(0, 0, 0)', menu: 'rgb(7, 7, 7)', style: 'rgb(7, 7, 7)', toolbar: 'rgb(7, 7, 7)', side: 'rgb(7, 7, 7)',
        toolOn: 'true', toolFill: 'rgb(255, 176, 0)', toolInk: 'rgb(0, 0, 0)', text: 'rgb(242, 239, 233)',
      });
      await page.hover('[data-testid="tools.draw"]');
      await page.waitForSelector('.tlui-tooltip', { timeout: 5000 });
      expect(await page.$eval('.tlui-tooltip', (t) => ({ bg: getComputedStyle(t).backgroundColor, ink: getComputedStyle(t).color }))).toEqual({ bg: 'rgb(51, 51, 51)', ink: 'rgb(242, 239, 233)' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("keeps tldraw's palette for what is drawn, and sets only the canvas's own colors: the selection and its brush amber, snap lines silver, the canvas black", async () => {
    const { page, context } = await open();
    try {
      const theme = await page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; return { mode: e.getColorMode(), dark: e.getCurrentTheme().colors.dark }; });
      expect(theme.mode).toBe('dark');
      expect(theme.dark).toMatchObject({
        background: '#000000', negativeSpace: '#000000', selectionStroke: '#FFB000', selectionFill: '#FFB00029', brushStroke: '#FFB0008C', brushFill: '#FFB00014', snap: '#E8E4D9', laser: '#FFB000', text: '#F2EFE9', cursor: '#F2EFE9', selectedContrast: '#F2EFE9',
        // tldraw 5.5.2's own values for what is drawn, unchanged
        solid: '#010403', noteBorder: 'rgb(20, 20, 20)',
        black: expect.objectContaining({ solid: '#f2f2f2', noteFill: '#2c2c2c', frameFill: '#0c0c0c' }),
        blue: expect.objectContaining({ solid: '#4f72fc' }),
        green: expect.objectContaining({ solid: '#099268' }),
      });
    } finally {
      await context.close();
    }
  }, 90_000);

  it('has no white, cyan, blue or violet chrome: every background, border and word outside the drawing and the palette\'s swatches', async () => {
    const { page, context } = await open();
    try {
      // tldraw's main menu open too, with its Preferences
      await page.click('[data-testid="main-menu.button"]');
      await page.hover('[data-testid="main-menu-sub.preferences-button"]');
      await page.waitForSelector('[data-testid="main-menu-sub.preferences-content"]');
      const offenders = await page.evaluate(() => {
        const parse = (c: string) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : null; };
        const hueOf = ([r, g, b]: number[]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return { h: 0, s: 0 }; const d = mx - mn; const s = d / mx; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; return { h, s }; };
        const out: string[] = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('.tl-shapes, .tl-html-layer, [data-testid^="style.color."], .tl-watermark_SEE-LICENSE, [class*="watermark"]')) continue;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          // tldraw draws an icon as its ink (the text color) through a mask: its "background" is a glyph's ink, not a background
          const glyph = (s.maskImage && s.maskImage !== 'none') || ((s as unknown as { webkitMaskImage?: string }).webkitMaskImage ?? 'none') !== 'none';
          for (const [prop, value] of [[glyph ? 'text' : 'background', s.backgroundColor], ['border', s.borderTopColor], ['text', s.color]] as const) {
            const v = parse(value);
            if (!v || (v.length > 3 && v[3] < 0.35)) continue;
            if (prop === 'border' && s.borderTopStyle === 'none') continue;
            const [r, g, b] = v;
            const { h, s: sat } = hueOf([r, g, b]);
            const name = `${(el.getAttribute('data-testid') || el.id || el.className || el.tagName).toString().slice(0, 50)} ${prop} ${value}`;
            if (prop === 'background' && r > 200 && g > 200 && b > 200) out.push(`white: ${name}`);
            if (sat > 0.3 && h >= 170 && h <= 300) out.push(`cyan/blue/violet: ${name}`);
          }
        }
        return [...new Set(out)];
      });
      expect(offenders).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('stays dark: tldraw\'s menu offers no color scheme, its shortcut changes nothing, and a light system preference changes nothing', async () => {
    const { page, context } = await open('light');
    try {
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.user.getIsDarkMode())).toBe(true);
      await page.click('[data-testid="main-menu.button"]');
      await page.hover('[data-testid="main-menu-sub.preferences-button"]');
      await page.waitForSelector('[data-testid="main-menu-sub.preferences-content"]');
      const items = await page.locator('[data-testid="main-menu-sub.preferences-content"]').innerText();
      expect(items).toMatch(/Accessibility/);
      expect(items).not.toMatch(/\bTheme\b|\bDark\b|\bLight\b|Dark mode/);
      expect(await page.locator('[data-testid*="color-scheme"]').count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.mouse.click(700, 450);
      await page.keyboard.press('Control+/');
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getColorMode())).toBe('dark');
      expect(await page.$eval('.tl-background', (e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
    } finally {
      await context.close();
    }
  }, 90_000);
});
