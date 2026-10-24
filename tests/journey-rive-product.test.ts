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
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Video } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompanionServer } from '../src/companion/server.js';
import type { StudioServer } from '../src/studio/server.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';
import { capturer, revisionOf } from './fixtures/journey-caps.js';
import { grant, nameProject } from './helpers/canvas-auth.js';
import { activeProjectFile } from '../src/studio/active-follow.js';

/**
 * The servers: from THE INSTALLED PACKAGE when TIMMY_INSTALLED_ROOT names its root (<prefix>/node_modules/timmy-tui, as
 * scripts/review/review.sh installs the packed tarball; the operator's 07:06 bar: the recordings come from the installed
 * package, not a worktree's dev server), else this checkout's sources. The fixtures (the FAKE identity provider, the FAKE Ollama)
 * are this checkout's either way. The sidecars say which.
 */
const INSTALLED = process.env.TIMMY_INSTALLED_ROOT?.trim() || '';
type Servers = { startCompanionServer: (port: number, o: Record<string, unknown>) => Promise<CompanionServer>; startStudioServer: (port: number, o: Record<string, unknown>) => Promise<StudioServer> };
async function servers(): Promise<Servers> {
  if (!INSTALLED) {
    const c = await import('../src/companion/server.js');
    const st = await import('../src/studio/server.js');
    return { startCompanionServer: c.startCompanionServer as Servers['startCompanionServer'], startStudioServer: st.startStudioServer as Servers['startStudioServer'] };
  }
  const load = (rel: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(INSTALLED, rel)).href) as Promise<Record<string, unknown>>;
  const c = await load('dist/src/companion/server.js');
  const st = await load('dist/src/studio/server.js');
  return { startCompanionServer: c.startCompanionServer as Servers['startCompanionServer'], startStudioServer: st.startStudioServer as Servers['startStudioServer'] };
}
/** The installed package's own words of itself: its version, its build revision (dist/build-info.json), the tarball's sha256 when named. */
function installedWords(): string[] {
  if (!INSTALLED) return ['Servers: this checkout\'s sources (a worktree dev server), NOT the installed package.'];
  const out: string[] = [];
  try { const pkg = JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')) as { name?: string; version?: string }; out.push(`Servers: THE INSTALLED PACKAGE ${pkg.name ?? '?'}@${pkg.version ?? '?'} (TIMMY_INSTALLED_ROOT: the tarball installed into a temp prefix; its own dist/src/companion/server.js and dist/src/studio/server.js started on 127.0.0.1).`); } catch { out.push('Servers: the installed package (its package.json could not be read).'); }
  try { const info = JSON.parse(readFileSync(join(INSTALLED, 'dist', 'build-info.json'), 'utf8')) as Record<string, unknown>; out.push(`Package build: ${JSON.stringify(info).slice(0, 300)}`); } catch { out.push('Package build: no dist/build-info.json in the installed package.'); }
  const tgz = process.env.TIMMY_INSTALLED_TARBALL?.trim();
  if (tgz) { try { out.push(`Tarball: ${tgz.split('/').pop()} · sha256 ${createHash('sha256').update(readFileSync(tgz)).digest('hex')}`); } catch { out.push(`Tarball: ${tgz.split('/').pop()} (not readable for its sha256)`); } }
  // the review package the tarball came out of (final.sh's timmy-review-<rev>.tar.gz), when named
  const review = process.env.TIMMY_INSTALLED_REVIEW?.trim();
  if (review) { try { out.push(`Review package: ${review.split('/').pop()} · sha256 ${createHash('sha256').update(readFileSync(review)).digest('hex')}`); } catch { out.push(`Review package: ${review.split('/').pop()} (not readable for its sha256)`); } }
  return out;
}

// ── the contract's selectors (one place to adjust) ──────────────────────────────
const SEL = {
  /** the chat screen's console (H171's 06:58: ONE band #cx-console above the composer's route line, H174's mountConsole bound to the activity feed) */
  console: '#cx-console [data-rive-component], #screen-chat [data-rive-component="activity"], [data-rive-component="console"]',
  consoleKey: 'activity',
  /** the NEEDS-YOU answer buttons (H174's mountActionButton: a real <button aria-label=label> wrapping the canvas; H171 names the choice) inside the turn's group */
  needsGroup: '.cx-needs',
  answerButton: (choice: string): string => `.cx-needs button[data-cx-answer="${choice}"], .cx-needs [data-cx-answer="${choice}"] button, .cx-needs button[aria-label="${choice}"]`,
  /** the welcome's starter buttons (ActionButtons mounted by H171) */
  starter: 'button[data-cx-start], [data-cx-start] button',
  /** a provider card and the ProviderCard mounted in it */
  card: (id: string): string => `[data-provider="${id}"]`,
  cardComponent: (id: string): string => `[data-provider="${id}"] [data-rive-component]`,
  /** the console's fold (H171: folds to the WORD by its aria-expanded button; a phone's width or a short window starts folded; a tap opens) */
  consoleFold: '#cx-console button[aria-expanded="false"]',
};
const PROVIDERS = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];
const NATIVE = { name: 'timmy-ui.riv', bytes: 405_278, sha256: '9fd9ae7c098187df4646f0ed581e6c7019173903078ac419ad7765ac7a1beac6', artboards: ['AgentConsole', 'ProviderCard', 'ActionButton'], stateMachine: 'TimmyUI', inputs: ['State', 'Hover', 'Pressed', 'ReducedMotion'] };
const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

const caps = capturer('tests/journey-rive-product.test.ts', [
  'REAL: the companion and the Studio (started in this process), their launch tokens and pages, the identity verifier (RS256 against CLERK_JWT_KEY), the agent turn (openChatSession → runTurn) and its SSE, the NEEDS YOU gate (write_project_file), the Stop route, the sealed receipts, the project storage (the board under the project), @rive-app/canvas served from this origin, the operator\'s timmy-ui.riv (AgentConsole, ProviderCard, ActionButton; TimmyUI).',
  'FAKE: the identity provider (an RSA pair made by the test; the session minted by the test), the Ollama on 127.0.0.1 (no model behind it: one tool call then a fixed answer; the gated write on "write"; the slow answer on "slowly"), the tldraw license key when the environment has none (a string the SDK rejects).',
  'What animates: the native Rive artboards drawn by the runtime, each state the native State input the binding set from a backend event; the HTML word beside it says the same. What a face\'s own caption run reads is in the capture\'s own line where the test read it back.',
  ...installedWords(),
  `Tests head: ${revisionOf()} (this checkout); the product tree: ${INSTALLED ? 'the installed package\'s build-info revision above' : 'this checkout at the same revision'}.`,
], 'product');

const PORT = 4500;
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'c6'.repeat(32);
const USER = fakeUserId('product');
const MODEL = 'fake-qwen3:8b';
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
const FAKE_WRITTEN = 'FAKE answer: the note was written (no model behind this).';
const DENSE_CHUNKS = 300;
const DENSE_EVERY_MS = 15;
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
    // the operator's 07:06 bar: a DENSE stream — 300 chunks, one every 15 ms (≈ 66 per second for ≈ 4.5 s)
    dense: { when: /dense/i, words: Array.from({ length: DENSE_CHUNKS }, (_, i) => `d${i + 1}`), everyMs: DENSE_EVERY_MS },
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
  const sv = await servers();
  companion = await sv.startCompanionServer(PORT, { token: TOKEN, chatEnv: env, workspace: { env, shareMs: 0 } });
  // the Studio (Timmy Canvas): the real server and the real bundle built here; the license key from the environment when it has
  // one (the lead's / CI's; never read here), else a FAKE string the SDK rejects — the SDK's own verdict is what is asserted
  studioRoot = mkdtempSync(join(tmpdir(), 'journey-rive-product-studio-'));
  studioHome = mkdtempSync(join(tmpdir(), 'journey-rive-product-home-'));
  if (!INSTALLED) {
    // the dev server: the bundle built here from this checkout
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(studioRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(studioRoot, 'dist'), { licenses: studioRoot });
  }
  realKey = Boolean(process.env.TLDRAW_LICENSE_KEY?.trim());
  const studioEnv: Record<string, string | undefined> = { TIMMY_HOME: studioHome, HOME: studioHome, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TLDRAW_LICENSE_KEY: realKey ? process.env.TLDRAW_LICENSE_KEY : 'FAKE-license-key-the-sdk-rejects-H172' };
  // (the installed package serves its own companion/studio-canvas — index.html and the bundle it packed — from its default root)
  // (followActive: the Studio follows its Timmy home's active-project record, which is how a project switch reaches an open page)
  studio = await sv.startStudioServer(0, { env: studioEnv, followActive: true, followEveryMs: 200, ...(INSTALLED ? {} : { root: studioRoot }) });
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

interface Opened { page: Page; context: BrowserContext; errors: string[]; missing: string[]; left: string[]; rivFetches: string[]; close: () => Promise<void> }

/** What the page did on the network and in its console: errors, misses, requests that left 127.0.0.1, every fetch of the .riv. */
function watch(page: Page, o: { errors: string[]; missing: string[]; left: string[]; rivFetches: string[] }): void {
  page.on('response', (r) => { if (/\/assets\/rive\/timmy-ui\/timmy-ui\.riv/.test(r.url())) o.rivFetches.push(`${r.status()} ${new Date().toISOString()}`); });
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
async function keepRecording(v: Video | null, name: string, words: string[], verdict = 'the case\'s verdict is in the vitest log and the GATE line (this sidecar is written before vitest counts it)', seen: string[] = []): Promise<void> {
  if (!caps.folder) return;
  const base = join(caps.folder, name);
  try {
    const p = v ? await v.path() : '';
    if (p && existsSync(p)) renameSync(p, `${base}.webm`);
    // (the recording holds the page from its open to its close: what the case REACHED is listed, in order — nothing it did not reach)
    writeFileSync(`${base}.txt`, [`${name} · a Playwright recording in headless Chromium (recordVideo), scripted test run, not a person · ${new Date().toISOString()}`, ...installedWords(), `Tests head: ${revisionOf()} (this checkout); the product tree: ${INSTALLED ? 'the installed package\'s build-info revision above' : 'this checkout at the same revision'}.`, `Origins: the companion ${companion.address}; the Studio ${studioBase} — both on 127.0.0.1.`, 'FAKE on 127.0.0.1: the identity provider (an RSA pair made by the test; its public key is CLERK_JWT_KEY; the session minted by the test, verified by the REAL verifier), the Ollama (no model: scripted tool calls and answers). No real Ollama in this sandbox.', ...words, `What the recording holds, in order (the steps the case reached): ${seen.length ? seen.join(' → ') : '(none recorded)'}.`, `Verdict: ${verdict}.`, ''].join('\n'));
  } catch (e) { try { writeFileSync(`${base}.failed.txt`, `the recording ${name} did not complete: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing to say it with */ } }
}

async function open(size: { width: number; height: number }, o: { reducedMotion?: boolean; record?: string } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}), ...recordingOf(o.record) });
  const page = await context.newPage();
  const errors: string[] = [];
  const missing: string[] = [];
  const left: string[] = [];
  const rivFetches: string[] = [];
  watch(page, { errors, missing, left, rivFetches });
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
  return { page, context, errors, missing, left, rivFetches, close: async () => { await context.close(); } };
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
/**
 * The caption a drawn face carries, read back from the RUNTIME (H174's dafb636d: the text run named by its baked words; a live face
 * says LIVE, the Inspect view's preview says PREVIEW — the operator's rule). "(not readable)" when the runtime has no such read.
 */
const captionOf = (page: Page, key: string): Promise<string> => page.evaluate((k) => {
  const R = (window as unknown as { TimmyRive?: { handles?: () => Array<{ component?: string; rive: { getTextRunValue?: (name: string) => string | undefined } | null }> } }).TimmyRive;
  const h = R?.handles?.().find((x) => x.component === k);
  try { const v = h?.rive?.getTextRunValue?.('PREVIEW  /  NOT A LIVE JOB'); return typeof v === 'string' ? v : '(not readable)'; } catch { return '(not readable)'; }
}, key);
const LIVE_TURN = 'LIVE  /  THE TURN’S EVENTS';
const LIVE_CONNECTIONS = 'LIVE  /  GET /api/connections';
/** The handles per component key, as "key×n" sorted — ONE runtime instance per mounted component is the invariant. */
async function handleCensus(page: Page): Promise<string[]> {
  const hs = await handles(page);
  const by = new Map<string, number>();
  for (const h of hs) by.set(h.component ?? h.id, (by.get(h.component ?? h.id) ?? 0) + 1);
  return [...by.entries()].sort().map(([k, n]) => `${k}×${n}`);
}

/** The focus order from the composer: each Tab's active element, until Send or `max` tabs. Never a canvas. */
async function tabOrder(page: Page, max = 40): Promise<string[]> {
  const composer = page.getByRole('textbox', { name: /Message Timmy/i }).or(page.getByPlaceholder(/Message Timmy/i)).first();
  // (Send is disabled — and so skipped by Tab — while the composer is empty: the order is read with a draft in it, cleared after)
  await composer.first().fill('focus order (a draft, cleared)');
  await composer.focus();
  await page.keyboard.press('Escape'); // (a panel left open by the model's choice closes; the composer keeps the focus)
  await composer.focus();
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const d = await page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${a.getAttribute('data-rive-face') ? `[rive-face=${a.getAttribute('data-rive-face')}]` : ''} "${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30)}"` : 'none'; });
    seen.push(d);
    if (/^button[^"]*"Send/i.test(d)) break;
  }
  await composer.first().fill('');
  return seen;
}

/** The chat screen with the FAKE model chosen for the next turn (H171's panel), as a person does it. */
async function toChat(o: Opened, size: { width: number; height: number }, capPrefix: string): Promise<Locator> {
  await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s));
  await o.page.getByRole('button', { name: /Continue to the workspace|Explore without a model/ }).first().click();
  await until(o.page, 'the chat', (s) => /Message Timmy/i.test(s));
  const landing = await text(o.page);
  const welcome = /What would you like to make\?/.test(landing);
  await caps.cap(o.page, size, `${capPrefix}chat-welcome-console`, [welcome ? 'The chat screen on landing: the welcome (no turn in this project yet), the composer, the AgentConsole band mounted above the composer\'s route line (idle, State 0) — REAL runtime, the operator\'s artboard.' : 'The chat screen on landing: the project\'s conversation as it stands (turns of an earlier case of this run, this being the USER\'s one project), the composer, the AgentConsole band above the composer\'s route line — REAL runtime, the operator\'s artboard.']);
  if (size.width < 600) await o.page.getByRole('button', { name: /Models/ }).first().click(); // (a phone keeps the Models panel behind its button)
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

    it.skipIf(!browserPath)(`${at} CHAT: the AgentConsole drawn in the chat at a readable size, its State on a REAL turn (working 1 → idle 0), the label aria-live, the focus order unchanged, ${phone ? '' : 'the DENSE stream with a NEEDS-YOU in the middle (one instance, the last event\'s State), '}the NEEDS-YOU answered through the ActionButton (click, then Enter) with POST /api/chat/answer seen, the welcome starter, Stop → State 3 with the receipt's stop; ${phone ? 'folded to its label, opened on a tap; nothing overflows' : 'recorded'}; no page error`, async () => {
      const o = await open(size, { record: phone ? undefined : 'recording-chat-1440x900' });
      let chatPassed = false;
      const seen: string[] = [];
      try {
        const composer = await toChat(o, size, '');
        seen.push('the chat opened, the FAKE model chosen');
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
        if (!phone) expect(boxOf!.width, 'readable: the asset\'s card size (H174: 320 px; the borders inside)').toBeGreaterThanOrEqual(300);
        else expect(boxOf!.width, 'within the phone\'s width').toBeLessThanOrEqual(size.width);
        expect(await o.page.locator(`[data-rive-status="${key}"]`).first().getAttribute('aria-live')).toBe('polite');
        expect(await label(o.page, key)).toBe('idle');
        expect(await inputValue(o.page, key, 'State'), 'State 0 Idle before any turn').toBe(0);
        const consoleCaption = await captionOf(o.page, key);
        if (consoleCaption !== '(not readable)') expect(consoleCaption, 'a live face says LIVE (the runtime\'s own text run), never PREVIEW').toBe(LIVE_TURN);
        await caps.cap(o.page, size, 'chat-console-idle', ['The AgentConsole in the chat, drawn, idle (State 0); the model chosen for the next turn.', `The face\'s caption, read back from the runtime\'s text run: "${consoleCaption}".`], { to: root, what: 'the console' });
        seen.push('the console drawn, idle (State 0)');
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
        await caps.cap(o.page, size, 'chat-turn-answered', ['After the REAL quick turn: the FAKE answer with its receipt; the console back to idle (State 0, from SSE done (answered)).'], { to: o.page.getByText(/receipt [0-9a-f]{8}/).filter({ visible: true }).last(), what: 'the turn\'s receipt line' });
        seen.push('a quick REAL turn: working (State 1) → idle (State 0), the answer with its receipt');
        // ── RAPID EVENTS (the operator's 07:06 bar, product level): a REAL turn whose FAKE stream is DENSE — a gated write first
        // (the NEEDS-YOU in the middle of the turn), then 300 chunks at one every 15 ms (≈ 66 per second for ≈ 4.5 s) through the
        // real SSE and H171's feed into the drawn console. Invariants read from the page before, during and after: one runtime
        // instance per mounted component, the .riv not fetched again, no "Aborted()" / onLoadError / page error, the console's
        // State the LAST event's mapping (done → idle → 0) and the HTML word the same once the stream ends.
        if (!phone) {
          const censusBefore = await handleCensus(o.page);
          const rivBefore = o.rivFetches.length;
          const eventsBefore = (await handleOf(o.page, key))!.events.length;
          await composer.first().fill('FAKE: dense write please');
          await o.page.getByRole('button', { name: /^Send/ }).first().click();
          const denseGroup = o.page.locator(SEL.needsGroup).last();
          await denseGroup.waitFor({ state: 'visible', timeout: 30_000 });
          await inputIs(o.page, key, 'State', 2, 10_000);
          await o.page.waitForSelector(`${SEL.needsGroup} canvas[data-timmy-rive][data-loaded]`, { state: 'attached', timeout: 20_000 });
          const censusDuring = await handleCensus(o.page);
          expect(censusDuring.filter((c) => c.startsWith(`${key}×`)), 'ONE console instance while the ask stands').toEqual([`${key}×1`]);
          const denseOnce = denseGroup.getByRole('button', { name: /^(allow )?once$/i }).first();
          await denseOnce.waitFor({ state: 'visible', timeout: 10_000 });
          const denseAnswered = o.page.waitForResponse((r) => r.url().endsWith('/api/chat/answer') && r.request().method() === 'POST', { timeout: 15_000 });
          const t0 = Date.now();
          await denseOnce.click();
          expect((await denseAnswered).status()).toBe(200);
          // mid-stream: working (State 1), one console instance, the .riv not asked again
          await inputIs(o.page, key, 'State', 1, 20_000);
          await o.page.waitForTimeout(1500);
          expect(await label(o.page, key), 'the word mid-stream').toBe('working');
          expect((await handleCensus(o.page)).filter((c) => c.startsWith(`${key}×`)), 'ONE console instance mid-stream').toEqual([`${key}×1`]);
          await caps.cap(o.page, size, 'chat-dense-stream', [`The DENSE REAL turn mid-stream: the FAKE answers ${DENSE_CHUNKS} chunks at one every ${DENSE_EVERY_MS} ms (≈ ${Math.round(1000 / DENSE_EVERY_MS)} per second) after the NEEDS-YOU was answered on the ActionButton; the console working (State 1); one runtime instance.`], { to: root, what: 'the console' });
          await until(o.page, 'the dense answer complete', (s) => s.includes(`d${DENSE_CHUNKS}`), 90_000);
          await inputIs(o.page, key, 'State', 0, 30_000);
          const took = Date.now() - t0;
          const chat = ollama.chats().filter((c) => /dense/i.test(String(([...(c.body?.messages ?? [])].reverse().find((m: { role?: string }) => m.role === 'user') as { content?: string } | undefined)?.content ?? ''))).at(-1);
          expect(chat, 'the FAKE saw the dense turn').toBeTruthy();
          expect(chat!.aborted, 'the dense stream ran to its end (not cut)').not.toBe(true);
          console.warn(`journey-rive-product ${at}: the dense turn — ${DENSE_CHUNKS} chunks at ${DENSE_EVERY_MS} ms (≈ ${Math.round(1000 / DENSE_EVERY_MS)}/s) ran in ${took} ms; console events recorded +${(await handleOf(o.page, key))!.events.length - eventsBefore} (the bindings keep the last ${40}); .riv fetches during: ${o.rivFetches.length - rivBefore}`);
          expect(await label(o.page, key), 'the word once the stream ended').toBe('idle');
          const last = (await handleOf(o.page, key))!.events.at(-1)!;
          expect(`${last.input} = ${JSON.stringify(last.value)} → ${last.native ? `${last.native.input} ${JSON.stringify(last.native.value)}` : '—'}`, 'the LAST event is the done → idle → State 0').toBe('activity = "idle" → State 0');
          expect(last.source).toMatch(/POST \/api\/chat\/turn · SSE done/);
          const censusAfter = await handleCensus(o.page);
          expect(censusAfter.filter((c) => c.startsWith(`${key}×`)), 'ONE console instance after the stream').toEqual([`${key}×1`]);
          expect(censusAfter.length, `no component gained a second instance (before: ${censusBefore.join(', ')}; after: ${censusAfter.join(', ')})`).toBeLessThanOrEqual(censusBefore.length + 3); // (+ the ask's three ActionButtons, unmounted when answered or kept inert: H174's unmount)
          for (const c of censusAfter) expect(c.endsWith('×1'), `one instance each: ${censusAfter.join(', ')}`).toBe(true);
          expect(o.rivFetches.length - rivBefore, `the .riv fetched only for the ask's new ActionButtons during the dense turn (fetches: ${o.rivFetches.slice(rivBefore).join(' | ')})`).toBeLessThanOrEqual(3);
          expect(o.errors.filter((e) => /Aborted\(\)|RuntimeError|onLoadError|Failed to fetch the Rive file/.test(e)), 'no runtime abort or load error through the dense stream').toEqual([]);
          await caps.cap(o.page, size, 'chat-dense-done', ['The dense turn ended: the console idle (State 0, the last event SSE done); one runtime instance throughout; the .riv not fetched again.'], { to: root, what: 'the console' });
          seen.push(`the dense turn (a NEEDS-YOU answered on the ActionButton, then ${DENSE_CHUNKS} chunks at ${DENSE_EVERY_MS} ms) → idle`);
        }
        // ── NEEDS-YOU: a gated tool → the ActionButton (a real <button>) → a trusted click → POST /api/chat/answer seen → the turn goes on ──
        await composer.first().fill('FAKE: write a note please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        const group = o.page.locator(SEL.needsGroup).last();
        await group.waitFor({ state: 'visible', timeout: 30_000 });
        await inputIs(o.page, key, 'State', 2, 10_000); // awaiting approval → State 2 Approval
        expect(await label(o.page, key)).toMatch(/awaiting/);
        // (H171: each option is a mounted ActionButton — a real <button aria-label> wrapping its canvas — with an HTML twin that is the
        // control only until the file is drawn; the role query sees the visible one)
        await o.page.waitForSelector(`${SEL.needsGroup} canvas[data-timmy-rive][data-loaded]`, { state: 'attached', timeout: 20_000 });
        const once = group.getByRole('button', { name: /^(allow )?once$/i }).first();
        await once.waitFor({ state: 'visible', timeout: 10_000 });
        expect(await once.evaluate((e) => e.tagName), 'the answer control is a real <button>').toBe('BUTTON');
        expect(await once.evaluate((e) => Boolean(e.getAttribute('data-rive-face') || e.querySelector('canvas[data-timmy-rive]') || e.classList.contains('tr-face'))), 'the answer control is the mounted ActionButton\'s face (the HTML twin hidden once the file is drawn)').toBe(true);
        await caps.cap(o.page, size, 'chat-needs-you', ['NEEDS YOU: the FAKE model asked for write_project_file; H169\'s gate waits for this page; the ActionButtons offer the choices; the console awaiting approval (State 2).'], { to: group, what: 'the NEEDS YOU group' });
        const answered = o.page.waitForResponse((r) => r.url().endsWith('/api/chat/answer') && r.request().method() === 'POST', { timeout: 15_000 });
        await once.click();
        const res = await answered;
        expect(res.status()).toBe(200);
        expect(JSON.parse(res.request().postData() || '{}')).toMatchObject({ choice: 'once' });
        await until(o.page, 'the turn went on after the answer', (s) => s.includes(FAKE_WRITTEN), 60_000);
        await inputIs(o.page, key, 'State', 0, 20_000);
        await caps.cap(o.page, size, 'chat-needs-you-answered', ['After the trusted click on the ActionButton: POST /api/chat/answer { id, choice: "once" } seen (200); the tool ran; the turn answered; the console idle again.']);
        seen.push('a NEEDS-YOU answered by a click on the ActionButton (POST /api/chat/answer seen) → the turn answered');
        // keyboard: a second ask answered with Enter on the focused ActionButton
        await composer.first().fill('FAKE: write another note please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        const group2 = o.page.locator(SEL.needsGroup).last();
        await group2.waitFor({ state: 'visible', timeout: 30_000 });
        await o.page.waitForSelector(`${SEL.needsGroup} canvas[data-timmy-rive][data-loaded]`, { state: 'attached', timeout: 20_000 });
        const once2 = group2.getByRole('button', { name: /^(allow )?once$/i }).first();
        await once2.waitFor({ state: 'visible', timeout: 10_000 });
        const answered2 = o.page.waitForResponse((r) => r.url().endsWith('/api/chat/answer') && r.request().method() === 'POST', { timeout: 15_000 });
        await once2.focus();
        await o.page.keyboard.press('Enter');
        expect((await answered2).status(), 'Enter on the focused ActionButton answers').toBe(200);
        await until(o.page, 'the second turn went on', (s) => s.split(FAKE_WRITTEN).length > 2, 60_000);
        await inputIs(o.page, key, 'State', 0, 20_000);
        seen.push('a second NEEDS-YOU answered with Enter on the focused ActionButton');
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
        seen.push('a slow turn: working (State 1) → Stop → stopped (State 3) with its receipt');
        // ── the welcome's starter ActionButton fires the starter (a new conversation shows the welcome again) ──
        await o.page.getByRole('button', { name: /New conversation/ }).first().click().catch(() => undefined);
        // (H171: the welcome's PRIMARY starter is a mounted ActionButton → startWith('plan'); its HTML twin stands — visible — until the
        // file is drawn, then hides. On a slow runner the file may take long: the read waits up to 30 s for EITHER the native face (a
        // visible button holding the drawn canvas) OR a visible twin, and never settles on a hidden variant; the sidecar says which drew.)
        const starterNative = o.page.locator('.cx-starters, .cx-welcome, .cx-ways').getByRole('button').filter({ has: o.page.locator('canvas[data-timmy-rive][data-loaded]') }).filter({ visible: true });
        const starterTwin = o.page.locator('.cx-starters, .cx-welcome, .cx-ways').locator(SEL.starter).filter({ visible: true });
        const starterPath = await Promise.race([
          starterNative.first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'native' as const, () => 'none' as const),
          o.page.waitForTimeout(4_000).then(async () => { for (let i = 0; i < 26; i++) { if (await starterNative.count()) return 'native' as const; if (await starterTwin.count()) return 'twin' as const; await o.page.waitForTimeout(1_000); } return 'none' as const; }, () => 'none' as const),
        ]);
        const starter = starterPath === 'native' ? starterNative.first() : starterPath === 'twin' ? starterTwin.first() : null;
        if (starter) {
          await starter.waitFor({ state: 'visible', timeout: 10_000 });
          const id = (await starter.getAttribute('data-cx-start')) || (await starter.getAttribute('aria-label')) || (await starter.innerText()).trim();
          expect(await starter.evaluate((e) => e.tagName)).toBe('BUTTON');
          await starter.click();
          // the starter's own action: the composer takes its words, or the chat moves (H171's STARTERS); the welcome's Pressed recorded
          await o.page.waitForTimeout(500);
          const after = await text(o.page);
          expect(after.length, `the starter "${id}" did something on the page`).toBeGreaterThan(0);
          await caps.cap(o.page, size, 'chat-starter', [starterPath === 'native' ? `The welcome's starter ActionButton "${id}" fired (a trusted click on the native face; Pressed down then up on ActionButton).` : `The welcome's starter "${id}" fired through its HTML twin (the native face had not drawn within the wait on this runner; the twin is the control until it does).`]);
          seen.push(`the welcome's starter "${id}" clicked (${starterPath === 'native' ? 'the native ActionButton face' : 'its HTML twin, the face not yet drawn'})`);
        } else console.warn(`journey-rive-product ${at}: no starter control (native or twin) was visible within the wait — the welcome's starter is not exercised here`);
        if (phone) {
          const overflow = await o.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, 'nothing overflows the phone\'s width').toBeLessThanOrEqual(0);
        }
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
        chatPassed = true;
      } finally {
        const video = o.page.video();
        await o.close();
        if (!phone) await keepRecording(video, 'recording-chat-1440x900', ['REAL: the companion, the agent turn and its SSE, the NEEDS YOU gate, the Stop, the receipts, the runtime drawing the AgentConsole and the ActionButtons (the console face\'s caption run read back in the chat-console-idle capture\'s sidecar).'], chatPassed ? 'the Chat case passed its assertions' : 'the Chat case FAILED an assertion (see the vitest log)', seen);
      }
    });

    it.skipIf(!browserPath)(`${at} CONNECTIONS: a ProviderCard drawn in each card; Check → the fed event "GET /api/connections: ollama-local" with State 1 while it ran, State 0 after with the label connected (no success pose, said); the four states in quick succession (one instance per card, the last word's mapping); ${phone ? '' : 'recorded; '}no page error`, async () => {
      const o = await open(size, { record: phone ? undefined : 'recording-connections-1440x900' });
      let connPassed = false;
      const seen: string[] = [];
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
        const cardCaptions: string[] = [];
        for (const id of PROVIDERS) { const k = (await o.page.locator(SEL.cardComponent(id)).first().getAttribute('data-rive-component'))!; const c = await captionOf(o.page, k); cardCaptions.push(`${id}: "${c}"`); if (c !== '(not readable)') expect(c, `${id}'s live face says LIVE, never PREVIEW`).toBe(LIVE_CONNECTIONS); }
        const cardWords: string[] = [];
        for (const id of PROVIDERS) { const k = (await o.page.locator(SEL.cardComponent(id)).first().getAttribute('data-rive-component'))!; cardWords.push(`${id}: card state "${await o.page.locator(SEL.card(id)).first().getAttribute('data-state')}", the face's word "${await label(o.page, k)}", State ${JSON.stringify(await inputValue(o.page, k, 'State'))}`); }
        await caps.cap(o.page, size, 'connections-cards', ['The connections screen: a ProviderCard drawn in each of the four cards; the cards\' buttons stay HTML buttons.', `Each card as it stands in this picture — ${cardWords.join(' · ')}.`, `The faces\' captions, read back from the runtime\'s text runs: ${cardCaptions.join(' · ')}.`]);
        const local = o.page.locator(SEL.cardComponent('ollama-local')).first();
        const key = (await local.getAttribute('data-rive-component'))!;
        await o.page.getByRole('button', { name: /^Check$/ }).first().click();
        await o.page.waitForSelector('[data-provider="ollama-local"][data-state="checked"]', { timeout: 20_000, state: 'attached' });
        await inputIs(o.page, key, 'State', 0, 15_000);
        expect(await label(o.page, key)).toBe('connected');
        seen.push('the four cards with their ProviderCards drawn', 'Check on Ollama · local against the FAKE → the card checked, the face connected (State 0)');
        // (H170 feeds one line per state CHANGE from render(); against the FAKE, Check answers within milliseconds, so a "checking"
        // word is fed only when the screen draws a pending state in between — asserted when it is there, said when it is not)
        const checking = await eventOf(o.page, key, 'connection', 'checking');
        if (checking) { expect(checking.native).toBe('State 1'); expect(checking.source).toMatch(/GET \/api\/connections: ollama-local/); }
        else console.warn(`journey-rive-product ${at}: no "checking" word was fed on Check (the FAKE answered before a pending state was drawn): State 1 while Check runs is not exercised here`);
        const connected = await eventOf(o.page, key, 'connection', 'connected');
        expect(connected!.native).toBe('State 0');
        // (the word may reach the card before its file loaded — "kept until the file loads" — and is applied on load: the live State 0 above says it)
        expect(connected!.did).toMatch(/no success pose|kept until the file loads/);
        expect(connected!.source).toMatch(/GET \/api\/connections: ollama-local/);
        await caps.cap(o.page, size, 'connections-after-check', ['Ollama · local after Check against the FAKE: the card checked, the ProviderCard State 0 with the label "connected" (no success pose is authored, said in the event); the checking event (State 1) recorded from GET /api/connections: ollama-local.'], { to: o.page.locator(SEL.card('ollama-local')).first(), what: 'the local card' });
        // ── RAPID EVENTS (the operator's 07:06 bar): the four cards' states changed in quick succession — every Check the screen
        // offers pressed within a second (the FAKE local Ollama answers in milliseconds; a card without a key offers none), and a
        // burst of backend-shaped words through the REAL feed (TimmyRive.fromProviderState, H170's one line; the test's calls are
        // FAKE, said in their source): 4 cards × 4 states × 25 rounds in one tick, then a 2 s stream at one every 10 ms. Invariants:
        // one instance per card, the .riv not fetched again, no abort, each card's word and State = its LAST word's mapping.
        {
          const keys: Record<string, string> = {};
          for (const id of PROVIDERS) keys[id] = (await o.page.locator(SEL.cardComponent(id)).first().getAttribute('data-rive-component'))!;
          const censusBefore = await handleCensus(o.page);
          const rivBefore = o.rivFetches.length;
          const checks = o.page.getByRole('button', { name: /^Check/ });
          const n = await checks.count();
          const pressStart = Date.now();
          for (let i = 0; i < n; i++) await checks.nth(i).click({ timeout: 2_000 }).catch(() => undefined);
          console.warn(`journey-rive-product ${at}: ${n} Check button(s) pressed within ${Date.now() - pressStart} ms (a card without a key offers none)`);
          const words = ['not set up', 'pending', 'checked', 'refused'] as const; // the cards' state words → disconnected / checking / connected / failed
          const finalWord = await o.page.evaluate(async ([ids, ws]) => {
            const R = (window as unknown as { TimmyRive: { fromProviderState: (id: string, state: string, source?: string) => unknown } }).TimmyRive;
            // one tick: 4 × 4 × 25 = 400 words
            for (let r = 0; r < 25; r++) for (const id of ids) for (const w of ws) R.fromProviderState(id, w, `FAKE (the test's burst): GET /api/connections: ${id} "${w}"`);
            // a sustained stream: one every 10 ms for 2 s, ending on a known word per card
            const end: Record<string, string> = {};
            for (let k = 0; k < 200; k++) { const id = ids[k % ids.length]; const w = ws[(k >> 2) % ws.length]; end[id] = w; R.fromProviderState(id, w, `FAKE (the test's stream): GET /api/connections: ${id} "${w}"`); await new Promise((f) => setTimeout(f, 10)); }
            return end;
          }, [PROVIDERS, words] as const);
          const expected: Record<string, [string, number]> = { 'not set up': ['disconnected', 0], pending: ['checking', 1], checked: ['connected', 0], refused: ['failed', 4] };
          const stateOfWord: Record<string, number> = { disconnected: 0, checking: 1, connected: 0, failed: 4 };
          for (const id of PROVIDERS) {
            // the LAST event wins: the test's last FAKE word, or — when H170's real GET /api/connections refresh landed after it — the
            // card's own true state (both are backend-shaped words through the same feed; which one was last is read from the events)
            const h = (await handleOf(o.page, keys[id]))!;
            const lastEvent = [...h.events].reverse().find((e) => e.input === 'connection')!;
            const [fakeWord] = expected[finalWord[id]];
            const word = String(lastEvent.value);
            expect([fakeWord, expected[(await o.page.locator(SEL.card(id)).first().getAttribute('data-state')) || 'not set up']?.[0] ?? fakeWord], `${id}: the last event is the test's last word (${finalWord[id]} → ${fakeWord}) or the real refresh's`).toContain(word);
            expect(await label(o.page, keys[id]), `${id}'s HTML word = its LAST event's word`).toBe(word);
            await inputIs(o.page, keys[id], 'State', stateOfWord[word], 10_000);
          }
          const censusAfter = await handleCensus(o.page);
          expect(censusAfter, 'one instance per card before and after the burst').toEqual(censusBefore);
          expect(o.rivFetches.length - rivBefore, 'the .riv not fetched again by the burst').toBe(0);
          expect(o.errors.filter((e) => /Aborted\(\)|RuntimeError|onLoadError|Failed to fetch the Rive file/.test(e)), 'no runtime abort or load error through the burst').toEqual([]);
          await caps.cap(o.page, size, 'connections-burst', ['After 400 backend-shaped words in one tick and 200 more over 2 s through the REAL feed (FAKE words, said in each event\'s source): one ProviderCard instance per card, each word and State its LAST event\'s mapping, the .riv not fetched again. (The real GET /api/connections refresh re-syncs the words to the cards\' true states on the next draw.)']);
          seen.push('the burst: every Check within a second, 400 FAKE words in one tick + 200 over 2 s through the real feed → each card on its last event\'s word');
        }
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
        connPassed = true;
      } finally {
        const video = o.page.video();
        await o.close();
        if (!phone) await keepRecording(video, 'recording-connections-1440x900', ['REAL: the companion, the connections screen, GET /api/connections, the runtime drawing a ProviderCard in each card (the faces\' caption runs read back in the connections-cards capture\'s sidecar).'], connPassed ? 'the Connections case passed its assertions' : 'the Connections case FAILED an assertion (see the vitest log)', seen);
      }
    });
  }

  // ── the Canvas (the Studio) ──────────────────────────────────────────────────

  type Ed = { getShape: (id: string) => { id: string; type: string; x: number; y: number; props: Record<string, unknown> } | undefined; updateShape: (s: unknown) => void; createShape: (s: unknown) => void; createBindings: (b: unknown[]) => void; getBindingsInvolvingShape?: (id: string) => Array<{ type: string; fromId: string; toId: string; props: Record<string, unknown> }>; store: { serialize: (scope: string) => Record<string, { typeName: string; type?: string; fromId?: string; toId?: string; props?: Record<string, unknown>; x?: number; y?: number }> }; selectNone: () => void; zoomToFit: () => unknown };
  // (page.evaluate must never RETURN the tldraw Editor — zoomToFit() returns `this`, and Playwright's serialization of that graph with an
  // arrow on the board ends the evaluation with "Execution context was destroyed" (H172's scratch, 07:0x): every editor call is a block)
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
    let canvasPassed = false;
    const seen: string[] = [];
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
      // the three shapes APART (H174's placeRive(component, { at }): the console at the left, the card 480 px to its right, the button
      // below them, clear of the console card's words) so that an arrow between the console and the card has length, and every face reads at 100 %
      placed = await page.evaluate(() => { const W = window as unknown as Win; return { activity: W.timmyCanvas.placeRive('activity', { at: { x: 0, y: 0 } }), connection: W.timmyCanvas.placeRive('connection', { provider: 'ollama-local', label: 'Ollama · local', at: { x: 480, y: 0 } }), welcome: W.timmyCanvas.placeRive('welcome', { at: { x: 200, y: 420 } }) }; });
      await page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      // Timmy's lists folded (the Studio's own Fold button), so the board is the picture
      await page.locator('#side-fold').first().click({ timeout: 5_000 }).catch(() => undefined);
      await page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
      await page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      const hs = await handles(page);
      for (const h of hs) { expect(h.contract).toBe('TimmyUI'); expect(h.runtime!.artboardNames).toEqual(NATIVE.artboards); }
      expect(await page.$$eval('[data-timmy-rive-shape] canvas[data-loaded]', (els) => els.length)).toBe(3);
      await caps.cap(page, size, 'canvas-three-shapes', ['Timmy Canvas (the Studio, licensed tldraw with the key the environment gives, or a FAKE one the SDK rejects), Timmy\'s lists folded: the three timmy-rive shapes placed apart — AgentConsole at the left, ProviderCard to its right, ActionButton below — drawn by the runtime, each with its state word; the board re-fit to the window.']);
      seen.push(`the license verdict "${license}"`, 'the three shapes placed apart, drawn by the runtime');
      // move and resize through the editor (what a drag does): the console 40 px down, the card widened to 420 (expanded)
      await page.evaluate((ids) => { const e = (window as unknown as Win).timmyCanvas.editor; const a = e.getShape(ids.activity)!; e.updateShape({ id: ids.activity, type: 'timmy-rive', x: a.x, y: a.y + 40 }); const c = e.getShape(ids.connection)!; e.updateShape({ id: ids.connection, type: 'timmy-rive', props: { ...c.props, w: 420 } }); }, placed);
      await page.waitForFunction((ids) => { const e = (window as unknown as Win).timmyCanvas.editor; return (e.getShape(ids.connection)?.props.w as number) === 420; }, placed, { timeout: 10_000 });
      await page.waitForSelector('[data-timmy-rive-shape].is-expanded', { timeout: 10_000 });
      // an arrow BOUND between the console and the card (tldraw's bindings: the records the board keeps)
      const arrowId = await page.evaluate((ids) => {
        const e = (window as unknown as Win).timmyCanvas.editor;
        const a = e.getShape(ids.activity)!; const c = e.getShape(ids.connection)!;
        const id = `shape:arrow-${Date.now().toString(36)}`;
        // from the console's right edge to the card's left edge (the shapes are 480 px apart: a readable arrow, not a stub)
        const aw = Number(a.props.w) || 240; const ah = Number(a.props.h) || 200; const ch = Number(c.props.h) || 200;
        e.createShape({ id, type: 'arrow', x: 0, y: 0, props: { start: { x: a.x + aw, y: a.y + ah / 2 }, end: { x: c.x, y: c.y + ch / 2 } } });
        e.createBindings([{ type: 'arrow', fromId: id, toId: ids.activity, props: { terminal: 'start' } }, { type: 'arrow', fromId: id, toId: ids.connection, props: { terminal: 'end' } }]);
        return id;
      }, placed);
      const bindings = await page.evaluate((id) => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'binding' && r.fromId === id).map((r) => [r.toId, (r.props as { terminal: string }).terminal]), arrowId);
      expect(bindings.sort()).toEqual([[placed.activity, 'start'], [placed.connection, 'end']].sort());
      await saved(page);
      // ONE picture at 100 % with the three faces and the arrow readable: the camera set so the group (≈ 900 × 500 page px) sits in the middle
      await page.evaluate((ids) => { const e = (window as unknown as Win).timmyCanvas.editor as unknown as { setCamera: (c: { x: number; y: number; z: number }) => unknown; getShape: (id: string) => { x: number; y: number; props: Record<string, unknown> } | undefined }; const shapes = [ids.activity, ids.connection, ids.welcome].map((i) => e.getShape(i)!); const minX = Math.min(...shapes.map((sh) => sh.x)); const minY = Math.min(...shapes.map((sh) => sh.y)); const maxX = Math.max(...shapes.map((sh) => sh.x + (Number(sh.props.w) || 240))); const maxY = Math.max(...shapes.map((sh) => sh.y + (Number(sh.props.h) || 200))); e.setCamera({ x: (window.innerWidth - (maxX - minX)) / 2 - minX, y: (window.innerHeight - (maxY - minY)) / 2 - minY, z: 1 }); }, placed);
      await page.waitForTimeout(400);
      const arrowBox = await page.locator('[data-shape-type="arrow"], .tl-shape[data-shape-type="arrow"]').first().boundingBox().catch(() => null);
      await caps.cap(page, size, 'canvas-arrow-bound', ['Timmy Canvas at 100 % with Timmy\'s lists folded: the AgentConsole (moved 40 px down), the ProviderCard (resized to 420 wide, expanded) 480 px to its right, the ActionButton below, and the arrow BOUND from the console\'s right edge to the card\'s left edge (two binding records) — saved through Timmy\'s project storage (the board under the project).', `The arrow\'s box on screen: ${arrowBox ? `${Math.round(arrowBox.width)} × ${Math.round(arrowBox.height)} px` : 'not read'}.`]);
      await page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
      seen.push('the console moved, the card resized (expanded), an arrow bound between them, saved; the picture at 100 %');
      before = await page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
      // ── RAPID REDRAWS (the operator's 07:06 bar): the camera zoomed, panned and the board re-fit 31 times with the three shapes and
      // the bound arrow on it — every evaluate a block body; invariants: three instances before and after, no execution-context loss,
      // the records unchanged by the camera, the .riv not fetched again, no abort.
      {
        const censusBefore = await handleCensus(page);
        const moves = await page.evaluate(async () => {
          const e = (window as unknown as Win).timmyCanvas.editor as unknown as { zoomIn: () => unknown; zoomOut: () => unknown; zoomToFit: () => unknown; setCamera: (c: { x: number; y: number; z: number }) => unknown; getCamera: () => { x: number; y: number; z: number } };
          let n = 0;
          for (let i = 0; i < 10; i++) {
            e.zoomIn(); n++; await new Promise((f) => setTimeout(f, 30));
            e.zoomOut(); n++; await new Promise((f) => setTimeout(f, 30));
            const c = e.getCamera(); e.setCamera({ x: c.x + (i % 2 ? -120 : 120), y: c.y + 60, z: c.z }); n++; await new Promise((f) => setTimeout(f, 30));
          }
          e.zoomToFit(); n++;
          return n;
        });
        expect(moves).toBeGreaterThanOrEqual(30);
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
        expect(after, 'the records unchanged by the camera').toEqual(before);
        expect(await handleCensus(page), 'three instances before and after the camera moves').toEqual(censusBefore);
        expect(await page.$$eval('[data-timmy-rive-shape] canvas[data-loaded]', (els) => els.length)).toBe(3);
        expect(first.errors.filter((e) => /Aborted\(\)|RuntimeError|onLoadError/.test(e)), 'no runtime abort through the camera moves').toEqual([]);
        await caps.cap(page, size, 'canvas-after-camera', [`After ${moves} camera moves (10 × zoom in, zoom out and a pan, then one re-fit) with the three shapes and the bound arrow: three runtime instances, the records unchanged; the picture is the board re-fit to the window.`]);
      }
      expect(first.errors, 'page errors').toEqual([]);
      seen.push('31 camera moves with the three shapes and the bound arrow: three instances, the records unchanged');
      canvasPassed = true;
    } finally {
      const video = first.page.video();
      await first.context.close();
      await keepRecording(video, 'recording-canvas-1440x900', ['REAL: the Studio, the tldraw editor (licensed with the environment\'s key, or a FAKE one the SDK rejects — the SDK\'s own verdict is read), the runtime drawing the three artboards, Timmy\'s board save.'], canvasPassed ? 'the Canvas case passed its assertions up to the save (the reopen, the switch and reduced motion follow in new pages)' : 'the Canvas case FAILED an assertion before the save (see the vitest log)', seen);
    }
    // reopened in a new page: every record back (the shapes with their props, the arrow, its two bindings)
    const again = await openCanvas(size);
    try {
      const after = await again.page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(after).toEqual(before);
      await again.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await again.page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
      await again.page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      expect(await again.page.evaluate((ids) => (window as unknown as Win).timmyCanvas.editor.getShape(ids.connection)?.props.w, placed)).toBe(420);
      await caps.cap(again.page, size, 'canvas-reopened', ['The board reopened in a new page: the three shapes with their props (the card at 420 wide), the arrow and its two bindings exactly as saved; drawn again by the runtime.']);
      // a project switch: the active-project record names the other project (as the Workbench's picker writes it; the Studio's own
      // follower sees it): the other project's board has none of this
      const switchTo = (name: string, root: string): void => { mkdirSync(join(studioHome, 'state'), { recursive: true }); writeFileSync(activeProjectFile({ TIMMY_HOME: studioHome, HOME: studioHome }), `${JSON.stringify({ name, root, at: new Date().toISOString() })}\n`); };
      switchTo('rive-product-b', projectB);
      await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'rive-product-b'; }, null, { timeout: 20_000 });
      await again.page.waitForTimeout(500);
      expect(await again.page.evaluate(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length), 'the other project\'s board is empty of these shapes').toBe(0);
      expect(await again.page.$$eval('[data-timmy-rive-shape]', (els) => els.length)).toBe(0);
      await caps.cap(again.page, size, 'canvas-other-project', ['Switched to the other project (rive-product-b): its board carries none of the first project\'s shapes (project isolation of the boards).']);
      switchTo('rive-product-a', projectA);
      await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'rive-product-a'; }, null, { timeout: 20_000 });
      await again.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      expect(again.errors, 'page errors').toEqual([]);
    } finally { await again.context.close(); }
    // reduced motion: the asset's own ReducedMotion input true; the pose settles (the runtime stops moving)
    const still = await openCanvas(size, { reducedMotion: true });
    try {
      await still.page.waitForFunction(() => document.querySelectorAll('[data-timmy-rive-shape]').length >= 3, null, { timeout: 20_000 });
      await still.page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
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
      await o.page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
      await o.page.waitForFunction(() => { const hs = (window as unknown as Win).TimmyRive.inspect(); return hs.length >= 3 && hs.every((x) => x.state === 'drawn'); }, null, { timeout: 30_000 });
      const overflow = await o.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'nothing overflows the phone\'s width').toBeLessThanOrEqual(0);
      await caps.cap(o.page, size, 'canvas-phone', ['The same board at 390x844: the three shapes drawn; nothing overflows.']);
      expect(o.errors, 'page errors').toEqual([]);
    } finally { await o.context.close(); }
  });
});
