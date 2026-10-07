import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutCI } from './fixtures/repl-pty-env.js';

// The block input in a real PTY (tmux): typing, Ctrl+J, bracketed paste, CJK with backspace, and the
// piped case (`echo hi | timmy`): plain input, no raw mode, no terminal queries (playbook §17.2, §17.9).
const TSX = resolve('node_modules/.bin/tsx');
const FIXTURE = resolve('tests/fixtures/repl-input-fixture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastScreen = '';

async function typeInto(keys: Array<string[] | { paste: string }>) {
  const dir = mkdtempSync('/tmp/ti-');
  const env = { ...withoutCI(process.env), TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'in', ...args], { env, encoding: 'utf8' });
  try {
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '24', 'bash', '--norc', '-c', `${TSX} ${FIXTURE}; sleep 60`);
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200; i++) { const m = screen().match(re); if (m) return m; await sleep(50); }
      throw new Error(`timed out waiting for ${re}:\n${screen()}`);
    };
    await waitFor(/Enter to send/);
    for (const k of keys) {
      if (Array.isArray(k)) tmux('send-keys', '-t', 't', ...k);
      else { tmux('set-buffer', k.paste); tmux('paste-buffer', '-p', '-t', 't'); }
      await sleep(150);
    }
    const result = JSON.parse((await waitFor(/RESULT=(.*)$/m))[1]);
    lastScreen = screen();
    return result;
  } finally {
    try { tmux('kill-server'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('block input in a real PTY', () => {
  it('submits typed text on Enter', async () => {
    expect(await typeInto([['-l', 'hello world'], ['Enter']])).toEqual({ kind: 'submit', text: 'hello world' });
    expect(lastScreen).toMatch(/› hello world/); // the submitted prompt stays in scrollback
    expect(lastScreen).not.toContain('Enter to send'); // the hint does not
  });
  it('adds a line with Ctrl+J and with a trailing backslash', async () => {
    expect(await typeInto([['-l', 'one'], ['C-j'], ['-l', 'two\\'], ['Enter'], ['-l', 'three'], ['Enter']])).toEqual({ kind: 'submit', text: 'one\ntwo\nthree' });
  });
  it('keeps a bracketed paste literal: its newlines never submit', async () => {
    expect(await typeInto([{ paste: 'line one\nline two' }, ['Enter']])).toEqual({ kind: 'submit', text: 'line one\nline two' });
  });
  it('edits CJK by grapheme', async () => {
    expect(await typeInto([['-l', '日本語'], ['BSpace'], ['Enter']])).toEqual({ kind: 'submit', text: '日本' });
  });
  it('clears typed text on the first Ctrl+C and cancels on an empty prompt', async () => {
    expect(await typeInto([['-l', 'oops'], ['C-c'], ['C-c']])).toEqual({ kind: 'cancel' });
  });
});

describe('piped input (echo hi | timmy)', () => {
  it('reads plain input with no raw mode and no terminal queries', () => {
    const dir = mkdtempSync('/tmp/ti-');
    try {
      const log = join(dir, 'writes.log');
      const r = spawnSync(TSX, [FIXTURE], { input: 'hi\n', encoding: 'utf8', env: { ...process.env, FIXTURE_WRITE_LOG: log, TIMMY_PALETTE: '' } });
      expect(r.stdout).toContain('RESULT={"kind":"submit","text":"hi"}');
      const writes = readFileSync(log, 'utf8');
      expect(writes).not.toContain('\x1b]11;?');
      expect(writes).not.toContain('\x1b[?2004h');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
