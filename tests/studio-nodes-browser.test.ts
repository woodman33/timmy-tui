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
 * R6 (H145, step 4c): connections, by reading the page, the board and tray's board on disk, the expected words worked out by the
 * page's own rules from tray's reading as the server answers it: the operation's own arrows are listed as data; Connect draws, from
 * the first selected node to the second, a labelled link that says no data flows where none does (a parameter node to a workflow
 * node, an operation's cards the wrong way round) and the operation's own link where data flows (after a person deleted it: the
 * page's record of the operation names the new arrow, so the operation node, pressed again, adds nothing and speaks of no deleted
 * arrow); a second press says it is already connected; one undo takes a connection back; an arrow drawn with tldraw's arrow tool
 * between two nodes is labelled once the gesture ends (never during it), an arrow with a person's words keeps them, and a label
 * taken off is not put back; all of it saved to tray's board, blank's board files unchanged; while Studio switches to blank a
 * connection is refused in words, and one whose reading was held across the switch connects nothing (noted under Kept apart).
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
import { connectionOf, LINK_LABEL, LINK_META, nodeOf, ordersOf, paletteOf, recordsOf, richWords } from '../companion/studio-canvas/src/nodes.js';
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
// R7 lead: one matcher for page.route and page.unroute. Playwright matches a function matcher by identity (urlMatchesEqual:
// match1 === match2), so `page.unroute(() => true, handler)`, given a new arrow function, removed nothing: on e1bea84 a read still
// inside the held-read handler's route.fetch() when the page closed raised an unhandled rejection in the full suite
const ANY_URL = (): boolean => true;
// The page keeps this route for its whole life, so removing a test's own handlers never removes the page's last route. When the
// last one goes, Playwright continues a request still with a handler by itself, and that handler's own continue then fails
// ("route.continue: Route is already handled!", an unhandled rejection: seen once the removal above worked)
const passOn = (route: Route): Promise<void> => route.fallback();
// a held read's handlers are off the page once the test removes them: `routed` counts every call of them, and a request made
// after the removal reaches none of them (the page's own address: a plain page, read without a token)
async function gone(page: Page, routed: () => number): Promise<void> {
  const before = routed();
  await page.evaluate(() => fetch('/', { cache: 'no-store' }).then((r) => r.status, () => 0));
  expect(routed(), 'a request made after the unroute reached a removed handler').toBe(before);
}
type Project = { name: string; root: string; id: string; jobs: string; receipts: string };
type Who = { id: string; name: string } | null;
type Rec = { id: string; type: string; typeName: string; x?: number; y?: number; props: Record<string, unknown>; meta: Record<string, unknown> };
type Win = { timmyCanvas: {
  editor: { getCurrentPageShapes: () => Rec[]; getBindingsFromShape: (id: string, type: string) => Array<{ toId: string; props: { terminal: string } }> };
  project: Who; identity: { project: Who; switching: Who; state: string; kept: Array<{ words: string }> };
  addNode: (kind: string, id: string) => Promise<{ words: string }>;
} };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
/** Step 4c: the page's handle, with the editor as tldraw gives it and the connections' hooks. */
type WinC = { timmyCanvas: { editor: Any; connectNodes: (from: string, to: string) => Promise<{ words: string }>; connections: () => Array<{ arrow: string; data: boolean | null; words: string; by: string }>; identity: { kept: Array<{ words: string }> } } };
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
    await page.route(ANY_URL, passOn);
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
      let routed = 0;
      const holdRead = async (route: Route): Promise<void> => {
        routed += 1;
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/project') { await route.fallback(); return; }
        readHeld = true;
        const answered = await route.fetch();
        await readGate;
        await route.fulfill({ response: answered });
      };
      await page.route(ANY_URL, holdRead);
      const held = page.evaluate(() => (window as never as Win).timmyCanvas.addNode('params', 'params:recipes/tray.params.json').then((r) => r.words, (e: Error) => e.message));
      await until('the add\'s reading is held', () => readHeld, 10_000);
      // blank's board is held from loading, so Studio stays switching while a person presses Add
      const boardGate = new Promise<void>((done) => { releaseBoard = done; });
      const holdBoard = async (route: Route): Promise<void> => {
        routed += 1;
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/canvas/document' || u.searchParams.get('project') !== blank.id) { await route.fallback(); return; }
        await boardGate;
        await route.fallback();
      };
      await page.route(ANY_URL, holdBoard);
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
      await page.unroute(ANY_URL, holdRead);
      releaseBoard();
      await page.unroute(ANY_URL, holdBoard);
      await gone(page, () => routed);
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

  it("connections: the operation's own arrows carry data; Connect draws a labelled link where no data flows and the operation's own link where it does; a drawn arrow is labelled once its gesture ends, a person's words are kept; refused while Studio switches", async () => {
    expect(added.length).toBeGreaterThan(3);
    const s = await open();
    const { page } = s;
    let releaseRead: () => void = () => {};
    let releaseBoard: () => void = () => {};
    /** The arrows on the board on screen bound from shape `a` (start) to shape `b` (end). */
    const arrowsBetween = (a: string, b: string): Promise<Rec[]> => page.evaluate((x) => {
      const e = (window as never as WinC).timmyCanvas.editor;
      return e.getCurrentPageShapes().filter((r: Rec) => r.type === 'arrow').filter((r: Rec) => {
        const bs = e.getBindingsFromShape(r.id, 'arrow') as Array<{ toId: string; props: { terminal: string } }>;
        return bs.some((y) => y.props.terminal === 'start' && y.toId === x.a) && bs.some((y) => y.props.terminal === 'end' && y.toId === x.b);
      });
    }, { a, b });
    // (the editor's own methods return the editor: a page.evaluate that calls one sends nothing back)
    /** The panel's Connections, as drawn. */
    const listed = () => page.$$eval('#node-link-list li.nlink', (ls) => ls.map((l) => ({
      arrow: l.getAttribute('data-arrow'), flow: l.getAttribute('data-flow'), from: l.getAttribute('data-from'), to: l.getAttribute('data-to'),
      kind: l.querySelector('.nlink-kind')?.textContent ?? null, ends: l.querySelector('.nlink-ends')?.textContent ?? null,
      words: l.querySelector('.nlink-words')?.textContent ?? null, by: l.querySelector('.nlink-by')?.textContent ?? null,
    })));
    const select = (ids: string[]) => page.evaluate((x) => { const e = (window as never as WinC).timmyCanvas.editor; e.selectNone(); e.select(...x); }, ids);
    /** Presses Connect with nodes `a` then `b` selected; the band's words once it speaks. */
    async function connect(a: string, b: string): Promise<{ said: string; kind: string | null }> {
      await select([a, b]);
      await page.waitForFunction((x) => { const n = document.getElementById('node-connect') as HTMLButtonElement; return !n.disabled && n.dataset.from === x.a && n.dataset.to === x.b; }, { a, b }, { timeout: 10_000 });
      await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
      await page.click('#node-connect');
      await page.waitForFunction(() => (document.getElementById('project-said')?.textContent ?? '').trim() !== '', null, { timeout: 15_000 });
      return { said: await text(page, '#project-said'), kind: await page.getAttribute('#project-said', 'data-kind') };
    }
    /** Brings shapes `ids` into the canvas area beside the side panel (the camera only). */
    const view = (ids: string[]) => page.evaluate((x) => {
      const e = (window as never as WinC).timmyCanvas.editor;
      const bs = x.map((id: string) => e.getShapePageBounds(id)).filter(Boolean);
      const minX = Math.min(...bs.map((b: Any) => b.minX)); const maxX = Math.max(...bs.map((b: Any) => b.maxX));
      const minY = Math.min(...bs.map((b: Any) => b.minY)); const maxY = Math.max(...bs.map((b: Any) => b.maxY));
      const side = document.getElementById('side')!.getBoundingClientRect();
      const v = e.getViewportScreenBounds();
      const left = side.right + 32 - v.x;
      const free = { x: left, y: 90, w: v.w - left - 32, h: v.h - 90 - 130 };
      const z = Math.min(1, free.w / Math.max(1, maxX - minX), free.h / Math.max(1, maxY - minY));
      e.setCamera({ x: (free.x + free.w / 2) / z - (minX + maxX) / 2, y: (free.y + free.h / 2) / z - (minY + maxY) / 2, z }, { immediate: true });
    }, ids);
    try {
      await shows(page, tray);
      const blankBefore = files(blank);
      // tray's reading, as the server answers it: the expected words are the page's own rules applied to it
      const session = await pageSession(port, server.projectToken);
      const reading = (await call(port, 'GET', '/api/project?detail=1', { headers: bearer(session) })).json;
      const orders = ordersOf(reading, drawnType);
      const records = recordsOf(reading);
      const op = operation.op;
      const order = orders[op] as string[];
      expect(order.length).toBeGreaterThan(1);
      const recs: Rec[] = await page.evaluate(() => (window as never as WinC).timmyCanvas.editor.getCurrentPageShapes().filter((r: Rec) => /^timmy-(workflow|params|result)$/.test(r.type)));
      const node = (ok: (r: Rec) => boolean) => { const r = recs.find(ok); if (!r) throw new Error('a node test 1 added is not on the board'); return nodeOf(r)!; };
      const P = node((r) => r.props.card === 'params:box.params.json' && !r.meta.timmyOperation);
      const W = node((r) => r.props.card === 'workflow:BUILD.md' && !r.meta.timmyOperation);
      const F = node((r) => r.props.card === `flow:${canvasProject.flow}` && !r.meta.timmyOperation);
      const O = order.map((card) => node((r) => r.props.card === card && r.meta.timmyOperation === op));
      const words = (a: typeof P, b: typeof P): string => connectionOf(a, b, orders, records).words;

      // the operation's own arrows: each listed as data, from a card of the operation to the next, drawn for it
      await page.waitForFunction((n) => document.querySelectorAll('#node-link-list li.nlink[data-flow="data"]').length === n, O.length - 1, { timeout: 15_000 });
      const own = O.slice(1).map((b, i) => ({ flow: 'data', from: O[i].id, to: b.id, kind: `data · operation ${op}`, ends: `${O[i].title} → ${b.title}`, words: words(O[i], b), by: `drawn for operation ${op}` }));
      expect(own.every((w) => w.words === `Data flows: ${w.ends}, the next step of operation ${op} in the order its records give.`)).toBe(true);
      const first = await listed();
      expect(first.map(({ arrow: _a, ...rest }) => rest)).toEqual(own);
      expect((await page.evaluate(() => (window as never as WinC).timmyCanvas.connections())).map((c) => [c.arrow, c.data, c.words, c.by])).toEqual(first.map((l) => [l.arrow, true, l.words, l.by]));
      expect(await text(page, '#node-links-note')).toBe(`Data flows only along an operation's own links: from a card its operation node placed to the card that ran next. Any other arrow between two nodes is a link only, and says so on the board ("${LINK_LABEL}"); words you write on an arrow are kept.`);
      expect(await page.isDisabled('#node-connect')).toBe(true);
      expect(await text(page, '#node-connect-note')).toBe("Select two nodes on tray's board (shift-click the second): Connect draws an arrow from the first you select to the second.");

      // Connect, a parameter node to a workflow node: no record names a data path, so a link that says so
      const pwWords = words(P, W);
      expect(pwWords).toBe(`Link only, no data flows: Timmy's records name no data path from ${P.title} to ${W.title}; data flows only along an operation's own links.`);
      await select([P.id, W.id]);
      await page.waitForFunction((x) => (document.getElementById('node-connect') as HTMLButtonElement).dataset.to === x, W.id, { timeout: 10_000 });
      expect(await text(page, '#node-connect-note')).toBe(`From ${P.title} to ${W.title}: ${pwWords}`);
      expect(await connect(P.id, W.id)).toEqual({ said: `Connected ${P.title} → ${W.title}. ${pwWords}`, kind: 'ok' });
      const [pw, ...pwMore] = await arrowsBetween(P.id, W.id);
      expect(pwMore).toEqual([]);
      expect([pw.props.dash, pw.props.kind, richWords(pw.props.richText), pw.meta.timmyOperation]).toEqual(['dashed', 'elbow', LINK_LABEL, undefined]);
      expect(pw.meta[LINK_META]).toEqual({ v: 1, from: 'params:box.params.json', to: 'workflow:BUILD.md', project: tray.id, data: false, by: 'connect', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
      await page.waitForFunction((id) => !!document.querySelector(`#node-link-list li.nlink[data-arrow="${id}"]`), pw.id, { timeout: 10_000 });
      expect((await listed()).find((l) => l.arrow === pw.id)).toEqual({ arrow: pw.id, flow: 'link', from: P.id, to: W.id, kind: 'link only', ends: `${P.title} → ${W.title}`, words: pwWords, by: 'drawn by Connect' });
      // a second press: already connected, nothing drawn
      expect(await connect(P.id, W.id)).toEqual({ said: `Already connected: ${pwWords}`, kind: 'ok' });
      expect((await arrowsBetween(P.id, W.id)).map((r) => r.id)).toEqual([pw.id]);
      // one undo takes the connection back; redo brings it again
      await page.evaluate(() => { (window as never as WinC).timmyCanvas.editor.undo(); });
      expect(await arrowsBetween(P.id, W.id)).toEqual([]);
      await page.evaluate(() => { (window as never as WinC).timmyCanvas.editor.redo(); });
      expect((await arrowsBetween(P.id, W.id)).map((r) => r.id)).toEqual([pw.id]);

      // a person deletes the operation's own arrow from its first card to its second; Connect draws the operation's link again
      const [own01] = await arrowsBetween(O[0].id, O[1].id);
      expect(own01.meta.timmyOperation).toBe(op);
      await page.evaluate((id) => { (window as never as WinC).timmyCanvas.editor.deleteShapes([id]); }, own01.id);
      await page.waitForFunction((id) => !document.querySelector(`#node-link-list li.nlink[data-arrow="${id}"]`), own01.id, { timeout: 10_000 });
      const dataWords = words(O[0], O[1]);
      expect(dataWords).toBe(`Data flows: ${O[0].title} → ${O[1].title}, the next step of operation ${op} in the order its records give.`);
      expect(await connect(O[0].id, O[1].id)).toEqual({ said: `Connected ${O[0].title} → ${O[1].title}. ${dataWords}`, kind: 'ok' });
      const [again] = await arrowsBetween(O[0].id, O[1].id);
      expect(again.id).not.toBe(own01.id);
      expect(again.meta).toEqual({ timmyOperation: op });
      expect([again.props.dash, richWords(again.props.richText)]).toEqual(['solid', '']);
      // the page's record of the operation names it as the operation's link, so its node, pressed again, adds nothing and speaks of no deleted arrow
      const placed = await page.evaluate((k) => (window as never as WinC).timmyCanvas.editor.getCurrentPage().meta.timmyOperations[k], `${tray.id}:${op}`);
      expect(placed.links.filter((l: { from: string; to: string }) => l.from === O[0].card && l.to === O[1].card)).toEqual([{ from: O[0].card, to: O[1].card, arrow: again.id }]);
      await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
      await page.click(`#node-palette li.nitem[data-node-kind="operation"][data-node-id="${op}"] button.nitem-add`);
      await page.waitForFunction(() => (document.getElementById('project-said')?.textContent ?? '').trim() !== '', null, { timeout: 15_000 });
      const pressed = await text(page, '#project-said');
      expect(pressed.startsWith(`Operation ${op}: nothing added; ${O.length} cards already placed for it, left as they are`)).toBe(true);
      expect(pressed).not.toMatch(/deleted/);
      // the same cards the wrong way round: a link that says which ran first
      const backWords = words(O[1], O[0]);
      expect(backWords).toBe(`Link only, no data flows: ${O[0].title} ran before ${O[1].title} in operation ${op}.`);
      expect(await connect(O[1].id, O[0].id)).toEqual({ said: `Connected ${O[1].title} → ${O[0].title}. ${backWords}`, kind: 'ok' });
      const [back] = await arrowsBetween(O[1].id, O[0].id);
      expect([back.props.dash, richWords(back.props.richText), back.meta[LINK_META].by, back.meta.timmyOperation]).toEqual(['dashed', LINK_LABEL, 'connect', undefined]);
      // it runs in a lane of its own beside the operation's link between the same two cards, never over it
      const lanes = await page.evaluate((x) => x.map((id) => ((window as never as WinC).timmyCanvas.editor.getBindingsFromShape(id, 'arrow') as Array<{ props: { terminal: string; normalizedAnchor: { x: number; y: number }; isPrecise: boolean } }>)
        .map((b) => [b.props.terminal, b.props.normalizedAnchor.y, b.props.isPrecise]).sort()), [again.id, back.id]);
      expect(lanes).toEqual([[['end', 0.5, false], ['start', 0.5, false]], [['end', 0.7, true], ['start', 0.7, true]]]);

      // an arrow drawn with tldraw's arrow tool from the flow node to the workflow node: not labelled while the gesture lasts; once
      // it ends, labelled once, by Studio
      await select([]);
      await view([F.id, W.id]);
      const at = (id: string) => page.$eval(`[data-timmy-card="${id}"] .tc-title`, (t) => { const b = t.getBoundingClientRect(); return { x: b.left + Math.min(24, b.width / 2), y: b.top + b.height / 2 }; });
      const from = await at(F.id);
      const to = await at(W.id);
      await page.evaluate(() => { (window as never as WinC).timmyCanvas.editor.setCurrentTool('arrow'); });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2 + 40, { steps: 8 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.waitForFunction((x) => {
        const e = (window as never as WinC).timmyCanvas.editor;
        return e.getCurrentPageShapes().some((r: Rec) => r.type === 'arrow' && (e.getBindingsFromShape(r.id, 'arrow') as Array<{ toId: string; props: { terminal: string } }>).filter((y) => (y.props.terminal === 'start' && y.toId === x.a) || (y.props.terminal === 'end' && y.toId === x.b)).length === 2);
      }, { a: F.id, b: W.id }, { timeout: 10_000 });
      await page.waitForTimeout(900);
      const [mid] = await arrowsBetween(F.id, W.id);
      expect([richWords(mid.props.richText), mid.meta[LINK_META]]).toEqual(['', undefined]);
      await page.mouse.up();
      await page.waitForFunction((id) => !!(window as never as WinC).timmyCanvas.editor.getShape(id)?.meta?.timmyLink, mid.id, { timeout: 10_000 });
      const [drawn] = await arrowsBetween(F.id, W.id);
      expect(drawn.id).toBe(mid.id);
      const fwWords = words(F, W);
      expect(fwWords.startsWith('Link only, no data flows: ')).toBe(true);
      expect([richWords(drawn.props.richText), drawn.meta[LINK_META]]).toEqual([LINK_LABEL, { v: 1, from: F.card, to: W.card, project: tray.id, data: false, by: 'label', at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
      await page.waitForFunction((id) => document.querySelector(`#node-link-list li.nlink[data-arrow="${id}"] .nlink-by`)?.textContent === 'drawn by hand; labelled by Studio', drawn.id, { timeout: 10_000 });
      expect((await listed()).find((l) => l.arrow === drawn.id)).toEqual({ arrow: drawn.id, flow: 'link', from: F.id, to: W.id, kind: 'link only', ends: `${F.title} → ${W.title}`, words: fwWords, by: 'drawn by hand; labelled by Studio' });
      // a label a person takes off is not put back
      await page.evaluate((id) => { (window as never as WinC).timmyCanvas.editor.updateShape({ id, type: 'arrow', props: { richText: { type: 'doc', content: [{ type: 'paragraph' }] } } }); }, drawn.id);
      await page.waitForTimeout(900);
      const [bare] = await arrowsBetween(F.id, W.id);
      expect([richWords(bare.props.richText), bare.meta[LINK_META].by]).toEqual(['', 'label']);
      await page.waitForFunction((id) => document.querySelector(`#node-link-list li.nlink[data-arrow="${id}"] .nlink-by`)?.textContent === 'drawn by hand; its label taken off by hand', drawn.id, { timeout: 10_000 });
      // an arrow with a person's own words on it (as one typed on it), from the workflow node to the flow node: its words kept
      const mine = 'shape:r6-h145-own-words';
      await page.evaluate((x) => {
        const e = (window as never as WinC).timmyCanvas.editor;
        e.setCurrentTool('select');
        e.createShape({ id: x.id, type: 'arrow', x: 0, y: 0, props: { start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'feeds the tray' }] }] } } });
        e.createBindings([
          { type: 'arrow', fromId: x.id, toId: x.a, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
          { type: 'arrow', fromId: x.id, toId: x.b, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false, isExact: false } },
        ]);
      }, { id: mine, a: W.id, b: F.id });
      await page.waitForFunction((id) => !!document.querySelector(`#node-link-list li.nlink[data-arrow="${id}"]`), mine, { timeout: 10_000 });
      await page.waitForTimeout(900);
      const [kept] = await arrowsBetween(W.id, F.id);
      expect([kept.id, richWords(kept.props.richText), kept.meta[LINK_META]]).toEqual([mine, 'feeds the tray', undefined]);
      expect((await listed()).find((l) => l.arrow === mine)).toEqual({ arrow: mine, flow: 'link', from: W.id, to: F.id, kind: 'link only', ends: `${W.title} → ${F.title}`, words: words(W, F), by: 'drawn by hand; its own words kept' });

      // all of it saved to tray's board; blank's board files as they were
      await savedState(page);
      await page.waitForTimeout(600);
      await savedState(page);
      const disk = (JSON.parse(readFileSync(join(board(tray), 'canvas.json'), 'utf8')) as { snapshot: { store: Record<string, Rec> } }).snapshot.store;
      expect([disk[pw.id]?.meta[LINK_META]?.by, richWords(disk[pw.id]?.props.richText)]).toEqual(['connect', LINK_LABEL]);
      expect(disk[again.id]?.meta).toEqual({ timmyOperation: op });
      expect(disk[own01.id]).toBeUndefined();
      expect([disk[back.id]?.meta[LINK_META]?.by, richWords(disk[back.id]?.props.richText)]).toEqual(['connect', LINK_LABEL]);
      expect([disk[drawn.id]?.meta[LINK_META]?.by, richWords(disk[drawn.id]?.props.richText)]).toEqual(['label', '']);
      expect([disk[mine]?.meta[LINK_META], richWords(disk[mine]?.props.richText)]).toEqual([undefined, 'feeds the tray']);
      const page0 = Object.values(disk).find((r) => r.typeName === 'page' && (r.meta as Any)?.timmyOperations);
      expect(((page0!.meta as Any).timmyOperations[`${tray.id}:${op}`].links as Array<{ from: string; to: string; arrow: string }>).filter((l) => l.from === O[0].card && l.to === O[1].card)).toEqual([{ from: O[0].card, to: O[1].card, arrow: again.id }]);
      expect(files(blank)).toEqual(blankBefore);
      const before = await listed();
      expect(before.map((l) => l.flow).sort()).toEqual([...Array(O.length - 1).fill('data'), 'link', 'link', 'link', 'link'].sort());
      await view([P.id, W.id, F.id, ...O.map((o) => o.id)]);
      await select([]);
      await page.evaluate(() => document.getElementById('node-links')!.scrollIntoView({ block: 'start' }));
      await capture(page, '15-node-connections');

      // while Studio switches to blank: a connection is refused in words; one whose reading of tray was held across the switch
      // connects nothing (noted under Kept apart); blank's Connections are blank's (none); back on tray, tray's are as they were
      const trayBefore = files(tray);
      const readGate = new Promise<void>((done) => { releaseRead = done; });
      let readHeld = false;
      let routed = 0;
      const holdRead = async (route: Route): Promise<void> => {
        routed += 1;
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/project') { await route.fallback(); return; }
        readHeld = true;
        const answered = await route.fetch();
        await readGate;
        await route.fulfill({ response: answered });
      };
      await page.route(ANY_URL, holdRead);
      const held = page.evaluate((x) => (window as never as WinC).timmyCanvas.connectNodes(x.a, x.b).then((r) => r.words, (e: Error) => e.message), { a: P.id, b: F.id });
      await until('the connection\'s reading is held', () => readHeld, 10_000);
      const boardGate = new Promise<void>((done) => { releaseBoard = done; });
      const holdBoard = async (route: Route): Promise<void> => {
        routed += 1;
        const u = new URL(route.request().url());
        if (u.pathname !== '/api/canvas/document' || u.searchParams.get('project') !== blank.id) { await route.fallback(); return; }
        await boardGate;
        await route.fallback();
      };
      await page.route(ANY_URL, holdBoard);
      workbench(blank);
      await named(blank);
      await page.waitForFunction((id) => (window as never as Win).timmyCanvas.identity.state === 'switching' && (window as never as Win).timmyCanvas.identity.switching?.id === id, blank.id, { timeout: 20_000 });
      expect(await page.evaluate((x) => (window as never as WinC).timmyCanvas.connectNodes(x.a, x.b).then((r) => r.words, (e: Error) => e.message), { a: W.id, b: F.id }))
        .toBe('Not connected: Studio is switching to blank, so nothing is connected on either board until its board is loaded.');
      await page.waitForFunction(() => (document.getElementById('node-link-list')?.textContent ?? '') === 'No board on screen.', null, { timeout: 10_000 });
      expect(await text(page, '#node-connect-note')).toBe('Not connected: Studio is switching to blank, so nothing is connected on either board until its board is loaded.');
      releaseRead();
      expect(await held).toBe("Not connected: Studio switched boards while it read tray's records, so nothing was connected on either board.");
      await page.unroute(ANY_URL, holdRead);
      releaseBoard();
      await page.unroute(ANY_URL, holdBoard);
      await gone(page, () => routed);
      await shows(page, blank);
      await page.waitForFunction(() => /^No connections on this board yet/.test(document.getElementById('node-link-list')?.textContent ?? ''), null, { timeout: 10_000 });
      expect(await page.locator('#node-link-list li.nlink').count()).toBe(0);
      const keptApart = await page.evaluate(() => (window as never as WinC).timmyCanvas.identity.kept.map((k) => k.words));
      expect(keptApart.some((w) => /^A reading of tray \(its records\) came back after Studio switched to blank: it was dropped/.test(w))).toBe(true);
      await page.waitForTimeout(800);
      expect(files(tray)).toEqual(trayBefore);
      expect(files(blank)).toEqual(blankBefore);
      workbench(tray);
      await named(tray);
      await shows(page, tray);
      await page.waitForFunction((n) => document.querySelectorAll('#node-link-list li.nlink').length === n && !document.querySelector('#node-link-list li.nlink[data-flow="unread"]'), before.length, { timeout: 15_000 });
      expect((await listed()).map((l) => [l.arrow, l.flow, l.words, l.by]).sort()).toEqual(before.map((l) => [l.arrow, l.flow, l.words, l.by]).sort());
      expect(files(blank)).toEqual(blankBefore);
      expect(s.errors).toEqual([]);
    } finally {
      releaseRead();
      releaseBoard();
      await s.context.close();
    }
  });
});
