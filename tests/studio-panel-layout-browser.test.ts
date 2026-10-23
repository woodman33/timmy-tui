/**
 * Round R4 (H100): the left panel of Timmy Canvas, laid out in a real headless Chromium at 1440 x 900 and at narrow sizes,
 * against the real canvas server and the real bundle (built here into a temporary folder), with a project of many cards
 * (tests/helpers/canvas-project.ts, an operation from tests/helpers/canvas-operation.ts and 24 more workflow documents) and
 * canvas jobs made through the agent's own route (POST /api/canvas/exec with the REPL's token).
 *
 * The Mac run r24 (the operator's first hands-on review) found the New board footer sitting on the list's cut rows, and the
 * "Placed card" message sitting on the buttons of the rows under it: the panel scrolled as a whole and its lists scrolled
 * again inside it, with nothing between a list's cut edge and what came after. Now the panel never scrolls; its lists scroll
 * in one region, which ends above the message band and the footer. Checked by geometry and by hit-testing: what the browser
 * finds at the middle of a row's button scrolled to the bottom of the list, and of New board's Open, is that button itself.
 * Screenshots for a look by eye are taken only when TIMMY_CANVAS_SHOTS names a folder (a run leaves nothing behind
 * otherwise). Skipped, saying so, where no Chromium is found.
 *
 * R10 (H172; CI at ea03f40e failed the 800 x 600 case's "some Place buttons wholly in the open part"; locally, under load, the
 * 1440 x 900 case's last row once ended 13 px under the region): the panel moves under the test's own presses, and the test read
 * it once. Each change to the board (a card placed, the card growing as its detail is read, a canvas call) is saved, and the save
 * line says its states in one line or two (at 320 px: saved one, waiting to be saved two), so a save that began after the list
 * was scrolled to its end moved the region's top down a line and left the list a line short of its end (the last row 12.9 px under
 * the region, read against a box taken before). And the middle Place button was centred in the region, which at 800 x 600 is
 * 63.6 px with its list's heading (18.8 px) stuck at its top: the button sat 0.4 px below that heading, and with one line less
 * room (a longer message, another font's wrapping; shown at 800 x 581) under it, so no Place button was wholly in the open part.
 * Now each check reads the panel in one frame of a settled page (settle below): the board saved, no job waiting to be recorded,
 * the strip drawn and the canvas below it, tldraw's foot measured, the panel's boxes unchanged for five frames in a row; the
 * scroll the check is about (the list's end, the middle Place button in the middle of the open part, below the heading) is made
 * again whenever the panel moved under it, and every box and hit-test the check asserts is taken in that same frame.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, type Operation } from './helpers/canvas-operation.js';
import { grant } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-panel-layout-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

type Box = { x: number; y: number; w: number; h: number; top: number; bottom: number; left: number; right: number };

/** WCAG relative luminance and contrast of two CSS colours (rgb() or rgba()). */
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

describe.skipIf(!browserPath)("Timmy Canvas's left panel: its lists scroll above the message band and New board", () => {
  let p: CanvasProject;
  let o: Operation;
  let pageRoot = '';
  let home = '';
  let server: StudioServer;
  let browser: Browser;
  let base = '';
  const shots = process.env.TIMMY_CANVAS_SHOTS;
  const shoot = async (page: Page, name: string): Promise<void> => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, name) });
  };

  beforeAll(async () => {
    p = await makeCanvasProject('studio-panel-layout-');
    o = await addOperation(p);
    for (let i = 1; i <= 24; i++) p.write(`WF${String(i).padStart(2, '0')}.md`, `# Workflow number ${i}, with a title long enough to wrap in the panel\n\n\`\`\`bash [name:a]\necho ${i}\n\`\`\`\n`);
    pageRoot = mkdtempSync(join(tmpdir(), 'timmy-layout-root-'));
    home = mkdtempSync(join(tmpdir(), 'timmy-layout-home-'));
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(pageRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, out: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(pageRoot, 'dist'), { licenses: pageRoot });
    // R5 (H133): the page's workspace strip asks the server for the frame, which reads Timmy's settings: this file's own folder
    server = await startStudioServer(0, { env: { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR }, root: pageRoot });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const named = await fetch(`${base}/api/project/active`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` }, body: JSON.stringify({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }) });
    expect(named.status).toBe(200);
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    for (const d of [p?.base, pageRoot, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  /** What a check reads of the panel, in one frame: see `settle`. */
  type Step = { kind: 'panel' } | { kind: 'end' } | { kind: 'part-way' } | { kind: 'reach'; sel: string };
  type Read = {
    side: Box; region: Box; said: Box; foot: Box; under: Array<{ sel: string; b: Box | null }>; sideScrolls: boolean; regionScrolls: boolean;
    ownScroll: string[]; reach: Record<string, boolean>; card: string | null; row: Box | null; open: { top: number; bottom: number };
    whole: number; covered: number; target: Box | null;
  };
  let calls = 0;
  /**
   * R10 (H172): reads the panel once the page has settled, in the frame where it has, as a person sees it once it stops moving:
   * the board saved (#save says saved: no change waiting to be saved, none on its way), no canvas job waiting to be recorded, the
   * strip drawn (its revision) with the canvas below it (--frame-h followed), tldraw's foot measured (--side-foot), and the
   * panel's boxes, the region's scroll and the step's target unchanged for five frames in a row. The step's scroll is made again
   * in any frame where the panel moved under it: 'end', the region scrolled to its end; 'part-way', the middle row's Place button
   * in the middle of the region's open part (below the list's heading stuck at its top); 'reach', `sel` brought into the open
   * part when it is not wholly there. Every box and hit-test is taken in that frame. A page that does not settle in 20 s says
   * which of those did not hold.
   */
  const settle = async (page: Page, step: Step): Promise<Read> => {
    const id = ++calls;
    try {
      const h = await page.waitForFunction(({ s, id: call }) => {
        const w = window as unknown as { __settle?: { sig: string; n: number; why: string } };
        const q = (sel: string): HTMLElement | null => document.querySelector(sel);
        const box = (e: Element | null): Box | null => {
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        };
        /** Whether what the browser finds at the middle of `e` is `e` (or inside it): nothing covers it. */
        const reach = (e: Element | null): boolean => {
          if (!e) return false;
          const b = e.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!hit && (hit === e || e.contains(hit));
        };
        const region = q('#side-scroll')!;
        // the region's open part: below the list heading (sticky) that stays at its top while its list scrolls under it
        const openOf = (r: DOMRect) => ({ top: Math.max(r.top, ...['#jobs > summary', '#project > summary'].map((sel) => { const b = q(sel)!.getBoundingClientRect(); return b.top <= r.top + 1 ? b.bottom : r.top; })), bottom: r.bottom });
        const places = [...document.querySelectorAll('#project-groups li.pcard .pcard-place')];
        const target = s.kind === 'end' ? [...document.querySelectorAll('#project-groups li.pcard')].at(-1) ?? null
          : s.kind === 'part-way' ? places[Math.floor(places.length / 2)] ?? null
            : s.kind === 'reach' ? q(s.sel) : null;
        // the step's scroll, made again whenever the panel moved under it
        if (s.kind === 'end' && region.scrollTop + region.clientHeight < region.scrollHeight - 1) region.scrollTop = region.scrollHeight;
        if ((s.kind === 'part-way' || s.kind === 'reach') && target) {
          const open = openOf(region.getBoundingClientRect());
          const b = target.getBoundingClientRect();
          const whole = b.top >= open.top - 0.5 && b.bottom <= open.bottom + 0.5;
          const want = open.top + Math.max(0, (open.bottom - open.top - b.height) / 2);
          if ((s.kind === 'part-way' || !whole) && Math.abs(b.top - want) > 1) region.scrollTop += b.top - want;
        }
        // the page's own state: saved, no job waiting, the strip drawn and followed, tldraw's foot measured
        const frame = q('#frame');
        const root = q('#root');
        const why = [
          q('#save')?.dataset.state === 'saved' ? '' : `the save line says ${q('#save')?.dataset.state ?? 'nothing'}`,
          q('#job-list li.job[data-waiting]') ? 'a canvas job waits to be recorded' : '',
          frame && !frame.hidden && frame.dataset.revision ? '' : 'the strip has drawn no reading',
          frame && root && Math.abs(root.getBoundingClientRect().top - frame.getBoundingClientRect().bottom) <= 1 ? '' : 'the canvas is not below the strip yet',
          document.documentElement.style.getPropertyValue('--side-foot') ? '' : "tldraw's foot is not measured yet",
        ].filter(Boolean);
        const parts = ['#frame', '#side', '#status', '#save', '#side-scroll', '#project-said', '#project-said-acts', '#side-foot', '#jobs', '#project'].map((sel) => box(q(sel)));
        const sig = JSON.stringify([call, parts, region.scrollTop, region.scrollHeight, region.clientHeight, box(target)]);
        const n = why.length === 0 && w.__settle?.sig === sig ? w.__settle.n + 1 : 0;
        w.__settle = { sig, n, why: why.length ? why.join('; ') : n === 0 ? 'the panel moved in the last frame' : '' };
        if (n < 5) return null;
        // this frame's reading
        const side = q('#side')!;
        const r = region.getBoundingClientRect();
        const open = openOf(r);
        const inOpen = places.filter((b) => { const x = b.getBoundingClientRect(); return x.top >= open.top && x.bottom <= open.bottom; });
        const row = s.kind === 'end' ? target : null;
        return {
          side: box(side)!, region: box(region)!, said: box(q('#project-said'))!, foot: box(q('#boards'))!,
          under: ['.tlui-main-toolbar__inner', '.tlui-navigation-panel'].map((sel) => ({ sel, b: box(q(sel)) })),
          sideScrolls: side.scrollHeight > side.clientHeight + 1, regionScrolls: region.scrollHeight > region.clientHeight,
          ownScroll: ['#job-list', '#project-groups'].filter((sel) => q(sel)!.scrollHeight > q(sel)!.clientHeight + 1),
          reach: Object.fromEntries<boolean>([
            ...['label[for="board-pick"]', '#board-pick', '#board-open'].map((sel): [string, boolean] => [sel, reach(q(sel))]),
            ...(row ? [['.pcard-place', reach(row.querySelector('.pcard-place'))], ['.pcard-more > summary', reach(row.querySelector('.pcard-more > summary'))], ['.pcard-cmd in its Details', !!row.querySelector('.pcard-cmd')?.closest('details.pcard-more')]] as Array<[string, boolean]> : []),
            ...(s.kind === 'reach' ? [[s.sel, reach(target)]] as Array<[string, boolean]> : []),
          ]),
          card: row ? row.getAttribute('data-card') : null, row: box(row), open, whole: inOpen.length, covered: inOpen.filter((b) => !reach(b)).length, target: box(target),
        };
      }, { s: step, id }, { polling: 'raf', timeout: 20_000 });
      return (await h.jsonValue()) as Read;
    } catch (e) {
      const why = await page.evaluate(() => (window as unknown as { __settle?: { why: string } }).__settle?.why ?? 'not read').catch(() => 'not read');
      throw new Error(`the panel did not settle for the ${step.kind} check: ${why} (${String(e).split('\n')[0]})`);
    }
  };

  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 800, height: 600 }]) {
    it(`at ${size.width} x ${size.height}: one list region scrolls; the "Placed card" message and New board sit below it, covering no row or button, and the panel stays on screen`, async () => {
      const context = await browser.newContext({ viewport: size });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/#code=${await grant(Number(new URL(base).port), server.projectToken)}`);
        await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
        await page.waitForSelector('#project-groups li.pcard', { state: 'attached', timeout: 15_000 });
        // canvas jobs, as the agent's canvas calls make them (the REPL's token; no holder named): the jobs list grows too
        for (let i = 0; i < 6; i++) {
          const r = await fetch(`${base}/api/canvas/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}` }, body: JSON.stringify({ code: `editor.createShape({ type: 'geo', x: ${3000 + i * 80}, y: 3000 })`, jobId: `layout-${size.width}-${i}` }) });
          expect(r.status).toBe(200);
        }
        await page.waitForFunction((n) => document.querySelectorAll('#job-list li.job').length >= n, 6, { timeout: 15_000 });
        // a narrow screen starts with both lists folded: a person opens them. R7 (H151): below 1100 px the panel's lists themselves
        // start folded behind #side-fold (the board keeps most of the window): opened first
        if ((await page.getAttribute('#side', 'data-folded')) === 'true') await page.click('#side-fold');
        await page.evaluate(() => { for (const id of ['jobs', 'project']) (document.getElementById(id) as HTMLDetailsElement).open = true; });
        // A press that says something ("Placed card: …"), from a row in the middle of the list
        await page.locator('#project-groups li.pcard[data-card="workflow:WF12.md"] .pcard-drawn').scrollIntoViewIfNeeded();
        await page.click('#project-groups li.pcard[data-card="workflow:WF12.md"] .pcard-drawn');
        await page.waitForFunction(() => /^Placed card: /.test(document.getElementById('project-said')?.textContent ?? ''));
        await shoot(page, `layout-${size.width}x${size.height}.png`);

        // R10 (H172): read once the page has settled after the press (the card placed, grown and saved), in one frame (settle)
        const at = await settle(page, { kind: 'panel' });
        const { side, region, said, foot } = at;
        // the panel on screen, above tldraw's toolbar; it never scrolls as a whole. R5 (H137): the toolbar as drawn (its inner part;
        // .tlui-main-toolbar is a full-width container that draws nothing at the left), and tldraw's navigation panel: whichever is
        // under the panel, the panel ends above it (on a wide window it now reaches down to the navigation panel)
        expect(side.left >= 0 && side.top >= 0 && side.right <= size.width && side.bottom <= size.height, JSON.stringify(side)).toBe(true);
        for (const { sel, b: under } of at.under) {
          if (under && under.w > 0 && under.left < side.right && under.right > side.left) expect(side.bottom, `above ${sel}`).toBeLessThanOrEqual(under.top);
        }
        expect(at.sideScrolls, 'the panel scrolls as a whole').toBe(false);
        // one region scrolls, and no list scrolls inside it
        expect(at.regionScrolls).toBe(true);
        expect(at.ownScroll, 'lists that scroll on their own').toEqual([]);
        // the region ends above the message band, the band above the footer, the footer inside the panel
        expect(said.h).toBeGreaterThan(0);
        expect(region.bottom, 'the list ends above the message').toBeLessThanOrEqual(said.top + 0.5);
        expect(said.bottom, 'the message ends above New board').toBeLessThanOrEqual(foot.top + 0.5);
        expect(foot.bottom, 'New board inside the panel').toBeLessThanOrEqual(side.bottom + 0.5);
        // New board's controls are whole and nothing covers them
        for (const sel of ['label[for="board-pick"]', '#board-pick', '#board-open']) expect(at.reach[sel], sel).toBe(true);
        // the list's last row, scrolled to the bottom of the region: whole, above the band, and its buttons are its own (the region and
        // the row read in the frame where the region is at its end and the page settled)
        const end = await settle(page, { kind: 'end' });
        expect(end.card).not.toBeNull();
        const row = end.row!;
        expect(row.bottom, 'the last row ends inside the region, above the band').toBeLessThanOrEqual(end.region.bottom + 0.5);
        // a region taller than a row shows it whole (on a short window a row may be taller than the region: its end shows)
        if (row.h <= end.region.h) expect(row.top).toBeGreaterThanOrEqual(end.region.top - 0.5);
        // (R10 H167: a row's command is under its Details, whose control is reachable beside Place on canvas)
        for (const sel of ['.pcard-place', '.pcard-more > summary']) expect(end.reach[sel], `the last row's ${sel} (${end.card})`).toBe(true);
        expect(end.reach['.pcard-cmd in its Details']).toBe(true);
        // scrolled part-way: every Place button wholly in the open part of the region (below the list's heading, which stays at
        // its top while its list scrolls under it) is under nothing. R5 (H133): part-way is the middle row's Place button brought
        // to the middle of the region (it had been the list's exact middle: with the workspace strip above the canvas the region
        // on an 800 x 600 window is shorter than one card row, so a button wholly in view there depended on where that middle fell).
        // R10 (H172): to the middle of the region's open part, below the heading (in the region's middle, it sat 0.4 px under the
        // heading's foot at 800 x 600), read with the region and the heading of that same frame
        const mid = await settle(page, { kind: 'part-way' });
        expect(mid.whole, `some Place buttons wholly in the open part of the region (it is ${(mid.open.bottom - mid.open.top).toFixed(1)} px; the middle button ${mid.target ? mid.target.h.toFixed(1) : 'not found'} px)`).toBeGreaterThan(0);
        expect(mid.covered, 'a Place button in the open part of the region that something covers').toBe(0);
        // By operation: the operation's group and its Place this operation are laid out the same way
        await page.click('#project-by button[data-by="operation"]');
        await page.waitForSelector(`#project-groups section.pop[data-op="${o.op}"] .pop-place`);
        const opPlace = `#project-groups section.pop[data-op="${o.op}"] .pop-place`;
        expect((await settle(page, { kind: 'reach', sel: opPlace })).reach[opPlace], opPlace).toBe(true);
        await shoot(page, `layout-by-operation-${size.width}x${size.height}.png`);
        // the new words clear 4.5:1 on the panel
        const pairs = await page.evaluate(() => {
          const bg = getComputedStyle(document.getElementById('side')!).backgroundColor;
          return ['.pop-head', '.pop-request', '.pop-count', '#project-by button', '#project-said', '.pop-place']
            .map((s) => { const e = document.querySelector(s); return e ? { s, fg: getComputedStyle(e).color, bg } : null; }).filter(Boolean) as Array<{ s: string; fg: string; bg: string }>;
        });
        await page.click('#project-by button[data-by="kind"]');
        const op = await page.evaluate(() => { const e = document.querySelector('.pcard-op'); return e ? getComputedStyle(e).color : null; });
        const bg = await page.$eval('#side', (e) => getComputedStyle(e).backgroundColor);
        for (const x of [...pairs, { s: '.pcard-op', fg: op!, bg }]) expect(contrast(x.fg, x.bg), `${x.s} ${x.fg} on ${x.bg}`).toBeGreaterThanOrEqual(4.5);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 120_000);
  }
});
