/**
 * R10 (H170; CHAT-H170 items 2, 4, 5, 6): the provider states and their checks, end to end against FAKE servers on 127.0.0.1
 * only. A FAKE OpenRouter plays its authorization page (GET /auth: a redirect back with a code), its code exchange (POST
 * /api/v1/auth/keys: the S256 challenge checked against the verifier) and its key endpoint (GET /api/v1/key); a FAKE
 * ollama.com plays Ollama Cloud's model list (GET /api/tags with the key). Every request for openrouter.ai or ollama.com is
 * routed to them, and any other request fails the test: nothing here reaches a provider, an account or the network.
 *
 * What each state shows is read in words: a pasted key is "saved, not checked" until a check answers; "checked" carries
 * its time; a revoked key is "refused"; no network is "unreachable"; the sign-in saves a key like a pasted one, and Cancel,
 * a timeout, a declined sign-in and a refused exchange each save nothing. A key never appears in a state's words.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkProvider, CONNECTIONS_SCHEMA, describeCheck, forgetKey, keyWhere, MANUAL_WORDS, providerState, providerStates, readObservations, saveKey, startOpenRouterSignIn,
} from '../src/setup/providers-state.js';
import { checkKeyShape, keyInUse } from '../src/setup/provider-keys.js';
import { authorizationUrl, pkcePair } from '../src/setup/openrouter-signin.js';

const realFetch = globalThis.fetch;
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** FAKE OpenRouter: the authorization page, the exchange and the key endpoint, on 127.0.0.1. */
function fakeOpenRouter(mode: { decline?: boolean; exchange?: 403 | 500 } = {}) {
  const codes = new Map<string, string>(); // code -> challenge
  const keys = new Set<string>();
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push(`${req.method} ${u.pathname}`);
    if (req.method === 'GET' && u.pathname === '/auth') {
      const cb = u.searchParams.get('callback_url') ?? '';
      if (u.searchParams.get('code_challenge_method') !== 'S256' || !u.searchParams.get('code_challenge')) { res.writeHead(400); res.end(); return; }
      if (mode.decline) { res.writeHead(302, { Location: cb }); res.end(); return; }
      const code = `FAKE-code-${randomBytes(6).toString('hex')}`;
      codes.set(code, u.searchParams.get('code_challenge')!);
      res.writeHead(302, { Location: `${cb}?code=${code}` }); res.end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/v1/auth/keys') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (mode.exchange) { res.writeHead(mode.exchange, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"FAKE refusal"}}'); return; }
        const j = JSON.parse(body) as { code?: string; code_verifier?: string; code_challenge_method?: string };
        if (j.code_challenge_method !== 'S256') { res.writeHead(400); res.end('{}'); return; }
        const challenge = j.code ? codes.get(j.code) : undefined;
        if (!challenge || !j.code_verifier || b64url(createHash('sha256').update(j.code_verifier).digest()) !== challenge) { res.writeHead(403); res.end('{}'); return; }
        codes.delete(j.code!);
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
  return { server, codes, keys, seen };
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

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const close = (s: Server): Promise<void> => new Promise((r) => { s.close(() => r()); s.closeAllConnections(); });

let root = '';
let env: Record<string, string> = {};
const asked: string[] = [];
let routes: Record<string, string> = {};
/** Requests for openrouter.ai and ollama.com go to the FAKE servers; 127.0.0.1 is asked as it is; anything else fails. */
const routed = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  asked.push(`${u.origin}${u.pathname}`);
  const to = routes[u.origin];
  if (to) return realFetch(`${to}${u.pathname}${u.search}`, init);
  if (u.hostname === '127.0.0.1') return realFetch(u, init);
  throw new Error(`a request left this computer: ${u.origin}`);
}) as typeof fetch;

beforeAll(async () => {
  // loaded once here, before any test names its own folders: the key check's module loads the settings store
  await import('../src/capabilities/live.js');
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'h170-providers-'));
  for (const d of ['home', 'settings', 'work']) mkdirSync(join(root, d));
  env = { TIMMY_HOME: join(root, 'home'), TIMMY_SETTINGS_DIR: join(root, 'settings'), PATH: join(root, 'work'), TIMMY_REPO_ROOT: join(root, 'work') };
  asked.length = 0;
  routes = {};
  vi.stubGlobal('fetch', (input: unknown) => { throw new Error(`the global fetch was used: ${String(input)}`); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const providers = (): Record<string, unknown> => JSON.parse(readFileSync(join(root, 'home', 'providers.json'), 'utf8'));
const mode = (): number => statSync(join(root, 'home', 'providers.json')).mode & 0o777;
const ctx = () => ({ env, cwd: join(root, 'work'), fetch: routed });

describe('provider keys: saved in providers.json (0600), never shown, saved is not checked', () => {
  it('a pasted OpenRouter key is saved 0600 beside what the file holds, said "saved, not checked", and forgotten again', () => {
    writeFileSync(join(root, 'home', 'providers.json'), '{"ollama_host": "127.0.0.1:11434"}\n', { mode: 0o644 });
    const key = `FAKE-or-key-${randomBytes(8).toString('hex')}`;
    expect(providerState('openrouter', ctx())).toMatchObject({ state: 'not set up', words: 'No OpenRouter key is set up.' });
    const saved = saveKey('openrouter', `  ${key}\n`, env, join(root, 'work'));
    expect(saved).toMatchObject({ ok: true });
    expect(providers()).toEqual({ ollama_host: '127.0.0.1:11434', openrouter_api_key: key });
    expect(mode()).toBe(0o600);
    const s = providerState('openrouter', ctx());
    expect(s.state).toBe('saved, not checked');
    expect(s.words).toMatch(/^Saved, not checked: the key \(key [0-9a-f]{12}\) from providers\.json in the Timmy home \(0600\)\. A check asks OpenRouter's key endpoint \(no model is run, no charge\)\.$/);
    expect(JSON.stringify(providerStates(ctx()))).not.toContain(key);
    expect(JSON.stringify(saved)).not.toContain(key);
    const gone = forgetKey('openrouter', env, join(root, 'work'));
    expect(gone).toMatchObject({ ok: true, removed: true, stillUsed: null, words: 'Forgotten: providers.json in the Timmy home no longer holds the OpenRouter key. No OpenRouter key is set up now.' });
    expect(providers()).toEqual({ ollama_host: '127.0.0.1:11434' });
    expect(providerState('openrouter', ctx()).state).toBe('not set up');
  });

  it('refuses what is not one key, and never overwrites a providers.json that is not JSON', () => {
    expect(checkKeyShape('openrouter', '')).toEqual({ why: 'nothing was pasted: paste the OpenRouter key from https://openrouter.ai/keys' });
    expect(checkKeyShape('openrouter', 'two words here and more words')).toMatchObject({ why: expect.stringContaining('holds a space') });
    expect(checkKeyShape('ollama-cloud', 'https://ollama.com/settings/keys')).toMatchObject({ why: expect.stringContaining('an address') });
    expect(checkKeyShape('openrouter', 'short')).toMatchObject({ why: expect.stringContaining('20 to 512 characters') });
    writeFileSync(join(root, 'home', 'providers.json'), 'not json {', { mode: 0o600 });
    const r = saveKey('openrouter', `FAKE-or-key-${randomBytes(8).toString('hex')}`, env, join(root, 'work'));
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('is not a JSON object, so Timmy does not overwrite it') });
    expect(readFileSync(join(root, 'home', 'providers.json'), 'utf8')).toBe('not json {');
  });

  it('a key in the environment is used first, said so, and is not Timmy\'s to forget', () => {
    const envKey = `FAKE-env-key-${randomBytes(8).toString('hex')}`;
    const e2 = { ...env, OPENROUTER_API_KEY: envKey };
    const saved = saveKey('openrouter', `FAKE-or-key-${randomBytes(8).toString('hex')}`, e2, join(root, 'work'));
    expect(saved).toMatchObject({ ok: true, words: expect.stringContaining('OPENROUTER_API_KEY in this environment is used before it while that is set.') });
    expect(keyWhere('openrouter', e2, join(root, 'work'))).toMatchObject({ from: 'environment' });
    const gone = forgetKey('openrouter', e2, join(root, 'work'));
    expect(gone).toMatchObject({ ok: true, removed: true, stillUsed: 'environment' });
    expect(gone.ok && gone.words).toBe('Forgotten: providers.json in the Timmy home no longer holds the OpenRouter key. Still in use: the OpenRouter key from OPENROUTER_API_KEY in this environment, which Timmy does not delete.');
  });
});

describe('OpenRouter: the key check without a model call, and the PKCE sign-in (FAKE OpenRouter on 127.0.0.1)', () => {
  it('a pasted key: checked with its time when the key endpoint takes it, refused once revoked, unreachable with no network', async () => {
    const fake = fakeOpenRouter();
    routes['https://openrouter.ai'] = await listen(fake.server);
    const key = `FAKE-or-key-${randomBytes(8).toString('hex')}`;
    fake.keys.add(key);
    saveKey('openrouter', key, env, join(root, 'work'));
    expect(describeCheck('openrouter')).toEqual({ sends: 'GET https://openrouter.ai/api/v1/key', words: 'Asks OpenRouter\'s key endpoint whether it takes the key: no model is called, nothing is charged.' });
    const before = Date.now();
    const ok = await checkProvider('openrouter', ctx());
    expect(ok.state).toBe('checked');
    expect(Date.parse(ok.at!)).toBeGreaterThanOrEqual(before - 1000);
    expect(ok.words).toMatch(/^Checked just now: OpenRouter took the key \(key [0-9a-f]{12}\) from providers\.json in the Timmy home \(0600\) \(the key endpoint took the key; no model was called\)\.$/);
    expect(fake.seen).toEqual(['GET /api/v1/key']);
    fake.keys.delete(key);
    const refused = await checkProvider('openrouter', ctx());
    expect(refused).toMatchObject({ state: 'refused', next: 'Sign in again, or paste a new key from openrouter.ai/keys' });
    expect(refused.words).toMatch(/^Refused just now: OpenRouter did not take the key \(key [0-9a-f]{12}\) from .*: it is invalid or was revoked\.$/);
    await close(fake.server);
    const down = await checkProvider('openrouter', ctx());
    expect(down.state).toBe('unreachable');
    expect(down.words).toMatch(/^Unreachable just now: OpenRouter did not answer the check \(the key endpoint did not answer\); the key .* is kept as it was\.$/);
    // the record every surface reads: the workspace check's own schema, the key named by its fingerprint only
    const rec = readFileSync(join(root, 'home', 'state', 'connections.json'), 'utf8');
    expect(JSON.parse(rec)).toMatchObject({ schema: 'timmy.connections/1', checks: { openrouter: { answer: 'no answer', asked: expect.stringMatching(/^key [0-9a-f]{12}$/) } } });
    expect(rec).not.toContain(key);
    expect(asked.every((a) => a === 'https://openrouter.ai/api/v1/key')).toBe(true);
  });

  it('sign-in: the address holds the S256 challenge and the 127.0.0.1 callback; the code is exchanged; the key is saved like a pasted one', async () => {
    const fake = fakeOpenRouter();
    routes['https://openrouter.ai'] = await listen(fake.server);
    const flow = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed, limit: 5 });
    const u = new URL(flow.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://openrouter.ai/auth');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('callback_url')).toBe(flow.callback);
    expect(flow.callback).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${flow.port}/openrouter/callback/[A-Za-z0-9_-]{22}$`));
    expect(providerState('openrouter', { ...ctx(), pending: ['openrouter'] })).toMatchObject({ state: 'pending' });
    // the person's step: the browser opens the address (here, a request through the router), OpenRouter sends it back
    const page = await routed(flow.url, { redirect: 'follow' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Timmy received the sign-in');
    const r = await flow.done;
    expect(r).toMatchObject({ ok: true, fingerprint: expect.stringMatching(/^key [0-9a-f]{12}$/) });
    expect(r.ok && r.words).toMatch(/^Signed in: Saved, not checked: the OpenRouter key \(key [0-9a-f]{12}\) is in providers\.json in the Timmy home \(0600\)\.$/);
    const key = providers().openrouter_api_key as string;
    expect(fake.keys.has(key)).toBe(true);
    expect(mode()).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(fake.seen).toEqual(['GET /auth', 'POST /api/v1/auth/keys']);
    expect(providerState('openrouter', ctx()).state).toBe('saved, not checked');
    expect((await checkProvider('openrouter', ctx())).state).toBe('checked');
    // the callback server stopped
    await expect(realFetch(flow.callback)).rejects.toThrow();
  });

  it('Cancel, a timeout, a declined sign-in and a refused exchange each save nothing, in words', async () => {
    const fake = fakeOpenRouter();
    routes['https://openrouter.ai'] = await listen(fake.server);
    const ac = new AbortController();
    const a = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed, signal: ac.signal });
    ac.abort();
    expect(await a.done).toMatchObject({ ok: false, reason: 'cancelled', words: 'The sign-in was cancelled: nothing was saved.' });
    await expect(realFetch(a.callback)).rejects.toThrow();
    const t = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed, timeoutMs: 50 });
    expect(await t.done).toMatchObject({ ok: false, reason: 'timeout', words: expect.stringMatching(/^The sign-in timed out after 50 ms with no answer from the browser: nothing was saved\./) });
    const declined = fakeOpenRouter({ decline: true });
    routes['https://openrouter.ai'] = await listen(declined.server);
    const d = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed });
    await routed(d.url, { redirect: 'follow' });
    expect(await d.done).toMatchObject({ ok: false, reason: 'declined' });
    const refusing = fakeOpenRouter({ exchange: 403 });
    routes['https://openrouter.ai'] = await listen(refusing.server);
    const x = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed });
    await routed(x.url, { redirect: 'follow' });
    expect(await x.done).toMatchObject({ ok: false, reason: 'refused', words: expect.stringContaining('OpenRouter refused the exchange (HTTP 403: the code or its verifier is not valid, or the sign-in expired): nothing was saved.') });
    expect(existsSync(join(root, 'home', 'providers.json'))).toBe(false);
    for (const s of [fake.server, declined.server, refusing.server]) await close(s);
  });

  it('the manual way: the address a browser on another computer ended on, typed into Timmy\'s field, is exchanged', async () => {
    const fake = fakeOpenRouter();
    routes['https://openrouter.ai'] = await listen(fake.server);
    const flow = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed });
    // the other computer's browser: OpenRouter sends it to a 127.0.0.1 address it cannot load, which stays in its address bar
    const away = await routed(flow.url, { redirect: 'manual' });
    expect(away.status).toBe(302);
    const ended = away.headers.get('location')!;
    expect(ended.startsWith(`${flow.callback}?code=`)).toBe(true);
    expect(flow.submit('not a code')).toEqual({ ok: false, words: 'That holds no code from OpenRouter: paste the whole address the browser ended on (it holds code=…), or the code alone.' });
    expect(flow.submit(ended.replace(/\/callback\/[^?]+/, '/callback/another'))).toMatchObject({ ok: false, words: expect.stringContaining('from another sign-in') });
    expect(flow.submit(ended)).toEqual({ ok: true, words: 'Taken: the code is being exchanged for a key; nothing is saved until OpenRouter answers.' });
    expect(flow.submit(ended)).toEqual({ ok: false, words: 'This sign-in has its code already: it is being exchanged.' });
    const r = await flow.done;
    expect(r).toMatchObject({ ok: true, words: expect.stringMatching(/^Signed in: Saved, not checked:/) });
    expect(fake.keys.has(providers().openrouter_api_key as string)).toBe(true);
    expect(fake.seen).toEqual(['GET /auth', 'POST /api/v1/auth/keys']);
    expect(flow.submit(ended)).toEqual({ ok: false, words: 'This sign-in has ended: start it again.' });
    expect(MANUAL_WORDS).toMatch(/never into the chat\.$/);
    await close(fake.server);
  });

  it('a request to the callback that is not OpenRouter\'s answer (another path) is refused, and the sign-in still waits', async () => {
    const flow = await startOpenRouterSignIn({ env, cwd: join(root, 'work'), fetch: routed, timeoutMs: 2000 });
    const wrong = await realFetch(`http://127.0.0.1:${flow.port}/openrouter/callback/guess?code=FAKE-code-x`);
    expect(wrong.status).toBe(404);
    flow.cancel();
    expect((await flow.done).ok).toBe(false);
    // the challenge is the verifier's S256 (RFC 7636), and the address builder holds no verifier
    const p = pkcePair();
    expect(b64url(createHash('sha256').update(p.verifier).digest())).toBe(p.challenge);
    expect(authorizationUrl('http://127.0.0.1:1/cb', p.challenge)).not.toContain(p.verifier);
  });
});

describe('Ollama Cloud: its own key, checked by listing models (no inference); Cloudflare: read only', () => {
  it('checked, refused (signed out, expired or revoked) and unreachable (no network), from the FAKE ollama.com', async () => {
    const fake = fakeOllamaCom();
    routes['https://ollama.com'] = await listen(fake.server);
    const key = `FAKE-ollama-key-${randomBytes(8).toString('hex')}`;
    expect(providerState('ollama-cloud', ctx())).toMatchObject({ state: 'not set up', next: 'Paste an Ollama API key from ollama.com/settings/keys (no local install or download is needed for Ollama Cloud)' });
    saveKey('ollama-cloud', key, env, join(root, 'work'));
    expect(providers()).toEqual({ ollama_cloud_api_key: key });
    expect(keyInUse('ollama-cloud', env, join(root, 'work'))).toEqual({ from: 'providers.json', key });
    expect(providerState('ollama-cloud', ctx()).state).toBe('saved, not checked');
    fake.keys.add(key);
    const ok = await checkProvider('ollama-cloud', ctx());
    expect(ok).toMatchObject({ state: 'checked' });
    expect(ok.words).toMatch(/^Checked just now: Ollama Cloud took the key \(key [0-9a-f]{12}\) from providers\.json in the Timmy home \(0600\) \(it lists 2 models; none was run\)\.$/);
    fake.keys.delete(key);
    expect((await checkProvider('ollama-cloud', ctx())).words).toMatch(/: signed out, expired or revoked\.$/);
    await close(fake.server);
    expect((await checkProvider('ollama-cloud', ctx()))).toMatchObject({ state: 'unreachable', words: expect.stringContaining('(no network, or Ollama Cloud did not answer)') });
    expect(readObservations(env)['ollama-cloud']).toMatchObject({ answer: 'no answer' });
    expect(JSON.stringify(providerStates(ctx()))).not.toContain(key);
  });

  it('Cloudflare is optional and never asked: not set up, then configured and not checked, and its check sends nothing', async () => {
    const none = providerState('cloudflare', ctx());
    expect(none.state).toBe('not set up');
    expect(none.lines).toEqual([
      'Worker: not set up (no edge host in the private overlay or TIMMY_EDGE_HOST)',
      'Commander: not set up (no commander_ws)',
      'AI Gateway / model routing: not set (optional)',
      'Workers AI: not configured (no decision model uses it)',
      'Cloud logs: off; local logs are already part of the design',
    ]);
    const e2 = { ...env, TIMMY_EDGE_HOST: 'fake-edge.example.invalid', TIMMY_COMMANDER_WS: 'ws://127.0.0.1:1' };
    const set = providerState('cloudflare', { ...ctx(), env: e2 });
    expect(set.state).toBe('saved, not checked');
    expect(set.lines?.[0]).toBe('Worker: fake-edge.example.invalid configured, not checked here');
    expect(set.lines?.[1]).toBe('Commander: an address is configured (TIMMY_COMMANDER_WS); connected only while a Timmy surface holds its socket');
    const checked = await checkProvider('cloudflare', { ...ctx(), env: e2 });
    expect(checked.words).toMatch(/^Sends nothing: Timmy reads Cloudflare's settings only \(a request to an AI Gateway can create one and bill\)\./);
    expect(asked).toEqual([]);
  });

  it('the record is the workspace check\'s own: same schema, read back by its reader', async () => {
    const { CONNECTIONS_SCHEMA: theirs, readConnections } = await import('../src/ops/workspace-frame.js');
    expect(CONNECTIONS_SCHEMA).toBe(theirs);
    const fake = fakeOpenRouter();
    routes['https://openrouter.ai'] = await listen(fake.server);
    const key = `FAKE-or-key-${randomBytes(8).toString('hex')}`;
    fake.keys.add(key);
    saveKey('openrouter', key, env, join(root, 'work'));
    await checkProvider('openrouter', ctx());
    expect(readConnections(env).checks.openrouter).toMatchObject({ answer: 'accepted', asked: expect.stringMatching(/^key [0-9a-f]{12}$/) });
    await close(fake.server);
  });
});
