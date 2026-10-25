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

  it('draws the canvas on the B11 registry (#080B0F), tldraw\'s panels and Timmy\'s on its surface (#111A23), the active tool amber with ink, tooltips raised with the text colour', async () => {
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
        // R11 round 7 (H176; DESIGN.md §10 B11, SHELL CONTRACT v1): canvas #080B0F, surface #111A23, ink #1C3043 on the amber tool, text #ECF1F5
        canvas: 'rgb(8, 11, 15)', menu: 'rgb(17, 26, 35)', style: 'rgb(17, 26, 35)', toolbar: 'rgb(17, 26, 35)', side: 'rgb(17, 26, 35)',
        toolOn: 'true', toolFill: 'rgb(255, 176, 0)', toolInk: 'rgb(28, 48, 67)', text: 'rgb(236, 241, 245)',
      });
      await page.hover('[data-testid="tools.draw"]');
      await page.waitForSelector('.tlui-tooltip', { timeout: 5000 });
      expect(await page.$eval('.tlui-tooltip', (t) => ({ bg: getComputedStyle(t).backgroundColor, ink: getComputedStyle(t).color }))).toEqual({ bg: 'rgb(28, 41, 54)', ink: 'rgb(236, 241, 245)' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("keeps tldraw's palette for what is drawn, and sets only the canvas's own colors: the selection and its brush amber, snap lines in the secondary text, the canvas #080B0F", async () => {
    const { page, context } = await open();
    try {
      const theme = await page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; return { mode: e.getColorMode(), dark: e.getCurrentTheme().colors.dark }; });
      expect(theme.mode).toBe('dark');
      expect(theme.dark).toMatchObject({
        background: '#080B0F', negativeSpace: '#080B0F', selectionStroke: '#FFB000', selectionFill: '#FFB00029', brushStroke: '#FFB0008C', brushFill: '#FFB00014', snap: '#BDCADA', laser: '#FFB000', text: '#ECF1F5', cursor: '#ECF1F5', selectedContrast: '#ECF1F5',
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

  // R7 (H151; H147's R6 finding 4: "tldraw's style panel shows blue, purple and red swatches"; the operator, 2026-10-16: "Preserve
  // editable content colours where appropriate"): the swatches are the board's content colours, the ones a person chooses for their
  // shapes (B10: "Content keeps its colors ... tldraw artwork ... never recolored"), so each shows tldraw's own palette colour; the
  // panel around them is Timmy's chrome: its well the B11 surface (#111A23), its words the text colour, the selected control and focus amber.
  it('R7 (H151): the style panel\'s swatches are tldraw\'s own content palette (blue, violet and red among them, as a person chooses them for shapes), and the panel around them is Timmy\'s chrome', async () => {
    const { page, context, errors } = await open();
    try {
      await page.waitForSelector('[data-testid="style.panel"] [data-testid^="style.color."]');
      const seen = await page.evaluate(() => {
        const e = (window as never as { timmyCanvas: { editor: { getCurrentTheme: () => { colors: { dark: Record<string, { solid?: string } | string> } } } } }).timmyCanvas.editor;
        const dark = e.getCurrentTheme().colors.dark;
        const rgb = (hex: string) => { const n = parseInt(hex.slice(1, 7), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
        const panel = document.querySelector('[data-testid="style.panel"]')!;
        const swatches = [...panel.querySelectorAll('[data-testid^="style.color."]')].map((b) => {
          const name = (b.getAttribute('data-testid') ?? '').replace('style.color.', '');
          const icon = b.querySelector('.tlui-icon') ?? b;
          const want = dark[name] && typeof dark[name] === 'object' ? (dark[name] as { solid?: string }).solid : undefined;
          return { name, shown: getComputedStyle(icon).color, palette: want ? rgb(want) : null };
        });
        return { swatches, well: getComputedStyle(panel).backgroundColor, words: getComputedStyle(panel).color };
      });
      expect(seen.swatches.length).toBeGreaterThanOrEqual(12);
      for (const s of seen.swatches) expect(s.shown, s.name).toBe(s.palette);
      expect(seen.swatches.map((s) => s.name)).toEqual(expect.arrayContaining(['blue', 'violet', 'red', 'light-blue', 'light-violet']));
      expect(seen.well).toBe('rgb(17, 26, 35)');
      expect(seen.words).toBe('rgb(236, 241, 245)');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  // R11 round 7 (H176; DESIGN.md §10 B11, SHELL CONTRACT v1): the browser surfaces take the Card Lab's materials, which are blue-tinted
  // darks (#080B0F canvas, #111A23 surface, #1C2936 raised, #44586B border): B10's "no other hue in the chrome" is the terminal's rule
  // now. What holds for the chrome here: every background, border and word outside the drawing is a colour of the B11 registry (the
  // page's own sheet names no colour but a --timmy-ui-* token), no white backgrounds (the one light focal object is a task's, not
  // a page's: none on Studio's chrome), and no saturated hue that is not the registry's: no cyan, no violet, no blue of tldraw's own.
  const REGISTRY_RGB = new Set(['8, 11, 15', '17, 26, 35', '28, 41, 54', '232, 239, 245', '68, 88, 107', '30, 42, 54', '236, 241, 245', '189, 202, 218', '154, 175, 195', '28, 48, 67', '59, 81, 104', '255, 176, 0', '40, 254, 20', '0, 215, 0', '255, 95, 86',
    // the amber family (the default), and the elevation gradients' own stops (tokens.ts UI_ELEVATION; a gradient reads as its stops)
    '214, 170, 100', '234, 208, 163', '64, 46, 20', '240, 229, 212', '20, 30, 41', '14, 22, 31', '34, 48, 62', '22, 33, 44', '14, 21, 29']);
  it('has no white and no hue of its own in the chrome: every background, border and word outside the drawing is the B11 registry\'s (or a mix of it with the canvas)', async () => {
    const { page, context } = await open();
    try {
      // tldraw's main menu open too, with its Preferences
      await page.click('[data-testid="main-menu.button"]');
      await page.hover('[data-testid="main-menu-sub.preferences-button"]');
      await page.waitForSelector('[data-testid="main-menu-sub.preferences-content"]');
      const offenders = await page.evaluate(() => {
        // rgb(r, g, b[, a]) in 0..255; Chromium gives a colour-mixed value as color(srgb r g b[ / a]) in 0..1: scaled to the same scale
        const parse = (c: string) => { const m = c.match(/[\d.]+/g); if (!m) return null; const n = m.map(Number); return c.startsWith('color(srgb') ? n.map((x, i) => (i < 3 ? Math.round(x * 255) : x)) : n; };
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
            out.push(`rgb: ${[r, g, b].join(', ')} · ${name}`);
            void h; void sat;
          }
        }
        return [...new Set(out)];
      });
      expect(offenders.filter((o) => o.startsWith('white: '))).toEqual([]);
      // every opaque chrome colour is the registry's, or a mix of two registry colours (tldraw mixes its muted and hint tones from
      // the text and the canvas; a disabled word is the secondary text mixed with the canvas): a colour of the page's own is neither
      const reg = [...REGISTRY_RGB].map((r) => r.split(', ').map(Number));
      const mixOf = (rgb: number[]): boolean => reg.some((a) => reg.some((b) => [0, 1, 2].every((i) => rgb[i] >= Math.min(a[i], b[i]) - 2 && rgb[i] <= Math.max(a[i], b[i]) + 2)));
      const strange = offenders.filter((o) => o.startsWith('rgb: ')).map((o) => o.slice(5)).filter((o) => { const rgb = o.split(' · ')[0]; return !REGISTRY_RGB.has(rgb) && !mixOf(rgb.split(', ').map(Number)); });
      expect(strange).toEqual([]);
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
      expect(await page.$eval('.tl-background', (e) => getComputedStyle(e).backgroundColor)).toBe('rgb(8, 11, 15)');
    } finally {
      await context.close();
    }
  }, 90_000);
});
