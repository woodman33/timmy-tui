/**
 * The spatial tools order (2026-10-28), in a real headless Chromium against the real companion: a Gaussian splat on the
 * licensed tldraw Workspace — brought in from this computer (Import → From this computer) → drawn by Spark in the Three.js
 * viewport (its facts from the file's own values) → "Crop with KIRI…" adds the KIRI operation node beside it with its input
 * connected → Run (a Timmy job; its stages are its progress) → the edited splat and the native .blend come back on the board
 * with the run's receipt → the board kept across a fresh browser. 3D Model Studio's host menu lists the splat operations,
 * gsplat with its reason (awaiting an NVIDIA worker), never as a working item.
 *
 * Real: the companion, the app's bundle, tldraw, Spark 2.3.1 and three (software WebGL here), the job manager, the records and
 * receipts. FAKE, labelled: the spatial tools (tests/fixtures/fake-spatial-tools.ts: a FAKE Blender stands in for KIRI).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { readChain } from '../src/utils/receipts.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';
import { FIXTURE_PLY, fakeSpatialTools } from './fixtures/fake-spatial-tools.js';

const shots = process.env.TIMMY_G_SHOTS;

describe.skipIf(!browserPath)('Workspace splats: import → Spark → KIRI operation → results and receipt → kept (FAKE spatial tools)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'splat-browser-'));
    root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(box, 'fixture.ply'), FIXTURE_PLY);
    const fake = fakeSpatialTools(box);
    const env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, HOME: box, TMPDIR: tmpdir(), ...fake.env };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
    expect(problems.filter((p) => !/favicon|WebGL|GPU stall/.test(p))).toEqual([]);
  });

  const open = async (width: number, height: number, nav = 'canvas'): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    await page.click(`.ta-rail-item[data-nav="${nav}"]`);
    if (nav === 'canvas') await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    return page;
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  // lit pixels on a splat node's WebGL canvas: the picture itself, not the file's count (a KIRI export once drew 4 Gaussians as 5 pixels)
  const lit = async (page: Page, sel: string): Promise<number> => page.locator(`${sel} canvas`).first().evaluate((c: HTMLCanvasElement) => {
    const g = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null; if (!g) return -1;
    const px = new Uint8Array(g.drawingBufferWidth * g.drawingBufferHeight * 4); g.readPixels(0, 0, g.drawingBufferWidth, g.drawingBufferHeight, g.RGBA, g.UNSIGNED_BYTE, px);
    let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) n++; return n;
  }).catch(() => -2);
  const desk = async (page: Page) => page.evaluate(async (t) => (await fetch('/api/app/desk', { headers: { authorization: `Bearer ${t}` } })).json(), token);

  it('3D Model Studio’s splat menu: KIRI and Brush offered; gsplat listed with its reason, never as a working item', async () => {
    const page = await open(1440, 900, 'model-studio');
    await page.click('button[data-menu="splats"]');
    await page.waitForSelector('[data-splat-op="spatial.kiri-crop-export"]');
    expect(await page.locator('[data-splat-op="spatial.kiri-crop-export"]').getAttribute('data-op-available')).toBe('yes');
    const g = page.locator('[data-splat-op="spatial.gsplat-smoke"]');
    expect(await g.getAttribute('data-op-available')).toBe('no');
    expect(await g.isDisabled()).toBe(true);
    expect(await g.innerText()).toMatch(/awaiting a powered NVIDIA worker/);
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  it('import a splat → Spark draws it → Crop with KIRI → Run → edited splat, .blend and receipt on the board → kept', async () => {
    const page = await open(1440, 900);
    await page.click('[data-tool="Import"]');
    await page.setInputFiles('input[data-import-file]', join(box, 'fixture.ply'));
    const node = '[data-node-kind="splat"][data-node-path$="/fixture.ply"]';
    await page.waitForSelector(node, { timeout: 30_000 });
    await expect.poll(() => page.locator(`${node} [data-node-splat]`).getAttribute('data-node-splat'), { timeout: 30_000 }).toBe('ok');
    expect(await page.locator(`${node} [data-node-splat]`).getAttribute('data-splat-count')).toBe('2');
    await expect.poll(() => lit(page, node), { timeout: 15_000 }).toBeGreaterThan(200);
    // its facts from the file's own values (the inspector)
    await page.click(`${node} [data-node-toggle]`);
    await expect.poll(() => page.locator(`${node} [data-splat-facts]`).innerText(), { timeout: 10_000 }).toMatch(/2 \(ascii, synthetic fixture\)/);
    expect(await page.locator(`${node} [data-node-inspector]`).innerText()).toMatch(/-0\.4, 0, 0 to 0\.4, 0, 0/);
    await shot(page, 'splat-1-imported');
    // the exact-centres view, then back to the splats
    await page.click(`${node} button[data-menu="node-view"]`);
    await page.click('[data-view="centers"]');
    await page.click(`${node} button[data-menu="node-view"]`);
    await page.click('[data-view="splats"]');

    // Crop with KIRI…: an operation node beside it, its input connected
    await page.click(`${node} [data-node-primary]`);
    const op = '[data-op="spatial.kiri-crop-export"]';
    await page.waitForSelector(op, { timeout: 20_000 });
    await expect.poll(() => page.locator(`${op} li[data-port="splat"]`).getAttribute('data-connected')).toBe('yes');
    await page.selectOption(`${op} select[data-param="keep"]`, 'x ≤ 0');
    await page.waitForTimeout(500);
    await page.click(`${op} [data-op-run]`);
    await expect.poll(() => page.locator(op).getAttribute('data-op-state'), { timeout: 30_000 }).toBe('completed');
    await page.waitForSelector(`${op} [data-op-output$="/edited.ply"]`, { timeout: 30_000 });
    await expect.poll(() => page.locator(`${op} [data-op-readback]`).getAttribute('data-op-readback'), { timeout: 10_000 }).toBe('matched');
    expect(await page.locator(`${op} [data-op-receipt] code`).count()).toBe(1);
    await shot(page, 'splat-2-kiri');
    // the edited splat (KIRI-shaped export: extra red/green/blue/alpha and Col_* columns) is drawn, not just counted
    const edited = '[data-node-kind="splat"][data-node-path$="/edited.ply"]';
    await expect.poll(() => page.locator(`${edited} [data-node-splat]`).getAttribute('data-splat-count'), { timeout: 20_000 }).toBe('1');
    await expect.poll(() => lit(page, edited), { timeout: 15_000 }).toBeGreaterThan(200);
    // the edited splat is itself a splat node (1 Gaussian kept), the .blend a reference node; both from the run
    type Rec = { type?: string; meta?: Record<string, unknown>; props?: Record<string, unknown> };
    await expect.poll(async () => Object.values((await desk(page)).snapshot.store as Record<string, Rec>).filter((r) => r.type === 'timmy-display' && r.meta && r.meta.run).map((r) => `${r.props!.kind}:${String(r.props!.path).split('/').pop()}`).sort(), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['file:edited.blend', 'splat:edited.ply']));
    const rc = readChain('runs', root).filter((x) => x.kind === 'spatial');
    expect(rc).toHaveLength(1);
    expect(rc[0]).toMatchObject({ status: 'ok', spatial: { tool: 'kiri', fixture: true } });
    await page.context().close();

    // a fresh browser opens the same board as it was left
    const again = await open(1440, 900);
    await again.waitForSelector(op, { timeout: 30_000 });
    expect(await again.locator(op).getAttribute('data-op-state')).toBe('completed');
    expect(await again.locator('[data-node-kind="splat"]').count()).toBeGreaterThanOrEqual(1);
    await again.context().close();
  });
});
