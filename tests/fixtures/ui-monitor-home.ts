// Fixtures for the monitor's PTY tests (fourth order, step 1). Each test gets a home of its own: HOME,
// the config folder (XDG_CONFIG_HOME, set here, never inherited: on CI it pointed the config store at the
// runner's own folder, so the monitor opened its first-run screen), the Timmy home, the repo, the store
// and the tmux server (TMUX_TMPDIR is the test's own folder, so no two tests share a socket file).
// "initialized" has finished onboarding and opens on the home screen; "first-run" has not, and opens on
// the setup screen. Signals go only to processes the test started and captured.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withoutCI } from './repl-pty-env.js';

export const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
export const MONITOR = resolve('cli.tsx');
export const CLI = resolve('src/cli.ts');
const XDG_VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

export type HomeKind = 'initialized' | 'first-run';

export interface MonitorHome {
  box: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  tmux(...args: string[]): string;
  /** Wait for `re` on the screen; throws with the screen when it never appears. */
  waitFor(re: RegExp, ms?: number, target?: string): Promise<RegExpMatchArray>;
  dispose(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function monitorHome(kind: HomeKind, opts: { git?: boolean } = {}): MonitorHome {
  const box = mkdtempSync('/tmp/tm-'); // short: a tmux socket path has a length limit
  const home = join(box, 'home');
  const config = join(home, '.config');
  const repo = join(box, 'repo');
  mkdirSync(join(config, 'timmy-tui-nodejs'), { recursive: true });
  mkdirSync(repo);
  if (opts.git) execFileSync('git', ['init', '-q'], { cwd: repo });
  const base = withoutCI(process.env);
  for (const k of XDG_VARS) delete base[k];
  const env: NodeJS.ProcessEnv = {
    ...base, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'), TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: repo, TIMMY_STORE: join(box, 'store'),
    OPENROUTER_API_KEY: '', COLORTERM: 'truecolor', TMUX: '', TMUX_TMPDIR: box,
  };
  execFileSync(process.execPath, ['--import', LOADER, CLI, 'init', '--yes', '--operator', 'Sample', '--seed', 'generate', '--project', 'demo'], { cwd: repo, env, stdio: 'ignore' });
  if (kind === 'initialized') writeFileSync(join(config, 'timmy-tui-nodejs', 'config.json'), '{"onboarded": true}');
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'pty', ...args], { env, encoding: 'utf8' });
  const waitFor = async (re: RegExp, ms = 45_000, target = 't'): Promise<RegExpMatchArray> => {
    let screen = '';
    for (let i = 0; i < ms / 100; i++) {
      screen = tmux('capture-pane', '-p', '-t', target);
      const m = screen.match(re);
      if (m) return m;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${re}:\n${screen}`);
  };
  // The server's hangup ends every process in its sessions (the first-run screen also starts lane sessions
  // there, whose shells write their history as they exit), so the folder is removed once they are done.
  const dispose = async (): Promise<void> => {
    try { tmux('kill-server'); } catch { /* already gone */ }
    for (let i = 0; ; i++) {
      try { rmSync(box, { recursive: true, force: true }); return; } catch (e) {
        if (i >= 75) throw e; // 15 seconds: something of this test is still writing here
        await sleep(200);
      }
    }
  };
  return { box, repo, env, tmux, waitFor, dispose };
}

/** A process the test started: its pid and the command line it had when captured. */
export interface OwnedProcess { pid: number; args: string }

export function argsOf(pid: number): string | null {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

export function childrenOf(pid: number): number[] {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
}

/** Every process under `pid` (not `pid` itself), with its command line. */
export function treeOf(pid: number): OwnedProcess[] {
  return childrenOf(pid).flatMap((c) => {
    const args = argsOf(c);
    return args === null ? treeOf(c) : [{ pid: c, args }, ...treeOf(c)];
  });
}

/** Still running: the same pid with the same command line (a reused pid is another process). */
export function stillRunning(p: OwnedProcess): boolean {
  return argsOf(p.pid) === p.args;
}
