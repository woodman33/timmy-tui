// R5 (H131; the QA of the installed build e7f853e, defect 3): the Workbench's local-model box, proved in a real terminal (tmux)
// as the rehearsal drives it. `timmy init --yes --chat local --ollama <host>` names a FAKE Ollama on 127.0.0.1 at a port of
// this test's own (never 11434) and no model; Home's one next step is then "Choose the local model (from what Ollama lists)";
// Enter on it, with the Workflow actions bar holding the keyboard, opens the box with what THAT Ollama lists; Enter on a model
// writes it through the setup's own writer: "The chat is set to the local model …". The chat route then reads it.
//
// FAKE here, each said where it is made:
// - the Ollama: an HTTP server in this test's process, with no model behind it; it answers GET /api/tags with two FAKE models
//   (names that begin "fake-") and counts every request it gets;
// - the openers on PATH (`open` and `xdg-open` stubs that only log; nothing presses Show).
// Everything else is the real program, started as the installed command starts it (src/cli.ts through tsx's loader), over a
// sandbox of its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux server).
// The screens are kept as .ansi and .txt in <tmpdir>/timmy-workbench-captures/r5-terminal, or in TIMMY_WB_CAPTURES. Every wait,
// key and kept screen goes through the shared frame helper (tests/helpers/tmux-frame.ts, R5 H136): a screen counts only as a
// whole, settled frame, and a key is sent once the one before it was read.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, sendKeys, settledScreen, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r5-terminal');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The body's left column of a screen (Home's and Chat's box), its rows joined and its runs of spaces as one: each row up to
 *  where the column's border meets the right column's. */
const leftColumn = (screen: string): string => screen.split('\n').map((row) => { const at = row.search(/┃[│╭╰]/); return at >= 0 ? row.slice(0, at) : row; }).join(' ').replace(/[┃│]/g, ' ').replace(/\s+/g, ' ');

let box = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};
let server: Server | undefined;
let port = 0;
/** what the FAKE Ollama was asked, in order ("GET /api/tags") */
const asked: string[] = [];
/** FAKE: the two models the FAKE Ollama lists (no model is behind either) */
const FAKE_MODELS = [
  { name: 'fake-qwen3:8b', model: 'fake-qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
  { name: 'fake-llama3.2:1b', model: 'fake-llama3.2:1b', size: 1_300_000_000, details: { parameter_size: '1B', quantization_level: 'Q8_0' } },
];

const cli = (args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env, timeout });

/** A tmux server of the test's own, read through the shared frame helper: waits on whole, settled frames with a deadline that
 *  names what they wait for, keys sent one at a time once read, screens kept whole. */
function terminal(label: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  const waitFor = (re: RegExp, what: string, ms = 30_000): Promise<string> => waitScreen(pane, { what, re, ms });
  const keys = (...k: string[]): Promise<void> => sendKeys(pane, k);
  /** Tab until the zone titled `title` has the keyboard (its frame heavy, with ◆), as the rehearsal does */
  const focusZone = async (title: string, max = 8): Promise<boolean> => {
    const focused = () => new RegExp(`┏━ ◆ [^━\\n]*${esc(title)}`).test(settledScreen(pane));
    for (let i = 0; i < max && !focused(); i++) await keys('Tab');
    return focused();
  };
  // (a notice may stand in the key-hint line's place for a few seconds after an action: the frame is kept whole either way)
  const capture = (name: string): string => keepScreen(pane, CAPTURES, name, { foot: 'drawn' });
  return { tmux, waitFor, keys, focusZone, capture };
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-local-model-'));
  const home = join(box, 'home');
  // (the workspace under HOME, as a person's is: a path the screens show is then said from ~, never as this machine's folders)
  repo = join(home, 'work');
  timmyHome = join(home, 'timmy');
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
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    // R10 CHAT (H167): this file checks the classic Chat tab; the Chat screen's shell that replaces it is tests/workbench-chat-shell.test.ts's
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_WORKBENCH_CHAT: 'classic', TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  const init = await cli(['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo']);
  expect(init.status, init.stderr).toBe(0);
  const made = await cli(['act', '/project new tray1 --from tray-workflow']);
  expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
}, 150_000);

afterAll(async () => {
  try { execFileSync('tmux', ['-L', 'wbLocalModel', 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ }
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

describe('`timmy workbench` in a terminal: the local model chosen in the Workbench (tmux; R5 H131, QA defect 3)', () => {
  it('after timmy init --yes --chat local --ollama <a FAKE Ollama on another port>, Home\'s one next step is the local model; Enter opens the box with what that Ollama lists; Enter on one sets it through the setup\'s writer, and the route reads it', async () => {
    const host = `127.0.0.1:${port}`;
    // exactly the rehearsal's step: the setup names the FAKE Ollama's address, and no model
    const addr = await cli(['init', '--yes', '--chat', 'local', '--ollama', host]);
    expect(addr.status, addr.stderr).toBe(0);
    expect(addr.stdout.replace(/\s+/g, ' ')).toContain(`Ollama at ${host}`);
    const providers = JSON.parse(readFileSync(join(timmyHome, 'providers.json'), 'utf8')) as { ollama_host?: string };
    expect(providers.ollama_host).toBe(host);

    const t = terminal('wbLocalModel');
    t.tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '160', '-y', '45', '-c', repo, 'bash', '--norc', '-c',
      `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
    await t.waitFor(/tray1 \/ Home · recent work[\s\S]*Activity & log/, 'Home, at the start', 60_000);
    // the one next step, on Home: the local route with no model chosen
    await t.waitFor(/▶ 1 Choose the local model \(from what Ollama lists\)/, 'Home\'s one next step: the local model', 30_000);
    // Enter acts on the zone with the keyboard: the Workflow actions bar, where the fix is the one primary (and selected)
    expect(await t.focusZone('Workflow actions'), 'the Workflow actions bar given the keyboard').toBe(true);
    await t.waitFor(/▸\[▶ 1 Choose the local model/, 'the primary selected on the bar', 10_000);
    t.capture('local-model-160x45-01-home-next-step-FAKE-ollama');

    const before = asked.length;
    await t.keys('Enter');
    // the box: its title and first line, then what THAT Ollama lists (its address said), the FAKE models with their facts
    // (R10 H167; H168's F3: the Ollama the setup names said in words, on this computer; its address is the details', [i])
    const listed = await t.waitFor(/What Ollama on this computer lists now \(asked just now, no charge\)/, 'the box with what the FAKE Ollama lists', 20_000);
    expect(listed).toContain('Choose the local model');
    expect(listed).toContain('LOCAL MODELS (2)');
    expect(listed).toMatch(/fake-qwen3:8b\s+local weights · 8B · Q4_K_M · 5\.2 GB/);
    expect(listed).toMatch(/fake-llama3\.2:1b\s+local weights · 1B · Q8_0 · 1\.3 GB/);
    expect(asked.slice(before)).toContain('GET /api/tags');
    t.capture('local-model-160x45-02-box-listed-FAKE-ollama');

    // Enter on the first (selected): the setup's answer, through its writer
    await t.keys('Enter');
    const done = await t.waitFor(/The chat is set to the local model fake-qwen3:8b/, 'the words of what changed', 20_000);
    expect(done).toContain('WHAT CHANGED');
    expect(done).toContain('WHAT DID NOT');
    // its first line whole, wrapped under itself (it was cut at "the setup's answer…"), and what was written, from ~
    expect(leftColumn(done)).toContain('The chat is set to the local model fake-qwen3:8b, as the setup\'s answer (written as timmy init --chat local --model writes it).');
    expect(leftColumn(done)).toMatch(/Written: ~\/work\/\.timmy\/private\/config\.json, ~\/timmy\/setup\.json\./);
    expect(done).toMatch(/The route as read now: chat: local fake-qwen3:8b · Ollama \(ready\)\./);
    t.capture('local-model-160x45-03-model-set-FAKE-ollama');
    const setup = JSON.parse(readFileSync(join(timmyHome, 'setup.json'), 'utf8')) as { by: string; answers: { chat?: string; model?: string; ollama?: string } };
    expect(setup).toMatchObject({ by: 'timmy workbench', answers: { chat: 'local', model: 'fake-qwen3:8b', ollama: host } });

    // the route reads it: Chat's route names the model, and the chat is ready (nothing was sent to any model)
    await t.keys('Escape', '2');
    // (R10 H167: Chat's own route row, under its title, as routeNow reads it (the header says the same on every tab); a model
    // whose name says FAKE is named FAKE; the composer's row says where a message goes once its session is open)
    const chat = await t.waitFor(/tray1 \/ Chat · conversation[\s\S]*next turn: FAKE fake-qwen3:8b · this computer \(Ollama\)[\s\S]*\[Enter\] Type a message +· to FAKE fake-qwen3:8b/, 'Chat\'s route on the model chosen, and its composer ready', 30_000);
    // (R10 H167: a ready route has no "not ready" words)
    expect(chat).not.toMatch(/not ready/);
    expect(asked.every((a) => a === 'GET /api/tags'), `the FAKE Ollama was asked only for its list: ${asked.join(', ')}`).toBe(true);
    // nothing of this machine on the screens: not the sandbox's folders, not its name
    for (const s of [listed, done, chat]) {
      expect(s.includes(box)).toBe(false);
      expect(s.includes(hostname())).toBe(false);
    }
    await t.keys('C-c');
    await t.waitFor(/EXIT=0\b/, 'the Workbench quitting at Ctrl+C (R6 H141: it stopped nothing, so exit 0)', 20_000);
    expect(existsSync(join(box, 'opened.log'))).toBe(false);
  }, 240_000);
});
