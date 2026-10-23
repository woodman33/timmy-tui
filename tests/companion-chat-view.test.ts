/**
 * R10 CHAT CHECKPOINT (H171): what the browser companion's Chat reads (src/companion/chat-view.ts), as functions and over real
 * HTTP on 127.0.0.1: the project's saved conversation with each answer's model from its sealed receipt, the catalog rows of
 * a source sorted and filtered, and each provider's state, without a key, a model call or a request off this computer.
 *
 * Real: the companion server, its token, the routes, the conversation file (.sessions, as the REPL keeps it) and a receipts
 * chain the test writes in the shape src/repl/seal.ts seals a turn (the page reads its model, status and surface, and
 * verifies nothing). FAKE, labelled: the local Ollama (tests/fixtures/fake-ollama-chat.ts, its model fake-qwen3:8b, no
 * model behind it). OpenRouter's rows come from tests/fixtures/openrouter-public-catalog-2026-10-22.json (H169's: OpenRouter's
 * public catalog of 2026-10-22 trimmed to 12 models), kept where `timmy models --refresh` keeps a fetched catalog. The rows
 * and their query are H169's (src/models/catalog.ts, tested in tests/models-catalog.test.ts); here, what the Chat reads.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companionCatalog, companionProviders, catalogQueryOf, savedConversation } from '../src/companion/chat-view.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FIXTURE = join(__dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json');
/** The fixture's models as `timmy models --refresh` keeps a fetched catalog in the Timmy home (models/openrouter-catalog.json). */
interface FixtureModel { id: string; created?: number; pricing?: Record<string, string>; architecture?: { output_modalities?: string[] } }
const FIXTURE_MODELS = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: FixtureModel[] }).data;
const TEXT_MODELS = FIXTURE_MODELS.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'));
function keepCatalog(home: string): void {
  mkdirSync(join(home, 'models'), { recursive: true });
  writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: FIXTURE_MODELS }));
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ANSWER_1 = 'FAKE answer 1: a plan in three steps (no model behind it).';
const ANSWER_2 = 'FAKE answer 2, which no receipt of this project seals.';

/** The project: a conversation of five messages, and the first answer's turn sealed (kind chat, the Workbench's subject). */
function project(root: string): void {
  mkdirSync(join(root, '.sessions'), { recursive: true });
  const t0 = Date.parse('2026-10-22T23:30:00.000Z');
  const lines = [
    { role: 'user', content: 'Help me turn this folder into a plan.', timestamp: t0 },
    { role: 'assistant', content: ANSWER_1, timestamp: t0 + 1000 },
    { role: 'tool', name: 'list_project_files', content: 'README.md\nSHOT.md', timestamp: t0 + 1500 },
    { role: 'user', content: 'And the first slice?', timestamp: t0 + 2000 },
    { role: 'assistant', content: ANSWER_2, timestamp: t0 + 3000 },
  ];
  writeFileSync(join(root, '.sessions', 'session-1792711800000-abc123.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
  const receipt = {
    v: 1, id: 'rc_test', stream: 'runs', ts: '2026-10-22T23:30:01.000Z', kind: 'chat', subject: 'chat.turn · workbench · 0 steps · fake-qwen3:8b',
    status: 'ok', via: 'ollama', model_resolved: 'fake-qwen3:8b', model_requested: 'fake-qwen3:8b',
    prompt_hash: sha('Help me turn this folder into a plan.'), response_hash: sha(ANSWER_1), hash: `sha256_${'7f'.repeat(32)}`,
  };
  writeFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), `${JSON.stringify(receipt)}\n`);
}

describe('the Chat\'s data: the saved conversation, the catalog rows and the providers\' states (R10 H171)', () => {
  let box = '';
  beforeAll(() => { box = mkdtempSync(join(tmpdir(), 'h171-chat-view-')); });
  afterAll(() => { if (box) rmSync(box, { recursive: true, force: true }); });

  it('the newest conversation in .sessions, each answer with the model its sealed receipt names; an answer no receipt seals says so; a tool result is its own row', () => {
    const root = join(box, 'p1');
    project(root);
    const c = savedConversation(root, {});
    expect(c.session).toBe('session-1792711800000-abc123');
    expect(c.total).toBe(5);
    expect(c.turns.map((t) => t.kind)).toEqual(['you', 'timmy', 'tool', 'you', 'timmy']);
    expect(c.turns[1]).toMatchObject({ kind: 'timmy', text: ANSWER_1, model: 'fake-qwen3:8b', receipt: { id: '7f7f7f7f', status: 'ok', surface: 'workbench' }, at: '2026-10-22T23:30:01.000Z' });
    expect(c.turns[2]).toMatchObject({ kind: 'tool', tool: 'list_project_files', text: 'README.md\nSHOT.md' });
    expect(c.turns[4].model).toBeNull();
    expect(c.turns[4].receipt).toBeUndefined();
    // a project with no conversation kept
    expect(savedConversation(join(box, 'none'), {})).toEqual({ session: null, total: 0, turns: [] });
  });

  it('OpenRouter\'s rows as this computer keeps them, asking no one: the fetched copy with its date, else the snapshot shipped with Timmy', async () => {
    const home = join(box, 'home-fetched');
    keepCatalog(home);
    const fetched = await companionCatalog('openrouter', { TIMMY_HOME: home });
    expect(fetched).toMatchObject({ from: 'cache', cache: 'fetched', fetchedAt: '2026-10-22T16:00:00.000Z' });
    expect(fetched.asked).toBeFalsy();
    expect(fetched.words).toBe('OpenRouter\'s public catalog as this computer fetched it on 2026-10-22 (timmy models --refresh fetches it again); not a live quote');
    expect(fetched.rows.map((r) => r.id).sort()).toEqual(FIXTURE_MODELS.map((m) => m.id).sort());
    const shipped = await companionCatalog('openrouter', { TIMMY_HOME: join(box, 'home-empty') });
    expect(shipped).toMatchObject({ from: 'cache', cache: 'shipped' });
    expect(shipped.asked).toBeFalsy();
    expect(shipped.words).toMatch(/^OpenRouter's public catalog of \d{4}-\d{2}-\d{2}, the snapshot shipped with Timmy/);
    // Ollama Cloud's list is read only when asked: none here, said why
    const cloud = await companionCatalog('ollama-cloud', { TIMMY_HOME: join(box, 'home-empty') });
    expect(cloud).toMatchObject({ rows: [], from: 'none' });
    expect(cloud.asked).toBeFalsy();
    expect(cloud.words).toMatch(/^Ollama Cloud is not set up: no key/);
  });

  it('the page\'s query: what it does not know is left out', () => {
    expect(catalogQueryOf({ source: 'ollama-local', sort: 'nonsense', capability: 'magic', cost: 'free', context: '-5', search: ' qwen ' })).toEqual({ source: 'ollama-local', sort: 'recent', cost: 'free', search: 'qwen' });
    expect(catalogQueryOf({ source: 'openrouter', sort: 'price', capability: 'vision', cost: 'paid', context: '128000', maker: 'anthropic' })).toEqual({ source: 'openrouter', sort: 'price', capability: 'vision', cost: 'paid', minContext: 128000, maker: 'anthropic' });
  });

  it('the providers\' states without asking anything: a saved key is "saved, not checked", none is "not set up", Cloudflare is never checked from here', () => {
    const none = companionProviders({ TIMMY_HOME: join(box, 'empty-home'), TIMMY_SETTINGS_DIR: join(box, 'empty-settings') }, join(box, 'cwd'));
    expect(none.map((p) => [p.id, p.state])).toEqual([['openrouter', 'not set up'], ['ollama-local', 'saved, not checked'], ['ollama-cloud', 'not set up'], ['cloudflare', 'not set up']]);
    expect(none.find((p) => p.id === 'cloudflare')!.words).toContain('never checks it from here');
    const keyed = companionProviders({ OPENROUTER_API_KEY: 'FAKE-key-never-sent', TIMMY_HOME: join(box, 'empty-home'), TIMMY_SETTINGS_DIR: join(box, 'empty-settings') }, join(box, 'cwd'));
    expect(keyed[0]).toMatchObject({ id: 'openrouter', state: 'saved, not checked' });
    expect(JSON.stringify(keyed)).not.toContain('FAKE-key-never-sent');
  });
});

describe('GET /api/chat/view and /api/chat/models on the companion, with its token (R10 H171)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let base = '';
  let token = '';
  const get = async (path: string, auth = true): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h171-chat-routes-'));
    const home = join(box, 'home');
    const root = join(box, 'project');
    project(root);
    ollama = await startFakeOllama({ models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'], size: 5_200_000_000 }, { name: 'fake-gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443' }] });
    keepCatalog(home);
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(box, 'settings') };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  });
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('refuses without the token before reading anything', async () => {
    for (const path of ['/api/chat/view', '/api/chat/models?source=openrouter']) expect((await get(path, false)).status).toBe(401);
    expect(ollama.requests).toHaveLength(0);
  });

  it('the view: the conversation with its models, this page\'s route (local, the FAKE model, no tools, no receipt), the providers (Ollama observed now), free-only off; no key, no home path', async () => {
    const { status, body } = await get('/api/chat/view');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.conversation.turns.map((t: { kind: string }) => t.kind)).toEqual(['you', 'timmy', 'tool', 'you', 'timmy']);
    expect(body.conversation.turns[1].model).toBe('fake-qwen3:8b');
    expect(body.route).toMatchObject({ kind: 'local', ready: true, model: 'fake-qwen3:8b', loopback: true, cloud: false });
    expect(body.scope).toMatchObject({ conversation: 'this page', tools: 'none', receipt: false });
    expect(body.policy).toMatchObject({ freeOnly: false, localOnly: null });
    const local = body.providers.find((p: { id: string }) => p.id === 'ollama-local');
    expect(local).toMatchObject({ state: 'checked', words: '1 installed on this computer (its list of models; no model ran).' });
    expect(Date.parse(local.at)).toBeGreaterThan(Date.now() - 60_000);
    // the requests off this process: the local Ollama's list of models and their facts; no model asked
    const asked = new Set(ollama.requests.map((r) => `${r.method} ${r.path}`));
    expect(asked.has('GET /api/tags')).toBe(true);
    for (const a of asked) expect(['GET /api/tags', 'POST /api/show', 'GET /api/ps', 'GET /api/version']).toContain(a);
    expect(ollama.chats()).toHaveLength(0);
  });

  it('the models: OpenRouter\'s rows sorted Recently added and filtered on the server (a sort keeps a filter); Ollama Local\'s installed model; Ollama Cloud read only when asked', async () => {
    const or = (await get('/api/chat/models?source=openrouter')).body;
    expect(or).toMatchObject({ ok: true, from: 'cache', cache: 'fetched', all: TEXT_MODELS.length, matched: TEXT_MODELS.length, query: { source: 'openrouter', sort: 'recent' } });
    const newest = [...TEXT_MODELS].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    expect(or.rows[0].id).toBe(newest.id);
    expect(or.words).toContain('2026-10-22');
    expect(or.makers.length).toBeGreaterThan(1);
    expect(or.makers[0]).toEqual({ id: expect.any(String), label: expect.any(String), count: expect.any(Number) });
    const free = (await get('/api/chat/models?source=openrouter&cost=free')).body;
    expect(free.rows.length).toBeGreaterThan(0);
    expect(free.rows.every((r: { price: { free: unknown } }) => r.price.free === true)).toBe(true);
    expect(free.rows.map((r: { id: string }) => r.id)).toContain('recursive/flint-v1.0:free');
    expect(free).toMatchObject({ all: TEXT_MODELS.length, matched: free.rows.length });
    const byName = (await get('/api/chat/models?source=openrouter&sort=name&cost=free')).body;
    expect(byName.query).toEqual({ source: 'openrouter', sort: 'name', cost: 'free' });
    expect(byName.rows.map((r: { id: string }) => r.id).sort()).toEqual(free.rows.map((r: { id: string }) => r.id).sort());
    const local = (await get('/api/chat/models?source=ollama-local')).body;
    expect(local.rows.map((r: { id: string; installed: boolean }) => [r.id, r.installed])).toEqual([['fake-qwen3:8b', true]]);
    expect(local.rows[0].price).toMatchObject({ inPerM: 0, outPerM: 0, free: true });
    const cloud = (await get('/api/chat/models?source=ollama-cloud')).body;
    expect(cloud).toMatchObject({ ok: true, rows: [], from: 'none', matched: 0 });
    expect(cloud.words).toMatch(/^Ollama Cloud is not set up: no key/);
    expect(ollama.chats()).toHaveLength(0);
  });
});
