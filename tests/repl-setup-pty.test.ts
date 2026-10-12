// R4 (H98): the REPL and the one guided setup, end to end in a real terminal (tmux), each run in a temporary Timmy home.
// The header names the chat route in effect ("chat: no model key · /setup"); the first screen shows Timmy's three surfaces in
// one line and, on a home without setup, that /setup runs the guided setup; /setup asks timmy init's questions right here
// (the same words and files, setup.json recorded as set up by the REPL), then seals the setup check (C-14). Ctrl+C stops it
// with nothing written and the REPL stays; /setup key asks for an OpenRouter key, hidden as it is typed (the key is made at
// run time, and no message is sent: nothing here calls a model). Without a terminal, /setup says the exact command.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLI_MS = 50_000;
const TMUX_MS = 10_000;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'repl-setup-'));
  const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night' };
  return { dir, env, home: join(dir, 'timmy') };
}

/** A REPL in a tmux terminal (100 x 40) of its own; `screen()` includes what scrolled away. */
function terminal(dir: string, env: NodeJS.ProcessEnv, label: string) {
  const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', label, ...args], { env: tenv, encoding: 'utf8', timeout: TMUX_MS });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', dir, 'bash', '--norc', '-c', `S0=$(stty -g); ${TSX} ${CLI} repl; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`);
  const screen = () => tmux('capture-pane', '-p', '-J', '-S', '-400', '-t', 't');
  const waitFor = async (re: RegExp, count = 1): Promise<string> => {
    for (let i = 0; i < 900; i++) {
      const s = screen();
      if ((s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length >= count) return s;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${re} (x${count}):\n${screen()}`);
  };
  const type = (text: string) => { if (text) tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  const key = (k: string) => tmux('send-keys', '-t', 't', k);
  const close = () => { try { tmux('kill-server'); } catch { /* gone */ } };
  return { screen, waitFor, type, key, close };
}

/** The receipts sealed so far (runs.jsonl also carries the bus's events; receipts are the lines with a prev_hash). */
const receipts = (store: string): Array<{ kind: string; discrepancies?: string[] }> => {
  const file = join(store, 'runs.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string');
};

describe('the REPL and the guided setup (R4 H98)', () => {
  it('a home without setup: the header names the chat route, the first screen the three surfaces and /setup, which asks here and seals the check', async () => {
    const { dir, env, home } = sandbox();
    const t = terminal(dir, env, 'setup');
    try {
      const first = await t.waitFor(/Enter to send/);
      expect(first).toMatch(/^TIMMY {2}chat: no model key · \/setup$/m);
      expect(first).toMatch(/^Studio \/studio · Control Room \/room · God's Eye View \/overview$/m);
      expect(first).toMatch(/^all three in your browser: \/board live$/m);
      expect(first).toMatch(/^First run: type \/setup for the guided setup \(as timmy init\)\.$/m);
      t.type('/setup');
      // timmy init's questions, asked here; each with its preselected answer in brackets
      expect(await t.waitFor(/Operator name \(your receipts show it\)\n {2}> \[operator\]/)).toContain('TIMMY · first run — guided setup (/setup in the REPL)');
      t.type('Sample');
      await t.waitFor(/Identity: g makes a new key/);
      t.type('');
      await t.waitFor(/Ollama host \(the local model\)/);
      t.type('');
      const chat = await t.waitFor(/Chat model/);
      expect(chat).toMatch(/l {2}local model only/);
      expect(chat).toMatch(/o {2}OpenRouter: a paid cloud service/);
      t.type('');
      await t.waitFor(/Logs and run events/);
      t.type('');
      await t.waitFor(/First project name/);
      t.type('demo');
      await t.waitFor(/Proceed\? \[Y\/n\]/);
      t.type('');
      const done = await t.waitFor(/RECEIPT [0-9a-f]{8}\s+setup check sealed and verified[\s\S]*Enter to send/);
      expect(done).toMatch(/✓ Set up: operator Sample · chat: local model only/);
      expect(done).toContain('Back in the REPL.');
      expect(done).toMatch(/identity\s+Sample/);
      expect(done).toMatch(/model key\s+none · \/setup key or OPENROUTER_API_KEY/);
      // written once, in the Timmy home, as timmy init writes it
      const setup = JSON.parse(readFileSync(join(home, 'setup.json'), 'utf8'));
      expect(setup.by).toBe('the REPL (/setup)');
      expect(setup.answers).toMatchObject({ operator: 'Sample', chat: 'local', logs: 'local', project: 'demo' });
      expect(JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8')).operator).toBe('Sample');
      expect(statSync(join(home, 'identity.seed')).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'setup.json')).mode & 0o777).toBe(0o600);
      expect(receipts(join(dir, 'store')).map((r) => [r.kind, r.discrepancies])).toEqual([['check', ['model key']]]);
      // a message without a key says how to add one
      t.type('hello');
      expect(await t.waitFor(/no model key, so Timmy cannot answer[\s\S]*Enter to send/)).toContain('Try: /setup key, or export OPENROUTER_API_KEY');
      // nothing left to ask: /setup is the check again; /help starts with the three surfaces
      t.type('/setup');
      const again = await t.waitFor(/setup check sealed and verified/, 2);
      expect(again.slice(again.lastIndexOf('setup check sealed and verified'))).toMatch(/^setup check sealed and verified\n {2}Set up: operator Sample · chat: local model only \(Ollama\s+at 127\.0\.0\.1:11434; no key\) · logs: this computer only ·\s+project demo\./);
      expect(again.split('TIMMY · first run — guided setup')).toHaveLength(2);
      expect(receipts(join(dir, 'store'))).toHaveLength(2);
      t.type('/help');
      const help = await t.waitFor(/\/exit {8}Quit Timmy/);
      expect(help).toMatch(/^ {2}Studio \/studio · Control Room \/room\n {2}God's Eye View \/overview\n {2}all three in your browser: \/board live\n {2}WORK$/m);
      expect(help).toMatch(/\/studio {6}Timmy Studio: opens it, as \/canvas open/);
      t.type('/exit');
      // the terminal check prints after EXIT=: wait for its own line, not for EXIT= (a race under load)
      const end = await t.waitFor(/TTY=(?:same|changed)/);
      expect(end).toMatch(/EXIT=0/);
      expect(end).toContain('TTY=same');
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('Ctrl+C stops the setup: nothing is written, no check is sealed, and the REPL stays', async () => {
    const { dir, env, home } = sandbox();
    const t = terminal(dir, env, 'stop');
    try {
      await t.waitFor(/Enter to send/);
      t.type('/setup');
      await t.waitFor(/Operator name/);
      t.type('Sample');
      await t.waitFor(/Identity: g makes a new key/);
      t.key('C-c');
      const back = await t.waitFor(/Back in the REPL; \/setup asks again\.[\s\S]*Enter to send/);
      expect(back).toContain('Stopped: nothing was written.');
      expect(existsSync(join(home, 'identity.json'))).toBe(false);
      expect(existsSync(join(home, 'setup.json'))).toBe(false);
      expect(receipts(join(dir, 'store'))).toEqual([]);
      t.type('/exit');
      expect(await t.waitFor(/TTY=(?:same|changed)/)).toMatch(/EXIT=0[\s\S]*TTY=same/);
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('/setup key asks for an OpenRouter key, shown only as *, stores it 0600, and the chat takes it up', async () => {
    const { dir, env, home } = sandbox();
    // a home set up by timmy init (the preselected answers: the local model, logs on this computer)
    const init = await runAsync(TSX, [CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo'], { cwd: dir, env, timeout: CLI_MS });
    expect(init.status, init.stderr).toBe(0);
    const t = terminal(dir, env, 'key');
    const key = `sk-or-test-${randomBytes(12).toString('hex')}`;
    try {
      const first = await t.waitFor(/Enter to send/);
      expect(first).toMatch(/^TIMMY {2}chat: no model key · \/setup$/m);
      // set up, no receipts yet: the check
      expect(first).toMatch(/^First run: type \/setup to check what Timmy needs\.$/m);
      t.type('/setup key');
      const asked = await t.waitFor(/OpenRouter key \(hidden as you type; blank: no key\)\n {2}> ?$/m);
      expect(asked).toContain('TIMMY · guided setup (/setup in the REPL)');
      expect(asked).toContain('One question has no answer yet.');
      t.type(key);
      const shown = await t.waitFor(/Proceed\? \[Y\/n\]/);
      expect(shown).toContain('*'.repeat(key.length));
      expect(shown).toMatch(/chat: OpenRouter \(paid, cloud; key\s+set\)/);
      t.type('');
      const done = await t.waitFor(/setup check sealed and verified[\s\S]*Enter to send/);
      expect(done).toContain('The chat uses the stored key from your next message.');
      expect(done).toMatch(/model key\s+set/);
      expect(done).not.toContain(key);
      const providers = JSON.parse(readFileSync(join(home, 'providers.json'), 'utf8'));
      expect(providers.openrouter_api_key).toBe(key);
      expect(statSync(join(home, 'providers.json')).mode & 0o777).toBe(0o600);
      const setup = JSON.parse(readFileSync(join(home, 'setup.json'), 'utf8'));
      expect(setup).toMatchObject({ by: 'the REPL (/setup)', answers: { chat: 'openrouter' } });
      expect(JSON.stringify(setup)).not.toContain(key);
      // a second /setup key asks nothing: a key is stored
      t.type('/setup key');
      expect(await t.waitFor(/setup check sealed and verified/, 2)).toContain('A model key is already stored in the Timmy home');
      t.type('/exit');
      expect(await t.waitFor(/TTY=(?:same|changed)/)).toMatch(/EXIT=0[\s\S]*TTY=same/);
      expect(t.screen()).not.toContain(key);
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('without a terminal, /setup says the exact command, writes no setup, and still seals the check', async () => {
    const { dir, env, home } = sandbox();
    try {
      // a key in the environment lets the REPL start from a pipe; /setup is a command, so no model is asked
      const r = await runAsync(TSX, [CLI, 'repl'], { cwd: dir, env: { ...env, OPENROUTER_API_KEY: `sk-or-test-${randomBytes(12).toString('hex')}` }, input: '/setup\n', timeout: CLI_MS });
      expect(r.status, `${r.error?.message ?? ''}\n${r.stderr}`).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain('  6 setup questions have no answer yet.\n  In a terminal, run timmy init: it asks only those.\n');
      expect(out).toContain('setup check sealed and verified');
      expect(existsSync(join(home, 'setup.json'))).toBe(false);
      expect(existsSync(join(home, 'identity.json'))).toBe(false);
      expect(receipts(join(dir, 'store')).map((x) => [x.kind, x.discrepancies])).toEqual([['check', ['identity']]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
