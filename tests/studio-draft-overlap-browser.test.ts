/**
 * R8 (H158; open item J, the operator's decision of 2026-10-18, 01:15 PT: "Say so, offer to move it"): a model's draft that lands
 * on shapes already on the board, in a real headless Chromium against the real canvas server and the real bundle (built here).
 * In the R7 rehearsal two FAKE drafts used the same coordinates: the second lay over the first, accepted one, and nothing said so.
 *
 * Checked, by reading the page and the disk: Studio names the overlap where the draft is shown (its card in the drafts list and
 * its label on the board), with the count of the board's shapes it lands on, and one neutral button beside the words, Move it to
 * free space; pressed, it moves the draft's shapes together, as they are arranged, to the nearest place where they cover no shape
 * (the placement rule of companion/studio-canvas/src/placement.js, worked out here again from the page's own bounds), and the
 * words say it was moved and from where; the draft stays a draft and Accept works; one undo puts it back; it is saved to the
 * shown project's board only (the other project's board files byte-identical); while Studio switches projects the button is off,
 * says why, and nothing moves on either board. Nothing moves by itself, and a draft that lands on nothing says nothing of it.
 *
 * FAKE, said where used: the drafts are the agent's own canvas_exec tool (src/agent/canvas-tools.ts) with one REPL's credentials,
 * sending code this file writes (a scripted call standing in for a model; no model runs); the person's shapes are drawn through
 * the page's own editor, standing in for a hand on the canvas, and the undo is tldraw's own (editor.undo, what its Undo and Ctrl+Z
 * call); the projects, tray and blank, are empty folders made here; the pending switch is said through the server's own call
 * (StudioServer.switchPending, what its follower calls). Skipped, saying so, where no Chromium or Chrome is found.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nearestSpot } from '../companion/studio-canvas/src/placement.js';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { projectId } from '../src/project/index.js';
import { boardDir } from '../src/studio/boards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-draft-overlap-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const AMBER = 'rgb(255, 176, 0)';
/** The REPL these tests stand in for: its holder id (as /canvas open names it), so its page's session counts for both projects. */
const HOLDER = 'c'.repeat(32);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type B = { minX: number; minY: number; maxX: number; maxY: number };
type Rec = { id: string; type: string; x: number; y: number; parentId: string; meta: Record<string, unknown> };
type Answer = { ok: boolean; result?: unknown; error?: string; draft?: { id: string; shapes?: number } };
type Win = { timmyCanvas: {
  editor: { getShape: (id: string) => Rec | undefined; getShapePageBounds: (id: string) => B; createShapes: (s: unknown[]) => void; undo: () => void; getInstanceState: () => { isReadonly: boolean } };
  identity: { state: string; project: { name: string } | null };
  drafts: () => Array<{ id: string; shapes: string[] }>;
} };
/** A FAKE draft: boxes as a model's canvas_exec code would draw them, each at its x and y, w x h, with its words. */
const boxes = (list: Array<{ x: number; y: number; w: number; h: number; text: string }>) => `const { createShapeId, toRichText } = helpers; const ids = ${JSON.stringify(list)}.map(() => createShapeId()); editor.createShapes(${JSON.stringify(list)}.map((b, i) => ({ id: ids[i], type: 'geo', x: b.x, y: b.y, props: { w: b.w, h: b.h, richText: toRichText(b.text) } }))); return ids;`;
const strict = (a: B, b: B): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
/** A screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind otherwise); it says on
 *  itself that what it shows is FAKE test data. */
async function shoot(page: Page, name: string): Promise<void> {
  const shots = process.env.TIMMY_CANVAS_SHOTS;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.id = 'fake-shot-label';
    label.textContent = 'FAKE test data (scripted drafts and FAKE projects written by the test), not a real project';
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

describe.skipIf(!browserPath)('a draft that lands on shapes already on the board: Studio says so and offers to move it (R8 H158)', () => {
  let pageRoot = '';
  let home = '';
  let tray = '';
  let blank = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  let port = 0;

  beforeAll(async () => {
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-overlap-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-overlap-home-'));
    tray = join(home, 'tray');
    blank = join(home, 'blank');
    mkdirSync(tray);
    mkdirSync(blank);
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // the page's workspace strip reads Timmy's settings: this file's own folder (tests/isolation-setup.ts), never the account's
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** The REPL's /project: it names `root` to the canvas, with its holder id. */
  const name = (root: string) => nameProject(port, server.projectToken, { root, name: root === tray ? 'tray' : 'blank', holder: HOLDER });
  /** Every file of a project's board, with its sha256 ({} before it has any). */
  const dirOf = (root: string): string => boardDir(join(home, 'canvas'), projectId(root));
  function files(root: string): Record<string, string> {
    const dir = dirOf(root);
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names.sort()) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else out[relative(dir, f)] = sha(readFileSync(f)); }
    };
    walk(dir);
    return out;
  }
  /** Where shapes `ids` are in tray's board on disk ({ x, y } each, null for one not there). */
  const onDisk = (ids: string[]): Array<{ x: number; y: number } | null> => {
    const store = (JSON.parse(readFileSync(join(dirOf(tray), 'canvas.json'), 'utf8')) as { snapshot: { store: Record<string, Rec> } }).snapshot.store;
    return ids.map((i) => (store[i] ? { x: store[i].x, y: store[i].y } : null));
  };
  /** The agent's own canvas tools, a fresh set for each call (so no call is made from a revision the person has moved on from). */
  const agent = (root: string) => {
    const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server.projectToken, holder: HOLDER, project: projectId(root) }) });
    return (tool: string, args: Record<string, unknown>) => (tools.find((t) => t.function.name === tool)!.function.execute as (a: unknown) => Promise<Answer>)(args);
  };
  async function open(): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port, server.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    return { page, context, errors };
  }
  const shows = (page: Page, project: string) => page.waitForFunction((n) => { const t = (window as never as Win).timmyCanvas; return t?.identity.state === 'shown' && t.identity.project?.name === n && !t.editor.getInstanceState().isReadonly; }, project, { timeout: 20_000 });
  const savedState = (page: Page) => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 15_000 });
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** Shapes drawn by a person's hand (the page's own editor, as tldraw's tools make them). */
  const draw = (page: Page, list: Array<{ id: string; x: number; y: number; w: number; h: number }>) => page.evaluate((l) => {
    (window as never as Win).timmyCanvas.editor.createShapes(l.map((s) => ({ id: s.id, type: 'geo', x: s.x, y: s.y, props: { w: s.w, h: s.h } })));
  }, list);
  const where = (page: Page, ids: string[]) => page.evaluate((l) => l.map((i) => { const s = (window as never as Win).timmyCanvas.editor.getShape(i)!; return { x: s.x, y: s.y }; }), ids);
  const boundsOf = (page: Page, ids: string[]) => page.evaluate((l) => l.map((i) => { const b = (window as never as Win).timmyCanvas.editor.getShapePageBounds(i); return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY }; }), ids);
  const markOf = (page: Page, i: string) => page.evaluate((x) => (window as never as Win).timmyCanvas.editor.getShape(x)!.meta, i);
  /** The words and the button the card of draft `id` shows of what it lands on, and its label on the board. */
  const said = (page: Page, id: string) => page.evaluate((d) => {
    const li = document.querySelector(`#draft-list li.draft[data-draft="${d}"]`);
    const mark = document.querySelector(`.timmy-draft-mark[data-draft="${d}"]`);
    const row = li?.querySelector('.draft-over');
    return {
      card: row?.querySelector('.draft-over-words')?.textContent ?? null,
      buttons: li ? [...li.querySelectorAll('button')].map((b) => b.textContent) : [],
      move: row?.querySelector('button.draft-move') ? (row.querySelector('button.draft-move') as HTMLButtonElement).disabled ? 'off' : 'on' : null,
      label: mark?.querySelector('.timmy-draft-label')?.textContent ?? null,
      board: mark?.querySelector('.timmy-draft-words')?.textContent ?? null,
    };
  }, id);

  it("a FAKE draft that lands on 3 of the board's shapes: its card and its label say so, with one neutral button; Move it to free space moves every shape of it clear of them, as they are arranged, to the nearest free place, and says from where; still a draft; one undo puts it back; moved again and accepted, it stays where it was moved; saved to tray's board only, blank's files byte-identical; nothing moved by itself", async () => {
    // blank's board first, with a shape of the person's on it, saved: its files are what tray's steps must never change
    await name(blank);
    const { page, context, errors } = await open();
    try {
      await shows(page, 'blank');
      await draw(page, [{ id: 'shape:blank-own', x: 500, y: 260, w: 200, h: 120 }]);
      await savedState(page);
      const blank0 = files(blank);
      expect(Object.keys(blank0)).toEqual(['canvas.json']);
      // the REPL's /project tray: Studio shows tray's board; the person's shapes on it, three where the draft will land, one far off
      await name(tray);
      await shows(page, 'tray');
      const mine = [
        { id: 'shape:p1', x: 400, y: 200, w: 200, h: 120 },
        { id: 'shape:p2', x: 650, y: 200, w: 150, h: 100 },
        { id: 'shape:p3', x: 420, y: 360, w: 120, h: 80 },
        { id: 'shape:p4', x: 1400, y: 900, w: 100, h: 100 },
      ];
      await draw(page, mine);
      await savedState(page);
      const ids = mine.map((m) => m.id);
      const theirs = await where(page, ids);

      // FAKE: a scripted canvas_exec call proposes two boxes, the first over p1 and p3, the second over p2 (no model)
      const drawn = await agent(tray)('canvas_exec', { code: boxes([{ x: 460, y: 220, w: 160, h: 160, text: 'FAKE proposed one' }, { x: 680, y: 230, w: 160, h: 80, text: 'FAKE proposed two' }]), jobId: 'turn-overlap' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 2 } });
      const id = drawn.draft!.id;
      const own = drawn.result as string[];
      // its card and its label on the board name the overlap, with the count; one button beside the words, Move it to free space
      const lands = 'This draft lands on 3 shapes already on the board.';
      await page.waitForFunction((d) => document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent === 'This draft lands on 3 shapes already on the board.', id, { timeout: 10_000 });
      await page.waitForFunction((d) => document.querySelector(`.timmy-draft-mark[data-draft="${d}"] .timmy-draft-words`)?.textContent === 'This draft lands on 3 shapes already on the board.', id, { timeout: 10_000 });
      expect(await said(page, id)).toEqual({ card: lands, buttons: ['Move it to free space', 'Show', 'Accept', 'Discard'], move: 'on', label: 'DRAFT · proposed by Timmy', board: lands });
      // B10: the button is neutral (the one amber step is the draft's Accept); every word of it is 11 px or more
      const look = await page.evaluate((d) => {
        const li = document.querySelector(`#draft-list li.draft[data-draft="${d}"]`)!;
        const mark = document.querySelector(`.timmy-draft-mark[data-draft="${d}"]`)!;
        const s = (e: Element) => getComputedStyle(e);
        const move = li.querySelector('button.draft-move')!;
        const amber = [...document.querySelectorAll('#drafts *, .timmy-draft-mark, .timmy-draft-mark *')].filter((e) => [s(e).color, s(e).backgroundColor, s(e).borderTopStyle !== 'none' ? s(e).borderTopColor : ''].includes('rgb(255, 176, 0)'))
          .map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`);
        return {
          move: [s(move).color, s(move).backgroundColor, s(move).borderTopColor], amber,
          sizes: [li.querySelector('.draft-over-words')!, move, mark.querySelector('.timmy-draft-words')!, mark.querySelector('.timmy-draft-label')!].map((e) => parseFloat(s(e).fontSize)),
        };
      }, id);
      expect(look.move).not.toContain(AMBER);
      expect(look.amber).toEqual(['button.draft-accept']);
      for (const px of look.sizes) expect(px).toBeGreaterThanOrEqual(11);
      await shoot(page, 'draft-overlap-lands-1440x900.png');

      // nothing moves by itself: a while later the draft is where the model put it, on screen and on disk, and so are the person's
      await page.waitForTimeout(1500);
      await savedState(page);
      const put = await where(page, own);
      expect(put).toEqual([{ x: 460, y: 220 }, { x: 680, y: 230 }]);
      expect(onDisk(own)).toEqual(put);
      expect(await where(page, ids)).toEqual(theirs);
      expect(files(blank)).toEqual(blank0);

      // the nearest free place, worked out here again from the page's own bounds by the placement rule
      const before = await boundsOf(page, own);
      const block = { minX: Math.min(...before.map((b) => b.minX)), minY: Math.min(...before.map((b) => b.minY)), maxX: Math.max(...before.map((b) => b.maxX)), maxY: Math.max(...before.map((b) => b.maxY)) };
      const want = nearestSpot(block, await boundsOf(page, ids));
      expect(Math.hypot(want.dx, want.dy)).toBeGreaterThan(0);

      // the person's press: the draft's shapes move together, as they are arranged, to that place, clear of every shape there
      const press = async (): Promise<void> => {
        await page.click(`#draft-list li.draft[data-draft="${id}"] button.draft-move`);
        await page.waitForFunction((d) => /^Moved to free space from /.test(document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent ?? ''), id, { timeout: 10_000 });
        const now = await where(page, own);
        for (let i = 0; i < own.length; i++) {
          expect(now[i].x - put[i].x, `${own[i]} moved across`).toBeCloseTo(want.dx, 6);
          expect(now[i].y - put[i].y, `${own[i]} moved down`).toBeCloseTo(want.dy, 6);
        }
        const after = await boundsOf(page, own);
        const board = await boundsOf(page, ids);
        expect(after.flatMap((a, i) => board.filter((b) => strict(a, b)).map((_, k) => `${own[i]} on ${ids[k]}`))).toEqual([]);
        expect(await where(page, ids)).toEqual(theirs);
      };
      await press();
      // still a draft: its mark, its card with Accept and Discard; the words say it was moved and from where, and the button is gone
      const moved = 'Moved to free space from x 460, y 220, where it landed on 3 shapes. It lands on no shape now.';
      await page.waitForFunction(({ d, w }) => document.querySelector(`.timmy-draft-mark[data-draft="${d}"] .timmy-draft-words`)?.textContent === w, { d: id, w: moved }, { timeout: 10_000 });
      expect(await said(page, id)).toEqual({ card: moved, buttons: ['Show', 'Accept', 'Discard'], move: null, label: 'DRAFT · proposed by Timmy', board: moved });
      for (const s of own) expect((await markOf(page, s)).timmyDraft).toMatchObject({ id, job: 'turn-overlap', moved: { x: 460, y: 220, over: 3 } });
      expect((await page.evaluate(() => (window as never as Win).timmyCanvas.drafts())).map((d) => d.id)).toEqual([id]);
      expect(await text(page, '#project-said')).toBe(`${moved} It is still a draft: Accept or Discard it. Undo puts it back.`);
      await page.waitForTimeout(300);
      await shoot(page, 'draft-overlap-moved-1440x900.png');
      // saved to tray's board, there; blank's board files as they were
      await savedState(page);
      const movedTo = await where(page, own);
      expect(onDisk(own)).toEqual(movedTo);
      expect(files(blank)).toEqual(blank0);

      // one undo (tldraw's own) puts it back, and the words with it; saved so
      await page.evaluate(() => { (window as never as Win).timmyCanvas.editor.undo(); });
      await page.waitForFunction((d) => document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent === 'This draft lands on 3 shapes already on the board.', id, { timeout: 10_000 });
      expect(await where(page, own)).toEqual(put);
      for (const s of own) expect((await markOf(page, s)).timmyDraft).not.toHaveProperty('moved');
      expect(await said(page, id)).toEqual({ card: lands, buttons: ['Move it to free space', 'Show', 'Accept', 'Discard'], move: 'on', label: 'DRAFT · proposed by Timmy', board: lands });
      await savedState(page);
      await expect.poll(() => onDisk(own), { timeout: 5_000 }).toEqual(put);
      expect(files(blank)).toEqual(blank0);

      // moved again, then accepted: kept where it was moved, unmarked, saying who proposed it and that it was moved; recorded
      await press();
      await page.click(`#draft-list li.draft[data-draft="${id}"] .draft-accept`);
      await page.waitForFunction(() => /^Accepted Timmy's draft \(2 shapes, job turn-overlap\): kept on the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      await savedState(page);
      expect(await where(page, own)).toEqual(movedTo);
      for (const s of own) {
        const meta = await markOf(page, s);
        expect(meta.timmyDraft).toBeUndefined();
        expect(meta.timmyProposed).toMatchObject({ by: 'Timmy', draft: id, job: 'turn-overlap', moved: { x: 460, y: 220, over: 3 } });
      }
      expect(onDisk(own)).toEqual(movedTo);
      expect(await page.locator('.timmy-draft-mark').count()).toBe(0);
      const record = ((await (await fetch(`${base}/api/canvas/drafts`, { headers: bearer(server.projectToken) })).json()) as { drafts: Array<{ draft: string; event: string }> }).drafts.filter((r) => r.draft === id);
      expect(record.map((r) => r.event)).toEqual(['proposed', 'accepted']);
      expect(files(blank)).toEqual(blank0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('a FAKE draft that lands on nothing (and one that only touches a shape\'s edge) says nothing of it: no words on its card or its label, and no button', async () => {
    await name(tray);
    const { page, context, errors } = await open();
    try {
      await shows(page, 'tray');
      await draw(page, [{ id: 'shape:edge', x: 3000, y: 3400, w: 200, h: 100 }]);
      await savedState(page);
      // far from everything, and one box whose left edge is the person's shape's right edge
      const drawn = await agent(tray)('canvas_exec', { code: boxes([{ x: 3000, y: 3000, w: 160, h: 80, text: 'FAKE clear' }, { x: 3200, y: 3400, w: 120, h: 60, text: 'FAKE touching' }]), jobId: 'turn-clear' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 2 } });
      const id = drawn.draft!.id;
      await page.waitForSelector(`#draft-list li.draft[data-draft="${id}"]`);
      await page.waitForSelector(`.timmy-draft-mark[data-draft="${id}"]`, { state: 'attached' });
      await page.waitForTimeout(300);
      expect(await said(page, id)).toEqual({ card: null, buttons: ['Show', 'Accept', 'Discard'], move: null, label: 'DRAFT · proposed by Timmy', board: null });
      expect(await page.locator(`#draft-list li.draft[data-draft="${id}"] .draft-over`).count()).toBe(0);
      // tidy: the person discards it
      await page.click(`#draft-list li.draft[data-draft="${id}"] .draft-discard`);
      await page.waitForFunction((d) => !document.querySelector(`#draft-list li.draft[data-draft="${d}"]`), id, { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("the R7 rehearsal's case: a second FAKE draft at the first one's coordinates; while both wait each says it lands on the other's 2 shapes; once the first is accepted the second still says so, and Move takes it clear of them", async () => {
    await name(tray);
    const { page, context, errors } = await open();
    try {
      await shows(page, 'tray');
      const at = [{ x: 5000, y: 5000, w: 160, h: 80, text: 'FAKE first' }, { x: 5240, y: 5000, w: 160, h: 80, text: 'FAKE first too' }];
      const first = await agent(tray)('canvas_exec', { code: boxes(at), jobId: 'turn-first' });
      expect(first).toMatchObject({ ok: true, draft: { shapes: 2 } });
      await page.waitForSelector(`#draft-list li.draft[data-draft="${first.draft!.id}"]`);
      expect((await said(page, first.draft!.id)).card).toBeNull();
      // the same coordinates again, as the rehearsal's second draft had them
      const second = await agent(tray)('canvas_exec', { code: boxes(at.map((b) => ({ ...b, text: b.text.replace('first', 'second') }))), jobId: 'turn-second' });
      expect(second).toMatchObject({ ok: true, draft: { shapes: 2 } });
      const lands = 'This draft lands on 2 shapes already on the board.';
      await page.waitForFunction((d) => document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent === 'This draft lands on 2 shapes already on the board.', second.draft!.id, { timeout: 10_000 });
      expect((await said(page, first.draft!.id)).card).toBe(lands);
      // the first accepted: its shapes are the board's own now, and the second still lands on them
      await page.click(`#draft-list li.draft[data-draft="${first.draft!.id}"] .draft-accept`);
      await page.waitForFunction(() => /^Accepted Timmy's draft \(2 shapes, job turn-first\): kept on the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(await said(page, second.draft!.id)).toEqual({ card: lands, buttons: ['Move it to free space', 'Show', 'Accept', 'Discard'], move: 'on', label: 'DRAFT · proposed by Timmy', board: lands });
      await page.click(`#draft-list li.draft[data-draft="${second.draft!.id}"] button.draft-move`);
      await page.waitForFunction((d) => document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent === 'Moved to free space from x 5000, y 5000, where it landed on 2 shapes. It lands on no shape now.', second.draft!.id, { timeout: 10_000 });
      const theirs = await boundsOf(page, first.result as string[]);
      const mine = await boundsOf(page, second.result as string[]);
      expect(mine.flatMap((a) => theirs.filter((b) => strict(a, b)))).toEqual([]);
      await savedState(page);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  it('while Studio switches projects the button is off and says why, and nothing moves on either board; the switch given up, the draft is where the model put it, still saying what it lands on, and the button moves it', async () => {
    await name(tray);
    const { page, context, errors } = await open();
    try {
      await shows(page, 'tray');
      await draw(page, [{ id: 'shape:under', x: -2000, y: -2000, w: 200, h: 120 }]);
      await savedState(page);
      const drawn = await agent(tray)('canvas_exec', { code: boxes([{ x: -1980, y: -1960, w: 160, h: 80, text: 'FAKE over yours' }]), jobId: 'turn-switch' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 1 } });
      const id = drawn.draft!.id;
      const own = drawn.result as string[];
      await page.waitForFunction((d) => document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent === 'This draft lands on 1 shape already on the board.', id, { timeout: 10_000 });
      await savedState(page);
      const put = await where(page, own);
      const tray0 = files(tray);
      const blank0 = files(blank);
      // a switch to blank is pending: the board takes no edit, and the button is off and says why
      expect(server.switchPending({ id: projectId(blank), name: 'blank', since: new Date().toISOString() })).toBe(1);
      await page.waitForFunction(() => (window as never as Win).timmyCanvas.identity.state === 'switching', null, { timeout: 5_000 });
      const button = page.locator(`#draft-list li.draft[data-draft="${id}"] button.draft-move`);
      await page.waitForFunction((d) => (document.querySelector(`#draft-list li.draft[data-draft="${d}"] button.draft-move`) as HTMLButtonElement | null)?.disabled === true, id, { timeout: 5_000 });
      expect(await button.getAttribute('title')).toBe("Studio is switching to blank: editing, Accept and Discard wait until blank's board is loaded.");
      await button.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      await shoot(page, 'draft-overlap-switching-1440x900.png');
      expect(await where(page, own)).toEqual(put);
      expect(files(tray)).toEqual(tray0);
      expect(files(blank)).toEqual(blank0);
      // the switch given up: tray's board again, editable; the draft where the model put it, its words and its button as they were
      server.switchPending(null);
      await shows(page, 'tray');
      await page.waitForFunction((d) => (document.querySelector(`#draft-list li.draft[data-draft="${d}"] button.draft-move`) as HTMLButtonElement | null)?.disabled === false, id, { timeout: 10_000 });
      expect(await where(page, own)).toEqual(put);
      expect((await said(page, id)).card).toBe('This draft lands on 1 shape already on the board.');
      expect(files(tray)).toEqual(tray0);
      expect(files(blank)).toEqual(blank0);
      // and the button moves it now
      await page.click(`#draft-list li.draft[data-draft="${id}"] button.draft-move`);
      await page.waitForFunction((d) => /^Moved to free space from x -1980, y -1960, where it landed on 1 shape\. It lands on no shape now\.$/.test(document.querySelector(`#draft-list li.draft[data-draft="${d}"] .draft-over-words`)?.textContent ?? ''), id, { timeout: 10_000 });
      expect(await where(page, own)).not.toEqual(put);
      await savedState(page);
      expect(files(blank)).toEqual(blank0);
      // still a draft once moved: Discard removes it, as before, and the person's shape it had landed on stays
      await page.click(`#draft-list li.draft[data-draft="${id}"] .draft-discard`);
      await page.waitForFunction(() => /^Discarded Timmy's draft \(1 shape, job turn-switch\): removed from the board; saved at revision \d+ and recorded\. No tool or job ran\.$/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(await page.evaluate((i) => [i, 'shape:under'].map((s) => Boolean((window as never as Win).timmyCanvas.editor.getShape(s))), own[0])).toEqual([false, true]);
      expect(files(blank)).toEqual(blank0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);
});
