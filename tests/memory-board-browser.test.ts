// Timmy Memory on the live board in a real headless Chromium (round R4, helper H50; skipped when no Chromium is found, as
// tests/board-live-browser.test.ts is): the Memory section shows a draft lesson with its Check button; pressing it runs
// /lesson check <id> through the Workspace as the typed command, the page shows what Timmy printed, and the card, redrawn
// from the next state, says checked. Real files and a REAL receipts chain in a temporary project
// (tests/helpers/memory-kit.ts); no agent or model runs.
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Lesson } from '../src/memory/lessons.js';
import { chainOf, memoryKit, put, read, text, workspace } from './helpers/memory-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('memory-board-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const kit = memoryKit();
afterEach(async () => { await kit.cleanup(); });

describe.skipIf(!browserPath)('Memory on the live board in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('Check on a draft lesson runs /lesson check, shows its answer, and the card says checked; no CSP or script error', async () => {
    const root = kit.temp('memory-browser-');
    put(root, 'evidence/one.txt', 'the run where it held\n');
    const { ws, notes } = workspace(root, kit);
    const id = /Lesson\s+(l[0-9a-f]{8})/.exec(text(ws.lesson('add "Keep the lid gap at <b>0.4 mm</b>." --from evidence/one.txt --applies scad')))![1];
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const check = `button[data-act="lesson-check"][data-lesson="${id}"]`;
    await page.waitForSelector(check);
    const card = `article[data-lesson-card="${id}"]`;
    expect(await page.textContent(`${card} .lesson-status`)).toBe('draft');
    // The text is shown as text: the <b> is not markup.
    expect(await page.textContent(`${card} .lesson-text`)).toBe('Keep the lid gap at <b>0.4 mm</b>.');
    expect(await page.$$eval(`${card} .lesson-text b`, (b) => b.length)).toBe(0);
    expect(await page.textContent('#memory')).toContain('Memory');

    await page.click(check);
    await page.waitForFunction(() => !document.getElementById('out')!.hidden);
    const out = (await page.textContent('#out'))!;
    expect(out.split('\n')[0]).toBe(`board /lesson check ${id}`);
    expect(out).toContain(`${id} checked: every evidence file (1) has the bytes it was added with, and every receipt it names verifies`);
    // The card, redrawn from the next state (the page polls every 2 s), says checked.
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === 'checked', `${card} .lesson-status`, { timeout: 8000 });
    expect(notes).toContain(`  board  /lesson check ${id}`);
    expect((JSON.parse(read(root, `.timmy/memory/lessons/${id}.json`)) as Lesson).status).toBe('checked');
    expect(chainOf(root).at(-1)).toMatchObject({ kind: 'lesson', lesson: { id, action: 'check', status: 'checked' } });
    // Nothing kept in the browser, and nothing refused by the page's policy.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);
});
