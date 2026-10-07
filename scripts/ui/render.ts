// Picture of one capture, drawn from the same parsed cells the gate measures:
//   npx tsx scripts/ui/render.ts FILE.ansi OUT.png COLS ROWS [night|day|audited]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { parseAnsiFrame } from '../../src/tui/qa/ansi-frame.js';
import { CAPTURE_PALETTES as PALETTES } from './palettes.js';

const [file, out, colsArg, rowsArg, paletteName = 'night'] = process.argv.slice(2);
const palette = PALETTES[paletteName];
if (!file || !out || !palette) {
  console.error('usage: render.ts FILE.ansi OUT.png COLS ROWS [night|day|audited]');
  process.exit(2);
}
const cols = Number(colsArg) || 100;
const rows = Number(rowsArg) || 32;
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const cells = parseAnsiFrame(readFileSync(file, 'utf8'), palette).filter((c) => c.row < rows && c.col < cols);
const spans = cells.map((c) => {
  const bg = c.bg === palette.background.toUpperCase() ? '' : `background:${c.bg};`;
  return `<span style="grid-row:${c.row + 1};grid-column:${c.col + 1}/span ${c.width};color:${c.fg};${bg}${c.bold ? 'font-weight:700;' : ''}">${escapeHtml(c.char)}</span>`;
});
const html = `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:${palette.background}}
.t{display:grid;grid-template-columns:repeat(${cols},9.6px);grid-template-rows:repeat(${rows},20px);padding:16px;width:max-content;
font:15.5px/20px "JetBrains Mono","SF Mono",Menlo,"DejaVu Sans Mono",monospace;color:${palette.foreground}}
.t span{white-space:pre;overflow:visible}</style><div class=t>${spans.join('')}</div>`;
// TIMMY_UI_CHROMIUM: use an already-installed Chromium instead of Playwright's pinned download.
const browser = await chromium.launch(process.env.TIMMY_UI_CHROMIUM ? { executablePath: process.env.TIMMY_UI_CHROMIUM } : {});
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: Math.ceil(cols * 9.6 + 32), height: rows * 20 + 32 } });
await page.setContent(html);
await page.locator('.t').screenshot({ path: out });
await browser.close();
console.log(out);
