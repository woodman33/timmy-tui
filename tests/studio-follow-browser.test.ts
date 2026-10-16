/**
 * R4 (H109), R6 (H139): Timmy Canvas follows the active project, in a real headless Chromium against the real canvas server and the
 * real bundle (built here into a temporary folder), with a real temporary Timmy home. R6: each project has its own board
 * (src/studio/boards.ts), so following the active project changes the whole board, its drafts, jobs and cards with it; a board kept
 * from the canvas a Timmy home had before (one canvas for every project) can still be pinned to a project, visibly, and let go.
 *
 * FAKE, said where used: the projects alpha and beta are folders made here, named to the canvas as a REPL names them (POST
 * /api/project/active with the server's token and a holder id; no REPL takes card actions, so the cards are diagrams), and the
 * active project changes through <TIMMY_HOME>/state/active-project.json, written as src/project/index.ts saveActiveProject writes
 * it. The old canvas of the second test is written here in the old layout (<TIMMY_HOME>/canvas/canvas.json), from a document this
 * page made, with one board page pinned to alpha as R4's Pin kept it. A person's presses are Chromium's own clicks; switching board
 * pages is the editor's own call, as tldraw's page menu makes it. Every request the page makes goes to 127.0.0.1 (anything else is
 * aborted). Skipped, saying so, where no Chromium or Chrome is found.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeProjectFile } from '../src/studio/active-follow.js';
import { ADOPTION_RECORD, boardDir, oldLayoutWords } from '../src/studio/boards.js';
import { CanvasDocuments } from '../src/studio/document.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { projectId } from '../src/project/index.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-follow-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Editor = {
  getCurrentPage: () => { id: string; meta: Record<string, unknown> };
  setCurrentPage: (id: string) => void;
  getShape: (id: string) => { props: Record<string, unknown> } | undefined;
  getCurrentPageShapes: () => Array<{ id: string }>;
  store: { getStoreSnapshot: (scope: string) => { store: Record<string, Record<string, unknown>>; schema: unknown } };
};
type Win = { timmyCanvas: { editor: Editor; placeDrawnCard: (id: string) => Promise<{ shape: string }>; identity: { state: string; project: { id: string } | null } } };
type Project = { name: string; root: string; id: string };
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(!browserPath)('Timmy Canvas follows the active project: each project its own board, in a real browser', () => {
  let pageRoot = '';
  let browser: Browser;
  const made: string[] = [];
  const servers: StudioServer[] = [];
  const project = (name: string, title: string): Project => {
    const root = join(mkdtempSync(join(tmpdir(), `timmy-follow-${name}-`)), name);
    made.push(join(root, '..'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'BUILD.md'), `# ${title}\n\n\`\`\`bash [name:build]\necho build\n\`\`\`\n`);
    return { name, root, id: projectId(root) };
  };
  let alpha: Project;
  let beta: Project;
  /** A document this page made (alpha's board, with alpha's card on it), as the page saves it: the second test's old canvas. */
  let madeHere: { store: Record<string, Record<string, unknown>>; schema: unknown } | null = null;

  beforeAll(async () => {
    alpha = project('alpha', 'Alpha build');
    beta = project('beta', 'Beta build');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-follow-root-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await new Promise<void>((done) => s.close(() => done()));
    for (const d of [...made, pageRoot]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** A server that serves Timmy home `home` for its REPLs (as the REPL's own and `timmy studio` do): it follows the active project. */
  async function serve(home: string): Promise<{ server: StudioServer; base: string; port: number }> {
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    const server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, projectTokenFile: true, followEveryMs: 100, followGraceMs: 200 });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { server, base: `http://127.0.0.1:${port}`, port };
  }
  /** The active project of Timmy home `home`, as the Workbench's p (and /project) write it. */
  function setActive(home: string, p: Project): void {
    const file = activeProjectFile({ TIMMY_HOME: home });
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ name: p.name, root: p.root, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  async function open(at: { server: StudioServer; base: string; port: number }): Promise<{ page: Page; context: BrowserContext; errors: string[]; origins: Set<string> }> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.origin === at.base ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // a reading the server refused as another project's (asked just before a switch, answered after it) is dropped by the page
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 409 \(Conflict\)$/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${at.base}/#code=${await grant(at.port, at.server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors, origins };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** Studio shows `p`'s board, under `p`'s name (its Project panel read for it). */
  const shows = async (page: Page, p: Project) => {
    await page.waitForFunction((id) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.id === id; }, p.id, { timeout: 20_000 });
    await page.waitForFunction((n) => document.getElementById('project-name')?.textContent === n, p.name, { timeout: 20_000 });
  };
  const ownWords = (p: Project) => `This is ${p.name}'s own board: Studio shows the board of the project the canvas shows, and switches to another project's own board when the active project changes.`;

  it("following the active project changes the whole board: alpha's board with alpha's card, then beta's own board, then alpha's again; nothing to pin a project's own board to", async () => {
    const home = mkdtempSync(join(tmpdir(), 'timmy-canvas-follow-home-'));
    made.push(home);
    const at = await serve(home);
    await nameProject(at.port, at.server.projectToken, { root: alpha.root, name: 'alpha', holder: 'a'.repeat(32) });
    const { page, context, errors, origins } = await open(at);
    try {
      await shows(page, alpha);
      // alpha's own board: it says so; there is nothing to pin it to (it is alpha's), so no pin and no Pin button
      expect(await text(page, '#project-follow')).toBe(ownWords(alpha));
      expect(await page.isHidden('#project-pinned')).toBe(true);
      expect(await page.isHidden('#project-pin')).toBe(true);
      const a1 = (await page.evaluate(() => (window as never as Win).timmyCanvas.placeDrawnCard('workflow:BUILD.md'))).shape;
      await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
      madeHere = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.getStoreSnapshot('document'));

      // the active project changes to beta (the file, as the Workbench's p writes it): Studio shows beta's own board
      setActive(home, beta);
      await shows(page, beta);
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Beta build');
      expect(await text(page, '#project-said')).toBe("Studio shows beta now: its own board, drafts and canvas jobs. alpha's board, drafts and canvas jobs are kept as they were, in alpha.");
      expect(await text(page, '#project-follow')).toBe(ownWords(beta));
      expect(await page.isHidden('#project-pin')).toBe(true);
      // alpha's card is not on beta's board: it stays on alpha's, saved there with alpha's id
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().length)).toBe(0);
      expect(await page.locator(`[data-timmy-card="${a1}"]`).count()).toBe(0);
      const alphaDoc = new CanvasDocuments(boardDir(join(home, 'canvas'), alpha.id)).load().snapshot as { store: Record<string, { props?: Record<string, unknown> }> };
      expect(alphaDoc.store[a1].props).toMatchObject({ projectId: alpha.id, card: 'workflow:BUILD.md' });
      expect(new CanvasDocuments(boardDir(join(home, 'canvas'), beta.id)).peek().revision).toBe(0);

      // and back to alpha: alpha's own board again, its card on it, read from alpha
      setActive(home, alpha);
      await shows(page, alpha);
      await page.waitForSelector(`[data-timmy-card="${a1}"] .tc-title`);
      expect(await text(page, `[data-timmy-card="${a1}"] .tc-title`)).toBe('Alpha build');
      expect(await text(page, '#project-follow')).toBe(ownWords(alpha));
      expect([...origins].every((x) => x === at.base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it("a Timmy home in the old layout: its canvas becomes the board of the project it last showed, and says so; a board page in it pinned to alpha reads alpha's cards, visibly, until a person lets it go; the old file stays as it was", async () => {
    expect(madeHere).not.toBeNull();
    const home = mkdtempSync(join(tmpdir(), 'timmy-canvas-follow-old-'));
    made.push(home);
    // the old layout: one canvas for every project, in <TIMMY_HOME>/canvas/canvas.json (FAKE: written here from the document this
    // page made in the first test, with a second board page pinned to alpha as R4's Pin kept it); beta was the active project
    const doc = structuredClone(madeHere!);
    const pages = Object.values(doc.store).filter((r) => r.typeName === 'page');
    doc.store['page:pinned'] = { ...pages[0], id: 'page:pinned', name: 'Alpha, pinned', index: 'a9', meta: { timmyPin: { projectId: alpha.id, project: 'alpha', at: '2026-10-11T12:00:00.000Z' } } };
    const old = join(home, 'canvas', 'canvas.json');
    mkdirSync(join(home, 'canvas'), { recursive: true });
    writeFileSync(old, `${JSON.stringify({ format: 'timmy-canvas', version: 1, revision: 7, savedAt: '2026-10-11T12:00:00.000Z', sourceRevision: sha(JSON.stringify(doc)), snapshot: doc })}\n`);
    const oldBytes = sha(readFileSync(old));
    setActive(home, beta);
    const at = await serve(home);
    // the old canvas is beta's board now (the project it last showed), copied byte for byte; the old file is where it was
    expect(sha(readFileSync(join(boardDir(join(home, 'canvas'), beta.id), 'canvas.json')))).toBe(oldBytes);
    expect(JSON.parse(readFileSync(join(home, 'canvas', ADOPTION_RECORD), 'utf8'))).toMatchObject({ project: { id: beta.id, name: 'beta' } });
    // the page opens for alpha (its own, blank board), and the REPL's /project names beta: its session reaches both
    const holder = 'b'.repeat(32);
    await nameProject(at.port, at.server.projectToken, { root: alpha.root, name: 'alpha', holder });
    const { page, context, errors, origins } = await open(at);
    try {
      await shows(page, alpha);
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().length)).toBe(0);
      await nameProject(at.port, at.server.projectToken, { root: beta.root, name: 'beta', holder });
      await shows(page, beta);
      // beta's board is the old canvas: the band says so, and where the old file is kept
      const words = oldLayoutWords(join(home, 'canvas'), beta.id);
      expect(words).toMatch(/^This board is the canvas this Timmy home had before each project had its own \(canvas\.json, copied \d{4}-\d\d-\d\d\): it was /);
      expect(await text(page, '#project-said')).toBe(`Studio shows beta now: its own board, drafts and canvas jobs. alpha's board, drafts and canvas jobs are kept as they were, in alpha. ${words}`);
      expect(await text(page, '#project-follow')).toBe(ownWords(beta));

      // its board page pinned to alpha: the panel reads alpha's cards for it, and says so
      await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.setCurrentPage('page:pinned'); });
      await page.waitForFunction(() => document.getElementById('project-pinned')?.hidden === false, null, { timeout: 15_000 });
      await page.waitForFunction(() => document.getElementById('project-name')?.textContent === 'alpha', null, { timeout: 15_000 });
      // Studio still shows beta's board (the pin names whose cards this board page reads, not whose board it is)
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.identity.project?.id)).toBe(beta.id);
      expect(await text(page, '#project-pinned')).toBe('pinned');
      expect(await text(page, '#project-follow')).toBe("Pinned to alpha: this board reads alpha's cards, whichever project's board holds it. The canvas shows beta now.");
      expect(await text(page, '#project-pin')).toBe('Follow the active project');
      await page.waitForSelector('#project-groups li.pcard[data-card="workflow:BUILD.md"]');
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')).toBe('Alpha build');

      // let go (a person's click): it is beta's board's page again, read as beta's
      await page.click('#project-pin');
      await page.waitForFunction(() => document.getElementById('project-name')?.textContent === 'beta', null, { timeout: 15_000 });
      expect(await text(page, '#project-said')).toBe('This board follows the project the canvas shows again (it was pinned to alpha).');
      expect(await page.isHidden('#project-pinned')).toBe(true);
      expect(await page.isHidden('#project-pin')).toBe(true);
      expect(await text(page, '#project-follow')).toBe(ownWords(beta));
      await page.waitForFunction(() => document.querySelector('#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-title')?.textContent === 'Beta build', null, { timeout: 15_000 });
      // the let-go is saved on beta's board; the old file is as it was, byte for byte
      await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
      const betaDoc = new CanvasDocuments(boardDir(join(home, 'canvas'), beta.id)).load().snapshot as { store: Record<string, { meta?: Record<string, unknown> }> };
      expect(betaDoc.store['page:pinned'].meta?.timmyPin).toBeUndefined();
      expect(sha(readFileSync(old))).toBe(oldBytes);
      expect(existsSync(join(boardDir(join(home, 'canvas'), alpha.id), 'canvas.json'))).toBe(false);
      expect([...origins].every((x) => x === at.base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
