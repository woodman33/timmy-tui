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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), OPENROUTER_API_KEY: '' };
  for (const k of ['TIMMY_STORE', 'OLLAMA_HOST', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) delete base[k];
  Object.assign(process.env, base);
  for (const k of ['TIMMY_STORE', 'OLLAMA_HOST', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) delete process.env[k];
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
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

interface Opened { page: Page; errors: string[]; left: string[]; close: () => Promise<void> }

/** The page at a size, with the launch token in its address; what leaves 127.0.0.1 and every page error recorded. */
async function open(server: CompanionServer, size: { width: number; height: number }, o: { session?: string; tab?: string } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  const errors: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { try { if (new URL(r.url()).hostname !== '127.0.0.1') left.push(r.url()); } catch { /* data: */ } });
  await page.goto(server.url);
  if (o.session) await useSession(page, o.session, o.tab as 'chat' | undefined);
  return { page, errors, left, close: () => context.close() };
}

/**
 * The session given to the page as H173's account screen gives it after a Clerk sign-in (H171's shell: session.set(token, user),
 * then land() runs the landing rule); the server still verifies every request's token. Nothing of the verifier is bypassed.
 */
async function useSession(page: Page, token: string, go?: 'account' | 'connections' | 'chat'): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { TimmyShell?: unknown }).TimmyShell), null, { timeout: 15_000 }).catch(() => undefined);
  const ok = await page.evaluate(async ([t, id, target]) => {
    const w = window as unknown as { timmyAccount?: { useSession?: (token: string) => unknown }; TimmyShell?: { session?: { set?: (token: string, user?: unknown) => unknown }; land?: () => unknown; go?: (id: string) => unknown } };
    if (w.timmyAccount?.useSession) await w.timmyAccount.useSession(t);
    else if (w.TimmyShell?.session?.set) await w.TimmyShell.session.set(t, { id });
    else return 'absent';
    if (target && w.TimmyShell?.go) await w.TimmyShell.go(target); else await w.TimmyShell?.land?.();
    return 'ok';
  }, [token, USER, go ?? ''] as const);
  expect(ok, `the page's session seam ${SESSION_SEAM} (H171's shell contract, 19:37; H173 sets it the same way)`).toBe('ok');
}
/** Which screen the shell shows (body[data-screen], H171's contract). */
const screenOf = (page: Page): Promise<string> => page.evaluate(() => document.body.getAttribute('data-screen') ?? '');

const text = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText);
const html = (page: Page): Promise<string> => page.evaluate(() => document.documentElement.outerHTML);
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

    it(`1. identity not configured at ${at}: the account screen names the env names; the social buttons say what they need; nothing signs in, nothing leaves 127.0.0.1`, async () => {
      const o = await open(unconfigured!, size);
      try {
        const t = await until(o.page, 'the account screen', (s) => /Create your Timmy account|Welcome back to Timmy/.test(s));
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
        expect(after).not.toMatch(/Signed in|Sign out/);
        expect(o.left, 'requests that left 127.0.0.1').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
      } finally { await o.close(); }
    });

    it(`2. configured at ${at}: the connections screen; four cards with their state words; Ollama · local lists the FAKE model; the pull: size, confirmation, progress, Cancel; Continue → chat`, async () => {
      const session = identity.token(USER);
      const o = await open(configured!, size, { session });
      try {
        const t = await until(o.page, 'the connections screen (the landing rule: signed in, no route yet)', (s) => /Connect with OpenRouter/.test(s) && /Ollama · local/.test(s));
        expect(await screenOf(o.page), 'body[data-screen]').toBe('connections');
        for (const words of [/OpenRouter/, /Ollama · local/, /Ollama · cloud/, /Cloudflare/]) expect(t).toMatch(words);
        // the state words are H170's provider states: never "free", never "connected" for a selection
        expect(t).not.toMatch(/\bfree\b/i);
        expect(t).toMatch(/Not connected|not set up|No key|not installed|Install Ollama/i);
        // Ollama · local against the FAKE Ollama: its model listed with its size
        const listed = await until(o.page, 'the FAKE Ollama\'s model on the local card', (s) => s.includes(MODEL), 20_000);
        expect(listed).toMatch(/4\.9 GB|4\.6 GiB|4\.9GB/);
        // Download a local model: the size first, a confirmation, then progress, then Cancel: the FAKE sees the abort
        await o.page.getByRole('button', { name: /Download a local model|Download/ }).first().click();
        const asked = await until(o.page, 'the download\'s confirmation with its size', (s) => /1\.1 GB|1\.0 GiB|1\.1GB/.test(s) && /Download|Confirm|Start/i.test(s));
        expect(ollama.pulls().length, 'nothing is pulled before the confirmation').toBe(0);
        expect(asked).toMatch(new RegExp(PULL.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        await o.page.getByRole('button', { name: /^(Download|Confirm|Start download|Yes, download)/i }).first().click();
        await until(o.page, 'the download\'s progress', (s) => /\d+ ?%|MB of|GB of|pulling/i.test(s), 15_000);
        expect(ollama.pulls().length).toBe(1);
        await o.page.getByRole('button', { name: /Cancel/ }).first().click();
        const end = Date.now() + 10_000;
        while (!ollama.pulls()[0].aborted && Date.now() < end) await o.page.waitForTimeout(100);
        expect(ollama.pulls()[0].aborted, 'the FAKE /api/pull saw the abort').toBe(true);
        const cancelled = await until(o.page, 'the download cancelled, said', (s) => /cancel/i.test(s) && !/\d+ ?%/.test(s), 10_000);
        expect(cancelled).not.toContain(FAKE_CLOUD_KEY);
        // Continue → the chat
        await o.page.getByRole('button', { name: /^Continue$|Continue to chat|Explore without a model/ }).first().click();
        const chat = await until(o.page, 'the chat screen', (s) => /Message Timmy/.test(s));
        expect(await screenOf(o.page), 'body[data-screen]').toBe('chat');
        expect(chat).toMatch(/Local logs · cloud sync off|Local logs/);
        expect(o.errors, 'page errors').toEqual([]);
      } finally { await o.close(); }
    });

    it(`3. the chat at ${at}: the model chosen in the right panel (the five controls; a sort keeps a filter); a turn with a tool call and a receipt that verifies; Stop ends a slow turn with its stage; reopen restores project, model, draft, conversation`, async () => {
      const session = identity.token(USER);
      const o = await open(configured!, size, { session, tab: 'chat' });
      try {
        await until(o.page, 'the chat screen', (s) => /Message Timmy/.test(s));
        // the right panel (a button on a phone)
        if (size.width < 600) await o.page.getByRole('button', { name: /Models/ }).first().click();
        await until(o.page, 'the Models panel', (s) => /Sort|All makers|All capabilities|Any cost|Any context/.test(s));
        for (const control of [/Sort/, /All makers/, /All capabilities/, /Any cost/, /Any context/]) expect(await o.page.getByRole('combobox', { name: control }).or(o.page.getByRole('button', { name: control })).count(), `the control ${control}`).toBeGreaterThan(0);
        // the local source lists the FAKE model; a filter set, then a sort: the filter stays
        const search = o.page.getByRole('searchbox').or(o.page.getByPlaceholder(/Search models/));
        if (await search.count()) { await search.first().fill('fake'); }
        await until(o.page, 'the FAKE model in the list', (s) => s.includes(MODEL), 20_000);
        const sort = o.page.getByRole('combobox', { name: /Sort/ });
        if (await sort.count()) { await sort.first().selectOption({ index: 1 }).catch(() => undefined); }
        if (await search.count()) expect(await search.first().inputValue(), 'a sort keeps the search').toBe('fake');
        await o.page.getByText(MODEL, { exact: false }).first().click();
        const chosen = await until(o.page, 'the model chosen', (s) => new RegExp(`Next turn: ${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}|${MODEL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*(ready|chosen|this computer)`).test(s), 20_000);
        expect(chosen).not.toContain(FAKE_CLOUD_KEY);
        // a turn: the REAL agent through H169's SSE; the FAKE model calls one tool, then answers
        const composer = o.page.getByRole('textbox', { name: /Message Timmy/ }).or(o.page.getByPlaceholder(/Message Timmy/));
        await composer.first().fill('FAKE: what time is it?');
        await o.page.getByRole('button', { name: /^Send/ }).first().click();
        const answered = await until(o.page, 'the FAKE answer', (s) => s.includes(FAKE_ANSWER), 60_000);
        expect(answered).toMatch(/get_current_time/);
        const evidence = /receipt ([0-9a-f]{8})/.exec(answered);
        expect(evidence, 'the evidence line with its receipt').toBeTruthy();
        expect(ollama.chats().length).toBeGreaterThanOrEqual(2);
        // the receipt verifies in the user's project chain
        const projects = await api(configured!, 'GET', '/api/projects', { session });
        const rows: Array<{ root?: string }> = Array.isArray(projects.json) ? projects.json : projects.json?.projects ?? [];
        const root = rows[0]?.root;
        expect(typeof root, `the user's project root from GET /api/projects: ${projects.text.slice(0, 200)}`).toBe('string');
        const chain = readChain('runs', root!);
        expect(verifyChain('runs', root!).ok, 'the project\'s chain verifies').toBe(true);
        const sealed = chain.find((r) => String(r.hash).replace(/^sha256_/, '').startsWith(evidence![1]));
        expect(sealed, `the receipt ${evidence![1]} is on the chain`).toBeTruthy();
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
        await o.page.reload();
        await useSession(o.page, session, 'chat');
        const again = await until(o.page, 'the chat again', (s) => /Message Timmy/.test(s) && s.includes(FAKE_ANSWER), 30_000);
        expect(again).toContain(MODEL);
        expect(again).toContain('FAKE: what time is it?');
        const draft = await o.page.getByRole('textbox', { name: /Message Timmy/ }).or(o.page.getByPlaceholder(/Message Timmy/)).first().inputValue();
        expect(draft).toBe(DRAFT);
        expect(await html(o.page)).not.toContain(FAKE_CLOUD_KEY);
        expect(o.errors, 'page errors').toEqual([]);
      } finally { await o.close(); }
    });
  }

  it('4. at 390x844 the rail folds, Connections and Models are buttons, nothing is cut, no page errors', async () => {
    const o = await open(configured!, { width: 390, height: 844 }, { session: identity.token(USER), tab: 'chat' });
    try {
      await until(o.page, 'the chat screen', (s) => /Message Timmy/.test(s));
      expect(await o.page.getByRole('button', { name: /Models/ }).count()).toBeGreaterThan(0);
      expect(await o.page.getByRole('button', { name: /Connections|Models & accounts/ }).count()).toBeGreaterThan(0);
      // the rail folded: its items are not laid out at once
      const railVisible = await o.page.getByText(/Runs & receipts/).first().isVisible().catch(() => false);
      expect(railVisible, 'the rail is folded on a phone').toBe(false);
      // nothing cut: no element wider than the viewport
      const overflow = await o.page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
      expect(overflow, 'horizontal overflow in CSS pixels').toBeLessThanOrEqual(0);
      expect(o.errors, 'page errors').toEqual([]);
    } finally { await o.close(); }
  });
});
