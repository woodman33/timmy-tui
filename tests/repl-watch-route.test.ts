import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `timmy watch` in a real PTY (C-15): a SIGTERM sent to the `timmy` process itself (as `timeout` or a
// process manager sends it) reaches the monitor, which restores the terminal; `timmy watch` exits 143
// and no monitor is left drawing. Before, it waited in spawnSync: the wrapper died and the monitor,
// behind npx, a shell and tsx, kept running. (A monitor that cannot start: tests/repl-watch-launch.)
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = resolve('src/cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let box: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  box = mkdtempSync('/tmp/tw-');
  const home = join(box, 'home');
  const repo = join(box, 'repo');
  mkdirSync(join(home, '.config', 'timmy-tui-nodejs'), { recursive: true });
  mkdirSync(repo);
  env = { ...process.env, HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'), OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor', TMUX: '', TMUX_TMPDIR: box };
  execFileSync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo'], { cwd: repo, env, stdio: 'ignore' });
  writeFileSync(join(home, '.config', 'timmy-tui-nodejs', 'config.json'), '{"onboarded": true}');
}, 60_000);
afterAll(() => rmSync(box, { recursive: true, force: true }));

describe('timmy watch and a SIGTERM to it', () => {
  it('passes the signal to the monitor: exit 143, the terminal back, no monitor left', async () => {
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'watch', ...args], { env, encoding: 'utf8' });
    const script = `sleep 0.5; S0=$(stty -g); ${process.execPath} --import ${LOADER} ${CLI} watch --no-companion; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
    try {
      tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'w', '-x', '100', '-y', '30', '-c', join(box, 'repo'), 'bash', '--norc', '-c', script);
      for (let i = 0; i < 300 && !tmux('capture-pane', '-p', '-t', 'w').includes('YOUR JOURNEY'); i++) await sleep(100);
      const bash = tmux('display', '-p', '-t', 'w', '#{pane_pid}').trim();
      const timmy = execFileSync('pgrep', ['-P', bash], { encoding: 'utf8' }).trim().split('\n')[0];
      process.kill(Number(timmy), 'SIGTERM');
      let screen = '';
      for (let i = 0; i < 60 && !/TTY=\w+/.test(screen); i++) { await sleep(100); screen = tmux('capture-pane', '-p', '-t', 'w'); }
      const left = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(`${resolve('cli.tsx')}`) && l.includes('--import')).length;
      expect({ exit: screen.match(/EXIT=(\d+)/)?.[1], tty: screen.match(/TTY=(\w+)/)?.[1], monitorsLeft: left }).toEqual({ exit: '143', tty: 'same', monitorsLeft: 0 });
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
    }
  }, 60_000);
});
