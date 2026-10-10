// Round R4, review M4: the cockpit's browser lane (Agent.addBrowserPane, src/agent/core.ts) types a command into a
// pane's shell. A link pasted there (the live board's, with its token) must not reach that text: it is what tmux
// send-keys carries as an argument, what the pane's shell keeps in its history, and what the lane's log and name
// show. carbonyl is a FAKE (tests/fixtures/fake-web.mjs) first on the PATH; the board is a real LiveBoard on
// 127.0.0.1; the shell is a real sh, and a real interactive bash in a tmux server of the test's own (tmux -S) when
// tmux is installed.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveBoard } from '../src/repl/board-live.js';
import { dropLaunchPages } from '../src/utils/launch-page.js';

const FAKE_WEB = resolve('tests/fixtures/fake-web.mjs');
const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const parts = (token: string, n: number): string[] => Array.from({ length: token.length - n + 1 }, (_, i) => token.slice(i, i + n));
const holds = (s: string, token: string, n = 8): boolean => parts(token, n).some((p) => s.includes(p));

let cwd = '';
let board: LiveBoard;
beforeEach(async () => {
  cwd = process.cwd();
  // The agent's logger writes logs/ in the folder it runs in: a temporary one here.
  process.chdir(temp('timmy-pane-cwd-'));
  board = new LiveBoard({ state: () => ({ project: 'pane-test', madeAt: 'now', toc: '', html: '', shape: 's', jobs: [], workflows: [], files: [] }), execute: async () => [] });
  await board.start();
});
afterEach(async () => {
  // Pages the lane wrote in this process (the cockpit's lane keeps one for a minute at most).
  dropLaunchPages(board.url);
  await board.close();
  process.chdir(cwd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeCarbonyl(): { bin: string; log: string } {
  const bin = join(temp('timmy-fake-bin-'), 'bin');
  mkdirSync(bin);
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(join(bin, 'carbonyl'), `#!/bin/sh\n# FAKE carbonyl (tests/fixtures/fake-web.mjs)\nexec ${q(process.execPath)} ${q(FAKE_WEB)} carbonyl "$@"\n`);
  chmodSync(join(bin, 'carbonyl'), 0o755);
  return { bin, log: join(temp('timmy-fake-log-'), 'web.jsonl') };
}
type Rec = { role: string; argv?: string[]; done?: boolean; page?: number; state?: number; project?: string; fileMode?: number; dirMode?: number };
const records = (log: string): Rec[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);

/** The real Agent (no multiplexer of its own); the lane manager is replaced by one that records what it is given. */
async function agentWithLanes() {
  const { createAgent } = await import('../src/agent/core.js');
  const agent = createAgent({ apiKey: 'test-key', model: 'test/model' }, { multiplexer: 'none' });
  const typed: string[] = [];
  (agent as unknown as { tmuxMgr: unknown }).tmuxMgr = {
    init() {}, spawnSession() {}, killSession() {}, getCwd: () => process.cwd(), capturePane: () => [], poll() {}, destroy() {},
    sendCommand: async (_id: string, command: string) => { typed.push(command); },
  };
  return { agent, typed };
}

describe('the browser lane keeps a link\'s token out of what it types, names and logs (review M4)', () => {
  it('types carbonyl on a private launch page; the lane\'s name and log show the address without its secret', async () => {
    const token = board.token;
    const { agent, typed } = await agentWithLanes();
    agent.addBrowserPane(board.url);
    expect(typed).toHaveLength(1);
    expect(holds(typed[0], token)).toBe(false);
    expect(typed[0]).toMatch(/carbonyl 'file:\/\/[^']*\/open\.html'/);
    const lane = agent.tmuxSessions.at(-1)!;
    expect(lane.name).toBe(`Browser: ${board.address}#…`);
    const log = existsSync('logs/timmy-tui.log') ? readFileSync('logs/timmy-tui.log', 'utf8') : '';
    expect(log).toContain('[browser.spawned]');
    expect(holds(log, token)).toBe(false);

    // The text, run by a real sh, starts carbonyl on the page, which opens the board; the board lets it in. (Not
    // spawnSync: the board answers from this process, so its event loop must keep running.)
    const { bin, log: web } = fakeCarbonyl();
    const status = await new Promise<number | null>((done) => {
      const child = spawn('sh', ['-c', typed[0]], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_WEB_LOG: web }, stdio: 'ignore' });
      child.on('exit', (code) => done(code));
      child.on('error', () => done(null));
    });
    expect(status).toBe(0);
    const recs = records(web);
    expect(recs.find((x) => !x.done)!.argv!.every((a) => !holds(a, token))).toBe(true);
    expect(recs.find((x) => x.done)).toMatchObject({ page: 200, state: 200, project: 'pane-test', fileMode: 0o600, dirMode: 0o700 });
  }, 60_000);

  it('a plain address is typed as itself, quoted so the shell reads it as one word', async () => {
    const { agent, typed } = await agentWithLanes();
    agent.addBrowserPane("http://127.0.0.1:4336/a b'c$(id)");
    expect(typed[0]).toContain(`carbonyl 'http://127.0.0.1:4336/a b'\\''c$(id)'`);
    expect(agent.tmuxSessions.at(-1)!.name).toBe("Browser: http://127.0.0.1:4336/a b'c$(id)");
  });

  it.skipIf(!hasTmux || !hasBash)('typed into a real interactive bash in a tmux of its own, the token is in neither the shell\'s history nor send-keys\' arguments', async () => {
    const token = board.token;
    const { agent, typed } = await agentWithLanes();
    agent.addBrowserPane(board.url);
    const { bin, log: web } = fakeCarbonyl();
    const box = temp('timmy-tmux-');
    const sock = join(box, 'sock');
    const hist = join(box, 'history');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_WEB_LOG: web, HISTFILE: hist, TMUX_TMPDIR: box };
    delete (env as Record<string, string | undefined>).TMUX;
    const tmux = (...a: string[]) => spawnSync('tmux', ['-S', sock, ...a], { env, encoding: 'utf8', timeout: 15_000 });
    try {
      expect(tmux('new-session', '-d', '-s', 'lane', '-x', '200', '-y', '50', 'bash --norc --noprofile -i').status).toBe(0);
      await sleep(300);
      // As the lane manager sends a command: send-keys with the text as one argument, then Enter.
      const sendKeys = ['send-keys', '-t', 'lane', typed[0], 'C-m'];
      expect(sendKeys.some((a) => holds(a, token))).toBe(false);
      expect(tmux(...sendKeys).status).toBe(0);
      for (let i = 0; i < 200 && !records(web).some((x) => x.done); i++) await sleep(100);
      expect(records(web).find((x) => x.done)).toMatchObject({ page: 200, state: 200 });
      tmux('send-keys', '-t', 'lane', 'history -a', 'C-m');
      for (let i = 0; i < 50 && !(existsSync(hist) && readFileSync(hist, 'utf8').includes('carbonyl')); i++) await sleep(100);
      const history = readFileSync(hist, 'utf8');
      expect(history).toContain('carbonyl');
      expect(holds(history, token)).toBe(false);
    } finally {
      tmux('kill-server');
    }
  }, 60_000);
});
