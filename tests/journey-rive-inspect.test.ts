/**
 * R11 round 5 (H172; the journey leg for H174's Rive components, contract of 23:52 PT as merged): the page's Rive bindings and
 * the "Inspect animation" view, end to end, on a CONFIGURED companion with a FAKE identity provider's RS256 session (verified by
 * the real verifier; no Clerk account, no network) and a FAKE Ollama on 127.0.0.1 (no model behind it).
 *
 * What this container holds, said as it is: the Rive SOURCE of each component (src/companion/assets/rive/<component>/scene.rml,
 * rive.yaml, README.md) and NO .riv — nothing animates here, and the Inspect view must say so ("words only"); the state of every
 * component is the HTML word beside it (aria-live), which follows the page's drawing of the backend's own events (H170's cards,
 * H171's turns), each binding event labelled "derived from the page's drawing of …", never as the event itself.
 *
 *  1. GET /api/rive/assets: 401 without the launch token; 401 { needs: 'session' } with the token alone (configured → no operator
 *     fallback); 200 with the session: { ok, runtime, components } — each component's riv null here, its sources named; the
 *     source files served by exact name (GET /assets/rive/<component>/scene.rml), a path or an unknown name → 404 in words.
 *  2. Chromium, 1440x900 and 390x844: the Inspect view on #inspect lists welcome, the four connections, activity and the mark;
 *     every runtime row reads "words only"; the connection labels read "disconnected" for cards that are not set up, and
 *     "connected" for Ollama · local once Check made its card "checked" — the event's source says it is derived from the page's
 *     drawing; the PREVIEW label stands on every operational card and a preview moves the label with source 'PREVIEW' only (no
 *     receipt, no progress, nothing asked of the FAKE Ollama); the welcome fires on a trusted click only (a programmatic click
 *     records nothing); reduced motion is said in the card; no page error.
 *  3. The REAL turn: after a model is chosen, a message to the FAKE model moves the activity label to "working" and then "idle"
 *     (the turn answered), and Stop on a slow turn ends in "stopped" — from the page's drawing of H169's SSE, said so.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';

const PORT = 4498;
const SESSION_HEADER = 'X-Timmy-Session';
const TOKEN = 'c4'.repeat(32);
const USER = fakeUserId('rive');
const MODEL = 'fake-qwen3:8b';
const FAKE_ANSWER = 'FAKE answer: the time was read by a tool (no model behind this).';
const PREVIEW_LABEL = 'Preview playback — not an execution, no progress, no receipt';
const COMPONENTS = ['welcome', 'connection-openrouter', 'connection-ollama-local', 'connection-ollama-cloud', 'connection-cloudflare', 'activity', 'mark'];

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

interface Opened { page: Page; errors: string[]; missing: string[]; left: string[]; close: () => Promise<void> }

async function open(size: { width: number; height: number }, o: { reducedMotion?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ viewport: size, ...(o.reducedMotion ? { reducedMotion: 'reduce' as const } : {}) });
  const page = await context.newPage();
  const errors: string[] = [];
  const missing: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
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
  return { page, errors, missing, left, close: () => context.close() };
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
/** The binding events the Inspect view lists for a component: each as "<input = value> · <source>". */
const events = (page: Page, key: string): Promise<string[]> => page.locator(`[data-inspect-events="${key}"] li`).evaluateAll((lis) => lis.map((li) => `${li.querySelector('code')?.textContent ?? ''} · ${li.getAttribute('data-event-source') ?? ''}`));
/** The Inspect view opens on the #inspect fragment (until the shell knows the screen); Close clears it. */
async function openInspect(page: Page): Promise<string> {
  await page.evaluate(() => { location.hash = '#inspect'; });
  // (the view's own section: #screen-inspect, shown on the fragment; its text is read from the section itself — the body's innerText
  // reads empty while the section is up, so the page's text is not the measure here)
  await page.waitForSelector('#screen-inspect:not([hidden]) [data-inspect-component]', { timeout: 30_000 });
  await page.waitForFunction(() => !/Reading the companion/.test(document.querySelector('[data-inspect-listing]')?.textContent || ''), null, { timeout: 30_000 });
  // (a missing file is declared after the bindings' patience: every runtime row then reads "words only" — nothing animates here)
  await page.waitForFunction(() => { const els = [...document.querySelectorAll('[data-inspect-runtime]')]; return els.length >= 7 && els.every((e) => /words only/.test(e.textContent || '')); }, null, { timeout: 30_000 });
  return page.locator('#screen-inspect').innerText();
}
async function closeInspect(page: Page): Promise<void> {
  await page.locator('[data-inspect-close]').first().click();
  await page.waitForFunction(() => location.hash !== '#inspect', null, { timeout: 5_000 });
}

// ── the leg ───────────────────────────────────────────────────────────────────

describe('the Rive components and the Inspect animation view: a FAKE identity provider\'s RS256 session verified by the real verifier, a FAKE Ollama on 127.0.0.1, no .riv in this installation (R11 round 5, H172 for H174)', { timeout: 240_000 }, () => {
  it('GET /api/rive/assets: 401 without the launch token; 401 needs:session with the token alone (configured); 200 with the session — every component\'s riv null here, its sources named; the source files by exact name, a path or an unknown name 404 in words', async () => {
    const none = await api('GET', '/api/rive/assets', { token: null });
    expect(none.status, none.text.slice(0, 200)).toBe(401);
    const alone = await api('GET', '/api/rive/assets');
    expect(alone.status, `the launch token alone, configured: ${alone.text.slice(0, 200)}`).toBe(401);
    expect(alone.json?.needs).toBe('session');
    const r = await api('GET', '/api/rive/assets', { session: identity.token(USER) });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json?.ok).toBe(true);
    expect(typeof r.json?.runtime, 'whether @rive-app/canvas is served (/vendor/rive/)').toBe('boolean');
    const rows: Array<{ component: string; riv: unknown; sources: string[]; words: string }> = r.json?.components ?? [];
    expect(rows.map((c) => c.component).sort()).toEqual(['activity', 'connection', 'welcome']);
    for (const c of rows) {
      expect(c.riv, `${c.component}: no .riv is in this installation (the source only; nothing animates here)`).toBeNull();
      expect(c.sources, `${c.component}'s editable source beside the asset`).toEqual(expect.arrayContaining(['scene.rml', 'rive.yaml', 'README.md']));
      expect(typeof c.words).toBe('string');
    }
    const src = await api('GET', '/assets/rive/connection/scene.rml');
    expect(src.status, src.text.slice(0, 200)).toBe(200);
    expect(src.text).toMatch(/artboard|state|machine|TimmyConnection|<rive|rml/i);
    for (const bad of ['/assets/rive/connection/../mark/scene.rml', '/assets/rive/connection/nothing.riv', '/assets/rive/no-such-component/scene.rml']) {
      const b = await api('GET', bad);
      expect(b.status, `${bad}: ${b.text.slice(0, 200)}`).toBe(404);
      expect(b.text.trim().length, `${bad}: 404 with words`).toBeGreaterThan(0);
      expect(b.text).not.toMatch(/\/home\/|\/Users\//);
    }
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const at = `${size.width}x${size.height}`;

    it.skipIf(!browserPath)(`${at}: the Inspect view lists every component as words only (no .riv here); the connection labels follow the cards (Check → connected, said as derived); the PREVIEW label stands and a preview moves the label only; the welcome fires on a trusted click only; no page error`, async () => {
      const o = await open(size);
      try {
        // signed in, no route → the connections screen (its cards carry data-provider + data-state, which the bindings read)
        await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s) && /Ollama · local/.test(s));
        const view = await openInspect(o.page);
        for (const key of COMPONENTS) expect(await o.page.locator(`[data-inspect-component="${key}"]`).count(), `the card of ${key}`).toBe(1);
        // nothing animates in this container: every runtime row says words only; the Inspect view names the missing file, never an error
        for (const key of COMPONENTS) {
          const runtime = await o.page.locator(`[data-inspect-runtime="${key}"]`).first().innerText();
          expect(runtime, `${key}'s runtime row`).toMatch(/words only/i);
        }
        expect(view).not.toMatch(/\bError\b|undefined|NaN/);
        expect(view).toMatch(/not in this installation|no file|words only/i);
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
        const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
        expect(card).not.toMatch(/receipt [0-9a-f]{8}|\d+ ?%|sha256_/i);
        expect(ollama.chats().length, 'the FAKE Ollama got nothing from a preview').toBe(chatsBefore);
        await o.page.locator('[data-preview="activity:idle"]').first().click();
        expect(await labelIs(o.page, 'activity', /^idle$/)).toBe('idle');
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
        expect(derived!, 'the event says it is derived from the page\'s drawing, never the backend event itself').toMatch(/derived from the page.s drawing of GET \/api\/connections/);
        expect(await label(o.page, 'connection-openrouter'), 'the other cards stay as they are').toBe('disconnected');
        await closeInspect(o.page);
        expect(o.left, 'requests that left 127.0.0.1 (Clerk\'s fetches to the FAKE instance aside)').toEqual([]);
        expect(o.errors, 'page errors').toEqual([]);
        expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
      } finally { await o.close(); }
    });
  }

  it.skipIf(!browserPath)('reduced motion: the card says the runtime would be paused on its first frame; the labels carry the state; no page error', async () => {
    const o = await open({ width: 1440, height: 900 }, { reducedMotion: true });
    try {
      await until(o.page, 'the connections screen', (s) => /Connect with OpenRouter/.test(s));
      const view = await openInspect(o.page);
      expect(view).toMatch(/Reduced motion/);
      const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
      expect(card).toMatch(/Reduced motion\s*\n?\s*on: the runtime is paused on its first frame/);
      expect(await label(o.page, 'activity')).toBe('idle');
      await closeInspect(o.page);
      expect(o.errors, 'page errors').toEqual([]);
    } finally { await o.close(); }
  });

  it.skipIf(!browserPath)('the REAL turn moves the activity label: working while the FAKE model answers, idle when it has; Stop on a slow turn → stopped — each from the page\'s drawing of H169\'s SSE, said so', async () => {
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
      // a slow turn: working while it streams; Stop → stopping → stopped
      const composer = o.page.getByRole('textbox', { name: /Message Timmy/i }).or(o.page.getByPlaceholder(/Message Timmy/i));
      await composer.first().fill('FAKE: answer slowly please');
      await o.page.getByRole('button', { name: /^Send/ }).first().click();
      // (the page's own turn is drawn in #cx-own — li.cx-turn.is-timmy.is-streaming — while the saved conversation is #cx-turns; the
      // bindings must follow the real turn either from H171's SSE handler calling TimmyRive.fromSse/stopping, or by reading #cx-own)
      expect(await labelIs(o.page, 'activity', /^working$/, 20_000), 'the activity label while the FAKE model streams (H174\'s derivation reads #cx-turns, H171 draws the own turn in #cx-own; or H171 feeds TimmyRive.fromSse)').toBe('working');
      await o.page.getByRole('button', { name: /^Stop/ }).first().click();
      expect(await labelIs(o.page, 'activity', /^stopped$/, 30_000)).toBe('stopped');
      // a quick turn: working, then idle when answered
      await until(o.page, 'the stopped turn settled', (s) => /Stopped|stopped/i.test(s), 20_000);
      await composer.first().fill('FAKE: what time is it?');
      await o.page.getByRole('button', { name: /^Send/ }).first().click();
      await until(o.page, 'the FAKE answer', (s) => s.includes(FAKE_ANSWER), 60_000);
      expect(await labelIs(o.page, 'activity', /^idle$/, 20_000)).toBe('idle');
      await openInspect(o.page);
      const ev = await events(o.page, 'activity');
      for (const word of ['working', 'stopped', 'idle']) expect(ev.some((e) => new RegExp(`activity = "${word}"`).test(e) && /derived from the page.s drawing of the turn|derived from the page.s Stop button/.test(e)), `the ${word} event, said to be derived: ${ev.join(' | ')}`).toBe(true);
      expect(ev.some((e) => /^activity = "stopping" · /.test(e)), `a stopping event from the page's Stop: ${ev.join(' | ')}`).toBe(true);
      const card = await o.page.locator('[data-inspect-component="activity"]').innerText();
      expect(card, 'the Inspect view shows no receipt and no progress number').not.toMatch(/receipt [0-9a-f]{8}|\d+ ?%|sha256_/i);
      await closeInspect(o.page);
      expect(o.errors, 'page errors').toEqual([]);
      expect(o.missing, 'resources the page asked for and the companion has not').toEqual([]);
    } finally { await o.close(); }
  });
});
