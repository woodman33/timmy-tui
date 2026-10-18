// R4 (H98): `timmy watch` on a home without setup runs the same guided setup in place when it has a terminal, then opens the
// monitor, which asks nothing the setup answered and shows one line of what it chose; without a terminal it still exits 78
// with the message. TIMMY_COMPANION_PORT is honoured as --companion-port is (r24: the companion took 3001), and the monitor
// says which port the companion took when it is not the one asked for. Real processes, a real tmux terminal, real files in
// a temporary home; no model is asked (no key).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { askedCompanionPort, companionPortArgs, companionPortNote } from '../src/setup/companion-port.js';

const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * How long a cold start may take to draw (R5 H130): tsx loads the CLI from source, and for the monitor, spawns it, and it loads
 * React, Ink and the whole shell. Alone that drew HOME in about 7 s here, the screen blank for most of it (before the boot frame,
 * and again once that is erased while the shell loads); in a full run on 2 CPUs with two other agents testing, three of these
 * tests saw a blank screen for the whole 45 s they waited, and with the monitor's own processes stopped about 95 % of the time it
 * took 21 to 41 s. The waits that cover a cold start take this; the others keep 45 s. A wait ends at once if the command has ended.
 */
const COLD_START_MS = 150_000;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const env: NodeJS.ProcessEnv = {
    ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: join(dir, 'timmy'), TIMMY_REPO_ROOT: dir, XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local', 'share'), XDG_STATE_HOME: join(dir, '.local', 'state'), XDG_CACHE_HOME: join(dir, '.cache'),
    TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', TMUX: '', TMUX_TMPDIR: dir, LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor',
  };
  delete env.TIMMY_SKIP_INIT;
  delete env.TIMMY_COMPANION_PORT;
  return { dir, env };
}

function pty(dir: string, name: string, env: NodeJS.ProcessEnv, command: string) {
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', name, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', dir, 'bash', '--norc', '-c', command);
  const screen = (): string => tmux('capture-pane', '-p', '-t', 't');
  // waits until the screen matches `re`, for `ms` by the clock; the pane's command ends with `echo EXIT=$?`, so a screen that
  // says EXIT= and does not match has nothing more coming, and fails at once
  const waitFor = async (re: RegExp, ms = 45_000): Promise<RegExpMatchArray> => {
    const end = Date.now() + ms;
    for (;;) {
      const now = screen();
      const m = now.match(re);
      if (m) return m;
      if (/EXIT=\d+/.test(now)) throw new Error(`the command ended before ${re} was drawn:\n${now}`);
      if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${re}:\n${now}`);
      await sleep(100);
    }
  };
  const type = (text: string) => { tmux('send-keys', '-t', 't', '-l', text); tmux('send-keys', '-t', 't', 'Enter'); };
  const keys = (...k: string[]) => tmux('send-keys', '-t', 't', ...k);
  return { screen, waitFor, type, keys, kill: () => { try { tmux('kill-server'); } catch { /* gone */ } } };
}

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('TIMMY_COMPANION_PORT, as --companion-port', () => {
  it('is passed on as the flag, a flag given wins, and a value that is not a port is refused in words', () => {
    expect(companionPortArgs([], { TIMMY_COMPANION_PORT: '4555' })).toEqual({ args: ['--companion-port', '4555'] });
    expect(companionPortArgs(['--companion-port', '4600'], { TIMMY_COMPANION_PORT: '4555' })).toEqual({ args: ['--companion-port', '4600'] });
    expect(companionPortArgs(['--no-companion'], {})).toEqual({ args: ['--no-companion'] });
    expect(companionPortArgs([], { TIMMY_COMPANION_PORT: 'abc' })).toEqual({ error: expect.stringContaining('not a port (1 to 65535)') });
    expect([askedCompanionPort(['--companion-port', '4600'], {}), askedCompanionPort(['--companion-port=4601'], {}), askedCompanionPort([], { TIMMY_COMPANION_PORT: '4555' }), askedCompanionPort([], {})]).toEqual([4600, 4601, 4555, 3001]);
    expect([companionPortNote(4555, 4555), companionPortNote(4555, 4556), companionPortNote(4555, undefined)]).toEqual([null, 'Browser companion on port 4556: 4555, the port asked for, was taken.', null]);
  });

  it('timmy watch refuses a TIMMY_COMPANION_PORT that is not a port (exit 2) before anything starts', () => {
    const { dir, env } = sandbox();
    try {
      const r = spawnSync(process.execPath, ['--import', LOADER, CLI, 'watch'], { cwd: dir, env: { ...env, TIMMY_COMPANION_PORT: '70000' }, encoding: 'utf8', timeout: 60_000 });
      expect({ status: r.status, said: r.stderr.includes('TIMMY_COMPANION_PORT is "70000", which is not a port') }).toEqual({ status: 2, said: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('timmy watch on a home without setup', () => {
  it('without a terminal: exit 78 and the message, as before; nothing written', () => {
    const { dir, env } = sandbox();
    try {
      const r = spawnSync(process.execPath, ['--import', LOADER, CLI, 'watch', '--no-companion'], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
      expect({ status: r.status, init: r.stdout.includes('timmy init'), home: existsSync(join(dir, 'timmy')) }).toEqual({ status: 78, init: true, home: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('in a terminal: the same guided setup in place, then the monitor, which asks nothing more and shows one line of what was chosen', async () => {
    const { dir, env } = sandbox();
    const port = await freePort();
    const p = pty(dir, 'watch', { ...env, TIMMY_COMPANION_PORT: String(port) }, `${process.execPath} --import ${LOADER} ${CLI} watch; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/TIMMY · first run — guided setup \(timmy watch\)/, COLD_START_MS);
      await p.waitFor(/> \[operator\]/);
      p.type('Sample');
      for (const q of [/> \[new key\]/, /Ollama host[\s\S]*> \[http:\/\/127\.0\.0\.1:11434\]/, /Chat model[\s\S]*> \[l\]/]) {
        await p.waitFor(q);
        p.type('');
      }
      await p.waitFor(/> \[first-light\]/);
      p.type('demo');
      await p.waitFor(/Proceed\? \[Y\/n\]/);
      p.type('');
      // the monitor opens on HOME: no FIRST RUN, and one line of what the setup chose (waited for whole: a capture taken as a
      // frame is written can hold part of the one before)
      await p.waitFor(/YOUR JOURNEY[\s\S]*Set up by timmy watch: chat local model \(no key\) · logs this computer only · project demo/, COLD_START_MS);
      expect(p.screen()).not.toContain('FIRST RUN');
      // the companion took the port TIMMY_COMPANION_PORT asked for
      const listening = await new Promise<boolean>((done) => { const c = createServer(); c.once('error', () => done(true)); c.listen(port, '127.0.0.1', () => c.close(() => done(false))); });
      expect(listening).toBe(true);
      p.keys('C-c');
      const [, code] = await p.waitFor(/EXIT=(\d+)/, 15_000);
      expect(code).toBe('130');
      const rec = JSON.parse(readFileSync(join(dir, 'timmy', 'setup.json'), 'utf8'));
      expect({ by: rec.by, chat: rec.answers.chat, logs: rec.answers.logs }).toEqual({ by: 'timmy watch', chat: 'local', logs: undefined });
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 360_000);

  // r24: on a computer whose monitor finished its own FIRST RUN before (its settings say so), a home timmy init set up opened
  // HOME with nothing said about the setup
  it('a monitor whose own first run finished before asks nothing, and still says in one line what the setup recorded', async () => {
    const { dir, env } = sandbox();
    mkdirSync(join(dir, '.config', 'timmy-tui-nodejs'), { recursive: true });
    writeFileSync(join(dir, '.config', 'timmy-tui-nodejs', 'config.json'), JSON.stringify({ onboarded: true }));
    execFileSync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo'], { cwd: dir, env, stdio: 'ignore', timeout: 60_000 });
    const port = await freePort();
    const p = pty(dir, 'watchdone', { ...env, TIMMY_COMPANION_PORT: String(port) }, `${process.execPath} --import ${LOADER} ${CLI} watch; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/YOUR JOURNEY[\s\S]*Set up by timmy init: chat local model \(no key\) · logs this computer only · project demo/, COLD_START_MS);
      expect(p.screen()).not.toMatch(/FIRST RUN|guided setup/);
      p.keys('C-c');
      await p.waitFor(/EXIT=\d+/, 15_000);
    } finally {
      p.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('the companion\'s port taken: the monitor says which port it took instead', async () => {
    const { dir, env } = sandbox();
    // a set-up home (timmy init --yes), and the asked port held by another listener
    execFileSync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--project', 'demo'], { cwd: dir, env, stdio: 'ignore', timeout: 60_000 });
    const port = await freePort();
    const holder: Server = createServer().listen(port, '127.0.0.1');
    await new Promise((r) => holder.once('listening', r));
    const p = pty(dir, 'watchport', { ...env, TIMMY_COMPANION_PORT: String(port) }, `${process.execPath} --import ${LOADER} ${CLI} watch; echo EXIT=$?; sleep 60`);
    try {
      await p.waitFor(/YOUR JOURNEY/, COLD_START_MS);
      // the STATUS card says it short; q on HOME shows the pairing card, which says it in full above the address
      const [, took] = await p.waitFor(new RegExp(`companion on port (\\d+) \\(${port} was taken\\)`));
      p.keys('q');
      await p.waitFor(new RegExp(`Browser companion on port ${took}: ${port}, the port asked for, was taken\\.[\\s\\S]*http://127\\.0\\.0\\.1:${took}/#t=`));
      p.keys('C-c');
      await p.waitFor(/EXIT=\d+/, 15_000);
    } finally {
      p.kill();
      await new Promise((r) => holder.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
