// R4 (H113, part 2): one conversation per project, across the surfaces and their processes (src/agent/chat-turn.ts).
//
// - A turn in the Workbench's Chat, in a process of its own, continues the project's kept conversation (.sessions) that the
//   REPL's turn began, and the REPL's next turn reads the Workbench's (and says so); each receipt names its surface.
// - One turn at a time in a project across processes: while the Workbench's turn runs, the REPL's is refused and nothing is
//   sent (two surfaces never start a second agent for one turn); a hold whose process is gone (killed) is stale, and the next
//   turn goes, the dead turn's unanswered request closed as the agent closes one.
// - A message with a key (the companion's page sends one) is sent once: sent again (a reconnect), from this process or
//   another, it is refused naming its receipt, and nothing more is sent.
// - The REPL's /new is kept: a conversation this surface started and has not written yet is the newest.
//
// Real pieces: the agent (src/agent/core.ts), the turn (src/repl/turn.ts), the conversation files, the hold files and their
// process proof (ps), signed receipt chains, and the other surface as a real child process (tests/fixtures/chat-surface-
// fixture.ts through tsx), killed with SIGKILL in one test. FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1
// (tests/fixtures/fake-ollama-chat.ts: no model behind it), and the network is a recording fetch in both processes (FAKE:
// anything but that Ollama is refused before it leaves).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession, projectStore } from '../src/agent/chat-session.js';
import { CHAT_TURNS_DIR, projectTurn, type Continued } from '../src/agent/chat-turn.js';
import { createAgent, UNANSWERED, type Agent } from '../src/agent/core.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const PRELOAD = pathToFileURL(resolve('tests/fixtures/record-fetch-preload.mjs')).href;
const FIXTURE = resolve('tests/fixtures/chat-surface-fixture.ts');

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let ollama: FakeOllama | null = null;
let restoreNet: (() => void) | null = null;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-one-conv-'));
  project = join(box, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  // the project's own store, pinned in its folder (src/utils/receipts.ts rootStoreDir): its seals land there, whatever is above it
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const) delete process.env[v];
});
afterEach(async () => {
  for (const c of children.splice(0)) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }
  restoreNet?.();
  restoreNet = null;
  await ollama?.close();
  ollama = null;
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
}, 30_000);

/** The FAKE Ollama, the setup choosing it for the chat (local, qwen3:8b), and this process's recording fetch. */
async function local(chat: Parameters<typeof startFakeOllama>[0]['chat']): Promise<FakeOllama> {
  ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat });
  mkdirSync(process.env.TIMMY_HOME!, { recursive: true });
  writeFileSync(join(process.env.TIMMY_HOME!, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
  writeFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', chat: 'local', model: 'qwen3:8b' } }));
  restoreNet = recordFetch(onlyPorts(new URL(ollama.url).port)).restore;
  return ollama;
}
const answer = (text: string) => () => ({ chunks: textChunks('qwen3:8b', [text]) });

/** The REPL's agent in this process, on the chat's local route (as src/repl/main.ts sets it before each message). */
function replAgent(): Agent {
  const agent = createAgent({ apiKey: '', model: '', instructions: 'You are the REPL (test).', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
  agent.useSessions(join(project, '.sessions'));
  agent.useLocalChat({ host: ollama!.url, model: 'qwen3:8b' });
  return agent;
}
/** One REPL turn of the project, as src/repl/main.ts runs it (its seal into the project's store), with what it continued. */
async function replTurn(agent: Agent, text: string) {
  let continued: Continued | null = null;
  const r = await projectTurn({
    agent, project: { name: 'demo', root: project }, surface: 'repl', text, sink: { handle: () => undefined, endTurn: () => undefined },
    seal: (f) => sealTurn({ ...f, model: 'qwen3:8b', project: 'demo', projectId: projectId(project) }, projectStore(project)),
    onContinue: (c) => { continued = c; },
  });
  return { r, continued: continued as Continued | null };
}

/** Another surface in a process of its own (the Workbench's composer, the companion's page): its turn's result. */
function surface(o: { surface: string; text: string; key?: string }) {
  const child = spawn(process.execPath, ['--import', LOADER, '--import', PRELOAD, FIXTURE], {
    cwd: box,
    env: {
      PATH: process.env.PATH, HOME: join(box, 'home'), TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR,
      TIMMY_TEST_FETCH_LOG: join(box, 'child-fetches.jsonl'), TIMMY_TEST_FETCH_ALLOW: new URL(ollama!.url).port,
      CHAT_PROJECT: project, CHAT_SURFACE: o.surface, CHAT_TEXT: o.text, ...(o.key ? { CHAT_KEY: o.key } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr!.on('data', (c: Buffer) => { err += c.toString(); });
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const waitFor = async (re: RegExp, ms = 30_000): Promise<RegExpExecArray> => {
    const t0 = Date.now();
    for (;;) {
      const m = re.exec(out);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error(`waited for ${re} in the surface's output: ${out}\n${err}`);
      await sleep(50);
    }
  };
  return {
    child, exited, waitFor,
    result: async () => JSON.parse((await waitFor(/^RESULT (.*)$/m))[1]) as { status: string; lines?: string[]; sent: boolean; receipt?: string; text: string },
  };
}

const conversationFiles = (): string[] => (existsSync(join(project, '.sessions')) ? readdirSync(join(project, '.sessions')).filter((n) => n.endsWith('.jsonl')).sort() : []);
const conversation = (file: string) => readFileSync(join(project, '.sessions', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { role: string; content: string });
const said = (messages: Array<{ role: string; content: string }>) => messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`);
const receipts = () => readChain('runs', project).map((r) => ({ kind: r.kind, subject: r.subject }));

describe('one conversation per project, across surfaces and processes (R4 H113, part 2)', () => {
  it('the Workbench\'s turn (another process) continues the REPL\'s conversation, the REPL\'s next turn reads it, and each receipt names its surface', async () => {
    await local([answer('One.'), answer('Two.'), answer('Three.')]);
    const repl = replAgent();
    expect((await replTurn(repl, 'first')).r.status).toBe('ok');
    const wb = surface({ surface: 'workbench', text: 'second' });
    expect(await wb.result()).toMatchObject({ status: 'answered', text: 'Two.', sent: true });
    const third = await replTurn(repl, 'third');
    expect(third.r.status).toBe('ok');
    // the REPL's next turn read what the Workbench added: its message and its answer
    expect(third.continued).toMatchObject({ added: 2, moved: false, messages: 4 });
    // what the model was asked, each time: the one conversation, in order (the Workbench's included)
    const asked = ollama!.chats().map((c) => said(c.messages));
    expect(asked).toEqual([
      ['user: first'],
      ['user: first', 'assistant: One.', 'user: second'],
      ['user: first', 'assistant: One.', 'user: second', 'assistant: Two.', 'user: third'],
    ]);
    // one conversation kept in the project, every surface's turn in it
    expect(conversationFiles()).toHaveLength(1);
    expect(said(conversation(conversationFiles()[0]))).toEqual(['user: first', 'assistant: One.', 'user: second', 'assistant: Two.', 'user: third', 'assistant: Three.']);
    // each receipt names the surface that sent its turn, in the project's store
    expect(receipts()).toEqual([
      { kind: 'turn', subject: 'repl · 0 steps' },
      { kind: 'chat', subject: 'chat.turn · workbench · 0 steps · qwen3:8b' },
      { kind: 'turn', subject: 'repl · 0 steps' },
    ]);
    // no hold is left behind
    expect(readdirSync(join(project, CHAT_TURNS_DIR)).filter((n) => n.endsWith('.json'))).toEqual([]);
  }, 90_000);

  it('one turn at a time: while the Workbench\'s turn runs in its process, the REPL\'s is refused and nothing is sent; once that process is killed, the next turn goes', async () => {
    await local([() => ({ hang: true }), answer('Back.')]);
    const wb = surface({ surface: 'workbench', text: 'a long one' });
    const [, pid] = await wb.waitFor(/^SENDING (\d+)$/m);
    for (let i = 0; i < 400 && ollama!.chats().length === 0; i++) await sleep(50);
    expect(ollama!.chats()).toHaveLength(1);
    const repl = replAgent();
    const refused = await replTurn(repl, 'hello');
    expect(refused.r).toEqual({ status: 'refused', lines: [
      expect.stringMatching(new RegExp(`^Not sent: a chat turn of this project is running in the Workbench \\(pid ${pid}, since [^)]+\\)\\.$`)),
      'Try: send it again when that turn ends: one turn at a time keeps the project\'s one conversation in order. Nothing was sent to any model.',
    ] });
    // nothing was sent: the model was asked once (the Workbench's), and this REPL's message is not in the conversation
    await sleep(300);
    expect(ollama!.chats()).toHaveLength(1);
    expect(said(conversation(conversationFiles()[0]))).toEqual(['user: a long one']);
    // the Workbench's process ends without its stop path (SIGKILL): its hold names a process that is gone
    wb.child.kill('SIGKILL');
    await wb.exited;
    const again = await replTurn(repl, 'hello again');
    expect(again.r.status).toBe('ok');
    expect(ollama!.chats()).toHaveLength(2);
    // the dead turn's request was closed as the agent closes an unanswered one, then this one went
    expect(said(ollama!.chats()[1].messages)).toEqual(['user: a long one', `assistant: ${UNANSWERED}`, 'user: hello again']);
    expect(readdirSync(join(project, CHAT_TURNS_DIR)).filter((n) => n.endsWith('.json'))).toEqual([]);
  }, 90_000);

  it('a message with a key is sent once: sent again (a reconnect), here or from another process, it is refused naming its receipt', async () => {
    await local([answer('Once.'), answer('never asked')]);
    const chat = await openChatSession({ project: { name: 'demo', root: project }, surface: 'companion' }, { agent: replAgent() });
    const hooks = { onText: () => undefined, askPerson: async () => 'deny' as const };
    const first = await chat.sendOnce('k-0123456789abcdef', 'hello', hooks);
    expect(first).toMatchObject({ status: 'answered', text: 'Once.', sent: true, receipt: expect.stringMatching(/^sha256_/) });
    const again = await chat.sendOnce('k-0123456789abcdef', 'hello', hooks);
    expect(again).toEqual({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: [
      expect.stringMatching(new RegExp(`^Not sent again: this message was already sent from the companion at \\S+ \\(receipt ${first.receipt!.slice(7, 15)}\\)\\.$`)),
      'Nothing was sent to any model.',
    ] });
    const elsewhere = surface({ surface: 'companion', text: 'hello', key: 'k-0123456789abcdef' });
    expect(await elsewhere.result()).toMatchObject({ status: 'refused', sent: false, lines: [expect.stringContaining(`(receipt ${first.receipt!.slice(7, 15)})`), 'Nothing was sent to any model.'] });
    expect(ollama!.chats()).toHaveLength(1);
    expect(receipts()).toEqual([{ kind: 'chat', subject: 'chat.turn · companion · 0 steps · qwen3:8b' }]);
  }, 90_000);

  it('the REPL\'s /new is kept: the conversation it started and has not written yet is the newest, and the next turn continues it', async () => {
    await local([answer('Old.'), answer('New.'), answer('Newer.')]);
    const repl = replAgent();
    await replTurn(repl, 'first');
    await sleep(5);
    repl.startSession();
    const fresh = await replTurn(repl, 'a fresh start');
    expect(fresh.continued).toMatchObject({ added: 0, messages: 0 });
    expect(said(ollama!.chats()[1].messages)).toEqual(['user: a fresh start']);
    expect(conversationFiles()).toHaveLength(2);
    // a Workbench turn now continues the newest conversation: the fresh one
    const wb = surface({ surface: 'workbench', text: 'and then' });
    expect(await wb.result()).toMatchObject({ status: 'answered', text: 'Newer.' });
    expect(said(ollama!.chats()[2].messages)).toEqual(['user: a fresh start', 'assistant: New.', 'user: and then']);
  }, 90_000);
});
