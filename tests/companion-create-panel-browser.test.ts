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
 * FAKE, labelled: the projects (written by the test) and a large flat mesh (scans/strip.stl, a strip of triangles written by
 * the test). Real: the server, its token, Timmy's STL reader, the demo mesh as its script generated it
 * (examples/visual-tools/demo-tray.stl), the Rerun header reader over the repository's own recording
 * (studio/ctx-c3w8/…/context.rrd, read, never changed), the page's code. Captures are written only where H153_CAPS names a
 * folder. Skipped, saying so, where no Chromium or Chrome is found.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { DOCTRINE_15, num, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { projectId } from '../src/project/index.js';
import { VIEW_MAX_TRIANGLES, VIEW_WORDS } from '../src/vox/meshes.js';
import { DEMO_HEADER, DEMO_MESH } from '../scripts/demo-mesh.mjs';
import { cubeStl } from './helpers/vox-fakes.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-create-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const RRD = resolve('studio/ctx-c3w8/checkpoints/C5/exports/context.rrd');
const CAPS = process.env.H153_CAPS ?? '';
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
    mkdirSync(join(root, 'rec'), { recursive: true });
    copyFileSync(RRD, join(root, 'rec', 'context.rrd'));
    put(other, 'refs/theirs.stl', cubeStl(5));
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    if (CAPS) mkdirSync(CAPS, { recursive: true });
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
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.keyboard.press('6');
    await page.waitForSelector('[data-panel-host="create"] .create-mesh', { timeout: 15_000 });
    return { page, errors, bad };
  }
  const text = (page: Page, sel: string): Promise<string> => page.$eval(sel, (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  const settled = (page: Page): Promise<unknown> => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  /** The canvas's pixels: a hash of them all, how many differ from the stage's ground, and whether every one is a neutral grey. */
  const pixels = (page: Page) => page.$eval('[data-create="canvas"]', (c) => {
    const cv = c as HTMLCanvasElement;
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    let hash = 2166136261;
    let drawn = 0;
    let neutral = true;
    for (let i = 0; i < d.length; i += 4) {
      hash = Math.imul(hash ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619) >>> 0;
      if (d[i] !== 7 || d[i + 1] !== 7 || d[i + 2] !== 7) drawn += 1;
      if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) neutral = false;
    }
    return { hash, drawn, neutral, w: cv.width, h: cv.height, triangles: Number(cv.dataset.drawn ?? 0) };
  });
  const viewName = (page: Page): Promise<string> => text(page, '[data-create="view-name"]');
  const shot = async (page: Page, name: string): Promise<void> => { if (CAPS) await page.screenshot({ path: join(CAPS, `${name}.png`) }); };

  it('draws the demo mesh; a drag turns it; F, T and S show the front, top and side with their names; R the first view; the measurements are the file\'s', async () => {
    const { page, errors, bad } = await open();
    try {
      // the list: the project's meshes, the demo tray first chosen (the first measured, by path)
      expect(await page.$$eval('.create-mesh', (bs) => bs.map((b) => [(b as HTMLElement).dataset.createMesh, b.getAttribute('aria-current')]))).toEqual([['refs/demo-tray.stl', 'true'], ['scans/strip.stl', 'false']]);
      expect(await text(page, '[data-create="meshes-title"]')).toBe('Meshes in this project (2)');
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

      // a drag turns it
      const c = (await page.$('[data-create="canvas"]'))!;
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

      // the page's tab 6: the frame's Unfinished words are drawn above the panel (H152's box, prepended to the tab's page):
      // nothing of the panel is above them, and the panel's view stays in sight under them. Where this branch draws no box,
      // a FAKE stand-in of its shape is prepended the same way (labelled FAKE), so the panel's side of it is still checked.
      const order = await page.evaluate(() => {
        const page6 = document.getElementById('ws-create')!;
        const host = page6.querySelector('[data-panel-host="create"]')!;
        let box = page6.querySelector(':scope > .unfinished, :scope > [data-unfinished]');
        const real = Boolean(box);
        if (!box) {
          box = document.createElement('section');
          box.className = 'unfinished';
          box.setAttribute('data-unfinished', 'create');
          for (const t of ['◌ Unfinished · 3D & Motion (FAKE stand-in: the test drew it)', 'Works now: FAKE words the frame would give', 'Not yet: FAKE words the frame would give']) { const p = document.createElement('p'); p.textContent = t; box.append(p); }
          page6.prepend(box);
        }
        const kids = [...page6.children];
        const at = (e: Element) => e.getBoundingClientRect();
        const view = page6.querySelector('[data-create="stage"]')!;
        return { real, before: kids.slice(0, kids.indexOf(host)).map((e) => e.className), above: at(box).bottom <= at(host).top + 1, viewInSight: at(view).bottom <= at(page6).bottom + 1 && at(view).height > 150 };
      });
      await settled(page);
      await shot(page, order.real ? 'h153-09-tab6-under-the-unfinished-box' : 'h153-09-tab6-under-a-FAKE-stand-in-unfinished-box');
      expect(order.before).toEqual(['unfinished']);
      expect(order.above).toBe(true);
      expect(order.viewInSight).toBe(true);
      if (!order.real) console.warn('companion-create-panel-browser: no Unfinished box is drawn on this branch (H152 draws it), so a FAKE stand-in of its shape was checked');

      // another project's mesh, asked from this page with its token, is refused; the list holds only this project's
      const token = /t=([0-9a-f]{64})/.exec(new URL(companion.url).hash)?.[1] ?? '';
      const refused = await page.evaluate(async ({ t, id }) => {
        const r = await fetch(`/api/panel/create/mesh?path=${encodeURIComponent('refs/theirs.stl')}&project=${id}`, { headers: { Authorization: `Bearer ${t}` } });
        return [r.status, (await r.json()).error];
      }, { t: token, id: projectId(root) });
      expect(refused).toEqual([404, 'Refused: refs/theirs.stl is not a mesh of this project (tab 6 lists its STL files and tessellations), so it is not served.']);
      expect(await page.$$eval('.create-mesh', (bs) => bs.map((x) => (x as HTMLElement).dataset.createMesh))).not.toContain('refs/theirs.stl');

      // every text of the tab at 11 px or more; the palette: no blue, purple or cyan, no green (nothing live or sealed here)
      const look = await page.evaluate(() => {
        const parse = (v: string): number[] | null => { const mm = /^rgba?\(([^)]+)\)$/.exec(v.trim()); if (!mm) return null; const p = mm[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
        const hsl = ([rr, gg, bb]: number[]) => { const [R, G, B] = [rr / 255, gg / 255, bb / 255]; const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min; if (d === 0) return { h: 0, s: 0, l }; const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4); return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
        const out = { small: [] as string[], hue: [] as string[], green: [] as string[], amber: [] as string[] };
        for (const el of document.querySelectorAll('#ws-create [data-panel-host="create"], #ws-create [data-panel-host="create"] *')) {
          if (el.closest('[hidden]')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || el.getBoundingClientRect().width === 0) continue;
          if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) && parseFloat(cs.fontSize) < 11) out.small.push(`${el.tagName}.${el.className} ${cs.fontSize}`);
          for (const prop of ['color', 'background-color', 'border-top-color', 'border-left-color']) {
            const c = parse(cs.getPropertyValue(prop)); if (!c || c[3] === 0) continue;
            const { h, s, l } = hsl(c); if (s < 0.2 || l < 0.08 || l > 0.92) continue;
            if (h >= 150 && h <= 320) out.hue.push(`${el.tagName} ${prop}`);
            else if (h >= 75 && h < 150) out.green.push(`${el.tagName}.${el.className} ${prop}`);
            else if (c[0] === 255 && c[1] === 176 && c[2] === 0) out.amber.push(`${el.tagName}.${el.className}`);
          }
        }
        return out;
      });
      expect(look.small).toEqual([]);
      expect(look.hue).toEqual([]);
      expect(look.green).toEqual([]);
      // amber only where the selection is (the chosen mesh, the pressed view's key)
      for (const a of look.amber) expect(a).toMatch(/create-mesh|create-key/);
      expect(bad.filter((x) => !x.startsWith('404 /api/panel/create/mesh'))).toEqual([]);
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
      expect(await text(page, `${rec} [data-rec="unknown"]`)).toBe("unknown to Timmy: inside the recording's data chunks (compressed Arrow), which Timmy does not decode; Rerun's viewer shows it");
      expect(await page.$eval('[data-create-viewer]', (v) => v.getAttribute('data-create-viewer'))).toBe('needs setup');
      expect(await text(page, '.create-viewer-state')).toBe("Rerun's viewer: needs setup");
      await page.$eval('[data-create-box="recordings"]', (e) => e.scrollIntoView());
      await shot(page, 'h153-07-tab6-recordings');
      expect(bad).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('a mesh still being measured says so, and the page asks again until the list holds its measurements', async () => {
    const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // FAKE: the page's first list answer is the server's own with the demo tray marked as not measured yet (as a reading
    // whose time budget ran out leaves a large mesh); every later answer is the server's, untouched
    let asked = 0;
    await page.route('**/api/panel/create/meshes?**', async (route) => {
      asked += 1;
      if (asked > 1) { await route.continue(); return; }
      const res = await route.fetch();
      const body = await res.json() as { meshes: Array<Record<string, unknown>>; pending: number };
      body.meshes = body.meshes.map((m) => (m.path === 'refs/demo-tray.stl' ? { path: m.path, kind: 'stl', bytes: m.bytes, origin: { provenance: 'not recorded', words: 'not read yet' }, pending: true, why: "being measured: Timmy's own STL reader reads it next (the list is read again in a moment)" } : m));
      body.pending = 1;
      await route.fulfill({ response: res, json: body });
    });
    try {
      await page.goto(companion.url);
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      await page.keyboard.press('6');
      const sub = '.create-mesh[data-create-mesh="refs/demo-tray.stl"] .create-mesh-sub';
      await page.waitForSelector(sub, { timeout: 15_000 });
      expect(await text(page, sub)).toBe('STL · being measured… · 1.4 KB');
      await page.waitForFunction((sel) => /28 triangles/.test(document.querySelector(sel)?.textContent ?? ''), sub, { timeout: 15_000 });
      expect(await text(page, sub)).toBe('STL · 28 triangles · 1.4 KB');
      expect(asked).toBeGreaterThanOrEqual(2);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
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
