/**
 * Round R4 (H60): the live board's token handoff between its own tabs, in a real headless Chromium (the one the other
 * browser tests use; skipped when none is found), against the Workspace's live board on 127.0.0.1 with a REAL receipts
 * chain in a temporary project (tests/helpers/memory-kit.ts). Timmy Canvas's "Open on the board" opens the board's bare
 * address and a section (#room) in a new tab: that tab asks a tab of the same board for the token over a BroadcastChannel
 * named for the board's port. A page of another origin (another port on 127.0.0.1) never gets an answer. No model, agent
 * or tool runs here.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { memoryKit, put, workspace } from './helpers/memory-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-live-handoff-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

const NO_TOKEN = 'No token: this tab was opened without the token of this board, and no other open tab of this board gave it one. In Timmy, type /board live: it gives you the address of this board with its token.';

async function board() {
  const root = kit.temp('board-handoff-');
  put(root, 'README.md', '# a project for the token handoff test\n');
  const { ws } = workspace(root, kit);
  await ws.boardLive('live');
  const { url, port } = ws.liveBoard!;
  return { ws, root, url, port, token: url.split('#t=')[1] };
}

/** Problems a page reports: console errors and warnings, and uncaught errors. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  return problems;
}

/** Posts these messages on the board's channel from `page`, and returns what came back on it within `ms`. */
function onChannel(page: Page, port: number, messages: unknown[], ms = 1200): Promise<unknown[]> {
  return page.evaluate(async ({ name, messages: list, ms: wait }) => {
    const seen: unknown[] = [];
    const ch = new BroadcastChannel(name);
    ch.onmessage = (e) => { seen.push(e.data); };
    for (const m of list) ch.postMessage(m);
    await new Promise((r) => setTimeout(r, wait));
    ch.close();
    return seen;
  }, { name: `timmy-board-${port}`, messages, ms });
}

describe.skipIf(!browserPath)('the live board\'s token handoff (headless Chromium, fresh contexts)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('a second tab of the same board, opened at its bare address and #room, gets the token from the first; the token is nowhere on it', async () => {
    const { url, port, token, root } = await board();
    const context = await browser.newContext();
    const first = await context.newPage();
    const firstProblems = watch(first);
    await first.goto(url);
    await first.waitForSelector('h2#room');
    const second = await context.newPage();
    const problems = watch(second);
    await second.goto(`http://127.0.0.1:${port}/#room`);
    await second.waitForSelector('h2#room', { timeout: 8000 });
    await second.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('live · '));
    // The section stays in the address; the token is not in it, nor in the page's text or markup, nor kept anywhere.
    expect(second.url()).toBe(`http://127.0.0.1:${port}/#room`);
    expect(await second.evaluate(() => document.documentElement.outerHTML)).not.toContain(token);
    expect(await second.evaluate(() => document.body.innerText)).not.toContain(root);
    expect(await second.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(await first.evaluate(() => document.documentElement.outerHTML)).not.toContain(token);
    expect(first.url()).toBe(`http://127.0.0.1:${port}/`);
    expect([...problems, ...firstProblems]).toEqual([]);
    await context.close();
  }, 40_000);

  it('a tab that holds the token answers only the exact request, only on its own origin; a page on another port of 127.0.0.1 gets nothing', async () => {
    const { url, port, token } = await board();
    const other = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>another origin</title>'); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const otherPort = (other.address() as AddressInfo).port;
    const context = await browser.newContext();
    try {
      const holder = await context.newPage();
      await holder.goto(url);
      await holder.waitForSelector('h2#room');
      await holder.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('live · '));
      // The exact request from this origin is answered with the token, and only that one: every other shape is not.
      const n = (c: string): string => c.repeat(32);
      const sameOrigin = await onChannel(holder, port, [
        { t: 'timmy-board-token?', n: n('a') },
        { t: 'timmy-board-token?', n: n('b'), extra: 1 },
        { t: 'timmy-board-token?', n: 'not-hex' },
        { t: 'timmy-board-token?', n: n('c').toUpperCase() },
        { t: 'timmy-board-token?', n: 12345 },
        { t: 'timmy-board-token!', n: n('d') },
        ['timmy-board-token?', n('e')],
        'timmy-board-token?',
        { t: 'timmy-board-token', n: n('f'), k: 'f'.repeat(64) },
      ]);
      expect(sameOrigin).toEqual([{ t: 'timmy-board-token', n: n('a'), k: token }]);
      // Another origin: the same request on a channel of the same name reaches no tab of the board.
      const stranger = await context.newPage();
      await stranger.goto(`http://127.0.0.1:${otherPort}/`);
      expect(await onChannel(stranger, port, [{ t: 'timmy-board-token?', n: n('a') }], 1500)).toEqual([]);
      // ... and the board's tab still answers its own origin afterwards (the silence above was the origin, not the tab).
      expect(await onChannel(holder, port, [{ t: 'timmy-board-token?', n: n('9') }])).toEqual([{ t: 'timmy-board-token', n: n('9'), k: token }]);
    } finally {
      await context.close();
      await new Promise<void>((r) => other.close(() => r()));
    }
  }, 40_000);

  it('a tab with no board tab open says how to open the board from Timmy, draws nothing, and takes the token once a tab with it opens', async () => {
    const { url, port } = await board();
    const context = await browser.newContext();
    const lone = await context.newPage();
    const problems = watch(lone);
    await lone.goto(`http://127.0.0.1:${port}/#room`);
    await lone.waitForFunction((line) => document.getElementById('status')!.textContent === line, NO_TOKEN, { timeout: 8000 });
    expect(await lone.evaluate(() => document.getElementById('status')!.className)).toBe('sub bad');
    expect(await lone.evaluate(() => document.getElementById('main')!.innerHTML)).toBe('');
    // A tab opened with the printed address: the lone tab asks again as it polls, and is given the token.
    const opened = await context.newPage();
    await opened.goto(url);
    await lone.waitForSelector('h2#room', { timeout: 8000 });
    expect(lone.url()).toBe(`http://127.0.0.1:${port}/#room`);
    expect(problems).toEqual([]);
    await context.close();
  }, 40_000);
});
