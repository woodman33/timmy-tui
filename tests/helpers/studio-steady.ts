/**
 * R10 (H172): a press in Studio's side panel made once the panel stands still, for the Studio browser tests.
 *
 * On the first page after a Studio server starts, the workspace strip's first frame can arrive after the Project panel's first
 * cards (it is built cold). Drawing it grows the strip from 55 to 75 px and moves the whole side panel down 20 px. A press whose
 * release comes after that move lands on whatever is above the button, the click goes to their common parent, and nothing is
 * pressed. Playwright checks a click's target only as the button goes down, so the lost press still counts as a click made.
 * Shown on 052fbde8's final check (tests/studio-used-values-browser.test.ts, which keeps its own copy of these helpers).
 *
 * `steady` waits until all of these hold: the strip has drawn a frame (#frame[data-revision]); the panel sits under it (--frame-h
 * is the strip's height, #side's top is that + 52 px); the Artifacts, Reference images and Nodes lists have read their project;
 * and the button is shown and its box, and the list region's scroll, have held for 5 frames. Each call counts its own frames.
 */
import type { Page } from 'playwright';

let calls = 0;

export async function steady(page: Page, sel: string): Promise<void> {
  const call = ++calls;
  await page.waitForFunction(([s, c]) => {
    const w = window as unknown as { __steady?: { key: string; n: number; why?: string } };
    const not = (why: string) => { w.__steady = { key: '', n: 0, why }; return false; };
    const strip = document.getElementById('frame');
    const side = document.getElementById('side');
    const b = document.querySelector(s);
    if (!strip || strip.hidden || !strip.dataset.revision) return not('the workspace strip has drawn no frame yet');
    if (!side || !b) return not(`no ${s}`);
    const fh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-h')) || 0;
    if (Math.abs(fh - Math.ceil(strip.getBoundingClientRect().height)) > 1 || Math.abs(side.getBoundingClientRect().top - (fh + 52)) > 1) return not('the panel is not under the strip yet');
    for (const id of ['artifacts-name', 'references-name', 'nodes-name']) if (/reading…$/.test(document.getElementById(id)?.textContent ?? '')) return not(`#${id} is still reading`);
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return not(`${s} is not shown yet`);
    // (this call's own count: the frames counted for an earlier press never count for this one)
    const key = `${c}|${[r.top, r.left, r.width, r.height, document.getElementById('side-scroll')?.scrollTop ?? 0].map((v) => Math.round(v * 10)).join(',')}`;
    if (!w.__steady || w.__steady.key !== key) { w.__steady = { key, n: 1 }; return false; }
    w.__steady.n += 1;
    return w.__steady.n >= 5;
  }, [sel, call] as const, { polling: 'raf', timeout: 20_000 }).catch(async (e: unknown) => {
    const why = await page.evaluate(() => (window as unknown as { __steady?: { why?: string } }).__steady?.why ?? 'its box kept moving').catch(() => 'not read');
    throw new Error(`${String(e).split('\n')[0]}: the panel did not stand still before ${sel} was pressed (${why})`);
  });
}

/** `sel` pressed once the panel stands still. */
export async function press(page: Page, sel: string): Promise<void> {
  await steady(page, sel);
  await page.click(sel);
}

/** By kind or By operation, pressed once the panel stands still; the page's own aria-pressed says the press took. */
export async function groupBy(page: Page, by: 'kind' | 'operation'): Promise<void> {
  const sel = `#project-by button[data-by="${by}"]`;
  await press(page, sel);
  await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', sel, { timeout: 5_000 })
    .catch((e: unknown) => { throw new Error(`${String(e).split('\n')[0]}: the By ${by} press did not take (its aria-pressed stayed false)`); });
}
