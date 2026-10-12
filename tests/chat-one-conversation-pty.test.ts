// R4 (H113, part 2): the REPL itself (`timmy repl`, src/repl/main.ts's chat part) in a real terminal (tmux, 100 x 40) takes
// part in the project's one conversation (src/agent/chat-turn.ts): while another surface's turn holds the project, a message
// typed in the REPL is refused in its words and nothing is sent; a turn the Workbench's session then sends (in this test's
// process, as the terminal Workbench's composer sends it) continues the REPL's conversation; and the REPL's next message reads
// what the Workbench added, and says so before its answer.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it), and
// this test's process has a recording fetch (FAKE network: anything else is refused before it leaves). The other surface's
// running turn is a real hold taken by this live process (src/agent/chat-turn.ts takeTurnHold), as the Workbench takes one.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const PRELOAD = pathToFileURL(resolve('tests/fixtures/record-fetch-preload.mjs')).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VARS = ['TIMMY_HOME', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
}, 30_000);

function terminal(dir: string, env: NodeJS.ProcessEnv, label: string) {
  const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', dir, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT1=$?; sleep 60`);
  const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', 't');
  const waitFor = async (re: RegExp): Promise<string> => {
    for (let i = 0; i < 1200; i++) {
      const s = screen();
      if (re.test(s)) return s;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${re}:\n${screen()}`);
  };
  const type = (text: string) => { if (text) tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  return { screen, waitFor, type, close: () => { try { tmux('kill-server'); } catch { /* gone */ } } };
}

const said = (messages: Array<{ role: string; content: string }>) => messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`);

describe('the REPL in the project\'s one conversation, in a terminal (R4 H113)', () => {
  it('both routes set up, the header names the local one; refused while another surface\'s turn holds the project; then it reads what the Workbench added, and says so; nothing goes to OpenRouter', async () => {
    const ollama: FakeOllama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: [
        () => ({ chunks: textChunks('qwen3:8b', ['From the REPL.']) }),
        () => ({ chunks: textChunks('qwen3:8b', ['From the Workbench.']) }),
        () => ({ chunks: textChunks('qwen3:8b', ['Back in the REPL.']) }),
      ],
    });
    cleanups.push(() => ollama.close());
    const dir = mkdtempSync(join(tmpdir(), 'chat-one-conv-pty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // the project's own store, pinned in its folder: the Workbench's seals (this process) land there, whatever is above it
    mkdirSync(join(dir, '.timmy'), { recursive: true });
    writeFileSync(join(dir, '.timmy', 'store-pin'), join(dir, '.timmy', 'receipts'));
    const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night' };
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', 'qwen3:8b'], { cwd: dir, env, timeout: 50_000 });
    // R4 (H113, part 4): both routes set up: the local model chosen, and an OpenRouter key (FAKE, made now); the REPL's own
    // fetch is recorded (FAKE network: anything but the FAKE Ollama is refused before it leaves)
    const fetchLog = join(dir, 'repl-fetches.jsonl');
    Object.assign(env, { OPENROUTER_API_KEY: `sk-or-FAKE-${randomBytes(8).toString('hex')}`, NODE_OPTIONS: `--import ${PRELOAD}`, TIMMY_TEST_FETCH_LOG: fetchLog, TIMMY_TEST_FETCH_ALLOW: new URL(ollama.url).port });
    expect(init.status, init.stderr).toBe(0);
    const t = terminal(dir, env, 'oneconv');
    cleanups.push(() => t.close());
    await t.waitFor(/^TIMMY {2}chat: local qwen3:8b · Ollama$/m);
    t.type('hello');
    await t.waitFor(/From the REPL\.[\s\S]*RECEIPT [0-9a-f]{8} signed and verified/);
    expect(ollama.chats()).toHaveLength(1);

    // another surface's turn holds the project (a live process: this one): the REPL's message is refused, nothing is sent
    const hold = takeTurnHold(dir, 'workbench');
    expect(hold).toMatchObject({ ok: true });
    t.type('are you there?');
    const refused = await t.waitFor(/Not sent: a chat turn of this project is running in the Workbench \(pid \d+, since [^)]+\)\.[\s\S]*Nothing was sent to any model\./);
    expect(refused).toContain(`running in the Workbench (pid ${process.pid}, since`);
    await sleep(500);
    expect(ollama.chats()).toHaveLength(1);
    if (hold.ok) hold.hold.release();

    // the Workbench's turn (its session, as its composer sends it): it continues the REPL's conversation
    process.env.TIMMY_HOME = join(dir, 'timmy');
    for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const) delete process.env[v];
    const net = recordFetch(onlyPorts(new URL(ollama.url).port));
    cleanups.push(() => net.restore());
    const chat = await openChatSession({ project: { name: 'demo', root: dir }, surface: 'workbench' });
    const wb = await chat.send('from the workbench', { onText: () => undefined, askPerson: async () => 'deny' });
    expect(wb).toMatchObject({ status: 'answered', text: 'From the Workbench.', sent: true });
    expect(said(ollama.chats()[1].messages)).toEqual(['user: hello', 'assistant: From the REPL.', 'user: from the workbench']);

    // the REPL's next message reads it, and says so before the answer
    t.type('and now?');
    const back = await t.waitFor(/Back in the REPL\.[\s\S]*RECEIPT [0-9a-f]{8} signed and verified/);
    expect(back.replace(/\s+/g, ' ')).toContain('The conversation continues: 2 messages another surface added to this project\'s conversation since this REPL last sent (kept in .sessions).');
    expect(said(ollama.chats()[2].messages)).toEqual(['user: hello', 'assistant: From the REPL.', 'user: from the workbench', 'assistant: From the Workbench.', 'user: and now?']);
    // the REPL's receipts name it: two turns sealed (the refused message has none)
    const sealed = readFileSync(join(dir, 'store', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind?: string; subject?: string; hash?: string }).filter((r) => r.hash && r.kind === 'turn');
    expect(sealed.map((r) => r.subject)).toEqual(['repl · 0 steps', 'repl · 0 steps']);
    expect(net.requests.every((q) => new URL(q.url).port === new URL(ollama.url).port)).toBe(true);
    // the strict free policy in the REPL itself: with the local model chosen, nothing went to OpenRouter though a key is set
    const replFetches = readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { url: string });
    // (the REPL's own local checks, its canvas and receipt pages on 127.0.0.1, are not model requests)
    expect(replFetches.filter((f) => new URL(f.url).pathname === '/api/chat').map((f) => new URL(f.url).port)).toEqual([new URL(ollama.url).port, new URL(ollama.url).port]);
    expect(replFetches.filter((f) => new URL(f.url).hostname !== '127.0.0.1' || /openrouter/i.test(f.url))).toEqual([]);
    t.type('/exit');
    await t.waitFor(/EXIT1=0/);
  }, 180_000);
});
