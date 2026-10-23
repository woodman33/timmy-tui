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
//   answers GET /api/tags with four FAKE models (names with "fake" in them) and POST /api/show for each as Ollama would (two
//   do not establish a chat model: a decision model and an embedding model, as the lead's Mac lists; one has a long name), and
//   counts every request it gets; in the last case only, POST /api/chat with one fixed FAKE answer (scripted, streamed as
//   Ollama streams: no model behind it), for the one turn that case sends;
// - the openers on PATH (`open` and `xdg-open` stubs that only log; nothing presses Show; Connect OpenRouter's Open hands its
//   sign-in address to them, and they only log it).
// Connect OpenRouter's sign-in is H170's own flow (src/setup/openrouter-signin.ts): its server listens on 127.0.0.1 here and
// is cancelled before any code comes back, so nothing is ever sent to OpenRouter.
// Everything else is the real program, started as the installed command starts it (src/cli.ts through tsx's loader), over a
// sandbox of its own (HOME, the XDG folders, the Timmy home, the settings folder, the store, TMPDIR and the tmux server). The
// screens are kept as .ansi and .txt in <tmpdir>/timmy-workbench-captures/r10-chat-landing, or in TIMMY_WB_CAPTURES.
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
/** FAKE: the models the FAKE Ollama lists (no model is behind any of them) */
const LONG = 'hf.co/fake-maker/a-very-long-model-name-GGUF:Q4_K_M';
const FAKE_MODELS = [
  { name: 'fake-decision:latest', model: 'fake-decision:latest', size: 12_400_000_000, details: { parameter_size: '12B', quantization_level: 'MXFP8' } },
  { name: 'fake-embed:latest', model: 'fake-embed:latest', size: 1_300_000_000, details: { parameter_size: '1B', quantization_level: 'F16' } },
  { name: 'fake-qwen3:8b', model: 'fake-qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
  { name: LONG, model: LONG, size: 18_500_000_000, details: { parameter_size: '27.3B', quantization_level: 'Q4_K_M' } },
];
/** FAKE: what its /api/show says of each (capabilities as Ollama gives them; only "completion" makes a chat model) */
const FAKE_SHOW: Record<string, { details: { format: string }; capabilities: string[] }> = {
  'fake-decision:latest': { details: { format: 'gguf' }, capabilities: ['tools'] },
  'fake-embed:latest': { details: { format: 'gguf' }, capabilities: ['embedding'] },
  'fake-qwen3:8b': { details: { format: 'gguf' }, capabilities: ['completion', 'tools'] },
  [LONG]: { details: { format: 'gguf' }, capabilities: ['completion'] },
};
/** FAKE: the one answer the FAKE Ollama gives a chat turn (scripted; no model behind it) */
const FAKE_ANSWER = 'FAKE answer from the test\'s stand-in (no model behind it).';
/** what an Ollama is asked that runs no model: its list, and each model's facts */
const LISTING = /^(GET \/api\/tags|POST \/api\/show)$/;

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
    if (req.method === 'POST' && req.url === '/api/show') {
      let body = '';
      req.on('data', (b: Buffer) => { body += b.toString('utf8'); });
      req.on('end', () => {
        let name = '';
        try { name = String((JSON.parse(body) as { model?: unknown }).model ?? ''); } catch { /* none */ }
        const show = FAKE_SHOW[name];
        res.writeHead(show ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(show ?? { error: `FAKE Ollama: model '${name}' not found` }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      req.resume();
      req.on('end', () => {
        const line = (o: Record<string, unknown>) => `${JSON.stringify({ model: 'fake-qwen3:8b', created_at: new Date().toISOString(), ...o })}\n`;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(line({ message: { role: 'assistant', content: FAKE_ANSWER }, done: false }));
        // (its end comes after a while, as a model's does, so the turn being answered is seen: [ Stop ] in the composer)
        setTimeout(() => res.end(line({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: 1 })), 2500);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'FAKE Ollama: only /api/tags, /api/show and /api/chat are answered here' }));
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
    const first = await launch('fresh', /How would you like to run chat\?[\s\S]*Continue without a model/, 'the first run\'s question on the Chat screen');
    const pane = first.pane;
    // (Models beside it lists what the FAKE Ollama lists, once each model's /api/show has answered)
    const screen = await waitScreen(pane, { what: 'the first run with Models listing the local models', re: /How would you like to run chat\?[\s\S]*not a chat model/, ms: 30_000 });
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
    expect(cols(rows[4], 92, 121)).toMatch(/^MODELS \[M\] +\[ Details \]$/);
    expect(cols(rows[35], 20, 121)).toBe('[Attach]  [Tools]  [Plan / Run]  [Permissions]  [Budget]  [Stop]  [Logs]  [Cloudflare]');
    expect(cols(rows[36], 20, 121)).toMatch(/^Logs: this computer \/ idle .* 122 x 37$/);
    // never the tabbed Home
    expect(screen).not.toMatch(/\[1 Home\]|\/ Home · recent work|Workflow actions/);
    // Models (the lead's Mac check of 50237ef): each local model as its /api/show answer establishes it, by name; the two that
    // are not chat models say so; the long name is cut where its row ends, its facts below it; with no route chosen the mark is
    // the cursor and nothing is SELECTED or "the next turn's"
    const rail = rows.map((r) => cols(r, 92, 121));
    expect(rail.slice(14, 22)).toEqual(['> FAKE fake-decision:latest', '  not a chat model', '  FAKE fake-embed:latest', '  not a chat model', '  FAKE fake-qwen3:8b', '  8B · Q4_K_M · 5.2 GB', '  FAKE hf.co/fake-maker/a-v…', '  27.3B · Q4_K_M · 18.5 GB']);
    expect(rail.join('\n')).toMatch(/Not a chat model \(checked\)\./);
    expect(screen).not.toMatch(/SELECTED|next turn uses it/);
    // OpenRouter / cloud (the cursor's): Connect OpenRouter. Sign in starts H170's flow: its address shown whole; Open hands it
    // to the opener (the FAKE xdg-open logs it) only on that Enter; Esc cancels it, nothing saved, the question again
    await sendKeys(pane, ['Enter']);
    await waitScreen(pane, { what: 'Connect OpenRouter', re: /Connect OpenRouter[\s\S]*\[ Sign in with OpenRouter \][\s\S]*\[ Paste a key \]/, ms: 20_000 });
    await sendKeys(pane, ['Enter']);
    const signin = await waitScreen(pane, { what: 'the sign-in\'s address', re: /The address to sign in at[\s\S]*Open it in the browser/, ms: 20_000 });
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-01b-openrouter-signin', { foot: 'drawn' });
    const mid = signin.split('\n').map((r) => cols(r, 20, 89));
    const at = mid.findIndex((r) => r.startsWith('  https://openrouter.ai/auth?'));
    const parts: string[] = [];
    for (let k = at; k >= 0 && /^ {2}\S+$/.test(mid[k] ?? ''); k++) parts.push(mid[k].slice(2));
    const url = parts.join('');
    expect(url).toMatch(/^https:\/\/openrouter\.ai\/auth\?callback_url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fopenrouter%2Fcallback%2F[\w-]+&code_challenge=[\w-]{43}&code_challenge_method=S256$/);
    expect(existsSync(join(box, 'opened.log'))).toBe(false);
    await sendKeys(pane, ['Enter']);
    await waitScreen(pane, { what: 'the sign-in page handed to the opener', re: /Opened in the browser: sign in on OpenRouter/, ms: 20_000 });
    // (the opener is a process of its own: its log once it has run)
    for (const end = Date.now() + 5_000; Date.now() < end && !existsSync(join(box, 'opened.log')); await sleep(50)) { /* it runs */ }
    expect(readFileSync(join(box, 'opened.log'), 'utf8').trim().split('\n')).toEqual([expect.stringContaining(url)]);
    await sendKeys(pane, ['Escape']);
    await waitScreen(pane, { what: 'the first run again, the sign-in cancelled', re: /How would you like to run chat\?/, test: (s) => !/Connect OpenRouter/.test(s), ms: 20_000 });
    // Paste a key: the hidden field says how many characters, never which; Esc goes back, Esc again closes (nothing kept)
    const FIXTURE_KEY = 'FIXTURE-not-a-real-key-0123456789';
    await sendKeys(pane, ['Enter']);
    await waitScreen(pane, { what: 'Connect OpenRouter again', re: /\[ Paste a key \]/, ms: 20_000 });
    await sendKeys(pane, ['Down', 'Enter']);
    await waitScreen(pane, { what: 'the hidden field', re: /nothing typed yet \(hidden\)/, ms: 20_000 });
    await sendKeys(pane, [FIXTURE_KEY], { literal: true });
    const hidden = await waitScreen(pane, { what: 'the characters counted, not shown', re: new RegExp(`${FIXTURE_KEY.length} characters typed \\(hidden\\)`), ms: 20_000 });
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-01c-openrouter-key-hidden', { foot: 'drawn' });
    expect(hidden).not.toContain(FIXTURE_KEY);
    expect(hidden).not.toContain('FIXTURE-not');
    await sendKeys(pane, ['Escape']);
    await waitScreen(pane, { what: 'back to the box\'s choices', re: /Connect OpenRouter[\s\S]*\[ Sign in with OpenRouter \]/, ms: 20_000 });
    await sendKeys(pane, ['Escape']);
    await waitScreen(pane, { what: 'the first run again', re: /How would you like to run chat\?/, test: (s) => !/Connect OpenRouter/.test(s), ms: 20_000 });
    expect(existsSync(join(env.TIMMY_HOME ?? '', 'providers.json')) ? readFileSync(join(env.TIMMY_HOME ?? '', 'providers.json'), 'utf8') : '').not.toMatch(/openrouter_api_key/);
    // Continue without a model (the fourth choice): Chat with no model, its composer keeping a draft
    await sendKeys(pane, ['Down', 'Down', 'Down', 'Enter']);
    const none = await waitScreen(pane, { what: 'Chat with no model', re: /A model is optional until you need an answer\./, ms: 20_000 });
    // (R11 H167, step 1b/1c: the composer always drawn; Send dim with the reason; the chip says no model)
    expect(none).toMatch(/› Message TIMMY…/);
    expect(none).toMatch(/\[ Send \]  no model: M chooses one +○ no model · choose one \(M\)/);
    expect(none.split('\n').map((r) => cols(r, 20, 121))[1]).toBe('NEXT / Connect a model to chat');
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-02-no-model', { foot: 'drawn' });
    // (H168's pass 3a, R4, its keys: Write a draft, a message, Enter: not sent, as the route has no model; the no-model view
    // and its choices stay, the message kept in the composer; no refusal of the REPL's drawn in their place)
    await sendKeys(pane, ['Down', 'Down', 'Enter']);
    await sendKeys(pane, ['FIXTURE: a message with no model'], { literal: true });
    await sendKeys(pane, ['Enter']);
    const kept = await waitScreen(pane, { what: 'the no-model view kept, the message not sent', re: /A model is optional until you need an answer\.[\s\S]*Review setup choices[\s\S]*FIXTURE: a message with no model/, ms: 20_000 });
    expect(kept).not.toMatch(/Cause|YOUR LAST MESSAGE|a setting \(\[i\]\)/);
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-02b-no-model-send', { foot: 'drawn' });
    // nothing but what Ollama lists and each model's facts was asked of it (no chat turn: there is no model)
    expect(asked).toContain('POST /api/show');
    expect(asked.filter((a) => !LISTING.test(a))).toEqual([]);
    stop('fresh');
  });

  it('the home with the local route and a model (FAKE fake-qwen3:8b): the first frame is Chat with the conversation\'s place and the composer', async () => {
    const host = `127.0.0.1:${port}`;
    const set = await cli(['init', '--yes', '--chat', 'local', '--ollama', host, '--model', 'fake-qwen3:8b']);
    expect(set.status, `${set.stdout}\n${set.stderr}`).toBe(0);
    const { screen, pane } = await launch('model', /CHAT \/ tray1[\s\S]*› Message TIMMY…/, 'the Chat screen with the composer');
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-03-with-model-FAKE', { foot: 'drawn' });
    const rows = screen.split('\n');
    expect(cols(rows[0], 20, 121)).toMatch(/^tray1 \/ Chat +LOCAL RECORDS$/);
    expect(cols(rows[1], 20, 121)).toBe('NEXT / Ollama local / FAKE fake-qwen3:8b');
    expect(cols(rows[4], 20, 89)).toBe('CHAT / tray1');
    const center = rows.map((r) => cols(r, 20, 89));
    expect(center[27]).toBe('─'.repeat(69));
    // (R11 H167, step 1b/1c: the tinted composer with its placeholder; [ Send ] with the chord hint; the chip: green only once
    // the listing's /api/show answered for the route's model, grey "not checked" before)
    expect(center.slice(28, 30)).toEqual(['› Message TIMMY…', '']);
    expect(center[30]).toBe('[ Send ]  Enter sends · Ctrl+J newline');
    expect(center[31]).toMatch(/^[●○] FAKE fake-qwen3:8b · this computer · (ready \d\d:\d\d|not checked|checking…)$/);
    expect(screen).not.toMatch(/WELCOME TO TIMMY|How would you like to run chat|\[1 Home\]|\/ Home · recent work/);
    // (R11 H167, step 2a: the welcome in the conversation's place: the three lines, START WITH and the four starter actions,
    // none selected; the composer below them)
    expect(center.slice(7, 9)).toEqual(['TIMMY runs tools and workflows on your machine and keeps a receipt', 'for every step.']);
    expect(center[9]).toBe('Write below and press Enter: the model on the chip answers.');
    expect(center.slice(10, 12)).toEqual(['Logs and receipts stay on this computer, in this project\'s .timmy', 'folder: Logs & records lists them.']);
    expect(center[13]).toBe('START WITH');
    expect([center[14], center[17], center[20], center[23]]).toEqual(['  [ Ask about this project ]', '  [ Inspect an image ]', '  [ Run a workflow ]', '  [ Open the canvas ]']);
    // Models: the route's model is SELECTED, the next turn's (once the list is read)
    const listed = await waitScreen(pane, { what: 'Models listing the route\'s model as SELECTED', re: /SELECTED[\s\S]*The next turn uses it\./, ms: 30_000 });
    const rail = listed.split('\n').map((r) => cols(r, 92, 121));
    expect(rail).toContain('> FAKE fake-qwen3:8b');
    expect(rail.join('\n')).toMatch(/The next turn uses it\./);
    expect(listed.split('\n').map((r) => cols(r, 20, 89))[31]).toMatch(/^● FAKE fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
    // no chat turn was sent: the FAKE Ollama was asked only what it lists and each model's facts
    expect(asked.filter((a) => !LISTING.test(a))).toEqual([]);
    stop('model');
  });

  it('an answered turn, quit, relaunch: the same conversation in the center (one turn to the FAKE Ollama, its scripted answer; the lead\'s ask for the Mac)', async () => {
    // (the home of the case before: the local route with FAKE fake-qwen3:8b)
    const QUESTION = 'FIXTURE: what does the tray workflow do?';
    const { pane } = await launch('turn', /CHAT \/ tray1[\s\S]*› Message TIMMY…/, 'the Chat screen with the composer');
    await sendKeys(pane, ['Enter']);
    await sendKeys(pane, [QUESTION], { literal: true });
    await sendKeys(pane, ['Enter']);
    // (a send while the chat session is still opening keeps the text in the composer, "Not sent yet", and Enter sends it once
    // the session is open: pressed again then, as a person would)
    for (const end = Date.now() + 30_000; Date.now() < end && !/FAKE answer from the test's stand-in/.test(readPane(pane).text); await sleep(250)) {
      if (/Not sent yet: /.test(readPane(pane).text) && readPane(pane).text.includes(QUESTION)) { await sleep(500); await sendKeys(pane, ['Enter']); }
    }
    // (R11 H167, step 1b: while the FAKE's answer is still open, [ Stop ] in the composer's row: the turn being answered)
    const during = keepScreen(pane, CAPTURES, 'chat-landing-122x37-03b-turn-FAKE', { foot: 'drawn', re: /\[ Stop \]  Esc stops the turn being answered/ });
    expect(during).toMatch(/\[ Stop \]  Esc stops the turn being answered/);
    expect(during).not.toMatch(/\[ Send \]/);
    // (the turn answered: the answer under TIMMY / the model / its time, no longer BEING ANSWERED NOW)
    const answered = await waitScreen(pane, { what: 'the FAKE answer in the conversation, the turn answered', re: /FIXTURE: what does the tray workflow do\?[\s\S]*TIMMY \/ FAKE fake-qwen3:8b \/ \d\d:\d\d[\s\S]*FAKE answer from the test's stand-in/, test: (s) => !/BEING ANSWERED NOW/.test(s), ms: 60_000 });
    expect(answered).toMatch(/TIMMY \/ FAKE fake-qwen3:8b \/ \d\d:\d\d/);
    expect(asked.filter((a) => a === 'POST /api/chat')).toHaveLength(1);
    // (R11 H167, step 2b: the evidence line under the answer, from the receipt the real session sealed: the model, this
    // computer, its seconds, its receipt, ✓ as verifyReceiptIn confirmed it in this reading; the old status row is gone)
    const EVIDENCE = /  FAKE fake-qwen3:8b · this computer · \d+\.\d s · receipt [0-9a-f]{8} ✓/;
    const sealed = await waitScreen(pane, { what: 'the evidence line under the answer', re: EVIDENCE, ms: 20_000 });
    expect(sealed.split('\n').map((r) => cols(r, 20, 89)).join('\n')).not.toMatch(/answered · sent to a model|receipt sealed/);
    const evidenceRow = sealed.split('\n').findIndex((r) => EVIDENCE.test(r));
    expect(evidenceRow).toBeGreaterThan(7);
    // Esc leaves the composer; ↓ selects the newest message (the answer); Enter opens its activity: no tool ran (the FAKE's
    // scripted answer calls none), the receipt's facts; Esc folds it
    await sendKeys(pane, ['Escape', 'Down', 'Enter']);
    const open = await waitScreen(pane, { what: 'the answer\'s activity open', re: /  no tool ran[^\n]*\n[^\n]*  sealed \d\d:\d\d:\d\d · operation \S+ · answered · no charge[^\n]*\n[^\n]*  verified ✓/, ms: 20_000 });
    keepScreen(pane, CAPTURES, 'chat-landing-122x37-03c-evidence-open-FAKE', { foot: 'drawn' });
    const rows = open.split('\n').map((r) => cols(r, 20, 89));
    expect(rows[evidenceRow + 1]).toBe('  no tool ran');
    expect(rows[evidenceRow + 2]).toMatch(/^  sealed \d\d:\d\d:\d\d · operation \S+ · answered · no charge$/);
    expect(rows[evidenceRow + 3]).toBe('  verified ✓');
    await sendKeys(pane, ['Escape']);
    await waitScreen(pane, { what: 'the activity folded', re: EVIDENCE, test: (s) => !/no tool ran/.test(s), ms: 20_000 });
    // quit (Ctrl+C): nothing of its own runs once the turn is answered, so it ends at once
    await sendKeys(pane, ['C-c']);
    await waitScreen(pane, { what: 'the Workbench ended', re: /EXIT=0/, ms: 20_000 });
    stop('turn');
    // relaunch: the first frame is that conversation, in the center
    const again = await launch('again', /CHAT \/ tray1[\s\S]*FAKE answer from the test's stand-in/, 'the same conversation after the relaunch');
    keepScreen(again.pane, CAPTURES, 'chat-landing-122x37-04-relaunch-FAKE', { foot: 'drawn' });
    const center = again.screen.split('\n').map((r) => cols(r, 20, 89));
    expect(center[4]).toBe('CHAT / tray1');
    const q = center.indexOf(QUESTION);
    expect(q, again.screen).toBeGreaterThan(4);
    expect(center[q - 1]).toMatch(/^YOU \/ \d\d:\d\d$/);
    expect(center.slice(q + 1)).toContain(FAKE_ANSWER);
    // (R11 step 2b: the evidence line under the answer after the relaunch too: the receipt read and verified at the start)
    expect(center[center.indexOf(FAKE_ANSWER) + 1]).toMatch(/^  FAKE fake-qwen3:8b · this computer · \d+\.\d s · receipt [0-9a-f]{8} ✓$/);
    expect(again.screen).not.toMatch(/START WITH/);
    // the relaunch sent nothing: still the one turn
    expect(asked.filter((a) => a === 'POST /api/chat')).toHaveLength(1);
    stop('again');
  });
});
