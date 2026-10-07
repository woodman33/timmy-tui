import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Each NEEDS YOU key in a real PTY (tmux): y once, a session, n, Esc and Enter deny. A piped run
// never asks and denies (playbook §17.8).
const TSX = resolve('node_modules/.bin/tsx');
const FIXTURE = resolve('tests/fixtures/repl-approval-fixture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function press(key: string): Promise<{ decision: string; screen: string }> {
  const dir = mkdtempSync('/tmp/ta-');
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'ap', ...args], { env, encoding: 'utf8' });
  try {
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '24', 'bash', '--norc', '-c', `${TSX} ${FIXTURE}; sleep 60`);
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    for (let i = 0; i < 200 && !screen().includes('NEEDS YOU'); i++) await sleep(50);
    await sleep(400); // keys in the first 300ms after the box appears are ignored (type-ahead guard)
    tmux('send-keys', '-t', 't', key);
    for (let i = 0; i < 200; i++) {
      const m = screen().match(/DECISION=(\w+)/);
      if (m) return { decision: m[1], screen: screen() };
      await sleep(50);
    }
    throw new Error(`no decision:\n${screen()}`);
  } finally {
    try { tmux('kill-server'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('NEEDS YOU keys in a real PTY', () => {
  for (const [key, decision] of [['y', 'once'], ['a', 'session'], ['n', 'deny'], ['Escape', 'deny'], ['Enter', 'deny']] as const) {
    it(`${key} → ${decision}`, async () => {
      const r = await press(key);
      expect(r.decision).toBe(decision);
      expect(r.screen).not.toContain('NEEDS YOU'); // the box is gone once answered
    });
  }
  it('a piped run never asks and denies', () => {
    const r = spawnSync(TSX, [FIXTURE], { input: '', encoding: 'utf8', env: { ...process.env, TIMMY_PALETTE: '' } });
    expect(r.stdout).toContain('DECISION=deny');
    expect(r.stdout + r.stderr).not.toContain('NEEDS YOU');
  });
});
