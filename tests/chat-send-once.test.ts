// R4 lead (2026-10-12): the shared chat contract's sendOnce (src/contracts/chat-session.ts), made by the chat session
// (src/agent/chat-session.ts) through the project's turn (src/agent/chat-turn.ts keyDecision). The operator's direction of
// 2026-10-11: "Reconcile retries so refresh, duplicate clicks or reconnection cannot repeat completed side effects".
//
// - a key whose turn sent a request: sent again, refused naming that turn's receipt (here, and from another process);
// - a key whose turn ended having sent nothing (its request refused before it left this process): sent again, it goes (a retry);
// - a key whose turn runs now in another process: refused, the turn under way stands, and its answer comes once;
// - a key whose turn's process was killed during it: refused (whether it reached a model is not known), never sent again;
// - not a key: refused, and nothing is kept or sent.
//
// Real pieces: the chat session, the agent (src/agent/core.ts), the turn (src/repl/turn.ts), the hold and key files with their
// process proof (ps), signed receipt chains, and the other surface as a real child process (tests/fixtures/chat-surface-
// fixture.ts through tsx), killed with SIGKILL in one test. FAKE pieces, labelled: the model is a FAKE Ollama on 127.0.0.1
// (tests/fixtures/fake-ollama-chat.ts: no model behind it); the network is a recording fetch (FAKE: anything it does not allow
// is refused before it leaves, as ECONNREFUSED).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openChatSession } from '../src/agent/chat-session.js';
import { CHAT_TURNS_DIR, keyDecision } from '../src/agent/chat-turn.js';
import { CHAT_KEY, type ChatSession, type ChatTurnHooks } from '../src/contracts/chat-session.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type ChatReply, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { recordFetch } from './fixtures/recording-fetch.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const PRELOAD = pathToFileURL(resolve('tests/fixtures/record-fetch-preload.mjs')).href;
const FIXTURE = resolve('tests/fixtures/chat-surface-fixture.ts');

const VARS = ['TIMMY_HOME', 'TIMMY_SETTINGS_DIR', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let project = '';
let ollama: FakeOllama | null = null;
let restoreNet: (() => void) | null = null;
/** FAKE network: whether this process's fetch lets /api/chat through to the FAKE Ollama (its other paths always go) */
let chatGoes = true;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hooks: ChatTurnHooks = { onText: () => undefined, askPerson: async () => 'deny' };

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'chat-send-once-'));
  project = join(box, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# demo\n');
  // the project's own store, pinned in its folder (src/utils/receipts.ts): its seals land there, whatever is above it
  mkdirSync(join(project, '.timmy'), { recursive: true });
  writeFileSync(join(project, '.timmy', 'store-pin'), join(project, '.timmy', 'receipts'));
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  process.env.TIMMY_SETTINGS_DIR = join(box, 'settings');
  for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'TIMMY_CHAT_NUM_CTX', 'OLLAMA_HOST'] as const) delete process.env[v];
  chatGoes = true;
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
async function local(chat: Array<() => ChatReply>): Promise<FakeOllama> {
  ollama = await startFakeOllama({ models: [{ name: 'qwen3:8b' }], chat });
  mkdirSync(process.env.TIMMY_HOME!, { recursive: true });
  writeFileSync(join(process.env.TIMMY_HOME!, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
  writeFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', chat: 'local', model: 'qwen3:8b' } }));
  const port = new URL(ollama.url).port;
  restoreNet = recordFetch((u) => u.hostname === '127.0.0.1' && u.port === port && (chatGoes || u.pathname !== '/api/chat')).restore;
  return ollama;
}
const answer = (text: string, delayMs?: number) => (): ChatReply => ({ chunks: textChunks('qwen3:8b', [text]), ...(delayMs ? { delayMs } : {}) });

/** The companion's page in a process of its own, sending `text` with `key`: its turn's result, and a way to wait for its hold. */
function companion(o: { text: string; key: string }) {
  const child = spawn(process.execPath, ['--import', LOADER, '--import', PRELOAD, FIXTURE], {
    cwd: box,
    env: {
      PATH: process.env.PATH, HOME: join(box, 'home'), TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR,
      TIMMY_TEST_FETCH_LOG: join(box, 'child-fetches.jsonl'), TIMMY_TEST_FETCH_ALLOW: new URL(ollama!.url).port,
      CHAT_PROJECT: project, CHAT_SURFACE: 'companion', CHAT_TEXT: o.text, CHAT_KEY: o.key,
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
  return { child, exited, result: async () => JSON.parse((await waitFor(/^RESULT (.*)$/m))[1]) as { status: string; lines?: string[]; sent: boolean; receipt?: string; text: string } };
}

/** Waits until the FAKE Ollama has had `n` /api/chat requests (a turn's request is out). */
async function chatsOut(n: number, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (ollama!.chats().length < n) {
    if (Date.now() - t0 > ms) throw new Error(`the FAKE Ollama had ${ollama!.chats().length} chat requests, not ${n}`);
    await sleep(50);
  }
}

const keyRecords = (): Array<Record<string, unknown>> => {
  const f = join(project, CHAT_TURNS_DIR, 'keys.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const turnReceipts = () => readChain('runs', project).filter((r) => r.kind === 'chat').map((r) => r.subject);
const open = (): Promise<ChatSession> => openChatSession({ project: { name: 'demo', root: project }, surface: 'companion' });

describe('sendOnce, the shared chat contract\'s keyed send (R4 lead)', () => {
  it('a key whose turn sent a request is refused when sent again, naming its receipt; a different key is a new message', async () => {
    await local([answer('Once.'), answer('Another.')]);
    const chat = await open();
    const first = await chat.sendOnce('page-msg-0001', 'hello', hooks);
    expect(first).toMatchObject({ status: 'answered', text: 'Once.', sent: true, receipt: expect.stringMatching(/^sha256_[0-9a-f]{64}$/) });
    const again = await chat.sendOnce('page-msg-0001', 'hello', hooks);
    expect(again).toEqual({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: [
      expect.stringMatching(new RegExp(`^Not sent again: this message was already sent from the companion at \\S+ \\(receipt ${first.receipt!.slice(7, 15)}\\)\\.$`)),
      'Nothing was sent to any model.',
    ] });
    // the key's records: its start (by this process), its end as the turn knew it, and its end with the receipt
    expect(keyRecords().map((k) => [k.state, k.sent ?? null, k.receipt ? 'receipt' : null])).toEqual([['started', null, null], ['ended', true, null], ['ended', true, 'receipt']]);
    const other = await chat.sendOnce('page-msg-0002', 'hello', hooks);
    expect(other).toMatchObject({ status: 'answered', text: 'Another.', sent: true });
    expect(ollama!.chats()).toHaveLength(2);
    expect(turnReceipts()).toEqual(['chat.turn · companion · 0 steps · qwen3:8b', 'chat.turn · companion · 0 steps · qwen3:8b']);
  }, 60_000);

  it('a key whose turn sent nothing (its request refused before it left this process) is sent when tried again: a retry, not a repeat', async () => {
    await local([answer('Now it went.')]);
    const chat = await open();
    chatGoes = false; // FAKE network: the chat request is refused here, before it leaves (ECONNREFUSED)
    const first = await chat.sendOnce('page-msg-0003', 'are you there?', hooks);
    expect(first).toMatchObject({ status: 'failed', sent: false });
    expect(first.lines).toContain('Nothing was sent to any model.');
    expect(ollama!.chats()).toHaveLength(0);
    expect(keyRecords().filter((k) => k.state === 'ended').every((k) => k.sent === false)).toBe(true);
    expect(keyDecision(project, 'page-msg-0003')).toEqual({ send: true, retry: true });
    chatGoes = true;
    const retry = await chat.sendOnce('page-msg-0003', 'are you there?', hooks);
    expect(retry).toMatchObject({ status: 'answered', text: 'Now it went.', sent: true });
    expect(ollama!.chats()).toHaveLength(1);
    // and now it went: a third try is refused, naming the retry's receipt
    const third = await chat.sendOnce('page-msg-0003', 'are you there?', hooks);
    expect(third).toMatchObject({ status: 'refused', sent: false, lines: [expect.stringContaining(`(receipt ${retry.receipt!.slice(7, 15)})`), 'Nothing was sent to any model.'] });
    expect(ollama!.chats()).toHaveLength(1);
  }, 60_000);

  it('a key whose turn runs now in another process is refused, and that turn\'s answer comes once', async () => {
    await local([answer('Slowly.', 1500), answer('never asked')]);
    const page = companion({ text: 'a slow one', key: 'page-msg-0004' });
    await chatsOut(1);
    const meanwhile = await (await open()).sendOnce('page-msg-0004', 'a slow one', hooks);
    expect(meanwhile).toEqual({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: [
      expect.stringMatching(new RegExp(`^Not sent again: this message is being sent now from the companion \\(pid ${page.child.pid}, since \\S+\\)\\.$`)),
      'Nothing was sent to any model.',
    ] });
    const done = await page.result();
    expect(done).toMatchObject({ status: 'answered', text: 'Slowly.', sent: true });
    const after = await (await open()).sendOnce('page-msg-0004', 'a slow one', hooks);
    expect(after.lines?.[0]).toContain(`already sent from the companion`);
    expect(after.lines?.[0]).toContain(`(receipt ${done.receipt!.slice(7, 15)})`);
    expect(ollama!.chats()).toHaveLength(1);
  }, 90_000);

  it('a key whose turn\'s process was killed during it is refused: whether it reached a model is not known, so it is not sent again', async () => {
    await local([() => ({ hang: true }), answer('never asked')]);
    const page = companion({ text: 'one that hangs', key: 'page-msg-0005' });
    await chatsOut(1);
    page.child.kill('SIGKILL');
    await page.exited;
    const again = await (await open()).sendOnce('page-msg-0005', 'one that hangs', hooks);
    expect(again).toEqual({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: [
      expect.stringMatching(/^Not sent again: this message was being sent from the companion at \S+ when that process ended, so whether it reached a model is not known\.$/),
      'Try: send it as a new message if it should be asked again. Nothing was sent to any model.',
    ] });
    expect(ollama!.chats()).toHaveLength(1);
    // the killed turn's hold is stale; a new message goes
    const fresh = await (await open()).sendOnce('page-msg-0006', 'one that hangs', hooks);
    expect(fresh.status).not.toBe('refused');
  }, 90_000);

  it('a key that is not one is refused: nothing is kept, nothing is sent', async () => {
    await local([answer('never asked')]);
    const chat = await open();
    for (const key of ['', 'short', 'has space in it', 'x'.repeat(81), 'émoji-key-0001']) {
      expect(CHAT_KEY.test(key)).toBe(false);
      expect(await chat.sendOnce(key, 'hello', hooks)).toEqual({ status: 'refused', text: '', sent: false, costWords: 'no request, no cost', lines: [
        'Not sent: the message\'s key is not one Timmy keeps (8 to 80 letters, digits, - or _), so sending it only once could not be kept.',
        'Nothing was sent to any model.',
      ] });
    }
    expect(ollama!.chats()).toHaveLength(0);
    expect(existsSync(join(project, CHAT_TURNS_DIR, 'keys.jsonl'))).toBe(false);
    expect(existsSync(join(project, CHAT_TURNS_DIR)) ? readdirSync(join(project, CHAT_TURNS_DIR)) : []).toEqual([]);
  }, 30_000);
});
