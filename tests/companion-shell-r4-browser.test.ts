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
      // (R11 round 7: the Chat is the page section #ws-chat of the one shell — SHELL CONTRACT v1 §2.1)
      expect(await page.isVisible('#ws-chat')).toBe(true);
      expect(await page.isVisible('#screen-account')).toBe(false);
      expect(await text(page, '#rail-account-name')).toBe('This computer’s operator');
      // the rail's account block opens H173's account screen, mounted into the shell: "Identity · not configured" (GET
      // /api/identity names what is missing), the sign-up card with its primary step off; nothing signs in
      await page.click('#rail-account-go');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('account');
      expect(await page.isVisible('#ws-chat')).toBe(false);
      // (R11 round 7, H173's account page on the scaffold: the UNCONFIGURED blocker — no identity provider → no sign-up form is
      // pretended; the page says so and offers Continue as the operator)
      expect(await text(page, '#screen-account #ac-blocker-title')).toBe('No identity provider is configured.');
      expect(await text(page, '#screen-account')).toContain('Sign-in is not set up on this companion');
      expect(await page.$$eval('#screen-account .ac-submit', (els) => els.length)).toBe(0);
      // the shell remembers the screen id only: never a token, never a key (the screens are reached by the shell: the
      // account screen has no way around sign-in; H170's connections screen has Explore without a model → chat)
      // the rail's Models & accounts opens H170's connections screen, mounted: its routes read as this computer's operator
      // (no provider configured: the operator principal), the preview's four cards; Explore without a model → Chat
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.click('#rail-menu .rail-item[data-page="connections"]');
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('connections');
      await page.waitForSelector('#screen-connections .cn-card', { timeout: 20_000 });
      // (R11 round 7: H170's words on the scaffold's head — the order's "One model is enough to begin.")
      expect(await text(page, '#screen-connections .page-head .page-title')).toBe('One model is enough to begin.');
      expect(await page.$$eval('#screen-connections .cn-card', (els) => els.length)).toBe(4);
      // (R11 round 7: H170's "Explore without a model" is his head's text action; on the scaffold head (H175 97389f14) the control is
      // his to place — when it is there it leads to Chat, else the rail's Chat does: said FOR H170 in the handoff)
      const explore = page.locator('#screen-connections button:has-text("Explore without a model")');
      if (await explore.count()) await explore.first().click(); else await page.click('#rail-menu .rail-item[data-page="chat"]');
      await page.waitForFunction(() => document.body.dataset.screen === 'chat', null, { timeout: 10_000 });
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('chat');
      expect(await page.isVisible('#ws-chat')).toBe(true);
      const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => `${k}=${v}`).join('\n'));
      expect(stored).toContain('timmy.shell.screen=chat');
      expect(stored).not.toMatch(/[0-9a-f]{64}|sk-or-/);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('at 1440 × 900 the chat as the preview draws it: the rail, the top line, the descriptor, the welcome with three starters, the composer, the bottom row, the right panel with its five controls and NEXT TURN; Send amber with a draft and a route; the FAKE key nowhere', async () => {
    const { context, page, errors } = await land(withRoute, { width: 1440, height: 900 });
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      // R11 round 5 (H174's ask): the welcome's T mark asks for its FILE only when the companion says it is there (GET
      // /assets/mark.json: mark) — the runtime IS on the page (R11 round 6: the native UI components' own file, timmy-ui.riv,
      // served here and drawn in the Chat's console band and the primary starter, loads window.rive) and the mark's file is
      // not: drawing on the runtime's presence alone asked /assets/timmy-mark.riv and wrote "Failed to fetch the Rive file:
      // HTTP 404" to the console per canvas. The runtime's Rive is wrapped to record every construction (put on the page when
      // no runtime is here), the marks are drawn again, and the mark's file is neither asked for nor constructed: of the mark
      // the page's one read is mark.json; the only .riv asked for is the native UI's
      // (R11 round 7, H174 a4914820: the mark's words come with the components listing — GET /api/rive/assets — and /assets/mark.json
      // is asked only when no listing answers; either read is the one)
      await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => ['/assets/mark.json', '/api/rive/assets'].includes(new URL(e.name).pathname)), null, { timeout: 10_000 });
      await page.evaluate(() => {
        const made: unknown[] = [];
        const w = window as unknown as { rive?: { Rive?: new (o: unknown) => unknown; made?: unknown[] } };
        if (w.rive && typeof w.rive.Rive === 'function') { const Real = w.rive.Rive; w.rive.Rive = function Recorded(this: unknown, o: unknown) { made.push(o); return new Real(o); } as unknown as new (o: unknown) => unknown; w.rive.made = made; }
        else w.rive = { Rive: class { constructor(o: unknown) { made.push(o); } }, made };
      });
      // @ts-expect-error -- drawMarks is a function of the page's classic script chat-shell.js
      await page.evaluate(() => { drawMarks(); });
      await page.waitForTimeout(1_000);
      const rive = await page.evaluate(() => ({
        made: (window as unknown as { rive: { made: unknown[] } }).rive.made.length,
        asked: performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => /\.riv$|\/assets\/mark\.json$/.test(p)),
        started: [...document.querySelectorAll('canvas[data-timmy-mark]')].map((c) => c.getAttribute('data-rive-started')),
      }));
      expect(rive.made).toBe(0);
      expect(rive.asked.filter((p) => /timmy-mark\.riv$/.test(p))).toEqual([]);
      expect(rive.asked.filter((p) => /\.riv$/.test(p)).every((p) => p === '/assets/rive/timmy-ui/timmy-ui.riv')).toBe(true);
      // (R11 round 7, H174 a4914820: the mark's words ride the components listing; /assets/mark.json is asked only without one)
      expect(rive.asked.some((p) => p === '/assets/mark.json') || (await page.evaluate(() => performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname === '/api/rive/assets')))).toBe(true);
      expect(rive.started.length).toBeGreaterThan(0);
      expect(rive.started.every((s) => s === null)).toBe(true);
      expect(consoleErrors.filter((e) => /Rive|\.riv|404/.test(e))).toEqual([]);
      // the rail: the mark and TIMMY; WORKSPACE with the project box and New conversation; Chat; WORK; CREATE; CONNECT; the account
      expect(await text(page, '#shell-rail .rail-brand')).toBe('T TIMMY');
      expect(await text(page, '#rail-project-label')).toBe('Workspace');
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'fresh', null, { timeout: 60_000 }); // (the socket's welcome names it)
      expect(await text(page, '#rail-project-name')).toBe('fresh');
      expect(await text(page, '#rail-new-conv')).toBe('+ New conversation');
      expect(await texts(page, '#rail-menu .rail-group:not([hidden])')).toEqual(['Work', 'Create', 'Connect']);
      // (R11 round 7: the shell's rail — D3's ten destinations in their groups; Models & accounts a page item like the others)
      expect(await texts(page, '#rail-menu .rail-item .rail-label')).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'VoxVision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations', 'Control Room']);
      expect(await page.getAttribute('#rail-menu .rail-item[data-dest="chat"]', 'aria-current')).toBe('page');
      expect(await page.getAttribute('#rail-menu .rail-item[data-page="connections"]', 'data-dest')).toBe('connections');
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
      // (R11 round 7: the descriptor's line is the page's state line — on the welcome, the welcome's)
      expect(await text(page, '#cx-sub')).toBe('Your models, tools and ideas share one workspace.');
      expect(await text(page, '#cx-kicker')).toBe('01 / START A CONVERSATION');
      expect(await text(page, '#cx-tag')).toBe('FAKE model on this computer');
      expect(await text(page, '#cx-descriptor-state')).toBe('Local logs · cloud sync off');
      // (R11 round 7, on the scaffold: the page head carries the question and the line; the welcome the mark, "Start with", the starters)
      expect(await text(page, '#ws-chat .page-head .page-title')).toBe('What would you like to make?');
      expect(await text(page, '#ws-chat .page-head .page-intro')).toBe('Your models, tools and ideas share one workspace.');
      expect(await text(page, '#cx-empty .cx-welcome-start')).toBe('Start with');
      expect(await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent, e.querySelector('.cx-way-words')?.textContent]))).toEqual([
        ['plan', 'Plan a project', 'Turn an idea into the next step.'], ['image', 'Inspect an image', 'Bring it into VoxVision.'], ['workflow', 'Build a workflow', 'Connect your tools around a task.'],
      ]);
      const tops = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      // R11 round 6 (the operator's order of 06:32): the native AgentConsole IN the chat — a band above the route line; D13 (H168's
      // R77, the lead's ruling): ONE ROW while no turn runs — the toggle, the face at ≤ 48 px in the artboard's own proportions
      // (640 × 380), the state word idle beside it (HTML, aria-live); the toggle OPENS it (this viewer's choice, kept): the face
      // then ≤ 160 px, the word still read; the welcome's primary starter is the native ActionButton with the card as its twin (one
      // control at a time); the route line's button stays the stop before the textarea
      const band = await page.$eval('#cx-console', (b) => ({ hidden: (b as HTMLElement).hidden, folded: b.classList.contains('is-folded'), expanded: b.querySelector('#cx-console-toggle')?.getAttribute('aria-expanded'), artboard: b.querySelector('[data-rive-component]')?.getAttribute('data-artboard'), word: b.querySelector('[data-rive-status]')?.textContent?.trim(), live: b.querySelector('[data-rive-status]')?.getAttribute('aria-live'), bottom: Math.round(b.getBoundingClientRect().bottom), height: Math.round(b.getBoundingClientRect().height) }));
      expect(band).toMatchObject({ hidden: false, folded: true, expanded: 'false', artboard: 'AgentConsole', word: 'idle', live: 'polite' });
      expect(band.height, `the band one row: ${JSON.stringify(band)}`).toBeLessThanOrEqual(56);
      expect(band.bottom).toBeLessThanOrEqual(Math.round(await page.$eval('#cx-route', (e) => e.getBoundingClientRect().top)) + 1);
      const faceOf = () => page.$eval('#cx-console .tr-face', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 }; });
      const face = await faceOf();
      expect(face.visible).toBe(true);
      expect(face.h).toBeLessThanOrEqual(48);
      expect(Math.abs(face.w / face.h - 640 / 380)).toBeLessThan(0.08);
      await page.click('#cx-console-toggle');
      expect(await page.getAttribute('#cx-console-toggle', 'aria-expanded')).toBe('true');
      const open = await faceOf();
      expect(open.visible).toBe(true);
      expect(open.h).toBeGreaterThanOrEqual(96);
      expect(open.h).toBeLessThanOrEqual(160);
      expect(Math.abs(open.w / open.h - 640 / 380)).toBeLessThan(0.06);
      expect(await page.isVisible('#cx-console [data-rive-status]')).toBe(true);
      expect(await text(page, '#cx-console [data-rive-status]')).toBe('idle');
      await page.waitForFunction(() => ['drawn', 'words'].includes(document.querySelector('#cx-empty .cx-way-twin')?.getAttribute('data-rive') ?? ''), null, { timeout: 15_000 });
      // H168's R65: with the band OPEN the welcome is drawn compact and WHOLE — the mark, the question, the line and the three
      // starters inside the conversation's own scroll box (not cut at its bottom edge) and inside the viewport, no scrolling
      await page.evaluate(() => document.fonts.ready);
      const whole = await page.evaluate(() => {
        const sb = document.getElementById('cx-scroll')!.getBoundingClientRect();
        const parts = ['#cx-empty .cx-welcome-mark', '#cx-empty .cx-welcome-start', ...['plan', 'image', 'workflow'].map((id) => `#cx-empty [data-cx-start="${id}"]`)];
        return { open: document.body.classList.contains('console-open'), scroll: { top: Math.round(sb.top), bottom: Math.round(sb.bottom) }, parts: parts.map((sel) => { const e = document.querySelector(sel)!; const r = e.getBoundingClientRect(); return { sel, top: Math.round(r.top), bottom: Math.round(r.bottom), inside: r.top >= sb.top - 1 && r.bottom <= sb.bottom + 1 && r.bottom <= window.innerHeight, cut: e.scrollHeight > e.clientHeight + 1 }; }) };
      });
      expect(whole.open).toBe(true);
      expect(whole.parts.every((p) => p.inside && !p.cut), `the welcome whole above the open band: ${JSON.stringify(whole)}`).toBe(true);
      const starter = await page.$eval('#cx-empty .cx-way-twin', (t) => ({ rive: t.getAttribute('data-rive'), start: t.getAttribute('data-cx-start'), cardHidden: (t.querySelector('.cx-way') as HTMLElement | null)?.hidden ?? null, face: t.querySelector('.cx-rive-host button.tr-face')?.getAttribute('aria-label') ?? null, words: t.querySelector('.cx-rive-host .cx-twin-words')?.textContent ?? null }));
      expect(starter.start).toBe('plan');
      if (starter.rive === 'drawn') expect(starter).toMatchObject({ cardHidden: true, face: 'Plan a project', words: 'Turn an idea into the next step.' });
      else expect(starter).toMatchObject({ cardHidden: false, face: null });
      // the toggle again: the one row — the face at ≤ 48 px, the word still read
      await page.click('#cx-console-toggle');
      expect(await page.getAttribute('#cx-console-toggle', 'aria-expanded')).toBe('false');
      expect((await faceOf()).h).toBeLessThanOrEqual(48);
      expect(await text(page, '#cx-console [data-rive-status]')).toBe('idle');
      await page.focus('#cx-input');
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-change');
      // (H172's GATE 38 observation) + New conversation on an EMPTY project: the welcome stays, its three starters as they were, the
      // primary one the same native button (mounted once: the action handles are as many as before)
      const actionsBefore = await page.evaluate(() => (window as unknown as { TimmyRive: { inspect(): Array<{ component: string }> } }).TimmyRive.inspect().filter((x) => x.component === 'action').length);
      await page.click('#rail-new-conv');
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 10_000 });
      expect(await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent]))).toEqual([['plan', 'Plan a project'], ['image', 'Inspect an image'], ['workflow', 'Build a workflow']]);
      expect(await page.$eval('#cx-empty .cx-way-twin', (t) => t.getAttribute('data-rive'))).toBe(starter.rive);
      expect(await page.evaluate(() => (window as unknown as { TimmyRive: { inspect(): Array<{ component: string }> } }).TimmyRive.inspect().filter((x) => x.component === 'action').length)).toBe(actionsBefore);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
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
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundImage)).toContain('linear-gradient'); // (B11: the primary's material, the family gradient; never green)
      // the bottom row
      expect(await texts(page, '#cx-controls .cx-ctl')).toEqual(['▱ Plan / Run', '◇ Permissions', '$ Budget', '≡ Logs', '? Keys', '⌁ Cloudflare optional']); // (round 7: Keys on the row; the top row's went with the shell)
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

  it('without a route: "No model connected. Choose one when you’re ready." with the quiet "Choose a model" (the head\'s primary\'s text twin) into Models, Send off, NEXT TURN says no model', async () => {
    const { context, page, errors } = await land(noRoute, { width: 1440, height: 900 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      await page.waitForFunction(() => (document.getElementById('cx-route-words')?.textContent ?? '').startsWith('No model connected'), null, { timeout: 30_000 });
      expect(await text(page, '#cx-route-words')).toBe('No model connected. Choose one when you’re ready.');
      // (R78, H168's pass 1: one step with one verb — the head's "Choose a model" is the primary, this line's control its quiet
      // text twin into Models; the solid "Set up a model →" chip to the connections screen is gone)
      expect(await text(page, '#cx-change')).toBe('Choose a model');
      expect(await page.getAttribute('#cx-change', 'data-shell-go')).toBeNull();
      expect(await page.$eval('#cx-change', (b) => ({ setup: b.classList.contains('is-setup'), bg: getComputedStyle(b).backgroundColor }))).toEqual({ setup: false, bg: 'rgba(0, 0, 0, 0)' });
      expect(await text(page, '#ws-chat > .page-head .page-primary .ui-primary span:first-child')).toBe('Choose a model');
      await page.fill('#cx-input', 'anything');
      expect(await page.isDisabled('#cx-send')).toBe(true);
      expect(await text(page, '#cx-next-turn-model')).toBe('No model selected');
      expect(await text(page, '#cx-next-turn-words')).toBe('Choose a connected model before sending.');
      await page.click('#cx-change');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cm-search');
      expect(await page.evaluate(() => document.body.dataset.screen)).not.toBe('connections');
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
      ({ context, page, errors } = await openPage(browser, { origin: urlOf(withRoute) }, { width: 1440, height: 900 }, kept));
      // R11 round 5 (the reopen's race, seen once as a 60 s wait for the project's name): companion.js opens the socket as it
      // loads, before chat-shell.js is fetched; the socket's welcome can arrive in between, and only companion.js hears it.
      // Here chat-shell.js is held back 1.5 s so the welcome ALWAYS comes first: the shell must still name the project (the
      // frame it reads as soon as the socket is up, then the project companion.js already took), restore the draft by project
      // and read the conversation — without waiting for a hello that was answered before it loaded
      let welcomeAt = 0;
      let shellAt = 0;
      page.on('websocket', (ws) => ws.on('framereceived', (f) => { if (!welcomeAt && /"type":"welcome"/.test(String(f.payload))) welcomeAt = Date.now(); }));
      await page.route('**/chat-shell.js', async (route) => { await new Promise((r) => setTimeout(r, 1500)); shellAt = Date.now(); await route.continue(); });
      await page.goto(`${urlOf(withRoute)}/#t=${tokenOf(withRoute)}`);
      await page.waitForFunction(() => Boolean(document.body.dataset.screen), null, { timeout: 30_000 });
      // no identity provider: the landing rule opens the workspace (a remembered screen counts only when signed in)
      expect(await page.evaluate(() => document.body.dataset.screen)).toBe('chat');
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'fresh', null, { timeout: 15_000 });
      expect(welcomeAt).toBeGreaterThan(0);
      expect(shellAt).toBeGreaterThan(0);
      expect(welcomeAt).toBeLessThan(shellAt); // (the race as staged: the welcome before the shell's script was served)
      // the shell's own project (not only the rail's words): the welcome companion.js took is the shell's project too
      // (`cx` is a top-level const of chat-shell.js: a global lexical binding, reached by its name)
      // @ts-expect-error -- declared by the page's classic script
      expect(await page.evaluate(() => (cx as { project: { name: string; id: string } | null }).project)).toMatchObject({ name: 'fresh', id: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(await text(page, '.cx-crumb')).toBe('fresh / Chat');
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
      expect(await page.$eval('#cx-turns .cx-turn.is-timmy:last-of-type .cx-ev-row', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())).toMatch(/· receipt [0-9a-f]{8}/);
      expect(await page.inputValue('#cx-input')).toBe('');
      // New conversation puts this page's turns away and clears the draft
      await page.click('#rail-new-conv');
      expect(await page.$$eval('#cx-own .cx-turn', (els) => els.length)).toBe(0);
      // (H172's GATE 38 observation: the turn folded into the project's saved conversation; New conversation asks the companion for
      // a conversation of its own (POST /api/chat/new, H169's) → the welcome on the empty one; without the route the page says
      // what its New conversation is and why no conversation of its own starts here)
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty' || (document.getElementById('cx-note')?.textContent ?? '').startsWith('New conversation on this page:'), null, { timeout: 20_000 });
      const fresh = await page.evaluate(() => document.body.dataset.chatState === 'empty');
      if (fresh) {
        // (H169's POST /api/chat/new answered: the welcome on the conversation of its own, the three starters, the composer's keyboard)
        expect(await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => e.getAttribute('data-cx-start')))).toEqual(['plan', 'image', 'workflow']);
        expect(await page.$$eval('#cx-turns > .cx-turn', (els) => els.length)).toBe(0);
        expect(await text(page, '#cx-note')).toBe('New conversation: the project’s next turn starts a conversation of its own (the saved one is kept in .sessions).');
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
      } else expect(await text(page, '#cx-note')).toContain('the project’s saved conversation (2 messages) stays and the next turn continues it');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);

  it('at 390 × 844 the rail folds behind Menu; Connections and Models are the top buttons; the starters stack; nothing overflows sideways', async () => {
    // (a project of its own with no conversation, so the welcome shows; withRoute's project holds the turn sent above)
    const { context, page, errors } = await land(phone, { width: 390, height: 844 });
    try {
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('chat'));
      await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
      // (R11 round 7, SHELL CONTRACT v1 §4: the rail is a top strip with Menu (#shell-menu) over a closed sheet; Models & accounts is
      // in the sheet; the Models context opens from the head's "Models" button; the Chat's own top row is the shell's now)
      expect(await page.$eval('#rail-sheet', (e) => getComputedStyle(e).display)).toBe('none');
      expect(await page.isVisible('#shell-menu')).toBe(true);
      expect(await page.isVisible('#cx-menu')).toBe(false);
      expect(await page.isVisible('#cx-models-toggle')).toBe(false);
      expect(await text(page, '#ws-chat .page-head .page-context-btn')).toContain('Models');
      const tops = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      // R11 round 6 → D13 (H168's R77): on a phone the console band is ONE ROW — its word and the face at ≤ 48 px; a tap opens it,
      // inside the viewport; a tap again folds it to the row
      expect(await page.$eval('#cx-console', (b) => ({ hidden: (b as HTMLElement).hidden, folded: b.classList.contains('is-folded'), expanded: b.querySelector('#cx-console-toggle')?.getAttribute('aria-expanded'), word: b.querySelector('[data-rive-status]')?.textContent?.trim() }))).toEqual({ hidden: false, folded: true, expanded: 'false', word: 'idle' });
      expect(await page.$eval('#cx-console .tr-face', (e) => Math.round(e.getBoundingClientRect().height))).toBeLessThanOrEqual(48);
      await page.click('#cx-console-toggle');
      expect(await page.getAttribute('#cx-console-toggle', 'aria-expanded')).toBe('true');
      expect(await page.isVisible('#cx-console .tr-face')).toBe(true);
      expect(await page.$eval('#cx-console .tr-face', (e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && r.height > 48; })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.click('#cx-console-toggle');
      expect(await page.$eval('#cx-console .tr-face', (e) => Math.round(e.getBoundingClientRect().height))).toBeLessThanOrEqual(48);
      await page.click('#shell-menu');
      await page.waitForSelector('#rail-sheet:visible', { timeout: 5_000 });
      expect(await texts(page, '#rail-menu .rail-item .rail-label')).toContain('Models & accounts');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('rail-sheet')!).display === 'none', null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('shell-menu');
      // the Models context: a sheet from the bottom, opened by the head's button; its providers; Escape closes it, the focus back
      await page.click('#ws-chat .page-head .page-context-btn');
      await page.waitForSelector('#ws-chat .page-context.is-open', { timeout: 5_000 });
      expect(await texts(page, '#cx-models .cm-provider')).toEqual(['OpenRouter', 'Ollama local', 'Ollama cloud', 'Cloudflare']);
      // (the sheet slides up over --timmy-ui-motion-panel: its rect is read once it has settled inside the viewport)
      await page.waitForFunction(() => { const e = document.querySelector('#ws-chat .page-context'); if (!e) return false; const r = e.getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth + 1; }, null, { timeout: 5_000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#ws-chat .page-context.is-open'), null, { timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.className.includes('page-context-btn'))).toBe(true);
      // R11 round 5 (H172's capture 04 at 390: the connections screen's heading and the head's identity badge were cut at the
      // right edge): the screen's h1 wraps (the page's `h1 { white-space: nowrap }` is the old header's brand rule, lifted for
      // the shell's screens in companion.css), and the badge's words end in an ellipsis inside their border (given long words:
      // the badge here says "No account signed in"; a signed-in page's names the account's id)
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string): void } }).TimmyShell.go('connections'));
      await page.waitForSelector('#screen-connections .page-head .page-title', { timeout: 20_000 });
      const h1 = await page.$eval('#screen-connections .page-head .page-title', (e) => { const r = e.getBoundingClientRect(); return { text: (e.textContent || '').trim(), right: Math.round(r.right), lines: Math.round(r.height / parseFloat(getComputedStyle(e).lineHeight)), whole: r.right <= window.innerWidth && e.scrollWidth <= e.clientWidth + 1 }; });
      // (R11 round 7: H170's title on the scaffold's head — the order's words; the head's h1 wraps whole on a phone)
      expect(h1).toMatchObject({ text: 'One model is enough to begin.', whole: true });
      expect(h1.lines).toBeGreaterThanOrEqual(1); // (the round-6 title wrapped to two lines; the order's shorter one fits as it fits)
      const badge = await page.$('#screen-connections .sh-head-words');
      if (badge) expect(await badge.evaluate((e) => { e.textContent = `Signed in · user_${'x'.repeat(48)}`; const r = e.getBoundingClientRect(); return { inside: r.right <= window.innerWidth, ellipsis: getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth }; })).toEqual({ inside: true, ellipsis: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
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
      // (H173's D16, 68a4a97e: a configured provider that did not answer this page is an explicit blocker — "Sign-in cannot start
      // here yet." with Check the identity setup the one next step; the create-account words come once Clerk has loaded, which this
      // FAKE instance never does — either way the account screen, never a refusal)
      expect(['Sign-in cannot start here yet.', 'Checking the identity setup…', 'Create your Timmy account']).toContain(await text(page, '#screen-account h2'));
      // a user-data route asked before the shell was here (the frame's first read) answered 401 needs:session — once, not a loop
      const sessions = got.filter((g) => g.status === 401);
      // (R11 round 5, the lead's dae84ba5: the journey's and the panels' reads are user-data reads too, under the same principal)
      for (const g of sessions) {
        const path = g.url.replace(/\?.*$/, '');
        if (/^\/api\/(?:journey|panel)\//.test(path)) continue;
        expect(['/api/workspace', '/api/chat/view', '/api/chat/models', '/api/chat/route', '/api/connections', '/api/rive/assets']).toContain(path);
      }
      expect(sessions.length).toBeLessThan(12);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, LONG);
});
