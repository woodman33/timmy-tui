/**
 * R7 (H151; H147's R6 finding 9, REMAINING-DEFECTS row 18: "For about 2 s after Enter, Studio still shows the old project and
 * accepts edits for it"): the moment the server says a switch is pending (the active-project record names another project, not
 * named to the canvas yet: src/studio/active-follow.ts FollowDeps.pending, H149's, pushed to the page by src/studio/bridge.ts
 * announcePending, the shape agreed in the R7 handoff), the page takes no edit, says why, and loads the new project's board once
 * the canvas names it; a switch given up gives the board before back. Neither project's board file takes an edit meanwhile.
 * In a real headless Chromium against the real canvas server and the real bundle (built here).
 *
 * The first two tests say the pending switch through the server's own call (StudioServer.switchPending, what its follower calls);
 * the third switches the record itself, and runs where the follower says a switch pending (H149's ActiveFollower.pending: on
 * r7/review-build once both branches are in), else it is skipped, saying so. The projects are FAKE (empty folders made here).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectId } from '../src/project/index.js';
import { ActiveFollower, activeProjectFile } from '../src/studio/active-follow.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-switch-pending-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');
/** H149's follower says a switch pending (its getter): in this tree only once r7/h149-repl-follows is merged with this branch. */
const followsPending = Object.getOwnPropertyDescriptor(ActiveFollower.prototype, 'pending') !== undefined;
if (!followsPending) console.warn('studio-switch-pending-browser: this tree\'s ActiveFollower says no switch pending yet (H149\'s 5a18cdb is not in it), so the record-switching test is skipped here');

type Win = { timmyCanvas: { editor: { createShape: (s: unknown) => void; getCurrentPageShapes: () => Array<{ id: string; type: string }>; getInstanceState: () => { isReadonly: boolean } }; project: { id: string; name: string } | null; identity: { state: string; project: { name: string } | null; switching: { name: string } | null } } };

/** A screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind otherwise); it says on
 *  itself that what it shows is FAKE test data. */
async function shoot(page: Page, name: string): Promise<void> {
  const shots = process.env.TIMMY_CANVAS_SHOTS;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.id = 'fake-shot-label';
    label.textContent = 'FAKE test data (a scripted switch between FAKE projects written by the test), not a real project';
    label.setAttribute('style', 'position:fixed;right:8px;bottom:100px;z-index:2147483647;pointer-events:none;max-width:calc(100vw - 16px);box-sizing:border-box;'
      + 'padding:2px 6px;font:12px/16px ui-monospace,monospace;color:#F2EFE9;background:#070707;border:1px solid #444444;border-radius:4px');
    document.body.append(label);
  });
  try {
    await page.screenshot({ path: join(shots, name) });
  } finally {
    await page.evaluate(() => document.getElementById('fake-shot-label')?.remove());
  }
}

describe.skipIf(!browserPath)('Studio takes no edit from the moment a switch is pending (R7 H151)', () => {
  let pageRoot = '';
  let home = '';
  let tray = '';
  let blank = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;
  const board = (root: string): string => join(boardDir(join(home, 'canvas'), projectId(root)), 'canvas.json');
  const hashOf = (file: string): string => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent');

  beforeAll(async () => {
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-pending-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-pending-home-'));
    tray = join(home, 'tray');
    blank = join(home, 'blank');
    mkdirSync(tray);
    mkdirSync(blank);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // the server follows this Timmy home's active-project record (as the REPL's own Studio does), with a short poll
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot, followActive: true, followEveryMs: 200 });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** tray named to the canvas, its page open with one shape of the person's on its board, saved. */
  async function trayPage(): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    await nameProject(port, server.projectToken, { root: tray, name: 'tray' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => (window as never as Win).timmyCanvas?.identity?.state === 'shown' && (window as never as Win).timmyCanvas.identity.project?.name === 'tray', null, { timeout: 15_000 });
    // (R11 round 7, H176: the call returns nothing to the test — tldraw's createShape returns the Editor itself, and Playwright would
    // then serialize the whole editor with its reactive graph (≈ 500 KB, nested as deep as the graph's dependency chains run):
    // past Chromium's JSON depth limit that read "Execution context was destroyed" though nothing navigated)
    await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.createShape({ type: 'geo', x: 900, y: 400, props: { w: 120, h: 80 } }); });
    await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
    await page.waitForTimeout(300);
    return { page, context, errors };
  }
  /** One edit tried now, as a hand on the canvas makes it: whether the board took it (its shapes before and after). */
  const tryEdit = (page: Page) => page.evaluate(() => {
    const e = (window as never as Win).timmyCanvas.editor;
    const before = e.getCurrentPageShapes().length;
    try { e.createShape({ type: 'geo', x: 1200, y: 600, props: { w: 40, h: 40 } }); } catch { /* refused */ }
    return { took: e.getCurrentPageShapes().length > before, readonly: e.getInstanceState().isReadonly, state: (window as never as Win).timmyCanvas.identity.state };
  });

  it('a switch said pending: from that moment the page takes no edit and says why; once the canvas names the new project, its own board is shown; neither board file took an edit', async () => {
    const { page, context, errors } = await trayPage();
    try {
      const trayBefore = hashOf(board(tray));
      const blankBefore = hashOf(board(blank));
      expect(trayBefore).not.toBe('absent');
      const since = new Date().toISOString();
      const t0 = Date.now();
      expect(server.switchPending({ id: projectId(blank), name: 'blank', since })).toBe(1);
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'switching', null, { timeout: 2_000 });
      const blockedIn = Date.now() - t0;
      expect(blockedIn, `blocked ${blockedIn} ms after the server said pending`).toBeLessThanOrEqual(500);
      // an edit tried now is refused: the board is read only and covered, and the page says why
      expect(await tryEdit(page)).toEqual({ took: false, readonly: true, state: 'switching' });
      const why = await page.evaluate(() => ({ cover: (document.getElementById('switching-title')?.textContent ?? '').trim(), save: (document.getElementById('save-words')?.textContent ?? '').trim(), header: (document.getElementById('frame-project')?.textContent ?? '').trim() }));
      expect(why).toEqual({ cover: 'TIMMY · switching to blank…', save: 'Studio is switching to blank: editing, Accept and Discard wait until blank\'s board is loaded.', header: 'switching to blank…' });
      await shoot(page, 'switch-pending-blocked-1440x900.png');
      // the canvas names blank a moment later: the server's own follow of the active-project record, after its grace (the record
      // is written here, as the Workbench's picker writes it); blank's own board is then shown, empty
      await page.waitForTimeout(600);
      expect((await tryEdit(page)).took).toBe(false);
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(activeProjectFile({ TIMMY_HOME: home, HOME: home }), `${JSON.stringify({ name: 'blank', root: blank, at: new Date().toISOString() })}\n`);
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'shown' && (window as never as Win).timmyCanvas.identity.project?.name === 'blank', null, { timeout: 15_000 });
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().length)).toBe(0);
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getInstanceState().isReadonly)).toBe(false);
      // neither board file took an edit while the switch was pending
      expect(hashOf(board(tray))).toBe(trayBefore);
      expect(hashOf(board(blank))).toBe(blankBefore);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a switch said pending and then given up (the record back on the project shown): the board before comes back, editable, as it was', async () => {
    const { page, context, errors } = await trayPage();
    try {
      const trayBefore = hashOf(board(tray));
      const shapes = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().length);
      server.switchPending({ id: projectId(blank), name: 'blank', since: new Date().toISOString() });
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'switching', null, { timeout: 2_000 });
      expect((await tryEdit(page)).took).toBe(false);
      server.switchPending(null);
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'shown' && (window as never as Win).timmyCanvas.identity.project?.name === 'tray', null, { timeout: 15_000 });
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes().length)).toBe(shapes);
      expect(hashOf(board(tray))).toBe(trayBefore);
      // editable again
      expect((await tryEdit(page)).took).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it.skipIf(!followsPending)('the record itself switched (the active project of this Timmy home): the page is blocked within 500 ms, an edit tried at once is refused, blank\'s board comes; neither board file took the edit', async () => {
    const { page, context, errors } = await trayPage();
    try {
      const trayBefore = hashOf(board(tray));
      const blankBefore = hashOf(board(blank));
      const t0 = Date.now();
      const file = activeProjectFile({ TIMMY_HOME: home, HOME: home });
      mkdirSync(join(home, 'state'), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ name: 'blank', root: blank, at: new Date().toISOString() })}\n`);
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'switching', null, { timeout: 3_000 });
      const blockedIn = Date.now() - t0;
      expect(blockedIn, `blocked ${blockedIn} ms after the record changed`).toBeLessThanOrEqual(500);
      expect(await tryEdit(page)).toEqual({ took: false, readonly: true, state: 'switching' });
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'shown' && (window as never as Win).timmyCanvas.identity.project?.name === 'blank', null, { timeout: 15_000 });
      expect(hashOf(board(tray))).toBe(trayBefore);
      expect(hashOf(board(blank))).toBe(blankBefore);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
