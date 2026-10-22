// R10 (H164): the journey's route (src/journey/route.ts routeNow): the route the next chat turn of the active project takes,
// read from the SAME function the turn reads (src/agent/chat-route.ts chatRouteNow, which src/agent/chat-session.ts calls at
// every message), with the arguments the turn gives it. Shown equal to the turn's own record: a turn is sent to a FAKE Ollama
// on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts, no model behind it) through the Workbench's own chat session (the agent it
// makes for the project), and on the OpenRouter route through a session whose agent has a FAKE OpenRouter client (the repo's
// FAKE seam: it records what it is asked and plays what the SDK would); each turn's sealed receipt is read back
// (src/journey/route.ts routeTaken) and compared with what routeNow said before it was sent. The network is a recording
// fetch (FAKE: anything not to the test's own servers is refused before it leaves, and recorded).
//
// Also: not ready, with why and the one setup step (each surface's own); the price as declared (OpenRouter's catalog) or
// unknown, never zero by inference (the R9 rule); FAKE labelled; the companion page's own Send (its own model, no tools);
// never a key.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { modelPrice } from '../src/agent/model-price.js';
import { OPENROUTER_MODEL, pageRoute } from '../src/companion/chat-route.js';
import { routeNow, routeTaken } from '../src/journey/index.js';
import { loadConfig } from '../src/utils/config.js';
import { readChain, type Receipt } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_FREE_ONLY', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const KEY = `sk-or-FAKE-${'0123456789abcdef'.repeat(2)}`;
let box = '';
let project = '';
let ollama: FakeOllama | null = null;
const restore: Array<() => void> = [];

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'journey-route-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  // the project's own store, pinned in its folder: its seals land there
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_FREE_ONLY', 'OLLAMA_HOST'] as const) delete process.env[v];
});
afterEach(async () => {
  for (const r of restore.splice(0)) r();
  await ollama?.close();
  ollama = null;
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

/** The setup's files as `timmy init` writes them: setup.json's answers and providers.json (its Ollama, a FAKE key when asked). */
function setUp(o: { chat: 'local' | 'openrouter'; model?: string; ollama?: string; key?: boolean }): void {
  const home = process.env.TIMMY_HOME!;
  mkdirSync(home, { recursive: true });
  const host = o.ollama ?? ollama?.url ?? 'http://127.0.0.1:11434';
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: host, ...(o.key ? { openrouter_api_key: KEY } : {}) }));
  writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: host, project: 'demo', chat: o.chat, ...(o.model ? { model: o.model } : {}) } }));
}

const hooks = { onText: () => undefined, askPerson: async () => 'deny' as const };
/** The project's sealed chat turns (every surface's turn is sealed into the project's own store). */
const turns = (): Receipt[] => readChain('runs', project).filter((r) => r.kind === 'chat' || r.kind === 'turn');

/** The real agent the session would make (createAgent with the settings' key and model), with a FAKE OpenRouter client. */
function agentWithFakeClient(o: { answer?: string; cost?: number } = {}): { agent: Agent; asked: string[] } {
  const config = loadConfig();
  const agent = createAgent({ apiKey: config.apiKey ?? '', model: config.model, instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(box, 'sessions'));
  const asked: string[] = [];
  (agent as unknown as { client: unknown }).client = {
    callModel: (req: { model: string }) => {
      asked.push(req.model);
      return {
        async *getItemsStream() { yield { type: 'message', id: 'm1', content: [{ text: o.answer ?? 'FAKE answer.' }] }; },
        getResponse: async () => ({ id: 'resp-fake', usage: { cost: o.cost ?? 0.0021 } }),
        cancel: async () => undefined,
      };
    },
  };
  return { agent, asked };
}

describe('routeNow is the route the next turn takes (R10 H164)', () => {
  it('local: the Workbench\'s own chat session sends to the FAKE Ollama, and its receipt names the provider, model and place routeNow said', async () => {
    ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat: [() => ({ chunks: textChunks('qwen3:8b', ['Free and local.']) })] });
    setUp({ chat: 'local', model: 'qwen3:8b' });
    const before = routeNow({ surface: 'workbench' });
    expect(before).toMatchObject({
      provider: 'ollama', model: 'qwen3:8b', where: 'this computer', ready: true, fake: false, surface: 'workbench', tools: 'gated',
      words: 'chat: local qwen3:8b · Ollama',
    });
    // a local model's price is declared nowhere: unknown, never "free" or $0 by inference (the R9 rule)
    expect(before.price.state).toBe('unknown');
    expect(before.price).not.toHaveProperty('free');
    expect(before.price.words).toMatch(/^no price declared/);
    expect(before.why).toBeUndefined();
    expect(before.step).toBeUndefined();

    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    restore.push(net.restore);
    // the session the Workbench opens (no agent handed over: it makes the project's own, as the Workbench's composer does)
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    expect(chat.route()).toMatchObject({ kind: 'local', words: before.words, ready: before.ready });
    const r = await chat.send('hello', hooks);
    expect(r).toMatchObject({ status: 'answered', sent: true, model: 'qwen3:8b' });
    // what the turn took, from its own receipt, is what routeNow said
    const taken = routeTaken(turns().at(-1)!);
    expect(taken).toMatchObject({ provider: before.provider, requested: before.model, answeredBy: 'qwen3:8b', where: before.where, fallback: false, fake: false });
    // the FAKE Ollama was asked for that model, and nothing else left this process
    expect(ollama.chats().map((c) => c.model)).toEqual(['qwen3:8b']);
    expect(net.requests.every((q) => new URL(q.url).port === new URL(ollama!.url).port)).toBe(true);
    // the route after the turn is the same route
    expect(routeNow({ surface: 'workbench' })).toEqual(before);
  });

  it('OpenRouter: the same agent\'s route and its turn (a FAKE OpenRouter client) name the same provider, model and place', async () => {
    setUp({ chat: 'openrouter', key: true });
    process.env.OPENROUTER_MODEL = 'fake/model';
    const { agent, asked } = agentWithFakeClient();
    const before = routeNow({ surface: 'workbench', agent });
    expect(before).toMatchObject({ provider: 'openrouter', model: 'fake/model', where: 'cloud', ready: true, words: 'chat: fake/model · OpenRouter', tools: 'gated' });
    // its name says fake: labelled FAKE, with what says so
    expect(before.fake).toBe(true);
    expect(before.fakeWhy).toMatch(/fake\/model/);
    const net = recordFetch();
    restore.push(net.restore);
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' }, { agent });
    expect(chat.route()).toMatchObject({ kind: 'openrouter', words: before.words, ready: true });
    const r = await chat.send('hello', hooks);
    expect(r).toMatchObject({ status: 'answered', sent: true, model: 'fake/model' });
    expect(asked).toEqual(['fake/model']);
    const taken = routeTaken(turns().at(-1)!);
    expect(taken).toMatchObject({ provider: 'openrouter', requested: before.model, answeredBy: 'fake/model', where: 'cloud', fallback: false, fake: true });
    expect(net.requests).toEqual([]);
  });

  it('with no agent handed over, routeNow reads the inputs the session\'s own agent is made from (the settings\' model and key)', async () => {
    setUp({ chat: 'openrouter', key: true });
    process.env.OPENROUTER_MODEL = 'vendor/some-model';
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const now = routeNow({ surface: 'workbench' });
    const session = chat.route();
    expect([now.provider, now.ready, now.words]).toEqual(['openrouter', session.ready, session.words]);
    expect(now.model).toBe('vendor/some-model');
    expect(session.words).toBe('chat: vendor/some-model · OpenRouter');
  });

  it('a last-resort answer is told apart: the receipt names OpenRouter\'s model asked and the local model that answered', () => {
    const r = {
      v: 1, id: 'x', stream: 'runs', ts: '2026-10-22T00:00:00.000Z', kind: 'chat', subject: 'chat.turn · workbench · 1 step · ollama/granite4.2:latest', hash: 'sha256:00',
      via: 'ollama', model_requested: 'fake/model', model_resolved: 'ollama/granite4.2:latest',
      sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: 'local', tools: 'off', cost_basis: 'local endpoint', role: 'last-resort fallback', openrouter_failed: 'fake/model: 503' }],
    } as unknown as Receipt;
    expect(routeTaken(r)).toMatchObject({ provider: 'ollama', requested: 'fake/model', answeredBy: 'ollama/granite4.2:latest', where: 'this computer', fallback: true });
    // not a chat turn: nothing
    expect(routeTaken({ ...r, kind: 'workflow', subject: 'x' } as unknown as Receipt)).toBeNull();
  });
});

describe('not ready: why, and the one setup step, in each surface\'s own words (nothing is sent)', () => {
  it('no key and no local model: none, the cause, and the setup step (the REPL\'s own command there)', async () => {
    setUp({ chat: 'openrouter' });
    const wb = routeNow({ surface: 'workbench' });
    expect(wb).toMatchObject({ provider: 'none', model: null, where: null, ready: false, fake: false, words: 'chat: no model key · /setup' });
    expect(wb.why).toBe('no model key, and the chat is not set to the local model');
    expect(wb.cause).toBe('no OPENROUTER_API_KEY, and the setup stored no key; its chat answer is OpenRouter, or none yet.');
    expect(wb.step).toEqual({ kind: 'key', command: 'timmy init --chat openrouter', words: 'timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>' });
    expect(wb.price).toEqual({ state: 'unknown', words: 'no route: nothing is asked' });
    const repl = routeNow({ surface: 'repl' });
    expect(repl.step).toMatchObject({ kind: 'key', command: '/setup key' });
    // the turn refuses it the same way: nothing sent, no receipt
    const net = recordFetch();
    restore.push(net.restore);
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const r = await chat.send('hello', hooks);
    expect(r).toMatchObject({ status: 'refused', sent: false });
    expect(net.requests).toEqual([]);
    expect(turns()).toEqual([]);
  });

  it('the local model chosen with none named, and an Ollama address Timmy does not use', () => {
    setUp({ chat: 'local' });
    const none = routeNow({ surface: 'workbench' });
    expect(none).toMatchObject({ provider: 'ollama', model: null, where: 'this computer', ready: false, why: 'the chat is set to the local model, and no model is chosen' });
    expect(none.step).toMatchObject({ kind: 'local-model', command: 'timmy init --chat local --model <name>' });
    expect(routeNow({ surface: 'repl' }).step).toMatchObject({ kind: 'local-model', command: '/model' });
    setUp({ chat: 'local', model: 'qwen3:8b', ollama: 'ftp://127.0.0.1:11434' });
    const bad = routeNow({ surface: 'workbench' });
    expect(bad).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', where: null, ready: false, why: 'the chat is set to the local model, and its Ollama address is not one Timmy uses' });
    expect(bad.step).toMatchObject({ kind: 'ollama-address', command: 'timmy init --chat local --ollama <host>' });
  });

  it('free-only on, the model not known to be free: not ready, its price unknown (never passed as free)', () => {
    setUp({ chat: 'openrouter', key: true });
    process.env.OPENROUTER_MODEL = 'vendor/unlisted';
    process.env.TIMMY_CHAT_FREE_ONLY = '1';
    const r = routeNow({ surface: 'workbench', price: (id) => modelPrice(id, { fetchedAt: '2026-10-01T00:00:00.000Z', models: [] }) });
    expect(r).toMatchObject({ provider: 'openrouter', model: 'vendor/unlisted', ready: false, why: 'free-only is on, and vendor/unlisted is not known to be free' });
    expect(r.step).toMatchObject({ kind: 'free-model', command: '/model free' });
    expect(r.price).toEqual({ state: 'unknown', words: 'price unknown: the OpenRouter catalog of 2026-10-01 does not list it (timmy models --refresh)' });
    expect(r.details.freeOnly).toBe(true);
  });
});

describe('the place, the price as declared, FAKE, the companion page\'s own Send, never a key', () => {
  const catalog = { fetchedAt: '2026-10-01T00:00:00.000Z', models: [
    { id: 'vendor/free-one:free', pricing: { prompt: '0', completion: '0' }, context_length: 131072, supported_parameters: ['tools'] },
    { id: 'vendor/paid-one', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 200000 },
  ] };
  const price = (id: string) => modelPrice(id, catalog as never);

  it('OpenRouter\'s catalog declares the price (free, or what it costs); a model it does not list is unknown, never zero', () => {
    setUp({ chat: 'openrouter', key: true });
    process.env.OPENROUTER_MODEL = 'vendor/free-one:free';
    expect(routeNow({ price }).price).toEqual({ state: 'declared', free: true, words: 'free (OpenRouter catalog of 2026-10-01) · 131k context · tools' });
    process.env.OPENROUTER_MODEL = 'vendor/paid-one';
    expect(routeNow({ price }).price).toEqual({ state: 'declared', free: false, words: '$3 in / $15 out per 1M tokens (OpenRouter catalog of 2026-10-01) · 200k context' });
    process.env.OPENROUTER_MODEL = 'vendor/unknown';
    const unknown = routeNow({ price });
    expect(unknown.price).toEqual({ state: 'unknown', words: 'price unknown: the OpenRouter catalog of 2026-10-01 does not list it (timmy models --refresh)' });
    expect(JSON.stringify(unknown)).not.toMatch(/\$0\b|"free":true/);
  });

  it('where the model runs: another computer\'s Ollama, a cloud-backed model on this computer\'s, each price unknown', () => {
    setUp({ chat: 'local', model: 'qwen3:8b', ollama: 'http://192.0.2.10:11434' });
    const away = routeNow();
    expect(away).toMatchObject({ provider: 'ollama', where: 'another computer', ready: true, words: 'chat: local qwen3:8b · Ollama at 192.0.2.10:11434 (not this computer)' });
    expect(away.price.state).toBe('unknown');
    setUp({ chat: 'local', model: 'kimi-k2:cloud', ollama: 'http://127.0.0.1:11434' });
    const cloud = routeNow();
    expect(cloud).toMatchObject({ provider: 'ollama', model: 'kimi-k2:cloud', where: 'cloud', ready: true });
    expect(cloud.price).toEqual({ state: 'unknown', words: 'unknown: Ollama reports no cost for a cloud-backed model or another computer\'s' });
  });

  it('a FAKE model is labelled FAKE; a caller\'s declared FAKE stand-in is provider fake', () => {
    setUp({ chat: 'local', model: 'fake-chat:1b' });
    const local = routeNow();
    expect(local).toMatchObject({ provider: 'ollama', model: 'fake-chat:1b', fake: true });
    expect(local.fakeWhy).toBe('its model\'s name says FAKE (fake-chat:1b)');
    setUp({ chat: 'local', model: 'mistake-7b' });
    expect(routeNow().fake).toBe(false);
    const stand = routeNow({ fake: { model: 'scripted-demo', why: 'the REPL\'s scripted demo turn (no model is asked)' } });
    expect(stand).toMatchObject({ provider: 'fake', model: 'scripted-demo', where: 'this computer', ready: true, fake: true, fakeWhy: 'the REPL\'s scripted demo turn (no model is asked)' });
    expect(stand.price).toEqual({ state: 'unknown', words: 'FAKE: no model is asked, so no price applies' });
  });

  it('the companion page\'s own Send: its own model, no tools, no receipt, not the project\'s conversation, in the page\'s own words', () => {
    setUp({ chat: 'openrouter', key: true });
    process.env.OPENROUTER_MODEL = 'vendor/session-model';
    const page = routeNow({ surface: 'companion', price });
    expect(page).toMatchObject({ provider: 'openrouter', model: OPENROUTER_MODEL, tools: 'none', surface: 'companion', conversation: 'this page', receipt: false });
    // its words are the page's own chip (src/companion/chat-route.ts pageRoute's label): one source for both
    expect(page.words).toBe(pageRoute(process.env, process.cwd()).label);
    expect(page.words).toBe(`${OPENROUTER_MODEL} · OpenRouter · this page's own chat · each message spends credits`);
    // the project's chat (the Workbench's, the REPL's): the session's model, its gated tools, the project's conversation, sealed
    expect(routeNow({ surface: 'workbench', price })).toMatchObject({ model: 'vendor/session-model', tools: 'gated', conversation: 'project', receipt: true });
    expect(routeNow({ surface: 'repl', price })).toMatchObject({ conversation: 'project', receipt: true });
    setUp({ chat: 'local', model: 'qwen3:8b' });
    expect(routeNow({ surface: 'companion' })).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', tools: 'none', conversation: 'this page', receipt: false, words: 'local qwen3:8b · Ollama · this page\'s own chat · no tools' });
  });

  it('never the key: not in the route, its words or its details', () => {
    setUp({ chat: 'openrouter', key: true });
    const r = routeNow();
    expect(r.details.keyFrom).toBe('providers.json');
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain('sk-or-');
  });
});
