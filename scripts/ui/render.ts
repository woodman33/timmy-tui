// Picture of one capture, drawn from the same parsed cells the gate measures, in Monaspace Argon on
// Timmy Homebrew (DESIGN.md §10 B9) so a review picture matches the terminal profile:
//   npx tsx scripts/ui/render.ts FILE.ansi OUT.png COLS ROWS [homebrew|night|day|audited|clear-dark|basic]
// The font is read from this machine (@fontsource/monaspace-argon, OFL-1.1) and embedded in the page
// that is photographed, unmodified; it is never copied into the repository and nothing is fetched.
// If it is not here, the picture is drawn in the system's monospace face and the command says so.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fontDir } from '../../src/studio/server.js';
import type { TerminalPalette } from '../../src/term/palettes.js';
import { FONT_FILES, TYPE } from '../../src/theme/tokens.js';
import { parseAnsiFrame } from '../../src/tui/qa/ansi-frame.js';
import { CAPTURE_PALETTES as PALETTES } from './palettes.js';

export const DEFAULT_PALETTE = 'homebrew';

/**
 * One terminal cell in the picture. Monaspace Argon advances 0.62 em (measured in a browser by
 * tests/ui-render.test.ts), so 16 px type fills a 9.92 px cell exactly; the grid is laid out by cell
 * anyway, so a fallback font cannot shift a glyph.
 */
export const CELL = { fontPx: 16, advance: 0.62, widthPx: 9.92, heightPx: 20, padPx: 16 } as const;

export interface PictureFont {
  /** `@font-face` rules with the faces embedded, or '' when they are not on this machine. */
  css: string;
  found: boolean;
  /** What to tell the person about the font the picture used. */
  note: string;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** Monaspace Argon's faces from `dir` (the package's `files` folder), embedded as data. */
export function fontFaceCss(dir: string | null): PictureFont {
  const missing: PictureFont = {
    css: '',
    found: false,
    note: `Monaspace Argon not found here, so the picture is drawn in the system's monospace font (to install it: ${TYPE.install}, or npm ci).`,
  };
  if (!dir) return missing;
  try {
    const rules = FONT_FILES.map((f) => {
      const data = readFileSync(`${dir}/${f.file}`).toString('base64');
      return `@font-face{font-family:"${TYPE.family}";font-style:${f.style};font-weight:${f.weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    });
    return { css: rules.join('\n'), found: true, note: `Monaspace Argon (${FONT_FILES.length} faces, from this machine's @fontsource copy)` };
  } catch {
    return missing;
  }
}

/** The page that is photographed, and what to say about the font it uses. */
export function pictureHtml(opts: { ansi: string; palette: TerminalPalette; cols: number; rows: number; font?: PictureFont }): { html: string; note: string } {
  const { ansi, palette, cols, rows } = opts;
  const font = opts.font ?? fontFaceCss(fontDir());
  const cells = parseAnsiFrame(ansi, palette).filter((c) => c.row < rows && c.col < cols);
  const spans = cells.map((c) => {
    const bg = c.bg === palette.background.toUpperCase() ? '' : `background:${c.bg};`;
    return `<span style="grid-row:${c.row + 1};grid-column:${c.col + 1}/span ${c.width};color:${c.fg};${bg}${c.bold ? 'font-weight:700;' : ''}">${escapeHtml(c.char)}</span>`;
  });
  const html = `<!doctype html><meta charset=utf-8><style>
${font.css}
body{margin:0;background:${palette.background}}
.t{display:grid;grid-template-columns:repeat(${cols},${CELL.widthPx}px);grid-template-rows:repeat(${rows},${CELL.heightPx}px);padding:${CELL.padPx}px;width:max-content;
font-family:${TYPE.stack};font-size:${CELL.fontPx}px;line-height:${CELL.heightPx}px;color:${palette.foreground}}
.t span{white-space:pre;overflow:visible}</style><div class=t>${spans.join('')}</div>`;
  return { html, note: font.note };
}

async function main(): Promise<void> {
  const [file, out, colsArg, rowsArg, paletteName = DEFAULT_PALETTE] = process.argv.slice(2);
  const palette = PALETTES[paletteName];
  if (!file || !out || !palette) {
    console.error(`usage: render.ts FILE.ansi OUT.png COLS ROWS [${Object.keys(PALETTES).join('|')}]`);
    process.exit(2);
  }
  const cols = Number(colsArg) || 100;
  const rows = Number(rowsArg) || 32;
  const { html, note } = pictureHtml({ ansi: readFileSync(file, 'utf8'), palette, cols, rows });
  const { chromium } = await import('playwright');
  // TIMMY_UI_CHROMIUM: use an already-installed Chromium instead of Playwright's pinned download.
  const browser = await chromium.launch(process.env.TIMMY_UI_CHROMIUM ? { executablePath: process.env.TIMMY_UI_CHROMIUM } : {});
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: Math.ceil(cols * CELL.widthPx + CELL.padPx * 2), height: rows * CELL.heightPx + CELL.padPx * 2 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.t').screenshot({ path: out });
  await browser.close();
  console.error(`drawn on ${palette.name}: ${note}`);
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
