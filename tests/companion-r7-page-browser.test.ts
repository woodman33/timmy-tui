/**
 * R7 (H152): the companion page's R7 states, in a real headless Chromium against the real companion server and its token,
 * each read from what the page shows (its words, values and the targets of its actions):
 *
 *  - Home's newest images (the R6 interaction review's N9, the package's defect 14: Home followed the newest run only): with a
 *    run that wrote an image and a newer one that wrote none, and a newer VoxVision record that observed no image, Home still
 *    shows the run's image and the record's, each naming its run or record, saying what ran after it, and opening it;
 *  - /run/<op> typed by hand (N7, defect 12): it has no token, by design (the token is kept nowhere: no storage, no cookie),
 *    and its words name the Workbench's c on the run, `timmy watch`'s q on HOME, and this page's Operation id box, which
 *    opens the run once the page has its token; ?run=<op> beside the token opens that run on Workflows;
 *  - the unfinished tabs (the operator's order of 2026-10-16, 22:08 PT): 6, 7, 8 and 0 are marked in the tab strip by a dashed
 *    border and ◌ (not by a colour alone), and each opens with an "Unfinished" box above its content in the frame's own words
 *    (src/contracts/workspace.ts TabDef.unfinished), in structure and text colours; the other tabs have neither.
 *
 * Real: the server, its token, the page's code, the frame, the runs (a /run in the REPL's own Workspace; upmd is the TEST
 * DOUBLE of tests/helpers/ops-sandbox.ts, labelled FAKE there). FAKE, labelled: the VoxVision records and their images
 * (tests/helpers/companion-page-kit.ts; the record with no image below).
 */
import { utimesSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TABS } from '../src/contracts/workspace.js';
import { folderProject } from '../src/project/index.js';
import { opsKit } from './helpers/ops-sandbox.js';
import { runOf } from './helpers/run-inspect-fixture.js';
import { sealRecord, writeFile } from './helpers/vox-panel-kit.js';
import { browserPath, closeProject, launchBrowser, openPage, pageProject, shotDoc, showTab, SIZES, type PageProject } from './helpers/companion-page-kit.js';

if (!browserPath) console.warn('companion-r7-page-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);
const text = (page: Page, sel: string): Promise<string> => page.$eval(sel, (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

/** FAKE: a VoxVision record of a text file, newer than the image records: it observed no image (written and sealed; no tool ran). */
function noImageRecord(root: string): void {
  const notes = writeFile(root, 'refs/notes.txt', 'FAKE: a text file, not an image (tests/companion-r7-page-browser.test.ts)\n');
  sealRecord(root, {
    schema: 'timmy.vox/1', id: 'vfa4e0b18', action: 'inspect', command: '/inspect refs/notes.txt', made_at: '2026-10-16T12:10:00.000Z', project: folderProject(root).name, status: 'ok',
    inputs: [{ ...notes, kind: 'text', kind_by: 'name' }], tools: [{ tool: 'look', name: 'timmy-look', version: 'fake', ran: 'job', job: { id: 'j0fa4e4', state: 'completed', exit_code: 0 } }],
    metrics: [], highlights: [], failures: [], notes: ['FAKE: a test fixture (tests/companion-r7-page-browser.test.ts): no image was observed and no tool ran.'],
  });
}

describe.skipIf(!browserPath)('the companion page\'s R7 states (H152)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('Home shows the newest images the records hold, whatever ran after: the run\'s and the record\'s, each named, said, and opening it', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'home-images-browser-' });
      noImageRecord(p.s.root);
      const { context, page, errors } = await openPage(browser, p, SIZES[0]);
      try {
        await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
        const figs = '#home-preview [data-preview="images"]';
        await page.waitForFunction((sel) => document.querySelectorAll(`${sel} figure[data-home-image] img`).length === 2, figs, { timeout: 30_000 });
        // a newer run, while Home is on screen, that writes no image
        writeFile(p.s.root, 'NOPIC.md', shotDoc('nopic'));
        // R10 (H163; this case failed on CI's fast runners only): it starts less than a second after out/shot.png was written,
        // as it does on a fast machine. Only the image's time is set (0.3 s before now; its bytes stay the SHOT run's). Up to R10
        // the newer run's receipt then claimed out/shot.png as its own output, so Home's run image named the newer run, newer 0
        const shotAt = (Date.now() - 300.5) / 1000;
        utimesSync(path.join(p.s.root, 'out', 'shot.png'), shotAt, shotAt);
        const { op: newer } = await runOf(p.ws, 'NOPIC.md', 'nopic');
        // Home's newest run is that one now ...
        await page.waitForFunction((op) => document.querySelector('#home-preview [data-preview="run"] [data-open-run]')?.getAttribute('data-open-run') === op, newer, { timeout: 20_000 });
        // ... and its images are still the newest ones the records hold, each saying what ran after it. R10 (H171; CI at 5072a81
        // and a88ede0): both read once both are drawn. The page asks the run's image and the record's apart, and when its first
        // frame was drawn before the companion's welcome named the project, the first frame drawn after it (here: the newer
        // run's) asks both again: the run's answer (one request) came back and was drawn before the record's (three, and its
        // image read into the page), so a read on the run's alone found the run's figure only.
        await page.waitForFunction((sel) => ['run', 'vox'].every((k) => {
          const fig = document.querySelector(`${sel} figure[data-home-image="${k}"]`);
          const img = fig?.querySelector('img');
          return fig?.getAttribute('data-newer') === '1' && img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
        }), figs, { timeout: 20_000 });
        const shown = await page.$$eval(`${figs} [data-home-image]`, (els) => els.map((e) => ({
          kind: e.getAttribute('data-home-image'), tag: e.tagName.toLowerCase(), newer: e.getAttribute('data-newer'),
          words: (e.querySelector('figcaption')?.textContent ?? '').trim(), note: (e.querySelector('.home-thumb-note')?.textContent ?? '').trim(),
          open: e.querySelector('[data-open-run]')?.getAttribute('data-open-run') ?? e.querySelector('[data-open-vox]')?.getAttribute('data-open-vox') ?? null,
          drawn: (e.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? 0,
        })));
        expect(shown).toEqual([
          // (R10 H167, H168's F3 on the page: in words, each file by its name; the run's and the record's ids are their Open's)
          { kind: 'run', tag: 'figure', newer: '1', words: 'run · shot.png · 640 × 360', note: 'the newest run that holds an image: 1 newer run holds none', open: p.op, drawn: 640 },
          { kind: 'vox', tag: 'figure', newer: '1', words: 'VoxVision · detect · newest.png', note: 'the newest record with an image: 1 newer record observed none it can show', open: 'vfa4e0b17', drawn: 640 },
        ]);
        // its Open opens that run (not the newest) in Workflows
        await page.click(`${figs} [data-open-run="${p.op}"]`);
        await page.waitForSelector(`#run-detail .run-view[data-operation="${p.op}"]`, { timeout: 30_000 });
        expect(await page.getAttribute('#ws-tabs [data-ws-tab="workflows"]', 'aria-selected')).toBe('true');
        if (process.env.TIMMY_CAPTURE_DIR) {
          await page.keyboard.press('1');
          await page.waitForSelector(`${figs} figure[data-home-image="run"]`);
          await page.screenshot({ path: `${process.env.TIMMY_CAPTURE_DIR}/home-newest-images-after-a-run-without-one-1376x768.png` });
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await closeProject(p); }
  }, 180_000);

  it('/run/<op> typed by hand: no token, by design, and words that name the Workbench\'s c, timmy watch\'s q on HOME and the Operation id box; ?run=<op> with the token opens it', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'run-address-browser-', records: false });
      const { context, page, errors } = await openPage(browser, p, SIZES[0]);
      try {
        // the page opened from Timmy (its token in the fragment): the token is taken out of the address and kept nowhere
        await page.goto(`${p.origin}/?tab=workflows#t=${p.token}`);
        await page.waitForSelector('#ws-actions .act', { timeout: 30_000 });
        expect(page.url()).not.toContain(p.token);
        const kept = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
        expect(kept).not.toContain(p.token);
        expect(await context.cookies()).toEqual([]);

        // the run's address typed by hand: a new page load, with no token
        await page.goto(`${p.origin}/run/${p.op}`);
        await page.waitForSelector('#run-detail [data-run="no-token"]', { timeout: 15_000 });
        const words = await text(page, '#run-detail [data-run="no-token"]');
        expect(words).toContain(`Run ${p.op} was not read: this page has no token.`);
        expect(words).toContain(`an address typed or opened by hand, as /run/${p.op} was, carries none.`);
        expect(words).toContain('in the Workbench (timmy workbench), select the run on its Workflows tab (3) and press c: this page opens there with its token.');
        expect(words).toContain('Or in timmy watch, press q on HOME, which shows the address with its token.');
        expect(words).toContain(`Then type ${p.op} in this page’s Operation id box, above, and press Open its run detail.`);
        // the box it names is there, with the id in it, and the note at the top says both ways too
        expect(await page.inputValue('#run-op')).toBe(p.op);
        expect(await page.isVisible('#run-open')).toBe(true);
        expect(await text(page, '#token-note')).toMatch(/no token from Timmy.*in the Workbench \(`timmy workbench`\), press c.*in `timmy watch`, press q on HOME/);
        expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]))).not.toContain(p!.token);

        // opened from Timmy with the run named beside the tab (?run=<op>): that run's detail on Workflows
        await page.goto(`${p.origin}/?tab=workflows&run=${p.op}#t=${p.token}`);
        await page.waitForSelector(`#run-detail .run-view[data-operation="${p.op}"][data-inspected="true"]`, { timeout: 30_000 });
        expect(await page.getAttribute('#ws-tabs [data-ws-tab="workflows"]', 'aria-selected')).toBe('true');
        // and the Operation id box opens a run once the page has its token (R10 H167: behind its Details control, opened as a
        // person opens it)
        expect(await page.$eval('#run-by-id', (d) => (d as HTMLDetailsElement).open)).toBe(false);
        await page.click('#run-by-id > summary');
        await page.fill('#run-op', p.op);
        await page.click('#run-open');
        await page.waitForSelector(`#run-detail .run-view[data-operation="${p.op}"]`, { timeout: 30_000 });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await closeProject(p); }
  }, 180_000);

  it('tabs 6, 7, 8 and 0: marked unfinished in the strip without a colour alone, and opening with the frame\'s Unfinished box above their content, at 1376×768 and 800×600', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'unfinished-browser-', records: false });
      for (const size of SIZES) {
        const at = `${size.width}x${size.height}`;
        const { context, page, errors } = await openPage(browser, p, size);
        try {
          await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
          await page.waitForSelector('#ws-tabs [data-ws-tab="logs"][data-unfinished="true"]', { timeout: 30_000 });
          for (const t of TABS) {
            const tab = await page.$eval(`#ws-tabs [data-ws-tab="${t.id}"]`, (b) => ({
              marked: b.getAttribute('data-unfinished'), border: getComputedStyle(b).borderTopStyle,
              glyph: (b.querySelector('.tab-unfinished')?.textContent ?? '').trim(), described: b.getAttribute('aria-description'),
            }));
            if (t.unfinished) {
              expect(tab, `${at} tab ${t.key}`).toEqual({ marked: 'true', border: 'dashed', glyph: '◌', described: `unfinished: works now: ${t.unfinished.works}; not yet: ${t.unfinished.missing}` });
            } else {
              expect(tab, `${at} tab ${t.key}`).toEqual({ marked: null, border: 'solid', glyph: '', described: null });
            }
            await showTab(page, t.key, t.id);
            const box = await page.evaluate((id) => {
              const page = document.querySelector(`[data-ws-page="${id}"]`)!;
              const b = page.querySelector(':scope > .unfinished') as HTMLElement | null;
              if (!b) return null;
              const next = b.nextElementSibling as HTMLElement | null;
              const c = (sel: string): string => getComputedStyle(b.querySelector(sel)!).color;
              return {
                first: page.firstElementChild === b,
                above: next ? b.getBoundingClientRect().bottom <= next.getBoundingClientRect().top + 0.5 : true,
                title: (b.querySelector('.unfinished-title')?.textContent ?? '').trim(),
                works: (b.querySelector('[data-unfinished-part="works"]')?.textContent ?? '').trim(),
                missing: (b.querySelector('[data-unfinished-part="missing"]')?.textContent ?? '').trim(),
                colours: { border: getComputedStyle(b).borderTopColor, style: getComputedStyle(b).borderTopStyle, title: c('.unfinished-title'), line: c('.unfinished-line'), key: c('.unfinished-k'), ground: getComputedStyle(b).backgroundColor },
              };
            }, t.id);
            if (!t.unfinished) { expect(box, `${at} tab ${t.key}: no Unfinished box`).toBeNull(); continue; }
            expect(box, `${at} tab ${t.key}`).toEqual({
              first: true, above: true, title: `◌ Unfinished · ${t.label}`, works: `Works now: ${t.unfinished.works}`, missing: `Not yet: ${t.unfinished.missing}`,
              // structure and text colours (B10): #444444, #F2EFE9, #8E8E93 on the canvas; never amber or green
              colours: { border: 'rgb(68, 68, 68)', style: 'dashed', title: 'rgb(242, 239, 233)', line: 'rgb(242, 239, 233)', key: 'rgb(142, 142, 147)', ground: 'rgb(0, 0, 0)' },
            });
            if (process.env.TIMMY_CAPTURE_DIR && t.id === 'control') await page.screenshot({ path: `${process.env.TIMMY_CAPTURE_DIR}/unfinished-tab7-${at}.png` });
          }
          expect(errors, at).toEqual([]);
        } finally { await context.close(); }
      }
    } finally { await closeProject(p); }
  }, 180_000);
});
