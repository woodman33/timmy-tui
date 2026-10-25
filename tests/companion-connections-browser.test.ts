/**
 * R11 round 4 (H170; contract C2): the Connections screen in a real browser (Chromium through playwright, headless) against
 * the real routes (src/companion/connections.ts) and FAKE providers on 127.0.0.1 — a FAKE local Ollama whose pull streams
 * and stops when the client goes away, a FAKE ollama.com — with a FAKE shell of this test standing in for H171's
 * window.TimmyShell (the same mount/fetch/h/go/land/toast surface; a header names the FAKE user, as the FAKE withUser of
 * the route test reads it: C1's real verification is H173's). Nothing is asked of openrouter.ai, ollama.com or Cloudflare:
 * the browser resolves no host but 127.0.0.1. Where no Chromium is found the browser checks are skipped, saying so.
 * R11 round 6: a FAKE TimmyRive (H174's 06:37 contract surface, below) records what the screen asks of the module — the
 * ProviderCard mounted once per card, in a host of the card's width above the state word; the feed one line per state change
 * with the backend's event as its source; the unmount on a redraw — and a bare page (no TimmyRive) draws the same words.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountConnections, type ConnectionsUser } from '../src/companion/connections.js';
import { refuseRequest } from '../src/utils/local-request.js';

const CLIENT = resolve('src/companion/client');
const FAKE_KEY = `FAKE-ollama-cloud-key-${randomBytes(8).toString('hex')}`;

/** FAKE local Ollama (as the route test's): version, tags, ps, show; a pull that streams in steps, stalling when asked. */
function fakeOllama() {
  const installed = new Set<string>(['fake-qwen3:8b']);
  const seen: string[] = [];
  let stall = false;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(`${req.method} ${u.pathname}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && u.pathname === '/api/version') return json(200, { version: '0.0.0-FAKE' });
    if (req.method === 'GET' && u.pathname === '/api/tags') return json(200, { models: [...installed].map((name) => ({ name, model: name, size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } })) });
    if (req.method === 'GET' && u.pathname === '/api/ps') return json(200, { models: [] });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) as { model?: string } : {};
      if (req.method === 'POST' && u.pathname === '/api/show') {
        if (!j.model || !installed.has(j.model)) return json(404, { error: 'model not found' });
        return json(200, { size: 5_200_000_000, capabilities: ['completion', 'tools'], details: { format: 'gguf', parameter_size: '8B', quantization_level: 'Q4_K_M' }, model_info: { 'qwen3.context_length': 40960 } });
      }
      if (req.method === 'POST' && u.pathname === '/api/pull') {
        const model = j.model ?? '';
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
        line({ status: 'pulling manifest' });
        let done = 0;
        const TOTAL = 4_000_000;
        const step = () => {
          if (res.destroyed) return;
          done = Math.min(TOTAL, done + 1_000_000);
          line({ status: 'pulling FAKE-layer', digest: 'sha256:FAKE', total: TOTAL, completed: done });
          if (stall && done >= 2_000_000) return;
          if (done < TOTAL) { setTimeout(step, 60); return; }
          line({ status: 'success' });
          installed.add(model); res.end();
        };
        setTimeout(step, 60);
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, installed, seen, setStall: (s: boolean) => { stall = s; } };
}

/** FAKE ollama.com: GET /api/tags with the key it knows. */
function fakeOllamaCom() {
  const server: Server = createServer((req, res) => {
    const k = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.method === 'GET' && req.url === '/api/tags' && k === FAKE_KEY) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[{"name":"fake-cloud-model-a"}]}'); return; }
    res.writeHead(401); res.end('{"error":"unauthorized"}');
  });
  return { server };
}

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });
/**
 * H168's R102 (the lead's D22): the word "null" stood under the context sheet — replaceChildren writes a null argument as text. Every
 * text node of the page whose trimmed words are exactly "null" or "undefined", with its parent's class: the pin is an empty list.
 */
const strayWords = (page: import('playwright').Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walk.nextNode())) { const t = (n.textContent ?? '').trim(); if (t === 'null' || t === 'undefined') out.push(`${n.parentElement?.className ?? '(no parent)'}: ${t}`); }
  return out;
});
/**
 * D24 (the lead's 00:47): with no route ready the page has exactly ONE accent-filled control — the head's primary (the amber-fit read: a
 * solid fill of the family accent, or a gradient ending on it) — and the recommended card's verb carries the accent as its RING, the
 * .sh-btn look (the head's "Set up a model" selects that card and focuses that verb: one action, one fill).
 */
async function oneAccentFill(page: import('playwright').Page, where: string): Promise<void> {
  const r = await page.evaluate(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--timmy-ui-accent, var(--timmy-accent))'; document.body.append(probe);
    const rgb = getComputedStyle(probe).color; probe.remove();
    const filled = [...document.querySelectorAll('#screen-connections *')].filter((e) => (e as HTMLElement).getClientRects().length > 0 && (getComputedStyle(e).backgroundColor === rgb || getComputedStyle(e).backgroundImage.includes(rgb)))
      .map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className)} "${(e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`);
    const verb = document.querySelector('.cn-verb.is-recommended');
    return { rgb, filled, ring: verb ? getComputedStyle(verb).borderTopColor : '(no recommended verb)', verbFill: verb ? getComputedStyle(verb).backgroundColor : '' };
  });
  expect(r.filled, `${where}: accent-filled: ${r.filled.join(' | ')}`).toHaveLength(1);
  expect(r.filled[0]).toMatch(/^button\.ui-primary/);
  expect(r.ring, `${where}: the recommended verb's ring is the accent`).toBe(r.rgb);
  expect(r.verbFill, `${where}: the recommended verb is not filled`).not.toBe(r.rgb);
}

/**
 * FAKE TimmyRive (this test's; R11 round 6): H174's 06:37 contract surface only — mountProviderCard(host, providerId, opts) →
 * a handle with root/binds/events/unmount(), fromProviderState(id, word, source) recording an event on every handle bound to
 * 'connection:<id>', inspect() listing the handles — so what THIS screen asks of the module is checked: where it mounts, how
 * often, what it feeds and with which source. The real module, runtime and timmy-ui.riv are H174's, exercised on the integrated
 * page by H172's journey; nothing here draws.
 */
const FAKE_RIVE = `<script>
window.__unmounted = 0; window.__mounts = [];
(() => {
  const handles = [];
  window.TimmyRive = {
    VERSION: 'FAKE (this test)',
    mountProviderCard(host, providerId, o) {
      const root = document.createElement('div'); root.className = 'tr-component'; root.dataset.artboard = 'ProviderCard'; root.dataset.fakeRive = 'ProviderCard'; root.textContent = 'FAKE ProviderCard ' + providerId;
      host.append(root);
      const handle = { id: 'fake-' + providerId + '-' + window.__mounts.length, component: 'connection', artboard: 'ProviderCard', binds: ['connection:' + providerId], events: [], word: null, root, provider: { name: o && o.providerName, detail: o && o.detail }, setProvider(p) { handle.provider = Object.assign({}, p); window.__setProvider = (window.__setProvider || []).concat([{ providerId, p }]); }, unmount() { window.__unmounted += 1; const i = handles.indexOf(handle); if (i >= 0) handles.splice(i, 1); root.remove(); } };
      handles.push(handle); window.__mounts.push({ providerId, o: o || null });
      return handle;
    },
    fromProviderState(id, word, source) { const out = []; for (const x of handles) if (x.binds.includes('connection:' + id)) { x.events.push({ input: 'connection', value: word, source, at: Date.now() }); x.word = word; out.push(x); } return out; },
    inspect() { return handles.map((x) => ({ id: x.id, component: x.component, artboard: x.artboard, binds: x.binds.slice(), events: x.events.slice(), word: x.word })); },
  };
})();
</script>`;

/** The page of this test: H171's shell stood in by a FAKE TimmyShell with the same surface; the real screen script and sheet. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FAKE shell</title>
<style>:root{--timmy-ground:#000;--timmy-surface:#0c0c0c;--timmy-raised:#161616;--timmy-line:#2a2a2a;--timmy-line-strong:#3a3a3a;--timmy-text:#f2f2f2;--timmy-text-secondary:#a8a8a8;--timmy-accent:#FFB000;--timmy-accent-ink:#000;--timmy-accent-soft:#333;--timmy-silver:#E8E4D9;--timmy-live:#00ff00;--timmy-weight-heading:600;--timmy-weight-strong:600;--timmy-weight-body:400;--timmy-font-mono:monospace}
body{margin:0;background:var(--timmy-ground);color:var(--timmy-text);font:15px/1.4 sans-serif}.sh-screen{height:100vh;overflow-y:auto}.sh-main{width:100%;max-width:1240px;margin:0 auto;padding:36px 48px;box-sizing:border-box}.sh-card{padding:28px;border:1px solid var(--timmy-line-strong);border-radius:6px;background:var(--timmy-surface)}.sh-btn,.sh-btn-primary,.sh-btn-text{font:inherit;cursor:pointer}.sh-btn{border:1px solid var(--timmy-line-strong);background:transparent;color:var(--timmy-text);padding:8px 14px}.sh-btn-primary{border:1px solid var(--timmy-accent);background:var(--timmy-accent);color:#000;padding:8px 14px}.sh-btn-text{border:0;background:transparent;color:var(--timmy-text);text-decoration:underline}.sh-input,.sh-select{font:inherit;padding:6px 10px;border:1px solid var(--timmy-line-strong);background:#000;color:var(--timmy-text)}.sh-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.sh-state.is-live{color:var(--timmy-live)}.sh-note{font-size:13px;color:var(--timmy-text-secondary)}.sh-head,.sh-foot{display:flex;justify-content:space-between;gap:16px;padding:16px 48px}.sh-steps{display:flex;gap:20px}@media (max-width:720px){.sh-main{padding:20px 16px}.sh-head,.sh-foot{padding:12px 16px}}
/* the FAKE scaffold at the real shell's measures (companion.css 1440: the 244 px rail beside the page, padding 26/32, the body grid work + 320 px context, gap 24; ≤ 720: padding 16, one column) so the cards' geometry here is the product's */
.sh-screen.page{box-sizing:border-box;padding:26px 32px 22px 276px;display:flex;flex-direction:column;gap:18px}.page-head{display:flex;justify-content:space-between;gap:24px}.page-kicker{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase}.page-title{margin:4px 0;font-size:30px;line-height:1.15;font-weight:600}.page-intro{margin:0;font-size:15px}.page-band{min-height:48px;border:1px solid var(--timmy-line);border-radius:10px;padding:12px 16px;box-sizing:border-box}.page-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;align-items:start}.page-body:has(> .page-context[hidden]){grid-template-columns:minmax(0,1fr)}.page-work{min-width:0;display:flex;flex-direction:column;gap:14px}.page-context{min-width:0;display:flex;flex-direction:column;gap:16px}.page-dock{display:flex;gap:12px;align-items:center}.dock-tools{display:flex;flex-wrap:wrap;gap:8px}
@media (max-width:720px){.sh-screen.page{padding:16px}.page-body{grid-template-columns:minmax(0,1fr)}}
/* the shell's head primary as companion.css fills it (its gradient ends on the family accent; a solid fill of that accent here): the page's ONE accent fill (D24) */
.ui-primary{font:inherit;cursor:pointer;border:1px solid var(--timmy-accent);background:var(--timmy-accent);color:#000;padding:8px 14px}</style>
<link rel="stylesheet" href="/screen-connections.css"></head><body>
__SECTION__
<script>
// FAKE TimmyShell (this test's): the same surface as H171's shell; the FAKE user rides in a header the FAKE withUser reads.
// R11 round 7: the SHELL CONTRACT v1 registration surface too (page / band / state), recording what the screen registers
window.__went = []; window.__landed = 0; window.__toasts = []; window.__pages = []; window.__bands = []; window.__states = [];
window.TimmyShell = {
  draws: {},
  // the rail's numbers, as shell.js exposes them (Models & accounts is the eighth destination)
  PAGES: [{ id: 'chat', n: '01' }, { id: 'connections', n: '08' }],
  // the registration drawn into the scaffold's head as the real shell draws it (the kicker, the title, the intro, the primary; FAKE here)
  page(id, reg) {
    window.__pages.push({ id, reg: Object.assign({}, reg, { primary: reg.primary ? { label: reg.primary.label, run: typeof reg.primary.run } : null }) }); window.__lastPrimary = reg.primary ? reg.primary.run : null;
    const s = document.getElementById('screen-' + id); if (!s) return;
    s.querySelector('.page-kicker').textContent = reg.kicker || ''; s.querySelector('.page-title').textContent = reg.title || ''; s.querySelector('.page-intro').textContent = reg.intro || '';
    const slot = s.querySelector('.page-primary'); slot.replaceChildren();
    if (reg.primary) { const b = document.createElement('button'); b.type = 'button'; b.className = 'ui-primary page-primary-btn'; b.textContent = reg.primary.label; b.addEventListener('click', () => reg.primary.run()); slot.append(b); }
    const ctx = s.querySelector('.page-context'); if (ctx) ctx.hidden = !reg.context;
  },
  band(id, cells) { window.__bands.push({ id, cells }); },
  state(id, word, o) { window.__states.push({ id, word, words: o && o.words }); const s = document.getElementById('screen-' + id); if (s) s.dataset.state = word; },
  // (shell.js 97389f14 hands a mount() page its SECTION; the screen draws into a .page-mount of its own inside .page-work)
  mount(id, fn) { this.draws[id] = fn; const s = document.getElementById('screen-' + id); if (s) fn(s, this); },
  fetch(url, init) { const o = Object.assign({}, init || {}); o.headers = Object.assign({}, o.headers || {}, { 'X-FAKE-User': 'alice' }); o.cache = 'no-store'; return fetch(url, o); },
  h(tag, attrs, ...children) { const el = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); } for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c))); return el; },
  go(id) { window.__went.push(id); }, land() { window.__landed += 1; }, toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
  session: { user: () => ({ id: 'alice', username: 'alice' }) },
};
</script>
__RIVE__<script src="/screen-connections.js"></script>
</body></html>`;
/** The page's section with the shell's scaffold (SHELL CONTRACT v1 §2.2 as shell.js writes it; 97389f14 hands the screen the section, the screen keeps its work in a .page-mount of its own inside .page-work). */
const SECTION_SCAFFOLD = `<section class="sh-screen page ws-page" id="screen-connections" data-screen="connections" data-page="connections" data-ws-page="connections" data-state="content">
<header class="page-head"><div class="page-head-words"><p class="page-kicker"></p><h1 class="page-title" tabindex="-1"></h1><p class="page-intro"></p></div><div class="page-head-actions"><div class="page-primary"></div></div></header>
<div class="page-band"><div class="band-cell"><span class="band-k">Workspace</span><strong class="band-v">FAKE project</strong></div></div>
<div class="page-body"><div class="page-work"><div class="page-state" hidden></div></div><aside class="page-context" hidden></aside></div>
<div class="page-dock"><span class="dock-label">MODELS &amp; ACCOUNTS TOOLS</span><div class="dock-tools"></div></div>
<div class="page-records"></div>
</section>`;
/** The page with the FAKE TimmyRive before the screen's script (the integrated page's order), or bare: no TimmyRive at all. */
const pageHtml = (rive: boolean): string => PAGE.replace('__RIVE__', rive ? `${FAKE_RIVE}\n` : '').replace('__SECTION__', SECTION_SCAFFOLD);

let root = '';
let browser: Browser | null = null;
let browserPath: string | undefined;
let ollama: ReturnType<typeof fakeOllama>;
let ollamaCom: ReturnType<typeof fakeOllamaCom>;
let companion: Server;
let base = '';
let mounted: ReturnType<typeof mountConnections>;
const asked: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'h170-connections-browser-'));
  mkdirSync(join(root, 'bin'));
  ollama = fakeOllama(); ollamaCom = fakeOllamaCom();
  const ollamaOrigin = await listen(ollama.server);
  const routes: Record<string, string> = { 'https://ollama.com': await listen(ollamaCom.server) };
  const routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    asked.push(`${u.origin}${u.pathname}`);
    const to = routes[u.origin];
    if (to) return realFetch(`${to}${u.pathname}${u.search}`, init);
    if (u.hostname === '127.0.0.1') return realFetch(input, init);
    throw new Error(`a request left this computer: ${u.origin}`);
  }) as typeof fetch;
  globalThis.fetch = routed; // the local probe asks through the global fetch; restored in afterAll
  const fakeWithUser: express.RequestHandler = (req, res, next) => {
    const id = req.get('X-FAKE-User');
    if (!id) { refuseRequest(res, 401, 'FAKE withUser: no session on this request'); return; }
    (req as express.Request & { user?: ConnectionsUser }).user = { id, username: `fake-${id}` };
    next();
  };
  // (the user's own record names the FAKE Ollama — as `timmy init --ollama <host>` records it; the companion's shell variable is passed
  // through as identity/scope.ts userEnv passes it and is never a user's address since the 18:21 fix: tests/companion-connections pins it)
  const userEnv = (user: ConnectionsUser): Record<string, string | undefined> => {
    const home = join(root, 'users', user.id);
    for (const d of ['timmy', 'settings', 'mcp']) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
    const providers = join(home, 'timmy', 'providers.json');
    if (!existsSync(providers)) writeFileSync(providers, JSON.stringify({ ollama_host: ollamaOrigin }, null, 2), { mode: 0o600 });
    return { PATH: join(root, 'bin'), HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), TIMMY_MCP_HOME: join(home, 'mcp'), OLLAMA_HOST: ollamaOrigin };
  };
  const app = express();
  app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(pageHtml(req.query.bare !== '1')); });
  app.get('/screen-connections.js', (_req, res) => { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.send(readFileSync(join(CLIENT, 'screen-connections.js'), 'utf8')); });
  app.get('/screen-connections.css', (_req, res) => { res.setHeader('Content-Type', 'text/css; charset=utf-8'); res.send(readFileSync(join(CLIENT, 'screen-connections.css'), 'utf8')); });
  mounted = mountConnections(app, { withUser: fakeWithUser, userEnv, fetch: routed, platform: 'linux', signInTimeoutMs: 60_000, confirmTimeoutMs: 60_000 });
  companion = createServer(app);
  base = await listen(companion);
  browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p): p is string => Boolean(p) && existsSync(p!));
  if (!browserPath) console.warn('companion-connections-browser: no Chromium found, so the browser checks are skipped here');
  if (browserPath) browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  mounted.close();
  if (browser) await browser.close();
  await Promise.all([close(companion), close(ollama.server), close(ollamaCom.server)]);
  rmSync(root, { recursive: true, force: true });
});

describe('the Connections screen in Chromium (FAKE shell, real routes, FAKE providers on 127.0.0.1)', () => {
  it('1440x900: the preview\'s words, four cards with their state words and next steps; a cloud key pasted is saved, never in the page or an address; Explore and Continue go where the shell says', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${base}/`);
    await page.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    // R11 round 7: the page on the shell's scaffold — the screen registers the kicker (the rail's number, then the verb phrase),
    // the title, the lead, the ONE primary next action (no route is ready under this FAKE user: "Set up a model"), the Account
    // cell; the band's Model and Records cells; the state. The head is the shell's (the FAKE draws the registration as it does).
    type Reg = { id: string; reg: { kicker: string; title: string; intro: string; primary: { label: string; run: string } | null; context: string; band: Array<{ k: string; v: string }>; dock: string } };
    const pages = await page.evaluate(() => (window as unknown as { __pages: Reg[] }).__pages);
    expect(pages.at(-1)).toEqual({ id: 'connections', reg: { kicker: '08 / CONNECT A PROVIDER', title: 'One model is enough to begin.', intro: 'Use a local model or connect a cloud account. Add the others when you need them.', primary: { label: 'Set up a model', run: 'function' }, context: 'selection', band: [{ k: 'Account', v: 'Signed in · alice' }], dock: 'MODELS & ACCOUNTS TOOLS' } });
    expect(await page.evaluate(() => (window as unknown as { __bands: unknown[] }).__bands.at(-1))).toEqual({ id: 'connections', cells: { model: 'Choose a provider', records: 'Local by default' } });
    expect(await page.evaluate(() => (window as unknown as { __states: Array<{ id: string; word: string }> }).__states.at(-1))).toMatchObject({ id: 'connections', word: 'content' });
    expect(await page.locator('#screen-connections .page-kicker').textContent()).toBe('08 / CONNECT A PROVIDER');
    expect(await page.locator('#screen-connections .page-primary button').textContent()).toBe('Set up a model');
    // the screen draws no head or band of its own; its work is in the mount, its context in the shell's column, its buttons in the
    // dock's tools, its records in the shell's records region
    expect(await page.locator('#screen-connections .cn-head, #screen-connections .cn-band, #screen-connections .cn-grid').count()).toBe(0);
    expect(await page.locator('#screen-connections > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['page-head', 'page-band', 'page-body', 'page-dock', 'page-records']);
    expect(await page.locator('.page-work > .page-mount > *').evaluateAll((els) => els.map((e) => e.className.split(' ').find((c) => c.startsWith('cn-'))))).toEqual(['cn-work', 'cn-note']);
    expect(await page.locator('.page-context .cn-context-title').textContent()).toBe('Choose your model');
    expect(await page.locator('.page-dock .dock-tools .dock-btn[data-cn-dock]').evaluateAll((els) => els.map((e) => e.getAttribute('data-cn-dock')))).toEqual(['check-all', 'download', 'explore', 'back', 'records']);
    expect(await page.locator('.page-records .cn-records').count()).toBe(1);
    expect(await page.locator('.cn-card .cn-card-title').allTextContents()).toEqual(['OpenRouter', 'Ollama · local', 'Ollama · cloud', 'Cloudflare']);
    expect(await page.locator('.cn-card .cn-state-word').allTextContents()).toEqual(['not set up', 'not installed', 'not set up', 'not set up']);
    // each card in one of the order's situations, with its verb-led action; the ONE primary is the recommended card's verb
    // (D15: ONE state word per card — the probe's; the situation drives the verb and stays as data-situation, no chip, no frame by colour)
    expect(await page.locator('.cn-card').evaluateAll((els) => els.map((e) => [e.getAttribute('data-situation'), e.querySelector('[data-cn-verb]')?.textContent, e.querySelector('[data-cn-verb]')?.className.includes('is-recommended')]))).toEqual([
      ['no-account', 'Connect with OpenRouter ↗', false], ['no-model', 'Install Ollama ↗', true], ['no-account', 'Save an Ollama key', false], ['no-account', 'Set up Cloudflare', false]]);
    expect(await page.locator('.cn-card .cn-situation').count()).toBe(0);
    expect(await page.locator('.cn-card .cn-state-word').count()).toBe(4); // one per card
    expect(await page.locator('.cn-card').evaluateAll((els) => els.map((e) => getComputedStyle(e).borderColor))).toEqual(Array(4).fill(await page.locator('.cn-card').first().evaluate((e) => getComputedStyle(e).borderColor))); // no frame by state
    // D24 (the lead's 00:47): with no route ready the head's "Set up a model" and the recommended card's verb are ONE action, so the page
    // has exactly one accent FILL (the head's primary) and the recommended verb carries the accent as its RING (the .sh-btn look); no
    // .sh-btn-primary on any card; the context repeats no verb
    expect(await page.locator('.cn-card .sh-btn-primary').count()).toBe(0);
    expect(await page.locator('.cn-verb.is-recommended').count()).toBe(1);
    await oneAccentFill(page, '1440, no route ready');
    // D15 (H168's R85): the face beside the words at ≤ 160 px, every card's verb above the fold at 1440×900 (the FAKE scaffold at the shell's measures)
    const geometry = await page.locator('.cn-card').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect(); const v = e.querySelector('[data-cn-verb]')!.getBoundingClientRect(); const f = e.querySelector('.cn-rive')?.getBoundingClientRect();
      return { id: e.getAttribute('data-provider'), top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width), verbTop: Math.round(v.top), verbBottom: Math.round(v.bottom), face: f ? [Math.round(f.width), Math.round(f.height), Math.round(f.left - r.left)] : null };
    }));
    console.info(`companion-connections-browser 1440x900 (FAKE scaffold at the shell's measures): ${geometry.map((g) => `${g.id} ${g.width}×${g.height} at y ${g.top}, verb y ${g.verbTop}–${g.verbBottom}, face ${g.face ? `${g.face[0]}×${g.face[1]} at x+${g.face[2]}` : 'none'}`).join(' · ')}`);
    for (const g of geometry) {
      expect(g.verbBottom, `${g.id}: its verb above the fold`).toBeLessThanOrEqual(900);
      expect(g.height, `${g.id}: a compact cell`).toBeLessThanOrEqual(460);
      expect(g.face![1], `${g.id}: the face ≤ 160 px tall`).toBeLessThanOrEqual(160);
      expect(g.face![2], `${g.id}: the face beside the words, not over them`).toBeGreaterThan(g.width / 2);
    }
    // the context: Choose your model, the chosen provider (the recommended one) with its cost, what a check sends, the offer
    expect(await page.locator('.cn-context-title').textContent()).toBe('Choose your model');
    expect(await page.locator('.cn-pick[aria-pressed="true"]').textContent()).toBe('Ollama local'); // (the short name on the segmented control; the full one as its title)
    expect(await page.locator('.cn-pick[aria-pressed="true"]').getAttribute('title')).toBe('Ollama · local');
    // (R87: the context holds the selected card's facts, not the card again — no second title block, state or verb)
    expect(await page.locator('.cn-context-card .cn-state-word, .cn-context-card [data-cn-context-verb], .cn-context-card .cn-situation').count()).toBe(0);
    // (item 5 of the operator's 19:18 order: the facts in view are plain — the mechanics behind Details)
    expect(await page.locator('.cn-context-card > .cn-facts dt').allTextContents()).toEqual(['Cost']);
    expect(await page.locator('.cn-context-card .cn-context-details .cn-facts dt').allTextContents()).toEqual(['Next step', 'A check sends', 'What it asks', 'Last observed', 'Observed', 'On this computer']);
    expect(await page.locator('.cn-context-card .cn-context-details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await page.locator('.cn-context-card .cn-context-about').textContent()).toBe('Run models on this computer. No provider account required.'); // (the description is the context's, not the card's)
    // the selected card's other controls are the context's (one verb on the card); no card shows an address, a path, a command or an
    // endpoint — not now, not after an action (the probe's words and the files' names are the Details' and the records')
    expect(await page.locator('.page-context [data-cn-tools="ollama-local"] button').allTextContents()).toEqual(['Download a local model', 'Check', 'Set up local Ollama ↗']);
    expect(await page.locator('.cn-card button').count()).toBe(4);
    const noMechanics = async () => { for (const t of await page.locator('.cn-card').allTextContents()) expect(t).not.toMatch(/https?:|127\.0\.0\.1|\/api\/|\.json|curl |ollama serve|GET |key [0-9a-f]{12}/); };
    await noMechanics();
    expect(await page.locator('.cn-card .cn-status-words').allTextContents()).toEqual(['No OpenRouter account yet.', 'Ollama is not installed on this computer.', 'No Ollama key saved yet.', 'Optional; nothing set up yet.']);
    // a card is title · face · ONE status line · ONE verb: no footer, no second line of words (what an action says is the context's live line)
    expect(await page.locator('.cn-card').evaluateAll((els) => els.map((e) => [...e.children].map((k) => k.className.split(' ').find((c) => c.startsWith('cn-')))))).toEqual(Array(4).fill(['cn-card-head', 'cn-status', 'cn-rive', 'cn-verb-row']));
    expect(await page.locator('.cn-card .cn-say').count()).toBe(0);
    expect(await page.locator('.page-context .cn-context-card [data-cn-say="ollama-local"]').count()).toBe(1);
    // (R87: the segmented control in one row at 1440)
    expect(new Set(await page.locator('.cn-pick').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).size).toBe(1);
    expect(await page.locator('.cn-context-card').getAttribute('data-cn-context-for')).toBe('ollama-local');
    expect(await page.locator('.cn-facts div').filter({ has: page.locator('dt', { hasText: /^Cost$/ }) }).locator('dd').textContent()).toBe('No charge: models run on this computer. A download comes from ollama.com and takes disk space.');
    expect(await page.locator('.cn-offer .cn-starter').count()).toBe(3);
    expect(await page.locator('.cn-offer .cn-starter-pick').first().textContent()).toMatch(/^Download \S+ \(\d+(\.\d+)? [GM]B\)$/); // (R96: the verb and the size, not "Offer")
    expect(await page.locator('.cn-offer').textContent()).toContain('a rule of thumb from Ollama’s library, not a measurement of this computer');
    expect(await page.locator('.cn-note').textContent()).toContain('Nothing is downloaded until you confirm.');
    // the records are closed until asked; the dock's Records opens them
    expect(await page.locator('.cn-records').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.getByRole('button', { name: 'Records', exact: true }).click();
    expect(await page.locator('.cn-records').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator('.cn-record').count()).toBe(7);
    expect(await page.locator('.cn-record').nth(4).textContent()).toContain('id alice'); // (R95: the session's raw id behind Details, not in the band)
    for (const name of ['Connect with OpenRouter ↗', 'Install Ollama ↗', 'Save an Ollama key', 'Set up Cloudflare', 'Download a local model', 'Check', 'Set up local Ollama ↗', 'Back', 'Explore without a model', 'Set up a model', 'Download a model']) {
      await expect(page.getByRole('button', { name, exact: true }).count()).resolves.toBe(1);
    }
    for (const name of ['Sign in to Ollama ↗', 'Open Cloudflare setup ↗']) await expect(page.getByRole('button', { name, exact: true }).count()).resolves.toBe(0); // (another card's tools: shown when it is selected)
    // (R102: no text node reading "null" or "undefined" on the page — with the local card's context, which carries the offer)
    expect(await strayWords(page)).toEqual([]);
    // the picker changes the context, not any connection
    await page.locator('.cn-pick[data-cn-pick="openrouter"]').click();
    expect(await page.locator('.cn-context-card').getAttribute('data-cn-context-for')).toBe('openrouter');
    expect(await page.locator('.cn-card.is-chosen').getAttribute('data-provider')).toBe('openrouter');
    expect(await page.locator('.cn-card .cn-state-word').allTextContents()).toEqual(['not set up', 'not installed', 'not set up', 'not set up']);
    // (R102's repro: a card WITHOUT the download offer selected — the context's second child was a null, written as the word "null")
    expect(await strayWords(page)).toEqual([]);
    expect(await page.locator('.cn-context-body').evaluate((b) => [...b.childNodes].map((n) => n.nodeType))).toEqual([1]); // (one element, no text node)
    // no card is "connected" and nothing is "free": a selection is never a connection
    const text = (await page.locator('#screen-connections').textContent()) ?? '';
    expect(text).not.toMatch(/\bconnected\b/i);
    expect(text).not.toMatch(/\bfree\b/i);
    // R11 round 6: the native ProviderCard's host in every card — the footer's first child, the state word right after it — mounted
    // once per card through TimmyRive.mountProviderCard(host, id, { size: 'wide', label }) (the FAKE's marker stands in the host)
    const hosts = await page.locator('.cn-card > .cn-rive').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-rive-host'), card: e.closest('.cn-card')?.getAttribute('data-provider'), next: e.nextElementSibling?.className ?? '', marker: e.querySelector('[data-fake-rive="ProviderCard"]')?.textContent ?? '' })));
    expect(hosts).toEqual(['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'].map((id) => ({ id, card: id, next: expect.stringContaining('cn-verb-row'), marker: `FAKE ProviderCard ${id}` })));
    type Mount = { providerId: string; o: { size?: string; label?: string; providerName?: string; detail?: string; words?: string } | null };
    expect(await page.evaluate(() => (window as unknown as { __mounts: Mount[] }).__mounts)).toEqual([
      // (D15: the detail run is the provider's subtitle — a fact; the one state word is the card's, the face's label follows the feed;
      // item 4 / D18: `words: 'spoken'` — the module takes its own HTML status off the screen only while the face is drawn and legible)
      { providerId: 'openrouter', o: { size: 'wide', label: 'OpenRouter', providerName: 'OpenRouter', detail: 'One account. Many model providers.', words: 'spoken' } }, { providerId: 'ollama-local', o: { size: 'wide', label: 'Ollama · local', providerName: 'Ollama · local', detail: 'On your computer', words: 'spoken' } },
      { providerId: 'ollama-cloud', o: { size: 'wide', label: 'Ollama · cloud', providerName: 'Ollama · cloud', detail: 'Your Ollama account', words: 'spoken' } }, { providerId: 'cloudflare', o: { size: 'wide', label: 'Cloudflare', providerName: 'Cloudflare', detail: 'Optional · gateway, agents and sync', words: 'spoken' } }]);
    // the feed: the first draw fed each card's state ONCE, the backend's event as the source (never the card's drawing)
    type Handle = { id: string; binds: string[]; events: Array<{ input: string; value: string; source: string }>; word: string | null };
    const inspect = () => page.evaluate(() => (window as unknown as { TimmyRive: { inspect(): Handle[] } }).TimmyRive.inspect());
    const first = await inspect();
    expect(first.map((x) => x.binds)).toEqual([['connection:openrouter'], ['connection:ollama-local'], ['connection:ollama-cloud'], ['connection:cloudflare']]);
    expect(first.map((x) => x.events)).toEqual([
      [{ input: 'connection', value: 'not set up', source: 'GET /api/connections: openrouter', at: expect.any(Number) }],
      [{ input: 'connection', value: 'not installed', source: 'GET /api/connections: ollama-local', at: expect.any(Number) }],
      [{ input: 'connection', value: 'not set up', source: 'GET /api/connections: ollama-cloud', at: expect.any(Number) }],
      [{ input: 'connection', value: 'not set up', source: 'GET /api/connections: cloudflare', at: expect.any(Number) }]]);
    // Ollama · cloud: its verb selects the card and the context shows its tools — the labelled password field, focused; the key
    // pasted there is sent once in the body; the card says saved, not checked
    await page.getByRole('button', { name: 'Save an Ollama key', exact: true }).click();
    expect(await page.locator('.cn-card.is-chosen').getAttribute('data-provider')).toBe('ollama-cloud');
    const keyField = page.locator('.page-context').getByLabel('Ollama API key', { exact: true });
    expect(await keyField.evaluate((e) => document.activeElement === e)).toBe(true);
    await keyField.fill(FAKE_KEY);
    await page.getByRole('button', { name: 'Save the key', exact: true }).click();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: 'saved, not checked' }).waitFor();
    // (item 5: the card's one status line is plain; what the save said is the context's live line, plain too — the file's name and
    // the key's fingerprint are the records')
    expect(await page.locator('.cn-card-ollama-cloud .cn-status-words').textContent()).toBe('A key is saved; not checked yet.');
    const saidCloud = page.locator('.page-context .cn-context-card [data-cn-say="ollama-cloud"]');
    expect(await saidCloud.textContent()).toBe('The key is saved, not checked yet. Check the key asks Ollama Cloud whether it takes it; no model is run.');
    expect(await saidCloud.getAttribute('aria-live')).toBe('polite');
    await noMechanics();
    expect(await keyField.inputValue()).toBe('');
    expect(await page.content()).not.toContain(FAKE_KEY);
    expect(requests.some((u) => u.includes(FAKE_KEY))).toBe(false);
    expect(requests.every((u) => u.startsWith(base))).toBe(true);
    // its check: the FAKE ollama.com takes the key; the state is checked (green) on the card's one status line; the probe's full words
    // (the fingerprint, the file) are the Details' Observed row; the live line is cleared (the state changed: the status line says it) —
    // no toast from this screen (R96: the shell's toast painted over the records band)
    await page.getByRole('button', { name: 'Check the key', exact: true }).click();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await page.locator('.cn-card-ollama-cloud .cn-state-word').getAttribute('class')).toContain('is-live');
    expect(await page.locator('.cn-card .cn-state-word.is-live').count()).toBe(1); // (green only for the observed "checked": the cloud card alone)
    expect(await page.locator('.cn-card-ollama-cloud .cn-status-words').textContent()).toBe('Ollama Cloud took the key.');
    expect(await saidCloud.textContent()).toBe('');
    expect(await page.locator('.page-context .cn-context-details .cn-facts div').filter({ has: page.locator('dt', { hasText: /^Observed$/ }) }).locator('dd').textContent()).toMatch(/^Checked just now: Ollama Cloud took the key \(key [0-9a-f]{12}\) from providers\.json/);
    await noMechanics();
    expect(await strayWords(page)).toEqual([]); // (R102: the cloud card's context after the key was saved and checked — H168's second picture)
    expect(await page.evaluate(() => (window as unknown as { __toasts: unknown[] }).__toasts.length)).toBe(0);
    // the two refreshes (the key saved, the key checked) fed the cloud card's two changes and nothing else: still four handles
    // (no re-mount: the host moved into each redrawn card), the other three cards unchanged, so unfed
    const after = await inspect();
    expect(after.map((x) => x.id)).toEqual(first.map((x) => x.id));
    expect(after[2].events.map((e) => [e.value, e.source])).toEqual([['not set up', 'GET /api/connections: ollama-cloud'], ['saved, not checked', 'GET /api/connections: ollama-cloud'], ['checked', 'GET /api/connections: ollama-cloud']]);
    expect(after[2].word).toBe('checked');
    expect([after[0], after[1], after[3]].map((x) => x.events.length)).toEqual([1, 1, 1]);
    expect(await page.locator('.cn-card-ollama-cloud > .cn-rive [data-fake-rive="ProviderCard"]').count()).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __mounts: unknown[] }).__mounts.length)).toBe(4);
    // RIVE CONTRACT v2's optional setProvider: the detail run is the subtitle (a fact that does not move), so no call followed the
    // situation's change — the face's state is the feed's (H174's f165d8c7: the label and the ProviderState run say the observed word)
    expect(await page.evaluate(() => (window as unknown as { __setProvider?: unknown[] }).__setProvider ?? [])).toEqual([]);
    // the cloud card's situation moved: an existing setup now, its verb "Check again"; the band's Model cell follows the route
    // (this FAKE user's route stays not ready: no model chosen), so the registered primary stays "Set up a model"; the
    // registration was redrawn once per refresh into the same containers (never a second head, dock button or records)
    expect(await page.locator('.cn-card-ollama-cloud').getAttribute('data-situation')).toBe('existing');
    expect(await page.locator('.cn-card-ollama-cloud [data-cn-verb]').textContent()).toBe('Check again');
    expect(await page.evaluate(() => (window as unknown as { __bands: Array<{ cells: { model: string } }> }).__bands.at(-1)!.cells.model)).toBe('Choose a provider');
    expect(await page.locator('.page-dock .dock-tools .dock-btn[data-cn-dock]').count()).toBe(5);
    expect(await page.locator('.page-records .cn-records').count()).toBe(1);
    expect(await page.locator('.page-context .cn-context-card').count()).toBe(1);
    // the steps go where the shell says: Explore → chat; Back → account; the primary (no route ready) selects the recommended card
    // (D8: the dock's words carry no arrow — the page's one arrow is the shell's primary)
    await page.getByRole('button', { name: 'Explore without a model', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Set up a model', exact: true }).click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-cn-verb'))).toBe('ollama-cloud');
    expect(await page.evaluate(() => (window as unknown as { __went: string[]; __landed: number }).__went)).toEqual(['chat', 'account']);
    expect(await page.evaluate(() => (window as unknown as { __landed: number }).__landed)).toBe(0);
    expect(asked.filter((a) => !a.startsWith('http://127.0.0.1:') && !a.startsWith('https://ollama.com/'))).toEqual([]);
    // the shell shows the screen again (a second draw): the four handles are unmounted first, then four fresh ones fed afresh
    await page.evaluate(() => { const sh = (window as unknown as { TimmyShell: { draws: Record<string, (host: Element, shell: unknown) => void> } }).TimmyShell; sh.draws.connections(document.getElementById('screen-connections')!, sh); });
    // (the unmounts are synchronous in the redraw; the four fresh mounts come with its asynchronous render — waited for, not assumed)
    await page.waitForFunction(() => (window as unknown as { __mounts: unknown[] }).__mounts.length >= 8, null, { timeout: 15_000 });
    await page.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __unmounted: number }).__unmounted)).toBe(4);
    const again = await inspect();
    expect(again.length).toBe(4);
    expect(again.map((x) => x.id).some((id) => first.some((x) => x.id === id))).toBe(false);
    expect(again[2].events.map((e) => [e.value, e.source])).toEqual([['checked', 'GET /api/connections: ollama-cloud']]);
    // R103 (the lead's D22): the band's Account cell says the TIMMY account's truth — "Signed in · <name>" with the session's name,
    // "Signed in" when the session carries an id but no name (H168's page: the cell read "Not signed in" while signed in), "This
    // computer's operator" with no identity provider configured, "Not signed in" otherwise; the provider accounts are the cards'
    // (the redraw registers its page asynchronously — refresh() → render() → TimmyShell.page(): the previous draw's head and cards stand
    // meanwhile, so a read of the last registration right after the redraw could return the PREVIOUS call's band (hold C, 00:13, under
    // --maxWorkers=2): the read waits for the registrations to grow by this redraw's, then reads that one)
    const registrations = () => page.evaluate(() => (window as unknown as { __pages: unknown[] }).__pages.length);
    const accountCell = async (user: Record<string, string> | null, token: string, identity: Record<string, unknown> | null) => {
      const before = await registrations();
      await page.evaluate(([u, t, i]) => {
        const sh = (window as unknown as { TimmyShell: Record<string, any> }).TimmyShell;
        sh.session = { user: () => u, get: () => t };
        if (i) sh.identity = () => i; else delete sh.identity;
        sh.draws.connections(document.getElementById('screen-connections')!, sh);
      }, [user, token, identity] as const);
      await page.waitForFunction((n) => (window as unknown as { __pages: unknown[] }).__pages.length > n, before, { timeout: 15_000 });
      await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
      return page.evaluate((n) => (window as unknown as { __pages: Array<{ reg: { band: Array<{ k: string; v: string }> } }> }).__pages[n]!.reg.band, before);
    };
    expect(await accountCell({ id: 'user_FAKE0000', username: '' }, 'FAKE-session-token', { configured: true })).toEqual([{ k: 'Account', v: 'Signed in' }]); // (no raw id in the band)
    expect(await accountCell({ id: 'user_FAKE0000', username: '', name: 'Alice Example' }, 'FAKE-session-token', { configured: true })).toEqual([{ k: 'Account', v: 'Signed in · Alice Example' }]);
    expect(await accountCell(null, 'FAKE-session-token', { configured: true })).toEqual([{ k: 'Account', v: 'Signed in' }]); // (a token the shell restored, its user record not yet read)
    expect(await accountCell(null, '', { configured: false })).toEqual([{ k: 'Account', v: 'This computer’s operator' }]);
    expect(await accountCell(null, '', { configured: true })).toEqual([{ k: 'Account', v: 'Not signed in' }]);
    expect(await strayWords(page)).toEqual([]);
    await page.close();
  }, 60_000);

  it('Ollama · local: Check against the FAKE; the download names its size, waits for Confirm the download, shows progress to done; a second one is cancelled during the download', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/`);
    await page.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    const card = page.locator('.cn-card-ollama-local');
    // (the case above left this FAKE user a checked cloud key, so the recommended — selected — card is that existing setup; a press
    // on the local card selects it: a selection, never a connection) — the context then holds its tools: Check is there (the card's
    // one verb is Install Ollama)
    await card.locator('.cn-card-title').click();
    expect(await page.locator('.cn-card.is-chosen').getAttribute('data-provider')).toBe('ollama-local');
    expect(await card.locator('.cn-state-word').textContent()).toBe('not installed');
    const ctx = page.locator('.page-context');
    const tools = ctx.locator('[data-cn-tools="ollama-local"]');
    await tools.getByRole('button', { name: 'Check', exact: true }).click();
    await card.locator('.cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    // the card's one status line is plain; the probe's words with the address are the context's Details (Observed) and the records;
    // the context's live line is cleared (the state changed: the status line says it)
    expect(await card.locator('.cn-status-words').textContent()).toBe('Ollama answered with local models.');
    expect(await card.textContent()).not.toMatch(/127\.0\.0\.1|\/api\/|GET /);
    expect(await page.locator('.cn-card.is-chosen').getAttribute('data-provider')).toBe('ollama-local');
    const saidLocal = ctx.locator('.cn-context-card [data-cn-say="ollama-local"]');
    expect(await saidLocal.textContent()).toBe('');
    expect(await ctx.locator('.cn-context-details .cn-facts div').filter({ has: page.locator('dt', { hasText: /^Observed$/ }) }).locator('dd').textContent()).toMatch(/^Checked just now: Ollama answered at 127\.0\.0\.1:\d+ with local models \(no account, no charge\)\.$/);
    expect(await ctx.locator('.cn-context-details').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    // what the check FOUND — the models this Ollama holds — is in view in the context (a fact the person chooses by; the journeys read
    // the model's name from the visible page), not behind the Details with the mechanics
    const found = ctx.locator('.cn-found[data-cn-found="ollama-local"]');
    expect(await found.isVisible()).toBe(true);
    expect((await found.locator('.cn-context-lines[data-cn-lines="ollama-local"]').textContent()) ?? '').toContain('holds fake-qwen3:8b (5.2 GB)');
    expect(await ctx.locator('.cn-context-details .cn-context-lines').count()).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).toContain('fake-qwen3:8b');
    // the card's verb is "Check again" now (an existing setup); pressed, the state stays and the live line says so
    expect(await card.locator('[data-cn-verb]').textContent()).toBe('Check again');
    await card.locator('[data-cn-verb]').click();
    await saidLocal.filter({ hasText: 'Checked again; the state is as it was.' }).waitFor();
    expect(await card.locator('.cn-status-words').textContent()).toBe('Ollama answered with local models.');
    // the download box, in the context under the card's tools: a name typed, the size asked (unknown: not a starter, not held),
    // then the confirmation, then progress
    await tools.getByRole('button', { name: 'Download a local model', exact: true }).click();
    await ctx.getByLabel('Another model name', { exact: true }).fill('fake-new:3b');
    await ctx.getByRole('button', { name: 'Show the size', exact: true }).click();
    const confirmBtn = ctx.getByRole('button', { name: 'Confirm the download', exact: true });
    await confirmBtn.waitFor();
    expect(await ctx.locator('.cn-pull-status').textContent()).toContain('fake-new:3b: size unknown');
    expect(ollama.seen).not.toContain('POST /api/pull');
    await confirmBtn.click();
    await ctx.locator('.cn-pull-status').filter({ hasText: /MB of .* MB/ }).waitFor();
    expect(await ctx.locator('.cn-pull-status').textContent()).toMatch(/\d+ MB of 4 MB · pulling FAKE-layer \(\d+%\)/);
    await ctx.locator('.cn-pull-status').filter({ hasText: 'Downloaded: Ollama lists fake-new:3b as installed now.' }).waitFor({ timeout: 10_000 });
    expect(ollama.installed.has('fake-new:3b')).toBe(true);
    // the second download, stalled by the FAKE, cancelled from the page: "Cancelled" in the words, nothing installed
    ollama.setStall(true);
    await ctx.getByLabel('Another model name', { exact: true }).fill('fake-second:1b');
    await ctx.getByRole('button', { name: 'Show the size', exact: true }).click();
    await ctx.getByRole('button', { name: 'Confirm the download', exact: true }).click();
    await ctx.locator('.cn-pull-status').filter({ hasText: /MB of .* MB/ }).waitFor();
    await ctx.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ctx.locator('.cn-pull-status').filter({ hasText: /^Cancelled/ }).waitFor();
    expect(await ctx.locator('.cn-pull-status').textContent()).toContain('Ollama keeps what it downloaded of fake-second:1b');
    expect(ollama.installed.has('fake-second:1b')).toBe(false);
    expect(mounted.pendingPulls()).toBe(0);
    // R11 round 6: the local card's feed over this case — the first draw (not installed), the Check (checked); the download's
    // refresh found the same state and fed nothing: one line per state CHANGE, each from the backend's event
    const local = (await page.evaluate(() => (window as unknown as { TimmyRive: { inspect(): Array<{ binds: string[]; events: Array<{ value: string; source: string }> }> } }).TimmyRive.inspect())).find((x) => x.binds.includes('connection:ollama-local'));
    expect(local?.events.map((e) => [e.value, e.source])).toEqual([['not installed', 'GET /api/connections: ollama-local'], ['checked', 'GET /api/connections: ollama-local']]);
    await page.close();
  }, 60_000);

  it('without TimmyRive on the page (R11 round 6): every card still carries its empty host, hidden by the sheet; the words, the buttons and the state words are the same', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/?bare=1`);
    await page.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    expect(await page.evaluate(() => typeof (window as unknown as { TimmyRive?: unknown }).TimmyRive)).toBe('undefined');
    const hosts = await page.locator('.cn-card > .cn-rive').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-rive-host'), empty: e.childNodes.length === 0, display: getComputedStyle(e).display })));
    expect(hosts).toEqual(['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'].map((id) => ({ id, empty: true, display: 'none' })));
    // the same companion, the same user (the cases above saved and checked a cloud key and checked the local Ollama): the words
    // with and without the module are the same — the titles, the state words, the words under them, every button
    const words = async (p: typeof page) => ({
      titles: await p.locator('.cn-card .cn-card-title').allTextContents(),
      states: await p.locator('.cn-card .cn-state-word').allTextContents(),
      under: await p.locator('.cn-card .cn-status-words').allTextContents(),
      buttons: await p.getByRole('button').allTextContents(),
      head: [await p.locator('.page-kicker').textContent(), await p.locator('h1').textContent(), await p.locator('.page-intro').textContent()],
    });
    const bare = await words(page);
    expect(bare.titles).toEqual(['OpenRouter', 'Ollama · local', 'Ollama · cloud', 'Cloudflare']);
    expect(bare.states.length).toBe(4);
    const withModule = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await withModule.goto(`${base}/`);
    await withModule.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    await withModule.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await withModule.locator('.cn-card .cn-rive [data-fake-rive="ProviderCard"]').count()).toBe(4);
    const full = await words(withModule);
    expect(bare).toEqual(full);
    expect(errors).toEqual([]);
    await withModule.close();
    await page.close();
  }, 60_000);

  it('390x844: one column, no horizontal overflow, the same words and buttons', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/`);
    await page.getByRole('heading', { level: 1, name: 'One model is enough to begin.' }).waitFor();
    const boxes = await page.locator('.cn-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }));
    expect(boxes.length).toBe(4);
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    expect(boxes.every((b) => b.w > 300 && b.w <= 390)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // R11 round 6: the ProviderCard's host stays within its card at a phone width (the component's own size is H174's)
    expect(await page.locator('.cn-card .cn-rive').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const c = e.closest('.cn-card')!.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right + 0.5; }))).toEqual([true, true, true, true]);
    // R11 round 7, 390×844: the shell's regions in order; the screen's cards in one column, the context's picker scrolls sideways
    // inside its box (the context's sheet and the band's stacking are the shell's, not drawn by this FAKE page)
    // (D8: the registered label carries no arrow; the shell's button draws the one →)
    await expect(page.getByRole('button', { name: /^(Set up a model|Continue to the workspace)$/ }).count()).resolves.toBe(1);
    const order = await page.locator('#screen-connections > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(order.every((t, i) => i === 0 || t >= order[i - 1])).toBe(true);
    expect(await page.locator('.cn-picker').evaluate((e) => e.scrollWidth <= e.clientWidth + 1 || getComputedStyle(e).overflowX === 'auto')).toBe(true);
    // D24 at 390: one accent fill (the head's primary), the recommended verb's accent ring
    await oneAccentFill(page, '390');
    // R102 at 390 (H168's pictures): the context for a card without the download offer — Ollama · cloud pressed — carries no stray word
    await page.locator('.cn-card-ollama-cloud .cn-card-title').click();
    expect(await page.locator('.cn-context-card').getAttribute('data-cn-context-for')).toBe('ollama-cloud');
    expect(await strayWords(page)).toEqual([]);
    await page.locator('.cn-card-ollama-local .cn-card-title').click();
    expect(await page.locator('.cn-context-card').getAttribute('data-cn-context-for')).toBe('ollama-local');
    expect(await strayWords(page)).toEqual([]);
    await page.close();
  }, 60_000);
});
