// R4 (H103): the REPL's chat on the local model, in a real terminal (tmux, 100 x 40), against a FAKE Ollama (a real HTTP
// server on 127.0.0.1 in this test's process, answering as Ollama's API does; no model behind it). A home `timmy init --yes`
// set up with that Ollama's address chose the local model and no model (no list without questions): the header says so.
// /setup chat lists what the FAKE Ollama has (a cloud-backed entry labelled, never preselected), Enter takes the local one,
// and the next message streams from it: the text grows on the screen before the answer ends, and the turn closes with its
// receipt, "no charge (local endpoint)". A second REPL's header names the route chosen ("chat: local <model> · Ollama"), and
// /model lists the models. Nothing is sent to OpenRouter: there is no key, and the FAKE Ollama saw every request. Then the
// same gate as the OpenRouter route: a tool the local model calls that changes the project waits at the REPL's NEEDS YOU box
// (answered y here), runs, is given back to the model, and the turn's receipt names the file it wrote.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakes: FakeOllama[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });

/** Two REPLs, one after the other, in a tmux terminal of their own; `screen()` includes what scrolled away. */
function terminal(dir: string, env: NodeJS.ProcessEnv, label: string) {
  const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', dir, 'bash', '--norc', '-c',
    `${TSX} ${CLI} repl; echo EXIT1=$?; ${TSX} ${CLI} repl; echo EXIT2=$?; sleep 60`);
  const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', 't');
  const waitFor = async (re: RegExp, seen?: (s: string) => void): Promise<string> => {
    for (let i = 0; i < 1200; i++) {
      const s = screen();
      seen?.(s);
      if (re.test(s)) return s;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${re}:\n${screen()}`);
  };
  const type = (text: string) => { if (text) tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  return { screen, waitFor, type, close: () => { try { tmux('kill-server'); } catch { /* gone */ } } };
}

describe('the REPL\'s chat on a local model, in a terminal (FAKE Ollama)', () => {
  it('the header names the route; /setup chat lists the models; a message streams from the local one, sealed as no charge', async () => {
    const pieces = ['Hello', ' from', ' the', ' FAKE', ' local', ' model.'];
    const ollama = await startFakeOllama({
      models: [{ name: 'big:120b-cloud', remote_host: 'https://ollama.example:443' }, { name: 'qwen3:8b' }],
      chat: [() => ({ chunks: textChunks('qwen3:8b', pieces), delayMs: 400 })],
    });
    fakes.push(ollama);
    const dir = mkdtempSync(join(tmpdir(), 'repl-local-chat-'));
    const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night' };
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url], { cwd: dir, env, timeout: 50_000 });
    expect(init.status, init.stderr).toBe(0);
    const t = terminal(dir, env, 'localchat');
    try {
      const first = await t.waitFor(/Enter to send/);
      expect(first).toMatch(/^TIMMY {2}chat: local · no model chosen · \/model$/m);
      // the chat question again, with what the FAKE Ollama lists
      t.type('/setup chat');
      const asked = await t.waitFor(/> \[2\] $/m);
      expect(asked).toContain(`Ollama at ${ollama.host} lists 2 models:`);
      expect(asked).toMatch(/ 1 {2}big:120b-cloud · cloud-backed: Ollama sends the chat\s+off this computer/);
      expect(asked).toContain(' 2  qwen3:8b · local weights · 8B · Q4_K_M · 5.2 GB');
      t.type('');
      await t.waitFor(/Proceed\? \[Y\/n\]/);
      t.type('');
      const back = await t.waitFor(/The chat from your next message: local qwen3:8b · Ollama\.[\s\S]*Enter to send/);
      expect(back).toContain('Back in the REPL.');
      // the setup check names the route, which needs no key (never "model key none")
      expect(back).toMatch(/● chat\s+local qwen3:8b · Ollama \(no key needed\)/);
      expect(back).not.toMatch(/model key\s+none/);
      expect(JSON.parse(readFileSync(join(dir, 'timmy', 'setup.json'), 'utf8')).answers).toMatchObject({ chat: 'local', model: 'qwen3:8b', ollama: ollama.url });
      // one message: the text grows on the screen while the answer streams, then the receipt
      let partial = false;
      t.type('hello');
      const done = await t.waitFor(/RECEIPT [0-9a-f]{8} signed and verified[\s\S]*Enter to send/, (s) => {
        if (/Hello from the/.test(s) && !/local model\./.test(s)) partial = true;
      });
      expect(partial).toBe(true);
      expect(done).toContain('Hello from the FAKE local model.');
      expect(done).toMatch(/0 steps · no charge \(local endpoint\) · [\d.]+s · qwen3:8b/);
      t.type('/exit');
      // the next REPL's header names the route chosen; /model lists what Ollama has
      const second = await t.waitFor(/EXIT1=0[\s\S]*TIMMY {2}chat: local qwen3:8b · Ollama\n[\s\S]*Enter to send/);
      expect(second).toMatch(/^TIMMY {2}chat: local qwen3:8b · Ollama$/m);
      t.type('/model');
      const models = await t.waitFor(/switches for this session; \/setup chat keeps one for every start\./);
      expect(models).toMatch(/Model {4}qwen3:8b \(the setup\)/);
      expect(models).toMatch(/● {2}2 {2}qwen3:8b/);
      t.type('/exit');
      await t.waitFor(/EXIT2=0/);
      // the turn's receipt: where it went, and no charge
      const receipts = readFileSync(join(dir, 'store', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string');
      const turn = receipts.find((r) => r.kind === 'turn');
      expect(turn).toMatchObject({ status: 'ok', model_requested: 'qwen3:8b', via: 'ollama', cost_usd: 0, cost_measured: true });
      expect(turn.sources).toEqual([{ kind: 'ollama', host: ollama.host, endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }]);
      // what the FAKE Ollama was asked: the list (/setup chat, /model), what the model can do, and one streamed chat with the tools
      const chats = ollama.chats();
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({ model: 'qwen3:8b', stream: true });
      expect(chats[0].messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
      expect(chats[0].tools.length).toBeGreaterThan(10);
      expect(new Set(ollama.requests.map((r) => r.path))).toEqual(new Set(['/api/tags', '/api/show', '/api/chat']));
      expect(existsSync(join(dir, 'timmy', 'providers.json')) && JSON.parse(readFileSync(join(dir, 'timmy', 'providers.json'), 'utf8')).openrouter_api_key).toBeFalsy();
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // the same gate as the OpenRouter route: a tool that changes the project waits at the REPL's NEEDS YOU box; the model was
  // chosen by TIMMY_CHAT_MODEL (a scripted run's way), so the header names it at once
  it('a tool the local model calls that needs a person waits at the REPL\'s NEEDS YOU box; allowed once, it runs and is sealed', async () => {
    const write = { name: 'write_project_file', arguments: { path: 'notes.md', content: 'written by the FAKE local model\n' } };
    const ollama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: [() => ({ chunks: toolCallChunks('qwen3:8b', [write]) }), () => ({ chunks: textChunks('qwen3:8b', ['Wrote notes.md.']) })],
    });
    fakes.push(ollama);
    const dir = mkdtempSync(join(tmpdir(), 'repl-local-gate-'));
    const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night', TIMMY_CHAT_MODEL: 'qwen3:8b' };
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url], { cwd: dir, env, timeout: 50_000 });
    expect(init.status, init.stderr).toBe(0);
    const t = terminal(dir, env, 'localgate');
    try {
      expect(await t.waitFor(/Enter to send/)).toMatch(/^TIMMY {2}chat: local qwen3:8b · Ollama$/m);
      t.type('write notes.md');
      const box = await t.waitFor(/NEEDS YOU[\s\S]*write_project_file: notes\.md[\s\S]*changes a file in your project[\s\S]*n, Esc, Enter deny/);
      expect(box).toContain('y allow once');
      expect(existsSync(join(dir, 'notes.md'))).toBe(false);
      // past the box's type-ahead guard (300 ms), one key answers it
      await sleep(600);
      execFileSync('tmux', ['-L', 'localgate', 'send-keys', '-t', 't', 'y'], { env: { ...env, TMUX_TMPDIR: dir, TMUX: '' } });
      const done = await t.waitFor(/RECEIPT [0-9a-f]{8} signed and verified[\s\S]*Enter to send/);
      expect(done).toContain('Wrote notes.md.');
      expect(done).toMatch(/1 step · no charge \(local endpoint\) · [\d.]+s · qwen3:8b/);
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('written by the FAKE local model\n');
      t.type('/exit');
      await t.waitFor(/EXIT1=0/);
      const turn = readFileSync(join(dir, 'store', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'turn' && typeof r.prev_hash === 'string')[0];
      expect(turn).toMatchObject({ via: 'ollama', cost_usd: 0, cost_measured: true, tool_outcomes: [{ name: 'write_project_file', outcome: 'completed' }], files: [{ path: 'notes.md', created: true }] });
      // the model was given the tool's own answer
      const [, second] = ollama.chats();
      expect(JSON.parse(second.messages.at(-1).content)).toMatchObject({ ok: true });
      expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'write_project_file' });
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
