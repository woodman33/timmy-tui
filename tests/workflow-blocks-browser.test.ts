// Round R4 (H74): what the connected workflow card adds for per-block receipts and NEEDS YOU, in a real headless Chromium
// (the one tests/board-live-browser.test.ts uses; skipped when none is found), in a fresh browser context, against the
// Workspace's live board on 127.0.0.1, with real files in a temporary project: a node whose run reaches a risky block says
// it needs you; the board's Run of it is refused before anything runs and listed in the Control Room's "Waiting on you"
// with the command to type in the REPL; the note does not take the block editor's row of dependencies' look (nor the
// other way round); and a safe run's run bar, inspector and operation card name each block's own receipt.
// Workflow runs use tests/fixtures/fake-upmd.mjs, a labelled TEST DOUBLE of upmd 0.2.7's --ci protocol (it is not upmd);
// its blocks only write files in the temporary project. No paid call, no network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { BLOCK_RECEIPT_KIND } from '../src/workflows/block-receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('workflow-blocks-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

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

function make() {
  const root = temp('h74-browser-');
  put(root, 'RISKY.md', DOC);
  put(root, 'dist/keep.txt', 'kept\n');
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: () => null,
    notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
    jobsDir: join(temp('h74-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, root, sealed };
}

/** A CSS colour token (#rrggbb) as the browser computes it. */
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

describe.skipIf(!browserPath)('per-block receipts and NEEDS YOU on the connected workflow card (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath, timeout: 60_000 }); }, 90_000);
  afterAll(async () => { await browser?.close(); });

  async function open(ws: Workspace): Promise<{ page: Page; problems: string[]; close: () => Promise<void> }> {
    await ws.boardLive('live');
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    await page.waitForSelector(`${card} [data-wf-node="3"]`);
    return { page, problems, close: () => context.close() };
  }
  const card = '[data-wfx="RISKY.md"]';

  it('a node whose run reaches a risky block says it needs you; the board\'s Run is refused before anything runs and waits on you with the command; the block editor keeps its own look', async () => {
    const { ws, root, sealed } = make();
    const { page, problems, close } = await open(ws);
    await page.click(`${card} [data-wf-select="2"]`);
    const note = `${card} [data-wf-insp="2"] [data-wf-needs-you="2"]`;
    const words = (await page.textContent(note)) ?? '';
    expect(words.startsWith('needs you clean (rm -rf dist): a destructive shell command on this machine.')).toBe(true);
    expect(words).toContain('asks first in the REPL\'s NEEDS YOU box, once, before anything runs (upmd runs a block only after the blocks it needs, with no stop between them).');
    expect(words).toContain('The board cannot show that box: its Run is refused and listed in Waiting on you with the command to type in the REPL.');
    // clean's own node says so too; hello, which reaches no risky block, does not
    expect(await page.$$(`${card} [data-wf-insp="1"] [data-wf-needs-you="1"]`)).toHaveLength(1);
    expect(await page.$$(`${card} [data-wf-insp="3"] [data-wf-needs-you]`)).toHaveLength(0);
    // its look: a paragraph with the attention rule at its left (a word, never a colour alone: "needs you")
    const look = await page.$eval(note, (e) => { const s = getComputedStyle(e); return [s.display, s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor]; });
    expect(look).toEqual(['block', '3px', 'solid', rgb(HOMEBREW.attention)]);

    // Run up to here: refused before anything runs, with the command to type in the REPL
    await page.click(`${card} [data-wf-insp="2"] button[data-act="run"]`);
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('board /run RISKY.md build'));
    expect(await page.textContent('#out')).toContain('Not run: clean (rm -rf dist) is a destructive shell command on this machine, which needs a person, and the board cannot ask you. Type this in the REPL instead: /run RISKY.md build');
    expect(ws.jobs.list()).toEqual([]);
    expect(sealed).toEqual([]);
    expect(readFileSync(join(root, 'dist', 'keep.txt'), 'utf8')).toBe('kept\n');

    // the Control Room's Waiting on you lists it on its next draw: the exact command, no keys (the board has no box)
    const title = 'NEEDS YOU: /run RISKY.md build from the board (clean: rm -rf dist)';
    await page.waitForFunction((t) => [...document.querySelectorAll('ol.decisions li.dec-approval .dec-title')].some((e) => e.textContent === t), title, { timeout: 10_000 });
    const item = await page.evaluate((t) => {
      const li = [...document.querySelectorAll('ol.decisions li.dec-approval')].find((e) => e.querySelector('.dec-title')?.textContent === t)!;
      return { kind: li.querySelector('.dec-kind')?.textContent, cmds: li.querySelector('.cmds')?.textContent, keys: li.querySelectorAll('kbd').length, text: li.textContent ?? '' };
    }, title);
    expect(item).toMatchObject({ kind: 'blocks a requested run', cmds: '/run RISKY.md build', keys: 0 });
    expect(item.text).toContain('type the command below in the REPL and answer its NEEDS YOU box: the board cannot show the box, so its Run was refused and nothing ran');
    expect(item.text).toContain('upmd would run clean → build, and clean runs a destructive shell command on this machine: rm -rf dist');

    // the block editor's row of dependencies ("needs") keeps its own look: no attention rule from the note above
    await page.click(`${card} [data-wf-edit]`);
    await page.waitForSelector(`${card} .wf-editor [data-needs]`);
    const rows = await page.$$eval(`${card} .wf-editor [data-needs]`, (els) => els.map((e) => { const s = getComputedStyle(e); return [s.display, s.borderLeftWidth]; }));
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toEqual(['flex', '0px']);
    expect(problems).toEqual([]);
    await close();
  }, 60_000);

  it('a run of a safe block: its run bar, its inspector and its operation card name the block\'s own receipt', async () => {
    const { ws, root, sealed } = make();
    const { page, problems, close } = await open(ws);
    await page.click(`${card} [data-wf-select="3"]`);
    expect(await page.textContent(`${card} [data-wf-insp="3"] button[data-act="run"]`)).toBe('Run this block');
    await page.click(`${card} [data-wf-insp="3"] button[data-act="run"]`);
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('board /run RISKY.md hello'));
    const job = ws.jobs.list().find((j) => j.label === 'RISKY.md › hello')!;
    await ws.jobs.done(job.id);
    // what Timmy sealed: the prediction, hello's own receipt, the run's (which names it)
    await expect.poll(() => sealed.map((s) => s.kind), { timeout: 10_000 }).toEqual(['predict', BLOCK_RECEIPT_KIND, 'workflow']);
    expect(sealed[1]).toMatchObject({ block: { name: 'hello', outcome: 'completed', exit_code: 0 } });
    expect(sealed[2]).toMatchObject({ child_receipts: ['00000001'] });
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello\n');
    // the run bar, drawn again after the run: each block's receipt by its short id
    await page.waitForFunction(() => (document.querySelector('[data-wfx="RISKY.md"] .wfx-run-blocks')?.textContent ?? '') === 'block hello: receipt 00000001', undefined, { timeout: 10_000 });
    expect(await page.textContent(`${card} [data-wf-insp="3"] .wf-last`)).toContain('block hello: receipt 00000001');
    // the Control Room's operation card: hello's step with its receipt
    const step = await page.evaluate(() => [...document.querySelectorAll('.room li.op-step')].find((e) => e.querySelector('.op-step-name')?.textContent === 'hello')?.textContent ?? '');
    expect(step).toContain('receipt 00000001');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await close();
  }, 60_000);
});
