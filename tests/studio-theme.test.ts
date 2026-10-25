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
import { FONT_FILES, HOMEBREW, LEGACY_WEB_ALIAS, UI, UI_THEMES } from '../src/theme/tokens.js';

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
    // D12 (R11 round 7, H175): the B10 web names are aliases of their B11 role — the legacy accent is the family's accent, the exact
    // amber is the registry's focus; the values are read from the token source, never written here
    expect(css).toContain(`--timmy-accent: var(--timmy-ui-${LEGACY_WEB_ALIAS.accent});`);
    expect(css).toContain(`--timmy-ui-accent: ${UI_THEMES.amber.accent};`);
    expect(css).toContain(`--timmy-ui-focus: ${UI.focus};`);
    expect(UI.focus).toBe(HOMEBREW.accent); // (the terminal's amber and the registry's focus are the one value)
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
      // D12: the ground is the registry's canvas through its alias (the value from the token source)
      expect(html).toContain(`--timmy-ground: var(--timmy-ui-${LEGACY_WEB_ALIAS.ground});`);
      expect(html).toContain(`--timmy-ui-canvas: ${UI.canvas};`);
    } finally {
      await new Promise<void>((done) => s.close(() => done()));
    }
  });
  // R11 round 7 (H176; DESIGN.md §10 B11, SHELL CONTRACT v1): the page's own sheet names the B11 registry (--timmy-ui-*), each with the
  // fallback the contract gives it (the value tokens.ts emits once H175's registry lands; a page whose theme sheet has no B11 block
  // gets the same look from the fallbacks). The B10 names are gone from it: a page on the contract uses the B11 names only.
  const UI_V1: Record<string, string> = {
    canvas: '#080B0F', surface: '#111A23', raised: '#1C2936', paper: '#E8EFF5', border: '#44586B', 'border-quiet': '#1E2A36',
    text: '#ECF1F5', 'text-secondary': '#BDCADA', 'text-muted': '#9AAFC3', ink: '#1C3043', 'ink-soft': '#3B5168',
    focus: '#FFB000', 'focus-halo': '#080B0F', verified: '#28FE14', 'verified-dim': '#00D700',
    // the amber family (the default without data-theme)
    accent: '#D6AA64', 'accent-soft': '#EAD0A3', 'accent-ink': '#402E14', 'accent-start': '#F0E5D4',
    // a material's fallback is its base colour (the gradient is the sheet's)
    'elev-surface': '#111A23', 'elev-raised': '#1C2936', 'elev-top': '#0E151D', 'elev-canvas': '#080B0F',
  };
  it('the canvas page takes the shared look: every color a B11 variable (--timmy-ui-*), its fallback the very value the contract gives it', () => {
    const html = readFileSync('companion/studio-canvas/index.html', 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="/timmy-theme.css" />');
    // Every color in the page's own style is a shared variable (with its fallback), never a color of its own.
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    for (const hex of style.match(/#[0-9a-f]{6}\b/gi) ?? []) expect(style).toMatch(new RegExp(`var\\(--timmy-ui-[a-z-]+, ${hex}\\)`));
    const fallbacks = [...style.matchAll(/var\(--timmy-([a-z-]+), (#[0-9a-f]{6})\)/gi)];
    expect(fallbacks.length).toBeGreaterThan(50);
    for (const [, name, hex] of fallbacks) {
      expect(name, `--timmy-${name}: a B11 name`).toMatch(/^ui-/);
      expect(hex.toUpperCase(), `--timmy-${name}`).toBe(UI_V1[name.slice(3)]?.toUpperCase());
    }
    // the B10 names are not read by this page any more (the B11 registry is additive: the sheet still emits them for the pages not moved)
    expect(style).not.toMatch(/var\(--timmy-(?!ui-)[a-z-]+/);
    // the registry's values the page relies on are the shared ones (the terminal's amber and green, exact in both families)
    expect(UI_V1.focus).toBe(HOMEBREW.accent);
    expect(UI_V1.verified).toBe(HOMEBREW.live);
    // no color by name, rgb() or hsl() of its own either (in its rules; its comments may name them)
    expect(style.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\b(rgba?|hsla?)\(|:\s*(white|red|blue|cyan|green|purple|violet)\b/i);
    // D2: words in the UI face, ids and commands in the mono face; nothing under the 13 px floor but the desk's caption marks
    expect(style).toContain('var(--timmy-ui-font, "Outfit", "Monaspace Argon", system-ui, sans-serif)');
    expect(style).toContain('var(--timmy-ui-font-mono, ui-monospace, Menlo, monospace)');
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
    // R11 round 7 (H176): on the B11 registry: the dark canvas, the surface for tldraw's panels, exact amber for the selection and focus
    expect(value('--tl-color-background')).toBe('var(--timmy-ui-canvas, #080B0F)');
    expect(value('--tl-color-panel')).toBe('var(--timmy-ui-surface, #111A23)');
    expect(value('--tl-color-text')).toBe('var(--timmy-ui-text, #ECF1F5)');
    expect(value('--tl-color-selected')).toBe('var(--timmy-ui-focus, #FFB000)');
    expect(value('--tl-color-focus')).toBe('var(--timmy-ui-focus, #FFB000)');
    expect(value('--tl-color-selection-stroke')).toBe('var(--timmy-ui-focus, #FFB000)');
    // tldraw's white tooltip and blue info are gone; a toast's success is not green
    expect(value('--tl-color-tooltip')).toBe('var(--timmy-ui-raised, #1C2936)');
    expect(value('--tl-color-info')).toBe('var(--timmy-ui-text-secondary, #BDCADA)');
    expect(value('--tl-color-success')).not.toMatch(/live|verified/);
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
  it('reads each chrome color from the page\'s --timmy-ui-* variables, its registry fallback when a sheet has no B11 block or did not load', async () => {
    const { chromeColors, CHROME_KEYS, TOKENS } = await import('../companion/studio-canvas/src/theme.js');
    // R11 round 7 (H176): the B11 registry's names first (SHELL CONTRACT v1's values)
    const served: Record<string, string> = { '--timmy-ui-canvas': '#080B0F', '--timmy-ui-text': '#ECF1F5', '--timmy-ui-focus': HOMEBREW.accent, '--timmy-ui-text-secondary': '#BDCADA' };
    const colors = chromeColors((name: string, fallback: string) => served[name] ?? fallback);
    expect(Object.keys(colors).sort()).toEqual([...CHROME_KEYS].sort());
    expect(colors).toEqual({
      background: '#080B0F', negativeSpace: '#080B0F', text: '#ECF1F5', cursor: '#ECF1F5',
      selectionStroke: '#FFB000', selectionFill: '#FFB00029', selectedContrast: '#ECF1F5',
      brushStroke: '#FFB0008C', brushFill: '#FFB00014', snap: '#BDCADA', laser: '#FFB000',
    });
    // the fallbacks are the registry's own values; a sheet without the B11 block gives the same chrome (the page's sheet falls back alike)
    for (const [variables, fallback] of Object.values(TOKENS) as Array<[string[], string]>) expect(fallback.toUpperCase(), variables[0]).toBe(served[variables[0]].toUpperCase());
    expect(chromeColors(() => '')).toEqual(colors);
    const b10: Record<string, string> = { '--timmy-ground': HOMEBREW.ground, '--timmy-text': HOMEBREW.text, '--timmy-accent': HOMEBREW.accent, '--timmy-silver': HOMEBREW.silver };
    expect(chromeColors((name: string, fallback: string) => b10[name] ?? fallback)).toEqual(colors);
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
