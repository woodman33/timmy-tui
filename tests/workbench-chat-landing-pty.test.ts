// R10 CHAT CHECKPOINT (H167; the operator's order of 2026-10-22 and the lead's Mac check of 4417b2a): `timmy workbench` opens
// on the Chat screen, proved in a real terminal (tmux) at the operator's 122x37. A fresh home (timmy init with no chat answer:
// no key, no model): the first frame is Chat with the first run's question in its center (WELCOME TO TIMMY; OpenRouter / cloud,
// Ollama / this computer, Ollama / cloud, Continue without a model; Cloudflare only as the advanced choice), the left menu,
// Models and the bottom in place, never the tabbed Home. The same home once its chat is the local route with a model (timmy
// init --chat local --ollama <a FAKE Ollama> --model fake-qwen3:8b): the first frame is Chat with the conversation's place and
// the composer, FAKE named in the header.
//
// FAKE here, each said where it is made:
// - the Ollama: an HTTP server in this test's process, with no model behind it, the setup's Ollama address from the start; it
//   answers GET /api/tags with one FAKE model (a name that begins "fake-") and counts every request it gets; nothing asks it
//   for an answer (no chat turn is sent);
// - the openers on PATH (`open` and `xdg-open` stubs that only log; nothing presses Show).
// Everything else is the real program, started as the installed command starts it (src/cli.ts through tsx's loader), over a
// sandbox of its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux server). The
// screens are kept as .ansi and .txt in <tmpdir>/timmy-workbench-captures/r10-chat-landing, or in TIMMY_WB_CAPTURES.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r10-chat-landing');
const LABEL = 'wbChatLanding';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the cells `from` to `to` (inclusive) of a row, trailing blanks dropped */
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();

let box = '';
let repo = '';
let env: NodeJS.ProcessEnv = {};
let server: Server | undefined;
let port = 0;
/** what the FAKE Ollama was asked, in order ("GET /api/tags") */
const asked: string[] = [];
/** FAKE: the one model the FAKE Ollama lists (no model is behind it) */
const FAKE_MODELS = [{ name: 'fake-qwen3:8b', model: 'fake-qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } }];

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });

/** `timmy workbench` in a tmux session of this test's own server at 122x37; its first settled frame that shows `re`. */
async function launch(session: string, re: RegExp, what: string): Promise<{ screen: string; pane: Pane }> {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', LABEL, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '122', '-y', '37', '-c', repo, 'bash', '--norc', '-c',
    `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
  const pane: Pane = { tmux, target: session, folders: [box] };
  const screen = await waitScreen(pane, { what, re, ms: 60_000 });
  return { screen, pane };
}

function stop(session: string): void {
  try { execFileSync('tmux', ['-L', LABEL, 'kill-session', '-t', session], { env, stdio: 'ignore' }); } catch { /* gone */ }
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-chat-landing-'));
  const home = join(box, 'home');
  // (the workspace under HOME, as a person's is: a path the screens show is then said from ~, never as this machine's folders)
  repo = join(home, 'work');
  const bin = join(box, 'fakebin');
  for (const d of [home, repo, bin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // FAKE: the Ollama, on 127.0.0.1 at a port the system gives this test (never Ollama's own 11434)
  server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: FAKE_MODELS }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'FAKE Ollama: only /api/tags is answered here' }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  expect(port).not.toBe(11434);
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  delete base.OLLAMA_HOST;
  delete base.OLLAMA_BASE_URL;
  delete base.TIMMY_WORKBENCH_CHAT;
  delete base.TIMMY_CHAT_MODEL;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  // (the setup's Ollama address is the FAKE one from the start: nothing in this file asks Ollama's own 11434)
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo', '--ollama', `127.0.0.1:${port}`]);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
}, 150_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', LABEL, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` opens on the Chat screen at 122x37 (tmux; R10 CHAT H167, the lead\'s Mac check of 4417b2a)', { timeout: 180_000 }, () => {
  it('a fresh home (no key, no model): the first frame is Chat with the first run\'s question in its center, the menu, Models and the bottom in place; not the tabbed Home', async () => {
    const { screen, pane } = await launch('fresh', /How would you like to run chat\?[\s\S]*Continue without a model/, 'the first run\'s question on the Chat screen');
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-01-first-run', { foot: 'drawn' });
    const rows = screen.split('\n');
    expect(cols(rows[0], 0, 6)).toBe('  TIMMY');
    expect(cols(rows[0], 20, 121)).toMatch(/^tray1 \/ Chat +LOCAL RECORDS$/);
    expect(cols(rows[1], 20, 121)).toBe('FIRST RUN / choose how chat runs');
    expect(cols(rows[4], 20, 89)).toBe('WELCOME TO TIMMY');
    const center = rows.map((r) => cols(r, 20, 89));
    expect(center.slice(7, 9)).toEqual(['How would you like to run chat?', 'Choose one. You can add the others later.']);
    // the choices, the cursor on the first (the conversation's zone has the keyboard at the start)
    for (const label of ['OpenRouter / cloud', 'Ollama / this computer', 'Ollama / cloud', 'Continue without a model', 'Advanced: Cloudflare (optional)']) expect(center.some((r) => r.includes(`[ ${label} ]`)), label).toBe(true);
    expect(center.find((r) => r.includes('[ OpenRouter / cloud ]'))).toBe('> [ OpenRouter / cloud ]');
    // the menu with Chat selected, Models beside, the bottom: the same screen as with a model
    expect(rows.map((r) => cols(r, 0, 17))[10]).toBe(' > Chat');
    expect(cols(rows[4], 92, 121)).toMatch(/^MODELS +\[ Details \]$/);
    expect(cols(rows[35], 20, 121)).toBe('[Attach]  [Tools]  [Plan / Run]  [Permissions]  [Budget]  [Stop]  [Logs]  [Cloudflare]');
    expect(cols(rows[36], 20, 121)).toMatch(/^Logs: this computer \/ idle .* 122 x 37$/);
    // never the tabbed Home
    expect(screen).not.toMatch(/\[1 Home\]|\/ Home · recent work|Workflow actions/);
    // Continue without a model (the fourth choice): Chat with no model, its composer keeping a draft
    await sendKeys(pane, ['Down', 'Down', 'Down', 'Enter']);
    const none = await waitScreen(pane, { what: 'Chat with no model', re: /A model is optional until you need an answer\./, ms: 20_000 });
    expect(none).toMatch(/Connect a model to chat \(a draft is kept\)/);
    expect(none.split('\n').map((r) => cols(r, 20, 121))[1]).toBe('NEXT / Connect a model to chat');
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-02-no-model', { foot: 'drawn' });
    // nothing but what Ollama lists was asked of it (no chat turn: there is no model)
    expect(asked.filter((a) => a !== 'GET /api/tags')).toEqual([]);
    stop('fresh');
  });

  it('the home with the local route and a model (FAKE fake-qwen3:8b): the first frame is Chat with the conversation\'s place and the composer', async () => {
    const host = `127.0.0.1:${port}`;
    const set = await cli(['init', '--yes', '--chat', 'local', '--ollama', host, '--model', 'fake-qwen3:8b']);
    expect(set.status, `${set.stdout}\n${set.stderr}`).toBe(0);
    const { screen, pane } = await launch('model', /CHAT \/ tray1[\s\S]*MESSAGE/, 'the Chat screen with the composer');
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-03-with-model-FAKE', { foot: 'drawn' });
    const rows = screen.split('\n');
    expect(cols(rows[0], 20, 121)).toMatch(/^tray1 \/ Chat +LOCAL RECORDS$/);
    expect(cols(rows[1], 20, 121)).toBe('NEXT / Ollama local / FAKE fake-qwen3:8b');
    expect(cols(rows[4], 20, 89)).toBe('CHAT / tray1');
    const center = rows.map((r) => cols(r, 20, 89));
    expect(center[27]).toBe('─'.repeat(69));
    expect(center.slice(28, 30)).toEqual(['MESSAGE', 'Enter writes a message']);
    expect(screen).not.toMatch(/WELCOME TO TIMMY|How would you like to run chat|\[1 Home\]|\/ Home · recent work/);
    // no chat turn was sent: the FAKE Ollama was asked only what it lists
    expect(asked.filter((a) => a !== 'GET /api/tags')).toEqual([]);
    stop('model');
  });
});
