import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio, rgbToHex } from '../src/term/color.js';
import { startStudioServer } from '../src/studio/server.js';

// Fourth order, step 5, the acceptance pass: Timmy Canvas in a real browser, against the real
// server and the real bundle. Every request goes to 127.0.0.1; Timmy's own panel stays on screen and
// clear of tldraw's menus at desktop, tablet and phone sizes; it works from the keyboard; its own text
// clears 4.5:1; and it says when it is loading or cannot start. Skipped, saying so, where no Chromium
// or Chrome is found (a GitHub runner has Chrome at /usr/bin/google-chrome).
const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-canvas-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const hex = (css: string): string => {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return rgbToHex([r, g, b]);
};

describe.skipIf(!browserPath)('Timmy Canvas in a real browser', () => {
  let root = '';
  let home = '';
  let server: Server | undefined;
  let browser: Browser | undefined;
  let base = '';
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-canvas-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function open(size = { width: 1280, height: 800 }, wait = /Timmy connected/): Promise<{ page: Page; context: BrowserContext; origins: Set<string>; errors: string[] }> {
    const context = await browser!.newContext({ viewport: size });
    const origins = new Set<string>();
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      origins.add(url.origin);
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('status')?.textContent ?? ''), wait.source, { timeout: 30_000 });
    return { page, context, origins, errors };
  }

  it('loads nothing from any host but 127.0.0.1, and says it is ready, saved', async () => {
    const { page, context, origins, errors } = await open();
    expect([...origins]).toEqual([base]);
    expect(await page.textContent('#status')).toMatch(/^Canvas ready · tldraw 5\.5\.2 · .+ · Timmy connected · revision 0, saved$/);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('the blank board says where Timmy saves it: the folder this server writes, from TIMMY_HOME (the 20:14 order)', async () => {
    const { page, context } = await open();
    try {
      await page.waitForSelector('#guide:not([hidden])');
      expect(await page.locator('#guide-dir').textContent()).toBe(join(home, 'canvas'));
      expect(await page.locator('#guide').textContent()).not.toContain('~/timmy/canvas');
    } finally {
      await context.close();
    }
  });

  it("keeps its panel on screen and clear of tldraw's menu, style panel and toolbar at desktop, tablet and phone sizes, its text unclipped", async () => {
    for (const size of [{ width: 1280, height: 800 }, { width: 768, height: 600 }, { width: 390, height: 740 }]) {
      const { page, context } = await open(size);
      // A long page name widens tldraw's menu: it must not run under Timmy's panel.
      await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { renamePage: (id: string, n: string) => void; getCurrentPageId: () => string } } }).timmyCanvas.editor; e.renamePage(e.getCurrentPageId(), 'A page with a rather long name for the menu'); });
      await page.waitForTimeout(300);
      // Timmy's own elements: the status and the panel. tldraw's zones present at this size (no waiting for absent ones).
      const zones: Array<[string, Box]> = [];
      for (const zone of ['.tlui-menu-zone', '.tlui-style-panel__wrapper', '.tlui-main-toolbar', '.tlui-navigation-panel']) {
        const box = await (await page.$(zone))?.boundingBox();
        if (box) zones.push([zone, box]);
      }
      expect(zones.length, `tldraw zones found at ${size.width}`).toBeGreaterThanOrEqual(2);
      for (const own of ['#status', '#side']) {
        const box = (await (await page.$(own))!.boundingBox())!;
        expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height, `${own} inside ${size.width}x${size.height}`).toBe(true);
        for (const [zone, other] of zones) expect(overlaps(box, other), `${own} over ${zone} at ${size.width}x${size.height}`).toBe(false);
      }
      expect(await page.$eval('#status', (el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await context.close();
    }
  }, 120_000);

  // Round R1, assignment 3: the panel names each job in the REPL's words: Canvas (job, revision), Receipt, and the time.
  it("lists each job in the REPL's words: its state, its time, Canvas (job and revision), Receipt (linked, or not yet), readable at phone width", async () => {
    const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; error?: string }>;
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 740 }]) {
      const { page, context } = await open(size);
      try {
        const tag = `words-${size.width}`;
        const good = await post('/api/canvas/exec', { code: `const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 300, y: 200, props: { w: 120, h: 60 } }); return id;`, jobId: `${tag}-a` });
        const bad = await post('/api/canvas/exec', { code: "throw new Error('on purpose');", jobId: `${tag}-b` });
        expect(good.ok, good.error).toBe(true);
        expect(bad.ok).toBe(false);
        expect(await post(`/api/canvas/jobs/${tag}-a/receipt`, { receipt: 'a1b2c3d4' })).toEqual({ ok: true, job: `${tag}-a`, receipt: 'a1b2c3d4' });
        // On a phone the jobs start folded: they are in the page before they are on screen.
        await page.waitForSelector(`#job-list li[data-job="${tag}-a"]`, { state: 'attached', timeout: 10_000 });
        await page.waitForSelector(`#job-list li[data-job="${tag}-b"]`, { state: 'attached', timeout: 10_000 });
        if (!(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open))) await page.click('#jobs > summary');
        const api = (await (await fetch(`${base}/api/canvas/jobs`)).json()) as Array<{ id: string; revision: number; at: string; ok: boolean }>;
        const read = (id: string) => page.$eval(`#job-list li[data-job="${id}"]`, (li) => ({
          state: li.querySelector('.job-state')?.textContent,
          time: { text: li.querySelector('time')?.textContent, datetime: li.querySelector('time')?.getAttribute('datetime') },
          canvas: li.querySelector('.job-row[data-row="Canvas"]')?.textContent,
          receipt: li.querySelector('.job-row[data-row="Receipt"]')?.textContent,
          receiptHref: li.querySelector('.job-row[data-row="Receipt"] a')?.getAttribute('href') ?? null,
        }));
        const a = api.find((j) => j.id === `${tag}-a`)!;
        const b = api.find((j) => j.id === `${tag}-b`)!;
        const ra = await read(`${tag}-a`);
        const rb = await read(`${tag}-b`);
        expect(ra.state).toBe('✓ done');
        expect(rb.state).toBe('✖ failed');
        expect(ra.time.datetime).toBe(a.at);
        expect(ra.time.text).toMatch(/^(\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?|.+ \d{1,2}:\d{2})/i);
        expect(ra.canvas).toBe(`Canvas job ${tag}-a, rev ${a.revision}`);
        expect(rb.canvas).toBe(`Canvas job ${tag}-b, rev ${b.revision}`);
        expect(ra.receipt).toBe('Receipt a1b2c3d4');
        expect(ra.receiptHref).toBe('/receipts/a1b2c3d4');
        expect(rb.receipt).toBe('Receipt not linked yet');
        expect(rb.receiptHref).toBeNull();
        // Readable: nothing clipped or sideways, the panel inside the screen and clear of tldraw's toolbar, text at 12px or more.
        const fit = await page.evaluate(() => {
          const side = document.getElementById('side')!;
          const sideBox = side.getBoundingClientRect();
          const toolbar = document.querySelector('.tlui-main-toolbar')?.getBoundingClientRect();
          const rows = [...document.querySelectorAll('#job-list li *')].filter((el) => el.children.length === 0 && el.textContent);
          return {
            sideway: side.scrollWidth > side.clientWidth + 1,
            clipped: rows.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
            smallest: Math.min(...rows.map((el) => parseFloat(getComputedStyle(el).fontSize))),
            inside: sideBox.left >= 0 && sideBox.right <= innerWidth && sideBox.bottom <= innerHeight,
            overToolbar: toolbar ? sideBox.bottom > toolbar.top && sideBox.top < toolbar.bottom && sideBox.right > toolbar.left && sideBox.left < toolbar.right : false,
          };
        });
        expect(fit, `${size.width}px`).toEqual({ sideway: false, clipped: [], smallest: expect.any(Number), inside: true, overToolbar: false });
        expect(fit.smallest).toBeGreaterThanOrEqual(12);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  it("shows a job's drawing on its Canvas row: the click selects the shapes that job made and marks the job", async () => {
    const { page, context } = await open();
    try {
      const made = (await (await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: `const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 350, y: 250, props: { w: 100, h: 50 } }); return id;`, jobId: 'pick-me' }) })).json()) as { ok: boolean; result: string };
      expect(made.ok).toBe(true);
      await page.waitForSelector('#job-list li[data-job="pick-me"]', { timeout: 10_000 });
      // (A block, so the page does not try to send the editor itself back: selectNone returns it.)
      await page.evaluate(() => { (window as never as { timmyCanvas: { editor: { selectNone: () => void } } }).timmyCanvas.editor.selectNone(); });
      await page.click('#job-list li[data-job="pick-me"] .job-row[data-row="Canvas"] button');
      const selected = await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getSelectedShapeIds: () => string[] } } }).timmyCanvas.editor.getSelectedShapeIds());
      expect(selected).toEqual([made.result]);
      await page.waitForFunction(() => document.querySelector('#job-list li[data-job="pick-me"]')?.getAttribute('aria-current') === 'true');
      // A job that drew nothing (or whose shapes are gone) says so instead of selecting nothing silently.
      const none = await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'return 1;', jobId: 'draws-nothing' }) });
      expect((await none.json() as { ok: boolean }).ok).toBe(true);
      await page.waitForSelector('#job-list li[data-job="draws-nothing"]', { timeout: 10_000 });
      await page.click('#job-list li[data-job="draws-nothing"] .job-row[data-row="Canvas"] button');
      await page.waitForFunction(() => /draws-nothing[\s\S]*no shapes of this job on this page/i.test(document.getElementById('job-list')!.textContent ?? ''));
    } finally {
      await context.close();
    }
  }, 60_000);

  it('works from the keyboard: the jobs fold, a template opens, and tldraw takes its own keys', async () => {
    const { page, context } = await open();
    await page.focus('#jobs > summary');
    await page.keyboard.press('Enter');
    expect(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.keyboard.press('Enter');
    expect(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open)).toBe(true);
    await page.focus('#board-pick');
    await page.keyboard.press('ArrowDown'); // the first template, after "Blank board"
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-open');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { getCurrentPage: () => { name: string }; getCurrentPageShapes: () => Array<{ type: string }> } } }).timmyCanvas.editor; return { page: e.getCurrentPage().name, frames: e.getCurrentPageShapes().filter((s) => s.type === 'frame').length }; });
    expect(board).toEqual({ page: 'Prompt Lab', frames: 4 });
    // tldraw's own keys, once the canvas has focus: r picks the rectangle (geo) tool, Escape goes back.
    await page.mouse.click(700, 500);
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('geo');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('select');
    await context.close();
  }, 60_000);

  it("its own text clears 4.5:1 on what is behind it: the panel, the job marks, links, controls, the guide", async () => {
    const { page, context } = await open();
    const pairs = await page.evaluate(() => {
      const bgOf = (el: Element | null): string => {
        for (let n = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (bg && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)) return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const canvasBg = getComputedStyle(document.querySelector('.tl-background') ?? document.body).backgroundColor;
      const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = '✓ done';
      const bad = document.createElement('span'); bad.className = 'bad'; bad.textContent = '✖ failed';
      const link = document.createElement('a'); link.href = '#'; link.textContent = 'receipt';
      const list = document.getElementById('job-list')!;
      list.append(ok, bad, link);
      const els: Array<[string, Element, string?]> = [['status', document.getElementById('status')!], ['jobs', document.querySelector('#jobs summary')!], ['done', ok], ['failed', bad], ['link', link],
        ['label', document.querySelector('label[for="board-pick"]')!], ['select', document.getElementById('board-pick')!], ['button', document.getElementById('board-open')!], ['guide', document.getElementById('guide')!, canvasBg]];
      return els.map(([name, el, behind]) => ({ name, fg: getComputedStyle(el).color, bg: behind ?? bgOf(el) }));
    });
    const low = pairs.map((p) => ({ ...p, ratio: contrastRatio(hex(p.fg), hex(p.bg)) })).filter((p) => p.ratio < 4.5);
    expect(low).toEqual([]);
    await context.close();
  }, 60_000);

  // LIVE-01 (ledger row 65): the model drew a rectangle at (100, 100) and it sat hidden under Timmy's
  // panel. What a call draws now comes into view beside the panel (or below it on a phone), clear of
  // tldraw's toolbar; a call that draws inside the view leaves the camera where it is.
  it('brings what the agent draws into view beside its panel, never under it, and leaves the camera alone when it already shows', async () => {
    const exec = async (code: string, jobId: string) => (await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, jobId }) })).json() as Promise<{ ok: boolean; result: string; error?: string }>;
    const rect = (x: number, y: number, label: string) => `const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: ${x}, y: ${y}, props: { w: 200, h: 100, richText: helpers.toRichText('${label}') } }); return id;`;
    type Cam = { x: number; y: number; z: number };
    const view = (page: Page, id: string) => page.evaluate((shapeId) => {
      const e = (window as never as { timmyCanvas: { editor: { getShapePageBounds: (i: string) => { minX: number; minY: number; maxX: number; maxY: number }; pageToScreen: (p: { x: number; y: number }) => { x: number; y: number }; getCamera: () => Cam } } }).timmyCanvas.editor;
      const b = e.getShapePageBounds(shapeId);
      const a = e.pageToScreen({ x: b.minX, y: b.minY });
      const z = e.pageToScreen({ x: b.maxX, y: b.maxY });
      const c = e.getCamera();
      return { box: { x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y }, camera: { x: c.x, y: c.y, z: c.z } };
    }, id);
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 740 }]) {
      const { page, context } = await open(size);
      const drawn = await exec(rect(100, 100, 'LIVE-01'), `reveal-${size.width}`);
      expect(drawn.ok, drawn.error).toBe(true);
      await page.waitForTimeout(700); // the camera's move
      const { box, camera } = await view(page, drawn.result);
      const side = (await (await page.$('#side'))!.boundingBox())!;
      const toolbar = await (await page.$('.tlui-main-toolbar'))?.boundingBox();
      expect(overlaps(box, side), `under the panel at ${size.width}x${size.height}: ${JSON.stringify(box)}`).toBe(false);
      if (toolbar) expect(overlaps(box, toolbar), `under the toolbar at ${size.width}x${size.height}`).toBe(false);
      expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height, `in view at ${size.width}x${size.height}: ${JSON.stringify(box)}`).toBe(true);
      if (size.width === 1280) {
        // Drawn where the view already shows it: the camera stays.
        const near = await page.evaluate((c: Cam) => ({ x: Math.round(700 / c.z - c.x), y: Math.round(400 / c.z - c.y) }), camera);
        const second = await exec(rect(near.x, near.y, 'beside'), 'reveal-stays');
        expect(second.ok, second.error).toBe(true);
        await page.waitForTimeout(700);
        expect((await view(page, second.result)).camera).toEqual(camera);
      }
      await context.close();
    }
  }, 120_000);

  // Round R1, found on the operator's Mac: a call tldraw refused (props.text on a text shape) crashed
  // the page into "Something went wrong" for good, kept the shapes drawn before the refusal, and later
  // calls answered done to a page nobody could see. A failed call now keeps nothing, and a crashed page
  // starts again from the canvas as it was before the call.
  it('keeps nothing from a call that fails, and starts a crashed page again from the canvas before it', async () => {
    type Answer = { ok: boolean; result?: unknown; error?: string; rolledBack?: boolean; restarted?: boolean; changed?: boolean };
    const exec = async (code: string, jobId: string) => (await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, jobId }) })).json() as Promise<Answer>;
    const box = (x: number) => `editor.createShape({ id: helpers.createShapeId(), type: 'geo', x: ${x}, y: 40, props: { w: 60, h: 60 } });`;
    const { page, context } = await open();
    const count = () => page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentPageShapes: () => unknown[] } } }).timmyCanvas.editor.getCurrentPageShapes().length);
    const mounts = () => page.evaluate(() => (window as never as { timmyCanvas: { mounts: number } }).timmyCanvas.mounts);
    const start = await count();

    // Its own error after drawing: undone, and the page carries on.
    const thrown = await exec(`${box(0)} throw new Error('stop here');`, 'rollback-throw');
    expect(thrown).toMatchObject({ ok: false, rolledBack: true, changed: false, error: 'Error: stop here' });
    expect(thrown.restarted).toBeUndefined();
    expect(await count()).toBe(start);

    // A shape tldraw refuses, after one it took: the page crashed, so it starts again without either.
    const before = await mounts();
    const refused = await exec(`${box(100)} editor.createShape({ id: helpers.createShapeId(), type: 'text', x: 0, y: 160, props: { text: 'the old API' } });`, 'rollback-crash');
    expect(refused).toMatchObject({ ok: false, rolledBack: true, restarted: true, changed: false });
    expect(refused.error).toMatch(/ValidationError/);
    await page.waitForFunction((m) => (window as never as { timmyCanvas: { mounts: number } }).timmyCanvas.mounts > m, before);
    expect(await page.getByText('Something went wrong').count()).toBe(0);
    expect(await count()).toBe(start);

    // The next call draws on the page as it started again, and the saved canvas holds it.
    const drawn = await exec(`${box(200)} return 'drawn';`, 'after-restart');
    expect(drawn).toMatchObject({ ok: true, result: 'drawn', changed: true });
    expect(await count()).toBe(start + 1);
    // Every page's shapes (earlier tests opened boards of their own): the file and the page agree.
    const total = await page.evaluate(() => (window as never as { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string }> } } } }).timmyCanvas.editor.store.allRecords().filter((r) => r.typeName === 'shape').length);
    const saved = (await (await fetch(`${base}/api/canvas/document`)).json()) as { snapshot: { store: Record<string, { typeName: string }> } };
    expect(Object.values(saved.snapshot.store).filter((r) => r.typeName === 'shape')).toHaveLength(total);

    // The jobs say what happened: each failed call is marked, and nothing it drew was kept.
    const jobs = (await (await fetch(`${base}/api/canvas/jobs`)).json()) as Array<{ id: string; ok: boolean; failed?: number }>;
    expect(jobs.find((j) => j.id === 'rollback-crash')).toMatchObject({ ok: false, failed: 1 });
    expect(jobs.find((j) => j.id === 'after-restart')).toMatchObject({ ok: true, failed: 0 });
    await context.close();
  }, 120_000);

  // Round R1: the drawing canvas_exec shows the model runs as written in this tldraw: two labeled boxes,
  // a title, and an arrow bound to both boxes.
  it("the example drawing in canvas_exec's description works in this tldraw", async () => {
    const { CANVAS_EXAMPLE } = await import('../src/agent/canvas-tools.js');
    const { page, context } = await open();
    const answer = (await (await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CANVAS_EXAMPLE, jobId: 'example' }) })).json()) as { ok: boolean; result?: string[]; error?: string; changed?: boolean };
    expect(answer.ok, answer.error).toBe(true);
    expect(answer.changed).toBe(true);
    const arrow = answer.result![2];
    const bound = await page.evaluate((id) => (window as never as { timmyCanvas: { editor: { getBindingsFromShape: (s: string, t: string) => Array<{ toId: string; props: { terminal: string } }> } } }).timmyCanvas.editor.getBindingsFromShape(id, 'arrow').map((b) => `${b.props.terminal}:${b.toId}`).sort(), arrow);
    expect(bound).toEqual([`end:${answer.result![1]}`, `start:${answer.result![0]}`]);
    expect(await page.getByText('Something went wrong').count()).toBe(0);
    await context.close();
  }, 120_000);

  it('says it is loading while it loads, and why it cannot start when it cannot', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/studio-config.json', async (route) => { await held; await route.continue(); });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => /^Loading the canvas/.test(document.getElementById('status')?.textContent ?? ''));
    expect(await page.getAttribute('#status', 'data-kind')).toBe('loading');
    release();
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    // A bundle built from another tldraw than the one Timmy pins: it says so, and how to rebuild.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.fulfill({ json: { licenseKey: null, tldrawVersion: '9.9.9' } }));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toBe('The canvas could not start: this canvas was built with tldraw 5.5.2, but Timmy pins 9.9.9. Rebuild it: npm run build:canvas');
    // Timmy not answering at all.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.abort());
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toMatch(/^The canvas could not start: /);
    await context.close();
  }, 60_000);
});
