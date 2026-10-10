// Round R4 (H22): the live board's parameter form and workflow node editor in a real headless Chromium (the one
// tests/board-live-browser.test.ts uses; skipped when none is found), in a fresh browser context, against the
// Workspace's live board on 127.0.0.1, writing real files in a temporary project. No workflow block is run here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-nodes-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const F = '```';
const DOC = [
  '# Build', '', 'Prose that stays.', '',
  `${F}bash [name:setup]`, 'mkdir -p dist', F, '',
  `${F}bash [name:build, deps:setup]`, 'echo built > dist/out.txt', F, '',
  `${F}bash [name:verify, deps:build]`, 'test -f dist/out.txt', F, '',
].join('\n');
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
  const root = temp('board-nodes-browser-');
  put(root, 'BUILD.md', DOC);
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') },
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
  return { ws, root, notes, sealed };
}

describe.skipIf(!browserPath)('editing on the live board in a real browser (headless Chromium, a fresh context)', () => {
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
    await page.waitForSelector('[data-wf-edit]');
    return { page, problems, close: () => context.close() };
  }

  it('saves parameters from the form: Rebuild waits while unsaved, the file is written, and the card redraws with it', async () => {
    const { ws, root, notes } = make();
    const { page, problems, close } = await open(ws);
    await page.fill('[data-param="width"]', '165');
    expect(await page.isDisabled('button[data-act="rebuild"]')).toBe(true);
    expect(await page.textContent('[data-params-msg]')).toContain('Not saved yet');
    await page.click('[data-params-save]');
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('Saved recipes/tray.params.json'));
    expect(await page.textContent('#out')).toContain('width 140 → 165');
    const file = readFileSync(join(root, 'recipes/tray.params.json'));
    expect(JSON.parse(file.toString()).parameters).toEqual({ width: 165, wall: 3, supportOffset: 10, bore: 3 });
    // The card is drawn again from the saved file (no longer being edited), and Rebuild is offered again.
    await page.waitForFunction((h) => document.querySelector('[data-params]')?.getAttribute('data-params-base') === h, sha(file), { timeout: 6000 });
    expect(await page.inputValue('[data-param="width"]')).toBe('165');
    expect(await page.isDisabled('button[data-act="rebuild"]')).toBe(false);
    expect(notes.some((n) => n.startsWith('  board  saved recipes/tray.params.json: width 140 → 165'))).toBe(true);
    // A value the recipe refuses: the page shows why, the file stays as saved.
    await page.fill('[data-param="bore"]', '50');
    await page.click('[data-params-save]');
    await page.waitForFunction(() => (document.querySelector('[data-params-msg]')?.textContent ?? '').startsWith('Refused:'));
    expect(await page.getAttribute('[data-params-msg]', 'class')).toContain('bad');
    expect(readFileSync(join(root, 'recipes/tray.params.json'))).toEqual(file);
    // Discard puts the saved values back.
    await page.click('[data-params-discard]');
    expect(await page.inputValue('[data-param="bore"]')).toBe('3');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    // The one console line is the browser's own note of the refused save (its 422); no script or CSP error.
    expect(problems).toEqual(['Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)']);
    await close();
  }, 30_000);

  it('edits a workflow as nodes: rename, remove, add with a need, Save; the document is rewritten and the graph redrawn', async () => {
    const { ws, root, sealed } = make();
    const { page, problems, close } = await open(ws);
    await page.click('[data-wf-edit]');
    const rows = page.locator('[data-wf-doc="BUILD.md"] [data-row]');
    expect(await rows.count()).toBe(3);
    await rows.nth(0).locator('[data-field="name"]').fill('init');
    // The rename follows into the other blocks' needs.
    expect(await rows.nth(1).locator('.wf-need').allTextContents()).toEqual([' init', ' verify']);
    expect(await rows.nth(1).locator('input[data-need]').first().isChecked()).toBe(true);
    await rows.nth(2).locator('[data-wf-remove]').click();
    expect(await rows.count()).toBe(2);
    await page.click('[data-wf-add]');
    expect(await rows.count()).toBe(3);
    const added = rows.nth(2);
    expect(await added.locator('[data-field="name"]').inputValue()).toBe('step-3');
    await added.locator('[data-field="command"]').fill('echo lint');
    await added.locator('label.wf-need', { hasText: 'build' }).locator('input').check();
    await page.click('[data-wf-save]');
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('Saved BUILD.md'));
    const said = (await page.textContent('#out'))!;
    expect(said).toContain('renamed setup to init');
    expect(said).toContain('added step-3 (needs build)');
    expect(said).toContain('removed verify');
    const after = readFileSync(join(root, 'BUILD.md'), 'utf8');
    expect(parseWorkflow(after).filter((b) => b.name).map((b) => [b.name, b.deps, b.code])).toEqual([['init', [], 'mkdir -p dist'], ['build', ['init'], 'echo built > dist/out.txt'], ['step-3', ['build'], 'echo lint']]);
    expect(after.startsWith('# Build\n\nProse that stays.\n')).toBe(true);
    expect(sealed.at(-1)).toMatchObject({ kind: 'edit', files: [{ path: 'BUILD.md', previous_sha256: sha(DOC) }] });
    // The board redraws the graph from the new document.
    await page.waitForFunction(() => [...document.querySelectorAll('.wf-name')].map((t) => t.textContent).join(',') === 'init,build,step-3', undefined, { timeout: 6000 });
    expect(await page.locator('button[data-act="run"][data-block="step-3"]').count()).toBe(1);
    expect(problems).toEqual([]);
    await close();
  }, 30_000);

  it('does not redraw over an open editor; a save over a document changed on disk is refused and the edits stay', async () => {
    const { ws, root } = make();
    const { page, problems, close } = await open(ws);
    await page.click('[data-wf-edit]');
    await page.locator('[data-row] [data-field="command"]').first().fill('mkdir -p dist build');
    // Something else changes the board (a new reference): the page does not draw over the editor.
    put(root, 'refs/new.txt', 'a new reference');
    await page.waitForTimeout(2600);
    expect(await page.locator('[data-row]').count()).toBe(3);
    expect(await page.locator('[data-row] [data-field="command"]').first().inputValue()).toBe('mkdir -p dist build');
    expect(await page.locator('text=refs/new.txt').count()).toBe(0);
    // The document changes on disk under the editor: Save is refused, nothing is written over it.
    const changed = DOC.replace('Prose that stays.', 'Prose edited elsewhere.');
    put(root, 'BUILD.md', changed);
    await page.click('[data-wf-save]');
    await page.waitForFunction(() => (document.querySelector('[data-wf-msg]')?.textContent ?? '').includes('changed since the board read it'));
    expect(readFileSync(join(root, 'BUILD.md'), 'utf8')).toBe(changed);
    expect(await page.locator('[data-row] [data-field="command"]').first().inputValue()).toBe('mkdir -p dist build');
    // Discard closes the editor, and the board is drawn as it is now.
    await page.click('[data-wf-discard]');
    await page.waitForSelector('text=refs/new.txt', { timeout: 6000 });
    expect(await page.locator('.wf-editor:not([hidden])').count()).toBe(0);
    // The one console line is the browser's own note of the refused save (its 409); no script or CSP error.
    expect(problems).toEqual(['Failed to load resource: the server responded with a status of 409 (Conflict)']);
    await close();
  }, 30_000);
});
