/**
 * R12 (the operator's 03:04 order: "coding the timmy tui into rive and tldraw", and the finish brief): the Timmy app in a real
 * headless Chromium, against the real companion on 127.0.0.1, read and used as a person does — Timmy's shell (the rail, the
 * page head, the band, the tools row), the permission before the local Ollama is asked, a model chosen, a real turn sent and
 * sealed, NEEDS YOU on the Rive ActionButton, Stop, the Canvas desk (Rive shapes, Timmy cards, the SDK's licence, a node added,
 * undone and kept across a reload), and the phone's drawer and composer.
 *
 * Real: the companion, its token, the app's bundle (scripts/canvas/build-app.mjs, built here when it is missing), the Chat's
 * routes and the agent's turn (POST /api/chat/turn), the receipt it seals. FAKE, labelled: the local Ollama
 * (tests/fixtures/fake-ollama-chat.ts: no model behind it, its answer says FAKE).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { appRoot } from '../src/companion/timmy-app.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const ANSWER = 'FAKE app answer: the board streamed the real turn (no model behind it).';

describe.skipIf(!browserPath)('the Timmy app: Timmy\'s shell, the Chat, Models & accounts, the Canvas desk and the Rive faces (R12)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let origin = '';
  let token = '';
  const outside: string[] = [];
  const problems: string[] = [];

  beforeAll(async () => {
    if (!existsSync(join(appRoot(), 'dist', 'app.js'))) await buildApp();
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'r12-app-browser-'));
    const root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    ollama = await startFakeOllama({
      models: [
        { name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] },
        { name: 'fake-embed:1', capabilities: ['embedding'] },
      ],
      chat: [
        () => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE app answer: ', 'the board streamed ', 'the real turn ', '(no model behind it).']), delayMs: 200 }),
        // NEEDS YOU: the FAKE model asks for write_project_file, which asks the person; allowed once on the page, it runs
        () => ({ chunks: toolCallChunks('fake-qwen3:8b', [{ name: 'write_project_file', arguments: { path: 'notes-app.md', content: 'from the FAKE model, allowed once in the app\n' } }]) }),
        () => ({ chunks: textChunks('fake-qwen3:8b', ['Written', '.']), delayMs: 100 }),
        // Stop: a turn that never answers
        () => ({ hang: true }),
      ],
    });
    const home = process.env.TIMMY_HOME!;
    // the setup names this FAKE's address and no model yet: the page chooses one
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host } }));
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
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
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.origin === origin) return route.continue(); outside.push(u.href); return route.abort(); });
    await context.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP ${e.effectiveDirective} ${e.blockedURI}`)));
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console ${m.text()}`); });
    await page.goto(`${origin}/app#t=${token}`);
    return page;
  };

  const go = async (page: Page, id: string): Promise<void> => {
    if (await page.locator('.ta-menu').isVisible()) { await page.click('.ta-menu'); await page.waitForSelector('.ta-rail.is-open'); }
    await page.click(`.ta-rail-item[data-nav="${id}"]`);
    await page.waitForSelector(`.ta-page[data-page="${id}"]`, { timeout: 30_000 });
  };
  const chat = '.ta-chat[data-card="chat"]';

  it('opens on the Chat in Timmy\'s shell: the rail\'s groups, the page head, the band, one composer; the token out of the address', async () => {
    const before = ollama.requests.length;
    const page = await open(1440, 900);
    await page.waitForSelector('.ta-page[data-page="chat"] .ta-title', { timeout: 60_000 });
    expect(page.url()).toBe(`${origin}/app`);
    expect(await page.locator('.ta-rail-label').allInnerTexts()).toEqual(['WORK', 'CREATE', 'CONNECT']);
    expect(await page.locator('.ta-rail-item').count()).toBe(12);
    expect(await page.locator('.ta-rail-item[aria-current="page"]').innerText()).toContain('Chat');
    expect(await page.locator('.ta-page[data-page="chat"] .ta-band .ta-cell-k').allInnerTexts()).toEqual(['WORKSPACE', 'MODEL', 'AGENT', 'RECORDS']);
    // one Send (in the composer), and the chat's tools on its tools row
    expect(await page.locator('button:has-text("Send")').count()).toBe(1);
    expect(await page.locator('.ta-toolsrow .ta-tool').count()).toBeGreaterThanOrEqual(6);
    expect(await page.locator('.ta-tool[data-tool="Attach"]').isDisabled()).toBe(true);
    // the AgentConsole face is mounted in the context column
    await page.waitForSelector('.ta-context .ta-face-console .tr-component[data-artboard="AgentConsole"]');
    await page.waitForTimeout(1200);
    expect(ollama.requests.slice(before).map((r) => r.path)).toEqual([]);
    expect((await page.content()).includes(token)).toBe(false);
    await page.context().close();
  }, 120_000);

  it('Models & accounts asks before it looks: no request reaches Ollama until the person says yes; then its chat models, not the others', async () => {
    const before = ollama.requests.length;
    const page = await open(1440, 900);
    await go(page, 'models');
    await page.waitForSelector('[data-panel="local"] >> text=May Timmy look for the models on this computer?');
    // one card per provider, each with its ProviderCard face and its name once
    await page.waitForFunction(() => document.querySelectorAll('.ta-provider .ta-face-provider .tr-component[data-artboard="ProviderCard"]').length >= 4);
    expect(await page.locator('.ta-provider .ta-provider-name').count()).toBe(await page.locator('.ta-provider').count());
    await page.waitForTimeout(1200);
    expect(ollama.requests.slice(before).map((r) => r.path)).toEqual([]);
    await page.click('[data-panel="local"] >> text=Yes, look for models');
    await page.waitForSelector('[data-panel="local"] .ta-model[data-model="fake-qwen3:8b"]', { timeout: 30_000 });
    expect(ollama.requests.slice(before).some((r) => r.path === '/api/tags')).toBe(true);
    expect(await page.locator('.ta-model[data-model="fake-embed:1"]').count()).toBe(0);
    // chosen for the chat: the setup's own write path; the band says it, and the one next step is Continue to workspace
    await page.click('[data-panel="local"] [aria-label="Use fake-qwen3:8b for the chat"]');
    await page.waitForSelector('[data-panel="local"] .ta-model.is-chosen[data-model="fake-qwen3:8b"]', { timeout: 30_000 });
    await page.waitForFunction(() => (document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '').includes('fake-qwen3:8b'));
    await page.click('.ta-head-actions >> text=Continue to workspace');
    await page.waitForSelector('.ta-page[data-page="chat"]');
    await page.context().close();
  }, 120_000);

  it('the Chat runs the real turn: the AgentConsole face works, the FAKE answer streams, the receipt is sealed and verified', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector(`${chat} textarea.ta-input:not([disabled])`, { timeout: 30_000 });
    await page.waitForSelector('.ta-face-console .tr-component[data-artboard="AgentConsole"]');
    await page.fill(`${chat} textarea.ta-input`, 'Show me the board is wired to the real turn.');
    await page.click(`${chat} button:has-text("Send")`);
    // the face follows the turn's own events: working while it runs
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'working', null, { timeout: 30_000 });
    await page.waitForFunction((a) => (document.querySelector('.ta-chat .ta-turns')?.textContent ?? '').includes(a), ANSWER, { timeout: 60_000 });
    await page.waitForSelector(`${chat} .ta-receipt .ta-verified`, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'idle', null, { timeout: 30_000 });
    expect(ollama.chats().length).toBe(1);
    expect(await page.locator('.ta-page[data-page="chat"] .ta-band .ta-cell').nth(3).innerText()).toContain('verified');
    await page.context().close();
  }, 180_000);

  it('NEEDS YOU: the tool waits for the person; the Rive ActionButton "Allow once" answers it, the tool runs, the file is written', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector(`${chat} textarea.ta-input:not([disabled])`, { timeout: 30_000 });
    await page.fill(`${chat} textarea.ta-input`, 'Write a note into the project.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.ta-needs[aria-label="NEEDS YOU"]', { timeout: 60_000 });
    expect(await page.locator('.ta-needs').innerText()).toContain('write_project_file');
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'awaiting', null, { timeout: 30_000 });
    // the answers are the bindings' own <button>s around the ActionButton faces (their words spoken once, not drawn twice)
    const allow = page.locator('.ta-needs button[aria-label="Allow once"]');
    expect(await allow.count()).toBe(1);
    await allow.click();
    await page.waitForFunction(() => (document.querySelector('.ta-chat .ta-turns')?.textContent ?? '').includes('Written.'), null, { timeout: 60_000 });
    expect(existsSync(join(process.env.TIMMY_REPO ?? join(box, 'project'), 'notes-app.md')) || existsSync(join(box, 'project', 'notes-app.md'))).toBe(true);
    await page.context().close();
  }, 180_000);

  it('Stop: a turn that hangs is stopped from the composer; the face says stopped, Send comes back', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector(`${chat} textarea.ta-input:not([disabled])`, { timeout: 30_000 });
    await page.fill(`${chat} textarea.ta-input`, 'This one will be stopped.');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${chat} button:has-text("Stop")`, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'working', null, { timeout: 30_000 });
    await page.click(`${chat} button:has-text("Stop")`);
    await page.waitForFunction(() => ['stopping', 'stopped'].includes(document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector(`${chat} button:has-text("Send")`, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'stopped', null, { timeout: 30_000 });
    await page.context().close();
  }, 180_000);

  it('the Canvas: a bounded desk with Timmy\'s Rive shapes and cards, the SDK\'s licence read; a node added, undone, kept across a reload', async () => {
    const page = await open(1440, 900);
    await go(page, 'canvas');
    await page.waitForSelector('.ta-stage .tl-container .ta-desk', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll('.tr-shape .tr-component[data-artboard]').length >= 2, null, { timeout: 30_000 });
    expect(await page.locator('.ta-desk-card').count()).toBeGreaterThanOrEqual(2);
    // a saved Rive shape never claims to be live before an event of this page moved it
    expect(await page.locator('.tr-shape-source').first().innerText()).toContain('as saved');
    // the licence as the SDK's own manager says it (no key in this test: unlicensed on a development address)
    await page.waitForSelector('.ta-license[data-license]:not([data-license="unread"])', { timeout: 30_000 });
    expect(await page.locator('.ta-footer').innerText()).toContain('Canvas licence:');
    const count = async (): Promise<number> => page.evaluate(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '')?.[1] ?? -1));
    const n0 = await count();
    expect(n0).toBeGreaterThanOrEqual(4);
    await page.click('.ta-tool[data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="card:conversation"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0);
    expect(await page.locator('.ta-inspect-title').innerText()).toContain('This conversation');
    await page.click('.ta-tool[data-tool="Undo"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '')?.[1] ?? -1) === n, n0);
    await page.click('.ta-tool[data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="card:receipt"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0);
    await page.waitForTimeout(1200); // tldraw writes its store to the browser's IndexedDB as the person works
    // opened again from Timmy (the token is in the page's memory only, so a reload alone reads nothing): the page it was on, the desk as left
    await page.goto('about:blank');
    await page.goto(`${origin}/app#t=${token}`);
    await page.waitForSelector('.ta-page[data-page="canvas"] .ta-stage .tl-container .ta-desk', { timeout: 60_000 });
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0, { timeout: 30_000 });
    expect(await page.locator('.ta-footer-btn:has-text("Export canvas")').isDisabled()).toBe(false);
    await page.context().close();
  }, 180_000);

  it('a phone\'s width: the rail is a drawer, the pages one column, the composer in view, nothing wider than the screen', async () => {
    const page = await open(390, 844);
    await page.waitForSelector('.ta-page[data-page="chat"]', { timeout: 60_000 });
    expect(await page.locator('.ta-rail').evaluate((el) => el.getBoundingClientRect().right <= 0)).toBe(true);
    const box = await page.locator('.ta-composer').boundingBox();
    expect(box && box.y + box.height <= 844).toBe(true);
    await go(page, 'models');
    expect(await page.locator('.ta-rail.is-open').count()).toBe(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.context().close();
  }, 120_000);

  it('asked nothing of another host, broke no policy, threw nothing', () => {
    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });
});
