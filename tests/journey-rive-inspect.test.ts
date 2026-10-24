/**
 * R11 round 5 (H172; the journey leg for H174's Rive components, contract of 23:52 PT as merged): the page's Rive bindings and
 * the "Inspect animation" view, end to end, on a CONFIGURED companion with a FAKE identity provider's RS256 session (verified by
 * the real verifier; no Clerk account, no network) and a FAKE Ollama on 127.0.0.1 (no model behind it).
 *
 * What this checkout holds decides the path, and the leg says which it took (H174's 7b34db2e): the operator's native asset
 * src/companion/assets/rive/timmy-ui/timmy-ui.riv (gitignored `*.riv`; beside its editable source, which IS committed) — when the
 * file is beside its source, the six components are DRAWN by @rive-app/canvas served from this origin (/vendor/rive/), the page's
 * policy carries wasm-unsafe-eval, the runtime reports the asset's artboards (AgentConsole, ProviderCard, ActionButton), its state
 * machine TimmyUI and its inputs, and every binding event records the native input it set beside the word (working → State 1,
 * stopping → State 1 with its note, stopped → State 3, idle → State 0; connected → State 0, the HTML label alone saying connected);
 * when the file is not here (a checkout without the ignored file: CI), every component shows its state WORD only and the Inspect
 * view says so ("words only"). The words path is no longer exercised in a checkout that has the file: the companion's listing reads
 * src/companion/assets/rive/ (server.ts mounts it without a folder override), so this leg cannot point it at an empty folder.
 * Either way the state of every component is the HTML word beside it (aria-live), which follows the page's drawing of the
 * backend's own events (H170's cards, H171's turns) or, where an owner feeds it (the chat's SSE handler calls TimmyRive.fromSse /
 * stopping), the backend's own event ("POST /api/chat/turn · SSE <event>", "POST /api/chat/stop { id: … }"); a derived event is
 * labelled so, never as the event itself. The T mark stays the text mark (no timmy-mark.riv here) on both paths.
 *
 * Known miss, named and not hidden (H174's 7b34db2e finding, H171's line): once the Inspect view has loaded the runtime,
 * chat-shell.js drawMarks() asks /assets/timmy-mark.riv for every text mark it draws without asking /assets/mark.json first; the
 * companion answers 404 (the file is not here) and the runtime logs "Failed to fetch the Rive file: HTTP 404". That one request
 * is counted apart (o.markAsks) and reported; it is not a page error and nothing else may be missing.
 *
 *  1. GET /api/rive/assets: 401 without the launch token; 401 { needs: 'session' } with the token alone (configured → no operator
 *     fallback); 200 with the session: { ok, runtime, components } — the drafted components' riv null, timmy-ui's riv the file
 *     (name, 405,278 bytes, sha256 9fd9ae7c0981) when it is here, its meta from rive.yaml; the source files served by exact name
 *     (GET /assets/rive/<component>/scene.rml), the font not served, a path or an unknown name → 404 in words.
 *  2. Chromium, 1440x900 and 390x844: the Inspect view on #inspect lists welcome, the four connections, activity and the mark;
 *     every runtime row reads "drawn by @rive-app/canvas" (the asset here) or "words only"; the connection labels read "disconnected" for cards that are not set up, and
 *     "connected" for Ollama · local once Check made its card "checked" — the event's source says it is derived from the page's
 *     drawing; the PREVIEW label stands on every operational card and a preview moves the label with source 'PREVIEW' only (no
 *     receipt, no progress, nothing asked of the FAKE Ollama); the welcome fires on a trusted click only (a programmatic click
 *     records nothing); reduced motion is said in the card; no page error.
 *  3. The REAL turn: after a model is chosen, a message to the FAKE model moves the activity label to "working" and then "idle"
 *     (the turn answered), and Stop on a slow turn ends in "stopped" — from the backend's own SSE / the Stop's POST where the feed
 *     spoke, the page's drawing otherwise, said so; with the asset here, each event's native State beside its word.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';
import { capturer } from './fixtures/journey-caps.js';
/** Capture points (inert unless TIMMY_JOURNEY_CAPS names a folder): the operator's Inspect-view captures. */
const caps = capturer('tests/journey-rive-inspect.test.ts', [
  'REAL: the companion, its launch token and page, the identity verifier (RS256 against CLERK_JWT_KEY), H174\'s Rive bindings (window.TimmyRive) and the Inspect view, the agent turn and its SSE (POST /api/chat/turn), the Stop route.',
  'FAKE: the identity provider (an RSA pair made by the test, its public key as CLERK_JWT_KEY, the session minted by the test), the Ollama on 127.0.0.1 (one FAKE model; the slow answer is scripted a word every 700 ms).',
]);

const PORT = 4498;
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'c4'.repeat(32);
const USER = fakeUserId('rive');
const MODEL = 'fake-qwen3:8b';
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
const PREVIEW_LABEL = 'Preview playback — not an execution, no progress, no receipt';
const COMPONENTS = ['welcome', 'connection-openrouter', 'connection-ollama-local', 'connection-ollama-cloud', 'connection-cloudflare', 'activity', 'mark'];
/** The six components the runtime draws when the native asset is here (the mark has no file either way). */
const DRAWN = ['activity', 'connection-cloudflare', 'connection-ollama-cloud', 'connection-ollama-local', 'connection-openrouter', 'welcome'];
/** The operator's native asset as H174's README states it (timmy-ui.riv: 405,278 bytes; the listing's sha256 is its first 12 hex). */
const NATIVE = { name: 'timmy-ui.riv', bytes: 405_278, sha256: '9fd9ae7c0981', artboards: ['AgentConsole', 'ProviderCard', 'ActionButton'], stateMachine: 'TimmyUI', inputs: ['State', 'Hover', 'Pressed', 'ReducedMotion'] };
/** Which path this checkout takes: decided by the first case from GET /api/rive/assets (the file beside its source, and the runtime served). */
let native: boolean | null = null;
const pathWords = (): string => native ? `DRAWN: ${NATIVE.name} is beside its source in this checkout and @rive-app/canvas is served from this origin` : 'WORDS ONLY: no .riv beside the sources in this checkout (every state is the word beside its component)';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p as string));
if (!browserPath) console.warn('journey-rive-inspect: no Chromium found, so the browser leg is skipped here (said, not passed)');

let box = '';
let timmyHome = '';
let identity: FakeIdentity;
let ollama: FakeOllamaJourney;
let browser: Browser;
let companion: CompanionServer;
const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_MCP_HOME', 'TIMMY_STORE', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'OLLAMA_BASE_URL', 'TIMMY_REPO'];

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  box = mkdtempSync(join(tmpdir(), 'journey-rive-'));
  timmyHome = join(box, 'home', 'timmy');
  mkdirSync(timmyHome, { recursive: true });
  ollama = await startFakeOllamaJourney({
    models: [{ name: MODEL, size: 4_900_000_000, family: 'qwen3', parameterSize: '8B' }],
    tool: { name: 'get_current_time', arguments: {} },
    answer: FAKE_ANSWER,
    slow: { when: /slowly/i, words: 'FAKE slow answer one word at a time so that Stop can end it before it is done'.split(' '), slowMs: 700 },
  });
  identity = fakeIdentityProvider({ azp: `http://127.0.0.1:${PORT}` });
  const userHome = join(timmyHome, 'users', USER);
  mkdirSync(userHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(userHome, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }), { mode: 0o600 });
  const env = identity.env({ ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: '', OLLAMA_HOST: ollama.url });
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete env[k];
  Object.assign(process.env, env);
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY']) delete process.env[k];
  // no name but 127.0.0.1 resolves; the container's proxy variables are not handed to Chromium (it reads them, --no-proxy-server notwithstanding)
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  companion = await startCompanionServer(PORT, { token: TOKEN, chatEnv: env, workspace: { env, shareMs: 0 } });
}, 90_000);

afterAll(async () => {
  await companion?.shutdown();
  await browser?.close();
  await ollama?.close();
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  if (box) rmSync(box, { recursive: true, force: true });
}, 30_000);

// ── the calls ─────────────────────────────────────────────────────────────────

async function api(method: string, path: string, o: { session?: string; token?: string | null; body?: unknown } = {}): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.session) headers[SESSION_HEADER] = o.session;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL(path, companion.address), { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const t = await res.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { /* words */ }
  return { status: res.status, json, text: t };
}

// ── the page ──────────────────────────────────────────────────────────────────

interface Opened { page: Page; errors: string[]; missing: string[]; markAsks: string[]; left: string[]; close: () => Promise<void> }

async function open(size: { width: number; height: number }, o: { reducedMotion?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}) });
  const page = await context.newPage();
  const errors: string[] = [];
  const missing: string[] = [];
  const markAsks: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // the known miss (header): chat-shell's drawMarks asks /assets/timmy-mark.riv once window.rive is here; the runtime's own line
    if (/Failed to fetch the Rive file: HTTP 404/.test(t) || (/Failed to load resource/.test(t) && / 404 /.test(t) && /\/assets\/timmy-mark\.riv/.test(m.location().url))) { markAsks.push(`${t} — ${m.location().url}`); return; }
    if (!/Failed to load resource/.test(t)) { errors.push(t); return; }
    if (/ 401 /.test(t)) return; // the page's own first reads before a session, by design
    if (/ERR_NAME_NOT_RESOLVED/.test(t) && /clerk\.accounts\.invalid/.test(m.location().url)) return; // Clerk's fetches to the FAKE instance
    missing.push(`${t} — ${m.location().url}`);
  });
  // (a blob: address is this origin's own — Clerk's Web Worker from a blob of its code; data: likewise)
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.protocol === 'blob:' || u.protocol === 'data:') return; if (u.hostname !== '127.0.0.1' && !/clerk\.accounts\.invalid$/.test(u.hostname)) left.push(r.url()); } catch { /* data: */ } });
  await page.goto(companion.url);
  // the session, as the account screen gives it after a sign-in (H173's seam), once the page's own landing settled
  await page.waitForFunction(() => Boolean((window as unknown as { TimmyShell?: { identity?: () => unknown } }).TimmyShell?.identity?.()), null, { timeout: 15_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  const ok = await page.evaluate(async (t) => {
    const w = window as unknown as { timmyAccount?: { useSession?: (token: string) => Promise<unknown> } };
    if (!w.timmyAccount?.useSession) return 'absent';
    await w.timmyAccount.useSession(t);
    return 'ok';
  }, identity.token(USER)).catch((e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`);
  expect(ok, 'the page\'s session seam (window.timmyAccount.useSession)').toBe('ok');
  return { page, errors, missing, markAsks, left, close: () => context.close() };
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
/** The HTML status label beside a component (aria-live): the exact state word. */
const label = (page: Page, key: string): Promise<string> => page.locator(`[data-rive-status="${key}"]`).first().innerText().then((t) => t.trim());
async function labelIs(page: Page, key: string, word: RegExp, ms = 15_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  for (;;) {
    last = await label(page, key).catch(() => '(no label)');
    if (word.test(last)) return last;
    if (Date.now() > end) {
      // (for the words of a failure: the turns the derivation reads, and the handle's events)
      const facts = await page.evaluate((k) => {
        const turns = [...document.querySelectorAll('#cx-turns li, #cx-own li')].map((li) => `${li.parentElement?.id}>${li.className}${(li as HTMLElement).dataset.own ? ` own=${(li as HTMLElement).dataset.own}` : ''}`);
        const ev = [...document.querySelectorAll(`[data-inspect-events="${k}"] li`)].map((li) => `${li.querySelector('code')?.textContent ?? ''} · ${li.getAttribute('data-event-source') ?? ''}`);
        const cards = [...document.querySelectorAll('[data-provider][data-state]')].map((c) => `${c.getAttribute('data-provider')}=${c.getAttribute('data-state')}`);
        const R = (window as unknown as { TimmyRive?: { inspect?: () => Array<{ id: string; component?: string; binds?: string[]; values?: unknown; state?: string; events?: unknown[] }> } }).TimmyRive;
        const handles = R?.inspect ? R.inspect().map((x) => `${x.component ?? x.id}: binds=${JSON.stringify(x.binds ?? null)} values=${JSON.stringify(x.values ?? null)} state=${x.state ?? '?'} events=${Array.isArray(x.events) ? x.events.length : '?'}`) : ['no TimmyRive.inspect'];
        return `#cx-turns/#cx-own: [${turns.join(' | ')}]; cards: [${cards.join(', ')}]; events of ${k} in the view: [${ev.join(' | ')}]; handles: [${handles.join(' || ')}]`;
      }, key).catch(() => 'facts unreadable');
      throw new Error(`the label of ${key} did not read ${word} within ${ms} ms: it reads "${last}"; ${facts}`);
    }
    await page.waitForTimeout(100);
  }
}
/**
 * The source words a binding event may carry: FED by the owner's code with the backend's own event (H171's chat-shell.js:
 * "POST /api/chat/turn · SSE <event> (<status>)", "POST /api/chat/stop { id: … } (this page's Stop)"), or, until an owner feeds it,
 * DERIVED from the page's drawing ("derived from the page's drawing of …"). The activity is fed (H171, 582935d9): where the feed
 * spoke (TimmyRive.activityFed()), its words are the ones asserted — the operator's "real backend events drive operational states".
 */
const FED_TURN = /POST \/api\/chat\/turn · SSE (route|turn|delta|tool|needs-you|done|error)/;
const FED_STOP = /POST \/api\/chat\/stop \{ id: |POST \/api\/chat\/turn: this page stop(?:s|ped) reading/; // ("stopping" by the Stop's POST; "stopped" by this page's own end of the stream, in H171's words)
const DERIVED_TURN = /derived from the page.s drawing of the turn/;
const DERIVED_STOP = /derived from the page.s Stop button/;
const activityFed = (page: Page): Promise<boolean> => page.evaluate(() => Boolean((window as unknown as { TimmyRive?: { activityFed?: () => boolean } }).TimmyRive?.activityFed?.()));
/** What TimmyRive.inspect() reports of one component: its state, contract, the runtime's names and live input values, its events with the native input each set. */
interface Handle { component?: string; id: string; state: string; contract: string | null; nativeReduced: boolean; runtime: { artboardNames: string[]; stateMachineNames: string[]; inputs: Array<{ name: string; type: string; value: unknown }> } | null; events: Array<{ input: string; value: unknown; source: string; did: string; native: { input: string; value: unknown; note?: string } | null }> }
const handleOf = (page: Page, key: string): Promise<Handle | null> => page.evaluate((k) => { const R = (window as unknown as { TimmyRive?: { inspect?: () => Handle[] } }).TimmyRive; return R?.inspect?.().find((x) => x.component === k) ?? null; }, key);
/** The live value of one input on a drawn component's state machine (null on the words path). */
const inputValue = async (page: Page, key: string, name: string): Promise<unknown> => (await handleOf(page, key))?.runtime?.inputs.find((i) => i.name === name)?.value ?? null;
/** The native input and value the newest event carrying `word` set (the asset's contract), as "State 1" / "State 1 (note)". */
async function nativeOf(page: Page, key: string, input: string, word: unknown): Promise<string> {
  const h = await handleOf(page, key);
  const e = [...(h?.events ?? [])].reverse().find((x) => x.input === input && x.value === word);
  if (!e) return `(no ${input} = ${JSON.stringify(word)} event)`;
  return e.native ? `${e.native.input} ${JSON.stringify(e.native.value)}${/\(/.test(e.did) ? ` ${e.did.slice(e.did.indexOf('('))}` : ''}` : '(HTML only)';
}
/** The binding events the Inspect view lists for a component: each as "<input = value> · <source>". */
const events = (page: Page, key: string): Promise<string[]> => page.locator(`[data-inspect-events="${key}"] li`).evaluateAll((lis) => lis.map((li) => `${li.querySelector('code')?.textContent ?? ''} · ${li.getAttribute('data-event-source') ?? ''}`));
/** The Inspect view opens on the #inspect fragment (until the shell knows the screen); Close clears it. */
async function openInspect(page: Page): Promise<string> {
  await page.evaluate(() => { location.hash = '#inspect'; });
  // (the view's own section: #screen-inspect, shown on the fragment; its text is read from the section itself — the body's innerText
  // reads empty while the section is up, so the page's text is not the measure here)
  await page.waitForSelector('#screen-inspect:not([hidden]) [data-inspect-component]', { timeout: 30_000 });
  await page.waitForFunction(() => !/Reading the companion/.test(document.querySelector('[data-inspect-listing]')?.textContent || ''), null, { timeout: 30_000 });
  // every component settled: drawn by the runtime (the asset here) or the words (a missing file is declared after the bindings' patience)
  await page.waitForFunction(() => { const els = [...document.querySelectorAll('[data-inspect-runtime]')]; return els.length >= 7 && els.every((e) => /words only|drawn by/.test(e.textContent || '')); }, null, { timeout: 30_000 });
  return page.locator('#screen-inspect').innerText();
}
async function closeInspect(page: Page): Promise<void> {
  await page.locator('[data-inspect-close]').first().click();
  await page.waitForFunction(() => location.hash !== '#inspect', null, { timeout: 5_000 });
}

// ── the leg ───────────────────────────────────────────────────────────────────

describe('the Rive components and the Inspect animation view: a FAKE identity provider\'s RS256 session verified by the real verifier, a FAKE Ollama on 127.0.0.1; DRAWN by the runtime when the operator\'s timmy-ui.riv is beside its source, words only when not — said which (R11 round 5, H172 for H174)', { timeout: 240_000 }, () => {
  it('GET /api/rive/assets: 401 without the launch token; 401 needs:session with the token alone (configured); 200 with the session — the drafted components\' riv null, timmy-ui\'s riv the file when it is here (405,278 bytes, sha256 9fd9ae7c0981) with its meta; the source files by exact name, the font not served, a path or an unknown name 404 in words; the page\'s policy carries wasm-unsafe-eval when the file and the runtime are here', async () => {
    const none = await api('GET', '/api/rive/assets', { token: null });
    expect(none.status, none.text.slice(0, 200)).toBe(401);
    const alone = await api('GET', '/api/rive/assets');
    expect(alone.status, `the launch token alone, configured: ${alone.text.slice(0, 200)}`).toBe(401);
    expect(alone.json?.needs).toBe('session');
    const r = await api('GET', '/api/rive/assets', { session: identity.token(USER) });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json?.ok).toBe(true);
    expect(typeof r.json?.runtime, 'whether @rive-app/canvas is served (/vendor/rive/)').toBe('boolean');
    const rows: Array<{ component: string; riv: { name: string; bytes: number; sha256: string } | null; sources: string[]; words: string; meta: { artboard?: string; artboards?: string[]; stateMachine?: string; inputs?: string[] } }> = r.json?.components ?? [];
    expect(rows.map((c) => c.component).sort()).toEqual(['activity', 'connection', 'timmy-ui', 'welcome']);
    for (const c of rows) {
      expect(c.sources, `${c.component}'s editable source beside the asset`).toEqual(expect.arrayContaining(['scene.rml', 'rive.yaml', 'README.md']));
      expect(typeof c.words).toBe('string');
      if (c.component !== 'timmy-ui') expect(c.riv, `${c.component}: a drafted source, its .riv never compiled here`).toBeNull();
    }
    // the operator's native asset: its source committed beside it (the generator, the font's license), the file itself gitignored —
    // here when the checkout carries it; the path this leg takes follows, and is said
    const ui = rows.find((c) => c.component === 'timmy-ui')!;
    expect(ui.sources).toEqual(expect.arrayContaining(['scene.rml', 'rive.yaml', 'README.md', 'create-controls.py', 'OFL.txt']));
    expect(ui.meta.stateMachine).toBe(NATIVE.stateMachine);
    expect(ui.meta.artboards).toEqual(NATIVE.artboards);
    expect(ui.meta.inputs).toEqual(NATIVE.inputs);
    native = ui.riv !== null && r.json.runtime === true;
    console.warn(`journey-rive-inspect: ${pathWords()}${ui.riv ? '' : ' — the .riv is not beside its source (gitignored *.riv; this checkout has not got it)'}${r.json.runtime ? '' : ' — the runtime (@rive-app/canvas) is not served'}`);
    const riv = await fetch(new URL('/assets/rive/timmy-ui/timmy-ui.riv', companion.address), { headers: { Authorization: `Bearer ${TOKEN}`, [SESSION_HEADER]: identity.token(USER) } });
    if (ui.riv) {
      expect(ui.riv).toEqual({ name: NATIVE.name, bytes: NATIVE.bytes, sha256: NATIVE.sha256 });
      expect(ui.words).toMatch(/\.riv and its editable source are both here/);
      expect(riv.status, 'the .riv served by exact name').toBe(200);
      expect((await riv.arrayBuffer()).byteLength).toBe(NATIVE.bytes);
    } else {
      expect(ui.words).toMatch(/compiled \.riv is not/);
      expect(riv.status, 'no file: 404 in words').toBe(404);
    }
    // the page's policy: the WebAssembly keyword only when there is a file to draw and a runtime to draw it with
    const pageRes = await fetch(new URL('/', companion.address), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(pageRes.status).toBe(200);
    const policy = pageRes.headers.get('content-security-policy') || '';
    if (native) expect(policy, 'wasm-unsafe-eval on the page with the asset and the runtime here').toContain('wasm-unsafe-eval');
    else expect(policy, 'no WebAssembly keyword without a file to draw').not.toContain('wasm-unsafe-eval');
    // the font beside the asset is kept, not served (the .riv embeds what it needs: H174's README)
    const font = await api('GET', '/assets/rive/timmy-ui/Montserrat.ttf');
    expect(font.status, `the font is not served: ${font.text.slice(0, 120)}`).toBe(404);
    const src = await api('GET', '/assets/rive/connection/scene.rml');
    expect(src.status, src.text.slice(0, 200)).toBe(200);
    expect(src.text).toMatch(/artboard|state|machine|TimmyConnection|<rive|rml/i);
    const rml = await api('GET', '/assets/rive/timmy-ui/scene.rml');
    expect(rml.status).toBe(200);
    expect(rml.text).toContain('name="AgentConsole"');
    expect(rml.text).toContain('<StateMachine name="TimmyUI"');
    for (const bad of ['/assets/rive/connection/../mark/scene.rml', '/assets/rive/connection/nothing.riv', '/assets/rive/no-such-component/scene.rml']) {
      const b = await api('GET', bad);
      expect(b.status, `${bad}: ${b.text.slice(0, 200)}`).toBe(404);
      expect(b.text.trim().length, `${bad}: 404 with words`).toBeGreaterThan(0);
      expect(b.text).not.toMatch(/\/home\/|\/Users\//);
    }
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const at = `${size.width}x${size.height}`;

    it.skipIf(!browserPath)(`${at}: the Inspect view lists every component — drawn by the runtime out of timmy-ui.riv with its artboard, TimmyUI and its inputs when the file is here, words only when not (said which); the connection labels follow the cards (Check → connected, said as derived; State 0, no success pose); the PREVIEW label stands and a preview moves the label (and State) only; the welcome fires on a trusted click only; no page error`, async () => {
      const o = await open(size);
      try {
        // signed in, no route → the connections screen (its cards carry data-provider + data-state, which the bindings read)
        await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s) && /Ollama · local/.test(s));
        const view = await openInspect(o.page);
        await caps.cap(o.page, size, 'inspect-view', [`The Inspect animation view (#inspect) over the connections screen. ${pathWords()}.`, native ? 'The six components are drawn by @rive-app/canvas (this origin) out of timmy-ui.riv — AgentConsole for the activity, ProviderCard for each connection, ActionButton for the welcome — each with its artboard, TimmyUI and the inputs\' live values in its card; the T mark stays the text mark (no timmy-mark.riv). The derived connection labels follow the cards.' : 'Every component a card of words (the runtime rows say "words only"; the .riv named as missing, not an error); the derived connection labels follow the cards.']);
        for (const key of COMPONENTS) expect(await o.page.locator(`[data-inspect-component="${key}"]`).count(), `the card of ${key}`).toBe(1);
        expect(native, 'the path was decided by the first case').not.toBeNull();
        // the runtime rows: drawn (the asset here) or words only; the mark's file is not here on either path; never an error
        for (const key of COMPONENTS) {
          const runtime = await o.page.locator(`[data-inspect-runtime="${key}"]`).first().innerText();
          if (native && key !== 'mark') expect(runtime, `${key}'s runtime row`).toMatch(/drawn by @rive-app\/canvas \(this origin, \/vendor\/rive\/\)/);
          else expect(runtime, `${key}'s runtime row`).toMatch(/words only/i);
        }
        expect(view).not.toMatch(/\bError\b|undefined|NaN/);
        expect(view).toMatch(/not in this installation|no file|words only/i);
        if (native) {
          // REAL: the runtime loaded from this origin drew the six (canvas[data-loaded] is set by TimmyRive's onLoad only); the mark not
          expect(await o.page.evaluate(() => typeof (window as unknown as { rive?: { Rive?: unknown } }).rive?.Rive), 'window.rive from /vendor/rive/').toBe('function');
          // (the Inspect view's own six: round 6 draws more on the page — H171's console band and starter, H170's four provider cards)
          expect(await o.page.$$eval('#screen-inspect canvas[data-timmy-rive][data-loaded]', (els) => els.map((e) => e.getAttribute('data-timmy-rive')).sort())).toEqual(DRAWN);
          expect(await o.page.$$eval('[data-inspect-component="mark"] canvas[data-loaded]', (els) => els.length)).toBe(0);
          // what the RUNTIME reports of the asset (not the source's names): the three artboards, TimmyUI, the four inputs with values
          for (const key of DRAWN) {
            const h = (await handleOf(o.page, key))!;
            expect(h.state, `${key} drawn`).toBe('drawn');
            expect(h.contract, `${key} on the TimmyUI contract`).toBe('TimmyUI');
            expect(h.runtime!.artboardNames, `${key}: the artboards the runtime reports`).toEqual(NATIVE.artboards);
            expect(h.runtime!.stateMachineNames).toEqual([NATIVE.stateMachine]);
            expect(h.runtime!.inputs.map((i) => i.name)).toEqual(NATIVE.inputs);
            expect(h.nativeReduced, `${key}: the asset has its own ReducedMotion input`).toBe(true);
          }
          const factsOf = (key: string): Promise<string> => o.page.locator(`[data-inspect-component="${key}"] .tr-facts`).innerText();
          const act = await factsOf('activity');
          expect(act).toContain('artboard AgentConsole');
          expect(act).toContain(NATIVE.artboards.join(', '));
          expect(act).toMatch(/State · Number · \d/);
          expect(act).toContain('Native contract');
          expect(act).toContain('stopping → State 1 until the backend says cancelled → 3');
          for (const p of ['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']) expect(await factsOf(`connection-${p}`), `connection-${p} on ProviderCard`).toContain('artboard ProviderCard');
          expect(await factsOf('welcome')).toContain('artboard ActionButton');
          // the binding state row says the word AND the native input it set
          expect(await o.page.locator('[data-inspect-values="connection-openrouter"]').innerText()).toMatch(/connection = "disconnected" → State 0/);
        }
        // the connection labels: the cards not set up / not installed → "disconnected" (the vocabulary's word, in the HTML label);
        // a card ALREADY "checked" when the view opens (the companion kept the observation from an earlier Check) → "connected" at once
        for (const p of ['openrouter', 'ollama-cloud', 'cloudflare']) expect(await label(o.page, `connection-${p}`), `connection-${p}`).toBe('disconnected');
        const localState = await o.page.locator('[data-provider="ollama-local"]').first().getAttribute('data-state');
        if (localState === 'checked') expect(await labelIs(o.page, 'connection-ollama-local', /^connected$/, 5_000).catch((e: Error) => e.message), 'a card already checked when the Inspect view opens must read connected (H174: the first look() runs before the view\'s handles exist, so a state seen then is never applied to them)').toBe('connected');
        else expect(await label(o.page, 'connection-ollama-local')).toBe('disconnected');
        // the PREVIEW label on every operational card; the welcome has none (a user trigger); the mark has no preview
        for (const key of ['connection-openrouter', 'connection-ollama-local', 'connection-ollama-cloud', 'connection-cloudflare', 'activity']) {
          expect(await o.page.locator(`[data-preview-words="${key}"]`).first().innerText(), `${key}'s preview label`).toBe(PREVIEW_LABEL);
        }
        expect(await o.page.locator('[data-inspect-component="welcome"]').innerText()).toMatch(/user trigger|press the component/i);
        // a preview moves the label with source PREVIEW only: no receipt, no progress, nothing asked of the FAKE Ollama, no other state
        const chatsBefore = ollama.chats().length;
        await o.page.locator('[data-preview="activity:working"]').first().click();
        expect(await labelIs(o.page, 'activity', /^working$/)).toBe('working');
        const ev = await events(o.page, 'activity');
        expect(ev.some((e) => /activity = "working"/.test(e) && /PREVIEW/.test(e)), `a PREVIEW event: ${ev.join(' | ')}`).toBe(true);
        if (native) {
          // the preview moved the native State to 1 (the asset's Working pose) — and nothing else
          expect(await nativeOf(o.page, 'activity', 'activity', 'working')).toBe('State 1');
          expect(await inputValue(o.page, 'activity', 'State'), 'the live State input on AgentConsole').toBe(1);
        }
        const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
        expect(card).not.toMatch(/receipt [0-9a-f]{8}|\d+ ?%|sha256_/i);
        expect(ollama.chats().length, 'the FAKE Ollama got nothing from a preview').toBe(chatsBefore);
        await o.page.locator('[data-preview="activity:idle"]').first().click();
        expect(await labelIs(o.page, 'activity', /^idle$/)).toBe('idle');
        if (native) expect(await inputValue(o.page, 'activity', 'State'), 'State back to 0 Idle').toBe(0);
        // the welcome: a programmatic click records nothing; a trusted click fires the trigger (recorded with its source)
        await o.page.evaluate(() => { document.querySelector<HTMLElement>('button[data-rive-face="welcome"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await o.page.waitForTimeout(300);
        expect((await events(o.page, 'welcome')).filter((e) => /welcome/.test(e)), 'no welcome event from an untrusted click').toEqual([]);
        await o.page.locator('button[data-rive-face="welcome"]').first().click();
        const end = Date.now() + 5_000;
        let fired: string[] = [];
        while (Date.now() < end) { fired = (await events(o.page, 'welcome')).filter((e) => /welcome/.test(e)); if (fired.length) break; await o.page.waitForTimeout(100); }
        expect(fired.length, 'one welcome event from the trusted click').toBeGreaterThan(0);
        expect(fired[0]).toMatch(/click|Enter|Space|trusted/i);
        // Check on Ollama · local against the FAKE: the card's state becomes "checked" and the binding derives "connected", said so
        await closeInspect(o.page);
        await o.page.getByRole('button', { name: /^Check$/ }).first().click();
        // the card's own state first (H170's data-state: "checked" once the FAKE answered its list), then the binding's word
        await o.page.waitForSelector('[data-provider="ollama-local"][data-state="checked"]', { timeout: 20_000, state: 'attached' }).catch(async () => {
          const st = await o.page.locator('[data-provider="ollama-local"]').first().getAttribute('data-state').catch(() => null);
          throw new Error(`the local card did not become "checked" after Check (H170's card): data-state="${st}"`);
        });
        await openInspect(o.page);
        expect(await labelIs(o.page, 'connection-ollama-local', /^connected$/)).toBe('connected');
        const conn = await events(o.page, 'connection-ollama-local');
        const derived = conn.find((e) => /connection = "connected"/.test(e));
        expect(derived, `the connected event: ${conn.join(' | ')}`).toBeTruthy();
        // (the connections are not fed by H170's screen yet: the word is derived from the card's data-state, said so; a fed one would
        // name GET /api/connections with the provider state itself)
        expect(derived!, 'the event names its source: the backend event (fed) or the page\'s drawing of it (derived), never neither').toMatch(/derived from the page.s drawing of GET \/api\/connections|GET \/api\/connections: ollama-local/);
        if (native) {
          // connected has NO success pose on the asset (none is authored, by design): State stays 0, the HTML label alone says connected, the event says why
          // (the note rides on the move; a word that reached the card before its file loaded was "kept until the file loads" and applied
          // on load — the native State 0 and the facts row below say the same either way)
          expect(await nativeOf(o.page, 'connection-ollama-local', 'connection', 'connected')).toMatch(/^State 0( \(no success pose is authored: State stays 0 Idle; the label says connected\))?$/);
          expect(await inputValue(o.page, 'connection-ollama-local', 'State')).toBe(0);
          expect(await o.page.locator('[data-inspect-component="connection-ollama-local"] .tr-facts').innerText()).toContain('connected has NO success pose');
        }
        expect(await label(o.page, 'connection-openrouter'), 'the other cards stay as they are').toBe('disconnected');
        await closeInspect(o.page);
        expect(o.left, 'requests that left 127.0.0.1 (Clerk\'s fetches to the FAKE instance aside)').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, `resources the page asked for and the companion has not (the mark's known miss counted apart: ${o.markAsks.length})`).toEqual([]);
        if (!native) expect(o.markAsks, 'without the runtime loaded nothing asks for the mark\'s file').toEqual([]);
      } finally { await o.close(); }
    });
  }

  it.skipIf(!browserPath)('reduced motion: with the asset here its own ReducedMotion input is true (zero-duration transitions; the runtime settles and stops moving), else the card says the runtime would be paused on its first frame; the labels carry the state; no page error', async () => {
    const o = await open({ width: 1440, height: 900 }, { reducedMotion: true });
    try {
      await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s));
      const view = await openInspect(o.page);
      expect(view).toMatch(/Reduced motion/);
      const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
      if (native) {
        expect(card).toMatch(/Reduced motion\s*\n?\s*on: the asset’s own ReducedMotion input is true/);
        expect(await inputValue(o.page, 'activity', 'ReducedMotion'), 'the live ReducedMotion input').toBe(true);
        expect((await handleOf(o.page, 'activity'))?.nativeReduced).toBe(true);
      } else expect(card).toMatch(/Reduced motion\s*\n?\s*on: the runtime is paused on its first frame/);
      expect(await label(o.page, 'activity')).toBe('idle');
      await closeInspect(o.page);
      expect(o.errors, 'page errors').toEqual([]);
    } finally { await o.close(); }
  });

  it.skipIf(!browserPath)('the REAL turn moves the activity label: working while the FAKE model answers, idle when it has; Stop on a slow turn → stopped — each from the backend\'s own SSE / Stop where the feed spoke, said so; with the asset here, each event\'s native State beside its word (working 1, stopping 1 with its note, stopped 3, idle 0)', async () => {
    const o = await open({ width: 1440, height: 900 });
    try {
      await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s));
      // the activity component exists once the Inspect view made it; the bindings then follow the chat's turns wherever the view is
      await openInspect(o.page);
      expect(await label(o.page, 'activity')).toBe('idle');
      await closeInspect(o.page);
      await o.page.getByRole('button', { name: /Continue to the workspace|Explore without a model/ }).first().click();
      await until(o.page, 'the chat', (s) => /Message Timmy/i.test(s));
      // the model: the "Ollama local" tab, the FAKE model, "Use for the next turn" (H171's panel)
      await o.page.getByRole('tab', { name: 'Ollama local' }).first().click();
      await until(o.page, 'the FAKE model in the list', (s) => s.includes(MODEL), 20_000);
      await o.page.locator('#cm-list').getByText(MODEL, { exact: false }).first().click();
      const use = o.page.getByRole('button', { name: /Use for the next turn/ }).first();
      await use.click({ timeout: 10_000 }).catch(async () => { const li = o.page.locator('#cm-list li', { hasText: MODEL }).first(); await li.focus(); await li.press('Enter'); });
      await until(o.page, 'the model chosen', (s) => /Next turn: fake-qwen3:8b|fake-qwen3:8b[^\n]*(ready|this computer)/.test(s), 20_000);
      // a quick turn first: the FAKE answers within ~150–300 ms, so "working" is read from the RECORDED binding events (the label
      // holds it only that long: a timer-held minimum would be a fabricated state, refused — H174's 01:36 evidence), and "idle" from
      // the label once the answer stands
      const composer = o.page.getByRole('textbox', { name: /Message Timmy/i }).or(o.page.getByPlaceholder(/Message Timmy/i));
      const recorded = (): Promise<string[]> => o.page.evaluate(() => {
        const R = (window as unknown as { TimmyRive?: { inspect?: () => Array<{ component?: string; id: string; events?: Array<{ input: string; value: unknown; source: string }> }> } }).TimmyRive;
        const h = R?.inspect?.().find((x) => x.component === 'activity');
        return (h?.events ?? []).map((e) => `${e.input} = ${JSON.stringify(e.value)} · ${e.source}`);
      });
      const eventsBefore = (await recorded()).length;
      await composer.first().fill('FAKE: what time is it?');
      await o.page.getByRole('button', { name: /^Send/ }).first().click();
      await until(o.page, 'the FAKE answer', (s) => s.includes(FAKE_ANSWER), 60_000);
      expect(await labelIs(o.page, 'activity', /^idle$/, 20_000)).toBe('idle');
      const quick = (await recorded()).slice(eventsBefore);
      const fed = await activityFed(o.page);
      const turnSource = fed ? FED_TURN : DERIVED_TURN;
      expect(quick.some((e) => /^activity = "working" · /.test(e) && turnSource.test(e)), `the quick turn's "working", recorded from ${fed ? 'the SSE feed (POST /api/chat/turn)' : 'the page\'s drawing'}: ${quick.join(' | ')}`).toBe(true);
      expect(quick.some((e) => /^activity = "idle" · /.test(e) && turnSource.test(e)), `the quick turn's "idle", recorded from ${fed ? 'the SSE feed (done)' : 'the page\'s drawing'}: ${quick.join(' | ')}`).toBe(true);
      // then a slow turn: working while it streams; Stop → stopping → stopped. (After a Stop the stopped own turn stays the newest
      // in #cx-own while a later answered turn folds into #cx-turns, so a turn answered AFTER a Stop leaves the label on "stopped" —
      // observed in gate 22, said here, not asserted: the derivation's newest-li rule across the two lists is H174's/H171's call.)
      await composer.first().fill('FAKE: answer slowly please');
      await o.page.getByRole('button', { name: /^Send/ }).first().click();
      // (the slow turn streams a word every 700 ms: "working" is seen on the live label here)
      expect(await labelIs(o.page, 'activity', /^working$/, 20_000)).toBe('working');
      await o.page.getByRole('button', { name: /^Stop/ }).first().click();
      expect(await labelIs(o.page, 'activity', /^stopped$/, 30_000)).toBe('stopped');
      await openInspect(o.page);
      await caps.cap(o.page, { width: 1440, height: 900 }, 'inspect-fed-events', [`The Inspect view after the REAL turns: the activity card\'s event list — working / idle from the quick turn, working / stopping / stopped from the slow turn ended by Stop — each line naming its source (the backend\'s SSE events and POST /api/chat/stop when the feed spoke; the page\'s drawing otherwise)${native ? ' and the native State it set on AgentConsole (working → State 1, stopping → State 1, stopped → State 3, idle → State 0)' : ''}. ${pathWords()}.`], { to: o.page.locator('[data-inspect-events="activity"]').first(), what: 'the activity card\'s event list' });
      const ev = await events(o.page, 'activity');
      const fedNow = await activityFed(o.page);
      const src = fedNow ? new RegExp(`${FED_TURN.source}|${FED_STOP.source}`) : new RegExp(`${DERIVED_TURN.source}|${DERIVED_STOP.source}`);
      for (const word of ['working', 'stopped', 'idle']) expect(ev.some((e) => new RegExp(`activity = "${word}"`).test(e) && src.test(e)), `the ${word} event from ${fedNow ? 'the backend\'s own events (POST /api/chat/turn SSE, POST /api/chat/stop)' : 'the page\'s drawing'}: ${ev.join(' | ')}`).toBe(true);
      expect(ev.some((e) => /^activity = "stopping" · /.test(e) && (fedNow ? FED_STOP : DERIVED_STOP).test(e)), `a stopping event from ${fedNow ? 'POST /api/chat/stop' : 'the page\'s Stop button'}: ${ev.join(' | ')}`).toBe(true);
      // the activity is fed on this tree (H171's chat-shell.js calls TimmyRive.fromSse per SSE event): said as the fact it is
      expect(fedNow, 'the activity component was fed by the chat\'s own SSE handler (TimmyRive.activityFed())').toBe(true);
      if (native) {
        // the asset's contract beside each word: the native State the binding set, and the live input after the Stop
        expect(await nativeOf(o.page, 'activity', 'activity', 'working')).toBe('State 1');
        expect(await nativeOf(o.page, 'activity', 'activity', 'idle')).toBe('State 0');
        expect(await nativeOf(o.page, 'activity', 'activity', 'stopping')).toBe('State 1 (no stopping pose: State 1 Working until the backend says cancelled (3))');
        expect(await nativeOf(o.page, 'activity', 'activity', 'stopped')).toBe('State 3');
        expect(await inputValue(o.page, 'activity', 'State'), 'the live State input after the Stop: 3 Stopped').toBe(3);
        expect(await o.page.$$eval('[data-inspect-events="activity"] li .tr-native', (els) => els.map((e) => (e.textContent || '').trim())), 'the view writes the native input beside each event').toEqual(expect.arrayContaining(['→ State 3', '→ State 1', '→ State 0']));
      }
      const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
      expect(card, 'the Inspect view shows no receipt and no progress number').not.toMatch(/receipt [0-9a-f]{8}|\d+ ?%|sha256_/i);
      await closeInspect(o.page);
      expect(o.errors, 'page errors').toEqual([]);
      expect(o.missing, `resources the page asked for and the companion has not (the mark's known miss counted apart: ${o.markAsks.length})`).toEqual([]);
    } finally { await o.close(); }
  });
});
