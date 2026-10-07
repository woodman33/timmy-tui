import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Real PTY (tmux) proof for C-3: a program that hides the cursor, enters the alternate screen,
// turns on raw mode and bracketed paste is ended every way; each time the terminal comes back:
// cursor visible, main screen, and the exact tty settings it started with (stty -g).
const TSX = resolve('node_modules/.bin/tsx');
const FIXTURE = resolve('tests/fixtures/term-session-fixture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function endItBy(mode: 'return' | 'ctrl-c' | 'sigterm' | 'throw') {
  const dir = mkdtempSync('/tmp/tt-');
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'pty', ...args], { env, encoding: 'utf8' });
  const script = `S0=$(stty -g); ${TSX} ${FIXTURE} ${mode}; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '24', 'bash', '--norc', '-c', script);
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200; i++) {
        const m = screen().match(re);
        if (m) return m;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${re}: ${screen()}`);
    };
    const ready = await waitFor(/PID=(\d+) READY/);
    expect(tmux('display', '-p', '-t', 't', '#{cursor_flag} #{alternate_on}').trim()).toBe('0 1');
    if (mode === 'ctrl-c') tmux('send-keys', '-t', 't', 'C-c');
    if (mode === 'sigterm') process.kill(Number(ready[1]), 'SIGTERM');
    const exit = Number((await waitFor(/EXIT=(\d+)/))[1]);
    await waitFor(/TTY=\w+/);
    return { exit, tty: screen().match(/TTY=(\w+)/)![1], flags: tmux('display', '-p', '-t', 't', '#{cursor_flag} #{alternate_on}').trim() };
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('terminal restore in a real PTY', () => {
  for (const [mode, code] of [['return', 0], ['ctrl-c', 130], ['sigterm', 143], ['throw', 1]] as const) {
    it(`${mode}: exits ${code}, cursor shown, main screen, tty settings as before`, async () => {
      const r = await endItBy(mode);
      expect(r).toEqual({ exit: code, tty: 'same', flags: '1 0' });
    });
  }
});
