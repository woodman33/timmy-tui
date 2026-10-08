import { describe, expect, it } from 'vitest';
import { CLI, LOADER, MONITOR, monitorHome, stillRunning, treeOf } from './fixtures/ui-monitor-home.js';

// `timmy watch` in a real PTY (C-15): a SIGTERM sent to the `timmy` process itself (as `timeout` or a
// process manager sends it) reaches the monitor, which restores the terminal; `timmy watch` exits 143
// and no monitor is left drawing. Before, it waited in spawnSync: the wrapper died and the monitor,
// behind npx, a shell and tsx, kept running. (A monitor that cannot start: tests/repl-watch-launch.)
// Fourth order, step 1: the test looks only at the processes it started (under its own pane), not at
// every monitor on the machine: on CI other tests run monitors at the same time. Its home is its own
// (tests/fixtures/ui-monitor-home.ts), and it fails if the home screen never appears.
describe('timmy watch and a SIGTERM to it', () => {
  it('passes the signal to the monitor: exit 143, the terminal back, no monitor left', async () => {
    const h = monitorHome('initialized');
    const script = `sleep 0.5; S0=$(stty -g); ${process.execPath} --import ${LOADER} ${CLI} watch --no-companion; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
    try {
      h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '30', '-c', h.repo, 'bash', '--norc', '-c', script);
      await h.waitFor(/YOUR JOURNEY/, 30_000);
      const owned = treeOf(Number(h.tmux('display', '-p', '-t', 't', '#{pane_pid}').trim()));
      const timmy = owned.filter((p) => p.args.includes(CLI) && p.args.includes('watch'));
      const monitors = owned.filter((p) => p.args.includes(MONITOR));
      expect({ timmy: timmy.length, monitors: monitors.length }).toEqual({ timmy: 1, monitors: 1 });
      process.kill(timmy[0].pid, 'SIGTERM');
      const [, exit] = await h.waitFor(/EXIT=(\d+)/, 6_000);
      const [, tty] = await h.waitFor(/TTY=(\w+)/, 2_000);
      expect({ exit, tty, timmyLeft: timmy.filter(stillRunning).length, monitorsLeft: monitors.filter(stillRunning).length }).toEqual({ exit: '143', tty: 'same', timmyLeft: 0, monitorsLeft: 0 });
    } finally {
      await h.dispose();
    }
  }, 90_000);
});
