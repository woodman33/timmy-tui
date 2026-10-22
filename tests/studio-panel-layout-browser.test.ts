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

  const box = (page: Page, sel: string): Promise<Box | null> => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }, sel);
  /** Whether what the browser finds at the middle of `sel` is that element (or inside it): nothing covers it. */
  const reachable = (page: Page, sel: string): Promise<boolean> => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === e || e.contains(hit));
  }, sel);

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

        const side = (await box(page, '#side'))!;
        const region = (await box(page, '#side-scroll'))!;
        const said = (await box(page, '#project-said'))!;
        const foot = (await box(page, '#boards'))!;
        // the panel on screen, above tldraw's toolbar; it never scrolls as a whole. R5 (H137): the toolbar as drawn (its inner part;
        // .tlui-main-toolbar is a full-width container that draws nothing at the left), and tldraw's navigation panel: whichever is
        // under the panel, the panel ends above it (on a wide window it now reaches down to the navigation panel)
        expect(side.left >= 0 && side.top >= 0 && side.right <= size.width && side.bottom <= size.height, JSON.stringify(side)).toBe(true);
        for (const sel of ['.tlui-main-toolbar__inner', '.tlui-navigation-panel']) {
          const under = await box(page, sel);
          if (under && under.w > 0 && under.left < side.right && under.right > side.left) expect(side.bottom, `above ${sel}`).toBeLessThanOrEqual(under.top);
        }
        expect(await page.$eval('#side', (e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
        // one region scrolls, and no list scrolls inside it
        expect(await page.$eval('#side-scroll', (e) => e.scrollHeight > e.clientHeight)).toBe(true);
        for (const sel of ['#job-list', '#project-groups']) expect(await page.$eval(sel, (e) => e.scrollHeight <= e.clientHeight + 1), `${sel} scrolls on its own`).toBe(true);
        // the region ends above the message band, the band above the footer, the footer inside the panel
        expect(said.h).toBeGreaterThan(0);
        expect(region.bottom, 'the list ends above the message').toBeLessThanOrEqual(said.top + 0.5);
        expect(said.bottom, 'the message ends above New board').toBeLessThanOrEqual(foot.top + 0.5);
        expect(foot.bottom, 'New board inside the panel').toBeLessThanOrEqual(side.bottom + 0.5);
        // New board's controls are whole and nothing covers them
        for (const sel of ['label[for="board-pick"]', '#board-pick', '#board-open']) expect(await reachable(page, sel), sel).toBe(true);
        // the list's last row, scrolled to the bottom of the region: whole, above the band, and its buttons are its own
        const last = await page.$eval('#project-groups', (g) => [...g.querySelectorAll('li.pcard')].at(-1)?.getAttribute('data-card') ?? null);
        expect(last).not.toBeNull();
        const lastSel = `#project-groups li.pcard[data-card="${last}"]`;
        await page.$eval('#side-scroll', (e) => { e.scrollTop = e.scrollHeight; });
        await page.waitForTimeout(100);
        const row = (await box(page, lastSel))!;
        expect(row.bottom, 'the last row ends inside the region, above the band').toBeLessThanOrEqual(region.bottom + 0.5);
        // a region taller than a row shows it whole (on a short window a row may be taller than the region: its end shows)
        if (row.h <= region.h) expect(row.top).toBeGreaterThanOrEqual(region.top - 0.5);
        // (R10 H167: a row's command is under its Details, whose control is reachable beside Place on canvas)
        for (const sel of [`${lastSel} .pcard-place`, `${lastSel} .pcard-more > summary`]) expect(await reachable(page, sel), sel).toBe(true);
        expect(await page.$eval(`${lastSel} .pcard-cmd`, (b) => !!b.closest('details.pcard-more'))).toBe(true);
        // scrolled part-way: every Place button wholly in the open part of the region (below the list's heading, which stays at
        // its top while its list scrolls under it) is under nothing. R5 (H133): part-way is the middle row's Place button brought
        // to the middle of the region (it had been the list's exact middle: with the workspace strip above the canvas the region
        // on an 800 x 600 window is shorter than one card row, so a button wholly in view there depended on where that middle fell)
        await page.$eval('#project-groups', (g) => { const all = [...g.querySelectorAll('li.pcard .pcard-place')]; all[Math.floor(all.length / 2)]?.scrollIntoView({ block: 'center' }); });
        await page.waitForTimeout(100);
        const open = await page.evaluate((r) => ({ top: Math.max(r.top, ...['#jobs > summary', '#project > summary'].map((s) => { const b = document.querySelector(s)!.getBoundingClientRect(); return b.top <= r.top + 1 ? b.bottom : r.top; })), bottom: r.bottom }), region);
        const placeButtons = (covered: boolean): Promise<number> => page.$$eval('#project-groups li.pcard .pcard-place', (els, a) => els.filter((b) => {
          const x = b.getBoundingClientRect();
          if (x.top < a.r.top || x.bottom > a.r.bottom) return false;
          if (!a.covered) return true;
          const hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
          return !(hit === b || b.contains(hit));
        }).length, { r: open, covered });
        expect(await placeButtons(false), 'some Place buttons wholly in the open part of the region').toBeGreaterThan(0);
        expect(await placeButtons(true), 'a Place button in the open part of the region that something covers').toBe(0);
        // By operation: the operation's group and its Place this operation are laid out the same way
        await page.click('#project-by button[data-by="operation"]');
        await page.waitForSelector(`#project-groups section.pop[data-op="${o.op}"] .pop-place`);
        await page.locator(`#project-groups section.pop[data-op="${o.op}"] .pop-place`).scrollIntoViewIfNeeded();
        expect(await reachable(page, `#project-groups section.pop[data-op="${o.op}"] .pop-place`)).toBe(true);
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
