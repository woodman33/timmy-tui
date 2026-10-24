/**
 * R11 round 4 (H171): the page's shell and the main agent Chat as the operator's design preview draws them (captures 04/05/09),
 * in a real Chromium at 1440x900 and 390x844, on this container's FAKE state: no identity provider configured (GET /api/identity
 * is not on this branch: the account screen's placeholder names it and nothing signs in), a FAKE Ollama on 127.0.0.1 with one
 * chat model chosen (the route ready) and a second companion with no model chosen (Send off). The landing rule (account), the
 * screens by TimmyShell.go, the rail per the preview, the right panel's five controls, the welcome's three starters, Send off
 * without a route and amber with one, reopen restores the draft and the chosen screen, no page errors, the FAKE key's value
 * nowhere in the DOM. The turn itself is H169's POST /api/chat/turn (its own test); here the page says plainly when the
 * companion has no such route.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser, openPage } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FAKE_KEY = 'sk-or-v1-FAKE-never-on-the-page-0000000000000000';
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
const texts = (page: Page, sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
const LONG = 240_000;

describe.skipIf(!browserPath)('the page shell and the main agent Chat as the preview draws them (R11 round 4, H171)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let withRoute: CompanionServer;
  let noRoute: CompanionServer;
  const urlOf = (c: CompanionServer): string => `http://127.0.0.1:${c.port}`;
  const tokenOf = (c: CompanionServer): string => /#t=([0-9a-f]{64})$/.exec(c.url)![1];

  beforeAll(async () => {
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'h171-r4-shell-'));
    const home = process.env.TIMMY_HOME!;
    ollama = await startFakeOllama({ models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] }], chat: [() => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE answer.']), delayMs: 20 })] });
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: [] }));
    // the FAKE key, saved as the setup saves one, must never reach the page
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ openrouter_api_key: FAKE_KEY, ollama_host: ollama.host }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    const root = join(box, 'fresh');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    process.env.TIMMY_REPO = root;
    withRoute = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    // a second companion whose settings choose no model: the route is not ready
    const home2 = join(box, 'home-none');
    mkdirSync(join(home2, 'models'), { recursive: true });
    writeFileSync(join(home2, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: [] }));
    const settings2 = join(box, 'settings-none');
    mkdirSync(settings2, { recursive: true });
    const env2 = { TIMMY_HOME: home2, TIMMY_SETTINGS_DIR: settings2 };
    noRoute = await startCompanionServer(0, { chatEnv: env2, workspace: { env: env2 } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
  }, LONG);
  afterAll(async () => {
    await withRoute?.shutdown();
    await noRoute?.shutdown();
    await ollama?.close();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page opened with its token, landed by the shell's rule. */
  async function land(c: CompanionServer, size: { width: number; height: number }) {
    const o = await openPage(browser, { origin: urlOf(c) }, size);
    await o.page.goto(`${urlOf(c)}/#t=${tokenOf(c)}`);
    await o.page.waitForFunction(() => Boolean(document.body.dataset.screen), null, { timeout: 30_000 });
    return o;
  }

  it('lands on the account screen when no identity provider is configured (the dependency named, nothing signed in), then the connections and the chat screens by the shell', async () => {
    const { context, page, errors } = await land(withRoute, { width: 1440, height: 900 });
    try {
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('account');
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { current(): string; SCREENS: string[] } }).TimmyShell.SCREENS)).toEqual(['account', 'connections', 'chat']);
      expect(await page.isVisible('#screen-account')).toBe(true);
      expect(await page.isVisible('#screen-chat')).toBe(false);
      // the shell's placeholder (the account screen's own script is H173's): what is missing, in words; nothing signs in
      expect(await text(page, '#screen-account h2')).toBe('Create your Timmy account');
      expect(await text(page, '#screen-account')).toContain('no GET /api/identity');
      expect(await page.$$eval('#screen-account input', (els) => els.length)).toBe(0);
      // the shell remembers the screen id only: never a token, never a key
      await page.click('#screen-account [data-shell-go="connections"]');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('connections');
      expect(await text(page, '#screen-connections h2')).toBe('Choose how you want to run.');
      await page.click('#screen-connections [data-shell-go="chat"]');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('chat');
      expect(await page.isVisible('#screen-chat')).toBe(true);
      const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'));
      expect(stored).toContain('timmy.shell.screen=chat');
      expect(stored).not.toMatch(/[0-9a-f]{64}|sk-or-/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('at 1440 × 900 the chat as the preview draws it: the rail, the top line, the descriptor, the welcome with three starters, the composer, the bottom row, the right panel with its five controls and NEXT TURN; Send amber with a draft and a route; the FAKE key nowhere', async () => {
    const { context, page, errors } = await land(withRoute, { width: 1440, height: 900 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      // the rail: the mark and TIMMY; WORKSPACE with the project box and New conversation; Chat; WORK; CREATE; CONNECT; the account
      expect(await text(page, '#shell-rail .rail-brand')).toBe('T TIMMY');
      expect(await text(page, '#rail-project-label')).toBe('Workspace');
      expect(await text(page, '#rail-project-name')).toBe('fresh');
      expect(await text(page, '#rail-new-conv')).toBe('+ New conversation');
      expect(await texts(page, '#rail-menu .rail-group:not([hidden])')).toEqual(['Work', 'Create', 'Connect']);
      expect(await texts(page, '#rail-menu .rail-item .rail-label')).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'VoxVision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations']);
      expect(await page.getAttribute('#rail-menu .rail-item[data-dest="chat"]', 'aria-current')).toBe('page');
      expect(await page.getAttribute('#rail-menu .rail-item[data-shell-go]', 'data-shell-go')).toBe('connections');
      expect(await text(page, '#rail-account')).toBe('T Not signed in this companion’s own workspace');
      expect(await page.isVisible('#rail-signout')).toBe(false);
      // the top line: "<project> / Chat", the state words, Connections
      expect(await text(page, '.cx-crumb')).toBe('fresh / Chat');
      expect(await text(page, '#cx-state-words')).toBe('Local logs · cloud sync off');
      expect(await text(page, '#cx-connections')).toBe('Connections');
      // the descriptor and the welcome
      expect(await text(page, '#cx-descriptor')).toBe('Agent chat Think, make and check your work. FAKE model on this computer Local logs · cloud sync off');
      expect(await text(page, '#cx-empty .cx-welcome-title')).toBe('What would you like to make?');
      expect(await text(page, '#cx-empty .cx-welcome-line')).toBe('Your models, tools and ideas share one workspace.');
      expect(await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent, e.querySelector('.cx-way-words')?.textContent]))).toEqual([
        ['plan', 'Plan a project', 'Turn an idea into the next step.'], ['image', 'Inspect an image', 'Bring it into VoxVision.'], ['workflow', 'Build a workflow', 'Connect your tools around a task.'],
      ]);
      const tops = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      // the line above the composer: the route is ready, so the next turn's model
      expect(await text(page, '#cx-route')).toBe('Next turn: fake-qwen3:8b · Ollama on this computer Change model');
      // the composer: "Message Timmy…", + Attach, ⌘ Tools, Send ↑ (off until typed), the two notes
      expect(await page.getAttribute('#cx-input', 'placeholder')).toBe('Message Timmy…');
      expect(await texts(page, '.cx-compose-foot .cx-foot-btn')).toEqual(['+ Attach', '⌘ Tools']);
      expect(await page.getAttribute('#cx-send', 'aria-label')).toBe('Send message');
      expect(await page.isDisabled('#cx-send')).toBe(true);
      expect(await text(page, '.cx-hint')).toBe('Messages and records stay local unless you choose cloud services.Enter to send · Shift + Enter for a new line');
      await page.fill('#cx-input', 'Plan the first slice.');
      expect(await page.isDisabled('#cx-send')).toBe(false);
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundColor)).toBe('rgb(255, 176, 0)');
      // the bottom row
      expect(await texts(page, '#cx-controls .cx-ctl')).toEqual(['▱ Plan / Run', '◇ Permissions', '$ Budget', '≡ Logs', '⌁ Cloudflare optional']);
      // the right panel: Models | Tools; the provider tabs; the chosen tab's description and its action; the five controls
      expect(await texts(page, '#cx-models .cx-panel-tab')).toEqual(['Models', 'Tools']);
      expect(await texts(page, '#cx-models .cm-provider')).toEqual(['OpenRouter', 'Ollama local', 'Ollama cloud', 'Cloudflare']);
      expect(await text(page, '#cm-desc h3')).toBe('OpenRouter');
      expect(await text(page, '#cm-desc > p')).toBe('Use models from many makers through your OpenRouter account.');
      expect(await text(page, '#cm-desc .cm-connect')).toBe('Connect with OpenRouter ↗');
      expect(await page.getAttribute('#cm-desc .cm-connect', 'data-shell-go')).toBe('connections');
      expect(await page.getAttribute('#cm-search', 'placeholder')).toBe('Search models or makers');
      expect(await page.$$eval('#cx-models .cm-filters select', (els) => els.map((e) => [(e as HTMLSelectElement).getAttribute('aria-label'), (e as HTMLSelectElement).selectedOptions[0]?.textContent]))).toEqual([
        ['Sort', 'Newest first'], ['Maker', 'All makers'], ['Capability', 'All capabilities'], ['Cost', 'Any cost'], ['Context', 'Any context'],
      ]);
      // OpenRouter's catalog here is empty: the preview's words, nothing invented
      expect(await text(page, '#cm-list .cm-empty-models strong')).toBe('Your models will appear here.');
      expect(await text(page, '#cm-list .cm-empty-models')).toContain('No catalog or live prices are invented.');
      // NEXT TURN: the chosen model, and the chip with its ready dot
      expect(await text(page, '#cx-next-turn .sh-label')).toBe('Next turn');
      expect(await text(page, '#cx-next-turn-model')).toBe('fake-qwen3:8b');
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
      // the Tools tab: the four contextual tools with a state word each
      await page.click('#cx-panel-tools');
      await page.waitForSelector('#cx-models .cx-tool-item', { timeout: 10_000 });
      expect(await texts(page, '#cx-models .cx-tool-item h3')).toEqual(['Project files', 'Web & research', 'Canvas', 'Cloudflare agents']);
      expect(await text(page, '#cx-models .cm-desc h3')).toBe('Tools for this conversation');
      expect(await page.$$eval('#cx-models .cx-tool-item', (els) => els.every((e) => ['available', 'configured', 'exercised', 'none'].includes(e.getAttribute('data-state') || '')))).toBe(true);
      // the composer's ⌘ Tools opens that tab too
      await page.click('#cx-panel-models');
      await page.click('#cx-tools-btn');
      expect(await page.getAttribute('#cx-models', 'data-panel')).toBe('tools');
      // the FAKE key's value is nowhere in the DOM
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('FAKE-never-on-the-page');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('without a route: "No model connected. Choose one when you’re ready." with "Set up a model →" to the connections screen, Send off, NEXT TURN says no model', async () => {
    const { context, page, errors } = await land(noRoute, { width: 1440, height: 900 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      await page.waitForFunction(() => (document.getElementById('cx-route-words')?.textContent ?? '').startsWith('No model connected'), null, { timeout: 30_000 });
      expect(await text(page, '#cx-route-words')).toBe('No model connected. Choose one when you’re ready.');
      expect(await text(page, '#cx-change')).toBe('Set up a model →');
      expect(await page.getAttribute('#cx-change', 'data-shell-go')).toBe('connections');
      await page.fill('#cx-input', 'anything');
      expect(await page.isDisabled('#cx-send')).toBe(true);
      expect(await text(page, '#cx-next-turn-model')).toBe('No model selected');
      expect(await text(page, '#cx-next-turn-words')).toBe('Choose a connected model before sending.');
      await page.click('#cx-change');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('connections');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('reopen restores the draft (localStorage) and, after the shell was told the screen, the chat; the turn without H169’s route says so plainly', async () => {
    let { context, page, errors } = await land(withRoute, { width: 1440, height: 900 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      await page.fill('#cx-input', 'A draft that survives the reopen.');
      await page.waitForTimeout(200);
      expect(errors).toEqual([]);
      await context.close();
      ({ context, page, errors } = await land(withRoute, { width: 1440, height: 900 }));
      // not signed in: the landing rule lands on the account screen again (a remembered screen counts only when signed in)
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('account');
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      expect(await page.inputValue('#cx-input')).toBe('A draft that survives the reopen.');
      // Send: this branch has no POST /api/chat/turn (H169's): the turn says so, nothing streams, nothing is invented
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own .cx-turn.is-failed', { timeout: 20_000 });
      expect(await text(page, '#cx-own .cx-turn.is-failed .cx-end')).toContain('no POST /api/chat/turn yet');
      expect(await page.inputValue('#cx-input')).toBe('');
      // New conversation puts this page's turns away and clears the draft
      await page.click('#rail-new-conv');
      expect(await page.$$eval('#cx-own .cx-turn', (els) => els.length)).toBe(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('at 390 × 844 the rail folds behind Menu; Connections and Models are the top buttons; the starters stack; nothing overflows sideways', async () => {
    const { context, page, errors } = await land(withRoute, { width: 390, height: 844 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      expect(await page.isVisible('#shell-rail')).toBe(false);
      expect(await page.isVisible('#cx-menu')).toBe(true);
      expect(await page.isVisible('#cx-connections')).toBe(true);
      expect(await page.isVisible('#cx-models-toggle')).toBe(true);
      const tops = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.click('#cx-menu');
      await page.waitForSelector('#shell-rail:visible', { timeout: 5_000 });
      expect(await texts(page, '#rail-menu .rail-item .rail-label')).toContain('Models & accounts');
      await page.keyboard.press('Escape');
      await page.click('#cx-models-toggle');
      await page.waitForSelector('#cx-models:visible', { timeout: 5_000 });
      expect(await texts(page, '#cx-models .cm-provider')).toEqual(['OpenRouter', 'Ollama local', 'Ollama cloud', 'Cloudflare']);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);
});
