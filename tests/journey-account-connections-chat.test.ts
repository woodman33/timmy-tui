/**
 * R11 round 4 (H172, contract C4): the complete account → connections → main agent Chat journey in a real headless Chromium at
 * 1440x900 and 390x844, against the companion in-process. Identity: a FAKE identity provider (tests/fixtures/fake-identity.ts:
 * an RSA pair made here, its public key as CLERK_JWT_KEY) whose RS256 tokens the product's REAL verifier checks (H173's
 * verifySession); no Clerk account, no network (Chromium resolves no host but 127.0.0.1). Models: a FAKE Ollama on 127.0.0.1
 * (tests/fixtures/fake-ollama-journey.ts), no model behind it; the turn is the REAL one (H169's POST /api/chat/turn through
 * openChatSession: the FAKE model answers with one tool call, then text; its receipt is sealed on the project's chain and
 * verified here).
 *
 *   1. identity not configured → the account screen, reviewable, naming the exact env names; the social buttons say what they
 *      need; nothing signs in and no request leaves 127.0.0.1;
 *   2. configured with the FAKE provider's key, a minted session given to the page through its test seam (the same call the
 *      Clerk flow makes; the server still verifies the token) → the connections screen: four cards with their state words;
 *      Ollama · local against the FAKE Ollama: a model listed; Download a local model → its size, a confirmation, progress,
 *      Cancel (the FAKE /api/pull sees the abort); Continue → the chat;
 *   3. the chat: the model chosen in the right panel (the five controls move the list; a sort never resets a filter); a
 *      message → delta, the tool line, the evidence line with a receipt that verifies in the project's chain; Stop on a second,
 *      slow turn ends it with its stage; the page reopened → the same project, the chosen model, the draft typed before, the
 *      conversation;
 *   4. 390x844: the rail folds; Connections and Models as buttons; nothing cut; no page errors.
 * The FAKE key's value is in no screen and no DOM, asserted.
 *
 * The screens' words are the preview's (R11-R4-COMMON); the page's seams (the screen ids, the session seam) are H171's and
 * H173's contract as posted in the handoff: until a piece lands, its step fails with words naming it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { readChain, verifyChain, verifyReceiptIn } from '../src/utils/receipts.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';

// ── the contract's names (C1-C3; the handoff's posted seams) ──────────────────

const PORTS = { unconfigured: 4495, configured: 4496 };
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'b4'.repeat(32);
const USER = fakeUserId('journey');
const MODEL = 'fake-qwen3:8b';
const PULL = { name: 'fake-small:1b', size: 1_100_000_000 };
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
/** FAKE: the Ollama cloud key pasted on the connections screen; its value must reach no screen and no DOM afterwards */
const FAKE_CLOUD_KEY = `FAKE-ollama-cloud-key-${'j'.repeat(24)}`;
const DRAFT = 'FIXTURE draft typed before the page was reopened';
/** the page's session seam: H173's window.timmyAccount.useSession(token) (the lead's 19:41), else H171's TimmyShell.session.set(token, user) + land() */
const SESSION_SEAM = 'window.timmyAccount.useSession(token), else TimmyShell.session.set(token, user) + land()';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('journey-account-connections-chat: no Chromium found, so the journey is skipped here (said, not passed)');

let box = '';
let timmyHome = '';
let identity: FakeIdentity;
let ollama: FakeOllamaJourney;
let browser: Browser;
let unconfigured: CompanionServer | null = null;
let configured: CompanionServer | null = null;
const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'TIMMY_MCP_HOME', 'TIMMY_STORE', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'TIMMY_REPO'];

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  box = mkdtempSync(join(tmpdir(), 'journey-r4-'));
  timmyHome = join(box, 'home', 'timmy');
  mkdirSync(timmyHome, { recursive: true });
  ollama = await startFakeOllamaJourney({
    models: [{ name: MODEL, size: 4_900_000_000, family: 'qwen3', parameterSize: '8B' }],
    pull: { ...PULL, stepMs: 400, steps: 12 },
    tool: { name: 'get_current_time', arguments: {} },
    answer: FAKE_ANSWER,
    slow: { when: /slowly/i, words: 'FAKE slow answer one word at a time so that Stop can end it before it is done'.split(' '), slowMs: 700 },
  });
  identity = fakeIdentityProvider({ azp: `http://127.0.0.1:${PORTS.configured}` });
  // the user's chat asks the FAKE Ollama: its address in the user's providers.json (what timmy init --ollama records)
  const userHome = join(timmyHome, 'users', USER);
  mkdirSync(userHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(userHome, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }), { mode: 0o600 });
  // the Ollama address the cards and the chat ask is OLLAMA_HOST unless the chat setup recorded one (ollamaAddress): the FAKE on 127.0.0.1
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: '', OLLAMA_HOST: ollama.url };
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) delete base[k];
  Object.assign(process.env, base);
  for (const k of ['TIMMY_STORE', 'OLLAMA_BASE_URL', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) delete process.env[k];
  // no name but 127.0.0.1 resolves; and no proxy: a container's HTTPS_PROXY in the environment would carry the browser's
  // requests out (Chromium reads it, --no-proxy-server notwithstanding — H173's finding, 21:22), so the variables are not handed down
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  unconfigured = await startCompanionServer(PORTS.unconfigured, { token: TOKEN, chatEnv: base, workspace: { env: base, shareMs: 0 } });
  const withIdentity = identity.env(base);
  Object.assign(process.env, { CLERK_JWT_KEY: withIdentity.CLERK_JWT_KEY, CLERK_PUBLISHABLE_KEY: withIdentity.CLERK_PUBLISHABLE_KEY });
  configured = await startCompanionServer(PORTS.configured, { token: TOKEN, chatEnv: withIdentity, workspace: { env: withIdentity, shareMs: 0 } });
}, 90_000);

afterAll(async () => {
  await unconfigured?.shutdown();
  await configured?.shutdown();
  await browser?.close();
  await ollama?.close();
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  if (box) rmSync(box, { recursive: true, force: true });
}, 30_000);

// ── the page ──────────────────────────────────────────────────────────────────

interface Opened { page: Page; errors: string[]; missing: string[]; left: string[]; refused: string[]; frames: string[]; seam: string; close: () => Promise<void> }

/** The page at a size, with the launch token in its address; what leaves 127.0.0.1 and every page error recorded. */
async function open(server: CompanionServer, size: { width: number; height: number }, o: { session?: string; tab?: string } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  const errors: string[] = [];
  const missing: string[] = [];
  const left: string[] = [];
  const refused: string[] = [];
  // every frame the companion's socket sent the page, as `<type>` or `session:<ok>:<needs>` (never a token's value); '--seam--' marks the adoption
  const frames: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!/Failed to load resource/.test(t)) { errors.push(t); return; }
    // the browser's own line for a request the server answered 4xx/5xx or could not reach:
    // - a 401 before a session is the page's first read, by design (the shell then shows the account screen);
    // - the FAKE identity provider's instance is unreachable on purpose (no name but 127.0.0.1 resolves): Clerk's own fetches to it;
    // - anything else (a 404: a resource the page asks for and the companion has not) is kept apart as `missing`, asserted by the steps
    if (/ 401 /.test(t)) return;
    if (/ERR_NAME_NOT_RESOLVED/.test(t) && /clerk\.accounts\.invalid/.test(m.location().url)) return;
    missing.push(`${t} — ${m.location().url}`);
  });
  page.on('request', (r) => { try { if (new URL(r.url()).hostname !== '127.0.0.1') left.push(r.url()); } catch { /* data: */ } });
  // every 401/403 the page met: which request, whether it carried a session (for a failure's words; the tokens' values never kept)
  page.on('response', (r) => {
    if (r.status() !== 401 && r.status() !== 403) return;
    const headers = r.request().headers();
    r.text().then((body) => refused.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} (session header: ${headers['x-timmy-session'] ? 'yes' : 'no'}): ${body.slice(0, 160)}`), () => refused.push(`${r.status()} ${r.request().method()} ${r.url()}`));
  });
  // the socket: every hello the page sent (with or without a session; never the token) and every refusal the companion answered
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => { const t = String(f.payload); if (t.includes('"type":"hello"')) refused.push(`ws hello sent (session: ${/"session":"/.test(t) ? 'yes' : 'no'})`); });
    ws.on('framereceived', (f) => {
      const t = String(f.payload);
      if (t.includes('"type":"session"') && t.includes('"ok":false')) refused.push(`ws ${t.slice(0, 220)}`);
      try { const m = JSON.parse(t) as { type?: string; ok?: boolean; needs?: string }; frames.push(m.type === 'session' ? `session:${String(m.ok)}:${m.needs ?? ''}` : String(m.type ?? '?')); } catch { frames.push('?'); }
    });
    ws.on('close', () => refused.push('ws closed'));
  });
  await page.goto(server.url);
  const seam = o.session ? await useSession(page, o.session, o.tab as 'chat' | undefined, () => frames.push('--seam--'), () => `refused so far: ${refused.join(' | ') || 'none'}; frames: ${frames.join(',')}`) : '';
  if (!frames.includes('--seam--')) frames.push('--seam--');
  return { page, errors, missing, left, refused, frames, seam, close: () => context.close() };
}

/**
 * The session given to the page as H173's account screen gives it after a Clerk sign-in (H171's shell: session.set(token, user),
 * then land() runs the landing rule); the server still verifies every request's token. Nothing of the verifier is bypassed.
 */
async function useSession(page: Page, token: string, go?: 'account' | 'connections' | 'chat', mark?: () => void, seen?: () => string): Promise<string> {
  const guard = async (what: string, p: Promise<unknown>): Promise<void> => { try { await p; } catch (e) { throw new Error(`the seam's guard "${what}" did not hold within its time: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}; ${seen?.() ?? ''}; the page read:\n${(await text(page).catch(() => '')).slice(0, 1200)}`); } };
  await guard('window.TimmyShell is here', page.waitForFunction(() => Boolean((window as unknown as { TimmyShell?: unknown }).TimmyShell), null, { timeout: 15_000 }));
  // as a person would: the page's own landing settles first (body[data-screen] chosen, its first requests answered) and the
  // session is adopted after it — the shell's fetch clears the session it holds when a 401 { needs: 'session' } comes back, so a
  // token set while the page's session-less first requests are still in flight is wiped by their refusals (gate run, 22:10)
  await guard('the landing chose a screen (body[data-screen])', page.waitForFunction(() => Boolean(document.body.getAttribute('data-screen')), null, { timeout: 15_000 }));
  // (and the landing read GET /api/identity with the page's launch token: TimmyShell.identity() is its answer; a page that took
  // the no-token path has none, and a seam then would be refused for the launch token, not the session)
  await guard('the landing read GET /api/identity with the launch token (TimmyShell.identity())', page.waitForFunction(() => Boolean((window as unknown as { TimmyShell?: { identity?: () => unknown } }).TimmyShell?.identity?.()), null, { timeout: 15_000 }));
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined); // (a page that keeps polling is not a fault of the seam)
  // and the account script's Clerk load has ended (its first state, "no session", fires then — gate 4, 22:24: account.js
  // onClerkState clears the shell's session whenever Clerk reports none, so one adopted before that fire is wiped)
  // (Clerk's load against the FAKE, unreachable instance may never end: this wait is bounded and says so, not a fault of the seam)
  const clerkLoaded = await page.waitForFunction(() => { const a = (window as unknown as { timmyAccount?: { state?: () => { loading?: boolean } } }).timmyAccount; return !a?.state || a.state().loading === false; }, null, { timeout: 15_000 }).then(() => true, () => false);
  mark?.();
  const ok = await page.evaluate(async ([t, id, target]) => {
    const w = window as unknown as { timmyAccount?: { useSession?: (token: string) => unknown }; TimmyShell?: { session?: { set?: (token: string, user?: unknown) => unknown }; land?: () => unknown; go?: (id: string) => unknown } };
    if (w.timmyAccount?.useSession) await w.timmyAccount.useSession(t);
    else if (w.TimmyShell?.session?.set) await w.TimmyShell.session.set(t, { id });
    else return 'absent';
    if (target && w.TimmyShell?.go) await w.TimmyShell.go(target); else await w.TimmyShell?.land?.();
    return 'ok';
  }, [token, USER, go ?? ''] as const).catch((e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`);
  expect(ok, `the page's session seam ${SESSION_SEAM} (H171's shell contract, 19:37; H173 sets it the same way)`).toBe('ok');
  // what the page holds after the seam, for a failure's words (never the token's value)
  return page.evaluate(() => {
    const w = window as unknown as { timmyAccount?: { state?: () => unknown }; TimmyShell?: { session?: { get?: () => string; user?: () => unknown }; current?: () => string } };
    const st = w.timmyAccount?.state ? JSON.stringify(w.timmyAccount.state()) : 'no timmyAccount.state';
    const id = (w.TimmyShell as { identity?: () => unknown } | undefined)?.identity?.();
    return `session ${w.TimmyShell?.session?.get?.() ? 'held' : 'EMPTY'}; user ${JSON.stringify(w.TimmyShell?.session?.user?.() ?? null)}; screen ${w.TimmyShell?.current?.() ?? '?'}; identity ${id ? JSON.stringify(id).slice(0, 120) : 'not read'}; account ${st.slice(0, 300)}`;
  }).catch(() => 'state unreadable').then((st) => `${st}; Clerk's load ${clerkLoaded ? 'ended' : 'still running when the session was adopted'}`);
}
/** Which screen the shell shows (body[data-screen], H171's contract). */
const screenOf = (page: Page): Promise<string> => page.evaluate(() => document.body.getAttribute('data-screen') ?? '');

const text = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);
const html = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.outerHTML);
async function until(page: Page, what: string, test: (t: string) => boolean, ms = 20_000, refuse?: (t: string) => string | null, more?: () => string): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  for (;;) {
    last = await text(page);
    if (test(last)) return last;
    // (innerText carries the page's text-transform: a label drawn in capitals reads in capitals here — callers match /i)
    const why = refuse?.(last);
    if (why) throw new Error(`${why}; ${more?.() ?? ''}; the page read:\n${last.slice(0, 1500)}`);
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}; ${more?.() ?? ''}; the page read:\n${last.slice(0, 2500)}`);
    await page.waitForTimeout(100);
  }
}
/** The opened page's facts for a failure: the seam's state after adoption, every request the server refused. */
const facts = (o: Opened) => (): string => `after the seam: ${o.seam}; refused: ${o.refused.length ? o.refused.join(' | ') : 'none'}`;
/** The page's own sentence for a connections screen with no answer from GET /api/connections: the owner piece named. */
const noConnections = (t: string): string | null => (/could not be read from the companion/.test(t) ? 'the connections screen has nothing to show: GET /api/connections answered nothing (H170\'s routes; their mount line in server.ts is H171\'s)' : null);

/** The companion's own API as the signed-in user (for the facts the screen is checked against). */
async function api(server: CompanionServer, method: string, path: string, o: { session?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string }> {
  const url = new URL(path, server.address);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(o.session ? { [SESSION_HEADER]: o.session } : {}), ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const t = await res.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { /* words */ }
  return { status: res.status, json, text: t };
}

// ── the journey ───────────────────────────────────────────────────────────────

const SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

describe.skipIf(!browserPath)('the account → connections → chat journey in Chromium: a FAKE identity provider\'s RS256 tokens, verified by the real verifier; no Clerk account, no network (R11 round 4, H172)', { timeout: 240_000 }, () => {
  for (const size of SIZES) {
    const at = `${size.width}x${size.height}`;

    it(`1. identity not configured at ${at}: the page lands on the operator's chat, the rail's account block names the env names and opens the account screen, whose social buttons say what they need; nothing signs in, nothing leaves 127.0.0.1`, async () => {
      const o = await open(unconfigured!, size);
      try {
        // the lead's 21:48 ruling (a)+(b): no provider configured → the companion as it was, the operator's own workspace ('chat'),
        // the rail's account block saying "This computer's operator · no identity provider configured (CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY)"
        await until(o.page, 'the operator\'s chat (unconfigured lands on chat)', (s) => /Message Timmy/i.test(s));
        expect(await screenOf(o.page), 'body[data-screen] (unconfigured lands on chat)').toBe('chat');
        // on a phone the rail is folded behind Menu (H171's shell: #cx-menu opens it)
        if (size.width < 600) await o.page.getByRole('button', { name: 'Menu' }).first().click();
        const landed = await until(o.page, 'the rail\'s account block naming the dependency (the lead\'s 21:48 words; H171)', (s) => /no identity provider configured/i.test(s), 10_000);
        expect(landed).toMatch(/CLERK_PUBLISHABLE_KEY/);
        expect(landed).toMatch(/CLERK_JWT_KEY|CLERK_SECRET_KEY/);
        expect(landed).toMatch(/This computer.s operator/i);
        // the account block opens the account screen (H171): the dependency named again, in the screen's own words
        await o.page.getByText(/no identity provider configured/i).first().click();
        const t = await until(o.page, 'the account screen (opened from the rail\'s account block)', (s) => /Create your Timmy account|Welcome back to Timmy/.test(s), 10_000);
        expect(await screenOf(o.page), 'body[data-screen]').toBe('account');
        expect(t).toMatch(/CLERK_PUBLISHABLE_KEY/);
        expect(t).toMatch(/CLERK_JWT_KEY|CLERK_SECRET_KEY/);
        for (const name of [/Continue with Google/, /Continue with GitHub/]) {
          const button = o.page.getByRole('button', { name });
          expect(await button.count(), `the ${name} button`).toBeGreaterThan(0);
          const first = button.first();
          const disabled = await first.isDisabled().catch(() => false);
          const described = `${await first.getAttribute('aria-describedby').catch(() => '')} ${await first.getAttribute('title').catch(() => '')} ${await first.textContent().catch(() => '')}`;
          // it says what it needs (its words, or the screen's under it), and does not sign in
          expect(disabled || /not configured|needs|CLERK_/i.test(`${described} ${t}`), `${name}: what it needs is said`).toBe(true);
          if (!disabled) await first.click({ trial: false }).catch(() => undefined);
        }
        await o.page.waitForTimeout(500);
        const after = await text(o.page);
        expect(after).toMatch(/Create your Timmy account|Welcome back to Timmy/);
        expect(after).not.toMatch(/Signed in|Sign out/i);
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
      } finally { await o.close(); }
    });

    it(`2. configured at ${at}: the connections screen; four cards with their state words; Ollama · local lists the FAKE model; the pull: size, confirmation, progress, Cancel; Continue → chat`, async () => {
      const session = identity.token(USER);
      const o = await open(configured!, size, { session });
      try {
        const t = await until(o.page, 'the connections screen (the landing rule: signed in, no route yet)', (s) => /Connect with OpenRouter/.test(s) && /Ollama · local/.test(s), 20_000, noConnections, facts(o));
        expect(await screenOf(o.page), 'body[data-screen]').toBe('connections');
        // the socket rule (the lead, 22:3x): a configured companion answers a socket without a session with { type: 'session',
        // ok: false, needs: 'session' } and NOTHING else (no welcome, bus tail, event or project frame) — the frames before the seam
        // (server.ts: "told once ({ type: 'session', ok: false, needs: 'session' }) and gets no project frame (no welcome, bus tail,
        // event or project) until a hello with a session verifies"; the state word at connect names no project)
        const beforeSeam = o.frames.slice(0, o.frames.indexOf('--seam--'));
        expect(beforeSeam, `the socket told the session-less page it needs a session: ${JSON.stringify(o.frames).slice(0, 400)}`).toContain('session:false:session');
        expect(beforeSeam.filter((f) => /^(welcome|bus\.tail|event|project|integrations)$/.test(f)), `no project frame before a session (the frames: ${JSON.stringify(beforeSeam).slice(0, 400)})`).toEqual([]);
        expect(o.frames.slice(o.frames.indexOf('--seam--')), 'the user\'s own frames once the session is verified (a welcome)').toContain('welcome');
        for (const words of [/OpenRouter/, /Ollama · local/, /Ollama · cloud/, /Cloudflare/]) expect(t).toMatch(words);
        // the state words are H170's provider states: never "free", never "connected" for a selection
        expect(t).not.toMatch(/\bfree\b/i);
        expect(t).toMatch(/not set up|Not connected|No key|not installed|Install Ollama|not asked/i);
        // Ollama · local against the FAKE Ollama: Check asks it (the card's first state is this computer's PATH: "not installed" with
        // no ollama program here); its model is then listed
        await o.page.getByRole('button', { name: /^Check$/ }).first().click();
        await until(o.page, 'the FAKE Ollama\'s model on the local card (after Check)', (s) => s.includes(MODEL), 20_000, undefined, facts(o));
        // Download a local model (H170's words, 19:47): the box, the model's name, "Show the size" → the confirmation sentence
        // "Download <model> (<size>; <free>). Ollama downloads it from its library; nothing else is installed." before anything
        // is pulled; "Confirm the download" → progress "<x> MB of <y> MB · <status> (<n>%)"; Cancel → "Cancelled…", the FAKE
        // /api/pull sees the abort
        const pullsBefore = ollama.pulls().length; // (the FAKE keeps every pull across the sizes)
        await o.page.getByRole('button', { name: /Download a local model/ }).first().click();
        const nameField = o.page.getByRole('textbox', { name: /model|name/i }).or(o.page.getByPlaceholder(/model|name/i));
        if (await nameField.count()) await nameField.first().fill(PULL.name);
        await o.page.getByRole('button', { name: /Show the size/ }).first().click();
        // (H170's words: "Download <model> (<size>; <free>). Ollama downloads it from its library; nothing else is installed." for a starter;
        // for another name: "<model>: size unknown (not a starter model, and Ollama does not hold it yet). Confirm to download it into the
        // Ollama on this computer from Ollama's library; nothing else is installed.")
        const asked = await until(o.page, 'the download\'s confirmation sentence', (s) => /Ollama downloads it from its library|Confirm to download it into the Ollama on this computer/.test(s), 20_000, undefined, facts(o));
        expect(ollama.pulls().length - pullsBefore, 'nothing is pulled before the confirmation').toBe(0);
        expect(asked).toMatch(new RegExp(`${PULL.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s(]`));
        expect(asked).toMatch(/size unknown|\d+(\.\d+)? ?[GM]B/);
        await o.page.getByRole('button', { name: /Confirm the download/ }).first().click();
        await until(o.page, 'the download\'s progress', (s) => /MB of .*\(\d+%\)|\d+ ?%/i.test(s), 20_000);
        expect(ollama.pulls().length - pullsBefore, 'one /api/pull after the confirmation').toBe(1);
        await o.page.getByRole('button', { name: /^Cancel/ }).first().click();
        const end = Date.now() + 10_000;
        const thisPull = ollama.pulls()[pullsBefore];
        while (!thisPull.aborted && Date.now() < end) await o.page.waitForTimeout(100);
        expect(thisPull.aborted, 'the FAKE /api/pull saw the abort').toBe(true);
        const cancelled = await until(o.page, 'the download cancelled, said', (s) => /Cancelled/.test(s), 10_000);
        expect(cancelled).not.toContain(FAKE_CLOUD_KEY);
        // the screen's own heading (SCREEN_WORDS: the kicker, the title "Choose how you want to run.", the lead) is on the page
        expect(cancelled, 'the connections screen\'s title (H170\'s SCREEN_WORDS.title, drawn in #cx-title — H171 noted the id is also the Chat\'s)').toMatch(/Choose how you want to run\./i);
        expect(cancelled).toMatch(/CONNECT YOUR MODELS & TOOLS/i);
        // Continue → the chat (the footer's "Continue to the workspace →", or "Explore without a model")
        await o.page.getByRole('button', { name: /Continue to the workspace|Explore without a model/ }).first().click();
        const chat = await until(o.page, 'the chat screen', (s) => /Message Timmy/i.test(s));
        expect(await screenOf(o.page), 'body[data-screen]').toBe('chat');
        if (size.width >= 600) expect(chat).toMatch(/Local logs · cloud sync off|Local logs/); // (the state words fold on a phone)
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not (a signed-in page: the panels\' reads for the user\'s project — H171)').toEqual([]);
      } finally { await o.close(); }
    });

    it(`3. the chat at ${at}: the model chosen in the right panel (the five controls; a sort keeps a filter); a turn with a tool call and a receipt that verifies; Stop ends a slow turn with its stage; reopen restores project, model, draft, conversation`, async () => {
      const session = identity.token(USER);
      const o = await open(configured!, size, { session, tab: 'chat' });
      try {
        const first = await until(o.page, 'the chat screen', (s) => /Message Timmy/i.test(s), 20_000, undefined, facts(o));
        // the screen is the USER's: the WORKSPACE box and the top line name the user's own project (C1: "Untitled project", the
        // default made under the user's home), never the operator's active project (this checkout's folder, the follower's view)
        expect(first, 'the user\'s project named (H171: the project box reads GET /api/projects when a session exists; the chat view the user\'s project)').toMatch(/Untitled project/);
        expect(first, `the operator's project (${basename(process.cwd())}) is not shown to a signed-in user (H171)`).not.toContain(basename(process.cwd()));
        // the right panel (a button on a phone)
        if (size.width < 600) await o.page.getByRole('button', { name: /Models/ }).first().click();
        await until(o.page, 'the Models panel', (s) => /All makers|All capabilities|Any cost|Any context/.test(s));
        // the five controls (H171, 19:58): selects labelled Sort / Maker / Capability / Cost / Context, their first options
        const controls: Array<[string, string]> = [['Sort', 'Newest first'], ['Maker', 'All makers'], ['Capability', 'All capabilities'], ['Cost', 'Any cost'], ['Context', 'Any context']];
        for (const [label, first] of controls) {
          const select = o.page.getByRole('combobox', { name: label });
          expect(await select.count(), `the ${label} control`).toBeGreaterThan(0);
          expect(await select.first().locator('option').first().textContent(), `${label}'s first option`).toBe(first);
        }
        // the local source lists the FAKE model (the panel opens on OpenRouter's tab: the "Ollama local" tab first); a search typed,
        // then a sort: the search stays (a sort never resets a filter)
        await o.page.getByRole('tab', { name: 'Ollama local' }).first().click();
        const search = o.page.getByPlaceholder(/Search models/);
        expect(await search.count(), 'the search box').toBeGreaterThan(0);
        await search.first().fill('fake');
        await until(o.page, 'the FAKE model in the list', (s) => s.includes(MODEL), 20_000);
        await o.page.getByRole('combobox', { name: 'Sort' }).first().selectOption({ index: 1 });
        await o.page.waitForTimeout(300);
        expect(await search.first().inputValue(), 'a sort keeps the search').toBe('fake');
        expect(await text(o.page)).toContain(MODEL);
        // (the panel's list is #cm-list — the connections card's hidden line names the model too, so the locator is scoped)
        const row = o.page.locator('#cm-list').getByText(MODEL, { exact: false }).first();
        await row.scrollIntoViewIfNeeded().catch(() => undefined);
        await row.click({ timeout: 10_000 });
        // the model's detail opens; "Use for the next turn" is the choice (POST /api/chat/choose: Ollama asked for the exact name first)
        const use = o.page.getByRole('button', { name: /Use for the next turn/ }).first();
        await use.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        // (H171, 23:20: the detail sits under the clicked row inside #cm-list — li.is-selected > #cm-detail, the button [data-cm-use];
        // Enter on the row chooses directly, which is the way on a phone's overlay when the detail is not in view)
        await use.click({ timeout: 10_000 }).catch(async () => { const li = o.page.locator('#cm-list li', { hasText: MODEL }).first(); await li.focus(); await li.press('Enter'); }).catch(async (e: unknown) => {
          const panel = await o.page.evaluate(() => { const p = document.querySelector('.cx-models'); return p ? `${(p as HTMLElement).innerText.slice(0, 1200)} [visible: ${(p as HTMLElement).offsetParent !== null}, ${(p as HTMLElement).getBoundingClientRect().width}x${(p as HTMLElement).getBoundingClientRect().height}]` : 'no .cx-models'; }).catch(() => 'unreadable');
          throw new Error(`"Use for the next turn" after the model's row was clicked (${at}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}; the Models panel: ${panel}`);
        });
        const chosen = await until(o.page, 'the model chosen', (s) => new RegExp(`Next turn: ${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}|${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*(ready|chosen|this computer)`).test(s), 20_000);
        expect(chosen).not.toContain(FAKE_CLOUD_KEY);
        // a turn: the REAL agent through H169's SSE; the FAKE model calls one tool, then answers
        const composer = o.page.getByRole('textbox', { name: /Message Timmy/i }).or(o.page.getByPlaceholder(/Message Timmy/i));
        // the conversation is the USER's project's and persists across this file's sizes: the answer counted is a NEW one, and the
        // tool line is read from that newest turn's own node (its activity folds into the answer once the receipt is read back, so
        // the visible text alone is not the measure — gates 19–20)
        const answersBefore = await o.page.evaluate((a) => [...document.querySelectorAll('#cx-own li, #cx-turns li')].filter((li) => (li.textContent || '').includes(a)).length, FAKE_ANSWER);
        await composer.first().fill('FAKE: what time is it?');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        await o.page.waitForFunction(([a, n]) => [...document.querySelectorAll('#cx-own li, #cx-turns li')].filter((li) => (li.textContent || '').includes(a)).length > n, [FAKE_ANSWER, answersBefore] as const, { timeout: 60_000 });
        const answered = await text(o.page);
        expect(answered).toContain(FAKE_ANSWER);
        // the tool line sits in the turn's activity, folded under its evidence line (▸, a button with aria-expanded) once the turn is
        // saved and read back: the fold is opened as a person would, then the line is read from the newest turn's node
        const newest = o.page.locator('#cx-own li, #cx-turns li').filter({ hasText: FAKE_ANSWER }).last();
        const fold = newest.locator('.cx-evidence[aria-expanded="false"]').first();
        if (await fold.count()) await fold.click();
        await o.page.waitForFunction((a) => { const lis = [...document.querySelectorAll('#cx-own li, #cx-turns li')].filter((li) => (li.textContent || '').includes(a)); const last = lis[lis.length - 1]; return Boolean(last && /get_current_time/.test(last.textContent || '')); }, FAKE_ANSWER, { timeout: 15_000 })
          .catch(async () => { throw new Error(`the newest turn carries no tool line get_current_time (its activity opened); the turn read:\n${(await newest.innerText().catch(() => '')).slice(0, 800)}`); });
        // the newest turn's evidence line, once its receipt is sealed and read back ("<model> · this computer · <s> · receipt <8 hex> ✓")
        const evidenceLine = await o.page.waitForFunction((a) => {
          const lis = [...document.querySelectorAll('#cx-own li, #cx-turns li')].filter((li) => (li.textContent || '').includes(a));
          const last = lis[lis.length - 1];
          const line = last ? (last.textContent || '').split('\n').map((l) => l.trim()).find((l) => /receipt\W{0,3}(?:sha256_)?[0-9a-f]{8}/i.test(l)) : undefined;
          return line || false;
        }, FAKE_ANSWER, { timeout: 20_000 }).then((h) => h.jsonValue() as Promise<string>).catch(async () => `(no receipt line on the newest turn; the page read: ${(await text(o.page)).slice(0, 800)})`);
        const evidence = /receipt\W{0,3}(?:sha256_)?([0-9a-f]{8})/i.exec(evidenceLine);
        expect(evidence, `the evidence line with its receipt (the lines: ${answered.split('\n').filter((l) => /receipt/i.test(l)).join(' | ').slice(0, 400)})`).toBeTruthy();
        expect(ollama.chats().length).toBeGreaterThanOrEqual(2);
        // the receipt verifies in the user's project chain
        const projects = await api(configured!, 'GET', '/api/projects', { session });
        const rows: Array<{ root?: string }> = Array.isArray(projects.json) ? projects.json : projects.json?.projects ?? [];
        const root = rows[0]?.root;
        expect(typeof root, `the user's project root from GET /api/projects: ${projects.text.slice(0, 200)}`).toBe('string');
        const chain = readChain('runs', root!);
        expect(verifyChain('runs', root!).ok, 'the project\'s chain verifies').toBe(true);
        // (the page's short id is the hash's last 8 — chat-shell.js `t.receipt.slice(-8)`; a first-8 convention is accepted too)
        const sealed = chain.find((r) => { const h = String(r.hash).replace(/^sha256_/, ''); return h.startsWith(evidence![1]) || h.endsWith(evidence![1]); });
        // (for a failure's words: every receipts file under the test's box, and which of them holds the hash)
        const files = (): string[] => { const out: string[] = []; const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.jsonl$/.test(e.name) && /receipts/.test(f)) out.push(f); } }; walk(box); return out; };
        const holders = files().filter((f) => readFileSync(f, 'utf8').includes(evidence![1])).map((f) => f.replace(box, '<box>'));
        const line = evidenceLine;
        expect(sealed, `the receipt ${evidence![1]} is on the project's runs chain (${root!.replace(box, '<box>')}: ${chain.length} receipts: ${chain.map((r) => `${String(r.kind)} ${String(r.hash).slice(0, 15)}`).join(', ')}); the evidence line: "${line}"; files holding the hash: ${holders.join(', ') || 'none'}; receipts files: ${files().map((f) => f.replace(box, '<box>')).join(', ')}`).toBeTruthy();
        expect(verifyReceiptIn(chain, String(sealed!.hash)).ok).toBe(true);
        // Stop: a second, slow turn ended by Stop with its stage
        await composer.first().fill('FAKE: answer slowly please');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        await until(o.page, 'the slow turn running (Stop shown)', (s) => /Stop/.test(s), 20_000);
        await o.page.getByRole('button', { name: /^Stop/ }).first().click();
        const stopped = await until(o.page, 'the turn stopped with its stage', (s) => /stopped|cancelled|ended/i.test(s), 20_000);
        expect(stopped).toMatch(/stopped|cancelled|ended/i);
        const slow = ollama.chats().at(-1)!;
        const end = Date.now() + 10_000;
        while (!slow.aborted && Date.now() < end) await o.page.waitForTimeout(100);
        expect(slow.aborted, 'the FAKE Ollama saw the stopped turn\'s request end').toBe(true);
        // a draft typed, the page reopened: the project, the model, the draft and the conversation are back
        await composer.first().fill(DRAFT);
        await o.page.waitForTimeout(600);
        const before = await html(o.page);
        expect(before).not.toContain(FAKE_CLOUD_KEY);
        // a reopen in this product is Timmy opening the address WITH its token again (companion.js takes the launch token from the
        // fragment and replaceStates it out, so a bare reload has none — H173, 23:20); the page's pin stays in sessionStorage
        await o.page.goto(configured!.url);
        await useSession(o.page, session, 'chat');
        const again = await until(o.page, 'the chat again', (s) => /Message Timmy/i.test(s) && s.includes(FAKE_ANSWER), 30_000);
        expect(again).toContain(MODEL);
        expect(again).toContain('FAKE: what time is it?');
        const draft = await o.page.getByRole('textbox', { name: /Message Timmy/i }).or(o.page.getByPlaceholder(/Message Timmy/i)).first().inputValue();
        expect(draft).toBe(DRAFT);
        expect(await html(o.page)).not.toContain(FAKE_CLOUD_KEY);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not (a signed-in page: the panels\' reads for the user\'s project — H171)').toEqual([]);
      } finally { await o.close(); }
    });
  }

  it('4. at 390x844 the rail folds, Connections and Models are buttons, nothing is cut, no page errors', async () => {
    const o = await open(configured!, { width: 390, height: 844 }, { session: identity.token(USER), tab: 'chat' });
    try {
      await until(o.page, 'the chat screen', (s) => /Message Timmy/i.test(s), 20_000, undefined, facts(o));
      expect(await o.page.getByRole('button', { name: /Models/ }).count()).toBeGreaterThan(0);
      expect(await o.page.getByRole('button', { name: /Connections|Models & accounts/ }).count()).toBeGreaterThan(0);
      // the rail folded: its items are not laid out at once
      const railVisible = await o.page.getByText(/Runs & receipts/).first().isVisible().catch(() => false);
      expect(railVisible, 'the rail is folded on a phone').toBe(false);
      // nothing cut: no element wider than the viewport
      const overflow = await o.page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      expect(overflow, 'horizontal overflow in CSS pixels').toBeLessThanOrEqual(0);
      expect(o.errors, 'page errors').toEqual([]);
      expect(o.missing, 'resources the page asked for and the companion has not (a signed-in page: the panels\' reads for the user\'s project — H171)').toEqual([]);
    } finally { await o.close(); }
  });
});
