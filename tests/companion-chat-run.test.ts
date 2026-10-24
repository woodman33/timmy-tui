/**
 * R11 round 4 (H169; contract C3's server half): the companion's chat is the REAL turn. POST /api/chat/turn runs
 * openChatSession({ surface: 'companion' }) for the user's project under the user's env: the one turn implementation (the
 * Agent's tool loop, the route policy, the project's turn hold, the NEEDS YOU gate, the REPL's own seal into the project's
 * store, Stop by the turn's id), answered as Server-Sent Events (route, turn, delta, tool, needs-you, done, error).
 *
 * FAKE pieces, labelled: the Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts; a scripted answer with one tool call,
 * no model behind it), the launch token and the users (a FAKE `withUser` reads the user's id from the request header
 * X-FAKE-User: contract C1's real verifier is H173's; this test checks the turn's side of the contract, not the session's),
 * the user homes (temp folders). The network is recorded: nothing leaves this computer, and a refused message makes 0
 * requests. No OpenRouter is asked (the OpenRouter route is tested only in its refusals here).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TURN_ID } from '../src/agent/chat-turn.js';
import { mountChatRun, NEEDS_YOU_TIMEOUT_MS, userSettings, whereOf, type ChatUser } from '../src/companion/chat-run.js';
import { savedConversation } from '../src/companion/chat-view.js';
import { readChain, verifyChain, verifyReceiptIn } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const TOKEN = 'FAKE-launch-token-0001';
const MODEL = 'fake-qwen3:8b';
let box = '';
let ollama: FakeOllama;
let server: ReturnType<express.Express['listen']> | null = null;
let base = '';
const restore: Array<() => void> = [];

/** The user's own env (contract C1's userEnv, FAKE here: a home per user under the box). */
const userHome = (id: string): string => join(box, 'users', id);
const userEnv = (user: ChatUser): Record<string, string | undefined> => ({ TIMMY_HOME: join(userHome(user.id), 'timmy'), TIMMY_SETTINGS_DIR: join(userHome(user.id), 'settings'), TIMMY_CHAT_FREE_ONLY: '', TIMMY_CHAT_LOCAL_ONLY: '' });
const isOwnedRoot = (user: ChatUser, root: string): boolean => root.startsWith(join(userHome(user.id), 'projects') + '/');
/** The user's project folder, its own receipts store pinned in it, with two files the model may list. */
const project = (id: string, name = 'demo'): string => {
  const root = join(userHome(id), 'projects', name);
  mkdirSync(join(root, '.timmy'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
  writeFileSync(join(root, 'README.md'), '# demo\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;\n');
  return root;
};
/** The user's setup as `timmy init --chat local --model <m>` records it, at the FAKE Ollama (or no chat route at all). */
const setUp = (id: string, chat: { model: string } | null): void => {
  const home = join(userHome(id), 'timmy');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
  writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', ...(chat ? { chat: 'local', model: chat.model } : {}) } }));
};

interface Event { event: string; data: any }
/** POST /api/chat/turn, the events as they arrive (`onEvent` sees each one), the whole list at the end. */
async function turn(body: unknown, o: { user?: string | null; token?: string | null; onEvent?: (e: Event) => void } = {}): Promise<{ status: number; events: Event[]; json?: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.user !== null) headers['X-FAKE-User'] = o.user ?? 'alice';
  const r = await fetch(`${base}/api/chat/turn`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: r.status, events: [], json: await r.json() };
  const events: Event[] = [];
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep); buffer = buffer.slice(sep + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      const e = { event, data: data ? JSON.parse(data) : null };
      events.push(e);
      o.onEvent?.(e);
    }
  }
  return { status: r.status, events };
}
const post = async (path: string, body: unknown, user = 'alice'): Promise<{ status: number; json: any }> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-FAKE-User': user }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const names = (events: Event[]): string[] => events.map((e) => e.event);
const answer = (events: Event[]): string => events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');

beforeEach(async () => {
  box = mkdtempSync(join(tmpdir(), 'h169-chat-run-'));
  ollama = await startFakeOllama({
    models: [{ name: MODEL, capabilities: ['completion', 'tools'] }],
    chat: [
      () => ({ chunks: toolCallChunks(MODEL, [{ name: 'list_project_files', arguments: {} }]) }),
      () => ({ chunks: textChunks(MODEL, ['The project has ', 'README.md and src/app.ts.']) }),
      () => ({ chunks: textChunks(MODEL, ['A second answer.']) }),
    ],
  });
  const app = express();
  // FAKE token and FAKE user checks, in the contract's order (the token, then the session): the real ones are the server's and H173's
  const withToken: express.RequestHandler = (req, res, next) => { if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ ok: false, error: 'Refused: this needs the browser companion\'s token.' }); return; } next(); };
  const withUser: express.RequestHandler = (req, res, next) => {
    const id = req.headers['x-fake-user'];
    if (typeof id !== 'string' || !id) { res.status(401).json({ ok: false, error: 'Refused: no signed-in session (FAKE check).' }); return; }
    (req as express.Request & { user?: ChatUser }).user = { id };
    next();
  };
  mountChatRun(app, { withToken, withUser, json: express.json({ limit: '128kb' }), userEnv, isOwnedRoot: (u, root) => isOwnedRoot(u, root), needsYouTimeoutMs: 400 });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const r of restore.splice(0)) r();
  // a turn left running by a failed assertion holds its SSE open: the connections are closed, not waited for
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await ollama.close();
  rmSync(box, { recursive: true, force: true });
});

describe('the real turn behind POST /api/chat/turn (R11 round 4, contract C3)', () => {
  it('route, turn, tool, delta, done: the FAKE model\'s tool call runs through the agent\'s loop; the receipt is sealed into the project\'s chain, names the companion and verifies', async () => {
    setUp('alice', { model: MODEL });
    const root = project('alice');
    const net = recordFetch(onlyPorts(new URL(ollama.url).port, new URL(base).port));
    restore.push(net.restore);
    const { status, events } = await turn({ message: 'what files are here?', project: { root } });
    expect(status).toBe(200);
    expect(names(events)).toEqual(['route', 'turn', 'tool', 'tool', 'delta', 'delta', 'done']);
    const [route, started, asked, ran] = events;
    expect(route.data).toEqual({ kind: 'local', label: `local ${MODEL} · Ollama · the project's conversation`, model: MODEL, where: 'this computer' });
    expect(started.data).toMatchObject({ surface: 'companion', receiptPending: true });
    expect(started.data.id).toMatch(TURN_ID);
    expect(asked.data).toMatchObject({ name: 'list_project_files', status: 'asked' });
    expect(ran.data).toMatchObject({ name: 'list_project_files', status: 'ran', call: asked.data.call });
    expect(answer(events)).toBe('The project has README.md and src/app.ts.');
    const done = events.at(-1)!.data;
    expect(done).toMatchObject({ status: 'answered', sent: true, model: MODEL, steps: 1, cost: 'no charge (local endpoint)', costUsd: 0, costMeasured: true, fellBack: false, turn: started.data.id });
    expect(done.receipt).toMatch(/^sha256_[0-9a-f]{64}$/);
    // what the FAKE Ollama was sent: one /api/show, then the two chat requests of the loop (the tool's answer in the second)
    expect(ollama.requests.map((r) => r.path)).toEqual(['/api/show', '/api/chat', '/api/chat']);
    expect(ollama.chats()[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'list_project_files' });
    // nothing left this computer but the requests to the two FAKE servers
    expect(net.requests.every((q) => new URL(q.url).hostname === '127.0.0.1')).toBe(true);
    // the receipt: in the project's chain, naming the surface, the turn's id and the tool's outcome; it verifies
    const chain = readChain('runs', root);
    const sealed = chain.find((r) => r.hash === done.receipt) as Record<string, unknown> | undefined;
    expect(sealed).toMatchObject({ kind: 'chat', status: 'ok', subject: `chat.turn · companion · 1 step · ${MODEL}`, turn_id: started.data.id, via: 'ollama', model_requested: MODEL, tool_outcomes: [{ name: 'list_project_files', outcome: 'completed' }] });
    expect(verifyReceiptIn(chain, done.receipt).ok).toBe(true);
    expect(verifyChain('runs', root).ok).toBe(true);
    // the conversation is the project's (kept in .sessions), as every surface's
    expect(existsSync(join(root, '.sessions'))).toBe(true);
  });

  it('the user\'s settings are read under the user\'s env, never this process\'s: no key, the chosen model, where the turn\'s facts come from', () => {
    setUp('alice', { model: MODEL });
    const env = userEnv({ id: 'alice' });
    expect(userSettings(env, project('alice'))).toEqual({});
    mkdirSync(env.TIMMY_SETTINGS_DIR!, { recursive: true });
    writeFileSync(join(env.TIMMY_SETTINGS_DIR!, 'config.json'), JSON.stringify({ model: 'fake-maker/fake-chosen', modelChosen: 'fake-maker/fake-chosen' }));
    writeFileSync(join(env.TIMMY_HOME!, 'providers.json'), JSON.stringify({ ollama_host: ollama.url, openrouter_api_key: 'sk-or-FAKE-alice-0001' }));
    expect(userSettings(env, project('alice'))).toEqual({ apiKey: 'sk-or-FAKE-alice-0001', model: 'fake-maker/fake-chosen' });
    expect(whereOf({ kind: 'openrouter' } as never)).toBe('OpenRouter (cloud)');
    expect(NEEDS_YOU_TIMEOUT_MS).toBe(120_000);
  });

  it('no route for the user (no chat answer, no key): error with the refusal\'s words, nothing sent anywhere (0 requests)', async () => {
    setUp('alice', null);
    const root = project('alice');
    const net = recordFetch(onlyPorts(new URL(base).port));
    restore.push(net.restore);
    const { events } = await turn({ message: 'hello', project: { root } });
    expect(names(events)).toEqual(['error']);
    expect(events[0].data.lines).toEqual(expect.arrayContaining([expect.stringMatching(/^Error: no model key, and the chat is not set to the local model, so this message was not sent\./), 'Nothing was sent to any model.']));
    expect(events[0].data.words).toContain('Nothing was sent to any model.');
    expect(ollama.requests).toEqual([]);
    expect(net.requests.filter((q) => new URL(q.url).port !== new URL(base).port)).toEqual([]);
    expect(readChain('runs', root)).toEqual([]);
  });

  it('the token first, then the user: 401 without either; a project that is not the user\'s: 400 with words, nothing opened', async () => {
    setUp('alice', { model: MODEL });
    setUp('bob', { model: MODEL });
    const alices = project('alice');
    expect((await turn({ message: 'hi', project: { root: alices } }, { token: null })).status).toBe(401);
    expect((await turn({ message: 'hi', project: { root: alices } }, { user: null })).status).toBe(401);
    const bobs = await turn({ message: 'hi', project: { root: alices } }, { user: 'bob' });
    expect(bobs.status).toBe(400);
    expect(bobs.json).toEqual({ ok: false, error: 'Not sent: that project is not one of this account\'s projects, so nothing runs in it.' });
    expect((await turn({ project: { root: alices } })).json.error).toMatch(/^Not sent: the request names no message/);
    expect((await turn({ message: 'hi' })).json.error).toMatch(/^Not sent: the request names no project/);
    expect((await turn({ message: 'hi', key: 'short', project: { root: alices } })).json.error).toMatch(/^Not sent: the message's key is not one/);
    expect(ollama.requests).toEqual([]);
    expect(existsSync(join(alices, '.sessions'))).toBe(false);
  });

  it('Stop mid-turn by the turn\'s id ends it with its stage (cancelled, sealed); another user cannot stop it; an unknown id is 409', async () => {
    await ollama.close();
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion'] }], chat: [() => ({ hang: true })] });
    setUp('alice', { model: MODEL });
    setUp('bob', { model: MODEL });
    const root = project('alice');
    let turnId = '';
    let finished: Event[] | null = null;
    const seen = new Promise<void>((resolve) => {
      void turn({ message: 'a long one', project: { root } }, { onEvent: (e) => { if (e.event === 'turn') { turnId = e.data.id; resolve(); } } }).then((r) => { finished = r.events; });
    });
    await seen;
    expect(turnId).toMatch(TURN_ID);
    // another user, the same id: refused before anything (the turn is not theirs), by the id alone or with alice's root
    const bob = await post('/api/chat/stop', { id: turnId }, 'bob');
    expect(bob.status).toBe(400);
    expect(bob.json.error).toBe('Not stopped: that turn is another account\'s, so it is not yours to stop.');
    expect((await post('/api/chat/stop', { id: turnId, project: { root } }, 'bob')).status).toBe(400);
    // an id this page never started: no project to look in without one named (400); named, no such hold (409)
    expect((await post('/api/chat/stop', { id: 't1-00000000' })).status).toBe(400);
    expect((await post('/api/chat/stop', { id: 't1-00000000', project: { root } })).status).toBe(409);
    expect((await post('/api/chat/stop', { id: 'not-a-turn' })).status).toBe(400);
    // contract C3: Stop by the turn's id alone, for a turn this page started
    const stop = await post('/api/chat/stop', { id: turnId });
    expect(stop.status).toBe(200);
    expect(stop.json.words).toMatch(/^Stop asked of the turn being answered in the companion: it stops there at once/);
    for (let i = 0; i < 200 && !finished; i++) await new Promise((r) => setTimeout(r, 25));
    expect(finished).not.toBeNull();
    const done = finished!.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data).toMatchObject({ status: 'cancelled', turn: turnId });
    expect(done.data.lines[0]).toMatch(/^Stopped after the request went out/);
    const sealed = readChain('runs', root).find((r) => r.hash === done.data.receipt) as Record<string, unknown>;
    expect(sealed).toMatchObject({ kind: 'chat', status: 'cancelled', turn_id: turnId, stopped_by: 'companion' });
  });

  it('a second message while the first runs is refused, naming whose turn it is; nothing more is sent', async () => {
    await ollama.close();
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion'] }], chat: [() => ({ hang: true })] });
    setUp('alice', { model: MODEL });
    const root = project('alice');
    let turnId = '';
    let first: Event[] | null = null;
    const started = new Promise<void>((resolve) => { void turn({ message: 'first', project: { root } }, { onEvent: (e) => { if (e.event === 'turn') { turnId = e.data.id; resolve(); } } }).then((r) => { first = r.events; }); });
    await started;
    // the hold is taken (the `turn` event) before the request reaches the FAKE: wait for that request, so the counter below is exact
    for (let i = 0; i < 200 && ollama.chats().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    const second = await turn({ message: 'second', project: { root } });
    expect(names(second.events)).toEqual(['route', 'error']);
    expect(second.events[1].data.lines).toEqual(['Not sent: another chat turn of this project is running here, sent from the companion.', 'Try: send it again when that turn ends (Stop ends it). Nothing was sent to any model.']);
    expect(ollama.chats()).toHaveLength(1);
    expect((await post('/api/chat/stop', { id: turnId, project: { root } })).status).toBe(200);
    for (let i = 0; i < 200 && !first; i++) await new Promise((r) => setTimeout(r, 25));
    expect(first!.at(-1)!.data.status).toBe('cancelled');
  });

  it('NEEDS YOU: a tool that needs a person waits for the page\'s answer (POST /api/chat/answer); allowed once, it runs; another user cannot answer; nobody answering denies after the wait, said in words', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'from the FAKE model\n' } };
    await ollama.close();
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion', 'tools'] }], chat: [
      () => ({ chunks: toolCallChunks(MODEL, [write]) }), () => ({ chunks: textChunks(MODEL, ['Written.']) }),
      () => ({ chunks: toolCallChunks(MODEL, [write]) }), () => ({ chunks: textChunks(MODEL, ['I could not write it.']) }),
    ] });
    setUp('alice', { model: MODEL });
    const root = project('alice');
    const asks: Event[] = [];
    const answered = turn({ message: 'write notes', project: { root } }, { onEvent: (e) => {
      if (e.event !== 'needs-you') return;
      asks.push(e);
      void (async () => {
        // bob cannot answer alice's NEEDS YOU
        expect((await post('/api/chat/answer', { id: e.data.id, choice: 'once' }, 'bob')).status).toBe(404);
        expect((await post('/api/chat/answer', { id: e.data.id, choice: 'once' })).json).toEqual({ ok: true, id: e.data.id, choice: 'once' });
      })();
    } });
    const { events } = await answered;
    expect(asks).toHaveLength(1);
    expect(asks[0].data).toMatchObject({ tool: 'write_project_file', options: ['once', 'session', 'deny'] });
    expect(asks[0].data.words).toMatch(/write_project_file|notes\.md/);
    expect(names(events)).toEqual(['route', 'turn', 'tool', 'needs-you', 'tool', 'delta', 'done']);
    expect(events[4].data).toMatchObject({ name: 'write_project_file', status: 'ran' });
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('from the FAKE model\n');
    expect(events.at(-1)!.data).toMatchObject({ status: 'answered', steps: 1 });
    // a second turn whose NEEDS YOU nobody answers: denied after the wait (400 ms here), the tool refused in words, the model told
    rmSync(join(root, 'notes.md'));
    const silent = await turn({ message: 'write notes again', project: { root } });
    expect(names(silent.events)).toEqual(['route', 'turn', 'tool', 'needs-you', 'tool', 'tool', 'delta', 'done']);
    expect(silent.events[4].data).toMatchObject({ name: 'write_project_file', status: 'refused' });
    expect(silent.events[4].data.words).toBe('write_project_file did not run: nobody decided on this page within 400 ms, so it was denied. Next time, answer the NEEDS YOU here, or run the turn in the REPL (timmy) or the Workbench, where the box waits.');
    expect(silent.events[5].data).toMatchObject({ name: 'write_project_file', status: 'refused' });
    expect(existsSync(join(root, 'notes.md'))).toBe(false);
    expect(answer(silent.events)).toBe('I could not write it.');
    // an answer to an ask that waits no more: 404
    expect((await post('/api/chat/answer', { id: silent.events[3].data.id, choice: 'once' })).status).toBe(404);
  });

  it('a keyed message is sent once: the same key again is refused with what became of the first; a new key goes', async () => {
    setUp('alice', { model: MODEL });
    const root = project('alice');
    const first = await turn({ message: 'what files are here?', key: 'page-message-0001', project: { root } });
    expect(first.events.at(-1)!.data.status).toBe('answered');
    const again = await turn({ message: 'what files are here?', key: 'page-message-0001', project: { root } });
    expect(names(again.events)).toEqual(['route', 'error']);
    expect(again.events[1].data.words).toMatch(/sent|went out|ran/i);
    expect(ollama.chats()).toHaveLength(2);
    const next = await turn({ message: 'and now?', key: 'page-message-0002', project: { root } });
    expect(next.events.at(-1)!.data.status).toBe('answered');
    expect(answer(next.events)).toBe('A second answer.');
  });

  it('R11 round 6: POST /api/chat/new starts a conversation of its own on the project\'s one agent (the REPL\'s /new): 200 with its id, the view\'s newest conversation empty, the next turn without the old messages; another user\'s project 400; a running turn 409', async () => {
    setUp('alice', { model: MODEL });
    setUp('bob', { model: MODEL });
    const root = project('alice');
    // the project has a conversation: one answered turn (the FAKE's tool call and its answer), two messages in .sessions
    const first = await turn({ message: 'what files are here?', project: { root } });
    expect(first.events.at(-1)!.data).toMatchObject({ status: 'answered' });
    const before = savedConversation(root);
    expect(before.total).toBeGreaterThan(0);
    // another user cannot start a conversation on alice's project: the boundary's refusal, as /turn's
    const bob = await post('/api/chat/new', { project: { root } }, 'bob');
    expect(bob.status).toBe(400);
    expect(bob.json.error).toBe('Not started: that project is not one of this account\'s projects, so no conversation of it is yours to start.');
    expect((await post('/api/chat/new', {})).status).toBe(400);
    // alice: a new conversation, its id the agent's (startSession); the saved one stays on disk
    const made = await post('/api/chat/new', { project: { root } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ ok: true, words: 'New conversation: the project\'s next turn starts a conversation of its own (the saved one is kept in .sessions).' });
    expect(made.json.session).toMatch(/^session-\d+-[a-z0-9]+$/);
    expect(existsSync(join(root, '.sessions', `${before.session}.jsonl`))).toBe(true);
    // what the page re-reads (GET /api/chat/view → savedConversation): the newest conversation is the new one, empty
    const after = savedConversation(root);
    expect(after).toMatchObject({ session: made.json.session, total: 0, turns: [] });
    // the next turn continues the NEW conversation: the FAKE is sent the new message only, none of the old ones
    const next = await turn({ message: 'and now?', project: { root } });
    expect(next.events.at(-1)!.data).toMatchObject({ status: 'answered' });
    expect(answer(next.events)).toBe('A second answer.');
    const sent = ollama.chats().at(-1)!.messages as Array<{ role: string; content: string }>;
    expect(sent.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['and now?']);
    expect(savedConversation(root)).toMatchObject({ session: made.json.session, total: 2 });
  });

  it('R11 round 6: POST /api/chat/new while a turn of the project runs is refused (409) naming the surface; after Stop it starts', async () => {
    await ollama.close();
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion'] }], chat: [() => ({ hang: true })] });
    setUp('alice', { model: MODEL });
    const root = project('alice');
    let turnId = '';
    let finished: Event[] | null = null;
    const started = new Promise<void>((resolve) => { void turn({ message: 'a long one', project: { root } }, { onEvent: (e) => { if (e.event === 'turn') { turnId = e.data.id; resolve(); } } }).then((r) => { finished = r.events; }); });
    await started;
    const busy = await post('/api/chat/new', { project: { root } });
    expect(busy.status).toBe(409);
    expect(busy.json.error).toBe('Not started: another chat turn of this project is running here, sent from the companion: it ends first (Stop ends it), then a new conversation can start.');
    expect((await post('/api/chat/stop', { id: turnId })).status).toBe(200);
    for (let i = 0; i < 200 && !finished; i++) await new Promise((r) => setTimeout(r, 25));
    expect(finished!.at(-1)!.data.status).toBe('cancelled');
    const made = await post('/api/chat/new', { project: { root } });
    expect(made.status).toBe(200);
    expect(savedConversation(root)).toMatchObject({ session: made.json.session, total: 0 });
  });
});
