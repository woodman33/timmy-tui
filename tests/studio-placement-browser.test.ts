/**
 * R7 (H151; H147's R6 finding 5, REMAINING-DEFECTS row 10: "placed cards cover existing shapes", review/H147/caps/studio/
 * 24-image-added.png; the operator's order of 2026-10-16: "non-overlapping Studio cards"): every way Timmy places on the board
 * puts what it places where it overlaps no shape already there, in a real headless Chromium against the real canvas server and
 * the real bundle (built here). The board is given shapes where the old rules put cards: the middle of the area beside the panel
 * (where a project card went) and just right of the rightmost card (where the next drawn card, artifact card or reference image
 * went). Then one of each kind is placed through the page's own calls (the panel's buttons and the agent's tools call the same):
 * a project card, a drawn card, a node, an operation's cards, an artifact card and a reference image. Each one's page bounds
 * overlap none of the shapes that were on the board before it, and each is brought into view. The project, its operation and its
 * image are FAKE (tests/helpers/canvas-project.ts, canvas-operation.ts, vox-fakes.ts). Skipped, saying so, where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';
import { addOperation, type Operation } from './helpers/canvas-operation.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { png } from './helpers/vox-fakes.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-placement-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const HX = 'e'.repeat(32);
type B = { minX: number; minY: number; maxX: number; maxY: number };
type Ed = {
  getCurrentPageShapes: () => Array<{ id: string; type: string; parentId: string }>; getShapePageBounds: (id: string) => B & { w: number; h: number };
  pageToScreen: (p: { x: number; y: number }) => { x: number; y: number }; screenToPage: (p: { x: number; y: number }) => { x: number; y: number };
  createShape: (s: unknown) => void; getShape: (id: string) => { id: string; parentId: string } | undefined;
};
type Win = { timmyCanvas: { editor: Ed; placeProjectCard: (id?: string) => Promise<{ shape?: string; cards?: Array<{ id: string; kind: string }> }>; placeDrawnCard: (id: string) => Promise<{ shape: string }>;
  placeOperation: (id: string) => Promise<{ placed: Array<{ shape: string }>; arrows: Array<{ arrow: string }> }>; placeArtifact: (id: string) => Promise<{ shape: string }>;
  placeReference: (path: string) => Promise<{ image: string; caption: string; group: string }>; addNode: (kind: string, id: string) => Promise<{ shape?: string }> } };

describe.skipIf(!browserPath)('every way Timmy places on the board puts it where it covers no shape (R7 H151)', () => {
  let p: CanvasProject;
  let o: Operation;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-place-');
    o = await addOperation(p);
    mkdirSync(join(p.root, 'refs'), { recursive: true });
    writeFileSync(join(p.root, 'refs', 'photo.png'), png(320, 200, (x) => (x < 160 ? [200, 10, 10] : [10, 10, 200])));
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-place-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-place-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    await nameProject(port, server.projectToken, { root: p.root, name: 'placement', holder: HX, jobs: p.jobs, receipts: p.store });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(viewport = { width: 1440, height: 900 }): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    return { page, context, errors };
  }

  /** The page bounds of every top shape on the page now (a group's, not its children's), by id. */
  const boxes = (page: Page) => page.evaluate(() => {
    const e = (window as never as Win).timmyCanvas.editor;
    return Object.fromEntries(e.getCurrentPageShapes().filter((s) => s.parentId.startsWith('page:')).map((s) => { const b = e.getShapePageBounds(s.id); return [s.id, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }]; }));
  });
  /** Which of `before` (shapes on the board before a placement) the placed shapes' bounds overlap: none, for a placement that covers nothing. */
  const covered = (placed: B[], before: Record<string, B>): string[] => Object.entries(before)
    .filter(([, b]) => placed.some((q) => q.minX < b.maxX && b.minX < q.maxX && q.minY < b.maxY && b.minY < q.maxY)).map(([id]) => id);
  /** A FAKE shape the person drew (a rectangle), at page `x`, `y`, of `w` x `h`. */
  const drawBox = (page: Page, x: number, y: number, w: number, h: number) => page.evaluate(({ x, y, w, h }) => { (window as never as Win).timmyCanvas.editor.createShape({ type: 'geo', x, y, props: { w, h } }); }, { x, y, w, h });
  /** Whether the bounds `b` are on screen, beside the panel, above tldraw's toolbar. */
  const inView = (page: Page, b: B) => page.evaluate((q) => {
    const e = (window as never as Win).timmyCanvas.editor;
    const a = e.pageToScreen({ x: q.minX, y: q.minY });
    const z = e.pageToScreen({ x: q.maxX, y: q.maxY });
    const side = document.getElementById('side')!.getBoundingClientRect();
    const bar = document.querySelector('.tlui-main-toolbar__inner')?.getBoundingClientRect();
    return a.x >= side.right - 1 && a.y >= 0 && z.x <= innerWidth + 1 && z.y <= (bar ? bar.top : innerHeight) + 1;
  }, b);

  it('a project card, a drawn card, a node, an operation\'s cards, an artifact card and a reference image, each placed on a board with shapes where the old rules put cards: none covers a shape that was there before it, and each is brought into view', async () => {
    const { page, context, errors } = await open();
    try {
      // the middle of the area beside the panel, where a project card went: a shape of the person's there
      const mid = await page.evaluate(() => {
        const e = (window as never as Win).timmyCanvas.editor;
        const side = document.getElementById('side')!.getBoundingClientRect();
        const top = document.getElementById('root')!.getBoundingClientRect().top + 56;
        const bar = document.querySelector('.tlui-main-toolbar__inner')!.getBoundingClientRect();
        return e.screenToPage({ x: (side.right + innerWidth) / 2, y: (top + bar.top) / 2 });
      });
      await drawBox(page, Math.round(mid.x - 260), Math.round(mid.y - 180), 520, 360);
      const listed = await page.evaluate(() => (window as never as Win).timmyCanvas.placeProjectCard());
      const workflow = listed.cards!.find((c) => c.kind === 'workflow')!.id;
      const params = listed.cards!.find((c) => c.kind === 'params')!.id;
      const placedAll: Array<{ kind: string; ids: string[] }> = [];
      /** Places one block with `run`, then checks it against the board as it was just before (`ids`: its shapes). */
      const place = async (kind: string, run: () => Promise<string[]>): Promise<B[]> => {
        const before = await boxes(page);
        const ids = await run();
        await page.waitForTimeout(150);
        const after = await boxes(page);
        const top = (id: string) => page.evaluate((x) => { const e = (window as never as Win).timmyCanvas.editor; let s = e.getShape(x); while (s && !s.parentId.startsWith('page:')) s = e.getShape(s.parentId); return s ? s.id : x; }, id);
        const tops = [...new Set(await Promise.all(ids.map(top)))];
        const own = tops.map((id) => after[id]).filter(Boolean);
        expect(own.length, `${kind}: its shapes on the board`).toBeGreaterThan(0);
        expect(covered(own, before), `${kind} covers what was on the board before it`).toEqual([]);
        for (const b of own) expect(await inView(page, b), `${kind} in view`).toBe(true);
        placedAll.push({ kind, ids: tops });
        return own;
      };
      const note = await place('project card', async () => [(await page.evaluate((id) => (window as never as Win).timmyCanvas.placeProjectCard(id), workflow)).shape!]);
      // just right of the rightmost card, where the next drawn card, artifact card or image went: a shape there each time
      const rightOf = async (b: B) => drawBox(page, Math.round(b.maxX + 32), Math.round(b.minY), 420, 320);
      await rightOf(note[0]);
      const card = await place('drawn card', async () => [(await page.evaluate((id) => (window as never as Win).timmyCanvas.placeDrawnCard(id), workflow)).shape]);
      await rightOf(card[0]);
      const node = await place('node', async () => [(await page.evaluate((id) => (window as never as Win).timmyCanvas.addNode('params', id), params)).shape!]);
      await rightOf(node[0]);
      await place('operation\'s cards', async () => {
        const r = await page.evaluate((id) => (window as never as Win).timmyCanvas.placeOperation(id), o.op);
        return r.placed.map((x) => x.shape);
      });
      await place('artifact card', async () => [(await page.evaluate((id) => (window as never as Win).timmyCanvas.placeArtifact(id), `run:${o.op}`)).shape]);
      const all = await boxes(page);
      const rightmost = Object.values(all).reduce((a, b) => (b.maxX > a.maxX ? b : a));
      await rightOf(rightmost);
      await place('reference image', async () => { const r = await page.evaluate(() => (window as never as Win).timmyCanvas.placeReference('refs/photo.png')); return [r.group || r.image]; });
      // and no two placed blocks cover each other, now that every card has its height
      await page.waitForTimeout(400);
      const end = await boxes(page);
      const blocks = placedAll.map((x) => ({ kind: x.kind, boxes: x.ids.map((id) => end[id]).filter(Boolean) }));
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const other = Object.fromEntries(blocks[j].boxes.map((b, k) => [`${blocks[j].kind} ${k}`, b]));
          expect(covered(blocks[i].boxes, other), `${blocks[i].kind} and ${blocks[j].kind}`).toEqual([]);
        }
      }
      expect(errors.filter((e) => !/status of 401/.test(e))).toEqual([]);
      if (process.env.TIMMY_CANVAS_SHOTS) {
        mkdirSync(process.env.TIMMY_CANVAS_SHOTS, { recursive: true });
        await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { zoomToFit: () => void } } }).timmyCanvas.editor; e.zoomToFit(); });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(process.env.TIMMY_CANVAS_SHOTS, 'placement-every-kind-1440x900.png') });
      }
    } finally {
      await context.close();
    }
  }, 180_000);
});
