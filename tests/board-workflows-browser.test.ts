// Round R4 (H47): the connected workflow card in a real headless Chromium (the one tests/board-live-browser.test.ts uses;
// skipped when none is found), in a fresh browser context, against the Workspace's live board on 127.0.0.1, with real
// files in a temporary project: select a node from the graph and from the prose, edit an OpenSCAD parameter, run a block,
// see each block's state in words, edit a command, stop a run; and the snapshot's chips opening their block's details.
// Workflow runs use tests/fixtures/fake-upmd.mjs, a labelled TEST DOUBLE of upmd 0.2.7's --ci protocol (it is not upmd);
// its blocks only sleep, echo and write files in the temporary project. No paid call, no network.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-workflows-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const F = '```';
const DOC = [
  '# Tray build', '', 'Check `box.params.json`, build, then verify. See [the model](box.scad).', '',
  `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
  '## Build', '', 'The build reads the parameters:', '',
  `${F}bash [name:build, deps:setup]`, 'cat box.params.json > dist/params.txt', 'sleep 4', 'echo built > dist/out.txt', F, '',
  `${F}sh [name:verify, deps:build]`, 'test -f dist/out.txt', F, '',
  `${F}bash [name:wait]`, 'sleep 30', F, '',
].join('\n');
const PARAMS = `${JSON.stringify({ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: { width: 60, part: 'both', lid: true } }, null, 2)}\n`;
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function make() {
  const root = temp('board-wfx-browser-');
  put(root, 'BUILD.md', DOC);
  put(root, 'box.scad', 'width = 60;\npart = "both";\nlid = true;\ncube([width, 40, 10]);\n');
  put(root, 'box.params.json', PARAMS);
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return String(sealed.length - 1).padStart(8, '0'); },
    jobsDir: join(temp('jobs-'), 'jobs'), chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}${'0'.repeat(56)}` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return { ws, root, notes, sealed };
}

describe.skipIf(!browserPath)('the connected workflow card in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  async function open(ws: Workspace): Promise<{ page: Page; problems: string[]; close: () => Promise<void> }> {
    await ws.boardLive('live');
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    await page.waitForSelector('[data-wfx="BUILD.md"] [data-wf-node="1"]');
    return { page, problems, close: () => context.close() };
  }
  const card = '[data-wfx="BUILD.md"]';
  const shown = (page: Page): Promise<string[]> => page.$$eval(`${card} [data-wf-insp]`, (els) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => e.getAttribute('data-wf-insp')!));
  const pressed = (page: Page, sel: string): Promise<string | null> => page.getAttribute(`${card} ${sel}`, 'aria-pressed');
  const nodeWords = (page: Page, key: string): Promise<string> => page.textContent(`${card} [data-wf-node="${key}"] .wf-state`).then((t) => t ?? '');

  it('selects the same block from the graph, from the prose and with the keyboard; edits an OpenSCAD parameter; runs a block and shows each state in words', async () => {
    const { ws, root, notes, sealed } = make();
    const { page, problems, close } = await open(ws);
    expect(await shown(page)).toEqual(['1']);
    // a node in the graph
    await page.click(`${card} [data-wf-node="2"]`);
    expect(await shown(page)).toEqual(['2']);
    expect(await pressed(page, '[data-wf-node="2"]')).toBe('true');
    expect(await pressed(page, '[data-wf-select="2"]')).toBe('true');
    expect(await pressed(page, '[data-wf-node="1"]')).toBe('false');
    expect(await page.textContent(`${card} [data-wf-insp="2"] .wf-insp-name`)).toBe('build');
    // a chip in the instructions selects the same key
    await page.click(`${card} [data-wf-select="3"]`);
    expect(await shown(page)).toEqual(['3']);
    expect(await pressed(page, '[data-wf-node="3"]')).toBe('true');
    // the keyboard: a node is a control
    await page.focus(`${card} [data-wf-node="1"]`);
    await page.keyboard.press('Enter');
    expect(await shown(page)).toEqual(['1']);

    // build's inspector: the OpenSCAD parameter file its command names, found by a plain match of its path
    await page.click(`${card} [data-wf-select="2"]`);
    const panel = `${card} [data-wf-insp="2"]`;
    expect(await page.textContent(`${panel} .wf-params`)).toContain('box.params.json: found by a plain match of each file\'s path in the command\'s text.');
    expect(await page.isDisabled(`${panel} [data-scad-save]`)).toBe(true);
    await page.fill(`${panel} [data-scad-param="width"]`, '80');
    expect(await page.textContent(`${panel} [data-scad-params] tr[data-edited] [data-param-change]`)).toBe(' → 80');
    // while it is not saved, Run waits (it reads the saved file)
    expect(await page.isDisabled(`${panel} button[data-act="run"]`)).toBe(true);
    expect(await page.getAttribute(`${panel} button[data-act="run"]`, 'title')).toBe('Save first: Run uses the saved files');
    await page.click(`${panel} [data-scad-save]`);
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('Saved box.params.json'));
    expect(await page.textContent('#out')).toContain('width 60 → 80');
    const saved = readFileSync(join(root, 'box.params.json'));
    expect(JSON.parse(saved.toString()).parameters).toEqual({ width: 80, part: 'both', lid: true });
    expect(sealed.at(-1)).toMatchObject({ kind: 'edit', files: [{ path: 'box.params.json', previous_sha256: sha(PARAMS) }] });
    expect(notes.some((n) => n.startsWith('  board  saved box.params.json: width 60 → 80'))).toBe(true);
    // the board draws the card again from the saved file; the operator's selection stays, and Run is offered again
    await page.waitForFunction((h) => document.querySelector('[data-scad-params]')?.getAttribute('data-scad-base') === h, sha(saved), { timeout: 8000 });
    expect(await shown(page)).toEqual(['2']);
    expect(await page.isDisabled(`${panel} button[data-act="run"]`)).toBe(false);

    // Run up to here: upmd runs setup, then build; each block's state in words on the graph, the chips and the run bar
    expect(await page.textContent(`${panel} button[data-act="run"]`)).toBe('Run up to here');
    await page.click(`${panel} button[data-act="run"]`);
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('board /run BUILD.md build'));
    await page.waitForFunction(() => (document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="2"] .wf-state')?.textContent ?? '') === '● running', undefined, { timeout: 10_000 });
    expect(await nodeWords(page, '1')).toMatch(/^✓ completed · exit 0/);
    expect(await page.textContent(`${card} [data-wf-select="2"] .wf-chip-state`)).toBe('running');
    expect(await page.textContent(`${card} .wfx-run`)).toContain('setup completed, build running');
    expect(await shown(page)).toEqual(['2']);
    await page.waitForFunction(() => /^✓ completed · exit 0/.test(document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="2"] .wf-state')?.textContent ?? ''), undefined, { timeout: 15_000 });
    expect(await page.textContent(`${card} [data-wf-select="2"] .wf-chip-state`)).toBe('completed');
    expect(await nodeWords(page, '3')).toBe('· not run yet');
    expect(await page.textContent(`${panel} .wf-last`)).toContain('outcome receipt');
    expect(await page.textContent(`${panel} .wf-last`)).toContain('dist/params.txt');
    expect(readFileSync(join(root, 'dist/params.txt'), 'utf8')).toContain('"width": 80');
    expect(await shown(page)).toEqual(['2']);
    // the state is a word and a glyph, never a colour alone; an outcome is not drawn in the action green
    const colours = await page.$eval(`${card} [data-wf-node="2"] .wf-state`, (e) => getComputedStyle(e).fill);
    expect(colours).not.toBe('rgb(40, 254, 20)');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await close();
  }, 60_000);

  it('while something else on the board is being edited (no redraw), the blocks\' states still change in place, in words', async () => {
    const { ws } = make();
    const { page, problems, close } = await open(ws);
    // the tray recipe's card in the Parameters section, edited and not saved: the live board does not draw over it
    await page.fill('#parameters ~ .grid [data-params="tray"] [data-param="width"]', '150');
    expect(await page.getAttribute('#parameters ~ .grid [data-params="tray"]', 'data-editing')).toBe('');
    await page.click(`${card} [data-wf-select="4"]`);
    await page.click(`${card} [data-wf-insp="4"] button[data-act="run"]`);
    await page.waitForFunction(() => (document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="4"] .wf-state')?.textContent ?? '') === '● running', undefined, { timeout: 10_000 });
    expect(await page.textContent(`${card} [data-wf-select="4"] .wf-chip-state`)).toBe('running');
    expect(await page.textContent(`${card} [data-wf-insp="4"] .wf-insp-head .wf-word strong`)).toBe('running');
    expect(await page.getAttribute(`${card} [data-wf-node="4"] .wf-box`, 'class')).toContain('wfs-running');
    // not drawn again: the unsaved value is still there
    expect(await page.inputValue('#parameters ~ .grid [data-params="tray"] [data-param="width"]')).toBe('150');
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › wait')!;
    expect((await ws.stop(job.id)).map((l) => l.map((x) => x.text).join('')).join('\n')).toContain('stopped');
    await page.waitForFunction(() => (document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="4"] .wf-state')?.textContent ?? '') === '■ stopped', undefined, { timeout: 10_000 });
    expect(await page.inputValue('#parameters ~ .grid [data-params="tray"] [data-param="width"]')).toBe('150');
    expect(problems).toEqual([]);
    await close();
  }, 60_000);

  it("edits a block's command in the inspector (save-workflow); Stop in the run bar stops a run through the Jobs section's Stop", async () => {
    const { ws, root, sealed } = make();
    const { page, problems, close } = await open(ws);
    await page.click(`${card} [data-wf-select="3"]`);
    const panel = `${card} [data-wf-insp="3"]`;
    await page.fill(`${panel} [data-wf-cmd]`, 'test -f dist/out.txt && echo verified');
    expect(await page.textContent(`${panel} [data-wf-cmd-msg]`)).toContain('Not saved yet');
    // while the command is not saved: the card is not drawn over, Run waits and the block editor stays closed
    expect(await page.getAttribute(card, 'data-editing')).toBe('');
    expect(await page.isDisabled(`${panel} button[data-act="run"]`)).toBe(true);
    expect(await page.isDisabled(`${card} [data-wf-edit]`)).toBe(true);
    await page.click(`${panel} [data-wf-cmd-save]`);
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('Saved BUILD.md'));
    expect(await page.textContent('#out')).toContain("edited verify's command (1 → 1 line)");
    const after = readFileSync(join(root, 'BUILD.md'), 'utf8');
    expect(parseWorkflow(after).filter((b) => b.name).map((b) => [b.name, b.code])).toEqual([
      ['setup', 'mkdir -p dist'], ['build', 'cat box.params.json > dist/params.txt\nsleep 4\necho built > dist/out.txt'], ['verify', 'test -f dist/out.txt && echo verified'], ['wait', 'sleep 30'],
    ]);
    expect(after.startsWith('# Tray build\n\nCheck `box.params.json`, build, then verify.')).toBe(true);
    expect(sealed.at(-1)).toMatchObject({ kind: 'edit', files: [{ path: 'BUILD.md', previous_sha256: sha(DOC) }] });
    await page.waitForFunction((h) => document.querySelector('[data-wfx="BUILD.md"]')?.getAttribute('data-wf-sha') === h, sha(after), { timeout: 8000 });
    expect(await shown(page)).toEqual(['3']);

    // a long block, then Stop from the run bar: the existing /stop path (the Jobs section's own Stop button)
    await page.click(`${card} [data-wf-select="4"]`);
    await page.click(`${card} [data-wf-insp="4"] button[data-act="run"]`);
    await page.waitForFunction(() => (document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="4"] .wf-state')?.textContent ?? '') === '● running', undefined, { timeout: 10_000 });
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › wait')!;
    await page.click(`${card} [data-wf-stop="${job.id}"]`);
    await page.waitForFunction((id) => (document.getElementById('out')!.textContent ?? '').startsWith(`board /stop ${id}`), job.id, { timeout: 10_000 });
    await page.waitForFunction(() => (document.querySelector('[data-wfx="BUILD.md"] [data-wf-node="4"] .wf-state')?.textContent ?? '') === '■ stopped', undefined, { timeout: 10_000 });
    expect(ws.jobs.get(job.id)?.state).toBe('cancelled');
    expect(await page.textContent(`${card} .wfx-run`)).toContain('stopped');
    expect(problems).toEqual([]);
    await close();
  }, 60_000);

  it('the snapshot: a chip or a node opens its block\'s details; the page has its one copying script and no other', async () => {
    const { ws, root } = make();
    ws.board('');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(pathToFileURL(join(root, '.timmy/board/index.html')).href);
    const opened = (): Promise<boolean[]> => page.$$eval(`${card} details.wf-insp`, (els) => els.map((e) => (e as HTMLDetailsElement).open));
    expect(await opened()).toEqual([false, false, false, false]);
    await page.click(`${card} a.wf-chip:has-text("verify")`);
    expect(await opened()).toEqual([false, false, true, false]);
    await page.click(`${card} a.wf-node-link >> nth=1`);
    expect(await opened()).toEqual([false, true, true, false]);
    expect(await page.$$eval('script', (s) => s.length)).toBe(1);
    expect(await page.$$('[data-wf-node], [data-act]')).toHaveLength(0);
    expect(problems).toEqual([]);
    await context.close();
  }, 30_000);
});
