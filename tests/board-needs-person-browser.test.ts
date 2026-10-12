// Round R4 (H99, the review of the H99 work, item 6): a Run the board cannot press because its run needs a person, in a real
// headless Chromium (the one tests/board-live-browser.test.ts uses; skipped when none is found), in a fresh browser context,
// against the Workspace's live board on 127.0.0.1, with real files in a temporary project. The review: the disabled Run's
// pointer said "progress" (busy) where nothing is in progress; the run bar's "Run <block> again" said why only in a title,
// which a touch screen never shows. Now a disabled button reads not-allowed (only a button whose request is on its way reads
// busy), and the run bar says why in text, readable at 390 px.
// The interrupted run is a SYNTHETIC job record written by hand in src/jobs' shape (a run whose REPL ended: its process is
// gone); no block runs here. No paid call, no network.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-needs-person-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const F = '```';
const DOC = [
  '# Clean build', '', 'Clean, then build; hello stands alone.', '',
  `${F}bash [name:clean]`, 'rm -rf dist', F, '',
  `${F}bash [name:build, deps:clean]`, 'mkdir -p dist && echo built > dist/out.txt', F, '',
  `${F}bash [name:hello]`, 'echo hello > hello.txt', F, '',
].join('\n');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(): { ws: Workspace; root: string; jobsDir: string } {
  const root = temp('h99-needs-person-');
  put(root, 'RISKY.md', DOC);
  const jobsDir = join(temp('h99-needs-person-jobs-'), 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  // SYNTHETIC: a /run of RISKY.md › build its REPL left while clean ran (its process is gone), in src/jobs' shape
  writeFileSync(join(jobsDir, 'j00b0c1.json'), JSON.stringify({
    id: 'j00b0c1', kind: 'workflow', label: 'RISKY.md › build', project: 'demo', root, command: 'upmd', args: ['--ci', '-b', 'build', '-d', root, join(root, 'RISKY.md')],
    state: 'running', pid: 2147480000, startedAt: '2026-10-11T10:00:00.000Z', lines: 0, steps: [{ name: 'clean', index: 1, state: 'running' }],
  }));
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: () => null,
    notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
    jobsDir, chdir: () => {}, recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, root, jobsDir };
}

describe.skipIf(!browserPath)('a Run that needs a person, on the live board (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath, timeout: 60_000 }); }, 90_000);
  afterAll(async () => { await browser?.close(); });
  const card = '[data-wfx="RISKY.md"]';

  async function open(ws: Workspace, width: number): Promise<{ page: Page; problems: string[]; close: () => Promise<void> }> {
    if (!ws.liveBoard) await ws.boardLive('live');
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500 });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    await page.waitForSelector(`${card} [data-wf-node="3"]`);
    return { page, problems, close: () => context.close() };
  }
  const cursorOf = (page: Page, sel: string): Promise<string> => page.$eval(sel, (e) => getComputedStyle(e).cursor);

  it('its disabled Run reads not-allowed, never busy; the run bar says why in text, at 1360 and at 390 px; a Run whose request is on its way reads busy', async () => {
    const { ws } = make();
    const why = 'Run build again is disabled here: clean runs a destructive shell command on this machine, which needs a person, and the board cannot ask you. Type /run RISKY.md build in the REPL, which asks first in its NEEDS YOU box.';
    for (const width of [1360, 390]) {
      const { page, problems, close } = await open(ws, width);
      // the run bar of the interrupted run: Run build again, disabled, with why as text beside it (a touch screen shows no title)
      const again = `${card} .wfx-run button[data-wf-needs-person]`;
      expect(await page.$eval(again, (b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual(['Run build again', true]);
      expect(await cursorOf(page, again)).toBe('not-allowed');
      const said = `${card} .wfx-run [data-wf-held-why]`;
      expect((await page.textContent(said))?.replace(/\s+/g, ' ').trim()).toBe(`needs you ${why}`);
      expect(await page.isVisible(said)).toBe(true);
      // at 390 px it is read where it is: inside the page's width, wrapped, not cut
      const box = await page.$eval(said, (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, scroll: e.scrollWidth <= e.clientWidth, page: document.documentElement.scrollWidth }; });
      expect(box.left, `${width} px`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${width} px`).toBeLessThanOrEqual(width);
      expect(box.scroll, `${width} px`).toBe(true);
      // the inspector's Run up to here of build: disabled, not-allowed too (its why is the note below it)
      await page.click(`${card} [data-wf-select="2"]`);
      const upTo = `${card} [data-wf-insp="2"] button[data-wf-needs-person="2"]`;
      expect(await page.$eval(upTo, (b) => (b as HTMLButtonElement).disabled)).toBe(true);
      expect(await cursorOf(page, upTo)).toBe('not-allowed');
      expect(problems).toEqual([]);
      await close();
    }

    // a Run whose request is on its way reads busy (progress) while it is, and is pressable again after (hello's Run: FAKE upmd
    // runs `echo hello > hello.txt` in the temporary project)
    const { page, close } = await open(ws, 1360);
    await page.click(`${card} [data-wf-select="3"]`);
    const hello = `${card} [data-wf-insp="3"] button[data-act="run"]`;
    expect(await cursorOf(page, hello)).toBe('pointer');
    const busy = await page.evaluate((sel) => new Promise<string[]>((done) => {
      const b = document.querySelector(sel) as HTMLButtonElement;
      const seen: string[] = [];
      const watch = new MutationObserver(() => { if (b.disabled) seen.push(`${getComputedStyle(b).cursor} ${b.getAttribute('aria-busy')}`); else { watch.disconnect(); done(seen); } });
      watch.observe(b, { attributes: true, childList: true, characterData: true, subtree: true });
      b.click();
    }), hello);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]).toBe('progress true');
    // once it has gone (the board drew the card again), the node's Run is pressable again, not busy
    await page.waitForFunction((sel) => { const b = document.querySelector(sel) as HTMLButtonElement | null; return !!b && !b.disabled; }, hello);
    await page.click(`${card} [data-wf-select="3"]`);
    expect(await page.$eval(hello, (b) => [(b as HTMLButtonElement).disabled, b.getAttribute('aria-busy'), getComputedStyle(b).cursor])).toEqual([false, null, 'pointer']);
    await close();
  }, 120_000);
});
