/**
 * Round R4 (H48): the Control Room section of the live board in a real headless Chromium (the one the other browser
 * tests use; skipped when none is found), in a fresh browser context, against the Workspace's live board on 127.0.0.1.
 *
 * FAKE pieces, each labelled: the running job is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing
 * sent) run through /agent as Qwen Code on a local endpoint, its task saying SLEEP so its job (a real child process) runs
 * until stopped; the flow is /iterate tray with that FAKE agent, held in its agent step (TIMMY_CADQUERY_PYTHON names a FAKE
 * file never executed).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('room-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FAKE_AGENT = resolve('tests/fixtures/fake-code-agent.mjs');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make() {
  const root = temp('room-browser-');
  const fakePython = join(temp('room-browser-fixtures-'), 'fake-python');
  writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  put(root, 'README.md', '# FAKE project for the Control Room browser test\n');
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('room-browser-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256_${String(i).padStart(64, '0')}` })) as unknown as Receipt[],
    recoverAtStart: false,
    roomTools: async () => [],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, root };
}

describe.skipIf(!browserPath)('the Control Room in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('loads the section, presses Stop on a FAKE running job: it stops as the typed /stop, and the room shows it stopped, with no CSP or script error', async () => {
    const { ws, notes, root } = make();
    const job = /\b(j[0-9a-f]{6})\b/.exec(text(await ws.agent('qwen FAKE: SLEEP until stopped')))![1];
    await ws.boardLive('live');
    const { url, port } = ws.liveBoard!;
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(url);
    // The section is the board's first: its heading, the costs line, the running run with its owner and route.
    await page.waitForSelector('h2#room');
    expect(page.url()).toBe(`http://127.0.0.1:${port}/`);
    const stop = page.locator(`button[data-act="room-stop"][data-job="${job}"]`);
    await stop.waitFor({ timeout: 8000 });
    const card = page.locator(`article.room-run[data-room-id] >> nth=0`);
    expect(await card.locator('.room-owner').textContent()).toBe('Qwen Code');
    expect(await card.locator('.room-state').textContent()).toBe('running');
    expect(await page.locator('.room-costs').textContent()).toContain('1 run free (local endpoint)');
    expect(await page.locator('#room-running .count').textContent()).toBe('1');
    // The Jobs section keeps its own Stop for the same job: the two are told apart by their action.
    expect(await page.locator(`button[data-act="stop"][data-job="${job}"]`).count()).toBe(1);

    await stop.click();
    await page.waitForFunction(() => !document.getElementById('out')!.hidden);
    expect((await page.textContent('#out'))!.split('\n')[0]).toBe(`board /stop ${job}`);
    await page.waitForFunction((id) => !document.querySelector(`button[data-act="room-stop"][data-job="${id}"]`)
      && [...document.querySelectorAll('article.room-run .room-state')].some((s) => s.textContent === 'stopped'), job, { timeout: 8000 });
    expect(ws.jobs.get(job)?.state).toBe('cancelled');
    expect(notes).toContain(`  board  /stop ${job}`);
    expect(await page.locator('#room-running + p.empty').textContent()).toBe('Nothing runs in this project now.');
    // Nothing from the project's folder on the page, nothing kept in the browser, no error.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(root);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 40_000);

  it('a FAKE-agent flow held in its agent step: the room\'s Stop on it is sent as the flow\'s stop and the flow ends cancelled', async () => {
    const { ws } = make();
    const flow = /\b(f[0-9a-f]{8})\b/.exec(text(await ws.iterate('tray "FAKE: SLEEP, then make the tray wider"')))![1];
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const stop = page.locator(`button[data-act="room-stop"][data-flow="${flow}"]`);
    await stop.waitFor({ timeout: 8000 });
    expect(await page.locator(`ol.handoff[aria-label="the handoffs of flow ${flow}"] li`).count()).toBe(4);
    await stop.click();
    await page.waitForFunction((id) => (document.getElementById('out')?.textContent ?? '').startsWith(`board /stop ${id}`), flow, { timeout: 30_000 });
    expect(await page.textContent('#out')).toContain(`${flow} cancelled`);
    await page.waitForFunction((id) => !document.querySelector(`button[data-flow="${id}"]`), flow, { timeout: 8000 });
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);
});
