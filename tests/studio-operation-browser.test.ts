/**
 * Round R4 (H100): operations on Timmy Canvas in a real headless Chromium, against the real canvas server, the real bundle
 * (built here into a temporary folder, as tests/studio-project-browser.test.ts builds it) and a real temporary project with
 * one operation (tests/helpers/canvas-operation.ts: Timmy's own operation record, a job started inside it by the real
 * JobManager with a FAKE program standing in for upmd, then a flow and a VoxVision record naming it, FIXTURES written in
 * their schemas). The project is named the way the REPL names it
 * (POST /api/project/active with the server's token, no holder: the drawn cards are diagrams here; their actions are tested
 * in tests/studio-cards-browser.test.ts). A person's moves are Chromium's own input (a mouse drag, a click, the Delete key);
 * a resize is the editor's own call, as tldraw's resize handle makes it. Every request the page makes goes to 127.0.0.1
 * (anything else is aborted). Skipped, saying so, where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, writeVox, type Operation } from './helpers/canvas-operation.js';
import { bearer, grant } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-operation-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** A drawn card as the page holds it. */
type Drawn = { id: string; card: string; x: number; y: number; w: number; h: number; op: unknown };
type Arrow = { id: string; op: unknown; start: string | null; end: string | null };
type Editor = {
  store: { allRecords: () => Array<{ typeName: string; type?: string; id: string; x?: number; y?: number; props: Record<string, unknown>; meta: Record<string, unknown> }> };
  getShape: (id: string) => { id: string; type: string; x: number; y: number; props: Record<string, unknown> } | undefined;
  getBindingsFromShape: (id: string, type: string) => Array<{ toId: string; props: { terminal: string } }>;
  getCurrentPage: () => { id: string; meta: Record<string, unknown> };
  updateShape: (s: unknown) => void;
  undo: () => void;
  getShapePageBounds: (id: string) => { minX: number; minY: number; maxX: number; maxY: number; center: { x: number; y: number } } | undefined;
  centerOnPoint: (p: { x: number; y: number }, o?: unknown) => void;
  getCamera: () => { z: number };
};
type Win = { timmyCanvas: { editor: Editor; placeOperation: (id: string) => Promise<{ words: string }> } };

describe.skipIf(!browserPath)('Timmy Canvas: operations in a real browser', () => {
  let p: CanvasProject;
  let o: Operation;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';

  beforeAll(async () => {
    p = await makeCanvasProject('studio-operation-browser-');
    o = await addOperation(p);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-op-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-op-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const named = await fetch(`${base}/api/project/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` },
      body: JSON.stringify({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }),
    });
    expect(named.status).toBe(200);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(context: BrowserContext): Promise<{ page: Page; origins: Set<string>; errors: string[] }> {
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.hostname === '127.0.0.1' && url.origin === base ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/#code=${await grant(Number(new URL(base).port), server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    return { page, origins, errors };
  }
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** The drawn cards on the page, placed for operation `op`, from left to right. */
  const drawn = (page: Page, op: string): Promise<Drawn[]> => page.evaluate((id) => {
    const e = (window as never as Win).timmyCanvas.editor;
    return e.store.allRecords().filter((r) => r.typeName === 'shape' && typeof r.type === 'string' && r.type.startsWith('timmy-') && r.meta?.timmyOperation === id)
      .map((r) => ({ id: r.id, card: String(r.props.card), x: r.x ?? 0, y: r.y ?? 0, w: Number(r.props.w), h: Number(r.props.h), op: r.meta.timmyOperation }))
      .sort((a, b) => a.x - b.x);
  }, op);
  const arrows = (page: Page, op: string): Promise<Arrow[]> => page.evaluate((id) => {
    const e = (window as never as Win).timmyCanvas.editor;
    return e.store.allRecords().filter((r) => r.typeName === 'shape' && r.type === 'arrow' && r.meta?.timmyOperation === id).map((r) => {
      const b = e.getBindingsFromShape(r.id, 'arrow');
      return { id: r.id, op: r.meta.timmyOperation, start: b.find((x) => x.props.terminal === 'start')?.toId ?? null, end: b.find((x) => x.props.terminal === 'end')?.toId ?? null };
    });
  }, op);
  const place = async (page: Page, words: RegExp): Promise<string> => {
    await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
    await page.click(`#project-groups section.pop[data-op="${o.op}"] .pop-place`);
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('project-said')?.textContent ?? ''), words.source, { timeout: 15_000 });
    return text(page, '#project-said');
  };
  /** Brings a drawn card to the middle of the view at its zoom (a canvas is not scrolled, its camera is moved). */
  const centre = async (page: Page, shape: string): Promise<void> => {
    await page.evaluate((id) => { const e = (window as never as Win).timmyCanvas.editor; const b = e.getShapePageBounds(id); if (b) e.centerOnPoint(b.center, { animation: { duration: 0 } }); }, shape);
    await page.waitForTimeout(150);
  };

  it("groups the project's cards by operation (each under its id, state and request, in the order they ran), and the choice is kept for this browser", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { page, origins, errors } = await open(context);
      // By kind (as before): each row names its operation, or says why none
      expect(await page.getAttribute('#project-by button[data-by="kind"]', 'aria-pressed')).toBe('true');
      expect(await text(page, `#project-groups li.pcard[data-card="flow:${o.flowId}"] .pcard-op`)).toBe(`operation ${o.op}`);
      expect(await text(page, '#project-groups li.pcard[data-card="workflow:BUILD.md"] .pcard-op')).toBe('no operation: not run yet');
      expect(await text(page, `#project-groups li.pcard[data-card="flow:${p.flow}"] .pcard-op`)).toBe('no operation: its flow record names none');
      // By operation
      await page.click('#project-by button[data-by="operation"]');
      const group = `#project-groups section.pop[data-op="${o.op}"]`;
      await page.waitForSelector(group);
      expect(await page.getAttribute('#project-by button[data-by="operation"]', 'aria-pressed')).toBe('true');
      expect(await text(page, `${group} .pop-head`)).toBe(`Operation ${o.op} · succeeded`);
      // the request as its record says it, the project's folder written as "."
      expect(await text(page, `${group} .pop-request`)).toBe('/run RUN.md build # in .');
      expect(await text(page, `${group} .pop-count`)).toBe('4 cards, in the order they ran');
      expect(await page.$$eval(`${group} li.pcard`, (lis) => lis.map((li) => (li as HTMLElement).dataset.card))).toEqual(['workflow:RUN.md', `run:job:${o.job.id}`, `flow:${o.flowId}`, `vox:${o.voxId}`]);
      // the group names its operation once; its rows do not repeat it
      expect(await page.locator(`${group} .pcard-op`).count()).toBe(0);
      expect(await text(page, '#project-groups section.pop-rest h3')).toMatch(/^No operation named \(\d+\)$/);
      expect(await text(page, '#project-groups section.pop-rest li.pcard[data-card="workflow:BUILD.md"] .pcard-op')).toBe('no operation: not run yet');
      // a second page of this browser (a new grant) starts grouped by operation
      const second = await open(context);
      await second.page.waitForSelector(group);
      expect(await second.page.getAttribute('#project-by button[data-by="operation"]', 'aria-pressed')).toBe('true');
      expect([...origins, ...second.origins].every((x) => x === base)).toBe(true);
      expect([...errors, ...second.errors]).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("Place this operation lays its cards out left to right in the order they ran, linked by arrows bound to them, each card naming the operation; again, it adds no duplicate, keeps a person's moves, sizes and deletions, adds what ran since, and says so", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const { page, origins, errors } = await open(context);
      await page.click('#project-by button[data-by="operation"]');
      await page.waitForSelector(`#project-groups section.pop[data-op="${o.op}"] .pop-place`);
      // 1. The first press
      expect(await place(page, /^Operation /)).toBe(`Operation ${o.op}: 4 cards placed left to right in the order they ran, linked by 3 arrows.`);
      await page.waitForTimeout(400);
      // a screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder: otherwise a run leaves nothing behind
      const shots = process.env.TIMMY_CANVAS_SHOTS;
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, 'operation-placed-1440x900.png') });
      }
      const first = await drawn(page, o.op);
      expect(first.map((d) => d.card)).toEqual(['workflow:RUN.md', `run:job:${o.job.id}`, `flow:${o.flowId}`, `vox:${o.voxId}`]);
      for (let i = 1; i < first.length; i++) {
        expect(first[i].y, 'one row').toBe(first[0].y);
        expect(first[i].x, 'left to right, the room for an arrow between').toBe(Math.round(first[i - 1].x + first[i - 1].w + 72));
      }
      // each arrow is bound to the card before and the card after it (tldraw moves its ends with them)
      const chain = await arrows(page, o.op);
      const pairs = (list: Arrow[]): string[] => list.map((a) => `${a.start} → ${a.end}`).sort();
      expect(pairs(chain)).toEqual([`${first[0].id} → ${first[1].id}`, `${first[1].id} → ${first[2].id}`, `${first[2].id} → ${first[3].id}`].sort());
      // each card names the operation on its face, as Timmy read it from its record now
      await page.waitForFunction((ids) => ids.every((id) => document.querySelector(`[data-timmy-card="${id}"] .tc-op`)), first.map((d) => d.id));
      for (const d of first) expect(await text(page, `[data-timmy-card="${d.id}"] .tc-op`)).toBe(`operation ${o.op}`);
      // the row is in view with the cards' heights: each card's last line (Details) is under nothing, neither the panel nor
      // tldraw's toolbar
      for (const d of first) {
        expect(await page.evaluate((id) => {
          const f = document.querySelector(`[data-timmy-card="${id}"] .tc-toggle`);
          if (!f) return false;
          const b = f.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!hit && (hit === f || f.contains(hit));
        }, d.id), `${d.card}'s Details`).toBe(true);
      }
      // ... and its Details name it: where it was read, its request and state as its record says, and /op
      await centre(page, first[2].id);
      await page.click(`[data-timmy-card="${first[2].id}"] .tc-toggle`);
      await page.waitForSelector(`[data-timmy-card="${first[2].id}"] .tc-details`);
      const rows = await page.$$eval(`[data-timmy-card="${first[2].id}"] .tc-details dl:first-child > *`, (n) => n.map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(rows).toEqual(['operation', `${o.op}, as its flow record names it`, 'its request', '/run RUN.md build # in .', 'its state', 'succeeded, as its record says', 'in Timmy', `/op ${o.op}`]);
      await page.click(`[data-timmy-card="${first[2].id}"] .tc-toggle`);

      // 2. A person's edits: the workflow card dragged down (Chromium's own mouse), the job's card selected and deleted (a click
      //    and the Delete key), the VoxVision card made wider (the editor's resize, as tldraw's handle makes it)
      await centre(page, first[0].id);
      const z = await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCamera().z);
      const title = (await page.locator(`[data-timmy-card="${first[0].id}"] .tc-title`).boundingBox())!;
      await page.mouse.move(title.x + 20, title.y + title.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(title.x + 20, title.y + title.height / 2 + 15 * i);
      await page.mouse.up();
      await page.waitForTimeout(200);
      const moved = (await drawn(page, o.op)).find((d) => d.id === first[0].id)!;
      expect(Math.abs(moved.y - (first[0].y + 120 / z)), `dragged ${moved.y - first[0].y} at zoom ${z}`).toBeLessThan(8);
      await centre(page, first[1].id);
      const job = (await page.locator(`[data-timmy-card="${first[1].id}"] .tc-title`).boundingBox())!;
      await page.mouse.click(job.x + 10, job.y + job.height / 2);
      await page.keyboard.press('Delete');
      await page.waitForFunction((id) => !(window as never as Win).timmyCanvas.editor.getShape(id), first[1].id);
      await page.evaluate((id) => { const e = (window as never as Win).timmyCanvas.editor; const s = e.getShape(id)!; e.updateShape({ id, type: s.type, props: { w: 520 } }); }, first[3].id);

      // 3. Pressed again: nothing added, nothing written over, and it says so
      expect(await place(page, /^Operation /)).toBe(`Operation ${o.op}: nothing added; 3 cards already placed for it, left as they are; 1 card you deleted not placed again (Place card in the list places one).`);
      const again = await drawn(page, o.op);
      expect(again.map((d) => d.card)).toEqual(['workflow:RUN.md', `flow:${o.flowId}`, `vox:${o.voxId}`]);
      expect(again.find((d) => d.id === first[0].id)).toMatchObject({ x: moved.x, y: moved.y });
      expect(again.find((d) => d.id === first[3].id)!.w).toBe(520);
      expect((await arrows(page, o.op)).length).toBe(3);

      // 4. A record of the operation made since (a second VoxVision record): pressed again, it is added after the rightmost
      //    card of the operation and linked to the card before it
      writeVox(p, 'vc3d4e5f6', o.op, '2099-01-01T00:00:03.000Z');
      expect(await place(page, /added/)).toBe(`Operation ${o.op}: 1 card added and linked by 1 arrow; 3 cards already placed for it, left as they are; 1 card you deleted not placed again (Place card in the list places one).`);
      const third = await drawn(page, o.op);
      const vox = third.find((d) => d.id === first[3].id)!;
      const added = third.find((d) => d.card === 'vox:vc3d4e5f6')!;
      expect(added).toMatchObject({ x: Math.round(vox.x + vox.w + 72), y: Math.round(vox.y) });
      expect((await arrows(page, o.op)).filter((a) => a.end === added.id).map((a) => a.start)).toEqual([first[3].id]);
      expect(third.filter((d) => d.card === `vox:${o.voxId}`).length).toBe(1);

      // 5. The press is one step of tldraw's undo: undone, the card and arrow it added are gone, and the page's record with them
      const record = (): Promise<unknown> => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPage().meta.timmyOperations);
      const withAdded = JSON.stringify(await record());
      await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.undo(); });
      await page.waitForTimeout(100);
      expect((await drawn(page, o.op)).map((d) => d.card)).toEqual(['workflow:RUN.md', `flow:${o.flowId}`, `vox:${o.voxId}`]);
      expect((await arrows(page, o.op)).length).toBe(3);
      expect(JSON.stringify(await record())).not.toBe(withAdded);
      expect(JSON.stringify(await record())).not.toContain('vox:vc3d4e5f6');

      // 6. Saved by Timmy with the page's record and the arrows; no token, no absolute path
      let saved = '';
      for (let i = 0; i < 40 && !(saved.includes('timmyOperations') && saved.includes(first[0].id)); i++) {
        await new Promise((r) => setTimeout(r, 150));
        saved = await (await fetch(`${base}/api/canvas/document`, { headers: bearer(server.projectToken) })).text();
      }
      expect(saved).toContain('timmyOperations');
      expect(saved).toContain(`"timmyOperation":"${o.op}"`);
      expect(saved).not.toContain(server.projectToken);
      for (const f of [p.root, p.real, p.base]) expect(saved).not.toContain(f);
      expect([...origins].every((x) => x === base)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
