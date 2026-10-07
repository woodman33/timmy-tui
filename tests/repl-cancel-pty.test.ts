import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The playbook's Ctrl+C cases in a real PTY (§16.2, §17.8): mid-turn it cancels and returns to the
// prompt; at an idle prompt it exits 130 with the terminal restored; pressed twice within 2s while a
// cancel has not landed, it quits. The agent is a slow scripted fake (TIMMY_TEST_STUCK: it ignores cancel).
const TSX = resolve('node_modules/.bin/tsx');
const FIXTURE = resolve('tests/fixtures/repl-cancel-fixture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRepl(extraEnv: Record<string, string>, body: (io: {
  keys: (...k: string[]) => void;
  type: (text: string) => void;
  screen: () => string;
  waitFor: (re: RegExp, from?: number) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync('/tmp/tc-');
  const env = { ...process.env, ...extraEnv, TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor' };
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'cc', ...args], { env, encoding: 'utf8' });
  try {
    tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '30', 'bash', '--norc', '-c', `S0=$(stty -g); ${TSX} ${FIXTURE}; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same; sleep 60`);
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    const waitFor = async (re: RegExp, from = 0) => {
      for (let i = 0; i < 300; i++) { if (re.test(screen().slice(from))) return; await sleep(50); }
      throw new Error(`timed out waiting for ${re}:\n${screen()}`);
    };
    await body({ keys: (...k) => void tmux('send-keys', '-t', 't', ...k), type: (text) => void tmux('send-keys', '-t', 't', '-l', text), screen, waitFor });
  } finally {
    try { tmux('kill-server'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Ctrl+C in a real PTY', () => {
  it('cancels the turn, returns to the prompt, then exits 130 from the idle prompt', async () => {
    await withRepl({}, async ({ keys, type, screen, waitFor }) => {
      await waitFor(/Enter to send/);
      type('write a long answer');
      keys('Enter');
      await waitFor(/Line 2 of a long answer/);
      keys('C-c');
      await waitFor(/Cancelled\./);
      await waitFor(/Enter to send/, screen().indexOf('Cancelled.'));
      expect(screen()).not.toContain('Line 9 of a long answer');
      keys('C-c');
      await waitFor(/EXIT=\d+/);
      expect(screen()).toContain('EXIT=130');
      expect(screen()).toContain('TTY=same');
    });
  });
  it('quits on a second Ctrl+C within 2s when the agent ignores the cancel (exit 130, terminal restored)', async () => {
    await withRepl({ TIMMY_TEST_STUCK: '1' }, async ({ keys, type, screen, waitFor }) => {
      await waitFor(/Enter to send/);
      type('write a long answer');
      keys('Enter');
      await waitFor(/Line 2 of a long answer/);
      keys('C-c');
      await waitFor(/Ctrl\+C again to quit/);
      keys('C-c');
      await waitFor(/EXIT=\d+/);
      expect(screen()).toContain('EXIT=130');
      expect(screen()).toContain('TTY=same');
      expect(screen()).not.toContain('Line 9 of a long answer');
    });
  });
});
