// Round R3: the live board's page in a real headless Chromium (the one tests/studio-canvas-browser.test.ts
// uses; skipped when none is found), in a fresh browser context, against the Workspace's live board on
// 127.0.0.1. Workflow runs use tests/fixtures/fake-upmd.mjs, a labelled TEST DOUBLE of upmd 0.2.7's --ci
// protocol (it is not upmd); the job it starts is a real process, stopped through /stop.
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
if (!browserPath) console.warn('board-live-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const XSS = '<img src=x onerror=alert(1)>.png';
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make() {
  const root = temp('board-live-browser-');
  put(root, 'BUILD.md', ['# Build', '', '```bash [name:wait]', 'sleep 30', '```', ''].join('\n'));
  put(root, 'refs/photo.png', PNG);
  put(root, `refs/${XSS}`, PNG);
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: FAKE_UPMD },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => `Open ${url} in your browser.`,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes };
}

describe.skipIf(!browserPath)('the live board in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('draws the board from its state, runs a block and stops its job with the buttons, with no CSP or script error', async () => {
    const { ws, notes } = make();
    await ws.boardLive('live');
    const { url, port } = ws.liveBoard!;
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(url);
    await page.waitForSelector('button[data-act="run"][data-block="wait"]');
    // The token left the address bar; it lives only in the page's script.
    expect(page.url()).toBe(`http://127.0.0.1:${port}/`);
    expect(await page.textContent('#project')).toBe(ws.project.name);
    expect(await page.textContent('#status')).toContain('live');
    // A file name with HTML is text: no element was made from it.
    expect(await page.evaluate(() => document.querySelectorAll('img').length)).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).toContain(XSS);

    await page.click('button[data-act="run"][data-block="wait"]');
    await page.waitForFunction(() => !document.getElementById('out')!.hidden);
    expect((await page.textContent('#out'))!.split('\n')[0]).toBe('board /run BUILD.md wait');
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › wait')!;
    expect(job).toBeDefined();
    const stop = page.locator(`button[data-act="stop"][data-job="${job.id}"]`);
    await stop.waitFor({ timeout: 6000 });
    await stop.click();
    await page.waitForFunction((id) => document.querySelector(`[data-job-card="${id}"] .state`)?.textContent === 'cancelled', job.id, { timeout: 6000 });
    expect(await page.textContent('#out')).toContain(`board /stop ${job.id}`);
    expect(ws.jobs.get(job.id)?.state).toBe('cancelled');
    expect(notes).toContain('  board  /run BUILD.md wait');
    expect(notes).toContain(`  board  /stop ${job.id}`);
    // Nothing kept in the browser.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 30_000);

  it('a reload, with the token gone from the address, asks nothing and says to open the printed address', async () => {
    const { ws } = make();
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(ws.liveBoard!.url);
    await page.waitForSelector('button[data-act="run"]');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.includes('No token'));
    expect(await page.evaluate(() => document.getElementById('main')!.innerHTML)).toBe('');
    await context.close();
  }, 30_000);
});
