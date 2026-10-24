/**
 * R11 round 4 (H173, contract C1): the ACCOUNT screen in a real browser (Chromium through playwright, headless) on H171's
 * shell contract (19:37), with Clerk's REAL module served from this checkout's node_modules by the REAL vendor route.
 *
 * WHAT IS REAL: src/companion/client/account.js and account.css; src/companion/identity/routes.ts (mountIdentity: GET
 * /api/identity, /vendor/clerk/*, /api/identity/me, /api/projects) with the product's verifier on RS256 tokens; the page's
 * Content-Security-Policy (page.ts pagePolicy, connect-src widened by connectSrcFor as H171's page does); @clerk/clerk-js
 * 6.40.1's clerk.no-rhc.mjs, imported by the page and RUN (new Clerk(key).load()).
 * WHAT STANDS IN: H171's window.TimmyShell — a FAKE of this test's with the same surface (mount/go/current/fetch with the
 * launch token + X-Timmy-Session and the { needs: 'session' } 401 rule/session/identity/land/toast/h/on), served as a file
 * (the page allows no inline script); the launch token's check (a FAKE withToken: Bearer <this test's token>); the
 * instance's key pair (this test's, as tests/identity-session.test.ts); the instance itself — there is none: its host is
 * under .invalid and the browser resolves no name but 127.0.0.1, so Clerk.load() FAILS here and the screen says so in
 * words. Nothing signs in, anywhere. What the request log proves: the page fetched Clerk's code from 127.0.0.1 only, and
 * asked nothing of any host but the instance's (fetches, which failed). Where no Chromium is found the browser checks are
 * skipped, saying so; where the package is not installed, the module checks are, saying so.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { SignJWT } from 'jose';
import { chromium, type Browser, type Page, type Request as PwRequest } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSrcFor, IDENTITY_ENV, identityConfig } from '../src/companion/identity/config.js';
import { CLERK_SCRIPT, CLERK_VENDOR_PATH, mountIdentity } from '../src/companion/identity/routes.js';
import { SESSION_WORDS } from '../src/companion/identity/session.js';
import { pagePolicy } from '../src/companion/page.js';

const CLIENT = resolve('src/companion/client');
const HOST = 'fake-identity.clerk.accounts.invalid';
const PK = `pk_test_${Buffer.from(`${HOST}$`).toString('base64')}`;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const USER_A = 'user_2abcDEF0123456789';
const LAUNCH = randomBytes(32).toString('hex');

async function mint(o: { sub?: string; azp: string; key?: KeyObject }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: o.sub ?? USER_A, sid: 'sess_2abcSESSION0123456', azp: o.azp, iss: `https://${HOST}` })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_fake_kid' }).setIssuedAt(now).setExpirationTime(now + 60).sign(o.key ?? pair.privateKey);
}

/** The FAKE shell of this test: H171's surface (19:37), as a file the page loads before account.js. */
const FAKE_SHELL = `(() => {
  'use strict';
  const token = (/#t=([0-9a-f]{64})/.exec(location.hash) || [])[1] || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  let current = ''; let sessionTok = null; let sessionUser = null; let ident = null;
  const draws = {}; const listeners = { screen: [], session: [], identity: [] };
  const emit = (ev, data) => (listeners[ev] || []).forEach((f) => { try { f(data); } catch (e) { console.error('listener', e); } });
  window.__went = []; window.__toasts = []; window.__landed = 0;
  const shell = {
    mount(id, fn) { draws[id] = fn; if (current === id) { const host = document.getElementById('screen-' + id); if (host) fn(host, shell); } },
    go(id) {
      window.__went.push(id); current = id;
      document.querySelectorAll('.sh-screen').forEach((s) => { s.hidden = s.dataset.screen !== id; });
      document.body.dataset.screen = id;
      const host = document.getElementById('screen-' + id);
      if (host && draws[id]) draws[id](host, shell);
      const head = host && host.querySelector('h1, h2'); if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
      emit('screen', id);
    },
    current: () => current,
    async fetch(url, init) {
      const o = Object.assign({}, init || {});
      o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token }, sessionTok ? { 'X-Timmy-Session': sessionTok } : {});
      o.credentials = 'omit'; o.cache = 'no-store';
      const r = await fetch(url, o);
      if (r.status === 401) {
        let body = null; try { body = await r.clone().json(); } catch (e) { body = null; }
        if (body && body.needs === 'session') { shell.session.clear(); shell.toast(body.words || 'Signed out.'); shell.go('account'); }
      }
      return r;
    },
    socketHello: () => (sessionTok ? { session: sessionTok } : {}),
    session: {
      set(t, u) { sessionTok = t; sessionUser = u || null; emit('session', { token: t, user: sessionUser }); },
      clear() { sessionTok = null; sessionUser = null; emit('session', { token: null, user: null }); },
      get: () => sessionTok, user: () => sessionUser,
    },
    identity: () => ident,
    async land() { window.__landed += 1; shell.go('account'); },
    toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
    h(tag, attrs, ...children) {
      const el = document.createElement(tag);
      if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); }
      for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
      return el;
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
  window.TimmyShell = shell;
  shell.fetch('/api/identity').then(async (r) => {
    ident = r.status === 200 ? await r.json() : { configured: false, needs: [], words: 'GET /api/identity answered ' + r.status + '.' };
    emit('identity', ident);
    shell.land();
  });
})();
`;

/** The page: the shell's host for the account screen, the theme's variables, the shell's classes the screen uses; no inline script. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell · account</title>
<style>:root{--timmy-ground:#000;--timmy-surface:#0c0c0c;--timmy-raised:#161616;--timmy-line:#2a2a2a;--timmy-line-strong:#3a3a3a;--timmy-text:#f2f2f2;--timmy-text-secondary:#a8a8a8;--timmy-accent:#FFB000;--timmy-accent-ink:#000;--timmy-accent-soft:#333;--timmy-silver:#E8E4D9;--timmy-live:#00ff00;--timmy-font-mono:monospace}
body{margin:0;background:var(--timmy-ground);color:var(--timmy-text);font:15px/1.4 sans-serif}.sh-screen{height:100vh;overflow-y:auto}.sh-screen[hidden]{display:none}.sh-main{width:100%;max-width:1240px;margin:0 auto;padding:36px 48px;box-sizing:border-box}.sh-card{padding:28px;border:1px solid var(--timmy-line-strong);border-radius:6px;background:var(--timmy-surface)}.sh-btn,.sh-btn-primary,.sh-btn-text{font:inherit;cursor:pointer}.sh-btn{border:1px solid var(--timmy-line-strong);background:transparent;color:var(--timmy-text);padding:8px 14px}.sh-btn-primary{border:1px solid var(--timmy-accent);background:var(--timmy-accent);color:#000;padding:8px 14px}.sh-btn-text{border:0;background:transparent;color:var(--timmy-text);text-decoration:underline}.sh-input,.sh-select{font:inherit;padding:6px 10px;border:1px solid var(--timmy-line-strong);background:#000;color:var(--timmy-text);max-width:100%;box-sizing:border-box}.sh-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.sh-state.is-live{color:var(--timmy-live)}.sh-note{font-size:13px;color:var(--timmy-text-secondary)}.sh-head,.sh-foot{display:flex;justify-content:space-between;gap:16px;padding:16px 48px}.sh-steps{display:flex;gap:20px}.sh-field{display:block}@media (max-width:720px){.sh-main{padding:20px 16px}.sh-head,.sh-foot{padding:12px 16px;flex-wrap:wrap}}</style>
<link rel="stylesheet" href="/account.css"></head><body>
<section class="sh-screen" id="screen-account" data-screen="account" hidden></section>
<script src="/fake-shell.js"></script>
<script src="/account.js"></script>
</body></html>`;

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let browser: Browser | null = null;
let companion: Server;
let base = '';
let mounted: ReturnType<typeof mountIdentity>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h173-account-browser-'));
  mkdirSync(join(root, 'home'));
  writeFileSync(join(root, 'fake-shell.js'), FAKE_SHELL);
  const env = { TIMMY_HOME: join(root, 'home'), [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.jwtKey]: PEM };
  const cfg = identityConfig(env);
  const app = express();
  const policy = (host: string | undefined) => pagePolicy(host).replace("connect-src 'self'", `connect-src 'self'${connectSrcFor(cfg)}`); // as H171's page widens it
  const sendPage = (req: express.Request, res: express.Response) => { res.setHeader('Content-Security-Policy', policy(req.headers.host)); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(PAGE); };
  const file = (name: string, type: string, dir = CLIENT): express.RequestHandler => (_req, res) => { res.setHeader('Content-Type', type); res.send(readFileSync(join(dir, name), 'utf8')); };
  app.get('/', sendPage);
  app.get('/fake-shell.js', file('fake-shell.js', 'text/javascript; charset=utf-8', root));
  app.get('/account.js', file('account.js', 'text/javascript; charset=utf-8'));
  app.get('/account.css', file('account.css', 'text/css; charset=utf-8'));
  const withToken: express.RequestHandler = (req, res, next) => {
    if ((req.get('authorization') ?? '') !== `Bearer ${LAUNCH}`) { res.status(401).json({ ok: false, error: 'FAKE withToken: the launch token is missing or wrong' }); return; }
    next();
  };
  mounted = mountIdentity(app, { withToken, json: express.json({ limit: '16kb' }), env, sendPage: (res) => sendPage(res.req, res) });
  companion = createServer(app);
  base = await listen(companion);
  const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('identity-account-browser: no Chromium found, so the browser checks are skipped here');
  // no proxy (a container's HTTPS_PROXY in the environment would otherwise carry the browser's requests out: Chromium reads
  // it, --no-proxy-server notwithstanding, so the variables are not handed down), and no name but 127.0.0.1 resolves
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
  await close(companion);
  rmSync(root, { recursive: true, force: true });
});

interface Watched { requests: { url: string; type: string; failed: string | null; status: number | null }[]; errors: string[]; console: string[] }

/** A page with its request log, its uncaught errors and its console. */
async function open(width: number, height: number): Promise<{ page: Page; w: Watched }> {
  const page = await browser!.newPage({ viewport: { width, height } });
  const w: Watched = { requests: [], errors: [], console: [] };
  const seen = new Map<PwRequest, Watched['requests'][number]>();
  page.on('request', (r) => { const e = { url: r.url(), type: r.resourceType(), failed: null as string | null, status: null as number | null }; seen.set(r, e); w.requests.push(e); });
  page.on('requestfailed', (r) => { const e = seen.get(r); if (e) e.failed = r.failure()?.errorText ?? 'failed'; });
  page.on('response', (r) => { const e = seen.get(r.request()); if (e) e.status = r.status(); });
  page.on('pageerror', (e) => w.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') w.console.push(m.text()); });
  await page.goto(`${base}/#t=${LAUNCH}`);
  await page.getByRole('heading', { level: 2, name: 'Create your Timmy account' }).waitFor();
  return { page, w };
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { timmyAccount: { state(): { view: string; configured: boolean; module: boolean; clerk: boolean; loading: boolean; words: string; verified: unknown; clerkSession: boolean } } }).timmyAccount.state());

describe('the account screen in Chromium (FAKE shell on H171\'s surface, real routes, Clerk\'s real module from 127.0.0.1)', () => {
  it('1440x900: the words of the preview; Clerk\'s module fetched from this companion only and run; the instance unreachable → the words beside disabled buttons; no script from any other host', async () => {
    if (!browser) return;
    const { page, w } = await open(1440, 900);
    try {
      expect(await page.locator('.ac-kicker').textContent()).toBe('Your ideas. Your tools. One workspace.');
      expect(await page.locator('.ac-title').innerText()).toBe('Make room\nfor your\nnext idea.');
      expect(await page.locator('.ac-lede').textContent()).toBe('Think in Chat. Build on Canvas. Put your tools to work, together.');
      expect(await page.locator('.sh-head-words').textContent()).toBe(`Identity · ${HOST}`);
      expect(await page.locator('.sh-step').allInnerTexts()).toEqual(['01Account', '02Connections', '03Workspace']);
      expect(await page.locator('.sh-sub').first().textContent()).toBe('Your workspace starts with you.');
      expect(await page.locator('.sh-divider').textContent()).toBe('or create an account');
      expect(await page.locator('.ac-social').allTextContents()).toEqual(['GContinue with Google', '⌘Continue with GitHub']);
      expect(await page.locator('.sh-field-k').allTextContents()).toEqual(['Username', 'Email address', 'Password']);
      expect(await page.locator('.sh-foot span').allTextContents()).toEqual(['Every request is verified by this companion.', 'Local first. Cloud optional.']);

      const installed = Boolean(mounted.clerkDir);
      if (!installed) console.warn('identity-account-browser: @clerk/clerk-js is not installed here, so the module checks are skipped');
      // the module: imported from /vendor/clerk/ and run — then Clerk.load() against the instance, which has no address here
      await page.waitForFunction(() => { const s = (window as unknown as { timmyAccount: { state(): { loading: boolean; words: string } } }).timmyAccount.state(); return !s.loading && s.words !== ''; }, null, { timeout: 30_000 });
      const s = await state(page);
      expect(s.configured).toBe(true);
      expect(s.clerk).toBe(false);
      if (installed) {
        expect(s.module).toBe(true);
        // Clerk 6.40.1 resolves load() "ready" even here (a default environment, a client without an id): the page's own check says what happened
        expect(s.words).toBe(`Clerk could not start from ${HOST}: its environment and client did not load (no network to it, or the key names an instance that does not exist); Clerk reports status "ready".`);
        const vendor = w.requests.filter((r) => r.url.startsWith(`${base}${CLERK_VENDOR_PATH}`));
        expect(vendor.map((r) => r.url)).toEqual([`${base}${CLERK_VENDOR_PATH}${CLERK_SCRIPT}`]);
        expect(vendor[0].status).toBe(200);
        expect(vendor[0].type).toBe('script');
        // the instance was asked (its environment, over https) and could not be reached: fetches, never scripts, and all failed
        const foreign = w.requests.filter((r) => new URL(r.url).hostname !== '127.0.0.1');
        expect(foreign.length).toBeGreaterThan(0);
        for (const r of foreign) { expect(new URL(r.url).hostname, r.url).toBe(HOST); expect(['fetch', 'xhr'], r.url).toContain(r.type); expect(r.failed, r.url).toBe('net::ERR_NAME_NOT_RESOLVED'); }
        expect([...new Set(foreign.map((r) => new URL(r.url).pathname))].sort()).toEqual(['/v1/client', '/v1/environment']); // Clerk's load(): the instance's environment and client, retried
      } else {
        expect(s.module).toBe(false);
        expect(s.words).toContain('not installed');
      }
      // every script the page ran came from 127.0.0.1; nothing threw; the policy refused nothing but Clerk's timer worker
      // (a Worker from a blob: of its own code, which script-src 'self' refuses — Clerk then uses the page's timers and says
      // "Consider adding worker-src blob:"; H171's policy decides that): no script of another site's was even attempted
      for (const r of w.requests.filter((r) => r.type === 'script')) expect(new URL(r.url).hostname, r.url).toBe('127.0.0.1');
      expect(w.errors).toEqual([]);
      const refused = w.console.filter((m) => /Content Security Policy|Refused to/.test(m));
      for (const m of refused) expect(m).toMatch(/^Creating a worker from 'blob:http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+' violates the following Content Security Policy directive: "script-src 'self'"/);
      if (installed) expect(refused.length).toBeGreaterThan(0);
      // the screen: drawn and reviewable, the primary and the social buttons disabled with the words beside them; nothing signs in
      const primary = page.getByRole('button', { name: /Create account/ });
      expect(await primary.isDisabled()).toBe(true);
      expect(await page.locator('#ac-primary-note').textContent()).toBe(s.words);
      for (const b of await page.locator('.ac-social').all()) expect(await b.isDisabled()).toBe(true);
      expect(await page.locator('#ac-social-note').textContent()).toBe(`Social sign-in requires an auth service to be connected. ${s.words}`);
      // the launch token is in memory: not in the page, not in any address the page asked for after the first
      expect(await page.content()).not.toContain(LAUNCH);
      for (const r of w.requests.slice(1)) expect(r.url).not.toContain(LAUNCH);
      expect(await page.content()).not.toContain('PUBLIC KEY');
    } finally { await page.close(); }
  }, 60_000);

  it('a session the server verifies → "You\'re signed in" with the ONE green line from GET /api/identity/me; a token of another key → refused with words, the shell\'s 401 rule clears it; sign out → "Welcome back to Timmy"', async () => {
    if (!browser) return;
    const { page, w } = await open(1440, 900);
    try {
      const origin = base;
      const good = await mint({ azp: origin });
      const u = await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<{ id: string }> } }).timmyAccount.useSession(t), good);
      expect(u.id).toBe(USER_A);
      await page.getByRole('heading', { level: 2, name: 'You\'re signed in' }).waitFor();
      const live = page.locator('.ac-state.is-live');
      expect(await live.textContent()).toBe(`Verified by this companion: ${USER_A}`);
      expect(await page.locator('.sh-sub').first().textContent()).toBe(USER_A); // a default session token carries no username or email
      expect(await page.evaluate(() => (window as unknown as { __landed: number }).__landed)).toBeGreaterThanOrEqual(2);
      // the token rode in the header only: not in the page, not in an address
      expect(await page.content()).not.toContain(good);
      for (const r of w.requests) expect(r.url).not.toContain(good);
      const me = w.requests.find((r) => r.url === `${base}/api/identity/me`);
      expect(me?.status).toBe(200);
      // Clerk's state with NO session while the page holds a server-verified one: NOT cleared (the lead's 22:31 ruling: the
      // seam, or an instance momentarily unreachable); a session Clerk itself gave, then gone (active → none): cleared
      await page.evaluate(() => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: null, user: null }));
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBe(good);
      expect(await page.getByRole('heading', { level: 2, name: 'You\'re signed in' }).count()).toBe(1);
      expect((await state(page)).clerkSession).toBe(false);
      await page.evaluate((t) => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: { id: 'sess_FAKEclerkheld0001', status: 'active', getToken: async () => t }, user: { id: 'user_2abcDEF0123456789', username: 'fake-alice' } }), good);
      expect((await state(page)).clerkSession).toBe(true);
      expect(await page.locator('.sh-sub').first().textContent()).toBe('fake-alice'); // Clerk's user view, the id verified by this companion
      await page.evaluate(() => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: null, user: null }));
      await page.getByRole('heading', { level: 2, name: 'Welcome back to Timmy' }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      expect((await state(page)).clerkSession).toBe(false);
      // signed in again through the seam, then sign out: the page forgets (no Clerk here to tell), the sign-in card is drawn
      await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<unknown> } }).timmyAccount.useSession(t), good);
      await page.getByRole('heading', { level: 2, name: 'You\'re signed in' }).waitFor();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('heading', { level: 2, name: 'Welcome back to Timmy' }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      expect(await page.locator('.sh-divider').textContent()).toBe('or use your email');
      expect(await page.locator('.sh-btn-text').allTextContents()).toEqual(['Email me a code instead', 'Forgot your password?', 'Create an account']);
      // a token the instance did not sign: 401 { needs: 'session' } → the shell clears the session and toasts; the page shows no account
      const bad = await mint({ azp: origin, key: other.privateKey });
      const why = await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<unknown> } }).timmyAccount.useSession(t).then(() => 'signed in', (e: Error) => e.message), bad);
      expect(why).toBe(SESSION_WORDS.signature);
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      const toasts = await page.evaluate(() => (window as unknown as { __toasts: { words: string; live: boolean }[] }).__toasts);
      expect(toasts[toasts.length - 1]).toEqual({ words: SESSION_WORDS.signature, live: false });
      expect(await page.getByRole('heading', { level: 2, name: 'You\'re signed in' }).count()).toBe(0);
      expect((await state(page)).verified).toBeNull();
      expect(w.errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('390x844: one column, nothing wider than the screen; the card, its fields and the primary button are there', async () => {
    if (!browser) return;
    const { page } = await open(390, 844);
    try {
      const over = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(over.scroll, JSON.stringify(over)).toBeLessThanOrEqual(over.client);
      expect(await page.locator('.ac-card').count()).toBe(1);
      expect(await page.locator('.sh-input').count()).toBe(3);
      const card = await page.locator('.ac-card').boundingBox();
      expect(card!.x + card!.width).toBeLessThanOrEqual(390);
      expect(await page.getByRole('button', { name: /Create account/ }).isVisible()).toBe(true);
    } finally { await page.close(); }
  }, 60_000);
});
