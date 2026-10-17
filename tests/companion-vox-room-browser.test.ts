/**
 * R7 (H152; the R6 package's defect 16, the visual review's #6: "the VoxVision viewport is squeezed to 48% at 1376×768, and
 * its labels overlap the image's red text"): VoxVision's viewport gives the image the room it needs, at its own aspect, and
 * draws what each mark is on a band outside the image, tied to its mark. In a real headless Chromium against the real
 * companion server and its token, with the newest FAKE record's 640 × 360 image (its region and centroid measured over it):
 *
 *  - the share stated: at 1376×768 the image's drawn box is at least 25% of the VoxVision panel's area (it was about 9%,
 *    drawn at 48% of its size), and the viewport is the panel's largest box; at 800×600 (one column, the page scrolls) the
 *    image is drawn at least 75% of the window's width;
 *  - the image keeps its own aspect (within a pixel);
 *  - no label's box overlaps the image's drawn area;
 *  - each label keeps its words (`<what> · <provenance> · <evidence>`), is 11 px or more, names its mark, and is joined to it
 *    by a leader line (one end on the label's edge, the other on the mark's bounds); pressing it selects its entity, and the
 *    label, its line and its mark turn amber.
 *
 * Real: the server, its token, the page's code, a /run in the REPL's own Workspace (upmd is the TEST DOUBLE of
 * tests/helpers/ops-sandbox.ts, labelled FAKE there). FAKE, labelled: the VoxVision records and their images
 * (tests/helpers/companion-page-kit.ts).
 */
import type { Page } from 'playwright';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { opsKit } from './helpers/ops-sandbox.js';
import { browserPath, closeProject, launchBrowser, openPage, pageProject, SIZES, type PageProject } from './helpers/companion-page-kit.js';

if (!browserPath) console.warn('companion-vox-room-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const AMBER = 'rgb(255, 176, 0)';
const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

type Rect = [number, number, number, number];
interface Room {
  natural: [number, number];
  drawn: Rect;
  panel: Rect;
  boxes: Array<{ name: string; area: number }>;
  labels: Array<{ for: string; text: string; r: Rect; px: number }>;
  marks: Array<{ id: string; r: Rect }>;
  leaders: Array<{ for: string; a: [number, number]; b: [number, number] }>;
}

/** What the viewport shows now, in the window's pixels: the image's drawn box (as object-fit contain draws it in its element). */
const measure = (page: Page): Promise<Room> => page.evaluate(() => {
  const rect = (r: DOMRect): [number, number, number, number] => [r.left, r.top, r.right, r.bottom];
  const img = document.querySelector('.vox-img') as HTMLImageElement;
  const ir = img.getBoundingClientRect();
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const s = Math.min(ir.width / W, ir.height / H);
  const dw = W * s;
  const dh = H * s;
  const drawn: [number, number, number, number] = [ir.left + (ir.width - dw) / 2, ir.top + (ir.height - dh) / 2, ir.left + (ir.width + dw) / 2, ir.top + (ir.height + dh) / 2];
  const lead = document.querySelector('.vox-leaders') as SVGSVGElement | null;
  const lr = lead ? lead.getBoundingClientRect() : null;
  const vb = lead ? (lead.getAttribute('viewBox') ?? '0 0 1 1').split(' ').map(Number) : [0, 0, 1, 1];
  const kx = lr ? lr.width / (vb[2] || 1) : 1;
  const ky = lr ? lr.height / (vb[3] || 1) : 1;
  return {
    natural: [W, H],
    drawn,
    panel: rect(document.querySelector('.vox-cols')!.getBoundingClientRect()),
    boxes: [...document.querySelectorAll<HTMLElement>('.vox-cols .box')].filter((b) => !b.hidden && b.getClientRects().length > 0)
      .map((b) => { const r = b.getBoundingClientRect(); return { name: b.dataset.voxBox ?? '', area: Math.round(r.width * r.height) }; }),
    labels: [...document.querySelectorAll<Element>('[data-vox="stage"] .vox-label, .vox-overlay .ov-label')].map((l) => ({
      for: l.getAttribute('data-label-for') ?? '', text: (l.textContent ?? '').replace(/\s+/g, ' ').trim(), r: rect(l.getBoundingClientRect()),
      px: parseFloat(getComputedStyle(l).fontSize) * (l instanceof SVGGraphicsElement ? Math.hypot(l.getScreenCTM()!.a, l.getScreenCTM()!.b) : 1),
    })),
    marks: [...document.querySelectorAll<SVGGraphicsElement>('.vox-overlay .ov')].map((m) => ({ id: m.getAttribute('data-overlay') ?? '', r: rect(m.getBoundingClientRect()) })),
    leaders: lr ? [...lead!.querySelectorAll('line')].map((l) => ({
      for: l.getAttribute('data-label-for') ?? '',
      a: [lr.left + Number(l.getAttribute('x1')) * kx, lr.top + Number(l.getAttribute('y1')) * ky] as [number, number],
      b: [lr.left + Number(l.getAttribute('x2')) * kx, lr.top + Number(l.getAttribute('y2')) * ky] as [number, number],
    })) : [],
  };
});

const area = (r: Rect): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const overlaps = (a: Rect, b: Rect, tol = 0.5): boolean => a[0] < b[2] - tol && a[2] > b[0] + tol && a[1] < b[3] - tol && a[3] > b[1] + tol;
const within = (p: [number, number], r: Rect, tol: number): boolean => p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol;
const onEdge = (p: [number, number], r: Rect, tol = 1.5): boolean => within(p, r, tol)
  && (Math.abs(p[0] - r[0]) <= tol || Math.abs(p[0] - r[2]) <= tol || Math.abs(p[1] - r[1]) <= tol || Math.abs(p[1] - r[3]) <= tol);

describe.skipIf(!browserPath)('VoxVision\'s preview: room for the image at its own aspect, labels beside it and never over it (R7 H152)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launchBrowser(); }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('at 1376×768 and 800×600: the share stated, the aspect kept, no label over the image, each label tied to its mark', async () => {
    let p: PageProject | undefined;
    try {
      p = await pageProject(kit, { prefix: 'vox-room-browser-' });
      for (const size of SIZES) {
        const at = `${size.width}x${size.height}`;
        const { context, page, errors } = await openPage(browser, p, size);
        try {
          await page.goto(`${p.origin}/?tab=voxvision#t=${p.token}`);
          // the newest record, its image drawn and laid out with both marks' labels
          await page.waitForFunction(() => {
            const i = document.querySelector('.vox-img') as HTMLImageElement | null;
            return !!i && i.dataset.path === 'refs/newest.png' && i.complete && i.naturalWidth === 640
              && document.querySelectorAll('[data-vox="stage"] .vox-label, .vox-overlay .ov-label').length === 2 && i.getBoundingClientRect().width > 0;
          }, null, { timeout: 30_000 });
          // its layout settles (a resize observer and the face loading may lay it out once more)
          await page.waitForTimeout(400);
          const room = await measure(page);
          const [W, H] = room.natural;
          const dw = room.drawn[2] - room.drawn[0];
          const dh = room.drawn[3] - room.drawn[1];

          // the share stated
          if (size.width === 1376) {
            expect(area(room.drawn) / area(room.panel), `${at}: the image's share of the panel`).toBeGreaterThanOrEqual(0.25);
            const largest = [...room.boxes].sort((a, b) => b.area - a.area)[0];
            expect(largest.name, `${at}: the panel's largest box`).toBe('view');
          } else {
            expect(dw / size.width, `${at}: the image's width against the window's`).toBeGreaterThanOrEqual(0.75);
          }
          // its own aspect, within a pixel, and the image fills its frame (no letterbox to put a label in)
          expect(Math.abs(dh - (dw * H) / W), `${at}: aspect`).toBeLessThanOrEqual(1);
          const frame = await page.$eval('.vox-frame', (f) => { const r = f.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom] as Rect; }).catch(() => null);
          expect(frame, `${at}: the image's frame`).not.toBeNull();
          for (let k = 0; k < 4; k++) expect(Math.abs(frame![k] - room.drawn[k]), `${at}: the image fills its frame`).toBeLessThanOrEqual(1);

          // the labels: their words, their size, never over the image
          expect(room.labels.map((l) => l.text)).toEqual(['colour region rgb(240, 240, 240) · measured · constructed', 'centroid · measured · constructed']);
          for (const l of room.labels) {
            expect(l.px, `${at}: ${l.text}`).toBeGreaterThanOrEqual(11);
            expect(overlaps(l.r, room.drawn), `${at}: "${l.text}" over the image`).toBe(false);
          }
          // each tied to its mark: it names one, and a leader line runs from the label's edge to the mark's bounds
          for (const l of room.labels) {
            const mark = room.marks.find((m) => m.id === l.for);
            expect(mark, `${at}: the mark of "${l.text}"`).toBeDefined();
            const line = room.leaders.find((x) => x.for === l.for);
            expect(line, `${at}: the leader of "${l.text}"`).toBeDefined();
            expect(onEdge(line!.b, l.r), `${at}: the leader starts on the label's edge`).toBe(true);
            expect(within(line!.a, mark!.r, 2), `${at}: the leader ends on its mark`).toBe(true);
          }

          // pressing a label selects its entity: the label, its leader and its mark amber
          await page.click('[data-vox="stage"] .vox-label[data-shape="box"]');
          await page.waitForFunction(() => document.querySelectorAll('.vox-overlay .ov.is-selected').length === 2, null, { timeout: 10_000 });
          const sel = await page.evaluate(() => {
            const label = document.querySelector('[data-vox="stage"] .vox-label[data-shape="box"]')!;
            const id = label.getAttribute('data-label-for')!;
            return {
              label: getComputedStyle(label).color,
              leader: getComputedStyle(document.querySelector(`.vox-leaders line[data-label-for="${id}"]`)!).stroke,
              mark: getComputedStyle(document.querySelector(`.vox-overlay .ov[data-overlay="${id}"]`)!).stroke,
              tree: document.querySelector('.vox-ent[aria-current="true"]')?.getAttribute('data-vox-entity'),
            };
          });
          expect(sel).toEqual({ label: AMBER, leader: AMBER, mark: AMBER, tree: 'color-region' });
          // still clear of the image once selected (the layout is drawn again with the selection)
          const after = await measure(page);
          for (const l of after.labels) expect(overlaps(l.r, after.drawn), `${at} selected: "${l.text}" over the image`).toBe(false);
          if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: `${process.env.TIMMY_CAPTURE_DIR}/vox-room-${at}.png` });
          expect(errors, at).toEqual([]);
        } finally { await context.close(); }
      }
    } finally { await closeProject(p); }
  }, 240_000);
});
