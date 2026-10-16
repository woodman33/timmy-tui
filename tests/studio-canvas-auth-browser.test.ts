/**
 * Round R4 (H83): the canvas page's own flow under the server's credentials, in a real headless Chromium, against the real canvas
 * server, the real bundle (built here into a temporary folder, as the other browser tests build it), a real temporary project
 * (tests/helpers/canvas-project.ts) and the REPL's side for real: a Workspace whose /run uses tests/fixtures/fake-upmd.mjs (a
 * labelled TEST DOUBLE of upmd 0.2.7) and a CanvasProject that names the project with its holder id, asks for the page's grant
 * and takes the cards' actions; the agent's canvas tools send the REPL's credentials (src/agent/canvas-tools.ts). Every request
 * the page makes goes to 127.0.0.1 (anything else is aborted). Skipped, saying so, where no Chromium or Chrome is found.
 *
 * Checked: opened by /canvas open, the page loads the canvas, a card acts on a person's click, canvas_exec draws a shape and
 * it is saved; after a reload (no grant) the canvas is not loaded and the page says what to do, as a page opened by its address
 * does; a page of one project shows another project's drawn card with its kept detail withheld (it says so and gives that
 * project's commands) and its saves keep that detail; once another REPL names its project, the page's save is refused in words.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { folderProject, projectId } from '../src/project/index.js';
import { CanvasProject } from '../src/repl/canvas-project.js';
import { Workspace } from '../src/repl/workspace.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { bearer, call, nameProject } from './helpers/canvas-auth.js';
import { makeCanvasProject, type CanvasProject as Fixture } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-canvas-auth-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const F = '```';
const RUN_DOC = ['# Make', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, ''].join('\n');
type Win = { timmyCanvas: { placeDrawnCard: (id: string) => Promise<{ shape: string }>; editor: { getShape: (id: string) => unknown; getShapePageBounds: (id: string) => { center: { x: number; y: number } } | undefined; centerOnPoint: (p: { x: number; y: number }, o?: unknown) => void; createShape: (s: unknown) => void } } };

describe.skipIf(!browserPath)('Timmy Canvas under its credentials, in a real browser', () => {
  let p: Fixture;
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let ws: Workspace;
  let cp: CanvasProject;
  let browser: Browser;
  let base = '';
  let port = 0;
  const notes: string[] = [];

  beforeAll(async () => {
    p = await makeCanvasProject('canvas-auth-browser-');
    p.write('RUN.md', RUN_DOC);
    pageRoot = temp('canvas-auth-root-');
    home = temp('canvas-auth-home-');
    const storeBase = temp('canvas-auth-store-');
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const jobs = join(temp('canvas-auth-jobs-'), 'jobs');
    ws = new Workspace({
      glyphs: glyphSet(true), env: { UPMD_BIN: resolve('tests/fixtures/fake-upmd.mjs') }, onPath: () => null,
      notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
      seal: (input) => appendReceipt('runs', input, storeBase).hash.slice(7, 15), receipts: () => [], jobsDir: jobs, chdir: () => {},
    }, folderProject(p.root));
    cp = new CanvasProject({
      base: () => base, env: { TIMMY_HOME: home }, project: () => ws.project, projectId,
      jobsDir: jobs, receipts: () => join(storeBase, '.timmy', 'receipts'), board: () => null, ownToken: () => server.projectToken, act: (e) => ws.canvasAct(e),
    });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    cp?.stop();
    await browser?.close();
    await ws?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, ...dirs]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** A page as /canvas open opens it (a fresh grant in its fragment), or by its bare address. */
  async function open(o: { grant?: boolean; wait?: RegExp; viewport?: { width: number; height: number } } = {}): Promise<{ page: Page; context: BrowserContext; origins: Set<string>; errors: string[]; asked: string[] }> {
    let target = `${base}/`;
    if (o.grant !== false) {
      expect(await cp.handOff({ grant: true })).toEqual({ ok: true, name: 'demo' });
      target = cp.openTarget().target;
    }
    const context = await browser.newContext({ viewport: o.viewport ?? { width: 1400, height: 900 } });
    const origins = new Set<string>();
    const asked: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      asked.push(`${route.request().method()} ${url.pathname}`);
      return url.hostname === '127.0.0.1' && url.origin === base ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(target);
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')?.textContent ?? ''), (o.wait ?? /Timmy connected/).source, { timeout: 30_000 });
    return { page, context, origins, errors, asked };
  }
  /** A person's click through Chromium's own input (CDP): a trusted click at the element's middle. */
  async function personClick(page: Page, context: BrowserContext, sel: string): Promise<void> {
    const box = await page.locator(sel).boundingBox();
    if (!box) throw new Error(`${sel} is not on screen`);
    const cdp = await context.newCDPSession(page);
    try {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
    } finally { await cdp.detach(); }
  }
  const saved = async (): Promise<string> => (await call(port, 'GET', '/api/canvas/document', { headers: bearer(server.projectToken) })).body;
  const NO_GRANT = 'This page was opened without a grant from Timmy, so it loads no canvas: Timmy opens the canvas page with a one-time grant, and a page opened by its address, a bookmark or a reload has none.';

  it('opened by /canvas open: the canvas loads, a card acts on a person\'s click, canvas_exec draws and it is saved; after a reload nothing loads and the page says what to do', async () => {
    const { page, context, origins, errors, asked } = await open();
    try {
      expect(await page.textContent('#project-acts')).toBe('This page was opened by Timmy: its executable cards can act.');
      // a card acts (a person's click on Run; the REPL runs /run as its own job)
      const wf = await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:RUN.md'));
      const run = `[data-timmy-card="${wf.shape}"] button[data-tc-act="run"][data-tc-block="setup"]`;
      await page.waitForSelector(run);
      // R4 (H88; the Mac run r23): the first card placed sits clear of Timmy's side panel, whole (it sat partly under it)
      await page.waitForTimeout(400);
      const sideBox = await page.locator('#side').boundingBox();
      const cardBox = await page.locator(`[data-timmy-card="${wf.shape}"]`).boundingBox();
      expect(sideBox && cardBox, 'the panel and the card are on screen').toBeTruthy();
      const apart = cardBox!.x >= sideBox!.x + sideBox!.width || cardBox!.y >= sideBox!.y + sideBox!.height;
      expect(apart, `the card ${JSON.stringify(cardBox)} overlaps the panel ${JSON.stringify(sideBox)}`).toBe(true);
      await page.evaluate((id) => { const e = (window as never as Win).timmyCanvas.editor; const b = e.getShapePageBounds(id); if (b) e.centerOnPoint(b.center, { animation: { duration: 0 } }); }, wf.shape);
      await page.waitForTimeout(100);
      await personClick(page, context, run);
      await page.waitForFunction((s) => /^canvas \/run RUN\.md setup/.test(document.querySelector(`[data-timmy-card="${s}"] .tc-answer`)?.textContent ?? ''), wf.shape, { timeout: 20_000 });
      expect(notes).toContain('  canvas  /run RUN.md setup');
      // canvas_exec through the agent's tool, with the REPL's own credentials: drawn on this page, then saved
      const tools = createCanvasTools({ baseUrl: base, auth: () => cp.credentials() });
      const execTool = tools.find((t) => (t as { function: { name: string } }).function.name === 'canvas_exec') as unknown as { function: { execute: (a: unknown) => Promise<Record<string, unknown>> } };
      const drawn = await execTool.function.execute({ code: "const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 900, y: 200, props: { w: 120, h: 60 } }); return id;", jobId: 'auth-draw' });
      expect(drawn).toMatchObject({ ok: true, changed: true, jobId: 'auth-draw' });
      expect(await page.evaluate((id) => !!(window as never as Win).timmyCanvas.editor.getShape(id), drawn.result as string)).toBe(true);
      let doc = '';
      for (let i = 0; i < 40 && !doc.includes(String(drawn.result)); i++) { await new Promise((r) => setTimeout(r, 150)); doc = await saved(); }
      expect(doc).toContain(String(drawn.result));
      expect(doc).toContain(wf.shape);
      expect([...origins]).toEqual([base]);
      expect(errors).toEqual([]);
      // the reload: the grant was good once, so the page has no session; it asks for no canvas, and says what to do (what the
      // page asked for is counted from the new document on: the old one saves as it leaves, with its session)
      await page.reload({ waitUntil: 'commit' });
      asked.length = 0;
      await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'refused', null, { timeout: 30_000 });
      // R5 (H133): the why and what to type are said once, in the middle of the page; the panel's line points there
      expect(await page.textContent('#status')).toBe('Not loaded: why, and what to type in Timmy, are in the middle of the page.');
      expect((await page.evaluate(() => document.body.innerText)).split(NO_GRANT).length - 1).toBe(1);
      expect(await page.isVisible('#refused')).toBe(true);
      expect(await page.textContent('#refused-words')).toBe(NO_GRANT);
      expect(((await page.textContent('#refused')) ?? '').replace(/\s+/g, ' ')).toContain('In Timmy: /canvas open opens the canvas with its project\'s cards.');
      expect(asked.filter((a) => /\/api\/(canvas|project)\b/.test(a))).toEqual([]);
      expect(await page.isHidden('#side-ready')).toBe(true);
      // the server refuses the canvas to it too, in words
      const tried = await page.evaluate(async () => { const r = await fetch('/api/canvas/document', { cache: 'no-store' }); return { status: r.status, body: await r.text() }; });
      expect(tried.status).toBe(401);
      expect(JSON.parse(tried.body)).toMatchObject({ ok: false, session: 'none', error: expect.stringMatching(/In Timmy: \/canvas open\.$/) });
      expect(tried.body).not.toContain(wf.shape);
      // and the agent's next call finds no page that may run it
      const after = await execTool.function.execute({ code: 'return 1' });
      expect(after).toMatchObject({ ok: false, error: 'No canvas is open. In Timmy: /canvas open opens it, then try again.' });
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 150_000);

  it('a page opened by its address alone loads no canvas and says it needs /canvas open; nothing else on it breaks', async () => {
    const { page, context, origins, errors, asked } = await open({ grant: false, wait: /^Not loaded: / });
    try {
      expect(await page.getAttribute('#status', 'data-kind')).toBe('refused');
      expect(await page.textContent('#refused-words')).toBe(NO_GRANT);
      expect(asked.filter((a) => /\/api\/(canvas|project)\b/.test(a))).toEqual([]);
      expect([...origins]).toEqual([base]);
      expect(errors).toEqual([]);
      // its words and the command are readable: inside the screen, unclipped
      const fit = await page.evaluate(() => { const r = document.getElementById('refused')!.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
      expect(fit).toBe(true);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("a page of one project shows another project's drawn card with its kept detail withheld (saying so, with its commands); its saves keep that detail; once another REPL names its project, a save is refused in words", async () => {
    // Another project's card on the canvas, as a page of that project saved it (with the REPL's token here).
    const other = join(temp('canvas-auth-other-'), 'beta');
    mkdirSync(other);
    const detail = { type: 'params', engine: 'tray', file: 'b.params.json', values: [{ name: 'width', value: 42, kind: 'number' }], secret: 'beta-kept-detail' };
    const current = JSON.parse(await saved()) as { revision: number; snapshot: { store: Record<string, unknown>; schema: unknown } | null };
    expect(current.snapshot).not.toBeNull();
    const page1 = Object.values(current.snapshot!.store).find((r) => (r as { typeName: string }).typeName === 'page') as { id: string };
    const card = {
      id: 'shape:betacard', typeName: 'shape', type: 'timmy-params', x: 1100, y: 500, rotation: 0, index: 'a9', parentId: page1.id, isLocked: false, opacity: 1, meta: {},
      props: { w: 360, h: 160, card: 'params:b.params.json', kind: 'params', projectId: projectId(other), project: 'beta', title: 'Tray of beta', command: '/recipe tray', data: detail, readAt: '2026-10-11T01:00:00.000Z', open: false, gone: false },
    };
    const put = await call(port, 'PUT', '/api/canvas/document', { headers: { ...bearer(server.projectToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: { ...current.snapshot, store: { ...current.snapshot!.store, [card.id]: card } }, revision: current.revision + 1, baseRevision: current.revision }) });
    expect(put.status).toBe(200);
    const { page, context, errors } = await open();
    try {
      const at = '[data-timmy-card="shape:betacard"]';
      await page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; const b = e.getShapePageBounds('shape:betacard'); if (b) e.centerOnPoint(b.center, { animation: { duration: 0 } }); });
      await page.waitForSelector(`${at} .tc-mode`);
      expect(await page.textContent(`${at} .tc-badge`)).toBe('diagram');
      expect(await page.textContent(`${at} .tc-mode`)).toBe('Withheld: this card\'s kept detail (its commands and values) belongs to beta, and this page\'s session is for another project. To read it, open Timmy in beta\'s folder and type /canvas open there; in a Timmy REPL open elsewhere, /project followed by the path of beta\'s folder opens it first.');
      expect(await page.$$eval(`${at} .tc-withheld .tc-cmd`, (n) => n.map((x) => x.textContent))).toEqual(['/canvas open', "/project <the path of beta's folder>"]);
      expect(await page.textContent(`${at} .tc-read`)).toBe('its detail withheld here');
      expect(await page.locator(`${at} [data-tc-param]`).count()).toBe(0);
      expect(await page.content()).not.toContain('beta-kept-detail');
      // the page saves (a shape of its own), and the saved copy of beta's card keeps its detail
      await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.createShape({ type: 'geo', x: 50, y: 700, props: { w: 40, h: 40 } }); });
      await page.waitForFunction(() => /revision \d+, saved$/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 15_000 });
      const doc = JSON.parse(await saved()) as { snapshot: { store: Record<string, { props?: Record<string, unknown> }> } };
      expect(doc.snapshot.store['shape:betacard'].props).toMatchObject({ projectId: projectId(other), data: detail, readAt: '2026-10-11T01:00:00.000Z' });
      // another REPL names its project: this page's session no longer counts; its next save is refused and says so
      await nameProject(port, server.projectToken, { root: other, name: 'beta', holder: 'f'.repeat(32) });
      await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.createShape({ type: 'geo', x: 150, y: 700, props: { w: 40, h: 40 } }); });
      await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'refused', null, { timeout: 15_000 });
      expect(await page.textContent('#status')).toBe('Not saved: Refused: this canvas page\'s session was given for another project than the one the canvas shows now. In Timmy: /canvas open, from the REPL that holds this project.');
      // R4 (H88; the Mac run r23): the project panel's line follows the session: its cards are diagrams now (it kept "can act")
      await page.waitForFunction(() => document.getElementById('project-acts')?.dataset.kind === 'paused', null, { timeout: 15_000 });
      expect(await page.textContent('#project-acts')).toBe('Refused: this canvas page\'s session was given for another project than the one the canvas shows now. In Timmy: /canvas open, from the REPL that holds this project. Until it counts again, this page\'s cards are diagrams: nothing on them acts.');
      expect(await page.textContent('#project-acts')).not.toContain('can act');
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
    } finally {
      await context.close();
      // demo is named again for any later test
      await cp.handOff();
    }
  }, 150_000);

  // R4 (H88; the Mac run r23): the first card placed on the canvas sat partly under Timmy's side panel. Seen here: on a
  // narrow, tall window (760 x 1600) a card placed while the panel was short (its lists folded) went below it, and the panel,
  // once its folds opened, covered part of it. The area beside the panel is now used whenever it can hold a card.
  it('R4 (H88; r23): the first card placed sits beside the panel, clear of it, also once the panel grows', async () => {
    const { page, context, errors } = await open({ viewport: { width: 760, height: 1600 } });
    try {
      // this page's drawn cards removed (earlier tests placed some), so the card placed next is the first
      await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { getCurrentPageShapes: () => Array<{ id: string; type: string }>; deleteShapes: (ids: string[]) => void } } }).timmyCanvas.editor; e.deleteShapes(e.getCurrentPageShapes().filter((x) => x.type.startsWith('timmy-')).map((x) => x.id)); });
      await page.evaluate(() => { for (const id of ['project', 'jobs']) (document.getElementById(id) as HTMLDetailsElement).open = false; });
      await page.waitForTimeout(100);
      const wf = await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:RUN.md'));
      await page.waitForSelector(`[data-timmy-card="${wf.shape}"] .tc-title`);
      await page.evaluate(() => { for (const id of ['project', 'jobs']) (document.getElementById(id) as HTMLDetailsElement).open = true; });
      await page.waitForTimeout(400);
      const side = (await page.locator('#side').boundingBox())!;
      const card = (await page.locator(`[data-timmy-card="${wf.shape}"]`).boundingBox())!;
      // the panel grew past where the card sits (so a card below it would be covered), and the card is beside it, whole
      expect(side.y + side.height).toBeGreaterThan(card.y);
      expect(card.x, `the card ${JSON.stringify(card)} beside the panel ${JSON.stringify(side)}`).toBeGreaterThanOrEqual(side.x + side.width);
      expect(card.x + card.width).toBeLessThanOrEqual(760);
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);
});
