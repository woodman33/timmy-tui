/**
 * R6 (H145, step 4a): custom nodes, the node palette in Studio's side panel (companion/studio-canvas/src/nodes.js), in a real
 * headless Chromium against the real canvas server and the real bundle (built here into a temporary folder), with a real
 * temporary Timmy home and two disposable projects: tray, made of real record files of every kind (tests/helpers/canvas-project.ts:
 * written by Timmy's own writers where one exists, FIXTURES in their documented shapes otherwise) and one operation
 * (tests/helpers/canvas-operation.ts: a job of the real JobManager inside it, a FAKE program standing in for upmd); and blank, a
 * folder with one workflow document. The projects are named as the REPL names them, and made the active project as the
 * Workbench's p makes one (Studio follows it).
 *
 * What is checked, by reading the page and the disk: the palette lists exactly the drawable cards of tray's reading, by the node
 * each makes, and its operation; each kind is added as a node bound to tray (a parameter, a workflow and a result node, each its
 * drawn card; an operation node, its cards linked by arrows bound to them), each add saved to tray's board while blank's board
 * files stay byte-identical (hashed before and after each step); while Studio switches to blank an add is refused in words, and
 * an add whose reading was held across the switch places nothing on either board (noted under Kept apart); blank's board shows
 * none of tray's nodes and its palette is blank's own; back on tray, its nodes are still there, still tray's.
 *
 * Skipped, saying so, where no Chromium or Chrome is found. Captures (PNG) only when TIMMY_R6_CAPTURES names a folder, each with
 * a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawnType } from '../companion/studio-canvas/src/cards.js';
import { paletteOf } from '../companion/studio-canvas/src/nodes.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, grant, nameProject, pageSession } from './helpers/canvas-auth.js';
import { addOperation, type Operation } from './helpers/canvas-operation.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-nodes-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HOLDER = 'b'.repeat(32);
const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Project = { name: string; root: string; id: string; jobs: string; receipts: string };
type Who = { id: string; name: string } | null;
type Rec = { id: string; type: string; typeName: string; x?: number; y?: number; props: Record<string, unknown>; meta: Record<string, unknown> };
type Win = { timmyCanvas: {
  editor: { getCurrentPageShapes: () => Rec[]; getBindingsFromShape: (id: string, type: string) => Array<{ toId: string; props: { terminal: string } }> };
  project: Who; identity: { project: Who; switching: Who; state: string; kept: Array<{ words: string }> };
  addNode: (kind: string, id: string) => Promise<{ words: string }>;
} };
/** A node on the board on screen: its shape, type, card, project and operation. */
type Node = { id: string; type: string; card: string; projectId: string; op: string | null };

describe.skipIf(!browserPath)("Studio's node palette: the shown project's own cards, each added as a node bound to it (real browser)", () => {
  let canvasProject: CanvasProject;
  let operation: Operation;
  let pageRoot = '';
  let home = '';
  let base = '';
  let port = 0;
  let server: StudioServer;
  let browser: Browser;
  const dirs: string[] = [];
  let tray: Project;
  let blank: Project;
  /** the nodes test 1 added, as tray's board holds them */
  let added: Node[] = [];

  beforeAll(async () => {
    canvasProject = await makeCanvasProject('timmy-nodes-tray-');
    operation = await addOperation(canvasProject);
    dirs.push(canvasProject.base);
    tray = { name: 'tray', root: canvasProject.root, id: projectId(canvasProject.root), jobs: canvasProject.jobs, receipts: canvasProject.store };
    const b = mkdtempSync(join(tmpdir(), 'timmy-nodes-blank-'));
    dirs.push(b);
    mkdirSync(join(b, 'blank'), { recursive: true });
    mkdirSync(join(b, 'jobs'), { recursive: true });
    mkdirSync(join(b, 'store'), { recursive: true });
    writeFileSync(join(b, 'blank', 'BUILD.md'), '# blank build\n\n```bash [name:build]\necho blank\n```\n');
    blank = { name: 'blank', root: join(b, 'blank'), id: projectId(join(b, 'blank')), jobs: join(b, 'jobs'), receipts: join(b, 'store') };
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-nodes-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-nodes-home-'));
    dirs.push(pageRoot, home);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, PATH: process.env.PATH }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    workbench(tray);
    await named(tray);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 240_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of dirs) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** The REPL's /canvas open: it names `p`, with its holder id, its jobs folder and its receipts store. */
  const named = (p: Project) => nameProject(port, server.projectToken, { root: p.root, name: p.name, holder: HOLDER, jobs: p.jobs, receipts: p.receipts });
  /** The Workbench's p: the active project of this Timmy home (the server follows it). */
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  const board = (p: Project): string => boardDir(join(home, 'canvas'), p.id);
  /** Every file of project `p`'s board, with its sha256 ({} before it has any). */
  function files(p: Project): Record<string, string> {
    const dir = board(p);
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f)); }
    };
    walk(dir);
    return out;
  }
  /** The nodes tray's board holds on disk (its drawn cards), with their project and operation. */
  function savedNodes(p: Project): Node[] {
    let snap: { store?: Record<string, Rec> } = {};
    try { snap = (JSON.parse(readFileSync(join(board(p), 'canvas.json'), 'utf8')) as { snapshot: typeof snap }).snapshot; } catch { return []; }
    return Object.values(snap.store ?? {}).filter((r) => r.typeName === 'shape' && /^timmy-(workflow|params|result)$/.test(r.type))
      .map((r) => ({ id: r.id, type: r.type, card: String(r.props.card), projectId: String(r.props.projectId), op: typeof r.meta.timmyOperation === 'string' ? r.meta.timmyOperation : null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`not in time: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  interface Studio { page: Page; context: BrowserContext; errors: string[] }
  async function open(): Promise<Studio> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** The board on screen is `p`'s, and the palette lists `p`'s cards (opened: it starts folded). */
  async function shows(page: Page, p: Project): Promise<void> {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id && t.project?.id === id; }, p.id, { timeout: 20_000 });
    if (!(await page.evaluate(() => (document.getElementById('nodes') as HTMLDetailsElement).open))) await page.click('#nodes > summary');
    await page.waitForFunction((x) => (document.getElementById('nodes-name')?.textContent ?? '').startsWith(`${x.name} · `) && document.getElementById('node-palette')?.dataset.project === x.id, { id: p.id, name: p.name }, { timeout: 20_000 });
  }
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  /** The palette as drawn: each kind's items (their ids), and the projects they name. */
  const palette = (page: Page) => page.$$eval('#node-palette section.ngroup', (ss) => ss.map((s) => ({
    kind: s.getAttribute('data-node-group'),
    ids: [...s.querySelectorAll('li.nitem')].map((l) => l.getAttribute('data-node-id')),
    projects: [...new Set([...s.querySelectorAll('li.nitem')].map((l) => l.getAttribute('data-project')))],
  })));
  /** The nodes on the board on screen. */
  const onBoard = (page: Page): Promise<Node[]> => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes()
    .filter((r) => /^timmy-(workflow|params|result)$/.test(r.type))
    .map((r) => ({ id: r.id, type: r.type, card: String(r.props.card), projectId: String(r.props.projectId), op: typeof r.meta.timmyOperation === 'string' ? r.meta.timmyOperation as string : null }))
    .sort((a, b) => a.id.localeCompare(b.id)));
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · records written by the test (FIXTURES in their shapes; a FAKE program stands in for upmd) · disposable projects tray and blank';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', maxWidth: '60vw', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }

  it("the palette lists tray's own cards by the node each makes; each kind is added as a node bound to tray, saved to tray's board, blank's board untouched", async () => {
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      // exactly the drawable cards (and the operation) of tray's reading, as the server answers it
      const session = await pageSession(port, server.projectToken);
      const reading = await call(port, 'GET', '/api/project?detail=1', { headers: bearer(session) });
      expect(reading.status).toBe(200);
      const want = paletteOf(reading.json, drawnType).groups.map((g) => ({ kind: g.kind, ids: g.items.map((i) => i.id), projects: g.items.length ? [tray.id] : [] }));
      expect(await palette(page)).toEqual(want);
      const ids = Object.fromEntries(want.map((g) => [g.kind, g.ids]));
      expect(ids.params).toEqual(expect.arrayContaining(['params:box.params.json', 'params:recipes/tray.params.json']));
      expect(ids.workflow).toEqual(expect.arrayContaining(['workflow:BUILD.md', 'workflow:RUN.md']));
      expect(ids.result).toEqual(expect.arrayContaining([`flow:${canvasProject.flow}`, `vox:${canvasProject.voxId}`, `flow:${operation.flowId}`, `vox:${operation.voxId}`]));
      expect(ids.result.some((id: string) => id.startsWith('run:'))).toBe(true);
      expect(ids.operation).toEqual([operation.op]);
      const op = (reading.json.operations as Array<{ id: string; cards: string[] }>).find((o) => o.id === operation.op)!;
      const opCards = (reading.json.cards as Array<{ id: string; kind: string }>).filter((c) => op.cards.includes(c.id) && drawnType(c.kind)).map((c) => c.id);
      expect(opCards.length).toBeGreaterThan(1);

      // each kind added, one press each; after each, tray's board saved with it, blank's board files as they were
      const blankBefore = files(blank);
      for (const [kind, id, words] of [
        ['params', 'params:box.params.json', /^Added a parameter node to tray's board: OpenSCAD parameters of box\.scad/],
        ['workflow', 'workflow:BUILD.md', /^Added a workflow node to tray's board: /],
        ['result', `flow:${canvasProject.flow}`, /^Added a result node to tray's board: /],
        ['operation', operation.op, new RegExp(`${operation.op}`)],
      ] as Array<[string, string, RegExp]>) {
        const trayBefore = files(tray)['canvas.json'] ?? '';
        await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
        await page.click(`#node-palette li.nitem[data-node-kind="${kind}"][data-node-id="${id}"] button.nitem-add`);
        await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('project-said')?.textContent ?? ''), words.source, { timeout: 15_000 });
        expect(await page.getAttribute('#project-said', 'data-kind')).toBe('ok');
        await savedState(page);
        await until(`${kind} node saved to tray's board`, () => (files(tray)['canvas.json'] ?? '') !== trayBefore && (kind === 'operation' ? savedNodes(tray).some((n) => n.op === operation.op) : savedNodes(tray).some((n) => n.card === id && n.op === null)));
        expect(files(blank)).toEqual(blankBefore);
      }
      // on the board: one node of each card kind, and the operation's cards, each bound to tray; the operation's linked by arrows
      const nodes = await onBoard(page);
      expect(nodes.every((n) => n.projectId === tray.id)).toBe(true);
      expect(nodes.filter((n) => n.op === null).map((n) => [n.type, n.card]).sort()).toEqual([['timmy-params', 'params:box.params.json'], ['timmy-result', `flow:${canvasProject.flow}`], ['timmy-workflow', 'workflow:BUILD.md']]);
      const opNodes = nodes.filter((n) => n.op === operation.op);
      expect(opNodes.map((n) => n.card).sort()).toEqual([...opCards].sort());
      const arrows = await page.evaluate((o) => {
        const e = (window as never as Win).timmyCanvas.editor;
        return e.getCurrentPageShapes().filter((r) => r.type === 'arrow' && r.meta.timmyOperation === o).map((r) => e.getBindingsFromShape(r.id, 'arrow').map((x) => [x.props.terminal, x.toId]).sort());
      }, operation.op);
      expect(arrows).toHaveLength(opCards.length - 1);
      const opShapes = new Set(opNodes.map((n) => n.id));
      for (const a of arrows) expect(a.map(([t, to]) => [t, opShapes.has(to)])).toEqual([['end', true], ['start', true]]);
      // what tray's board holds on disk is what is on screen
      added = savedNodes(tray);
      expect(added).toEqual(nodes);
      expect(files(blank)).toEqual(blankBefore);
      await capture(page, '11-tray-nodes-added');
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  });

  it("while Studio switches to blank an add is refused, and one whose reading was held across the switch places nothing; blank shows none of tray's nodes and its own palette; back on tray, its nodes are tray's still", async () => {
    expect(added.length).toBeGreaterThan(3);
    const s = await open();
    const { page } = s;
    let releaseRead: () => void = () => {};
    let releaseBoard: () => void = () => {};
    try {
      await shows(page, tray);
      expect(await onBoard(page)).toEqual(added);
      // the drawn cards follow their records once read (a card writes itself only when its record's detail changed): the board
      // is hashed once that is saved
      await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
      await savedState(page);
      await page.waitForTimeout(600);
      await savedState(page);
      const trayBefore = files(tray);
      const blankBefore = files(blank);
      // an add whose reading of tray is held until the switch to blank has begun
      const readGate = new Promise<void>((done) => { releaseRead = done; });
      let readHeld = false;
      const holdRead = async (route: Route): Promise<void> => {
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/project') { await route.fallback(); return; }
        readHeld = true;
        const answered = await route.fetch();
        await readGate;
        await route.fulfill({ response: answered });
      };
      await page.route(() => true, holdRead);
      const held = page.evaluate(() => (window as never as Win).timmyCanvas.addNode('params', 'params:recipes/tray.params.json').then((r) => r.words, (e: Error) => e.message));
      await until('the add\'s reading is held', () => readHeld, 10_000);
      // blank's board is held from loading, so Studio stays switching while a person presses Add
      const boardGate = new Promise<void>((done) => { releaseBoard = done; });
      const holdBoard = async (route: Route): Promise<void> => {
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/canvas/document' || u.searchParams.get('project') !== blank.id) { await route.fallback(); return; }
        await boardGate;
        await route.fallback();
      };
      await page.route(() => true, holdBoard);
      workbench(blank);
      await named(blank);
      await page.waitForFunction((id) => (window as never as Win).timmyCanvas.identity.state === 'switching' && (window as never as Win).timmyCanvas.identity.switching?.id === id, blank.id, { timeout: 20_000 });
      // while switching: refused at once, in words; the palette shows nothing of tray's
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.addNode('workflow', 'workflow:RUN.md').then((r) => r.words, (e: Error) => e.message)))
        .toBe('Not added: Studio is switching to blank, so no node is added to either board until its board is loaded.');
      expect(await page.locator('#node-palette li.nitem').count()).toBe(0);
      expect(await text(page, '#nodes-name')).toBe('switching…');
      // the held reading of tray comes back now: nothing is placed on either board
      releaseRead();
      expect(await held).toBe("Not added: Studio switched boards while it read tray's cards, so nothing was placed on either board.");
      await page.unroute(() => true, holdRead);
      releaseBoard();
      await page.unroute(() => true, holdBoard);
      await shows(page, blank);
      // blank's board: none of tray's nodes; blank's palette: blank's own workflow, nothing of tray's
      expect(await onBoard(page)).toEqual([]);
      expect(await palette(page)).toEqual([
        { kind: 'params', ids: [], projects: [] }, { kind: 'workflow', ids: ['workflow:BUILD.md'], projects: [blank.id] },
        { kind: 'result', ids: [], projects: [] }, { kind: 'operation', ids: [], projects: [] },
      ]);
      expect(await text(page, '#node-palette li.nitem .nitem-title')).toBe('blank build');
      const kept = await page.evaluate(() => (window as never as Win).timmyCanvas.identity.kept.map((k) => k.words));
      expect(kept.some((w) => /^A reading of tray \(its cards\) came back after Studio switched to blank: it was dropped/.test(w))).toBe(true);
      // nothing written to either board by the refused adds
      await page.waitForTimeout(800);
      expect(files(tray)).toEqual(trayBefore);
      expect(files(blank)).toEqual(blankBefore);
      await capture(page, '12-blank-own-palette');
      // back on tray: its nodes, as they were, still tray's
      workbench(tray);
      await named(tray);
      await shows(page, tray);
      await page.waitForFunction((n) => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().filter((r) => /^timmy-(workflow|params|result)$/.test(r.type)).length === n, added.length, { timeout: 15_000 });
      expect(await onBoard(page)).toEqual(added);
      expect(savedNodes(tray)).toEqual(added);
      expect(files(blank)).toEqual(blankBefore);
      expect(s.errors).toEqual([]);
    } finally {
      releaseRead();
      releaseBoard();
      await s.context.close();
    }
  });
});
