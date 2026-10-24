/**
 * R11 round 7 (H173): the FILES page in a real browser (Chromium through playwright, headless) on the study's scaffold
 * (section.page[data-page="files"] with its .page-* regions; H175's SHELL CONTRACT names the same regions), against the REAL
 * routes (src/companion/workspace.ts mountFiles through src/companion/identity/routes.ts mountIdentity) on a project folder
 * made for the test. The identity provider is NOT configured here, so the launch token's holder is the operator (the lead's
 * ruling of 2026-10-23 21:48) and the project is the fixed one (TIMMY_REPO): the same path the operator's Mac takes without
 * Clerk. FAKE: window.TimmyShell (this test's, the shell's surface), the launch token's check (Bearer <this test's token>).
 * Nothing leaves 127.0.0.1. Where no Chromium is found the browser checks are skipped, saying so.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountIdentity } from '../src/companion/identity/routes.js';
import { projectId } from '../src/project/index.js';
import { tildePath } from '../src/utils/home-scrub.js';

const CLIENT = resolve('src/companion/client');
const LAUNCH = randomBytes(32).toString('hex');
// a 1×1 transparent PNG (70 bytes): a real image the page shows
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * The FAKE shell of this test: SHELL CONTRACT v1's surface as this page consumes it — h, fetch, go, current, toast, on,
 * page(id, meta) (draws the head's kicker/title/intro/primary and the band's three cells + the page's own cells, as §2.3
 * says the shell does), state(id, s, { words, next }), sheet(name, open) — and a FAKE TimmyPanels (register/has/draw) that
 * companion.js drives in the product (draw on show and on a frame). What is REAL is what the page does with them.
 */
const FAKE_SHELL = `(() => {
  'use strict';
  const token = (/#t=([0-9a-f]{64})/.exec(location.hash) || [])[1] || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  let current = 'files';
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach((f) => { try { f(d); } catch (e) { console.error('listener', e); } });
  window.__went = []; window.__toasts = []; window.__attach = []; window.__states = []; window.__sheets = []; window.__meta = null;
  window.addEventListener('timmy:attach', (ev) => { window.__attach.push(ev.detail); });
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
    toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    page(id, meta) {
      window.__meta = meta;
      const sec = section(id); if (!sec) return;
      const head = sec.querySelector('.page-head');
      const btn = h('button', { type: 'button', class: 'ui-primary', 'data-fs': 'primary', disabled: !!meta.primary.disabled, title: meta.primary.why || null }, meta.primary.label, h('span', { 'aria-hidden': 'true' }, ' →'));
      btn.addEventListener('click', () => meta.primary.run());
      head.replaceChildren(h('div', null, h('p', { class: 'page-kicker' }, meta.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, meta.title), h('p', { class: 'page-intro' }, meta.intro)), h('div', { class: 'page-primary' }, btn));
      const band = sec.querySelector('.page-band');
      const cells = [['Workspace', 'studio-project'], ['Model', 'not chosen'], ['Records', 'Local']].concat((meta.band || []).map((c) => [c.k, c.v]));
      const act = h('button', { type: 'button', class: 'band-action' }, meta.primary.label); act.addEventListener('click', () => meta.primary.run());
      band.replaceChildren(...cells.map(([k, v]) => h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, k), h('strong', { class: 'band-v' }, v))), act);
      const dock = sec.querySelector('.page-dock'); if (dock && !dock.querySelector('.dock-label')) dock.prepend(h('span', { class: 'dock-label' }, meta.dock || (id.toUpperCase() + ' TOOLS')));
    },
    state(id, s, o) { window.__states.push({ id, s, words: o && o.words, next: o && o.next && o.next.label }); const sec = section(id); if (sec) sec.dataset.state = s; },
    sheet(name, open) { window.__sheets.push({ name, open }); const sec = section(current); const ctx = sec && sec.querySelector('.page-context'); if (ctx && name === 'context') ctx.classList.toggle('is-open', open !== false); },
    session: { get: () => '', user: () => null },
  };
  const panels = new Map();
  window.TimmyPanels = {
    register(tab, panel) { panels.set(tab, panel); },
    has: (tab) => panels.has(tab),
    draw(tab, frame, ctx) { const p = panels.get(tab); const host = document.querySelector('[data-panel-host="' + tab + '"]'); if (!p || !host) return false; p.draw(host, frame, Object.assign({ h }, ctx)); return true; },
  };
  // as companion.js does when the page is shown: the panel drawn with the shown project
  window.__showFiles = (project) => { window.TimmyShell.go('files', 'test'); window.TimmyPanels.draw('files', { revision: 'FAKE' }, { project, fetch: window.TimmyShell.fetch, own: true }); };
})();
`;

/** The page: SHELL CONTRACT v1 §2's scaffold for the Files page, the regions in order (the shell's markup); no inline script. */
const PAGE = `<!doctype html><html lang="en" data-theme="amber"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell · files</title>
<style>:root{--timmy-ui-canvas:#080B0F;--timmy-ui-surface:#111A23;--timmy-ui-raised:#1C2936;--timmy-ui-paper:#E8EFF5;--timmy-ui-border:#44586B;--timmy-ui-border-quiet:#1E2A36;--timmy-ui-text:#ECF1F5;--timmy-ui-text-secondary:#BDCADA;--timmy-ui-text-muted:#9AAFC3;--timmy-ui-ink:#1C3043;--timmy-ui-ink-soft:#3B5168;--timmy-ui-focus:#FFB000;--timmy-ui-focus-halo:#080B0F;--timmy-ui-accent:#D6AA64;--timmy-ui-accent-ink:#402E14;--timmy-ui-accent-start:#F0E5D4;--timmy-ui-font:system-ui,sans-serif;--timmy-ui-font-mono:monospace;--timmy-ui-size-page:30px;--timmy-ui-size-section:18px;--timmy-ui-size-body:14px;--timmy-ui-size-label:13px;--timmy-ui-radius-control:10px;--timmy-ui-radius-panel:16px;--timmy-ui-elev-primary:linear-gradient(120deg,#F0E5D4,#D6AA64)}
body{margin:0;background:var(--timmy-ui-canvas);color:var(--timmy-ui-text);font:14px/1.55 var(--timmy-ui-font)}main{max-width:1240px;margin:0 auto;padding:24px 32px;box-sizing:border-box}.page-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.page-kicker{font-size:13px;letter-spacing:.14em;color:var(--timmy-ui-accent);margin:0 0 6px}.page-title{margin:0 0 6px;font-size:30px}.page-intro{margin:0;color:var(--timmy-ui-text-secondary)}.page-band{display:flex;gap:24px;align-items:center;margin:16px 0;padding:14px 18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.band-k{display:block;font-size:13px;color:var(--timmy-ui-text-secondary)}.band-action{margin-left:auto;font:inherit;background:transparent;border:0;color:var(--timmy-ui-text);text-decoration:underline;cursor:pointer}.page-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}.page-work{min-width:0}.page-context{min-width:0;padding:18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.page-dock{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}.dock-label{font-size:13px;letter-spacing:.12em;color:var(--timmy-ui-text-secondary)}.dock-group{display:contents}.ui-primary{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-accent);background:var(--timmy-ui-elev-primary);color:var(--timmy-ui-accent-ink);padding:10px 16px;border-radius:10px}.sh-btn,.sh-btn-text,.dock-btn{font:inherit;cursor:pointer}.sh-btn,.dock-btn{border:1px solid var(--timmy-ui-border);background:transparent;color:var(--timmy-ui-text);padding:8px 14px;border-radius:10px}.sh-btn:disabled,.dock-btn:disabled{opacity:.5;cursor:default}.sh-btn-text{border:0;background:transparent;color:var(--timmy-ui-text);text-decoration:underline}
@media (max-width:720px){main{padding:16px}.page-head{flex-direction:column}.page-band{flex-wrap:wrap}.page-body{grid-template-columns:1fr}.page-context{position:fixed;left:0;right:0;bottom:0;max-height:70vh;overflow:auto;transform:translateY(110%);transition:none}.page-context.is-open{transform:none}}</style>
<link rel="stylesheet" href="/panel-files.css"></head><body>
<div id="project" data-project="__PROJECT__" hidden></div>
<main id="ws-main">
<section class="page ws-page" id="ws-files" data-page="files" data-ws-page="files" aria-label="Files">
  <header class="page-head"></header>
  <div class="page-band"></div>
  <div class="page-body"><div class="page-work"><div data-panel-host="files"></div></div><aside class="page-context" aria-label="The selected file"></aside></div>
  <div class="page-dock"></div>
  <div class="page-records"></div>
</section>
</main>
<script src="/fake-shell.js"></script>
<script src="/panel-files.js"></script>
</body></html>`;

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let project = '';
let browser: Browser | null = null;
let companion: Server;
let base = '';
let pid = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h173-files-browser-'));
  project = join(root, 'studio-project'); mkdirSync(project);
  mkdirSync(join(project, 'notes')); mkdirSync(join(project, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(project, 'empty'));
  writeFileSync(join(project, 'README.md'), '# A FAKE project\n\nMade by the test.\n');
  writeFileSync(join(project, 'notes', 'plan.txt'), 'first\nsecond\nthird\n');
  writeFileSync(join(project, 'mark.png'), PNG);
  writeFileSync(join(project, 'data.bin'), Buffer.from([0, 1, 2, 0xff, 0, 7, 8, 9]));
  writeFileSync(join(root, 'fake-shell.js'), FAKE_SHELL);
  pid = projectId(project);
  const env = { TIMMY_HOME: join(root, 'home'), TIMMY_REPO: project }; // no CLERK_*: the operator; the fixed project
  const app = express();
  const page = (res: express.Response) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(PAGE.replace('__PROJECT__', pid)); };
  const file = (name: string, type: string, dir = CLIENT): express.RequestHandler => (_req, res) => { res.setHeader('Content-Type', type); res.send(readFileSync(join(dir, name), 'utf8')); };
  app.get('/', (_req, res) => page(res));
  app.get('/fake-shell.js', file('fake-shell.js', 'text/javascript; charset=utf-8', root));
  app.get('/panel-files.js', file('panel-files.js', 'text/javascript; charset=utf-8'));
  app.get('/panel-files.css', file('panel-files.css', 'text/css; charset=utf-8'));
  const withToken: express.RequestHandler = (req, res, next) => { if ((req.get('authorization') ?? '') !== `Bearer ${LAUNCH}`) { res.status(401).json({ ok: false, error: 'FAKE withToken: the launch token is missing or wrong' }); return; } next(); };
  mountIdentity(app, { withToken, json: express.json({ limit: '16kb' }), env, sendPage: (res) => page(res), clerkDir: join(root, 'no-clerk') });
  companion = createServer(app);
  base = await listen(companion);
  const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('companion-files-browser: no Chromium found, so the browser checks are skipped here');
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
  await close(companion);
  rmSync(root, { recursive: true, force: true });
});

interface Opened { page: Page; errors: string[]; left: string[] }
async function open(width: number, height: number): Promise<Opened> {
  const page = await browser!.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the browser's own line for a request the companion refused in words (a 404 for a project of nobody's, a 415 for a binary) is the page's doing, said on the page
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: .* (404|415) /.test(m.text())) errors.push(m.text()); });
  // what leaves 127.0.0.1 (a blob: of this origin — the image shown — is the page's own)
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.protocol !== 'blob:' && u.hostname !== '127.0.0.1') left.push(r.url()); } catch { /* data: */ } });
  await page.goto(`${base}/#t=${LAUNCH}`);
  await page.evaluate((id) => (window as unknown as { __showFiles(p: string): void }).__showFiles(id), pid);
  await page.waitForFunction(() => (window as unknown as { timmyFiles?: { state(): { state: string } } }).timmyFiles?.state().state === 'content', null, { timeout: 15_000 });
  return { page, errors, left };
}
const state = (page: Page) => page.evaluate(() => (window as unknown as { timmyFiles: { state(): { state: string; path: string; project: string; count: number | null; selected: string | null; opened: string | null; error: string } } }).timmyFiles.state());
const rows = (page: Page) => page.locator('.fs-row').evaluateAll((els) => els.map((e) => `${e.className.replace(/\s*is-selected/, '').split(' ').filter((c) => c.startsWith('fs-row-') || c.startsWith('is-')).join(' ')}|${e.querySelector('.fs-row-name')?.textContent}`));

describe('the Files page in Chromium (FAKE shell on the scaffold, the real routes, the operator\'s fixed project)', () => {
  it('1440x900: the words; the listing in order with kinds and sizes; a folder opens (crumbs, Up); a text and an image open beside; a binary says so; Attach hands { project, path } to Chat; Details and "where this project lives" carry the paths', async () => {
    if (!browser) return;
    const { page, errors, left } = await open(1440, 900);
    try {
      expect(await page.locator('.page-kicker').textContent()).toBe('02 / OPEN THE PROJECT’S FILES');
      expect(await page.locator('.page-title').textContent()).toBe('Everything this project holds.');
      expect(await page.locator('.page-intro').textContent()).toBe('Browse the project’s folder, open a text or an image beside it, and hand a file to the conversation.');
      expect(await page.locator('[data-fs="primary"]').textContent()).toBe('Open Chat →');
      // the head and the band are the shell's, from the registration (FAKE here): the page's own Files cell beside the three
      expect(await page.locator('.band-cell .band-v').allTextContents()).toEqual(['studio-project', 'not chosen', 'Local', '6 items']);
      expect(await page.locator('.band-action').textContent()).toBe('Open Chat');
      expect(await page.locator('.dock-label').textContent()).toBe('FILE TOOLS');
      const meta = await page.evaluate(() => (window as unknown as { __meta: { kicker: string; context: string; dock: string; band: { k: string; v: string }[] } }).__meta);
      expect(meta).toMatchObject({ kicker: '02 / OPEN THE PROJECT’S FILES', context: 'selection', dock: 'FILE TOOLS', band: [{ k: 'Files', v: '6 items' }] });
      expect(await page.evaluate(() => (window as unknown as { __states: { id: string; s: string }[] }).__states.at(-1))).toEqual({ id: 'files', s: 'content', words: undefined, next: undefined });
      expect(await rows(page)).toEqual(['fs-row-dir|empty', 'fs-row-dir|node_modules', 'fs-row-dir|notes', 'fs-row-file is-binary|data.bin', 'fs-row-file is-image|mark.png', 'fs-row-file is-text|README.md']);
      expect(await page.locator('.fs-row-kind').allTextContents()).toEqual(['Folder', 'Folder · large', 'Folder', 'File', 'Image', 'Text']);
      expect(await page.locator('.fs-row-size').allTextContents()).toEqual(['', '', '', '8 B', '70 B', '36 B']);
      expect(await page.locator('.fs-crumb').allTextContents()).toEqual(['studio-project']);
      expect(await page.locator('[data-fs="up"]').isDisabled()).toBe(true);
      expect(await page.locator('.fs-ctx-title').textContent()).toBe('Open a file to see it here.');
      // a folder: the crumbs, its one file, Up back to the root
      await page.getByRole('button', { name: /^notes/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { path: string; state: string } } }).timmyFiles.state().path === 'notes' && (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'content');
      expect(await page.locator('.fs-crumb').allTextContents()).toEqual(['studio-project', 'notes']);
      expect(await rows(page)).toEqual(['fs-row-file is-text|plan.txt']);
      expect(await page.locator('.band-cell .band-v').nth(3).textContent()).toBe('1 item in notes');
      // the text opened beside: its lines, the primary action becomes Attach, Details carries the path
      await page.getByRole('button', { name: /^plan\.txt/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { opened: string | null } } }).timmyFiles.state().opened === 'text');
      expect(await page.locator('.fs-ctx-title').textContent()).toBe('plan.txt');
      expect(await page.locator('.fs-text').textContent()).toBe('first\nsecond\nthird\n');
      expect(await page.locator('[data-fs="primary"]').textContent()).toBe('Attach to Chat →');
      expect(await page.locator('.fs-row.is-selected .fs-row-name').textContent()).toBe('plan.txt');
      expect(await page.locator('.fs-details .fs-dl dd').first().textContent()).toBe('notes/plan.txt');
      expect(await page.locator('.fs-details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false); // the path stays behind Details
      // Attach: the event's detail, the toast, Chat opened
      await page.locator('[data-fs="attach"]').click();
      const attached = await page.evaluate(() => { const w = window as unknown as { __attach: unknown[]; __toasts: { words: string }[]; __went: string[] }; return { attach: w.__attach, toast: w.__toasts[w.__toasts.length - 1], went: w.__went[w.__went.length - 1] }; });
      expect(attached.attach).toEqual([{ project: pid, path: 'notes/plan.txt', name: 'plan.txt', size: 19, view: 'text' }]);
      expect(attached.toast).toEqual({ words: 'plan.txt goes with your next turn.', live: false });
      expect(attached.went).toBe('chat:attach');
      // Up: the root again, the selection let go
      await page.locator('[data-fs="up"]').click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { path: string; state: string } } }).timmyFiles.state().path === '' && (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'content');
      expect((await state(page)).selected).toBeNull();
      // the image: shown from a blob of this origin, with its real size
      await page.getByRole('button', { name: /^mark\.png/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { opened: string | null } } }).timmyFiles.state().opened === 'image');
      const img = page.locator('.fs-image');
      expect(await img.getAttribute('src')).toMatch(/^blob:http:\/\/127\.0\.0\.1:/);
      await page.waitForFunction(() => (document.querySelector('.fs-image') as HTMLImageElement)?.naturalWidth === 1);
      expect(await page.locator('.fs-figure figcaption').textContent()).toBe('mark.png · 70 B');
      // the binary: said, not guessed at
      await page.getByRole('button', { name: /^data\.bin/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { opened: string | null } } }).timmyFiles.state().opened === 'refused');
      expect(await page.locator('.fs-refused').textContent()).toContain('neither text nor an image');
      expect(await page.locator('[data-fs="attach"]').isDisabled()).toBe(false); // a tool of a turn can still read it
      // the empty folder: its words and the way up
      await page.getByRole('button', { name: /^empty/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'empty');
      expect(await page.locator('.fs-state-title').textContent()).toBe('This folder is empty.');
      expect(await page.evaluate(() => (window as unknown as { __states: { s: string; words: string; next: string }[] }).__states.at(-1))).toEqual({ id: 'files', s: 'empty', words: 'This folder is empty.', next: 'Up one folder' });
      expect(await page.locator('section.page[data-page="files"]').getAttribute('data-state')).toBe('empty');
      await page.locator('[data-fs="empty-up"]').click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string; path: string } } }).timmyFiles.state().state === 'content');
      // where this project lives: the page's records, a closed <details class="records">, from ~ where a home folder is one
      const records = page.locator('.page-records details.records');
      expect(await records.locator('summary').textContent()).toBe('Where this project lives');
      expect(await records.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      await records.locator('summary').click();
      expect(await records.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
      expect(await records.locator('dd').first().textContent()).toBe(tildePath(project));
      expect(await records.locator('dd').nth(1).textContent()).toBe(tildePath(join(root, 'home')));
      expect(errors).toEqual([]);
      expect(left).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('an unknown project → the error state with its words and Retry; a refresh keeps the folder', async () => {
    if (!browser) return;
    const { page, errors } = await open(1440, 900);
    try {
      await page.evaluate(() => (window as unknown as { __showFiles(p: string): void }).__showFiles('0123456789abcdef'));
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'error');
      expect(await page.locator('.fs-error .fs-note').textContent()).toContain('not one of this account');
      expect(await page.locator('.band-cell .band-v').nth(3).textContent()).toBe('not read');
      expect(await page.evaluate(() => (window as unknown as { __states: { s: string; next: string }[] }).__states.at(-1))).toMatchObject({ s: 'error', next: 'Retry' });
      await page.locator('[data-fs="retry"]').click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'error'); // the same project is asked until the page is shown with another
      await page.evaluate((id) => (window as unknown as { __showFiles(p: string): void }).__showFiles(id), pid);
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string } } }).timmyFiles.state().state === 'content');
      expect(await page.locator('[data-fs="refresh"]').isEnabled()).toBe(true);
      await page.locator('[data-fs="refresh"]').click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { state: string; count: number | null } } }).timmyFiles.state().count === 6);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it('390x844: one column, nothing wider than the screen; the rows keep the name and the size; the file opens and the dock stays reachable', async () => {
    if (!browser) return;
    const { page, errors } = await open(390, 844);
    try {
      const over = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(over.scroll, JSON.stringify(over)).toBeLessThanOrEqual(over.client);
      expect(await page.locator('.fs-row-kind').first().isVisible()).toBe(false);
      expect(await page.locator('.fs-row-size').nth(5).textContent()).toBe('36 B');
      await page.getByRole('button', { name: /^README\.md/ }).click();
      await page.waitForFunction(() => (window as unknown as { timmyFiles: { state(): { opened: string | null } } }).timmyFiles.state().opened === 'text');
      expect(await page.locator('.fs-text').textContent()).toBe('# A FAKE project\n\nMade by the test.\n');
      // on a phone the selected file is the context SHEET, opened by the page for the person (the shell's sheet rules close it)
      expect(await page.evaluate(() => (window as unknown as { __sheets: { name: string; open: boolean }[] }).__sheets.at(-1))).toEqual({ name: 'context', open: true });
      expect(await page.locator('.page-context').evaluate((el) => el.classList.contains('is-open'))).toBe(true);
      const dock = await page.locator('.page-dock').boundingBox();
      expect(dock!.x + dock!.width).toBeLessThanOrEqual(390);
      expect(await page.locator('[data-fs="dock-attach"]').isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
