/**
 * R10 (H169): the turn's route (src/agent/chat-turn.ts routes.jsonl) and the connection's newest observation (H168's pass 2c,
 * R2 and R4: src/ops/workspace-frame.ts). Each turn goes through the chat session (src/agent/chat-session.ts, the Workbench's
 * path) with the real agent and a FAKE model: a FAKE OpenRouter client that plays what the SDK would stream (its final
 * response names the model that answered), or a FAKE Ollama on 127.0.0.1, or a port where nothing listens (the connection
 * fails for real). Receipts are real signed chains in this test's own store. Nothing reaches the network.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { observationsKept, turnRoute, turnRoutes, turnRouteWords } from '../src/agent/chat-turn.js';
import { connectionOf, newestObservation, readConnections, type ConnectionCheck } from '../src/ops/workspace-frame.js';
import { readChain } from '../src/utils/receipts.js';

let box = '';
let project = '';
let homeDir = '';
const servers: http.Server[] = [];
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'h169-turn-route-'));
  project = join(box, 'project');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  homeDir = join(box, 'home');
  mkdirSync(homeDir, { recursive: true });
  vi.stubEnv('TIMMY_HOME', homeDir);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  vi.stubEnv('TIMMY_CHAT_LOCAL_ONLY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OLLAMA_HOST', '127.0.0.1:9');
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllEnvs();
  rmSync(box, { recursive: true, force: true });
});

const askPerson = async () => 'deny' as const;
const turnsOf = () => readChain('runs', join(project, '.timmy', 'receipts')) as unknown as Array<Record<string, unknown>>;

/** The real agent with a FAKE OpenRouter client: it streams `text`, and its final response names `returned`. */
function openRouterAgent(asked: string, returned: string | null, during?: (agent: Agent) => void): Agent {
  const agent = createAgent({ apiKey: 'FAKE-openrouter-key', model: asked, instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(project, '.sessions'));
  (agent as unknown as { client: unknown }).client = {
    callModel: () => ({
      async *getItemsStream() {
        during?.(agent);
        yield { type: 'message', id: 'm1', content: [{ text: 'FAKE: answered.' }] };
      },
      getResponse: async () => ({ id: 'r1', ...(returned ? { model: returned } : {}), usage: { cost: 0 } }),
      cancel: async () => undefined,
    }),
  };
  return agent;
}

const listen = (handler: http.RequestListener): Promise<string> => new Promise((resolve) => {
  const s = http.createServer(handler);
  servers.push(s);
  s.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${(s.address() as AddressInfo).port}`));
});
/** A port nothing listens on: a connection to it is refused. */
const closedPort = async (): Promise<string> => {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `127.0.0.1:${port}`;
};
const localSetup = (host: string) => writeFileSync(join(homeDir, 'setup.json'), JSON.stringify({ answers: { chat: 'local', ollama: host, model: 'fake-qwen3:8b' } }));

describe('the turn\'s route: requested, returned, where it ran, the gateway, where its log is kept', () => {
  it('an OpenRouter turn: the model asked and the model OpenRouter named are kept apart, beside its receipt', async () => {
    const agent = openRouterAgent('fake/asked-model', 'fake/returned-model-2026-10-22');
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent });
    const r = await chat.send('hello', { onText: () => undefined, askPerson });
    expect(r.status).toBe('answered');
    const [route] = turnRoutes(project);
    expect(route).toMatchObject({
      surface: 'workbench', requested: { source: 'openrouter', model: 'fake/asked-model' }, inference: 'cloud', endpoint: 'openrouter.ai', gateway: 'none',
      log: { where: 'this computer', record: '.timmy/chat-turns/routes.jsonl' }, policy: { freeOnly: false, localOnly: false },
      ended: { status: 'ok', sent: true, returned: 'fake/returned-model-2026-10-22', connection: 'answered' },
    });
    expect(route.log.conversation).toMatch(/^\.sessions\/session-.+\.jsonl$/);
    expect(turnRouteWords(route)).toBe('OpenRouter · cloud · logs on this computer');
    // the receipt names the same turn, the model asked and the model that answered
    const receipt = turnsOf().at(-1)!;
    expect(receipt).toMatchObject({ turn_id: route.turn, model_requested: 'fake/asked-model', model_resolved: 'fake/returned-model-2026-10-22' });
    expect(turnRoute(project, route.turn)).toEqual(route);
    expect(r.model).toBe('fake/returned-model-2026-10-22');
  });

  it('a model chosen while a turn runs changes only the next turn; the receipt is not relabelled', async () => {
    const agent = openRouterAgent('fake/asked-model', null, (a) => a.setModel('fake/chosen-mid-turn'));
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent });
    await chat.send('first', { onText: () => undefined, askPerson });
    const first = turnRoutes(project)[0];
    expect(first.requested.model).toBe('fake/asked-model');
    // OpenRouter named no model: the one the turn used, never the one chosen since
    expect(first.ended?.returned).toBeUndefined();
    expect(turnsOf().at(-1)).toMatchObject({ model_requested: 'fake/asked-model', model_resolved: 'fake/asked-model' });
    await chat.send('second', { onText: () => undefined, askPerson });
    const [second] = turnRoutes(project);
    expect(second.requested.model).toBe('fake/chosen-mid-turn');
    expect(turnRoutes(project)).toHaveLength(2);
  });

  it('a local turn through this computer\'s Ollama (FAKE): the model Ollama named, inference here, its answer observed', async () => {
    const host = await listen((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        if (req.url === '/api/show') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ capabilities: ['completion'], details: { format: 'gguf' } })); return; }
        if (req.url === '/api/chat') { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(`${JSON.stringify({ model: 'fake-qwen3:8b-q4', message: { role: 'assistant', content: 'FAKE: local answer.' }, done: true, done_reason: 'stop' })}\n`); return; }
        res.writeHead(404); res.end();
      });
    });
    localSetup(host);
    const agent = createAgent({ apiKey: '', model: 'unused', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(project, '.sessions'));
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent });
    const r = await chat.send('hello', { onText: () => undefined, askPerson });
    expect(r.status).toBe('answered');
    const [route] = turnRoutes(project);
    expect(route).toMatchObject({ requested: { source: 'ollama-local', model: 'fake-qwen3:8b' }, inference: 'this computer', endpoint: host, ended: { status: 'ok', returned: 'fake-qwen3:8b-q4', connection: 'answered' } });
    expect(turnRouteWords(route)).toBe('Ollama on this computer · logs on this computer');
    await observationsKept();
    const seen = readConnections().checks.ollama;
    expect(seen).toMatchObject({ answer: 'accepted', by: 'turn', detail: 'fake-qwen3:8b', asked: `http://${host}` });
    expect(connectionOf('ollama', 'Ollama (local models)', { configured: true, setupWords: '', setup: null, check: seen, now: Date.now() }))
      .toMatchObject({ state: 'live', words: 'answered a chat turn just now (fake-qwen3:8b); live: an answer within the last 30 min' });
  });
});

describe('the route\'s connection row takes its newest observation (pass 2c, R2 and R4)', () => {
  it('R2: a turn that failed because the connection failed ends "live" (configured: it did not answer), until a check or a turn answers again', async () => {
    const host = await closedPort();
    localSetup(host);
    // the last check saw Ollama answer (live), a minute before the turn
    mkdirSync(join(homeDir, 'state'), { recursive: true });
    const checkedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(homeDir, 'state', 'connections.json'), JSON.stringify({ schema: 'timmy.connections/1', checks: { ollama: { answer: 'accepted', at: checkedAt, detail: '1 local model', asked: `http://${host}` } } }));
    const agent = createAgent({ apiKey: '', model: 'unused', instructions: '', maxSteps: 2, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(project, '.sessions'));
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent });
    const r = await chat.send('hello', { onText: () => undefined, askPerson });
    expect(r.status).toBe('failed');
    expect(r.sent).toBe(false);
    const [route] = turnRoutes(project);
    expect(route.ended).toMatchObject({ status: 'failed', sent: false, connection: 'did not answer' });
    await observationsKept();
    const seen = readConnections().checks.ollama as ConnectionCheck;
    expect(seen).toMatchObject({ answer: 'no answer', by: 'turn', detail: 'the connection failed (ECONNREFUSED)', asked: `http://${host}` });
    const row = connectionOf('ollama', 'Ollama (local models)', { configured: true, setupWords: '', setup: 'timmy workspace check', check: seen, now: Date.now() });
    expect(row.state).toBe('configured');
    expect(row.words).toBe('did not answer a chat turn just now (the connection failed (ECONNREFUSED)); a check or a turn that answers makes it live again');
    expect(row.observedAt).toBe(seen.at);
  });

  it('R4: "answered" comes from the newest answer the frame holds, a sealed turn\'s included', () => {
    const now = Date.parse('2026-10-22T16:00:00Z');
    const check: ConnectionCheck = { answer: 'accepted', at: '2026-10-22T11:29:05Z', detail: '1 local model', asked: 'http://127.0.0.1:11434' };
    const turns = [
      { state: 'answered' as const, at: '2026-10-22T14:49:10Z', local: true, model: 'fake-qwen3:8b' },
      { state: 'answered' as const, at: '2026-10-22T14:43:00Z', local: true, model: 'fake-qwen3:8b' },
      { state: 'answered' as const, at: '2026-10-22T15:55:00Z', model: 'fake/openrouter-model' },
    ];
    const newest = newestObservation(check, 'ollama', turns);
    expect(newest).toEqual({ answer: 'accepted', at: '2026-10-22T14:49:10Z', detail: 'fake-qwen3:8b', by: 'turn' });
    const row = connectionOf('ollama', 'Ollama (local models)', { configured: true, setupWords: '', setup: null, check: newest, now });
    expect(row).toMatchObject({ state: 'configured', observedAt: '2026-10-22T14:49:10Z', words: 'answered a chat turn 70 min ago (fake-qwen3:8b); check again to see it now' });
    // within the bound, live
    const live = connectionOf('ollama', 'Ollama (local models)', { configured: true, setupWords: '', setup: null, check: newest, now: Date.parse('2026-10-22T15:00:00Z') });
    expect(live.state).toBe('live');
    // OpenRouter's turns are OpenRouter's: they say nothing of Ollama, and the other way round
    expect(newestObservation(undefined, 'openrouter', turns)).toMatchObject({ at: '2026-10-22T15:55:00Z', detail: 'fake/openrouter-model' });
    // a check newer than every turn stands; a stopped or failed turn is no answer
    expect(newestObservation({ ...check, at: '2026-10-22T15:59:00Z' }, 'ollama', turns)?.at).toBe('2026-10-22T15:59:00Z');
    expect(newestObservation(check, 'ollama', [{ state: 'failed', at: '2026-10-22T15:00:00Z', local: true }])).toBe(check);
  });

  it('a newer turn\'s failure is not hidden by an older answered turn', () => {
    const failed: ConnectionCheck = { answer: 'no answer', at: '2026-10-22T16:02:26Z', detail: 'the connection failed (ECONNREFUSED)', by: 'turn' };
    const turns = [{ state: 'answered' as const, at: '2026-10-22T16:01:00Z', local: true, model: 'fake-qwen3:8b' }];
    expect(newestObservation(failed, 'ollama', turns)).toBe(failed);
  });
});

describe('the connections record keeps no key', () => {
  it('an OpenRouter turn\'s observation names the key by its fingerprint at most', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'FAKE-openrouter-key-0003');
    const agent = openRouterAgent('fake/asked-model', 'fake/returned');
    const chat = await openChatSession({ project: { name: 'tray', root: project }, surface: 'workbench' }, { agent });
    await chat.send('hello', { onText: () => undefined, askPerson });
    await observationsKept();
    const raw = readFileSync(join(homeDir, 'state', 'connections.json'), 'utf8');
    expect(raw).not.toContain('FAKE-openrouter-key-0003');
    expect(JSON.parse(raw).checks.openrouter).toMatchObject({ answer: 'accepted', by: 'turn', asked: expect.stringMatching(/^key [0-9a-f]{12}$/) });
  });
});
