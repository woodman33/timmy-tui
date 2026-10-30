// R13 (classifying the 030d0942 full suite's one failure: tests/chat-one-conversation-pty.test.ts timed out with "› hello"
// and an empty second row in the prompt, nothing sent). A message typed and Entered while the REPL is still starting (before
// its first prompt has the terminal raw) reaches the prompt through the terminal's cooked line discipline, which turns the
// Enter into a line feed; the prompt read that line feed as Ctrl+J (a new line), so the message was never sent. This test
// types before the REPL has drawn anything, which makes that window certain rather than a matter of load.
//
// FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts: no model behind it).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); }, 30_000);

async function typedWhileStarting(palette: string | null, label: string) {
    const ollama: FakeOllama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: [
        () => ({ chunks: textChunks('qwen3:8b', ['Typed ahead.']) }),
        () => ({ chunks: textChunks('qwen3:8b', ['Two lines.']) }),
      ],
    });
    cleanups.push(() => ollama.close());
    const dir = mkdtempSync(join(tmpdir(), 'repl-typeahead-pty-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, '.timmy'), { recursive: true });
    writeFileSync(join(dir, '.timmy', 'store-pin'), join(dir, '.timmy', 'receipts'));
    const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', ...(palette ? { TIMMY_PALETTE: palette } : {}) };
    if (!palette) delete (env as Record<string, unknown>).TIMMY_PALETTE;
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo', '--ollama', ollama.url, '--chat', 'local', '--model', 'qwen3:8b'], { cwd: dir, env, timeout: 50_000 });
    expect(init.status, init.stderr).toBe(0);
    const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env: tenv, encoding: 'utf8', timeout: 10_000 });
    cleanups.push(() => { try { tmux('kill-server'); } catch { /* gone */ } });
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', dir, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT1=$?; sleep 60`);
    const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-600', '-t', 't');
    const waitFor = async (re: RegExp, ms = 60_000): Promise<string> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const s = screen(); if (re.test(s)) return s; await sleep(50); }
      throw new Error(`timed out waiting for ${re}:\n${screen()}`);
    };
    // typed at once, while the process is still loading: the terminal is cooked (its own Enter becomes a line feed)
    tmux('send-keys', '-t', 't', '-l', 'hello');
    tmux('send-keys', '-t', 't', 'Enter');
    expect(screen()).not.toMatch(/^TIMMY {2}chat:/m);
    await waitFor(/Typed ahead\.[\s\S]*RECEIPT [0-9a-f]{8} signed and verified/);
    expect(ollama.chats()).toHaveLength(1);
    expect(ollama.chats()[0].messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual(['hello']);
    // at a raw prompt, Ctrl+J is still a new line in the message, and Enter sends both lines
    await sleep(300);
    tmux('send-keys', '-t', 't', '-l', 'one');
    tmux('send-keys', '-t', 't', 'C-j');
    tmux('send-keys', '-t', 't', '-l', 'two');
    await sleep(300);
    expect(ollama.chats()).toHaveLength(1);
    tmux('send-keys', '-t', 't', 'Enter');
    await waitFor(/Two lines\./);
    expect(ollama.chats()[1].messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual(['hello', 'one\ntwo']);
    tmux('send-keys', '-t', 't', '-l', '/exit');
    tmux('send-keys', '-t', 't', 'Enter');
    await waitFor(/EXIT1=0/);
}

describe('the REPL: a message typed while it starts is sent, not turned into a new line', () => {
  it('“hello” and Enter typed before the first prompt: one turn, answered and sealed; then Ctrl+J at a raw prompt is still a new line', async () => {
    await typedWhileStarting('night', 'typeahead');
  }, 180_000);
  it('the same with the palette asked of the terminal (the colour probe reads first): the typed message is not dropped', async () => {
    await typedWhileStarting(null, 'typeahead-probe');
  }, 180_000);
});
