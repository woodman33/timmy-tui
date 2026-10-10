/**
 * Round R4 (H67, ledger row 162, r20): the live board's header says it is live only once it is. On the Mac (r20) a tab of
 * the board opened without its token still read "Board · live" in its header, above "No token …". The header word now
 * reads "not live yet" until a state arrives, "waiting for the token" while the tab has none, "live" once the board has
 * taken the tab's token and sent its state, and "not live" when the board refuses it; only "live" is drawn in the accent.
 * In a real headless Chromium (the one the other browser tests use; skipped when none is found), against the Workspace's
 * live board on 127.0.0.1 with a REAL receipts chain in a temporary project (tests/helpers/memory-kit.ts). No model, agent or
 * tool runs here.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOMEBREW } from '../src/theme/tokens.js';
import { memoryKit, put, workspace } from './helpers/memory-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-live-header-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const NO_TOKEN = 'No token: this tab was opened without the token of this board, and no other open tab of this board gave it one. In Timmy, type /board live: it gives you the address of this board with its token.';

async function board() {
  const root = kit.temp('board-header-');
  put(root, 'README.md', '# a project for the live header test\n');
  const { ws } = workspace(root, kit);
  await ws.boardLive('live');
  const { url, port } = ws.liveBoard!;
  return { url, port };
}

/** The header as the page shows it: its text, the live word's own text and class, and the colour it is drawn in. */
const header = (page: Page) => page.evaluate(() => {
  const word = document.getElementById('live')!;
  return { h1: document.querySelector('h1')!.textContent!.replace(/\s+/g, ' ').trim(), word: word.textContent, cls: word.className, color: getComputedStyle(word).color };
});
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

describe.skipIf(!browserPath)("the live board's header word (headless Chromium, fresh contexts)", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('the page as served (before any script runs) says not live yet, never live', async () => {
    const { port } = await board();
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('<h1>Board · <span class="project" id="project"></span> <span class="live not-live" id="live">not live yet</span></h1>');
    expect(html).not.toMatch(/>live<\/span>/);
  }, 20_000);

  it('a tab without the token never says live: it waits for the token, says how to get it, and says live once a tab with the token gives it', async () => {
    const { url, port } = await board();
    const context = await browser.newContext();
    const lone = await context.newPage();
    const problems: string[] = [];
    lone.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    lone.on('pageerror', (e) => problems.push(String(e)));
    // Every word the header shows from the first moment the page runs, kept as it changes.
    await lone.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __words: string[] }).__words = seen;
      document.addEventListener('DOMContentLoaded', () => {
        const word = document.getElementById('live')!;
        seen.push(String(word.textContent));
        new MutationObserver(() => seen.push(String(word.textContent))).observe(word, { childList: true, characterData: true, subtree: true });
      });
    });
    await lone.goto(`http://127.0.0.1:${port}/#room`);
    await lone.waitForFunction((line) => document.getElementById('status')!.textContent === line, NO_TOKEN, { timeout: 8000 });
    expect(await header(lone)).toEqual({ h1: 'Board · waiting for the token', word: 'waiting for the token', cls: 'live not-live', color: rgb(HOMEBREW.attention) });
    // Kept waiting while it polls: never live, never in the accent.
    await lone.waitForTimeout(2500);
    expect((await header(lone)).word).toBe('waiting for the token');
    expect(await lone.evaluate(() => (window as unknown as { __words: string[] }).__words)).not.toContain('live');
    // A tab opened with the printed address: it is live, and the lone tab is given the token and is live too.
    const opened = await context.newPage();
    await opened.goto(url);
    await opened.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('live · '));
    expect(await header(opened)).toMatchObject({ word: 'live', cls: 'live', color: rgb(HOMEBREW.accent) });
    await lone.waitForFunction(() => document.getElementById('live')!.textContent === 'live', undefined, { timeout: 8000 });
    expect(await header(lone)).toMatchObject({ word: 'live', cls: 'live', color: rgb(HOMEBREW.accent) });
    // Its script had run before the page was parsed to its end: the first word seen is the wait, then live.
    const words = await lone.evaluate(() => (window as unknown as { __words: string[] }).__words);
    expect(words[0]).toBe('waiting for the token');
    expect(words.indexOf('live')).toBeGreaterThan(words.indexOf('waiting for the token'));
    expect(problems).toEqual([]);
    await context.close();
  }, 40_000);

  it('a token the board does not take (it was started again): not live, with the refusal; never live', async () => {
    const { port } = await board();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/#t=${'0'.repeat(64)}`);
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Refused: '), undefined, { timeout: 8000 });
    expect(await header(page)).toMatchObject({ word: 'not live', cls: 'live not-live', color: rgb(HOMEBREW.attention) });
    await context.close();
  }, 40_000);
});
