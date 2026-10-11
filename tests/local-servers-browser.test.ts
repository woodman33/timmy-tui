/**
 * Round R4 (H84): the pages of the browser companion (`timmy watch`) and the log companion (`timmy logs`) under their tokens,
 * in a real headless Chromium against the real servers on 127.0.0.1. Opened with the address Timmy gives (the token in the
 * fragment), a page takes the token out of its address at once, keeps it in memory, and sends it in an Authorization header
 * on each request (the log pages' event streams too) and as a WebSocket subprotocol; opened without it, a page asks for
 * nothing and says how to open it from Timmy. The model is a FAKE OpenRouter on 127.0.0.1. Every request a page makes to
 * anywhere but its server is aborted. R4 (H92): the companion page asks nothing of anywhere else (its scripts, style sheet,
 * fonts and markdown parser are its server's: tests/companion-page-browser.test.ts); the `timmy logs` chat mirror still
 * imports Streamdown from esm.sh, aborted here, so only its own script runs. Skipped, saying so, where no Chromium or
 * Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { folderWords, startManagedLogServer } from '../src/utils/logserver.js';
import { publish } from '../src/bus/index.js';
import { appendReceipt } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('local-servers-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FAKE_KEY = 'FAKE-openrouter-key-for-browser-tests';
const OTHER = 'cd'.repeat(32);
const tokenOf = (url: string): string => /#t=([0-9a-f]{64})$/.exec(url)?.[1] ?? '';

/** What a page asked of its server: each request's method, path and query, and its Authorization header. */
interface Seen { method: string; path: string; auth: string }

describe.skipIf(!browserPath)('the browser companion and the log companion under their tokens, in a real browser', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const saved: Record<string, string | undefined> = {};
  const ENV = ['TIMMY_REPO', 'OPENROUTER_API_KEY', 'TIMMY_HOME', 'TIMMY_LOGS_OPEN'];
  const originalCwd = process.cwd();
  let browser: Browser;
  let fake: Server;
  let fakeUrl = '';
  const upstream: Array<{ auth: string; body: string }> = [];

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    const root = temp('h84b-root-');
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'runs', 'timmy-events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'test.browser-seeded', payload: { note: 'SYNTHETIC' } })}\n`);
    process.env.TIMMY_REPO = root;
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    process.env.TIMMY_HOME = temp('h84b-home-');
    process.env.TIMMY_LOGS_OPEN = '0';
    process.chdir(temp('h84b-work-'));
    // FAKE OpenRouter: records what it is sent, streams a canned answer
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        upstream.push({ auth: String(req.headers.authorization ?? ''), body });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE streamed ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }], usage: { total_tokens: 5 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/chat/completions`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
    process.chdir(originalCwd);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A page in a fresh context: requests to `base` go through (and are recorded), anything else is aborted; `serve` answers
   * the given paths of `base` with these files instead (a page of the test's own, on the server's origin).
   */
  async function open(base: string, address: string, serve: Record<string, { type: string; body: string }> = {}): Promise<{ page: Page; context: BrowserContext; seen: Seen[]; sockets: string[]; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const seen: Seen[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      if (url.origin !== base) return route.abort();
      const own = serve[url.pathname];
      if (own) return route.fulfill({ status: 200, contentType: own.type, body: own.body });
      // (a browser's own favicon request is not the page's)
      if (url.pathname !== '/favicon.ico') seen.push({ method: route.request().method(), path: url.pathname + url.search, auth: route.request().headers().authorization ?? '' });
      return route.continue();
    });
    const page = await context.newPage();
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(address);
    return { page, context, seen, sockets, errors };
  }

  it('the companion page opened with its token: the token leaves the address, the socket connects, the bus shows, and a chat answer streams from the FAKE upstream', async () => {
    const server: CompanionServer = await startCompanionServer(0, { upstream: fakeUrl });
    const base = `http://127.0.0.1:${server.port}`;
    const token = tokenOf(server.url);
    const { page, context, seen, sockets } = await open(base, server.url);
    try {
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      // the address no longer shows the token, and nothing kept it
      expect(await page.evaluate(() => location.href)).toBe(`${base}/`);
      expect(await page.evaluate(() => `${location.href} ${document.cookie} ${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)} ${history.length}`)).not.toContain(token);
      expect(await page.isHidden('#token-note')).toBe(true);
      // the bus, as the page shows it in its log
      await page.waitForFunction(() => /Event bus: \d+ recent events?, latest test\.browser-seeded/.test(document.getElementById('logs-list')?.textContent ?? ''), null, { timeout: 15_000 });
      // the socket's address carries no token (it went as a subprotocol)
      expect(sockets).toHaveLength(1);
      expect(sockets[0]).toBe(`ws://127.0.0.1:${server.port}/`);
      // a chat answer, streamed through the page's own chat call (the model chat's: src/companion/client/chat.js)
      const events = await page.evaluate(async () => {
        const out: Array<[string, unknown]> = [];
        await (window as unknown as { timmyCompanion: { chat: (m: unknown, on: (e: string, d: unknown) => void) => Promise<void> } }).timmyCompanion
          .chat([{ role: 'user', content: 'hello from the page' }], (e, d) => { out.push([e, d]); });
        return out;
      });
      expect(events.filter(([e]) => e === 'delta').map(([, d]) => d).join('')).toBe('FAKE streamed answer');
      expect(events.some(([e]) => e === 'usage')).toBe(true);
      expect(events.at(-1)).toEqual(['done', { ok: true }]);
      expect(upstream).toHaveLength(1);
      expect(upstream[0].auth).toBe(`Bearer ${FAKE_KEY}`);
      expect(JSON.parse(upstream[0].body).messages).toEqual([{ role: 'user', content: 'hello from the page' }]);
      // every request the page made with the token carried it in a header, never in its address
      for (const s of seen) expect(s.path).not.toContain(token);
      expect(seen.find((s) => s.path === '/chat')?.auth).toBe(`Bearer ${token}`);
      // the canvas tab reads through the token too (R4 H92: opened as a person opens it; its fade is the browser's own)
      await page.click('[data-tab="canvas"]');
      await page.waitForFunction(() => /Revision 0|No canvas jobs yet/.test(document.getElementById('canvas-summary')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(seen.find((s) => s.path === '/api/canvas')?.auth).toBe(`Bearer ${token}`);
      // Slate 3D's frame is given the token in its fragment, never in its address's query (R4 H92: when its tab is opened)
      expect(await page.evaluate(() => document.getElementById('slate3d-frame')?.getAttribute('src') ?? null)).toBeNull();
      await page.click('[data-tab="slate3d"]');
      const frame = await page.evaluate(() => (document.getElementById('slate3d-frame') as HTMLIFrameElement).getAttribute('src') ?? '');
      expect(frame).toBe(`/slate3d/?board=ledger#t=${token}`);
    } finally {
      await context.close();
      await server.shutdown();
    }
  });

  it('the companion page opened without its token asks for nothing and says how to open it; with a wrong token it says so and stops', async () => {
    const server = await startCompanionServer(0, { upstream: fakeUrl });
    const base = `http://127.0.0.1:${server.port}`;
    const before = upstream.length;
    const bare = await open(base, `${base}/`);
    try {
      await bare.page.waitForSelector('#token-note:not([hidden])');
      expect(await bare.page.textContent('#token-note')).toMatch(/no token from Timmy.*timmy watch.*press q on HOME/s);
      expect(await bare.page.textContent('#status-text')).toBe('COMPANION · NEEDS ITS TOKEN');
      await bare.page.waitForTimeout(1500);
      expect(bare.sockets).toEqual([]);
      // R4 (H92): the page's own files (its code, style sheet, theme, fonts and markdown parser), and nothing that needs the token
      expect(bare.seen.map((s) => s.path)).toContain('/');
      for (const s of bare.seen) expect(s.path).toMatch(/^\/(?:|[\w-]+\.(?:js|css)|vendor\/marked\.esm\.js|fonts\/[\w.-]+\.woff2)$/);
      for (const s of bare.seen) expect(s.auth).toBe('');
    } finally { await bare.context.close(); }
    const wrong = await open(base, `${base}/#t=${OTHER}`);
    try {
      await wrong.page.waitForFunction(() => /not the companion/.test(document.getElementById('token-note')?.textContent ?? ''), null, { timeout: 20_000 });
      expect(await wrong.page.evaluate(() => location.href)).toBe(`${base}/`);
      expect(await wrong.page.textContent('#status-text')).toBe('COMPANION · NEEDS ITS TOKEN');
      const tries = wrong.sockets.length;
      await wrong.page.waitForTimeout(4500);
      // no endless retries once the token was refused
      expect(wrong.sockets.length).toBe(tries);
    } finally {
      await wrong.context.close();
      await server.shutdown();
    }
    expect(upstream.length).toBe(before);
  });

  it('Slate 3D\'s bus (companion/slate3d/src/bus.js, as built into its page) takes the token from its fragment, joins the companion\'s socket with it and reads receipts with it; without it, it says so', async () => {
    const server = await startCompanionServer(0, { upstream: fakeUrl });
    const base = `http://127.0.0.1:${server.port}`;
    const token = tokenOf(server.url);
    // Slate 3D's own module from the repository (its three.js scene is not built here), loaded into a page this server
    // served (a page answered by the test itself would be held to Chromium's local network checks, which a served page is not).
    // R4 (H92): the test's own module is a file too, answered on the server's origin: the page's policy (script-src 'self')
    // refuses an inline script.
    const harness = [
      "import { connectBus, companionFetch, slateToken } from '/slate3d/bus.js';",
      'const result = { has: slateToken.length > 0, href: location.href, statuses: [], events: [], receipts: null };',
      'window.result = result;',
      "connectBus({ source: 'ws' }, (ev) => result.events.push(ev.kind), (st) => result.statuses.push(st.text));",
      "companionFetch('/slate3d/receipts?limit=5').then((r) => r.json(), () => 'failed').then((j) => { result.receipts = j; });",
    ].join('\n');
    const serve = {
      '/slate3d/bus.js': { type: 'text/javascript', body: readFileSync(new URL('../companion/slate3d/src/bus.js', import.meta.url), 'utf8') },
      '/slate3d/bus-test.js': { type: 'text/javascript', body: harness },
    };
    type Result = { has: boolean; href: string; statuses: string[]; events: string[]; receipts: unknown };
    const run = async (page: Page, fragment: string): Promise<void> => {
      // the address as Slate 3D's frame gets it: this server's page, with the token (or none) in its fragment
      await page.evaluate((frag) => history.replaceState(null, '', `/slate3d/?board=ledger${frag}`), fragment);
      // the module as Slate 3D's page imports it (a module script of the page's own)
      await page.addScriptTag({ type: 'module', url: '/slate3d/bus-test.js' });
      await page.waitForFunction(() => { const r = (window as unknown as { result?: Result }).result; return !!r && r.receipts !== null; }, null, { timeout: 20_000 });
    };
    const withToken = await open(base, `${base}/`, serve);
    try {
      await run(withToken.page, `#t=${token}`);
      await withToken.page.waitForFunction(() => (window as unknown as { result: Result }).result.events.includes('test.browser-seeded'), null, { timeout: 20_000 });
      const r = await withToken.page.evaluate(() => (window as unknown as { result: Result }).result);
      expect(r.has).toBe(true);
      expect(r.href).toBe(`${base}/slate3d/?board=ledger`);
      expect(r.statuses).toContain('bus live');
      expect(r.receipts).toMatchObject({ ok: true });
      expect(withToken.seen.find((s) => s.path.startsWith('/slate3d/receipts'))?.auth).toBe(`Bearer ${token}`);
      expect(withToken.sockets).toEqual([`ws://127.0.0.1:${server.port}/`]);
    } finally { await withToken.context.close(); }
    const without = await open(base, `${base}/`, serve);
    try {
      await run(without.page, '');
      await without.page.waitForTimeout(1000);
      const r = await without.page.evaluate(() => (window as unknown as { result: Result }).result);
      expect(r.has).toBe(false);
      expect(r.statuses.join(' ')).toMatch(/needs the companion's token/);
      expect(r.events).toEqual([]);
      expect(r.receipts).toMatchObject({ ok: false });
      expect(without.sockets).toEqual([]);
    } finally {
      await without.context.close();
      await server.shutdown();
    }
  });

  it('the `timmy logs` page opened with its token: the token leaves the address, the event stream and the chain arrive with it in a header, and its links carry it', async () => {
    const logs = await startManagedLogServer({ port: 0 });
    const base = `http://127.0.0.1:${logs.port}`;
    const token = tokenOf(logs.url);
    appendReceipt('runs', { kind: 'run', subject: 'SYNTHETIC browser receipt', policy: 'auto', status: 'ok' });
    const { page, context, seen } = await open(base, logs.url);
    try {
      await page.waitForFunction(() => document.getElementById('conn')?.textContent === 'live', null, { timeout: 20_000 });
      expect(await page.evaluate(() => location.href)).toBe(`${base}/`);
      await page.waitForFunction(() => /SYNTHETIC browser receipt/.test(document.getElementById('chain')?.textContent ?? ''), null, { timeout: 15_000 });
      // a new bus event reaches the page through the stream it reads with fetch
      publish('test.browser-live', { note: 'SYNTHETIC live event' });
      await page.waitForFunction(() => /test\.browser-live/.test(document.getElementById('events')?.textContent ?? ''), null, { timeout: 15_000 });
      // R4 (H92): its folder from ~ or by name (r23c: the absolute path), never the whole path
      expect(await page.textContent('#cwd')).toBe(folderWords(process.cwd()));
      if (!folderWords(process.cwd()).startsWith('~')) expect(await page.textContent('header')).not.toContain(process.cwd());
      for (const path of ['/events', '/receipts?stream=runs', '/health']) expect(seen.find((s) => s.path === path)?.auth, path).toBe(`Bearer ${token}`);
      for (const s of seen) expect(s.path).not.toContain(token);
      expect(await page.isHidden('#timmy-token-note')).toBe(true);
      // the mission studio, from its link (the token in the link's fragment), loads its escrows with it
      expect(await page.getAttribute('a[data-timmy-page="/mission"]', 'href')).toBe(`/mission#t=${token}`);
      await page.click('a[data-timmy-page="/mission"]');
      await page.waitForFunction(() => /arm one via the escrow engine/.test(document.getElementById('escrows')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(await page.evaluate(() => location.href)).toBe(`${base}/mission`);
      expect(seen.find((s) => s.path === '/mission/escrows')?.auth).toBe(`Bearer ${token}`);
      // the chat mirror (its Streamdown module comes from esm.sh, aborted here: only its own script runs) takes the token
      // out of its address too, and its link back to the full inspection carries it
      await page.goto(`${base}/chat#t=${token}`);
      expect(await page.evaluate(() => location.href)).toBe(`${base}/chat`);
      expect(await page.getAttribute('a[data-timmy-page="/"]', 'href')).toBe(`/#t=${token}`);
      expect(await page.isHidden('#timmy-token-note')).toBe(true);
    } finally {
      await context.close();
      await logs.stop();
    }
  });

  it('the `timmy logs` page opened without its token asks for nothing and says how to open it', async () => {
    const logs = await startManagedLogServer({ port: 0 });
    const base = `http://127.0.0.1:${logs.port}`;
    const { page, context, seen } = await open(base, `${base}/`);
    try {
      await page.waitForSelector('#timmy-token-note:not([hidden])');
      expect(await page.textContent('#timmy-token-note')).toMatch(/no token from Timmy.*timmy logs. prints and opens its address with its token/s);
      expect(await page.textContent('#conn')).toBe('needs its token');
      await page.waitForTimeout(1200);
      expect(seen.map((s) => s.path)).toEqual(['/']);
      // the chat mirror, opened without it, says so too
      await page.goto(`${base}/chat`);
      await page.waitForSelector('#timmy-token-note:not([hidden])');
      expect(await page.textContent('#timmy-token-note')).toMatch(/timmy logs. prints and opens its address with its token/);
    } finally {
      await context.close();
      await logs.stop();
    }
  });
});
