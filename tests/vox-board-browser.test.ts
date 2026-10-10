// Timmy VoxVision on the live board in a real headless Chromium (round R4, helper H49; skipped when no Chromium is
// found, as tests/board-live-browser.test.ts is): pressing Inspect on an image runs /inspect through the Workspace, the
// record's card appears, verified, and its highlight is shown through /file as a blob: URL under the page's CSP.
// The image is generated here and the Look worker is a FAKE (tests/helpers/vox-fakes.ts: a labelled test double, not
// OpenCV); the STL is read by Timmy's own reader, which is real.
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetLookChecks } from '../src/vision/look.js';
import { cubeStl, fakeTools, png, put, settled, tempKit, workspace } from './helpers/vox-fakes.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('vox-board-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const kit = tempKit();
afterEach(async () => { resetLookChecks(); await kit.cleanup(); });

describe.skipIf(!browserPath)('VoxVision on the live board in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('Inspect on a fake image makes a verified card whose highlight loads as a blob, with no CSP or script error', async () => {
    const root = kit.temp('vox-browser-');
    put(root, 'refs/photo.png', png(4, 2, (x) => (x < 2 ? [200, 10, 10] : [10, 10, 200])));
    put(root, 'refs/photo2.png', png(4, 2, () => [10, 10, 200]));
    put(root, 'models/cube.stl', cubeStl(1));
    const fake = fakeTools(kit.temp('vox-fake-'));
    const { ws, notes } = workspace(root, kit, { env: { TIMMY_VISION_PYTHON: fake.look, FAKE_QR: 'FAKE-QR' } });
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const inspect = 'button[data-act="vox"][data-verb="inspect"][data-file="refs/photo.png"]';
    await page.waitForSelector(inspect);
    expect(await page.textContent('#voxvision')).toContain('VoxVision');
    // Compare offers the other image of the same kind, and only it.
    expect(await page.$$eval('li[data-vox-file="refs/photo.png"] select[data-vox-other] option', (os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(['refs/photo2.png']);

    await page.click(inspect);
    await page.waitForFunction(() => !document.getElementById('out')!.hidden);
    expect((await page.textContent('#out'))!.split('\n')[0]).toBe('board /inspect refs/photo.png');
    await settled(ws);
    // The card arrives with the next state (the page polls every 2 s), verified, with its labelled values.
    await page.waitForSelector('article.vox-card', { timeout: 8000 });
    const card = (await page.textContent('article.vox-card'))!;
    expect(card).toContain('verified');
    expect(card).toContain('inspect');
    expect(card).toContain('deterministic computation (OpenCV) on these bytes');
    expect(card).toContain('timmy-look fake (OpenCV 5.0.0-fake, Python fake)');
    expect(card).toContain('/inspect refs/photo.png');
    // The highlight: fetched with the token through /file, shown as a blob: URL (img-src blob:), decoded by the browser.
    await page.waitForFunction(() => { const i = document.querySelector('article.vox-card img[data-vox-src]') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, undefined, { timeout: 8000 });
    expect(await page.$eval('article.vox-card img[data-vox-src]', (i) => [(i as HTMLImageElement).src.startsWith('blob:'), (i as HTMLImageElement).naturalWidth])).toEqual([true, 4]);
    expect(notes).toContain('  board  /inspect refs/photo.png');

    // Inspect on the STL: Timmy's own reader, in process; its bounding box drawing (SVG) loads the same way.
    await page.click('button[data-act="vox"][data-verb="inspect"][data-file="models/cube.stl"]');
    await page.waitForFunction(() => document.querySelectorAll('article.vox-card').length === 2, undefined, { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('article.vox-card img[data-vox-src]')].some((i) => (i.getAttribute('data-vox-src') ?? '').endsWith('bbox.svg') && (i as HTMLImageElement).naturalWidth > 0), undefined, { timeout: 8000 });
    expect(await page.textContent('#voxvision ~ .vox-cards, .vox-cards')).toContain('Timmy can compute and verify dimensions of generated CAD.');

    // Compare, with the second file from the list.
    await page.selectOption('li[data-vox-file="refs/photo.png"] select[data-vox-other]', 'refs/photo2.png');
    await page.click('button[data-act="vox"][data-verb="compare"][data-file="refs/photo.png"]');
    await page.waitForFunction(() => (document.getElementById('out')!.textContent ?? '').startsWith('board /compare refs/photo.png refs/photo2.png'), undefined, { timeout: 8000 });
    await settled(ws);
    await page.waitForFunction(() => document.querySelectorAll('article.vox-card').length === 3, undefined, { timeout: 8000 });

    // Nothing kept in the browser, and nothing refused by the page's policy.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);
});
