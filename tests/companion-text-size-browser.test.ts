/**
 * R7 (H152; the R6 package's defect 17, the visual review's #7: "2–19 elements on every companion screen are 10–10.5 px,
 * below the 11 px floor"; DESIGN.md §10 B9): every text the companion draws is 11 px or more on screen. In a real headless
 * Chromium against the real companion server and its token, at 1376×768 and at 800×600, it visits every tab (keys 1 to 9,
 * then 0), the run detail opened by its address, and an image shown at size, and reads the computed size of every rendered
 * text node, of every ::before and ::after content and of every placeholder (an SVG's text at the scale it is drawn): none
 * is under 11 px. The companion has no Keys list of its own (the `?` Keys list is the Workbench's), so there is none to read.
 *
 * Real: the server, its token, the page's code, a /run in the REPL's own Workspace (upmd is the TEST DOUBLE of
 * tests/helpers/ops-sandbox.ts, labelled FAKE there). FAKE, labelled: the VoxVision records and their images
 * (tests/helpers/companion-page-kit.ts).
 */
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { opsKit } from './helpers/ops-sandbox.js';
import { browserPath, closeProject, launchBrowser, openPage, pageProject, showTab, SIZES, smallText, TAB_KEYS, type PageProject, type SmallText, landWorkspace } from './helpers/companion-page-kit.js';

if (!browserPath) console.warn('companion-text-size-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

describe.skipIf(!browserPath)('the companion\'s text is 11 px or more on every screen, at 1376×768 and 800×600 (R7 H152, B9)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('every tab, the run detail and an image at size: no rendered text under 11 px', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'text-size-browser-' });
      const small: Record<string, SmallText[]> = {};
      for (const size of SIZES) {
        const at = `${size.width}x${size.height}`;
        const { context, page, errors } = await openPage(browser, p, size);
        try {
          await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
          await landWorkspace(page);
          await page.waitForSelector('#ws-actions .act', { timeout: 30_000 });
          // Home's newest images drawn (the run's and the newest VoxVision record's)
          await page.waitForFunction(() => document.querySelectorAll('#home-preview [data-home-image] img').length === 2, null, { timeout: 30_000 });
          for (const [key, id] of TAB_KEYS) {
            await showTab(page, key, id);
            if (id === 'voxvision') await page.waitForFunction(() => document.querySelectorAll('[data-vox="stage"] .vox-label').length > 0, null, { timeout: 15_000 });
            if (id === 'workflows') await page.waitForSelector('#run-detail .run-view[data-inspected="true"]', { timeout: 30_000 });
            small[`${at} tab ${key} ${id}`] = await smallText(page);
            if (id === 'chat') {
              // the chat tab's other view: this page's own chat with a model (the Streamdown island)
              await page.click('#btn-streamdown');
              await page.waitForSelector('#tab-streamdown.active #streamdown-root > *', { timeout: 20_000 });
              small[`${at} tab ${key} ${id} · Ask a model here`] = await smallText(page);
              await page.click('#btn-chat');
            }
          }
          // an image at size (Home's newest run image)
          await showTab(page, '1', 'home');
          await page.click('#home-preview [data-home-image="run"] .home-thumb-btn');
          await page.waitForSelector('dialog.enlarge[open]');
          small[`${at} the image at size`] = await smallText(page);
          await page.keyboard.press('Escape');
          // the run detail opened by its address (as a Workbench or Studio link names it), with the page's token
          await page.goto(`${p.origin}/run/${p.op}#t=${p.token}`);
          await landWorkspace(page);
          await page.waitForSelector(`#run-detail .run-view[data-operation="${p.op}"][data-inspected="true"]`, { timeout: 30_000 });
          small[`${at} the run detail /run/${p.op}`] = await smallText(page);
          expect(errors, at).toEqual([]);
        } finally { await context.close(); }
      }
      // every screen read something, and none has a text under 11 px
      expect(Object.keys(small)).toHaveLength(SIZES.length * (TAB_KEYS.length + 3));
      const under = Object.entries(small).filter(([, list]) => list.length > 0);
      expect(Object.fromEntries(under)).toEqual({});
    } finally { await closeProject(p); }
  }, 240_000);
});
