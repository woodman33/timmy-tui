/**
 * R6 (H145, step 4b): a parameter node's values, edited through the existing parameter save path, in a real headless Chromium
 * against the real canvas server and the real bundle (built here into a temporary folder), a real temporary project
 * (tests/helpers/canvas-project.ts: an OpenSCAD model with its parameter file and the tray recipe's parameter file, written by
 * Timmy's own writers), and the REPL's side for real, as tests/studio-cards-browser.test.ts sets it up: a Workspace
 * (src/repl/workspace.ts) and a CanvasProject (src/repl/canvas-project.ts) that names the project with its holder id and takes
 * the cards' actions. The page is opened as /canvas open opens it (its one-time grant in the address's fragment). Receipts are
 * sealed by appendReceipt into a temporary store.
 *
 * A parameter node added from the palette (companion/studio-canvas/src/nodes.js) is the project's own parameter card. Its typed
 * values are saved by Save through the live board's save path: the REPL's set-scad-params and set-params check them with their
 * rules, keep the previous version, write the file and seal an edit receipt; the node is drawn again from the saved file. While
 * a flow holds the project, Save is refused in the REPL's own words and nothing is written: the file's bytes, the receipts and
 * the kept versions are as they were. Once the hold is gone, the same Save goes through.
 *
 * FAKE, said where used: the flow's hold on the project is taken through Timmy's own hold writer (src/ops/flow-hold.ts
 * takeProjectHold), as another process's flow takes one; here the test takes it (so the words name the test's pid), and no flow
 * runs. Skipped, saying so, where no Chromium or Chrome is found. Captures (PNG) only when TIMMY_R6_CAPTURES names a folder, each
 * with a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { takeProjectHold } from '../src/ops/flow-hold.js';
import { folderProject, projectId } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { Workspace } from '../src/repl/workspace.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { makeCanvasProject, type CanvasProject as Fixture } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-nodes-edit-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const BOX = 'box.params.json';
const TRAY = 'recipes/tray.params.json';
const FLOW = 'fbee0f00d';
type Rec = { id: string; type: string; typeName: string; props: Record<string, unknown> };
type Win = { timmyCanvas: { editor: { store: { allRecords: () => Rec[] }; getShapePageBounds: (id: string) => { center: { x: number; y: number } } | undefined; centerOnPoint: (p: { x: number; y: number }, o?: unknown) => void } } };

describe.skipIf(!browserPath)("a parameter node's values, edited through the existing parameter save path (real browser)", () => {
  let p: Fixture;
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  let pageRoot = '';
  let home = '';
  let storeBase = '';
  let store = '';
  let server: StudioServer;
  let ws: Workspace;
  let cp: CanvasProject;
  let browser: Browser;
  let base = '';
  const notes: string[] = [];
  const receipts = (): Array<Record<string, unknown>> => { try { return readFileSync(join(store, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>); } catch { return []; } };
  const edits = () => receipts().filter((r) => r.kind === 'edit');
  /** The kept versions of the project's parameter files (.timmy/params-history), each with its sha256. */
  function kept(): Record<string, string> {
    const dir = join(p.root, '.timmy', 'params-history');
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f)); }
    };
    walk(dir);
    return out;
  }
  let boxShape = '';

  beforeAll(async () => {
    p = await makeCanvasProject('timmy-nodes-edit-');
    dirs.push(p.base);
    pageRoot = temp('timmy-nodes-edit-root-');
    home = temp('timmy-nodes-edit-home-');
    storeBase = temp('timmy-nodes-edit-store-');
    store = join(storeBase, '.timmy', 'receipts');
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixtures = temp('timmy-nodes-edit-fixtures-');
    const fakePython = join(fixtures, 'fake-python');
    writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
    const jobs = join(temp('timmy-nodes-edit-jobs-'), 'jobs');
    ws = new Workspace({
      glyphs: glyphSet(true),
      env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs'), TIMMY_CADQUERY_PYTHON: fakePython },
      onPath: () => null,
      notify: (l) => notes.push(l.map((s) => s.text).join('')),
      openWeb: (url) => `Open ${url} in your browser.`,
      link: (t) => t,
      seal: (input) => appendReceipt('runs', input, storeBase).hash.slice(7, 15),
      receipts: () => receipts() as never,
      jobsDir: jobs,
      chdir: () => {},
    }, folderProject(p.root));
    cp = new CanvasProject({
      base: () => base, env: { TIMMY_HOME: home }, project: () => ws.project, projectId,
      jobsDir: jobs, receipts: () => store, board: () => null, ownToken: () => server.projectToken, act: (e) => ws.canvasAct(e),
    });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    cp?.stop();
    await browser?.close();
    await ws?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of dirs) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** A page as /canvas open opens it (a fresh grant in its fragment), the node palette open on the project's cards. */
  async function open(): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    expect(await cp.handOff({ grant: true })).toEqual({ ok: true, name: 'demo' });
    const t = cp.openTarget();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // a refused save is an answer of 409 or 422 from Timmy: said on the card, not an error of the page
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4(09|22)/.test(m.text())) errors.push(m.text()); });
    await page.goto(t.target);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    expect(((await page.textContent('#project-acts')) ?? '').replace(/\s+/g, ' ').trim()).toBe('This page was opened by Timmy: its executable cards can act.');
    await page.click('#nodes > summary');
    await page.waitForFunction(() => (document.getElementById('nodes-name')?.textContent ?? '').startsWith('demo · '), null, { timeout: 20_000 });
    return { page, context, errors };
  }
  const card = (shape: string): string => `[data-timmy-card="${shape}"]`;
  /** The page's own word that what it holds is saved (Studio saves a moment after a change). */
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  /** Whether the project's board on disk holds shape `id` (the page saves it a moment after it is drawn). */
  const onDisk = (id: string): boolean => { try { return readFileSync(join(home, 'canvas', 'projects', projectId(p.root), 'canvas.json'), 'utf8').includes(`"${id}"`); } catch { return false; } };
  /** Whether the board on screen holds shape `id`. */
  const inStore = (page: Page, id: string): Promise<boolean> => page.evaluate((x) => (window as never as Win).timmyCanvas.editor.store.allRecords().some((r) => r.id === x), id);
  /** Adds the parameter node of `id` from the palette; its shape id. */
  async function addParameterNode(page: Page, id: string): Promise<string> {
    await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
    await page.click(`#node-palette li.nitem[data-node-kind="params"][data-node-id="${id}"] button.nitem-add`);
    await page.waitForFunction(() => /^Added a parameter node to demo's board: /.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
    return page.evaluate((c) => (window as never as Win).timmyCanvas.editor.store.allRecords().filter((r) => r.typeName === 'shape' && r.type === 'timmy-params' && r.props.card === c).map((r) => r.id).at(-1)!, id);
  }
  /** Brings a node to the middle of the view, its Save under nothing else. */
  async function bring(page: Page, shape: string): Promise<void> {
    await page.evaluate((id) => { const e = (window as never as Win).timmyCanvas.editor; const b = e.getShapePageBounds(id); if (b) e.centerOnPoint(b.center, { animation: { duration: 0 } }); }, shape);
    try {
      await page.waitForFunction((s) => { const b = document.querySelector(`${s} button[data-tc-act="save"]`)?.getBoundingClientRect(); if (!b) return false; const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && !!hit.closest(`${s} button[data-tc-act="save"]`); }, card(shape), { timeout: 5000 });
    } catch (e) {
      // what is there instead, for the report (a diagnosis, then the failure stands)
      const why = await page.evaluate((s) => {
        const btn = document.querySelector(`${s} button[data-tc-act="save"]`);
        const b = btn?.getBoundingClientRect();
        const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
        return { card: !!document.querySelector(s), button: !!btn, box: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null, view: [innerWidth, innerHeight], hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : null };
      }, card(shape));
      throw new Error(`${(e as Error).message} · ${JSON.stringify(why)}`);
    }
  }
  /** Types `value` into the node's field `name` and presses Save; the node's new answer, once Timmy gave it (not one before). */
  async function save(page: Page, shape: string, name: string, value: string): Promise<{ text: string; bad: boolean }> {
    const at = card(shape);
    await bring(page, shape);
    const before = await page.evaluate((s) => document.querySelector(`${s} pre.tc-answer`)?.textContent ?? null, at);
    await page.click(`${at} [data-tc-param="${name}"]`);
    await page.fill(`${at} [data-tc-param="${name}"]`, value);
    expect(await page.isDisabled(`${at} button[data-tc-act="save"]`)).toBe(false);
    await page.click(`${at} button[data-tc-act="save"]`);
    await page.waitForFunction((x) => { const e = document.querySelector(`${x.s} pre.tc-answer`); return !!e && e.textContent !== x.before && !document.querySelector(`${x.s} p.tc-answer`); }, { s: at, before }, { timeout: 20_000 });
    return page.$eval(`${at} pre.tc-answer`, (e) => ({ text: (e.textContent ?? '').trim(), bad: e.classList.contains('tc-bad') }));
  }
  /** The values a node read from its file (its kept reading), by name. */
  const readValues = (page: Page, shape: string): Promise<Record<string, unknown>> => page.evaluate((id) => {
    const r = (window as never as Win).timmyCanvas.editor.store.allRecords().find((x) => x.id === id);
    const d = r && r.props.data as { values?: Array<{ name: string; value: unknown }> } | null;
    return Object.fromEntries((d && d.values ? d.values : []).map((v) => [v.name, v.value]));
  }, shape);
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · records written by the test (FIXTURES in their shapes) · FAKE flow hold (taken by the test through Timmy\'s own hold writer; no flow runs) · disposable project demo';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', maxWidth: '60vw', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }

  it("a parameter node's typed value is saved through the live board's save path: the rules, the previous version kept, an edit receipt; the node is drawn again from the saved file", async () => {
    const { page, context, errors } = await open();
    try {
      boxShape = await addParameterNode(page, `params:${BOX}`);
      const at = card(boxShape);
      await page.waitForSelector(`${at} [data-tc-param="width"]`);
      // the added node is saved to the board (test 2 opens the board again and uses it)
      await savedState(page);
      expect(onDisk(boxShape), 'the OpenSCAD node is saved to the project\'s board').toBe(true);
      // the node is the project's own parameter card, bound to it, with Save (the REPL takes its actions)
      expect(await page.evaluate((id) => (window as never as Win).timmyCanvas.editor.store.allRecords().find((r) => r.id === id)!.props.projectId, boxShape)).toBe(projectId(p.root));
      const was = readFileSync(join(p.root, BOX));
      const keptBefore = kept();
      const editsBefore = edits().length;
      const said = await save(page, boxShape, 'width', '120');
      expect(said.bad).toBe(false);
      expect(said.text).toMatch(new RegExp(`^Saved ${BOX.replace(/\./g, '\\.')}: width 90 → 120, depth 40, height 30\\. sha256 [0-9a-f]{12} \\(was ${sha(was).slice(0, 12)}\\); the previous version is kept at (\\S+); receipt [0-9a-f]{8}\\. /scad box\\.scad takes these values\\.$`));
      // on disk: the new value, the previous bytes kept where the answer says, one edit receipt naming both
      expect((JSON.parse(readFileSync(join(p.root, BOX), 'utf8')) as { parameters: Record<string, unknown> }).parameters).toEqual({ width: 120, depth: 40, height: 30 });
      const keptAt = /the previous version is kept at (\S+);/.exec(said.text)![1];
      expect(readFileSync(join(p.root, keptAt)).equals(was)).toBe(true);
      expect(Object.keys(kept()).length).toBe(Object.keys(keptBefore).length + 1);
      expect(edits()).toHaveLength(editsBefore + 1);
      // its subject names Timmy Canvas: the save came through the canvas (src/repl/canvas-actions.ts canvasSubject)
      expect(edits().at(-1)).toMatchObject({ policy: 'human-gated', subject: `edit · ${BOX} · OpenSCAD parameters from Timmy Canvas (the live board's save path)` });
      expect((edits().at(-1)!.files as Array<{ path: string; previous_sha256: string; sha256: string }>)[0]).toMatchObject({ path: BOX, previous_sha256: sha(was), sha256: sha(readFileSync(join(p.root, BOX))) });
      // the REPL said it in its own transcript: the save went through it
      expect(notes.some((n) => n.startsWith(`  canvas  saved ${BOX}: width 90 → 120`))).toBe(true);
      // the node, read again from the saved file (its kept reading, not the typed field), holds the saved value
      await expect.poll(() => readValues(page, boxShape), { timeout: 15_000 }).toEqual({ width: 120, depth: 40, height: 30 });
      await capture(page, '13-parameter-node-saved');
      // the node's new reading is saved too before the page closes
      await savedState(page);
      expect(onDisk(boxShape)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('while a flow holds the project, Save on a parameter node is refused in the REPL\'s own words and nothing is written; once the hold is gone, the same Save goes through', async () => {
    expect(boxShape).not.toBe('');
    const { page, context, errors } = await open();
    await page.waitForFunction((id) => (window as never as Win).timmyCanvas.editor.store.allRecords().some((r) => r.id === id), boxShape, { timeout: 15_000 }).catch(() => undefined);
    expect(await inStore(page, boxShape), `the OpenSCAD node test 1 added (${boxShape}) is on the reopened board`).toBe(true);
    // FAKE: a flow's hold on the project, taken through Timmy's own hold writer as another process's flow takes one; no flow runs
    const held = takeProjectHold(p.root, { kind: 'tray' });
    if (!held.ok || !held.hold) throw new Error('FAKE flow hold not taken');
    held.hold.name(FLOW);
    let released = false;
    try {
      const trayShape = await addParameterNode(page, `params:${TRAY}`);
      await page.waitForSelector(`${card(trayShape)} [data-tc-param="width"]`);
      const trayWas = readFileSync(join(p.root, TRAY));
      const boxWas = readFileSync(join(p.root, BOX));
      const keptBefore = kept();
      const editsBefore = edits().length;
      const refusal = `flow ${FLOW} is running in this project in another Timmy process (pid ${process.pid}): save after it ends`;
      // the tray recipe's node (set-params) and the OpenSCAD node (set-scad-params): each refused, in the same words
      expect(await save(page, trayShape, 'width', '150')).toEqual({ text: refusal, bad: true });
      await capture(page, '14-parameter-node-refused-while-a-flow-runs');
      // the OpenSCAD node is elsewhere on the board: brought into view first (tldraw draws no shape outside the view)
      await bring(page, boxShape);
      expect(await save(page, boxShape, 'width', '130')).toEqual({ text: refusal, bad: true });
      // nothing written: the files' bytes, the receipts and the kept versions are as they were; the REPL said why
      expect(readFileSync(join(p.root, TRAY)).equals(trayWas)).toBe(true);
      expect(readFileSync(join(p.root, BOX)).equals(boxWas)).toBe(true);
      expect(edits()).toHaveLength(editsBefore);
      expect(kept()).toEqual(keptBefore);
      expect(notes.filter((n) => n.startsWith(`  canvas  refused a parameter save: flow ${FLOW} is running in this project in another Timmy process`))).toHaveLength(1);
      expect(notes.filter((n) => n.startsWith(`  canvas  refused an OpenSCAD parameter save: flow ${FLOW} is running in this project in another Timmy process`))).toHaveLength(1);
      // the hold is gone: the same Save goes through, written and sealed
      held.hold.release();
      released = true;
      const after = await save(page, trayShape, 'width', '150');
      expect(after.bad).toBe(false);
      expect(after.text).toMatch(/^Saved recipes\/tray\.params\.json: width 145 → 150/);
      expect((JSON.parse(readFileSync(join(p.root, TRAY), 'utf8')) as { parameters: { width: number } }).parameters.width).toBe(150);
      expect(edits()).toHaveLength(editsBefore + 1);
      expect(errors).toEqual([]);
    } finally {
      if (!released) held.hold.release();
      await context.close();
    }
  }, 120_000);
});
