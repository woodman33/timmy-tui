// R4 (H87): rmux and zellij lanes follow the tmux rule. They start only when asked; then every command is on a server of
// Timmy's own (rmux: `-L timmy-lanes-<pid> -f /dev/null`; zellij: ZELLIJ_SOCKET_DIR, a folder of this process's own), cleanup
// ends only the sessions this process made (never zellij's `kill-all-sessions`, never a listing of anyone else's), and
// nothing is written into the operator's ~/.config/zellij.
//
// rmux, zellij and `script` here are FAKES: stub scripts on PATH that write each call (its arguments and ZELLIJ_SOCKET_DIR)
// to a log and succeed; neither multiplexer is installed on this machine. The agent runs in a child process (tsx), with a
// HOME and TMPDIR of the test's own, and exits normally, so its exit handler ends its lanes.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { laneMultiplexer, laneOptions, lanePrograms, lanesWords, laneServerArgs, laneWatchdog, LANES_OPTION_WORDS } from '../src/agent/lane-server.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Runs an agent with the given multiplexer in a child process over FAKE binaries; returns its pid and the calls they saw. */
function runAgent(multiplexer: string): { pid: number; calls: string[]; dir: string; home: string; tmp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-lanesrv-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  for (const d of [bin, home, tmp]) mkdirSync(d);
  const log = join(dir, 'calls.log');
  // FAKE rmux and zellij: one line per call (the socket folder, then the arguments); `script` (BSD form) runs its command.
  for (const name of ['rmux', 'zellij']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s|%s|%s\\n' '${name}' "\${ZELLIJ_SOCKET_DIR:-}" "$*" >> '${log}'\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, 'script'), '#!/bin/sh\nshift 2\nexec "$@"\n');
  chmodSync(join(bin, 'script'), 0o755);
  const code = `import { createAgent } from '${resolve('src/agent/core.ts')}';
    console.log('PID=' + process.pid);
    createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 1, maxCost: 1 }, { multiplexer: '${multiplexer}' });
    setTimeout(() => process.exit(0), 400);`;
  const r = spawnSync(resolve('node_modules/.bin/tsx'), ['-e', code], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: tmp, TIMMY_RMUX_BIN: '', TIMMY_RMUX_POLL_MS: '60000', TIMMY_ZELLIJ_POLL_MS: '60000' },
  });
  const pid = Number(/PID=(\d+)/.exec(r.stdout)?.[1]);
  return { pid, calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [], dir, home, tmp };
}

describe('lanes on rmux (FAKE rmux)', () => {
  it('every call is on Timmy\'s own server; only its own sessions end, with the agent; a watchdog is set once', () => {
    const { pid, calls } = runAgent('rmux');
    expect(pid).toBeGreaterThan(0);
    const own = `-L timmy-lanes-${pid} -f /dev/null `;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.startsWith(`rmux||${own}`))).toEqual([]);
    const args = calls.map((c) => c.slice(`rmux||${own}`.length));
    expect(args.filter((a) => a.startsWith('new-session')).map((a) => a.split(' ').at(-1))).toEqual(['ortui-1', 'ortui-2', 'ortui-3', 'ortui-4', 'ortui-5', 'ortui-6']);
    expect(args.filter((a) => a.startsWith('run-shell -b')).length).toBe(1);
    expect(args.some((a) => a.startsWith('list-sessions') || a.startsWith('kill-server'))).toBe(false);
    // at exit, exactly the sessions it made
    expect(args.filter((a) => a.startsWith('kill-session')).map((a) => a.split(' ').at(-1)).sort()).toEqual(['ortui-1', 'ortui-2', 'ortui-3', 'ortui-4', 'ortui-5', 'ortui-6']);
  });
});

describe('lanes on zellij (FAKE zellij and script)', () => {
  it('every call has a socket folder of its own; never kill-all-sessions; only its own sessions end; nothing in ~/.config/zellij', () => {
    const { pid, calls, home, tmp } = runAgent('zellij');
    expect(pid).toBeGreaterThan(0);
    const socketDir = join(tmp, `timmy-zellij-${pid}`);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.startsWith(`zellij|${socketDir}|`))).toEqual([]);
    const args = calls.map((c) => c.slice(`zellij|${socketDir}|`.length));
    expect(args.some((a) => /kill-all-sessions|list-sessions/.test(a))).toBe(false);
    expect(args.filter((a) => a.startsWith('kill-session')).map((a) => a.split(' ').at(-1)).sort()).toEqual(['ortui-1', 'ortui-2', 'ortui-3', 'ortui-4', 'ortui-5', 'ortui-6']);
    // the layout by its path in the socket folder, and nothing written in the operator's zellij configuration
    expect(args.find((a) => a.includes('--default-layout'))).toContain(join(socketDir, 'layouts'));
    expect(existsSync(join(home, '.config', 'zellij'))).toBe(false);
    // the layout this process wrote went with it
    expect(existsSync(join(socketDir, 'layouts'))).toBe(false);
  });
});

describe('the lanes\' rule and words (src/agent/lane-server.ts)', () => {
  it('none unless asked; asked, tmux unless TIMMY_MULTIPLEXER says zellij or rmux; the monitor\'s choice rides on its config', () => {
    expect([laneMultiplexer(false, {}), laneMultiplexer(false, { TIMMY_MULTIPLEXER: 'tmux' }), laneMultiplexer(false, { TIMMY_MULTIPLEXER: 'zellij' })]).toEqual(['none', 'none', 'none']);
    expect([laneMultiplexer(true, {}), laneMultiplexer(true, { TIMMY_MULTIPLEXER: 'zellij' }), laneMultiplexer(true, { TIMMY_MULTIPLEXER: 'rmux' }), laneMultiplexer(true, { TIMMY_MULTIPLEXER: 'screen' })]).toEqual(['tmux', 'zellij', 'rmux', 'tmux']);
    expect([laneOptions({ lanes: 'tmux' }), laneOptions({}), laneOptions(null), laneOptions({ lanes: 'bogus' })].map((o) => o.multiplexer)).toEqual(['tmux', 'none', 'none', 'none']);
  });
  it('the server and its watchdog are this process\'s own; the words name each program and what a first run may install', () => {
    expect(laneServerArgs(4242)).toEqual(['-L', 'timmy-lanes-4242', '-f', '/dev/null']);
    expect(laneWatchdog('tmux', 4242).slice(0, 6)).toEqual(['-L', 'timmy-lanes-4242', '-f', '/dev/null', 'run-shell', '-b']);
    expect(laneWatchdog('tmux', 4242)[6]).toBe("while kill -0 4242 2>/dev/null; do sleep 1; done; 'tmux' -L timmy-lanes-4242 kill-server");
    expect(lanePrograms()).toEqual(['opencode', 'hermes', 'pi', 'openhands', 'jcode', 'minds']);
    const off = lanesWords('none');
    for (const p of lanePrograms()) { expect(off).toContain(p); expect(LANES_OPTION_WORDS).toContain(p); }
    expect(off).toMatch(/timmy watch --lanes/);
    expect(off).toMatch(/LaunchAgent/);
    expect(lanesWords('tmux', 4242)).toContain('tmux -L timmy-lanes-4242');
  });
});
