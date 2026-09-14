// lanes/factory/verifiers/playwright.mjs — load the take in headless Chromium: console errors, DOM counts, a screenshot for OCR.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const req = createRequire(import.meta.url);
export const name = 'playwright';
export async function verify(file, prediction, { screenshot } = {}) {
  let pw; try { pw = req('playwright'); } catch { return { name, ran: false, ok: false, detail: 'playwright not resolvable' }; }
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { return { name, ran: false, ok: false, detail: e.message.split('\n')[0].slice(0, 160) }; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
    const resp = await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 30000 });
    const counts = await page.evaluate(() => ({ pages: Math.max(1, document.querySelectorAll('section[data-page]').length), elements: document.querySelectorAll('h1,h2,h3,p,li,button,a,section,img,article').length, named_text: [...document.querySelectorAll('[data-named]')].map((e) => e.getAttribute('data-named')) }));
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    const checks = { loaded: !resp || resp.ok(), no_console_errors: errors.length === 0, pages: counts.pages === prediction.pages, elements: counts.elements === prediction.elements };
    return { name, ran: true, ok: Object.values(checks).every(Boolean), checks, counted: counts, console_errors: errors, screenshot: screenshot ?? null };
  } finally { await browser.close(); }
}
