/**
 * The 2026-10-27 shared-integrator order, in a real headless Chromium against the real companion: Tools & integrations' Treg
 * and tldraw cards. A person sees the five words kept apart (installed, signed in, discovered, ran here, qualified), discovers
 * Treg's tools, searches the catalog, previews a price, sees a paid call's proposal with its quote, approves it once, sees
 * its result, what Treg's answer says it charged and its receipt, and puts that result on the Canvas as a note.
 *
 * Real: the companion, its routes, the app's bundle, `timmy act` (the CLI through tsx), Timmy's SDK route, the records and
 * receipts. FAKE, labelled: Treg's MCP server (tests/fixtures/fake-treg-mcp.mjs; nothing contacts treg.to) and its sign-in
 * file (a made-up token, which must never reach the page).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { readChain } from '../src/utils/receipts.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FAKE_TREG = fileURLToPath(new URL('./fixtures/fake-treg-mcp.mjs', import.meta.url));
const LOADER = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLI = join(REPO, 'src', 'cli.ts');
const TOKEN = 'fake-treg-token-NEVER-ON-THE-PAGE';
const shots = process.env.TIMMY_G_SHOTS;

describe.skipIf(!browserPath)('Tools & integrations: Treg through the host’s operations, and the tldraw card (the FAKE Treg server)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = ''; let browser: Browser; let companion: CompanionServer; let origin = ''; let token = ''; let root = ''; let log = '';
  const problems: string[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'int-browser-'));
    root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    const signIn = join(box, 'treg-login.json');
    writeFileSync(signIn, JSON.stringify({ token: TOKEN, active_org: 'fake-team' }));
    log = join(box, 'fake-treg.log');
    const home = process.env.TIMMY_HOME!;
    const env = { ...process.env, TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TREG_CONFIG: signIn };
    delete env.TIMMY_STORE;
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, {
      chatEnv: env, workspace: { env },
      connectorOps: { timmy: [process.execPath, '--import', LOADER, CLI], bridge: ['/usr/bin/env', `FAKE_TREG_LOG=${log}`, process.execPath, FAKE_TREG] },
    });
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const open = async (width: number, height: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    page.on('response', async (r) => { if (r.url().includes('/api/connectors')) { try { bodies.push(await r.text()); } catch { /* streamed */ } } });
    await page.goto(`${origin}/app?page=tools#t=${token}`);
    await page.waitForSelector('.ta-page[data-page="tools"] [data-connector="treg"]', { timeout: 60_000 });
    return page;
  };
  const shot = async (page: Page, name: string, el?: string) => {
    if (!shots) return;
    // the page scrolls inside its own column: the part in question is brought into view, and the window is captured
    if (el) { await page.locator(el).scrollIntoViewIfNeeded(); await page.locator(el).evaluate((n) => n.scrollIntoView({ block: 'start' })); await page.waitForTimeout(250); }
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const rung = (page: Page, connector: string, r: string) => page.locator(`[data-connector="${connector}"] [data-rung="${r}"]`).getAttribute('data-ok');
  // the operation a press started (a new one in the detail, not the one shown before it), once it has ended
  const opNow = async (page: Page) => (await page.locator('.tx-int-op').count() ? page.locator('.tx-int-op').getAttribute('data-op') : null);
  const ended = async (page: Page, before: string | null) => {
    await expect.poll(() => opNow(page), { timeout: 60_000 }).not.toBe(before);
    await expect.poll(async () => page.locator('.tx-int-op').getAttribute('data-op-state'), { timeout: 90_000 }).toMatch(/^(answered|failed|stopped|unknown)$/);
  };

  it('the five words, a discovery, a free search, a price preview, a proposal approved once, its charge and receipt; then the result on the Canvas', async () => {
    const page = await open(1440, 900);
    expect(await rung(page, 'treg', 'installed')).toBe('yes');
    expect(await rung(page, 'treg', 'signed in')).toBe('yes');
    expect(await rung(page, 'treg', 'discovered')).toBe('no');
    expect(await rung(page, 'treg', 'qualified')).toBe('no');
    await shot(page, 'int-1-tools-before', '[data-panel="integrations"]');

    await page.click('text=Discover tools · free');
    await expect.poll(() => rung(page, 'treg', 'discovered'), { timeout: 60_000 }).toBe('yes');
    await page.fill('.tx-int-form input >> nth=0', 'profile lookup');
    let before = await opNow(page);
    await page.click('text=Search the catalog · free');
    await ended(page, before);
    expect(await page.locator('.tx-int-op').getAttribute('data-op-state')).toBe('answered');
    await page.click('.tx-int-hits button >> text=fake.demo.profile');
    before = await opNow(page);
    await page.click('text=Preview its price · free');
    await ended(page, before);
    await page.waitForSelector('.tx-int-propose', { timeout: 30_000 });
    await page.fill('.tx-int-propose textarea', '{"method":"GET","query":{"uniqueId":"fake"}}');
    await page.click('text=Propose this call');
    await page.waitForSelector('[data-proposal]');
    expect(await page.locator('.tx-int-price').innerText()).toBe('$0.001');
    expect(await page.locator('[data-proposal]').innerText()).toMatch(/quote, not a cap/);
    // nothing paid was sent before Approve
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').not.toMatch(/"tool":"call"/);
    await shot(page, 'int-2-proposal', '.tx-int-propose');

    before = await opNow(page);
    await page.click('[data-action="approve"]');
    await ended(page, before);
    const op = page.locator('.tx-int-op');
    expect(await op.getAttribute('data-op-state')).toBe('answered');
    expect(await op.innerText()).toMatch(/\$0\.001 — Treg’s answer, field charged_micro/);
    expect(await op.innerText()).toMatch(/research, not admitted evidence/);
    await expect.poll(async () => (await page.locator('.tx-int-ops').innerText())).toMatch(/Paid call fake\.demo\.profile/);
    await shot(page, 'int-3-paid-answered', '.tx-int-ops');
    expect(readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"tool":"call"'))).toHaveLength(1);
    const chain = readChain('runs', root);
    expect(chain.filter((r) => r.kind === 'connector.call').length).toBe(3);

    // the tldraw card: the same result, on the Canvas as a note
    await page.click('[data-action="tldraw-place"]');
    await page.waitForSelector('.ta-page[data-page="canvas"] .tl-container', { timeout: 60_000 });
    await expect.poll(async () => page.locator('.tl-shape[data-shape-type="note"]').allInnerTexts().then((t) => t.join('\n')), { timeout: 30_000 }).toMatch(/Treg · Paid call fake\.demo\.profile/);
    await page.waitForTimeout(600);
    await shot(page, 'int-4-canvas-note');

    // I8: every other adapter in the same five words (from the inventory and the workflows reading), each word apart; none is
    // shown qualified, and none discovered on this page
    await page.click('.ta-rail-item[data-nav="tools"]');
    await page.waitForSelector('[data-adapter="tool:upmd"]', { timeout: 60_000 });
    expect(Number(await page.locator('[data-adapters]').getAttribute('data-adapters'))).toBeGreaterThan(5);
    expect(await page.locator('[data-adapter] td[data-rung="qualified"][data-ok="yes"]').count()).toBe(0);
    expect(await page.locator('[data-adapter] td[data-rung="discovered"][data-ok="yes"]').count()).toBe(0);
    expect(await page.locator('[data-adapter="tool:upmd"] td[data-rung="signed_in"]').getAttribute('data-ok')).toBe('yes');

    // the Control Room's connector-call cards (the 07:37 pass, I6): the same operations, the process, outcome and check apart;
    // the paid call's charge is Treg's own figure, a free lookup's says it is not paid
    await page.click('.ta-rail-item[data-nav="control"]');
    await page.waitForSelector('.ta-page[data-page="control"] [data-connector-op]', { timeout: 60_000 });
    const cards = page.locator('[data-connector-op]');
    expect(await cards.count()).toBe(4); // discover, search, price preview, the paid call
    const paid = cards.filter({ hasText: 'Treg · call' });
    expect(await paid.innerText()).toMatch(/process\s*ended[\s\S]*outcome\s*answered[\s\S]*check\s*receipt \S+[\s\S]*charge\s*\$0\.00\d* \(Treg’s charged_micro\)/);
    expect(await cards.filter({ hasText: 'none: not a paid call' }).count()).toBe(3);
    await shot(page, 'int-5-control-connector-cards', '#connector-calls');

    // no token anywhere on the page or in what the companion answered it
    expect(await page.content()).not.toContain(TOKEN);
    expect(bodies.join('\n')).not.toContain(TOKEN);
    expect(problems).toEqual([]);
    await page.context().close();
  }, 300_000);

  it('on a phone the cards stack and every control is in reach', async () => {
    const page = await open(390, 844);
    await page.locator('[data-panel="integrations"]').scrollIntoViewIfNeeded();
    const card = await page.locator('[data-connector="treg"]').boundingBox();
    expect(card && card.x >= 0 && card.x + card.width <= 390).toBe(true);
    const tl = await page.locator('[data-connector="tldraw"]').boundingBox();
    expect(tl && card && tl.y > card.y).toBe(true);
    await shot(page, 'int-5-phone-tools', '[data-connector="treg"]');
    expect(problems).toEqual([]);
    await page.context().close();
  }, 120_000);
});
