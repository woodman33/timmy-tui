/**
 * R11 round 7 (H173): the SETTINGS page in a real browser (Chromium through playwright, headless) on SHELL CONTRACT v1's
 * scaffold (section#ws-settings[data-page="settings"]), against: the REAL identity routes (no provider configured → the
 * operator; src/companion/identity/routes.ts), the REAL workspace prefs (src/companion/workspace.ts CompanionWorkspace:
 * GET /api/workspace and POST /api/workspace/prefs with the revision rule, the Workbench's settings file written for real
 * in the test's Timmy home) and the REAL files route (the records' home). FAKE, said: the frame producer (a frame built
 * from the settings file, as src/ops/workspace-frame.ts would read it), GET /api/connections (the Cloudflare card's shape,
 * H170's; cloud logs off), window.TimmyShell (the contract's surface) and TimmyPanels. Nothing leaves 127.0.0.1.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import { mountIdentity } from '../src/companion/identity/routes.js';
import { CompanionWorkspace } from '../src/companion/workspace.js';
import { projectId } from '../src/project/index.js';
import { readSettings } from '../src/workbench/settings.js';
import { tildePath } from '../src/utils/home-scrub.js';

const CLIENT = resolve('src/companion/client');
const LAUNCH = randomBytes(32).toString('hex');

const FAKE_SHELL = `(() => {
  'use strict';
  const token = (/#t=([0-9a-f]{64})/.exec(location.hash) || [])[1] || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  let current = 'settings';
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach((f) => { try { f(d); } catch (e) { console.error('listener', e); } });
  window.__went = []; window.__toasts = []; window.__meta = null; window.__states = []; window.__identity = null;
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const section = (id) => document.querySelector('section.page[data-page="' + id + '"]');
  window.TimmyShell = {
    h,
    fetch(url, init) { const o = Object.assign({}, init || {}); o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token }); o.credentials = 'omit'; o.cache = 'no-store'; return fetch(url, o); },
    go(id, why) { window.__went.push(id + ':' + (why || '')); current = id; emit('page', { id, legacy: id, why }); },
    current: () => current,
    identity: () => window.__identity,
    toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    page(id, meta) {
      window.__meta = meta;
      const sec = section(id); if (!sec) return;
      const btn = h('button', { type: 'button', class: 'ui-primary', 'data-st': 'primary' }, meta.primary.label, h('span', { 'aria-hidden': 'true' }, ' →'));
      btn.addEventListener('click', () => meta.primary.run());
      sec.querySelector('.page-head').replaceChildren(h('div', null, h('p', { class: 'page-kicker' }, meta.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, meta.title), h('p', { class: 'page-intro' }, meta.intro)), h('div', { class: 'page-primary' }, btn));
      sec.querySelector('.page-band').replaceChildren(...[['Workspace', 'studio-project'], ['Model', 'not chosen'], ['Records', 'Local']].map(([k, v]) => h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, k), h('strong', { class: 'band-v' }, v))));
      const ctx = sec.querySelector('.page-context'); if (ctx) ctx.hidden = meta.context === null;
      const dock = sec.querySelector('.page-dock'); if (dock && !dock.querySelector('.dock-label')) dock.prepend(h('span', { class: 'dock-label' }, meta.dock || (id.toUpperCase() + ' TOOLS')));
    },
    state(id, s, o) { window.__states.push({ id, s }); const sec = section(id); if (sec) sec.dataset.state = s; },
    session: { get: () => '', user: () => null, clear() {} },
  };
  const panels = new Map();
  window.TimmyPanels = { register(tab, panel) { panels.set(tab, panel); }, has: (tab) => panels.has(tab), draw(tab, frame, ctx) { const p = panels.get(tab); const host = document.querySelector('[data-panel-host="' + tab + '"]'); if (!p || !host) return false; p.draw(host, frame, Object.assign({ h }, ctx)); return true; } };
  // as the shell does at landing: GET /api/identity read; then the page shown with the frame (companion.js draws the panel with it)
  window.__showSettings = async (project) => {
    const r = await window.TimmyShell.fetch('/api/identity'); window.__identity = r.status === 200 ? await r.json() : null;
    const f = await window.TimmyShell.fetch('/api/workspace?project=' + project); const frame = f.status === 200 ? await f.json() : null;
    window.TimmyShell.go('settings', 'test');
    window.TimmyPanels.draw('settings', frame, { project, fetch: window.TimmyShell.fetch, own: true });
  };
})();
`;

const PAGE = `<!doctype html><html lang="en" data-theme="amber"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell · settings</title>
<style>:root{--timmy-ui-canvas:#080B0F;--timmy-ui-surface:#111A23;--timmy-ui-raised:#1C2936;--timmy-ui-border:#44586B;--timmy-ui-border-quiet:#1E2A36;--timmy-ui-text:#ECF1F5;--timmy-ui-text-secondary:#BDCADA;--timmy-ui-text-muted:#9AAFC3;--timmy-ui-focus:#FFB000;--timmy-ui-accent:#D6AA64;--timmy-ui-accent-ink:#402E14;--timmy-ui-font:system-ui,sans-serif;--timmy-ui-font-mono:monospace;--timmy-ui-size-section:18px;--timmy-ui-size-body:14px;--timmy-ui-size-label:13px;--timmy-ui-radius-control:10px;--timmy-ui-radius-panel:16px;--timmy-ui-radius-pill:999px;--timmy-ui-elev-primary:linear-gradient(120deg,#F0E5D4,#D6AA64)}
:root[data-theme="glacier"]{--timmy-ui-accent:#8ABBE3;--timmy-ui-accent-ink:#1D3848}
body{margin:0;background:var(--timmy-ui-canvas);color:var(--timmy-ui-text);font:14px/1.55 var(--timmy-ui-font)}main{max-width:1240px;margin:0 auto;padding:24px 32px;box-sizing:border-box}.page-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.page-kicker{font-size:13px;letter-spacing:.14em;color:var(--timmy-ui-accent);margin:0 0 6px}.page-title{margin:0 0 6px;font-size:30px}.page-intro{margin:0;color:var(--timmy-ui-text-secondary)}.page-band{display:flex;gap:24px;align-items:center;margin:16px 0;padding:14px 18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.band-k{display:block;font-size:13px;color:var(--timmy-ui-text-secondary)}.page-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}.page-body:has(.page-context[hidden]){grid-template-columns:minmax(0,1fr)}.page-work{min-width:0}.page-context{min-width:0}.page-dock{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}.dock-label{font-size:13px;letter-spacing:.12em;color:var(--timmy-ui-text-secondary)}.dock-group{display:contents}.ui-primary{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-accent);background:var(--timmy-ui-elev-primary);color:var(--timmy-ui-accent-ink);padding:10px 16px;border-radius:10px}.sh-btn,.dock-btn{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-border);background:transparent;color:var(--timmy-ui-text);padding:8px 14px;border-radius:10px}.sh-btn:disabled,.dock-btn:disabled{opacity:.5}
@media (max-width:720px){main{padding:16px}.page-head{flex-direction:column}.page-band{flex-wrap:wrap}.page-body{grid-template-columns:1fr}}</style>
<link rel="stylesheet" href="/panel-settings.css"></head><body>
<div id="project" data-project="__PROJECT__" hidden></div>
<main id="ws-main">
<section class="page ws-page" id="ws-settings" data-page="settings" data-ws-page="settings" aria-label="Settings">
  <header class="page-head"></header>
  <div class="page-band"></div>
  <div class="page-body"><div class="page-work"><div data-panel-host="settings"></div></div><aside class="page-context" aria-label="Context"></aside></div>
  <div class="page-dock"></div>
  <div class="page-records"></div>
</section>
</main>
<script src="/fake-shell.js"></script>
<script src="/panel-settings.js"></script>
</body></html>`;

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let home = '';
let project = '';
let pid = '';
let browser: Browser | null = null;
let companion: Server;
let base = '';
let frames = 0;
let env: Record<string, string>;

/** FAKE frame producer: the two start-up settings from the Workbench's settings file (as the real producer reads them), a revision of them. */
const fakeFrame = async (o: { cwd: string; env: Record<string, string | undefined> }): Promise<WorkspaceFrame> => {
  frames += 1;
  const s = readSettings(o.env).settings;
  const surfaces = { companion: { openAtStart: s.openCompanionAtStart, url: null, state: 'not running' as const }, studio: { openAtStart: s.openStudioAtStart, url: null, state: 'unknown' as const } };
  const revision = createHash('sha256').update(JSON.stringify([s.openCompanionAtStart, s.openStudioAtStart])).digest('hex').slice(0, 16);
  return { schema: 'timmy.workspace', version: 1, at: new Date().toISOString(), revision, project: { id: pid, name: 'studio-project', shown: '~/studio-project', chosen: true, switch: 'timmy project use studio-project', create: 'timmy project new' }, tabs: [], actions: {} as WorkspaceFrame['actions'], connections: [], activity: { running: 0, waitingOnYou: 0, stopCurrent: { job: null, words: '' } }, log: [], surfaces } as unknown as WorkspaceFrame;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h173-settings-browser-'));
  home = join(root, 'home'); mkdirSync(home);
  project = join(root, 'studio-project'); mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# FAKE\n');
  writeFileSync(join(root, 'fake-shell.js'), FAKE_SHELL);
  pid = projectId(project);
  env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(home, 'settings'), TIMMY_REPO: project }; // no CLERK_*: the operator
  const app = express();
  const page = (res: express.Response) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(PAGE.replace('__PROJECT__', pid)); };
  const file = (name: string, type: string, dir = CLIENT): express.RequestHandler => (_req, res) => { res.setHeader('Content-Type', type); res.send(readFileSync(join(dir, name), 'utf8')); };
  app.get('/', (_req, res) => page(res));
  app.get('/fake-shell.js', file('fake-shell.js', 'text/javascript; charset=utf-8', root));
  app.get('/panel-settings.js', file('panel-settings.js', 'text/javascript; charset=utf-8'));
  app.get('/panel-settings.css', file('panel-settings.css', 'text/css; charset=utf-8'));
  const withToken: express.RequestHandler = (req, res, next) => { if ((req.get('authorization') ?? '') !== `Bearer ${LAUNCH}`) { res.status(401).json({ ok: false, error: 'FAKE withToken: the launch token is missing or wrong' }); return; } next(); };
  const identity = mountIdentity(app, { withToken, json: express.json({ limit: '16kb' }), env, sendPage: (res) => page(res), clerkDir: join(root, 'no-clerk') });
  // the REAL workspace frame/prefs routes of src/companion/workspace.ts, on the FAKE producer, for the project the request names
  const workspace = new CompanionWorkspace({ env, frame: fakeFrame, shareMs: 0 });
  const shown = { name: 'studio-project', root: project };
  app.get('/api/workspace', withToken, identity.withUser, async (_req, res) => { const a = await workspace.answerFrame(shown); res.status(a.status).json(a.body); });
  app.post('/api/workspace/prefs', withToken, identity.withUser, express.json({ limit: '4kb' }), async (req, res) => { const a = await workspace.answerPrefs(shown, req.body); res.status(a.status).json(a.body); });
  // FAKE Models & accounts: the Cloudflare card's shape (H170's GET /api/connections), cloud logs off, nothing configured
  app.get('/api/connections', withToken, identity.withUser, (_req, res) => { res.json({ ok: true, cards: [{ id: 'cloudflare', title: 'Cloudflare', state: 'not configured', words: 'not configured (optional)', cloudflare: { gatewayUrl: null, cloudLogs: false, file: 'state/cloudflare.json' } }] }); });
  companion = createServer(app);
  base = await listen(companion);
  const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('companion-settings-browser: no Chromium found, so the browser checks are skipped here');
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
  await close(companion);
  rmSync(root, { recursive: true, force: true });
});

type Seam = { state(): { frame: boolean; revision: string | null; prefs: { state: string; words: string }; theme: string; me: string | null; cloud: { state: string; cloudLogs: boolean } | null; home: string }; setTheme(t: string): void; reload(): void };
async function open(width: number, height: number): Promise<{ page: Page; errors: string[]; left: string[] }> {
  const page = await browser!.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: .* (404|409|415) /.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.protocol !== 'blob:' && u.hostname !== '127.0.0.1') left.push(r.url()); } catch { /* data: */ } });
  await page.goto(`${base}/#t=${LAUNCH}`);
  await page.evaluate((id) => (window as unknown as { __showSettings(p: string): Promise<void> }).__showSettings(id), pid);
  await page.waitForFunction(() => { const s = (window as unknown as { timmySettings?: Seam }).timmySettings?.state(); return Boolean(s && s.frame && s.me && s.cloud && s.home); }, null, { timeout: 15_000 });
  return { page, errors, left };
}
const seam = (page: Page) => page.evaluate(() => (window as unknown as { timmySettings: Seam }).timmySettings.state());

describe('the Settings page in Chromium (FAKE shell on the scaffold; the real prefs, identity and files routes; the operator)', () => {
  it('1440x900: the registration (no right column); Start-up saved for real in the Workbench\'s settings file with the revision rule; Appearance persisted per viewer; Records local, cloud sync as the card says, the home behind Details; Account: the operator, the provider not configured, Open account', async () => {
    if (!browser) return;
    const { page, errors, left } = await open(1440, 900);
    try {
      const meta = await page.evaluate(() => (window as unknown as { __meta: { kicker: string; title: string; context: unknown; dock: string; primary: { label: string } } }).__meta);
      expect(meta).toMatchObject({ kicker: 'SETTINGS / SET HOW TIMMY RUNS', title: 'Make Timmy run your way.', context: null, dock: 'SETTINGS TOOLS', primary: { label: 'Done' } });
      expect(await page.locator('.page-context').isHidden()).toBe(true);
      expect(await page.locator('.st-card-title').allTextContents()).toEqual(['Start-up', 'Appearance', 'Records', 'Account']);
      // Start-up: both off in a fresh home; one turned on → saved for real (the file), the frame's revision moves
      const companionBox = page.locator('#st-pref-companion');
      const studioBox = page.locator('#st-pref-studio');
      expect(await companionBox.isChecked()).toBe(false);
      expect(await studioBox.isChecked()).toBe(false);
      expect(await page.locator('[data-st="prefs-state"]').textContent()).toBe('Kept in the Workbench’s settings file: the terminal reads the same one.');
      const before = (await seam(page)).revision;
      await page.locator('label[for="st-pref-companion"]').click();
      await page.waitForFunction(() => (window as unknown as { timmySettings: Seam }).timmySettings.state().prefs.state === 'saved');
      expect(await page.locator('[data-st="prefs-state"]').textContent()).toMatch(/^Saved at \d\d:\d\d\. Kept in the Workbench’s settings file/);
      expect(readSettings(env).settings.openCompanionAtStart).toBe(true);
      expect(readSettings(env).settings.openStudioAtStart).toBe(false);
      expect((await seam(page)).revision).not.toBe(before);
      expect(await companionBox.isChecked()).toBe(true);
      // changed elsewhere (another surface wrote the file): this page's next save is refused — stale — and says so, nothing written over
      const { saveSettings } = await import('../src/workbench/settings.js');
      const now = readSettings(env).settings; saveSettings({ ...now, openStudioAtStart: true }, env);
      await page.locator('label[for="st-pref-companion"]').click(); // turn it off against the old revision
      await page.waitForFunction(() => (window as unknown as { timmySettings: Seam }).timmySettings.state().prefs.state === 'conflict');
      expect(await page.locator('[data-st="prefs-state"]').textContent()).toBe('Changed elsewhere: Reload to see the newer setting, then choose again.');
      expect(readSettings(env).settings.openCompanionAtStart).toBe(true); // not written over
      expect(await companionBox.isDisabled()).toBe(true);
      await page.locator('[data-st="reload"]').click();
      await page.waitForFunction(() => { const s = (window as unknown as { timmySettings: Seam }).timmySettings.state(); return s.frame && s.prefs.state === 'idle'; });
      expect(await studioBox.isChecked()).toBe(true); // the newer setting, read
      expect(await companionBox.isChecked()).toBe(true);
      // Appearance: Glacier chosen → html[data-theme], localStorage "timmy.theme"; kept over a reload
      expect(await page.locator('.st-theme-btn[aria-pressed="true"]').textContent()).toBe('Amber');
      await page.locator('[data-theme-pick="glacier"]').click();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('glacier');
      expect(await page.evaluate(() => localStorage.getItem('timmy.theme'))).toBe('glacier');
      expect(await page.locator('.st-theme-btn[aria-pressed="true"]').textContent()).toBe('Glacier');
      // Records: local; cloud sync off as the FAKE card says; the way to change it; the home behind Details, from ~
      expect(await page.locator('[data-st-card="records"] .st-line').allTextContents()).toEqual(['Local records: on this computer', 'Cloud sync (Cloudflare logs): off — local records are the design; nothing is sent.']);
      expect(await page.locator('[data-st="connections"]').textContent()).toBe('Change cloud sync in Models & accounts →');
      const details = page.locator('.page-records details.records');
      expect(await details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await details.locator('dd').first().textContent()).toBe(tildePath(home));
      // Account: the operator; no provider configured, the env names; Open account; no Sign out
      expect(await page.locator('[data-st="who"]').textContent()).toBe('This computer’s operator.');
      expect(await page.locator('[data-st-card="account"] .st-note').nth(1).textContent()).toBe('This computer\'s operator · no identity provider configured (CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY)');
      expect(await page.locator('[data-st="provider"]').textContent()).toBe('Identity provider: not configured.'); // the names are said once, above
      expect(await page.locator('[data-st="signout"]').isHidden()).toBe(true);
      await page.locator('[data-st="account"]').click();
      expect(await page.evaluate(() => (window as unknown as { __went: string[] }).__went.at(-1))).toBe('account:settings');
      // Done → Chat
      await page.locator('[data-st="primary"]').click();
      expect(await page.evaluate(() => (window as unknown as { __went: string[] }).__went.at(-1))).toBe('chat:settings-done');
      expect(await page.content()).not.toContain(LAUNCH);
      expect(errors).toEqual([]);
      expect(left).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('390x844: one column, nothing wider than the screen; the switches, the theme buttons and the dock reachable', async () => {
    if (!browser) return;
    const { page, errors } = await open(390, 844);
    try {
      const over = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(over.scroll, JSON.stringify(over)).toBeLessThanOrEqual(over.client);
      expect(await page.locator('.st-card').count()).toBe(4);
      const cards = await page.locator('.st-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
      for (const r of cards) expect(r).toBeLessThanOrEqual(390);
      await page.locator('[data-theme-pick="glacier"]').click();
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('glacier');
      expect(await page.locator('[data-st="reload"]').isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
