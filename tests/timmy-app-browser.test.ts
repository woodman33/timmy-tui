/**
 * R12 (the operator's 03:04 order: "coding the timmy tui into rive and tldraw", and the finish brief): the Timmy app in a real
 * headless Chromium, against the real companion on 127.0.0.1, read and used as a person does — Timmy's shell (the rail, the
 * page head, the band, the tools row), the permission before the local Ollama is asked, a model chosen, a real turn sent and
 * sealed, NEEDS YOU on the Rive ActionButton, Stop, the Canvas desk (Rive shapes, Timmy cards, the SDK's licence, a node added,
 * undone and kept in the project's own storage — back in a fresh browser, never over a newer desk), and the phone's drawer and composer.
 *
 * Real: the companion, its token, the app's bundle (scripts/canvas/build-app.mjs, built here when it is missing), the Chat's
 * routes and the agent's turn (POST /api/chat/turn), the receipt it seals. FAKE, labelled: the local Ollama
 * (tests/fixtures/fake-ollama-chat.ts: no model behind it, its answer says FAKE).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../scripts/canvas/build-app.mjs';
import { DESK_FOLDER, appRoot } from '../src/companion/timmy-app.js';
import { projectId } from '../src/project/index.js';
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
        // the Canvas: the request of the desk's native ActionButton, sent as a real turn
        () => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE desk answer: ', 'sent from the canvas.']), delayMs: 300 }),
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
    // the WORKSPACES pages sit behind the rail's disclosure (the 07:37 pass): open it first when it is closed
    if (await page.locator(`.ta-rail-more:not([open]) .ta-rail-item[data-nav="${id}"]`).count()) await page.click('.ta-rail-more > summary');
    await page.click(`.ta-rail-item[data-nav="${id}"]`);
    await page.waitForSelector(`.ta-page[data-page="${id}"]`, { timeout: 30_000 });
  };
  const chat = '.ta-chat[data-card="chat"]';

  it('opens on the Chat in Timmy\'s shell: the rail\'s groups, the page head, the band, one composer; the token out of the address', async () => {
    const before = ollama.requests.length;
    const page = await open(1440, 900);
    await page.waitForSelector('.ta-page[data-page="chat"] .ta-title', { timeout: 60_000 });
    expect(page.url()).toBe(`${origin}/app`);
    // the 07:37 pass on the operator's 07:57 word: APPS (image, video, 3D, 2D animation), AGENTS, TOOLS on the rail, six more
    // pages behind the WORKSPACES disclosure (closed while none of them is shown), Runs/Settings/Help at the foot: 20 pages
    expect(await page.locator('.ta-rail-label').allInnerTexts()).toEqual(['APPS', 'AGENTS', 'TOOLS', 'WORKSPACES']);
    expect(await page.locator('.ta-rail-item').count()).toBe(20);
    expect(await page.locator('.ta-rail-item:visible').count()).toBe(14);
    expect(await page.locator('.ta-rail-apps .ta-rail-title').allInnerTexts()).toEqual(['Image · Card Lab', 'Video · Film Room', '3D · Model Studio', '2D Animation · Stream Studio']);
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
    // Stop pressed at once, before the companion has named the turn: it is asked when the turn's id arrives, not lost
    await page.click(`${chat} button:has-text("Stop")`, { timeout: 30_000 });
    await page.waitForFunction(() => ['stopping', 'stopped'].includes(document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') ?? ''), null, { timeout: 30_000 });
    await page.waitForSelector(`${chat} button:has-text("Send")`, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.ta-face-console .tr-component')?.getAttribute('data-state') === 'stopped', null, { timeout: 30_000 });
    await page.context().close();
  }, 180_000);

  it('the Canvas: a bounded desk with Timmy\'s Rive shapes and cards, the SDK\'s licence read; a node added, undone, kept in the project and opened in a fresh browser', async () => {
    const page = await open(1440, 900);
    await go(page, 'canvas');
    await page.waitForSelector('.ta-stage .tl-container .ta-desk', { timeout: 60_000 });
    // the first desk: the three native Rive components (ActionButton, ProviderCard, AgentConsole) and the receipt card, joined by
    // three arrows bound to them
    await page.waitForFunction(() => document.querySelectorAll('.tr-shape .tr-component[data-artboard]').length >= 3, null, { timeout: 30_000 });
    expect(await page.locator('.ta-desk-card').count()).toBeGreaterThanOrEqual(1);
    for (const a of ['ActionButton', 'ProviderCard', 'AgentConsole']) expect(await page.locator(`.tr-shape .tr-component[data-artboard="${a}"]`).count(), a).toBe(1);
    // a saved Rive shape never claims to be live before an event of this page moved it
    expect(await page.locator('.tr-shape-source').first().innerText()).toContain('as saved');
    // the licence as the SDK's own manager says it (no key in this test: unlicensed on a development address)
    await page.waitForSelector('.ta-license[data-license]:not([data-license="unread"])', { timeout: 30_000 });
    expect(await page.locator('.ta-footer').innerText()).toContain('Canvas licence:');
    // the desk's native ActionButton does what it shows: a person's click sends its request as a real turn of the project; the
    // AgentConsole on the desk follows the turn's own events (working, then idle) and the receipt card shows the new receipt
    const chatsBefore = ollama.chats().length;
    await page.click('.tr-shape-welcome button.tr-face');
    await page.waitForFunction(() => document.querySelector('.tr-shape-activity')?.getAttribute('data-state') === 'working', null, { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('.tr-shape-activity')?.getAttribute('data-state') === 'idle', null, { timeout: 60_000 });
    expect(await page.locator('.tr-shape-activity .tr-shape-source').innerText()).toContain('POST /api/chat/turn');
    expect(ollama.chats().length).toBeGreaterThan(chatsBefore);
    await page.waitForFunction(() => (document.querySelector('.ta-turnpanel')?.textContent ?? '').includes('receipt'), null, { timeout: 30_000 });
    await page.waitForSelector('.ta-desk-card[data-desk-card="receipt"] .ta-verified', { timeout: 30_000 });
    // the inspector is a layer on the stage: folded by default, opened, dragged by its header (kept where it was left)
    expect(await page.locator('.ta-layer').getAttribute('class')).toContain('is-folded');
    await page.click('.ta-layer-fold');
    await page.waitForFunction(() => !document.querySelector('.ta-layer')?.classList.contains('is-folded'));
    const head = await page.locator('.ta-layer-head').boundingBox();
    await page.mouse.move(head!.x + 40, head!.y + head!.height / 2);
    await page.mouse.down();
    await page.mouse.move(head!.x - 160, head!.y + 120, { steps: 8 });
    await page.mouse.up();
    const moved = await page.locator('.ta-layer').boundingBox();
    expect(Math.round(moved!.x)).toBeLessThan(Math.round(head!.x) - 100);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('timmy-app:canvas-layer') || '{}').folded)).toBe(false);
    const count = async (): Promise<number> => page.evaluate(() => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1));
    const n0 = await count();
    expect(n0).toBeGreaterThanOrEqual(4);
    await page.click('.ta-tool[data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="card:conversation"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0);
    expect(await page.locator('.ta-inspect-title').innerText()).toContain('This conversation');
    await page.click('.ta-tool[data-tool="Undo"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n, n0);
    await page.click('.ta-tool[data-tool="Nodes"]');
    await page.click('.ta-popover-item[data-node="card:receipt"]');
    await page.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0);
    // kept in Timmy's project storage, not the browser: saved at a revision as the person works
    const file = join(process.env.TIMMY_HOME!, 'canvas', 'projects', projectId(join(box, 'project')), DESK_FOLDER, 'canvas.json');
    const shapesIn = (): number => { try { return Object.values((JSON.parse(readFileSync(file, 'utf8')) as { snapshot: { store: Record<string, { typeName?: string }> } }).snapshot.store).filter((r) => r.typeName === 'shape').length; } catch { return -1; } };
    await expect.poll(shapesIn, { timeout: 20_000 }).toBe(n0 + 1);
    await page.waitForSelector('[data-kept="saved"]', { timeout: 20_000 });
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { format: string; revision: number; snapshot: { store: Record<string, { typeName?: string; type?: string; props?: { kind?: string } }> } };
    expect(saved.format).toBe('timmy-canvas');
    expect(saved.revision).toBeGreaterThanOrEqual(2);
    expect(Object.values(saved.snapshot.store).filter((r) => r.typeName === 'shape').length).toBe(n0 + 1);
    await page.context().close();
    // opened again from Timmy in ANOTHER browser context (nothing of the first one's storage): the page it was on is not
    // remembered there, so it goes to the Canvas; the desk is the project's, as left
    const again = await open(1440, 900);
    await go(again, 'canvas');
    await again.waitForSelector('.ta-page[data-page="canvas"] .ta-stage .tl-container .ta-desk', { timeout: 60_000 });
    await again.waitForFunction((n) => Number(/(\d+) shape/.exec(document.querySelector('.ta-toolsrow-note')?.textContent ?? '')?.[1] ?? -1) === n + 1, n0, { timeout: 30_000 });
    // opening it wrote nothing: the desk on disk is the one left, at the same revision (no viewer's record is the project's)
    await again.waitForTimeout(2000);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { revision: number }).revision).toBe(saved.revision);
    expect(Object.values((JSON.parse(readFileSync(file, 'utf8')) as typeof saved).snapshot.store).some((r) => r.typeName === 'user')).toBe(false);
    expect(await again.locator('[data-kept]').innerText()).toContain(`revision ${saved.revision}`);
    // the console was saved as the turn left it (idle), never as it was while the turn ran
    expect(await again.locator('.tr-shape-activity').getAttribute('data-state')).toBe('idle');
    // a save over a newer desk is refused, and its version kept beside it (two windows on one project)
    const stale = await fetch(`${origin}/api/app/desk`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: saved.snapshot, baseRevision: 1, revision: 2 }) });
    expect(stale.status).toBe(409);
    const refused = await stale.json() as { conflict?: boolean; kept?: string };
    expect(refused.conflict).toBe(true);
    expect(refused.kept).toMatch(/^copies\/canvas-r2-/);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { revision: number }).revision).toBe(saved.revision);
    const page2 = again;
    expect(await page2.locator('.ta-footer-btn:has-text("Export canvas")').isDisabled()).toBe(false);
    await page2.context().close();
  }, 180_000);

  it('a phone\'s width: the rail is a drawer, the pages one column, the composer in view, nothing wider than the screen', async () => {
    const page = await open(390, 844);
    await page.waitForSelector('.ta-page[data-page="chat"]', { timeout: 60_000 });
    expect(await page.locator('.ta-rail').evaluate((el) => el.getBoundingClientRect().right <= 0)).toBe(true);
    const box = await page.locator('.ta-composer').boundingBox();
    expect(box && box.y + box.height <= 844).toBe(true);
    // closed, the drawer is out of the tab order; Escape closes it when it is open
    expect(await page.locator('.ta-rail').getAttribute('inert')).not.toBeNull();
    await page.click('.ta-menu');
    await page.waitForSelector('.ta-rail.is-open');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ta-rail.is-open'));
    // every page: nothing wider than the screen inside the page's own scroller
    for (const id of ['chat', 'models', 'canvas', 'files', 'workflows', 'runs', 'voxvision', 'motion', 'tools', 'mcp-cli', 'timmy-mcp', 'openhands', 'control', 'help', 'settings']) {
      await go(page, id);
      await page.waitForTimeout(400);
      const over = await page.evaluate(() => { const w = document.querySelector('.ta-pagewrap')!; return Math.max(w.scrollWidth - w.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth); });
      expect(over, `${id} is wider than the screen`).toBeLessThanOrEqual(0);
    }
    await page.context().close();
  }, 120_000);

  // the operator's 18:39 screenshot: in a short window the Canvas stage ran over its tools row (the fill page's body shrank
  // below the stage's own minimum and the stage overflowed). The stage and the Chat now end above their tools row at any height.
  it('a short window: the Canvas stage and the Chat never run over their tools row; at 1440 × 900 nothing scrolls', async () => {
    for (const [w, h] of [[1440, 900], [1280, 720], [1100, 640]] as const) {
      const page = await open(w, h);
      for (const id of ['canvas', 'chat']) {
        await go(page, id);
        if (id === 'canvas') await page.waitForSelector('.ta-stage .tl-container', { timeout: 60_000 });
        await page.waitForTimeout(600);
        const r = await page.evaluate((id) => {
          const a = document.querySelector(id === 'canvas' ? '.ta-stage' : '.ta-work')!.getBoundingClientRect();
          const t = document.querySelector('.ta-toolsrow')!.getBoundingClientRect();
          const main = document.querySelector('.ta-pagewrap')!.getBoundingClientRect();
          const wrap = document.querySelector('.ta-pagewrap')!;
          return { over: a.bottom - t.top, inside: t.top >= a.top && t.bottom <= a.bottom && t.left >= a.left && t.right <= a.right, share: (a.width * a.height) / (main.width * main.height), scrolls: wrap.scrollHeight > wrap.clientHeight + 1 };
        }, id);
        if (id === 'canvas') {
          // the operator's 19:19 order: the Canvas is the page — the stage takes most of it, its tools float inside it
          expect(r.inside, `the Canvas tools at ${w} × ${h} are inside the stage`).toBe(true);
          expect(r.share, `the stage's share of the page at ${w} × ${h}`).toBeGreaterThan(0.8);
        } else expect(r.over, `${id} at ${w} × ${h}: its stage ends ${r.over} px below the tools row's top`).toBeLessThanOrEqual(0);
        if (w === 1440) expect(r.scrolls, `${id} at 1440 × 900 scrolls`).toBe(false);
      }
      await page.context().close();
    }
  }, 180_000);

  // the operator's 20:38 order: a capability row is "Configured: Yes / No" and one Configure button; ONE aid serves them all
  it('configure: the fleet says Configured Yes or No with one Configure button, and the one aid explains a step or lands on its control', async () => {
    const page = await open(1440, 900);
    await go(page, 'control');
    await page.waitForSelector('.ta-page[data-page="control"] .ta-cfg', { timeout: 60_000 });
    expect(await page.locator('.ta-page[data-page="control"]').innerText()).not.toContain('The three facts');
    const rows = await page.locator('.ta-page[data-page="control"] .ta-cfg').evaluateAll((els) => els.map((e) => ({
      yn: e.getAttribute('data-configured'), word: e.querySelector('.ta-cfg-yn')?.textContent?.trim(), button: e.querySelectorAll('button.ta-cfg-go').length,
    })));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.word).toBe(r.yn === 'yes' ? '✓ Yes' : '○ No');
      expect(r.button).toBe(r.yn === 'yes' ? 0 : 1);
    }
    // a step this page cannot take: the aid unfolds under the button with the step, its native face and Check again
    const no = page.locator('.ta-page[data-page="control"] .ta-cfg[data-configured="no"] .ta-cfg-go').first();
    if (await no.count()) {
      await no.click();
      await page.waitForSelector('.ta-aid-ring');
      await page.waitForSelector('#ta-aid.is-explain', { timeout: 10_000 });
      await page.waitForSelector('#ta-aid .ta-aid-face .tr-component[data-artboard="ActionButton"]', { timeout: 30_000 });
      expect(await page.locator('#ta-aid .ta-aid-words').innerText()).not.toBe('');
      expect(await no.getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#ta-aid'));
    }
    // a step on another page: the aid holds, opens Models & accounts and lands on the exact control, focused
    await go(page, 'tools');
    await page.click('.tx-tools-groups [role="tab"]:has-text("Models")');
    const or = page.locator('.ta-cfg[data-cfg="model:openrouter"]');
    await or.waitFor();
    if ((await or.getAttribute('data-configured')) === 'no') {
      await or.locator('.ta-cfg-go').click();
      await page.waitForSelector('#ta-aid.is-landed', { timeout: 20_000 });
      expect(await page.locator('.ta-page').getAttribute('data-page')).toBe('models');
      // the aid marks the page landed at once and moves the focus once its scroll has run (configure.jsx: 420 ms, at once under
      // reduced motion): wait for the focus, not for a moment (R13: on an idle machine this line read the focus before it moved)
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Sign in with OpenRouter', null, { timeout: 5_000 }).catch(() => undefined);
      expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Sign in with OpenRouter');
      expect(await page.locator('.ta-aid-face').getAttribute('data-aid-state')).toBe('awaiting');
      await page.keyboard.press('Escape');
    }
    await page.context().close();
  }, 120_000);

  it('asked nothing of another host, broke no policy, threw nothing', () => {
    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });
});
