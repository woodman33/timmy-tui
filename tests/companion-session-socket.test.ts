/**
 * R11 round 4 (H171; the lead's gate-2 rulings of 22:31): a CONFIGURED companion (an identity provider: a FAKE instance whose
 * public PEM is CLERK_JWT_KEY, tokens minted here with its private half, as tests/identity-session.test.ts does) and its socket
 * and choose route under a user:
 *
 *  - a hello WITHOUT a session gets no project frame at all — no welcome, no bus tail, no event, no project name — only
 *    { type: 'session', ok: false, needs: 'session', words } once, and the socket waits; a later hello WITH a session gets the
 *    USER's project (its own id and root under users/<id>/projects/, user: true), never the operator's folder;
 *  - a user's POST /api/chat/choose?project=<theirs> writes the USER's home only (setup.json, providers.json, identity under
 *    users/<id>/), nothing under the operator's TIMMY_HOME outside users/, and the user's next view sees the choice.
 *
 * FAKE throughout: no Clerk, no network, a FAKE Ollama on 127.0.0.1 with no model behind it.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_ENV } from '../src/companion/identity/config.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const HOST = 'fake-identity.clerk.accounts.invalid';
const PK = `pk_test_${Buffer.from(`${HOST}$`).toString('base64')}`;
const FRONTEND = `https://${HOST}`;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const ENV = { [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.jwtKey]: PEM };
const USER_A = 'user_2abcDEF0123456789';

async function mint(azp: string, sub = USER_A): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, sid: 'sess_2abcSESSION0123456', azp, iss: FRONTEND }).setProtectedHeader({ alg: 'RS256', kid: 'ins_fake_kid' }).setIssuedAt(now).setExpirationTime(now + 60).sign(pair.privateKey);
}

/** The socket opened with the token; `hellos` sent in order, each followed by `wait` ms; every message it got, in order. */
async function socket(base: string, token: string, hellos: Array<Record<string, unknown>>, wait = 700): Promise<Array<Record<string, unknown>>> {
  const ws = new WebSocket(base.replace('http', 'ws'), ['timmy-companion', `timmy-token.${token}`], { origin: base });
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => { try { messages.push(JSON.parse(String(d)) as Record<string, unknown>); } catch { /* not JSON */ } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  for (const h of hellos) { ws.send(JSON.stringify(h)); await new Promise((r) => setTimeout(r, wait)); }
  ws.close();
  return messages;
}

describe('a configured companion: the socket without a session waits; with one, the user\'s project; a user\'s choice writes the user\'s home only (R11 round 4, H171)', () => {
  let box = '';
  let home = '';
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let base = '';
  let token = '';
  const keptRepo = process.env.TIMMY_REPO;
  const listing = (dir: string): string[] => { try { return readdirSync(dir).sort(); } catch { return []; } };

  beforeAll(async () => {
    box = realpathSync(mkdtempSync(join(tmpdir(), 'h171-session-socket-')));
    home = join(box, 'home');
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: [] }));
    ollama = await startFakeOllama({ models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] }, { name: 'fake-llama:1b', capabilities: ['completion'] }] });
    const root = join(box, 'operator-project');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(box, 'settings'), OLLAMA_HOST: ollama.host, ...ENV };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env }, identity: { clerkDir: join(box, 'no-clerk') } });
    if (keptRepo === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = keptRepo;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 60_000);
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('a hello without a session is told so once and gets no project frame; a hello with a session gets the user\'s own project', async () => {
    const without = await socket(base, token, [{ type: 'hello' }, { type: 'pin', id: 'anything' }], 800);
    // the connection's state word comes first (no project in it); then the one refusal; nothing of any project
    expect(without.map((m) => m.type)).toEqual(['state', 'session']);
    expect(without[1]).toMatchObject({ type: 'session', ok: false, needs: 'session' });
    expect(String(without[1].words)).toContain('signed-in Timmy account');
    expect(JSON.stringify(without)).not.toContain('operator-project');
    expect(JSON.stringify(without)).not.toContain('bus.tail');

    const session = await mint(base);
    const withOne = await socket(base, token, [{ type: 'hello' }, { type: 'hello', session }], 800);
    // (the refusal to the first hello, then the welcome and the bus tail of the USER's project; the integration status after)
    expect(withOne.map((m) => m.type).slice(0, 4)).toEqual(['state', 'session', 'welcome', 'bus.tail']);
    const project = withOne[2].project as Record<string, unknown>;
    expect(project).toMatchObject({ user: true, name: 'Untitled project' });
    expect(String(project.root)).toBe(join(home, 'users', USER_A, 'projects', 'untitled'));
    expect(JSON.stringify(withOne)).not.toContain('operator-project');
  }, 30_000);

  it('a user\'s POST /api/chat/choose writes the user\'s home only; the user\'s next view sees the choice', async () => {
    const session = await mint(base);
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Timmy-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const projects = await call('/api/projects');
    expect(projects.status).toBe(200);
    const mine = (projects.body.projects as Array<{ id: string; root: string }>)[0];
    expect(mine.root.startsWith(join(home, 'users', USER_A))).toBe(true);
    const operatorHomeBefore = listing(home).filter((n) => n !== 'users');
    const chosen = await call(`/api/chat/choose?project=${mine.id}`, { source: 'ollama-local', model: 'fake-llama:1b' });
    expect(chosen).toMatchObject({ status: 200, body: { ok: true, state: 'ready', model: 'fake-llama:1b' } });
    // nothing new under the operator's home outside users/
    expect(listing(home).filter((n) => n !== 'users')).toEqual(operatorHomeBefore);
    // the user's own home holds the answer (setup.json names the model; never a key)
    const userHome = join(home, 'users', USER_A);
    const setup = JSON.parse(readFileSync(join(userHome, 'setup.json'), 'utf8'));
    expect(setup.answers).toMatchObject({ chat: 'local', model: 'fake-llama:1b' });
    expect(listing(userHome)).toEqual(expect.arrayContaining(['identity.json', 'identity.seed', 'providers.json', 'setup.json']));
    const view = await call(`/api/chat/view?project=${mine.id}`);
    expect(view.status).toBe(200);
    expect(view.body.route).toMatchObject({ kind: 'local', model: 'fake-llama:1b' });
    expect(view.body.project).toEqual({ name: 'Untitled project' });
  }, 30_000);
});
