/**
 * The unified Workspace order (2026-10-27), in a real headless Chromium against the real companion: the Control Room's three
 * targets, never blurred. Files (a code agent on a copy: the existing form, with the harness as the integration catalog knows
 * it); an app's operation (from the catalog: one whose app is not installed is listed with why; run as the app's own job
 * through its adapter, then every delivered file read back and compared with its receipt); the canvas selection (kept from the
 * canvas, sent to the canvas agent, which opens aimed in Plan). Stream Studio is the labelled FAKE fixture app.
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
const IMG = 'from-apps/card-lab/c1/card.png';
const shots = process.env.TIMMY_G_SHOTS;

describe.skipIf(!browserPath)('the Control Room’s targets: files, an app’s operation (read back), the canvas selection', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let root = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'control-targets-'));
    root = join(box, 'project');
    mkdirSync(join(root, 'from-apps', 'card-lab', 'c1'), { recursive: true });
    mkdirSync(join(box, 'home'), { recursive: true });
    writeFileSync(join(root, IMG), PNG);
    appendReceipt('runs', {
      kind: 'miniapp', subject: 'miniapp · card-lab · inspection (FAKE)', policy: 'app-initiated', status: 'ok', project: 'project', project_id: projectId(root),
      job: { id: 'c1', kind: 'inspection', label: 'inspection', state: 'complete' }, outputs: [{ path: IMG, sha256: sha(PNG), bytes: PNG.length }],
      miniapp: { app: 'card-lab', title: 'Image Analysis', revision: null, record_sha256: sha('r'), started_by: 'test', principal: 'operator' },
    }, root);
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TIMMY_STREAM_STUDIO_DIR: STREAM };
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
  const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }); };

  it('files · an app’s operation, run through its adapter and read back · the canvas selection sent to the canvas agent', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    await page.click('.ta-rail-item[data-nav="control"]');
    await page.waitForSelector('[data-ctl-kind="files"]', { state: 'attached', timeout: 30_000 });
    // Files: the code agent's form, its harness as the catalog knows it
    expect(await page.locator('[data-ctl-kind="files"]').isChecked()).toBe(true);
    await page.waitForSelector('[data-ctl-catalog]', { timeout: 30_000 });
    // an app's operation: the catalog's operations, Animate's listed with why
    await page.click('label:has([data-ctl-kind="app"])');
    await page.waitForSelector('[data-ctl="operation"] option[value="stream-studio.animate-image"]', { state: 'attached', timeout: 30_000 });
    expect(await page.locator('[data-ctl="operation"] option[value="animate.export"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
    expect(await page.locator('[data-ctl="operation"] option[value="animate.export"]').innerText()).toMatch(/not installed|—/);
    await page.selectOption('[data-ctl="operation"]', 'stream-studio.animate-image');
    await page.waitForSelector(`[data-ctl-input="image"] option[value="${IMG}"]`, { state: 'attached' });
    await page.selectOption('[data-ctl-input="image"]', IMG);
    await page.selectOption('[data-ctl-param="motion"]', 'sway');
    await page.click('[data-ctl-op-run]');
    await expect.poll(() => page.locator('[data-ctl-op-state]').getAttribute('data-ctl-op-state'), { timeout: 40_000 }).toBe('completed');
    await expect.poll(() => page.locator('[data-ctl-readback]').getAttribute('data-ctl-readback'), { timeout: 30_000 }).toBe('matched');
    expect(await page.locator('[data-ctl-op-state]').innerText()).toMatch(/2 of 2 delivered files read back from the project match their receipt/);
    await shot(page, 'control-1-app-operation');
    // the canvas selection: nothing chosen yet, then a node chosen on the canvas, then sent to the canvas agent
    await page.click('label:has([data-ctl-kind="canvas"])');
    await page.waitForSelector('[data-ctl-canvas-empty]');
    await page.click('.ta-rail-item[data-nav="canvas"]');
    await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    await page.click('[data-tool="Import"]');
    await page.click(`[data-import="${IMG}"]`);
    await page.waitForSelector(`[data-node-path="${IMG}"]`, { timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.click('.ta-rail-item[data-nav="control"]');
    await page.click('label:has([data-ctl-kind="canvas"])');
    await page.waitForSelector('[data-ctl-canvas-nodes="1"]', { timeout: 10_000 });
    expect(await page.locator('[data-ctl-canvas]').innerText()).toContain(IMG);
    await page.fill('[data-ctl-canvas-goal]', 'Animate this card');
    await shot(page, 'control-2-canvas-selection');
    await page.click('[data-ctl-canvas-go]');
    await page.waitForSelector('[data-agent-goal]', { state: 'visible', timeout: 30_000 });
    expect(await page.locator('[data-agent-goal]').inputValue()).toBe('Animate this card');
    expect(await page.locator('[data-agent-mode="plan"]').isChecked()).toBe(true);
    await expect.poll(() => page.locator('[data-agent-target]').getAttribute('data-agent-target')).toBe('selection');
    expect(await page.locator('[data-agent-words]').innerText()).toMatch(/Aimed from the Control Room/);
    // no local chat model here: the agent is off, with its reason (an unavailable integration said, never a working button)
    await expect.poll(() => page.locator('[data-agent-harness]').getAttribute('data-agent-harness')).toBe('off');
    expect(await page.locator('[data-agent-go]').isDisabled()).toBe(true);
    await shot(page, 'control-3-agent-aimed');
    await context.close();
  }, 240_000);
});
