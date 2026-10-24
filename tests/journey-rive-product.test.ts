/**
 * R11 round 6 (H172; the operator's order of 06:32 PT 2026-10-24: "the real native Rive UI into licensed tldraw canvases
 * throughout the working product — not just thumbnails in Inspect"): the native asset (src/companion/assets/rive/timmy-ui/
 * timmy-ui.riv — AgentConsole, ProviderCard, ActionButton; one state machine TimmyUI; State / Hover / Pressed / ReducedMotion)
 * in the PRODUCT, end to end, in a real Chromium at 1440x900 and 390x844:
 *
 *   CHAT (H171's placement on H174's mount API)   the AgentConsole present and DRAWN by the runtime in the chat at a readable size,
 *     its native State following a REAL turn through the real agent (working → 1, idle → 0; Stop → 3), the HTML label aria-live
 *     beside it; the composer's focus order unchanged (Tab from the textarea reaches Send, never trapped by a canvas); the
 *     NEEDS-YOU gate answered through the ActionButton (a real <button>): a FAKE tool that asks (write_project_file → H169's
 *     gate) → the button → a trusted click → POST /api/chat/answer { id, choice } seen → the turn goes on; Enter / Space on the
 *     button answer too; the welcome's starter ActionButton fires the starter; Stop mid-turn → State 3 and the stopped turn
 *     folded with its receipt (H171's dd8b2aa3).
 *   CONNECTIONS (H170's placement)   a ProviderCard in each of the four cards; Check on Ollama · local → the fed event
 *     "GET /api/connections: ollama-local" with State 1 while it ran, State 0 after with the label "connected" (no success pose
 *     is authored: said).
 *   CANVAS (the Studio; the token + session; H174's timmy-rive shape)   the SDK's own license verdict (never a key in the test:
 *     a FAKE key the SDK rejects when the environment has none); the three shapes placed, moved, resized; an arrow BOUND
 *     between two (the binding record persists); saved → reopened in a new page → the shapes, their props and the binding are
 *     back; a project switch → the other project's board has none; reduced motion (emulateMedia) → the asset's own
 *     ReducedMotion input true and the pose settles.
 *   390x844   the console folds to its label and opens on a tap; nothing overflows the viewport; no page error anywhere.
 *   INSTALLED   the companion and the Studio both serve GET /assets/rive/timmy-ui/timmy-ui.riv (200, 405,278 bytes, the sha256).
 *
 * FAKE here, named: the identity provider (an RSA pair made by the test; its public key is CLERK_JWT_KEY; the session minted by
 * the test, verified by the REAL verifier), the Ollama on 127.0.0.1 (no model: one tool call, then a fixed answer; a gated tool
 * on "write"; a slow answer on "slowly"), the tldraw license key when the environment has none (a string the SDK rejects, so the
 * SDK's own verdict is asserted). REAL: the companion, the Studio, the agent turn and its SSE, the NEEDS YOU gate, the Stop,
 * the receipts, the project storage, the runtime (@rive-app/canvas from this origin) and the asset.
 *
 * Captures (TIMMY_JOURNEY_CAPS) at every step, and two recordings (Playwright recordVideo): the Chat console on a REAL turn with
 * the NEEDS-YOU button and Stop (1440x900), and the Canvas binding an arrow and reopening. Sidecars say REAL / FAKE / PREVIEW.
 *
 * CONTRACT (the owners' lines in HANDOFF.md; the selectors below are the ones this test reads — adjusted to the posted lines):
 *   H174  TimmyRive.mountConsole(host, opts) / mountProviderCard(host, providerId) / mountActionButton(host, { action, label });
 *         a mounted component's root carries data-rive-component="<key>" and data-artboard="<artboard>"; its canvas
 *         canvas[data-timmy-rive="<key>"][data-loaded] once drawn; its label [data-rive-status="<key>"] (aria-live); an
 *         ActionButton's face is a real <button data-rive-face="<key>">.
 *   H171  the console in the chat screen (the key below); the NEEDS-YOU answer = a mounted ActionButton per option inside the
 *         turn's .cx-needs group (data-cx-answer="<choice>"); the welcome's starter ActionButton (data-cx-start="<id>").
 *   H170  a ProviderCard inside each [data-provider="<id>"] card; TimmyRive.fromProviderState(id, state) per state change with
 *         the source "GET /api/connections: <id>".
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Video } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';
import { capturer } from './fixtures/journey-caps.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

// ── the contract's selectors (one place to adjust) ──────────────────────────────
const SEL = {
  /** the chat screen's console (H171's placement of H174's mountConsole): its root, by the component key it mounts */
  console: '#screen-chat [data-rive-component="activity"], [data-screen="chat"] [data-rive-component="activity"], [data-rive-component="console"]',
  consoleKey: 'activity',
  /** the NEEDS-YOU answer buttons (ActionButtons, real <button>s) inside the turn's group */
  needsGroup: '.cx-needs',
  answerButton: (choice: string): string => `.cx-needs button[data-cx-answer="${choice}"]`,
  /** the welcome's starter buttons (ActionButtons) */
  starter: 'button[data-cx-start]',
  /** a provider card and the ProviderCard mounted in it */
  card: (id: string): string => `[data-provider="${id}"]`,
  cardComponent: (id: string): string => `[data-provider="${id}"] [data-rive-component]`,
  /** the console's fold on a phone (H171's call: a control that opens the console from its label) */
  consoleFold: '[data-rive-fold], [data-console-fold], .cx-console-fold',
};
const PROVIDERS = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];
const NATIVE = { name: 'timmy-ui.riv', bytes: 405_278, sha256: '9fd9ae7c098187df4646f0ed581e6c7019173903078ac419ad7765ac7a1beac6', artboards: ['AgentConsole', 'ProviderCard', 'ActionButton'], stateMachine: 'TimmyUI', inputs: ['State', 'Hover', 'Pressed', 'ReducedMotion'] };
const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

const caps = capturer('tests/journey-rive-product.test.ts', [
  'REAL: the companion and the Studio (started in this process), their launch tokens and pages, the identity verifier (RS256 against CLERK_JWT_KEY), the agent turn (openChatSession → runTurn) and its SSE, the NEEDS YOU gate (write_project_file), the Stop route, the sealed receipts, the project storage (the board under the project), @rive-app/canvas served from this origin, the operator\'s timmy-ui.riv (AgentConsole, ProviderCard, ActionButton; TimmyUI).',
  'FAKE: the identity provider (an RSA pair made by the test; the session minted by the test), the Ollama on 127.0.0.1 (no model behind it: one tool call then a fixed answer; the gated write on "write"; the slow answer on "slowly"), the tldraw license key when the environment has none (a string the SDK rejects).',
  'What animates: the native Rive artboards drawn by the runtime, each state the native State input the binding set from a backend event; the HTML word beside it says the same. PREVIEW is only ever in the Inspect view, not here.',
]);

const PORT = 4500;
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'c6'.repeat(32);
const USER = fakeUserId('product');
const MODEL = 'fake-qwen3:8b';
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
const FAKE_WRITTEN = 'FAKE answer: the note was written (no model behind this).';
const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p as string));
if (!browserPath) console.warn('journey-rive-product: no Chromium found, so the browser legs are skipped here (said, not passed)');

let box = '';
let timmyHome = '';
let identity: FakeIdentity;
let ollama: FakeOllamaJourney;
let browser: Browser;
let companion: CompanionServer;
let studio: StudioServer | undefined;
let studioBase = '';
let studioRoot = '';
let studioHome = '';
let projectA = '';
let projectB = '';
/** whether the Studio's license key is the environment's (never read by this test beyond its presence) or this test's FAKE one */
let realKey = false;
const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_MCP_HOME', 'TIMMY_STORE', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL', 'TIMMY_REPO'];

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  box = mkdtempSync(join(tmpdir(), 'journey-rive-product-'));
  timmyHome = join(box, 'home', 'timmy');
  mkdirSync(timmyHome, { recursive: true });
  ollama = await startFakeOllamaJourney({
    models: [{ name: MODEL, size: 4_900_000_000, family: 'qwen3', parameterSize: '8B' }],
    tool: { name: 'get_current_time', arguments: {} },
    answer: FAKE_ANSWER,
    slow: { when: /slowly/i, words: 'FAKE slow answer one word at a time so that Stop can end it before it is done'.split(' '), slowMs: 700 },
    asks: { when: /write/i, tool: { name: 'write_project_file', arguments: { path: 'notes.md', content: 'from the FAKE model\n' } }, answer: FAKE_WRITTEN },
  });
  identity = fakeIdentityProvider({ azp: `http://127.0.0.1:${PORT}` });
  const userHome = join(timmyHome, 'users', USER);
  mkdirSync(userHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(userHome, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }), { mode: 0o600 });
  const env = identity.env({ ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: '', OLLAMA_HOST: ollama.url });
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete env[k];
  Object.assign(process.env, env);
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete process.env[k];
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  companion = await startCompanionServer(PORT, { token: TOKEN, chatEnv: env, workspace: { env, shareMs: 0 } });
  // the Studio (Timmy Canvas): the real server and the real bundle built here; the license key from the environment when it has
  // one (the lead's / CI's; never read here), else a FAKE string the SDK rejects — the SDK's own verdict is what is asserted
  studioRoot = mkdtempSync(join(tmpdir(), 'journey-rive-product-studio-'));
  studioHome = mkdtempSync(join(tmpdir(), 'journey-rive-product-home-'));
  copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(studioRoot, 'index.html'));
  const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
  await buildCanvas(repo, join(studioRoot, 'dist'), { licenses: studioRoot });
  realKey = Boolean(process.env.TLDRAW_LICENSE_KEY?.trim());
  const studioEnv: Record<string, string | undefined> = { TIMMY_HOME: studioHome, HOME: studioHome, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TLDRAW_LICENSE_KEY: realKey ? process.env.TLDRAW_LICENSE_KEY : 'FAKE-license-key-the-sdk-rejects-H172' };
  studio = await startStudioServer(0, { env: studioEnv, root: studioRoot });
  studioBase = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
  projectA = join(studioHome, 'project-a');
  projectB = join(studioHome, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  await nameProject((studio.address() as AddressInfo).port, studio.projectToken, { root: projectA, name: 'rive-product-a' });
}, 240_000);

afterAll(async () => {
  await companion?.shutdown();
  await new Promise<void>((done) => (studio ? studio.close(() => done()) : done()));
  await browser?.close();
  await ollama?.close();
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  for (const d of [box, studioRoot, studioHome]) if (d) rmSync(d, { recursive: true, force: true });
}, 30_000);

// ── the companion page ────────────────────────────────────────────────────────

interface Opened { page: Page; context: BrowserContext; errors: string[]; missing: string[]; left: string[]; close: () => Promise<void> }

function watch(page: Page, o: { errors: string[]; missing: string[]; left: string[] }): void {
  page.on('pageerror', (e) => o.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!/Failed to load resource/.test(t)) { o.errors.push(t); return; }
    if (/ 401 /.test(t)) return; // the page's own first reads before a session, by design
    if (/ERR_NAME_NOT_RESOLVED/.test(t) && /clerk\.accounts\.invalid/.test(m.location().url)) return; // Clerk's fetches to the FAKE instance
    o.missing.push(`${t} — ${m.location().url}`);
  });
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.protocol === 'blob:' || u.protocol === 'data:') return; if (u.hostname !== '127.0.0.1' && !/clerk\.accounts\.invalid$/.test(u.hostname)) o.left.push(r.url()); } catch { /* data: */ } });
}

/** The recordings' folder (the captures' folder when set); a context records when `record` names the recording. */
function recordingOf(record?: string): { recordVideo: { dir: string; size: { width: number; height: number } } } | Record<string, never> {
  if (!caps.folder || !record) return {};
  const dir = join(caps.folder, 'recording-tmp');
  mkdirSync(dir, { recursive: true });
  return { recordVideo: { dir, size: { width: 1440, height: 900 } } };
}
/** Moves a finished recording (the Video taken from the page before its context closed) to its name beside a sidecar; said in the sidecar when none came. */
async function keepRecording(v: Video | null, name: string, words: string[]): Promise<void> {
  if (!caps.folder) return;
  const base = join(caps.folder, name);
  try {
    const p = v ? await v.path() : '';
    if (p && existsSync(p)) renameSync(p, `${base}.webm`);
    writeFileSync(`${base}.txt`, [`${name} · a Playwright recording of the companion page in headless Chromium (recordVideo), scripted test run, not a person.`, ...words, ''].join('\n'));
  } catch (e) { try { writeFileSync(`${base}.failed.txt`, `the recording ${name} did not complete: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing to say it with */ } }
}

async function open(size: { width: number; height: number }, o: { reducedMotion?: boolean; record?: string } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}), ...recordingOf(o.record) });
  const page = await context.newPage();
  const errors: string[] = [];
  const missing: string[] = [];
  const left: string[] = [];
  watch(page, { errors, missing, left });
  await page.goto(companion.url);
  await page.waitForFunction(() => Boolean((window as unknown as { TimmyShell?: { identity?: () => unknown } }).TimmyShell?.identity?.()), null, { timeout: 15_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const ok = await page.evaluate(async (t) => {
    const w = window as unknown as { timmyAccount?: { useSession?: (token: string) => Promise<unknown> } };
    if (!w.timmyAccount?.useSession) return 'absent';
    await w.timmyAccount.useSession(t);
    return 'ok';
  }, identity.token(USER)).catch((e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`);
  expect(ok, 'the page\'s session seam (window.timmyAccount.useSession)').toBe('ok');
  return { page, context, errors, missing, left, close: async () => { await context.close(); } };
}

const text = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);
async function until(page: Page, what: string, test: (t: string) => boolean, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  for (;;) {
    last = await text(page);
    if (test(last)) return last;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}; the page read:\n${last.slice(0, 2500)}`);
    await page.waitForTimeout(100);
  }
}

/** What TimmyRive.inspect() reports of one component: state, contract, the runtime's names and live input values, the events with the native input each set. */
interface Handle { component?: string; id: string; state: string; why?: string; contract: string | null; nativeReduced: boolean; artboard?: string | null; runtime: { artboardNames: string[]; stateMachineNames: string[]; inputs: Array<{ name: string; type: string; value: unknown }> } | null; events: Array<{ input: string; value: unknown; source: string; did: string; native: { input: string; value: unknown; note?: string } | null }> }
const handles = (page: Page): Promise<Handle[]> => page.evaluate(() => { const R = (window as unknown as { TimmyRive?: { inspect?: () => Handle[] } }).TimmyRive; return R?.inspect?.() ?? []; });
const handleOf = async (page: Page, key: string): Promise<Handle | null> => (await handles(page)).find((x) => x.component === key) ?? null;
const inputValue = async (page: Page, key: string, name: string): Promise<unknown> => (await handleOf(page, key))?.runtime?.inputs.find((i) => i.name === name)?.value ?? null;
/** Waits for one component's live input to read `value`. */
async function inputIs(page: Page, key: string, name: string, value: unknown, ms = 15_000): Promise<unknown> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    last = await inputValue(page, key, name);
    if (last === value) return last;
    if (Date.now() > end) { const h = await handleOf(page, key); throw new Error(`${key}'s ${name} did not read ${JSON.stringify(value)} within ${ms} ms: it reads ${JSON.stringify(last)}; state ${h?.state ?? '(no handle)'}${h?.why ? ` (${h.why})` : ''}; events: ${(h?.events ?? []).map((e) => `${e.input}=${JSON.stringify(e.value)}→${e.native ? `${e.native.input} ${JSON.stringify(e.native.value)}` : '—'} · ${e.source}`).join(' | ')}`); }
    await page.waitForTimeout(100);
  }
}
/** The newest event of `input = word` on a component: its native input and value, and its source. */
async function eventOf(page: Page, key: string, input: string, word: unknown): Promise<{ native: string; source: string; did: string } | null> {
  const h = await handleOf(page, key);
  const e = [...(h?.events ?? [])].reverse().find((x) => x.input === input && x.value === word);
  return e ? { native: e.native ? `${e.native.input} ${JSON.stringify(e.native.value)}` : '(HTML only)', source: e.source, did: e.did } : null;
}
const label = (page: Page, key: string): Promise<string> => page.locator(`[data-rive-status="${key}"]`).first().innerText().then((t) => t.trim());

/** The focus order from the composer: each Tab's active element, until Send or `max` tabs. Never a canvas. */
async function tabOrder(page: Page, max = 8): Promise<string[]> {
  const composer = page.getByRole('textbox', { name: /Message Timmy/i }).or(page.getByPlaceholder(/Message Timmy/i)).first();
  await composer.focus();
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${a.getAttribute('data-rive-face') ? `[rive-face=${a.getAttribute('data-rive-face')}]` : ''} "${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30)}"` : 'none'; });
    seen.push(d);
    if (/^button[^"]*"Send/i.test(d)) break;
  }
  return seen;
}

/** The chat screen with the FAKE model chosen for the next turn (H171's panel), as a person does it. */
async function toChat(o: Opened, size: { width: number; height: number }, capPrefix: string): Promise<Locator> {
  await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s));
  await o.page.getByRole('button', { name: /Continue to the workspace|Explore without a model/ }).first().click();
  await until(o.page, 'the chat', (s) => /Message Timmy/i.test(s));
  await caps.cap(o.page, size, `${capPrefix}chat-welcome-console`, ['The chat screen on landing: the welcome, the composer, the AgentConsole mounted in the chat (idle, State 0) — REAL runtime, the operator\'s artboard.']);
  await o.page.getByRole('tab', { name: 'Ollama local' }).first().click();
  await until(o.page, 'the FAKE model in the list', (s) => s.includes(MODEL), 20_000);
  await o.page.locator('#cm-list').getByText(MODEL, { exact: false }).first().click();
  const use = o.page.getByRole('button', { name: /Use for the next turn/ }).first();
  await use.click({ timeout: 10_000 }).catch(async () => { const li = o.page.locator('#cm-list li', { hasText: MODEL }).first(); await li.focus(); await li.press('Enter'); });
  await until(o.page, 'the model chosen', (s) => /Next turn: fake-qwen3:8b|fake-qwen3:8b[^\n]*(ready|this computer)/.test(s), 20_000);
  return o.page.getByRole('textbox', { name: /Message Timmy/i }).or(o.page.getByPlaceholder(/Message Timmy/i));
}

// ── the leg ───────────────────────────────────────────────────────────────────

describe('the native Rive UI in the product: Chat, Connections, Canvas — a FAKE identity provider\'s RS256 session verified by the real verifier, a FAKE Ollama on 127.0.0.1, the REAL runtime and the operator\'s timmy-ui.riv (R11 round 6, H172)', { timeout: 300_000 }, () => {
  it('INSTALLED: the companion and the Studio both serve the asset by exact name (200, 405,278 bytes, the sha256), and the listing names it with its contract', async () => {
    const { createHash } = await import('node:crypto');
    const fromCompanion = await fetch(new URL('/assets/rive/timmy-ui/timmy-ui.riv', companion.address), { headers: { Authorization: `Bearer ${TOKEN}`, [SESSION_HEADER]: identity.token(USER) } });
    expect(fromCompanion.status).toBe(200);
    const bytes = Buffer.from(await fromCompanion.arrayBuffer());
    expect(bytes.length).toBe(NATIVE.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(NATIVE.sha256);
    const fromStudio = await fetch(`${studioBase}/assets/rive/timmy-ui/timmy-ui.riv`);
    expect(fromStudio.status).toBe(200);
    expect(createHash('sha256').update(Buffer.from(await fromStudio.arrayBuffer())).digest('hex')).toBe(NATIVE.sha256);
    const listing = await fetch(new URL('/api/rive/assets', companion.address), { headers: { Authorization: `Bearer ${TOKEN}`, [SESSION_HEADER]: identity.token(USER) } }).then((r) => r.json()) as { runtime: boolean; components: Array<{ component: string; riv: { name: string; bytes: number; sha256: string } | null; meta: { stateMachine?: string; artboards?: string[]; inputs?: string[] } }> };
    expect(listing.runtime, 'the runtime (@rive-app/canvas) served at /vendor/rive/').toBe(true);
    const ui = listing.components.find((c) => c.component === 'timmy-ui')!;
    expect(ui.riv).toEqual({ name: NATIVE.name, bytes: NATIVE.bytes, sha256: NATIVE.sha256.slice(0, 12) });
    expect(ui.meta).toMatchObject({ stateMachine: NATIVE.stateMachine, artboards: NATIVE.artboards, inputs: NATIVE.inputs });
    const policy = (await fetch(new URL('/', companion.address), { headers: { Authorization: `Bearer ${TOKEN}` } })).headers.get('content-security-policy') || '';
    expect(policy, 'the page\'s policy carries the WebAssembly keyword with a file to draw and a runtime to draw it').toContain('wasm-unsafe-eval');
  });

  for (const size of SIZES) {
    const at = `${size.width}x${size.height}`;
    const phone = size.width < 600;

    it.skipIf(!browserPath)(`${at} CHAT: the AgentConsole drawn in the chat at a readable size, its State on a REAL turn (working 1 → idle 0), the label aria-live, the focus order unchanged, the NEEDS-YOU answered through the ActionButton (click, then Enter) with POST /api/chat/answer seen, the welcome starter, Stop → State 3 with the receipt's stop; ${phone ? 'folded to its label, opened on a tap; nothing overflows' : 'recorded'}; no page error`, async () => {
      const o = await open(size, { record: phone ? undefined : 'recording-chat-1440x900' });
      try {
        const composer = await toChat(o, size, '');
        // ── the console: present, drawn by the runtime, the operator's artboard, readable ──
        const root = o.page.locator(SEL.console).first();
        await root.waitFor({ state: 'attached', timeout: 20_000 });
        const key = (await root.getAttribute('data-rive-component')) || SEL.consoleKey;
        if (phone) {
          // the phone folds the console to its label; a tap opens it (H171's control); nothing overflows the viewport either way
          const fold = o.page.locator(SEL.consoleFold).first();
          if (await fold.count()) {
            await caps.cap(o.page, size, 'chat-console-folded', ['390x844: the console folded to its label (the chat\'s room is the conversation\'s).']);
            await fold.click();
          }
        }
        await o.page.waitForSelector(`canvas[data-timmy-rive="${key}"][data-loaded]`, { state: 'attached', timeout: 20_000 });
        const h = (await handleOf(o.page, key))!;
        expect(h.state, 'drawn by the runtime').toBe('drawn');
        expect(h.contract).toBe('TimmyUI');
        expect(h.runtime!.artboardNames).toEqual(NATIVE.artboards);
        expect((await root.getAttribute('data-artboard')) || h.artboard, 'the console takes the AgentConsole artboard').toBe('AgentConsole');
        const boxOf = await o.page.locator(`canvas[data-timmy-rive="${key}"]`).first().boundingBox();
        expect(boxOf, 'the console\'s canvas has a box').toBeTruthy();
        if (!phone) expect(boxOf!.width, 'readable: at least 320 px wide at 1440').toBeGreaterThanOrEqual(320);
        else expect(boxOf!.width, 'within the phone\'s width').toBeLessThanOrEqual(size.width);
        expect(await o.page.locator(`[data-rive-status="${key}"]`).first().getAttribute('aria-live')).toBe('polite');
        expect(await label(o.page, key)).toBe('idle');
        expect(await inputValue(o.page, key, 'State'), 'State 0 Idle before any turn').toBe(0);
        await caps.cap(o.page, size, 'chat-console-idle', ['The AgentConsole in the chat, drawn, idle (State 0); the model chosen for the next turn.'], { to: root, what: 'the console' });
        // ── the focus order: Tab from the textarea reaches Send; no canvas takes the focus ──
        const order = await tabOrder(o.page);
        expect(order.some((d) => /^button[^"]*"Send/i.test(d)), `Tab from the textarea reaches Send: ${order.join(' → ')}`).toBe(true);
        expect(order.some((d) => /^canvas/.test(d)), `no canvas in the focus order: ${order.join(' → ')}`).toBe(false);
        // ── a REAL quick turn: working → State 1 (recorded), idle → State 0 (live) ──
        await composer.first().fill('FAKE: what time is it?');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        await until(o.page, 'the FAKE answer', (s) => s.includes(FAKE_ANSWER), 60_000);
        await inputIs(o.page, key, 'State', 0, 20_000);
        expect(await label(o.page, key)).toBe('idle');
        const working = await eventOf(o.page, key, 'activity', 'working');
        expect(working, 'a working event was recorded on the turn').toBeTruthy();
        expect(working!.native).toBe('State 1');
        expect(working!.source).toMatch(/POST \/api\/chat\/turn · SSE (route|turn|delta|tool)/);
        const idle = await eventOf(o.page, key, 'activity', 'idle');
        expect(idle!.native).toBe('State 0');
        expect(idle!.source).toMatch(/POST \/api\/chat\/turn · SSE done/);
        await caps.cap(o.page, size, 'chat-turn-answered', ['After the REAL quick turn: the FAKE answer with its receipt; the console back to idle (State 0, from SSE done (answered)).'], { to: o.page.getByText(/receipt [0-9a-f]{8}/).last(), what: 'the turn\'s receipt line' });
        // ── NEEDS-YOU: a gated tool → the ActionButton (a real <button>) → a trusted click → POST /api/chat/answer seen → the turn goes on ──
        await composer.first().fill('FAKE: write a note please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        const group = o.page.locator(SEL.needsGroup).last();
        await group.waitFor({ state: 'visible', timeout: 30_000 });
        await inputIs(o.page, key, 'State', 2, 10_000); // awaiting approval → State 2 Approval
        expect(await label(o.page, key)).toMatch(/awaiting/);
        const once = o.page.locator(SEL.answerButton('once')).last();
        await once.waitFor({ state: 'visible', timeout: 10_000 });
        expect(await once.evaluate((e) => e.tagName), 'the answer control is a real <button>').toBe('BUTTON');
        expect(await once.getAttribute('data-rive-face'), 'the answer control is a mounted ActionButton').toBeTruthy();
        await caps.cap(o.page, size, 'chat-needs-you', ['NEEDS YOU: the FAKE model asked for write_project_file; H169\'s gate waits for this page; the ActionButtons offer the choices; the console awaiting approval (State 2).'], { to: group, what: 'the NEEDS YOU group' });
        const answered = o.page.waitForResponse((r) => r.url().endsWith('/api/chat/answer') && r.request().method() === 'POST', { timeout: 15_000 });
        await once.click();
        const res = await answered;
        expect(res.status()).toBe(200);
        expect(JSON.parse(res.request().postData() || '{}')).toMatchObject({ choice: 'once' });
        await until(o.page, 'the turn went on after the answer', (s) => s.includes(FAKE_WRITTEN), 60_000);
        await inputIs(o.page, key, 'State', 0, 20_000);
        await caps.cap(o.page, size, 'chat-needs-you-answered', ['After the trusted click on the ActionButton: POST /api/chat/answer { id, choice: "once" } seen (200); the tool ran; the turn answered; the console idle again.']);
        // keyboard: a second ask answered with Enter on the focused ActionButton
        await composer.first().fill('FAKE: write another note please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        const group2 = o.page.locator(SEL.needsGroup).last();
        await group2.waitFor({ state: 'visible', timeout: 30_000 });
        const once2 = o.page.locator(SEL.answerButton('once')).last();
        await once2.waitFor({ state: 'visible', timeout: 10_000 });
        const answered2 = o.page.waitForResponse((r) => r.url().endsWith('/api/chat/answer') && r.request().method() === 'POST', { timeout: 15_000 });
        await once2.focus();
        await o.page.keyboard.press('Enter');
        expect((await answered2).status(), 'Enter on the focused ActionButton answers').toBe(200);
        await until(o.page, 'the second turn went on', (s) => s.split(FAKE_WRITTEN).length > 2, 60_000);
        await inputIs(o.page, key, 'State', 0, 20_000);
        // ── Stop mid-turn: State 3 and the receipt's stop ──
        await composer.first().fill('FAKE: answer slowly please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        await inputIs(o.page, key, 'State', 1, 20_000);
        expect(await label(o.page, key)).toBe('working');
        await caps.cap(o.page, size, 'chat-turn-streaming', ['The slow REAL turn streaming: the console working (State 1, from the SSE); Stop offered.'], { to: root, what: 'the console' });
        await o.page.getByRole('button', { name: /^Stop/ }).first().click();
        await inputIs(o.page, key, 'State', 3, 30_000);
        expect(await label(o.page, key)).toBe('stopped');
        const stopped = await eventOf(o.page, key, 'activity', 'stopped');
        expect(stopped!.native).toBe('State 3');
        expect(stopped!.source).toMatch(/POST \/api\/chat\/turn · SSE done \(cancelled\)|POST \/api\/chat\/stop/);
        const stopping = await eventOf(o.page, key, 'activity', 'stopping');
        expect(stopping!.native).toBe('State 1');
        expect(stopping!.source).toMatch(/POST \/api\/chat\/stop \{ id: /);
        // the stopped turn folds with its receipt (H171's dd8b2aa3): the receipt line says the stop
        const folded = await until(o.page, 'the stopped turn with its receipt', (s) => /stopped by you/i.test(s) && /receipt [0-9a-f]{8}/.test(s), 30_000);
        expect(folded).toMatch(/stopped by you/i);
        await caps.cap(o.page, size, 'chat-stopped', ['After Stop: the console stopped (State 3, from the turn\'s own done (cancelled)); the stopped turn folded with its receipt.'], { to: o.page.locator('#cx-own li, #cx-turns li').filter({ hasText: /stopped by you/i }).last(), what: 'the stopped turn' });
        // ── the welcome's starter ActionButton fires the starter (a new conversation shows the welcome again) ──
        await o.page.getByRole('button', { name: /New conversation/ }).first().click().catch(() => undefined);
        const starter = o.page.locator(SEL.starter).first();
        if (await starter.count()) {
          await starter.waitFor({ state: 'visible', timeout: 10_000 });
          const id = await starter.getAttribute('data-cx-start');
          expect(await starter.evaluate((e) => e.tagName)).toBe('BUTTON');
          await starter.click();
          // the starter's own action: the composer takes its words, or the chat moves (H171's STARTERS); the welcome's Pressed recorded
          await o.page.waitForTimeout(500);
          const after = await text(o.page);
          expect(after.length, `the starter "${id}" did something on the page`).toBeGreaterThan(0);
          await caps.cap(o.page, size, 'chat-starter', [`The welcome's starter ActionButton "${id}" fired (a trusted click; Pressed down then up on ActionButton).`]);
        }
        if (phone) {
          const overflow = await o.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, 'nothing overflows the phone\'s width').toBeLessThanOrEqual(0);
        }
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
      } finally {
        const video = o.page.video();
        await o.close();
        if (!phone) await keepRecording(video, 'recording-chat-1440x900', ['REAL: the companion, the agent turn and its SSE, the NEEDS YOU gate, the Stop, the receipts, the runtime drawing the AgentConsole and the ActionButtons. FAKE: the identity provider\'s session, the Ollama on 127.0.0.1 (the tool calls and the answers are scripted). What is seen: the console idle → working → idle on a quick turn; the NEEDS YOU answered through the ActionButton (click, then Enter); the slow turn stopped (State 3) with its receipt. No PREVIEW here.']);
      }
    });

    it.skipIf(!browserPath)(`${at} CONNECTIONS: a ProviderCard drawn in each card; Check → the fed event "GET /api/connections: ollama-local" with State 1 while it ran, State 0 after with the label connected (no success pose, said); no page error`, async () => {
      const o = await open(size);
      try {
        await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s) && /Ollama · local/.test(s));
        for (const id of PROVIDERS) {
          const comp = o.page.locator(SEL.cardComponent(id)).first();
          await comp.waitFor({ state: 'attached', timeout: 20_000 });
          const key = (await comp.getAttribute('data-rive-component'))!;
          await o.page.waitForSelector(`canvas[data-timmy-rive="${key}"][data-loaded]`, { state: 'attached', timeout: 20_000 });
          const h = (await handleOf(o.page, key))!;
          expect(h.state, `${id}: drawn`).toBe('drawn');
          expect((await comp.getAttribute('data-artboard')) || h.artboard, `${id} on ProviderCard`).toBe('ProviderCard');
          expect(await o.page.locator(`[data-rive-status="${key}"]`).first().getAttribute('aria-live')).toBe('polite');
        }
        await caps.cap(o.page, size, 'connections-cards', ['The connections screen: a ProviderCard drawn in each of the four cards (disconnected, State 0); the cards\' buttons stay HTML buttons.']);
        const local = o.page.locator(SEL.cardComponent('ollama-local')).first();
        const key = (await local.getAttribute('data-rive-component'))!;
        await o.page.getByRole('button', { name: /^Check$/ }).first().click();
        await o.page.waitForSelector('[data-provider="ollama-local"][data-state="checked"]', { timeout: 20_000, state: 'attached' });
        await inputIs(o.page, key, 'State', 0, 15_000);
        expect(await label(o.page, key)).toBe('connected');
        const checking = await eventOf(o.page, key, 'connection', 'checking');
        expect(checking, 'the checking event while Check ran').toBeTruthy();
        expect(checking!.native).toBe('State 1');
        expect(checking!.source).toMatch(/GET \/api\/connections: ollama-local/);
        const connected = await eventOf(o.page, key, 'connection', 'connected');
        expect(connected!.native).toBe('State 0');
        expect(connected!.did).toMatch(/no success pose/);
        expect(connected!.source).toMatch(/GET \/api\/connections: ollama-local/);
        await caps.cap(o.page, size, 'connections-after-check', ['Ollama · local after Check against the FAKE: the card checked, the ProviderCard State 0 with the label "connected" (no success pose is authored, said in the event); the checking event (State 1) recorded from GET /api/connections: ollama-local.'], { to: o.page.locator(SEL.card('ollama-local')).first(), what: 'the local card' });
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
      } finally { await o.close(); }
    });
  }

  // ── the Canvas (the Studio) ──────────────────────────────────────────────────

  type Ed = { getShape: (id: string) => { id: string; type: string; x: number; y: number; props: Record<string, unknown> } | undefined; updateShape: (s: unknown) => void; createShape: (s: unknown) => void; createBindings: (b: unknown[]) => void; getBindingsInvolvingShape?: (id: string) => Array<{ type: string; fromId: string; toId: string; props: Record<string, unknown> }>; store: { serialize: (scope: string) => Record<string, { typeName: string; type?: string; fromId?: string; toId?: string; props?: Record<string, unknown>; x?: number; y?: number }> }; selectNone: () => void; zoomToFit: () => void };
  type Win = { timmyCanvas: { editor: Ed; placeRive: (component: string, o?: Record<string, unknown>) => string; licenseState: string; identity?: { state: string; project?: { name: string } } }; TimmyRive: { inspect: () => Handle[] } };

  async function openCanvas(size: { width: number; height: number }, o: { reducedMotion?: boolean; record?: string } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
    const context = await browser.newContext({ viewport: size, ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}), ...recordingOf(o.record) });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${studioBase}/#code=${await grant((studio!.address() as AddressInfo).port, studio!.projectToken)}`);
    await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
    await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 20_000 }).catch(() => undefined);
    return { page, context, errors };
  }
  const saved = (page: Page, ms = 20_000): Promise<unknown> => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: ms });

  it.skipIf(!browserPath)('CANVAS 1440x900: the SDK\'s own license verdict (a FAKE key is rejected in its words; never a key in the test); the three shapes placed, moved, resized; an arrow BOUND between two; saved → reopened: shapes, props and the binding back; a project switch → the other board has none; reduced motion → ReducedMotion true and the pose settles; no page error; recorded', async () => {
    const size = { width: 1440, height: 900 };
    const first = await openCanvas(size, { record: 'recording-canvas-1440x900' });
    let placed: Record<string, string> = {};
    let before: Record<string, unknown> = {};
    try {
      const { page } = first;
      // the license: tldraw's own verdict on the key the Studio handed it (never inferred from a key being present)
      await page.waitForFunction(() => { const s = (window as unknown as Win).timmyCanvas?.licenseState; return Boolean(s) && s !== 'pending'; }, null, { timeout: 20_000 }).catch(() => undefined);
      const license = await page.evaluate(() => (window as unknown as Win).timmyCanvas.licenseState);
      console.warn(`journey-rive-product: the Studio's tldraw license state reads "${license}" (${realKey ? 'the environment\'s key, not read by this test' : 'this test\'s FAKE key, which the SDK must reject'})`);
      expect(['licensed', 'licensed-with-watermark', 'unlicensed', 'unlicensed-production', 'expired', 'unknown']).toContain(license);
      if (!realKey) expect(license, 'a FAKE key is not licensed in the SDK\'s own words').not.toMatch(/^licensed/);
      const about = await page.evaluate(() => document.getElementById('about')?.textContent || document.body.innerText);
      expect(about).not.toContain('FAKE-license-key');
      // the three shapes placed (H174's timmy-rive shape), drawn by the runtime
      placed = await page.evaluate(() => { const W = window as unknown as Win; return { activity: W.timmyCanvas.placeRive('activity'), connection: W.timmyCanvas.placeRive('connection', { provider: 'ollama-local', label: 'Ollama · local' }), welcome: W.timmyCanvas.placeRive('welcome') }; });
      await page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.zoomToFit());
      await page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      const hs = await handles(page);
      for (const h of hs) { expect(h.contract).toBe('TimmyUI'); expect(h.runtime!.artboardNames).toEqual(NATIVE.artboards); }
      expect(await page.$$eval('[data-timmy-rive-shape] canvas[data-loaded]', (els) => els.length)).toBe(3);
      await caps.cap(page, size, 'canvas-three-shapes', ['Timmy Canvas (the Studio, licensed tldraw with the key the environment gives, or a FAKE one the SDK rejects): the three timmy-rive shapes placed — AgentConsole, ProviderCard, ActionButton — drawn by the runtime, each with its state word.']);
      // move and resize through the editor (what a drag does)
      await page.evaluate((ids) => { const e = (window as unknown as Win).timmyCanvas.editor; const a = e.getShape(ids.activity)!; e.updateShape({ id: ids.activity, type: 'timmy-rive', x: a.x + 160, y: a.y + 40 }); const c = e.getShape(ids.connection)!; e.updateShape({ id: ids.connection, type: 'timmy-rive', props: { ...c.props, w: 420 } }); }, placed);
      await page.waitForFunction((ids) => { const e = (window as unknown as Win).timmyCanvas.editor; return (e.getShape(ids.connection)?.props.w as number) === 420; }, placed, { timeout: 10_000 });
      await page.waitForSelector('[data-timmy-rive-shape].is-expanded', { timeout: 10_000 });
      // an arrow BOUND between the console and the card (tldraw's bindings: the records the board keeps)
      const arrowId = await page.evaluate((ids) => {
        const e = (window as unknown as Win).timmyCanvas.editor;
        const a = e.getShape(ids.activity)!; const c = e.getShape(ids.connection)!;
        const id = `shape:arrow-${Date.now().toString(36)}`;
        e.createShape({ id, type: 'arrow', x: 0, y: 0, props: { start: { x: a.x + 40, y: a.y + 40 }, end: { x: c.x + 40, y: c.y + 40 } } });
        e.createBindings([{ type: 'arrow', fromId: id, toId: ids.activity, props: { terminal: 'start' } }, { type: 'arrow', fromId: id, toId: ids.connection, props: { terminal: 'end' } }]);
        return id;
      }, placed);
      const bindings = await page.evaluate((id) => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'binding' && r.fromId === id).map((r) => [r.toId, (r.props as { terminal: string }).terminal]), arrowId);
      expect(bindings.sort()).toEqual([[placed.activity, 'start'], [placed.connection, 'end']].sort());
      await page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.zoomToFit());
      await saved(page);
      await caps.cap(page, size, 'canvas-arrow-bound', ['The console moved, the card resized (expanded), an arrow BOUND from the console to the card (two binding records); saved through Timmy\'s project storage (the board under the project).']);
      before = await page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
      expect(first.errors, 'page errors').toEqual([]);
    } finally {
      const video = first.page.video();
      await first.context.close();
      await keepRecording(video, 'recording-canvas-1440x900', ['REAL: the Studio, the tldraw editor (licensed with the environment\'s key, or a FAKE one the SDK rejects), the runtime drawing the three artboards, Timmy\'s board save. What is seen: the three shapes placed, the console moved, the card resized, an arrow bound between them, saved. No PREVIEW here.']);
    }
    // reopened in a new page: every record back (the shapes with their props, the arrow, its two bindings)
    const again = await openCanvas(size);
    try {
      const after = await again.page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(after).toEqual(before);
      await again.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await again.page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.zoomToFit());
      await again.page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      expect(await again.page.evaluate((ids) => (window as unknown as Win).timmyCanvas.editor.getShape(ids.connection)?.props.w, placed)).toBe(420);
      await caps.cap(again.page, size, 'canvas-reopened', ['The board reopened in a new page: the three shapes with their props (the card at 420 wide), the arrow and its two bindings exactly as saved; drawn again by the runtime.']);
      // a project switch: the other project's board has none of this
      await nameProject((studio!.address() as AddressInfo).port, studio!.projectToken, { root: projectB, name: 'rive-product-b' });
      await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'rive-product-b'; }, null, { timeout: 20_000 });
      await again.page.waitForTimeout(500);
      expect(await again.page.evaluate(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length), 'the other project\'s board is empty of these shapes').toBe(0);
      expect(await again.page.$$eval('[data-timmy-rive-shape]', (els) => els.length)).toBe(0);
      await caps.cap(again.page, size, 'canvas-other-project', ['Switched to the other project (rive-product-b): its board carries none of the first project\'s shapes (project isolation of the boards).']);
      await nameProject((studio!.address() as AddressInfo).port, studio!.projectToken, { root: projectA, name: 'rive-product-a' });
      await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'rive-product-a'; }, null, { timeout: 20_000 });
      await again.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      expect(again.errors, 'page errors').toEqual([]);
    } finally { await again.context.close(); }
    // reduced motion: the asset's own ReducedMotion input true; the pose settles (the runtime stops moving)
    const still = await openCanvas(size, { reducedMotion: true });
    try {
      await still.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await still.page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.zoomToFit());
      await still.page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      const hs = await handles(still.page);
      for (const h of hs) {
        expect(h.nativeReduced, `${h.component}: the asset has its own ReducedMotion input`).toBe(true);
        expect(h.runtime!.inputs.find((i) => i.name === 'ReducedMotion')?.value, `${h.component}: ReducedMotion true`).toBe(true);
      }
      await caps.cap(still.page, size, 'canvas-reduced-motion', ['prefers-reduced-motion: the asset\'s own ReducedMotion input true on every shape (zero-duration transitions; the pose settles and the runtime stops moving).']);
      expect(still.errors, 'page errors').toEqual([]);
    } finally { await still.context.close(); }
  });

  it.skipIf(!browserPath)('CANVAS 390x844: the saved board opens on a phone; the shapes drawn; nothing overflows; no page error', async () => {
    const size = { width: 390, height: 844 };
    const o = await openCanvas(size);
    try {
      await o.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await o.page.evaluate(() => (window as unknown as Win).timmyCanvas.editor.zoomToFit());
      await o.page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      const overflow = await o.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'nothing overflows the phone\'s width').toBeLessThanOrEqual(0);
      await caps.cap(o.page, size, 'canvas-phone', ['The same board at 390x844: the three shapes drawn; nothing overflows.']);
      expect(o.errors, 'page errors').toEqual([]);
    } finally { await o.context.close(); }
  });
});
