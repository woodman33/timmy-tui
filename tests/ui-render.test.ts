import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { fontDir } from '../src/studio/server.js';
import { TIMMY_HOMEBREW, TIMMY_NIGHT } from '../src/term/palettes.js';
import { FONT_FILES, HOMEBREW, TYPE } from '../src/theme/tokens.js';
import { CELL, DEFAULT_PALETTE, fontFaceCss, pictureHtml } from '../scripts/ui/render.js';

// Round R1, assignment 4: review pictures are drawn in Monaspace Argon on Timmy Homebrew, the same
// look as the terminal profile, and say plainly when the font could not be found.
const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('ui-render: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FRAME = ['\x1b[1;32m✓ RECEIPT 0142\x1b[22;39m signed and verified', '\x1b[31m✖ Error:\x1b[39m the voiceover lane stopped', 'plain text'].join('\n');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('review pictures: the look', () => {
  it('draws on Timmy Homebrew unless another palette is named', () => {
    expect(DEFAULT_PALETTE).toBe('homebrew');
    const { html } = pictureHtml({ ansi: FRAME, palette: TIMMY_HOMEBREW, cols: 40, rows: 4 });
    expect(html).toContain(`background:${HOMEBREW.ground}`);
    expect(html).toContain(`color:${HOMEBREW.text}`);
    expect(html).toContain(`color:${HOMEBREW.accent}`);
  });
  it('still draws the other palettes, so older pictures can be redrawn', () => {
    const { html } = pictureHtml({ ansi: FRAME, palette: TIMMY_NIGHT, cols: 40, rows: 4 });
    expect(html).toContain(`color:${TIMMY_NIGHT.foreground}`);
    expect(html).not.toContain(HOMEBREW.accent);
  });
  it('asks for Monaspace Argon first, then the shared fallbacks, at the size the grid is built for', () => {
    const { html } = pictureHtml({ ansi: FRAME, palette: TIMMY_HOMEBREW, cols: 40, rows: 4 });
    expect(html).toContain(`font-family:${TYPE.stack}`);
    expect(html).not.toMatch(/JetBrains/);
    expect(CELL.fontPx * CELL.advance).toBeCloseTo(CELL.widthPx, 5);
  });
  it('keeps every glyph on its grid cell, whatever font answers', () => {
    const { html } = pictureHtml({ ansi: 'ab\ncd', palette: TIMMY_HOMEBREW, cols: 2, rows: 2 });
    expect(html).toContain(`grid-template-columns:repeat(2,${CELL.widthPx}px)`);
    expect(html).toContain('grid-row:2;grid-column:1/span 1');
  });
  it('escapes what a capture holds', () => {
    const { html } = pictureHtml({ ansi: '<b>&"x"</b>', palette: TIMMY_HOMEBREW, cols: 20, rows: 1 });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });
});

describe('review pictures: the font', () => {
  it.skipIf(!fontDir())('embeds the faces it needs from this machine, unmodified, and fetches nothing', () => {
    const font = fontFaceCss(fontDir());
    expect(font.found).toBe(true);
    for (const f of FONT_FILES) {
      const bytes = readFileSync(join(fontDir()!, f.file)).toString('base64');
      expect(font.css, f.file).toContain(`data:font/woff2;base64,${bytes}`);
    }
    expect(font.css).toContain(`font-family:"${TYPE.family}"`);
    expect(font.css).not.toMatch(/https?:|url\((?!data:)/);
    expect(font.note).toMatch(/^Monaspace Argon/);
  });
  it('says so, and falls back to system monospace, when the font is not on this machine', () => {
    const font = fontFaceCss(null);
    expect(font.found).toBe(false);
    expect(font.css).toBe('');
    expect(font.note).toMatch(/not found/i);
    expect(font.note).toMatch(/monospace/i);
    expect(font.note).toContain(TYPE.install);
  });
  it('never claims Monaspace Argon for a picture that did not use it', () => {
    expect(pictureHtml({ ansi: FRAME, palette: TIMMY_HOMEBREW, cols: 40, rows: 4, font: fontFaceCss(null) }).note).not.toMatch(/^Monaspace Argon \(/);
  });
});

describe.skipIf(!browserPath || !fontDir())('review pictures: in a real browser', () => {
  it('lays text out in Monaspace Argon at exactly one grid cell per character', async () => {
    const browser = await chromium.launch({ headless: true, executablePath: browserPath });
    try {
      const page = await browser.newPage();
      const { html } = pictureHtml({ ansi: 'MMMMMMMMMM\niiiiiiiiii', palette: TIMMY_HOMEBREW, cols: 10, rows: 2, font: fontFaceCss(fontDir()) });
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const usable = await page.evaluate((family) => document.fonts.check(`16px "${family}"`) && [...document.fonts].some((f) => f.family.replace(/"/g, '') === family && f.status === 'loaded'), TYPE.family);
      expect(usable, 'Monaspace Argon loaded').toBe(true);
      // Measured with the same font on a probe: M and i advance the same in a monospace face.
      const widths = await page.evaluate((stack) => {
        const probe = (t: string) => { const s = document.createElement('span'); s.style.cssText = `font:16px ${stack};white-space:pre;position:absolute`; s.textContent = t; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
        return { m: probe('M'.repeat(20)) / 20, i: probe('i'.repeat(20)) / 20 };
      }, TYPE.stack);
      expect(widths.m).toBeCloseTo(CELL.widthPx, 1);
      expect(widths.i).toBeCloseTo(CELL.widthPx, 1);
      const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(ground).toBe('rgb(0, 0, 0)');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('the command writes a PNG of a capture and says which font it used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timmy-render-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'frame.ansi'), FRAME);
    const out = join(dir, 'frame.png');
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ui/render.ts', join(dir, 'frame.ansi'), out, '40', '4'], { cwd: repo, encoding: 'utf8', env: { ...process.env, TIMMY_UI_CHROMIUM: browserPath }, timeout: 90_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(out);
    expect(run.stderr).toMatch(/Monaspace Argon/);
    expect(run.stderr).toMatch(/Timmy Homebrew/);
    expect(readFileSync(out).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }, 120_000);
});
