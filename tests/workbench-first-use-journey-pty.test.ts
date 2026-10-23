/**
 * R11 (H172, item 2): the operator's exact first-use journey, driven independently of H167's own test, from H167's KEY PATH
 * posted in the handoff (2026-10-23 09:27 PT), in a real terminal (tmux) at 122x37, then 80x24:
 *   launch `timmy workbench` on a BLANK home (no `timmy init`, no shell) → the first run's question → Down → Enter on
 *   "[ Ollama / this computer ]" → Models lists what the FAKE Ollama lists (each row checked by /api/show) → Esc ("Models
 *   keeps its state"; the center's no-model view has the keyboard) → Write a draft → the draft typed → Esc (kept) → M →
 *   "> granite4.2:latest" → Enter → "checking with Ollama…" (the FAKE delays /api/show, so the screen is read in between)
 *   → ready: the selector closed, the composer has the keyboard with the draft typed before the choice, the status row
 *   "Next turn: granite4.2:latest on this computer. Set up now (identity made in ~/timmy)." and the chip green
 *   "● granite4.2:latest · this computer · ready HH:MM" → the message is typed and sent with Enter → the FAKE answers → the
 *   answer's evidence line is drawn.
 * Asserted: no shell was needed (the choice set identity and setup up: identity.json exists, setup.json by `timmy workbench`
 * with chat local and the model); the composer had the keyboard right after the choice (typed text lands in it); the draft
 * survived; the row went ready only after /api/show answered ("checking" seen first, and the FAKE's clock says when it
 * answered); the chip (H167's step 1c): "○ no model · choose one (M)" before the choice, amber "● … · checking…" while the
 * FAKE holds its answer, green "● … · ready HH:MM" after, at both widths; the status row's "Next turn: … on this computer."
 * at every width and "Set up now" where the row carries those words (the six-second flash goes through inWords, which says
 * the path as "its folder", and is cut with an ellipsis to the row's room: at 122x37 "…Set up now (identity made in its…",
 * at 80x24 "…on this computer. Set…", the latter said as skipped with the row's exact words, not passed; reported).
 *
 * FAKE, said where used: the Ollama is an HTTP server in this test's process on 127.0.0.1 at a port of its own (never 11434),
 * with no model behind it; it lists exactly `granite4.2:latest` (the identifier as the operator's Mac names it, with the facts
 * Ollama gives it), answers POST /api/show for it as a chat model after ~700 ms, and POST /api/chat with one short scripted
 * answer. Its address is the one line the blank home holds before launch, providers.json's ollama_host (what `timmy init
 * --ollama <host>` records; no identity, no setup record, no project): on a blank home the Workbench's Models list, its
 * /api/show check and the setup it writes all ask the setup's Ollama address, else 127.0.0.1:11434, and NOT OLLAMA_HOST
 * (src/workbench/setup-paths.ts ollama/checkLocal/setLocal), so OLLAMA_HOST alone left the FAKE unasked ("Ollama on this
 * computer did not answer (the connection was refused)" at 09:33 PT; H167's, reported). The openers on PATH are stubs that only log. Everything else is the real program (src/cli.ts through tsx's loader) over a
 * sandbox of its own. Screens are kept whole (tests/helpers/tmux-frame.ts) under <tmpdir>/timmy-workbench-captures/h172-first-use
 * (TIMMY_WB_CAPTURES overrides).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { keepScreen, readPane, sendKeys, waitScreen, type Pane } from './helpers/tmux-frame.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'h172-first-use');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The exact identifier the operator's Mac names (Ollama's /api/tags), with its facts as Ollama lists them. */
const MODEL = 'granite4.2:latest';
const FAKE_TAGS = [{ name: MODEL, model: MODEL, size: 5_300_000_000, digest: 'fake', details: { format: 'gguf', family: 'granite', parameter_size: '8.8B', quantization_level: 'Q4_K_M' } }];
/** FAKE: /api/show for it, a chat model (local weights that complete); delayed so the screen says "checking" first */
const SHOW_DELAY_MS = 700;
const FAKE_SHOW = { details: { format: 'gguf', family: 'granite', parameter_size: '8.8B', quantization_level: 'Q4_K_M' }, model_info: { 'granite.context_length': 131072 }, capabilities: ['completion', 'tools'] };
/**
 * The chat column's text from the answer's header ("TIMMY / <model> / HH:MM") down to its first empty row, its rows joined
 * by one space: the evidence line wraps where the column is narrow, and the columns beside it must not get in.
 */
function answerColumn(screen: string, model: string): string {
  const rows = screen.split('\n');
  const head = rows.findIndex((r) => r.includes(`TIMMY / ${model} / `));
  if (head < 0) return '';
  const from = rows[head].lastIndexOf('│', rows[head].indexOf('TIMMY /')) + 1;
  const to = rows[head].indexOf('│', from);
  const cell = (r: string): string => r.slice(from, to < 0 ? undefined : to).trim();
  const out: string[] = [];
  for (let i = head + 1; i < rows.length; i++) {
    const w = cell(rows[i]);
    if (!w && out.some((x) => /receipt sealed/.test(x))) break;
    if (w) out.push(w);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

/** The model chip (H167's step 1c): no model before the choice; amber "checking…" while Ollama is asked; green "ready HH:MM" after. */
const M = MODEL.replace('.', '\\.');
const CHIP_NONE = /○ no model(?: chosen)? · choose one \(M\)/;
const CHIP_CHECKING = new RegExp(`● ${M} · this computer · checking…`);
const CHIP_READY = new RegExp(`● ${M} · this computer · ready (\\d\\d:\\d\\d)`);
/** HH:MM as the Workbench's clock says a time (Date#toTimeString, this process's zone, the one the Workbench inherits) */
const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** the center's no-model view with the keyboard: its cursor on one of its three choices */
const CENTER_CURSOR = /> \[ (Choose a model|Review setup choices|Write a draft) \]/;
const DRAFT = 'FIXTURE draft typed before the choice';
const MESSAGE = ' and sent after it';
const FAKE_ANSWER = 'FAKE answer from the test\'s stand-in Ollama (no model behind it).';

let box = '';
let home = '';
let repo = '';
let timmyHome = '';
let env: NodeJS.ProcessEnv = {};
let server: Server | undefined;
let port = 0;
/** what the FAKE Ollama was asked, in order, with the clock when it answered ("POST /api/show granite4.2:latest") */
const asked: Array<{ what: string; at: number; answered: number }> = [];

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-first-use-'));
  home = join(box, 'home');
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
    const started = Date.now();
    const note = (what: string) => { const entry = { what, at: started, answered: 0 }; asked.push(entry); return () => { entry.answered = Date.now(); }; };
    if (req.method === 'GET' && req.url === '/api/tags') {
      const done = note('GET /api/tags');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: FAKE_TAGS }), done);
      return;
    }
    let body = '';
    req.on('data', (b: Buffer) => { body += b.toString('utf8'); });
    req.on('end', () => {
      let name = '';
      try { name = String((JSON.parse(body) as { model?: unknown }).model ?? ''); } catch { /* none */ }
      if (req.method === 'POST' && req.url === '/api/show') {
        const done = note(`POST /api/show ${name}`);
        // (answered after a delay: the screen is read while it waits, and the clock here says when it answered)
        setTimeout(() => {
          if (name === MODEL) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(FAKE_SHOW), done); }
          else { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `model '${name}' not found` }), done); }
        }, SHOW_DELAY_MS);
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const done = note(`POST /api/chat ${name}`);
        const line = (o: Record<string, unknown>) => `${JSON.stringify({ model: MODEL, created_at: new Date().toISOString(), ...o })}\n`;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(line({ message: { role: 'assistant', content: FAKE_ANSWER }, done: false }));
        res.end(line({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 1, prompt_eval_count: 1, eval_count: 1 }), done);
        return;
      }
      const done = note(`${req.method} ${req.url}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'FAKE Ollama: only /api/tags, /api/show and /api/chat are answered here' }), done);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  expect(port).not.toBe(11434);
  const base = withoutRunner(process.env);
  delete base.NODE_PATH;
  delete base.OLLAMA_BASE_URL;
  delete base.TIMMY_WORKBENCH_CHAT;
  delete base.TIMMY_CHAT_MODEL;
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: timmyHome, TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`,
  };
  blankHome();
}, 60_000);

afterAll(async () => {
  for (const label of ['wbFirstUse122', 'wbFirstUse80']) { try { execFileSync('tmux', ['-L', label, 'kill-server'], { env, stdio: 'ignore' }); } catch { /* none */ } }
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  for (let i = 0; ; i++) {
    try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 50) throw e;
      await sleep(200);
    }
  }
}, 30_000);

/**
 * A blank home: no identity, no setup record, no settings, an empty project folder and store (no conversation from an
 * earlier journey); only the FAKE Ollama's address, as providers.json holds one.
 */
function blankHome(): void {
  for (const d of [home, join(box, 'settings')]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
  for (const d of [repo, timmyHome]) mkdirSync(d, { recursive: true });
  writeFileSync(join(timmyHome, 'providers.json'), JSON.stringify({ ollama_host: `http://127.0.0.1:${port}` }), { mode: 0o600 });
  expect(existsSync(join(timmyHome, 'identity.json'))).toBe(false);
  expect(existsSync(join(timmyHome, 'setup.json'))).toBe(false);
}

/** A tmux server of the test's own at the size given, the Workbench started in it as the installed command starts. */
function terminal(label: string, width: number, height: number) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  const pane: Pane = { tmux, target: 't', folders: [box] };
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', String(width), '-y', String(height), '-c', repo, 'bash', '--norc', '-c',
    `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
  const until = (re: RegExp, what: string, ms = 30_000, test?: (s: string) => boolean): Promise<string> => waitScreen(pane, { what, re, ms, foot: 'drawn', ...(test ? { test } : {}) });
  const keys = (...k: string[]): Promise<void> => sendKeys(pane, k);
  const type = (text: string): Promise<void> => sendKeys(pane, [text], { literal: true });
  const keep = (name: string): string => keepScreen(pane, CAPTURES, `${label}-${name}`, { foot: 'drawn' });
  const stop = (): void => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { pane, until, keys, type, keep, stop, read: () => readPane(pane).text };
}

/** Drives the journey at one size; the assertions in the order the operator meets them. */
async function journey(label: string, width: number, height: number): Promise<void> {
  asked.length = 0;
  const t = terminal(label, width, height);
  try {
    // 1. the first run's question, the cursor on the first choice; no composer yet, nothing asked of a shell
    const first = await t.until(/How would you like to run chat\?/, 'the first run\'s question', 60_000);
    t.keep('01-first-run');
    expect(first).toMatch(/> \[ OpenRouter \/ cloud \]/);
    expect(existsSync(join(timmyHome, 'identity.json'))).toBe(false);
    // 2. Down, Enter on Ollama / this computer: Models has the keyboard and lists what the FAKE lists, checked by /api/show
    await t.keys('Down');
    await t.until(/> \[ Ollama \/ this computer \]/, 'the cursor on Ollama / this computer');
    await t.keys('Enter');
    const listed = await t.until(new RegExp(`INSTALLED \\/ read \\d\\d:\\d\\d[\\s\\S]*${M}`), 'Models listing the FAKE\'s model', 40_000);
    t.keep('02-models-listed');
    expect(asked.map((a) => a.what)).toContain('GET /api/tags');
    expect(asked.filter((a) => a.what === `POST /api/show ${MODEL}`).length).toBeGreaterThan(0);
    // its facts as Ollama lists them, under its name; the chip says no model (nothing chosen yet)
    expect(listed.replace(/\s+/g, ' ')).toMatch(/8\.8B · Q4_K_M · 5\.3 GB/);
    expect(listed, 'the chip before the choice').toMatch(CHIP_NONE);
    // 3. a draft typed BEFORE the choice: Tab cycles the keyboard to the center (its cursor "> [" shows which pane has it),
    // where the no-model view offers Write a draft; the draft typed, Esc keeps it; M returns to Models with its state kept
    // (Esc first: "Esc anywhere earlier: Models keeps its state"; at 80x24 the drawer closes over the center)
    await t.keys('Escape');
    let center = await waitScreen(t.pane, { what: 'the screen after Esc from Models', ms: 10_000, foot: 'drawn' });
    if (process.env.H172_EXPLORE) t.keep('03-esc');
    for (let i = 0; i < 6 && !CENTER_CURSOR.test(center); i++) {
      await t.keys('Tab');
      center = await waitScreen(t.pane, { what: `the screen after Tab ${i + 1}`, ms: 10_000, foot: 'drawn' });
      if (process.env.H172_EXPLORE) t.keep(`03-tab-${i + 1}`);
    }
    expect(center, 'the keyboard in the center (its cursor on one of the no-model choices)').toMatch(CENTER_CURSOR);
    t.keep('03-center-focused');
    expect(center).toMatch(/\[ Write a draft \]/);
    for (let i = 0; i < 6 && !/> \[ Write a draft \]/.test(t.read()); i++) await t.keys('Down');
    await t.until(/> \[ Write a draft \]/, 'the cursor on Write a draft', 10_000);
    await t.keys('Enter');
    // (Enter on Write a draft gives the composer the keyboard: the draft typed next lands on its "› " row)
    await t.type(DRAFT);
    await t.until(new RegExp(`› *${DRAFT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the draft typed in the composer', 10_000);
    t.keep('04-draft-typed');
    await t.keys('Escape');
    await t.keys('M');
    await t.until(/INSTALLED \/ read \d\d:\d\d/, 'Models again, with the keyboard', 20_000);
    // 4. Down to the row, Enter: the chip "● granite4.2:latest · this computer · checking…" (amber) and the row's "checking
    // with Ollama…" are on screen while the FAKE still holds its /api/show answer
    const before = asked.filter((a) => a.what === `POST /api/show ${MODEL}`).length;
    for (let i = 0; i < 6 && !new RegExp(`> ${M}`).test(t.read()); i++) await t.keys('Down');
    await t.until(new RegExp(`> ${M}`), 'the cursor on the model\'s row', 10_000);
    t.keep('05-cursor-on-granite');
    await t.keys('Enter');
    const checking = await waitScreen(t.pane, { what: 'the chip checking', re: CHIP_CHECKING, ms: 5_000, foot: 'drawn' });
    t.keep('06-checking');
    const show = asked.filter((a) => a.what === `POST /api/show ${MODEL}`).slice(before);
    expect(show.length, 'the choice asked /api/show once').toBe(1);
    expect(show[0].answered, 'the chip said checking before the FAKE answered').toBe(0);
    expect(checking).toMatch(/checking with Ollama…/);
    expect(checking).not.toMatch(/Next turn:/);
    expect(checking).not.toMatch(CHIP_READY);
    // 5. ready: the selector closed, the status row's words, the composer with the keyboard and the draft, identity set up
    // (the status row is a six-second flash through inWords, which says a path as "its folder", cut with an ellipsis to the
    // row's room: its first sentence is asserted at every width; "Set up now" where the row carries those words (122x37),
    // the whole sentence where it is whole; where "Set up now" is cut off (80x24) it is said as skipped with the row's exact
    // words, not passed)
    const ready = await t.until(new RegExp(`Next turn: ${M} on this computer\\.`), 'the status row: next turn', 20_000);
    t.keep('07-ready');
    const statusRow = ready.split('\n').find((r) => r.includes('Next turn:')) ?? '';
    const setUpNow = new RegExp(`Next turn: ${M} on this computer\\. Set up now \\(identity made in (?:~/timmy|its folder)\\)\\.`);
    if (setUpNow.test(statusRow)) expect(statusRow).toMatch(setUpNow);
    else if (/Set up now/.test(statusRow)) {
      expect(statusRow).toMatch(new RegExp(`Next turn: ${M} on this computer\\. Set up now`));
      console.log(`NOTE: "Set up now" is in the status row at ${width}x${height}, its sentence cut to the row's room; the row reads: ${statusRow.trim()}`);
    } else console.log(`SKIPPED (not a pass): "Set up now" is not in the status row at ${width}x${height}; the row reads: ${statusRow.trim()}`);
    expect(show[0].answered, 'ready only after the FAKE answered').toBeGreaterThan(0);
    expect(ready).not.toMatch(/checking with Ollama/);
    expect(ready).not.toMatch(CHIP_CHECKING);
    expect(ready).toContain(DRAFT);
    // the chip: green "ready HH:MM" at both widths, the minute the check was made (the FAKE's own clock of the request; the
    // check starts a moment before the request lands, so the minute before it counts across a minute's edge)
    const chipRow = await t.until(CHIP_READY, 'the chip ready', 10_000);
    const chipAt = CHIP_READY.exec(chipRow)?.[1];
    expect([hhmm(show[0].at - 2000), hhmm(show[0].at), hhmm(show[0].answered)], `the chip's time ${chipAt}`).toContain(chipAt);
    expect(existsSync(join(timmyHome, 'identity.json')), 'the choice set the identity up (no shell)').toBe(true);
    const setup = JSON.parse(readFileSync(join(timmyHome, 'setup.json'), 'utf8')) as { by?: string; answers: Record<string, unknown> };
    expect(setup.by).toBe('timmy workbench');
    expect(setup.answers).toMatchObject({ chat: 'local', model: MODEL });
    // the composer has the keyboard right after the choice: typed text lands in it, after the draft
    await t.type(MESSAGE);
    const typed = await t.until(new RegExp(`${DRAFT}${MESSAGE}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the typed text landing in the composer after the draft', 10_000);
    t.keep('08-message-typed');
    // (the chip stays ready while the message is typed)
    expect(typed).toMatch(CHIP_READY);
    // 6. Enter sends; the FAKE answers; the answer and its evidence line are drawn
    await t.keys('Enter');
    // (the answer wraps at the column's edge where it is narrow: read as the chat column's text)
    const answered = await t.until(new RegExp(`TIMMY / ${M} / \\d\\d:\\d\\d`), 'the FAKE answer drawn under the model\'s header', 40_000, (s) => answerColumn(s, MODEL).includes(FAKE_ANSWER));
    expect(asked.filter((a) => a.what === `POST /api/chat ${MODEL}`).length).toBe(1);
    // its evidence line under the answer: answered, sent to a model, no charge, local, the model, the receipt sealed
    const evidence = await t.until(/receipt sealed/, 'the answer\'s evidence line', 30_000);
    t.keep('09-answered');
    expect(answerColumn(evidence, MODEL)).toMatch(new RegExp(`answered · sent to a model · no charge · local · ${M} · receipt sealed`));
    expect(answered).not.toMatch(/EXIT=/);
    // nothing opened a browser; nothing asked Ollama's own 11434 (the FAKE heard everything)
    expect(existsSync(join(box, 'opened.log'))).toBe(false);
  } finally {
    t.stop();
  }
}

describe('the operator\'s first-use journey, from a blank home (tmux; R11 H172 item 2; FAKE Ollama listing exactly granite4.2:latest)', { timeout: 300_000 }, () => {
  it('at 122x37: Ollama / this computer → granite4.2:latest → Enter: checking, then ready; the composer has the keyboard with the draft; the status row says the next turn and that the home was set up; Enter sends and the FAKE answers with its evidence line', async () => {
    await journey('wbFirstUse122', 122, 37);
  });
  it('at 80x24 (the Models drawer): the same journey', async () => {
    blankHome();
    await journey('wbFirstUse80', 80, 24);
  });
});
