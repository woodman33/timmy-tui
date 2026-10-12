/**
 * Round R4 (H99, the display defects of r24): a run's result card on the board, as the operator saw it at 1440 px.
 *   - A failed run's card counts its blocks as /jobs does. r24: the card said "0 of 1 steps completed" (the steps it had
 *     seen, and only the completed ones) while /jobs said "1 of 3 steps" (src/workflows/block-count.ts, the order its
 *     sealed prediction kept).
 *   - The JOB badge keeps its own size beside a title that wraps. r24: at 1440 px a long title wrapped, and the badge was
 *     stretched to the title's height (a flex row's default stretch), a squashed pill.
 * The board is the Workspace's own snapshot (/board), read by a real headless Chromium (skipped when none is found, as the
 * other *-browser tests are), at 1440 x 900.
 *
 * FAKE pieces: upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; it is not upmd); the
 * blocks only echo and exit. Receipts are sealed in memory (their ids are counters). No paid call, no network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-results-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const F = '```';
// a long path, as a template's workflow has: its card's title wraps at 1440 px
const REL = 'templates/tray-workflow/WORKFLOW.md';
const DOC = [
  '# FAKE workflow: a rerun that fails at its first block', '',
  `${F}bash [name:change]`, 'echo "the change was refused"', 'exit 1', F, '',
  `${F}bash [name:inspect, deps:change]`, 'echo inspect', F, '',
  `${F}bash [name:result, deps:inspect]`, 'echo result', F, '',
].join('\n');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project whose workflow run failed at its first block, and the board's snapshot of it. */
async function failedRun(): Promise<{ root: string; ws: Workspace; job: string; html: string }> {
  const root = temp('board-results-');
  put(root, REL, DOC);
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: () => null,
    notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
    jobsDir: join(temp('board-results-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false, runProgress: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  const out = text(await ws.run(`${REL} result`));
  const job = /Running\s+(j[0-9a-f]{6})/.exec(out)?.[1];
  expect(job, out).toBeDefined();
  expect((await ws.jobs.done(job!)).state).toBe('failed');
  ws.board('');
  return { root, ws, job: job!, html: readFileSync(join(root, '.timmy', 'board', 'index.html'), 'utf8') };
}

/** The result card of a job, as the snapshot's HTML has it. */
const cardOf = (html: string, job: string): string => {
  const at = html.indexOf(`<strong class="label">${job} · `);
  expect(at, `the result card of ${job}`).toBeGreaterThan(0);
  return html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at));
};

describe('a failed run\'s result card counts its blocks as /jobs does', () => {
  it('1 of 3 steps, the block that failed with its exit and the blocks not run (r24: "0 of 1 steps completed")', async () => {
    const { ws, job, html } = await failedRun();
    expect(text(ws.jobsView(job))).toContain('1 of 3 steps');
    const card = cardOf(html, job);
    expect(card).toContain('workflow · 1 of 3 steps; change failed, exit 1; inspect, result not run');
    expect(card).not.toMatch(/of 1 steps?\b/);
    expect(card).toContain('<div class="rstatus rstatus-failed"><strong>failed</strong>');
  }, 60_000);
});

describe.skipIf(!browserPath)('the JOB badge on a result card at 1440 px (real headless Chromium)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath, timeout: 60_000 }); }, 90_000);
  afterAll(async () => { await browser?.close(); });

  it('keeps one line\'s height and its whole word, at the top beside a title that wraps', async () => {
    const { root, job } = await failedRun();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(root, '.timmy', 'board', 'index.html')).href);
      const m = await page.evaluate((id) => {
        const card = [...document.querySelectorAll('article.card.result')].find((a) => a.querySelector('.jobhead .label')?.textContent?.startsWith(`${id} · `));
        if (!card) return undefined;
        const label = card.querySelector('.jobhead .label')!.getBoundingClientRect();
        const kind = card.querySelector('.jobhead .kind') as HTMLElement;
        const k = kind.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const style = getComputedStyle(kind);
        return {
          word: kind.textContent, labelH: label.height, labelTop: label.top, labelRight: label.right,
          kindH: k.height, kindW: k.width, kindTop: k.top, kindLeft: k.left, kindRight: k.right, scrollW: kind.scrollWidth, clientW: kind.clientWidth,
          lineH: parseFloat(style.lineHeight), borders: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), cardRight: c.right,
        };
      }, job);
      expect(m, 'the job\'s result card').toBeDefined();
      expect(m!.word).toBe('job');
      // the case of r24: the title wraps onto more than one line
      expect(m!.labelH).toBeGreaterThan(m!.lineH * 1.5);
      // the badge is one line high (its line and its borders), not stretched to the title's height
      expect(m!.kindH).toBeLessThanOrEqual(m!.lineH + m!.borders + 1);
      // its word is whole, beside the title (not over it), inside the card, at the top beside the title's first line
      expect(m!.scrollW).toBeLessThanOrEqual(m!.clientW);
      expect(m!.kindLeft).toBeGreaterThanOrEqual(m!.labelRight - 0.5);
      expect(m!.kindRight).toBeLessThanOrEqual(m!.cardRight);
      expect(Math.abs(m!.kindTop - m!.labelTop)).toBeLessThan(m!.lineH);
    } finally {
      await context.close();
    }
  }, 90_000);
});
