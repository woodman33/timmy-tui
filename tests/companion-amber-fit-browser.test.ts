/**
 * R7 (H152; DESIGN.md §10 B10, "Amber is exact"; the R5 visual review's 10 and H148's reading of it: amber key hints and
 * commands, "✕ Delete local copy" still amber): amber marks only where to look and act, and every tab is usable at 800×600.
 * In a real headless Chromium against the real companion server and its token, at 1376×768 and 800×600, on every tab:
 *
 *  - every element painted amber (#FFB000: its text, border, background, outline, or an SVG's fill or stroke) is one of B10's
 *    roles: the active tab, focus, the selection, the one primary next step, .intent and .predict, what waits for you, or a
 *    failure said with ✕ and its word; a key, a command, a destructive button and a FAKE mark are never amber;
 *  - each screen has exactly one amber-filled primary next step (the strip's), or none where the frame gives none;
 *  - the page never scrolls sideways; every box and the tab strip lie inside the window; no tab label, box title or button
 *    is cut (a line that shortens itself keeps its whole words in its title).
 *
 * Real: the server, its token, the page's code, a /run in the REPL's own Workspace (upmd is the TEST DOUBLE of
 * tests/helpers/ops-sandbox.ts, labelled FAKE there). FAKE, labelled: the VoxVision records (tests/helpers/companion-page-kit.ts).
 */
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { opsKit } from './helpers/ops-sandbox.js';
import { browserPath, closeProject, launchBrowser, openPage, pageProject, showTab, SIZES, TAB_KEYS, type PageProject, landWorkspace } from './helpers/companion-page-kit.js';

if (!browserPath) console.warn('companion-amber-fit-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

interface Amber { role: string; tag: string; cls: string; text: string; how: string[] }

/** Every rendered element painted amber, with the B10 role it plays ('' when none). */
const ambers = (page: Page): Promise<Amber[]> => page.evaluate(() => {
  const AMBER = 'rgb(255, 176, 0)';
  const ownText = (el: Element): string => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
  const within = (el: Element, sel: string): boolean => el.closest(sel) !== null;
  const roles: Array<[string, (el: Element) => boolean]> = [
    // R10 CHAT (H171): the shell's left menu marks the destination shown (the old tab row is not drawn on Chat)
    ['the active tab', (el) => (within(el, '#ws-tabs [role="tab"][aria-selected="true"]') && !within(el, '.tab-waiting')) || within(el, '#rail-menu .rail-item[aria-current="page"]')],
    // R10 CHAT (H171): the Models rail's search and filters draw their focus on their box
    // R11 (H171): the composer's field draws its focus on its box too
    ['focus', (el) => el.matches(':focus-visible') || el.matches('.cm-search:focus-within, .cm-filter:focus-within, .cx-composer:focus-within, .rail-find:focus')],
    // the strip's primary; on tab 9, where the strip gives none, the inspector's own one primary action (H142). R10 CHAT (H171):
    // on Chat, the composition's: Send, the first run's suggested way, or the no-model state's Choose a model
    ['the one primary next step', (el) => within(el, '#ws-actions .act.is-primary, #ws-tools .tools-go.is-primary, .cx-send:not(.is-muted):not(:disabled), .cx-btn.is-primary, .cx-way.is-suggested')],
    ['the selection', (el) => within(el, '[aria-current="true"], [aria-pressed="true"], [aria-selected="true"]:not([role="tab"]), .is-selected, .is-picked, .is-shown, .view-btn.active, .cm-providers [role="tab"][aria-selected="true"]')],
    ['.intent or .predict', (el) => within(el, '.is-intent, .is-predict, .rd-before, [data-stage="predict"], [data-stage="intent"], .tone-intent, .log-msg.user, .sd-user')],
    // R11 (H171): the model chip's dot while this page checks a model (amber, with its word "checking…")
    ['what waits for you', (el) => within(el, '.tab-waiting, .waits, #token-note, .tools-needs, .sd-approval, .tools-rule.is-waiting, #mirror-status[data-state="reconnecting"], #mirror-status[data-state="restored"], .mirror-note, .saved-banner, .sb-draft, .tone-setup, .st-needs-setup, .cx-dot[data-state="checking"], .cx-spin')],
    ['a failure, with ✕ and its word', (el) => within(el, '.tone-failed, .is-failed, .run-error, .canvas-fail, .conn-state.is-failed, [data-state="failed"], .tools-attn, .tools-refused, .tools-fielderr, .is-invalid, .log-level.error, .sb-thumb-failed, .st-failed, .tone-failure')],
  ];
  const out: Array<{ role: string; tag: string; cls: string; text: string; how: string[] }> = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!(el as HTMLElement).getClientRects || !(el as HTMLElement).getClientRects().length) continue;
    // off the window's side (the skip link, drawn only with focus): not on screen; below the fold is on the page
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= document.documentElement.clientWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') continue;
    const how: string[] = [];
    if (cs.color === AMBER && ownText(el)) how.push('text');
    if (cs.backgroundColor === AMBER) how.push('fill');
    if (['Top', 'Right', 'Bottom', 'Left'].some((s) => cs.getPropertyValue(`border-${s.toLowerCase()}-color`) === AMBER && cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none' && parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0)) how.push('border');
    if (cs.outlineStyle !== 'none' && cs.outlineColor === AMBER && parseFloat(cs.outlineWidth) > 0) how.push('outline');
    if (el instanceof SVGElement && (cs.fill === AMBER || cs.stroke === AMBER)) how.push('svg');
    if (!how.length) continue;
    const role = roles.find(([, test]) => test(el))?.[0] ?? '';
    const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : ((el as SVGElement).className as unknown as SVGAnimatedString).baseVal;
    out.push({ role, tag: el.tagName.toLowerCase(), cls, text: (ownText(el) || (el.textContent ?? '')).replace(/\s+/g, ' ').trim().slice(0, 50), how });
  }
  return out;
});

/** Keys, commands and FAKE marks drawn in amber (text or border): none should be. */
const amberWords = (page: Page) => page.evaluate(() => {
  const AMBER = 'rgb(255, 176, 0)';
  return [...document.querySelectorAll('.tab-key, kbd, .cmd, code, .act-cmd, .rv-cmd-now, .vox-act-cmd, .btn-action.danger, .vox-tag-fake, .vox-fake, .sb-fake')]
    .filter((el) => (el as HTMLElement).getClientRects().length > 0 && !el.closest('#ws-actions .act.is-primary'))
    .filter((el) => { const cs = getComputedStyle(el); return cs.color === AMBER || cs.borderTopColor === AMBER && cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0; })
    .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}: ${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}`);
});

/** What is cut or out of the window: a sideways scroll, a box or tab outside, a label, title or button cut without its words. */
const fit = (page: Page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const out: string[] = [];
  if (document.documentElement.scrollWidth > W + 1) out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} > ${W}`);
  if (document.body.scrollWidth > W + 1) out.push(`the body scrolls sideways: ${document.body.scrollWidth} > ${W}`);
  const shownPage = document.querySelector('.ws-page:not([hidden])');
  const scope = [...document.querySelectorAll('#ws-tabs [role="tab"], #ws-strip, .ws-header, #ws-activity'), ...(shownPage ? shownPage.querySelectorAll('.box, .unfinished') : [])];
  for (const el of scope) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.left < -0.5 || r.right > W + 0.5)) out.push(`outside the window: ${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  const cut = (el: Element): boolean => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1;
  const visible = (el: Element): boolean => (el as HTMLElement).getClientRects().length > 0;
  for (const el of document.querySelectorAll('#ws-tabs .tab-label')) if (visible(el) && cut(el)) out.push(`tab label cut: ${el.textContent}`);
  const where = shownPage ? [shownPage, document.querySelector('#ws-strip')!] : [document.querySelector('#ws-strip')!];
  for (const root of where) {
    for (const el of root.querySelectorAll('.box-title, .strip-title, button, .act, .cmd')) {
      if (!visible(el) || !cut(el)) continue;
      const words = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const title = el.getAttribute('title') ?? '';
      if (!title || !title.replace(/\s+/g, ' ').includes(words.replace(/…$/, ''))) out.push(`cut without its words in its title: ${el.tagName.toLowerCase()}.${(el as HTMLElement).className} "${words.slice(0, 60)}"`);
    }
  }
  return out;
});

describe.skipIf(!browserPath)('amber is exact and every tab fits, at 1376×768 and 800×600 (R7 H152, B10)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('on every tab: each amber element has a B10 role, one amber primary at most, nothing cut, nothing outside the window', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'amber-fit-browser-' });
      const report: Record<string, { ambers: Amber[]; primaries: number; fit: string[]; words: string[] }> = {};
      for (const size of SIZES) {
        const at = `${size.width}x${size.height}`;
        const { context, page, errors } = await openPage(browser, p, size);
        try {
          await page.goto(`${p.origin}/?tab=home#t=${p.token}`);
          await landWorkspace(page);
          await page.waitForSelector('#ws-actions .act', { timeout: 30_000 });
          await page.waitForFunction(() => document.querySelectorAll('#home-preview [data-home-image] img').length === 2, null, { timeout: 30_000 });
          for (const [key, id] of TAB_KEYS) {
            await showTab(page, key, id);
            if (id === 'voxvision') await page.waitForFunction(() => document.querySelectorAll('[data-vox="stage"] .vox-label').length > 0, null, { timeout: 15_000 });
            if (id === 'workflows') await page.waitForSelector('#run-detail .run-view[data-inspected="true"]', { timeout: 30_000 });
            // the keyboard's place: off the page, so focus draws no ring here (focus is read on its own below)
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            const list = await ambers(page);
            // R10 CHAT (H171): on Chat the strip is behind the composition, whose one primary is its own (an amber fill too)
            const primaries = await page.$$eval('#ws-actions .act.is-primary, .act.is-primary, .tools-go.is-primary, .cx-send, .cx-btn.is-primary, .cx-way-act', (els) => els.filter((e) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).backgroundColor === 'rgb(255, 176, 0)').length);
            report[`${at} tab ${key} ${id}`] = { ambers: list, primaries, fit: size.width === 800 ? await fit(page) : [], words: await amberWords(page) };
            // with TIMMY_CAPTURE_DIR, each tab as measured (the window's view; at 800x600 the page's top, it scrolls on)
            if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: `${process.env.TIMMY_CAPTURE_DIR}/tab${key}-${id}-${at}.png` });
            if (id === 'chat') {
              // the chat tab's other view, this page's own chat (its Send is the composer's amber words, not a fill)
              await page.click('#btn-streamdown');
              await page.waitForSelector('#tab-streamdown.active #streamdown-root > *', { timeout: 20_000 });
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
              report[`${at} tab ${key} ${id} · Ask a model here`] = { ambers: await ambers(page), primaries: 0, fit: size.width === 800 ? await fit(page) : [], words: await amberWords(page) };
              await page.click('#btn-chat');
            }
          }
          expect(errors, at).toEqual([]);
        } finally { await context.close(); }
      }
      expect(Object.keys(report)).toHaveLength(SIZES.length * (TAB_KEYS.length + 1));
      for (const [k, v] of Object.entries(report)) {
        // each amber element plays a B10 role; no key, command, destructive button or FAKE mark is amber
        expect(v.ambers.filter((a) => !a.role), `${k}: amber with no B10 role`).toEqual([]);
        expect(v.words, `${k}: amber keys, commands, Delete or FAKE`).toEqual([]);
        // one amber-filled primary next step at most
        expect(v.primaries, `${k}: amber primaries`).toBeLessThanOrEqual(1);
        // at 800x600: no sideways scroll, nothing outside the window, nothing cut without its words
        expect(v.fit, `${k}: fit`).toEqual([]);
      }
      // the tabs whose frame gives a primary next step show exactly one, at both sizes; every screen's active tab is amber
      for (const size of SIZES) {
        for (const id of ['home', 'chat', 'workflows', 'studio', 'voxvision', 'tools']) {
          const k = Object.keys(report).find((x) => x.startsWith(`${size.width}x${size.height} tab `) && x.endsWith(` ${id}`))!;
          expect(report[k].primaries, k).toBe(1);
        }
      }
      for (const [k, v] of Object.entries(report)) expect(v.ambers.some((a) => a.role === 'the active tab'), k).toBe(true);
    } finally { await closeProject(p); }
  }, 240_000);
});
