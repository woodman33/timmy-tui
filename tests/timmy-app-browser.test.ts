/**
 * R12 (the operator's 03:04 order: "coding the timmy tui into rive and tldraw"): the Timmy app in a real headless Chromium,
 * against the real companion on 127.0.0.1, read and used as a person does — the board (tldraw) and its cards, the Rive faces,
 * the permission before the local Ollama is asked, a model chosen, a real turn sent and sealed, its receipt on Review, and the
 * same cards as a column on a phone's width.
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

describe.skipIf(!browserPath)('the Timmy app: the board, its cards and its Rive faces (R12)', () => {
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

  it('opens on 01 Connect: the board with its cards, the step path, the band; the token out of the address', async () => {
    const page = await open(1440, 900);
    await page.waitForSelector('.tl-container .ta-card[data-card="models-here"]', { timeout: 60_000 });
    expect(page.url()).toBe(`${origin}/app`);
    expect(await page.locator('.ta-step[aria-current="step"]').innerText()).toMatch(/01\s*Connect/);
    for (const card of ['models-here', 'providers', 'catalog']) expect(await page.locator(`.ta-card[data-card="${card}"]`).count()).toBe(1);
    expect(await page.locator('.ta-band .ta-cell-k').allInnerTexts()).toEqual(['MODEL', 'AGENT', 'PROOF']);
    // the Rive faces are mounted (a face per provider, the bindings' own element)
    await page.waitForFunction(() => document.querySelectorAll('.ta-face-provider .tr-component[data-artboard="ProviderCard"]').length >= 4);
    expect((await page.content()).includes(token)).toBe(false);
    await page.context().close();
  }, 120_000);

  it('asks before it looks: no request reaches Ollama until the person says yes; then its chat models, not the others', async () => {
    const before = ollama.requests.length;
    const page = await open(1440, 900);
    await page.waitForSelector('text=May Timmy look for the models on this computer?');
    await page.waitForTimeout(1500);
    expect(ollama.requests.slice(before).map((r) => r.path)).toEqual([]);
    await page.click('text=Yes, look for models');
    await page.waitForSelector('.ta-model[data-model="fake-qwen3:8b"]', { timeout: 30_000 });
    expect(ollama.requests.slice(before).some((r) => r.path === '/api/tags')).toBe(true);
    expect(await page.locator('.ta-model[data-model="fake-embed:1"]').count()).toBe(0);
    // chosen for the chat: the setup's own write path; the band says it
    await page.click('[aria-label="Use fake-qwen3:8b for the chat"]');
    await page.waitForSelector('.ta-model.is-chosen[data-model="fake-qwen3:8b"]', { timeout: 30_000 });
    await page.waitForFunction(() => (document.querySelector('.ta-band .ta-cell-v')?.textContent ?? '').includes('fake-qwen3:8b'));
    await page.context().close();
  }, 120_000);

  it('02 Chat runs the real turn: the AgentConsole face works, the FAKE answer streams, the receipt is sealed and verified', async () => {
    const page = await open(1440, 900);
    await page.click('.ta-step:has-text("Chat")');
    await page.waitForSelector('.ta-card[data-card="chat"] textarea.ta-input:not([disabled])', { timeout: 30_000 });
    await page.waitForSelector('.ta-face-console .tr-component[data-artboard="AgentConsole"]');
    await page.fill('.ta-card[data-card="chat"] textarea.ta-input', 'Show me the board is wired to the real turn.');
    await page.click('.ta-card[data-card="chat"] button:has-text("Send")');
    // the face follows the turn's own events: working while it runs
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'working', null, { timeout: 30_000 });
    await page.waitForFunction((a) => (document.querySelector('.ta-card[data-card="chat"] .ta-turns')?.textContent ?? '').includes(a), ANSWER, { timeout: 60_000 });
    await page.waitForSelector('.ta-card[data-card="chat"] .ta-receipt .ta-verified', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'idle', null, { timeout: 30_000 });
    expect(ollama.chats().length).toBe(1);
    // 03 Review: the answer with its model and its verified receipt
    await page.click('.ta-step:has-text("Review")');
    await page.waitForSelector('.ta-card[data-card="receipts"] .ta-table td .ta-verified', { timeout: 30_000 });
    expect(await page.locator('.ta-card[data-card="receipts"] .ta-table tbody tr').first().innerText()).toContain('fake-qwen3:8b');
    expect(await page.locator('.ta-band .ta-cell').nth(2).innerText()).toContain('verified');
    await page.context().close();
  }, 180_000);

  it('NEEDS YOU: the tool waits for the person; the Rive ActionButton "Allow once" answers it, the tool runs, the file is written', async () => {
    const page = await open(1440, 900);
    await page.click('.ta-step:has-text("Chat")');
    await page.waitForSelector('.ta-card[data-card="chat"] textarea.ta-input:not([disabled])', { timeout: 30_000 });
    await page.fill('.ta-card[data-card="chat"] textarea.ta-input', 'Write a note into the project.');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('.ta-needs[aria-label="NEEDS YOU"]', { timeout: 60_000 });
    expect(await page.locator('.ta-needs').innerText()).toContain('write_project_file');
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'awaiting', null, { timeout: 30_000 });
    // the answers are the bindings' own <button>s around the ActionButton faces
    const allow = page.locator('.ta-needs button[aria-label="Allow once"]');
    expect(await allow.count()).toBe(1);
    await allow.click();
    await page.waitForFunction(() => (document.querySelector('.ta-card[data-card="chat"] .ta-turns')?.textContent ?? '').includes('Written.'), null, { timeout: 60_000 });
    expect(existsSync(join(process.env.TIMMY_REPO ?? join(box, 'project'), 'notes-app.md')) || existsSync(join(box, 'project', 'notes-app.md'))).toBe(true);
    await page.context().close();
  }, 180_000);

  it('Stop: a turn that hangs is stopped from the page; the face says stopped, Send comes back', async () => {
    const page = await open(1440, 900);
    await page.click('.ta-step:has-text("Chat")');
    await page.waitForSelector('.ta-card[data-card="chat"] textarea.ta-input:not([disabled])', { timeout: 30_000 });
    await page.fill('.ta-card[data-card="chat"] textarea.ta-input', 'This one will be stopped.');
    await page.click('.ta-card[data-card="chat"] button:has-text("Send")');
    await page.waitForSelector('.ta-card[data-card="chat"] button:has-text("Stop")', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'working', null, { timeout: 30_000 });
    await page.click('.ta-card[data-card="chat"] button:has-text("Stop")');
    await page.waitForFunction(() => ['stopping', 'stopped'].includes(document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector('.ta-card[data-card="chat"] button:has-text("Send")', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'stopped', null, { timeout: 30_000 });
    await page.context().close();
  }, 180_000);

  it('a phone\'s width: the same cards as a column (no board), the step path still there', async () => {
    const page = await open(390, 844);
    await page.waitForSelector('.ta-app.is-narrow .ta-stack .ta-card[data-card="models-here"]', { timeout: 60_000 });
    expect(await page.locator('.tl-container').count()).toBe(0);
    expect(await page.locator('.ta-step').count()).toBe(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.context().close();
  }, 120_000);

  it('asked nothing of another host, broke no policy, threw nothing', () => {
    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });
});
