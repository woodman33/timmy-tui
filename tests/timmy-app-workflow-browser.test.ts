/**
 * The unified Workspace order (2026-10-27), in a real headless Chromium against the real companion: one executable workflow on
 * the licensed tldraw canvas — import an app's image → add an operation from the catalog-fed picker (an operation whose app
 * is not installed is listed with its reason, never as a working item) → connect its typed input with an executable edge →
 * set a parameter in the node → Run (validated first) → the native Rive console and the run's own word follow the app's job
 * → the delivered files come back on the board as display nodes, connected from the operation, with the receipt → Run again
 * and Cancel: the cancelled attempt attaches nothing; the board keeps it all across a fresh browser.
 *
 * Real: the companion, the mini-app host, the app's bundle, tldraw, the Rive runtime, the records and receipts. FAKE,
 * labelled: Stream Studio (tests/fixtures/fake-stream-studio) and the "app image" this test writes and seals.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';

const STREAM = fileURLToPath(new URL('./fixtures/fake-stream-studio', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const shots = process.env.TIMMY_G_SHOTS;
const IMG = 'from-apps/card-lab/c1/card.png';

describe.skipIf(!browserPath)('Workspace workflow: an app’s image → an operation node → the app’s own job → its results on the board', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'workflow-browser-'));
    root = join(box, 'project');
    mkdirSync(join(root, 'from-apps', 'card-lab', 'c1'), { recursive: true });
    writeFileSync(join(root, IMG), PNG);
    appendReceipt('runs', {
      kind: 'miniapp', subject: 'miniapp · card-lab · inspection (FAKE)', policy: 'app-initiated', status: 'ok', project: 'project', project_id: projectId(root),
      job: { id: 'c1', kind: 'inspection', label: 'inspection', state: 'complete' },
      outputs: [{ path: IMG, sha256: sha(PNG), bytes: PNG.length }],
      miniapp: { app: 'card-lab', title: 'Image Analysis', revision: null, record_sha256: sha('r'), started_by: 'test', principal: 'operator' },
    }, root);
    // Stream Studio is installed (FAKE); Animate is NOT (its operation must be listed as unavailable, with why)
    const env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STREAM_STUDIO_DIR: STREAM };
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
    expect(problems.filter((p) => !/favicon|WebGL/.test(p))).toEqual([]);
  });

  const open = async (width: number, height: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    await page.click('.ta-rail-item[data-nav="canvas"]');
    await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    return page;
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  const desk = async (page: Page) => page.evaluate(async (t) => (await fetch('/api/app/desk', { headers: { authorization: `Bearer ${t}` } })).json(), token);

  it('import → operation → connect → parameter → Run → Rive state → results and receipt on the board → Run again, Cancel', async () => {
    const page = await open(1440, 900);
    await page.click('[data-tool="Import"]');
    await page.click(`[data-import="${IMG}"]`);
    await page.waitForSelector(`[data-node-path="${IMG}"]`, { timeout: 30_000 });

    // the operations picker is fed by the catalog: Stream Studio's can be added; Animate's (not installed) says why
    await page.click('button[data-menu="operations"]');
    await page.waitForSelector('[data-op-pick="stream-studio.animate-image"]');
    expect(await page.locator('[data-op-pick="stream-studio.animate-image"]').getAttribute('data-op-available')).toBe('yes');
    const animate = page.locator('[data-op-pick="animate.export"]');
    expect(await animate.getAttribute('data-op-available')).toBe('no');
    expect(await animate.isDisabled()).toBe(true);
    expect(await animate.innerText()).toMatch(/not installed/);
    await shot(page, 'flow-1-picker');
    await page.click('[data-op-pick="stream-studio.animate-image"]');
    await page.waitForSelector('[data-op="stream-studio.animate-image"]', { timeout: 20_000 });
    const op = '[data-op="stream-studio.animate-image"]';

    // Run before its input is connected: refused with the reason, nothing starts
    await page.waitForTimeout(600); // the camera's move to the new node settles
    await page.click(`${op} [data-op-run]`);
    await expect.poll(() => page.locator(`${op} .ta-op-problems`).innerText(), { timeout: 10_000 }).toMatch(/Image: not connected/);

    // connect the Image port to the imported node (an executable edge, its meta naming the port)
    await page.click(`${op} button[data-menu="op-port"][data-port="image"]`);
    await page.click(`[role="menu"] [data-source="${IMG}"]`);
    await expect.poll(() => page.locator(`${op} li[data-port="image"]`).getAttribute('data-connected')).toBe('yes');
    // a parameter, in the node: Motion → pulse
    await page.selectOption(`${op} select[data-param="motion"]`, 'pulse');

    // Run: validated, then the app's own job; the native Rive console follows the run's record
    await page.click(`${op} [data-op-run]`);
    await expect.poll(() => page.locator(`${op}`).getAttribute('data-op-state'), { timeout: 20_000 }).toMatch(/running|held|completed/);
    await expect.poll(() => page.locator(`${op} [data-face="op"]`).getAttribute('data-state'), { timeout: 20_000 }).toMatch(/running|held|completed/);
    await shot(page, 'flow-2-running');
    await expect.poll(() => page.locator(`${op}`).getAttribute('data-op-state'), { timeout: 30_000 }).toBe('completed');
    // its results attached to the board, connected from the operation; the node lists them, and one brings the HTML player
    // (in its isolated preview) into view
    await page.waitForSelector(`${op} [data-op-output$="/index.html"]`, { timeout: 30_000 });
    await expect.poll(async () => (await desk(page)).snapshot && Object.values((await desk(page)).snapshot.store as Record<string, { type?: string; meta?: Record<string, unknown> }>).filter((r) => r.type === 'timmy-display' && r.meta && r.meta.run).length, { timeout: 20_000 }).toBe(2);
    await page.click(`${op} [data-op-output$="/index.html"]`);
    await page.waitForSelector('[data-node-kind="html"][data-node-path$="/index.html"]', { timeout: 30_000 });
    await expect.poll(async () => page.frameLocator('[data-node-kind="html"] iframe[data-node-preview]').locator('#out').innerText(), { timeout: 20_000 }).toMatch(/FAKE Stream Studio player · pulse/);
    expect(await page.locator(`${op} [data-op-receipt] code`).count()).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.locator(`${op} [data-op-readback]`).getAttribute('data-op-readback'), { timeout: 10_000 }).toBe('matched');
    await shot(page, 'flow-3-results');
    // (kept in the project as the person works: the board's save follows its changes)
    type Rec = { type?: string; meta?: Record<string, unknown>; props?: Record<string, unknown> };
    await expect.poll(async () => Object.values((await desk(page)).snapshot.store as Record<string, Rec>).filter((r) => r.type === 'arrow' && r.meta && r.meta.edge === 'timmy').map((e) => e.meta!.port).sort(), { timeout: 20_000 }).toEqual(['image', 'output', 'output']);
    const store1 = Object.values((await desk(page)).snapshot.store as Record<string, Rec>);
    const results = store1.filter((r) => r.type === 'timmy-display' && r.meta && r.meta.run);
    expect(results.map((r) => String(r.props!.path).split('/').pop()).sort()).toEqual(['index.html', 'scene.json']);

    // Run again, then Cancel: the cancelled attempt attaches nothing; attempt 1's results stay
    // the node is brought back into view first (the person's own Fit-workspace control), so its footer is on screen
    await page.click('[aria-label="Fit workspace"]');
    await page.waitForTimeout(400);
    await shot(page, 'flow-4-fit');
    await page.click(`${op} [data-op-run]`);
    await page.waitForSelector(`${op} [data-op-cancel]`, { timeout: 20_000 });
    await page.click(`${op} [data-op-cancel]`);
    await expect.poll(() => page.locator(`${op}`).getAttribute('data-op-state'), { timeout: 20_000 }).toBe('cancelled');
    expect(await page.locator(`${op} [data-op-run]`).innerText()).toBe('Run again');
    expect(await page.locator(`${op} [data-op-run]`).isVisible()).toBe(true);
    await page.waitForTimeout(1500);
    const store2 = Object.values((await desk(page)).snapshot.store as Record<string, { type?: string; meta?: Record<string, unknown> }>);
    expect(store2.filter((r) => r.type === 'timmy-display' && r.meta && r.meta.run).length).toBe(2);
    await page.context().close();

    // a fresh browser: the board as it was left — the operation, its edges, its results
    const again = await open(1440, 900);
    await again.waitForSelector(op, { timeout: 30_000 });
    await expect.poll(() => again.locator(op).getAttribute('data-op-state'), { timeout: 20_000 }).toBe('cancelled');
    expect(await again.locator(`${op} [data-op-run-id], ${op} [data-op-run]`).count()).toBeGreaterThanOrEqual(1);
    await again.context().close();
  }, 240_000);
});
