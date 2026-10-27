/**
 * The operator's 05:03 PT order (2026-10-27), items G1–G3, in a real headless Chromium against the real companion: what a person
 * sees after the work, said once —
 *  - G2, a phone's Chat with no model: one setup action ("Choose a model") that opens the picker itself, as a sheet;
 *  - G1, the Control Room: an ended run shows one outcome (no live face, no "Started run" or "Stop sent"), its changed file
 *    and its receipt; the event history and the log in Details;
 *  - G3, Files: the apps' results first, by name and preview; after the handoff, "Sent to Card Lab" with Open inspection,
 *    which opens Card Lab on that run (`/?run=<id>`); the path, the hash and the receipts in Details.
 *
 * Real: the companion, its routes, the app's bundle, the receipts. FAKE, labelled: Ollama (a model list), `timmy act`
 * (tests/fixtures/fake-act.mjs) and Card Lab (tests/fixtures/fake-card-lab).
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FAKE_ACT = fileURLToPath(new URL('./fixtures/fake-act.mjs', import.meta.url));
const FAKE_CARD_LAB = fileURLToPath(new URL('./fixtures/fake-card-lab', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const shots = process.env.TIMMY_G_SHOTS;

describe.skipIf(!browserPath)('the 05:03 order\'s G1–G3: one outcome, one setup action, results by name (Timmy app)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let browser: Browser; let ollama: FakeOllama; let companion: CompanionServer; let origin = ''; let token = ''; let root = '';
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'g-app-browser-'));
    root = join(box, 'project');
    mkdirSync(join(root, 'from-apps', 'animate', 'j1'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    writeFileSync(join(root, 'from-apps', 'animate', 'j1', 'preview.png'), PNG);
    writeFileSync(join(root, 'from-apps', 'animate', 'j1', 'scene.json'), '{"fake":true}\n');
    appendReceipt('runs', {
      kind: 'miniapp', subject: 'miniapp · animate · export · succeeded', policy: 'app-initiated', status: 'ok', project: 'project', project_id: projectId(root),
      job: { id: 'j1', kind: 'export', label: 'export', state: 'succeeded' },
      outputs: [{ path: 'from-apps/animate/j1/preview.png', sha256: sha(PNG), bytes: PNG.length }, { path: 'from-apps/animate/j1/scene.json', sha256: sha('{"fake":true}\n'), bytes: 14 }],
      miniapp: { app: 'animate', title: 'Timmy Animate', revision: null, record_sha256: sha('r'), started_by: 'test', principal: 'operator' },
    }, root);
    ollama = await startFakeOllama({ models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] }], chat: [] });
    const home = process.env.TIMMY_HOME!;
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host } }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
    const bin = join(box, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'qwen'), '#!/bin/sh\necho qwen 0.25.1\n'); chmodSync(join(bin, 'qwen'), 0o755);
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, PATH: `${bin}:${process.env.PATH}`, FAKE_ACT_MODE: 'ok', TIMMY_CARD_LAB_DIR: FAKE_CARD_LAB, TIMMY_AGENT_BASE_URL: `${ollama.url}/v1` };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env }, controlRuns: { timmy: [process.execPath, FAKE_ACT] } });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const open = async (width: number, height: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-page[data-page="chat"] .ta-title', { timeout: 60_000 });
    return page;
  };
  const go = async (page: Page, id: string): Promise<void> => {
    if (await page.locator('.ta-menu').isVisible()) { await page.click('.ta-menu'); await page.waitForSelector('.ta-rail.is-open'); }
    await page.click(`.ta-rail-item[data-nav="${id}"]`);
    await page.waitForSelector(`.ta-page[data-page="${id}"]`, { timeout: 30_000 });
  };
  const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

  it('G2: a phone with no model chosen has one setup action, and it opens the picker at once (a sheet), with the composer in reach', async () => {
    const page = await open(390, 844);
    await page.waitForSelector('[data-setup="choose-model"]');
    await shot(page, 'g2-phone-chat-empty');
    expect(await page.locator('button:visible', { hasText: 'Choose a model' }).count()).toBe(1);
    expect(await page.locator('.ta-page[data-page="chat"] .ta-band').innerText()).not.toMatch(/none chosen|choose/i);
    expect(await page.getAttribute('.ta-input', 'placeholder')).toBe('Message Timmy');
    // the composer is on the first screen
    const box2 = await page.locator('.ta-composer').boundingBox();
    expect(box2 && box2.y + box2.height <= 844).toBe(true);
    await page.click('[data-setup="choose-model"]');
    await page.waitForSelector('dialog.ta-sheet[open] .ta-choose');
    expect(await page.locator('.ta-choose').count()).toBe(2); // the sheet's and the column's (the column below the chat)
    await page.waitForTimeout(400); // (its 200 ms entrance)
    await shot(page, 'g2-phone-chooser-sheet');
    await page.click('dialog.ta-sheet .ta-sheet-close');
    await page.waitForSelector('dialog.ta-sheet:not([open])', { state: 'attached' });
    expect(await page.locator('dialog.ta-sheet .ta-choose').count()).toBe(0);
    await page.context().close();
  }, 120_000);

  it('G5: a phone\'s Canvas opens on the whole desk; Overview, the cards one by one (focused, the inspector open), Undo, Redo and the tools are buttons', async () => {
    const page = await open(390, 844);
    await go(page, 'canvas');
    await page.waitForSelector('.ta-stage .tl-container .tl-shape', { timeout: 60_000 });
    await page.waitForTimeout(800);
    const inView = async () => page.evaluate(() => {
      const c = document.querySelector('.ta-stage .tl-container')!.getBoundingClientRect();
      const shapes = [...document.querySelectorAll('.ta-stage .tl-shape')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 4);
      return { n: shapes.length, out: shapes.filter((r) => r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1).length };
    });
    const first = await inView();
    expect(first.n).toBeGreaterThan(3);
    expect(first.out, 'shapes outside the phone\'s stage at its opening view').toBe(0);
    await shot(page, 'g5-phone-canvas-overview');
    // every control is a visible button of at least 44 px
    for (const k of ['overview', 'prev', 'next', 'undo', 'redo', 'tools']) {
      const b = await page.locator(`[data-phone="${k}"]`).boundingBox();
      expect(b && b.height >= 44 && b.width >= 44 && b.x >= 0 && b.x + b.width <= 390, k).toBe(true);
    }
    // the next card: selected, zoomed to, the inspector open with its parameters
    await page.click('[data-phone="next"]');
    await expect.poll(() => page.locator('.ta-phonebar-at').innerText()).toMatch(/^Card 1 of \d+$/);
    await page.waitForTimeout(500);
    expect(await page.locator('.ta-layer').getAttribute('class')).not.toContain('is-folded');
    expect(await page.locator('.ta-layer .ta-inspect-title').innerText()).not.toBe('Nothing selected');
    await shot(page, 'g5-phone-canvas-focused');
    await page.click('[data-phone="next"]');
    await expect.poll(() => page.locator('.ta-phonebar-at').innerText()).toMatch(/^Card 2 of \d+$/);
    // the tools behind Tools: a note added, then undone and redone with the bar's buttons
    expect(await page.locator('.ta-floatbar.ta-toolsrow').isVisible()).toBe(false);
    await page.click('[data-phone="tools"]');
    await page.waitForSelector('.ta-floatbar.ta-toolsrow [data-tool="Nodes"]');
    const before = await page.locator('.ta-stage .tl-shape').count();
    await page.click('.ta-floatbar [data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="note"]');
    await page.waitForFunction((n) => document.querySelectorAll('.ta-stage .tl-shape').length > n, before);
    await page.click('[data-phone="undo"]');
    await page.waitForFunction((n) => document.querySelectorAll('.ta-stage .tl-shape').length === n, before);
    await page.click('[data-phone="redo"]');
    await page.waitForFunction((n) => document.querySelectorAll('.ta-stage .tl-shape').length > n, before);
    await page.click('[data-phone="undo"]');
    // Overview: the whole desk again
    await page.click('[data-phone="overview"]');
    await page.waitForTimeout(500);
    expect((await inView()).out).toBe(0);
    expect(await page.locator('.ta-phonebar-at').innerText()).toMatch(/^\d+ cards$/);
    const over = await page.evaluate(() => { const w = document.querySelector('.ta-pagewrap')!; return w.scrollWidth - w.clientWidth; });
    expect(over).toBeLessThanOrEqual(0);
    await page.context().close();
  }, 180_000);

  it('G1: an ended run says one outcome, its changed file and its receipt; its history and log are in Details', async () => {
    const page = await open(1440, 900);
    await go(page, 'control');
    await page.waitForSelector('.tx-ctl-launch textarea');
    await page.fill('.tx-ctl-launch textarea', 'Add a line to a.txt');
    await page.click('button:has-text("Review the run")');
    await page.click('button:has-text("Approve and start")');
    const card = page.locator('.tx-ctl-run[data-outcome="succeeded"]');
    await card.waitFor({ timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'g1-control-run-ended');
    const words = await card.innerText();
    expect(words).not.toMatch(/Started run|Stop sent/);
    expect(await page.locator('.tx-ctl-launch').innerText()).not.toMatch(/Started run/);
    expect(await card.locator('.ta-face-run').count()).toBe(0); // the live face is for a live run; the end is a still outcome
    expect(await card.locator('.tx-ctl-outcome-line').innerText()).toMatch(/^Succeeded at .+; 1 file changed in its copy\.$/);
    expect(await card.locator('.tx-ctl-files').innerText()).toContain('a.txt');
    expect(await card.locator('.tx-ctl-receipt code').innerText()).toMatch(/^[0-9a-f]{8}$/);
    // the log and the events are not on the card's face; Details has them
    expect(await card.locator(':scope > .tx-ctl-tail').count()).toBe(0);
    await card.locator('summary:has-text("Details")').click();
    expect(await card.locator('details').last().innerText()).toMatch(/EVENT HISTORY[\s\S]*started[\s\S]*LOG[\s\S]*IDENTIFIERS/);
    await page.context().close();
  }, 120_000);

  it('G3: Files shows the apps\' results by name first; after the handoff, Sent to Card Lab with Open inspection, which opens that run', async () => {
    const page = await open(1440, 900);
    await go(page, 'files');
    await page.waitForSelector('.tx-files-results .tx-files-result[data-app="animate"]');
    await shot(page, 'g3-files-results');
    await page.click('.tx-files-result .ta-chip:has-text("preview.png")');
    await page.waitForSelector('.tx-files-open-name:text-is("preview.png")');
    expect(await page.locator('.tx-files-open').innerText()).not.toMatch(/from-apps\//); // the path is behind Details
    await page.click('button:has-text("Send to Card Lab")');
    await page.waitForSelector('[data-sent="card-lab"]', { timeout: 60_000 });
    await shot(page, 'g3-files-sent');
    expect(await page.locator('[data-sent="card-lab"]').innerText()).toMatch(/Sent to Card Lab/);
    await page.click('.tx-files-prov summary');
    const details = await page.locator('.tx-files-prov details').innerText();
    expect(details).toContain('from-apps/animate/j1/preview.png');
    expect(details).toContain(sha(PNG));
    const run = /card_[0-9a-f-]{36}/.exec(details)![0];
    await page.click('[data-action="open-inspection"]');
    await page.waitForSelector('iframe[data-miniapp-frame="card-lab"]', { timeout: 60_000 });
    const frame = page.frameLocator('iframe[data-miniapp-frame="card-lab"]');
    await frame.locator(`[data-fake-run="${run}"]`).waitFor({ timeout: 30_000 });
    await shot(page, 'g3-card-lab-inspection');
    // the bar names the Timmy project apart from the app's own documents, and says the app is open (not that a job runs)
    expect(await page.locator('.ta-miniapp-bar').innerText()).toMatch(/app open[\s\S]*Timmy project: project/);
    await page.context().close();
    expect(problems).toEqual([]);
  }, 180_000);
});
