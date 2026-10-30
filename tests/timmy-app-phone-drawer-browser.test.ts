/**
 * Found on the Mac at c0c9161 (the unified Workspace pass): on a phone, the Canvas page stacks its stage, tool bar, Inspector
 * and Agent layers in a flex column, and a flex item's z-index applies even when it is static, so those layers (z-index 400,
 * meant for the desktop's overlay) painted over the rail's drawer (100) and took the taps meant for it. Here, in a real
 * headless Chromium at 390 × 844: the drawer, opened over the Canvas page scrolled to its foot, is what a tap lands on.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';

describe.skipIf(!browserPath)('a phone: the rail’s drawer is above the Canvas page’s layers', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = '';
  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'phone-drawer-'));
    process.env.TIMMY_REPO = box;
    const env = { TIMMY_HOME: process.env.TIMMY_HOME!, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('opened over the Canvas page at its foot, the drawer takes the taps over the Inspector, the Agent and the tools', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-rail', { state: 'attached', timeout: 60_000 });
    await page.click('.ta-menu');
    await page.waitForTimeout(600);
    await page.click('.ta-rail-item[data-nav="canvas"]');
    await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
    await page.locator('.ta-agent-layer').scrollIntoViewIfNeeded();
    await page.click('.ta-menu');
    await page.waitForSelector('.ta-rail.is-open');
    await page.waitForTimeout(600);
    const hits = await page.evaluate(() => ['.ta-agent-layer', '.ta-layer[aria-label="Inspector"]', '.ta-floatbar'].map((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      const y = Math.min(window.innerHeight - 2, Math.max(2, r.y + Math.min(r.height, 40) / 2));
      return [sel, Boolean(document.elementFromPoint(120, y)?.closest('.ta-rail'))];
    }));
    expect(hits).toEqual([['.ta-agent-layer', true], ['.ta-layer[aria-label="Inspector"]', true], ['.ta-floatbar', true]]);
    // and the drawer works: Control Room reached from there
    await page.click('.ta-rail-item[data-nav="control"]');
    await page.waitForSelector('.ta-page[data-page="control"]', { timeout: 30_000 });
    await ctx.close();
  }, 120_000);
});
