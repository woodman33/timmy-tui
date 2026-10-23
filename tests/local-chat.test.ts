// R4 (H103): the REPL's chat on a local model. The real agent (src/agent/core.ts) on its local route (src/agent/local-chat.ts)
// against a FAKE Ollama (tests/fixtures/fake-ollama-chat.ts: a real HTTP server on 127.0.0.1 answering as Ollama's API does,
// no model behind it), with the REPL's real tools (replTools, as src/repl/main.ts makes them) behind the real NEEDS YOU gate
// (gateTools); the person who answers the box is the test (FAKE answers, labelled). Turns go through the real runTurn, the
// real transcript and the real seal, into a temporary receipts store.
//
// What is checked: a streamed answer; a read-only tool the model calls, run and given back as the tool's own answer; a tool
// that needs a person (denied: nothing ran; allowed once: the file written); a model without tool support (no tools sent,
// said so); a model whose /api/show lists no capabilities; Ollama refusing tools; an unreachable host and a missing model
// (words and the fix, and never OpenRouter or another model); a cloud-backed model that is not named as one (refused, no chat
// request); the step limit; an unknown tool; a cancel mid-stream; the cost (no charge on a local endpoint, unknown otherwise).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, UNANSWERED, type Agent } from '../src/agent/core.js';
import { forgetShownModel, LocalChatError, rememberShownModel, showModelOnce, shownModelKept } from '../src/agent/local-chat.js';
import { ollamaAt, type OllamaAt } from '../src/setup/ollama-models.js';
import { sealedRoute } from '../src/agent/chat-route.js';
import { ProjectTurnFiles } from '../src/agent/project-tools.js';
import { gateTools, type ApprovalRequest, type Decision } from '../src/repl/approvals.js';
import { REPL_INSTRUCTIONS, replTools } from '../src/repl/main.js';
import { sealTurn } from '../src/repl/seal.js';
import { Transcript } from '../src/repl/transcript.js';
import { runTurn } from '../src/repl/turn.js';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { readChain } from '../src/utils/receipts.js';
import { closedPort, startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
// R11 Phase 2 (H169, item c): the route's words for Ollama's cloud
import { localRouteWords, type ChatRoute } from '../src/agent/chat-route.js';

const MODEL = 'qwen3:8b';
const fakes: FakeOllama[] = [];
let box = '';
let project = '';
beforeEach(() => {
  forgetShownModel();
  box = mkdtempSync(join(tmpdir(), 'local-chat-'));
  project = join(box, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  writeFileSync(join(project, 'src', 'app.ts'), 'export const x = 1;\n');
});
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  rmSync(box, { recursive: true, force: true });
});
const fake = async (o: Parameters<typeof startFakeOllama>[0]): Promise<FakeOllama> => { const f = await startFakeOllama(o); fakes.push(f); return f; };

/**
 * The agent as the REPL makes it, on the local route: its conversation in this test's folder, the REPL's tools behind the
 * NEEDS YOU gate (`answer` is the FAKE person at the box), and a guard in place of the OpenRouter client: it throws if called.
 */
function localAgent(host: string, model: string, answer: Decision = 'deny', maxSteps = 10) {
  const agent = createAgent({ apiKey: '', model: 'anthropic/claude-opus-4.7', instructions: REPL_INSTRUCTIONS, maxSteps, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(box, 'sessions'));
  let openRouterCalls = 0;
  (agent as unknown as { client: unknown }).client = { callModel: () => { openRouterCalls++; throw new Error('FAKE guard: the OpenRouter client was called'); } };
  const asked: ApprovalRequest[] = [];
  const files = new ProjectTurnFiles();
  agent.setTools(gateTools(replTools(undefined, { root: () => project, touched: files }), async (req) => { asked.push(req); return answer; }));
  agent.useLocalChat({ host, model });
  return { agent, asked, files, openRouterCalls: () => openRouterCalls };
}

class Sink { writes: string[] = []; isTTY = false; write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }
/** A real turn: runTurn, the transcript (plain, 100 columns) and the seal, as the REPL does it (src/repl/main.ts). */
async function turn(agent: Agent, text: string, files: ProjectTurnFiles, signal?: AbortSignal) {
  const out = new Sink();
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
  const transcript = new Transcript(buildTheme(caps), new LiveRegion({ out, err: out }, { live: false }), { columns: 100 });
  let t = 0;
  const result = await runTurn(agent, transcript, text, () => (t += 1000), undefined, signal, (facts) => {
    const local = agent.localChatRoute();
    return sealTurn({ ...facts, model: agent.getModel(), project: 'demo', files: files.close(), ...(local ? { route: sealedRoute(local, agent.lastLocalTurn()) } : {}) });
  });
  const receipt = readChain('runs').filter((r) => r.kind === 'turn').at(-1);
  return { result, out: out.text, receipt };
}
const toolMessages = (req: any): any[] => (req?.messages ?? []).filter((m: any) => m.role === 'tool');

describe('the chat on a local model (FAKE Ollama)', () => {
  it('streams the answer from the Ollama the route names, with the REPL\'s tools offered, and seals it as no charge on a local endpoint', async () => {
    const ollama = await fake({ models: [{ name: MODEL }], chat: [() => ({ chunks: textChunks(MODEL, ['Hel', 'lo ', 'there.']), delayMs: 5 })] });
    const { agent, files, openRouterCalls } = localAgent(ollama.url, MODEL);
    const deltas: string[] = [];
    agent.on('stream:delta', (d) => deltas.push(d));
    const costs: unknown[] = [];
    agent.on('cost:update', (...a) => costs.push(a));
    const { result, out, receipt } = await turn(agent, 'hi', files);
    expect(result).toBe('ok');
    expect(deltas).toEqual(['Hel', 'lo ', 'there.']);
    expect(costs).toEqual([[0, 0, { complete: true, basis: 'local endpoint' }]]);
    expect(out).toContain('Hello there.');
    expect(out).toMatch(/0 steps · no charge \(local endpoint\) · \d+(\.\d)?s · qwen3:8b/);
    // what was sent: /api/show (what the model can do), then one streamed /api/chat with the instructions, the message and the tools
    expect(ollama.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/show', 'POST /api/chat']);
    const [req] = ollama.chats();
    expect(req).toMatchObject({ model: MODEL, stream: true });
    expect(req.messages[0]).toEqual({ role: 'system', content: REPL_INSTRUCTIONS });
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
    const names = req.tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['list_project_files', 'read_project_file', 'write_project_file', 'get_current_time']));
    // every tool as Ollama takes it: a function with a JSON schema (from the same zod schema the OpenRouter route converts)
    for (const t of req.tools) expect(t).toMatchObject({ type: 'function', function: { name: expect.any(String), parameters: { type: 'object' } } });
    expect(openRouterCalls()).toBe(0);
    // the receipt: the model asked, where it went, and no charge on a local endpoint
    expect(receipt).toMatchObject({ kind: 'turn', status: 'ok', model_requested: MODEL, model_resolved: MODEL, via: 'ollama', cost_usd: 0, cost_measured: true });
    expect(receipt?.sources).toEqual([{ kind: 'ollama', host: ollama.host, endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }]);
    expect(agent.getHistory().map((m) => [m.role, m.content])).toEqual([['user', 'hi'], ['assistant', 'Hello there.']]);
  });

  it('a read-only tool the model calls runs without asking, and the model is given the tool\'s own answer', async () => {
    const ollama = await fake({
      models: [{ name: MODEL }],
      chat: [
        () => ({ chunks: toolCallChunks(MODEL, [{ name: 'list_project_files', arguments: {} }]) }),
        () => ({ chunks: textChunks(MODEL, ['The project has README.md and src/app.ts.']) }),
      ],
    });
    const { agent, asked, files } = localAgent(ollama.url, MODEL);
    const { result, out, receipt } = await turn(agent, 'what files are here?', files);
    expect(result).toBe('ok');
    expect(asked).toEqual([]);
    const [first, second] = ollama.chats();
    expect(toolMessages(first)).toEqual([]);
    // the second request carries the model's call and the tool's answer, as Ollama's chat API takes them
    expect(second.messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'list_project_files', arguments: {} } }] });
    const [tool] = toolMessages(second);
    expect(tool.tool_name).toBe('list_project_files');
    const answer = JSON.parse(tool.content);
    expect(answer.ok).toBe(true);
    expect(JSON.stringify(answer)).toContain('src/app.ts');
    expect(JSON.stringify(answer)).toContain('README.md');
    expect(out).toContain('list_project_files');
    expect(out).toContain('The project has README.md and src/app.ts.');
    expect(out).toMatch(/1 step · no charge \(local endpoint\)/);
    expect(receipt).toMatchObject({ tool_outcomes: [{ name: 'list_project_files', outcome: 'completed' }], via: 'ollama' });
  });

  it('a tool that needs a person waits at NEEDS YOU: denied, nothing ran and the model is told; allowed once, the file is written', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'from the local model\n' } };
    const denied = await fake({ models: [{ name: MODEL }], chat: [() => ({ chunks: toolCallChunks(MODEL, [write]) }), () => ({ chunks: textChunks(MODEL, ['I could not write it.']) })] });
    const no = localAgent(denied.url, MODEL, 'deny');
    const d = await turn(no.agent, 'write notes.md', no.files);
    expect(d.result).toBe('ok');
    expect(no.asked.map((r) => [r.tool, r.reason, r.summary])).toEqual([['write_project_file', 'changes a file in your project', 'notes.md']]);
    expect(existsSync(join(project, 'notes.md'))).toBe(false);
    expect(JSON.parse(toolMessages(denied.chats()[1])[0].content)).toEqual({ error: 'The operator denied write_project_file; it did not run.' });
    expect(d.receipt).toMatchObject({ tool_outcomes: [{ name: 'write_project_file', outcome: 'failed' }] });

    const allowed = await fake({ models: [{ name: MODEL }], chat: [() => ({ chunks: toolCallChunks(MODEL, [write]) }), () => ({ chunks: textChunks(MODEL, ['Written.']) })] });
    const yes = localAgent(allowed.url, MODEL, 'once');
    const y = await turn(yes.agent, 'write notes.md', yes.files);
    expect(y.result).toBe('ok');
    expect(yes.asked).toHaveLength(1);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('from the local model\n');
    expect(JSON.parse(toolMessages(allowed.chats()[1])[0].content)).toMatchObject({ ok: true });
    // the turn's receipt names the file it wrote, with its hash, as on the OpenRouter route
    expect(y.receipt).toMatchObject({ tool_outcomes: [{ name: 'write_project_file', outcome: 'completed' }], files: [{ path: 'notes.md', created: true }] });
  });

  it('a model that does not take tool calls: no tools are sent, the instructions say there are none, and the turn says so', async () => {
    const ollama = await fake({ models: [{ name: 'tiny:1b', capabilities: ['completion'] }], chat: [() => ({ chunks: textChunks('tiny:1b', ['Hi.']) })] });
    const { agent, files } = localAgent(ollama.url, 'tiny:1b');
    const { result, out, receipt } = await turn(agent, 'list the files', files);
    expect(result).toBe('ok');
    const [req] = ollama.chats();
    expect(req).not.toHaveProperty('tools');
    expect(req.messages[0].content).toContain('No tools are available in this conversation');
    expect(out.replace(/\s+/g, ' ')).toContain('tools off: tiny:1b does not take tool calls. This turn runs without tools.');
    expect(receipt?.sources).toEqual([expect.objectContaining({ kind: 'ollama', tools: 'off' })]);
  });

  it('a model whose /api/show lists no capabilities (an older Ollama): tools off, said so; Ollama refusing tools: the turn goes on without them', async () => {
    const old = await fake({ models: [{ name: 'old:7b', capabilities: null }], chat: [() => ({ chunks: textChunks('old:7b', ['Hello.']) })] });
    const a = localAgent(old.url, 'old:7b');
    expect((await turn(a.agent, 'hi', a.files)).out.replace(/\s+/g, ' ')).toContain('tools off: Ollama did not say whether old:7b takes tool calls (its /api/show lists no capabilities). This turn runs without tools.');
    expect(old.chats()[0]).not.toHaveProperty('tools');

    const refusing = await fake({
      models: [{ name: 'mixed:3b' }],
      chat: [() => ({ status: 400, error: 'registry.ollama.ai/library/mixed:3b does not support tools' }), () => ({ chunks: textChunks('mixed:3b', ['Fine.']) })],
    });
    const b = localAgent(refusing.url, 'mixed:3b');
    const r = await turn(b.agent, 'hi', b.files);
    expect(r.result).toBe('ok');
    expect(r.out.replace(/\s+/g, ' ')).toContain('tools off: Ollama says mixed:3b does not support tools');
    const [first, second] = refusing.chats();
    expect(first.tools.length).toBeGreaterThan(0);
    expect(second).not.toHaveProperty('tools');
    expect(r.out).toContain('Fine.');
  });

  it('R28 (R11 Phase 2): /api/show is asked once per model choice, not before every chat: three sends are 1 show and 3 chats; an Ollama that stops answering is asked again', async () => {
    const script = (n: number) => () => ({ chunks: textChunks(MODEL, [`answer ${n}`]) });
    const ollama = await fake({ models: [{ name: MODEL, capabilities: ['completion', 'tools'] }], chat: [script(1), script(2), script(3)] });
    const at = ollamaAt(ollama.url) as OllamaAt;
    forgetShownModel();
    expect(shownModelKept(at, MODEL)).toBeNull();
    const { agent, files, openRouterCalls } = localAgent(ollama.url, MODEL);
    for (const q of ['one', 'two', 'three']) expect((await turn(agent, q, files)).result).toBe('ok');
    // what the FAKE was sent: one /api/show (the first turn's), then a chat per send
    expect(ollama.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/show', 'POST /api/chat', 'POST /api/chat', 'POST /api/chat']);
    expect(ollama.chats().map((c) => c.messages.at(-1).content)).toEqual(['one', 'two', 'three']);
    // every chat still carried the tools /api/show listed (the kept answer, not a guess)
    for (const c of ollama.chats()) expect(c.tools.map((x: any) => x.function.name)).toContain('get_current_time');
    expect(shownModelKept(at, MODEL)).toEqual({ capabilities: ['completion', 'tools'], remote: null });
    expect(openRouterCalls()).toBe(0);
    // the Ollama stops answering: the turn fails, and the kept answer is dropped, so the next turn asks /api/show again
    await ollama.close();
    fakes.splice(fakes.indexOf(ollama), 1);
    agent.on('error', () => undefined);
    expect((await turn(agent, 'four', files)).result).toBe('failed');
    expect(shownModelKept(at, MODEL)).toBeNull();
    // a check made elsewhere (the setup's choice check) can be kept, and the first turn then asks nothing before its chat
    rememberShownModel(at, MODEL, { capabilities: ['completion'], remote: null });
    expect(await showModelOnce(at, MODEL)).toEqual({ shown: { capabilities: ['completion'], remote: null }, asked: false });
    forgetShownModel(at, MODEL);
    expect(shownModelKept(at, MODEL)).toBeNull();
  });

  it('an Ollama that does not answer fails the turn with words and the fix; nothing goes to OpenRouter or another model', async () => {
    const port = await closedPort();
    const { agent, files, openRouterCalls } = localAgent(`http://127.0.0.1:${port}`, MODEL);
    const errors: Error[] = [];
    agent.on('error', (e) => errors.push(e));
    const { result, out, receipt } = await turn(agent, 'hi', files);
    expect(result).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LocalChatError);
    expect(out).toContain(`Error: Ollama at 127.0.0.1:${port} did not answer, so nothing was sent.`);
    expect(out).toMatch(/Cause: the connection failed \(ECONNREFUSED\)/);
    expect(out.replace(/\s+/g, ' ')).toContain('Try: start Ollama (the Ollama app, or ollama serve), or /setup chat; no other model is tried.');
    expect(out).not.toMatch(/setup key/);
    expect(openRouterCalls()).toBe(0);
    // a local endpoint costs nothing, even when it did not answer
    expect(receipt).toMatchObject({ status: 'failed', via: 'ollama', cost_usd: 0, cost_measured: true });
    expect(receipt?.sources).toEqual([expect.objectContaining({ endpoint: 'local', tools: 'unknown', cost_basis: 'local endpoint' })]);
    // the request it never answered is closed before the next one, as on the OpenRouter route
    expect(agent.getHistory().map((m) => m.role)).toEqual(['user']);
  });

  it('a model Ollama does not list: refused with the words and the fix (Timmy downloads nothing), and no chat request is sent', async () => {
    const ollama = await fake({ models: [{ name: 'other:8b' }] });
    const { agent, files, openRouterCalls } = localAgent(ollama.url, MODEL);
    const { result, out } = await turn(agent, 'hi', files);
    expect(result).toBe('failed');
    expect(out).toContain(`Error: Ollama at ${ollama.host} has no model named qwen3:8b, so nothing was sent.`);
    expect(out).toContain("Cause: its answer: model 'qwen3:8b' not found (Timmy downloads nothing)");
    expect(out).toContain('Try: /model lists what it has; ollama pull qwen3:8b installs it; no other model is tried.');
    expect(ollama.chats()).toEqual([]);
    expect(openRouterCalls()).toBe(0);
  });

  it('a cloud-backed model whose name does not say cloud is refused before anything is sent; one named as cloud runs on Ollama\'s servers (your account\'s terms), cost unknown, its receipt naming the route (R11 Phase 2 item c)', async () => {
    const hidden = await fake({ models: [{ name: 'alias:latest', remote_host: 'https://ollama.example:443' }] });
    const a = localAgent(hidden.url, 'alias:latest');
    const r = await turn(a.agent, 'hi', a.files);
    expect(r.result).toBe('failed');
    expect(r.out).toContain('Error: Ollama would send this chat off this computer, so nothing was sent.');
    expect(r.out).toContain('Cause: Ollama names https://ollama.example:443 for alias:latest; its name does not say cloud.');
    expect(hidden.chats()).toEqual([]);

    const named = await fake({ models: [{ name: 'big:120b-cloud', remote_host: 'https://ollama.example:443' }], chat: [() => ({ chunks: textChunks('big:120b-cloud', ['Hi from far away.']) })] });
    const b = localAgent(named.url, 'big:120b-cloud');
    const costs: unknown[] = [];
    b.agent.on('cost:update', (...x) => costs.push(x));
    const t = await turn(b.agent, 'hi', b.files);
    expect(t.result).toBe('ok');
    expect(t.out.replace(/\s+/g, ' ')).toContain('big:120b-cloud runs on Ollama\'s servers; your account\'s terms: Ollama sends this chat off this computer, and no cost comes back (unknown).');
    expect(t.out).toMatch(/cost unknown/);
    expect(t.out).not.toMatch(/no charge|free/);
    expect(costs).toEqual([[0, 0, { complete: false }]]);
    expect(b.agent.lastLocalTurn()).toMatchObject({ cloud: true, localEndpoint: false });
    // the receipt names the route: endpoint cloud, "ollama cloud", its cost basis unknown (never no charge)
    expect(t.receipt).toMatchObject({ via: 'ollama', cost_usd: 0, cost_measured: false });
    expect(t.receipt?.sources).toEqual([expect.objectContaining({ kind: 'ollama', endpoint: 'cloud', route: 'ollama cloud', cost_basis: 'unknown' })]);
    expect(sealedRoute({ host: named.url, model: 'big:120b-cloud' }, b.agent.lastLocalTurn())).toMatchObject({ endpoint: 'cloud', route: 'ollama cloud', costBasis: 'unknown' });
    // the route's words, for every surface's label: the route's name and the model
    expect(localRouteWords({ kind: 'local', host: named.url, at: ollamaAt(named.url), model: 'big:120b-cloud', from: 'the setup', cloud: true } as Extract<ChatRoute, { kind: 'local' }>)).toBe('chat: ollama cloud · big:120b-cloud');
  });

  it('stops at the step limit: the calls asked for after it are named and do not run', async () => {
    const ollama = await fake({
      models: [{ name: MODEL }],
      chat: [
        () => ({ chunks: toolCallChunks(MODEL, [{ name: 'get_current_time', arguments: {} }]) }),
        () => ({ chunks: toolCallChunks(MODEL, [{ name: 'write_project_file', arguments: { path: 'x.md', content: 'x' } }]) }),
      ],
    });
    const { agent, asked, files } = localAgent(ollama.url, MODEL, 'once', 1);
    const { result, out, receipt } = await turn(agent, 'go', files);
    expect(result).toBe('ok');
    expect(out.replace(/\s+/g, ' ')).toContain('Stopped at the 1-step limit: qwen3:8b asked for one more tool call (write_project_file), which did not run. Send another message to go on.');
    expect(asked).toEqual([]);
    expect(existsSync(join(project, 'x.md'))).toBe(false);
    expect(receipt?.tool_outcomes).toEqual([{ name: 'get_current_time', outcome: 'completed' }]);
  });

  it('a call to a tool the chat does not offer is answered with that, and nothing runs', async () => {
    const ollama = await fake({
      models: [{ name: MODEL }],
      chat: [() => ({ chunks: toolCallChunks(MODEL, [{ name: 'format_disk', arguments: {} }]) }), () => ({ chunks: textChunks(MODEL, ['No such tool.']) })],
    });
    const { agent, files } = localAgent(ollama.url, MODEL);
    const { result, receipt } = await turn(agent, 'go', files);
    expect(result).toBe('ok');
    expect(JSON.parse(toolMessages(ollama.chats()[1])[0].content)).toEqual({ error: 'No tool named format_disk is offered in this chat; nothing ran.' });
    expect(receipt?.tool_outcomes).toEqual([{ name: 'format_disk', outcome: 'failed' }]);
  });

  it('a cancel mid-stream stops the answer, keeps what was written in the record, and costs nothing on a local endpoint', async () => {
    const ollama = await fake({ models: [{ name: MODEL }], chat: [() => ({ chunks: textChunks(MODEL, ['one ', 'two ', 'three ', 'four ', 'five']), delayMs: 60 })] });
    const { agent, files } = localAgent(ollama.url, MODEL);
    const controller = new AbortController();
    agent.on('stream:delta', (_d, full) => { if (full.includes('two')) controller.abort(); });
    const { result, out, receipt } = await turn(agent, 'count', files, controller.signal);
    expect(result).toBe('cancelled');
    expect(out).toContain('no charge (local endpoint)');
    expect(receipt).toMatchObject({ status: 'cancelled', cost_usd: 0, cost_measured: true, via: 'ollama' });
    const last = agent.getHistory().at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('[Cancelled by the user before I finished answering. No tool had run.');
    expect(last.content).toContain('What I had written so far: "one two');
    expect(last.content).not.toBe(UNANSWERED);
  });
});
