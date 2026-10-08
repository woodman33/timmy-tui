import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutRunner } from './fixtures/repl-pty-env.js';

// The 20:14 order, the fourth installed defect: a signal that ends `timmy` mid-turn must leave the
// shell's next output on a clean line. The REPL's live line (the spinner) stayed where it was, so the
// shell wrote right after it: "⠸ Working 1.0sEXIT=143". Through the installed command's bin
// (timmy.ts), in a real PTY, with the REPL's 10-second loader as the turn.
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const BIN = resolve('timmy.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a signal mid-turn leaves the shell on a clean line', { timeout: 60_000 }, () => {
  for (const [sig, status] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`${sig} to \`timmy\` mid-turn: the REPL exits ${status}, the terminal restored, and the next output starts its own line`, async () => {
      const dir = mkdtempSync('/tmp/tsig-');
      const env = { ...withoutRunner(process.env), HOME: dir, TIMMY_HOME: `${dir}/timmy`, TIMMY_STORE: `${dir}/store`, OPENROUTER_API_KEY: '', TIMMY_PALETTE: 'night', TMUX_TMPDIR: dir, TMUX: '', LC_ALL: 'C.UTF-8', COLORTERM: 'truecolor' };
      const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'sig', ...args], { env, encoding: 'utf8' });
      try {
        tmux('-u', '-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '80', '-y', '24', '-c', dir, 'bash', '--norc', '-c',
          `S0=$(stty -g); ${process.execPath} --import ${LOADER} ${BIN} repl --demo-loader; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same; sleep 60`);
        const screen = () => tmux('capture-pane', '-p', '-t', 't');
        const waitFor = async (re: RegExp) => {
          for (let i = 0; i < 400; i++) { if (re.test(screen())) return; await sleep(50); }
          throw new Error(`timed out waiting for ${re}:\n${screen()}`);
        };
        await waitFor(/Working/);
        await sleep(1200); // the spinner shows its elapsed time after 1s
        const shell = tmux('display', '-p', '-t', 't', '#{pane_pid}').trim();
        const bin = Number(execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim().split('\n')[0]);
        process.kill(bin, sig);
        await waitFor(/EXIT=\d+/);
        const shown = screen();
        expect(shown).toMatch(new RegExp(`^EXIT=${status}$`, 'm'));
        expect(shown).not.toMatch(/Working.*EXIT=/);
        expect(shown).toContain('TTY=same');
        expect(tmux('display', '-p', '-t', 't', '#{cursor_flag}').trim()).toBe('1');
      } finally {
        try { tmux('kill-server'); } catch { /* gone */ }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
