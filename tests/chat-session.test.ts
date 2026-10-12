// R4 (H103): the one chat path for every surface (src/agent/chat-session.ts, the contract src/contracts/chat-session.ts).
// The real session and the real agent (src/agent/core.ts); the setup's answers are real files in this test's own Timmy home;
// Ollama is a FAKE on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: a real HTTP server, no model behind it), OpenRouter is
// a FAKE client where a turn needs one (it records what it is asked and plays what the SDK would), and the network is a
// recording fetch (tests/fixtures/recording-fetch.ts, FAKE: any request not to the test's own servers is refused before it
// leaves, and recorded). The person who answers the NEEDS YOU box is the test (FAKE answers).
//
// What is checked: the route as every surface reads it; with no key and no local route, the honest refusal and nothing sent
// (no request at all, no receipt); the local route streaming an answer, with its receipt (hashes, never the text; via
// ollama; no charge); the local route without a model; a slash command never sent; the NEEDS YOU gate on both routes (a
// write asks, a denial runs nothing, an allowance writes the file and the receipt names it); the last-resort fallback said
// and sealed; and one agent per project in a process (a second session of the project waits for the first one's turn).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '@openrouter/sdk/lib/tool-executor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession, NO_REQUEST_COST } from '../src/agent/chat-session.js';
import type { OpenChatSession } from '../src/contracts/chat-session.js';
import { createAgent, type Agent } from '../src/agent/core.js';
import { createProjectTools } from '../src/agent/project-tools.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

// the implementation is the contract's OpenChatSession (a call with { project, surface } alone)
const contract: OpenChatSession = openChatSession;

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const fakes: FakeOllama[] = [];
let box = '';
let project = '';
let restoreNet: (() => void) | null = null;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-session-'));
  project = join(box, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const) delete process.env[v];
});
afterEach(async () => {
  restoreNet?.();
  restoreNet = null;
  for (const f of fakes.splice(0)) await f.close();
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});
const fake = async (o: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> => { const f = await startFakeOllama(o); fakes.push(f); return f; };
const network = (...ports: Array<number | string>) => { const n = recordFetch(onlyPorts(...ports)); restoreNet = n.restore; return n; };
const portOf = (f: FakeOllama): string => new URL(f.url).port;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A home a setup wrote: providers.json and setup.json, as applySetup writes them. */
function setUp(answers: Record<string, unknown>, ollama: string): void {
  mkdirSync(process.env.TIMMY_HOME!, { recursive: true });
  writeFileSync(join(process.env.TIMMY_HOME!, 'providers.json'), JSON.stringify({ ollama_host: ollama }));
  writeFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama, project: 'demo', ...answers } }));
}
/** The surface's hooks: what it was shown, and the FAKE person's answers at the NEEDS YOU box. */
function surface(answers: Decision[] = []) {
  const texts: string[] = [];
  const tools: Array<{ id: string; name: string; phase: string; outcome?: string }> = [];
  const asked: ApprovalRequest[] = [];
  const hooks = {
    onText: (full: string) => { texts.push(full); },
    onTool: (e: { id: string; name: string; phase: 'start' | 'end'; outcome?: string }) => { tools.push(e); },
    askPerson: async (req: ApprovalRequest): Promise<Decision> => { asked.push(req); return answers.shift() ?? 'deny'; },
  };
  return { hooks, texts, tools, asked };
}
// R4 (H113): every surface's turn is sealed by the REPL's own seal (src/repl/seal.ts; this surface's subject names it), into the
// project's store
const chats = () => readChain('runs', project).filter((r) => r.kind === 'chat');

describe('the route, and a message with none (R4 H103, D1)', () => {
  it('no key and no local route: the route says so, the message is refused, nothing is sent, nothing is sealed', async () => {
    const ollama = await fake({ models: [{ name: 'granite4.2:latest' }], completions: [() => ({ content: 'FAKE answer nobody asked for' })] });
    process.env.OLLAMA_HOST = ollama.url;
    const net = network(portOf(ollama));
    const chat = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    expect(chat.route()).toEqual({
      kind: 'none', words: 'chat: no model key · /setup', ready: false,
      refusal: [
        'Error: no model key, and the chat is not set to the local model, so this message was not sent.',
        'Cause: no OPENROUTER_API_KEY, and the setup stored no key; its chat answer is OpenRouter, or none yet.',
        'Try: timmy init --chat openrouter (it asks for the key, hidden), or the local model: timmy init --chat local --model <name>',
        'Nothing was sent to any model.',
      ],
    });
    const s = surface();
    const r = await chat.send('hello', s.hooks);
    expect(r).toEqual({ status: 'refused', text: '', lines: chat.route().refusal, sent: false, costWords: NO_REQUEST_COST });
    expect(net.requests).toEqual([]);
    expect(ollama.requests).toEqual([]);
    expect(chats()).toEqual([]);
    expect(s.texts).toEqual([]);
    // the project's conversation took nothing
    expect(existsSync(join(project, '.sessions'))).toBe(false);
  });

  it('a slash command is never sent, on any route', async () => {
    const net = network();
    const chat = await contract({ project: { name: 'demo', root: project }, surface: 'monitor' });
    const r = await chat.send('/storyboard a tray demo', surface().hooks);
    expect(r).toMatchObject({ status: 'refused', sent: false, lines: ['Not sent: /storyboard is a command, and a command never goes to a model.', 'Try: the REPL runs it: timmy, then /storyboard.'] });
    expect(net.requests).toEqual([]);
  });

  it('the local route without a model: refused with the setup\'s words, and nothing is sent', async () => {
    const ollama = await fake({ models: [{ name: 'qwen3:8b' }] });
    setUp({ chat: 'local', model: '' }, ollama.url);
    const net = network(portOf(ollama));
    const chat = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    expect(chat.route()).toMatchObject({ kind: 'local', words: 'chat: local · no model chosen · /model', ready: false });
    const r = await chat.send('hello', surface().hooks);
    expect(r.status).toBe('refused');
    expect(r.lines?.[0]).toBe('Error: the chat is set to the local model, and no model is chosen.');
    expect(r.lines?.at(-1)).toBe('Nothing was sent to any model.');
    expect(net.requests).toEqual([]);
    expect(ollama.requests).toEqual([]);
  });
});

describe('a turn on the local route (FAKE Ollama)', () => {
  it('streams the answer through the surface, sends nothing to OpenRouter, and seals hashes, the route and no charge', async () => {
    const ollama = await fake({ models: [{ name: 'qwen3:8b' }], chat: [() => ({ chunks: textChunks('qwen3:8b', ['Hello', ' there.']) })] });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    const net = network(portOf(ollama));
    const chat = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    expect(chat.route()).toEqual({ kind: 'local', words: 'chat: local qwen3:8b · Ollama', ready: true });
    const s = surface();
    const r = await chat.send('hello', s.hooks);
    expect(r).toMatchObject({ status: 'answered', text: 'Hello there.', sent: true, costWords: 'no charge (local endpoint)', model: 'qwen3:8b', receipt: expect.stringMatching(/^sha256_/) });
    expect(s.texts).toEqual(['Hello', 'Hello there.']);
    expect(net.requests.every((q) => new URL(q.url).port === portOf(ollama))).toBe(true);
    expect(net.requests.some((q) => q.url.includes('openrouter'))).toBe(false);
    const sealed = chats().at(-1)!;
    expect(sealed).toMatchObject({
      kind: 'chat', subject: 'chat.turn · workbench · 0 steps · qwen3:8b', status: 'ok', project: 'demo',
      prompt_hash: sha('hello'), response_hash: sha('Hello there.'), model_requested: 'qwen3:8b', model_resolved: 'qwen3:8b',
      via: 'ollama', sources: [{ kind: 'ollama', host: ollama.host, endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }],
      cost_usd: 0, cost_measured: true,
    });
    expect(sealed.hash).toBe(r.receipt);
    // never the text itself
    expect(JSON.stringify(sealed)).not.toContain('Hello there');
    // the model was told the chat's rules, not another surface's
    expect(ollama.chats()[0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('the Workbench') });
  });

  it('NEEDS YOU: a write asks the surface; denied, nothing is written; allowed once, the file is written and sealed', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'hello\n' } };
    const ollama = await fake({
      models: [{ name: 'qwen3:8b' }],
      chat: [
        () => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Not written.']) }),
        () => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Written.']) }),
      ],
    });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    network(portOf(ollama));
    const chat = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const denied = surface(['deny']);
    const d = await chat.send('write notes.md', denied.hooks);
    expect(denied.asked).toMatchObject([{ tool: 'write_project_file', reason: 'changes a file in your project', summary: 'notes.md' }]);
    expect(existsSync(join(project, 'notes.md'))).toBe(false);
    expect(d).toMatchObject({ status: 'answered', text: 'Not written.' });
    expect(denied.tools).toEqual([{ id: expect.any(String), name: 'write_project_file', phase: 'start' }, { id: expect.any(String), name: 'write_project_file', phase: 'end', outcome: 'failed' }]);
    expect(chats().at(-1)).toMatchObject({ tool_outcomes: [{ name: 'write_project_file', outcome: 'failed' }] });
    const allowed = surface(['once']);
    const a = await chat.send('write notes.md', allowed.hooks);
    expect(allowed.asked).toHaveLength(1);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('hello\n');
    expect(a).toMatchObject({ status: 'answered', text: 'Written.' });
    expect(chats().at(-1)).toMatchObject({ tool_outcomes: [{ name: 'write_project_file', outcome: 'completed' }], files: [{ path: 'notes.md', created: true }] });
  });

  it('one agent per project in this process: a second session of the project does not start a second turn while one runs', async () => {
    const ollama = await fake({ models: [{ name: 'qwen3:8b' }], chat: [() => ({ hang: true })] });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    network(portOf(ollama));
    const first = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    const second = await contract({ project: { name: 'demo', root: project }, surface: 'companion' });
    const controller = new AbortController();
    const running = first.send('a long one', { ...surface().hooks, signal: controller.signal });
    for (let i = 0; i < 100 && ollama.chats().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const r = await second.send('hello', surface().hooks);
    expect(r).toMatchObject({ status: 'refused', sent: false, lines: ['Not sent: another chat turn of this project is running here.', 'Try: send it again when that turn ends. Nothing was sent to any model.'] });
    expect(ollama.chats()).toHaveLength(1);
    controller.abort();
    expect(await running).toMatchObject({ status: 'cancelled', sent: true });
  });

  it('two sessions of one project share the agent: a write asks the session that sends, under its own rules, and its receipt names the file', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'hello\n' } };
    const ollama = await fake({
      models: [{ name: 'qwen3:8b' }],
      chat: [() => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Written.']) })],
    });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    network(portOf(ollama));
    const first = await contract({ project: { name: 'demo', root: project }, surface: 'workbench' });
    // a second view of the project opens after the first: it must not take the first one's NEEDS YOU box or its rules
    await contract({ project: { name: 'demo', root: project }, surface: 'companion' });
    const s = surface(['once']);
    const r = await first.send('write notes.md', s.hooks);
    expect(s.asked).toMatchObject([{ tool: 'write_project_file', summary: 'notes.md' }]);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('hello\n');
    expect(r).toMatchObject({ status: 'answered', text: 'Written.' });
    expect(ollama.chats()[0].messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('the Workbench') });
    expect(chats().at(-1)).toMatchObject({ subject: 'chat.turn · workbench · 1 step · qwen3:8b', tool_outcomes: [{ name: 'write_project_file', outcome: 'completed' }], files: [{ path: 'notes.md', created: true }] });
  });

  it('tools set on a surface\'s agent after the session opened (ungated) are gated again before the turn: the write still asks', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'hello\n' } };
    const ollama = await fake({
      models: [{ name: 'qwen3:8b' }],
      chat: [() => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Not written.']) })],
    });
    setUp({ chat: 'local', model: 'qwen3:8b' }, ollama.url);
    network(portOf(ollama));
    // the surface's own agent (as the monitor hands over its own), with no key: the local route needs none
    const agent = createAgent({ apiKey: '', model: '', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(box, 'sessions'));
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'monitor' }, { agent });
    // something else on the surface sets the agent's tools again, with no gate (as a mode's tool list would)
    agent.setTools(createProjectTools({ root: () => project }) as Parameters<Agent['setTools']>[0]);
    const s = surface(['deny']);
    const r = await chat.send('write notes.md', s.hooks);
    expect(s.asked).toMatchObject([{ tool: 'write_project_file', summary: 'notes.md' }]);
    expect(existsSync(join(project, 'notes.md'))).toBe(false);
    expect(r).toMatchObject({ status: 'answered', text: 'Not written.' });
  });
});

describe('a turn on the OpenRouter route (FAKE OpenRouter client)', () => {
  /** An agent with a key whose OpenRouter client is a FAKE: it runs the tools it is given as the SDK does (executeTool), then answers. */
  function fakeOpenRouter(plan: (tools: any[]) => Promise<unknown[]>) {
    const agent = createAgent({ apiKey: 'sk-or-FAKE-key', model: 'fake/model', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(box, 'sessions'));
    const asked: string[] = [];
    (agent as unknown as { client: unknown }).client = {
      callModel: (req: { model: string; tools?: any[] }) => {
        asked.push(req.model);
        const items = plan(req.tools ?? []);
        return {
          async *getItemsStream() { for (const item of await items) yield item; },
          getResponse: async () => ({ id: 'resp-fake', usage: { cost: 0.0042 } }),
          cancel: async () => undefined,
        };
      },
    };
    return { agent, asked };
  }

  it('NEEDS YOU on this route too: the tools the model is given are the gated ones', async () => {
    const net = network();
    const { agent, asked } = fakeOpenRouter(async (tools) => {
      const t = tools.find((x) => x.function.name === 'write_project_file');
      const r = await executeTool(t, { id: 'call-1', name: 'write_project_file', arguments: { path: 'notes.md', content: 'x\n' } } as never, { numberOfTurns: 1 });
      return [
        { type: 'function_call', callId: 'call-1', name: 'write_project_file', arguments: '{"path":"notes.md","content":"x\\n"}', status: 'completed' },
        { type: 'function_call_output', callId: 'call-1', output: JSON.stringify(r.error ? { error: r.error.message } : r.result) },
        { type: 'message', id: 'm1', content: [{ text: 'Done as allowed.' }] },
      ];
    });
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'monitor' }, { agent });
    expect(chat.route()).toEqual({ kind: 'openrouter', words: 'chat: fake/model · OpenRouter', ready: true });
    const s = surface(['deny']);
    const r = await chat.send('write notes.md', s.hooks);
    expect(asked).toEqual(['fake/model']);
    expect(s.asked).toMatchObject([{ tool: 'write_project_file', summary: 'notes.md' }]);
    expect(existsSync(join(project, 'notes.md'))).toBe(false);
    expect(r).toMatchObject({ status: 'answered', text: 'Done as allowed.', sent: true, model: 'fake/model', costWords: '$0.0042 (as OpenRouter reported)' });
    expect(chats().at(-1)).toMatchObject({ model_requested: 'fake/model', model_resolved: 'fake/model', cost_usd: 0.0042, cost_measured: true });
    expect(s.tools.at(-1)).toMatchObject({ name: 'write_project_file', phase: 'end', outcome: 'failed' });
    expect(net.requests).toEqual([]);
  });

  it('the last-resort fallback: said beside the answer and sealed with OpenRouter\'s failure; never a cloud-backed model', async () => {
    const ollama = await fake({
      models: [{ name: 'kimi-k2:cloud', remote_host: 'https://ollama.com:443' }, { name: 'granite4.2:latest' }],
      completions: [() => ({ content: 'FAKE local answer.' })],
    });
    process.env.OLLAMA_HOST = ollama.url;
    network(portOf(ollama));
    const agent: Agent = createAgent({ apiKey: 'sk-or-FAKE-key', model: 'fake/model', instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: 'none' });
    agent.useSessions(join(box, 'sessions'));
    (agent as unknown as { client: unknown }).client = { callModel: () => { throw new Error('503 Service Unavailable (FAKE)'); } };
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'monitor' }, { agent });
    const r = await chat.send('hello', surface().hooks);
    expect(r).toMatchObject({ status: 'answered', text: 'FAKE local answer.', sent: true, model: 'ollama/granite4.2:latest', costWords: 'cost unknown' });
    expect(r.lines).toEqual(['OpenRouter failed: fake/model: 503 Service Unavailable (FAKE); then anthropic/claude-opus-4.7: 503 Service Unavailable (FAKE); answered by local granite4.2:latest on this computer\'s Ollama, the last-resort fallback.']);
    expect(chats().at(-1)).toMatchObject({
      model_requested: 'fake/model', model_resolved: 'ollama/granite4.2:latest', via: 'ollama',
      sources: [{ kind: 'ollama', host: ollama.host, endpoint: 'local', tools: 'off', cost_basis: 'local endpoint', role: 'last-resort fallback', openrouter_failed: expect.stringContaining('503 Service Unavailable') }],
      cost_measured: false,
    });
    expect(ollama.requests.filter((q) => q.path === '/v1/chat/completions').map((q) => q.body.model)).toEqual(['granite4.2:latest']);
  });
});
