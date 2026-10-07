import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';

// Fourth order, step 1: the other PTY tests keep a CI runner's settings out of the terminal they drive.
// This one sets CI=true on purpose and checks what Timmy actually does in CI, in a real terminal: a plain
// prompt with no live input row and no hint, a static "Working..." line instead of a spinner, the answer
// and its footer, and /exit leaving with 0.
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const FIXTURE = resolve('tests/fixtures/repl-qualify-fixture.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the REPL in CI mode, in a real PTY', () => {
  it('draws no live input row and no spinner, answers, and exits 0 on /exit', async () => {
    const box = mkdtempSync('/tmp/tci-');
    for (const d of ['home', 'work', 'store']) mkdirSync(join(box, d));
    const env = {
      ...withoutRunner(process.env), CI: 'true', HOME: join(box, 'home'), TIMMY_HOME: join(box, 'home', 'timmy'), TIMMY_REPO_ROOT: join(box, 'work'),
      TIMMY_STORE: join(box, 'store'), TIMMY_Q_SCRIPT: 'text', TMUX_TMPDIR: box, TMUX: '', LC_ALL: 'C.UTF-8', TIMMY_PALETTE: 'night', COLORTERM: 'truecolor',
    };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'ci', ...args], { env, encoding: 'utf8' });
    const screen = () => tmux('capture-pane', '-p', '-t', 't');
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 300; i++) { if (re.test(screen())) return; await sleep(50); }
      throw new Error(`timed out waiting for ${re}:\n${screen()}`);
    };
    try {
      tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '20', '-c', join(box, 'work'), 'bash', '--norc', '-c', `${process.execPath} --import ${LOADER} ${FIXTURE}; echo EXIT=$?; sleep 60`);
      await waitFor(/^›/m);
      await sleep(800);
      const idle = screen();
      tmux('send-keys', '-t', 't', '-l', 'hello');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/0 steps · \$0\.000/);
      const turn = screen();
      tmux('send-keys', '-t', 't', '-l', '/exit');
      tmux('send-keys', '-t', 't', 'Enter');
      await waitFor(/EXIT=\d+/);
      expect({
        hint: /Enter to send/.test(idle + turn),
        working: turn.includes('Working...'),
        spinner: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(turn),
        answer: turn.includes('Hello. The answer streams here'),
        exit: screen().match(/EXIT=(\d+)/)?.[1],
      }).toEqual({ hint: false, working: true, spinner: false, answer: true, exit: '0' });
    } finally {
      try { tmux('kill-server'); } catch { /* gone */ }
      rmSync(box, { recursive: true, force: true });
    }
  }, 60_000);
});
