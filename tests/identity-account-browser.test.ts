/**
 * R11 round 7 (H173; round 4's test, moved onto SHELL CONTRACT v1): the ACCOUNT page in a real browser (Chromium through
 * playwright, headless) on the contract's scaffold (#screen-account.page[data-page="account"] with its regions), with
 * Clerk's REAL module served from this checkout's node_modules by the REAL vendor route, and the UNCONFIGURED blocker page.
 *
 * WHAT IS REAL: src/companion/client/account.js and account.css; src/companion/identity/routes.ts (mountIdentity: GET
 * /api/identity, /vendor/clerk/*, /api/identity/me, /api/projects) with the product's verifier on RS256 tokens; the page's
 * Content-Security-Policy (page.ts pagePolicy, connect-src widened by connectSrcFor); @clerk/clerk-js 6.40.1's
 * clerk.no-rhc.mjs, imported by the page and RUN (new Clerk(key).load()).
 * WHAT STANDS IN: H175's window.TimmyShell — a FAKE of this test's with the contract's surface (page/state/go/current/
 * land/mount/fetch with the launch token + X-Timmy-Session and the { needs: 'session' } 401 rule/session/identity/toast/h/
 * on), served as a file (the page allows no inline script); the launch token's check (a FAKE withToken); the instance's key
 * pair (this test's); the instance itself — there is none: its host is under .invalid and the browser resolves no name
 * but 127.0.0.1, so Clerk.load() FAILS here and the page says so in words. Nothing signs in, anywhere. A real sign-up,
 * sign-in, OAuth round trip, recovery or restored session needs a real Clerk instance (the operator's Mac).
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

/** The FAKE shell of this test: SHELL CONTRACT v1's surface (page/state/go/current/land/mount/fetch/session/identity/toast/h/on). */
const FAKE_SHELL = `(() => {
  'use strict';
  const token = (/#t=([0-9a-f]{64})/.exec(location.hash) || [])[1] || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  let current = ''; let sessionTok = null; let sessionUser = null; let ident = null;
  const draws = {}; const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach((f) => { try { f(data); } catch (e) { console.error('listener', e); } });
  window.__went = []; window.__toasts = []; window.__landed = 0; window.__meta = null; window.__states = [];
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const section = (id) => document.getElementById('screen-' + id) || document.querySelector('section.page[data-page="' + id + '"]');
  const shell = {
    SCREENS: ['account', 'connections', 'chat'],
    h,
    mount(id, fn) { draws[id] = fn; if (current === id) { const host = section(id); if (host) fn(host, shell); } },
    go(id, why) {
      window.__went.push(id + ':' + (why || '')); current = id;
      document.querySelectorAll('section.page').forEach((s) => { s.hidden = s.dataset.page !== id; });
      document.body.dataset.page = id;
      const host = section(id);
      if (host && draws[id]) draws[id](host, shell);
      emit('page', { id, legacy: id, why }); if (['account', 'connections', 'chat'].includes(id)) emit('screen', { id, why });
      const head = host && host.querySelector('h1.page-title'); if (head) { head.setAttribute('tabindex', '-1'); head.focus(); }
    },
    current: () => current,
    page(id, meta) {
      window.__meta = meta;
      const sec = section(id); if (!sec) return;
      const btn = h('button', { type: 'button', class: 'ui-primary', 'data-ac': 'primary', disabled: !!meta.primary.disabled, title: meta.primary.why || null }, meta.primary.label, h('span', { 'aria-hidden': 'true' }, ' →'));
      btn.addEventListener('click', () => meta.primary.run());
      sec.querySelector('.page-head').replaceChildren(h('div', null, h('p', { class: 'page-kicker' }, meta.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, meta.title), h('p', { class: 'page-intro' }, meta.intro)), h('div', { class: 'page-primary' }, btn));
      const act = h('button', { type: 'button', class: 'band-action', disabled: !!meta.primary.disabled }, meta.primary.label); act.addEventListener('click', () => meta.primary.run());
      sec.querySelector('.page-band').replaceChildren(...[['Workspace', 'Untitled project'], ['Model', 'not chosen'], ['Records', 'Local']].map(([k, v]) => h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, k), h('strong', { class: 'band-v' }, v))), act);
      const ctx = sec.querySelector('.page-context'); if (ctx) ctx.hidden = meta.context === null;
      const dock = sec.querySelector('.page-dock'); if (dock && !dock.querySelector('.dock-label')) dock.prepend(h('span', { class: 'dock-label' }, meta.dock || (id.toUpperCase() + ' TOOLS')));
    },
    state(id, s, o) { window.__states.push({ id, s, words: o && o.words, next: o && o.next && o.next.label }); const sec = section(id); if (sec) sec.dataset.state = s; },
    async fetch(url, init) {
      const o = Object.assign({}, init || {});
      o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token }, sessionTok ? { 'X-Timmy-Session': sessionTok } : {});
      o.credentials = 'omit'; o.cache = 'no-store';
      const r = await fetch(url, o);
      if (r.status === 401) {
        let body = null; try { body = await r.clone().json(); } catch (e) { body = null; }
        if (body && body.needs === 'session') { shell.session.clear(); shell.toast(body.words || 'Signed out.'); shell.go('account', 'session'); }
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
    async land() { window.__landed += 1; shell.go(ident && ident.configured && !sessionTok ? 'account' : 'chat', 'landing'); },
    toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
  window.TimmyShell = shell;
  // as the real shell: the landing after the page's scripts have loaded (DOMContentLoaded), so every page script's listeners are on
  const start = () => shell.fetch('/api/identity').then(async (r) => {
    ident = r.status === 200 ? await r.json() : { configured: false, needs: [], words: 'GET /api/identity answered ' + r.status + '.' };
    emit('identity', ident);
    // the test's start: the person came from Files (the return path), then the account page
    shell.go('files', 'test'); shell.go('account', 'test');
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;

/** The page: the contract's scaffold for the account page + two more sections for the return path; no inline script. */
const PAGE = `<!doctype html><html lang="en" data-theme="amber"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell · account</title>
<style>:root{--timmy-ui-canvas:#080B0F;--timmy-ui-surface:#111A23;--timmy-ui-raised:#1C2936;--timmy-ui-border:#44586B;--timmy-ui-border-quiet:#1E2A36;--timmy-ui-text:#ECF1F5;--timmy-ui-text-secondary:#BDCADA;--timmy-ui-text-muted:#9AAFC3;--timmy-ui-focus:#FFB000;--timmy-ui-verified:#28FE14;--timmy-ui-accent:#D6AA64;--timmy-ui-accent-ink:#402E14;--timmy-ui-font:system-ui,sans-serif;--timmy-ui-font-mono:monospace;--timmy-ui-size-section:18px;--timmy-ui-size-body:14px;--timmy-ui-size-label:13px;--timmy-ui-radius-control:10px;--timmy-ui-radius-panel:16px;--timmy-ui-radius-pill:999px;--timmy-ui-elev-primary:linear-gradient(120deg,#F0E5D4,#D6AA64)}
body{margin:0;background:var(--timmy-ui-canvas);color:var(--timmy-ui-text);font:14px/1.55 var(--timmy-ui-font)}main{max-width:1240px;margin:0 auto;padding:24px 32px;box-sizing:border-box}section.page[hidden]{display:none}.page-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.page-kicker{font-size:13px;letter-spacing:.14em;color:var(--timmy-ui-accent);margin:0 0 6px}.page-title{margin:0 0 6px;font-size:30px}.page-intro{margin:0;color:var(--timmy-ui-text-secondary)}.page-band{display:flex;gap:24px;align-items:center;margin:16px 0;padding:14px 18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.band-k{display:block;font-size:13px;color:var(--timmy-ui-text-secondary)}.band-action{margin-left:auto;font:inherit;background:transparent;border:0;color:var(--timmy-ui-text);text-decoration:underline;cursor:pointer}.page-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}.page-work{min-width:0}.page-context{min-width:0;padding:18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.page-dock{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}.dock-label{font-size:13px;letter-spacing:.12em;color:var(--timmy-ui-text-secondary)}.dock-group{display:contents}.ui-primary{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-accent);background:var(--timmy-ui-elev-primary);color:var(--timmy-ui-accent-ink);padding:10px 16px;border-radius:10px}.ui-primary:disabled{opacity:.5;cursor:default}.sh-btn,.dock-btn{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-border);background:transparent;color:var(--timmy-ui-text);padding:8px 14px;border-radius:10px}.sh-btn:disabled,.dock-btn:disabled{opacity:.5;cursor:default}.sh-btn-text{font:inherit;cursor:pointer;border:0;background:transparent;color:var(--timmy-ui-text);text-decoration:underline}.sh-divider{text-align:center;color:var(--timmy-ui-text-secondary);font-size:13px}.sh-state.is-live{color:var(--timmy-ui-verified)}
@media (max-width:720px){main{padding:16px}.page-head{flex-direction:column}.page-band{flex-wrap:wrap}.page-body{grid-template-columns:1fr}}</style>
<link rel="stylesheet" href="/account.css"></head><body>
<main id="ws-main">
<section class="page ws-page" id="screen-account" data-page="account" data-ws-page="account" aria-label="Account" hidden>
  <header class="page-head"></header><div class="page-band"></div>
  <div class="page-body"><div class="page-work"></div><aside class="page-context" aria-label="About your account"></aside></div>
  <div class="page-dock"></div><div class="page-records"></div>
</section>
<section class="page ws-page" id="ws-files" data-page="files" hidden><header class="page-head"><h1 class="page-title">Files</h1></header></section>
<section class="page ws-page" id="ws-chat" data-page="chat" hidden><header class="page-head"><h1 class="page-title">Chat</h1></header></section>
</main>
<script src="/fake-shell.js"></script>
<script src="/account.js"></script>
</body></html>`;

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let browser: Browser | null = null;
const servers: Server[] = [];
let configuredBase = '';
let bareBase = '';
let configuredMount: ReturnType<typeof mountIdentity>;

async function startCompanion(env: Record<string, string>): Promise<{ base: string; mounted: ReturnType<typeof mountIdentity> }> {
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
  const mounted = mountIdentity(app, { withToken, json: express.json({ limit: '16kb' }), env, sendPage: (res) => sendPage(res.req, res) });
  const server = createServer(app);
  servers.push(server);
  return { base: await listen(server), mounted };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h173-account-browser-'));
  mkdirSync(join(root, 'home')); mkdirSync(join(root, 'home-bare'));
  writeFileSync(join(root, 'fake-shell.js'), FAKE_SHELL);
  // configured: the FAKE instance's key pair, both social sign-ins declared on (CLERK_SOCIAL); the real Clerk module found from node_modules
  ({ base: configuredBase, mounted: configuredMount } = await startCompanion({ TIMMY_HOME: join(root, 'home'), [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.jwtKey]: PEM, [IDENTITY_ENV.social]: 'google,github' }));
  // not configured: no CLERK_* at all — the blocker page
  ({ base: bareBase } = await startCompanion({ TIMMY_HOME: join(root, 'home-bare') }));
  const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('identity-account-browser: no Chromium found, so the browser checks are skipped here');
  // no proxy (a container's HTTPS_PROXY in the environment would otherwise carry the browser's requests out: Chromium reads
  // it, --no-proxy-server notwithstanding, so the variables are not handed down), and no name but 127.0.0.1 resolves
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
  await Promise.all(servers.map(close));
  rmSync(root, { recursive: true, force: true });
});

interface Watched { requests: { url: string; type: string; failed: string | null; status: number | null }[]; errors: string[]; console: string[] }
type AccountState = { view: string; configured: boolean; module: boolean; clerk: boolean; loading: boolean; words: string; verified: unknown; clerkSession: boolean; social: string[]; returnTo: string };
type Meta = { kicker: string; title: string; intro: string; context: string | null; dock: string; primary: { label: string; disabled?: boolean; why?: string } };

/** A page with its request log, its uncaught errors and its console; opened on the account page after the FAKE shell's start. */
async function open(base: string, width: number, height: number): Promise<{ page: Page; w: Watched }> {
  const page = await browser!.newPage({ viewport: { width, height } });
  const w: Watched = { requests: [], errors: [], console: [] };
  const seen = new Map<PwRequest, Watched['requests'][number]>();
  page.on('request', (r) => { const e = { url: r.url(), type: r.resourceType(), failed: null as string | null, status: null as number | null }; seen.set(r, e); w.requests.push(e); });
  page.on('requestfailed', (r) => { const e = seen.get(r); if (e) e.failed = r.failure()?.errorText ?? 'failed'; });
  page.on('response', (r) => { const e = seen.get(r.request()); if (e) e.status = r.status(); });
  page.on('pageerror', (e) => w.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') w.console.push(m.text()); });
  await page.goto(`${base}/#t=${LAUNCH}`);
  await page.waitForFunction(() => document.body.dataset.page === 'account' && Boolean(document.querySelector('#screen-account .ac-card')), null, { timeout: 15_000 });
  return { page, w };
}
const state = (page: Page) => page.evaluate(() => (window as unknown as { timmyAccount: { state(): AccountState } }).timmyAccount.state());
const meta = (page: Page) => page.evaluate(() => (window as unknown as { __meta: Meta }).__meta);
const went = (page: Page) => page.evaluate(() => { const w = (window as unknown as { __went: string[] }).__went; return w[w.length - 1]; });

describe('the account page in Chromium (FAKE shell on SHELL CONTRACT v1, real routes, Clerk\'s real module from 127.0.0.1)', () => {
  it('CONFIGURED, 1440x900: the registration per view; Clerk\'s module fetched from this companion only and run; the instance unreachable → the words, the primary disabled with them; the declared social choices; no script from any other host', async () => {
    if (!browser) return;
    const { page, w } = await open(configuredBase, 1440, 900);
    try {
      // the head is the shell's, from the registration: the sign-up view first
      expect(await meta(page)).toMatchObject({ kicker: 'ACCOUNT / CREATE YOUR ACCOUNT', title: 'Make room for your next idea.', context: 'selection', dock: 'ACCOUNT TOOLS', primary: { label: 'Create account' } });
      expect(await page.locator('#screen-account .page-kicker').textContent()).toBe('ACCOUNT / CREATE YOUR ACCOUNT');
      expect(await page.locator('#screen-account .page-title').textContent()).toBe('Make room for your next idea.');
      expect(await page.locator('.ac-card h2').textContent()).toBe('Create your Timmy account');
      expect(await page.locator('.ac-field-k').allTextContents()).toEqual(['Username', 'Email address', 'Password']);
      // the social choices: both declared (CLERK_SOCIAL=google,github), drawn; the divider's words
      expect(await page.locator('.ac-social').allTextContents()).toEqual(['GContinue with Google', '⌘Continue with GitHub']);
      expect(await page.locator('.ac-divider').textContent()).toBe('or create an account');
      expect((await state(page)).social).toEqual(['google', 'github']);
      // the right column: identity apart from provider authorization
      expect(await page.locator('.ac-ctx-title').textContent()).toBe('Two different things');
      expect(await page.locator('.ac-ctx-dl').first().locator('dt').allTextContents()).toEqual(['Your Timmy account', 'Provider authorization']);
      expect(await page.locator('.page-dock .dock-btn').allTextContents()).toEqual(['Sign in instead', 'Settings']);
      expect(await page.locator('.page-records details.records summary').textContent()).toBe('How sign-in is verified here');

      const installed = Boolean(configuredMount.clerkDir);
      if (!installed) console.warn('identity-account-browser: @clerk/clerk-js is not installed here, so the module checks are skipped');
      // the module: imported from /vendor/clerk/ and run — then Clerk.load() against the instance, which has no address here
      await page.waitForFunction(() => { const s = (window as unknown as { timmyAccount: { state(): AccountState } }).timmyAccount.state(); return !s.loading && s.words !== ''; }, null, { timeout: 30_000 });
      const s = await state(page);
      expect(s.configured).toBe(true);
      expect(s.clerk).toBe(false);
      if (installed) {
        expect(s.module).toBe(true);
        expect(s.words).toBe(`Clerk could not start from ${HOST}: its environment and client did not load (no network to it, or the key names an instance that does not exist); Clerk reports status "ready".`);
        const vendor = w.requests.filter((r) => r.url.startsWith(`${configuredBase}${CLERK_VENDOR_PATH}`));
        expect(vendor.map((r) => r.url)).toEqual([`${configuredBase}${CLERK_VENDOR_PATH}${CLERK_SCRIPT}`]);
        expect(vendor[0].status).toBe(200);
        expect(vendor[0].type).toBe('script');
        const foreign = w.requests.filter((r) => new URL(r.url).hostname !== '127.0.0.1');
        expect(foreign.length).toBeGreaterThan(0);
        for (const r of foreign) { expect(new URL(r.url).hostname, r.url).toBe(HOST); expect(['fetch', 'xhr'], r.url).toContain(r.type); expect(r.failed, r.url).toBe('net::ERR_NAME_NOT_RESOLVED'); }
        expect([...new Set(foreign.map((r) => new URL(r.url).pathname))].sort()).toEqual(['/v1/client', '/v1/environment']);
      } else {
        expect(s.module).toBe(false);
        expect(s.words).toContain('not installed');
      }
      for (const r of w.requests.filter((r) => r.type === 'script')) expect(new URL(r.url).hostname, r.url).toBe('127.0.0.1');
      expect(w.errors).toEqual([]);
      const refused = w.console.filter((m) => /Content Security Policy|Refused to/.test(m));
      for (const m of refused) expect(m).toMatch(/^Creating a worker from 'blob:http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+' violates the following Content Security Policy directive: "script-src 'self'"/);
      // the ONE primary (the shell's) disabled with the words as its title; the form's own submit disabled with the words beside; the social buttons too
      const primary = page.locator('[data-ac="primary"]');
      expect(await primary.isDisabled()).toBe(true);
      expect(await primary.getAttribute('title')).toBe(s.words);
      expect((await meta(page)).primary).toMatchObject({ label: 'Create account', disabled: true, why: s.words });
      expect(await page.locator('.ac-submit').isDisabled()).toBe(true);
      expect(await page.locator('#ac-primary-note').textContent()).toBe(s.words);
      for (const b of await page.locator('.ac-social').all()) expect(await b.isDisabled()).toBe(true);
      expect(await page.locator('#ac-social-note').textContent()).toBe(s.words);
      // the dock's switch: the sign-in view, its registration
      await page.locator('[data-ac="dock-switch"]').click();
      expect(await meta(page)).toMatchObject({ kicker: 'ACCOUNT / SIGN IN TO TIMMY', title: 'Welcome back to Timmy.', primary: { label: 'Sign in' } });
      expect(await page.locator('.ac-card h2').textContent()).toBe('Welcome back to Timmy');
      expect(await page.locator('.page-dock .dock-btn').first().textContent()).toBe('Create an account instead');
      expect(await page.locator('.ac-divider').textContent()).toBe('or use your email');
      await page.locator('[data-ac="recover"]').click();
      expect(await meta(page)).toMatchObject({ kicker: 'ACCOUNT / RESET YOUR PASSWORD', primary: { label: 'Send code' } });
      // the launch token is in memory: not in the page, not in any address the page asked for after the first
      expect(await page.content()).not.toContain(LAUNCH);
      for (const r of w.requests.slice(1)) expect(r.url).not.toContain(LAUNCH);
      expect(await page.content()).not.toContain('PUBLIC KEY');
    } finally { await page.close(); }
  }, 60_000);

  it('a session the server verifies → "You\'re signed in" with the ONE green line from GET /api/identity/me and the return path (back to Files); Clerk\'s state rules; a token of another key → refused with words, the shell\'s 401 rule clears it; sign out → the sign-in view', async () => {
    if (!browser) return;
    const { page, w } = await open(configuredBase, 1440, 900);
    try {
      expect((await state(page)).returnTo).toBe('files'); // the page the person came from (the FAKE shell's start)
      const good = await mint({ azp: configuredBase });
      const u = await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<{ id: string }> } }).timmyAccount.useSession(t), good);
      expect(u.id).toBe(USER_A);
      // the return path: on to Files, where the person was going
      expect(await went(page)).toBe('files:continue');
      // back on the account page: the signed-in view, its registration, the ONE green line
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string, why: string): void } }).TimmyShell.go('account', 'test'));
      await page.getByRole('heading', { level: 2, name: 'You’re signed in' }).waitFor();
      expect(await meta(page)).toMatchObject({ kicker: 'ACCOUNT / YOU ARE SIGNED IN', primary: { label: 'Continue' } });
      expect(await page.locator('#screen-account .page-intro').textContent()).toBe(`Verified by this companion: ${USER_A}. Your projects and records are your own.`);
      expect(await page.locator('.ac-state.is-live').textContent()).toBe(`Verified by this companion: ${USER_A}`);
      expect(await page.locator('.ac-sub').first().textContent()).toBe(USER_A); // a default session token carries no username or email
      expect(await page.locator('.page-dock .dock-btn').allTextContents()).toEqual(['Settings']);
      // the token rode in the header only: not in the page, not in an address
      expect(await page.content()).not.toContain(good);
      for (const r of w.requests) expect(r.url).not.toContain(good);
      expect(w.requests.find((r) => r.url === `${configuredBase}/api/identity/me`)?.status).toBe(200);
      // Continue → back to Files again (the page the person came from this time too)
      await page.locator('[data-ac="continue"]').click();
      expect(await went(page)).toBe('files:continue');
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string, why: string): void } }).TimmyShell.go('account', 'test'));
      // Clerk's state with NO session while the page holds a server-verified one: NOT cleared; a session Clerk itself gave, then gone: cleared
      await page.evaluate(() => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: null, user: null }));
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBe(good);
      expect(await page.getByRole('heading', { level: 2, name: 'You’re signed in' }).count()).toBe(1);
      await page.evaluate((t) => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: { id: 'sess_FAKEclerkheld0001', status: 'active', getToken: async () => t }, user: { id: 'user_2abcDEF0123456789', username: 'fake-alice' } }), good);
      expect((await state(page)).clerkSession).toBe(true);
      expect(await page.locator('.ac-sub').first().textContent()).toBe('fake-alice');
      expect(await page.locator('#screen-account .page-title').textContent()).toBe('Welcome, fake-alice.');
      await page.evaluate(() => (window as unknown as { timmyAccount: { clerkState(s: unknown): Promise<void> } }).timmyAccount.clerkState({ session: null, user: null }));
      await page.getByRole('heading', { level: 2, name: 'Welcome back to Timmy' }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      // signed in again through the seam, then Sign out from the card: the page forgets (no Clerk here to tell)
      await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<unknown> } }).timmyAccount.useSession(t), good);
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string, why: string): void } }).TimmyShell.go('account', 'test'));
      await page.getByRole('heading', { level: 2, name: 'You’re signed in' }).waitFor();
      await page.locator('[data-ac="signout"]').click();
      await page.getByRole('heading', { level: 2, name: 'Welcome back to Timmy' }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      // a token the instance did not sign: 401 { needs: 'session' } → the shell clears the session and toasts; no account shown
      const bad = await mint({ azp: configuredBase, key: other.privateKey });
      const why = await page.evaluate((t) => (window as unknown as { timmyAccount: { useSession(t: string): Promise<unknown> } }).timmyAccount.useSession(t).then(() => 'signed in', (e: Error) => e.message), bad);
      expect(why).toBe(SESSION_WORDS.signature);
      expect(await page.evaluate(() => (window as unknown as { TimmyShell: { session: { get(): string | null } } }).TimmyShell.session.get())).toBeNull();
      const toasts = await page.evaluate(() => (window as unknown as { __toasts: { words: string; live: boolean }[] }).__toasts);
      expect(toasts[toasts.length - 1]).toEqual({ words: SESSION_WORDS.signature, live: false });
      expect(await page.getByRole('heading', { level: 2, name: 'You’re signed in' }).count()).toBe(0);
      expect((await state(page)).verified).toBeNull();
      expect(w.errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('NOT CONFIGURED: an explicit blocker page — the exact names to set, what each is and where it comes from, what happens next; no form, no social button, nothing signs in; Continue as the operator', async () => {
    if (!browser) return;
    const { page, w } = await open(bareBase, 1440, 900);
    try {
      expect(await meta(page)).toMatchObject({ kicker: 'ACCOUNT / SET UP SIGN-IN', title: 'Sign-in is not set up on this companion.', primary: { label: 'Continue as the operator' }, context: 'selection' });
      expect((await state(page)).view).toBe('blocker');
      expect(await page.locator('#screen-account').getAttribute('data-state')).toBe('error');
      expect(await page.evaluate(() => { const s = (window as unknown as { __states: { s: string; next: string }[] }).__states; return s[s.length - 1]; })).toMatchObject({ s: 'error', next: 'Continue as the operator' });
      expect(await page.locator('[data-ac="blocker-state"]').textContent()).toBe('Sign-in is not set up on this companion');
      expect(await page.locator('#ac-blocker-title').textContent()).toBe('No identity provider is configured.');
      expect(await page.locator('.ac-blocker .ac-sub').textContent()).toBe('Set CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY where Timmy’s terminal starts the companion, then start Timmy again: this page then shows the sign-up.');
      // the steps: every name, its tag, what it is, where it comes from — never a value
      expect(await page.locator('.ac-step .ac-code').allTextContents()).toEqual(['CLERK_PUBLISHABLE_KEY', 'CLERK_JWT_KEY', 'CLERK_SOCIAL']);
      expect(await page.locator('.ac-step .ac-tag').allTextContents()).toEqual(['missing', 'missing', 'optional']);
      expect(await page.locator('.ac-step').first().locator('.ac-where').textContent()).toBe('Clerk dashboard → Configure → API keys → Publishable key.');
      expect(await page.locator('.ac-step').nth(1).locator('.ac-note').first().textContent()).toContain('verifies every session against it, with no network');
      // no form, no input, no social button: nothing to sign into, nothing pretended
      expect(await page.locator('#screen-account form, #screen-account input, #screen-account .ac-social').count()).toBe(0);
      expect(await page.locator('#screen-account').textContent()).toContain('Nothing is signed in and no account is pretended.');
      expect(await page.locator('.page-records details.records').textContent()).toContain('nothing: every request is the operator’s, under the launch token');
      // the module is not even asked for: no /vendor/clerk/ request, nothing foreign
      expect(w.requests.filter((r) => r.url.includes('/vendor/clerk/'))).toEqual([]);
      expect(w.requests.filter((r) => new URL(r.url).hostname !== '127.0.0.1')).toEqual([]);
      // Continue as the operator → where the person was going (Files); the primary says the same
      await page.locator('[data-ac="operator"]').click();
      expect(await went(page)).toBe('files:continue');
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string, why: string): void } }).TimmyShell.go('account', 'test'));
      await page.locator('[data-ac="primary"]').click();
      expect(await went(page)).toBe('files:continue');
      // landed on the account page directly (nothing to return to): the landing rule — the operator's workspace
      await page.evaluate(() => { try { sessionStorage.removeItem('timmy.account.return'); } catch (e) {} });
      await page.evaluate(() => (window as unknown as { TimmyShell: { go(id: string, why: string): void } }).TimmyShell.go('account', 'test'));
      await page.evaluate(() => { try { sessionStorage.removeItem('timmy.account.return'); } catch (e) {} (window as unknown as { timmyAccount: { forgetReturn(): void } }).timmyAccount.forgetReturn(); });
      await page.locator('[data-ac="primary"]').click();
      expect(await went(page)).toBe('chat:landing');
      expect(w.errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('390x844: one column, nothing wider than the screen; the card, its fields and the form\'s submit are there', async () => {
    if (!browser) return;
    const { page } = await open(configuredBase, 390, 844);
    try {
      const over = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(over.scroll, JSON.stringify(over)).toBeLessThanOrEqual(over.client);
      expect(await page.locator('.ac-card').count()).toBe(1);
      expect(await page.locator('.ac-input').count()).toBe(3);
      const card = await page.locator('.ac-card').boundingBox();
      expect(card!.x + card!.width).toBeLessThanOrEqual(390);
      expect(await page.locator('.ac-submit').isVisible()).toBe(true);
      expect(await page.locator('.ac-social').count()).toBe(2);
    } finally { await page.close(); }
  }, 60_000);
});
