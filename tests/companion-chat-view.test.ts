/**
 * R10 CHAT CHECKPOINT (H171): what the browser companion's Chat reads (src/companion/chat-view.ts), as functions and over real
 * HTTP on 127.0.0.1: the project's saved conversation with each answer's model from its sealed receipt, the catalog rows of
 * a source sorted and filtered, and each provider's state, without a key, a model call or a request off this computer.
 *
 * Real: the companion server, its token, the routes, the conversation file (.sessions, as the REPL keeps it) and a receipts
 * chain the test writes in the shape src/repl/seal.ts seals a turn (the page reads its model, status and surface, and
 * verifies nothing). FAKE, labelled: the local Ollama (tests/fixtures/fake-ollama-chat.ts, its model fake-qwen3:8b, no
 * model behind it). OpenRouter's rows come from tests/fixtures/openrouter-public-catalog-2026-10-22.json, OpenRouter's public
 * catalog of 2026-10-22 trimmed to six models, kept where `timmy models --refresh` keeps a fetched catalog.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companionProviders, catalogQueryOf, openRouterCatalog, openRouterRow, queryRows, savedConversation, type CatalogRow } from '../src/companion/chat-view.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { startFakeOllama, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FIXTURE = join(__dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json');
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

  it('OpenRouter\'s public rows: the maker, price per million and free only when both prices are 0 (a router\'s -1 is unknown), the capabilities the catalog lists', () => {
    const cat = openRouterCatalog({}, { fetched: FIXTURE, shipped: join(box, 'absent.json') });
    expect(cat).toMatchObject({ from: 'cache', fetchedAt: '2026-10-22T16:00:00.000Z' });
    expect(cat.words).toContain('as this computer fetched it on 2026-10-22');
    expect(cat.rows).toHaveLength(6);
    const by = new Map(cat.rows.map((r) => [r.id, r]));
    expect(by.get('recursive/flint-v1.0:free')).toMatchObject({ name: 'Recursive: Flint (free)', maker: 'Recursive', price: { inPerM: 0, outPerM: 0, free: true }, caps: { tools: true, vision: false }, contextLength: 262144 });
    expect(by.get('minimax/minimax-m3.1-flash')).toMatchObject({ maker: 'MiniMax', price: { inPerM: 0.15, outPerM: 0.6, free: false }, caps: { tools: true, vision: true } });
    expect(by.get('typesafe/jev-router')!.price).toEqual({ free: 'unknown' });
    expect(by.get('scaledown/summarize')!.price).toMatchObject({ outPerM: 0, free: false });
    expect(by.get('moondream/moondream3-preview')!.caps.tools).toBe(false);
    expect(openRouterRow({ name: 'no id' })).toBeNull();
    // no catalog on this computer: none, said so
    expect(openRouterCatalog({}, { fetched: join(box, 'x.json'), shipped: join(box, 'y.json') })).toMatchObject({ rows: [], from: 'none' });
  });

  it('sorts and filters: Recently added by when OpenRouter added it, a sort never resets a filter, unknown sorts last, makers listed, search over id, name and description', () => {
    const rows = openRouterCatalog({}, { fetched: FIXTURE, shipped: join(box, 'absent.json') }).rows;
    const ids = (r: { rows: CatalogRow[] }): string[] => r.rows.map((x) => x.id);
    const recent = queryRows(rows, { source: 'openrouter', sort: 'recent' });
    expect(recent.total).toBe(6);
    expect(ids(recent)[0]).toBe('recursive/flint-v1.0:free');
    const created = recent.rows.map((r) => r.created!);
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    expect(recent.makers).toEqual([...recent.makers].sort((a, b) => a.localeCompare(b)));
    expect(ids(queryRows(rows, { source: 'openrouter', sort: 'recent', cost: 'free' }))).toEqual(['recursive/flint-v1.0:free']);
    // paid: priced and not free; the router's unknown price is neither
    const paid = ids(queryRows(rows, { source: 'openrouter', sort: 'name', cost: 'paid' }));
    expect(paid).not.toContain('typesafe/jev-router');
    expect(paid).not.toContain('recursive/flint-v1.0:free');
    // a sort with a filter keeps the filter
    const vision = queryRows(rows, { source: 'openrouter', sort: 'price', capability: 'vision' });
    expect(vision.rows.every((r) => r.caps.vision === true)).toBe(true);
    expect(queryRows(rows, { source: 'openrouter', sort: 'context', capability: 'vision' }).total).toBe(vision.total);
    // price: the unknown last
    expect(ids(queryRows(rows, { source: 'openrouter', sort: 'price' })).at(-1)).toBe('typesafe/jev-router');
    expect(ids(queryRows(rows, { source: 'openrouter', sort: 'recent', search: 'haiku' }))).toEqual(['anthropic/claude-haiku-5.5']);
    expect(queryRows(rows, { source: 'openrouter', sort: 'recent', minContext: 1_000_000 }).rows.every((r) => (r.contextLength ?? 0) >= 1_000_000)).toBe(true);
    expect(ids(queryRows(rows, { source: 'openrouter', sort: 'recent', maker: 'Moondream' }))).toEqual(['moondream/moondream3-preview']);
    // the page's query: what it does not know is left out
    expect(catalogQueryOf({ source: 'ollama-local', sort: 'nonsense', capability: 'magic', cost: 'free', context: '-5', search: ' qwen ' })).toEqual({ source: 'ollama-local', sort: 'recent', cost: 'free', search: 'qwen' });
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
    mkdirSync(join(home, 'models'), { recursive: true });
    copyFileSync(FIXTURE, join(home, 'models', 'openrouter-catalog.json'));
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
    // the one request off this process: the local Ollama's list of models, no model asked
    expect(ollama.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/tags']);
    expect(ollama.chats()).toHaveLength(0);
  });

  it('the models: OpenRouter\'s rows sorted Recently added and filtered on the server; Ollama Local\'s installed model and the cloud-backed tag kept apart', async () => {
    const or = (await get('/api/chat/models?source=openrouter')).body;
    expect(or).toMatchObject({ ok: true, from: 'cache', total: 6, all: 6, query: { source: 'openrouter', sort: 'recent' } });
    expect(or.rows[0].id).toBe('recursive/flint-v1.0:free');
    expect(or.words).toContain('2026-10-22');
    const free = (await get('/api/chat/models?source=openrouter&sort=name&cost=free')).body;
    expect(free.rows.map((r: { id: string }) => r.id)).toEqual(['recursive/flint-v1.0:free']);
    expect(free.query).toEqual({ source: 'openrouter', sort: 'name', cost: 'free' });
    const local = (await get('/api/chat/models?source=ollama-local')).body;
    expect(local.rows.map((r: { id: string; installed: boolean }) => [r.id, r.installed])).toEqual([['fake-qwen3:8b', true]]);
    expect(local.rows[0].price).toEqual({ inPerM: 0, outPerM: 0, free: true });
    const cloud = (await get('/api/chat/models?source=ollama-cloud')).body;
    expect(cloud.rows.map((r: { id: string; source: string; installed: boolean }) => [r.id, r.source, r.installed])).toEqual([['fake-gpt-oss:120b-cloud', 'ollama-cloud', false]]);
    expect(cloud.rows[0].price.free).toBe('unknown');
    expect(ollama.chats()).toHaveLength(0);
  });
});
