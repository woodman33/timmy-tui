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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      const handle = { id: 'fake-' + providerId + '-' + window.__mounts.length, component: 'connection', artboard: 'ProviderCard', binds: ['connection:' + providerId], events: [], word: null, root, unmount() { window.__unmounted += 1; const i = handles.indexOf(handle); if (i >= 0) handles.splice(i, 1); root.remove(); } };
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
body{margin:0;background:var(--timmy-ground);color:var(--timmy-text);font:15px/1.4 sans-serif}.sh-screen{height:100vh;overflow-y:auto}.sh-main{width:100%;max-width:1240px;margin:0 auto;padding:36px 48px;box-sizing:border-box}.sh-card{padding:28px;border:1px solid var(--timmy-line-strong);border-radius:6px;background:var(--timmy-surface)}.sh-btn,.sh-btn-primary,.sh-btn-text{font:inherit;cursor:pointer}.sh-btn{border:1px solid var(--timmy-line-strong);background:transparent;color:var(--timmy-text);padding:8px 14px}.sh-btn-primary{border:1px solid var(--timmy-accent);background:var(--timmy-accent);color:#000;padding:8px 14px}.sh-btn-text{border:0;background:transparent;color:var(--timmy-text);text-decoration:underline}.sh-input,.sh-select{font:inherit;padding:6px 10px;border:1px solid var(--timmy-line-strong);background:#000;color:var(--timmy-text)}.sh-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.sh-state.is-live{color:var(--timmy-live)}.sh-note{font-size:13px;color:var(--timmy-text-secondary)}.sh-head,.sh-foot{display:flex;justify-content:space-between;gap:16px;padding:16px 48px}.sh-steps{display:flex;gap:20px}@media (max-width:720px){.sh-main{padding:20px 16px}.sh-head,.sh-foot{padding:12px 16px}}</style>
<link rel="stylesheet" href="/screen-connections.css"></head><body>
<section class="sh-screen" id="screen-connections" data-screen="connections"></section>
<script>
// FAKE TimmyShell (this test's): the same surface as H171's shell; the FAKE user rides in a header the FAKE withUser reads
window.__went = []; window.__landed = 0; window.__toasts = [];
window.TimmyShell = {
  draws: {},
  mount(id, fn) { this.draws[id] = fn; const host = document.getElementById('screen-' + id); if (host) fn(host, this); },
  fetch(url, init) { const o = Object.assign({}, init || {}); o.headers = Object.assign({}, o.headers || {}, { 'X-FAKE-User': 'alice' }); o.cache = 'no-store'; return fetch(url, o); },
  h(tag, attrs, ...children) { const el = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v); } for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c))); return el; },
  go(id) { window.__went.push(id); }, land() { window.__landed += 1; }, toast(words, o) { window.__toasts.push({ words, live: !!(o && o.live) }); },
  session: { user: () => ({ id: 'alice', username: 'alice' }) },
};
</script>
__RIVE__<script src="/screen-connections.js"></script>
</body></html>`;
/** The page with the FAKE TimmyRive before the screen's script (the integrated page's order), or bare: no TimmyRive at all. */
const pageHtml = (rive: boolean): string => PAGE.replace('__RIVE__', rive ? `${FAKE_RIVE}\n` : '');

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
  const userEnv = (user: ConnectionsUser): Record<string, string | undefined> => {
    const home = join(root, 'users', user.id);
    for (const d of ['timmy', 'settings', 'mcp']) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
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
    await page.getByRole('heading', { level: 1, name: 'Choose how you want to run.' }).waitFor();
    expect(await page.locator('.cn-kicker').textContent()).toBe('CONNECT YOUR MODELS & TOOLS');
    expect(await page.locator('.cn-lead').textContent()).toBe('Pick one, connect all three, or explore first. You can change this later.');
    expect(await page.locator('.cn-card .cn-card-title').allTextContents()).toEqual(['OpenRouter', 'Ollama · local', 'Ollama · cloud', 'Cloudflare']);
    expect(await page.locator('.cn-card .cn-state-word').allTextContents()).toEqual(['not set up', 'not installed', 'not set up', 'not set up']);
    expect(await page.locator('.cn-foot-words .cn-strong').textContent()).toBe('Local logs are already part of the design.');
    expect(await page.locator('.cn-note').textContent()).toContain('Downloads require your explicit confirmation.');
    for (const name of ['Connect with OpenRouter ↗', 'Install Ollama', 'Download a local model', 'Set up local Ollama ↗', 'Sign in to Ollama ↗', 'Open Cloudflare setup ↗', 'Back', 'Explore without a model', 'Continue to the workspace →']) {
      await expect(page.getByRole('button', { name, exact: true }).count()).resolves.toBe(1);
    }
    // no card is "connected" and nothing is "free": a selection is never a connection
    const text = (await page.locator('#screen-connections').textContent()) ?? '';
    expect(text).not.toMatch(/\bconnected\b/i);
    expect(text).not.toMatch(/\bfree\b/i);
    // R11 round 6: the native ProviderCard's host in every card — the footer's first child, the state word right after it — mounted
    // once per card through TimmyRive.mountProviderCard(host, id, { size: 'wide', label }) (the FAKE's marker stands in the host)
    const hosts = await page.locator('.cn-card .cn-card-foot > .cn-rive:first-child').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-rive-host'), card: e.closest('.cn-card')?.getAttribute('data-provider'), next: e.nextElementSibling?.className ?? '', marker: e.querySelector('[data-fake-rive="ProviderCard"]')?.textContent ?? '' })));
    expect(hosts).toEqual(['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'].map((id) => ({ id, card: id, next: expect.stringContaining('cn-state'), marker: `FAKE ProviderCard ${id}` })));
    type Mount = { providerId: string; o: { size?: string; label?: string } | null };
    expect(await page.evaluate(() => (window as unknown as { __mounts: Mount[] }).__mounts)).toEqual([
      { providerId: 'openrouter', o: { size: 'wide', label: 'OpenRouter' } }, { providerId: 'ollama-local', o: { size: 'wide', label: 'Ollama · local' } },
      { providerId: 'ollama-cloud', o: { size: 'wide', label: 'Ollama · cloud' } }, { providerId: 'cloudflare', o: { size: 'wide', label: 'Cloudflare' } }]);
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
    // Ollama · cloud: the key pasted into the labelled password field, sent once in the body; the card says saved, not checked
    const keyField = page.getByLabel('Ollama API key', { exact: true });
    await keyField.fill(FAKE_KEY);
    await page.getByRole('button', { name: 'Save the key', exact: true }).click();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: 'saved, not checked' }).waitFor();
    expect(await page.locator('.cn-card-ollama-cloud .cn-say').textContent()).toMatch(/^Saved, not checked: the Ollama Cloud key \(key [0-9a-f]{12}\) is in providers\.json in the Timmy home \(0600\)\./);
    expect(await keyField.inputValue()).toBe('');
    expect(await page.content()).not.toContain(FAKE_KEY);
    expect(requests.some((u) => u.includes(FAKE_KEY))).toBe(false);
    expect(requests.every((u) => u.startsWith(base))).toBe(true);
    // its check: the FAKE ollama.com takes the key; the state is checked (green), the toast is the observed fact
    await page.getByRole('button', { name: 'Check the key', exact: true }).click();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await page.locator('.cn-card-ollama-cloud .cn-state').getAttribute('class')).toContain('is-live');
    const toasts = await page.evaluate(() => (window as unknown as { __toasts: Array<{ words: string; live: boolean }> }).__toasts);
    expect(toasts.at(-1)).toMatchObject({ live: true });
    expect(toasts.at(-1)!.words).toMatch(/^Checked just now: Ollama Cloud took the key/);
    // the two refreshes (the key saved, the key checked) fed the cloud card's two changes and nothing else: still four handles
    // (no re-mount: the host moved into each redrawn card), the other three cards unchanged, so unfed
    const after = await inspect();
    expect(after.map((x) => x.id)).toEqual(first.map((x) => x.id));
    expect(after[2].events.map((e) => [e.value, e.source])).toEqual([['not set up', 'GET /api/connections: ollama-cloud'], ['saved, not checked', 'GET /api/connections: ollama-cloud'], ['checked', 'GET /api/connections: ollama-cloud']]);
    expect(after[2].word).toBe('checked');
    expect([after[0], after[1], after[3]].map((x) => x.events.length)).toEqual([1, 1, 1]);
    expect(await page.locator('.cn-card-ollama-cloud .cn-card-foot > .cn-rive:first-child [data-fake-rive="ProviderCard"]').count()).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { __mounts: unknown[] }).__mounts.length)).toBe(4);
    // the footer's steps go where the shell says
    await page.getByRole('button', { name: 'Explore without a model', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to the workspace →', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __went: string[]; __landed: number }).__went)).toEqual(['chat', 'account']);
    expect(await page.evaluate(() => (window as unknown as { __landed: number }).__landed)).toBe(1);
    expect(asked.filter((a) => !a.startsWith('http://127.0.0.1:') && !a.startsWith('https://ollama.com/'))).toEqual([]);
    // the shell shows the screen again (a second draw): the four handles are unmounted first, then four fresh ones fed afresh
    await page.evaluate(() => { const sh = (window as unknown as { TimmyShell: { draws: Record<string, (host: Element, shell: unknown) => void> } }).TimmyShell; sh.draws.connections(document.getElementById('screen-connections')!, sh); });
    await page.getByRole('heading', { level: 1, name: 'Choose how you want to run.' }).waitFor();
    await page.locator('.cn-card-ollama-cloud .cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __unmounted: number }).__unmounted)).toBe(4);
    const again = await inspect();
    expect(again.length).toBe(4);
    expect(again.map((x) => x.id).some((id) => first.some((x) => x.id === id))).toBe(false);
    expect(again[2].events.map((e) => [e.value, e.source])).toEqual([['checked', 'GET /api/connections: ollama-cloud']]);
    await page.close();
  }, 60_000);

  it('Ollama · local: Check against the FAKE; the download names its size, waits for Confirm the download, shows progress to done; a second one is cancelled during the download', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/`);
    await page.getByRole('heading', { level: 1, name: 'Choose how you want to run.' }).waitFor();
    const card = page.locator('.cn-card-ollama-local');
    await card.getByRole('button', { name: 'Check', exact: true }).click();
    await card.locator('.cn-state-word').filter({ hasText: /^checked$/ }).waitFor();
    expect(await card.locator('.cn-words').textContent()).toMatch(/^Checked just now: Ollama answered at 127\.0\.0\.1:\d+ with local models \(no account, no charge\)\.$/);
    expect((await card.locator('.cn-lines').textContent()) ?? '').toContain('holds fake-qwen3:8b (5.2 GB)');
    // the download box: a name typed, the size asked (unknown: not a starter, not held), then the confirmation, then progress
    await card.getByRole('button', { name: 'Download a local model', exact: true }).click();
    await card.getByLabel('Another model name', { exact: true }).fill('fake-new:3b');
    await card.getByRole('button', { name: 'Show the size', exact: true }).click();
    const confirmBtn = card.getByRole('button', { name: 'Confirm the download', exact: true });
    await confirmBtn.waitFor();
    expect(await card.locator('.cn-pull-status').textContent()).toContain('fake-new:3b: size unknown');
    expect(ollama.seen).not.toContain('POST /api/pull');
    await confirmBtn.click();
    await card.locator('.cn-pull-status').filter({ hasText: /MB of .* MB/ }).waitFor();
    expect(await card.locator('.cn-pull-status').textContent()).toMatch(/\d+ MB of 4 MB · pulling FAKE-layer \(\d+%\)/);
    await card.locator('.cn-pull-status').filter({ hasText: 'Downloaded: Ollama lists fake-new:3b as installed now.' }).waitFor({ timeout: 10_000 });
    expect(ollama.installed.has('fake-new:3b')).toBe(true);
    // the second download, stalled by the FAKE, cancelled from the page: "Cancelled" in the words, nothing installed
    ollama.setStall(true);
    await card.getByLabel('Another model name', { exact: true }).fill('fake-second:1b');
    await card.getByRole('button', { name: 'Show the size', exact: true }).click();
    await card.getByRole('button', { name: 'Confirm the download', exact: true }).click();
    await card.locator('.cn-pull-status').filter({ hasText: /MB of .* MB/ }).waitFor();
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card.locator('.cn-pull-status').filter({ hasText: /^Cancelled/ }).waitFor();
    expect(await card.locator('.cn-pull-status').textContent()).toContain('Ollama keeps what it downloaded of fake-second:1b');
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
    await page.getByRole('heading', { level: 1, name: 'Choose how you want to run.' }).waitFor();
    expect(await page.evaluate(() => typeof (window as unknown as { TimmyRive?: unknown }).TimmyRive)).toBe('undefined');
    const hosts = await page.locator('.cn-card .cn-card-foot > .cn-rive:first-child').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-rive-host'), empty: e.childNodes.length === 0, display: getComputedStyle(e).display })));
    expect(hosts).toEqual(['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare'].map((id) => ({ id, empty: true, display: 'none' })));
    expect(await page.locator('.cn-card .cn-card-title').allTextContents()).toEqual(['OpenRouter', 'Ollama · local', 'Ollama · cloud', 'Cloudflare']);
    expect(await page.locator('.cn-card .cn-state-word').allTextContents()).toEqual(['not set up', 'not installed', 'not set up', 'not set up']);
    for (const name of ['Connect with OpenRouter ↗', 'Install Ollama', 'Download a local model', 'Check', 'Save the key', 'Save Cloudflare settings', 'Continue to the workspace →']) {
      await expect(page.getByRole('button', { name, exact: true }).count()).resolves.toBe(1);
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it('390x844: one column, no horizontal overflow, the same words and buttons', async () => {
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/`);
    await page.getByRole('heading', { level: 1, name: 'Choose how you want to run.' }).waitFor();
    const boxes = await page.locator('.cn-card').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }));
    expect(boxes.length).toBe(4);
    expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    expect(boxes.every((b) => b.w > 300 && b.w <= 390)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // R11 round 6: the ProviderCard's host stays within its card at a phone width (the component's own size is H174's)
    expect(await page.locator('.cn-card .cn-rive').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const c = e.closest('.cn-card')!.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right + 0.5; }))).toEqual([true, true, true, true]);
    await expect(page.getByRole('button', { name: 'Continue to the workspace →', exact: true }).count()).resolves.toBe(1);
    await page.close();
  }, 60_000);
});
