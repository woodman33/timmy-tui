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
import { companionCatalog, companionProviders, catalogQueryOf, openRouterChoice, savedConversation, stoppedAnswerOf } from '../src/companion/chat-view.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { LEGACY_DEFAULT_MODEL } from '../src/utils/model-choice.js';
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

  it('a stopped turn (H168\'s pass 3b R19): its receipt found by the person\'s message it answers, its answer before the stop shown, Timmy\'s record of the stop said apart; a prompt asked again takes its own receipt', () => {
    const root = join(box, 'p-stopped');
    mkdirSync(join(root, '.sessions'), { recursive: true });
    const t0 = Date.parse('2026-10-22T23:40:00.000Z');
    const ask = 'Stop that one, please.';
    const partial = 'FAKE partial: the first "step" was';
    // the record src/agent/core.ts cancelRecord keeps in the conversation where the answer would be
    const record = `[Cancelled by the user before I finished answering. No tool had run. What I had written so far: ${JSON.stringify(partial)}. I stopped here and will not continue this request unless the user asks me to.]`;
    const lines = [
      { role: 'user', content: ask, timestamp: t0 },
      { role: 'assistant', content: record, timestamp: t0 + 2000 },
      { role: 'user', content: ask, timestamp: t0 + 10_000 },
      { role: 'assistant', content: 'FAKE answer after asking again.', timestamp: t0 + 11_000 },
    ];
    writeFileSync(join(root, '.sessions', 'session-1792712400000-stop01.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const sealed = (o: Record<string, unknown>): string => JSON.stringify({ v: 1, stream: 'runs', kind: 'chat', via: 'ollama', model_requested: 'fake-qwen3:8b', model_resolved: 'fake-qwen3:8b', ...o });
    writeFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), [
      // the stopped turn's receipt: its answer's hash is the text streamed before the stop, not the conversation's record
      sealed({ id: 'rc_stop', ts: '2026-10-22T23:40:02.000Z', subject: 'chat.turn · workbench · cancelled · 0 steps · fake-qwen3:8b', status: 'cancelled', stopped_by: 'monitor',
        cancelled_at: 'before-tools', prompt_hash: sha(ask), response_hash: sha(partial), hash: `sha256_${'6e'.repeat(32)}` }),
      sealed({ id: 'rc_again', ts: '2026-10-22T23:40:11.000Z', subject: 'chat.turn · workbench · 0 steps · fake-qwen3:8b', status: 'ok',
        prompt_hash: sha(ask), response_hash: sha('FAKE answer after asking again.'), hash: `sha256_${'5d'.repeat(32)}` }),
    ].join('\n') + '\n');
    const c = savedConversation(root, {});
    expect(c.turns.map((t) => t.kind)).toEqual(['you', 'timmy', 'you', 'timmy']);
    expect(c.turns[1]).toMatchObject({ kind: 'timmy', text: partial, model: 'fake-qwen3:8b', receipt: { id: '6e6e6e6e', status: 'cancelled', surface: 'workbench' }, stopped: { record, by: 'monitor' } });
    expect(c.turns[3]).toMatchObject({ kind: 'timmy', text: 'FAKE answer after asking again.', receipt: { id: '5d5d5d5d', status: 'ok' } });
    expect(c.turns[3].stopped).toBeUndefined();
    // a record of a turn stopped before anything was written: no answer to show, the record kept
    expect(stoppedAnswerOf('[Cancelled by the user before I answered. No tool had run. I stopped here and will not continue this request unless the user asks me to.]')).toBe('');
    expect(stoppedAnswerOf(record)).toBe(partial);
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

  it('the providers\' states, H170\'s (nothing asked), as this page shows them: the local Ollama\'s from this page\'s own read, each next step where it happens; a key never in them', () => {
    // a home with nothing set up, on a computer with no ollama program on its PATH (linux: no app is looked for)
    const env = { TIMMY_HOME: join(box, 'empty-home'), TIMMY_SETTINGS_DIR: join(box, 'empty-settings'), TIMMY_REPO_ROOT: join(box, 'cwd'), PATH: '' };
    const linux = { platform: 'linux' as const };
    const none = companionProviders(env, join(box, 'cwd'), undefined, linux);
    expect(none.map((p) => [p.id, p.state])).toEqual([['openrouter', 'not set up'], ['ollama-local', 'not installed'], ['ollama-cloud', 'not set up'], ['cloudflare', 'not set up']]);
    expect(none[0].next).toMatch(/^In a terminal: timmy init --openrouter - keeps a key .*signing in from this page is not in this revision\.$/);
    expect(none[2].next).toBe('Its key is read from OLLAMA_API_KEY or the Timmy home\'s providers.json; this page keeps no key and asks nothing.');
    expect(none[3].words).toContain('Timmy never sends Cloudflare a request to check it');
    // this page's read of the local Ollama: answered (checked, its time, how many models), or not (not installed here)
    const at = '2026-10-22T23:40:00.000Z';
    const answered = companionProviders(env, join(box, 'cwd'), { answered: true, models: 1, at }, linux)[1];
    expect(answered).toMatchObject({ id: 'ollama-local', state: 'checked', at, models: 1 });
    expect(answered.words).toBe('Ollama answered its list of models at 127.0.0.1:11434: 1 installed here (no model ran, no charge).');
    expect(answered.next).toBeUndefined();
    // (H168's pass 3b R20) Ollama lists 4, 3 of them chat models: both counts, and why the fourth is not a row
    const four = companionProviders(env, join(box, 'cwd'), { answered: true, models: 3, listed: 4, left: '1 did not pass Ollama\'s /api/show check as local weights', at }, linux)[1];
    expect(four.words).toBe('Ollama answered its list of models at 127.0.0.1:11434: it lists 4, 3 of them local chat models (no model ran, no charge).');
    expect(four.lines).toEqual(['Not shown as local chat models: 1 did not pass Ollama\'s /api/show check as local weights.']);
    const empty = companionProviders(env, join(box, 'cwd'), { answered: true, models: 0, at }, linux)[1];
    expect(empty).toMatchObject({ state: 'checked', models: 0 });
    expect(empty.next).toMatch(/^Install a model yourself \(ollama pull .+\); this page downloads nothing\.$/);
    const silent = companionProviders(env, join(box, 'cwd'), { answered: false, models: 0, at, error: 'the connection failed (ECONNREFUSED)' }, linux)[1];
    expect(silent).toMatchObject({ id: 'ollama-local', state: 'not installed', at, models: 0 });
    expect(silent.words).toContain('nothing answered at 127.0.0.1:11434 just now (the connection failed (ECONNREFUSED))');
    expect(silent.next).toMatch(/Timmy installs nothing\.$/);
    // installed here and silent: installed, stopped (installed is not running); the program a FAKE on the PATH, never run
    mkdirSync(join(box, 'bin'), { recursive: true });
    writeFileSync(join(box, 'bin', 'ollama'), '#!/bin/sh\n# FAKE: an ollama program on the PATH for this test (never run)\nexit 1\n', { mode: 0o755 });
    const stopped =companionProviders({ ...env, PATH: join(box, 'bin') }, join(box, 'cwd'), { answered: false, models: 0, at }, linux)[1];
    expect(stopped).toMatchObject({ state: 'installed, stopped' });
    expect(stopped.next).toMatch(/^Start it \(.+\), then Refresh in its setup\.$/);
    // a saved key: "saved, not checked", where a check happens; the key itself never in the states
    const keyed = companionProviders({ ...env, OPENROUTER_API_KEY: 'FAKE-key-never-sent' }, join(box, 'cwd'), undefined, linux);
    expect(keyed[0]).toMatchObject({ id: 'openrouter', state: 'saved, not checked' });
    expect(keyed[0].next).toMatch(/^In a terminal: timmy workspace check asks OpenRouter's key endpoint once/);
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
    expect(body.policy).toEqual({ freeOnly: false, localOnly: false, from: { freeOnly: 'settings', localOnly: 'settings' } });
    // (R11 step 1) the choice: the setup's local model, ready only because Ollama listed it at this read (its /api/show passed)
    expect(body.choice).toMatchObject({ chosen: true, source: 'ollama-local', model: 'fake-qwen3:8b', from: 'the setup', check: { state: 'ready' }, words: 'Next turn: fake-qwen3:8b on this computer.' });
    expect(body.choice.check.words).toMatch(/^Ollama answered at 127\.0\.0\.1:\d+: fake-qwen3:8b is listed as a local chat model \(its \/api\/show check passed; no model ran\)\.$/);
    expect(Date.parse(body.choice.check.at)).toBeGreaterThan(Date.now() - 60_000);
    const local = body.providers.find((p: { id: string }) => p.id === 'ollama-local');
    expect(local).toMatchObject({ state: 'checked', models: 1 });
    // (H168's pass 3b R20: the FAKE lists two, its cloud model not a local one)
    expect(local.words).toMatch(/^Ollama answered its list of models at 127\.0\.0\.1:\d+: it lists 2, 1 of them a local chat model \(no model ran, no charge\)\.$/);
    expect(local.lines).toEqual(['Not shown as local chat models: 1 cloud model is not local.']);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['openrouter', 'ollama-local', 'ollama-cloud', 'cloudflare']);
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
    expect(local).toMatchObject({ all: 1, listed: 2, left: '1 cloud model is not local' });
    expect(local.rows[0].price).toMatchObject({ inPerM: 0, outPerM: 0, free: true });
    const cloud = (await get('/api/chat/models?source=ollama-cloud')).body;
    expect(cloud).toMatchObject({ ok: true, rows: [], from: 'none', matched: 0 });
    expect(cloud.words).toMatch(/^Ollama Cloud is not set up: no key/);
    expect(ollama.chats()).toHaveLength(0);
  });
});

describe('the page\'s choice of model (R11 step 1): nothing is sent to a model nobody chose; a choice made on the page is kept where the Workbench keeps it', () => {
  it('the OpenRouter choice by H169\'s one rule (src/utils/model-choice.ts): a key alone chooses nothing; OPENROUTER_MODEL, a model saved as a choice, Models\' record choose; an older file\'s shipped default, which nobody chose, is no model', () => {
    const box = mkdtempSync(join(tmpdir(), 'h171-choice-'));
    try {
      const settings = join(box, 'settings');
      mkdirSync(settings, { recursive: true });
      const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: settings };
      expect(openRouterChoice(env)).toEqual({ chosen: false, model: '', from: 'nobody: no model is chosen' });
      expect(openRouterChoice({ ...env, OPENROUTER_MODEL: 'fake/chosen:free' })).toMatchObject({ chosen: true, model: 'fake/chosen:free' });
      // a model the settings name that is not the legacy default: a person's entry (as timmy-tui.config.json's model is)
      writeFileSync(join(settings, 'config.json'), JSON.stringify({ model: 'anthropic/claude-haiku-5.5' }));
      expect(openRouterChoice(env)).toMatchObject({ chosen: true, model: 'anthropic/claude-haiku-5.5', from: 'the settings' });
      // the legacy default an older version wrote into the file, nobody chose: no model (said)
      writeFileSync(join(settings, 'config.json'), JSON.stringify({ model: LEGACY_DEFAULT_MODEL }));
      expect(openRouterChoice(env)).toEqual({ chosen: false, model: '', from: 'nobody: no model is chosen', legacy: true });
      // ... unless saved as a choice (saveConfig records modelChosen), or recorded by the Workbench's Models
      writeFileSync(join(settings, 'config.json'), JSON.stringify({ model: LEGACY_DEFAULT_MODEL, modelChosen: LEGACY_DEFAULT_MODEL }));
      expect(openRouterChoice(env)).toMatchObject({ chosen: true, model: LEGACY_DEFAULT_MODEL, from: 'the settings (chosen in Models, /model or timmy init --chat openrouter --model)' });
      writeFileSync(join(settings, 'config.json'), JSON.stringify({ model: LEGACY_DEFAULT_MODEL }));
      writeFileSync(join(settings, 'workbench.json'), JSON.stringify({ schema: 'timmy.workbench-settings/1', openRouterModel: LEGACY_DEFAULT_MODEL }));
      expect(openRouterChoice(env)).toMatchObject({ chosen: true, model: LEGACY_DEFAULT_MODEL, from: 'Models (recorded by the Workbench)' });
      rmSync(join(settings, 'workbench.json'));
      // the setup's OpenRouter answer alone chooses no model either (timmy init --chat openrouter without --model says so)
      mkdirSync(join(box, 'home'), { recursive: true });
      writeFileSync(join(box, 'home', 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'openrouter' } }));
      expect(openRouterChoice(env).chosen).toBe(false);
    } finally { rmSync(box, { recursive: true, force: true }); }
  });
});

describe('POST /api/chat/choose and the guarded POST /chat (R11 step 1), on the companion with its token', () => {
  // this file's own Timmy home and settings folder (tests/isolation-setup.ts), so what the choice writes through the
  // Workbench's paths (the process's settings store, the setup's files) is what the companion reads back, as in production
  const env: Record<string, string | undefined> = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let base = '';
  let token = '';
  const upstream: Array<{ auth: string; body: any }> = [];
  let fake: import('node:http').Server;
  const models = [
    { name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] as string[] | null },
    { name: 'fake-llama:1b', capabilities: ['completion'] as string[] | null },
    { name: 'fake-embed:1', capabilities: ['embedding'] as string[] | null },
  ];
  const post = async (path: string, body: unknown, auth = true): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const view = async (): Promise<any> => (await (await fetch(`${base}/api/chat/view`, { headers: { Authorization: `Bearer ${token}` } })).json());
  const chat = async (message: string): Promise<string> => (await (await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ message }) })).text());
  const setupAnswers = (): any => JSON.parse(readFileSync(join(env.TIMMY_HOME!, 'setup.json'), 'utf8')).answers;

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h171-choose-'));
    const root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), '# project\n');
    ollama = await startFakeOllama({ models });
    keepCatalog(env.TIMMY_HOME!);
    mkdirSync(env.TIMMY_HOME!, { recursive: true });
    writeFileSync(join(env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    // a FAKE OpenRouter: records what /chat sends it, streams one word
    const { createServer } = await import('node:http');
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        upstream.push({ auth: String(req.headers.authorization ?? ''), body });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE answer' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    const { port } = fake.address() as import('node:net').AddressInfo;
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env }, upstream: `http://127.0.0.1:${port}/chat/completions` });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  });
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('a local model chosen on the page: Ollama asked for that exact name (/api/show, no model run), then kept as the setup\'s answer; the view says the next turn is it, ready only after Ollama answered', async () => {
    expect((await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-llama:1b' }, false)).status).toBe(401);
    const shows = () => ollama.requests.filter((r) => r.path === '/api/show').map((r) => r.body?.model);
    const before = shows().length;
    const r = await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-llama:1b' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: 'ready', source: 'ollama-local', model: 'fake-llama:1b', words: 'Next turn: fake-llama:1b on this computer.' });
    expect(shows().slice(before)).toContain('fake-llama:1b');
    expect(setupAnswers()).toMatchObject({ chat: 'local', model: 'fake-llama:1b', ollama: ollama.host });
    expect(JSON.stringify(r.body)).not.toContain(env.TIMMY_HOME);
    expect(r.body.written).toContain('<Timmy home>/setup.json');
    // the Ollama address the chat asks is kept (the recorded one, never the default written over it)
    expect(JSON.parse(readFileSync(join(env.TIMMY_HOME!, 'providers.json'), 'utf8')).ollama_host).toBe(ollama.host);
    const v = await view();
    expect(v.route).toMatchObject({ kind: 'local', ready: true, model: 'fake-llama:1b' });
    expect(v.choice).toMatchObject({ chosen: true, model: 'fake-llama:1b', check: { state: 'ready' } });
    expect(ollama.chats()).toHaveLength(0);
  });

  it('a row Ollama does not establish as a chat model, a name it does not list, an Ollama that does not answer: each said, nothing changed', async () => {
    const embed = await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-embed:1' });
    expect(embed.status).toBe(409);
    // (the words are H170's checkLocalModel's, shared with the terminal, after "Not chosen:")
    expect(embed.body).toMatchObject({ ok: false, state: 'not a chat model' });
    expect(embed.body.words).toMatch(/^Not chosen: fake-embed:1 is not a chat model: Ollama at 127\.0\.0\.1:\d+ lists it without the completion capability \(an embedding model, or weights in a form it cannot run\)\. Choose a chat model\. Nothing was changed\.$/);
    const none = await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-nope:1' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ ok: false, state: 'not installed' });
    expect(none.body.words).toMatch(/^Not chosen: Ollama at 127\.0\.0\.1:\d+ does not have fake-nope:1: ollama pull fake-nope:1 downloads it \(its size shows first\), then choose it again\. Nothing was changed\.$/);
    expect(setupAnswers().model).toBe('fake-llama:1b');
    // a stale list: the model Ollama listed a moment ago is not a chat model when asked now
    const llama = models.find((m) => m.name === 'fake-llama:1b')!;
    llama.capabilities = ['embedding'];
    try {
      const stale = await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-llama:1b' });
      expect(stale.body).toMatchObject({ ok: false, state: 'not a chat model' });
    } finally { llama.capabilities = ['completion']; }
    // nothing answering: the address the chat asks, moved to a closed port for this one read
    const closed = await startFakeOllama({ models: [] });
    const host = closed.host;
    await closed.close();
    // (the address the chat asks is providers.json's ollama_host, which the first choice wrote, else the setup's answer)
    const providers = join(env.TIMMY_HOME!, 'providers.json');
    const kept = readFileSync(providers, 'utf8');
    writeFileSync(providers, JSON.stringify({ ...JSON.parse(kept), ollama_host: host }));
    try {
      const dead = await post('/api/chat/choose', { source: 'ollama-local', model: 'fake-llama:1b' });
      expect(dead.status).toBe(409);
      expect(dead.body).toMatchObject({ ok: false, state: 'unreachable' });
      expect(dead.body.words).toMatch(/^Not chosen: Ollama (is not running|at 127\.0\.0\.1:\d+ did not answer)[^]*start it \(ollama serve\), then choose the model again\. Nothing was changed\.$/);
    } finally { writeFileSync(providers, kept); }
    // an OpenRouter model while the route is local: refused, as the Workbench refuses it
    const or = await post('/api/chat/choose', { source: 'openrouter', model: 'anthropic/claude-haiku-5.5' });
    expect(or.status).toBe(409);
    expect(or.body.words).toMatch(/^anthropic\/claude-haiku-5\.5 runs on OpenRouter, and the chat's route is local/);
    expect(ollama.chats()).toHaveLength(0);
  });

  it('a key with no chat answer: no model is chosen (Send is off, nothing sent); an OpenRouter model chosen on the page is kept as a choice and is what /chat asks', async () => {
    // the setup's local answer gone: a home with a key and no chat answer
    writeFileSync(join(env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { ollama: ollama.host } }));
    env.OPENROUTER_API_KEY = 'FAKE-key-never-sent';
    let v = await view();
    expect(v.route).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', label: 'no model chosen · Send is off' });
    expect(v.choice).toMatchObject({ chosen: false, words: 'No model chosen: choose one in Models.' });
    expect(v.route.words).toBe('No model chosen: choose one in Models. An OpenRouter key is set up, and no model is chosen for the next turn: nothing is sent to a model nobody chose.');
    const refused = await chat('hello');
    expect(refused).toContain('event: error');
    expect(refused).toContain('No model chosen: choose one in Models.');
    expect(upstream).toHaveLength(0);
    // the choice: a free row of the kept catalog
    const r = await post('/api/chat/choose', { source: 'openrouter', model: 'recursive/flint-v1.0:free' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: 'ready', source: 'openrouter', model: 'recursive/flint-v1.0:free', words: 'Next turn: recursive/flint-v1.0:free on OpenRouter (free).' });
    expect(JSON.parse(readFileSync(join(env.TIMMY_SETTINGS_DIR!, 'config.json'), 'utf8'))).toMatchObject({ model: 'recursive/flint-v1.0:free', modelChosen: 'recursive/flint-v1.0:free' });
    expect(JSON.parse(readFileSync(join(env.TIMMY_SETTINGS_DIR!, 'workbench.json'), 'utf8')).openRouterModel).toBe('recursive/flint-v1.0:free');
    v = await view();
    expect(v.route).toMatchObject({ kind: 'openrouter', ready: true, model: 'recursive/flint-v1.0:free' });
    expect(v.route.label).toMatch(/^recursive\/flint-v1\.0:free · OpenRouter · this page's own chat/);
    // the key is saved, not checked: the chip's dot stays grey (unknown), never green without an answer
    expect(v.choice).toMatchObject({ chosen: true, source: 'openrouter', model: 'recursive/flint-v1.0:free', check: { state: 'unknown' } });
    const sent = await chat('hello');
    expect(sent).toContain('FAKE answer');
    expect(upstream).toHaveLength(1);
    expect(JSON.parse(upstream[0].body).model).toBe('recursive/flint-v1.0:free');
    expect(upstream[0].auth).toBe('Bearer FAKE-key-never-sent');
    expect(JSON.stringify(v)).not.toContain('FAKE-key-never-sent');
    // a model not in the kept catalog is not chosen
    expect((await post('/api/chat/choose', { source: 'openrouter', model: 'nobody/made-this' })).body).toMatchObject({ ok: false, state: 'not listed' });
    delete env.OPENROUTER_API_KEY;
  });
});
