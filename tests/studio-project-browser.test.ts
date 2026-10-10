/**
 * Round R4 (H55): Timmy Canvas's Project panel in a real headless Chromium, against the real server, the real bundle (built
 * here into a temporary folder, as tests/studio-canvas-browser.test.ts builds it) and a real temporary project with real
 * record files (tests/helpers/canvas-project.ts). The project is named the way the REPL names it (POST /api/project/active
 * with the server's token); /board live's address and token come from a real LiveBoard. Every request the page makes goes
 * to 127.0.0.1 (anything else is aborted). Skipped, saying so, where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { LiveBoard } from '../src/repl/board-live.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { flowRecord, HOSTILE_TITLE, makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-project-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Meta = Record<string, unknown>;
type Placed = { id: string; lines: string[]; meta: Meta };

describe.skipIf(!browserPath)('Timmy Canvas: the Project panel in a real browser', () => {
  let p: CanvasProject;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let board: LiveBoard;
  let browser: Browser;
  let base = '';

  const name = (extra: Record<string, unknown> = {}) => fetch(`${base}/api/project/active`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` },
    body: JSON.stringify({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store, ...extra }),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const flowReceipt = (): string => readFileSync(join(p.store, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; hash: string }).find((r) => r.kind === 'flow')!.hash.slice(7, 15);

  beforeAll(async () => {
    p = await makeCanvasProject('studio-project-browser-');
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-canvas-project-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-canvas-project-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A real live board: its address may be named to the canvas, its token never.
    board = new LiveBoard({ state: () => ({ project: 'demo', madeAt: '', toc: '', html: '', shape: '', jobs: [], workflows: [], files: [] }), execute: async () => [] });
    await board.start();
    expect(await name({ board: board.address })).toEqual({ ok: true, project: { name: 'demo', id: p.pid }, board: true });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await board?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  async function open(size = { width: 1280, height: 800 }): Promise<{ page: Page; context: BrowserContext; origins: Set<string>; errors: string[] }> {
    const context = await browser.newContext({ viewport: size });
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
    await page.goto(`${base}/`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
    return { page, context, origins, errors };
  }
  /** Every placed project card on the canvas: its shape, its text as lines, and its meta. */
  const placed = (page: Page): Promise<Placed[]> => page.evaluate(() => {
    const e = (window as never as { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string; id: string; props: { richText?: { content?: Array<{ content?: Array<{ text?: string }> }> } }; meta: Record<string, unknown> }> } } } }).timmyCanvas.editor;
    return e.store.allRecords().filter((r) => r.typeName === 'shape' && r.meta?.timmyProjectCard).map((r) => ({
      id: r.id, lines: (r.props.richText?.content ?? []).map((para) => (para.content ?? []).map((t) => t.text ?? '').join('')), meta: r.meta.timmyProjectCard as Record<string, unknown>,
    }));
  });
  const placedCard = async (page: Page, card: string): Promise<Placed> => {
    await page.waitForFunction((c) => (window as never as { timmyCanvas: { editor: { store: { allRecords: () => Array<{ typeName: string; meta?: { timmyProjectCard?: { card?: string } } }> } } } }).timmyCanvas.editor.store.allRecords()
      .some((r) => r.typeName === 'shape' && r.meta?.timmyProjectCard?.card === c), card, { timeout: 10_000 });
    return (await placed(page)).filter((x) => x.meta.card === card).at(-1)!;
  };
  const refreshPlaced = async (page: Page, expect: RegExp): Promise<string> => {
    // The last message is cleared first, so the wait reads this refresh's answer.
    await page.evaluate(() => { document.getElementById('project-said')!.textContent = ''; });
    await page.click('#project-refresh');
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('project-said')?.textContent ?? ''), expect.source, { timeout: 10_000 });
    return (await page.textContent('#project-said')) ?? '';
  };

  it("lists the named project's cards in groups, every text as text (a hostile title stays text), with Open on the board while /board live runs", async () => {
    const { page, context, origins, errors } = await open();
    try {
      expect(await page.textContent('#project-name')).toBe('demo');
      const rows = await page.$$eval('#project-groups li.pcard', (lis) => lis.map((li) => ({
        card: (li as HTMLElement).dataset.card, title: li.querySelector('.pcard-title')?.textContent, state: li.querySelector('.pcard-state')?.textContent,
        command: li.querySelector('.pcard-cmd')?.textContent, board: li.querySelector('a.pcard-board')?.getAttribute('href') ?? null,
        rel: li.querySelector('a.pcard-board')?.getAttribute('rel') ?? null,
      })));
      const by = Object.fromEntries(rows.map((r) => [r.card, r]));
      expect(Object.keys(by)).toEqual(expect.arrayContaining(['workflow:BUILD.md', 'params:recipes/tray.params.json', 'params:box.params.json', `flow:${p.flow}`, `vox:${p.voxId}`, 'unreadable:results/flows/f0badbad0.json']));
      expect(by['workflow:BUILD.md']).toMatchObject({ title: HOSTILE_TITLE, state: 'not run yet · 2 blocks: build, render', command: '/run BUILD.md render', board: `${board.address}#workflows`, rel: 'noopener noreferrer' });
      expect(by[`flow:${p.flow}`]).toMatchObject({ board: `${board.address}#flows`, command: `/room ${p.flow}` });
      expect(by['unreadable:results/flows/f0badbad0.json'].state).toMatch(/^unreadable: not JSON/);
      // The groups, in order: the editable artifacts first, then the Control Room's runs, then what cannot be read.
      expect(await page.$$eval('#project-groups .pgroup', (s) => s.map((x) => (x as HTMLElement).dataset.kind))).toEqual(['workflow', 'params', 'flow', 'vox', 'run', 'unreadable']);
      // The hostile text made no element and ran nothing; the token is nowhere in the page.
      expect(await page.locator('#project img').count()).toBe(0);
      expect(await page.evaluate(() => (window as never as { __xss?: unknown }).__xss)).toBeUndefined();
      expect(await page.content()).not.toContain(board.token);
      expect([...origins]).toEqual([base]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('from the keyboard: the panel folds and opens, and Enter on Place on canvas makes one note holding the card, its record and receipt in its meta', async () => {
    const { page, context } = await open();
    try {
      await page.focus('#project > summary');
      await page.keyboard.press('Enter');
      expect(await page.$eval('#project', (d) => (d as HTMLDetailsElement).open)).toBe(false);
      await page.keyboard.press('Enter');
      expect(await page.$eval('#project', (d) => (d as HTMLDetailsElement).open)).toBe(true);
      // Tab to the first card's Place on canvas (the workflow document's: the first group).
      for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement?.classList.contains('pcard-place'))); i++) await page.keyboard.press('Tab');
      expect(await page.evaluate(() => (document.activeElement?.closest('li') as HTMLElement | null)?.dataset.card)).toBe('workflow:BUILD.md');
      const before = (await placed(page)).length;
      await page.keyboard.press('Enter');
      const note = await placedCard(page, 'workflow:BUILD.md');
      expect((await placed(page)).length).toBe(before + 1);
      expect(note.lines).toEqual([HOSTILE_TITLE, 'not run yet · 2 blocks: build, render', '/run BUILD.md render']);
      expect(note.meta).toMatchObject({ v: 1, card: 'workflow:BUILD.md', kind: 'workflow', project: 'demo', projectId: p.pid, record: 'BUILD.md', receipt: null, command: '/run BUILD.md render', section: 'workflows' });
      expect(await page.evaluate((id) => (window as never as { timmyCanvas: { editor: { getShape: (i: string) => { type: string } } } }).timmyCanvas.editor.getShape(id).type, note.id)).toBe('note');
      // Drawn by tldraw as text: still no element from the hostile title, nothing ran.
      await page.waitForTimeout(300);
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      expect(await page.evaluate(() => (window as never as { __xss?: unknown }).__xss)).toBeUndefined();
      expect(await page.textContent('#project-said')).toBe(`Placed: ${HOSTILE_TITLE}`);
    } finally {
      await context.close();
    }
  }, 90_000);

  it("is saved by Timmy with the card's record and receipt, and never the board's token or address", async () => {
    const { page, context } = await open();
    try {
      await page.click(`#project-groups li.pcard[data-card="flow:${p.flow}"] .pcard-place`);
      const note = await placedCard(page, `flow:${p.flow}`);
      expect(note.meta).toMatchObject({ card: `flow:${p.flow}`, record: p.flowFile, receipt: flowReceipt(), section: 'flows' });
      expect(Object.keys(note.meta).sort()).toEqual(['card', 'command', 'kind', 'placedAt', 'project', 'projectId', 'receipt', 'record', 'section', 'state', 'title', 'v']);
      let saved = '';
      for (let i = 0; i < 40 && !saved.includes(note.id); i++) {
        await new Promise((r) => setTimeout(r, 150));
        saved = await (await fetch(`${base}/api/canvas/document`)).text();
      }
      expect(saved).toContain(note.id);
      expect(saved).toContain(p.flowFile);
      expect(saved).not.toContain(board.token);
      expect(saved).not.toContain(board.address);
      expect(readFileSync(join(home, 'canvas', 'canvas.json'), 'utf8')).not.toContain(board.token);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('a placed card is refreshed from its record: its state changed gives new text, its record gone says so, and back again', async () => {
    const { page, context } = await open();
    const file = join(p.root, p.flowFile);
    const original = readFileSync(file, 'utf8');
    try {
      await page.click(`#project-groups li.pcard[data-card="flow:${p.flow}"] .pcard-place`);
      const first = await placedCard(page, `flow:${p.flow}`);
      expect(first.lines[1]).toBe(`succeeded, readback matches · verified: receipt ${flowReceipt()} sealed these bytes`);
      // The record changed after its receipt: the card says so, and no longer claims the receipt.
      writeFileSync(file, flowRecord(p.flow, 'failed'));
      expect(await refreshPlaced(page, /\d+ changed/)).toMatch(/^\d+ placed cards checked: \d+ changed, \d+ unchanged\.$/);
      let now = (await placed(page)).find((x) => x.id === first.id)!;
      expect(now.lines[1]).toBe('failed, readback differs (as the file says) · not verified: the file changed after it was sealed: its sha256 is not the one its flow receipt sealed');
      expect(now.meta).toMatchObject({ receipt: null, state: now.lines[1], placedAt: first.meta.placedAt });
      expect(typeof now.meta.refreshedAt).toBe('string');
      // The record gone: the card says so, naming it, and keeps its command.
      unlinkSync(file);
      expect(await refreshPlaced(page, /record(s)? gone/)).toMatch(/\d+ records? gone/);
      now = (await placed(page)).find((x) => x.id === first.id)!;
      expect(now.lines[0]).toBe(first.lines[0]);
      expect(now.lines[1]).toMatch(new RegExp(`^record gone: its record ${p.flowFile.replace(/[.]/g, '\\.')} is not in demo now \\(checked \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\)$`));
      expect(now.lines[2]).toBe(`/room ${p.flow}`);
      expect(now.meta).toMatchObject({ gone: true });
      // A second refresh changes nothing more (no new revision for a card already said gone).
      const rev = await page.evaluate(() => (window as never as { timmyCanvas: { document: { revision: number } } }).timmyCanvas.document.revision);
      expect(await refreshPlaced(page, /checked/)).not.toMatch(/\d+ changed|gone/);
      expect(await page.evaluate(() => (window as never as { timmyCanvas: { document: { revision: number } } }).timmyCanvas.document.revision)).toBe(rev);
      // Back as sealed: verified again.
      writeFileSync(file, original);
      await refreshPlaced(page, /\d+ changed/);
      now = (await placed(page)).find((x) => x.id === first.id)!;
      expect(now.lines[1]).toBe(first.lines[1]);
      expect(now.meta.gone).toBeUndefined();
    } finally {
      writeFileSync(file, original);
      await context.close();
    }
  }, 120_000);

  it('the agent tool canvas_place_project_card lists the cards, places one through the page, and its card id reaches the page only as a JSON string', async () => {
    const { page, context } = await open();
    try {
      const tools = createCanvasTools({ baseUrl: base });
      const tool = tools.find((t) => (t as { function: { name: string } }).function.name === 'canvas_place_project_card') as unknown as { function: { execute: (a: unknown) => Promise<Record<string, unknown>> } };
      const listed = await tool.function.execute({});
      expect(listed).toMatchObject({ ok: true, changed: false, result: { project: 'demo' } });
      expect((listed.result as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toContain(`vox:${p.voxId}`);
      const put = await tool.function.execute({ card: `vox:${p.voxId}` });
      expect(put).toMatchObject({ ok: true, changed: true, result: { placed: true, project: 'demo', card: { id: `vox:${p.voxId}`, record: p.voxFile } } });
      const note = await placedCard(page, `vox:${p.voxId}`);
      expect(note.id).toBe((put.result as { shape: string }).shape);
      expect(note.meta).toMatchObject({ record: p.voxFile, highlights: [`results/vox/${p.voxId}/bbox.svg`], section: 'voxvision' });
      expect(note.lines[2]).toBe('/measure part.stl');
      // A hostile id: no card by that name, nothing drawn, nothing run.
      const before = (await placed(page)).length;
      const hostile = await tool.function.execute({ card: '"); window.__xss = 3; ("' });
      expect(hostile.ok).toBe(false);
      expect(String(hostile.error)).toMatch(/^Error: No card "\\"\); window.__xss = 3; \(\\"" in demo now\. Its cards: /);
      expect((await placed(page)).length).toBe(before);
      expect(await page.evaluate(() => (window as never as { __xss?: unknown }).__xss)).toBeUndefined();
    } finally {
      await context.close();
    }
  }, 90_000);

  it('without /board live there is no Open on the board link', async () => {
    expect((await name()).board).toBe(false);
    const { page, context } = await open();
    try {
      expect(await page.locator('#project-groups a.pcard-board').count()).toBe(0);
      expect(await page.locator('#project-groups .pcard-place').count()).toBeGreaterThan(5);
    } finally {
      await context.close();
      await name({ board: board.address });
    }
  }, 60_000);
});
