/**
 * R7 (H153): the companion's tab 6 (src/companion/client/panel-create.js over src/companion/panels/create.ts) in a real
 * headless Chromium against the real companion server on 127.0.0.1 and its token, reading what the page shows: the demo mesh
 * drawn on the canvas (it holds drawn pixels, every one a neutral grey: the mesh is content); a drag turns it (other pixels,
 * "turned by hand"); F, T and S show the front, top and side views, each with its name on screen, R the first view again (the
 * same pixels), + and the wheel zoom; the measurements on screen are those of Timmy's own STL reader over the whole file; a
 * mesh above the cap draws an even pick and says "showing N of M"; the recordings with their header facts and what stays
 * unknown; another project's mesh refused from the page; the panel under the tab's Unfinished place; text of 11 px or more,
 * the B10 palette, and the panel at 800 × 600.
 *
 * R8 (H154): OBJ and PLY meshes beside STL, each listed with its kind, drawn in the same view from the triangles its own reader
 * reads (the same cube as OBJ and as PLY draws the same pixels), measured by its own reader with its faces and what it ignored;
 * a point cloud (a PLY with no faces) says why it is not drawn.
 *
 * FAKE, labelled: the projects (written by the test), a large flat mesh (scans/strip.stl, a strip of triangles written by
 * the test), and a cube as OBJ and PLY and a point cloud (tray/…, tests/helpers/mesh-fakes.ts). Real: the server, its token, Timmy's STL reader, the demo mesh as its script generated it
 * (examples/visual-tools/demo-tray.stl), the Rerun header reader over the repository's own recording
 * (studio/ctx-c3w8/…/context.rrd, read, never changed), the page's code. Captures are written only where H153_CAPS names a
 * folder. Skipped, saying so, where no Chromium or Chrome is found.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { DOCTRINE_15, num, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { VIEW_MAX_TRIANGLES, VIEW_WORDS } from '../src/vox/meshes.js';
import { forgetRrdReadings, readRrdWithCli, rrdReadingsIdle, type RrdReading } from '../src/vox/rrd-cli.js';
import { DEMO_HEADER, DEMO_MESH } from '../scripts/demo-mesh.mjs';
import { cubeObj, cubePly, pointCloudPly } from './helpers/mesh-fakes.js';
import { cubeStl } from './helpers/vox-fakes.js';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-create-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');
const CAPS = process.env.H153_CAPS ?? '';
const CAPS154 = process.env.H154_CAPS ?? '';
/** FAKE: a wavy sheet of `cells` × `cells` squares, two triangles each, written by the test (more triangles than the cap). */
const CELLS = 142;
const STRIP = CELLS * CELLS * 2;
function stripStl(cells: number): Buffer {
  const n = cells * cells * 2;
  const b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  const at = (x: number, y: number): number[] => [x, y, 6 * Math.sin(x / 9) * Math.cos(y / 11)];
  let i = 0;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      for (const c of [[at(x, y), at(x + 1, y), at(x + 1, y + 1)], [at(x, y), at(x + 1, y + 1), at(x, y + 1)]]) {
        c.forEach((p, k) => p.forEach((v, j) => b.writeFloatLE(v, 84 + i * 50 + 12 + k * 12 + j * 4)));
        i += 1;
      }
    }
  }
  return b;
}

describe.skipIf(!browserPath)('the companion\'s tab 6: the project\'s meshes in a view you can turn (R7 H153)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let other = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r7-create-browser-'));
    root = join(box, 'home', 'projects', 'FAKE-tray');
    other = join(box, 'home', 'projects', 'FAKE-other');
    const put = (at: string, rel: string, body: Buffer): void => { mkdirSync(dirname(join(at, rel)), { recursive: true }); writeFileSync(join(at, rel), body); };
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    mkdirSync(join(root, 'refs'), { recursive: true });
    copyFileSync(resolve(DEMO_MESH), join(root, 'refs', 'demo-tray.stl'));
    put(root, 'scans/strip.stl', stripStl(CELLS));
    put(root, 'tray/cube.obj', Buffer.from(cubeObj(10)));
    put(root, 'tray/cube.ply', cubePly(10));
    put(root, 'tray/cloud.ply', pointCloudPly(3));
    mkdirSync(join(root, 'rec'), { recursive: true });
    copyFileSync(RRD, join(root, 'rec', 'context.rrd'));
    put(other, 'refs/theirs.stl', cubeStl(5));
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    if (CAPS) mkdirSync(CAPS, { recursive: true });
    if (CAPS154) mkdirSync(CAPS154, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  async function open(viewport = { width: 1376, height: 768 }): Promise<{ page: Page; errors: string[]; bad: string[] }> {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    const bad: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.goto(companion.url);
    await landWorkspace(page);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.keyboard.press('6');
    await page.waitForSelector('[data-panel-host="create"] .create-mesh', { timeout: 15_000 });
    return { page, errors, bad };
  }
  const text = (page: Page, sel: string): Promise<string> => page.$eval(sel, (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  const settled = (page: Page): Promise<unknown> => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  /**
   * The canvas's pixels: a hash of them all, how many differ from the stage's ground, and whether every drawn one is a neutral grey.
   * (R11 round 7, H176; the lead's D12: the stage's ground is the registry's surface now — read from the stage's own computed
   * background, not pinned to B10's (7, 7, 7); the mesh stays content in neutral greys.)
   */
  const pixels = (page: Page) => page.$eval('[data-create="canvas"]', (c) => {
    const cv = c as HTMLCanvasElement;
    const bg = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(cv.closest('[data-create="stage"]')!).backgroundColor);
    const ground = bg ? [Number(bg[1]), Number(bg[2]), Number(bg[3])] : [7, 7, 7];
    // a drawn pixel is neutral within the ground's own tint: an edge pixel blends a grey with the ground (the canvas antialiases), so
    // its channels may differ by as much as the ground's do (9 on the slate surface, 0 on a grey one); amber or green differ by far more
    const tol = Math.max(Math.abs(ground[0] - ground[1]), Math.abs(ground[1] - ground[2]));
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let hash = 2166136261;
    let drawn = 0;
    let neutral = true;
    for (let i = 0; i < d.length; i += 4) {
      hash = Math.imul(hash ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619) >>> 0;
      const isGround = d[i] === ground[0] && d[i + 1] === ground[1] && d[i + 2] === ground[2];
      if (!isGround) {
        drawn += 1;
        if (Math.abs(d[i] - d[i + 1]) > tol || Math.abs(d[i + 1] - d[i + 2]) > tol) neutral = false;
      }
    }
    return { hash, drawn, neutral, w: cv.width, h: cv.height, triangles: Number(cv.dataset.drawn ?? 0) };
  });
  const viewName = (page: Page): Promise<string> => text(page, '[data-create="view-name"]');
  const shot = async (page: Page, name: string): Promise<void> => { if (CAPS) await page.screenshot({ path: join(CAPS, `${name}.png`) }); };

  it('draws the demo mesh; a drag turns it; F, T and S show the front, top and side with their names; R the first view; the measurements are the file\'s', async () => {
    const { page, errors, bad } = await open();
    try {
      // the list: the project's meshes, the demo tray first chosen (the first measured, by path)
      expect(await page.$$eval('.create-mesh', (bs) => bs.map((b) => [(b as HTMLElement).dataset.createMesh, b.getAttribute('aria-current')]))).toEqual([
        ['refs/demo-tray.stl', 'true'], ['scans/strip.stl', 'false'], ['tray/cloud.ply', 'false'], ['tray/cube.obj', 'false'], ['tray/cube.ply', 'false']]);
      expect(await text(page, '[data-create="meshes-title"]')).toBe('Meshes in this project (5)');
      await page.waitForFunction(() => Number((document.querySelector('[data-create="canvas"]') as HTMLElement | null)?.dataset.drawn ?? 0) > 0, null, { timeout: 15_000 });
      await settled(page);
      const first = await pixels(page);
      expect(first.drawn).toBeGreaterThan(2000);
      expect(first.neutral).toBe(true); // the mesh is content: neutral greys, never amber or green
      expect(await viewName(page)).toBe('isometric · seen from +x, −y and +z at equal angles');
      expect(await text(page, '[data-create="count"]')).toBe('all 28 triangles');
      expect(await text(page, '[data-create="label"]')).toBe(VIEW_WORDS);
      expect(await text(page, '[data-create="view-title"]')).toBe('The view you can turn · refs/demo-tray.stl');
      await shot(page, 'h153-01-tab6-demo-tray-isometric');

      // the measurements on screen are Timmy's own STL reader's, of the whole file
      const r = readStlFile(join(root, 'refs', 'demo-tray.stl'), 'refs/demo-tray.stl');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const m = r.readback;
      const shown = Object.fromEntries(await page.$$eval('[data-measure]', (ds) => ds.map((d) => [(d as HTMLElement).dataset.measure, (d.textContent ?? '').replace(/\s+/g, ' ').trim()])));
      expect(shown).toMatchObject({
        triangles: String(m.triangles), corners: String(m.corners),
        'box-min': m.bbox!.min.map(num).join(', '), 'box-max': m.bbox!.max.map(num).join(', '), 'box-size': m.bbox!.size.map(num).join(' × '),
        area: num(m.area), volume: volumeWords(m), topology: topologyWords(m), units: m.units, declared: DEMO_HEADER,
        format: `binary STL · 1.4 KB · sha256 ${m.sha256.slice(0, 12)}…`,
      });
      expect(shown.triangles).toBe('28');
      expect(shown['box-size']).toBe('80 × 50 × 20');
      expect(shown.volume).toBe('21392 (enclosed; normals outward)');
      expect(await text(page, '[data-create="doctrine"]')).toBe(DOCTRINE_15);
      expect(await text(page, '[data-create="reader"]')).toBe("Timmy's own STL reader (timmy-stl-readback/1), from the whole file: a deterministic computation on its bytes, in the file's own units");

      // a drag turns it (R11 round 7, H176: the page scrolls under the shell's head and band — at 768 px the view starts below the
      // fold, so it is scrolled into view first, as a person scrolls to it)
      const c = (await page.$('[data-create="canvas"]'))!;
      await c.scrollIntoViewIfNeeded();
      await settled(page);
      const b = (await c.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 40, { steps: 6 });
      await page.mouse.up();
      await settled(page);
      const dragged = await pixels(page);
      expect(dragged.hash).not.toBe(first.hash);
      expect(dragged.drawn).toBeGreaterThan(2000);
      expect(await viewName(page)).toBe('turned by hand: -15° around z from the front, 55° above it');
      await shot(page, 'h153-02-tab6-dragged');

      // the keys (the canvas has the focus after the drag): F, T, S, each its own view and name
      const seen = new Set([first.hash, dragged.hash]);
      for (const [key, name, file] of [
        ['f', 'front · seen from −y: x to the right, z up', 'h153-03-tab6-front'],
        ['t', 'top · seen from +z: x to the right, y up', 'h153-04-tab6-top'],
        ['s', 'side · seen from +x: y to the right, z up', 'h153-05-tab6-side'],
      ] as const) {
        await page.keyboard.press(key);
        await settled(page);
        expect(await viewName(page)).toBe(name);
        const p = await pixels(page);
        expect(p.drawn, key).toBeGreaterThan(1000);
        expect(seen.has(p.hash), `${key} draws a view of its own`).toBe(false);
        seen.add(p.hash);
        expect(await page.$eval(`[data-create-key="${key}"]`, (k) => k.getAttribute('aria-pressed'))).toBe('true');
        await shot(page, file);
      }
      // R: the first view again, the same pixels
      await page.keyboard.press('r');
      await settled(page);
      expect(await viewName(page)).toBe('isometric · seen from +x, −y and +z at equal angles');
      expect((await pixels(page)).hash).toBe(first.hash);
      // + zooms in, and so does the wheel; the arrow keys turn it
      await page.keyboard.press('+');
      await settled(page);
      expect(await viewName(page)).toBe('isometric · seen from +x, −y and +z at equal angles · zoom 1.25×');
      const zoomed = await pixels(page);
      expect(zoomed.drawn).toBeGreaterThan(first.drawn);
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.wheel(0, -200);
      await settled(page);
      expect(await viewName(page)).toMatch(/· zoom 1\.6[0-9]?×$/);
      await page.keyboard.press('ArrowLeft');
      await settled(page);
      expect(await viewName(page)).toMatch(/^turned by hand: 60° around z from the front, 35° above it · zoom /);
      // the buttons do what the keys do
      await page.click('[data-create-key="t"]');
      await settled(page);
      expect(await viewName(page)).toMatch(/^top · seen from \+z: x to the right, y up/);

      // the page's tab 6 on the scaffold (R11 round 7, H176; the lead's D23 on H168's R106): the frame's Unfinished words are EVIDENCE
      // — in the page's records, open, in the frame's own words; the companion's own box (prepended to the section) is hidden, so
      // nothing sits between the head and the band (head → band → body), and the panel's view stays in sight
      const order = await page.evaluate(() => {
        const page6 = document.getElementById('ws-create')!;
        const at = (e: Element | null) => e ? e.getBoundingClientRect() : null;
        const box = page6.querySelector(':scope > .unfinished') as HTMLElement | null;
        const rec = page6.querySelector('.page-records [data-create-records="unfinished"]') as HTMLDetailsElement | null;
        const view = page6.querySelector('[data-create="stage"]')!;
        const head = at(page6.querySelector(':scope > .page-head'))!;
        const band = at(page6.querySelector(':scope > .page-band'))!;
        const between = [...page6.children].filter((k) => { const b = k.getBoundingClientRect(); return b.height > 0 && b.top >= head.bottom - 1 && b.bottom <= band.top + 1 && !k.classList.contains('page-head') && !k.classList.contains('page-band'); }).map((k) => k.className);
        return { boxDrawn: Boolean(box), boxHidden: Boolean(box && box.hidden && at(box)!.height === 0), rec: rec ? { open: rec.open, text: (rec.textContent ?? '').replace(/\s+/g, ' ').trim() } : null,
          gap: Math.round(band.top - head.bottom), between, viewInSight: at(view)!.bottom <= at(page6)!.bottom + 1 && at(view)!.height > 150 };
      });
      await settled(page);
      await shot(page, 'h153-09-tab6-unfinished-in-the-records');
      expect(order.boxDrawn, 'the frame marks this page unfinished (TABS): companion.js draws its box').toBe(true);
      expect(order.boxHidden).toBe(true);
      expect(order.between).toEqual([]);
      expect(order.gap).toBeLessThanOrEqual(18);
      expect(order.rec).toMatchObject({ open: true });
      // (textContent joins the summary and the two lines without a space)
      expect(order.rec!.text).toMatch(/^Unfinished · .* — what works here now, and what does not yet\s*Works now: .+\s*Not yet: .+$/);
      expect(order.viewInSight).toBe(true);

      // another project's mesh, asked from this page with its token, is refused; the list holds only this project's
      const token = /t=([0-9a-f]{64})/.exec(new URL(companion.url).hash)?.[1] ?? '';
      const refused = await page.evaluate(async ({ t, id }) => {
        const r = await fetch(`/api/panel/create/mesh?path=${encodeURIComponent('refs/theirs.stl')}&project=${id}`, { headers: { Authorization: `Bearer ${t}` } });
        return [r.status, (await r.json()).error];
      }, { t: token, id: projectId(root) });
      expect(refused).toEqual([404, 'Refused: refs/theirs.stl is not a mesh of this project (tab 6 lists its STL, OBJ and PLY files and its tessellations), so it is not served.']);
      expect(await page.$$eval('.create-mesh', (bs) => bs.map((x) => (x as HTMLElement).dataset.createMesh))).not.toContain('refs/theirs.stl');

      // every text of the tab at 11 px or more; the palette: no blue, purple or cyan of the page's own, no green (nothing live or
      // sealed here). R11 round 7 (H176; DESIGN.md §10 B11): the page's sheet is the B11 registry's, whose darks and greys are
      // slate-blue tinted (#111A23, #1C2936, #44586B, #BDCADA, #9AAFC3 …): a colour of the registry, or of its slate band (a mix of
      // two of its colours), is not a hue of the page's own
      const REGISTRY = ['8, 11, 15', '17, 26, 35', '28, 41, 54', '232, 239, 245', '68, 88, 107', '30, 42, 54', '236, 241, 245', '189, 202, 218', '154, 175, 195', '28, 48, 67', '59, 81, 104', '255, 176, 0', '40, 254, 20', '0, 215, 0', '255, 95, 86',
        '214, 170, 100', '234, 208, 163', '64, 46, 20', '240, 229, 212', '138, 187, 227', '190, 217, 237', '29, 56, 72', '225, 238, 247',
        '20, 30, 41', '14, 22, 31', '34, 48, 62', '22, 33, 44', '18, 26, 36', '10, 15, 21', '14, 21, 29', '242, 245, 248', '228, 234, 240', '189, 203, 217'];
      const look = await page.evaluate((registry) => {
        const parse = (v: string): number[] | null => {
          const t = v.trim();
          const mm = /^rgba?\(([^)]+)\)$/.exec(t);
          if (mm) { const p = mm[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
          const cc = /^color\(srgb ([^)]+)\)$/.exec(t); // Chromium's colour-mixed value, 0..1
          if (cc) { const p = cc[1].split(/[\s/]+/).filter(Boolean).map(Number); return [Math.round(p[0] * 255), Math.round(p[1] * 255), Math.round(p[2] * 255), p[3] ?? 1]; }
          return null;
        };
        const ofRegistry = (c: number[]): boolean => registry.includes(`${c[0]}, ${c[1]}, ${c[2]}`);
        const hsl = ([rr, gg, bb]: number[]) => { const [R, G, B] = [rr / 255, gg / 255, bb / 255]; const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min; if (d === 0) return { h: 0, s: 0, l }; const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4); return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
        const out = { small: [] as string[], hue: [] as string[], green: [] as string[], amber: [] as string[] };
        for (const el of document.querySelectorAll('#ws-create [data-panel-host="create"], #ws-create [data-panel-host="create"] *')) {
          if (el.closest('[hidden]')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || el.getBoundingClientRect().width === 0) continue;
          if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) && parseFloat(cs.fontSize) < 11) out.small.push(`${el.tagName}.${el.className} ${cs.fontSize}`);
          for (const prop of ['color', 'background-color', 'border-top-color', 'border-left-color']) {
            const c = parse(cs.getPropertyValue(prop)); if (!c || c[3] === 0) continue;
            if (c[0] === 255 && c[1] === 176 && c[2] === 0) { out.amber.push(`${el.tagName}.${el.className}`); continue; }
            if (ofRegistry(c)) continue;
            const { h, s, l } = hsl(c); if (s < 0.2 || l < 0.08 || l > 0.92) continue;
            if (h >= 200 && h <= 222 && s <= 0.45) continue; // the registry's own slate band
            if (h >= 150 && h <= 320) out.hue.push(`${el.tagName} ${prop}`);
            else if (h >= 75 && h < 150) out.green.push(`${el.tagName}.${el.className} ${prop}`);
          }
        }
        return out;
      }, REGISTRY);
      expect(look.small).toEqual([]);
      expect(look.hue).toEqual([]);
      expect(look.green).toEqual([]);
      // amber only where the selection is (the chosen mesh, the pressed view's key)
      for (const a of look.amber) expect(a).toMatch(/create-mesh|create-key/);
      expect(bad.filter((x) => !x.startsWith('404 /api/panel/create/mesh'))).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("item 6 (the operator's 19:18 order; R11 round 7, H176): each step card carries ONE verb that does something now — Add a mesh copies /add <file> with its words; without a parameter file 02 is Add a parameter file (copies /add); Copy the hython command copies the shelf's invocation with the mesh in the view and the honest line; the state lines are the project's own words; nothing runs", async () => {
    const { page, errors } = await open();
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: companion.url });
      await page.waitForFunction(() => { const bs = [...document.querySelectorAll('[data-create-do]')]; return bs.length === 3 && bs.every((b) => !(b as HTMLButtonElement).disabled); }, null, { timeout: 15_000 });
      const cards = () => page.$$eval('.create-step', (els) => els.map((e) => ({
        n: e.getAttribute('data-create-step'), current: e.getAttribute('data-current'), tag: e.tagName, name: e.querySelector('.create-step-verb')?.textContent ?? '', state: e.querySelector('.create-step-state')?.textContent ?? '',
        verb: e.querySelector('.create-step-do')?.textContent ?? '', kind: e.querySelector('.create-step-do')?.getAttribute('data-create-do-kind'), buttons: e.querySelectorAll('button').length,
      })));
      let c = await cards();
      // one verb per step (one button on the card; the card itself is a group, not a button); the state the project's own words
      expect(c.map((x) => [x.n, x.tag, x.name, x.verb, x.kind, x.buttons])).toEqual([
        ['01', 'DIV', 'Define the geometry', 'Add a mesh', 'copy', 1], ['02', 'DIV', 'Set the parameters', 'Add a parameter file', 'copy', 1], ['03', 'DIV', 'Cook in Houdini', 'Copy the hython command', 'copy', 1]]);
      expect(c[0].state).toBe('5 meshes · demo-tray.stl in the view');
      expect(c[1].state).toBe('no parameter file in this project yet');
      expect(c[2].state).toBe('no workflow document in this project yet · no native Houdini operation');
      expect(c.map((x) => x.current)).toEqual(['true', 'false', 'false']);
      // 01 Add a mesh: /add <file> on the clipboard; the step's line says it was copied, for whom, and that nothing ran
      await page.click('[data-create-do="01"]');
      await page.waitForFunction(() => (document.querySelector('[data-create-step-state="01"]')?.textContent ?? '').startsWith('Copied /add <file>'), null, { timeout: 5_000 });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/add <file>');
      expect(await text(page, '[data-create-step-state="01"]')).toBe("Copied /add <file> for Timmy's terminal: type it with the mesh's path (an .stl, .obj or .ply file); Timmy copies the file into this project (a local change), and it is listed and drawn here. Nothing ran on this page.");
      // 03 Copy the hython command: the engine shelf's own invocation, the mesh in the view as its mesh, the honest line; no run claimed
      await page.click('[data-create-do="03"]');
      await page.waitForFunction(() => (document.querySelector('[data-create-step-state="03"]')?.textContent ?? '').startsWith('Copied the hython command'), null, { timeout: 5_000 });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('hython lanes/engines/houdini/templates/procedural-asset/script.py refs/demo-tray.stl <out dir> demo-tray');
      const said = await text(page, '[data-create-step-state="03"]');
      expect(said).toBe('Copied the hython command for a terminal on a computer with Houdini (demo-tray.stl as its mesh): hython lanes/engines/houdini/templates/procedural-asset/script.py refs/demo-tray.stl <out dir> demo-tray. Houdini is not connected on this companion: this copies the command, nothing runs.');
      expect(said).not.toMatch(/\b(ran|running|cooked)\b/);
      c = await cards();
      expect(c.map((x) => x.current)).toEqual(['false', 'false', 'true']);
      // 02 without a parameter file: Add a parameter file copies /add with its own words
      await page.click('[data-create-do="02"]');
      await page.waitForFunction(() => (document.querySelector('[data-create-step-state="02"]')?.textContent ?? '').startsWith('Copied /add <file>'), null, { timeout: 5_000 });
      expect(await text(page, '[data-create-step-state="02"]')).toMatch(/^Copied \/add <file> for Timmy's terminal: a parameter file is a tray recipe .* Nothing ran on this page\.$/);
      // the lines return to the project's words after a moment
      await page.waitForFunction(() => (document.querySelector('[data-create-step-state="01"]')?.textContent ?? '') === '5 meshes · demo-tray.stl in the view', null, { timeout: 9_000 });
      // D23 (R106) at 1440 and at 390: nothing between the head and the band (the band's top within the scaffold's 18-px gap of the
      // head's bottom), the Unfinished words in the records, the companion's box hidden
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(size);
        await settled(page);
        const m = await page.evaluate(() => {
          const sec = document.getElementById('ws-create')!;
          const r = (sel: string) => sec.querySelector(sel)!.getBoundingClientRect();
          const box = sec.querySelector(':scope > .unfinished') as HTMLElement | null;
          return { gap: Math.round(r(':scope > .page-band').top - r(':scope > .page-head').bottom), boxHidden: !box || (box.hidden && box.getBoundingClientRect().height === 0), recOpen: (sec.querySelector('.page-records [data-create-records="unfinished"]') as HTMLDetailsElement | null)?.open ?? false };
        });
        expect(m.gap, `${size.width}x${size.height}: the band right under the head`).toBeLessThanOrEqual(18);
        expect(m.boxHidden, `${size.width}x${size.height}`).toBe(true);
        expect(m.recOpen, `${size.width}x${size.height}: the Unfinished words in the records, open`).toBe(true);
      }
      // the three verbs whole on the cards at 1376 and at 800 x 600 (the verb stays on the card: nothing cut, nothing past the card's edge)
      for (const size of [{ width: 1376, height: 768 }, { width: 800, height: 600 }]) {
        await page.setViewportSize(size);
        await settled(page);
        const fit = await page.$$eval('.create-step', (els) => els.map((e) => { const c = e.getBoundingClientRect(); const b = e.querySelector('.create-step-do')!.getBoundingClientRect(); return { n: e.getAttribute('data-create-step'), inside: b.left >= c.left && b.right <= c.right + 0.5 && b.top >= c.top && b.bottom <= c.bottom + 0.5, wide: b.width >= 40 }; }));
        expect(fit.filter((f) => !f.inside || !f.wide).map((f) => f.n), `${size.width}x${size.height}`).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('a mesh above the cap draws an even pick and says "showing N of M"; the recordings say what Timmy read and what it does not know', async () => {
    const { page, errors, bad } = await open();
    try {
      await page.click('.create-mesh[data-create-mesh="scans/strip.stl"]');
      await page.waitForFunction(() => /^showing /.test(document.querySelector('[data-create="count"]')?.textContent ?? ''), null, { timeout: 30_000 });
      expect(await text(page, '[data-create="count"]')).toBe(`showing ${VIEW_MAX_TRIANGLES} of ${STRIP} triangles: an even pick through the file's order (triangle ⌊k × ${STRIP} / ${VIEW_MAX_TRIANGLES}⌋ for k = 0 … ${VIEW_MAX_TRIANGLES - 1}); the measurements are of all ${STRIP}`);
      expect(await text(page, '[data-measure="triangles"]')).toBe(String(STRIP));
      await page.waitForFunction(() => Number((document.querySelector('[data-create="canvas"]') as HTMLElement | null)?.dataset.drawn ?? 0) > 0, null, { timeout: 30_000 });
      await settled(page);
      const p = await pixels(page);
      expect(p.triangles).toBeGreaterThan(0);
      expect(p.triangles).toBeLessThanOrEqual(VIEW_MAX_TRIANGLES);
      expect(p.drawn).toBeGreaterThan(100);
      expect(p.neutral).toBe(true);
      await shot(page, 'h153-06-tab6-above-the-cap');

      // the recordings: the header's facts; entities, frames and time range unknown, with why; Rerun's viewer as it is here
      const rec = '[data-create-recording="rec/context.rrd"]';
      expect(await text(page, `${rec} [data-rec="header"]`)).toMatch(/^written by Rerun \d+\.\d+\.\d+ · compression (?:off|LZ4) · (?:Protobuf|MsgPack) · \d+(?:\.\d)? (?:B|KB|MB)$/);
      expect(await text(page, `${rec} [data-rec="messages"]`)).toMatch(/^\d+ store info · \d+ data chunks · \d+ blueprint/);
      expect(await text(page, `${rec} [data-rec="unknown"]`)).toBe("inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it");
      // R9 (H159): the Rerun CLI's reading beside the header: here no rerun at all, so each fact is unknown, with why
      expect(await text(page, `${rec} [data-rec="cli"]`)).toBe('not read by the Rerun CLI: rerun is not on the PATH and TIMMY_RERUN is not set');
      expect(await text(page, `${rec} [data-rec="entities"]`)).toBe('unknown: rerun is not on the PATH and TIMMY_RERUN is not set');
      expect(await page.$$eval(`${rec} dt`, (ds) => ds.map((d) => (d.textContent ?? '').trim()))).toEqual([
        'header (read by Timmy from the file)', 'messages', 'stores', 'read by the Rerun CLI', 'entities and timelines', 'written by', "not decoded by Timmy's own reader"]);
      expect(await text(page, `${rec} [data-rec="origin"]`)).toBe('not recorded: no receipt of this project names this file');
      expect(await page.$eval('[data-create-viewer]', (v) => v.getAttribute('data-create-viewer'))).toBe('needs setup');
      expect(await text(page, '.create-viewer-state')).toBe("Rerun's viewer: needs setup");
      await page.$eval('[data-create-box="recordings"]', (e) => e.scrollIntoView());
      await shot(page, 'h153-07-tab6-recordings');
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('OBJ and PLY: each listed with its kind, drawn in the same view, measured by its own reader with its faces and what it ignored; a point cloud says why it is not drawn (R8 H154)', async () => {
    const { page, errors, bad } = await open();
    try {
      const sub = (p: string): Promise<string> => text(page, `.create-mesh[data-create-mesh="${p}"] .create-mesh-sub`);
      expect(await sub('tray/cube.obj')).toBe(`OBJ · 12 triangles · ${Buffer.byteLength(cubeObj(10))} B`);
      expect(await sub('tray/cube.ply')).toBe(`PLY · 12 triangles · ${cubePly(10).length} B`);
      expect(await sub('tray/cloud.ply')).toBe(`PLY · not measured · ${pointCloudPly(3).length} B`);
      expect(await sub('refs/demo-tray.stl')).toBe('STL · 28 triangles · 1.4 KB');
      const hashes: number[] = [];
      for (const [p, file, words] of [
        ['tray/cube.obj', 'h154-01-tab6-cube-obj', {
          format: 'Wavefront OBJ (text)', faces: '6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all',
          ignored: 'ignored: 1 comment, 1 o lines', declared: 'FAKE: a cube written by a test', units: "the file's own: OBJ records no unit",
          precision: "each coordinate read as a 32-bit float (Math.fround), as Timmy's STL reader reads an ASCII STL, so one mesh written as STL and as OBJ measures the same",
          reader: "Timmy's own OBJ reader (timmy-obj-readback/1), from the whole file: a deterministic computation on its bytes, in the file's own units",
        }],
        ['tray/cube.ply', 'h154-02-tab6-cube-ply', {
          format: 'PLY (binary little-endian)', faces: '6 faces: 6 with four or more corners, each split as a fan from its first corner (exact for a flat, convex polygon); 12 triangles in all',
          ignored: 'ignored: 1 comment line', declared: 'FAKE: a cube written by a test', units: "the file's own: PLY records no unit",
          precision: 'x, y and z stored as 32-bit floats, read as they are', stored: 'x, y and z as float; corners as list uchar int vertex_indices',
          reader: "Timmy's own PLY reader (timmy-ply-readback/1), from the whole file: a deterministic computation on its bytes, in the file's own units",
        }],
      ] as const) {
        await page.click(`.create-mesh[data-create-mesh="${p}"]`);
        await page.waitForFunction((want) => document.querySelector('[data-create="view-title"]')?.textContent === `The view you can turn · ${want}` && document.querySelector('[data-create="count"]')?.textContent === 'all 12 triangles', p, { timeout: 15_000 });
        await settled(page);
        await settled(page);
        const px = await pixels(page);
        expect(px.triangles, p).toBeGreaterThan(0);
        expect(px.drawn, p).toBeGreaterThan(1000);
        expect(px.neutral, p).toBe(true);
        hashes.push(px.hash);
        expect(await viewName(page)).toBe('isometric · seen from +x, −y and +z at equal angles');
        const shown = Object.fromEntries(await page.$$eval('[data-measure]', (ds) => ds.map((d) => [(d as HTMLElement).dataset.measure, (d.textContent ?? '').replace(/\s+/g, ' ').trim()])));
        const { format, reader, ...rows } = words;
        expect(shown, p).toMatchObject({
          triangles: '12', corners: '8', 'box-size': '10 × 10 × 10', area: '600', volume: '1000 (enclosed; normals outward)',
          topology: 'edge-manifold: every edge shared by exactly two triangles, consistently oriented', ...rows,
        });
        expect(shown.format, p).toMatch(new RegExp(`^${format.replace(/[()]/g, '\\$&')} · \\d+ B · sha256 [0-9a-f]{12}…$`));
        expect(await text(page, '[data-create="reader"]'), p).toBe(reader);
        expect(await text(page, '[data-create="doctrine"]')).toBe(DOCTRINE_15);
        if (CAPS154) await page.screenshot({ path: join(CAPS154, `${file}.png`) });
      }
      // the same cube read from the OBJ and from the PLY: the same triangles, so the same pixels
      expect(hashes[0]).toBe(hashes[1]);
      // a point cloud: listed, not measured, not drawn, with why
      await page.click('.create-mesh[data-create-mesh="tray/cloud.ply"]');
      await page.waitForFunction(() => /^Not drawn: tray\/cloud\.ply/.test(document.querySelector('[data-create="note"]')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(await text(page, '[data-create="note"]')).toBe('Not drawn: tray/cloud.ply was not measured (not measured: no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read)).');
      expect(await text(page, '[data-measure="why"]')).toBe('not measured: no face element in its header, so no triangles to measure (a point cloud of 3 vertices; its data is not read)');
      expect(await page.$eval('[data-create="canvas"]', (c) => (c as HTMLElement).hidden)).toBe(true);
      if (CAPS154) await page.screenshot({ path: join(CAPS154, 'h154-03-tab6-point-cloud.png') });
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('a mesh still being measured says so, and the page asks again until the list holds its measurements', async () => {
    const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // FAKE: the page's first list answer is the server's own with the demo tray marked as not measured yet (as a reading
    // whose time budget ran out leaves a large mesh); every later answer is the server's, untouched, and held until the test
    // has read the pending state (R9 H159, the lead's race: it cannot be drawn over before it is read). Every list request is
    // matched, the first too, which the page may ask before it knows its project (so without ?project=)
    let asked = 0;
    let release!: () => void;
    const seen = new Promise<void>((r) => { release = r; });
    await page.route((url) => url.pathname === '/api/panel/create/meshes', async (route) => {
      asked += 1;
      if (asked > 1) { await seen; await route.continue(); return; }
      const res = await route.fetch();
      const body = await res.json() as { meshes: Array<Record<string, unknown>>; pending: number };
      body.meshes = body.meshes.map((m) => (m.path === 'refs/demo-tray.stl' ? { path: m.path, kind: 'stl', bytes: m.bytes, origin: { provenance: 'not recorded', words: 'not read yet' }, pending: true, why: "being measured: Timmy's own STL reader reads it next (the list is read again in a moment)" } : m));
      body.pending = 1;
      await route.fulfill({ response: res, json: body });
    });
    try {
      await page.goto(companion.url);
      await landWorkspace(page);
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      await page.keyboard.press('6');
      const sub = '.create-mesh[data-create-mesh="refs/demo-tray.stl"] .create-mesh-sub';
      await page.waitForSelector(sub, { timeout: 15_000 });
      expect(await text(page, sub)).toBe('STL · being measured… · 1.4 KB');
      release();
      await page.waitForFunction((sel) => /28 triangles/.test(document.querySelector(sel)?.textContent ?? ''), sub, { timeout: 15_000 });
      expect(await text(page, sub)).toBe('STL · 28 triangles · 1.4 KB');
      expect(asked).toBeGreaterThanOrEqual(2);
      expect(errors).toEqual([]);
    } finally { release(); await page.close(); }
  });

  it('at 800 × 600 the panel fits: nothing scrolls sideways, the view is drawn, every text 11 px or more', async () => {
    const { page, errors } = await open({ width: 800, height: 600 });
    try {
      await page.waitForFunction(() => Number((document.querySelector('[data-create="canvas"]') as HTMLElement | null)?.dataset.drawn ?? 0) > 0, null, { timeout: 15_000 });
      await settled(page);
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth, tab: document.getElementById('ws-create')!.scrollWidth, tabInner: document.getElementById('ws-create')!.clientWidth }));
      expect(Math.max(m.page, m.body)).toBeLessThanOrEqual(m.inner);
      expect(m.tab).toBeLessThanOrEqual(m.tabInner);
      const p = await pixels(page);
      expect(p.w).toBeGreaterThan(200);
      expect(p.h).toBeGreaterThan(150);
      expect(p.drawn).toBeGreaterThan(1000);
      const small = await page.evaluate(() => [...document.querySelectorAll('[data-panel-host="create"] *')].filter((el) => !el.closest('[hidden]') && el.getBoundingClientRect().width > 0
        && [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) && parseFloat(getComputedStyle(el).fontSize) < 11).map((el) => el.className));
      expect(small).toEqual([]);
      await page.$eval('[data-create-box="view"]', (e) => e.scrollIntoView());
      await settled(page);
      await shot(page, 'h153-08-tab6-800x600');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});

// R9 (H159): a recording read through the Rerun CLI in the background, as the page shows it, and a mesh the page's address
// names. FAKE, labelled: `rerun` is tests/fixtures/fake-rerun.mjs (a TEST DOUBLE replaying outputs CAPTURED from the real
// rerun-cli 0.38.1 on tests/fixtures/rrd-cli/probe.rrd and probe-cut.rrd), first on the companion's PATH, each rrd command
// held 400 ms (FAKE_RERUN_DELAY_MS) so the page is seen while it reads; the project, its two cubes and a file named .rrd that
// is not a recording are written by the test. Real: the server, its token, the page, src/vox/rrd-cli.ts. Captures are written
// only where H159_CAPS names a folder.
const CAPS159 = process.env.H159_CAPS ?? '';
describe.skipIf(!browserPath)('the companion\'s tab 6: recordings read through the Rerun CLI, and a mesh the address names (R9 H159)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    forgetRrdReadings();
    box = mkdtempSync(join(tmpdir(), 'r9-create-rrd-browser-'));
    const root = join(box, 'home', 'projects', 'FAKE-rec');
    const put = (rel: string, body: Buffer | string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
    put('rec/probe.rrd', readFileSync(resolve('tests/fixtures/rrd-cli/probe.rrd')));
    put('rec/cut.rrd', readFileSync(resolve('tests/fixtures/rrd-cli/probe-cut.rrd')));
    put('rec/not-one.rrd', 'FAKE: a file named .rrd that is not a recording\n');
    put('refs/a.stl', cubeStl(2));
    put('refs/b.stl', cubeStl(4));
    const bin = join(box, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'rerun'), `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-rerun.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'rerun'), 0o755);
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings'), PATH: `${bin}:/usr/bin:/bin`, FAKE_RERUN_DELAY_MS: '400' }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    if (CAPS159) mkdirSync(CAPS159, { recursive: true });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    await rrdReadingsIdle();
    forgetRrdReadings();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page on tab 6, its address carrying `query` before the token (as the Workbench's c gives it: src/workbench/servers.ts withQuery). */
  async function openAt(query: string, viewport = { width: 1376, height: 1600 }, before?: (page: Page) => Promise<void>): Promise<{ page: Page; errors: string[]; bad: string[] }> {
    const page = await browser.newPage({ viewport });
    if (before) await before(page);
    const errors: string[] = [];
    const bad: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    const at = companion.url.indexOf('#');
    const [base, hash] = at < 0 ? [companion.url, ''] : [companion.url.slice(0, at), companion.url.slice(at)];
    await page.goto(`${base}${base.includes('?') ? '&' : '?'}${query}${hash}`);
    await landedOn(page, 'motion');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.waitForSelector('[data-panel-host="create"] .create-mesh', { timeout: 15_000 });
    return { page, errors, bad };
  }
  /**
   * R11 round 7 (H176; SHELL CONTRACT v1): an address that names a tab (?tab=create…) lands on that PAGE by the shell's own rule
   * (shell.js land(): the page companion.js showed from the address, nothing to sign into here). The kit's landWorkspace sends
   * every page but Chat to Chat (its round-4 reading of current() as a screen id), which would undo what the address asked: so
   * here the landing itself is waited for and read — the page the address named, or the test says which page the shell chose.
   */
  async function landedOn(page: Page, id: string): Promise<void> {
    await page.waitForFunction(() => Boolean(document.body.dataset.screen), null, { timeout: 30_000 });
    await page.waitForFunction((want) => { const sh = (window as unknown as { TimmyShell?: { current(): string } }).TimmyShell; return Boolean(sh && sh.current() === want); }, id, { timeout: 15_000 })
      .catch(async () => { throw new Error(`the shell landed on ${await page.evaluate(() => (window as unknown as { TimmyShell?: { current(): string } }).TimmyShell?.current())}, not on ${id} as the address asked`); });
  }
  const text = (page: Page, sel: string): Promise<string> => page.$eval(sel, (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  /** A capture of the recordings box with `row` in view (the box scrolls inside), and the box's whole text, row by row. */
  const shot = async (page: Page, name: string, row: string): Promise<void> => {
    if (!CAPS159) return;
    await page.$eval(row, (e) => e.scrollIntoView({ block: 'start' }));
    await (await page.$('[data-create-box="recordings"]'))!.screenshot({ path: join(CAPS159, `${name}.png`) });
    const lines = await page.$$eval('[data-create-box="recordings"] .box-title, [data-create-box="recordings"] .create-rec-path, [data-create-box="recordings"] .create-note, [data-create-box="recordings"] dt, [data-create-box="recordings"] dd, [data-create-box="recordings"] .create-viewer-state',
      (es) => es.map((e) => `${e.tagName === 'DT' ? '  ' : e.tagName === 'DD' ? '      ' : ''}${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}`));
    writeFileSync(join(CAPS159, `${name}.txt`), `${lines.join('\n')}\n`);
  };

  it('a recording says "being read", then its entities and time ranges with who read them; each unknown says why', async () => {
    // FAKE, labelled: a receipt on the per-test chain saying a job of this project wrote rec/probe.rrd with these bytes
    const probeBytes = readFileSync(resolve('tests/fixtures/rrd-cli/probe.rrd'));
    const sealed = appendReceipt('runs', {
      kind: 'run', subject: 'FAKE: python mk-probe.py', policy: 'human-gated', status: 'ok', project: 'FAKE-rec', project_id: projectId(join(box, 'home', 'projects', 'FAKE-rec')),
      job: { id: 'jFAKE01', kind: 'shell', label: 'FAKE mk-probe.py', state: 'done' },
      outputs: [{ path: 'rec/probe.rrd', sha256: createHash('sha256').update(probeBytes).digest('hex'), bytes: probeBytes.length }],
    } as Parameters<typeof appendReceipt>[1]);
    const short = sealed.hash.replace(/^sha256[:_]/, '').slice(0, 8);
    const { page, errors, bad } = await openAt('tab=create');
    try {
      const probe = '[data-create-recording="rec/probe.rrd"]';
      await page.waitForSelector(`${probe} [data-rec="cli"]`, { timeout: 15_000 });
      expect(await text(page, `${probe} [data-rec="cli"]`)).toBe('being read by the Rerun CLI, in the background');
      expect(await text(page, `${probe} [data-rec="entities"]`)).toBe('being read by the Rerun CLI, in the background');
      await shot(page, 'h159-01-tab6-being-read', probe);
      // the page asks again while a recording is being read, and draws the reading once it is done
      await page.waitForFunction((sel) => /^read by rerun-cli/.test(document.querySelector(sel)?.textContent ?? ''), `${probe} [data-rec="cli"]`, { timeout: 30_000 });
      const rows = await page.$$eval(`${probe} dt, ${probe} dd`, (es) => es.map((e) => `${e.tagName === 'DT' ? '# ' : ''}${(e.textContent ?? '').replace(/\s+/g, ' ').trim()}`));
      expect(rows).toEqual([
        '# header (read by Timmy from the file)', 'written by Rerun 0.38.1 · compression LZ4 · Protobuf · 11.5 KB',
        '# messages', '2 store info · 4 data chunks · 0 blueprint · ends with its end marker and a footer',
        '# stores', 'recording · application timmy-r9-probe · recording probe-1',
        '# read by the Rerun CLI', 'read by rerun-cli 0.38.1: rrd stats and rrd print',
        "# Rerun's own check", 'rrd verify: 1 file verified without error.',
        '# entities (4)', '/__properties · /notes · /world/box · /world/points',
        '# static (logged on no timeline)', '/__properties · /notes',
        '# timelines (3)', 'frame · sequence · 0 to 7',
        'log_time · timestamp · 2026-10-20T12:53:49.704175155 to 2026-10-20T12:53:49.706428498 (2.253343 ms)',
        't · duration · 0 s to 1 s',
        '# written by', `written by job jFAKE01 (FAKE mk-probe.py) · receipt ${short} sealed these bytes`,
        "# not decoded by Timmy's own reader", "inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it",
      ]);
      // a recording cut short: Rerun's own check failed, with its words, and nothing more was read
      const cut = '[data-create-recording="rec/cut.rrd"]';
      expect(await text(page, `${cut} [data-rec="cli"]`)).toBe('rerun-cli 0.38.1 could not verify it (rrd verify failed), so nothing more was read');
      expect(await text(page, `${cut} [data-rec="verify"]`)).toBe('✕ failed: rrd verify ended with exit 1: stdin: Missing RRD footer / no RRD manifests · Error: Verification failed with 1 errors (the recording was given on its standard input)');
      expect(await text(page, `${cut} [data-rec="entities"]`)).toBe("unknown: not read: Rerun's own check of the file failed (rrd verify), so its stats and print were not run");
      // a file named .rrd that is not a recording: never given to the CLI
      const notOne = '[data-create-recording="rec/not-one.rrd"]';
      expect(await text(page, `${notOne} .create-note`)).toMatch(/^\d+ B · not read: its first bytes are not a Rerun recording's \(RRF2\)$/);
      expect(await text(page, `${notOne} [data-rec="cli"]`)).toBe("not given to the Rerun CLI: Timmy's own header reader says its first bytes are not a Rerun recording's (RRF2)");
      expect(await text(page, '.create-viewer-state')).toBe("Rerun's viewer: found (installed here, not run)");
      await shot(page, 'h159-02-tab6-read', probe);
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('every other state the reader gives is drawn with its why: a version not checked, a timeout, kinds or ranges not read, the edge sample', async () => {
    // FAKE, labelled: the list's recordings are replaced (page.route) by rows whose readings are the real outputs of
    // src/vox/rrd-cli.ts readRrdWithCli over the FAKE rerun in its other modes, and over the edge sample; the page draws them
    const bin = join(box, 'bin');
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: `${bin}:/usr/bin:/bin`, ...extra });
    const probeBytes = readFileSync(resolve('tests/fixtures/rrd-cli/probe.rrd'));
    const readings: Record<string, RrdReading> = {
      'rec/a-version.rrd': await readRrdWithCli(probeBytes, { env: env({ FAKE_RERUN_MODE: 'version=0.37.1' }) }),
      // R10 lead: the time limit applies to every call, and the FAKE `rerun` is a Node program that took over 0.4 s just to
      // start on a loaded 2-CPU machine (seen beside six busy loops: rerun --version timed out, so verify was never run and
      // no verify row was drawn): 3 s for each call, far under the 30 s the FAKE's stats sleeps, so only stats times out, as
      // this case means
      'rec/b-slow.rrd': await readRrdWithCli(probeBytes, { env: env({ FAKE_RERUN_MODE: 'sleep:stats' }), timeoutMs: 3000 }),
      'rec/c-kinds.rrd': await readRrdWithCli(probeBytes, { env: env({ FAKE_RERUN_MODE: 'garbage:print-vv' }) }),
      'rec/d-ranges.rrd': await readRrdWithCli(probeBytes, { env: env(), dataMax: 1024 }),
      'rec/e-edge.rrd': await readRrdWithCli(readFileSync(resolve('tests/fixtures/rrd-cli/edge.rrd')), { env: env() }),
      // the repository's own recording, a recording store and a blueprint store: the FAKE holds its verify and stats only
      'rec/f-stores.rrd': await readRrdWithCli(readFileSync(RRD), { env: env() }),
    };
    // every list answer, the page's first too (asked before the page knows its project, so without ?project=)
    const { page, errors } = await openAt('tab=create', undefined, (p) => p.route((url) => url.pathname === '/api/panel/create/meshes', async (route) => {
      const res = await route.fetch();
      const body = await res.json() as { recordings: Array<{ path: string }>; recordingsPending: number };
      const row = body.recordings.find((r) => r.path === 'rec/probe.rrd')!;
      body.recordings = Object.entries(readings).map(([path, cli]) => ({ ...row, path, cli }));
      body.recordingsPending = 0;
      await route.fulfill({ response: res, json: body });
    }));
    try {
      const at = (rel: string, sel: string): Promise<string> => text(page, `[data-create-recording="${rel}"] ${sel}`);
      await page.waitForSelector('[data-create-recording="rec/e-edge.rrd"] [data-rec="cli"]', { timeout: 15_000 });
      const unchecked = 'rerun-cli 0.37.1 is installed here, and Timmy reads only the output of rerun-cli 0.38.1 (the version its reading was checked against), so it ran nothing more';
      expect(await at('rec/a-version.rrd', '[data-rec="cli"]')).toBe(`not read by the Rerun CLI: ${unchecked}`);
      expect(await at('rec/a-version.rrd', '[data-rec="entities"]')).toBe(`unknown: ${unchecked}`);
      expect(await at('rec/b-slow.rrd', '[data-rec="verify"]')).toBe('rrd verify: 1 file verified without error.');
      expect(await at('rec/b-slow.rrd', '[data-rec="entities"]')).toBe('unknown: rrd stats gave no answer in 3 s, so it was stopped (its process group was killed)');
      const vv = "unknown: rrd print -vv's output does not parse as rerun-cli 0.38.1's: it printed 0 chunks, and rrd stats counted 4";
      expect(await at('rec/c-kinds.rrd', '[data-rec="entities"]')).toBe('/__properties · /notes · /world/box · /world/points');
      expect(await at('rec/c-kinds.rrd', '[data-rec="static"]')).toBe(vv);
      expect(await at('rec/c-kinds.rrd', '[data-rec-timeline="frame"]')).toBe(`frame · ${vv}`);
      expect(await at('rec/d-ranges.rrd', '[data-rec-timeline="t"]')).toBe('t · duration · range unknown: not read: rrd print -vvv prints the data itself, and is run here only on a recording of at most 1.0 KB (this one is 11.5 KB)');
      expect(await at('rec/e-edge.rrd', '[data-rec="entities"]')).toBe('/__properties · /a/b · /space\\ name/é · /text');
      // one store in it: its timelines are its recording's (with a blueprint store too, the label says they are counted across stores)
      expect(await page.$$eval('[data-create-recording="rec/e-edge.rrd"] dt', (ds) => ds.map((d) => (d.textContent ?? '').trim()).filter((t) => t.startsWith('timelines')))).toEqual(['timelines (4)']);
      expect(await page.$$eval('[data-create-recording="rec/e-edge.rrd"] [data-rec-timeline]', (ds) => ds.map((d) => (d.textContent ?? '').trim()))).toEqual([
        'frame · sequence · -5 to 9007199254740993',
        'log_time · timestamp · 2026-10-20T13:10:10.483927785 to 2026-10-20T13:10:10.487049994 (3.122209 ms)',
        't · duration · -1.25 s to 3725.000000001 s',
        'wall · timestamp · 1970-01-01T00:00:00 to 2026-10-20T12:53:45.500 (1792500825.5 s)',
      ]);
      // two stores in one file: rrd stats counts their entities and timelines together, and the page says so
      const stores = '[data-create-recording="rec/f-stores.rrd"]';
      expect(await at('rec/f-stores.rrd', '[data-rec="cli"]')).toBe('read by rerun-cli 0.38.1: rrd stats');
      expect(await at('rec/f-stores.rrd', '[data-rec="stores-cli"]')).toBe('recording timmy-context-evidence (7) · blueprint timmy-context-evidence (6)');
      expect(await page.$$eval(`${stores} dt`, (ds) => ds.map((d) => (d.textContent ?? '').trim()).filter((t) => /^(entities|timelines|counted)/.test(t)))).toEqual(['entities (13)', 'counted together, across', "timelines (3, across the file's stores)"]);
      const noCapture = 'unknown: rrd print -vv ended with exit 3: FAKE rerun (tests/fixtures/fake-rerun.mjs): no capture of `rerun rrd print -vv` for these bytes (sha256 8304232f8a69)';
      expect(await at('rec/f-stores.rrd', '[data-rec-timeline="blueprint"]')).toBe(`blueprint · ${noCapture}`);
      await shot(page, 'h159-03-tab6-other-states', '[data-create-recording="rec/a-version.rrd"]');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('the address names a mesh (mesh=<its path as lowercase hex of its UTF-8 bytes>): it is selected on the first list; else the first measured one', async () => {
    const hex = (p: string): string => Buffer.from(p, 'utf8').toString('hex');
    const selected = (page: Page): Promise<string[]> => page.$$eval('.create-mesh[aria-current="true"]', (bs) => bs.map((b) => (b as HTMLElement).dataset.createMesh ?? ''));
    for (const [query, want] of [[`tab=create&mesh=${hex('refs/b.stl')}`, 'refs/b.stl'], ['tab=create', 'refs/a.stl'], [`tab=create&mesh=${hex('refs/none.stl')}`, 'refs/a.stl'], ['tab=create&mesh=zz', 'refs/a.stl']] as const) {
      const { page, errors } = await openAt(query);
      try {
        await page.waitForFunction((w) => document.querySelector('[data-create="view-title"]')?.textContent === `The view you can turn · ${w}`, want, { timeout: 15_000 });
        expect(await selected(page), query).toEqual([want]);
        expect(await text(page, '[data-create="measure-title"]'), query).toBe(`Measured from the file · ${want}`);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  });
});
