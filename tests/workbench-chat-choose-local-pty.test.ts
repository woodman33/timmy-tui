// R11 (H167; step 1, the operator's first-use failure: "after selecting Ollama → This computer → granite 4.2 latest, nothing
// clearly happened, I had to press Escape, and I did not know where to type"): the Chat screen's choice of a local model,
// proved in a real terminal (tmux) at the operator's 122x37 AND at 80x24, where Models is a drawer over the center (inventory
// D's likeliest cause). First run → Ollama / this computer → a row → Enter, against a FAKE Ollama:
// - a row whose /api/show does not establish a chat model: nothing saved, the selector stays on that row with the reason
//   beside it, the status row says it;
// - a chat model: the chip says checking (amber) while the FAKE takes its time to answer /api/show, then ready (green, with
//   the time) only after it answered; the setup's answer is written; the selector closes; the composer has the keyboard with
//   the draft typed before intact; the status row says "Next turn: <model> on this computer.";
// - an Ollama that does not answer: nothing saved, the row says so;
// - a home with no identity at all (no timmy init): the choice sets it up (the identity made by the setup's writer, recorded
//   as made by timmy workbench), never a shell.
//
// FAKE here, each said where it is made: the Ollama is an HTTP server in this test's process with no model behind it: GET
// /api/tags lists two FAKE models (names with "fake" in them), POST /api/show answers each as Ollama would (an embedding
// model without the completion capability; a chat model), after SHOW_DELAY_MS so that a frame drawn meanwhile shows the
// check; it counts every request with its time. No model is run and nothing leaves this computer. The openers on PATH are
// stubs that only log. Everything else is the real program, started as the installed command starts it (src/cli.ts through
// tsx's loader) over a sandbox of its own. The screens are kept as .ansi and .txt in <tmpdir>/timmy-workbench-captures/
// r11-choose-local, or in TIMMY_WB_CAPTURES.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';
import { keepScreen, readPane, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r11-choose-local');
const LABEL = 'wbChooseLocal';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the cells `from` to `to` (inclusive) of a row, trailing blanks dropped */
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();
/** FAKE: how long the FAKE Ollama takes to answer /api/show (a frame drawn meanwhile shows the check under way) */
const SHOW_DELAY_MS = 1500;

let box = '';
let bin = '';
let server: Server | undefined;
let port = 0;
/** what the FAKE Ollama was asked, in order, with when ("POST /api/show fake-qwen3:8b") */
const asked: Array<{ at: number; what: string }> = [];
/** FAKE: the models the FAKE Ollama lists (no model is behind any of them) */
const FAKE_MODELS = [
  { name: 'fake-embed:latest', model: 'fake-embed:latest', size: 1_300_000_000, details: { parameter_size: '1B', quantization_level: 'F16' } },
  { name: 'fake-qwen3:8b', model: 'fake-qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
];
/** FAKE: what its /api/show says of each (capabilities as Ollama gives them; only "completion" makes a chat model) */
const FAKE_SHOW: Record<string, { details: { format: string; parameter_size: string; quantization_level: string }; model_info: Record<string, number>; capabilities: string[] }> = {
  'fake-embed:latest': { details: { format: 'gguf', parameter_size: '1B', quantization_level: 'F16' }, model_info: { 'fake.context_length': 512 }, capabilities: ['embedding'] },
  'fake-qwen3:8b': { details: { format: 'gguf', parameter_size: '8B', quantization_level: 'Q4_K_M' }, model_info: { 'fake.context_length': 40_960 }, capabilities: ['completion', 'tools'] },
};

const cli = (env: NodeJS.ProcessEnv, cwd: string, args: string[], timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd, env, timeout });

/** A sandbox of its own: a home, the Timmy home, the settings folder and a work folder; `init` runs timmy init there with the
 *  FAKE Ollama's address (no chat answer, no model), else the home is left blank (no identity at all). */
async function sandbox(name: string, init: boolean): Promise<{ env: NodeJS.ProcessEnv; home: string; repo: string; timmy: string }> {
  const home = join(box, name, 'home');
  const repo = join(home, 'work');
  for (const d of [home, repo, join(box, name, 'tmp'), join(box, name, 'settings')]) mkdirSync(d, { recursive: true });
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  delete base.OLLAMA_HOST;
  delete base.OLLAMA_BASE_URL;
  delete base.TIMMY_WORKBENCH_CHAT;
  delete base.TIMMY_CHAT_MODEL;
  const timmy = join(home, 'timmy');
  const env: NodeJS.ProcessEnv = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmy, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, name, 'settings'), TMPDIR: join(box, name, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  if (init) {
    const r = await cli(env, repo, ['init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo', '--ollama', `127.0.0.1:${port}`]);
    expect(r.status, r.stderr).toBe(0);
    const made = await cli(env, repo, ['act', '/project new tray1 --from tray-workflow']);
    expect(made.status, `${made.stdout}\n${made.stderr}`).toBe(0);
  } else {
    // (no identity, no setup record: only the Ollama address, since the setup's default is Ollama's own 11434, where this
    // test's FAKE never listens; the operator's Mac has Ollama there)
    mkdirSync(timmy, { recursive: true });
    writeFileSync(join(timmy, 'providers.json'), `${JSON.stringify({ ollama_host: `http://127.0.0.1:${port}` })}\n`, { mode: 0o600 });
  }
  return { env, home, repo, timmy };
}

/** `timmy workbench` in a tmux session of a server of this test's own, one server a sandbox (a tmux server keeps the
 *  environment it was started with, so each sandbox's HOME and Timmy home need a server of their own), at `w` x `h`; its
 *  first settled frame that shows `re`. */
const servers: string[] = [];
async function launch(session: string, env: NodeJS.ProcessEnv, repo: string, w: number, h: number, re: RegExp, what: string): Promise<{ screen: string; pane: Pane }> {
  const label = `${LABEL}-${session}`;
  servers.push(label);
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', String(w), '-y', String(h), '-c', repo, 'bash', '--norc', '-c',
    `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
  const pane: Pane = { tmux, target: session, folders: [box] };
  const screen = await waitScreen(pane, { what, re, ms: 60_000 });
  return { screen, pane };
}

function stop(env: NodeJS.ProcessEnv, session: string): void {
  try { execFileSync('tmux', ['-L', `${LABEL}-${session}`, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* gone */ }
}

function listen(): Promise<void> {
  return new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-choose-local-'));
  bin = join(box, 'fakebin');
  for (const d of [bin, CAPTURES]) mkdirSync(d, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // FAKE: the Ollama, on 127.0.0.1 at a port the system gives this test (never Ollama's own 11434)
  server = createServer((req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/api/tags') { asked.push({ at: Date.now(), what: 'GET /api/tags' }); json(200, { models: FAKE_MODELS }); return; }
    if (req.method === 'POST' && req.url === '/api/show') {
      let body = '';
      req.on('data', (b: Buffer) => { body += b.toString('utf8'); });
      req.on('end', () => {
        let name = '';
        try { name = String((JSON.parse(body) as { model?: unknown }).model ?? ''); } catch { /* none */ }
        asked.push({ at: Date.now(), what: `POST /api/show ${name}` });
        const show = FAKE_SHOW[name];
        // (its answer comes after a while, as a loaded Ollama's does, so the check is seen under way)
        setTimeout(() => json(show ? 200 : 404, show ?? { error: `FAKE Ollama: model '${name}' not found` }), SHOW_DELAY_MS);
      });
      return;
    }
    asked.push({ at: Date.now(), what: `${req.method} ${req.url}` });
    json(404, { error: 'FAKE Ollama: only /api/tags and /api/show are answered here' });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  expect(port).not.toBe(11434);
}, 60_000);

afterAll(async () => {
  for (const label of servers) { try { execFileSync('tmux', ['-L', label, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: box }, stdio: 'ignore' }); } catch { /* none */ } }
  await new Promise<void>((r) => (server?.listening ? server.close(() => r()) : r()));
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

/** The choice, as a person makes it: ↓ to Ollama / this computer, Enter; Models lists the FAKE models (each checked) */
async function toLocalList(pane: Pane): Promise<string> {
  await sendKeys(pane, ['Down', 'Enter']);
  return waitScreen(pane, { what: 'Models listing the FAKE local models, each checked', re: /not a chat model[\s\S]*FAKE fake-qwen3:8b/, ms: 30_000 });
}

describe('R11 step 1 (H167): Ollama → this computer → a row → Enter on the Chat screen, in a real terminal (tmux; FAKE Ollama)', { timeout: 300_000 }, () => {
  it('122x37: a failing row says why and saves nothing; a chat model is checked (amber), then ready (green, after the FAKE answered): saved, the selector closed, the composer with the draft, the status row naming the next turn', async () => {
    const { env, repo, timmy } = await sandbox('wide', true);
    const { pane } = await launch('wide', env, repo, 122, 37, /How would you like to run chat\?[\s\S]*Continue without a model/, 'the first run\'s question');
    keepScreen(pane, CAPTURES, 'choose-local-122x37-01-first-run', { foot: 'drawn' });
    // the operator's path: the question → Ollama / this computer → the list (the draft case is the 80x24 one)
    let screen = await toLocalList(pane);
    const rail = (s: string) => s.split('\n').map((r) => cols(r, 92, 121));
    expect(rail(screen).slice(14, 18)).toEqual(['> FAKE fake-embed:latest', '  not a chat model', '  FAKE fake-qwen3:8b', '  8B · Q4_K_M · 5.2 GB']);
    const listed = asked.length;
    // Enter on the embedding model: Ollama is asked once more; nothing is saved; the row says why; the keyboard stays on Models
    await sendKeys(pane, ['Enter']);
    screen = await waitScreen(pane, { what: 'the check under way on the row', re: /> FAKE fake-embed:latest\s*\n.*checking with Ollama/, ms: 20_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-02-checking-failing-row', { foot: 'drawn' });
    screen = await waitScreen(pane, { what: 'the row refused', re: /✕ not a chat model/, ms: 20_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-03-failing-row', { foot: 'drawn' });
    expect(rail(screen).slice(14, 16)).toEqual(['> FAKE fake-embed:latest', '  ✕ not a chat model']);
    // (H170's words under MODEL, in the rows the prices took; the last row cut where the rail ends)
    expect(rail(screen).join(' ').replace(/\s+/g, ' ')).toMatch(/fake-embed:latest is not a chat model: Ollama at 127\.0\.0\.1:\d+ lists it without the completion/);
    expect(cols(screen.split('\n')[36], 20, 121)).toMatch(/^Not chosen: not a chat model: no completion capability\./);
    expect(asked.slice(listed).map((a) => a.what)).toEqual(['POST /api/show fake-embed:latest']);
    expect(existsSync(join(timmy, 'setup.json')) ? JSON.parse(readFileSync(join(timmy, 'setup.json'), 'utf8')).answers.model : undefined).toBeUndefined();
    expect(screen).not.toMatch(/The local chat's model|WHAT CHANGED/);
    // ↓ to the chat model, Enter: checking, then ready after the FAKE answered; saved; the selector closes; the composer has
    // the keyboard; the status row names the next turn; the chip is green with the time
    await sendKeys(pane, ['Down', 'Enter']);
    const checking = await waitScreen(pane, { what: 'the chip checking (amber) while the FAKE takes its time', re: /checking/, ms: 20_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-04-checking', { foot: 'drawn' });
    expect(checking).not.toMatch(/ready \d\d:\d\d/);
    const ready = await waitScreen(pane, { what: 'the choice made, the composer with the keyboard', re: /Next turn: fake-qwen3:8b on this computer\./, ms: 30_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-05-ready', { foot: 'drawn' });
    const shows = asked.filter((a) => a.what === 'POST /api/show fake-qwen3:8b');
    expect(shows.length).toBeGreaterThanOrEqual(2);
    const rows = ready.split('\n');
    expect(cols(rows[1], 20, 121)).toBe('NEXT / Ollama local / FAKE fake-qwen3:8b');
    const center = rows.map((r) => cols(r, 20, 89));
    expect(center.some((r) => /^› /.test(r))).toBe(true);
    expect(center.some((r) => /\[ Send \] +Enter sends · Ctrl\+J newline/.test(r))).toBe(true);
    expect(center.some((r) => /● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d/.test(r))).toBe(true);
    expect(JSON.parse(readFileSync(join(timmy, 'setup.json'), 'utf8'))).toMatchObject({ by: 'timmy workbench', answers: { chat: 'local', model: 'fake-qwen3:8b' } });
    // the keyboard is in the composer: what is typed shows after ›; nothing is sent
    await sendKeys(pane, ['FIXTURE typed after the choice'], { literal: true });
    const typed = await waitScreen(pane, { what: 'the words in the composer', re: /› FIXTURE typed after the choice/, ms: 20_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-06-composer-typing', { foot: 'drawn' });
    expect(typed).not.toMatch(/YOU \/ \d\d:\d\d/);
    expect(asked.some((a) => /\/api\/chat/.test(a.what))).toBe(false);
    stop(env, 'wide');
  });

  it('80x24: Models is a drawer over the center; a draft typed before; Ollama → the chat model → Enter: checking, then ready: the drawer gone, the composer with the draft and the keyboard, the status row naming the next turn', async () => {
    const { env, repo, timmy } = await sandbox('narrow', true);
    const { pane } = await launch('narrow', env, repo, 80, 24, /How would you like to run chat\?/, 'the first run\'s question at 80x24');
    keepScreen(pane, CAPTURES, 'choose-local-80x24-01-first-run', { foot: 'drawn' });
    // Continue without a model, then Write a draft: a draft; Tab leaves it kept; Review setup choices asks the question again
    await sendKeys(pane, ['Down', 'Down', 'Down', 'Enter']);
    await waitScreen(pane, { what: 'Chat with no model', re: /A model is optional until you need an answer\./, ms: 20_000 });
    await sendKeys(pane, ['Down', 'Down', 'Enter']);
    await sendKeys(pane, ['FIXTURE: a draft kept across the choice'], { literal: true });
    await waitScreen(pane, { what: 'the draft in the composer', re: /FIXTURE: a draft kept across the choice/, ms: 20_000, foot: 'drawn' });
    // (Tab: the keyboard on the model chip, the words kept as the draft; M from there: the Models drawer)
    await sendKeys(pane, ['Tab']);
    await waitScreen(pane, { what: 'the draft kept in the composer', re: /› FIXTURE: a draft kept across the choice/, ms: 20_000, foot: 'drawn' });
    await sendKeys(pane, ['M']);
    await waitScreen(pane, { what: 'the Models drawer', re: /MODELS +\[ Close \]/, ms: 20_000, foot: 'drawn' });
    // (the drawer opens on the local Ollama, the route's provider on a home with no chat answer: its list, each row checked)
    let screen = await waitScreen(pane, { what: 'the local list in the drawer', re: /> Local[\s\S]*FAKE fake-qwen3:8b/, ms: 30_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-80x24-02-models-drawer', { foot: 'drawn' });
    const mid = (s: string) => s.split('\n').map((r) => cols(r, 16, 79));
    const row = mid(screen).findIndex((r) => /FAKE fake-qwen3:8b/.test(r));
    expect(row).toBeGreaterThan(0);
    if (!/^> /.test(mid(screen)[row])) await sendKeys(pane, ['Down']);
    screen = await waitScreen(pane, { what: 'the cursor on the chat model', re: /> FAKE fake-qwen3:8b/, ms: 20_000, foot: 'drawn' });
    await sendKeys(pane, ['Enter']);
    const checking = await waitScreen(pane, { what: 'the row checking in the drawer', re: /> FAKE fake-qwen3:8b \/ checking/, ms: 20_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-80x24-03-checking', { foot: 'drawn' });
    expect(checking).toMatch(/MODELS/);
    const ready = await waitScreen(pane, { what: 'the drawer gone, the composer with the draft', re: /Next turn: fake-qwen3:8b on this computer\./, ms: 30_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-80x24-04-ready', { foot: 'drawn' });
    const m = mid(ready);
    expect(m.join('\n')).not.toMatch(/MODELS|\[ Close \]|> Local/);
    expect(m.some((r) => /^› FIXTURE: a draft kept across the choice/.test(r))).toBe(true);
    expect(m.some((r) => /\[ Send \] +Enter sends · Ctrl\+J newline/.test(r))).toBe(true);
    expect(m.some((r) => /● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d/.test(r))).toBe(true);
    expect(cols(ready.split('\n')[1], 16, 79)).toBe('');
    expect(JSON.parse(readFileSync(join(timmy, 'setup.json'), 'utf8'))).toMatchObject({ by: 'timmy workbench', answers: { chat: 'local', model: 'fake-qwen3:8b' } });
    expect(asked.some((a) => /\/api\/chat/.test(a.what))).toBe(false);
    stop(env, 'narrow');
  });

  it('an Ollama that does not answer: nothing saved, the row says it did not answer at its address, the status row too (the FAKE stopped for the choice)', async () => {
    const { env, repo, timmy } = await sandbox('noanswer', true);
    const { pane } = await launch('noanswer', env, repo, 122, 37, /How would you like to run chat\?/, 'the first run\'s question');
    await toLocalList(pane);
    await sendKeys(pane, ['Down']);
    await waitScreen(pane, { what: 'the cursor on the chat model', re: /> FAKE fake-qwen3:8b/, ms: 20_000, foot: 'drawn' });
    // the FAKE stops listening: the choice's check finds nothing at the address
    await new Promise<void>((r) => server!.close(() => r()));
    try {
      await sendKeys(pane, ['Enter']);
      const refused = await waitScreen(pane, { what: 'the row saying Ollama did not answer', re: /✕ no answer from Ollama/, ms: 30_000, foot: 'drawn' });
      keepScreen(pane, CAPTURES, 'choose-local-122x37-07-no-answer', { foot: 'drawn' });
      const rail = refused.split('\n').map((r) => cols(r, 92, 121));
      expect(rail.slice(16, 18)).toEqual(['> FAKE fake-qwen3:8b', '  ✕ no answer from Ollama']);
      expect(rail.join(' ').replace(/\s+/g, ' ')).toMatch(new RegExp(`Ollama is not running at 127\\.0\\.0\\.1:${port} \\(the connection was refused\\): start it \\(ollama serve\\), then choose the model again\\.`));
      // (the status row says a loopback address as "this computer", as every notice there does; the row has the address)
      expect(cols(refused.split('\n')[36], 20, 121)).toMatch(/^Not chosen: Ollama did not answer on this computer\./);
      expect(JSON.parse(readFileSync(join(timmy, 'setup.json'), 'utf8')).answers.model).toBeUndefined();
      expect(refused).not.toMatch(/Next turn:/);
    } finally {
      await listen();
    }
    stop(env, 'noanswer');
  });

  it('a home with no identity at all (no timmy init): the choice sets it up, the identity made by the setup\'s writer and recorded as made by timmy workbench; never a shell', async () => {
    const { env, repo, timmy } = await sandbox('blank', false);
    expect(existsSync(join(timmy, 'identity.json'))).toBe(false);
    const { pane } = await launch('blank', env, repo, 122, 37, /How would you like to run chat\?/, 'the first run\'s question on a blank home');
    await toLocalList(pane);
    await sendKeys(pane, ['Down', 'Enter']);
    // (on the status row the folder is "its folder", as every path there)
    const ready = await waitScreen(pane, { what: 'the choice made and the home set up', re: /Next turn: fake-qwen3:8b on this computer\. Set up now \(identity made in its folder\)\./, ms: 30_000, foot: 'drawn' });
    keepScreen(pane, CAPTURES, 'choose-local-122x37-08-blank-home-set-up', { foot: 'drawn' });
    expect(ready).not.toMatch(/timmy init, in a shell|not set up on this computer/);
    expect(existsSync(join(timmy, 'identity.json'))).toBe(true);
    expect(existsSync(join(timmy, 'identity.seed'))).toBe(true);
    expect(JSON.parse(readFileSync(join(timmy, 'setup.json'), 'utf8'))).toMatchObject({ by: 'timmy workbench', answers: { chat: 'local', model: 'fake-qwen3:8b', identity: 'generated' } });
    // (the words say the folder from ~, never this machine's path)
    expect(ready).not.toContain(box);
    stop(env, 'blank');
  });
});
