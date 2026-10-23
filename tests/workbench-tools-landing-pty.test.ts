// R11 phase 2 (H167): the Tools & integrations screen in a real terminal (tmux), at 122x37 and 80x24, reached from the Chat
// screen through the finder (/ integrations Enter): the honest inventory of what this installation has, in three words
// (available / configured / exercised) and no fourth, nothing run to make the list.
//
// Two homes, each said where it is made:
// - a blank home: timmy init with no chat answer (no key, no model), a tray project; nothing is set, nothing was run;
// - a FAKE-populated home: the local route on a FAKE Ollama with FAKE fake-qwen3:8b chosen (the model is named FAKE in the
//   home's own words), and the review package's FAKE lane stand-ins (scripts/review/fake-lanes: shell scripts that only log,
//   so no real lane program can start) on PATH, as the review box's home has them.
// FAKE here: the Ollama is an HTTP server in this test's process with no model behind it (GET /api/tags lists FAKE names, POST
// /api/show answers for them); the openers on PATH only log. Everything else is the real program, started as the installed
// command starts it (src/cli.ts through tsx's loader), over a sandbox of its own. The screens are kept as .ansi and .txt in
// <tmpdir>/timmy-workbench-captures/r11-tools-landing, or in TIMMY_WB_CAPTURES.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const FAKE_LANES = resolve('scripts/review/fake-lanes');
const CAPTURES = process.env.TIMMY_WB_CAPTURES ? resolve(process.env.TIMMY_WB_CAPTURES) : join(tmpdir(), 'timmy-workbench-captures', 'r11-tools-landing');
const LABEL = 'wbToolsLanding';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** the cells `from` to `to` (inclusive) of a row, trailing blanks dropped */
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();
const CHIP = /^(available|configured|exercised)$/;
/** the inventory's capability rows of a screen: "  <name> <chip?> <found>" under a group heading, by the name column's shape */
const HEAD = /^TOOLS & INTEGRATIONS · what this installation has$/;

let box = '';
let repo = '';
let env: NodeJS.ProcessEnv = {};
let lanesBin = '';
let server: Server | undefined;
let port = 0;
const asked: string[] = [];
const FAKE_MODELS = [
  { name: 'fake-qwen3:8b', model: 'fake-qwen3:8b', size: 5_200_000_000, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
];
const FAKE_SHOW: Record<string, { details: { format: string }; capabilities: string[] }> = {
  'fake-qwen3:8b': { details: { format: 'gguf' }, capabilities: ['completion', 'tools'] },
};

const cli = (args: string[], e = env, timeout = 60_000) => runAsync(process.execPath, ['--import', LOADER, CLI, ...args], { cwd: repo, env: e, timeout });

/** `timmy workbench` in a tmux session of this test's own server at `w` x `h`; its first settled frame that shows `re`. */
async function launch(session: string, w: number, h: number, e: NodeJS.ProcessEnv, re: RegExp, what: string): Promise<{ screen: string; pane: Pane }> {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', LABEL, ...args], { env: e, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', String(w), '-y', String(h), '-c', repo, 'bash', '--norc', '-c',
    `${process.execPath} --import ${LOADER} ${CLI} workbench; echo EXIT=$?; sleep 600`);
  const pane: Pane = { tmux, target: session, folders: [box] };
  const screen = await waitScreen(pane, { what, re, ms: 60_000 });
  return { screen, pane };
}

function stop(session: string): void {
  try { execFileSync('tmux', ['-L', LABEL, 'kill-session', '-t', session], { env, stdio: 'ignore' }); } catch { /* gone */ }
}

/** From the Chat screen, the finder to the Tools & integrations screen; its settled frame with the inventory's header. */
async function toTools(pane: Pane, w: number): Promise<string> {
  await sendKeys(pane, ['/']);
  await waitScreen(pane, { what: 'the finder', re: /Find a workspace/, ms: 20_000 });
  await sendKeys(pane, ['integrations'], { literal: true });
  await sendKeys(pane, ['Enter']);
  // (the capabilities are read after the page opens: the header first, then the groups once the reading is in)
  return waitScreen(pane, { what: `the Tools & integrations screen at ${w} columns`, re: /TOOLS & INTEGRATIONS · what this installation has[\s\S]*CHAT · \d+ capabilit/, ms: 60_000 });
}

/** The rows of the inventory under the groups: each row's chip cell and the row itself (the body's cells, at its width). */
function inventoryRows(screen: string, w: number): Array<{ row: string; chip: string }> {
  const bodyFrom = 2;
  const nameW = w >= 110 + 4 ? 26 : 20;
  const chipAt = bodyFrom + 2 + nameW + 2;
  const out: Array<{ row: string; chip: string }> = [];
  // (a screen scrolled past the header is in the groups already)
  let inGroups = !screen.includes('TOOLS & INTEGRATIONS');
  for (const r of screen.split('\n')) {
    const row = cols(r, bodyFrom, w - 3);
    if (/^(CHAT|WORK|CREATE|CONNECT) · \d+ capabilit/.test(row)) { inGroups = true; continue; }
    // (the project's MCP calls come after the capabilities: not the inventory's rows; the list's panel ends at its bottom
    // border, and the Activity drawer under it is not a row either)
    if (/^MCP CALLS/.test(row) || (out.length > 0 && (/^[┗╰]/.test(r) || /Activity & log/.test(r)))) break;
    if (!inGroups || !/^[▸ ] \S/.test(row)) continue;
    out.push({ row, chip: cols(r, chipAt, chipAt + 9).trim() });
  }
  return out;
}

beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), 'wb-tools-landing-'));
  const home = join(box, 'home');
  repo = join(home, 'work');
  const bin = join(box, 'fakebin');
  lanesBin = join(box, 'fakelanes');
  for (const d of [home, repo, bin, lanesBin, join(box, 'tmp'), join(box, 'settings'), CAPTURES]) mkdirSync(d, { recursive: true });
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${box}/opened.log'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // FAKE lanes: the review package's stand-ins, copied beside this sandbox (they log to FAKE_LANES_LOG and run nothing)
  for (const name of readdirSync(FAKE_LANES)) { copyFileSync(join(FAKE_LANES, name), join(lanesBin, name)); chmodSync(join(lanesBin, name), 0o755); }
  // FAKE: the Ollama, on 127.0.0.1 at a port the system gives this test (never Ollama's own 11434)
  server = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: FAKE_MODELS })); return; }
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
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'FAKE Ollama: only /api/tags and /api/show are answered here' }));
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
  for (const k of Object.keys(base)) if (/_API_KEY$|_SECRET_KEY$|_API_URL$|^TIMMY_EDGE_HOST$|^AGENTPASS_REPO_PATH$/.test(k)) delete base[k];
  env = {
    ...base, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(home, '.timmy-store'),
    TIMMY_SETTINGS_DIR: join(box, 'settings'), TMPDIR: join(box, 'tmp'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor',
    TMUX: '', TMUX_TMPDIR: box, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_LANES_LOG: join(box, 'fake-lanes.log'),
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

describe('the Tools & integrations screen in a terminal (tmux; R11 phase 2, H167)', { timeout: 240_000 }, () => {
  it('a blank home (no key, no model) at 122x37 and 80x24: the header, the honesty row, the groups; no row exercised, no fourth word, no command', async () => {
    for (const [w, h] of [[122, 37], [80, 24]] as const) {
      const session = `blank${w}`;
      const { pane } = await launch(session, w, h, env, /How would you like to run chat\?/, `the first run's question at ${w}x${h}`);
      const screen = await toTools(pane, w);
      keepScreen(pane, CAPTURES, `tools-landing-${w}x${h}-01-blank-home`, { foot: 'drawn' });
      const rows = screen.split('\n');
      const body = rows.map((r) => cols(r, 2, w - 3));
      expect(body.some((r) => HEAD.test(r)), 'the header').toBe(true);
      expect(body.some((r) => /^nothing here was run to make this list · \d+ tools · checked \d+ (s|min) ago( · \[r\] checks again)?$/.test(r)), 'the honesty row').toBe(true);
      // the tabbed page's own title and the finder's way stay (existing names)
      expect(screen).toMatch(/All tools · capabilities/);
      const inv = inventoryRows(screen, w);
      expect(inv.length).toBeGreaterThanOrEqual(w === 80 ? 2 : 4);
      for (const { row, chip } of inv) expect(chip === '' || CHIP.test(chip), `${w}: "${row}"`).toBe(true);
      // nothing was run: no exercised chip, no receipt id; nothing green but what is exercised (so nothing)
      expect(inv.every((x) => x.chip !== 'exercised')).toBe(true);
      expect(screen).not.toMatch(/receipt [0-9a-f]{8}/);
      // no command, no address on the screen (the details hold them)
      expect(screen).not.toMatch(/brew install|npm install|127\.0\.0\.1|ollama pull|\bset [A-Z][A-Z0-9_]+\b|\bexport [^=\n]{1,40}=/);
      // OpenRouter (the inventory's first row): built in, so available; no key, so its next step names Models & accounts
      const or = inv.find((x) => /^[▸ ] OpenRouter/.test(x.row));
      expect(or?.chip, or?.row).toBe('available');
      expect(or?.row).toMatch(/Models & accounts/);
      // Ollama on this computer: the FAKE Ollama answers over HTTP, but no ollama program is here and no model is chosen: no chip
      const ol = inv.find((x) => /^[▸ ] Ollama \(this/.test(x.row));
      expect(ol?.chip, ol?.row).toBe('');
      // Enter on the selected row: its details in the right pane (the Inspector), with the state's meaning and the three facts
      await sendKeys(pane, ['Enter']);
      // (at 80x24 the drawer holds the state, what was found and the step; the rung's evidence is read on with ↓)
      const detail = await waitScreen(pane, { what: 'the details drawer', re: w === 80 ? /CAPABILITY[\s\S]*State +(?:available|configured|exercised|–)/ : /CAPABILITY[\s\S]*State +(?:available|configured|exercised|–)[\s\S]*Available +yes/, ms: 20_000 });
      keepScreen(pane, CAPTURES, `tools-landing-${w}x${h}-02-details`, { foot: 'drawn' });
      expect(detail).toMatch(/Esc closes/);
      await sendKeys(pane, ['Escape']);
      await waitScreen(pane, { what: 'the drawer closed', re: /TOOLS & INTEGRATIONS/, test: (s) => !/CAPABILITY/.test(s), ms: 20_000 });
      stop(session);
    }
    // the FAKE Ollama was only ever asked what it lists and each model's facts (the chat's own listing): never a model run
    expect(asked.every((a) => a === 'GET /api/tags' || a === 'POST /api/show')).toBe(true);
  });

  it('the FAKE-populated home (the local route with FAKE fake-qwen3:8b; the review\'s FAKE lanes on PATH) at 122x37 and 80x24: configured and available rows, still nothing exercised', async () => {
    const host = `127.0.0.1:${port}`;
    const set = await cli(['init', '--yes', '--chat', 'local', '--ollama', host, '--model', 'fake-qwen3:8b']);
    expect(set.status, `${set.stdout}\n${set.stderr}`).toBe(0);
    const populated: NodeJS.ProcessEnv = { ...env, PATH: `${lanesBin}:${env.PATH ?? ''}` };
    for (const [w, h] of [[122, 37], [80, 24]] as const) {
      const session = `fake${w}`;
      const { pane } = await launch(session, w, h, populated, /CHAT \/ tray1[\s\S]*› Message TIMMY…/, `the Chat screen with the composer at ${w}x${h}`);
      const screen = await toTools(pane, w);
      keepScreen(pane, CAPTURES, `tools-landing-${w}x${h}-03-FAKE-populated-home`, { foot: 'drawn' });
      const inv = inventoryRows(screen, w);
      expect(inv.length).toBeGreaterThanOrEqual(w === 80 ? 2 : 4);
      for (const { row, chip } of inv) expect(chip === '' || CHIP.test(chip), `${w}: "${row}"`).toBe(true);
      // Ollama on this computer: the chat is set to the FAKE local model at the FAKE address: configured (no ollama program
      // is here, so not available: the inventory keeps the words apart); the model named on its row, the address not
      const ol = inv.find((x) => /^[▸ ] Ollama \(this/.test(x.row));
      expect(ol?.chip, ol?.row).toBe('configured');
      // (at 80 columns the found words are cut by words: the FAKE marker stays, the name is the details')
      expect(ol?.row).toMatch(w === 80 ? /local FAKE/ : /local FAKE fake-qwen3:8b/);
      // nothing ran: no exercised chip, no receipt id anywhere
      expect(inv.every((x) => x.chip !== 'exercised')).toBe(true);
      expect(screen).not.toMatch(/receipt [0-9a-f]{8}/);
      expect(screen).not.toMatch(/brew install|npm install|127\.0\.0\.1|ollama pull|\bexport [^=\n]{1,40}=/);
      // End: the list scrolls to its last capability (the keyboard is on the list): CHAT's rows are above the view now; the
      // chip whole on every row shown
      await sendKeys(pane, ['End']);
      const end = await waitScreen(pane, { what: 'the end of the inventory', re: /TOOLS & INTEGRATIONS|All tools · capabilities/, test: (s) => !/CHAT · \d+ capabilit/.test(s) && inventoryRows(s, w).length >= 2, ms: 20_000 });
      keepScreen(pane, CAPTURES, `tools-landing-${w}x${h}-04-FAKE-populated-end`, { foot: 'drawn' });
      const tail = inventoryRows(end, w);
      for (const { row, chip } of tail) expect(chip === '' || CHIP.test(chip), `${w}: "${row}"`).toBe(true);
      expect(tail.every((x) => x.chip !== 'exercised')).toBe(true);
      // the tab's own search (/ from the list) keeps the lanes (their group): the FAKE stand-ins on PATH are available, or
      // configured where no key is needed (the inventory's own reading), never exercised: nothing of theirs ran (the FAKE
      // lanes' log stays unwritten)
      await sendKeys(pane, ['/']);
      await waitScreen(pane, { what: 'the tools search', re: /Search: /, ms: 20_000 });
      await sendKeys(pane, ['lanes']);
      const found = await waitScreen(pane, { what: 'the lanes rows', re: /\d+ tools? match(?:es)? "lanes"[\s\S]*CONNECT · \d+ capabilit/, ms: 20_000 });
      keepScreen(pane, CAPTURES, `tools-landing-${w}x${h}-05-FAKE-populated-search-lanes`, { foot: 'drawn' });
      const lanes = inventoryRows(found, w);
      expect(lanes.length).toBeGreaterThanOrEqual(2);
      for (const { row, chip } of lanes) expect(chip === '' || chip === 'available' || chip === 'configured', `${w}: "${row}"`).toBe(true);
      expect(lanes.some((x) => x.chip === 'available' || x.chip === 'configured')).toBe(true);
      expect(found).not.toMatch(/receipt [0-9a-f]{8}|brew install|npm install|127\.0\.0\.1/);
      stop(session);
    }
    expect(asked.every((a) => a === 'GET /api/tags' || a === 'POST /api/show')).toBe(true);
    // (the FAKE lanes were found on PATH, never run: their log was never written)
    expect(existsSync(join(box, 'fake-lanes.log'))).toBe(false);
  });
});
