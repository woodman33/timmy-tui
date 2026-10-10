import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';
import { runAsync } from './helpers/run-async.js';

// `timmy repl` end to end, sandboxed (scratch HOME, TIMMY_HOME and working folder): a missing key is a
// config error (exit 78) with cause and fix; in a real PTY the banner, /help from the registry, an
// unknown command answered locally, and /exit (exit 0) with the terminal restored.
const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// R4 H31: CI run 38000946368 never reported this file and sat in vitest for 6 hours. A spawnSync with no timeout blocks
// the worker's event loop until the child ends, so vitest's own test timeout can never fire. The CLI is awaited with a
// limit under the 60 s test timeout instead, and each tmux client call has one too.
const CLI_MS = 50_000;
const TMUX_MS = 10_000;
const sandbox = () => {
  const dir = mkdtempSync('/tmp/tr-');
  return { dir, env: { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: `${dir}/timmy`, TIMMY_REPO_ROOT: dir, TIMMY_STORE: `${dir}/store`, OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night' } };
};

describe('timmy repl', () => {
  it('exits 78 with a cause and a fix when there is no model key', async () => {
    const { dir, env } = sandbox();
    try {
      const r = await runAsync(TSX, [CLI, 'repl'], { cwd: dir, env, input: '', timeout: CLI_MS });
      expect(r.status, `${r.error?.message ?? ''}\n${r.stderr}`).toBe(78);
      expect(r.stderr).toContain('Error: no model key');
      expect(r.stderr).toContain('Try: timmy init');
      expect(r.stderr).toContain('Help: timmy repl --help');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints its own help from the registries for --help and -h, and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await runAsync(TSX, [CLI, 'repl', flag], { timeout: CLI_MS });
      expect(r.status, `${r.error?.message ?? ''}\n${r.stderr}`).toBe(0);
      expect(r.stdout.startsWith('timmy repl: ')).toBe(true);
      expect(r.stdout).toContain('/receipts');
    }
  });

  it('runs in a real PTY: banner, /help, an unknown command, /exit', async () => {
    const { dir, env } = sandbox();
    const tenv = { ...env, OPENROUTER_API_KEY: 'sk-or-test-placeholder', TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'repl', ...args], { env: tenv, encoding: 'utf8', timeout: TMUX_MS });
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '30', '-c', dir, 'bash', '--norc', '-c', `S0=$(stty -g); ${TSX} ${CLI} repl; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same; sleep 60`);
      const screen = () => tmux('capture-pane', '-p', '-t', 't');
      const waitFor = async (re: RegExp) => {
        for (let i = 0; i < 600; i++) { if (re.test(screen())) return; await sleep(50); }
        throw new Error(`timed out waiting for ${re}:\n${screen()}`);
      };
      // No receipts yet: a first run says how to run the setup check, and the prompt starts empty.
      await waitFor(/First run: type \/setup/);
      await waitFor(/Enter to send/);
      expect(screen()).toMatch(/TIMMY\s+\S+/);
      expect(screen()).not.toContain('Tab completes');
      tmux('send-keys', '-t', 't', '-l', '/help');
      tmux('send-keys', '-t', 't', 'Enter');
      // Each command is typed at a prompt that is back and ready, as a person would (SUITE-01 once lost
      // the next one on a loaded machine).
      await waitFor(/Show the model, or switch[\s\S]*Enter to send/);
      tmux('send-keys', '-t', 't', '-l', '/nope');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/Unknown command: \/nope\.[\s\S]*Enter to send/);
      tmux('send-keys', '-t', 't', '-l', '/exit');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/EXIT=\d+/);
      expect(screen()).toMatch(/EXIT=0/);
      expect(screen()).toContain('TTY=same');
      expect(tmux('display', '-p', '-t', 't', '#{cursor_flag}').trim()).toBe('1');
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // C-14, and the 20:14 order: a first run in a terminal, with no model key and no receipts yet. The
  // REPL opens anyway (only a pipe still exits 78), its prompt empty and a line saying to type /setup;
  // /setup runs the check and seals the first receipt, verified. A message without a key gets the cause
  // and the fix, and the REPL stays.
  it('a first run opens with an empty prompt and says to type /setup, which seals the first receipt', async () => {
    const { dir, env } = sandbox();
    const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'first', ...args], { env: tenv, encoding: 'utf8', timeout: TMUX_MS });
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '40', '-c', dir, 'bash', '--norc', '-c', `${TSX} ${CLI} repl; echo EXIT=$?; sleep 60`);
      const screen = () => tmux('capture-pane', '-p', '-t', 't');
      const waitFor = async (re: RegExp) => {
        for (let i = 0; i < 600; i++) { if (re.test(screen())) return; await sleep(50); }
        throw new Error(`timed out waiting for ${re}:\n${screen()}`);
      };
      // Short enough for a 60-column terminal (the review: the longer line was cut at 60).
      await waitFor(/First run: type \/setup to check what Timmy needs\.$/m);
      await waitFor(/Enter to send/);
      expect(screen()).not.toContain('Tab completes');
      tmux('send-keys', '-t', 't', '-l', '/setup');
      await waitFor(/\/setup\s+Check what Timmy needs, and seal it/);
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/RECEIPT [0-9a-f]{8}/);
      const shown = screen();
      expect(shown).toMatch(/model key\s+none · timmy init or OPENROUTER_API_KEY/);
      expect(shown).toContain('setup check sealed and verified');
      // runs.jsonl also carries the bus's events; receipts are the lines with a prev_hash.
      const chain = readFileSync(`${dir}/store/runs.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => typeof r.prev_hash === 'string');
      expect(chain.map((r) => [r.kind, r.discrepancies])).toEqual([['check', ['identity', 'model key']]]);
      tmux('send-keys', '-t', 't', '-l', 'hello');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/no model key, so Timmy cannot answer/);
      tmux('send-keys', '-t', 't', '-l', '/exit');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/EXIT=\d+/);
      expect(screen()).toMatch(/EXIT=0/);
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The 20:14 order: /exit typed at a first run's prompt exits. With /setup prefilled it became
  // /setup/exit, an unknown command, and the REPL stayed.
  it('on a first run, /exit typed at the empty prompt exits 0', async () => {
    const { dir, env } = sandbox();
    const tenv = { ...env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'firstexit', ...args], { env: tenv, encoding: 'utf8', timeout: TMUX_MS });
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '30', '-c', dir, 'bash', '--norc', '-c', `S0=$(stty -g); ${TSX} ${CLI} repl; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same; sleep 60`);
      const screen = () => tmux('capture-pane', '-p', '-t', 't');
      const waitFor = async (re: RegExp) => {
        for (let i = 0; i < 600; i++) { if (re.test(screen())) return; await sleep(50); }
        throw new Error(`timed out waiting for ${re}:\n${screen()}`);
      };
      await waitFor(/First run: type \/setup/);
      await waitFor(/Enter to send/);
      tmux('send-keys', '-t', 't', '-l', '/exit');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/EXIT=\d+/);
      const shown = screen();
      expect(shown).toMatch(/EXIT=0/);
      expect(shown).toContain('TTY=same');
      expect(shown).not.toContain('/setup/exit');
      expect(shown).not.toContain('Unknown command');
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
