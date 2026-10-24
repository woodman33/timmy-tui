/**
 * R6 lead (the operator's R6 order: "A command list or 'not available' sentence does not complete a requested preview"; the
 * lead's capture of the candidate at 1376x768): the companion's previews are drawn, legible and shown at size, in a real
 * headless Chromium against the real companion server on 127.0.0.1 and its token.
 *
 *  - Home (reference 01) draws the newest images of the shown project: the newest run's image output and the newest VoxVision
 *    record's image, each a thumbnail with its words and the action that opens it (the run in Workflows; the record in
 *    VoxVision, chosen there);
 *  - a thumbnail pressed shows the image at size in a dialog (panels.js TimmyEnlarge); Esc closes it and the keyboard is given
 *    back to the thumbnail;
 *  - the run viewer's image fits the box it is seen in at 1376x768 (it showed only its top before);
 *  - VoxVision's labels of a large image are at least 11 px on screen, on a band outside the image, each tied to its mark
 *    (R7 H152; they were drawn inside the image's frame);
 *  - one amber next step on tab 5: the strip's primary (the record's own next step is a brighter neutral).
 *
 * Real: the server, its token, a /run in the REPL's own Workspace (upmd is the TEST DOUBLE of tests/helpers/ops-sandbox.ts,
 * labelled FAKE there), its records read by the companion's own producer, the page's code. FAKE, labelled: the two VoxVision
 * records (written and sealed by tests/helpers/vox-panel-kit.ts sealRecord, saying FAKE; no tool ran) and their images.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { folderProject, saveActiveProject } from '../src/project/index.js';
import { opsKit, replOf, sandbox } from './helpers/ops-sandbox.js';
import { reportProject, runOf } from './helpers/run-inspect-fixture.js';
import { png, sealRecord, writeFile } from './helpers/vox-panel-kit.js';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-previews-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const AMBER = 'rgb(255, 176, 0)';
const F = '```';
const kit = opsKit();
const dirs: string[] = [];
afterEach(async () => { await kit.cleanup(); }, 60_000);
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A FAKE VoxVision record of one image, `w` × `h`, with a colour region measured over it (written, sealed; no tool ran). */
function fakeImageRecord(root: string, id: string, rel: string, w: number, h: number, at: string, box: [number, number, number, number]): void {
  const img = writeFile(root, rel, png(w, h, (x, y) => (x >= box[0] && x < box[2] && y >= box[1] && y < box[3] ? [240, 240, 240] : [24, 24, 24])));
  sealRecord(root, {
    schema: 'timmy.vox/1', id, action: 'detect', command: `/detect ${rel} color 240,240,240`, made_at: at, project: folderProject(root).name, status: 'ok',
    inputs: [{ ...img, kind: 'image', kind_by: 'bytes', frame: { space: 'pixels', unit: 'px', unit_by: 'reported', size: [w, h], words: `the image's pixel frame: ${w} × ${h} px (FAKE)` } }],
    tools: [{ tool: 'look', name: 'timmy-look', version: 'fake', ran: 'job', job: { id: 'j0fa4e3', state: 'completed', exit_code: 0 } }],
    metrics: [{
      name: 'color_region', title: 'Colour region',
      value: { rgb: [240, 240, 240], tolerance: 48, pixels: (box[2] - box[0]) * (box[3] - box[1]), share: ((box[2] - box[0]) * (box[3] - box[1])) / (w * h), centroid: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], box },
      unit: 'pixels', method: 'FAKE: written by the test, not measured', tier: 'deterministic computation', label: 'FAKE fixture', measured_by: 'timmy-look fake',
      status_word: 'measured', status_note: 'FAKE: written by the test',
    }],
    highlights: [], failures: [], notes: ['FAKE: a test fixture (tests/companion-previews-browser.test.ts): no image was read and no tool ran.'],
  });
}

describe.skipIf(!browserPath)('the companion\'s previews: drawn, legible and shown at size (R6 lead)', () => {
  let browser: Browser;
  beforeAll(async () => {
    await ensureCompanionWeb();
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);
  afterAll(async () => { await browser?.close(); });

  it('Home\'s newest images open at size and where they belong; the run viewer\'s image fits; VoxVision labels are legible; one amber next step on tab 5', async () => {
    const s = sandbox(kit, 'previews-browser-');
    reportProject(s);
    // the run: one block that writes a 640 × 360 image (the size the review demo's example has)
    const big = png(640, 360, (x, y) => (x > 200 && x < 440 && y > 120 && y < 240 ? [240, 240, 240] : [30, 30, 30]));
    const doc = ['# FAKE preview run (this test)', '', `${F}bash [name:shot]`, 'mkdir -p out', `printf '%s' '${big.toString('base64')}' | base64 -d > out/shot.png`, F, ''].join('\n');
    writeFile(s.root, 'SHOT.md', doc);
    const { ws } = replOf(kit, s);
    const { op } = await runOf(ws, 'SHOT.md', 'shot');
    // two FAKE VoxVision records: an older one of a large image (1280 × 720), then the newest (640 × 360)
    fakeImageRecord(s.root, 'vfa4e0b16', 'refs/large.png', 1280, 720, '2026-10-16T12:00:00.000Z', [200, 300, 900, 420]);
    fakeImageRecord(s.root, 'vfa4e0b17', 'refs/newest.png', 640, 360, '2026-10-16T12:05:00.000Z', [100, 60, 300, 160]);
    saveActiveProject({ name: path.basename(s.root), root: s.root, chosen: true });
    const settings = mkdtempSync(path.join(tmpdir(), 'previews-settings-'));
    dirs.push(settings);
    const companion: CompanionServer = await startCompanionServer(0, { chatEnv: { TIMMY_HOME: settings, TIMMY_SETTINGS_DIR: settings } });
    const origin = `http://127.0.0.1:${companion.port}`;
    const token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
    const context = await browser.newContext({ viewport: { width: 1376, height: 768 }, deviceScaleFactor: 1 });
    try {
      await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${origin}/?tab=home#t=${token}`);
      await landWorkspace(page);

      // ── Home: the newest images, each with its words and its action ──
      const thumbs = '#home-preview [data-preview="images"]';
      await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-home-image] img`).length === 2
        && [...document.querySelectorAll<HTMLImageElement>(`${sel} [data-home-image] img`)].every((i) => i.complete && i.naturalWidth > 0), thumbs, { timeout: 30_000 });
      const home = await page.$$eval(`${thumbs} [data-home-image]`, (els) => els.map((e) => ({
        kind: e.getAttribute('data-home-image'),
        natural: (e.querySelector('img') as HTMLImageElement).naturalWidth,
        shown: Math.round((e.querySelector('img') as HTMLImageElement).getBoundingClientRect().width),
        words: (e.querySelector('figcaption')?.textContent ?? '').trim(),
        open: e.querySelector('[data-open-run], [data-open-vox]')?.getAttribute(e.querySelector('[data-open-run]') ? 'data-open-run' : 'data-open-vox'),
      })));
      expect(home).toEqual([
        // (R10 H167, H168's F3 on the page: in words, each file by its name; the ids are their Open buttons')
        { kind: 'run', natural: 640, shown: expect.any(Number), words: 'run · shot.png · 640 × 360', open: op },
        { kind: 'vox', natural: 640, shown: expect.any(Number), words: 'VoxVision · detect · newest.png', open: 'vfa4e0b17' },
      ]);
      for (const t of home) expect(t.shown, `${t.kind} thumbnail`).toBeGreaterThan(60);

      // ── a thumbnail pressed: the image at size; Esc closes it and gives the keyboard back ──
      await page.click(`${thumbs} [data-home-image="run"] .home-thumb-btn`);
      await page.waitForSelector('dialog.enlarge[open]');
      const shown = await page.$eval('dialog.enlarge', (d) => {
        const r = d.getBoundingClientRect();
        return {
          natural: (d.querySelector('img') as HTMLImageElement).naturalWidth,
          width: (d.querySelector('img') as HTMLImageElement).clientWidth, // its own pixels, not scaled up (the border aside)
          words: (d.querySelector('figcaption')?.textContent ?? '').trim(),
          focus: document.activeElement?.className ?? '',
          // in the middle of the window, not in its corner (the lead's capture at e6b4da5 found it at the top left)
          centred: Math.abs(r.left - (innerWidth - r.right)) <= 2 && Math.abs(r.top - (innerHeight - r.bottom)) <= 2,
        };
      });
      expect(shown).toEqual({ natural: 640, width: 640, words: 'run · shot.png · 640 × 360', focus: 'btn-action enlarge-close', centred: true });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.enlarge')?.hasAttribute('open'));
      expect(await page.evaluate(() => document.activeElement?.closest('[data-home-image]')?.getAttribute('data-home-image'))).toBe('run');

      // ── VoxVision: the older, large record chosen there; its labels legible and inside the frame ──
      await page.keyboard.press('5');
      await page.waitForSelector('[data-panel-host="voxvision"] .vox-rec[data-vox-record="vfa4e0b16"]', { timeout: 15_000 });
      await page.click('.vox-rec[data-vox-record="vfa4e0b16"]');
      await page.waitForFunction(() => {
        const i = document.querySelector('.vox-img') as HTMLImageElement | null;
        return !!i && i.dataset.path === 'refs/large.png' && i.complete && i.naturalWidth === 1280 && document.querySelectorAll('[data-vox="stage"] .vox-label').length === 2;
      }, null, { timeout: 15_000 });
      // R7 (H152): the labels are on a band outside the image (its frame), at the page's own type size, each tied by a line
      const labels = await page.$eval('[data-vox="stage"]', (st) => {
        const f = st.querySelector('.vox-frame')!.getBoundingClientRect();
        return [...st.querySelectorAll('.vox-label')].map((l) => {
          const r = l.getBoundingClientRect();
          return {
            text: (l.textContent ?? '').replace(/\s+/g, ' ').trim(), px: parseFloat(getComputedStyle(l).fontSize),
            outside: r.right <= f.left + 0.5 || r.left >= f.right - 0.5 || r.bottom <= f.top + 0.5 || r.top >= f.bottom - 0.5,
            tied: !!st.querySelector(`.vox-leaders line[data-label-for="${CSS.escape(l.getAttribute('data-label-for') ?? '')}"]`),
          };
        });
      });
      // each label is still `<what> · <provenance> · <evidence>`
      expect(labels.map((l) => String(l.text).split(' · ')[0])).toEqual(['colour region rgb(240, 240, 240)', 'centroid']);
      for (const l of labels) expect(String(l.text).split(' · ')).toHaveLength(3);
      for (const l of labels) {
        expect(l.px, String(l.text)).toBeGreaterThanOrEqual(11);
        expect(l.outside, String(l.text)).toBe(true);
        expect(l.tied, String(l.text)).toBe(true);
      }
      // one amber next step on the tab: the strip's primary; the record's own next step is a brighter neutral
      const amber = await page.evaluate((a) => ({
        primaries: [...document.querySelectorAll('#ws-actions .act.is-primary, .act.is-primary')].filter((e) => (e as HTMLElement).offsetParent !== null).length,
        next: [...document.querySelectorAll('.vox-act.is-next')].map((e) => [getComputedStyle(e).borderTopColor === a, getComputedStyle(e.querySelector('.vox-act-label')!).color === a]),
      }), AMBER);
      expect(amber.primaries).toBe(1);
      for (const [border, words] of amber.next) { expect(border).toBe(false); expect(words).toBe(false); }

      // ── Home's "Open … in VoxVision": the newest record chosen on tab 5 (the older one was chosen there) ──
      await page.keyboard.press('1');
      await page.click(`${thumbs} [data-open-vox="vfa4e0b17"]`);
      await page.waitForFunction(() => document.querySelector('#ws-tabs [data-ws-tab="voxvision"]')?.getAttribute('aria-selected') === 'true'
        && document.querySelector('.vox-rec[aria-current="true"]')?.getAttribute('data-vox-record') === 'vfa4e0b17', null, { timeout: 15_000 });

      // ── the run viewer at 1376x768: its image fits the box it is seen in, and is a button that shows it at size ──
      await page.goto(`${origin}/run/${op}#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector(`#run-detail .run-view[data-operation="${op}"][data-inspected="true"]`, { timeout: 30_000 });
      await page.waitForFunction(() => { const i = document.querySelector('.rv-v-body [data-rv-image]') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth === 640; }, null, { timeout: 15_000 });
      const fit = await page.$eval('.rv-v-body [data-rv-image]', (i) => {
        const box = i.closest('.rv-scroll')!.getBoundingClientRect();
        const r = i.getBoundingClientRect();
        return { inside: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, height: Math.round(r.height), enlarge: i.closest('[data-enlarge]') !== null };
      });
      expect(fit.inside).toBe(true);
      expect(fit.height).toBeGreaterThanOrEqual(40);
      expect(fit.enlarge).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await companion.shutdown();
    }
  }, 240_000);
});
