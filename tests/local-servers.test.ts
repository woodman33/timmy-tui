/**
 * Round R4 (H84): the browser companion (src/companion/server.ts, started by `timmy watch`) and the log companion
 * (src/utils/logserver.ts, `timmy logs`) are this computer's own. Each listens on 127.0.0.1 unless asked otherwise (the
 * companion on the network too only with --lan), answers only requests addressed to this computer from its own pages (Host
 * and Origin, src/utils/local-request.ts), and asks for its token, made when it starts, on everything that spends, writes or
 * streams the operator's content. A refused request makes no upstream call, writes nothing, and says what to do.
 *
 * Real HTTP on 127.0.0.1 (and on this computer's own network address where it has one), real WebSocket clients (`ws`), real
 * files in temporary folders. The model is a FAKE OpenRouter: an HTTP server on 127.0.0.1 that records what it is sent and
 * answers a canned stream. Nothing here calls a model or leaves this computer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { companionPairing, NO_NETWORK, showCompanionQR } from '../src/companion/qr.js';
import { folderWords, startManagedLogServer, type LogServerHandle } from '../src/utils/logserver.js';
import { isLocalRequest, lanAddresses, LocalToken, logsTokenFile } from '../src/utils/local-request.js';
import { readChain } from '../src/utils/receipts.js';
import { call, type Reply } from './helpers/canvas-auth.js';

const FAKE_KEY = 'FAKE-openrouter-key-for-tests-only';
/** A name another site could rebind to 127.0.0.1 (RFC 2606's reserved .example). */
const REBIND = 'timmy-rebind.example';
const tokenOf = (url: string): string => /#t=([0-9a-f]{64})$/.exec(url)?.[1] ?? '';
const auth = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const OTHER = 'ab'.repeat(32);

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

/** Every file under `dir`, recursively (for "the token is in none of them"). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** FAKE OpenRouter: records each request (its Authorization header and body) and streams two deltas, usage, then [DONE]. */
async function fakeOpenRouter(): Promise<{ url: string; seen: Array<{ auth: string; body: string }>; close: () => Promise<void> }> {
  const seen: Array<{ auth: string; body: string }> = [];
  const s: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      seen.push({ auth: String(req.headers.authorization ?? ''), body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE upstream ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }], usage: { total_tokens: 7 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/chat/completions`, seen, close: () => new Promise((r) => s.close(() => r())) };
}

/** A WebSocket attempt: opened (with the messages it got in `wait` ms, after an optional hello) or refused (status, words). */
async function wsTry(url: string, protocols: string[], o: { headers?: Record<string, string>; origin?: string; hello?: boolean; wait?: number } = {}): Promise<{ open: boolean; status?: number; body?: string; protocol?: string; messages: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(url, protocols, { headers: o.headers, origin: o.origin });
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => { try { messages.push(JSON.parse(String(d)) as Record<string, unknown>); } catch { /* not JSON */ } });
  return new Promise((resolve) => {
    ws.once('unexpected-response', (_q, r) => {
      let b = '';
      r.on('data', (c: Buffer) => { b += String(c); });
      r.on('end', () => resolve({ open: false, status: r.statusCode, body: b.trim(), messages }));
    });
    ws.once('error', () => resolve({ open: false, messages }));
    ws.once('open', () => {
      if (o.hello) ws.send(JSON.stringify({ type: 'hello' }));
      setTimeout(() => { const protocol = ws.protocol; ws.close(); resolve({ open: true, protocol, messages }); }, o.wait ?? 400);
    });
  });
}

/** An SSE response's first `ms` milliseconds (status and text), then the connection is dropped. */
function sseFor(port: number, path: string, headers: Record<string, string>, ms = 600, host = '127.0.0.1'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET', headers: { Host: `${host}:${port}`, ...headers }, setHost: false, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += String(c); });
      const t = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode ?? 0, text }); }, ms);
      res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode ?? 0, text }); });
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

const json = (body: unknown): { headers: Record<string, string>; body: string } => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const DOC = {
  nodes: [
    { id: 'cap', kind: 'capsule', objective: 'local servers gateway probe' },
    { id: 'h', kind: 'harness', harness: 'hyperframes', workspace: 'host-ephemeral' },
  ],
  edges: [{ from: 'h', to: 'cap', kind: 'harness' }],
};

const saved: Record<string, string | undefined> = {};
const ENV = ['TIMMY_REPO', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_HOME', 'TIMMY_LOGS_PORT', 'TIMMY_TUI_ACTIVE'];
const originalCwd = process.cwd();
let work = '';
let root = '';
let home = '';
let fake: Awaited<ReturnType<typeof fakeOpenRouter>>;
let companion: CompanionServer;
let logs: LogServerHandle;
let cport = 0;
let ctoken = '';
let ltoken = '';
const busFile = (): string => join(root, '.timmy', 'runs', 'timmy-events.jsonl');

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  work = temp('h84-work-');
  root = temp('h84-root-');
  home = temp('h84-home-');
  mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
  writeFileSync(busFile(), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'test.seeded', payload: { note: 'SYNTHETIC bus event' } })}\n`);
  process.env.TIMMY_REPO = root;
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  // R11 (H169, Phase 0 item 2): the page's Send asks the model chosen for this process (no fixed model of its own): a FAKE one
  process.env.OPENROUTER_MODEL = 'fake-maker/fake-local-servers-model';
  process.env.TIMMY_HOME = home;
  delete process.env.TIMMY_TUI_ACTIVE;
  process.chdir(work);
  fake = await fakeOpenRouter();
  // the controller the companion's emit calls: `timmy logs`, keeping its token for this user's programs (in the temporary home)
  logs = await startManagedLogServer({ port: 0, tokenFile: true });
  process.env.TIMMY_LOGS_PORT = String(logs.port);
  ltoken = tokenOf(logs.url);
  companion = await startCompanionServer(0, { upstream: fake.url });
  cport = (companion.httpServer.address() as AddressInfo).port;
  ctoken = tokenOf(companion.url);
}, 60_000);

afterAll(async () => {
  await companion?.shutdown();
  await logs?.stop();
  await fake?.close();
  process.chdir(originalCwd);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the rule and the token (src/utils/local-request.ts)', () => {
  const req = (host?: string, origin?: string): IncomingMessage => ({ headers: { ...(host !== undefined ? { host } : {}), ...(origin !== undefined ? { origin } : {}) } }) as IncomingMessage;

  it('answers 127.0.0.1, localhost and [::1] from this computer\'s pages, and no other name', () => {
    for (const h of ['127.0.0.1:3001', 'localhost:3001', '[::1]:3001', '127.0.0.1', 'LOCALHOST:1']) expect(isLocalRequest(req(h)), h).toBe(true);
    for (const h of [`${REBIND}:3001`, '', '127.0.0.1.timmy-rebind.example', `localhost.${REBIND}:3001`, '127.0.0.1:3001@x']) expect(isLocalRequest(req(h)), h).toBe(false);
    expect(isLocalRequest(req())).toBe(false);
    expect(isLocalRequest(req('127.0.0.1:3001', 'http://127.0.0.1:4337'))).toBe(true);
    for (const o of [`http://${REBIND}`, 'null', `http://127.0.0.1.${REBIND}`]) expect(isLocalRequest(req('127.0.0.1:3001', o)), o).toBe(false);
  });

  it('with --lan, also this computer\'s own network address as written (plain http), never a name', () => {
    const lan = lanAddresses();
    for (const a of lan) expect(a).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    const a = lan[0];
    if (!a) { console.warn('local-servers: this computer has no network address, so the --lan half of the rule did not run here'); return; }
    expect(isLocalRequest(req(`${a}:3001`))).toBe(false);
    expect(isLocalRequest(req(`${a}:3001`), lan)).toBe(true);
    expect(isLocalRequest(req(`${a}:3001`, `http://${a}:3001`), lan)).toBe(true);
    expect(isLocalRequest(req(`${a}:3001`, `https://${a}:3001`), lan)).toBe(false);
    expect(isLocalRequest(req(`${REBIND}:3001`), lan)).toBe(false);
    expect(isLocalRequest(req(`${a}.${REBIND}:3001`), lan)).toBe(false);
    expect(isLocalRequest(req(`${a}:3001`, `http://${REBIND}`), lan)).toBe(false);
  });

  it('the token: 32 random bytes; exactly its 64 hex in a Bearer header, or as one subprotocol beside the app\'s; found in an address', () => {
    const t = new LocalToken();
    expect(t.value).toMatch(/^[0-9a-f]{64}$/);
    expect(new LocalToken().value).not.toBe(t.value);
    expect(new LocalToken('not-a-token').value).toMatch(/^[0-9a-f]{64}$/);
    expect(new LocalToken(OTHER).value).toBe(OTHER);
    expect(t.bearer(`Bearer ${t.value}`)).toBe(true);
    for (const h of [t.value, `bearer ${t.value}`, `Bearer ${t.value.toUpperCase()}`, `Bearer ${t.value} `, `Bearer ${OTHER}`, `Bearer  ${t.value}`, undefined, [`Bearer ${t.value}`]]) expect(t.bearer(h)).toBe(false);
    expect(t.offered(`timmy-companion, timmy-token.${t.value}`, 'timmy-companion')).toBe('ok');
    expect(t.offered('timmy-companion', 'timmy-companion')).toBe('none');
    expect(t.offered(undefined, 'timmy-companion')).toBe('none');
    expect(t.offered(`timmy-token.${t.value}`, 'timmy-companion')).toBe('wrong');
    expect(t.offered(`timmy-companion, timmy-token.${OTHER}`, 'timmy-companion')).toBe('wrong');
    expect(t.offered(`timmy-companion, timmy-token.${t.value}, timmy-token.${t.value}`, 'timmy-companion')).toBe('wrong');
    expect(t.inAddress(`/x?t=${t.value}`)).toBe(true);
    expect(t.inAddress(`/x?t=${t.value.toUpperCase()}`)).toBe(true);
    expect(t.inAddress(`/x?t=%${t.value.charCodeAt(0).toString(16)}${t.value.slice(1)}`)).toBe(true);
    expect(t.inAddress(`/x?t=${OTHER}`)).toBe(false);
    expect(t.open('http://127.0.0.1:3001/')).toBe(`http://127.0.0.1:3001/#t=${t.value}`);
  });
});

describe('the browser companion (timmy watch)', () => {
  it('listens on 127.0.0.1 by default and gives its address with its token in the fragment, and no network address', async () => {
    expect((companion.httpServer.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(companion.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/);
    expect(companion.lanUrls).toEqual([]);
    const lan = lanAddresses()[0];
    // this computer's own network address: nothing listens there without --lan
    if (lan) await expect(fetch(`http://${lan}:${cport}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  });

  it('answers only this computer: a rebinding Host or another site\'s Origin is refused on every route, with the token or without', async () => {
    const routes: Array<[string, string, ReturnType<typeof json> | undefined]> = [
      ['GET', '/', undefined], ['GET', '/index.html', undefined], ['GET', '/api/canvas', undefined], ['GET', '/slate3d/receipts', undefined],
      ['GET', '/api/clerk-config', undefined], ['GET', '/api/cloudflare-workflows', undefined], ['GET', '/api/auth', undefined],
      ['POST', '/api/workflow/fusion', json({ prompt: 'x' })], ['POST', '/slate3d/emit', json({ action: 'compile', doc: DOC })],
    ];
    const before = readFileSync(busFile(), 'utf8');
    for (const [method, path, body] of routes) {
      for (const headers of [{ Host: `${REBIND}:${cport}` }, { Origin: `http://${REBIND}` }, { Host: `${REBIND}:${cport}`, ...auth(ctoken) }, { Origin: `http://${REBIND}`, ...auth(ctoken) }]) {
        const r = await call(cport, method, path, { headers: { ...(body?.headers ?? {}), ...headers }, body: body?.body });
        expect(r.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(String(r.json.error)).toMatch(/this computer/);
      }
    }
    expect(existsSync(join(work, '.timmy'))).toBe(false);
    expect(readFileSync(busFile(), 'utf8')).toBe(before);
  });

  it('the WebSocket upgrade from a rebinding Host or another site\'s Origin is refused, token or not, and sends nothing', async () => {
    const good = ['timmy-companion', `timmy-token.${ctoken}`];
    const byHost = await wsTry(`ws://127.0.0.1:${cport}/`, good, { headers: { Host: `${REBIND}:${cport}` }, hello: true });
    expect(byHost).toMatchObject({ open: false, status: 403 });
    const byOrigin = await wsTry(`ws://127.0.0.1:${cport}/`, good, { origin: `http://${REBIND}`, hello: true });
    expect(byOrigin).toMatchObject({ open: false, status: 403 });
    expect([...byHost.messages, ...byOrigin.messages]).toEqual([]);
  });

  it('/chat with a rebinding Host or another site\'s Origin is refused and the FAKE upstream receives nothing', async () => {
    for (const headers of [{ Host: `${REBIND}:${cport}`, ...auth(ctoken) }, { Origin: `http://${REBIND}`, ...auth(ctoken) }]) {
      const r = await call(cport, 'POST', '/chat', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ message: 'hello' }) });
      expect(r.status).toBe(403);
    }
    expect(fake.seen).toEqual([]);
  });

  it('without the token, /chat is refused, says what to do, and the FAKE upstream receives nothing', async () => {
    for (const headers of [{}, auth(OTHER), { Authorization: ctoken }, { Authorization: `Basic ${ctoken}` }]) {
      const r = await call(cport, 'POST', '/chat', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ message: 'hello' }) });
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer');
      expect(String(r.json.error)).toMatch(/timmy watch/);
    }
    expect(fake.seen).toEqual([]);
  });

  it('without the token, fusion and emit are refused and write nothing; receipts and the canvas are refused', async () => {
    const before = readFileSync(busFile(), 'utf8');
    const dispatchBefore = filesUnder(join(work, '.timmy', 'dispatch')).length;
    for (const headers of [{}, auth(OTHER)]) {
      const f = await call(cport, 'POST', '/api/workflow/fusion', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ prompt: 'x', models: ['m'] }) });
      expect(f.status).toBe(401);
      const e = await call(cport, 'POST', '/slate3d/emit', { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action: 'store', plan: {} }) });
      expect(e.status).toBe(401);
      for (const path of ['/slate3d/receipts', '/api/canvas', '/api/clerk-config', '/api/cloudflare-workflows', '/api/auth']) {
        const r = await call(cport, 'GET', path, { headers });
        expect(r.status, path).toBe(401);
        expect(String(r.json.error)).toMatch(/token/);
      }
    }
    expect(existsSync(join(work, '.timmy', 'receipts'))).toBe(false);
    expect(readFileSync(busFile(), 'utf8')).toBe(before);
    expect(filesUnder(join(work, '.timmy', 'dispatch')).length).toBe(dispatchBefore);
  });

  it('the token in an address is refused, even with the header too', async () => {
    for (const path of [`/slate3d/receipts?t=${ctoken}`, `/api/canvas?token=${ctoken}`, `/api/auth?x=${ctoken.toUpperCase()}`]) {
      const r = await call(cport, 'GET', path, { headers: auth(ctoken) });
      expect(r.status, path).toBe(401);
      expect(String(r.json.error)).toMatch(/never in an address/);
    }
    const ws = await wsTry(`ws://127.0.0.1:${cport}/?t=${ctoken}`, ['timmy-companion', `timmy-token.${ctoken}`]);
    expect(ws).toMatchObject({ open: false, status: 401 });
  });

  it('without the token the WebSocket is refused and sends no bus event; with it, the state and the bus tail arrive', async () => {
    for (const protocols of [[], ['timmy-companion'], ['timmy-companion', `timmy-token.${OTHER}`], [`timmy-token.${ctoken}`], ['timmy-companion', `timmy-token.${ctoken}`, `timmy-token.${OTHER}`]]) {
      const r = await wsTry(`ws://127.0.0.1:${cport}/`, protocols, { hello: true });
      expect(r, JSON.stringify(protocols)).toMatchObject({ open: false });
      expect(r.status).toBe(401);
      expect(r.body ?? '').toMatch(/token/);
      expect(r.messages).toEqual([]);
    }
    const ok = await wsTry(`ws://127.0.0.1:${cport}/`, ['timmy-companion', `timmy-token.${ctoken}`], { origin: `http://127.0.0.1:${cport}`, hello: true, wait: 800 });
    expect(ok.open).toBe(true);
    // the server answers with its own subprotocol, never the token
    expect(ok.protocol).toBe('timmy-companion');
    expect(ok.messages[0]).toEqual({ type: 'state', state: 'idle' });
    const tail = ok.messages.find((m) => m.type === 'bus.tail') as { events: Array<{ kind: string }> } | undefined;
    expect(tail?.events.map((e) => e.kind)).toContain('test.seeded');
  });

  it('with the token each works as before: /chat streams the FAKE upstream\'s answer, fusion writes its receipt, emit reaches the controller, receipts and the canvas answer', async () => {
    const chat = await call(cport, 'POST', '/chat', { headers: { 'Content-Type': 'application/json', ...auth(ctoken) }, body: JSON.stringify({ message: 'hello companion' }) });
    expect(chat.status).toBe(200);
    expect(chat.body).toContain('event: delta\ndata: "FAKE upstream "');
    expect(chat.body).toContain('event: delta\ndata: "answer"');
    expect(chat.body).toContain('event: usage');
    expect(chat.body).toContain('event: done');
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0].auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(fake.seen[0].body)).toMatchObject({ model: 'fake-maker/fake-local-servers-model', stream: true, messages: [{ role: 'user', content: 'hello companion' }] });

    const fusion = await call(cport, 'POST', '/api/workflow/fusion', { headers: { 'Content-Type': 'application/json', ...auth(ctoken) }, body: JSON.stringify({ prompt: 'SYNTHETIC fusion', models: ['m1'] }) });
    expect(fusion.status).toBe(200);
    expect(fusion.json.success).toBe(true);
    expect(filesUnder(join(work, '.timmy', 'receipts')).some((f) => f.endsWith('receipt.json'))).toBe(true);

    const before = readFileSync(busFile(), 'utf8');
    const emit = await call(cport, 'POST', '/slate3d/emit', { headers: { 'Content-Type': 'application/json', ...auth(ctoken) }, body: JSON.stringify({ action: 'compile', capsule: 'cap', doc: DOC }) });
    expect(emit.status).toBe(200);
    expect(emit.json).toMatchObject({ ok: true, action: 'compile', capsule: 'cap' });
    expect((emit.json.plans as unknown[]).length).toBe(1);
    const added = readFileSync(busFile(), 'utf8').slice(before.length);
    expect(added).toContain('"kind":"slate.emit.compile"');

    const receipts = await call(cport, 'GET', '/slate3d/receipts', { headers: auth(ctoken) });
    expect(receipts.status).toBe(200);
    expect(receipts.json.ok).toBe(true);
    const canvas = await call(cport, 'GET', '/api/canvas', { headers: auth(ctoken) });
    expect(canvas.status).toBe(200);
    expect(canvas.json).toMatchObject({ revision: 0, jobs: [] });
    const ok = await call(cport, 'GET', '/api/auth', { headers: auth(ctoken) });
    expect(ok.json).toEqual({ ok: true, lan: false });
  });

  it('the page itself is open: it carries no content of the operator\'s', async () => {
    const page = await call(cport, 'GET', '/');
    expect(page.status).toBe(200);
    // the page's own title since H132's workspace view (e0c9732): "TIMMY · companion" (was "TIMMY Browser Companion")
    expect(page.body).toContain('<title>TIMMY · companion</title>');
    expect(page.body).not.toContain(ctoken);
  });

  it('the token is in no log file, no receipt and not on the bus; the start words in the companion\'s log name the address without it', async () => {
    process.env.TIMMY_TUI_ACTIVE = 'true';
    try { showCompanionQR(companion); } finally { delete process.env.TIMMY_TUI_ACTIVE; }
    const log = join(work, 'logs', 'companion.log');
    expect(readFileSync(log, 'utf8')).toContain(`http://127.0.0.1:${cport}/`);
    expect(readFileSync(log, 'utf8')).toMatch(/press q/);
    // the one file that holds a token by design is `timmy logs`'s own, kept for this user's programs (mode 0600)
    const tokenFile = logsTokenFile(logs.port, process.env);
    const files = [...filesUnder(work), ...filesUnder(root), ...filesUnder(home), ...filesUnder(String(process.env.TIMMY_STORE ?? ''))].filter((f) => f !== tokenFile);
    expect(files).toContain(log);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text.includes(ctoken), f).toBe(false);
      expect(text.includes(ltoken), f).toBe(false);
    }
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe('the browser companion with --lan', () => {
  it('also listens on the network; there the page opens without the token and everything else needs it', async () => {
    const lanServer = await startCompanionServer(0, { lan: true, upstream: fake.url });
    try {
      expect((lanServer.httpServer.address() as AddressInfo).address).toBe('0.0.0.0');
      const token = tokenOf(lanServer.url);
      const addrs = lanAddresses();
      expect(lanServer.lanUrls).toEqual(addrs.map((a) => `http://${a}:${lanServer.port}/#t=${token}`));
      // on this computer it answers as without --lan
      expect((await call(lanServer.port, 'GET', '/api/auth', { headers: auth(token) })).json).toEqual({ ok: true, lan: true });
      const lan = addrs[0];
      if (!lan) { console.warn('local-servers: this computer has no network address, so the network half of the --lan check did not run here'); return; }
      const at = (path: string, headers: Record<string, string> = {}): Promise<Reply> => new Promise((resolve, reject) => {
        const req = request({ host: lan, port: lanServer.port, path, method: 'GET', headers: { Host: `${lan}:${lanServer.port}`, ...headers }, setHost: false, agent: false }, (res) => {
          let body = '';
          res.on('data', (c) => { body += String(c); });
          res.on('end', () => { let j: Record<string, unknown> = {}; try { j = JSON.parse(body) as Record<string, unknown>; } catch { /* page */ } resolve({ status: res.statusCode ?? 0, body, json: j, headers: res.headers }); });
        });
        req.on('error', reject);
        req.end();
      });
      expect((await at('/')).status).toBe(200);
      expect((await at('/api/canvas')).status).toBe(401);
      expect((await at('/slate3d/receipts')).status).toBe(401);
      expect((await at('/api/canvas', auth(token))).status).toBe(200);
      expect((await at('/api/canvas', { ...auth(token), Origin: `http://${lan}:${lanServer.port}` })).status).toBe(200);
      expect((await at('/api/canvas', { ...auth(token), Host: `${REBIND}:${lanServer.port}` })).status).toBe(403);
      expect((await at('/api/canvas', { ...auth(token), Origin: `http://${REBIND}` })).status).toBe(403);
      const refused = await wsTry(`ws://${lan}:${lanServer.port}/`, ['timmy-companion'], { origin: `http://${lan}:${lanServer.port}`, hello: true });
      expect(refused).toMatchObject({ open: false, status: 401, messages: [] });
      const opened = await wsTry(`ws://${lan}:${lanServer.port}/`, ['timmy-companion', `timmy-token.${token}`], { origin: `http://${lan}:${lanServer.port}`, hello: true, wait: 600 });
      expect(opened.open).toBe(true);
      expect(opened.messages.some((m) => m.type === 'bus.tail')).toBe(true);
      // /chat over the network without the token: refused, nothing sent upstream
      const seen = fake.seen.length;
      const chat = await new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ message: 'x' });
        const req = request({ host: lan, port: lanServer.port, path: '/chat', method: 'POST', headers: { Host: `${lan}:${lanServer.port}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }, setHost: false, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end(body);
      });
      expect(chat).toBe(401);
      expect(fake.seen.length).toBe(seen);
    } finally {
      await lanServer.shutdown();
    }
  });

  it('says plainly what the network address is, and never prints a network address or a QR code without --lan', () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try {
      showCompanionQR({ url: `http://127.0.0.1:3001/#t=${OTHER}`, lanUrls: [] });
      const local = lines.join('\n');
      expect(local).toContain(`http://127.0.0.1:3001/#t=${OTHER}`);
      expect(local).not.toMatch(/█|▀|▄/);
      for (const a of lanAddresses()) expect(local).not.toContain(a);
      lines.length = 0;
      const lanUrl = `http://${lanAddresses()[0] ?? 'the-network-address'}:3001/#t=${OTHER}`;
      showCompanionQR({ url: `http://127.0.0.1:3001/#t=${OTHER}`, lanUrls: [lanUrl] });
      const lan = lines.join('\n');
      expect(lan).toContain(lanUrl);
      expect(lan).toMatch(/plain HTTP/);
      expect(lan).toMatch(/QR code holds the token/);
      expect(lan).toMatch(/only on a network you trust/);
      expect(lan).toMatch(/█|▀|▄/);
      // --lan asked on a computer with no network address: said plainly, no address, no QR code
      lines.length = 0;
      showCompanionQR({ url: `http://127.0.0.1:3001/#t=${OTHER}`, lanUrls: [], host: '0.0.0.0' });
      expect(lines.join('\n')).toContain(NO_NETWORK);
      expect(lines.join('\n')).not.toMatch(/█|▀|▄/);
    } finally { console.error = orig; }
  });

  it('the monitor\'s pairing card: the address with its token; a QR code only for a network address', () => {
    const url = `http://127.0.0.1:3001/#t=${OTHER}`;
    const lanUrl = `http://${lanAddresses()[0] ?? 'the-network-address'}:3001/#t=${OTHER}`;
    expect(companionPairing(undefined)).toBeNull();
    expect(companionPairing({ lanUrls: [] })).toBeNull();
    const local = companionPairing({ url, lanUrls: [], host: '127.0.0.1' });
    expect(local?.qr).toBeNull();
    expect(local?.lines).toContain(url);
    expect(local?.lines.join(' ')).toMatch(/timmy watch --lan/);
    const lan = companionPairing({ url, lanUrls: [lanUrl], host: '0.0.0.0' });
    expect(lan?.qr).toBe(lanUrl);
    expect(lan?.lines.join(' ')).toMatch(/plain HTTP on your local network.*QR code holds the token.*only on a network you trust/);
    expect(companionPairing({ url, lanUrls: [], host: '0.0.0.0' })?.lines).toContain(NO_NETWORK);
  });
});

describe('the log companion (timmy logs)', () => {
  it('listens on 127.0.0.1 by default and gives its address with its token in the fragment', async () => {
    const own = await startManagedLogServer({ port: 0 });
    try {
      expect(own.host).toBe('127.0.0.1');
      expect(own.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{64}$/);
      const lan = lanAddresses()[0];
      if (lan) await expect(fetch(`http://${lan}:${own.port}/health`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
      // it keeps no token file unless asked (the CLI asks)
      expect(existsSync(logsTokenFile(own.port, process.env))).toBe(false);
    } finally { await own.stop(); }
  });

  // (the two event streams last: without the rule they would stream and never end)
  const CONTENT: Array<[string, string, ReturnType<typeof json> | undefined]> = [
    ['GET', '/receipts?stream=runs', undefined], ['GET', '/verify?stream=runs', undefined],
    ['GET', '/verify-receipt?stream=runs&id=x', undefined], ['GET', '/dispatch', undefined], ['GET', '/mission/escrows', undefined], ['GET', '/mission/theatre?folder=studio', undefined],
    ['POST', '/mission/compile', json({ doc: DOC })], ['POST', '/mission/store', json({ plan: {} })], ['POST', '/mission/inspect', json({ kind: 'merkle', pass: { leaves: [] } })],
    ['POST', '/dispatch/action', json({ id: 'x', action: 'collect' })], ['GET', '/chat/events', undefined], ['GET', '/events', undefined],
  ];

  it('a rebinding Host or another site\'s Origin is refused on every route, pages included', async () => {
    for (const [method, path, body] of [...CONTENT, ['GET', '/', undefined], ['GET', '/chat', undefined], ['GET', '/mission', undefined], ['GET', '/browser', undefined], ['GET', '/health', undefined]] as typeof CONTENT) {
      for (const headers of [{ Host: `${REBIND}:${logs.port}`, ...auth(ltoken) }, { Origin: `http://${REBIND}`, ...auth(ltoken) }]) {
        const r = await call(logs.port, method, path, { headers: { ...(body?.headers ?? {}), ...headers }, body: body?.body });
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    }
  });

  it('without the token, every route with session turns, receipts, events or plans, and every write, is refused and says what to do', async () => {
    mkdirSync(join(work, '.sessions'), { recursive: true });
    writeFileSync(join(work, '.sessions', 'h84.jsonl'), `${JSON.stringify({ role: 'user', content: 'SYNTHETIC session turn' })}\n`);
    const chain = readChain('runs').length;
    const dispatch = filesUnder(join(work, '.timmy', 'dispatch')).length;
    for (const [method, path, body] of CONTENT) {
      for (const headers of [{}, auth(OTHER)]) {
        const r = await call(logs.port, method, path, { headers: { ...(body?.headers ?? {}), ...headers }, body: body?.body });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(String(r.json.error)).toMatch(/timmy logs/);
        expect(r.body).not.toContain('SYNTHETIC session turn');
      }
    }
    // no companion.pair receipt for a refused events client, no plan stored
    expect(readChain('runs').length).toBe(chain);
    expect(filesUnder(join(work, '.timmy', 'dispatch')).length).toBe(dispatch);
    // the pages and the health check answer without it, and carry no content
    for (const path of ['/', '/chat', '/mission', '/browser']) {
      const r = await call(logs.port, 'GET', path);
      expect(r.status, path).toBe(200);
      expect(r.body).not.toContain(ltoken);
    }
    expect((await call(logs.port, 'GET', '/health')).json).toEqual({ ok: true, app: 'timmy-logs', port: logs.port });
  });

  it('with the token: /chat/events streams the session\'s turns, /events seals the pair once, a plan is stored; the token in an address is refused', async () => {
    const turns = await sseFor(logs.port, '/chat/events', auth(ltoken));
    expect(turns.status).toBe(200);
    expect(turns.text).toContain('SYNTHETIC session turn');
    const chain = readChain('runs').length;
    const events = await sseFor(logs.port, '/events', auth(ltoken), 300);
    expect(events.status).toBe(200);
    expect(readChain('runs').length).toBe(chain + 1);
    const health = await call(logs.port, 'GET', '/health', { headers: auth(ltoken) });
    // R4 (H92): its folder from ~ or by name (r23c: the page showed the absolute path), never the whole path
    expect(health.json).toMatchObject({ ok: true, folder: folderWords(process.cwd()) });
    expect(health.json).not.toHaveProperty('cwd');
    if (!String(health.json.folder).startsWith('~')) expect(health.body).not.toContain(process.cwd());
    const c = await call(logs.port, 'POST', '/mission/compile', { headers: { 'Content-Type': 'application/json', ...auth(ltoken) }, body: JSON.stringify({ doc: DOC }) });
    expect(c.json.ok).toBe(true);
    const s = await call(logs.port, 'POST', '/mission/store', { headers: { 'Content-Type': 'application/json', ...auth(ltoken) }, body: JSON.stringify({ plan: (c.json.plans as Array<{ plan: unknown }>)[0].plan }) });
    expect(s.json.ok).toBe(true);
    for (const path of [`/receipts?stream=runs&t=${ltoken}`, `/chat/events?token=${ltoken}`]) {
      const r = await call(logs.port, 'GET', path, { headers: auth(ltoken) });
      expect(r.status, path).toBe(401);
      expect(String(r.json.error)).toMatch(/never in an address/);
    }
  });

  it('keeps its token for this user\'s programs only when asked, mode 0600 with its pid, and removes it when it stops', async () => {
    const own = await startManagedLogServer({ port: 0, tokenFile: true });
    const file = logsTokenFile(own.port, process.env);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ token: tokenOf(own.url), pid: process.pid });
    await own.stop();
    expect(existsSync(file)).toBe(false);
  });
});
