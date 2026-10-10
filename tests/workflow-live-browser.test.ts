// Round R4 (H58, ledger row 157): the connected workflow card's block states change in place as a run goes, in a real
// headless Chromium (the one tests/board-live-browser.test.ts uses; skipped when none is found), against the Workspace's
// live board on 127.0.0.1, with a real temporary project. The run goes through workers/upmd/pty_run.py with this machine's
// python3 and tests/fixtures/fake-upmd.mjs in its pty mode, a labelled TEST DOUBLE of upmd 0.2.7 (it is not upmd) whose
// blocks really sleep: each block reads running while it runs, then completed or failed with its exit and its own time,
// and the block after a failure reads not run; the page is not drawn again meanwhile (something else on it is being
// edited), so every change is made in place. No paid call, no network.
import { spawnSync } from 'node:child_process';
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
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!browserPath || !PYTHON3) console.warn('workflow-live-browser: no Chromium or no python3 here, so the in-place checks are skipped');

const F = '```';
const DOC = [
  '# Live states', '', 'Three blocks: the second fails, so the third never runs.', '',
  `${F}bash [name:first]`, 'echo "first starts"', 'sleep 3', 'echo "first done"', F, '',
  `${F}bash [name:second, deps:first]`, 'echo "second starts"', 'sleep 3', 'exit 3', F, '',
  `${F}bash [name:third, deps:second]`, 'echo never', F, '',
].join('\n');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!browserPath || !PYTHON3)('live block states on the card, in place, in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('running, then completed with its own time; the failing block failed with its exit; the rest not run; never drawn again meanwhile', async () => {
    const root = temp('h58-browser-');
    put(root, 'LIVE.md', DOC);
    const sealed: ReceiptInput[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null),
      notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
      seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
      jobsDir: join(temp('h58-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
      receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
    }, folderProject(root));
    spaces.push(ws);
    await ws.boardLive('live');
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const card = '[data-wfx="LIVE.md"]';
    await page.waitForSelector(`${card} [data-wf-node="3"]`);
    const node = (key: string): Promise<string> => page.textContent(`${card} [data-wf-node="${key}"] .wf-state`).then((t) => t ?? '');
    const waitNode = (key: string, test: string, timeout = 15_000) => page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent ?? ''), [`${card} [data-wf-node="${key}"] .wf-state`, test] as const, { timeout });
    // live states are available here: the card does not say otherwise
    expect(await page.textContent(card)).not.toContain('Live block states are not available');

    // the tray recipe's card is being edited (not saved): the live board does not draw its sections over it
    await page.fill('#parameters ~ .grid [data-params="tray"] [data-param="width"]', '150');
    // marks on what is drawn now: if anything were drawn again, a mark would be gone
    await page.evaluate((c) => { for (const el of document.querySelectorAll(`${c} [data-wf-node] .wf-state, ${c} .wfx-run, ${c} [data-wf-select]`)) el.setAttribute('data-h58', 'kept'); }, card);
    const marks = (): Promise<number> => page.$$eval(`${card} [data-h58="kept"]`, (els) => els.length);
    const marked = await marks();
    expect(marked).toBeGreaterThanOrEqual(7);

    await page.click(`${card} [data-wf-select="3"]`);
    await page.click(`${card} [data-wf-insp="3"] button[data-act="run"]`);
    await waitNode('1', '^● running$');
    expect(await node('2')).toBe('○ waiting');
    expect(await node('3')).toBe('○ waiting');
    expect(await page.textContent(`${card} [data-wf-select="1"] .wf-chip-state`)).toBe('running');
    expect(await page.textContent(`${card} [data-wf-insp="1"] .wf-insp-head .wf-word strong`)).toBe('running');
    // first ends after its 3 s: completed, with its exit and its own time; second runs
    await waitNode('1', '^✓ completed · exit 0 · [3-9]\\.\\d s$');
    await waitNode('2', '^● running$');
    // second fails with exit 3 after its 3 s; third, after the failure, is not run
    await waitNode('2', '^✕ failed · exit 3 · [3-9]\\.\\d s$');
    await waitNode('3', '^– not run$');
    expect(await page.textContent(`${card} [data-wf-insp="2"] .wf-insp-head .wf-word strong`)).toBe('failed');
    expect(await page.getAttribute(`${card} [data-wf-node="2"] .wf-box`, 'class')).toContain('wfs-failed');
    expect(await page.textContent(`${card} [data-wf-select="3"] .wf-chip-state`)).toBe('not run');
    // every change was made in place: the marks are all still there, and so is the unsaved value
    expect(await marks()).toBe(marked);
    expect(await page.inputValue('#parameters ~ .grid [data-params="tray"] [data-param="width"]')).toBe('150');
    // the run's record: the moments its blocks were seen, upmd's own exit
    const job = ws.jobs.list().find((j) => j.label === 'LIVE.md › third')!;
    expect((await ws.jobs.done(job.id))).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(problems).toEqual([]);
    await context.close();
  }, 90_000);
});
