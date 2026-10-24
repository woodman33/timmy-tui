/**
 * R11 round 4 (H172, contract C4): server-verified user isolation on the companion. Two users, A and B, with sessions minted by
 * a FAKE identity provider (tests/fixtures/fake-identity.ts: an RSA pair made here, its public key set as CLERK_JWT_KEY) whose
 * RS256 tokens the product's REAL verifier checks (H173's verifySession, src/companion/identity); no Clerk account, no network.
 * A connects a FAKE Ollama cloud key, makes a project and a turn (through a FAKE Ollama on 127.0.0.1, no model behind it);
 * B sees none of it: no key, no project, A's conversation refused with words, A's turn on A's root refused; every route that
 * reads or writes user data answers 401 without a session (enumerated from the server's own route table: every route behind
 * `withUser`), and 401 for a token signed by another key, without `sub`, with a `sub` that is not a user id, or expired; a
 * `clerk_user_id` in a body or a query changes nothing (A's token with B's id: A's data); the user's home is 0700 under
 * <TIMMY_HOME>/users/<id>; and no user id, token or key value is in any log line the companion writes.
 *
 * The route names are C1-C3's (R11-R4-COMMON): an owner who changes one posts it in the handoff first, and this file follows.
 * Until an owner's piece lands, its case fails with words naming it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { fakeIdentityProvider, fakeUserId, type FakeIdentity } from './fixtures/fake-identity.js';
import { startFakeOllamaJourney, type FakeOllamaJourney } from './fixtures/fake-ollama-journey.js';

// ── C1-C3's names ─────────────────────────────────────────────────────────────

const PORT = 4494;
/** a second companion, started without CLERK_* for the operator-principal case */
const OPERATOR_PORT = 4497;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION_HEADER = 'X-Timmy-Session';
const ROUTES = {
  identity: '/api/identity',
  me: '/api/identity/me',
  connections: '/api/connections',
  ollamaCloudKey: '/api/connections/ollama-cloud/key',
  projects: '/api/projects',
  chatView: '/api/chat/view',
  chatModels: '/api/chat/models',
  chatChoose: '/api/chat/choose',
  chatTurn: '/api/chat/turn',
  chatStop: '/api/chat/stop',
};

const TOKEN = 'a4'.repeat(32);
const MODEL = 'fake-qwen3:8b';
/** FAKE: the Ollama cloud key A connects; its value must never reach B, a log line or a home file but A's providers.json */
const FAKE_CLOUD_KEY = `FAKE-ollama-cloud-key-${'q'.repeat(24)}`;
const A = fakeUserId('A');
const B = fakeUserId('B');

let box = '';
let timmyHome = '';
let identity: FakeIdentity;
let ollama: FakeOllamaJourney;
let companion: CompanionServer;
let env: NodeJS.ProcessEnv;
const kept: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'TIMMY_HOME', 'OLLAMA_BASE_URL', 'TIMMY_SETTINGS_DIR', 'TIMMY_MCP_HOME', 'TIMMY_STORE', 'CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_HOST', 'TIMMY_REPO'];
/** every line the companion wrote to this process's stdout/stderr while it ran (the logger's) */
const written: string[] = [];
const restore: Array<() => void> = [];

beforeAll(async () => {
  for (const k of ENV_KEYS) kept[k] = process.env[k];
  box = mkdtempSync(join(tmpdir(), 'user-isolation-'));
  timmyHome = join(box, 'home', 'timmy');
  mkdirSync(timmyHome, { recursive: true });
  ollama = await startFakeOllamaJourney({
    models: [{ name: MODEL, size: 4_900_000_000, family: 'qwen3', parameterSize: '8B' }],
    tool: { name: 'get_current_time', arguments: {} },
    answer: 'FAKE answer: the time was read by a tool (no model behind this).',
  });
  identity = fakeIdentityProvider({ azp: ORIGIN });
  // the Ollama address the cards and the chat ask is OLLAMA_HOST unless the chat setup recorded one (src/capabilities/ollama-route.ts
  // ollamaAddress; the same rule for every user, whose env passes the base through): the FAKE on 127.0.0.1, for A and B alike
  env = identity.env({
    ...process.env, HOME: join(box, 'home'), TIMMY_HOME: timmyHome, TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_STORE: '',
    OPENROUTER_API_KEY: '', OLLAMA_HOST: ollama.url,
  });
  for (const k of ['TIMMY_STORE', 'OPENROUTER_API_KEY', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY', 'OLLAMA_BASE_URL']) delete env[k];
  Object.assign(process.env, env);
  for (const k of ['TIMMY_STORE', 'OPENROUTER_API_KEY', 'TIMMY_REPO', 'TIMMY_MCP_HOME', 'CLERK_SECRET_KEY', 'OLLAMA_BASE_URL']) delete process.env[k];
  // the companion's own log lines (src/utils/logger.js writes to this process's streams): kept to scan
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    const spy = ((chunk: string | Uint8Array, ...rest: unknown[]) => { written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return (original as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof stream.write;
    stream.write = spy;
    restore.push(() => { stream.write = original as typeof stream.write; });
  }
  companion = await startCompanionServer(PORT, { token: TOKEN, chatEnv: env, workspace: { env, shareMs: 0 } });
}, 60_000);

afterAll(async () => {
  for (const r of restore.splice(0)) r();
  await companion?.shutdown();
  await ollama?.close();
  for (const k of ENV_KEYS) { if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k]; }
  if (box) rmSync(box, { recursive: true, force: true });
}, 30_000);

// ── the calls ─────────────────────────────────────────────────────────────────

interface Answer { status: number; text: string; json: any }
async function call(method: string, path: string, o: { session?: string; body?: unknown; query?: Record<string, string>; token?: string | null; base?: string } = {}): Promise<Answer> {
  const url = new URL(path, o.base ?? companion.address);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.session) headers[SESSION_HEADER] = o.session;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

/** The SSE events of a POST that answers as a stream, until it ends (or `until` sees the event it waits for). */
async function sse(path: string, o: { session: string; body: unknown; query?: Record<string, string>; until?: (e: { event: string; data: any }) => boolean; ms?: number }): Promise<{ status: number; events: Array<{ event: string; data: any }>; text: string }> {
  const url = new URL(path, companion.address);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.ms ?? 30_000);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, [SESSION_HEADER]: o.session, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(o.body), signal: ctl.signal });
  const events: Array<{ event: string; data: any }> = [];
  let text = '';
  if (!res.body || !/text\/event-stream/.test(res.headers.get('content-type') ?? '')) { text = await res.text(); clearTimeout(timer); return { status: res.status, events, text }; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      text += dec.decode(value);
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at); buf = buf.slice(at + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const raw = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        let data: any = raw;
        try { data = JSON.parse(raw); } catch { /* words */ }
        events.push({ event, data });
        if (o.until?.({ event, data })) { ctl.abort(); return { status: res.status, events, text }; }
      }
    }
  } catch (e) { if (!(e instanceof Error && e.name === 'AbortError')) throw e; } finally { clearTimeout(timer); }
  return { status: res.status, events, text };
}

/** Every route of the server behind the user middleware (`withUser`, C1), from the router's own table, nested routers included. */
function userRoutes(): Array<{ method: string; path: string }> {
  interface Layer { name?: string; route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] }; handle?: { name?: string; stack?: Layer[] }; regexp?: RegExp; path?: string }
  const out: Array<{ method: string; path: string }> = [];
  // the guard's name begins with `withUser`: middleware.ts names it `withUser` for this walk (under vitest, esbuild's transform
  // renames the inner binding `withUser2` where it shadows the exported factory of the same name); server.ts wraps it as
  // `withUserOrOperator` (H171: the operator principal where no provider is configured, identity.withUser otherwise)
  const isUser = (l: Layer): boolean => /^withUser/.test(l.name ?? '') || /^withUser/.test(l.handle?.name ?? '');
  const walk = (layers: Layer[], prefix: string): void => {
    for (const layer of layers) {
      const r = layer.route;
      if (r) {
        if (!r.stack.some(isUser)) continue;
        for (const path of Array.isArray(r.path) ? r.path : [r.path]) for (const [m, on] of Object.entries(r.methods)) if (on) out.push({ method: m.toUpperCase(), path: `${prefix}${path}` });
      } else if (layer.handle?.stack) {
        // a nested router: its mount path from its regexp (express keeps no plain string for it)
        const src = layer.regexp?.source ?? '';
        const mount = src.replace(/^\^\\\/?/, '/').replace(/\\\/\?\(\?=\\\/\|\$\)\$?.*$/, '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':x');
        walk(layer.handle.stack, `${prefix}${mount === '/' ? '' : mount}`);
      }
    }
  };
  const router = (companion.app as unknown as { _router?: { stack: Layer[] } })._router;
  walk(router?.stack ?? [], '');
  return out;
}
/** The router's table in words, for a failure's message. */
function routeTable(): string {
  interface Layer { name?: string; route?: { path: string | string[]; stack: Array<{ name?: string }> }; handle?: { stack?: unknown[] } }
  const router = (companion.app as unknown as { _router?: { stack: Layer[] } })._router;
  return (router?.stack ?? []).map((l) => (l.route ? `${String(l.route.path)} [${l.route.stack.map((h) => h.name ?? '?').join(',')}]` : `${l.name ?? '?'}${l.handle?.stack ? ' (nested)' : ''}`)).join('; ');
}

/** The ollama-cloud card of a GET /api/connections answer (H170: { cards: [{ id, state, words, key? }] }); {} when absent. */
function cloudCard(a: Answer): { id?: string; state?: string; words?: string; key?: { fingerprint: string; from: string } } {
  const cards = (a.json?.cards ?? []) as Array<{ id?: string }>;
  return (cards.find((c) => c.id === 'ollama-cloud') ?? {}) as ReturnType<typeof cloudCard>;
}

const userHome = (id: string): string => join(timmyHome, 'users', id);
/** The FAKE Ollama's address into a user's providers.json (what `timmy init --ollama` records), so the user's chat asks it. */
function pointAtFakeOllama(id: string): void {
  const home = userHome(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'providers.json');
  let have: Record<string, unknown> = {};
  try { have = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* none yet */ }
  writeFileSync(file, JSON.stringify({ ...have, ollama_host: ollama.url }), { mode: 0o600 });
}
/** Every file under a folder, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)]));
}

// ── the checks ────────────────────────────────────────────────────────────────

describe('user isolation on the companion: a FAKE identity provider\'s RS256 tokens, verified by the real verifier; no Clerk account, no network (R11 round 4, H172)', { timeout: 120_000 }, () => {
  let aProject: { id: string; root: string; name: string } | null = null;

  it('GET /api/identity (the launch token only) says the provider is configured, by the env names, and names nothing of the key', async () => {
    const r = await call('GET', ROUTES.identity);
    expect(r.status, `GET ${ROUTES.identity}: ${r.text.slice(0, 200)} (H173's identityConfig)`).toBe(200);
    expect(r.json?.configured, JSON.stringify(r.json)).toBe(true);
    expect(r.text).not.toContain(identity.publicKeyPem.split('\n')[1]);
  });

  it('configured → no operator fallback: every route behind withUser answers 401 {needs:\'session\'} with words to the launch token alone (no X-Timmy-Session; enumerated from the route table)', async () => {
    const routes = userRoutes();
    expect(routes.length, `routes behind withUser in the router (none: H173's middleware, or an owner's route, is not there); the table: ${routeTable().slice(0, 3000)}`).toBeGreaterThan(0);
    // each route found: 401 with words, the body marked `needs: 'session'` (H171's shell tells it from the launch token's 401)
    for (const r of routes) {
      const path = r.path.replace(/:[^/]+/g, 'x');
      const a = await call(r.method, path, r.method === 'GET' || r.method === 'DELETE' ? {} : { body: {} });
      expect(a.status, `${r.method} ${r.path} without a session: ${a.text.slice(0, 160)}`).toBe(401);
      expect(a.text.trim().length, `${r.method} ${r.path}: 401 with words`).toBeGreaterThan(0);
      expect(a.json?.needs, `${r.method} ${r.path}: the 401's body names what it needs: ${a.text.slice(0, 160)}`).toBe('session');
    }
    // then the owners' user-data routes (C1-C3) are all among them: the missing ones named together, each with its owner
    const owner = { me: 'H173 (identity)', projects: 'H173 (identity)', connections: 'H170 (connections; the mount line in server.ts is H171\'s)', chatView: 'H171 (chat-view behind identity.withUser)', chatTurn: 'H169 (chat-run, mounted by H171)' } as const;
    const found = routes.map((r) => r.path);
    const missing = (Object.keys(owner) as Array<keyof typeof owner>).filter((name) => !found.includes(ROUTES[name])).map((name) => `${ROUTES[name]} — ${owner[name]}`);
    expect(missing, `routes not behind withUser on this tree (the routes found: ${routes.map((r) => `${r.method} ${r.path}`).join(', ')})`).toEqual([]);
  });

  it('a token signed by another key, without sub, with a sub that is not a user id, or expired: 401 (the launch token alone: 401)', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['forged (another key)', identity.forged(A)],
      ['without sub', identity.tokenOf({})],
      ['sub not a user id', identity.token('acct_FAKE0000000000000000000000')],
      ['expired', identity.expired(A)],
      ['not a token', 'FAKE.not.a.jwt'],
    ];
    // (against the identity's own route: GET /api/identity/me, this server's verdict on the session the page holds)
    for (const [what, session] of cases) {
      const r = await call('GET', ROUTES.me, { session });
      expect(r.status, `${what}: ${r.text.slice(0, 160)}`).toBe(401);
      expect(r.text).not.toContain(session!.slice(0, 40));
    }
    const valid = await call('GET', ROUTES.me, { session: identity.token(A) });
    expect(valid.status, `A's valid token: ${valid.text.slice(0, 200)} (H173's GET ${ROUTES.me})`).toBe(200);
    expect(valid.json?.user?.id).toBe(A);
    const noLaunch = await call('GET', ROUTES.me, { session: identity.token(A), token: null });
    expect(noLaunch.status, 'the session without the launch token').toBe(401);
    // configured → the launch token alone is nobody (the lead's 21:48 ruling: the OPERATOR principal exists only with NO provider configured)
    const alone = await call('GET', ROUTES.me);
    expect(alone.status, `the launch token alone, configured: ${alone.text.slice(0, 160)}`).toBe(401);
    expect(alone.json?.needs).toBe('session');
    expect(alone.text, 'never the operator when a provider is configured').not.toMatch(/operator/i);
  });

  it('NO identity provider configured → the launch token\'s holder is the OPERATOR principal (the lead\'s 21:48 ruling, H173): GET /api/identity/me answers the operator (no 401), /api/projects the companion\'s own; nothing under users/ is made; no launch token → 401 still', async () => {
    // a second companion, its own Timmy home, its env without CLERK_* (identityConfig reads the env it is given, not process.env)
    const operatorHome = join(box, 'operator-home', 'timmy');
    mkdirSync(operatorHome, { recursive: true });
    const plain: NodeJS.ProcessEnv = { ...env, TIMMY_HOME: operatorHome, TIMMY_SETTINGS_DIR: join(box, 'operator-settings') };
    for (const k of ['CLERK_JWT_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) delete plain[k];
    const other = await startCompanionServer(OPERATOR_PORT, { token: TOKEN, chatEnv: plain, workspace: { env: plain, shareMs: 0 } });
    try {
      const base = other.address;
      const id = await call('GET', ROUTES.identity, { base });
      expect(id.status).toBe(200);
      expect(id.json?.configured, `GET ${ROUTES.identity} unconfigured: ${id.text.slice(0, 200)}`).toBe(false);
      const me = await call('GET', ROUTES.me, { base });
      expect(me.status, `the launch token alone, unconfigured → the operator: ${me.text.slice(0, 200)} (H173's operator principal)`).toBe(200);
      expect(me.json?.user?.id, me.text.slice(0, 200)).toBe('operator');
      const list = await call('GET', ROUTES.projects, { base });
      expect(list.status, `the operator's GET ${ROUTES.projects}: ${list.text.slice(0, 200)}`).toBe(200);
      expect(list.text, 'the operator\'s projects are the companion\'s own, never under users/').not.toContain(`${operatorHome}/users/`);
      expect(existsSync(join(operatorHome, 'users')), 'nothing under <TIMMY_HOME>/users/ is made for the operator').toBe(false);
      // the launch token stays the trust boundary: without it, 401 (never the operator)
      const none = await call('GET', ROUTES.me, { base, token: null });
      expect(none.status, `no launch token, unconfigured: ${none.text.slice(0, 160)}`).toBe(401);
      expect(none.text).not.toMatch(/"id":"operator"/);
      // a user's token to an unconfigured companion names no user of its own: the operator, or a refusal — never A's id as a user
      const withA = await call('GET', ROUTES.me, { base, session: identity.token(A) });
      expect([200, 401]).toContain(withA.status);
      if (withA.status === 200) expect(withA.json?.user?.id, 'unconfigured, a session header cannot name a user (no verifier)').toBe('operator');
      expect(existsSync(join(operatorHome, 'users')), 'still nothing under users/').toBe(false);
    } finally { await other.shutdown(); }
  }, 30_000);

  it('A connects a FAKE Ollama cloud key: A\'s connections show it as a key present (never its value); B\'s show no key', async () => {
    const put = await call('POST', ROUTES.ollamaCloudKey, { session: identity.token(A), body: { key: FAKE_CLOUD_KEY } });
    expect(put.status, `POST ${ROUTES.ollamaCloudKey}: ${put.text.slice(0, 200)} (H170's)`).toBe(200);
    expect(put.text).not.toContain(FAKE_CLOUD_KEY);
    expect(put.json?.fingerprint, 'the answer names the key by its fingerprint').toBeTruthy();
    // H170's GET /api/connections: { cards: [{ id, state, words, key?: { fingerprint, from } }] } — A's cloud card carries a key
    // (its fingerprint, never the value) in the state "saved, not checked" (a saved key is never "connected"); B's carries none
    const a = await call('GET', ROUTES.connections, { session: identity.token(A) });
    expect(a.status, `A's GET ${ROUTES.connections}: ${a.text.slice(0, 200)} (H170's route; the mount line in server.ts is H171's)`).toBe(200);
    expect(a.text).not.toContain(FAKE_CLOUD_KEY);
    const aCloud = cloudCard(a);
    expect(aCloud, `A's ollama-cloud card: ${a.text.slice(0, 400)}`).toBeTruthy();
    expect(aCloud.key?.fingerprint, `A's card names the key by its fingerprint: ${JSON.stringify(aCloud).slice(0, 300)}`).toBe(put.json?.fingerprint);
    expect(aCloud.state, 'a saved key is saved, not checked (never "connected")').toBe('saved, not checked');
    const b = await call('GET', ROUTES.connections, { session: identity.token(B) });
    expect(b.status, `B's GET ${ROUTES.connections}: ${b.text.slice(0, 200)}`).toBe(200);
    expect(b.text).not.toContain(FAKE_CLOUD_KEY);
    expect(b.text).not.toContain(String(put.json?.fingerprint));
    const bCloud = cloudCard(b);
    expect(bCloud.key, `B's ollama-cloud card carries no key: ${JSON.stringify(bCloud).slice(0, 300)}`).toBeUndefined();
    expect(bCloud.state, 'B: not set up').toBe('not set up');
    // the key is in A's home only, 0600
    const files = filesUnder(timmyHome).filter((f) => readFileSync(f, 'utf8').includes(FAKE_CLOUD_KEY));
    expect(files.map((f) => f.replace(timmyHome, '<home>'))).toEqual([`<home>/users/${A}/providers.json`]);
    expect(statSync(files[0]).mode & 0o777).toBe(0o600);
  });

  it('the user\'s home is 0700 under <TIMMY_HOME>/users/<id>; nothing of a user is written outside it', async () => {
    // (the home is made on the user's first use: A's project list, which also makes A's default project)
    const first = await call('GET', ROUTES.projects, { session: identity.token(A) });
    expect(first.status, `A's GET ${ROUTES.projects}: ${first.text.slice(0, 200)}`).toBe(200);
    const home = userHome(A);
    expect(existsSync(home), `A's home ${home}`).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(existsSync(userHome(B)) ? statSync(userHome(B)).mode & 0o777 : 0o700).toBe(0o700);
    const outside = filesUnder(timmyHome).filter((f) => !f.startsWith(join(timmyHome, 'users') + '/'));
    expect(outside.filter((f) => /providers\.json|setup\.json|identity\.json|connections\.json/.test(f)), 'no credentials or setup outside the users\' homes').toEqual([]);
  });

  it('A makes a project and a turn (the FAKE Ollama answers through the real turn, sealed); B\'s project list is empty', async () => {
    const made = await call('POST', ROUTES.projects, { session: identity.token(A), body: { name: 'FAKE-a-project' } });
    expect(made.status, `POST ${ROUTES.projects}: ${made.text.slice(0, 200)} (C1 userProjects; the route H171/H173 post)`).toBeLessThan(300);
    const id = made.json?.id ?? made.json?.project?.id;
    const root = made.json?.root ?? made.json?.project?.root;
    expect(typeof id, `the project's id in ${made.text.slice(0, 200)}`).toBe('string');
    expect(String(root).startsWith(join(userHome(A), 'projects')), `A's project root under A's home: ${root}`).toBe(true);
    aProject = { id, root, name: 'FAKE-a-project' };
    // A's chat asks the FAKE Ollama (OLLAMA_HOST in the companion's env; A's providers.json records it too, as a setup would), then the model chosen
    pointAtFakeOllama(A);
    const chosen = await call('POST', ROUTES.chatChoose, { session: identity.token(A), query: { project: id }, body: { source: 'ollama-local', model: MODEL } });
    expect(chosen.status, `POST ${ROUTES.chatChoose}?project=<A's id>: ${chosen.text.slice(0, 300)} (H171's chat-view behind identity.withUser, the user's project resolved by id — H173's userProjectFor)`).toBe(200);
    expect(chosen.json?.ok, chosen.text.slice(0, 300)).toBe(true);
    // (H169's body: { message, project: { root } }; a root that is not this account's → 400 before any stream)
    const turn = await sse(ROUTES.chatTurn, { session: identity.token(A), body: { message: 'FAKE: what time is it?', project: { root } }, until: (e) => e.event === 'done' || e.event === 'error', ms: 60_000 });
    expect(turn.status, `POST ${ROUTES.chatTurn}: ${turn.text.slice(0, 300)} (H169's SSE)`).toBe(200);
    const names = turn.events.map((e) => e.event);
    expect(names, `the turn's events: ${JSON.stringify(turn.events).slice(0, 600)}`).toContain('done');
    expect(names).toContain('tool');
    const done = turn.events.find((e) => e.event === 'done')!.data;
    expect(typeof done.receipt, JSON.stringify(done)).toBe('string');
    expect(ollama.chats().length, 'the FAKE Ollama answered A\'s turn (two requests: the tool call, then the answer)').toBeGreaterThanOrEqual(2);
    // B's list has nothing of A's: only B's own default project (C1: "Untitled project" made under B's home when B has none)
    const bList = await call('GET', ROUTES.projects, { session: identity.token(B) });
    expect(bList.status, `B's GET ${ROUTES.projects}: ${bList.text.slice(0, 200)}`).toBe(200);
    const bRows: Array<{ id?: string; name?: string; root?: string }> = Array.isArray(bList.json) ? bList.json : bList.json?.projects ?? [];
    expect(bRows.length, `B's projects: ${bList.text.slice(0, 300)}`).toBeLessThanOrEqual(1);
    for (const p of bRows) expect(String(p.root).startsWith(join(userHome(B), 'projects')), `B's project root under B's home: ${p.root}`).toBe(true);
    expect(bList.text).not.toContain('FAKE-a-project');
    expect(bList.text).not.toContain(id);
    expect(bList.text).not.toContain(userHome(A));
  });

  it('B cannot read A\'s conversation nor run a turn on A\'s root: refused with words; A\'s logs and receipts are in none of B\'s reads', async () => {
    expect(aProject, 'A\'s project (the case above)').toBeTruthy();
    // A reads A's conversation first: a refusal that refuses everyone (a route that knows no user's project) is no isolation
    const own = await call('GET', ROUTES.chatView, { session: identity.token(A), query: { project: aProject!.id } });
    expect(own.status, `A's own GET ${ROUTES.chatView}?project=<A's id>: ${own.text.slice(0, 200)} (H171's chat-view behind identity.withUser, the user's project by id)`).toBe(200);
    const view = await call('GET', ROUTES.chatView, { session: identity.token(B), query: { project: aProject!.id } });
    expect([400, 403, 404], `B's GET ${ROUTES.chatView}?project=<A's>: ${view.status} ${view.text.slice(0, 200)}`).toContain(view.status);
    expect(view.text.trim().length).toBeGreaterThan(0);
    expect(view.text).not.toContain('FAKE: what time is it?');
    const byRoot = await call('GET', ROUTES.chatView, { session: identity.token(B), query: { project: aProject!.root } });
    expect([400, 403, 404], `B's read by A's root: ${byRoot.status}`).toContain(byRoot.status);
    const turn = await sse(ROUTES.chatTurn, { session: identity.token(B), body: { message: 'FAKE: B on A\'s root', project: { root: aProject!.root } }, until: (e) => e.event === 'done' || e.event === 'error', ms: 15_000 });
    expect(turn.status === 200 ? turn.events.map((e) => e.event) : turn.status, `B's turn on A's project: ${turn.status} ${turn.text.slice(0, 300)}`).not.toContain('done');
    if (turn.status === 200) expect(turn.events.map((e) => e.event)).toContain('error');
    else expect([400, 403, 404]).toContain(turn.status);
    const chatsBefore = ollama.chats().length;
    expect(ollama.chats().length, 'the FAKE Ollama got nothing from B').toBe(chatsBefore);
    // B's reads: nothing of A's (the project's name and id, the receipt, the message)
    const aReceipt = String((await call('GET', ROUTES.chatView, { session: identity.token(A), query: { project: aProject!.id } })).json?.turns?.[0]?.receipt ?? '');
    for (const path of [ROUTES.connections, ROUTES.projects, ROUTES.chatModels, '/api/workspace']) {
      const r = await call('GET', path, { session: identity.token(B) });
      for (const word of ['FAKE-a-project', aProject!.id, 'FAKE: what time is it?', ...(aReceipt ? [aReceipt] : [])]) expect(r.text, `B's GET ${path} carries nothing of A's (${word})`).not.toContain(word);
    }
  });

  it('a clerk_user_id in a body or a query changes nothing: A\'s token with B\'s id reads and writes A\'s data', async () => {
    // H173's routes first (on every tree): A's project list with ?clerk_user_id=<B> is A's; a project made with B's id in the body is A's
    const list = await call('GET', ROUTES.projects, { session: identity.token(A), query: { clerk_user_id: B } });
    expect(list.status, `A's GET ${ROUTES.projects}?clerk_user_id=<B>: ${list.text.slice(0, 200)}`).toBe(200);
    expect(list.text, 'A\'s projects, not B\'s: the project A made (the case above) is in A\'s list (H173: made and listed from the one registry under A\'s home; the nested home writes one and reads another)').toMatch(/fake-a-project/i); // (H173 keeps the name lowercase)
    expect(list.text, 'nothing of B\'s in it').not.toContain(B);
    const made = await call('POST', ROUTES.projects, { session: identity.token(A), body: { name: 'FAKE-a-second', clerk_user_id: B } });
    expect(made.status, `A's POST ${ROUTES.projects} with B's id in the body: ${made.text.slice(0, 200)}`).toBe(201);
    expect(String(made.json?.root ?? ''), 'the project is under A\'s home').toContain(`/users/${A}/`);
    expect(String(made.json?.root ?? ''), 'never under B\'s').not.toContain(`/users/${B}/`);
    const bList = await call('GET', ROUTES.projects, { session: identity.token(B) });
    expect(bList.text, 'B\'s list has nothing of A\'s').not.toMatch(/fake-a-second|fake-a-project/i);
    // then H170's: A's cards with ?clerk_user_id=<B> are A's (the key present); a key saved with B's id in the body lands in A's home
    const q = await call('GET', ROUTES.connections, { session: identity.token(A), query: { clerk_user_id: B } });
    expect(q.status, `A's GET ${ROUTES.connections}?clerk_user_id=<B>: ${q.text.slice(0, 200)} (H170's route; the mount line in server.ts is H171's)`).toBe(200);
    expect(cloudCard(q).key?.fingerprint, 'A\'s cards (the key present), not B\'s').toBeTruthy();
    const put = await call('POST', ROUTES.ollamaCloudKey, { session: identity.token(A), body: { key: `${FAKE_CLOUD_KEY}-2`, clerk_user_id: B } });
    expect(put.status, put.text.slice(0, 200)).toBe(200);
    const where = filesUnder(timmyHome).filter((f) => readFileSync(f, 'utf8').includes(`${FAKE_CLOUD_KEY}-2`)).map((f) => f.replace(timmyHome, '<home>'));
    expect(where).toEqual([`<home>/users/${A}/providers.json`]);
    const b = await call('GET', ROUTES.connections, { session: identity.token(B) });
    expect(cloudCard(b).key, 'B\'s cloud card still carries no key').toBeUndefined();
  });

  it('no user id, token or key value in any log line the companion writes, nor in a home file but the keys\' own', () => {
    const tokens = [identity.token(A), identity.token(B)];
    const lines = written.join('').split('\n');
    const bad = lines.filter((l) => [A, B, FAKE_CLOUD_KEY, ...tokens].some((s) => l.includes(s)));
    expect(bad, 'log lines naming a user id, a token or a key').toEqual([]);
    for (const f of filesUnder(timmyHome)) {
      const text = readFileSync(f, 'utf8');
      const rel = f.replace(timmyHome, '<home>');
      if (!/\/users\/[^/]+\/providers\.json$/.test(rel)) expect(text.includes(FAKE_CLOUD_KEY), `${rel} holds the key's value`).toBe(false);
      expect(tokens.some((t) => text.includes(t)), `${rel} holds a session token`).toBe(false);
      if (/\.log$/.test(rel) || /\/logs\//.test(rel)) expect([A, B].some((id) => text.includes(id)), `${rel} (a log) names a user id`).toBe(false);
    }
  });
});
