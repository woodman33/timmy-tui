/**
 * R11 round 7 (H169): the WORKFLOWS, RUNS & RECEIPTS and CONTROL ROOM pages in a real browser (Chromium through playwright,
 * headless) on the study's scaffold — section.page[data-page] with the .page-* regions SHELL CONTRACT v1 §2.2 names — against
 * the REAL page scripts (src/companion/client/panels.js, panel-run.js, panel-control.js, their two sheets) and the REAL routes
 * (src/companion/panels.ts mountPanels: GET /api/panel/workflows/docs, /api/panel/runs/list, /api/panel/control/room and
 * /panes) on a project folder made for the test, with ONE chat turn sealed by the REPL's own seal (a real signed receipt,
 * FIXTURE facts, no model asked) and one workflow document.
 * FAKE, and said: window.TimmyShell (this test's: the contract's surface — page/state/go/h/fetch), the launch token's check,
 * the WORKSPACE FRAME the room reads (a running FAKE job, a FAKE chat turn being answered, one thing waiting on you, three
 * fleet connections), the capability inventory's rows, and POST /api/chat/stop (records what the page sends; nothing runs).
 * Nothing leaves 127.0.0.1. Where no Chromium is found the browser checks are skipped, saying so.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountPanels } from '../src/companion/panels.js';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';

const CLIENT = resolve('src/companion/client');
const LAUNCH = randomBytes(32).toString('hex');
const MODEL = 'fake-qwen3:8b';
const TURN_ID = 't1-0000abcd';
const SINCE = '2026-10-24T21:00:00.000Z';
const GREEN = 'rgb(40, 254, 20)'; // --timmy-ui-verified #28FE14
const AMBER = 'rgb(255, 176, 0)'; // --timmy-ui-focus #FFB000

/** The FAKE workspace frame the room reads: a running FAKE job with its Stop current, a FAKE chat turn being answered, one thing waiting on you, the fleet's three connections. */
const FAKE_FRAME = {
  schema: 'timmy.workspace/1', revision: 7,
  project: { id: '', name: 'FAKE-project', root: '' },
  activity: { running: 1, waitingOnYou: 1, stopCurrent: { job: 'FAKE-job-1', words: 'Stop current: the FAKE job (Esc in the Workbench)' }, chatTurn: { id: TURN_ID, surface: 'workbench', since: SINCE, words: 'Timmy Workbench is answering a turn' } },
  actions: { control: [{ n: 1, label: 'Stop current', command: '/stop', effect: 'stops the running job', primary: true, enabled: true }] },
  connections: [
    { id: 'cloudroom', label: 'Cloudroom', state: 'unknown', words: 'FAKE: not checked from this companion', observedAt: null, setup: 'timmy cloudroom setup' },
    { id: 'clef', label: 'Clef', state: 'live', words: 'FAKE: observed live by this test\'s frame', observedAt: SINCE, setup: null },
    { id: 'cloudflare', label: 'Cloudflare', state: 'configured', words: 'FAKE: a gateway is named', observedAt: null, setup: null },
    { id: 'companion', label: 'Browser companion', state: 'live', words: 'this page', observedAt: SINCE, setup: null },
  ],
  tabs: [], log: [], chat: { turns: [] }, surfaces: {},
};

/** FAKE capability rows in the three words: a lane available only, an integration exercised. */
const FAKE_INVENTORY = { read: 'FAKE rows', inventory: { schema: 'timmy.capability-inventory/1', readAt: SINCE, means: { available: 'a', configured: 'b', exercised: 'c' }, groups: ['Lanes', 'Integrations'], rows: [
  { id: 'lane:fake', name: 'FAKE lane', group: 'Lanes', available: { ok: true, found: 'FAKE', source: 'FAKE', words: 'available: FAKE binary here' }, configured: { ok: false, found: 'no settings', source: 'FAKE', words: 'not configured: no settings' }, exercised: { ok: false, found: 'no receipt', source: 'FAKE', words: 'not exercised: no receipt of a run' }, next: 'Set it up in the terminal' },
  { id: 'integration:cloudflare', name: 'Cloudflare', group: 'Integrations', available: { ok: true, found: 'FAKE', source: 'FAKE', words: 'available' }, configured: { ok: true, found: 'FAKE', source: 'FAKE', words: 'configured: a FAKE gateway' }, exercised: { ok: true, receipt: 'sha256_00', hash: 'sha256_00', when: SINCE, what: 'FAKE', source: 'FAKE', words: 'exercised: FAKE receipt' } },
  { id: 'model:openrouter', name: 'OpenRouter', group: 'Models', available: { ok: true, found: '', source: '', words: '' }, configured: { ok: false, found: '', source: '', words: '' }, exercised: { ok: false, found: '', source: '', words: '' } },
] } };

/**
 * The FAKE shell of this test: SHELL CONTRACT v1's surface as the three pages consume it — h, fetch, go (hides every section
 * but the one), current, on, page(id, meta) (draws the head's kicker/title/intro/primary and the band's three cells + the
 * page's own cells, as §2.3 says the shell does; adds the dock's label and its .dock-stop slot), state(id, s, { words, next })
 * (moves data-state). TimmyPanels is the REAL registry (panels.js). What is REAL is what the pages do with them.
 */
const FAKE_SHELL = `(() => {
  'use strict';
  const token = (/#t=([0-9a-f]{64})/.exec(location.hash) || [])[1] || '';
  try { history.replaceState(null, '', location.pathname + (location.hash.replace(/#t=[0-9a-f]{64}/, '') || '')); } catch (e) {}
  const LEGACY = { workflows: 'workflows', logs: 'runs', runs: 'runs', control: 'control', chat: 'chat' };
  let current = null;
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach((f) => { try { f(d); } catch (e) { console.error('listener', e); } });
  window.__went = []; window.__states = []; window.__meta = {};
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
    go(id, why) { const page = LEGACY[id] || id; window.__went.push(page + ':' + (why || '')); current = page; for (const s of document.querySelectorAll('section.page')) s.hidden = s.dataset.page !== page; emit('page', { id: page, legacy: id, why }); },
    current: () => current,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    page(id, meta) {
      window.__meta[id] = meta;
      const sec = section(id); if (!sec) return;
      const head = sec.querySelector('.page-head');
      // (as shell.js: a registration without a primary falls back to the frame's primary action — a FAKE one here)
      const primary = meta.primary || { label: 'FAKE frame primary action', run() {} };
      const btn = h('button', { type: 'button', class: 'ui-primary', 'data-primary': id, disabled: !!primary.disabled, title: primary.why || null }, primary.label);
      btn.addEventListener('click', () => primary.run());
      head.replaceChildren(h('div', null, h('p', { class: 'page-kicker' }, meta.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, meta.title), h('p', { class: 'page-intro' }, meta.intro)), h('div', { class: 'page-primary' }, btn));
      const band = sec.querySelector('.page-band');
      const cells = [['Workspace', 'FAKE-project'], ['Model', 'not chosen'], ['Records', 'Local']].concat((meta.band || []).map((c) => [c.k, c.v]));
      const act = h('button', { type: 'button', class: 'band-action' }, primary.label); act.addEventListener('click', () => primary.run());
      band.replaceChildren(...cells.map(([k, v]) => h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, k), h('strong', { class: 'band-v' }, v))), act);
      const ctx = sec.querySelector('.page-context'); if (ctx) ctx.hidden = !meta.context;
      const dock = sec.querySelector('.page-dock'); if (dock && !dock.querySelector('.dock-label')) dock.prepend(h('span', { class: 'dock-label' }, meta.dock || (id.toUpperCase() + ' TOOLS')), h('span', { class: 'dock-stop' }));
    },
    state(id, s, o) { window.__states.push({ id, s, words: o && o.words, next: o && o.next && o.next.label }); const sec = section(id); if (sec) sec.dataset.state = s; },
    sheet() {},
    session: { get: () => '', user: () => null },
  };
  // the frame's words for the two tabs the frame marks unfinished (src/contracts/workspace.ts TabDef.unfinished; FAKE copies here)
  const UNF = { logs: ['FAKE: the receipt chain, checked in the Workbench', 'FAKE: replaying a run from here'], control: ['FAKE: this project’s jobs, chat turns and runs', 'FAKE: adding or removing harnesses'] };
  const FRAME = { revision: 7, tabs: Object.keys(UNF).map((id) => ({ id, unfinished: { works: UNF[id][0], missing: UNF[id][1] } })) };
  // as companion.js does on every frame (drawUnfinished): the Unfinished box PREPENDED to the section (the shell's sheet orders it
  // between the head and the band); then, as when a tab is shown, the panel drawn with the shown project (the REAL TimmyPanels)
  // (panels.js declares TimmyPanels as a top-level const: a global lexical binding, not a window property)
  window.__show = (tab, project) => {
    const sec = document.querySelector('section.page[data-ws-page="' + tab + '"]');
    if (sec && UNF[tab] && !sec.querySelector(':scope > .unfinished')) sec.prepend(h('section', { class: 'unfinished', 'data-unfinished': tab, role: 'note' }, h('h2', { class: 'unfinished-title' }, '◌ Unfinished · ' + tab), h('p', { class: 'unfinished-line' }, 'Works now: ' + UNF[tab][0]), h('p', { class: 'unfinished-line' }, 'Not yet: ' + UNF[tab][1])));
    window.TimmyShell.go(tab, 'test');
    return TimmyPanels.draw(tab, FRAME, { project, fetch: window.TimmyShell.fetch, own: true, h });
  };
})();
`;

/** The page: §2.2's scaffold for the three pages, the regions in order; the Workflows and Runs hosts NOT given (the scripts make them); no inline script. */
const PAGE = `<!doctype html><html lang="en" data-theme="amber"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell · H169's pages</title>
<style>:root{--timmy-ui-canvas:#080B0F;--timmy-ui-surface:#111A23;--timmy-ui-raised:#1C2936;--timmy-ui-paper:#E8EFF5;--timmy-ui-border:#44586B;--timmy-ui-border-quiet:#1E2A36;--timmy-ui-text:#ECF1F5;--timmy-ui-text-secondary:#BDCADA;--timmy-ui-text-muted:#9AAFC3;--timmy-ui-ink:#1C3043;--timmy-ui-ink-soft:#3B5168;--timmy-ui-focus:#FFB000;--timmy-ui-focus-halo:#080B0F;--timmy-ui-verified:#28FE14;--timmy-ui-verified-dim:#00D700;--timmy-ui-diff-remove:#FF5F56;--timmy-ui-accent:#D6AA64;--timmy-ui-accent-soft:#EAD0A3;--timmy-ui-accent-ink:#402E14;--timmy-ui-accent-start:#F0E5D4;--timmy-ui-accent-wash:rgba(214,170,100,.08);--timmy-ui-font:system-ui,sans-serif;--timmy-ui-font-mono:monospace;--timmy-ui-size-page:30px;--timmy-ui-size-section:18px;--timmy-ui-size-body:14px;--timmy-ui-size-label:13px;--timmy-ui-radius-control:10px;--timmy-ui-radius-panel:16px;--timmy-ui-elev-surface:#111A23;--timmy-ui-elev-raised:#1C2936;--timmy-ui-elev-primary:linear-gradient(120deg,#F0E5D4,#D6AA64)}
body{margin:0;background:var(--timmy-ui-canvas);color:var(--timmy-ui-text);font:14px/1.55 var(--timmy-ui-font)}main{max-width:1240px;margin:0 auto;padding:24px 32px;box-sizing:border-box}.page{display:flex;flex-direction:column;gap:18px}.page>.page-head{order:0}.page>.unfinished{order:1;border:1px dashed var(--timmy-ui-border);border-radius:10px;padding:6px 12px}.page>.page-band{order:2}.page>.page-body{order:3}.page>.page-dock{order:4}.page>.page-records{order:5}.page-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.page-kicker{font-size:13px;letter-spacing:.14em;color:var(--timmy-ui-accent);margin:0 0 6px}.page-title{margin:0 0 6px;font-size:30px}.page-intro{margin:0;color:var(--timmy-ui-text-secondary)}.page-band{display:flex;gap:24px;align-items:center;margin:0;padding:14px 18px;border:1px solid var(--timmy-ui-border);border-radius:16px;background:var(--timmy-ui-surface)}.band-k{display:block;font-size:13px;color:var(--timmy-ui-text-secondary)}.band-action{margin-left:auto;font:inherit;background:transparent;border:0;color:var(--timmy-ui-text);text-decoration:underline;cursor:pointer}.page-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px}.page-work{min-width:0}.page-context{min-width:0}.page-dock{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}.dock-label{font-size:13px;letter-spacing:.12em;color:var(--timmy-ui-text-secondary)}.ui-primary{font:inherit;cursor:pointer;border:1px solid var(--timmy-ui-accent);background:var(--timmy-ui-elev-primary);color:var(--timmy-ui-accent-ink);padding:10px 16px;border-radius:10px}.box{border:1px solid var(--timmy-ui-border-quiet);border-radius:16px;padding:12px;margin-top:12px}.empty{color:var(--timmy-ui-text-muted)}
@media (max-width:1320px){.page{gap:14px}}@media (max-width:720px){main{padding:16px}.page-head{flex-direction:column}.page-band{flex-wrap:wrap}.page-body{grid-template-columns:1fr}}</style>
<link rel="stylesheet" href="/panel-run.css"><link rel="stylesheet" href="/panel-control.css"></head><body>
<div id="project" data-project="__PROJECT__" hidden></div>
<main id="ws-main">
<section class="page ws-page" id="ws-workflows" data-page="workflows" data-ws-page="workflows" aria-label="Workflows" hidden>
  <header class="page-head"></header><div class="page-band"></div>
  <div class="page-body"><div class="page-work"><div class="cols cols-flow"><div class="box" id="flow-activity">FAKE: the frame's activity box</div></div><div id="tab-run" class="tab-panel"><div id="run-card" class="box"><div id="run-detail"></div></div></div></div><aside class="page-context" aria-label="The selected document" hidden></aside></div>
  <div class="page-dock"></div><div class="page-records"></div>
</section>
<section class="page ws-page" id="ws-logs" data-page="runs" data-ws-page="logs" aria-label="Runs &amp; receipts" hidden>
  <header class="page-head"></header><div class="page-band"></div>
  <div class="page-body"><div class="page-work"><div class="cols cols-logs"><div class="box"><div id="logs-list">FAKE socket log line</div></div><div class="box"><ul id="logs-events"></ul></div><div class="box"><div id="proof-latest">no receipt received yet</div></div></div></div><aside class="page-context" aria-label="The selected record" hidden></aside></div>
  <div class="page-dock"></div><div class="page-records"></div>
</section>
<section class="page ws-page" id="ws-control" data-page="control" data-ws-page="control" aria-label="Control Room" hidden>
  <header class="page-head"></header><div class="page-band"></div>
  <div class="page-body"><div class="page-work"><div class="cols cols-control"><div class="box"><div id="control-now" class="preview"><p class="empty">FAKE: companion.js draws the counts here</p></div></div><div class="control-host" data-panel-host="control"><p class="empty">Reading this project's panes…</p></div></div><section class="box" aria-labelledby="control-fleet-title"><h2 id="control-fleet-title">Fleet backend, decisions and the edge</h2><div class="conn-grid" data-conns-for="fleet"><p class="empty">FAKE: companion.js draws the frame's connection cards here</p></div></section></div><aside class="page-context" aria-label="The fleet" hidden></aside></div>
  <div class="page-dock"></div><div class="page-records"></div>
</section>
</main>
<script src="/fake-shell.js"></script>
<script src="/panels.js"></script>
<script src="/panel-control.js"></script>
<script src="/panel-run.js"></script>
</body></html>`;

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let project = '';
let pid = '';
let turnHash = '';
let browser: Browser | null = null;
let server: Server;
let base = '';
const stops: unknown[] = [];
const bad: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h169-pages-browser-'));
  project = join(root, 'FAKE-project');
  mkdirSync(join(project, '.timmy', 'receipts'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  writeFileSync(join(project, 'WORKFLOW.md'), '# FAKE workflow\n\n```bash [name:build]\necho build\n```\n\n```bash [name:check, deps:build]\necho check\n```\n');
  mkdirSync(join(root, 'home'), { recursive: true });
  mkdirSync(join(root, 'empty-path'), { recursive: true });
  writeFileSync(join(root, 'fake-shell.js'), FAKE_SHELL);
  pid = projectId(project);
  FAKE_FRAME.project = { id: pid, name: 'FAKE-project', root: project };
  const env: Record<string, string | undefined> = { TIMMY_HOME: join(root, 'home'), TIMMY_SETTINGS_DIR: join(root, 'settings'), PATH: join(root, 'empty-path'), HOME: root };
  // FIXTURE facts of one chat turn answered in the Workbench (no model asked), sealed as every surface seals one
  const turn = sealTurn({ prompt: 'FIXTURE prompt words, never shown', answer: 'FIXTURE answer', steps: 1, spend: 0, costMeasured: true, ms: 1234, status: 'ok', surface: 'workbench', model: MODEL, project: 'FAKE-project', projectId: pid, turnId: TURN_ID } as never, project);
  expect(turn.verified).toBe(true);
  turnHash = turn.hash;
  const app = express();
  const file = (name: string, type: string, dir = CLIENT): express.RequestHandler => (_req, res) => { res.setHeader('Content-Type', type); res.send(readFileSync(join(dir, name), 'utf8')); };
  app.get('/', (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(PAGE.replace('__PROJECT__', pid)); });
  app.get('/fake-shell.js', file('fake-shell.js', 'text/javascript; charset=utf-8', root));
  for (const f of ['panels.js', 'panel-run.js', 'panel-control.js']) app.get(`/${f}`, file(f, 'text/javascript; charset=utf-8'));
  for (const f of ['panel-run.css', 'panel-control.css']) app.get(`/${f}`, file(f, 'text/css; charset=utf-8'));
  const withToken: express.RequestHandler = (req, res, next) => { if ((req.get('authorization') ?? '') !== `Bearer ${LAUNCH}`) { res.status(401).json({ ok: false, error: 'FAKE withToken: the launch token is missing or wrong' }); return; } next(); };
  mountPanels(app, {
    withToken, projectFor: (req) => (req.query.project === 'unknown' ? null : { name: 'FAKE-project', root: project, chosen: true }), projectUnknown: 'This companion does not know that project.', env,
    frame: async () => FAKE_FRAME as unknown as WorkspaceFrame,
    inventory: async () => FAKE_INVENTORY as never,
  });
  // FAKE: what the real POST /api/chat/stop (src/companion/chat-run.ts) is asked; records the body, stops nothing
  app.post('/api/chat/stop', withToken, express.json({ limit: '1kb' }), (req, res) => { stops.push({ query: req.query, body: req.body }); res.json({ ok: true, words: 'FAKE: stop asked of the turn being answered in Timmy Workbench (nothing ran in this test).' }); });
  server = createServer(app);
  base = await listen(server);
  const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('companion-pages-h169-browser: no Chromium found, so the browser checks are skipped here');
  const browserEnv = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/proxy/i.test(k))) as Record<string, string>;
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, env: browserEnv, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  if (browser) await browser.close();
  await close(server);
  rmSync(root, { recursive: true, force: true });
});

interface Opened { context: BrowserContext; page: Page; errors: string[]; left: string[] }
async function open(width: number, height: number, hash = ''): Promise<Opened> {
  const context = await browser!.newContext({ viewport: { width, height }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors: string[] = [];
  const left: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // (the browser's own line for its favicon ask, a 404 the FAKE page answers: not the pages' doing; `bad` below keeps every other 4xx)
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: .* 404 /.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.protocol !== 'blob:' && u.hostname !== '127.0.0.1') left.push(r.url()); } catch { /* data: */ } });
  // (a favicon the FAKE page does not have is the browser's own ask, not the pages')
  page.on('response', (r) => { const path = new URL(r.url()).pathname; if (r.status() >= 400 && path !== '/favicon.ico') bad.push(`${r.status()} ${path}`); });
  await page.goto(`${base}/#t=${LAUNCH}${hash}`);
  return { context, page, errors, left };
}
const show = (page: Page, tab: string, id = pid) => page.evaluate(([t, p]) => (window as unknown as { __show(tab: string, project: string): boolean }).__show(t, p), [tab, id]);
const meta = (page: Page, id: string) => page.evaluate((i) => { const m = (window as unknown as { __meta: Record<string, { kicker: string; title: string; intro: string; context: string | null; dock: string; band: { k: string; v: string }[]; primary: { label: string } | null }> }).__meta[i]; return m ? { kicker: m.kicker, title: m.title, context: m.context, dock: m.dock, band: m.band, primary: m.primary ? m.primary.label : null } : null; }, id);
const lastState = (page: Page, id: string) => page.evaluate((i) => (window as unknown as { __states: { id: string; s: string; words?: string; next?: string }[] }).__states.filter((x) => x.id === i).at(-1), id);
const text = async (page: Page, selector: string): Promise<string> => ((await page.locator(selector).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
const colour = (page: Page, selector: string) => page.locator(selector).first().evaluate((e) => getComputedStyle(e).color);
/** every element with its own text inside `scope` computes to a font size of 13 px or more (the contract's floor) */
const smallText = (page: Page, scope: string) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} *`)].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())).map((e) => ({ tag: e.tagName, size: parseFloat(getComputedStyle(e).fontSize), words: (e.textContent ?? '').trim().slice(0, 30) })).filter((x) => x.size < 13), scope);

describe('H169\'s three pages in Chromium on the scaffold (FAKE shell and frame, said; the REAL scripts, sheets and routes)', () => {
  it('WORKFLOWS at 1440x900: the registration and the content state; the document with its two blocks (not run yet, the need); the runner absent → the primary copies timmy doctor; a document selected fills the context column; the block\'s run command copied, nothing run', async () => {
    if (!browser) return;
    const { context, page, errors, left } = await open(1440, 900);
    try {
      await show(page, 'workflows');
      await page.waitForSelector('#ws-workflows [data-panel-host="workflows"] .wf-doc', { timeout: 15_000 });
      // the host was made by the script inside .page-work (index.html gives none for this tab)
      expect(await page.locator('#ws-workflows .page-work > [data-panel-host="workflows"]').count()).toBe(1);
      expect(await meta(page, 'workflows')).toEqual({ kicker: '03 / RUN A WORKFLOW', title: 'Run the work the project describes.', context: null, dock: 'WORKFLOW TOOLS', band: [{ k: 'Workflows', v: '1 document · 0 running' }], primary: 'Copy: timmy doctor' });
      expect(await lastState(page, 'workflows')).toEqual({ id: 'workflows', s: 'content', words: undefined, next: undefined });
      expect(await page.locator('#ws-workflows').getAttribute('data-state')).toBe('content');
      expect(await text(page, '#ws-workflows .page-kicker')).toBe('03 / RUN A WORKFLOW');
      expect(await page.locator('#ws-workflows .band-cell .band-v').allTextContents()).toEqual(['FAKE-project', 'not chosen', 'Local', '1 document · 0 running']);
      // the document and its blocks, in the board's words
      expect(await text(page, '#ws-workflows .wf-doc-title')).toBe('FAKE workflow');
      expect(await text(page, '#ws-workflows .wf-doc-count')).toBe('2 blocks');
      expect(await page.locator('#ws-workflows .wf-block').evaluateAll((els) => els.map((e) => [e.getAttribute('data-wf-block'), e.getAttribute('data-word')]))).toEqual([['build', 'not run yet'], ['check', 'not run yet']]);
      expect(await text(page, '#ws-workflows .wf-block[data-wf-block="check"] .wf-needs')).toBe('needs build');
      expect(await page.locator('#ws-workflows .wf-block .is-verified, #ws-workflows .wf-block.is-ran').count()).toBe(0); // nothing ran: no green
      // the dock: the page's own tools after the shell's label, the runner's standing said
      expect(await page.locator('#ws-workflows .page-dock .dock-btn').allTextContents()).toEqual(['Read again', 'Runs & receipts']);
      expect(await text(page, '#ws-workflows .page-dock .dock-words')).toBe('Runner: upmd not found on this computer');
      // the records: closed, how it was read
      const records = page.locator('#ws-workflows .page-records details.records');
      expect(await records.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await text(page, '#ws-workflows .page-records details.records summary')).toBe('Records · how Workflows was read');
      expect(await text(page, '#ws-workflows .page-records details.records p')).toMatch(/^Read \d\d:\d\d:\d\d from the project's workflow documents, its job store and its receipts chain; nothing ran\. The runner \(upmd\) is not on this computer's PATH\.$/);
      // the context column fills when a document is picked; the registration says so
      expect(await page.locator('#ws-workflows .page-context').isHidden()).toBe(true);
      await page.locator('#ws-workflows [data-wf-pick="WORKFLOW.md"]').click();
      await page.waitForSelector('#ws-workflows .page-context [data-h169-context="workflows"]');
      expect((await meta(page, 'workflows'))?.context).toBe('selection');
      expect(await text(page, '#ws-workflows .page-context .ctx-title')).toBe('FAKE workflow');
      expect(await page.locator('#ws-workflows .page-context .ctx-facts dd').allTextContents()).toEqual(['WORKFLOW.md', '2 · 0 ran · 0 failed · 2 not run yet', 'build → check']);
      expect(await page.locator('#ws-workflows .wf-doc.is-selected').count()).toBe(1);
      // the block's run command, copied for the terminal (the clipboard granted to this test's page); nothing was sent
      await page.locator('#ws-workflows .wf-block[data-wf-block="check"] [data-wf-run]').click();
      await page.waitForFunction(() => /Copied|Could not copy/.test(document.querySelector('#ws-workflows [data-wf="said"]')?.textContent ?? ''));
      const said = await text(page, '#ws-workflows [data-wf="said"]');
      expect(said).toMatch(/^(Copied \/run WORKFLOW\.md check: paste it in the terminal \(the Workbench, or the REPL\)\. Nothing ran from this page\.|Could not copy .*; the command is \/run WORKFLOW\.md check\.)$/);
      if (said.startsWith('Copied')) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/run WORKFLOW.md check');
      // the primary: timmy doctor copied (the runner is not here); the Runs shortcut goes to the runs page through the shell
      await page.locator('#ws-workflows [data-primary="workflows"]').click();
      await page.waitForFunction(() => /timmy doctor/.test(document.querySelector('#ws-workflows [data-wf="said"]')?.textContent ?? ''));
      await page.locator('#ws-workflows .page-dock [data-wf-go="logs"]').click();
      expect(await page.evaluate(() => (window as unknown as { __went: string[] }).__went.at(-1))).toBe('runs:h169');
      expect(errors).toEqual([]);
      expect(left).toEqual([]);
      expect(stops).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('RUNS & RECEIPTS at 1440x900: the one sealed turn as a row (its line, model, time, ✓ verified in green only because the server verified it now, its Chat link); the records fold the old boxes in; a receipt link (the Chat\'s event, the hash) selects its row with the hash behind Details; an unknown one is said absent', async () => {
    if (!browser) return;
    const short = turnHash.slice(7, 15);
    const { context, page, errors, left } = await open(1440, 900, `#logs?receipt=${short}`);
    try {
      await show(page, 'logs');
      await page.waitForSelector('#ws-logs [data-panel-host="logs"] .rl-row', { timeout: 15_000 });
      expect(await meta(page, 'runs')).toEqual({ kicker: '04 / REVIEW WHAT RAN', title: 'Every run, and its receipt.', context: 'selection', dock: 'RECORD TOOLS', band: [{ k: 'Records', v: '1 run · 1 verified' }], primary: 'Open Workflows' });
      expect(await lastState(page, 'runs')).toEqual({ id: 'runs', s: 'content', words: undefined, next: undefined });
      // the row: newest first (one here), its facts, the receipt verified now
      const row = page.locator('#ws-logs .rl-row').first();
      expect(await row.getAttribute('data-kind')).toBe('turn');
      expect(await row.getAttribute('data-state')).toBe('answered');
      expect(await text(page, '#ws-logs .rl-row .rl-line')).toBe('Chat turn answered · Timmy Workbench (timmy workbench)');
      expect(await text(page, '#ws-logs .rl-row .rl-model')).toBe(MODEL);
      expect(await text(page, '#ws-logs .rl-row .rl-took')).toBe('1.2 s');
      expect(await text(page, '#ws-logs .rl-row .rl-receipt')).toBe(`✓ ${short} verified`);
      expect(await colour(page, '#ws-logs .rl-row .rl-receipt.is-verified')).toBe(GREEN);
      expect(await page.locator('#ws-logs .rl-row [data-rl-open]').count()).toBe(0); // no operation: no run detail to open
      expect(await page.locator('#ws-logs .rl-row [data-rl-chat]').getAttribute('data-rl-chat')).toBe(TURN_ID);
      // the link's record (location.hash on load) is selected: its facts in the context, the hash behind Details, closed
      expect(await row.evaluate((e) => e.classList.contains('is-selected'))).toBe(true);
      expect(await text(page, '#ws-logs .page-context .ctx-title')).toBe('Chat turn answered · Timmy Workbench (timmy workbench)');
      expect(await page.locator('#ws-logs .page-context .ctx-facts').first().locator('dd').allTextContents()).toEqual(['✓ answered', MODEL, '1.2 s', expect.stringMatching(/^\d\d:\d\d:\d\d$/), '✓ verified in this reading', 'Timmy Workbench (timmy workbench)']);
      const details = page.locator('#ws-logs .page-context details.ui-details');
      expect(await details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await details.locator('code').allTextContents()).toEqual([turnHash, TURN_ID]);
      // the old boxes are the page's records now, folded: the socket log is still in the DOM (its id kept) inside a closed details
      expect(await page.locator('#ws-logs .page-records details.records[data-h169-records="logs-boxes"] #logs-list').count()).toBe(1);
      expect(await page.locator('#ws-logs .page-records details.records[data-h169-records="logs-boxes"]').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await text(page, '#ws-logs .page-dock .dock-words')).toBe('1 of 1 receipts verified in this reading');
      // the Chat's event for a receipt not in this list: said in words, the selection kept
      await page.evaluate(() => document.dispatchEvent(new CustomEvent('timmy:open-receipt', { detail: { id: 'deadbeef', from: 'chat' } })));
      expect(await text(page, '#ws-logs [data-rl="said"]')).toBe('No record deadbeef in this list (1 shown of 1): timmy receipts lists every receipt of the project.');
      // a click on the row lets it go; the event with the full hash selects it again
      await page.locator('#ws-logs .rl-row .rl-pick').click();
      expect(await page.locator('#ws-logs .rl-row.is-selected').count()).toBe(0);
      expect(await page.locator('#ws-logs .page-context [data-h169-context="logs"]').count()).toBe(0);
      await page.evaluate((hash) => document.dispatchEvent(new CustomEvent('timmy:open-receipt', { detail: { id: hash, from: 'chat' } })), turnHash);
      expect(await page.locator('#ws-logs .rl-row.is-selected').count()).toBe(1);
      // Chat: the page goes there through the shell, telling it the turn
      const told = page.evaluate(() => new Promise((r) => window.addEventListener('timmy:chat-show-turn', (e) => r((e as CustomEvent).detail), { once: true })));
      await page.locator('#ws-logs .rl-row [data-rl-chat]').click();
      expect(await told).toEqual({ id: TURN_ID });
      expect(await page.evaluate(() => (window as unknown as { __went: string[] }).__went.at(-1))).toBe('chat:h169');
      expect(errors).toEqual([]);
      expect(left).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('CONTROL ROOM at 1440x900: the approval state (NEEDS YOU) while something waits, the running turn with Stop as the primary and in the dock\'s slot; Stop asks POST /api/chat/stop { turn }; the fleet in the three words (green only for exercised / live) and Fleet & Clef\'s connections in the context; the budget in the records; no button inside the panes', async () => {
    if (!browser) return;
    const { context, page, errors, left } = await open(1440, 900);
    try {
      await show(page, 'control');
      await page.waitForSelector('#ws-control [data-room="now"] [data-room-count="running"]', { timeout: 15_000 });
      await page.waitForSelector('#ws-control [data-panel-host="control"] [data-control="grid"] li', { timeout: 15_000 });
      expect(await meta(page, 'control')).toEqual({ kicker: '10 / KEEP WATCH', title: 'What runs now, and what it costs.', context: 'selection', dock: 'CONTROL TOOLS', band: [{ k: 'Fleet', v: '1 exercised · 0 configured · 1 available' }, { k: 'Budget', v: '$0.00 measured · 1 receipt' }], primary: 'Stop the turn' });
      expect(await lastState(page, 'control')).toEqual({ id: 'control', s: 'approval', words: '1 waiting on you.', next: 'Answer in Chat' });
      expect(await page.locator('#ws-control').getAttribute('data-state')).toBe('approval');
      // the now strip: the counts, NEEDS YOU in amber, the turn with its Stop, the job's stop command to copy
      expect(await text(page, '#ws-control [data-room-count="running"]')).toBe('1 running');
      expect(await text(page, '#ws-control [data-room-count="waiting"]')).toBe('NEEDS YOU · 1 waiting on you');
      expect(await colour(page, '#ws-control [data-room-count="waiting"]')).toBe(AMBER);
      expect(await text(page, '#ws-control [data-room="chat-turn"]')).toMatch(/^▶ Timmy Workbench is answering a turn · since \d\d:\d\d:\d\d Stop the turn$/);
      expect(await text(page, '#ws-control [data-room="job-stop"]')).toBe('Stop current: the FAKE job (Esc in the Workbench) Copy the stop command');
      // the dock: Stop in the shell's slot, then the page's tools
      expect(await page.locator('#ws-control .page-dock .dock-stop .dock-btn').textContent()).toBe('Stop the turn');
      expect(await page.locator('#ws-control .page-dock .dock-group .dock-btn').allTextContents()).toEqual(['Read again', 'Runs & receipts']);
      // nothing with a button inside the read-only panes (tests/companion-control-panel-browser pins the same)
      expect(await page.locator('#ws-control [data-panel-host="control"] button, #ws-control [data-panel-host="control"] [data-stop-turn]').count()).toBe(0);
      // the context: the fleet in the three words — exercised green, available quiet, none a word; then the frame's three connections (live green)
      expect(await page.locator('#ws-control .page-context .fleet-row[data-fleet]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-fleet'), e.getAttribute('data-word')]))).toEqual([['lane:fake', 'available'], ['integration:cloudflare', 'exercised']]);
      expect(await colour(page, '#ws-control .fleet-row[data-fleet="integration:cloudflare"] .fleet-word')).toBe(GREEN);
      expect(await colour(page, '#ws-control .fleet-row[data-fleet="lane:fake"] .fleet-word')).not.toBe(GREEN);
      expect(await page.locator('#ws-control .fleet-row[data-fleet="lane:fake"] .ctx-facts dd').allTextContents()).toEqual(['available: FAKE binary here', 'not configured: no settings', 'not exercised: no receipt of a run', 'Set it up in the terminal']);
      // Fleet & Clef's grid (index.html folds the box into this section; companion.js draws the frame's cards into it) is MOVED
      // into the context column, after the fleet; the room's own connection words are not drawn beside it (no duplicate)
      expect(await page.locator('#ws-control .page-context > section.box .conn-grid[data-conns-for="fleet"]').count()).toBe(1);
      expect(await page.locator('#ws-control .page-work [data-conns-for="fleet"]').count()).toBe(0);
      expect(await page.locator('#ws-control .page-context .fleet-row[data-conn]').count()).toBe(0);
      expect(await page.locator('#ws-control .page-context > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['ctx-box', 'box']);
      // the records: the budget's facts, no cap said plainly
      const rec = page.locator('#ws-control .page-records details.records[data-records-owner="control"]');
      expect(await rec.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await rec.locator('.budget-facts dd').allTextContents()).toEqual(['$0.00 across 1 receipt', 'off · from the settings', 'off · from the settings', 'none in this revision: OpenRouter\'s maxCost stops a request; it is not a guaranteed cap on billing']);
      // Stop: the primary asks POST /api/chat/stop { turn } for the shown project; the answer's words on the page; nothing else sent
      await page.locator('#ws-control [data-primary="control"]').click();
      await page.waitForFunction(() => /FAKE: stop asked/.test(document.querySelector('#ws-control [data-room="said"]')?.textContent ?? ''));
      expect(stops).toEqual([{ query: { project: pid }, body: { turn: TURN_ID } }]);
      // the job's stop command copied for the terminal, never run
      await page.locator('#ws-control [data-room="job-stop"] [data-room-copy]').click();
      await page.waitForFunction(() => /\/stop/.test(document.querySelector('#ws-control [data-room="said"]')?.textContent ?? ''));
      expect(stops).toHaveLength(1);
      // Answer in Chat is the state's next action; the band carries the primary too
      expect(await text(page, '#ws-control .band-action')).toBe('Stop the turn');
      expect(errors).toEqual([]);
      expect(left).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('390x844 (D5): the three pages fit the phone — no horizontal overflow, no text under 13 px in what the pages draw, the context column stacked under the work', async () => {
    if (!browser) return;
    const { context, page, errors } = await open(390, 844);
    try {
      for (const [tab, wait] of [['workflows', '#ws-workflows .wf-doc'], ['logs', '#ws-logs .rl-row'], ['control', '#ws-control [data-room-count="running"]']] as const) {
        await show(page, tab);
        await page.waitForSelector(wait, { timeout: 15_000 });
      }
      await show(page, 'workflows');
      await page.locator('#ws-workflows [data-wf-pick="WORKFLOW.md"]').click();
      await page.waitForSelector('#ws-workflows .page-context [data-h169-context="workflows"]');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await smallText(page, '#ws-workflows')).toEqual([]);
      await show(page, 'logs');
      await page.locator('#ws-logs .rl-row .rl-pick').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await smallText(page, '#ws-logs')).toEqual([]);
      // the row's facts stack (one column) and the context comes under the work
      const stacked = await page.evaluate(() => { const r = document.querySelector('#ws-logs .rl-row .rl-line')!.getBoundingClientRect(); const m = document.querySelector('#ws-logs .rl-row .rl-model')!.getBoundingClientRect(); const w = document.querySelector('#ws-logs .page-work')!.getBoundingClientRect(); const c = document.querySelector('#ws-logs .page-context')!.getBoundingClientRect(); return { factsStack: m.top >= r.bottom - 1, contextUnder: c.top >= w.bottom - 1 }; });
      expect(stacked).toEqual({ factsStack: true, contextUnder: true });
      await show(page, 'control');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await smallText(page, '#ws-control [data-room="now"], #ws-control .page-context, #ws-control .page-dock')).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);

  it('D23 (H168 R106): nothing between the head and the band on Runs & receipts and the Control Room — the frame\'s Unfinished box moves into the records (a details open by default), the band sits within the scaffold\'s gap of the head at 1440 and 390', async () => {
    if (!browser) return;
    for (const [width, height, gap] of [[1440, 900, 18], [390, 844, 14]] as const) {
      const { context, page, errors } = await open(width, height);
      try {
        for (const [tab, section, wait] of [['logs', '#ws-logs', '#ws-logs .rl-row'], ['control', '#ws-control', '#ws-control [data-room-count="running"]']] as const) {
          await show(page, tab);
          await page.waitForSelector(wait, { timeout: 15_000 });
          // the box left the section's top level; it is in the records, open, whole
          expect(await page.locator(`${section} > .unfinished`).count(), `${tab} ${width}: no box between the head and the band`).toBe(0);
          const folded = page.locator(`${section} > .page-records > details.records[data-h169-records="unfinished"], ${section} > .page-records > details.records[data-records-owner="unfinished"]`);
          expect(await folded.count(), `${tab} ${width}: the box in the records`).toBe(1);
          expect(await folded.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
          expect(await folded.locator('.unfinished .unfinished-line').allTextContents()).toEqual([`Works now: FAKE: ${tab === 'logs' ? 'the receipt chain, checked in the Workbench' : 'this project’s jobs, chat turns and runs'}`, `Not yet: FAKE: ${tab === 'logs' ? 'replaying a run from here' : 'adding or removing harnesses'}`]);
          expect(await folded.locator('.unfinished').count()).toBe(1); // one box, however many frames prepended one
          // head → band → body: the band's top within the page's gap of the head's bottom, the body under the band
          const y = await page.evaluate((sel) => { const r = (q: string) => document.querySelector(`${sel} > ${q}`)!.getBoundingClientRect(); const head = r('.page-head'); const band = r('.page-band'); const body = r('.page-body'); return { headBottom: head.bottom, bandTop: band.top, bandBottom: band.bottom, bodyTop: body.top }; }, section);
          expect(y.bandTop, `${tab} ${width}: the band right under the head`).toBeLessThanOrEqual(y.headBottom + gap + 1);
          expect(y.bandTop).toBeGreaterThanOrEqual(y.headBottom - 1);
          expect(y.bodyTop).toBeGreaterThanOrEqual(y.bandBottom - 1);
          // a second frame (companion.js prepends the box again): still one box, in the records
          await show(page, tab);
          expect(await page.locator(`${section} > .unfinished`).count()).toBe(0);
          expect(await folded.locator('.unfinished').count()).toBe(1);
        }
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  }, 90_000);

  it('every request the pages made was answered without a 4xx or 5xx, and nothing left 127.0.0.1', () => {
    expect(bad).toEqual([]);
  });
});
