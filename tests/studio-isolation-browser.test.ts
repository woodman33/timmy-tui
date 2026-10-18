/**
 * R6 (H139): Studio project isolation, in a real headless Chromium against the real canvas server and the real bundle (built here
 * into a temporary folder), with a real temporary Timmy home and two FAKE disposable projects, tray and blank (folders made here,
 * each with shapes and a workflow document of its own). The operator's words (2026-10-16, priority 1 of the round): "Fix Studio
 * project isolation first. Project identity, board, drafts, jobs, artifact links and save/action targets must change together.
 * Block edits while switching. Test two distinct disposable projects, pending drafts, delayed responses and save/reopen; prove
 * neither project's content is written into the other."
 *
 * FAKE, said where used: what proposes drafts is the agent's own canvas tools (src/agent/canvas-tools.ts) with one REPL's
 * credentials (its token, its holder id, the project it draws on, how often it opened the page), sending code this file writes: a
 * scripted tool call standing in for a model (no model runs). The active project changes as the Workbench's p writes it
 * (<TIMMY_HOME>/state/active-project.json, which the server follows) and as a REPL's /project names it (POST /api/project/active
 * with that REPL's holder id). Responses are held with Playwright's routing, and a call holds itself (its code waits before it
 * draws), so that they come back after the switch. Every file of both projects' boards is hashed before and after each step.
 * Skipped, saying so, where no Chromium or Chrome is found.
 *
 * Captures (PNG) are written only when TIMMY_R6_CAPTURES names a folder; each carries a band that says it is FAKE and scripted.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools, linkCanvasReceipt } from '../src/agent/canvas-tools.js';
import { projectId } from '../src/project/index.js';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { CanvasDocuments, shownPath } from '../src/studio/document.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-isolation-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Rec = { id: string; type: string; props: Record<string, unknown> };
type Ed = { getCurrentPageShapes: () => Rec[]; createShapes: (s: unknown[]) => void; getInstanceState: () => { isReadonly: boolean } };
type Who = { id: string; name: string } | null;
type Win = { timmyCanvas: { editor: Ed; project: Who; document: { revision: number }; identity: { project: Who; switching: Who; state: string; kept: Array<{ at: string; words: string }> }; placeDrawnCard: (id: string) => Promise<{ shape: string }>; drafts: () => Array<{ id: string; shapes: string[]; job: string | null }> } };
type Answer = { ok: boolean; result?: unknown; error?: string; jobId?: string; revision?: number; changed?: boolean; notRun?: string; kept?: string; project?: { id: string; name: string }; draft?: { id: string; shapes?: number; from?: number; refused?: string } };
type Project = { name: string; root: string; id: string };

/** The REPL these tests stand in for: its holder id (as /canvas open names it). */
const HOLDER = 'e'.repeat(32);
const CAPTURES = process.env.TIMMY_R6_CAPTURES?.trim() || '';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** tldraw's rich text (as helpers.toRichText makes it), for shapes drawn by hand here */
const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
/** A FAKE draft: three boxes, as a model's canvas_exec code would draw them, in a row at `y`. `wait`: ms its code waits before it draws. */
const threeBoxes = (label: string, o: { wait?: number; y?: number } = {}) => `${o.wait ? `await new Promise((r) => setTimeout(r, ${o.wait})); ` : ''}const { createShapeId, toRichText } = helpers; const ids = ['a', 'b', 'c'].map(() => createShapeId()); editor.createShapes(ids.map((id, i) => ({ id, type: 'geo', x: 520 + i * 200, y: ${o.y ?? 160}, props: { w: 160, h: 80, richText: toRichText('${label} ' + 'abc'[i]) } }))); return ids;`;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe.skipIf(!browserPath)('Studio project isolation: two projects, pending drafts, delayed responses and save/reopen, in a real browser', () => {
  let pageRoot = '';
  let home = '';
  let base = '';
  let port = 0;
  let server: StudioServer;
  let browser: Browser;
  const dirs: string[] = [];
  let tray: Project;
  let blank: Project;
  /** The project the REPL draws on (its /project), and how many times it opened the canvas page (its /canvas open). */
  let replOn: Project;
  let opened = 0;
  let ask: (name: string, args: Record<string, unknown>) => Promise<Answer>;

  const project = (name: string, title: string): Project => {
    const root = join(mkdtempSync(join(tmpdir(), `timmy-iso-${name}-`)), name);
    dirs.push(join(root, '..'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${title}\n\n\`\`\`bash [name:build]\necho ${name}\n\`\`\`\n`);
    return { name, root, id: projectId(root) };
  };

  beforeAll(async () => {
    tray = project('tray', 'Tray build');
    blank = project('blank', 'Blank build');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-iso-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-iso-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // a server that serves this Timmy home for its REPLs, as the REPL's own and `timmy studio` do: it follows the active project.
    // The page's workspace strip reads Timmy's settings: this file's own folder (TIMMY_SETTINGS_DIR, as the other Studio tests).
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    // one REPL, with one set of canvas tools for all its turns (as src/repl keeps them): its credentials name its project now
    const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server.projectToken, holder: HOLDER, project: replOn.id, opened }) });
    ask = (name, args) => (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown) => Promise<Answer>)(args);
    await repl(tray);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [...dirs, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  // ── the ways the active project changes ──────────────────────────────────────────────────────────────────────────────
  /** The REPL's /project (and /canvas open): it draws on `p` now and names it to the canvas, with its holder id. */
  async function repl(p: Project): Promise<void> {
    replOn = p;
    const r = await nameProject(port, server.projectToken, { root: p.root, name: p.name, holder: HOLDER });
    expect(r.status).toBe(200);
  }
  /** The Workbench's p: the active project of this Timmy home, written as src/project/index.ts saveActiveProject writes it. */
  function workbench(p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  // ── what is on disk ──────────────────────────────────────────────────────────────────────────────────────────────────
  const dirOf = (p: Project): string => boardDir(join(home, 'canvas'), p.id);
  /** Every file of project `p`'s board, with its sha256 (none yet: {}). */
  function files(p: Project): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dirOf(p), f)] = sha(readFileSync(f)); }
    };
    walk(dirOf(p));
    return out;
  }
  const saved = (p: Project) => new CanvasDocuments(dirOf(p));
  const savedText = (p: Project): string => { try { return readFileSync(join(dirOf(p), 'canvas.json'), 'utf8'); } catch { return ''; } };
  /** The shapes on `p`'s board on disk: their ids, in order. */
  const onDisk = (p: Project): string[] => Object.keys((saved(p).load().snapshot as { store: Record<string, unknown> }).store).filter((k) => k.startsWith('shape:')).sort();

  // ── the page ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * A Studio page in its own browser context. `errors`: what failed on the page (its errors, and its console's), but for the
   * readings the server refused as another project's (409: asked before a switch, answered after it; the page drops them),
   * kept in `refused`; `console`: the console's other lines (the "Kept apart" log among them).
   */
  interface Studio { page: Page; context: BrowserContext; errors: string[]; refused: string[]; console: string[] }
  async function context(size = { width: 1440, height: 900 }): Promise<BrowserContext> {
    const c = await browser.newContext({ viewport: size });
    // every request the page makes goes to this server (anything else is aborted)
    await c.route('**/*', (route) => (new URL(route.request().url()).origin === base || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    return c;
  }
  function watch(page: Page, s: Pick<Studio, 'errors' | 'refused' | 'console'>): void {
    page.on('pageerror', (e) => s.errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') s.console.push(m.text());
      else if (/^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/.test(m.text())) s.refused.push(m.text());
      else s.errors.push(m.text());
    });
  }
  async function open(): Promise<Studio> {
    const c = await context();
    const page = await c.newPage();
    const s: Studio = { page, context: c, errors: [], refused: [], console: [] };
    watch(page, s);
    // the REPL's /canvas open: one more page opened, with a one-time grant in its address
    opened += 1;
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return s;
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** Studio shows `p`'s board: its identity, its board, its header and its Project panel all name `p`, and no switch is under way. */
  async function shows(page: Page, p: Project): Promise<void> {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id && t.project?.id === id; }, p.id, { timeout: 20_000 });
    await page.waitForFunction((n) => document.getElementById('frame-project')?.textContent === n && document.getElementById('frame')?.dataset.switching !== 'true', p.name, { timeout: 20_000 });
    await page.waitForFunction((n) => document.getElementById('project-name')?.textContent === n, p.name, { timeout: 20_000 });
  }
  /** The board on screen: each shape's id, type and text, in id order. */
  const board = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().map((s) => {
    const words: string[] = [];
    const walk = (n: unknown): void => { if (!n || typeof n !== 'object') return; const o = n as { text?: unknown; content?: unknown[] }; if (typeof o.text === 'string') words.push(o.text); for (const c of o.content ?? []) walk(c); };
    walk(s.props.richText);
    return { id: s.id, type: s.type, text: words.join('') };
  })).then((list) => list.sort(byId));
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  /** Shapes drawn by a person's hand (the page's own editor, as tldraw's tools make them). */
  const draw = (page: Page, shapes: Array<{ id: string; text: string; x: number }>) => page.evaluate((list) => {
    (window as never as Win).timmyCanvas.editor.createShapes(list.map((s) => ({ id: s.id, type: 'geo', x: s.x, y: 420, props: { w: 150, h: 70, richText: s.rich } })));
  }, shapes.map((s) => ({ ...s, rich: rich(s.text) })));
  const kept = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.identity.kept.map((k) => k.words));
  const readonly = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getInstanceState().isReadonly);
  const drafts = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.drafts());
  /** A capture for the lead, with a band that says what drove it (only when TIMMY_R6_CAPTURES names a folder). */
  async function capture(page: Page, name: string): Promise<void> {
    if (!CAPTURES) return;
    mkdirSync(CAPTURES, { recursive: true });
    await page.evaluate(() => {
      if (document.getElementById('fake-band')) return;
      const b = document.createElement('div');
      b.id = 'fake-band';
      b.textContent = 'SCRIPTED TEST · headless Chromium · FAKE drafts: scripted canvas_exec calls, no model · disposable projects tray and blank';
      Object.assign(b.style, { position: 'fixed', right: '8px', bottom: '8px', zIndex: '400', padding: '4px 8px', background: '#070707', color: '#F2EFE9', border: '1px solid #444444', font: '12px/1.4 monospace', pointerEvents: 'none' });
      document.body.append(b);
    });
    await page.screenshot({ path: join(CAPTURES, `${name}.png`) });
  }
  /**
   * The first request the page makes that `match` names, held until release(). `fetchFirst`: the server answers it at once (a save
   * lands on disk, a reading is read then) and only its answer reaches the page late.
   */
  function hold(page: Page, match: (url: URL, method: string) => boolean, o: { fetchFirst?: boolean } = {}) {
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    let seen = false;
    // R6 lead (CI at e6b4da5 and once before): with fetchFirst, until() returned once the request was seen, before the server
    // had answered it; the test's next step (the REPL's /project for the other board) could then reach the server first, so the
    // server refused the held read (409: the canvas shows another project) and the late answer the test waits for never came.
    // until() now waits for the server's answer too: the read is answered while its project is named, as the case says.
    let answeredNow = false;
    const all = () => true;
    const handler = async (route: Route): Promise<void> => {
      const req = route.request();
      if (seen || !match(new URL(req.url()), req.method())) { await route.fallback(); return; }
      seen = true;
      if (o.fetchFirst) {
        const answered = await route.fetch();
        answeredNow = true;
        await gate;
        await route.fulfill({ response: answered });
      } else {
        await gate;
        await route.continue();
      }
    };
    const ready = () => seen && (!o.fetchFirst || answeredNow);
    return {
      install: () => page.route(all, handler),
      release: () => release(),
      remove: () => page.unroute(all, handler),
      until: async () => {
        for (let i = 0; i < 100 && !ready(); i++) await page.waitForTimeout(100);
        expect(seen).toBe(true);
        if (o.fetchFirst) expect(answeredNow, 'the server answered the held request').toBe(true);
      },
    };
  }
  const docOf = (p: Project) => (u: URL, m: string) => m === 'GET' && u.pathname === '/api/canvas/document' && u.searchParams.get('project') === p.id;

  it("the board, its pending draft, its jobs, its cards and links, the header and every action switch together: blocked while switching, nothing of tray under blank's name, tray's draft still tray's when Studio switches back; neither project's files are written by the other's steps", async () => {
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      // tray's own shapes, drawn by hand on its board
      await draw(page, [{ id: 'shape:tray-1', text: 'tray one', x: 360 }, { id: 'shape:tray-2', text: 'tray two', x: 560 }, { id: 'shape:tray-3', text: 'tray three', x: 760 }]);
      await savedState(page);
      // tray's card (its workflow document), drawn on its board
      const card = await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:BUILD.md'));
      await page.waitForSelector(`[data-timmy-card="${card.shape}"] .tc-title`);
      expect(await text(page, `[data-timmy-card="${card.shape}"] .tc-title`)).toBe('Tray build');
      await savedState(page);
      // FAKE: a scripted canvas_exec call proposes a draft on tray (no model)
      const drawn = await ask('canvas_exec', { code: threeBoxes('tray draft'), jobId: 'turn-tray-draft' });
      expect(drawn).toMatchObject({ ok: true, jobId: 'turn-tray-draft', project: { id: tray.id, name: 'tray' }, draft: { id: expect.stringMatching(/^draft-/), shapes: 3 } });
      expect(drawn.kept).toBeUndefined();
      const trayDraft = drawn.draft!.id;
      // R6 item d: the job its draft names is listed at once (never "No jobs yet" while the draft waits)
      await page.waitForSelector('#job-list li[data-job="turn-tray-draft"]', { timeout: 1500 });
      // its receipt, linked as the REPL links a sealed turn's: an artifact link of tray's job, in tray's jobs ledger
      expect(await linkCanvasReceipt('turn-tray-draft', 'a1b2c3d4', base, server.projectToken)).toBe(true);
      await page.waitForFunction(() => document.querySelector('#job-list li[data-job="turn-tray-draft"] a')?.getAttribute('href') === '/receipts/a1b2c3d4', null, { timeout: 15_000 });
      await savedState(page);

      // ── Studio on tray, with tray's pending draft ──
      const trayBoard = await board(page);
      expect(trayBoard.filter((x) => x.id.startsWith('shape:tray-')).map((x) => x.text)).toEqual(['tray one', 'tray two', 'tray three']);
      expect(trayBoard.filter((x) => x.text.startsWith('tray draft')).map((x) => x.text).sort()).toEqual(['tray draft a', 'tray draft b', 'tray draft c']);
      expect(trayBoard.map((x) => x.id)).toEqual(onDisk(tray));
      expect(await text(page, '#frame-project')).toBe('tray');
      expect(await text(page, '#project-name')).toBe('tray');
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Tray build');
      expect(await text(page, '#drafts-count')).toBe('1 waiting for you');
      // R8 (H158; open item J): the FAKE draft's boxes land on tray's drawn card (placed where Timmy places cards, at the top of the
      // area beside the panel): its card says so, with Move it to free space beside the words (tests/studio-draft-overlap-browser
      // .test.ts moves one; here it stays where it is)
      expect(await text(page, `#draft-list li[data-draft="${trayDraft}"] .draft-over-words`)).toBe('This draft lands on 1 shape already on the board.');
      expect(await page.locator(`#draft-list li[data-draft="${trayDraft}"] button`).allTextContents()).toEqual(['Move it to free space', 'Show', 'Accept', 'Discard']);
      expect(await page.isEnabled(`#draft-list li[data-draft="${trayDraft}"] .draft-accept`)).toBe(true);
      expect(await page.isEnabled(`#draft-list li[data-draft="${trayDraft}"] .draft-discard`)).toBe(true);
      expect(await readonly(page)).toBe(false);
      await capture(page, 'h139-01-studio-on-tray-with-its-pending-draft');
      expect(Object.keys(files(tray)).sort()).toEqual(['canvas.json', 'drafts.jsonl', 'jobs.json']);
      expect(saved(tray).jobs().find((j) => j.id === 'turn-tray-draft')).toMatchObject({ project: tray.id, receipt: 'a1b2c3d4' });
      expect(files(blank)).toEqual({});

      // ── a reading of tray's jobs on its way when the switch comes (its answer held), and blank's board read held, so the switch shows ──
      const jobsOfTray = hold(page, (u, m) => m === 'GET' && u.pathname === '/api/canvas/jobs' && u.searchParams.get('project') === tray.id, { fetchFirst: true });
      await jobsOfTray.install();
      // the page reads its jobs again just after it answers a call: a FAKE lookup (canvas_read, scripted) makes one; the lookup is a
      // job of tray's, in tray's own ledger
      const read = await ask('canvas_read', {});
      expect(read).toMatchObject({ ok: true, changed: false, project: { id: tray.id } });
      await jobsOfTray.until();
      expect(saved(tray).jobs()[0]).toMatchObject({ id: read.jobId, project: tray.id });
      const tray1 = files(tray);
      const blankRead = hold(page, docOf(blank));
      await blankRead.install();

      // ── the Workbench's p: blank ──
      workbench(blank);
      await page.waitForFunction(() => document.body.dataset.board === 'switching', null, { timeout: 15_000 });
      await blankRead.until();
      // switching: the board is not shown, nothing edits, Accept and Discard are off and say why; nothing of tray under blank's name
      const during = await page.evaluate(() => {
        const t = (window as never as Win).timmyCanvas;
        const all = (sel: string) => [...document.querySelectorAll(sel)];
        return {
          state: t.identity.state, switching: t.identity.switching?.name, project: t.identity.project?.name,
          readonly: t.editor.getInstanceState().isReadonly,
          root: getComputedStyle(document.getElementById('root')!).visibility,
          cover: { hidden: document.getElementById('switching')!.hidden, title: document.getElementById('switching-title')!.textContent, words: document.getElementById('switching-words')!.textContent, edge: getComputedStyle(document.getElementById('switching')!).borderLeftColor },
          header: { project: document.getElementById('frame-project')!.textContent, acts: all('#frame-acts li').length },
          panel: { name: document.getElementById('project-name')!.textContent, cards: all('#project-groups li.pcard').length },
          jobs: all('#job-list li').map((li) => li.textContent),
          drafts: { count: document.getElementById('drafts-count')!.textContent, why: document.getElementById('drafts-why')!.textContent, edge: getComputedStyle(document.getElementById('drafts')!).borderTopColor, rows: all('#draft-list li').map((li) => ({ line: li.querySelector('.draft-line')!.textContent, project: (li as HTMLElement).dataset.project, buttons: [...li.querySelectorAll('button')].map((b) => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled, title: b.getAttribute('title') })) })) },
          save: document.getElementById('save-words')!.textContent,
          open: (document.getElementById('board-open') as HTMLButtonElement).disabled,
        };
      });
      const why = "Studio is switching to blank: editing, Accept and Discard wait until blank's board is loaded.";
      const off = (label: string) => ({ text: label, disabled: true, title: why });
      expect(during).toEqual({
        state: 'switching', switching: 'blank', project: 'tray', readonly: true, root: 'hidden',
        // B10: nothing waits on the person while switching, so no amber: the cover's edge and the drafts' frame are structure grey
        cover: { hidden: false, title: 'TIMMY · switching to blank…', words: "Switching to blank… tray's board, drafts and canvas jobs are saved and put away, as they are. Nothing of tray is shown here under blank's name.", edge: 'rgb(68, 68, 68)' },
        header: { project: 'switching to blank…', acts: 0 },
        panel: { name: 'switching to blank…', cards: 0 },
        jobs: ['Switching to blank: its canvas jobs show once its board is loaded.'],
        drafts: { count: "1 of tray's, on hold", why, edge: 'rgb(68, 68, 68)', rows: [{ line: expect.stringMatching(/^tray's draft · DRAFT · proposed by Timmy · 3 shapes · job turn-tray-draft · from revision \d+$/), project: tray.id, buttons: [off('Move it to free space'), off('Show'), off('Accept'), off('Discard')] }] },
        save: why,
        open: true,
      });
      // a person's click on Accept now decides nothing (the button is off)
      await page.locator(`#draft-list li[data-draft="${trayDraft}"] .draft-accept`).click({ force: true, timeout: 2000 }).catch(() => undefined);
      await capture(page, 'h139-02-studio-switching-to-blank-blocked');
      expect(files(tray)).toEqual(tray1);
      expect(files(blank)).toEqual({});

      // ── blank's board arrives: Studio shows blank, all of it blank's own ──
      blankRead.release();
      await shows(page, blank);
      // the reading of tray's jobs, its answer let go now, comes back after the switch: dropped, and said so
      jobsOfTray.release();
      const dropped = 'A reading of tray (its canvas jobs) came back after Studio switched to blank: it was dropped, and nothing of it is shown here.';
      await page.waitForFunction((w) => (window as never as Win).timmyCanvas.identity.kept.some((k) => k.words === w), dropped, { timeout: 10_000 });
      expect(s.console).toContain(`[timmy-studio] ${dropped}`);
      await page.waitForSelector('#kept:not([hidden])');
      expect(await text(page, '#kept-list')).toContain(dropped);
      jobsOfTray.remove();
      blankRead.remove();
      const onBlank = await page.evaluate(() => ({
        readonly: (window as never as Win).timmyCanvas.editor.getInstanceState().isReadonly,
        board: document.body.dataset.board ?? null, cover: document.getElementById('switching')!.hidden,
        drafts: document.getElementById('drafts')!.hidden, jobs: [...document.querySelectorAll('#job-list li')].map((li) => li.textContent),
        guide: document.getElementById('guide-dir')!.textContent, band: document.getElementById('project-said')!.textContent,
      }));
      expect(onBlank).toEqual({
        readonly: false, board: null, cover: true, drafts: true,
        jobs: ["No jobs yet on blank's board. Ask Timmy in the REPL to draw something."],
        guide: shownPath(dirOf(blank)),
        band: "Studio shows blank now: its own board, drafts and canvas jobs. tray's board, drafts and canvas jobs are kept as they were, in tray.",
      });
      expect(await board(page)).toEqual([]);
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Blank build');
      const html = await page.content();
      for (const of of ['Tray build', 'tray one', 'tray draft', 'turn-tray-draft', 'a1b2c3d4', trayDraft]) expect(html).not.toContain(of);
      await capture(page, 'h139-03-studio-on-blank-its-own-board');
      // the switch wrote nothing: tray's files as they were, blank has none yet
      expect(files(tray)).toEqual(tray1);
      expect(files(blank)).toEqual({});

      // blank's own shapes, by hand: blank's file only
      await draw(page, [{ id: 'shape:blank-1', text: 'blank one', x: 400 }, { id: 'shape:blank-2', text: 'blank two', x: 600 }]);
      await savedState(page);
      expect(files(tray)).toEqual(tray1);
      const blank1 = files(blank);
      expect(Object.keys(blank1)).toEqual(['canvas.json']);
      expect(onDisk(blank)).toEqual(['shape:blank-1', 'shape:blank-2']);
      expect(savedText(blank)).not.toContain('tray');

      // ── the REPL's /project: back to tray, with tray's draft, still tray's ──
      await repl(tray);
      await shows(page, tray);
      expect(await board(page)).toEqual(trayBoard);
      expect(await text(page, '#drafts-count')).toBe('1 waiting for you');
      expect(await page.isEnabled(`#draft-list li[data-draft="${trayDraft}"] .draft-accept`)).toBe(true);
      expect(await page.isEnabled(`#draft-list li[data-draft="${trayDraft}"] .draft-discard`)).toBe(true);
      expect((await drafts(page)).map((d) => d.job)).toEqual(['turn-tray-draft']);
      expect(await page.locator('#job-list li[data-job="turn-tray-draft"] a').getAttribute('href')).toBe('/receipts/a1b2c3d4');
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Tray build');
      expect(await readonly(page)).toBe(false);
      expect(await page.content()).not.toContain('blank one');
      await capture(page, 'h139-04-studio-back-on-tray-with-its-draft');
      expect(files(blank)).toEqual(blank1);
      expect(files(tray)).toEqual(tray1);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  }, 180_000);

  it("delayed responses: tray's save answered after the switch lands on tray's board only; a call for tray running across the switch is drawn, saved and recorded for tray only; a call for blank that reaches the page while it still loads blank's board runs nothing; a read of tray's board answered after Studio switched on is dropped", async () => {
    await repl(tray);
    const s = await open();
    const { page } = s;
    try {
      await shows(page, tray);
      // ── a save of tray's whose answer is held: the server writes tray's file at once, the page hears of it after the switch ──
      const late = hold(page, (u, m) => m === 'PUT' && u.pathname === '/api/canvas/document', { fetchFirst: true });
      await late.install();
      const blank0 = files(blank);
      await draw(page, [{ id: 'shape:tray-late', text: 'tray late edit', x: 980 }]);
      await late.until();
      workbench(blank);
      // the switch waits for that save (a few seconds at most), then goes on to blank's board
      await shows(page, blank);
      late.release();
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.kept.some((k) => /^tray's save \(revision \d+\) landed after Studio switched to blank: it is kept on tray's own board, and nothing of it is shown here\.$/.test(k.words)), null, { timeout: 10_000 });
      late.remove();
      expect(onDisk(tray)).toContain('shape:tray-late');
      expect(files(blank)).toEqual(blank0);
      expect((await board(page)).map((x) => x.id)).toEqual(['shape:blank-1', 'shape:blank-2']);
      // the save line is blank's own, at blank's own revision
      await savedState(page);
      expect(await text(page, '#save-words')).toMatch(/^Saved: revision \d+, at \d\d:\d\d:\d\d\.$/);
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.document.revision)).toBe(saved(blank).peek().revision);

      // ── a FAKE call for tray that takes its time (its code waits before it draws), while the Workbench's p switches to blank ──
      await repl(tray);
      await shows(page, tray);
      const tray0 = files(tray);
      const blank1 = files(blank);
      const slow = ask('canvas_exec', { code: threeBoxes('tray slow', { wait: 2500, y: -60 }), jobId: 'turn-tray-slow' });
      await page.waitForTimeout(600);
      workbench(blank);
      await page.waitForFunction(() => document.body.dataset.board === 'switching', null, { timeout: 10_000 });
      const answer = await slow;
      // it ran on tray's board (Studio waited for it before it left), was saved there, and is recorded for tray, said so
      expect(answer).toMatchObject({ ok: true, jobId: 'turn-tray-slow', project: { id: tray.id, name: 'tray' }, draft: { shapes: 3 }, kept: "Kept for tray: the canvas switched to blank while this call ran, so what it did is tray's (its board, its jobs ledger and drafts record), never blank's." });
      await shows(page, blank);
      expect((await board(page)).map((x) => x.id)).toEqual(['shape:blank-1', 'shape:blank-2']);
      expect(onDisk(tray)).toEqual(expect.arrayContaining((answer.result as string[]).slice().sort()));
      expect(onDisk(blank)).toEqual(['shape:blank-1', 'shape:blank-2']);
      expect(saved(tray).peek().revision).toBe(answer.revision);
      expect(saved(tray).jobs().find((j) => j.id === 'turn-tray-slow')).toMatchObject({ ok: true, project: tray.id, revision: answer.revision });
      expect(saved(tray).drafts().filter((r) => r.job === 'turn-tray-slow').map((r) => [r.event, r.project, r.shapes])).toEqual([['proposed', tray.id, 3]]);
      expect(saved(blank).jobs()).toEqual([]);
      expect(files(blank)).toEqual(blank1);
      expect(files(tray)).not.toEqual(tray0);

      // ── blank's board read held while the REPL's /project asks to draw on blank: the call reaches the page while it loads: nothing runs ──
      await repl(tray);
      await shows(page, tray);
      const tray2 = files(tray);
      const blankRead = hold(page, docOf(blank));
      await blankRead.install();
      await repl(blank);
      await page.waitForFunction(() => document.body.dataset.board === 'switching', null, { timeout: 15_000 });
      await blankRead.until();
      const early = await ask('canvas_exec', { code: threeBoxes('blank early'), jobId: 'turn-blank-early' });
      expect(early).toMatchObject({ ok: false, notRun: 'switching', changed: false, project: { id: blank.id, name: 'blank' }, error: 'Not run: this call was made for blank, but Studio is switching to blank now, so nothing ran and nothing was drawn on either board. Ask again once Studio shows blank.' });
      blankRead.release();
      await shows(page, blank);
      blankRead.remove();
      expect(await kept(page)).toContain("A canvas call for blank (job turn-blank-early) reached this page while Studio was still loading blank's board: it did not run, and nothing was drawn on either board. Asked again, it runs on blank's board.");
      expect((await board(page)).map((x) => x.id)).toEqual(['shape:blank-1', 'shape:blank-2']);
      expect(saved(blank).jobs()).toEqual([]);
      expect(files(blank)).toEqual(blank1);
      expect(files(tray)).toEqual(tray2);
      // asked again now, it runs on blank's board, as blank's
      const again = await ask('canvas_exec', { code: threeBoxes('blank draft'), jobId: 'turn-blank-draft' });
      expect(again).toMatchObject({ ok: true, project: { id: blank.id, name: 'blank' }, draft: { shapes: 3 } });
      expect(again.kept).toBeUndefined();
      await page.waitForSelector(`#draft-list li[data-draft="${again.draft!.id}"]`);
      expect(saved(blank).jobs().map((j) => [j.id, j.project])).toEqual([['turn-blank-draft', blank.id]]);
      expect(files(tray)).toEqual(tray2);

      // ── a read of tray's board answered after Studio switched on: the REPL's /project tray, then blank again before tray's board
      // reaches the page (the server read it while tray was named; only its answer comes late) ──
      await savedState(page);
      const onBlank = (await board(page)).map((x) => x.id);
      const blank3 = files(blank);
      const trayRead = hold(page, docOf(tray), { fetchFirst: true });
      await trayRead.install();
      await repl(tray);
      await page.waitForFunction(() => document.body.dataset.board === 'switching', null, { timeout: 15_000 });
      await trayRead.until();
      await repl(blank);
      await shows(page, blank);
      trayRead.release();
      const droppedBoard = 'A reading of tray (its board) came back after Studio switched to blank: it was dropped, and nothing of it is shown here.';
      await page.waitForFunction((w) => (window as never as Win).timmyCanvas.identity.kept.some((k) => k.words === w), droppedBoard, { timeout: 10_000 });
      trayRead.remove();
      expect((await board(page)).map((x) => x.id)).toEqual(onBlank);
      expect((await board(page)).some((x) => /^tray/.test(x.text))).toBe(false);
      expect(await text(page, '#project-name')).toBe('blank');
      expect(await readonly(page)).toBe(false);
      expect(files(blank)).toEqual(blank3);
      expect(files(tray)).toEqual(tray2);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  }, 180_000);

  it("save, then reopen: each project's own board comes back as saved; after a reopen and after an Accept the next draw is not refused; Accept on blank's own draft is blank's (its board and its record); tray's files stay as they were", async () => {
    // tray, reopened (/canvas open)
    await repl(tray);
    const trayBefore = files(tray);
    const blankBefore = files(blank);
    let s = await open();
    try {
      await shows(s.page, tray);
      expect((await board(s.page)).map((x) => x.id)).toEqual(onDisk(tray));
      expect((await board(s.page)).map((x) => x.text)).toEqual(expect.arrayContaining(['tray one', 'tray two', 'tray three', 'tray late edit', 'tray draft a', 'tray slow a']));
      expect((await drafts(s.page)).map((d) => d.job).sort()).toEqual(['turn-tray-draft', 'turn-tray-slow']);
      expect(await text(s.page, '#drafts-count')).toBe('2 waiting for you');
      await capture(s.page, 'h139-05-studio-tray-reopened-its-board-and-drafts');
      expect(files(tray)).toEqual(trayBefore);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
    // blank, reopened
    await repl(blank);
    s = await open();
    const { page } = s;
    try {
      await shows(page, blank);
      expect((await board(page)).map((x) => x.id)).toEqual(onDisk(blank));
      expect((await board(page)).map((x) => x.text)).toEqual(expect.arrayContaining(['blank one', 'blank two', 'blank draft a']));
      expect((await board(page)).some((x) => /^tray/.test(x.text))).toBe(false);
      expect((await drafts(page)).map((d) => d.job)).toEqual(['turn-blank-draft']);
      await capture(page, 'h139-06-studio-blank-reopened-its-board-and-draft');
      expect(files(blank)).toEqual(blankBefore);
      expect(files(tray)).toEqual(trayBefore);

      // R6 item b, after a reopen: a person's edit moved the board on since the REPL last drew on it; the REPL's next draft is made
      // from the board's revision now, so it is not refused
      await draw(page, [{ id: 'shape:blank-3', text: 'blank three', x: 800 }]);
      await savedState(page);
      const handRevision = saved(blank).peek().revision;
      const two = await ask('canvas_exec', { code: threeBoxes('blank second', { y: -60 }), jobId: 'turn-blank-two' });
      expect(two).toMatchObject({ ok: true, project: { id: blank.id }, draft: { shapes: 3, from: handRevision } });
      expect(two.error).toBeUndefined();

      // Accept, a person's click, on blank's first draft: blank's board and blank's record; tray's files as they were
      const first = (await drafts(page)).find((d) => d.job === 'turn-blank-draft')!;
      await page.click(`#draft-list li[data-draft="${first.id}"] .draft-accept`);
      await page.waitForFunction(() => /^Accepted Timmy's draft \(3 shapes, job turn-blank-draft\): kept on the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      const records = saved(blank).drafts().filter((r) => r.draft === first.id);
      expect(records.map((r) => [r.event, r.project])).toEqual([['proposed', blank.id], ['accepted', blank.id]]);
      expect(saved(tray).drafts().some((r) => r.draft === first.id)).toBe(false);
      expect(files(tray)).toEqual(trayBefore);
      // R6 item b, after an Accept: the REPL's next draft is made from the revision the Accept's save left, so it is not refused
      const after = await ask('canvas_exec', { code: threeBoxes('blank after accept', { y: -280 }), jobId: 'turn-blank-after' });
      expect(after).toMatchObject({ ok: true, project: { id: blank.id }, draft: { shapes: 3, from: records[1].revision } });
      expect(after.error).toBeUndefined();
      expect(saved(blank).jobs().map((j) => j.id).sort()).toEqual(['turn-blank-after', 'turn-blank-draft', 'turn-blank-two']);
      expect(files(tray)).toEqual(trayBefore);
      expect(s.errors).toEqual([]);
    } finally {
      await s.context.close();
    }
  }, 180_000);

  it('a tab that loads no canvas takes a /canvas open link pasted into it: only its fragment changes, and it loads the canvas with it', async () => {
    await repl(tray);
    const c = await context({ width: 1280, height: 800 });
    try {
      const page = await c.newPage();
      const s = { errors: [] as string[], refused: [] as string[], console: [] as string[] };
      watch(page, s);
      await page.goto(`${base}/`);
      await page.waitForSelector('#refused:not([hidden])');
      // the person pastes the new link from /canvas open into this tab's address: only its fragment changes
      const loaded = page.waitForEvent('load');
      await page.evaluate((code) => { location.hash = `#code=${code}`; }, await grant(port, server.projectToken));
      await loaded;
      await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
      await shows(page, tray);
      expect(await page.isHidden('#refused')).toBe(true);
      // the grant is taken out of the address once read
      expect(page.url()).toBe(`${base}/`);
      expect(s.errors).toEqual([]);
    } finally {
      await c.close();
    }
  }, 120_000);
});
