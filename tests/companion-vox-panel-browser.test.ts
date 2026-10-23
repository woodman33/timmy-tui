/**
 * R6 (H143): the companion's VoxVision panel (tab 5; src/companion/client/panel-vox.js) in a real headless Chromium against
 * the real companion server on 127.0.0.1 and its token, reading what the page shows: the records newest first; the observed
 * image drawn (its naturalWidth); what was measured drawn over it, matching the record's corners, box and centroid, each
 * labelled with its provenance and evidence state; the entity tree, a selection highlighting its shapes; a video's frames on a
 * timeline, a frame chosen changing the image and what is drawn; an STL's three views; the pipeline as the record ran it and
 * what this computer has not; the receipt, green only when verified; the verdict line; one next step among the commands; the
 * palette (no blue, purple, cyan or mint; green only where .is-live or .is-verified marks it; text at least 4.5:1); and at
 * 390 px nothing scrolls sideways.
 *
 * FAKE, labelled: Look (tests/helpers/vox-fakes.ts, not OpenCV; the page says FAKE), the video record of
 * tests/helpers/vox-panel-kit.ts (its frames written by the test, saying FAKE). Real: the server, its token, the record writer
 * for /detect and /measure, Timmy's STL reader, the receipts and their verification, the page's code. Skipped, saying so,
 * where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { NO_VERDICT } from '../src/vox/preview.js';
import { act, cubeStl, fakeVideoRecord, put, SMALL, tempKit } from './helpers/vox-panel-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-vox-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

describe.skipIf(!browserPath)('the companion\'s VoxVision panel, in a real browser (R6 H143)', () => {
  const kit = tempKit();
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let browser: Browser;
  let companion: CompanionServer;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r6-vox-browser-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterEach(async () => { await kit.cleanup(); });
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  async function open(viewport = { width: 1376, height: 768 }): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(companion.url);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.keyboard.press('5');
    await page.waitForSelector('[data-panel-host="voxvision"] .vox-rec', { timeout: 15_000 });
    return { page, errors };
  }
  const choose = async (page: Page, id: string): Promise<void> => {
    await page.click(`.vox-rec[data-vox-record="${id}"]`);
    await page.waitForFunction((x) => (document.querySelector('[data-vox="tree-title"]')?.textContent ?? '') === `Entity tree · ${x}`, id, { timeout: 15_000 });
  };
  const imageDrawn = (page: Page, path: string) => page.waitForFunction((p) => {
    const i = document.querySelector('.vox-img') as HTMLImageElement | null;
    return !!i && i.dataset.path === p && i.complete && i.naturalWidth > 0 && !!document.querySelector('.vox-overlay')?.getAttribute('viewBox');
  }, path, { timeout: 15_000 });
  const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
  /**
   * R7 (H152): each mark's label, as laid out: on the band outside the image (its box never over the image's frame), shown
   * whole (not cut: as wide as its words or wrapped), and joined to its mark by a leader line.
   */
  const labelsOutside = (page: Page) => page.$eval('[data-vox="stage"]', (st) => {
    const f = st.querySelector('.vox-frame')!.getBoundingClientRect();
    return [...st.querySelectorAll('.vox-label')].map((l) => {
      const r = l.getBoundingClientRect();
      const clear = r.right <= f.left + 0.5 || r.left >= f.right - 0.5 || r.bottom <= f.top + 0.5 || r.top >= f.bottom - 0.5;
      const whole = r.width > 0 && l.scrollWidth <= l.clientWidth + 1;
      const tied = !!st.querySelector(`.vox-leaders line[data-label-for="${CSS.escape(l.getAttribute('data-label-for') ?? '')}"]`);
      return clear && whole && tied;
    });
  });

  it('draws a record\'s image with what was measured over it, its tree, a video\'s timeline, an STL\'s views, its pipeline, receipt and commands', async () => {
    put(root, 'refs/photo.png', SMALL);
    const video = fakeVideoRecord(root).id;
    const detect = await act(kit, root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    put(root, 'refs/cube.stl', cubeStl(10));
    const stl = await act(kit, root, (ws) => ws.measure('refs/cube.stl'));
    const { page, errors } = await open();
    try {
      // the records, newest first, each with its receipt verified now
      expect(await page.$$eval('.vox-rec', (bs) => bs.map((b) => (b as HTMLElement).dataset.voxRecord))).toEqual([stl, detect, video]);
      expect(await page.$$eval('.vox-rec .vox-receipt-mark', (ms) => ms.map((m) => (m as HTMLElement).dataset.verified))).toEqual(['true', 'true', 'true']);

      // the image record: the observed file drawn, what was measured over it in its own pixel frame
      await choose(page, detect);
      await imageDrawn(page, 'refs/photo.png');
      const img = await page.$eval('.vox-img', (i) => ({ w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight, src: (i as HTMLImageElement).src.slice(0, 22) }));
      expect(img).toEqual({ w: 4, h: 2, src: 'data:image/png;base64,' });
      expect(await page.$eval('.vox-overlay', (o) => o.getAttribute('viewBox'))).toBe('0 0 4 2');
      const shapes = await page.$$eval('.vox-overlay .ov', (els) => els.map((e) => ({
        entity: e.getAttribute('data-vox-entity'), shape: e.getAttribute('data-shape'), provenance: e.getAttribute('data-provenance'), evidence: e.getAttribute('data-evidence'),
        geom: e.tagName === 'polygon' ? e.getAttribute('points') : e.tagName === 'rect' ? ['x', 'y', 'width', 'height'].map((k) => e.getAttribute(k)).join(' ') : (e.querySelector('circle') ? ['cx', 'cy'].map((k) => e.querySelector('circle')!.getAttribute(k)).join(' ') : ''),
      })));
      expect(shapes).toEqual([
        { entity: 'qr-1', shape: 'polygon', provenance: 'measured', evidence: 'constructed', geom: '0,0 3,0 3,1 0,1' },
        { entity: 'color-region', shape: 'box', provenance: 'measured', evidence: 'constructed', geom: '1 0 2 1' },
        { entity: 'color-region', shape: 'point', provenance: 'measured', evidence: 'constructed', geom: '1.5 0.5' },
      ]);
      expect(await page.$$eval('[data-vox="stage"] .vox-label', (ls) => ls.map((l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual([
        'QR 1 "hello vox" · measured · constructed', 'colour region rgb(200, 10, 10) · measured · constructed', 'centroid · measured · constructed',
      ]);
      expect(await labelsOutside(page)).toEqual([true, true, true]); // R7 (H152): each label beside the 4 px image, whole, tied to its mark
      expect(await text(page, '[data-vox="caption"]')).toBe('the observed file (its bytes are the ones the record names) · drawn over it (px): 3 measured · constructed');
      expect(await text(page, '[data-vox="fake"]')).toBe('FAKE: made by a test double (timmy-look fake), not by the real tool');

      // the entity tree: selecting the colour region highlights its two shapes (amber), its row in the tree and its value
      expect(await page.$$eval('.vox-ent', (bs) => bs.map((b) => (b as HTMLElement).dataset.voxEntity))).toEqual(['record', 'inputs', 'input-1', 'observations', 'qr-1', 'color-region', 'images', 'image-1', 'values', 'value-1', 'value-2', 'value-3', 'receipt']);
      await page.click('.vox-ent[data-vox-entity="color-region"]');
      await page.waitForFunction(() => document.querySelectorAll('.vox-overlay .ov.is-selected').length === 2);
      expect(await page.$$eval('.vox-overlay .ov.is-selected', (els) => els.map((e) => [e.getAttribute('data-shape'), getComputedStyle(e).stroke]))).toEqual([['box', 'rgb(255, 176, 0)'], ['point', 'rgb(255, 176, 0)']]);
      expect(await page.$eval('.vox-overlay .ov[data-vox-entity="qr-1"]', (e) => getComputedStyle(e).stroke)).toBe('rgb(232, 228, 217)');
      expect(await page.$eval('.vox-ent[data-vox-entity="color-region"]', (b) => b.getAttribute('aria-current'))).toBe('true');
      expect(await page.$eval('.vox-val[aria-current="true"]', (v) => v.getAttribute('data-value'))).toBe('color_region');
      // the annotated copy the record sealed, chosen above the stage
      await page.click(`.vox-image-tab[data-vox-image="highlight:results/vox/${detect}/annotated.png"]`);
      await imageDrawn(page, `results/vox/${detect}/annotated.png`);

      // the pipeline as it ran, what this computer has not, the receipt green and verified, the verdict, one next step
      expect(await page.$$eval('[data-vox="steps"] .vox-step', (s) => s.map((x) => x.textContent))).toEqual(['.intent · asked', expect.stringMatching(/^Look \(OpenCV\) · job j[0-9a-f]{6} completed$/), '✓ .receipt · sealed and verified']);
      const absent = await text(page, '[data-vox="absent"]');
      for (const w of ['SAM 3 not installed', 'Depth Anything 3 not installed', 'Voxel grid from masks not in Timmy', 'Roboflow (hosted model) needs setup', 'Viser not used by VoxVision', 'FiftyOne not used by VoxVision']) expect(absent).toContain(w);
      const receipt = await page.$eval('[data-vox="receipt"]', (r) => ({ verified: r.getAttribute('data-verified'), mark: r.querySelector('.vox-receipt-mark')!.textContent, color: getComputedStyle(r.querySelector('.vox-receipt-mark')!).color }));
      expect(receipt).toEqual({ verified: 'true', mark: expect.stringMatching(/^✓ sealed and verified · receipt [0-9a-f]{8}$/), color: 'rgb(40, 254, 20)' });
      expect(await text(page, '[data-vox="verdict"]')).toBe(NO_VERDICT);
      const acts = await page.$$eval('.vox-act', (bs) => bs.map((b) => [b.getAttribute('data-vox-action'), b.getAttribute('data-copy'), b.classList.contains('is-next')]));
      expect(acts).toEqual([
        ['Open in Rerun', null, false], ['Measure it', '/measure refs/photo.png', true], ['Observe it', '/observe refs/photo.png', false],
        ['Do it again', '/detect refs/photo.png color 200,10,10', false], ['Open the record', `/open results/vox/${detect}.json`, false],
      ]);
      expect(await text(page, '[data-vox="next"]')).toBe('next: runs Look (OpenCV) on refs/photo.png as a job, and writes a new record with a vox receipt (a local change)');

      // the video record: its three sampled frames on a timeline; choosing one changes the image and what is drawn
      await choose(page, video);
      await imageDrawn(page, `results/vox/${video}/frames/frame-000005.png`);
      expect(await page.$eval('[data-vox-box="timeline"]', (b) => [(b as HTMLElement).hidden, b.getAttribute('data-frames')])).toEqual([false, '3']);
      expect(await page.$$eval('.vox-tick', (ts) => ts.map((t) => [t.textContent, t.getAttribute('aria-current')]))).toEqual([['0.5 s · frame 5', 'true'], ['1 s · frame 10', 'false'], ['1.5 s · frame 15', 'false']]);
      expect(await page.$eval('.vox-overlay rect', (r) => r.getAttribute('x'))).toBe('16');
      await page.click('.vox-tick[data-vox-frame="2"]');
      await imageDrawn(page, `results/vox/${video}/frames/frame-000015.png`);
      expect(await page.$eval('.vox-img', (i) => (i as HTMLImageElement).naturalWidth)).toBe(160);
      expect(await page.$eval('.vox-overlay', (o) => o.getAttribute('viewBox'))).toBe('0 0 160 120');
      expect(await page.$eval('.vox-overlay rect', (r) => ['x', 'y', 'width', 'height'].map((k) => r.getAttribute(k)).join(' '))).toBe('112 40 32 32');
      expect(await page.$eval('[data-vox="stage"] .vox-label', (l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim())).toBe('colour region at 1.5 s · measured · inferred');
      expect(await labelsOutside(page)).toEqual([true, true]); // R7 (H152): the box's label and the centroid's, beside the frame, tied
      expect(await page.$$eval('.vox-tick', (ts) => ts.map((t) => t.getAttribute('aria-current')))).toEqual(['false', 'false', 'true']);
      await page.keyboard.press('ArrowLeft');
      await imageDrawn(page, `results/vox/${video}/frames/frame-000010.png`);

      // the STL record: three views drawn from its own triangles
      await choose(page, stl);
      await page.waitForSelector('.vox-proj-svg path.vox-proj-lines');
      expect(await page.$$eval('.vox-proj', (fs) => fs.map((f) => [f.getAttribute('data-view'), f.getAttribute('data-lines'), (f.querySelector('path')?.getAttribute('d') ?? '').length > 10]))).toEqual([['front', '4', true], ['top', '4', true], ['side', '4', true]]);
      expect(await text(page, '.vox-mesh-words')).toBe("12 triangles · box 10 × 10 × 10 · 12 feature edges; a drawing of the file, measuring nothing · in the file's units (an STL declares none) · provenance not recorded · evidence declared");

      // the palette, over the whole tab: no blue, purple, cyan or mint; green only within .is-live or .is-verified; contrast
      const seen = await page.evaluate(() => {
        const parse = (v: string): number[] | null => { const m = /^rgba?\(([^)]+)\)$/.exec(v.trim()); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
        const hsl = ([r, g, b]: number[]) => { const [R, G, B] = [r / 255, g / 255, b / 255]; const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min; if (d === 0) return { h: 0, s: 0, l }; const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4); return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
        const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const out = { hue: [] as string[], green: [] as string[], greens: 0, contrast: [] as string[] };
        for (const el of document.querySelectorAll('#ws-voxvision, #ws-voxvision *')) {
          if (el.closest('[hidden]')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || el.getBoundingClientRect().width === 0) continue;
          for (const prop of ['color', 'background-color', 'border-top-color', 'border-left-color', 'fill', 'stroke']) {
            const c = parse(cs.getPropertyValue(prop)); if (!c || c[3] === 0) continue;
            const { h, s, l } = hsl(c); if (s < 0.2 || l < 0.08 || l > 0.92) continue;
            if (h >= 150 && h <= 320) out.hue.push(`${el.tagName} ${prop}`);
            else if (h >= 75 && h < 150) { if (el.closest('.is-live, .is-verified')) out.greens += 1; else out.green.push(`${el.tagName}.${el.className} ${prop}`); }
          }
          if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) || el.closest('svg')) continue;
          const fg = parse(cs.color); if (!fg) continue;
          let bg = [0, 0, 0]; for (let e: Element | null = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b[3] > 0.5) { bg = b.slice(0, 3); break; } }
          const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          if ((hi + 0.05) / (lo + 0.05) < 4.5) out.contrast.push(`${el.tagName}.${el.className}: ${(el.textContent ?? '').trim().slice(0, 30)}`);
        }
        return out;
      });
      expect(seen.hue).toEqual([]);
      expect(seen.green).toEqual([]);
      expect(seen.contrast).toEqual([]);
      expect(seen.greens).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('an address naming a record (?vox=<id>, as the Workbench\'s c gives it) opens the panel on that record, not the newest', async () => {
    put(root, 'refs/photo.png', SMALL);
    const older = await act(kit, root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    put(root, 'refs/cube.stl', cubeStl(10));
    const newer = await act(kit, root, (ws) => ws.measure('refs/cube.stl'));
    const page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      const u = new URL(companion.url);
      u.search = `?vox=${older}`;
      await page.goto(u.toString());
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      await page.keyboard.press('5');
      await page.waitForFunction((x) => (document.querySelector('[data-vox="tree-title"]')?.textContent ?? '') === `Entity tree · ${x}`, older, { timeout: 15_000 });
      expect(await page.$eval(`.vox-rec[data-vox-record="${older}"]`, (b) => b.getAttribute('aria-current'))).toBe('true');
      expect(await page.$eval(`.vox-rec[data-vox-record="${newer}"]`, (b) => b.getAttribute('aria-current'))).toBe('false');
      expect(page.url()).not.toContain('#t='); // the page took its token out of the address, as ever
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('at 390 px wide the tab stacks its columns and nothing scrolls sideways', async () => {
    put(root, 'refs/photo.png', SMALL);
    await act(kit, root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    const { page, errors } = await open({ width: 390, height: 844 });
    try {
      await page.waitForSelector('.vox-img', { timeout: 15_000 });
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      expect(Math.max(m.page, m.body)).toBeLessThanOrEqual(m.inner);
      const cols = await page.$$eval('.vox-cols > *', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right) }; }));
      expect(cols).toHaveLength(3);
      expect(new Set(cols.map((c) => c.left)).size).toBe(1);
      for (let i = 1; i < cols.length; i += 1) expect(cols[i].top).toBeGreaterThan(cols[i - 1].top);
      for (const c of cols) expect(c.right).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});
