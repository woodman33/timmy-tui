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
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
import { IDENTITY_ENV } from '../src/companion/identity/config.js';
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
  let phone: CompanionServer; // the same home (a ready route) on a project of its own, untouched by the turn sent above
  let configured: CompanionServer; // an identity provider CONFIGURED (a FAKE instance: its public PEM is CLERK_JWT_KEY), no Clerk dist
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
    const root3 = join(box, 'fresh-phone');
    mkdirSync(join(root3, '.timmy'), { recursive: true });
    process.env.TIMMY_REPO = root3;
    phone = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    // a configured companion: the identity's env names (tests/identity-session.test.ts's FAKE instance shape); the page gets
    // no session here (nothing signs in: no Clerk dist), so every user-data route answers 401 { needs: 'session' }
    const HOST = 'fake-identity.clerk.accounts.invalid';
    const PK = `pk_test_${Buffer.from(`${HOST}$`).toString('base64')}`;
    const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const root4 = join(box, 'fresh-configured');
    mkdirSync(join(root4, '.timmy'), { recursive: true });
    const env4 = { ...env, [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.jwtKey]: PEM };
    process.env.TIMMY_REPO = root4;
    configured = await startCompanionServer(0, { chatEnv: env4, workspace: { env: env4 }, identity: { clerkDir: join(box, 'no-clerk') } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
  }, LONG);
  afterAll(async () => {
    await withRoute?.shutdown();
    await phone?.shutdown();
    await configured?.shutdown();
    await noRoute?.shutdown();
    await ollama?.close();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** The page opened with its token, landed by the shell's rule. */
  async function land(c: CompanionServer, size: { width: number; height: number }, storageState?: StorageState) {
    const o = await openPage(browser, { origin: urlOf(c) }, size, storageState);
    await o.page.goto(`${urlOf(c)}/#t=${tokenOf(c)}`);
    await o.page.waitForFunction(() => Boolean(document.body.dataset.screen), null, { timeout: 30_000 });
    return o;
  }

  it('with no identity provider configured the page is this companion\'s own workspace (Chat; the rail says This computer\'s operator and names the dependency); the account screen says what is missing; the connections screen reads as the operator', async () => {
    const { context, page, errors } = await land(withRoute, { width: 1440, height: 900 });
    try {
      // (the landing rule: nothing to sign into here, so the workspace, as before accounts; configured and not signed in →
      // the account screen; signed in → connections until a route is ready: H172's journey)
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('chat');
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { current(): string; SCREENS: string[] } }).TimmyShell.SCREENS)).toEqual(['account', 'connections', 'chat']);
      expect(await page.isVisible('#screen-chat')).toBe(true);
      expect(await page.isVisible('#screen-account')).toBe(false);
      expect(await text(page, '#rail-account-name')).toBe('This computer’s operator');
      // the rail's account block opens H173's account screen, mounted into the shell: "Identity · not configured" (GET
      // /api/identity names what is missing), the sign-up card with its primary step off; nothing signs in
      await page.click('#rail-account-go');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('account');
      expect(await page.isVisible('#screen-chat')).toBe(false);
      expect(await text(page, '#screen-account h2')).toBe('Create your Timmy account');
      expect(await text(page, '#screen-account')).toContain('Identity · not configured');
      expect(await page.isDisabled('#screen-account .sh-btn-primary')).toBe(true);
      // the shell remembers the screen id only: never a token, never a key (the screens are reached by the shell: the
      // account screen has no way around sign-in; H170's connections screen has Explore without a model → chat)
      // the rail's Models & accounts opens H170's connections screen, mounted: its routes read as this computer's operator
      // (no provider configured: the operator principal), the preview's four cards; Explore without a model → Chat
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.click('#rail-menu .rail-item[data-shell-go="connections"]');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('connections');
      await page.waitForSelector('#screen-connections .cn-card', { timeout: 20_000 });
      expect(await text(page, '#screen-connections h1')).toBe('Choose how you want to run.');
      expect(await page.$$eval('#screen-connections .cn-card', (els) => els.length)).toBe(4);
      await page.click('#screen-connections button:has-text("Explore without a model")');
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
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'fresh', null, { timeout: 60_000 }); // (the socket's welcome names it)
      expect(await text(page, '#rail-project-name')).toBe('fresh');
      expect(await text(page, '#rail-new-conv')).toBe('+ New conversation');
      expect(await texts(page, '#rail-menu .rail-group:not([hidden])')).toEqual(['Work', 'Create', 'Connect']);
      expect(await texts(page, '#rail-menu .rail-item .rail-label')).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'VoxVision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations']);
      expect(await page.getAttribute('#rail-menu .rail-item[data-dest="chat"]', 'aria-current')).toBe('page');
      expect(await page.getAttribute('#rail-menu .rail-item[data-shell-go]', 'data-shell-go')).toBe('connections');
      expect(await text(page, '#rail-avatar')).toBe('T');
      // (the lead's ruling of 21:48: no identity provider → this computer's operator, the dependency named)
      expect(await text(page, '#rail-account-name')).toBe('This computer’s operator');
      expect(await text(page, '#rail-account-sub')).toMatch(/^no identity provider configured \(CLERK_[A-Z_]+(, CLERK_[A-Z_]+)*\)$/);
      expect(await page.isVisible('#rail-signout')).toBe(false);
      // the top line: "<project> / Chat", the state words, Connections
      expect(await text(page, '.cx-crumb')).toBe('fresh / Chat');
      expect(await text(page, '#cx-state-words')).toBe('Local logs · cloud sync off');
      expect(await text(page, '#cx-connections')).toBe('Connections');
      // the descriptor and the welcome
      expect(await text(page, '#cx-descriptor span > strong')).toBe('Agent chat');
      expect(await text(page, '#cx-sub')).toBe('Think, make and check your work.');
      expect(await text(page, '#cx-tag')).toBe('FAKE model on this computer');
      expect(await text(page, '#cx-descriptor-state')).toBe('Local logs · cloud sync off');
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
      // (no identity provider configured: the page is this computer's operator, so Send is amber with a draft and a route;
      // with a provider configured and no session it is off, saying "Sign in to send: the turn runs in your own Timmy home.")
      expect(await page.isDisabled('#cx-send')).toBe(false);
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundColor)).toBe('rgb(255, 176, 0)');
      // the bottom row
      expect(await texts(page, '#cx-controls .cx-ctl')).toEqual(['▱ Plan / Run', '◇ Permissions', '$ Budget', '≡ Logs', '⌁ Cloudflare optional']);
      // the right panel: Models | Tools; the provider tabs; the chosen tab's description and its action; the five controls
      expect(await texts(page, '#cx-models .cx-panel-tab')).toEqual(['Models', 'Tools']);
      expect(await texts(page, '#cx-models .cm-provider')).toEqual(['OpenRouter', 'Ollama local', 'Ollama cloud', 'Cloudflare']);
      // (the chosen tab is the route's provider: this home's route is the FAKE local Ollama; OpenRouter's description when
      // its tab is chosen)
      expect(await text(page, '#cm-desc h3')).toBe('Ollama · local');
      await page.click('[data-cm-provider="openrouter"]');
      expect(await text(page, '#cm-desc h3')).toBe('OpenRouter');
      expect(await text(page, '#cm-desc > p')).toBe('Use models from many makers through your OpenRouter account.');
      expect(await text(page, '#cm-desc .cm-connect')).toBe('Connect with OpenRouter ↗');
      expect(await page.getAttribute('#cm-desc .cm-connect', 'data-shell-go')).toBe('connections');
      expect(await page.getAttribute('#cm-search', 'placeholder')).toBe('Search models or makers');
      // (each control has its own <label for>: the words a reader hears; the first option is the preview's)
      expect(await page.$$eval('#cx-models .cm-filters select', (els) => els.map((e) => [(e as HTMLSelectElement).labels?.[0]?.textContent ?? null, (e as HTMLSelectElement).selectedOptions[0]?.textContent]))).toEqual([
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
      // (the draft is kept by project: the socket has named it before the person types)
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'fresh', null, { timeout: 60_000 });
      await page.fill('#cx-input', 'A draft that survives the reopen.');
      await page.waitForTimeout(200);
      expect(errors).toEqual([]);
      // the browser closed and opened again: its profile's storage (localStorage) comes back, as a person's browser keeps it;
      // it holds the screen and the draft only, never a token or a key
      const kept = await context.storageState();
      expect(JSON.stringify(kept)).not.toMatch(/[0-9a-f]{64}|sk-or-/);
      expect(kept.origins.flatMap((o) => o.localStorage.map((e) => e.name)).sort()).toEqual(expect.arrayContaining(['timmy.shell.screen']));
      await context.close();
      ({ context, page, errors } = await land(withRoute, { width: 1440, height: 900 }, kept));
      // no identity provider: the landing rule opens the workspace (a remembered screen counts only when signed in)
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('chat');
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'fresh', null, { timeout: 60_000 });
      await page.waitForFunction(() => (document.getElementById('cx-input') as HTMLTextAreaElement | null)?.value === 'A draft that survives the reopen.', null, { timeout: 10_000 });
      expect(await page.inputValue('#cx-input')).toBe('A draft that survives the reopen.');
      // Send (H169's POST /api/chat/turn) as this computer's operator (no identity provider here): the turn runs in the
      // companion's own project with the FAKE Ollama's answer streamed as this page's turn (the shell gave the screen's
      // heading the keyboard on arrival; a person clicks in first)
      await page.focus('#cx-input');
      await page.keyboard.press('Enter');
      // (the own turn folds into the project's saved conversation once its receipt is read back: the end state is the chain's)
      await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-turn.is-timmy').length >= 1 && document.querySelectorAll('#cx-own .cx-turn').length === 0 && document.body.dataset.chatState !== 'empty', null, { timeout: 60_000 });
      expect(await page.$eval('#cx-turns .cx-turn.is-timmy:last-of-type .cx-text', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())).toBe('FAKE answer.');
      expect(await page.$eval('#cx-turns .cx-turn.is-timmy:last-of-type .cx-evidence', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())).toMatch(/· receipt [0-9a-f]{8}/);
      expect(await page.inputValue('#cx-input')).toBe('');
      // New conversation puts this page's turns away and clears the draft
      await page.click('#rail-new-conv');
      expect(await page.$$eval('#cx-own .cx-turn', (els) => els.length)).toBe(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('at 390 × 844 the rail folds behind Menu; Connections and Models are the top buttons; the starters stack; nothing overflows sideways', async () => {
    // (a project of its own with no conversation, so the welcome shows; withRoute's project holds the turn sent above)
    const { context, page, errors } = await land(phone, { width: 390, height: 844 });
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

  it('on a CONFIGURED companion with no session the page lands on the account screen: GET /api/identity read, no refusal words, no project frame; the user-data routes\' 401 { needs: "session" } is never read as the launch token refused (the lead\'s 23:33 blocker)', async () => {
    const { context, page, errors } = await openPage(browser, { origin: urlOf(configured) }, { width: 1440, height: 900 });
    const got: Array<{ url: string; status: number }> = [];
    page.on('response', (r) => { const u = new URL(r.url()); if (u.origin === urlOf(configured) && u.pathname.startsWith('/api/')) got.push({ url: u.pathname, status: r.status() }); });
    try {
      await page.goto(`${urlOf(configured)}/#t=${tokenOf(configured)}`);
      await page.waitForFunction(() => Boolean(document.body.dataset.screen), null, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      const state = await page.evaluate(() => ({ screen: document.body.dataset.screen, refused: (window as unknown as { companion?: { refused?: boolean } }).companion?.refused ?? null, identity: (window as unknown as { TimmyShell?: { identity(): unknown } }).TimmyShell?.identity() ?? null }));
      expect(JSON.stringify({ ...state, got })).toMatch(/"screen":"account"/);
      expect(await page.isVisible('#screen-account')).toBe(true);
      // the identity was read (the shell's landing), and the page never said its token was refused
      expect(got.some((g) => g.url === '/api/identity' && g.status === 200)).toBe(true);
      const face = await page.evaluate(() => document.body.innerText);
      expect(face).not.toContain('not the companion’s');
      expect(face).not.toContain('loads nothing');
      expect(await text(page, '#screen-account h2')).toBe('Create your Timmy account');
      // a user-data route asked before the shell was here (the frame's first read) answered 401 needs:session — once, not a loop
      const sessions = got.filter((g) => g.status === 401);
      // (R11 round 5, the lead's dae84ba5: the journey's and the panels' reads are user-data reads too, under the same principal)
      for (const g of sessions) {
        const path = g.url.replace(/\?.*$/, '');
        if (/^\/api\/(?:journey|panel)\//.test(path)) continue;
        expect(['/api/workspace', '/api/chat/view', '/api/chat/models', '/api/chat/route', '/api/connections']).toContain(path);
      }
      expect(sessions.length).toBeLessThan(12);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);
});
