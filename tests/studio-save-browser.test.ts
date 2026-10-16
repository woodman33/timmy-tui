/**
 * R5 (H133): Timmy Canvas says how its save is going, in words and a glyph, and never saves over a newer canvas (the operator's
 * order of 2026-10-15: "Show saving, saved and failed-to-save states honestly"; "use revision checks and an explicit
 * conflict/recovery path for stale clients and concurrent edits; do not silently overwrite newer project or board state").
 * And a canvas reopened in a new page is the same document that was saved.
 *
 * A real browser, the real server and the real bundle. "Another window" is the REPL's token saving through the same route a page
 * saves through (standing in for a second page). A failed save is made by the browser's own request routing (the request is cut
 * or answered 413 here, labelled so); the person's edits are made through the page's editor. Skipped where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANVAS_EXAMPLE } from '../src/agent/canvas-tools.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { projectId } from '../src/project/index.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-save-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Rec = { id: string; typeName: string; x?: number; props?: Record<string, unknown> };
type Ed = { getCurrentPageId: () => string; createShape: (s: unknown) => void; updateShape: (s: unknown) => void; getShape: (id: string) => Rec | undefined; renamePage: (id: string, n: string) => void; createPage: (p: unknown) => unknown; store: { serialize: (scope: string) => Record<string, Rec> } };
type Win = { timmyCanvas: { editor: Ed; document: { revision: number; savedRevision: number } } };
type Doc = { revision: number; sourceRevision: string; snapshot: { store: Record<string, Rec>; schema: unknown } };
const AMBER = 'rgb(255, 176, 0)';
const GREENS = ['rgb(40, 254, 20)', 'rgb(0, 215, 0)'];

describe.skipIf(!browserPath)('the save, in a real browser', () => {
  let root = '';
  let home = '';
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  const port = (): number => (server!.address() as AddressInfo).port;
  const auth = (): Record<string, string> => bearer(server!.projectToken);
  const doc = async (): Promise<Doc> => (await fetch(`${base}/api/canvas/document`, { headers: auth() })).json() as Promise<Doc>;
  /** Another window saving: the REPL's token, through the route a page saves through. */
  const otherWindowSaves = async (change: (d: Doc) => void): Promise<Doc> => {
    const d = await doc();
    change(d);
    const r = await fetch(`${base}/api/canvas/document`, { method: 'PUT', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: d.snapshot, revision: d.revision + 5, baseRevision: d.revision }) });
    expect(r.status).toBe(200);
    return doc();
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-save-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-save-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root });
    base = `http://127.0.0.1:${port()}`;
    mkdirSync(join(home, 'project'));
    await nameProject(port(), server.projectToken, { root: join(home, 'project'), name: 'save-browser' });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function open(o: { size?: { width: number; height: number }; blockHealth?: boolean } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser!.newContext({ viewport: o.size ?? { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // a page that must not notice another window's save before it saves itself is kept from Timmy's health (no content)
    // R6 (H139): the page names its board's project (/api/canvas/health?project=<id>), so the path is matched, not the address
    if (o.blockHealth) await page.route((url) => url.pathname === '/api/canvas/health', (r) => r.abort());
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const line = (page: Page) => page.evaluate(() => {
    const el = document.getElementById('save')!;
    return { state: el.dataset.state, glyph: document.getElementById('save-glyph')!.textContent, words: document.getElementById('save-words')!.textContent ?? '', color: getComputedStyle(document.getElementById('save-words')!).color, retry: !document.getElementById('save-retry')!.hidden, box: !document.getElementById('conflict')!.hidden };
  });
  const stateIs = (page: Page, state: string, timeout = 15_000) => page.waitForFunction((s) => document.getElementById('save')?.dataset.state === s, state, { timeout });
  const draw = (page: Page, x: number) => page.evaluate((at) => { const id = `shape:hand-${at}-${Date.now()}`; (window as never as Win).timmyCanvas.editor.createShape({ id, type: 'geo', x: at, y: 300, props: { w: 60, h: 40 } }); return id; }, x);

  it('says saving while a save is on its way and saved when it landed, in words and a glyph, in the text colors, never green', async () => {
    const { page, context, errors } = await open();
    try {
      expect(await line(page)).toMatchObject({ state: 'saved', glyph: '■', words: expect.stringMatching(/^Saved: /) });
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/canvas/document', async (route) => { if (route.request().method() === 'PUT') await held; await route.continue(); });
      await draw(page, 400);
      await stateIs(page, 'saving');
      const saving = await line(page);
      expect(saving).toMatchObject({ glyph: '◔', words: expect.stringMatching(/^Saving revision \d+…$/), retry: false, box: false });
      expect(saving.color).toBe('rgb(142, 142, 147)');
      expect(await page.textContent('#status')).toMatch(/revision \d+, saving$/);
      release();
      await stateIs(page, 'saved');
      const saved = await line(page);
      expect(saved).toMatchObject({ glyph: '■', words: expect.stringMatching(/^Saved: revision \d+, at .+\.$/), retry: false });
      expect(saved.color).toBe('rgb(242, 239, 233)');
      expect(GREENS).not.toContain(saved.color);
      expect(await page.textContent('#status')).toMatch(/revision \d+, saved$/);
      await page.unroute('**/api/canvas/document');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('says failed to save, why, in amber with Retry, when Timmy cannot be reached or refuses the size (both made here by the browser\'s routing); Retry saves', async () => {
    const { page, context } = await open();
    try {
      await page.route('**/api/canvas/document', (route) => (route.request().method() === 'PUT' ? route.abort('failed') : route.continue()));
      await draw(page, 500);
      await stateIs(page, 'failed');
      const failed = await line(page);
      expect(failed).toMatchObject({ glyph: '✕', retry: true, words: expect.stringMatching(/^Failed to save revision \d+: Timmy could not be reached to save the canvas \(.+\)\. The next change tries again; Retry tries now\.$/) });
      expect(failed.color).toBe(AMBER);
      expect(await page.textContent('#status')).toMatch(/revision \d+, not saved$/);
      await page.unroute('**/api/canvas/document');
      await page.route('**/api/canvas/document', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 413, json: { ok: false, error: 'This canvas is too large to save (over 1 bytes).', tooLarge: true } }) : route.continue()));
      await page.click('#save-retry');
      await page.waitForFunction(() => /This canvas is too large to save/.test(document.getElementById('save-words')?.textContent ?? ''));
      expect(await line(page)).toMatchObject({ state: 'failed', retry: true });
      await page.unroute('**/api/canvas/document');
      await page.click('#save-retry');
      await stateIs(page, 'saved');
      const disk = await doc();
      expect(disk.revision).toBe(await page.evaluate(() => (window as never as Win).timmyCanvas.document.revision));
    } finally {
      await context.close();
    }
  }, 90_000);

  it('a newer canvas on disk refuses this page\'s save (nothing overwritten) and says so in amber; Keep a copy keeps this page\'s version; Reload takes the newer one, and saving goes on from it', async () => {
    const { page, context } = await open({ blockHealth: true });
    try {
      const mine = await draw(page, 600);
      await stateIs(page, 'saved');
      // another window moves the shape and saves first
      const theirs = await otherWindowSaves((d) => { d.snapshot.store[mine].x = 999; });
      // this page changes something else: its save is refused (409), and it says so
      const late = await draw(page, 700);
      await stateIs(page, 'conflict');
      const conflict = await line(page);
      expect(conflict).toMatchObject({ glyph: '⇄', box: true, words: expect.stringMatching(new RegExp(`^Not saved: a newer version of this canvas is on disk \\(revision ${theirs.revision}\\), saved after this page opened it\\. This page's (change|\\d+ changes) since revision \\d+ (is|are) not saved\\. Nothing was overwritten\\.$`)) });
      expect(conflict.color).toBe(AMBER);
      expect(await page.textContent('#status')).toMatch(/· revision \d+, not saved$/);
      expect(await page.getAttribute('#status', 'data-kind')).toBe('error');
      expect(await page.locator('#conflict button').allTextContents()).toEqual(['Reload the newer version', 'Keep a copy']);
      // nothing overwritten: the disk holds the other window's canvas, without this page's late shape
      const disk = await doc();
      expect(disk.revision).toBe(theirs.revision);
      expect(disk.snapshot.store[late]).toBeUndefined();
      expect(disk.snapshot.store[mine].x).toBe(999);
      // Keep a copy: this page's version, beside the canvas file
      await page.click('#conflict-keep');
      // R6 (H139): beside the project's own board (its folder in Timmy's canvas folder)
      await page.waitForFunction(() => /^Kept this page's version \(revision \d+\) as copies\/canvas-r\d+-.+\.json, beside save-browser's board in Timmy's canvas folder\. The board on disk is unchanged\.$/.test(document.getElementById('project-said')?.textContent ?? ''));
      const boardCopies = join(home, 'canvas', 'projects', projectId(join(home, 'project')), 'copies');
      const copies = readdirSync(boardCopies);
      const kept = JSON.parse(readFileSync(join(boardCopies, copies.at(-1)!), 'utf8')) as { format: string; snapshot: { store: Record<string, Rec> } };
      expect(kept.format).toBe('timmy-canvas-copy');
      expect(kept.snapshot.store[late]).toBeDefined();
      expect((await doc()).revision).toBe(theirs.revision);
      expect(await page.isDisabled('#conflict-keep')).toBe(true);
      // Reload: the newer canvas, in a fresh editor; this page's version stays kept
      await page.click('#conflict-reload');
      await page.waitForFunction((r) => new RegExp(`^Reloaded revision ${r} of save-browser's board from disk\\. This page's version is kept as copies/`).test(document.getElementById('project-said')?.textContent ?? ''), theirs.revision);
      await stateIs(page, 'saved');
      expect(await line(page)).toMatchObject({ box: false });
      const now = await page.evaluate(([a, b]) => { const e = (window as never as Win).timmyCanvas.editor; return { mine: e.getShape(a)?.x, late: e.getShape(b) ?? null }; }, [mine, late]);
      expect(now).toEqual({ mine: 999, late: null });
      // and saving goes on from the revision on disk
      await draw(page, 800);
      await stateIs(page, 'saved');
      expect((await doc()).revision).toBeGreaterThan(theirs.revision);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a newer canvas seen on disk before this page saves: it says so, sends no save over it, and Reload takes it', async () => {
    const { page, context } = await open();
    try {
      await draw(page, 300);
      await stateIs(page, 'saved');
      const theirs = await otherWindowSaves(() => undefined);
      await stateIs(page, 'stale', 12_000);
      expect(await line(page)).toMatchObject({ glyph: '⇄', box: true, words: expect.stringMatching(new RegExp(`^A newer version of this canvas is on disk \\(revision ${theirs.revision}\\), saved after this page's last save \\(revision \\d+\\)\\. This page has no unsaved changes\\. This page will not save over it\\.$`)) });
      const puts: string[] = [];
      page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/api/canvas/document')) puts.push(r.url()); });
      await draw(page, 350);
      await page.waitForTimeout(1200);
      expect(puts).toEqual([]);
      expect((await doc()).revision).toBe(theirs.revision);
      await page.click('#conflict-reload');
      await stateIs(page, 'saved');
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.document.savedRevision)).toBe(theirs.revision);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('reopens the same document: a new page shows exactly the records that were saved (shapes, text, an arrow bound to its boxes, pages)', async () => {
    const first = await open();
    let before: Record<string, Rec> = {};
    try {
      // what the agent draws (a direct call: CANVAS_EXAMPLE, boxes, text and a bound arrow) and what a hand does
      const drawn = await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CANVAS_EXAMPLE, jobId: 'reopen' }) }).then((r) => r.json()) as { ok: boolean };
      expect(drawn.ok).toBe(true);
      await first.page.evaluate(() => {
        const e = (window as never as Win).timmyCanvas.editor;
        e.renamePage(e.getCurrentPageId(), 'Reopened board');
        e.createShape({ id: 'shape:reopen-note', type: 'note', x: 40, y: 400, props: {} });
        e.createPage({ name: 'Second page' });
      });
      await stateIs(first.page, 'saved');
      before = await first.page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.serialize('document'));
    } finally {
      await first.context.close();
    }
    const again = await open({ size: { width: 390, height: 844 } });
    try {
      const after = await again.page.evaluate(() => (window as never as Win).timmyCanvas.editor.store.serialize('document'));
      // tldraw 5.5.2 keeps each editor's user (who made what: its attribution) in the document, so the reopened page adds its
      // own user record; every record that was saved, the earlier users included, is there exactly as it was
      const drawing = (m: Record<string, Rec>) => Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user'));
      expect(Object.keys(drawing(after)).sort()).toEqual(Object.keys(drawing(before)).sort());
      expect(drawing(after)).toEqual(drawing(before));
      for (const [id, r] of Object.entries(before)) expect(after[id], id).toEqual(r);
      expect(Object.values(after).filter((r) => r.typeName === 'user').length - Object.values(before).filter((r) => r.typeName === 'user').length).toBeLessThanOrEqual(1);
      const kinds = Object.values(after).map((r) => r.typeName);
      for (const k of ['document', 'page', 'shape', 'binding']) expect(kinds, k).toContain(k);
      // and what the page shows is what the file holds (the reopened page's own user record once it saves)
      const disk = await doc();
      expect(drawing(disk.snapshot.store)).toEqual(drawing(after));
      expect(await line(again.page)).toMatchObject({ state: 'saved' });
    } finally {
      await again.context.close();
    }
  }, 120_000);
});
