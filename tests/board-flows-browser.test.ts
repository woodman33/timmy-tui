// Round R4 (H45): the board's flow cards on the live board in a real headless Chromium (the one
// tests/board-live-browser.test.ts uses; skipped when none is found), in a fresh browser context, against the Workspace's
// live board on 127.0.0.1. The flow records are FAKE (tests/fixtures/fake-flow-records.ts: synthetic, written by hand; no
// agent, app or readback ran for them). The running flow in the third test is started by /iterate with
// tests/fixtures/fake-code-agent.mjs, a labelled TEST DOUBLE that only sleeps in its agent step; TIMMY_CADQUERY_PYTHON
// names a FAKE program that is never run (the flow is stopped in its agent step). The last test draws a snapshot whose
// flow receipts are FAKE too (made up in the test; nothing was sealed), only so that its cards are drawn verified.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { renderBoard } from '../src/repl/board.js';
import { readBoardFlows } from '../src/repl/board-flows.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { fakeAe, fakeBlender, fakeTray, fakeTrayFailed, type FakeRecord } from './fixtures/fake-flow-records.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-flows-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const record = (root: string, r: FakeRecord): void => put(root, `results/flows/${r.id}.json`, `${JSON.stringify(r, null, 2)}\n`);
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
async function until(pred: () => boolean, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make(root: string, extra: Partial<WorkspaceDeps> = {}): Workspace {
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('flows-browser-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return ws;
}

const card = (id: string): string => `article.card.flow:has(.jobhead strong:text-is("${id}"))`;
const isOpen = (page: Page, key: string): Promise<boolean> => page.$eval(`details[data-keep="${key}"]`, (d) => (d as HTMLDetailsElement).open);

describe.skipIf(!browserPath)('the flow cards on the live board in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  async function open(ws: Workspace): Promise<{ page: Page; problems: string[]; close: () => Promise<void> }> {
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    return { page, problems, close: () => context.close() };
  }

  it('the strip says each step\'s state in words; a <details> the operator opened or closed stays so across redraws, the others keep their defaults', async () => {
    const root = temp('flows-browser-');
    record(root, fakeTray());
    record(root, fakeTrayFailed());
    const ws = make(root);
    const { page, problems, close } = await open(ws);
    await page.waitForSelector(`${card('f0000a001')} ol.strip`);
    // The strip, as a reader gets it: an ordered list named for the flow, each step's name and state as text.
    const steps = page.getByRole('list', { name: 'the steps of flow f0000a001' }).getByRole('listitem');
    expect(await steps.count()).toBe(4);
    expect((await steps.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
      '✓ agent completed qwen · job j0a0001', '✓ checks completed width 140 → 180', '✓ build completed recipe job 1a2b3c4d · succeeded',
      '✓ readback completed ended here: succeeded matches · job j0a0003',
    ]);
    expect(await page.textContent(`${card('f0000a002')} li[aria-current="step"]`)).toContain('build failed ended here: failed');
    expect(await page.textContent(`${card('f0000a002')} ol.strip li:last-child`)).toContain('readback not run');
    // Defaults: closed for the flow that succeeded, open for the one that failed.
    expect(await isOpen(page, 'f0000a001:checks')).toBe(false);
    expect(await isOpen(page, 'f0000a002:steps')).toBe(true);
    // The operator opens one and closes another.
    await page.click(`details[data-keep="f0000a001:checks"] > summary`);
    await page.click(`details[data-keep="f0000a002:steps"] > summary`);
    expect(await isOpen(page, 'f0000a001:checks')).toBe(true);
    expect(await isOpen(page, 'f0000a002:steps')).toBe(false);
    // A new flow record changes the board: the page draws its sections again (new elements, as the mark shows).
    await page.$eval('details[data-keep="f0000a001:checks"]', (d) => d.setAttribute('data-before-redraw', ''));
    record(root, fakeBlender());
    await page.waitForSelector(`${card('f0000b001')}`, { timeout: 8000 });
    expect(await page.locator('[data-before-redraw]').count()).toBe(0);
    expect(await isOpen(page, 'f0000a001:checks')).toBe(true);
    expect(await isOpen(page, 'f0000a002:steps')).toBe(false);
    // Untouched ones keep their defaults: closed, open, and the new card's (it differs) open.
    expect(await isOpen(page, 'f0000a001:files')).toBe(false);
    expect(await isOpen(page, 'f0000a002:files')).toBe(true);
    expect(await isOpen(page, 'f0000a002:change')).toBe(true);
    expect(await page.locator('details[data-keep="f0000a002:checks"]').count()).toBe(0);
    expect(await isOpen(page, 'f0000b001:checks')).toBe(true);
    // And again, after another redraw (a new reference file).
    put(root, 'refs/new.txt', 'a new reference');
    await page.waitForSelector('text=refs/new.txt', { timeout: 8000 });
    expect(await isOpen(page, 'f0000a001:checks')).toBe(true);
    expect(await isOpen(page, 'f0000a002:steps')).toBe(false);
    // Nothing kept outside the page; no script or CSP error (no inline style, no handler).
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await close();
  }, 30_000);

  it("the parameter form: the saved value beside each input, an edited field's before → after, Save only while a value differs", async () => {
    const root = temp('flows-browser-params-');
    const ws = make(root);
    const { page, problems, close } = await open(ws);
    await page.waitForSelector('[data-params]');
    const width = 'tr:has([data-param="width"])';
    expect(await page.textContent(`${width} td.saved`)).toBe('140');
    expect(await page.isDisabled('[data-params-save]')).toBe(true);
    await page.fill('[data-param="width"]', '165');
    expect(await page.textContent(`${width} [data-param-change]`)).toBe(' → 165');
    expect(await page.getAttribute(width, 'data-edited')).toBe('');
    expect(await page.isDisabled('[data-params-save]')).toBe(false);
    expect(await page.isDisabled('button[data-act="rebuild"]')).toBe(true);
    // Typed back to the drawn value: nothing differs, the card is clean again.
    await page.fill('[data-param="width"]', '140.0');
    expect(await page.textContent(`${width} [data-param-change]`)).toBe('');
    expect(await page.isDisabled('[data-params-save]')).toBe(true);
    expect(await page.isDisabled('button[data-act="rebuild"]')).toBe(false);
    expect(await page.isHidden('[data-params-msg]')).toBe(true);
    // Discard puts the drawn values back and Save away.
    await page.fill('[data-param="bore"]', '4');
    expect(await page.isDisabled('[data-params-save]')).toBe(false);
    await page.click('[data-params-discard]');
    expect(await page.inputValue('[data-param="bore"]')).toBe('3');
    expect(await page.textContent('tr:has([data-param="bore"]) [data-param-change]')).toBe('');
    expect(await page.isDisabled('[data-params-save]')).toBe(true);
    expect(problems).toEqual([]);
    await close();
  }, 30_000);

  it('a flow that runs: its card from its state file with the step that runs; a save meanwhile is refused (409, said, Save kept); stopped, its record replaces the card', async () => {
    const root = temp('flows-browser-running-');
    const fakes = temp('flows-browser-fakes-');
    const python = join(fakes, 'python');
    writeFileSync(python, '#!/bin/sh\necho "FAKE: never run by this test"\nexit 1\n', { mode: 0o755 });
    const ws = make(root, { env: { TIMMY_AGENT_QWEN_BIN: resolve('tests/fixtures/fake-code-agent.mjs'), TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: python } });
    const out = text(await ws.iterate('tray "SLEEP PARAM:width=180"'));
    const id = /Flow\s+(f[0-9a-f]{8})/.exec(out)![1];
    const agent = /Agent\s+(j[0-9a-f]{6})/.exec(out)![1];
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    const { page, problems, close } = await open(ws);
    await page.waitForSelector(`${card(id)} ol.strip`);
    expect(await page.textContent(`${card(id)} .jobhead .state`)).toBe('running');
    expect(await page.textContent(`${card(id)} .status`)).toContain('no record yet: this card is drawn from its state file');
    expect((await page.textContent(`${card(id)} li[aria-current="step"]`))!.replace(/\s+/g, ' ')).toContain('agent running running now');
    expect(await page.textContent(`${card(id)} ol.strip li:last-child`)).toContain('readback waiting');
    // A save while the flow runs: refused by the board, said in the card, Save still offered.
    await page.fill('[data-param="width"]', '150');
    await page.click('[data-params-save]');
    await page.waitForFunction(() => (document.querySelector('[data-params-msg]')?.textContent ?? '').includes('is running in this project'));
    expect(await page.textContent('[data-params-msg]')).toBe(`flow ${id} is running in this project: save after it ends, or /stop it`);
    expect(await page.getAttribute('[data-params-msg]', 'class')).toContain('bad');
    expect(await page.isDisabled('[data-params-save]')).toBe(false);
    await page.click('[data-params-discard]');
    // Stopped: its record is written, and the board draws it in place of the running card.
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    await page.waitForFunction((fid) => !!document.querySelector('#flows-running') === false && [...document.querySelectorAll('article.card.flow .jobhead strong')].some((s) => s.textContent === fid), id, { timeout: 8000 });
    expect(await page.textContent(`${card(id)} .jobhead .state`)).toBe('cancelled');
    expect((await page.textContent(`${card(id)} li[aria-current="step"]`))!.replace(/\s+/g, ' ')).toContain('agent stopped ended here: cancelled');
    // The one console line is the browser's own note of the refused save (its 409); no script or CSP error.
    expect(problems).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
    await close();
  }, 60_000);

  it('green is for actions: on a flow card no outcome, verdict or seal is drawn green, and the commands are (a snapshot of FAKE records with FAKE receipts)', async () => {
    const root = temp('flows-browser-colours-');
    const sha = (b: string): string => createHash('sha256').update(b).digest('hex');
    const pid = 'fake-project-id';
    const receipts: unknown[] = [];
    for (const r of [fakeTray(), fakeAe()]) {
      record(root, r);
      const rel = `results/flows/${r.id}.json`;
      const body = `${JSON.stringify(r, null, 2)}\n`;
      // A FAKE flow receipt naming exactly these bytes (made up here: nothing was sealed), so both cards are drawn verified.
      receipts.push({ kind: 'flow', project_id: pid, hash: `sha256:${sha(`fake receipt ${r.id}`)}`, outputs: [{ path: rel, sha256: sha(body), bytes: body.length }] });
    }
    const flows = readBoardFlows(root, ['results/flows/f0000a001.json', 'results/flows/f0000e001.json'], { receipts: receipts as Receipt[], projectId: pid, scrub: (t) => t });
    put(root, '.timmy/board/index.html', renderBoard({ project: 'fake', madeAt: '2026-10-10 10:00 UTC', base: '../../', references: [], workflows: [], jobs: [], outputs: [], observations: [], flows }));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`file://${join(root, '.timmy/board/index.html')}`);
    const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const style = (sel: string, prop = 'color'): Promise<string> => page.$eval(sel, (e, p) => getComputedStyle(e).getPropertyValue(p), prop);
    const [tray, ae] = [card('f0000a001'), card('f0000e001')];
    // The words stay; their colour is the text's, not the green.
    expect(await page.textContent(`${tray} .jobhead .state`)).toBe('succeeded');
    expect(await style(`${tray} .jobhead .state`)).toBe(rgb(HOMEBREW.text));
    expect(await page.textContent(`${tray} .status-verified strong`)).toBe('verified');
    expect(await style(`${tray} .status-verified strong`)).toBe(rgb(HOMEBREW.text));
    expect(await style(`${tray} .vw-matches`)).toBe(rgb(HOMEBREW.text));
    expect(await style(`${ae} .status-verified strong`)).toBe(rgb(HOMEBREW.text));
    // Opened, the measured sections are ruled in grey, and the verdict there is in words too.
    await page.click(`details[data-keep="f0000a001:checks"] > summary`);
    expect(await style(`${tray} section.readback.measured`, 'border-left-color')).toBe(rgb(HOMEBREW.lineStrong));
    expect(await style(`${tray} section.readback.measured .verdict-matches`)).toBe(rgb(HOMEBREW.text));
    expect(await page.$eval('details[data-keep="f0000e001:checks"]', (d) => (d as HTMLDetailsElement).open)).toBe(true);
    expect(await style(`${ae} section.beforeafter.measured`, 'border-left-color')).toBe(rgb(HOMEBREW.lineStrong));
    // What differs keeps the failure colour; the commands (actions) are the green.
    expect(await style(`${ae} .vw-differs`)).toBe(rgb(HOMEBREW.failure));
    expect(await style(`${tray} button.cmd[data-cmd="/open results/flows/f0000a001.json"]`)).toBe(rgb(HOMEBREW.accent));
    await context.close();
  }, 30_000);
});
