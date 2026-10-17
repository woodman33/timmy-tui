/**
 * R5 (H133): drafts in Timmy Canvas, in a real browser, against the real server and the real bundle (the operator's order of
 * 2026-10-15: "Timmy can propose and arrange board content through its supported AI/backend interface; users can review, accept
 * or discard drafts. Accepting a canvas draft must not secretly execute native edits").
 *
 * What proposes here is the agent's own canvas_exec tool (src/agent/canvas-tools.ts) with the REPL's credentials, sending code
 * this file writes: no model runs, so each draft is a scripted call standing in for one (labelled so in each test's words). The
 * person's own edits are made through the page's editor (page.evaluate), standing in for a hand on the canvas. Skipped, saying
 * so, where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-drafts-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Rec = { id: string; type: string; typeName: string; parentId: string; x: number; y: number; meta: Record<string, unknown>; props: Record<string, unknown> };
type Win = { timmyCanvas: { editor: { getShape: (id: string) => Rec | undefined; getCurrentPageShapes: () => Rec[]; getCurrentPageId: () => string; createShape: (s: unknown) => void; store: { allRecords: () => Rec[] } }; drafts: () => Array<{ id: string; shapes: string[] }> } };
type Answer = { ok: boolean; result?: unknown; error?: string; jobId?: string; revision?: number; changed?: boolean; rolledBack?: boolean; stale?: boolean; draft?: { id: string; shapes?: number; from?: number; refused?: string; now?: number } };

describe.skipIf(!browserPath)('drafts in Timmy Canvas, in a real browser', () => {
  let root = '';
  let home = '';
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  const port = (): number => (server!.address() as AddressInfo).port;
  const getJson = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`, { headers: bearer(server!.projectToken) })).json() as Promise<T>;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'timmy-drafts-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-drafts-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(root, 'dist'), { licenses: root });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root });
    base = `http://127.0.0.1:${port()}`;
    mkdirSync(join(home, 'project'));
    await nameProject(port(), server.projectToken, { root: join(home, 'project'), name: 'drafts-browser' });
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function open(size = { width: 1280, height: 800 }): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser!.newContext({ viewport: size });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  /** The agent's own canvas tools, with the REPL's credentials (the project is named without a holder here). */
  const agent = () => {
    const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server!.projectToken, holder: null }) });
    return (name: string, args: Record<string, unknown>) => (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown) => Promise<Answer>)(args);
  };
  const shapes = (page: Page) => page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageShapes());
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  const twoBoxes = "const { createShapeId, toRichText } = helpers; const a = createShapeId(), b = createShapeId(); editor.createShapes([{ id: a, type: 'geo', x: 460, y: 220, props: { w: 160, h: 80, richText: toRichText('Proposed') } }, { id: b, type: 'geo', x: 700, y: 220, props: { w: 160, h: 80, richText: toRichText('Also proposed') } }]); return [a, b];";

  it('a draft from the agent\'s canvas_exec (a scripted call, no model) waits on the board, outlined in amber and labelled, listed with Show, Accept and Discard; Accept from the keyboard keeps its shapes, clears the mark, saves and records it, and runs nothing', async () => {
    const { page, context, errors } = await open();
    try {
      const run = agent();
      const drawn = await run('canvas_exec', { code: twoBoxes, jobId: 'draft-accept' });
      expect(drawn).toMatchObject({ ok: true, changed: true, jobId: 'draft-accept', draft: { id: expect.stringMatching(/^draft-[0-9a-f]{12}$/), shapes: 2 } });
      const id = drawn.draft!.id;
      const [a, b] = drawn.result as string[];
      // on the board: marked, outlined, labelled; in the panel: one row with its words and three buttons
      expect((await page.evaluate((s) => (window as never as Win).timmyCanvas.editor.getShape(s)!.meta, a)).timmyDraft).toMatchObject({ id, job: 'draft-accept' });
      await page.waitForSelector(`.timmy-draft-mark[data-draft="${id}"]`);
      const look = await page.$eval(`.timmy-draft-mark[data-draft="${id}"]`, (el) => { const s = getComputedStyle(el); const l = el.querySelector('.timmy-draft-label')!; return { style: s.borderTopStyle, color: s.borderTopColor, label: l.textContent, labelColor: getComputedStyle(l).color, events: s.pointerEvents }; });
      // R7 (H151; one amber next step: the strip's primary and the draft's Accept): the outline is silver, as what a model made is
      // (B10, B4), and its label says so in words
      expect(look).toEqual({ style: 'dashed', color: 'rgb(232, 228, 217)', label: 'DRAFT · proposed by Timmy', labelColor: 'rgb(232, 228, 217)', events: 'none' });
      await page.waitForSelector('#drafts:not([hidden])');
      expect(await page.textContent(`#draft-list li[data-draft="${id}"] .draft-line`)).toMatch(/^DRAFT · proposed by Timmy · 2 shapes · job draft-accept · from revision \d+$/);
      expect(await page.locator(`#draft-list li[data-draft="${id}"] button`).allTextContents()).toEqual(['Show', 'Accept', 'Discard']);
      // R5 (H137; QA defect 13): one amber next step on screen (B10): no fill of the page's own is amber (tldraw's own chrome, its
      // selected tool, is tldraw's selection), New board's Open is outlined, and the drafts' heading is off-white. R6 (H139): the
      // strip reads its frame once the board's project is known (the board is loaded), so it is drawn a moment later than the board:
      // counted once it is drawn. R7 (H151; the operator: "Make Studio's primary action reflect the actual next step when a draft is
      // waiting"): the frame's one primary is now the draft's Accept or Discard, and the draft's Accept is that same step: it is
      // outlined in amber (never filled), its Discard neutral (tests/studio-draft-step-browser.test.ts counts every amber element)
      await page.waitForFunction(() => document.querySelector('#frame-acts li.is-primary .fr-label')?.textContent === 'Accept or discard the draft Timmy proposed', null, { timeout: 15_000 });
      const amber = await page.evaluate(() => {
        const AMBER = 'rgb(255, 176, 0)';
        const fills = [...document.querySelectorAll('body *')].filter((e) => !e.closest('.tlui-layout') && getComputedStyle(e).backgroundColor === AMBER)
          .map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof (e as HTMLElement).className === 'string' && (e as HTMLElement).className ? `.${(e as HTMLElement).className}` : ''}`);
        const accept = getComputedStyle(document.querySelector('#draft-list button.draft-accept')!);
        const discard = getComputedStyle(document.querySelector('#draft-list button.draft-discard')!);
        return { fills, accept: [accept.backgroundColor, accept.borderTopColor, accept.color], discard: [discard.borderTopColor, discard.color], open: getComputedStyle(document.getElementById('board-open')!).backgroundColor, heading: getComputedStyle(document.querySelector('#drafts h2')!).color, primaries: document.querySelectorAll('#frame-acts li.is-primary').length };
      });
      expect(amber.fills).toEqual([]);
      expect(amber.accept[0]).not.toBe('rgb(255, 176, 0)');
      expect(amber.accept.slice(1)).toEqual(['rgb(255, 176, 0)', 'rgb(255, 176, 0)']);
      expect([...amber.discard, amber.open, amber.heading]).not.toContain('rgb(255, 176, 0)');
      expect(amber.primaries).toBe(1);
      // the mark covers both shapes on screen (R5 H133: on the page, as the mark's box is measured: the canvas starts under the
      // workspace strip now, so tldraw's viewport is no longer the page's origin)
      // R6 lead (H145 after merging r6/review-build: 4/5, 4/5, 5/5): the strip above the canvas can redraw a moment later (its
      // waiting count, its activity line) and move the canvas; the mark follows at the page's next rendering step. Read as a
      // person sees it, once the page has settled: both shapes inside the mark within 5 s, each read in the same frame as the
      // mark (a mark that never followed still fails here)
      const inside = async (): Promise<string[]> => page.evaluate(({ draft, shapes }) => {
        const mark = document.querySelector(`.timmy-draft-mark[data-draft="${draft}"]`)!.getBoundingClientRect();
        const e = (window as never as { timmyCanvas: { editor: { getShapePageBounds: (i: string) => { minX: number; minY: number; maxX: number; maxY: number }; pageToScreen: (p: { x: number; y: number }) => { x: number; y: number } } } }).timmyCanvas.editor;
        return shapes.map((x) => {
          const r = e.getShapePageBounds(x); const p = e.pageToScreen({ x: r.minX, y: r.minY }); const q = e.pageToScreen({ x: r.maxX, y: r.maxY });
          return p.x >= mark.left && p.y >= mark.top && q.x <= mark.right && q.y <= mark.bottom ? `${x} inside` : `${x} outside (${Math.round(p.x)},${Math.round(p.y)})-(${Math.round(q.x)},${Math.round(q.y)}) vs (${Math.round(mark.left)},${Math.round(mark.top)})-(${Math.round(mark.right)},${Math.round(mark.bottom)})`;
        });
      }, { draft: id, shapes: [a, b] });
      await expect.poll(inside, { timeout: 5_000, message: 'both shapes inside the mark on screen' }).toEqual([`${a} inside`, `${b} inside`]);
      const jobsBefore = (await getJson<Array<{ id: string }>>('/api/canvas/jobs')).map((j) => j.id);
      // keyboard: Show, then Tab to Accept, its focus amber and visible; Enter accepts
      await page.focus(`#draft-list li[data-draft="${id}"] .draft-show`);
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => { const el = document.activeElement as HTMLElement; const s = getComputedStyle(el); return { text: el.textContent, outline: `${s.outlineStyle} ${s.outlineColor}`, visible: el.matches(':focus-visible') }; });
      expect(focus).toEqual({ text: 'Accept', outline: 'solid rgb(255, 176, 0)', visible: true });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /^Accepted Timmy's draft \(2 shapes, job draft-accept\): kept on the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      await savedState(page);
      // the shapes stay, unmarked, saying who proposed them; the outline and the row are gone
      for (const s of [a, b]) {
        const meta = await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.meta, s);
        expect(meta.timmyDraft, s).toBeUndefined();
        expect(meta.timmyProposed).toMatchObject({ by: 'Timmy', draft: id, job: 'draft-accept', accepted: expect.any(String) });
      }
      expect(await page.locator('.timmy-draft-mark').count()).toBe(0);
      expect(await page.isHidden('#drafts')).toBe(true);
      // the saved canvas holds them unmarked, and the record holds the proposal and the decision, with the save that holds it
      const doc = await getJson<{ revision: number; sourceRevision: string; snapshot: { store: Record<string, Rec> } }>('/api/canvas/document');
      expect(doc.snapshot.store[a].meta.timmyDraft).toBeUndefined();
      expect(doc.snapshot.store[b].meta.timmyProposed).toMatchObject({ draft: id });
      const record = (await getJson<{ drafts: Array<Record<string, unknown>> }>('/api/canvas/drafts')).drafts.filter((r) => r.draft === id);
      expect(record.map((r) => r.event)).toEqual(['proposed', 'accepted']);
      expect(record[1]).toMatchObject({ by: 'page', proposed: true, shapes: 2, job: 'draft-accept' });
      expect(record[1].revision).toBeLessThanOrEqual(doc.revision);
      // nothing ran: no job and no call came from the decision
      expect((await getJson<Array<{ id: string }>>('/api/canvas/jobs')).map((j) => j.id)).toEqual(jobsBefore);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('Discard removes the draft\'s shapes and nothing of the person\'s, saves and records it', async () => {
    const { page, context } = await open();
    try {
      const run = agent();
      const framed = "const { createShapeId, toRichText } = helpers; const f = createShapeId(), c = createShapeId(); editor.createShape({ id: f, type: 'frame', x: 500, y: 160, props: { name: 'Proposed frame', w: 320, h: 220 } }); editor.createShape({ id: c, type: 'geo', parentId: f, x: 20, y: 40, props: { w: 120, h: 60, richText: toRichText('inside') } }); return [f, c];";
      const drawn = await run('canvas_exec', { code: framed, jobId: 'draft-discard' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 2 } });
      const [frame, child] = drawn.result as string[];
      // the person puts a shape of their own inside the proposed frame (not a call: never marked)
      const mine = await page.evaluate((f) => { const e = (window as never as Win).timmyCanvas.editor; const id = `shape:mine-${Date.now()}`; e.createShape({ id, type: 'geo', parentId: f, x: 180, y: 120, props: { w: 60, h: 40 } }); return id; }, frame);
      expect((await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.meta, mine)).timmyDraft).toBeUndefined();
      await page.click(`#draft-list li[data-draft="${drawn.draft!.id}"] .draft-discard`);
      await page.waitForFunction(() => /^Discarded Timmy's draft \(2 shapes, job draft-discard\): removed from the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      await savedState(page);
      const left = await page.evaluate((ids) => ids.map((x) => { const s = (window as never as Win).timmyCanvas.editor.getShape(x); return s ? { id: s.id, parent: s.parentId } : null; }), [frame, child, mine]);
      expect(left[0]).toBeNull();
      expect(left[1]).toBeNull();
      expect(left[2]).toEqual({ id: mine, parent: await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getCurrentPageId()) });
      const doc = await getJson<{ snapshot: { store: Record<string, Rec> } }>('/api/canvas/document');
      expect(doc.snapshot.store[frame]).toBeUndefined();
      expect(doc.snapshot.store[mine]).toBeDefined();
      const record = (await getJson<{ drafts: Array<Record<string, unknown>> }>('/api/canvas/drafts')).drafts.filter((r) => r.draft === drawn.draft!.id);
      expect(record.map((r) => r.event)).toEqual(['proposed', 'discarded']);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a draft made from a revision the canvas has left is refused before it runs, and one that changes the board\'s own shapes keeps nothing; each says why', async () => {
    const { page, context } = await open();
    try {
      const run = agent();
      // the scripted agent reads the board (the answer names its revision), then the person changes it
      const read = await run('canvas_read', {});
      expect(read.ok).toBe(true);
      const mine = await page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; const id = `shape:own-${Date.now()}`; e.createShape({ id, type: 'geo', x: 300, y: 500, props: { w: 80, h: 50 } }); return id; });
      const before = (await shapes(page)).length;
      const stale = await run('canvas_exec', { code: twoBoxes, jobId: 'draft-stale' });
      expect(stale).toMatchObject({ ok: false, stale: true, changed: false, draft: { refused: 'stale', from: read.revision } });
      expect(stale.error).toMatch(new RegExp(`^Refused: this draft was made from revision ${read.revision}, but the canvas is at revision \\d+ now: it changed after Timmy read it\\. Nothing was drawn\\.`));
      expect((await shapes(page)).length).toBe(before);
      // read again: now a draft that moves the person's shape is refused after it ran, and undone
      expect((await run('canvas_read', {})).ok).toBe(true);
      const at = await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.x, mine);
      const moves = await run('canvas_exec', { code: `editor.updateShape({ id: ${JSON.stringify(mine)}, type: 'geo', x: 900 }); editor.createShape({ type: 'geo', x: 10, y: 10, props: { w: 10, h: 10 } }); return 1;`, jobId: 'draft-moves' });
      expect(moves).toMatchObject({ ok: false, rolledBack: true, changed: false, draft: { refused: 'changes' } });
      expect(moves.error).toMatch(/^Refused: a draft only adds to the board, and it changed or removed 1 record already on the board \(shape:own-\d+\)\. Nothing was kept\./);
      expect(await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.x, mine)).toBe(at);
      expect((await shapes(page)).length).toBe(before);
      // both refusals are in the record, with why
      const record = (await getJson<{ drafts: Array<Record<string, unknown>> }>('/api/canvas/drafts')).drafts;
      expect(record.filter((r) => r.job === 'draft-stale' || r.job === 'draft-moves').map((r) => [r.event, r.reason])).toEqual([['refused', 'stale'], ['refused', 'changes']]);
      // and the same change, sent as a direct call (draft: false, which the REPL asks the person about first), is made
      const direct = await run('canvas_exec', { code: `editor.updateShape({ id: ${JSON.stringify(mine)}, type: 'geo', x: 900 }); return 1;`, jobId: 'direct-move', draft: false });
      expect(direct).toMatchObject({ ok: true, changed: true });
      expect(direct.draft).toBeUndefined();
      expect(await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.x, mine)).toBe(900);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('code on the page cannot get round the review: a draft call that strips its own mark still leaves a draft, and a script\'s click on Accept decides nothing; a person\'s click does', async () => {
    const { page, context } = await open();
    try {
      const run = agent();
      expect((await run('canvas_read', {})).ok).toBe(true);
      const sneaky = "const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 520, y: 420, props: { w: 100, h: 50 } }); const s = editor.getShape(id); editor.store.put([{ ...s, meta: {} }]); return id;";
      const drawn = await run('canvas_exec', { code: sneaky, jobId: 'draft-sneaky' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 1 } });
      expect((await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.meta, drawn.result as string)).timmyDraft).toMatchObject({ id: drawn.draft!.id });
      const row = `#draft-list li[data-draft="${drawn.draft!.id}"]`;
      await page.waitForSelector(row);
      // a script's click (as the agent's next call could make) is not the person's
      await page.evaluate((r) => (document.querySelector(`${r} .draft-accept`) as HTMLButtonElement).click(), row);
      const own = await run('canvas_exec', { code: `document.querySelector(${JSON.stringify(`${row} .draft-accept`)}).click(); return 1;`, jobId: 'draft-self-accept', draft: false });
      expect(own.ok).toBe(true);
      await page.waitForTimeout(500);
      expect((await page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.meta, drawn.result as string)).timmyDraft).toBeDefined();
      expect((await getJson<{ drafts: Array<Record<string, unknown>> }>('/api/canvas/drafts')).drafts.filter((r) => r.draft === drawn.draft!.id).map((r) => r.event)).toEqual(['proposed']);
      // the person's click accepts
      await page.click(`${row} .draft-accept`);
      await page.waitForFunction((x) => !(window as never as Win).timmyCanvas.editor.getShape(x)!.meta.timmyDraft, drawn.result as string, { timeout: 10_000 });
    } finally {
      await context.close();
    }
  }, 120_000);

  it('a pending draft survives a reopen: it is saved with its mark, and a new page lists it again', async () => {
    const first = await open();
    let id = '';
    try {
      const drawn = await agent()('canvas_exec', { code: twoBoxes, jobId: 'draft-reopen' });
      expect(drawn.ok).toBe(true);
      id = drawn.draft!.id;
      await savedState(first.page);
    } finally {
      await first.context.close();
    }
    const again = await open({ width: 390, height: 844 });
    try {
      await again.page.waitForSelector(`#draft-list li[data-draft="${id}"]`, { state: 'attached', timeout: 10_000 });
      expect(await again.page.evaluate(() => (window as never as Win).timmyCanvas.drafts().map((d) => d.shapes.length))).toContain(2);
      // at phone width the panel's Drafts and its buttons are on screen and clear of tldraw's toolbar
      const row = (await again.page.locator(`#draft-list li[data-draft="${id}"] .draft-accept`).boundingBox())!;
      const toolbar = await again.page.locator('.tlui-main-toolbar').boundingBox();
      expect(row.x >= 0 && row.x + row.width <= 390 && row.y >= 0 && row.y + row.height <= 844).toBe(true);
      if (toolbar) expect(row.y + row.height <= toolbar.y || row.y >= toolbar.y + toolbar.height || row.x + row.width <= toolbar.x).toBe(true);
    } finally {
      await again.context.close();
    }
  }, 120_000);
});
