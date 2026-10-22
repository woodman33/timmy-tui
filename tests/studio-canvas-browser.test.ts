import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio, rgbToHex } from '../src/term/color.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';
import { projectId } from '../src/project/index.js';

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
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  // R4 (H83): every call here is the REPL's (the server's token); every page is opened as /canvas open opens it (a one-time grant)
  const port = (): number => (server!.address() as AddressInfo).port;
  const auth = (): Record<string, string> => bearer(server!.projectToken);
  const opened = async (): Promise<string> => `${base}/#code=${await grant(port(), server!.projectToken)}`;
  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; error?: string }>;
  const getJson = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`, { headers: auth() })).json() as Promise<T>;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-canvas-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // the project the canvas shows, named as the REPL names it (no holder: no REPL takes card actions here)
    const project = join(home, 'project');
    mkdirSync(project);
    await nameProject(port(), server.projectToken, { root: project, name: 'canvas-browser' });
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
    await page.goto(await opened());
    await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('status')?.textContent ?? ''), wait.source, { timeout: 30_000 });
    return { page, context, origins, errors };
  }

  it('loads nothing from any host but 127.0.0.1, and says it is ready, saved', async () => {
    const { page, context, origins, errors } = await open();
    expect([...origins]).toEqual([base]);
    // R10 (H167; the round's rule: diagnostics in a details control): the line says the canvas's state; tldraw's version and its
    // license's verdict are the canvas's Details, under the save line (closed at first), beside the folder Timmy saves the board in
    expect(await page.textContent('#status')).toBe('Canvas ready · ● Timmy connected · revision 0, saved');
    expect(await page.textContent('#side-about-canvas')).toMatch(/^tldraw 5\.5\.2 · .+$/);
    expect(await page.$eval('#side-about', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    // R5 (H137; QA defect 26): the bar beside the line is neutral (its facts are not live observations); only "● Timmy connected",
    // the bridge's socket open now, is green, and only that part
    const look = await page.evaluate(() => {
      const st = document.getElementById('status')!;
      const parts = [...st.querySelectorAll('*')].map((e) => ({ text: e.textContent, color: getComputedStyle(e).color }));
      return { bar: getComputedStyle(st).borderLeftColor, line: getComputedStyle(st).color, parts };
    });
    const greens = ['rgb(40, 254, 20)', 'rgb(0, 215, 0)'];
    expect(greens).not.toContain(look.bar);
    expect(greens).not.toContain(look.line);
    expect(look.parts).toEqual([{ text: '● Timmy connected', color: expect.stringMatching(/^rgb\((40, 254, 20|0, 215, 0)\)$/) }]);
    expect(errors).toEqual([]);
    await context.close();
  }, 60_000);

  it('the blank board says where Timmy saves it: the folder this server writes, from TIMMY_HOME (the 20:14 order)', async () => {
    const { page, context } = await open();
    try {
      await page.waitForSelector('#guide:not([hidden])');
      // R6 (H139): the project's own board, in its own folder of the canvas folder. R10 (H167; the round's rule: no path on the
      // face outside the inspector): the guide says where in words, and the folder itself is in the panel's Details
      expect(await page.locator('#guide-dir').textContent()).toBe(join(home, 'canvas', 'projects', projectId(join(home, 'project'))));
      expect(await page.$eval('#guide-dir', (e) => !!e.closest('#side-about'))).toBe(true);
      expect(await page.locator('#guide').textContent()).toContain('Timmy saves it for this project, in its home (the panel\'s Details say where), so it reopens where you left it.');
      expect(await page.locator('#guide').textContent()).not.toContain('~/timmy/canvas');
      expect(await page.locator('#guide').textContent()).not.toContain(home);
      // R5 (H137; QA defect 13): its heading is off-white (amber is focus and the one next step), and New board's Open is outlined:
      // no fill of the page's own is amber (tldraw's own chrome, its selected tool, is tldraw's selection)
      const look = await page.evaluate(() => ({
        heading: getComputedStyle(document.querySelector('#guide strong')!).color, text: getComputedStyle(document.getElementById('side')!).color,
        fills: [...document.querySelectorAll('body *')].filter((e) => !e.closest('.tlui-layout') && getComputedStyle(e).backgroundColor === 'rgb(255, 176, 0)').map((e) => e.id || e.tagName),
      }));
      expect(look.heading).toBe(look.text);
      expect(look.fills).toEqual([]);
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
      // R6 (H145): the toolbar as drawn (.tlui-main-toolbar__inner), as R5 (H137) ruled in tests/studio-panel-layout-browser.test.ts:
      // .tlui-main-toolbar is a full-width row that draws nothing at the left, where the panel may reach down to the navigation panel
      for (const zone of ['.tlui-menu-zone', '.tlui-style-panel__wrapper', '.tlui-main-toolbar__inner', '.tlui-navigation-panel']) {
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
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 740 }]) {
      const { page, context } = await open(size);
      try {
        const tag = `words-${size.width}`;
        const good = await post('/api/canvas/exec', { code: `const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 300, y: 200, props: { w: 120, h: 60 } }); return id;`, jobId: `${tag}-a` });
        const bad = await post('/api/canvas/exec', { code: "throw new Error('on purpose');", jobId: `${tag}-b` });
        expect(good.ok, good.error).toBe(true);
        expect(bad.ok).toBe(false);
        expect(await post(`/api/canvas/jobs/${tag}-a/receipt`, { receipt: 'a1b2c3d4' })).toEqual({ ok: true, job: `${tag}-a`, receipt: 'a1b2c3d4', project: { id: projectId(join(home, 'project')), name: 'canvas-browser' } });
        // On a phone the jobs start folded: they are in the page before they are on screen.
        await page.waitForSelector(`#job-list li[data-job="${tag}-a"]`, { state: 'attached', timeout: 10_000 });
        await page.waitForSelector(`#job-list li[data-job="${tag}-b"]`, { state: 'attached', timeout: 10_000 });
        // R6 lead (CI on #99 at 1165cbd): since H139 a job this page answered is listed at once with the page's own time, marked
        // "answered here; Timmy records it next" (data-waiting), until the page reads Timmy's ledger. The rows compared with the
        // ledger below are the recorded ones: wait for them (and for a's receipt), not for the first row drawn.
        await page.waitForFunction((t) => {
          const row = (id: string) => document.querySelector<HTMLElement>(`#job-list li[data-job="${id}"]`);
          const a = row(`${t}-a`);
          const b = row(`${t}-b`);
          return !!a && !a.dataset.waiting && !!a.querySelector('.job-row[data-row="Receipt"] a') && !!b && !b.dataset.waiting;
        }, tag, { timeout: 15_000 });
        // R7 (H151): below 1100 px the panel's lists start folded behind #side-fold (the board keeps most of the window): opened first
        if ((await page.getAttribute('#side', 'data-folded')) === 'true') await page.click('#side-fold');
        if (!(await page.$eval('#jobs', (d) => (d as HTMLDetailsElement).open))) await page.click('#jobs > summary');
        const api = await getJson<Array<{ id: string; revision: number; at: string; ok: boolean }>>('/api/canvas/jobs');
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
        // R5 (H137; the QA round, defect 6): the one time format, this computer's 24-hour clock (the date too on another day)
        expect(ra.time.text).toMatch(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d$/);
        // R10 (H167; the round's rule: ids behind a details control): the job by the revision it left and what it drew, its
        // receipt by its page; the job's id and its receipt's are under the row's Details (closed at first)
        expect(ra.canvas).toBe(`Canvas revision ${a.revision}: select what it drew`);
        expect(rb.canvas).toBe(`Canvas revision ${b.revision}: select what it drew`);
        expect(ra.receipt).toBe('Receipt open its page');
        expect(ra.receiptHref).toBe('/receipts/a1b2c3d4');
        expect(rb.receipt).toBe('Receipt not linked yet');
        expect(rb.receiptHref).toBeNull();
        const more = (id: string) => page.$eval(`#job-list li[data-job="${id}"] .job-more`, (d) => ({ open: (d as HTMLDetailsElement).open, words: d.textContent }));
        expect(await more(`${tag}-a`)).toEqual({ open: false, words: `Details job ${tag}-a · receipt a1b2c3d4` });
        expect(await more(`${tag}-b`)).toEqual({ open: false, words: `Details job ${tag}-b` });
        // Readable: nothing clipped or sideways, the panel inside the screen and clear of tldraw's toolbar, text at 12px or more.
        // R5 (H137): the toolbar as drawn (its inner part: .tlui-main-toolbar is a full-width container that draws nothing at the
        // left), and the navigation panel at the bottom left: the panel now reaches down to whichever is under it, never over it
        const fit = await page.evaluate(() => {
          const side = document.getElementById('side')!;
          const sideBox = side.getBoundingClientRect();
          const parts = [...document.querySelectorAll('.tlui-main-toolbar__inner, .tlui-navigation-panel')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
          const rows = [...document.querySelectorAll('#job-list li *')].filter((el) => el.children.length === 0 && el.textContent);
          return {
            sideway: side.scrollWidth > side.clientWidth + 1,
            clipped: rows.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
            smallest: Math.min(...rows.map((el) => parseFloat(getComputedStyle(el).fontSize))),
            inside: sideBox.left >= 0 && sideBox.right <= innerWidth && sideBox.bottom <= innerHeight,
            overToolbar: parts.some((b) => sideBox.bottom > b.top && sideBox.top < b.bottom && sideBox.right > b.left && sideBox.left < b.right),
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
      const made = (await post('/api/canvas/exec', { code: `const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 350, y: 250, props: { w: 100, h: 50 } }); return id;`, jobId: 'pick-me' })) as { ok: boolean; result: string };
      expect(made.ok).toBe(true);
      await page.waitForSelector('#job-list li[data-job="pick-me"]', { timeout: 10_000 });
      // (A block, so the page does not try to send the editor itself back: selectNone returns it.)
      await page.evaluate(() => { (window as never as { timmyCanvas: { editor: { selectNone: () => void } } }).timmyCanvas.editor.selectNone(); });
      await page.click('#job-list li[data-job="pick-me"] .job-row[data-row="Canvas"] button');
      const selected = await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getSelectedShapeIds: () => string[] } } }).timmyCanvas.editor.getSelectedShapeIds());
      expect(selected).toEqual([made.result]);
      await page.waitForFunction(() => document.querySelector('#job-list li[data-job="pick-me"]')?.getAttribute('aria-current') === 'true');
      // A job that drew nothing (or whose shapes are gone) says so instead of selecting nothing silently.
      expect((await post('/api/canvas/exec', { code: 'return 1;', jobId: 'draws-nothing' })).ok).toBe(true);
      await page.waitForSelector('#job-list li[data-job="draws-nothing"]', { timeout: 10_000 });
      await page.click('#job-list li[data-job="draws-nothing"] .job-row[data-row="Canvas"] button');
      await page.waitForFunction(() => /no shapes of this job on this page/i.test(document.querySelector('#job-list li[data-job="draws-nothing"] .job-row[data-row="Canvas"]')?.textContent ?? ''));
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
    await page.keyboard.press('ArrowDown'); // the first template, after "Blank board": R5 (H133) the first guided blank board
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('board-open');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const board = await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { getCurrentPage: () => { name: string }; getCurrentPageShapes: () => Array<{ type: string }> } } }).timmyCanvas.editor; return { page: e.getCurrentPage().name, frames: e.getCurrentPageShapes().filter((s) => s.type === 'frame').length }; });
    expect(board).toEqual({ page: 'Workflow: intent → predict → sandbox → review → receipt', frames: 5 });
    // and a seed, further down the list, still opens as its title and an empty frame per capability
    await page.selectOption('#board-pick', 'P63');
    await page.click('#board-open');
    await page.waitForTimeout(400);
    const seed = await page.evaluate(() => { const e = (window as never as { timmyCanvas: { editor: { getCurrentPage: () => { name: string }; getCurrentPageShapes: () => Array<{ type: string }> } } }).timmyCanvas.editor; return { page: e.getCurrentPage().name, frames: e.getCurrentPageShapes().filter((s) => s.type === 'frame').length }; });
    expect(seed).toEqual({ page: 'Prompt Lab', frames: 4 });
    // tldraw's own keys, once the canvas has focus: r picks the rectangle (geo) tool, Escape goes back.
    await page.mouse.click(700, 500);
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('geo');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as never as { timmyCanvas: { editor: { getCurrentToolId: () => string } } }).timmyCanvas.editor.getCurrentToolId())).toBe('select');
    await context.close();
  }, 60_000);

  // R5 (H133): "Templates shipped publicly start blank and guided, without private creative assets."
  it('opens each guided blank board as its title, what it is for, and empty frames that say what goes where: text only, no image or asset', async () => {
    const { guidedTemplates } = await import('../src/studio/templates.js');
    const { page, context, errors } = await open();
    try {
      for (const t of guidedTemplates()) {
        await page.selectOption('#board-pick', t.id);
        await page.click('#board-open');
        await page.waitForTimeout(300);
        type S = { id: string; type: string; parentId: string; props: Record<string, unknown>; meta: Record<string, unknown> };
        const board = await page.evaluate(() => {
          const e = (window as never as { timmyCanvas: { editor: { getCurrentPage: () => { name: string }; getCurrentPageShapes: () => S[]; getBindingsFromShape: (id: string, t: string) => Array<{ toId: string }>; store: { allRecords: () => Array<{ typeName: string }> } } } }).timmyCanvas.editor;
          const plain = (rich: unknown): string => { const out: string[] = []; const walk = (n: { text?: string; content?: unknown[] } | undefined) => { if (!n) return; if (typeof n.text === 'string') out.push(n.text); for (const c of n.content ?? []) walk(c as never); }; walk(rich as never); return out.join(''); };
          const shapes = e.getCurrentPageShapes();
          const frames = shapes.filter((s) => s.type === 'frame');
          return {
            page: e.getCurrentPage().name,
            types: [...new Set(shapes.map((s) => s.type))].sort(),
            frames: frames.map((f) => ({ name: f.props.name, hints: shapes.filter((s) => s.parentId === f.id).map((s) => ({ type: s.type, text: plain(s.props.richText), part: s.meta.timmyGuide })) })),
            texts: shapes.filter((s) => s.type === 'text' && !frames.some((f) => f.id === s.parentId)).map((s) => plain(s.props.richText)),
            arrows: shapes.filter((s) => s.type === 'arrow').map((a) => e.getBindingsFromShape(a.id, 'arrow').length),
            template: [...new Set(shapes.map((s) => s.meta.timmyTemplate))],
            assets: e.store.allRecords().filter((r) => r.typeName === 'asset').length,
          };
        });
        // (a board opened again gets a number: the keyboard test above opened the first one already)
        expect(board.page, t.id).toMatch(new RegExp(`^${t.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`));
        expect(board.frames, t.id).toEqual(t.frames.map((f) => ({ name: f.name, hints: [{ type: 'text', text: f.guide, part: 'hint' }] })));
        expect(board.texts, t.id).toEqual([t.title, t.intro]);
        expect(board.template, t.id).toEqual([t.id]);
        expect(board.types, t.id).toEqual(t.flow ? ['arrow', 'frame', 'text'] : ['frame', 'text']);
        // the workflow's stages are joined left to right, each arrow bound at both ends
        expect(board.arrows, t.id).toEqual(t.flow ? Array(t.frames.length - 1).fill(2) : []);
        expect(board.assets, t.id).toBe(0);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

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
      // R5 (H133): and the save line
      const els: Array<[string, Element, string?]> = [['status', document.getElementById('status')!], ['save', document.getElementById('save-words')!], ['jobs', document.querySelector('#jobs summary')!], ['done', ok], ['failed', bad], ['link', link],
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
    const exec = async (code: string, jobId: string) => post('/api/canvas/exec', { code, jobId }) as Promise<{ ok: boolean; result: string; error?: string }>;
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
    const exec = async (code: string, jobId: string) => post('/api/canvas/exec', { code, jobId }) as Promise<Answer>;
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
    const saved = await getJson<{ snapshot: { store: Record<string, { typeName: string }> } }>('/api/canvas/document');
    expect(Object.values(saved.snapshot.store).filter((r) => r.typeName === 'shape')).toHaveLength(total);

    // The jobs say what happened: each failed call is marked, and nothing it drew was kept.
    const jobs = await getJson<Array<{ id: string; ok: boolean; failed?: number }>>('/api/canvas/jobs');
    expect(jobs.find((j) => j.id === 'rollback-crash')).toMatchObject({ ok: false, failed: 1 });
    expect(jobs.find((j) => j.id === 'after-restart')).toMatchObject({ ok: true, failed: 0 });
    await context.close();
  }, 120_000);

  // Round R1: the drawing canvas_exec shows the model runs as written in this tldraw: two labeled boxes,
  // a title, and an arrow bound to both boxes.
  it("the example drawing in canvas_exec's description works in this tldraw", async () => {
    const { CANVAS_EXAMPLE } = await import('../src/agent/canvas-tools.js');
    const { page, context } = await open();
    const answer = (await post('/api/canvas/exec', { code: CANVAS_EXAMPLE, jobId: 'example' })) as { ok: boolean; result?: string[]; error?: string; changed?: boolean };
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
    await page.goto(await opened());
    await page.waitForFunction(() => /^Loading the canvas/.test(document.getElementById('status')?.textContent ?? ''));
    expect(await page.getAttribute('#status', 'data-kind')).toBe('loading');
    release();
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    // A bundle built from another tldraw than the one Timmy pins: it says so, and how to rebuild.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.fulfill({ json: { licenseKey: null, tldrawVersion: '9.9.9' } }));
    // R4 (H83): a page loads only with a fresh grant (a reload has none), so each start here is a new /canvas open
    await page.goto('about:blank');
    await page.goto(await opened());
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toBe('The canvas could not start: this canvas was built with tldraw 5.5.2, but Timmy pins 9.9.9. Rebuild it: npm run build:canvas');
    // Timmy not answering at all.
    await page.unroute('**/studio-config.json');
    await page.route('**/studio-config.json', (route) => route.abort());
    await page.goto('about:blank');
    await page.goto(await opened());
    await page.waitForFunction(() => document.getElementById('status')?.dataset.kind === 'error');
    expect(await page.textContent('#status')).toMatch(/^The canvas could not start: /);
    await context.close();
  }, 60_000);
});
