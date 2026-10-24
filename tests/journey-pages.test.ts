/**
 * R11 round 7 (H172; the operator's order of 13:40 PT 2026-10-24, "Timmy — finish the product experience"): every major page of the
 * browser companion on H175's shell, reached as a person reaches it (the rail; on a phone the rail sheet; Settings through Help & find), in a real
 * headless Chromium at 1440x900 and 390x844, FROM THE RUNNING COMPANION AND STUDIO — never a mock, never the study's HTML.
 *
 * What is read on every page (D4, the scaffold): the kicker "NN / VERB PHRASE" · the title · the one-line description · the PRIMARY
 * NEXT ACTION · the summary band (Workspace / project · Model · Records + the one action) · the work · the context · the task dock ·
 * the records; a state with a verb-led next action; nothing wider than the viewport; no page error; nothing leaving 127.0.0.1.
 * And per page what it is for: Chat (the composer reachable, the Models context, the native console when mounted), Models & accounts
 * (the four provider cards; Check against the FAKE Ollama → its model listed), Canvas (the companion's page, and the Studio's tldraw
 * canvas opened — the SDK's own license verdict; a guided blank starter drawn, saved, reopened; a project switch), Files, Workflows,
 * Runs & receipts, VoxVision, Motion & 3D, Tools & integrations, Control Room, Settings, Help.
 * Then: the keyboard (Tab from the rail reaches the page's primary action and the composer; Escape closes a menu or a sheet and gives
 * the focus back; no trap), the phone's sheets (D5), 125 % zoom (1152x720 at a device scale of 1.25 = a 1440x900 window zoomed),
 * 1280x720 checked, reduced motion, a project switch through the rail's project menu.
 *
 * Phase A (the lead's checkpoint 1) is the three pages Chat, Models & accounts, Canvas: TIMMY_JOURNEY_PAGES="Chat,Models & accounts,Canvas"
 * limits the pages run; unset, every page runs (Phase B).
 *
 * FAKE here, named in every sidecar: the identity provider (an RSA pair made by the test; its public key is CLERK_JWT_KEY; the session
 * minted by the test, verified by the REAL verifier), the Ollama on 127.0.0.1 (no model behind it: one tool call, then a fixed
 * answer), the tldraw license key when the environment has none (a string the SDK rejects, so the SDK's own verdict is asserted).
 * REAL: the companion, the Studio, their routes, the agent turn, the receipts, the project storage, the runtime and the asset.
 * INSTALLED: with TIMMY_INSTALLED_ROOT the servers are the installed package's own dist (as in journey-rive-product); the sidecars say so.
 *
 * CONTRACT: the selectors in SHELL below are this test's reading of H175's SHELL CONTRACT v1 as posted in HANDOFF.md (the page
 * scaffold `section.page` with head / work / context / dock / records; the theme attribute; the mobile sheets; Help & find) — ADJUSTED
 * TO THE POSTED LINE; until a piece lands, its step fails with words naming it (H175's SHELL CONTRACT v1: <the piece>).
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
import { activeProjectFile } from '../src/studio/active-follow.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';
import { capturer, revisionOf } from './fixtures/journey-caps.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

// ── the servers: the installed package (TIMMY_INSTALLED_ROOT) or this checkout ──────────────────────────────────────────────────
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
/** The installed package's own words of itself (its name@version, its build-info, the tarballs' sha256 when named), or "this checkout". */
function installedWords(): string[] {
  if (!INSTALLED) return ['Servers: this checkout\'s sources (a worktree dev server), NOT the installed package.'];
  const out: string[] = [];
  try { const pkg = JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')) as { name?: string; version?: string }; out.push(`Servers: THE INSTALLED PACKAGE ${pkg.name ?? '?'}@${pkg.version ?? '?'} (TIMMY_INSTALLED_ROOT: the tarball installed into a temp prefix; its own dist/src/companion/server.js and dist/src/studio/server.js started on 127.0.0.1).`); } catch { out.push('Servers: the installed package (its package.json could not be read).'); }
  try { const info = JSON.parse(readFileSync(join(INSTALLED, 'dist', 'build-info.json'), 'utf8')) as Record<string, unknown>; out.push(`Package build: ${JSON.stringify(info).slice(0, 300)}`); } catch { out.push('Package build: no dist/build-info.json in the installed package.'); }
  for (const [label, name] of [['Tarball', 'TIMMY_INSTALLED_TARBALL'], ['Review package', 'TIMMY_INSTALLED_REVIEW']] as const) {
    const p = process.env[name]?.trim();
    if (p) { try { out.push(`${label}: ${p.split('/').pop()} · sha256 ${createHash('sha256').update(readFileSync(p)).digest('hex')}`); } catch { out.push(`${label}: ${p.split('/').pop()} (not readable for its sha256)`); } }
  }
  return out;
}

// ── THE CONTRACT: H175's SHELL CONTRACT v1 (review/SHELL-CONTRACT-v1.md, 14:23 PT; accepted by the lead 14:24) ───────────────
const SHELL = {
  /** §3.1 the ONE rail (D3): aside#shell-rail.nav-rail; nav#rail-menu .rail-item[data-page][data-dest] with .rail-label; aria-current="page" on the shown */
  rail: '#shell-rail',
  railItem: (id: string): string => `#rail-menu .rail-item[data-page="${id}"]`,
  groups: ['WORK', 'CREATE', 'CONNECT'],
  /** §2.1 the shown page: ONE section.page[data-page] per destination inside main#ws-main; body[data-page] is the attribute to wait on (§6) */
  shown: 'section.page[data-page]:not([hidden])',
  /** §2.2 the regions, in order */
  head: 'header.page-head',
  kicker: '.page-kicker',
  title: 'h1.page-title',
  description: 'p.page-intro',
  primary: '.page-primary',
  summary: '.page-band',
  work: '.page-work',
  context: 'aside.page-context',
  dock: '.page-dock',
  records: '.page-records',
  /** §3.2 the topbar: the theme switch (two buttons [data-theme], aria-pressed) sets html[data-theme]; amber is also the default without the attribute (§1.2) */
  themeSwitch: '.theme-switch [data-theme]',
  topbar: '#shell-top',
  /** §4 a phone (≤ 720 px): #shell-menu opens the rail sheet (.nav-rail.is-open, role=dialog aria-modal); the context is a sheet (.page-context.is-open) opened by .page-context-btn */
  menuButton: '#shell-menu',
  railSheet: '.nav-rail.is-open, #shell-rail[role="dialog"]',
  contextButton: '.page-context-btn',
  contextSheet: '.page-context.is-open',
  /** §5 Help & find: the rail's button #shell-help, the <dialog> #shell-help-dialog (⌘K / ?); Settings is reached from it or the account block (D3 amended) */
  helpButton: '#shell-help',
  helpDialog: '#shell-help-dialog',
  /** the account block (the rail's foot): ids unchanged (chat-shell.js writes them) */
  account: '#rail-account',
  /** the rail's project (ids unchanged) */
  projectButton: '#rail-project',
  projectMenu: '#rail-project-menu',
};
/** D3's destinations (the names as they are; the page ids of §2.1); Settings is reached from Help & find (not a rail item). */
const PAGES: Array<{ id: string; name: string; group: string; phaseA: boolean; via: 'rail' | 'help' }> = [
  { id: 'chat', name: 'Chat', group: '', phaseA: true, via: 'rail' },
  { id: 'files', name: 'Files', group: 'WORK', phaseA: false, via: 'rail' },
  { id: 'workflows', name: 'Workflows', group: 'WORK', phaseA: false, via: 'rail' },
  { id: 'runs', name: 'Runs & receipts', group: 'WORK', phaseA: false, via: 'rail' },
  { id: 'canvas', name: 'Canvas', group: 'CREATE', phaseA: true, via: 'rail' },
  { id: 'voxvision', name: 'VoxVision', group: 'CREATE', phaseA: false, via: 'rail' },
  { id: 'motion', name: 'Motion & 3D', group: 'CREATE', phaseA: false, via: 'rail' },
  { id: 'connections', name: 'Models & accounts', group: 'CONNECT', phaseA: true, via: 'rail' },
  { id: 'tools', name: 'Tools & integrations', group: 'CONNECT', phaseA: false, via: 'rail' },
  { id: 'control', name: 'Control Room', group: '', phaseA: false, via: 'rail' },
  { id: 'settings', name: 'Settings', group: 'foot', phaseA: false, via: 'help' },
];
const RAIL_PAGES = PAGES.filter((p) => p.via === 'rail');
const ONLY = (process.env.TIMMY_JOURNEY_PAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RUN = ONLY.length ? PAGES.filter((p) => ONLY.includes(p.name)) : PAGES;
const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const PROVIDERS = ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'];
/** the composer's label or placeholder (H171's words; the study's "What would you like to work on?" accepted as well) */
const COMPOSER = /Message Timmy|What would you like to work on|Your direction/i;

const caps = capturer('tests/journey-pages.test.ts', [
  'REAL: the companion and the Studio (started in this process), their launch tokens and pages, the identity verifier (RS256 against CLERK_JWT_KEY), the projects / connections / chat / canvas routes, the agent turn and its receipts, the project storage, @rive-app/canvas served from this origin and the operator\'s timmy-ui.riv where a page mounts a face.',
  'FAKE on 127.0.0.1, said: the identity provider (an RSA pair made by the test; the session minted by the test), the Ollama (no model behind it: one tool call then a fixed answer), the tldraw license key when the environment has none (a string the SDK rejects). No real Ollama, no Clerk account, no network: Chromium resolves no host but 127.0.0.1.',
  ...installedWords(),
  `Tests head: ${revisionOf()} (this checkout); the product tree: ${INSTALLED ? 'the installed package\'s build-info revision above' : 'this checkout at the same revision'}.`,
], 'product/pages');

const PORT = 4510;
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'd7'.repeat(32);
const USER = fakeUserId('pages');
/** a second FAKE user whose Ollama address is a closed port (nothing listens on 127.0.0.1:9 here: the card's "unreachable" state) */
const USER_UNREACHABLE = fakeUserId('pagesunreachable');
const UNREACHABLE_OLLAMA = 'http://127.0.0.1:9';
const MODEL = 'fake-qwen3:8b';
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
const FAKE_ERROR = 'FAKE error: llama runner process has terminated (no model behind this; the FAKE\'s error script)';
/** FAKE: a cloud key pasted on the Models & accounts page; its value must reach no screen and no DOM afterwards */
const FAKE_CLOUD_KEY = `FAKE-ollama-cloud-key-${'p'.repeat(24)}`;
const OTHER_PROJECT = 'pages-second-project';
/** the sidecar's first line (H168's rubric §13): page · state · FAKE/REAL */
const line = (page: string, state: string): string => `PAGE ${page} · STATE ${state} · FAKE identity + FAKE Ollama on 127.0.0.1, REAL companion${INSTALLED ? ' (THE INSTALLED PACKAGE)' : ' (this checkout)'}`;
const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p as string));
if (!browserPath) console.warn('journey-pages: no Chromium found, so the browser legs are skipped here (said, not passed)');

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
let realKey = false;
const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_MCP_HOME', 'TIMMY_STORE', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL', 'TIMMY_REPO'];

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  box = mkdtempSync(join(tmpdir(), 'journey-pages-'));
  timmyHome = join(box, 'home', 'timmy');
  mkdirSync(timmyHome, { recursive: true });
  ollama = await startFakeOllamaJourney({
    models: [{ name: MODEL, size: 4_900_000_000, family: 'qwen3', parameterSize: '8B' }],
    tool: { name: 'get_current_time', arguments: {} },
    answer: FAKE_ANSWER,
    slow: { when: /slowly/i, words: 'FAKE slow answer one word at a time so that Stop can end it before it is done'.split(' '), slowMs: 700 },
    // the error script (H168's rubric §13: "a failed turn"): the FAKE answers a request that says "fail" with Ollama's own error shape
    fail: { when: /fail/i, status: 500, error: FAKE_ERROR },
  });
  identity = fakeIdentityProvider({ azp: `http://127.0.0.1:${PORT}` });
  const userHome = join(timmyHome, 'users', USER);
  mkdirSync(userHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(userHome, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }), { mode: 0o600 });
  // a second user whose Ollama address is a closed port on 127.0.0.1 (H168's §13: "unreachable"): nothing listens there
  const user2Home = join(timmyHome, 'users', USER_UNREACHABLE);
  mkdirSync(user2Home, { recursive: true, mode: 0o700 });
  writeFileSync(join(user2Home, 'providers.json'), JSON.stringify({ ollama_host: UNREACHABLE_OLLAMA }), { mode: 0o600 });
  const env = identity.env({ ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: '', OLLAMA_HOST: ollama.url });
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete env[k];
  Object.assign(process.env, env);
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete process.env[k];
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const sv = await servers();
  companion = await sv.startCompanionServer(PORT, { token: TOKEN, chatEnv: env, workspace: { env, shareMs: 0 } });
  // the Studio (Timmy Canvas): the real server; the bundle built here from this checkout (the installed package serves its own)
  studioRoot = mkdtempSync(join(tmpdir(), 'journey-pages-studio-'));
  studioHome = mkdtempSync(join(tmpdir(), 'journey-pages-home-'));
  if (!INSTALLED) {
    copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(studioRoot, 'index.html'));
    const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
    await buildCanvas(repo, join(studioRoot, 'dist'), { licenses: studioRoot });
  }
  realKey = Boolean(process.env.TLDRAW_LICENSE_KEY?.trim());
  const studioEnv: Record<string, string | undefined> = { TIMMY_HOME: studioHome, HOME: studioHome, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TLDRAW_LICENSE_KEY: realKey ? process.env.TLDRAW_LICENSE_KEY : 'FAKE-license-key-the-sdk-rejects-H172' };
  studio = await sv.startStudioServer(0, { env: studioEnv, followActive: true, followEveryMs: 200, ...(INSTALLED ? {} : { root: studioRoot }) });
  studioBase = `http://127.0.0.1:${(studio.address() as AddressInfo).port}`;
  projectA = join(studioHome, 'project-a');
  projectB = join(studioHome, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  await nameProject((studio.address() as AddressInfo).port, studio.projectToken, { root: projectA, name: 'pages-canvas-a' });
}, 240_000);

afterAll(async () => {
  await companion?.shutdown();
  await new Promise<void>((done) => (studio ? studio.close(() => done()) : done()));
  await browser?.close();
  await ollama?.close();
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  for (const d of [box, studioRoot, studioHome]) if (d) rmSync(d, { recursive: true, force: true });
}, 30_000);

// ── the companion page ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Opened { page: Page; context: BrowserContext; size: { width: number; height: number }; errors: string[]; missing: string[]; left: string[]; close: () => Promise<void> }

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
function recordingOf(record: string | undefined, size: { width: number; height: number }): { recordVideo: { dir: string; size: { width: number; height: number } } } | Record<string, never> {
  if (!caps.folder || !record) return {};
  const dir = join(caps.folder, 'recording-tmp');
  mkdirSync(dir, { recursive: true });
  return { recordVideo: { dir, size } };
}
/** Moves a finished recording (the Video taken from the page before its context closed) beside a sidecar listing the steps the case reached. */
async function keepRecording(v: Video | null, name: string, words: string[], verdict: string, seen: string[]): Promise<void> {
  if (!caps.folder) return;
  const base = join(caps.folder, name);
  try {
    const p = v ? await v.path() : '';
    if (p && existsSync(p)) renameSync(p, `${base}.webm`);
    writeFileSync(`${base}.txt`, [`${name} · a Playwright recording in headless Chromium (recordVideo), scripted test run, not a person · ${new Date().toISOString()}`, ...installedWords(), `Tests head: ${revisionOf()} (this checkout); the product tree: ${INSTALLED ? 'the installed package\'s build-info revision above' : 'this checkout at the same revision'}.`, `Origins: the companion ${companion.address}; the Studio ${studioBase} — both on 127.0.0.1.`, 'FAKE on 127.0.0.1: the identity provider (an RSA pair made by the test; its public key is CLERK_JWT_KEY; the session minted by the test, verified by the REAL verifier), the Ollama (no model: scripted tool calls and answers). No real Ollama in this sandbox.', ...words, `What the recording holds, in order (the steps the case reached): ${seen.length ? seen.join(' → ') : '(none recorded)'}.`, `Verdict: ${verdict}.`, ''].join('\n'));
  } catch (e) { try { writeFileSync(`${base}.failed.txt`, `the recording ${name} did not complete: ${e instanceof Error ? e.message : String(e)}\n`); } catch { /* nothing to say it with */ } }
}

/** The companion page at a size with the FAKE session adopted through the page's own seam (the server verifies every request). */
async function open(size: { width: number; height: number }, o: { reducedMotion?: boolean; record?: string; scale?: number; user?: string } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, ...(o.scale ? { deviceScaleFactor: o.scale } : {}), ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}), ...recordingOf(o.record, size) });
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
  }, identity.token(o.user ?? USER)).catch((e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`);
  expect(ok, 'the page\'s session seam (window.timmyAccount.useSession; H173)').toBe('ok');
  return { page, context, size, errors, missing, left, close: async () => { await context.close(); } };
}
/** The landing settled: a page with a composer, or the connections (a first use lands there). */
const landed = (page: Page): Promise<string> => until(page, 'the landing (a page with a composer, or the connections)', (s) => COMPOSER.test(s) || /Connect with OpenRouter/.test(s));
/** The Chat with the FAKE model chosen for the next turn (H171's Models context; on a phone the context opens from its button). */
async function chooseModel(o: Opened): Promise<Locator> {
  const phone = o.size.width <= 720;
  if (phone) { await o.page.locator(SHELL.contextButton).first().click(); await o.page.locator(SHELL.contextSheet).first().waitFor({ state: 'visible', timeout: 5_000 }); }
  await o.page.getByRole('tab', { name: 'Ollama local' }).first().click();
  await until(o.page, 'the FAKE model in the list', (s) => s.includes(MODEL), 20_000);
  await o.page.locator('#cm-list').getByText(MODEL, { exact: false }).first().click();
  const use = o.page.getByRole('button', { name: /Use for the next turn/ }).first();
  await use.click({ timeout: 10_000 }).catch(async () => { const li = o.page.locator('#cm-list li', { hasText: MODEL }).first(); await li.focus(); await li.press('Enter'); });
  await until(o.page, 'the model chosen', (s) => new RegExp(`Next turn: ${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}|${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*(ready|this computer)`).test(s), 20_000);
  if (phone) await o.page.keyboard.press('Escape');
  return o.page.getByRole('textbox', { name: COMPOSER }).or(o.page.getByPlaceholder(COMPOSER)).first();
}
/** The theme switched to Glacier through the product's own control when it has one (a Glacier button / radio), else the attribute set (said which). */
async function toGlacier(page: Page): Promise<string> {
  const sw = page.locator(`${SHELL.themeSwitch.replace('[data-theme]', '[data-theme="glacier"]')}`).first();
  if (await sw.isVisible().catch(() => false)) { await sw.click(); await page.waitForTimeout(300); return 'through the topbar\'s theme switch (§3.2; persisted per viewer)'; }
  const control = page.getByRole('radio', { name: /Glacier/i }).or(page.getByRole('button', { name: /Glacier/i })).or(page.getByRole('option', { name: /Glacier/i })).first();
  if (await control.isVisible().catch(() => false)) { await control.click(); await page.waitForTimeout(300); return 'through the product\'s own control'; }
  const select = page.getByRole('combobox', { name: /Theme/i }).first();
  if (await select.isVisible().catch(() => false)) { await select.selectOption('glacier').catch(() => select.selectOption({ label: 'Glacier' })); await page.waitForTimeout(300); return 'through the Theme control'; }
  await page.evaluate(() => { (document.documentElement.hasAttribute('data-theme') ? document.documentElement : document.body).setAttribute('data-theme', 'glacier'); });
  await page.waitForTimeout(300);
  return 'by setting the data-theme attribute (no control for it on this page: said, not a product control)';
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
/** The companion's own API as the signed-in user. */
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(new URL(path, companion.address), { method, headers: { Authorization: `Bearer ${TOKEN}`, [SESSION_HEADER]: identity.token(USER), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { /* words */ }
  return { status: res.status, json, text: t };
}
/** Horizontal overflow in CSS pixels (nothing cut: ≤ 0). */
const overflowOf = (page: Page): Promise<number> => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
/** The active element, said. */
const activeOf = (page: Page): Promise<string> => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''} "${(a.getAttribute('aria-label') || a.textContent || (a as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"` : 'none'; });

// ── the scaffold (D4) ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Scaffold { page: string; kicker: string; title: string; description: string; primary: string; summary: string; regions: Record<string, boolean>; states: string[] }
/** The scaffold's selectors alone (strings: what page.evaluate can carry). */
const SCAFFOLD_SEL = { shown: SHELL.shown, head: SHELL.head, kicker: SHELL.kicker, title: SHELL.title, description: SHELL.description, primary: SHELL.primary, summary: SHELL.summary, work: SHELL.work, context: SHELL.context, dock: SHELL.dock, records: SHELL.records };
/** What the shown page carries of the scaffold, read in the page (every piece named so a missing one is said by name). */
const scaffoldOf = (page: Page): Promise<Scaffold> => page.evaluate((S) => {
  const shown = [...document.querySelectorAll<HTMLElement>(S.shown)].find((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed') ?? null;
  const q = (sel: string): HTMLElement | null => shown?.querySelector<HTMLElement>(sel) ?? null;
  const t = (el: HTMLElement | null): string => (el ? (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ') : '');
  const regions: Record<string, boolean> = {};
  for (const [k, sel] of Object.entries({ head: S.head, summary: S.summary, work: S.work, context: S.context, dock: S.dock, records: S.records })) regions[k] = Boolean(q(sel));
  // the page's states, as the shell marks them (data-state on the page: empty | content | running | approval | error) — read, not assumed
  const states = shown ? [shown.getAttribute('data-state') || '', ...[...shown.querySelectorAll<HTMLElement>('[data-state]')].map((e) => e.getAttribute('data-state') || '')].filter(Boolean) : [];
  return { page: shown ? (shown.getAttribute('data-page') || shown.id || shown.className) : '', kicker: t(q(S.kicker)), title: t(q(S.title)), description: t(q(S.description)), primary: t(q(S.primary)), summary: t(q(S.summary)), regions, states };
}, SCAFFOLD_SEL);

/** The scaffold asserted on the shown page, each missing piece named as H175's contract piece. */
async function expectScaffold(page: Page, name: string): Promise<Scaffold> {
  const s = await scaffoldOf(page);
  const piece = (what: string): string => `${name}: ${what} (H175's SHELL CONTRACT v1 — the page scaffold; adjust SHELL in this test to the posted line if the names differ); the page read: ${JSON.stringify({ page: s.page, kicker: s.kicker, title: s.title, primary: s.primary, regions: s.regions }).slice(0, 600)}`;
  expect(s.page, piece('a shown page (section.page)')).not.toBe('');
  // the kicker: "NN / VERB PHRASE" (the number is the rail's order, §2.3); a page outside the rail carries its name instead of a number
  // (H173's Settings: "SETTINGS / SET HOW TIMMY RUNS")
  expect(s.kicker, piece('the kicker "NN / VERB PHRASE" (a page outside the rail: "NAME / VERB PHRASE")')).toMatch(/^(\d{2}|[A-Z][A-Z &]*)\s*\/\s*\S+/);
  expect(s.title.length, piece('the title')).toBeGreaterThan(0);
  expect(s.description.length, piece('the one-line description')).toBeGreaterThan(0);
  expect(s.primary.length, piece('the PRIMARY NEXT ACTION at the right')).toBeGreaterThan(0);
  expect(s.regions.head, piece('the head container')).toBe(true);
  expect(s.regions.summary, piece('the summary band (Workspace / project · Model · Records + the one action)')).toBe(true);
  expect(s.regions.work, piece('the work container')).toBe(true);
  expect(s.regions.context, piece('the context container (right: models or the selected item)')).toBe(true);
  expect(s.regions.dock, piece('the task dock')).toBe(true);
  expect(s.regions.records, piece('the records (quiet, expandable)')).toBe(true);
  return s;
}

/**
 * The theme family per viewer (D1; §1.2 / §3.2): html[data-theme], else the pressed switch's family, else "amber" — the default
 * without the attribute (said as such).
 */
const themeOf = (page: Page): Promise<string> => page.evaluate((sw) => document.documentElement.getAttribute('data-theme') || document.querySelector<HTMLElement>(`${sw}[aria-pressed="true"]`)?.getAttribute('data-theme') || 'amber (the default: no data-theme attribute set)', SHELL.themeSwitch);

/** The page id shown, as the shell says it (TimmyShell.current(), §2.3) and marks it (body[data-page], §2.4). */
const currentPage = (page: Page): Promise<string> => page.evaluate(() => { const w = window as unknown as { TimmyShell?: { current?: () => string } }; return `${document.body.getAttribute('data-page') || ''}|${w.TimmyShell?.current?.() || ''}`; });

/** The rail sheet on a phone (§4): #shell-menu opens .nav-rail.is-open; the items are the same. */
async function openRailSheet(o: Opened): Promise<Locator> {
  const menu = o.page.locator(SHELL.menuButton).first();
  expect(await menu.isVisible().catch(() => false), 'the phone\'s menu button #shell-menu (§4)').toBe(true);
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  const sheet = o.page.locator(SHELL.railSheet).first();
  await sheet.waitFor({ state: 'visible', timeout: 5_000 });
  return sheet;
}

/** A destination reached as a person reaches it: the rail's item (on a phone through the rail sheet); Settings through Help & find (D3 amended). */
async function goTo(o: Opened, name: string, seen?: string[]): Promise<void> {
  const phone = o.size.width <= 720;
  const p = PAGES.find((x) => x.name === name)!;
  if (p.via === 'help') {
    // §5: ⌘K / the rail's button opens Help & find; the search filters the destinations; Enter runs the first ("Open Settings")
    const help = o.page.locator(SHELL.helpButton).first();
    if (!(await help.isVisible().catch(() => false)) && phone) await openRailSheet(o);
    await help.click();
    const dialog = o.page.locator(SHELL.helpDialog).first();
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    const search = dialog.getByRole('searchbox').or(dialog.getByRole('textbox')).or(dialog.locator('input')).first();
    await search.fill(name);
    await o.page.waitForTimeout(200);
    const item = dialog.getByRole('button', { name: new RegExp(`\\b${name}\\b`) }).or(dialog.getByRole('option', { name: new RegExp(`\\b${name}\\b`) })).or(dialog.getByRole('link', { name: new RegExp(`\\b${name}\\b`) })).first();
    if (await item.isVisible().catch(() => false)) await item.click(); else await search.press('Enter');
  } else {
    let item = o.page.locator(SHELL.railItem(p.id)).first();
    if (!(await item.isVisible().catch(() => false)) && phone) { await openRailSheet(o); item = o.page.locator(SHELL.railItem(p.id)).first(); }
    expect(await item.isVisible().catch(() => false), `the rail's item for "${name}" (${SHELL.railItem(p.id)}; on a phone inside the rail sheet — §3.1 / §4)`).toBe(true);
    await item.click();
  }
  // §2.4: body[data-page] is the attribute to wait on; the rail's item is marked aria-current="page"
  const reached = await o.page.waitForFunction((id) => document.body.getAttribute('data-page') === id, p.id, { timeout: 10_000 }).then(() => true, () => false);
  expect(reached, `"${name}" opened: body[data-page="${p.id}"] (§2.4); the shell reads ${await currentPage(o.page)}; the page read: ${(await text(o.page)).slice(0, 500)}`).toBe(true);
  if (p.via === 'rail') expect(await o.page.locator(SHELL.railItem(p.id)).first().getAttribute('aria-current'), `the rail's item "${name}" marked current (§3.1)`).toBe('page');
  // the sheet closed by the navigation (§2.4: go() closes any open sheet)
  if (phone) expect(await o.page.locator(SHELL.railSheet).first().isVisible().catch(() => false), 'the rail sheet closed on the navigation (§2.4)').toBe(false);
  seen?.push(`${name} opened by ${p.via === 'help' ? 'Help & find' : phone ? 'the rail sheet' : 'the rail'}`);
}

/** The page's common assertions after a step: nothing cut, no page error, nothing left 127.0.0.1, nothing the companion has not. */
async function clean(o: Opened, where: string): Promise<void> {
  expect(await overflowOf(o.page), `${where}: horizontal overflow in CSS pixels (nothing cut)`).toBeLessThanOrEqual(0);
  expect(o.left, `${where}: requests that left 127.0.0.1`).toEqual([]);
  expect(o.errors, `${where}: page errors`).toEqual([]);
  expect(o.missing, `${where}: resources the page asked for and the companion has not`).toEqual([]);
}

// ── the Studio (Timmy Canvas) ──────────────────────────────────────────────────────────────────────────────────────────────────

type Ed = { getShape: (id: string) => { id: string; type: string; x: number; y: number; meta?: Record<string, unknown>; props: Record<string, unknown> } | undefined; store: { serialize: (scope: string) => Record<string, { typeName: string; type?: string; meta?: Record<string, unknown>; props?: Record<string, unknown> }> }; selectNone: () => void; zoomToFit: () => unknown };
// (page.evaluate must never RETURN the tldraw Editor — zoomToFit() returns `this` and the serialization ends the context: every editor call a block)
type Win = { timmyCanvas: { editor: Ed; licenseState: string; identity?: { state: string; project?: { name: string } } } };
async function openCanvas(size: { width: number; height: number }, o: { record?: string } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext({ viewport: size, ...recordingOf(o.record, size) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${studioBase}/#code=${await grant((studio!.address() as AddressInfo).port, studio!.projectToken)}`);
  await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: 20_000 }).catch(() => undefined);
  return { page, context, errors };
}
const saved = (page: Page, ms = 20_000): Promise<unknown> => page.waitForFunction(() => document.getElementById('save')?.dataset.state === 'saved', null, { timeout: ms });
const records = (page: Page): Promise<Record<string, unknown>> => page.evaluate(() => { const m = (window as unknown as Win).timmyCanvas.editor.store.serialize('document'); return Object.fromEntries(Object.entries(m).filter(([, r]) => r.typeName !== 'user')); });
/** A Houdini starter as the board holds it, read against H176's TEMPLATE SCHEMA v1 (the meta, the arrows' bindings, the words, the colours). */
const starterOnBoard = (page: Page): Promise<{ shapes: number; kinds: string; workbench: string; page: string; templates: string[]; badMeta: string[]; arrows: number; arrowsWithoutTwoBindings: string[]; words: string; greens: string[] }> => page.evaluate(() => {
  const all = Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')) as Array<{ id?: string; typeName: string; type?: string; fromId?: string; toId?: string; meta?: Record<string, unknown>; props?: Record<string, unknown> }>;
  const shapes = all.filter((r) => r.typeName === 'shape');
  const bindings = all.filter((r) => r.typeName === 'binding');
  const badMeta: string[] = [];
  const templates = new Set<string>();
  let workbench = ''; let pageOf = '';
  for (const s of shapes) {
    const m = (s.meta ?? {}) as Record<string, unknown>;
    const starter = m.timmyStarter as Record<string, unknown> | undefined;
    const ok = m.workbench === 'timmy-starter-v1' && m.page === 'houdini' && typeof m.role === 'string' && typeof m.lane === 'string' && /^H\d{1,3}$/.test(String(m.timmyTemplate)) && typeof starter?.key === 'string' && ['P67', 'T22', 'T24'].includes(String(starter?.from));
    if (!ok) badMeta.push(`${s.id}: ${JSON.stringify(m).slice(0, 160)}`);
    workbench = String(m.workbench ?? workbench); pageOf = String(m.page ?? pageOf);
    if (typeof m.timmyTemplate === 'string') templates.add(m.timmyTemplate);
  }
  const flowArrows = shapes.filter((s) => s.type === 'arrow' && ['flow', 'port-binding'].includes(String((s.meta ?? {}).role)));
  const arrowsWithoutTwoBindings = flowArrows.filter((a) => { const b = bindings.filter((x) => x.fromId === a.id); const t = new Set(b.map((x) => String((x.props ?? {}).terminal))); return !(t.has('start') && t.has('end')); }).map((a) => String(a.id));
  // the words on the board: every text / geo / frame shape's rich text paragraphs, and a frame's name
  const words = shapes.map((s) => { const p = s.props ?? {}; const rt = p.richText as { content?: Array<{ content?: Array<{ text?: string }> }> } | undefined; const lines = (rt?.content ?? []).map((para) => (para.content ?? []).map((x) => x.text ?? '').join('')).join('\n'); return `${lines} ${String(p.name ?? '')} ${String(p.text ?? '')}`; }).join('\n');
  const greens = shapes.filter((s) => /green/.test(String((s.props ?? {}).color ?? ''))).map((s) => String(s.id));
  const kinds = [...shapes.reduce((m, s) => m.set(String(s.type), (m.get(String(s.type)) ?? 0) + 1), new Map<string, number>()).entries()].map(([k, n]) => `${k}×${n}`).join(', ');
  return { shapes: shapes.length, kinds, workbench, page: pageOf, templates: [...templates], badMeta, arrows: flowArrows.length, arrowsWithoutTwoBindings, words, greens };
});
const switchTo = (name: string, root: string): void => { mkdirSync(join(studioHome, 'state'), { recursive: true }); writeFileSync(activeProjectFile({ TIMMY_HOME: studioHome, HOME: studioHome }), `${JSON.stringify({ name, root, at: new Date().toISOString() })}\n`); };


// ── the pages ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('every major page on the shell, from the running companion and Studio: the rail, the scaffold, each page\'s purpose and states, the phone\'s sheets, the keyboard, 125 % and 200 % zoom, 1280x720, reduced motion, a project switch (R11 round 7, H172)', { timeout: 300_000 }, () => {
  for (const size of SIZES) {
    const at = `${size.width}x${size.height}`;
    const phone = size.width <= 720;

    it.skipIf(!browserPath)(`${at} the shell: ONE rail with the grouped destinations (D3), the topbar (crumb · status · theme switch), Help & find, the account block, the project; ${phone ? 'the rail sheet' : 'the old tab row gone'}; no overflow`, async () => {
      const o = await open(size);
      try {
        await landed(o.page);
        // the theme family per viewer (D1; §1.2 amber is the default without the attribute) and the topbar's switch (§3.2)
        const theme = await themeOf(o.page);
        expect(theme, 'the theme family (html[data-theme], or the pressed switch, or amber by default)').toMatch(/^(amber|glacier)/);
        const switches = await o.page.locator(SHELL.themeSwitch).allTextContents().catch(() => [] as string[]);
        expect(switches.map((x) => x.trim().toLowerCase()).join(' '), 'the theme switch\'s two families (§3.2 .theme-switch [data-theme])').toMatch(/glacier/);
        expect(switches.map((x) => x.trim().toLowerCase()).join(' ')).toMatch(/amber/);
        // the topbar: the crumb "Workspace / <page>", the status in words (never green but on an observed open socket)
        const top = o.page.locator(SHELL.topbar).first();
        expect(await top.count(), 'the topbar header#shell-top (§3.2)').toBeGreaterThan(0);
        const crumb = await top.locator('.crumb').first().innerText().catch(() => '');
        const status = await top.locator('#shell-status').first().innerText().catch(() => '');
        if (!phone) {
          // (§3.2: "Workspace / <page name>" where the first crumb reads #project-name's words — the project's name on a signed-in page)
          expect(crumb.replace(/\s+/g, ' '), 'the crumb reads "<workspace / project> / <page name>"').toMatch(/\S.* \/ .*\S/);
          expect(status.length, 'the status word in the topbar (#shell-status)').toBeGreaterThan(0);
        } // (§4: the phone's top strip is the mark, the project's name and the menu button; the crumb and the status may fold — read, said)
        const sheet = phone ? await openRailSheet(o) : null;
        const rail = o.page.locator(SHELL.rail).first();
        expect(await rail.count(), 'the rail aside#shell-rail (§3.1)').toBeGreaterThan(0);
        // §3.1: every destination as a .rail-item[data-page][data-dest] with its label; the groups WORK · CREATE · CONNECT; one marked current
        for (const p of RAIL_PAGES) {
          const item = o.page.locator(SHELL.railItem(p.id)).first();
          expect(await item.count(), `the rail's item for ${p.name} (${SHELL.railItem(p.id)})`).toBeGreaterThan(0);
          expect((await item.innerText()).trim(), `the item's label reads "${p.name}"`).toContain(p.name);
          expect(await item.getAttribute('data-dest'), `${p.name}: data-dest (the legacy id) set`).toBeTruthy();
        }
        const words = await rail.innerText();
        for (const g of SHELL.groups) expect(words.toUpperCase(), `the rail groups ${g}`).toContain(g);
        expect(await o.page.locator('#rail-menu .rail-item[aria-current="page"]').count(), 'one rail item marked current (the shown page)').toBe(1);
        // Settings is NOT a rail item (D3 amended: the account block's menu and Help & find reach it)
        expect(await o.page.locator(SHELL.railItem('settings')).count(), 'Settings is not a rail item (D3 amended)').toBe(0);
        // the foot: Help & find, the account block (the FAKE session's user, never the token's value), the project
        expect(await o.page.locator(SHELL.helpButton).first().count(), 'the rail\'s foot: #shell-help "Help & find" (§5)').toBeGreaterThan(0);
        expect(await o.page.locator(SHELL.helpButton).first().innerText()).toMatch(/Help/);
        const account = o.page.locator(SHELL.account).first();
        expect(await account.count(), 'the rail\'s account block (#rail-account)').toBeGreaterThan(0);
        expect(await o.page.locator(SHELL.projectButton).first().count(), 'the rail\'s project (#rail-project)').toBeGreaterThan(0);
        // ONE rail: the old workspace tab row is never visible again (§2.1: it stays in the DOM hidden for the keys)
        expect(await o.page.locator('#ws-tabs').first().isVisible().catch(() => false), 'the old ws-tabs row is not visible (D3: ONE rail)').toBe(false);
        if (phone && sheet) {
          // §4: the rail sheet is a modal dialog (H175's shell.js: the role and aria-modal sit on #rail-sheet inside the opened rail); Escape
          // closes it and the focus returns to #shell-menu
          const dialog = sheet.locator('#rail-sheet, [role="dialog"]').first();
          expect(await dialog.getAttribute('role'), 'the rail sheet is role=dialog').toBe('dialog');
          expect(await dialog.getAttribute('aria-modal'), 'the rail sheet is aria-modal').toBe('true');
          await caps.cap(o.page, size, 'shell-rail-sheet', { line: line('the shell', 'the rail sheet open on the phone'), facts: ['The phone\'s rail sheet opened from #shell-menu (§4): the same grouped destinations as the rail, a modal dialog over the page.'], full: true });
          await o.page.keyboard.press('Escape');
          await o.page.waitForTimeout(200);
          expect(await sheet.isVisible().catch(() => false), 'Escape closes the rail sheet').toBe(false);
          expect(await activeOf(o.page), 'the focus returns to #shell-menu on close (§4)').toContain('#shell-menu');
        }
        // §5 Help & find: the overlay opens from the rail's button, searches, closes on Escape with the focus back
        const help = o.page.locator(SHELL.helpButton).first();
        if (!(await help.isVisible().catch(() => false)) && phone) await openRailSheet(o);
        await help.click();
        const dialog = o.page.locator(SHELL.helpDialog).first();
        expect(await dialog.isVisible().catch(() => false), 'Help & find opens (#shell-help-dialog, §5)').toBe(true);
        const helpWords = await dialog.innerText();
        for (const p of RAIL_PAGES.slice(0, 3)) expect(helpWords, `Help & find lists the destination ${p.name}`).toContain(p.name);
        await caps.cap(o.page, size, 'shell-help-find', { line: line('the shell', 'Help & find open'), facts: ['Help & find (§5): the destinations, the page\'s actions and the keyboard hints in one overlay, one search field.'], full: true });
        await o.page.keyboard.press('Escape');
        await o.page.waitForTimeout(200);
        expect(await dialog.isVisible().catch(() => false), 'Escape closes Help & find').toBe(false);
        await caps.cap(o.page, size, 'shell-landing', { line: line('the shell', 'the landing of the signed-in product'), facts: [`The landing at ${at}: ${phone ? 'the rail as a top strip (§4)' : 'the ONE grouped rail (§3.1)'}, the topbar (crumb "${crumb.replace(/\s+/g, ' ').trim()}", status "${status.replace(/\s+/g, ' ').trim()}"), theme ${theme}.`], full: true });
        await clean(o, 'the shell');
      } finally { await o.close(); }
    });

    for (const p of RUN) {
      it.skipIf(!browserPath)(`${at} ${p.name}: reached by ${p.via === 'help' ? 'Help & find' : phone ? 'the rail sheet' : 'the rail'}; the scaffold (kicker · title · description · primary next action · summary band · work · context · dock · records); its purpose and states; captures`, async () => {
        const o = await open(size);
        try {
          await landed(o.page);
          await goTo(o, p.name);
          // the page's picture FIRST (a reviewer needs it whether or not a scaffold piece is missing), then the scaffold asserted
          const read = await scaffoldOf(o.page);
          const facts = [`${p.name} on the scaffold: kicker "${read.kicker}" · title "${read.title}" · primary next action "${read.primary || '(NONE drawn)'}" · states marked: ${read.states.join(', ') || '(none marked)'}.`, `The summary band: "${read.summary.slice(0, 160) || '(none read: H175\'s contract piece)'}".`];
          await caps.cap(o.page, size, `${slug(p.name)}-page`, { line: line(p.name, 'as reached by the navigation'), facts, full: true });
          await expectScaffold(o.page, p.name);
          await PROBES[p.name]?.(o, size, facts);
          await clean(o, p.name);
        } finally { await o.close(); }
      });
    }

    it.skipIf(!browserPath)(`${at} the keyboard: Tab from the start reaches the page's primary next action and the composer (captured at each); Escape closes the ${phone ? 'rail sheet' : 'project menu'} and gives the focus back; no trap`, async () => {
      const o = await open(size);
      try {
        await landed(o.page);
        await goTo(o, 'Chat');
        const s = await expectScaffold(o.page, 'Chat');
        // Tab from the document's start: the primary next action and the composer are reached within a bounded number of Tabs, never a canvas
        await o.page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); window.scrollTo(0, 0); });
        const seenFocus: string[] = [];
        let primary = -1; let composer = -1; let canvas = -1;
        for (let i = 0; i < 80 && (primary < 0 || composer < 0); i++) {
          await o.page.keyboard.press('Tab');
          const a = await activeOf(o.page);
          seenFocus.push(a);
          if (primary < 0 && s.primary && a.replace(/\s+/g, '').includes(s.primary.replace(/\s+/g, '').slice(0, 16))) { primary = i; await caps.cap(o.page, size, 'chat-focus-primary', { line: line('Chat', 'the keyboard focus on the primary next action'), facts: [`Tab ${i + 1} from the start: the focus on the primary next action "${s.primary}" (its focus ring is the picture's point).`] }); }
          if (composer < 0 && COMPOSER.test(a)) { composer = i; await caps.cap(o.page, size, 'chat-focus-composer', { line: line('Chat', 'the keyboard focus on the composer'), facts: [`Tab ${i + 1} from the start: the focus on the composer.`] }); }
          if (canvas < 0 && /^canvas/.test(a)) canvas = i;
        }
        expect(primary, `the primary next action "${s.primary}" is reached by Tab (the focus order: ${seenFocus.join(' → ').slice(0, 900)})`).toBeGreaterThanOrEqual(0);
        expect(composer, `the composer is reached by Tab (the focus order: ${seenFocus.join(' → ').slice(0, 900)})`).toBeGreaterThanOrEqual(0);
        expect(canvas, 'no canvas takes the focus').toBe(-1);
        // Escape (§4 / §5): the rail sheet (a phone) or Help & find (⌘K) opened from the keyboard closes on Escape and the focus returns to the opener (no trap)
        const opener = phone ? o.page.locator(SHELL.menuButton).first() : o.page.locator(SHELL.helpButton).first();
        expect(await opener.isVisible().catch(() => false), `${phone ? '#shell-menu' : '#shell-help'} visible for the keyboard`).toBe(true);
        await opener.focus();
        await o.page.keyboard.press('Enter');
        const opened = phone ? o.page.locator(SHELL.railSheet).first() : o.page.locator(SHELL.helpDialog).first();
        await opened.waitFor({ state: 'visible', timeout: 5_000 });
        await o.page.keyboard.press('Tab');
        const inside = await activeOf(o.page);
        expect(inside, 'Tab moves inside the opened sheet / overlay').not.toBe('none');
        await o.page.keyboard.press('Escape');
        await o.page.waitForTimeout(200);
        expect(await opened.isVisible().catch(() => false), 'Escape closes it').toBe(false);
        expect(await activeOf(o.page), `the focus returns to the opener (${phone ? '#shell-menu' : '#shell-help'})`).toContain(phone ? '#shell-menu' : '#shell-help');
        // ⌘K / Ctrl+K opens Help & find from anywhere (§5)
        await o.page.keyboard.press('Control+KeyK');
        const byKey = await o.page.locator(SHELL.helpDialog).first().waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
        if (byKey) await o.page.keyboard.press('Escape');
        else console.warn(`journey-pages ${at}: Ctrl+K did not open Help & find within 3 s (⌘K is the Mac's; said, not failed on)`);
        await clean(o, 'the keyboard');
      } finally { await o.close(); }
    });

    it.skipIf(!browserPath)(`${at} reduced motion: the shell honours prefers-reduced-motion; a mounted native face's ReducedMotion reads true; two frames 1 s apart`, async () => {
      const o = await open(size, { reducedMotion: true });
      try {
        await landed(o.page);
        await goTo(o, 'Chat');
        const motion = await o.page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { media: matchMedia('(prefers-reduced-motion: reduce)').matches, token: ['--timmy-ui-motion-feedback', '--timmy-ui-motion-state', '--timmy-ui-motion-panel'].map((n) => `${n}=${cs.getPropertyValue(n).trim() || '(unset)'}`).join(' '), attr: '' }; });
        expect(motion.media, 'the page sees prefers-reduced-motion: reduce').toBe(true);
        // §1.5: under prefers-reduced-motion the theme sheet sets the three motion variables to 0ms
        for (const n of ['--timmy-ui-motion-feedback', '--timmy-ui-motion-state', '--timmy-ui-motion-panel']) expect(motion.token, `${n} is 0ms under reduced motion (§1.5)`).toMatch(new RegExp(`${n}=0(\\.0+)?(s|ms)\\b`));
        // a mounted native face (the chat's console, when H171 mounts it): the asset's own ReducedMotion input true
        const faces = await o.page.evaluate(() => { const R = (window as unknown as { TimmyRive?: { inspect?: () => Array<{ component?: string; state: string; runtime: { inputs: Array<{ name: string; value: unknown }> } | null }> } }).TimmyRive; return (R?.inspect?.() ?? []).map((h) => ({ component: h.component, state: h.state, reduced: h.runtime?.inputs.find((i) => i.name === 'ReducedMotion')?.value ?? null })); });
        for (const f of faces.filter((x) => x.state === 'drawn')) expect(f.reduced, `${f.component}: ReducedMotion true`).toBe(true);
        const drawn = faces.filter((x) => x.state === 'drawn').map((x) => `${x.component} ReducedMotion=${String(x.reduced)}`).join(', ') || 'none mounted on this page';
        // two frames 1 s apart (H168's rubric §9: pixel-identical in the face under reduced motion)
        await caps.cap(o.page, size, 'reduced-motion-frame-1', { line: line('Chat', 'reduced motion, frame 1 of 2'), facts: [`prefers-reduced-motion: reduce — the motion variables read ${motion.token}; native faces drawn: ${drawn}. Frame 1; frame 2 follows 1 s later for the pixel comparison.`] });
        await o.page.waitForTimeout(1_000);
        await caps.cap(o.page, size, 'reduced-motion-frame-2', { line: line('Chat', 'reduced motion, frame 2 of 2 (1 s later)'), facts: [`The same page 1 s after frame 1: under reduced motion no pose keeps moving (native faces drawn: ${drawn}).`] });
        await clean(o, 'reduced motion');
      } finally { await o.close(); }
    });
  }

  // ── a phone's sheets (D5) ────────────────────────────────────────────────────────────────────────────────────────────────────
  it.skipIf(!browserPath)('390x844 the sheets: the context opens as a sheet and closes on Escape with the focus back; the composer stays reachable under it; the band folds and opens; nothing cut', async () => {
    const size = { width: 390, height: 844 };
    const o = await open(size);
    try {
      await landed(o.page);
      await goTo(o, 'Chat');
      const composer = o.page.getByRole('textbox', { name: COMPOSER }).or(o.page.getByPlaceholder(COMPOSER)).first();
      expect(await composer.isVisible().catch(() => false), 'the composer is visible on the phone').toBe(true);
      const box = await composer.boundingBox();
      expect(box && box.y + box.height <= size.height + 1, `the composer is inside the viewport (${JSON.stringify(box)})`).toBe(true);
      const ctx = o.page.locator(SHELL.contextButton).first();
      expect(await ctx.isVisible().catch(() => false), 'the context opens from .page-context-btn in the head on the phone (§4: "Models" / "Details")').toBe(true);
      await ctx.focus();
      await ctx.click();
      const sheet = o.page.locator(SHELL.contextSheet).first();
      const sheetShown = await sheet.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
      expect(sheetShown, 'the context sheet opens (.page-context.is-open, §4)').toBe(true);
      await caps.cap(o.page, size, 'chat-context-sheet', { line: line('Chat', 'the context (Models) sheet open'), facts: ['The context (Models) opened as a sheet from the bottom on the phone (§4).'], full: true });
      await o.page.keyboard.press('Escape');
      await o.page.waitForTimeout(200);
      expect(await sheet.isVisible().catch(() => false), 'Escape closes the context sheet').toBe(false);
      expect(await activeOf(o.page), 'the focus returns to .page-context-btn on close (§4)').toMatch(/page-context-btn|Models|Details/);
      expect(await composer.isVisible().catch(() => false), 'the composer is back in view after the sheet').toBe(true);
      // the band (the native console) folded to its word on a phone, opened on a tap (H171's control), nothing overflowing either way
      const fold = o.page.locator('#cx-console button[aria-expanded]').first();
      if (await fold.count()) {
        const was = await fold.getAttribute('aria-expanded');
        await caps.cap(o.page, size, `chat-band-${was === 'true' ? 'open' : 'folded'}`, { line: line('Chat', `the band ${was === 'true' ? 'open' : 'folded'} on the phone`), facts: [`The console band on the phone as the page opened it: aria-expanded=${was}.`] });
        await fold.click();
        await o.page.waitForTimeout(400);
        const now = await fold.getAttribute('aria-expanded');
        expect(now, 'the band toggles on a tap').not.toBe(was);
        await caps.cap(o.page, size, `chat-band-${now === 'true' ? 'open' : 'folded'}`, { line: line('Chat', `the band ${now === 'true' ? 'open' : 'folded'} after a tap`), facts: [`The console band after a tap: aria-expanded=${now}.`] });
        await fold.click();
      } else console.warn('journey-pages 390: no console band fold (#cx-console button[aria-expanded]) on this page — said, not asserted');
      await clean(o, 'the sheets');
    } finally { await o.close(); }
  });

  // ── 125 % and 200 % zoom, 1280x720 (D5; H168's rubric §8) ───────────────────────────────────────────────────────────────────
  it.skipIf(!browserPath)('1152x720 at a device scale of 1.25 (a 1440x900 window zoomed to 125 %): the scaffold intact, nothing cut', async () => {
    const size = { width: 1152, height: 720 };
    const o = await open(size, { scale: 1.25 });
    try {
      await landed(o.page);
      await goTo(o, 'Chat');
      await expectScaffold(o.page, 'Chat at 125 %');
      await caps.cap(o.page, size, 'chat-zoom-125', { line: line('Chat', '125 % zoom (1152x720 CSS px at a device scale of 1.25)'), facts: ['A 1440x900 window at 125 % zoom: the Chat page\'s scaffold intact.'], full: true });
      await clean(o, '125 % zoom');
    } finally { await o.close(); }
  });
  it.skipIf(!browserPath)('720x450 at a device scale of 2 (a 1440x900 window zoomed to 200 %): nothing cut, the composer reachable', async () => {
    const size = { width: 720, height: 450 };
    const o = await open(size, { scale: 2 });
    try {
      await landed(o.page);
      await goTo(o, 'Chat');
      const composer = o.page.getByRole('textbox', { name: COMPOSER }).or(o.page.getByPlaceholder(COMPOSER)).first();
      expect(await composer.count(), 'the composer at 200 %').toBeGreaterThan(0);
      await caps.cap(o.page, size, 'chat-zoom-200', { line: line('Chat', '200 % zoom (720x450 CSS px at a device scale of 2)'), facts: ['A 1440x900 window at 200 % zoom: the shell at 720 CSS px wide = the contract\'s phone breakpoint (the rail as a top strip, §4), nothing cut.'], full: true });
      await clean(o, '200 % zoom');
    } finally { await o.close(); }
  });
  it.skipIf(!browserPath)('1280x720 checked: every page\'s scaffold intact, nothing cut (one capture each)', async () => {
    const size = { width: 1280, height: 720 };
    const o = await open(size);
    try {
      await landed(o.page);
      for (const p of RUN) {
        await goTo(o, p.name);
        await expectScaffold(o.page, `${p.name} at 1280x720`);
        await caps.cap(o.page, size, `${slug(p.name)}-1280x720`, { line: line(p.name, 'at 1280x720 (D5: checked)'), facts: [`${p.name} at 1280x720: the scaffold intact.`] });
        expect(await overflowOf(o.page), `${p.name} at 1280x720: nothing cut`).toBeLessThanOrEqual(0);
      }
      await clean(o, '1280x720');
    } finally { await o.close(); }
  });

  // ── Models & accounts: unreachable (a second FAKE user whose Ollama address is a closed port) ────────────────────────────────
  it.skipIf(!browserPath)('1440x900 Models & accounts, unreachable: a user whose Ollama address is a closed port on 127.0.0.1 → Check says so in the card\'s own words; never "connected"', async () => {
    const size = { width: 1440, height: 900 };
    const o = await open(size, { user: USER_UNREACHABLE });
    try {
      await landed(o.page);
      await goTo(o, 'Models & accounts');
      await expectScaffold(o.page, 'Models & accounts (unreachable)');
      const local = o.page.locator('[data-provider="ollama-local"]').first();
      await local.getByRole('button', { name: /^Check$/ }).first().click({ timeout: 5_000 }).catch(async () => { await o.page.getByRole('button', { name: /^Check$/ }).first().click(); });
      const t = await until(o.page, 'the local card\'s word after Check against a closed port', (s) => /unreachable|refused|could not be reached|not reachable|no answer/i.test(s), 20_000);
      const state = await local.getAttribute('data-state');
      expect(state ?? '', 'the card\'s state after a refused connection').toMatch(/unreachable|refused|not set up|failed/i);
      expect(t, 'never "connected" on a refused connection').not.toMatch(/\bconnected\b/i);
      await caps.cap(o.page, size, 'models-accounts-unreachable', { line: line('Models & accounts', 'Ollama · local unreachable after Check (a closed port)'), facts: [`Ollama · local for a user whose address is ${UNREACHABLE_OLLAMA} (nothing listens there): after Check the card says it in its own words; state "${state ?? '(none)'}"; nothing green.`], full: true });
      await clean(o, 'unreachable');
    } finally { await o.close(); }
  });

  // ── a project switch through the rail ────────────────────────────────────────────────────────────────────────────────────────
  it.skipIf(!browserPath)('1440x900 a project switch: a second project made (POST /api/projects), chosen in the rail\'s project menu → the destination kept, the summary band names it', async () => {
    const size = { width: 1440, height: 900 };
    const made = await api('POST', '/api/projects', { name: OTHER_PROJECT });
    expect([200, 201], `POST /api/projects (H173): ${made.text.slice(0, 200)}`).toContain(made.status);
    const o = await open(size);
    try {
      await landed(o.page);
      await goTo(o, 'Chat');
      const before = await expectScaffold(o.page, 'Chat');
      await o.page.locator(SHELL.projectButton).first().click();
      const row = o.page.locator(SHELL.projectMenu).getByRole('button', { name: OTHER_PROJECT }).first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await row.click();
      await o.page.waitForFunction((n) => document.body.innerText.includes(n), OTHER_PROJECT, { timeout: 15_000 });
      await o.page.waitForTimeout(500);
      const after = await scaffoldOf(o.page);
      expect(after.page, 'the destination is kept across the switch').toBe(before.page);
      expect(`${after.summary} ${await o.page.locator(SHELL.projectButton).first().innerText()}`, 'the summary band / the rail name the chosen project').toContain(OTHER_PROJECT);
      await caps.cap(o.page, size, 'project-switched', { line: line('Chat', `the project switched to "${OTHER_PROJECT}"`), facts: [`The rail's project menu: the second project "${OTHER_PROJECT}" chosen (the companion pins the page to it) — the destination kept, the project named in the summary band.`] });
      await clean(o, 'the project switch');
    } finally { await o.close(); }
  });

  // ── the recorded tours (one per size): every page by the rail, in order ───────────────────────────────────────────────────────
  for (const size of SIZES) {
    const at = `${size.width}x${size.height}`;
    it.skipIf(!browserPath)(`${at} the tour, recorded: every page reached by the ${size.width <= 720 ? 'rail sheet' : 'rail'} in D3's order (the steps reached listed in the sidecar)`, async () => {
      const o = await open(size, { record: `recording-pages-${at}` });
      const seen: string[] = [];
      let passed = false;
      try {
        await landed(o.page);
        for (const p of RUN) {
          await goTo(o, p.name, seen);
          await o.page.waitForTimeout(700); // (a beat per page in the recording)
        }
        await clean(o, 'the tour');
        passed = true;
      } finally {
        const video = o.page.video();
        await o.close();
        await keepRecording(video, `recording-pages-${at}`, [`REAL: the companion's pages at ${at}, each reached by the ${size.width <= 720 ? 'rail sheet' : 'rail'} (the assertions on each page's scaffold and purpose are the per-page cases'; this recording is the walk).`], passed ? 'the tour reached every page listed without a page error, nothing cut, nothing leaving 127.0.0.1' : 'the tour FAILED before its end (see the vitest log; the steps reached are listed above)', seen);
      }
    });
  }
});

// ── what each page is for (its probe: the purpose asserted, its states captured, its facts for the sidecar) ──────────────────────

const slug = (name: string): string => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
type Probe = (o: Opened, size: { width: number; height: number }, facts: string[]) => Promise<void>;
const PROBES: Record<string, Probe> = {
  async 'Chat'(o, size, facts) {
    const phone = size.width <= 720;
    const composer = o.page.getByRole('textbox', { name: COMPOSER }).or(o.page.getByPlaceholder(COMPOSER)).first();
    expect(await composer.count(), 'the composer').toBeGreaterThan(0);
    expect(await composer.isVisible(), 'the composer is visible (the task dock reachable)').toBe(true);
    // H168's B2 bar: the primary next action AND the composer on screen without scrolling, at both sizes
    const inView = async (l: Locator): Promise<boolean> => { const b = await l.boundingBox().catch(() => null); return Boolean(b && b.y >= 0 && b.y + b.height <= size.height + 1 && b.x >= 0 && b.x + b.width <= size.width + 1); };
    expect(await inView(composer), `the composer inside the ${size.width}x${size.height} viewport without scrolling`).toBe(true);
    const primary = o.page.locator(SHELL.primary).first();
    expect(await inView(primary), `the primary next action inside the ${size.width}x${size.height} viewport without scrolling`).toBe(true);
    // the first use (empty): the welcome with its verb-led starters — the project's first visit; later (the USER's one project carries the
    // earlier cases' turns) the product's own way to an empty conversation: "+ New conversation" in the rail (POST /api/chat/new, H169)
    const welcome = (s: string): boolean => /What would you like to make|Plan a project/i.test(s);
    let firstUse = welcome(await text(o.page));
    if (!firstUse) {
      const fresh = o.page.locator('#rail-new-conv').first();
      if (!(await fresh.isVisible().catch(() => false)) && phone) await openRailSheet(o);
      if (await fresh.isVisible().catch(() => false)) {
        await fresh.click();
        firstUse = await until(o.page, 'the welcome after New conversation', welcome, 15_000).then(() => true, () => false);
        if (phone && await o.page.locator(SHELL.railSheet).first().isVisible().catch(() => false)) await o.page.keyboard.press('Escape');
      }
    }
    if (firstUse) await caps.cap(o.page, size, 'chat-first-use', { line: line('Chat', 'first use (empty): the welcome and its starters'), facts: ['The empty state: the welcome with its verb-led starters (the project\'s first visit, or New conversation on a project with a saved one); no turn in this conversation yet.'], full: true });
    else facts.push('Not first use at this capture: the conversation as it stands (turns of this run\'s earlier cases; New conversation did not draw the welcome within 15 s — said).');
    // the context at the right (a sheet on a phone): the models, with the catalog's words (H169's CATALOG METADATA; H171's panel)
    if (phone) await o.page.locator(SHELL.contextButton).first().click().catch(() => undefined);
    const models = await until(o.page, 'the Models context', (s) => /All makers|All capabilities|Newest first|Choose your model/.test(s), 10_000).catch(() => '');
    facts.push(models ? 'The context at the right (aside.page-context, context: models): the Models panel, its controls read.' : 'The Models context was not read within 10 s (said).');
    if (phone) await o.page.keyboard.press('Escape');
    // the native console when mounted (H171 on H174's mount API): present and drawn, its label aria-live
    const face = o.page.locator('#cx-console [data-rive-component], [data-rive-component="activity"], [data-rive-component="console"]').first();
    let consoleKey = '';
    if (await face.count()) {
      consoleKey = (await face.getAttribute('data-rive-component')) || 'activity';
      const drawn = await o.page.locator(`canvas[data-timmy-rive="${consoleKey}"][data-loaded]`).first().waitFor({ state: 'attached', timeout: 20_000 }).then(() => true, () => false);
      facts.push(`The native AgentConsole in the chat: ${drawn ? 'drawn by the runtime (canvas[data-loaded])' : 'mounted but not drawn within 20 s (said)'}; its label [data-rive-status] aria-live="${await o.page.locator(`[data-rive-status="${consoleKey}"]`).first().getAttribute('aria-live').catch(() => null)}".`);
    } else facts.push('No native console mounted on this page (H171 / H174): the words only.');
    // a content turn: the FAKE model chosen, a REAL turn through the agent (one tool call, then the FAKE's answer)
    const input = await chooseModel(o);
    await input.fill('FAKE: what time is it?');
    await o.page.getByRole('button', { name: /^Send/ }).first().click();
    await o.page.waitForFunction((a) => document.body.innerText.includes(a), FAKE_ANSWER, { timeout: 60_000 });
    await o.page.waitForTimeout(800); // (the receipt read back)
    await caps.cap(o.page, size, 'chat-content-turn', { line: line('Chat', 'a content turn answered (REAL agent, FAKE model)'), facts: ['A REAL turn through the agent, answered by the FAKE model (one tool call get_current_time, then its fixed answer), its receipt sealed on the USER\'s project chain; the evidence line under the answer.'], reveal: { to: o.page.locator('#cx-own li, #cx-turns li').filter({ hasText: FAKE_ANSWER }).last(), what: 'the answered turn' }, full: true });
    facts.push('A content turn: sent, answered by the FAKE model through the REAL agent, its receipt read back.');
    // a failed turn (H168's §13: the FAKE's error script): the FAKE answers 500 → the turn fails → the page says so with a verb-led way on (its words read)
    await input.fill('FAKE: fail this turn please');
    await o.page.getByRole('button', { name: /^Send/ }).first().click();
    const failed = await until(o.page, 'the failed turn said', (s) => /failed|error|could not|did not answer|went wrong/i.test(s.slice(s.indexOf('FAKE: fail this turn') >= 0 ? s.indexOf('FAKE: fail this turn') : 0)), 30_000);
    expect(failed, 'the failed turn is not drawn as an answer').not.toContain(FAKE_ANSWER.slice(0, 20) + ' ');
    const failState = consoleKey ? await o.page.evaluate((k) => { const R = (window as unknown as { TimmyRive?: { inspect?: () => Array<{ component?: string; runtime: { inputs: Array<{ name: string; value: unknown }> } | null }> } }).TimmyRive; return R?.inspect?.()?.find((h) => h.component === k)?.runtime?.inputs.find((i) => i.name === 'State')?.value ?? null; }, consoleKey) : null;
    const recovery = await o.page.locator('#cx-own li, #cx-turns li').last().getByRole('button').allInnerTexts().catch(() => [] as string[]);
    await caps.cap(o.page, size, 'chat-failed-turn', { line: line('Chat', 'a failed turn (the FAKE\'s error script) with its way on'), facts: [`The FAKE answered the turn's request with 500 "${FAKE_ERROR}": the REAL agent's turn failed; the page's words on the turn; the console's native State reads ${failState === null ? '(no console)' : String(failState)} (4 = Failed); the turn's own controls: ${recovery.map((x) => x.trim()).filter(Boolean).join(' · ') || '(none read)'}.`], reveal: { to: o.page.locator('#cx-own li, #cx-turns li').last(), what: 'the failed turn' }, full: true });
    facts.push(`A failed turn (the FAKE's 500): said on the page; the console's State ${failState === null ? 'not read (no console)' : String(failState)}.`);
    // Glacier: the other theme family on the same page (D1), through the product's control when it has one
    const how = await toGlacier(o.page);
    expect(await themeOf(o.page), 'the theme family reads glacier (html[data-theme])').toMatch(/^glacier/);
    await caps.cap(o.page, size, 'chat-glacier', { line: line('Chat', 'the Glacier theme family'), facts: [`The same page in Glacier (${how}): the same semantic roles, the accent family changed; a status's meaning unchanged.`], full: true });
    facts.push(`Glacier: ${how}.`);
  },
  async 'Models & accounts'(o, size, facts) {
    const t = await until(o.page, 'the four provider cards', (s) => /OpenRouter/.test(s) && /Ollama · local/.test(s) && /Cloudflare/.test(s), 20_000);
    for (const id of PROVIDERS) expect(await o.page.locator(`[data-provider="${id}"]`).count(), `the ${id} card (H170)`).toBeGreaterThan(0);
    expect(t).not.toMatch(/\bfree\b/i);
    const states = async (): Promise<string> => (await Promise.all(PROVIDERS.map(async (id) => `${id}: ${(await o.page.locator(`[data-provider="${id}"]`).first().getAttribute('data-state')) ?? '(none)'}`))).join(' · ');
    await caps.cap(o.page, size, 'models-accounts-first-use', { line: line('Models & accounts', 'first use: the four cards unconfigured'), facts: [`The four provider cards on first use, in their state words: ${await states()}; nothing set up, nothing "free", nothing green.`], full: true });
    // Check on Ollama · local against the FAKE Ollama: its model listed (the state word "connected" only after an observed answer)
    const local = o.page.locator('[data-provider="ollama-local"]').first();
    await local.getByRole('button', { name: /^Check$/ }).first().click({ timeout: 5_000 }).catch(async () => { await o.page.getByRole('button', { name: /^Check$/ }).first().click(); });
    await until(o.page, 'the FAKE Ollama\'s model on the local card (after Check)', (s) => s.includes(MODEL), 20_000);
    const state = await local.getAttribute('data-state');
    await caps.cap(o.page, size, 'models-accounts-after-check', { line: line('Models & accounts', 'Ollama · local after Check (the FAKE answered)'), facts: [`Ollama · local after Check against the FAKE Ollama on 127.0.0.1: its model ${MODEL} listed; the card's state "${state ?? '(none)'}" (an observed answer; no model ran).`], full: true });
    facts.push(`Ollama · local after Check: ${MODEL} listed; state "${state ?? '(no data-state)'}".`, 'The other cards in their unconfigured words — nothing invented, nothing "free".');
    // a key saved, not checked (H168's §13): the FAKE cloud key pasted and saved; the card says saved / not checked; the value in no DOM
    const keyField = o.page.getByRole('textbox', { name: /Ollama API key/i }).or(o.page.locator('#cn-ollama-cloud-key')).first();
    if (await keyField.count()) {
      await keyField.fill(FAKE_CLOUD_KEY);
      await o.page.getByRole('button', { name: /Save (the|an Ollama) key/ }).first().click();
      // (the card offers "Check the key" / "Forget the key" only once a key is held: the saved state, not a word that may already be on the page)
      const savedWords = await until(o.page, 'the key saved, said (Check the key / Forget the key offered)', (s) => /Check the key|Forget the key/.test(s), 15_000);
      expect(savedWords, 'the key\'s value reaches no screen').not.toContain(FAKE_CLOUD_KEY);
      expect(await o.page.evaluate(() => document.documentElement.outerHTML), 'the key\'s value reaches no DOM').not.toContain(FAKE_CLOUD_KEY);
      const cloudState = await o.page.locator('[data-provider="ollama-cloud"]').first().getAttribute('data-state');
      expect(cloudState ?? '', 'a saved key is not "checked"').not.toMatch(/checked|connected/i);
      await caps.cap(o.page, size, 'models-accounts-key-saved-not-checked', { line: line('Models & accounts', 'a FAKE cloud key saved, not checked'), facts: [`Ollama · cloud: a FAKE key pasted and saved (sent once in the request body; its value in no screen and no DOM, asserted); the card's state "${cloudState ?? '(none)'}" — saved is not checked, nothing green.`], full: true });
      facts.push(`A FAKE cloud key saved, not checked: state "${cloudState ?? '(none)'}".`);
      await o.page.getByRole('button', { name: /Forget the key/ }).first().click({ timeout: 5_000 }).catch(() => undefined);
    } else facts.push('No Ollama API key field on this page (said).');
    // a native ProviderCard per card when mounted (H170 on H174's mountProviderCard)
    const faces = await o.page.locator('[data-provider] [data-rive-component]').count();
    facts.push(faces ? `${faces} native ProviderCard face(s) mounted in the cards (drawn: ${await o.page.locator('[data-provider] canvas[data-timmy-rive][data-loaded]').count()}).` : 'No native ProviderCard face mounted in the cards on this head (said).');
    if (size.width <= 720) {
      // the phone: the page's context as a sheet (H168's §13: "390 with the sheet"), when the page has one
      const ctx = o.page.locator(SHELL.contextButton).first();
      if (await ctx.isVisible().catch(() => false)) {
        await ctx.click();
        await o.page.locator(SHELL.contextSheet).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
        await caps.cap(o.page, size, 'models-accounts-context-sheet', { line: line('Models & accounts', 'the context sheet open on the phone'), facts: ['The page\'s context (the chosen provider\'s card, §6) opened as a sheet on the phone (§4).'], full: true });
        await o.page.keyboard.press('Escape');
      } else facts.push('No context button on the phone for this page (its context is null: hidden, §2.2 — said).');
    }
  },
  async 'Canvas'(o, size, facts) {
    // the companion's Canvas page: its purpose (the board, the jobs, the project) and its primary next action (open the canvas)
    const t = await text(o.page);
    facts.push(/Timmy Canvas|Studio/.test(t) ? 'The companion\'s Canvas page: the board / jobs / project words on the scaffold.' : 'The companion\'s Canvas page read without the Canvas words (said).');
    // the Studio's own page (Timmy Canvas on licensed tldraw): the SDK's own verdict; a guided blank starter opened and drawn; saved → reopened; a switch
    const first = await openCanvas(size);
    try {
      await first.page.waitForFunction(() => { const s = (window as unknown as Win).timmyCanvas?.licenseState; return Boolean(s) && s !== 'pending'; }, null, { timeout: 20_000 }).catch(() => undefined);
      const license = await first.page.evaluate(() => (window as unknown as Win).timmyCanvas.licenseState);
      expect(['licensed', 'licensed-with-watermark', 'unlicensed', 'unlicensed-production', 'expired', 'unknown']).toContain(license);
      if (!realKey) expect(license, 'a FAKE key is not licensed in the SDK\'s own words').not.toMatch(/^licensed/);
      expect(await first.page.evaluate(() => document.body.innerText)).not.toContain('FAKE-license-key');
      // the starters listed (GET /api/canvas/templates: guided, blank first; a Houdini starter when H176 ships one — said which);
      // below 1100 px the Studio's lists start folded behind #side-fold (R7, H151): shown first so New board's controls can be used
      if ((await first.page.locator('#side').first().getAttribute('data-folded').catch(() => null)) === 'true') await first.page.locator('#side-fold').first().click({ timeout: 3_000 }).catch(() => undefined);
      // (the picker's first entry "Blank board" has no value and opens nothing to read: the starters are the options WITH a value)
      const options = await first.page.locator('#board-pick option').evaluateAll((els) => els.filter((e) => (e as HTMLOptionElement).value).map((e) => (e.textContent || '').trim())).catch(() => [] as string[]);
      const houdini = options.find((x) => /houdini/i.test(x));
      const pick = houdini ?? options[0];
      facts.push(`The Studio's starters (#board-pick): ${options.length} listed${houdini ? `, a Houdini starter among them ("${houdini}")` : ', no Houdini starter on this head (H176\'s templates)'}; opened: "${pick ?? '(none listed)'}".`);
      let shapes = 0;
      if (pick) {
        await first.page.locator('#board-pick').selectOption({ label: pick });
        await first.page.locator('#board-open').click();
        await first.page.waitForFunction(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length > 0, null, { timeout: 15_000 });
        shapes = await first.page.evaluate(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length);
        if (houdini) {
          // H176's TEMPLATE SCHEMA v1 on the board: every shape's meta { workbench 'timmy-starter-v1', page 'houdini', role, lane, data, timmyTemplate H<n>,
          // timmyGuide, timmyStarter { key, from P67|T22|T24 } }; a flow / port-binding arrow = an arrow SHAPE plus TWO binding records; the three steps'
          // verbs on the board; "Cook in Houdini" says no native operation is configured; green nowhere on a starter
          const st = await starterOnBoard(first.page);
          expect(st.shapes, 'the starter has shapes').toBeGreaterThan(0);
          expect(st.badMeta, 'every shape carries the schema\'s meta (workbench timmy-starter-v1, page houdini, role, lane, timmyTemplate H<n>, timmyStarter { key, from })').toEqual([]);
          expect(st.arrowsWithoutTwoBindings, 'every flow / port-binding arrow has its two tldraw binding records (start, end)').toEqual([]);
          for (const verb of ['Define the geometry', 'Set the parameters', 'Cook in Houdini']) expect(st.words, `the step "${verb}" on the board`).toContain(verb);
          expect(st.words, 'the Cook step says no native Houdini operation is configured').toMatch(/no native Houdini operation is configured/i);
          expect(st.greens, 'green nowhere on a starter (nothing observed live, passed or sealed)').toEqual([]);
          facts.push(`The Houdini starter on the board (TEMPLATE SCHEMA v1): ${st.shapes} shapes (${st.kinds}), meta workbench "${st.workbench}" page "${st.page}" template ${st.templates.join('/')}; ${st.arrows} flow / port-binding arrows each with its two binding records; the three steps' verbs drawn; the Cook step in its honest words; no green.`);
        } else {
          const metas = await first.page.evaluate(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').map((r) => Object.keys(r.meta ?? {}).sort().join(',')));
          facts.push(`The starter drawn: ${shapes} shapes; their meta keys: ${[...new Set(metas)].join(' | ') || '(none)'}.`);
        }
        await saved(first.page);
        await first.page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
        await first.page.waitForTimeout(400);
      }
      await first.page.locator('#side-fold').first().click({ timeout: 3_000 }).catch(() => undefined);
      await caps.cap(first.page, size, 'canvas-studio-starter', { line: line('Canvas (the Studio)', pick ? `the starter "${pick}" opened blank, drawn, saved` : 'no starter listed'), facts: [`Timmy Canvas (the Studio, tldraw with ${realKey ? 'the environment\'s key — the SDK\'s verdict' : 'a FAKE key the SDK rejects — its verdict'} "${license}"): ${pick ? `the starter "${pick}" opened blank and drawn (${shapes} shapes), saved through Timmy's project storage` : 'no starter listed'}; Timmy's lists folded.`], full: true });
      const before = pick ? await records(first.page) : null;
      expect(first.errors, 'page errors on the Studio').toEqual([]);
      await first.context.close();
      if (before) {
        // reopened in a new page: the records back; a project switch → the other project's board has none of it; back again
        const again = await openCanvas(size);
        try {
          await again.page.waitForFunction((n) => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length >= n, shapes, { timeout: 20_000 });
          expect(await records(again.page), 'the board reopened: every record as saved').toEqual(before);
          await again.page.evaluate(() => { (window as unknown as Win).timmyCanvas.editor.zoomToFit(); });
          await again.page.waitForTimeout(400);
          await caps.cap(again.page, size, 'canvas-reopened', { line: line('Canvas (the Studio)', 'the board reopened in a new page'), facts: [`The board reopened: ${shapes} shapes and every binding exactly as saved (the records compared).`] });
          switchTo('pages-canvas-b', projectB);
          await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'pages-canvas-b'; }, null, { timeout: 20_000 });
          await again.page.waitForTimeout(500);
          expect(await again.page.evaluate(() => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length), 'the other project\'s board is empty of the starter').toBe(0);
          await caps.cap(again.page, size, 'canvas-other-project', { line: line('Canvas (the Studio)', 'the other project (empty board)'), facts: ['Switched to the other project (pages-canvas-b) through the active-project record: its board carries none of the starter (project isolation).'] });
          switchTo('pages-canvas-a', projectA);
          await again.page.waitForFunction(() => { const i = (window as unknown as Win).timmyCanvas.identity; return i?.state === 'shown' && i.project?.name === 'pages-canvas-a'; }, null, { timeout: 20_000 });
          await again.page.waitForFunction((n) => Object.values((window as unknown as Win).timmyCanvas.editor.store.serialize('document')).filter((r) => r.typeName === 'shape').length >= n, shapes, { timeout: 20_000 });
          expect(again.errors, 'page errors on the reopened Studio').toEqual([]);
          facts.push('Reopened in a new page: the records exactly as saved; a project switch → the other board empty; back → the starter again.');
        } finally { await again.context.close(); }
      }
    } catch (e) { await first.context.close().catch(() => undefined); throw e; }
  },
  async 'Files'(o, _size, facts) { facts.push(await stateWords(o, 'Files', /file|folder|project/i)); },
  async 'Workflows'(o, _size, facts) { facts.push(await stateWords(o, 'Workflows', /workflow|run|step/i)); },
  async 'Runs & receipts'(o, _size, facts) { facts.push(await stateWords(o, 'Runs & receipts', /run|receipt|record/i)); },
  async 'VoxVision'(o, _size, facts) { facts.push(await stateWords(o, 'VoxVision', /vision|scan|observ|image|source/i)); },
  async 'Motion & 3D'(o, _size, facts) { facts.push(await stateWords(o, 'Motion & 3D', /motion|3D|clip|render|scene/i)); },
  async 'Tools & integrations'(o, _size, facts) { facts.push(await stateWords(o, 'Tools & integrations', /tool|MCP|integration/i)); },
  async 'Control Room'(o, _size, facts) { facts.push(await stateWords(o, 'Control Room', /control|fleet|clef|workspace|agent/i)); },
  async 'Settings'(o, _size, facts) { facts.push(await stateWords(o, 'Settings', /setting|theme|preference|account/i)); },
  async 'Help'(o, _size, facts) { facts.push(await stateWords(o, 'Help', /help|find|key|shortcut/i)); },
};
/** A page's purpose words and its state: an empty state with a verb-led action, or content; said for the sidecar, the purpose asserted. */
async function stateWords(o: Opened, name: string, purpose: RegExp): Promise<string> {
  const s = await scaffoldOf(o.page);
  const work = await o.page.locator(SHELL.work).first().innerText().catch(() => '');
  expect(`${s.title} ${s.description} ${work}`, `${name}: the page's purpose in its words`).toMatch(purpose);
  // a state marked by the shell (data-state) or read from the words; an empty state carries a verb-led action (a button or a link in the work)
  const actions = await o.page.locator(SHELL.work).first().getByRole('button').or(o.page.locator(SHELL.work).first().getByRole('link')).allInnerTexts().catch(() => [] as string[]);
  const state = s.states[0] || (/nothing yet|no .* yet|empty|none yet/i.test(work) ? 'empty (read from the words)' : 'content (read from the words)');
  return `${name}: state "${state}"; the work's actions: ${actions.map((a) => a.trim()).filter(Boolean).slice(0, 6).join(' · ') || '(none)'}.`;
}
