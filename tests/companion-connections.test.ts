/**
 * R11 round 4 (H170; contract C2): the browser companion's Connections routes (src/companion/connections.ts), end to end
 * over HTTP on 127.0.0.1 against FAKE servers only: a FAKE OpenRouter (its code exchange, the S256 challenge checked
 * against the verifier, and its key endpoint), a FAKE ollama.com (Ollama Cloud's model list with the key) and a FAKE
 * local Ollama (version, tags, ps, show, and a streamed pull that stops when the client goes away). Every request for
 * openrouter.ai or ollama.com is routed to the FAKEs; one for any other host fails the test; nothing is sent to Cloudflare.
 * The session is a FAKE withUser of this test (a header names the user), labelled so: C1's real verification is H173's and
 * is tested by H172; here the contract is the request's `user` and `userEnv`, each user's own Timmy home.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_WORDS, mountConnections, SCREEN_WORDS, type ConnectionsEvent, type ConnectionsUser, COST_WORDS, OFFER_WORDS } from '../src/companion/connections.js';
import { freeBytes, modelsDir, STARTER_MODELS, units } from '../src/setup/ollama-local.js';

/** The free-disk words confirmPull says on this box (a real measurement of the disk that holds Ollama's models, or none). */
const freeWords = (): string => { const f = freeBytes(modelsDir(process.env)); return f === null ? 'free space not known' : `${units(f)} free`; };
import { refuseRequest } from '../src/utils/local-request.js';

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** FAKE OpenRouter: the code exchange (S256 checked) and the key endpoint, on 127.0.0.1. Its authorization page is never visited here: the test plays the browser's return. */
function fakeOpenRouter() {
  const keys = new Set<string>();
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(`${req.method} ${u.pathname}`);
    if (req.method === 'POST' && u.pathname === '/api/v1/auth/keys') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body) as { code?: string; code_verifier?: string; code_challenge_method?: string };
        // the FAKE's codes carry the challenge they were issued for: FAKE-code-<challenge>
        const challenge = j.code?.startsWith('FAKE-code-') ? j.code.slice('FAKE-code-'.length) : undefined;
        if (j.code_challenge_method !== 'S256' || !challenge || !j.code_verifier || b64url(createHash('sha256').update(j.code_verifier).digest()) !== challenge) { res.writeHead(403); res.end('{}'); return; }
        const key = `FAKE-or-key-${randomBytes(8).toString('hex')}`;
        keys.add(key);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ key, user_id: null }));
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/v1/key') {
      const k = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (keys.has(k)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":{"label":"FAKE key"}}'); return; }
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"FAKE: no such key"}}');
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, keys, seen };
}

/** FAKE ollama.com: GET /api/tags with a key it knows. */
function fakeOllamaCom() {
  const keys = new Set<string>();
  const server: Server = createServer((req, res) => {
    const k = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.method === 'GET' && req.url === '/api/tags') {
      if (keys.has(k)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[{"name":"fake-cloud-model-a"},{"name":"fake-cloud-model-b"}]}'); return; }
      res.writeHead(401); res.end('{"error":"unauthorized"}');
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, keys };
}

/** FAKE local Ollama: FAKE model names, FAKE layers; the pull streams in steps and stops when the client goes away. */
function fakeOllama() {
  const installed = new Set<string>(['fake-qwen3:8b']);
  const seen: string[] = [];
  const TOTAL = 4000;
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
        const step = () => {
          if (res.destroyed) return;
          done = Math.min(TOTAL, done + 1000);
          line({ status: 'pulling FAKE-layer', digest: 'sha256:FAKE', total: TOTAL, completed: done });
          if (stall && done >= 2000) return; // waits: the client cancels
          if (done < TOTAL) { setTimeout(step, 10); return; }
          line({ status: 'success' });
          installed.add(model); res.end();
        };
        setTimeout(step, 10);
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, installed, seen, setStall: (s: boolean) => { stall = s; } };
}

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

const realFetch = globalThis.fetch;
let root = '';
let routes: Record<string, string> = {};
const asked: string[] = [];
/** Requests for openrouter.ai and ollama.com go to the FAKE servers; 127.0.0.1 is asked as it is; anything else fails. */
const routed = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  asked.push(`${u.origin}${u.pathname}`);
  const to = routes[u.origin];
  if (to) return realFetch(`${to}${u.pathname}${u.search}`, init);
  if (u.hostname === '127.0.0.1') return realFetch(input, init);
  throw new Error(`a request left this computer: ${u.origin}`);
}) as typeof fetch;

let openrouter: ReturnType<typeof fakeOpenRouter>;
let ollamaCom: ReturnType<typeof fakeOllamaCom>;
let ollama: ReturnType<typeof fakeOllama>;
let ollamaOrigin = '';
let companion: Server;
let base = '';
let mounted: ReturnType<typeof mountConnections>;
const events: Array<{ user: string } & ConnectionsEvent> = [];

/** FAKE withUser (this test's): the user named by a header; 401 without one. The real one (C1) verifies a session JWT. */
const fakeWithUser: express.RequestHandler = (req, res, next) => {
  const id = req.get('X-FAKE-User');
  if (!id) { refuseRequest(res, 401, 'FAKE withUser: no session on this request'); return; }
  (req as express.Request & { user?: ConnectionsUser }).user = id === 'operator' ? { id: 'operator', operator: true } : { id, username: `fake-${id}` };
  next();
};
/**
 * C1's userEnv as this test stands it in: the user's own Timmy home under <root>/users/<id>, with the companion's shell variables
 * passed through as identity/scope.ts userEnv passes them — OLLAMA_HOST among them, set to the FAKE Ollama here as the installed
 * companion's shell had it (H172's installed run, 18:21): a user's own address is the record in the user's home (recordOllama),
 * never this variable. The operator principal (as('operator')) is the one whose env this variable is.
 */
const userEnv = (user: ConnectionsUser): Record<string, string | undefined> => {
  const home = join(root, 'users', user.id);
  for (const d of ['timmy', 'settings', 'mcp']) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
  return { PATH: join(root, 'bin'), HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), TIMMY_MCP_HOME: join(home, 'mcp'), OLLAMA_HOST: ollamaOrigin, OPENROUTER_API_KEY: 'FAKE-env-key-that-must-never-count-0123', OLLAMA_API_KEY: 'FAKE-env-cloud-key-never-counted-4567' };
};
/** The user's own Ollama address, recorded in the user's providers.json (as `timmy init --ollama <host>` records it; saveKey keeps the field). */
const recordOllama = (user: string, host: string): void => {
  const home = join(root, 'users', user, 'timmy');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'providers.json');
  const body = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  writeFileSync(file, JSON.stringify({ ...body, ollama_host: host }, null, 2), { mode: 0o600 });
};
const as = (user: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined ?? {}), 'X-FAKE-User': user } });
const jsonOf = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;
const post = (path: string, user: string, body: unknown): Promise<Response> => realFetch(`${base}${path}`, as(user, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const cards = async (user: string): Promise<Record<string, Record<string, unknown>>> => {
  const j = await jsonOf(await realFetch(`${base}/api/connections`, as(user)));
  return Object.fromEntries((j.cards as Array<Record<string, unknown>>).map((c) => [String(c.id), c]));
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'h170-connections-'));
  mkdirSync(join(root, 'bin'));
  openrouter = fakeOpenRouter(); ollamaCom = fakeOllamaCom(); ollama = fakeOllama();
  routes = { 'https://openrouter.ai': await listen(openrouter.server), 'https://ollama.com': await listen(ollamaCom.server) };
  ollamaOrigin = await listen(ollama.server);
  asked.length = 0; events.length = 0;
  vi.stubGlobal('fetch', routed); // the local probe (src/agent/providers.ts) asks through the global fetch
  const app = express();
  mounted = mountConnections(app, { withUser: fakeWithUser, userEnv, fetch: routed, platform: 'linux', signInTimeoutMs: 60_000, confirmTimeoutMs: 60_000, notify: (user, e) => { events.push({ user, ...e }); } });
  companion = createServer(app);
  base = await listen(companion);
});
afterEach(async () => {
  mounted.close();
  vi.unstubAllGlobals();
  await Promise.all([close(companion), close(openrouter.server), close(ollamaCom.server), close(ollama.server)]);
  rmSync(root, { recursive: true, force: true });
});

/** Reads an SSE stream's events until one of `until` arrives (or the stream ends). */
async function sse(res: Response, until: string[], onEvent?: (name: string, data: Record<string, unknown>) => void | Promise<void>): Promise<Array<{ name: string; data: Record<string, unknown> }>> {
  const out: Array<{ name: string; data: Record<string, unknown> }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const ev = /^event: (.+)$/m.exec(block); const dat = /^data: (.+)$/m.exec(block);
      if (!ev || !dat) continue;
      const e = { name: ev[1], data: JSON.parse(dat[1]) as Record<string, unknown> };
      out.push(e);
      if (onEvent) await onEvent(e.name, e.data);
      if (until.includes(e.name)) { try { await reader.cancel(); } catch { /* closed */ } return out; }
    }
  }
  return out;
}

describe('the Connections routes: the four providers under the signed-in user\'s own home, FAKE servers on 127.0.0.1', () => {
  it('without a user every route refuses (401, words); the sign-in\'s callback alone carries no session and refuses an unknown state (410)', async () => {
    const none = await realFetch(`${base}/api/connections`);
    expect(none.status).toBe(401);
    expect((await jsonOf(none)).error).toContain('no session');
    for (const [method, path] of [['POST', '/api/connections/openrouter/start'], ['POST', '/api/connections/openrouter/check'], ['POST', '/api/connections/ollama-local/check'], ['POST', '/api/connections/ollama-local/pull'], ['POST', '/api/connections/ollama-local/pull/confirm'], ['POST', '/api/connections/ollama-local/pull/cancel'], ['POST', '/api/connections/ollama-cloud/key'], ['POST', '/api/connections/ollama-cloud/check'], ['POST', '/api/connections/cloudflare'], ['DELETE', '/api/connections/openrouter']] as const) {
      const r = await realFetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect([method, path, r.status]).toEqual([method, path, 401]);
    }
    const cb = await realFetch(`${base}/api/connections/openrouter/callback/not-a-state-anyone-knows?code=FAKE-code-x`);
    expect(cb.status).toBe(410);
    expect(await cb.text()).toContain('This sign-in has ended');
    expect(asked).toEqual([]);
  });

  it('GET /api/connections: the preview\'s words, four independent cards, each with H170\'s state word; nothing asked of any provider', async () => {
    const j = await jsonOf(await realFetch(`${base}/api/connections`, as('alice')));
    expect(j.ok).toBe(true);
    expect(j.schema).toBe('timmy.connections-screen/2');
    expect(j.screen).toEqual(SCREEN_WORDS);
    // R11 round 7: the order's words — one model is enough; the records line; the download offer said before anything is downloaded
    expect(SCREEN_WORDS.title).toBe('One model is enough to begin.');
    expect(SCREEN_WORDS.kicker).toBe('CONNECT A PROVIDER');
    expect(SCREEN_WORDS.records).toBe('Local records continue when cloud sync is unavailable.');
    expect(SCREEN_WORDS.footer).toBe('A Cloudflare account is optional. Provider selections are not connections.');
    // the summary band: the user's own route (none here: no key, no chosen model), the records (local; cloud logs off), nothing usable yet
    const sum = j.summary as { route: { ready: boolean; kind: string; label: string; note: string }; records: { local: true; cloudLogs: boolean; words: string; line: string }; usable: string[] };
    expect(sum.route.ready).toBe(false);
    expect(sum.route.note.length).toBeGreaterThan(10);
    expect(sum.records).toEqual({ local: true, cloudLogs: false, words: 'Local by default', line: SCREEN_WORDS.records });
    expect(sum.usable).toEqual([]);
    const c = j.cards as Array<Record<string, unknown>>;
    expect(c.map((x) => [x.id, x.title, x.subtitle, x.action])).toEqual([
      ['openrouter', 'OpenRouter', 'One account. Many model providers.', 'Connect with OpenRouter'],
      ['ollama-local', 'Ollama · local', 'On your computer', 'Set up local Ollama'],
      ['ollama-cloud', 'Ollama · cloud', 'Your Ollama account', 'Sign in to Ollama'],
      ['cloudflare', 'Cloudflare', 'Optional · gateway, agents and sync', 'Open Cloudflare setup'],
    ]);
    expect(c[1].buttons).toEqual(['Install Ollama', 'Download a local model']);
    expect(c.map((x) => x.state)).toEqual(['not set up', 'not installed', 'not set up', 'not set up']);
    // R11 round 7: each card's situation (the order's four and the two in between) with its verb-led action, in words
    expect(c.map((x) => [x.situation, x.situationWords, x.verb])).toEqual([
      ['no-account', 'No account', 'Connect with OpenRouter'],
      ['no-model', 'No downloaded model', 'Install Ollama'],
      ['no-account', 'No account', 'Save an Ollama key'],
      ['no-account', 'No account', 'Set up Cloudflare'],
    ]);
    expect(c.map((x) => x.model)).toEqual([true, true, true, false]);
    expect(c.map((x) => x.cost)).toEqual([COST_WORDS.openrouter, COST_WORDS['ollama-local'], COST_WORDS['ollama-cloud'], COST_WORDS.cloudflare]);
    expect((c[1].local as Record<string, unknown>).offer).toEqual(OFFER_WORDS);
    expect(OFFER_WORDS.hardware).toMatch(/a rule of thumb .* not a measurement of this computer/);
    // the process's own keys never count for a user: the env keys of userEnv's base are struck out
    expect(c[0].key).toBeUndefined();
    expect(c[2].key).toBeUndefined();
    expect(String(c[0].words)).toBe('No OpenRouter key is set up.');
    expect(String(c[1].next)).toMatch(/^Install it: /);
    expect((c[1].local as Record<string, unknown>).starters).toEqual(STARTER_MODELS.map((m) => ({ model: m.model, size: m.size, bytes: m.bytes, use: m.use, default: m.default })));
    expect((c[3].lines as string[])[2]).toBe('AI Gateway / model routing: not set (optional)');
    expect((c[3].lines as string[])[4]).toBe('Cloud logs: off; local logs are already part of the design');
    const text = JSON.stringify(j);
    expect(text).not.toContain('FAKE-env-key');
    expect(text).not.toContain('FAKE-env-cloud-key');
    expect(text).not.toMatch(/\bfree\b/i);
    expect(text).not.toMatch(/\bconnected\b/i);
    expect(asked).toEqual([]);
    for (const card of Object.values(CARD_WORDS)) expect(card.body.length).toBeGreaterThan(10);
    // R11 round 7 (the operator's 19:18 order, item 5): each card's ONE status sentence — plain words, no address, path, endpoint or command
    const list = Object.values(await cards('alice'));
    expect(list.map((c) => c.status)).toEqual(['No OpenRouter account yet.', 'Ollama is not installed on this computer.', 'No Ollama key saved yet.', 'Optional; nothing set up yet.']);
    for (const c of list) expect(String(c.status)).not.toMatch(/https?:|127\.0\.0\.1|\/api\/|\.json|curl |ollama serve|GET |\bconnected\b/i);
  });

  it('OpenRouter: the S256 PKCE sign-in through the companion\'s own callback: the verifier stays here, the code is exchanged with the FAKE, the key saved and observed, never shown; one state, one answer', async () => {
    const bad = await post('/api/connections/openrouter/start', 'alice', { callback: 'http://evil.example/api/connections/openrouter/callback' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toContain('this companion\'s own address');
    const start = await jsonOf(await post('/api/connections/openrouter/start', 'alice', { callback: `${base}/api/connections/openrouter/callback` }));
    expect(start.ok).toBe(true);
    const u = new URL(String(start.url));
    expect(u.origin).toBe('https://openrouter.ai');
    expect(u.pathname).toBe('/auth');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = u.searchParams.get('code_challenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cbUrl = new URL(u.searchParams.get('callback_url')!);
    expect(cbUrl.origin).toBe(base);
    expect(cbUrl.pathname).toMatch(/^\/api\/connections\/openrouter\/callback\/[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(start)).not.toMatch(/verifier/i);
    expect(mounted.pendingSignIns()).toBe(1);
    // the state is pending on the card while the browser is away
    expect((await cards('alice')).openrouter.state).toBe('pending');
    // the browser's return: the FAKE's code names the challenge it was issued for; the exchange checks the verifier against it
    const back = await realFetch(`${cbUrl.href}?code=FAKE-code-${challenge}`);
    expect(back.status).toBe(200);
    const pageText = await back.text();
    expect(pageText).toContain('Connected. Return to Timmy.');
    expect(pageText).not.toContain('FAKE-or-key');
    expect(openrouter.seen).toContain('POST /api/v1/auth/keys');
    expect(mounted.pendingSignIns()).toBe(0);
    // saved in alice's own providers.json (0600), observed (the exchange), the page told
    const file = join(root, 'users', 'alice', 'timmy', 'providers.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { openrouter_api_key: string };
    expect(openrouter.keys.has(saved.openrouter_api_key)).toBe(true);
    const c = await cards('alice');
    expect(c.openrouter.state).toBe('checked');
    expect(String(c.openrouter.words)).toMatch(/^Checked just now: OpenRouter took the key \(key [0-9a-f]{12}\) from providers\.json in the Timmy home \(0600\) \(issued by the sign-in \(the PKCE exchange\); no model was called\)\.$/);
    expect(c.openrouter.key).toEqual({ fingerprint: expect.stringMatching(/^key [0-9a-f]{12}$/), from: 'providers.json' });
    expect(JSON.stringify(c)).not.toContain(saved.openrouter_api_key);
    expect(events.at(-1)).toMatchObject({ user: 'alice', type: 'connections', provider: 'openrouter', state: 'checked' });
    // a second visit of the same state: 410; a start replaces a pending one; a decline (no code) saves nothing
    expect((await realFetch(`${cbUrl.href}?code=FAKE-code-${challenge}`)).status).toBe(410);
    const again = await jsonOf(await post('/api/connections/openrouter/start', 'alice', { callback: `${base}/api/connections/openrouter/callback` }));
    const declined = await realFetch(new URL(new URL(String(again.url)).searchParams.get('callback_url')!).href);
    expect(declined.status).toBe(200);
    expect(await declined.text()).toContain('The sign-in did not finish');
    expect(mounted.pendingSignIns()).toBe(0);
    // the key check: the FAKE key endpoint takes the key (no model called); the observation is written for this key
    const checked = await jsonOf(await post('/api/connections/openrouter/check', 'alice', {}));
    expect((checked.state as Record<string, unknown>).state).toBe('checked');
    expect(openrouter.seen).toContain('GET /api/v1/key');
    // forgetting it
    const gone = await jsonOf(await realFetch(`${base}/api/connections/openrouter`, as('alice', { method: 'DELETE' })));
    expect(gone.ok).toBe(true);
    expect((await cards('alice')).openrouter.state).toBe('not set up');
    // nothing left this computer: every request went to a FAKE on 127.0.0.1
    expect(asked.every((a) => a.startsWith('https://openrouter.ai/') || a.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('users are apart: bob sees nothing of alice\'s key, and his own sign-in does not touch hers', async () => {
    const start = await jsonOf(await post('/api/connections/openrouter/start', 'alice', { callback: `${base}/api/connections/openrouter/callback` }));
    const u = new URL(String(start.url));
    await realFetch(`${u.searchParams.get('callback_url')}?code=FAKE-code-${u.searchParams.get('code_challenge')}`);
    expect((await cards('alice')).openrouter.state).toBe('checked');
    expect((await cards('bob')).openrouter.state).toBe('not set up');
    expect(existsSync(join(root, 'users', 'bob', 'timmy', 'providers.json'))).toBe(false);
    const gone = await jsonOf(await realFetch(`${base}/api/connections/openrouter`, as('bob', { method: 'DELETE' })));
    expect(gone.removed).toBe(false);
    expect((await cards('alice')).openrouter.state).toBe('checked');
    // a body or a query naming a user changes nothing: the user is the session's
    const forged = await realFetch(`${base}/api/connections?clerk_user_id=alice`, as('bob'));
    expect(((await jsonOf(forged)).cards as Array<Record<string, unknown>>)[0].state).toBe('not set up');
  });

  it('users are apart on Ollama · local too: each Check asks the address the user\'s own home records, never the companion\'s OLLAMA_HOST; a Check\'s record and its event reach the asking principal only (H172\'s installed run, 18:21; the operator\'s 19:18 order, item 1)', async () => {
    // alice recorded the FAKE Ollama; bob recorded an address where nothing listens (as H172's second user did: 127.0.0.1:9);
    // carol recorded nothing. The companion's shell variable (userEnv's OLLAMA_HOST) names the FAKE for all three.
    const fakePort = new URL(ollamaOrigin).port;
    recordOllama('alice', ollamaOrigin);
    recordOllama('bob', '127.0.0.1:9');
    const before = ollama.seen.length;
    const a = (await jsonOf(await post('/api/connections/ollama-local/check', 'alice', {}))).state as Record<string, unknown>;
    expect(a.state).toBe('checked');
    expect(String(a.words)).toContain(`Ollama answered at 127.0.0.1:${fakePort}`);
    const afterAlice = ollama.seen.length;
    expect(afterAlice).toBeGreaterThan(before);
    // (1a) the CACHED result is alice's home's alone: state/connections.json under her Timmy home, none under bob's; bob's read —
    // GET /api/connections, what his page draws — carries nothing of alice's: no observation, no "Checked", not her port
    expect(existsSync(join(root, 'users', 'alice', 'timmy', 'state', 'connections.json'))).toBe(true);
    expect(existsSync(join(root, 'users', 'bob', 'timmy', 'state', 'connections.json'))).toBe(false);
    const bobRead = (await cards('bob'))['ollama-local'];
    expect(bobRead.state).toBe('not installed');
    expect(bobRead.at).toBeUndefined();
    expect(String(bobRead.words)).not.toMatch(/Checked|answered/);
    expect(String(bobRead.words)).not.toContain(`127.0.0.1:${fakePort}`);
    expect(bobRead.status).toBe('Ollama is not installed on this computer.');
    // (1b) the EVENT a Check emits — notify(userId, { type: 'connections', … }), which server.ts sends over the companion WebSocket
    // to the sockets whose verified hello session is that user — named alice alone: bob's queue is empty
    expect(events.filter((e) => e.provider === 'ollama-local').map((e) => [e.user, e.state])).toEqual([['alice', 'checked']]);
    expect(events.filter((e) => e.user === 'bob')).toEqual([]);
    // bob: his own address, nothing there — not alice's answer, and nothing asked of the FAKE
    const b = (await jsonOf(await post('/api/connections/ollama-local/check', 'bob', {}))).state as Record<string, unknown>;
    expect(b.state).toBe('not installed');
    expect(String(b.words)).toMatch(/nothing answered at 127\.0\.0\.1:9 when checked just now/);
    expect(String(b.words)).not.toContain(`127.0.0.1:${fakePort}`);
    expect(ollama.seen.length).toBe(afterAlice);
    // bob's Check wrote bob's record, under bob's home; its event went to bob alone; alice's record and her one event stand
    expect(existsSync(join(root, 'users', 'bob', 'timmy', 'state', 'connections.json'))).toBe(true);
    expect(events.filter((e) => e.provider === 'ollama-local').map((e) => [e.user, e.state])).toEqual([['alice', 'checked'], ['bob', 'not installed']]);
    expect((await cards('alice'))['ollama-local'].state).toBe('checked');
    // carol: no record of her own → Ollama's default address, never the companion's variable; nothing asked of the FAKE
    const c = (await jsonOf(await post('/api/connections/ollama-local/check', 'carol', {}))).state as Record<string, unknown>;
    expect(String(c.words)).toContain('127.0.0.1:11434');
    expect(String(c.words)).not.toContain(`127.0.0.1:${fakePort}`);
    expect(ollama.seen.length).toBe(afterAlice);
    // each card reads its own observation: alice's stays checked at the FAKE, bob's and carol's name their own addresses
    expect((await cards('alice'))['ollama-local']).toMatchObject({ state: 'checked', local: expect.objectContaining({ address: ollamaOrigin }) });
    expect((await cards('bob'))['ollama-local']).toMatchObject({ state: 'not installed', local: expect.objectContaining({ address: 'http://127.0.0.1:9' }) });
    expect(String((await cards('bob'))['ollama-local'].words)).not.toContain(`127.0.0.1:${fakePort}`);
    expect((await cards('carol'))['ollama-local']).toMatchObject({ local: expect.objectContaining({ address: 'http://127.0.0.1:11434' }) });
    // the operator principal keeps the companion's own variable (its env is the companion's: identity/scope.ts userEnv)
    expect((await cards('operator'))['ollama-local']).toMatchObject({ local: expect.objectContaining({ address: ollamaOrigin }) });
  });

  it('Ollama · cloud: a key pasted into the body is saved under the user\'s home and never echoed; checked only against the FAKE ollama.com; forgotten on DELETE', async () => {
    const bad = await post('/api/connections/ollama-cloud/key', 'alice', { key: 'short' });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toContain('20 to 512 characters');
    const key = `FAKE-ollama-cloud-key-${randomBytes(8).toString('hex')}`;
    ollamaCom.keys.add(key);
    const saved = await jsonOf(await post('/api/connections/ollama-cloud/key', 'alice', { key }));
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(saved.fingerprint).toMatch(/^key [0-9a-f]{12}$/);
    expect(String(saved.words)).toMatch(/^Saved, not checked: /);
    expect((saved.state as Record<string, unknown>).state).toBe('saved, not checked');
    const file = join(root, 'users', 'alice', 'timmy', 'providers.json');
    expect((JSON.parse(readFileSync(file, 'utf8')) as { ollama_cloud_api_key: string }).ollama_cloud_api_key).toBe(key);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const checked = await jsonOf(await post('/api/connections/ollama-cloud/check', 'alice', {}));
    expect((checked.state as Record<string, unknown>).state).toBe('checked');
    expect(String((checked.state as Record<string, unknown>).words)).toContain('it lists 2 models; none was run');
    expect((await cards('bob'))['ollama-cloud'].state).toBe('not set up');
    const gone = await jsonOf(await realFetch(`${base}/api/connections/ollama-cloud`, as('alice', { method: 'DELETE' })));
    expect(gone.removed).toBe(true);
    expect((await cards('alice'))['ollama-cloud'].state).toBe('not set up');
    expect(asked.filter((a) => a.startsWith('https://ollama.com/'))).toEqual(['https://ollama.com/api/tags']);
  });

  it('Ollama · local: the check asks the FAKE Ollama on this computer; the download says its size, waits for the confirmation, streams progress to done', async () => {
    recordOllama('alice', ollamaOrigin);
    const checked = await jsonOf(await post('/api/connections/ollama-local/check', 'alice', {}));
    const s = checked.state as Record<string, unknown>;
    expect(s.state).toBe('checked');
    expect(String(s.words)).toMatch(/^Checked just now: Ollama answered at 127\.0\.0\.1:\d+ with local models \(no account, no charge\)\.$/);
    expect(ollama.seen).toEqual(expect.arrayContaining(['GET /api/version', 'GET /api/tags', 'GET /api/ps']));
    expect(ollama.seen).not.toContain('POST /api/pull');
    // the pull of a model the library has and this FAKE does not hold yet (not a starter: no catalog size, no disk rule):
    // size unknown, then it waits for the confirmation, then the FAKE streams its layers to done
    const res = await post('/api/connections/ollama-local/pull', 'alice', { model: 'fake-new:3b' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    let id = '';
    const got = await sse(res, ['done', 'cancelled', 'error'], async (name, data) => {
      if (name === 'size') {
        id = String(data.id);
        expect(data).toMatchObject({ model: 'fake-new:3b', bytes: null, size: 'size unknown', from: 'unknown' });
        expect(String(data.words)).toContain('Confirm to download it into the Ollama on this computer');
        expect(ollama.seen).not.toContain('POST /api/pull'); // nothing downloaded before the confirmation
      }
      if (name === 'waiting') {
        // bob cannot confirm alice's download; alice can
        expect((await post('/api/connections/ollama-local/pull/confirm', 'bob', { id })).status).toBe(404);
        const c = await jsonOf(await post('/api/connections/ollama-local/pull/confirm', 'alice', { id }));
        expect(c.ok).toBe(true);
        expect(String(c.words)).toBe('Download fake-new:3b (size not known (not a starter model); free space not known). Ollama downloads it from its library; nothing else is installed.'.replace('free space not known', freeWords()));
      }
    });
    expect(got.map((e) => e.name).slice(0, 3)).toEqual(['size', 'waiting', 'confirmed']);
    expect(got.filter((e) => e.name === 'progress').length).toBeGreaterThan(1);
    expect(got.at(-1)!.name).toBe('done');
    expect(String(got.at(-1)!.data.words)).toContain('fake-new:3b');
    expect(ollama.seen).toContain('POST /api/pull');
    expect(ollama.installed.has('fake-new:3b')).toBe(true);
    expect(mounted.pendingPulls()).toBe(0);
    // a starter model: its size from the catalog, and the disk rule at the confirmation (confirmPull): refused in words when
    // the disk that holds Ollama's models lacks room for it with a tenth to spare (as this container's may), else confirmed
    const starter = STARTER_MODELS.find((m) => m.default)!;
    const free = freeBytes(modelsDir(process.env));
    const room = free === null || free >= starter.bytes * 1.1;
    const st = await post('/api/connections/ollama-local/pull', 'alice', { model: starter.model });
    const starterEvents = await sse(st, room ? ['confirmed', 'error'] : ['error', 'confirmed'], async (name, data) => {
      if (name === 'size') expect(data).toMatchObject({ model: starter.model, bytes: starter.bytes, size: starter.size, from: 'the starter catalog' });
      if (name === 'waiting') {
        const c = await jsonOf(await post('/api/connections/ollama-local/pull/confirm', 'alice', { id: String(data.id) }));
        if (room) expect(c.ok).toBe(true);
        else { expect(c.ok).toBe(false); expect(String(c.error)).toMatch(/^Not enough free disk for .* free where Ollama keeps its models\. Free some space, or choose a smaller model\.$/); expect(String(c.error)).toContain(`${starter.model} (${starter.size})`); }
      }
    });
    if (room) { expect(starterEvents.at(-1)!.name).toBe('confirmed'); await post('/api/connections/ollama-local/pull/cancel', 'alice', { id: String(starterEvents[0].data.id) }); }
    else expect(starterEvents.at(-1)).toMatchObject({ name: 'error', data: { words: expect.stringMatching(/^Not enough free disk/) } });
    process.stdout.write(`the starter's confirmation on this box: ${room ? 'confirmed (room on the disk)' : 'refused in words (the disk lacks room: a real measurement, not a FAKE)'}\n`);
    // a model the FAKE holds already: its size from /api/show
    const held = await post('/api/connections/ollama-local/pull', 'alice', { model: 'fake-qwen3:8b' });
    const sizeHeld = (await sse(held, ['waiting']))[0];
    expect(sizeHeld.data).toMatchObject({ bytes: 5_200_000_000, from: 'Ollama (/api/show: it holds this model already)' });
    await post('/api/connections/ollama-local/pull/cancel', 'alice', { id: String(sizeHeld.data.id) });
    expect(mounted.pendingPulls()).toBe(0);
  });

  it('Ollama · local: Cancel before the confirmation downloads nothing; Cancel during the download aborts it (the FAKE stops), and Ollama keeps what it got', async () => {
    recordOllama('alice', ollamaOrigin);
    const res = await post('/api/connections/ollama-local/pull', 'alice', { model: 'fake-new:3b' });
    const first = await sse(res, ['cancelled'], async (name, data) => {
      if (name === 'waiting') {
        const c = await jsonOf(await post('/api/connections/ollama-local/pull/cancel', 'alice', { id: String(data.id) }));
        expect(String(c.words)).toBe('Cancelled before it started: fake-new:3b was not downloaded.');
      }
    });
    expect(first.at(-1)).toMatchObject({ name: 'cancelled', data: { words: 'Cancelled before it started: fake-new:3b was not downloaded.' } });
    expect(ollama.seen).not.toContain('POST /api/pull');
    ollama.setStall(true);
    const res2 = await post('/api/connections/ollama-local/pull', 'alice', { model: 'fake-new:3b' });
    let cancelledWords = '';
    const second = await sse(res2, ['cancelled', 'done', 'error'], async (name, data) => {
      if (name === 'waiting') await post('/api/connections/ollama-local/pull/confirm', 'alice', { id: String(data.id) });
      if (name === 'progress' && Number(data.done) >= 2000) {
        const c = await jsonOf(await post('/api/connections/ollama-local/pull/cancel', 'alice', { id: String(data.id) }));
        cancelledWords = String(c.words);
      }
    });
    expect(cancelledWords).toContain('Cancelling: Ollama keeps what it downloaded of fake-new:3b');
    expect(second.at(-1)!.name).toBe('cancelled');
    expect(String(second.at(-1)!.data.words)).toContain('Ollama keeps what it downloaded of fake-new:3b');
    expect(ollama.installed.has('fake-new:3b')).toBe(false);
    expect(mounted.pendingPulls()).toBe(0);
    // a second download while one is under way is refused; a name that is not a model is refused
    expect((await post('/api/connections/ollama-local/pull', 'alice', { model: 'not a model name' })).status).toBe(400);
    // DELETE has nothing to forget for the local Ollama
    const del = await realFetch(`${base}/api/connections/ollama-local`, as('alice', { method: 'DELETE' }));
    expect(del.status).toBe(400);
    expect((await jsonOf(del)).error).toContain('nothing is kept for Ollama (this computer)');
  });

  it('Cloudflare: optional settings in the user\'s home, nothing sent to Cloudflare; https only, no credential in the address; removable', async () => {
    const http = await post('/api/connections/cloudflare', 'alice', { gatewayUrl: 'http://gateway.ai.cloudflare.com/v1/acct/gw' });
    expect(http.status).toBe(400);
    expect((await jsonOf(http)).error).toContain('https');
    const cred = await post('/api/connections/cloudflare', 'alice', { gatewayUrl: 'https://name:pw@gateway.example.com/v1/acct/gw' });
    expect(cred.status).toBe(400);
    expect((await jsonOf(cred)).error).toContain('a credential never goes into a URL');
    const saved = await jsonOf(await post('/api/connections/cloudflare', 'alice', { gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/FAKE-account/FAKE-gateway', cloudLogs: true }));
    expect(saved.ok).toBe(true);
    expect(saved.settings).toMatchObject({ gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/FAKE-account/FAKE-gateway', cloudLogs: true });
    expect(saved.lines).toEqual([
      'AI Gateway / model routing: set (gateway.ai.cloudflare.com); used only when a model call is routed through it; not checked here',
      'Cloud logs: on (a copy of the run events is to be synced; the local logs stay the record)',
    ]);
    expect(String(saved.words)).toContain('Sends nothing: Timmy reads Cloudflare\'s settings only');
    expect(String(saved.words)).toContain('Local logs are already part of the design.');
    const file = join(root, 'users', 'alice', 'timmy', 'state', 'cloudflare.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const c = await cards('alice');
    expect((c.cloudflare.cloudflare as Record<string, unknown>).gatewayUrl).toContain('FAKE-gateway');
    expect(c.cloudflare.state).toBe('saved, not checked');
    expect((c.cloudflare.lines as string[])[2]).toContain('AI Gateway / model routing: set');
    expect((await cards('bob')).cloudflare.cloudflare).toMatchObject({ gatewayUrl: null, cloudLogs: false });
    // logs off again, the gateway kept
    const off = await jsonOf(await post('/api/connections/cloudflare', 'alice', { cloudLogs: false }));
    expect(off.settings).toMatchObject({ gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/FAKE-account/FAKE-gateway', cloudLogs: false });
    const gone = await jsonOf(await realFetch(`${base}/api/connections/cloudflare`, as('alice', { method: 'DELETE' })));
    expect(gone.removed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect((await cards('alice')).cloudflare.state).toBe('not set up');
    expect(asked.filter((a) => /cloudflare/.test(a))).toEqual([]);
  });
});
