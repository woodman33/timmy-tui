/**
 * R7 (H151): Studio's one next step while a draft waits, in a real headless Chromium against the real canvas server, the real
 * frame (GET /api/workspace, made by src/ops/workspace-frame.ts from the project's records) and the real bundle (built here).
 *
 * The operator's order of 2026-10-16, 22:08 PT: "Make Studio's primary action reflect the actual next step when a draft is
 * waiting." H147's R6 finding 2 (review/H147/caps/studio/09-draft-waiting.png): the amber primary stayed "Open the canvas for
 * Timmy" while a draft waited, and Accept was neutral. H148's N6 and H147's finding 8 (11-after-accept.png): "1 waiting" stayed
 * 3 s after an Accept, and Activity lagged 1.4 s or more after a stop.
 *
 * The draft is FAKE: the agent's own canvas_exec tool (src/agent/canvas-tools.ts) with the REPL's credentials sends code this file
 * writes, so no model runs (a scripted call standing in for one). The chat turn stopped here is a real hold this file takes and
 * lets go (scripted: no turn runs and no model is asked). Skipped, saying so, where no Chromium is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvasTools } from '../src/agent/canvas-tools.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-draft-step-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const AMBER = 'rgb(255, 176, 0)';
// R11 round 7 (H176; B11): what a model made is drawn in the secondary text colour (B11 has no silver; the words say it)
const SILVER = 'rgb(189, 202, 218)';
type Answer = { ok: boolean; result?: unknown; error?: string; draft?: { id: string; shapes?: number } };
type Win = { timmyCanvas: { editor: { selectNone: () => void; getSelectedShapeIds: () => string[]; getShapePageBounds: (id: string) => { minX: number; minY: number; maxX: number; maxY: number }; pageToScreen: (p: { x: number; y: number }) => { x: number; y: number }; setCamera: (c: { x: number; y: number; z: number }) => void } } };

/** A screenshot for a look by eye, only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind otherwise); it says on
 *  itself that what it shows is FAKE test data. */
async function shoot(page: Page, name: string): Promise<void> {
  const shots = process.env.TIMMY_CANVAS_SHOTS;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.id = 'fake-shot-label';
    label.textContent = 'FAKE test data (a scripted draft and FAKE projects written by the test), not a real project';
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

describe.skipIf(!browserPath)("Studio's one next step while a draft waits, and counts that follow at once (R7 H151)", () => {
  let pageRoot = '';
  let home = '';
  let project = '';
  let server: StudioServer | undefined;
  let browser: Browser | undefined;
  let base = '';
  const port = (): number => (server!.address() as AddressInfo).port;
  beforeAll(async () => {
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-draftstep-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-draftstep-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // the frame reads Timmy's settings: this file's own folder (tests/isolation-setup.ts), never the account's
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    base = `http://127.0.0.1:${port()}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** R7 (H151): each test on a project of its own (so on a board of its own), named to the canvas before its page opens. */
  let made = 0;
  async function fresh(): Promise<string> {
    made += 1;
    project = join(home, `project-${made}`);
    mkdirSync(project);
    await nameProject(port(), server!.projectToken, { root: project, name: `draft-step-${made}` });
    return project;
  }
  /** A page /canvas open opens, on a fresh project's board (or on `named`, a project this test named already). */
  async function open(size = { width: 1440, height: 900 }, named = false): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    if (!named) await fresh();
    const context = await browser!.newContext({ viewport: size });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#code=${await grant(port(), server!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('#frame-tabs li').length === 10, null, { timeout: 30_000 });
    return { page, context, errors };
  }
  /** The agent's own canvas tools, with the REPL's credentials (the project is named without a holder here). */
  const agent = () => {
    const tools = createCanvasTools({ baseUrl: base, auth: () => ({ token: server!.projectToken, holder: null }) });
    return (name: string, args: Record<string, unknown>) => (tools.find((t) => t.function.name === name)!.function.execute as (a: unknown) => Promise<Answer>)(args);
  };
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
  /** Every element of the page (outside tldraw's own UI layer) drawn in amber, and how: its colour, fill, border or outline. */
  const ambers = (page: Page) => page.evaluate((amber) => [...document.querySelectorAll('body *')].flatMap((e) => {
    if (e.closest('.tlui-layout')) return [];
    const s = getComputedStyle(e);
    if (s.visibility === 'hidden' || s.display === 'none' || (e as HTMLElement).offsetParent === null && s.position !== 'fixed') return [];
    const how = [['color', s.color], ['fill', s.backgroundColor], ['border', s.borderTopColor], ['outline', s.outlineStyle !== 'none' ? s.outlineColor : ''], ['stroke', s.stroke]]
      .filter(([k, v]) => v === amber && !(k === 'border' && s.borderTopStyle === 'none' && s.borderTopWidth === '0px')).map(([k]) => k);
    // a colour inherited from an amber parent is the parent's (counted there)
    const inherited = how.includes('color') && e.parentElement && getComputedStyle(e.parentElement).color === amber;
    const own = how.filter((k) => !(k === 'color' && inherited));
    if (!own.length) return [];
    const he = e as HTMLElement;
    return [`${e.tagName.toLowerCase()}${he.id ? `#${he.id}` : ''}${typeof he.className === 'string' && he.className ? `.${he.className.trim().split(/\s+/).join('.')}` : ''}${he.dataset?.draft ? `[draft]` : ''}: ${own.join('+')} "${(e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"`];
  }), AMBER);
  const twoBoxes = "const { createShapeId, toRichText } = helpers; const a = createShapeId(), b = createShapeId(); editor.createShapes([{ id: a, type: 'geo', x: 2460, y: 1820, props: { w: 160, h: 80, richText: toRichText('FAKE proposed') } }, { id: b, type: 'geo', x: 2700, y: 1820, props: { w: 160, h: 80, richText: toRichText('FAKE also proposed') } }]); return [a, b];";

  it('while a FAKE draft waits, the strip\'s one amber primary is the frame\'s draft step and the draft\'s Accept is that same step: those, the waiting counts, the active tab and focus are the only amber; Go to the draft brings the draft into view with the focus on its Accept; Accept makes it 0 waiting within 500 ms, and the primary is then the frame\'s next one', async () => {
    const { page, context, errors } = await open();
    try {
      // before any draft: the frame's Studio primary is not the draft's
      await page.waitForFunction(() => Boolean(document.getElementById('frame')?.dataset.revision), null, { timeout: 20_000 });
      expect(await page.$$eval('#frame-acts li.is-primary .fr-label', (ls) => ls.map((l) => l.textContent))).not.toContain('Accept or discard the draft Timmy proposed');
      const drawn = await agent()('canvas_exec', { code: twoBoxes, jobId: 'draft-step-fake' });
      expect(drawn).toMatchObject({ ok: true, draft: { shapes: 2 } });
      const id = drawn.draft!.id;
      const shapes = drawn.result as string[];
      // the page saved the draft, and read the frame again at once: its one primary is now the draft step, from the frame
      await page.waitForFunction(() => document.querySelector('#frame-acts li.is-primary .fr-label')?.textContent === 'Accept or discard the draft Timmy proposed', null, { timeout: 10_000 });
      const primary = await page.$eval('#frame-acts li.is-primary', (li) => ({
        n: li.querySelector('.fr-n')?.textContent, go: li.querySelector('button.fr-go')?.textContent, goTitle: li.querySelector('button.fr-go')?.getAttribute('title'),
        copy: li.querySelectorAll('button.fr-copy, code.fr-cmd').length, first: li === li.parentElement!.firstElementChild,
      }));
      expect(primary).toEqual({ n: '1', go: 'Go to the draft', goTitle: '/studio, then Accept or Discard on the draft: shows the draft on the board and puts the focus on its Accept', copy: 0, first: true });
      expect(await page.locator('#frame-acts li.is-primary').count()).toBe(1);
      expect(await text(page, '#frame-activity')).toMatch(/· 1 waiting on you ·/);
      // the panel lists it with Show, Accept and Discard
      await page.waitForSelector(`#draft-list li[data-draft="${id}"]`);
      // the camera away from the draft, nothing selected, nothing focused: what amber is on the screen
      await page.evaluate(() => { const e = (window as never as Win).timmyCanvas.editor; e.selectNone(); e.setCamera({ x: 0, y: 0, z: 1 }); (document.activeElement as HTMLElement | null)?.blur(); });
      await page.waitForTimeout(200);
      const shown = await ambers(page);
      await shoot(page, 'draft-waiting-1440x900.png');
      // R7 lead (B10: things waiting for you are amber, as the Workbench and the companion draw them): the two tabs that count the
      // draft and the activity line's "1 waiting on you" are amber too
      expect(shown.sort()).toEqual([
        'button.draft-accept: color+border "Accept"',
        'li.fr-act.is-primary.is-draft: border "1 Accept or discard the draft Timmy proposed Go to the draft"',
        'li.fr-tab.is-active: border "4 Studio"',
        'span.fr-count: color "1 waiting"',
        'span.fr-count: color "1 waiting"',
        'span.fr-label: color "Accept or discard the draft Timmy proposed"',
        'span.fr-waiting.is-waiting: color "1 waiting on you"',
      ]);
      // the draft's Discard and Show are neutral; the draft's outline and label are silver (made by a model, B10), said in words
      const look = await page.evaluate((d) => {
        const li = document.querySelector(`#draft-list li[data-draft="${d}"]`)!;
        const c = (s: string) => getComputedStyle(li.querySelector(s)!);
        return { discard: [c('.draft-discard').color, c('.draft-discard').borderTopColor], show: c('.draft-show').color };
      }, id);
      expect([...look.discard, look.show]).not.toContain(AMBER);
      // tldraw's own UI layer: amber is only its selection (--tl-color-selected: the tool chosen, and the chosen value of its opacity
      // slider, its filled range), never a fill of Timmy's
      const tl = await page.evaluate((amber) => [...document.querySelectorAll('.tlui-layout *')].filter((e) => getComputedStyle(e).backgroundColor === amber)
        .map((e) => (e.closest('[data-state="selected"], [aria-pressed="true"], [aria-checked="true"], [data-isactive="true"]') || e.classList.contains('tlui-slider__range') ? 'selected' : `${e.tagName}.${(e as HTMLElement).className}`)), AMBER);
      expect([...new Set(tl)]).toEqual(tl.length ? ['selected'] : []);

      // choosing the primary takes you to the draft: its shapes in view, the focus on its Accept. They are not selected: a selection
      // is drawn amber (tldraw's handles, the panel's job row), and the one amber step there is the Accept; the draft's silver
      // outline and its label say which shapes it is
      await page.click('#frame-acts li.is-primary button.fr-go');
      await page.waitForFunction(() => document.activeElement?.classList.contains('draft-accept') ?? false, null, { timeout: 5_000 });
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).closest('li')?.getAttribute('data-draft'))).toBe(id);
      expect(await page.evaluate(() => (window as never as Win).timmyCanvas.editor.getSelectedShapeIds())).toEqual([]);
      expect(await page.locator('#job-list li[aria-current="true"]').count()).toBe(0);
      await expect.poll(() => page.evaluate((ids) => {
        const e = (window as never as Win).timmyCanvas.editor;
        const side = document.getElementById('side')!.getBoundingClientRect();
        const bar = document.querySelector('.tlui-main-toolbar__inner')?.getBoundingClientRect();
        return ids.every((s) => {
          const r = e.getShapePageBounds(s); const a = e.pageToScreen({ x: r.minX, y: r.minY }); const z = e.pageToScreen({ x: r.maxX, y: r.maxY });
          return a.x >= side.right && a.y >= 0 && z.x <= innerWidth && z.y <= (bar ? bar.top : innerHeight);
        });
      }, shapes), { timeout: 3_000, message: 'the draft\'s shapes in view, beside the panel' }).toBe(true);
      // there, amber is still the same four: the step, its label, the active tab and the Accept (with the focus, when shown)
      const there = (await ambers(page)).map((a) => a.replace(/^(button\.draft-accept: color\+border)\+outline "/, '$1 "'));
      await shoot(page, 'draft-go-to-the-draft-1440x900.png');
      expect(there.sort()).toEqual(shown);

      // Enter on the focused Accept (a person's key) accepts: 0 waiting within 500 ms of the key, and the draft step is no longer
      // the primary; the frame read next names the next one
      await page.evaluate(() => {
        const w = window as unknown as { seen?: { zero?: number }; t0?: number };
        w.seen = {};
        const line = document.getElementById('frame-activity')!;
        const look = () => {
          const t = (line.textContent ?? '').replace(/\s+/g, ' ');
          const noTabs = ![...document.querySelectorAll('#frame-tabs .fr-count')].length;
          const noStep = !document.querySelector('#frame-acts li.is-primary.is-draft');
          if (w.seen!.zero === undefined && / 0 waiting on you /.test(` ${t} `) && noTabs && noStep) w.seen!.zero = performance.now();
        };
        new MutationObserver(look).observe(document.getElementById('frame')!, { subtree: true, childList: true, characterData: true, attributes: true });
        w.t0 = performance.now();
      });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => (window as unknown as { seen: { zero?: number } }).seen.zero !== undefined, null, { timeout: 5_000 });
      const ms = await page.evaluate(() => { const w = window as unknown as { seen: { zero: number }; t0: number }; return Math.round(w.seen.zero - w.t0); });
      expect(ms, `0 waiting ${ms} ms after Accept`).toBeLessThanOrEqual(500);
      await page.waitForFunction(() => /^Accepted Timmy's draft \(2 shapes\)/.test(document.getElementById('project-said')?.textContent ?? ''), null, { timeout: 10_000 });
      // the frame read again names the next step (Studio's own, with no draft): the one amber primary again, with its command
      await page.waitForFunction(() => {
        const p = document.querySelector('#frame-acts li.is-primary');
        return !!p && !p.classList.contains('is-draft') && !p.classList.contains('is-done') && !!p.querySelector('code.fr-cmd');
      }, null, { timeout: 5_000 });
      const next = await page.$eval('#frame-acts li.is-primary', (li) => ({ label: li.querySelector('.fr-label')?.textContent, command: li.querySelector('code.fr-cmd')?.textContent, border: getComputedStyle(li).borderTopColor }));
      expect(next).toEqual({ label: 'Open Studio', command: '/studio', border: AMBER });
      await shoot(page, 'draft-after-accept-1440x900.png');
      expect(await page.locator('#frame-acts li.is-draft').count()).toBe(0);
      expect(await text(page, '#frame-activity')).toMatch(/^0 running · 0 waiting on you ·/);
      // the accepted shapes keep their own look; nothing of the draft's mark is left
      expect(await page.locator('.timmy-draft-mark').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('the draft\'s outline on the board is silver and labelled in words, the panel\'s drafts box too; Discard is neutral; a second draft\'s Accept is not a second amber step', async () => {
    const { page, context, errors } = await open();
    try {
      const run = agent();
      const one = await run('canvas_exec', { code: twoBoxes, jobId: 'draft-step-one' });
      expect(one.ok).toBe(true);
      expect((await run('canvas_read', {})).ok).toBe(true);
      const two = await run('canvas_exec', { code: "const id = helpers.createShapeId(); editor.createShape({ id, type: 'geo', x: 2460, y: 2100, props: { w: 120, h: 60 } }); return id;", jobId: 'draft-step-two' });
      expect(two.ok).toBe(true);
      await page.waitForFunction(() => document.querySelectorAll('#draft-list li.draft').length === 2, null, { timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('#frame-acts li.is-primary .fr-label')?.textContent === 'Accept or discard the 2 drafts Timmy proposed', null, { timeout: 10_000 });
      const look = await page.evaluate(() => {
        const mark = document.querySelector('.timmy-draft-mark')!;
        const label = mark.querySelector('.timmy-draft-label')!;
        const rows = [...document.querySelectorAll('#draft-list li.draft')];
        return {
          mark: [getComputedStyle(mark).borderTopStyle, getComputedStyle(mark).borderTopColor], label: [label.textContent, getComputedStyle(label).color],
          box: getComputedStyle(document.getElementById('drafts')!).borderTopColor,
          accepts: rows.map((r) => getComputedStyle(r.querySelector('.draft-accept')!).borderTopColor),
        };
      });
      expect(look.mark).toEqual(['dashed', SILVER]);
      expect(look.label).toEqual(['DRAFT · proposed by Timmy', SILVER]);
      expect(look.box).toBe(SILVER);
      expect(look.accepts[0]).toBe(AMBER);
      expect(look.accepts[1]).not.toBe(AMBER);
      // both decided: the step is decided at once, then the next one
      for (const sel of ['#draft-list li.draft:first-child .draft-discard', '#draft-list li.draft:first-child .draft-discard']) {
        await page.click(sel);
        await page.waitForTimeout(150);
      }
      await page.waitForFunction(() => document.querySelectorAll('#draft-list li.draft').length === 0, null, { timeout: 10_000 });
      await page.waitForFunction(() => !document.querySelector('#frame-acts li.is-draft'), null, { timeout: 5_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('a stop on another surface shows on Studio\'s Activity within 500 ms: a chat turn held in the project (a real hold, scripted), let go', async () => {
    const root = await fresh();
    const t = takeTurnHold(root, 'repl');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    let held = true;
    const { page, context, errors } = await open(undefined, true);
    try {
      await page.waitForFunction(() => /▶ a chat turn is being answered in the REPL/.test(document.getElementById('frame-activity')?.textContent ?? ''), null, { timeout: 20_000 });
      await page.evaluate(() => {
        const w = window as unknown as { stoppedAt?: number };
        const line = document.getElementById('frame-activity')!;
        new MutationObserver(() => { if (w.stoppedAt === undefined && !/chat turn/.test(line.textContent ?? '') && /^0 running/.test((line.textContent ?? '').trim())) w.stoppedAt = Date.now(); })
          .observe(line, { subtree: true, childList: true, characterData: true });
      });
      // a little while into the turn, as a person would stop it
      await page.waitForTimeout(700);
      const at = Date.now();
      t.hold.release();
      held = false;
      await page.waitForFunction(() => (window as unknown as { stoppedAt?: number }).stoppedAt !== undefined, null, { timeout: 10_000 });
      const ms = (await page.evaluate(() => (window as unknown as { stoppedAt: number }).stoppedAt)) - at;
      expect(ms, `Activity said it ${ms} ms after the stop`).toBeLessThanOrEqual(500);
      expect(await text(page, '#frame-activity')).toMatch(/^0 running · 0 waiting on you · Stop current: idle · newest: /);
      expect(errors).toEqual([]);
    } finally {
      if (held) t.hold.release();
      await context.close();
    }
  }, 120_000);
});
