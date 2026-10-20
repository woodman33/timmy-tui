/**
 * Round R1, gap 5: the browser pages read Timmy's shared look from the server that shows them, and
 * Monaspace Argon is served from this machine, by exact name, when it is not installed.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fontDir, startStudioServer } from '../src/studio/server.js';
import { FONT_FILES, HOMEBREW } from '../src/theme/tokens.js';

let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const start = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-theme-'));
  dirs.push(dir);
  server = await startStudioServer(0, { env: {}, canvasDir: dir });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('the shared look on Timmy Canvas\'s server', () => {
  it('serves the theme as CSS', async () => {
    const res = await fetch(`${await start()}/timmy-theme.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/css/);
    const css = await res.text();
    expect(css).toContain(`--timmy-accent: ${HOMEBREW.accent};`);
    expect(css).toContain('font-family: "Monaspace Argon"');
  });
  it.skipIf(!fontDir())('serves each Monaspace Argon face it names, unmodified, and nothing else', async () => {
    const base = await start();
    for (const f of FONT_FILES) {
      const res = await fetch(`${base}/fonts/${f.file}`);
      expect(res.status, f.file).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      const body = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(body.slice(0, 4)).toString('latin1')).toBe('wOF2');
      expect(Buffer.compare(Buffer.from(body), readFileSync(join(fontDir()!, f.file)))).toBe(0);
    }
    for (const name of ['monaspace-argon-latin-200-normal.woff2', '..%2Fpackage.json', 'x.woff2']) {
      expect((await fetch(`${base}/fonts/${name}`)).status, name).toBe(404);
    }
  });
  it('the receipt page allows fonts from this server only, and uses the shared look', async () => {
    const { mountReceiptPages } = await import('../src/studio/receipt-page.js');
    const express = (await import('express')).default;
    const app = express();
    const rec = { hash: `sha256:${'a'.repeat(64)}`, prev_hash: 'genesis', ts: '2026-10-08T21:00:00Z', kind: 'turn', subject: 'repl · 1 step', status: 'ok', sig: 'x', pubkey: 'y' } as never;
    mountReceiptPages(app, { read: () => [rec], verify: () => ({ ok: true, count: 1 }) as never });
    const s = await new Promise<Server>((done) => { const x = app.listen(0, '127.0.0.1', () => done(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/receipts/aaaaaaaa`);
      expect(res.headers.get('content-security-policy')).toContain("font-src 'self'");
      const html = await res.text();
      expect(html).toContain('var(--timmy-font-mono)');
      expect(html).toContain(`--timmy-ground: ${HOMEBREW.ground};`);
    } finally {
      await new Promise<void>((done) => s.close(() => done()));
    }
  });
  it('the canvas page takes the shared look: every color a shared variable, its fallback the very value tokens.ts gives it (B10)', () => {
    const html = readFileSync('companion/studio-canvas/index.html', 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="/timmy-theme.css" />');
    // Every color in the page's own style is a shared variable (with its fallback), never a color of its own.
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    for (const hex of style.match(/#[0-9a-f]{6}\b/gi) ?? []) expect(style).toMatch(new RegExp(`var\\(--timmy-[a-z-]+, ${hex}\\)`));
    // R5 (H133): and each fallback is the B10 value of its own token (a stale B9 fallback had stayed: #28fe14 for the accent)
    const camel = (name: string) => name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    const fallbacks = [...style.matchAll(/var\(--timmy-([a-z-]+), (#[0-9a-f]{6})\)/gi)];
    expect(fallbacks.length).toBeGreaterThan(50);
    for (const [, name, hex] of fallbacks) expect(hex.toUpperCase(), `--timmy-${name}`).toBe((HOMEBREW as Record<string, string>)[camel(name)]?.toUpperCase());
    // no color by name, rgb() or hsl() of its own either (in its rules; its comments may name them)
    expect(style.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\b(rgba?|hsla?)\(|:\s*(white|red|blue|cyan|green|purple|violet)\b/i);
  });

  // R5 (H133), DESIGN.md §10 B10 (the operator's palette of 2026-10-15: "pure black canvas, #070707 panels, off-white text, amber
  // focus and selection, no white/cyan/blue/violet chrome"). This test had held the page off tldraw's variables altogether
  // (`not.toMatch(/--tl-/)`), which left tldraw's chrome blue and grey on white tooltips. tldraw 5.5.2 colors its chrome only
  // through its --tl-color-* variables (its Themes guide names --tl-color-background as the canvas's background), so the page now
  // sets them, and the test keeps its intent: no color of the page's own. Each --tl-color-* value is built only from --timmy-*
  // tokens (each with its B10 fallback), mixed with transparent or another token; nothing else of tldraw's is touched.
  it('sets tldraw\'s chrome variables, in one block for its dark theme, only from --timmy-* tokens (B10)', () => {
    const html = readFileSync('companion/studio-canvas/index.html', 'utf8');
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const tl = [...style.matchAll(/(--tl-[a-z0-9-]+)\s*:\s*([^;]+);/g)];
    expect(tl.length).toBeGreaterThanOrEqual(25);
    for (const [, name, value] of tl) {
      expect(name, 'only colors').toMatch(/^--tl-color-/);
      const token = 'var\\(--timmy-[a-z-]+, #[0-9A-Fa-f]{6}\\)';
      expect(value.trim(), name).toMatch(new RegExp(`^(${token}|color-mix\\(in srgb, ${token} \\d{1,3}%, (transparent|${token})\\))$`));
    }
    // each in the dark theme's block, which is the only place they are set
    const block = style.slice(style.indexOf('.tl-container.tl-theme__dark {'), style.indexOf('}', style.indexOf('.tl-container.tl-theme__dark {')));
    expect([...block.matchAll(/--tl-[a-z0-9-]+\s*:/g)].length).toBe(tl.length);
    const value = (n: string) => tl.find(([, k]) => k === n)?.[2].trim();
    expect(value('--tl-color-background')).toBe('var(--timmy-ground, #000000)');
    expect(value('--tl-color-panel')).toBe('var(--timmy-surface, #070707)');
    expect(value('--tl-color-text')).toBe('var(--timmy-text, #F2EFE9)');
    expect(value('--tl-color-selected')).toBe('var(--timmy-accent, #FFB000)');
    expect(value('--tl-color-focus')).toBe('var(--timmy-accent, #FFB000)');
    expect(value('--tl-color-selection-stroke')).toBe('var(--timmy-accent, #FFB000)');
    // tldraw's white tooltip and blue info are gone; a toast's success is not green
    expect(value('--tl-color-tooltip')).toBe('var(--timmy-line, #333333)');
    expect(value('--tl-color-info')).toBe('var(--timmy-silver, #E8E4D9)');
    expect(value('--tl-color-success')).not.toMatch(/live/);
    // the page's own style never names a shape's palette or a content color (tldraw's text highlight stays tldraw's)
    expect(style).not.toMatch(/--tl-color-text-highlight|\.tl-rich-text|\.tl-shape\b|\.tl-image/);
  });
});

describe("tldraw's canvas colors on B10 (companion/studio-canvas/src/theme.js)", () => {
  // A FAKE default theme in tldraw's TLTheme shape (the real one is checked in Chromium by tests/studio-canvas-browser.test.ts)
  const FAKE_DEFAULT = {
    id: 'default', fontSize: 16, lineHeight: 1.35, strokeWidth: 2, fonts: { draw: { fontFamily: 'x' } },
    colors: {
      light: { text: '#000000', background: '#f9fafb', solid: '#fcfffe', noteBorder: 'grey', selectionStroke: 'blue', black: { solid: '#1d1d1d' }, blue: { solid: '#4465e9' } },
      dark: { text: 'hsl(210, 17%, 98%)', background: 'hsl(240, 5%, 6.5%)', negativeSpace: 'x', solid: '#010403', cursor: 'white', noteBorder: 'rgb(20, 20, 20)', snap: 'red', laser: 'red', selectionStroke: 'blue', selectionFill: 'blue', selectedContrast: '#ffffff', brushStroke: 'grey', brushFill: 'grey', black: { solid: '#f2f2f2', noteFill: '#2c2c2c' }, blue: { solid: '#4f72fc' }, red: { solid: '#e03131' } },
    },
  };
  it('reads each chrome color from the page\'s --timmy-* variables (its fallback when the sheet did not load)', async () => {
    const { chromeColors, CHROME_KEYS, TOKENS } = await import('../companion/studio-canvas/src/theme.js');
    const served: Record<string, string> = { '--timmy-ground': HOMEBREW.ground, '--timmy-text': HOMEBREW.text, '--timmy-accent': HOMEBREW.accent, '--timmy-silver': HOMEBREW.silver };
    const colors = chromeColors((name: string, fallback: string) => served[name] ?? fallback);
    expect(Object.keys(colors).sort()).toEqual([...CHROME_KEYS].sort());
    expect(colors).toEqual({
      background: '#000000', negativeSpace: '#000000', text: '#F2EFE9', cursor: '#F2EFE9',
      selectionStroke: '#FFB000', selectionFill: '#FFB00029', selectedContrast: '#F2EFE9',
      brushStroke: '#FFB0008C', brushFill: '#FFB00014', snap: '#E8E4D9', laser: '#FFB000',
    });
    // the fallbacks are the tokens' own values
    for (const [variable, fallback] of Object.values(TOKENS) as Array<[string, string]>) expect(fallback.toUpperCase(), variable).toBe(served[variable].toUpperCase());
    expect(chromeColors(() => '')).toEqual(colors);
    // nothing green: a selection is never a verification
    expect(Object.values(colors).join(' ').toUpperCase()).not.toMatch(new RegExp(`${HOMEBREW.live.slice(1)}|${HOMEBREW.liveDim.slice(1)}`));
  });
  it('changes only the dark palette\'s chrome: every shape color, solid, noteBorder and the light palette stay tldraw\'s', async () => {
    const { timmyThemes, CHROME_KEYS } = await import('../companion/studio-canvas/src/theme.js');
    const themes = timmyThemes(FAKE_DEFAULT, () => '') as { default: typeof FAKE_DEFAULT & { colors: { dark: Record<string, unknown> } } };
    expect(themes.default.colors.light).toBe(FAKE_DEFAULT.colors.light);
    expect(themes.default.fonts).toBe(FAKE_DEFAULT.fonts);
    for (const [k, v] of Object.entries(FAKE_DEFAULT.colors.dark)) {
      if ((CHROME_KEYS as readonly string[]).includes(k)) continue;
      expect(themes.default.colors.dark[k], k).toBe(v);
    }
    expect(themes.default.colors.dark).toMatchObject({ solid: '#010403', noteBorder: 'rgb(20, 20, 20)', blue: { solid: '#4f72fc' }, red: { solid: '#e03131' } });
    expect(FAKE_DEFAULT.colors.dark.selectionStroke).toBe('blue'); // the default itself is never changed
  });
  it('writes a color with alpha as #RRGGBBAA, and anything else as a mix with transparent', async () => {
    const { withAlpha } = await import('../companion/studio-canvas/src/theme.js');
    expect(withAlpha('#FFB000', 0.16)).toBe('#FFB00029');
    expect(withAlpha('#fb0', 1)).toBe('#FFBB00FF');
    expect(withAlpha('#000000', 0)).toBe('#00000000');
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('color-mix(in srgb, rgb(1, 2, 3) 50%, transparent)');
  });
});
