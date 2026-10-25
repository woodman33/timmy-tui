/**
 * R10 (H167; the R10 brief's step B, reference 12 and H168's F3, F5, F6 and patterns 1 and 7): Home's journey in the browser
 * companion, in a real headless Chromium against the real companion server on 127.0.0.1.
 *
 * Real: the server, its token, the page's code, H164's journey routes (GET /api/journey/recent, /run/<op>, /open), a /run of
 * SHOT.md in the REPL's own Workspace that writes a 640 × 360 PNG (tests/helpers/companion-page-kit.ts; upmd is the TEST DOUBLE
 * labelled FAKE there), its receipts verified on the server. FAKE, labelled there: two VoxVision records and their images.
 *
 * What is checked: Home lists the project's recent work, each item in words (its kind, its state, when), with the run among
 * them; the preview is the largest box of the page and draws the item chosen, the run's progress, result and receipt with the
 * image it wrote drawn large, its receipt green only as verified on the server; Enter on the list opens the run where it
 * belongs (Workflows, its run detail); an address that names a file of the project (?file=<its path as hex>) selects it and
 * draws it; what a person sees of Home names no operation id, no address of this computer, no token and no slash command
 * (they are behind Details); at 390 × 844 nothing scrolls sideways and the preview follows the list.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { browserPath, closeProject, launchBrowser, openPage, pageProject, type PageProject } from './helpers/companion-page-kit.js';
import { opsKit } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

const GREEN = 'rgb(40, 254, 20)';

/** What a person sees of Home: its rendered text (a closed Details shows its summary only). */
const face = (page: Page): Promise<string> => page.$eval('#ws-home', (e) => (e as HTMLElement).innerText);
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

describe.skipIf(!browserPath)('the browser companion\'s Home: the project\'s recent work and its preview (R10 H167)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('at 1376 × 768: the recent work in words, the preview the largest box, the run drawn with its image and its receipt verified; Enter opens its run detail; nothing of an id, an address or a command on its face', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'home-journey-browser-' });
      const { context, page, errors } = await openPage(browser, p, { width: 1376, height: 768 });
      try {
        await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
        const run = `#home-work [data-work-kind="run"][data-op="${p.op}"]`;
        await page.waitForSelector(run, { timeout: 30_000 });
        // each item in words: its title, its kind and state, when; the run by its request, not its operation's id
        const rows = await page.$$eval('#home-work [data-work]', (els) => els.map((e) => ({ kind: e.getAttribute('data-work-kind'), words: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
        expect(rows.length).toBeGreaterThan(1);
        const runRow = rows.find((r) => r.kind === 'run')!;
        expect(runRow.words).not.toContain(p.op);
        expect(runRow.words).toMatch(/run · completed/);
        // the preview is the largest box of Home
        const boxes = await page.$$eval('#ws-home .box', (els) => els.filter((e) => (e as HTMLElement).getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return { stage: Boolean(e.querySelector('#home-stage')), area: r.width * r.height }; }));
        const stage = boxes.find((b) => b.stage)!;
        expect(stage).toBeTruthy();
        for (const b of boxes) if (!b.stage) expect(stage.area).toBeGreaterThan(b.area);

        // the run chosen: its progress, result and receipt, and the image it wrote drawn large
        await page.click(run);
        await page.waitForFunction(() => { const i = document.querySelector('#home-stage .stage-figure img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640; }, null, { timeout: 30_000 });
        const facts = await page.$$eval('#home-stage .stage-fact', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
        expect(facts.find((f) => f.startsWith('Progress'))).toMatch(/^Progress✓ completed · /);
        expect(facts.find((f) => f.startsWith('Result'))).toMatch(/^Result\d+ files? written: .*\bshot\.png\b/);
        expect(facts.find((f) => f.startsWith('Receipt'))).toBe('Receipt✓ sealed and verified on the companion’s server now');
        expect(await page.$eval('#home-stage .stage-verified', (e) => getComputedStyle(e).color)).toBe(GREEN);
        // its ids are behind the stage's Details
        expect(await text(page, '#home-stage .stage-details')).toContain(p.op);
        // a reference image chosen: drawn from the file itself, as it is now (H164's GET /api/journey/file)
        await page.click('#home-work [data-work="reference:refs/newest.png"]');
        await page.waitForFunction(() => { const i = document.querySelector('#home-stage .stage-figure img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640; }, null, { timeout: 30_000 });
        expect(await text(page, '#home-stage .stage-figure figcaption')).toBe('newest.png · 640 × 360 px · as the file is now');
        await page.click(run);
        await page.waitForFunction(() => /^Progress/.test(document.querySelector('#home-stage .stage-fact')?.textContent ?? ''), null, { timeout: 30_000 });
        const seen = await face(page);
        expect(seen).not.toContain(p.op);
        expect(seen).not.toContain('127.0.0.1');
        expect(seen).not.toContain(p.token);
        expect(seen).not.toMatch(/(?:^|\s)\/(?:run|op|open|review|restore|jobs|canvas)\s/);
        expect(seen).not.toContain('.timmy/');

        // Enter on the list opens the run where it belongs: Workflows, its run detail
        await page.focus('#home-work');
        await page.keyboard.press('Enter');
        await page.waitForSelector(`#run-detail .run-view[data-operation="${p.op}"]`, { timeout: 30_000 });
        expect(await page.getAttribute('#ws-tabs [data-ws-tab="workflows"]', 'aria-selected')).toBe('true');
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await closeProject(p); }
  }, 240_000);

  it('an address that names a file of the project selects it and draws it; one outside the project is said in words, and the first item shown', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'home-journey-asked-', records: false });
      const { context, page, errors } = await openPage(browser, p, { width: 1280, height: 720 });
      try {
        const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
        await page.goto(`${p.origin}/?tab=home&file=${hex('out/shot.png')}#t=${p.token}`);
        // drawn from the file itself (H164's GET /api/journey/file), as it is now
        await page.waitForFunction(() => { const i = document.querySelector('#home-stage .stage-figure img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640; }, null, { timeout: 30_000 });
        expect(await text(page, '#home-stage-title')).toMatch(/^Preview · (?:FAKE · )?shot\.png$/);
        expect(await text(page, '#home-stage .stage-figure figcaption')).toBe('shot.png · 640 × 360 px · as the file is now');
        expect(await page.$('#home-stage .stage-notice')).toBeNull();

        // a path outside the project: nothing of it is shown, and the notice says so in words; the newest item is shown
        await page.goto(`${p.origin}/?tab=home&file=${hex('../outside.png')}#t=${p.token}`);
        await page.waitForSelector('#home-stage .stage-notice', { timeout: 30_000 });
        expect(await text(page, '#home-stage .stage-notice')).toMatch(/^The address names a path outside this project/);
        expect(await page.$eval('#home-work [aria-selected="true"]', (e) => e.getAttribute('data-work'))).toBe(await page.$eval('#home-work [data-work]', (e) => e.getAttribute('data-work')));
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await closeProject(p); }
  }, 240_000);

  it('at 390 × 844: nothing scrolls sideways; the preview follows the list, and draws the run chosen', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'home-journey-phone-', records: false });
      const { context, page, errors } = await openPage(browser, p, { width: 390, height: 844 });
      try {
        await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
        const run = `#home-work [data-work-kind="run"][data-op="${p.op}"]`;
        await page.waitForSelector(run, { timeout: 30_000 });
        expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true);
        const order = await page.evaluate(() => [document.getElementById('home-work')!.getBoundingClientRect().top, document.getElementById('home-stage')!.getBoundingClientRect().top]);
        expect(order[1]).toBeGreaterThan(order[0]);
        await page.click(run);
        await page.waitForFunction(() => { const i = document.querySelector('#home-stage .stage-figure img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640; }, null, { timeout: 30_000 });
        const fig = await page.$eval('#home-stage .stage-figure img', (i) => i.getBoundingClientRect().width);
        expect(fig).toBeLessThanOrEqual(390);
        expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await closeProject(p); }
  }, 240_000);
});
