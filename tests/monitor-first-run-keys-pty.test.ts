// R4 (H87): the monitor's FIRST RUN screen answers its keys. Found on the Mac (r23b): when `timmy watch` opened it on a home
// that was not set up, Enter, q and Esc did nothing and the terminal stayed in canonical, echoing mode. In a tmux PTY here:
// q on the splash ended only the screen (Ink's exit), not the monitor: the last frame stayed, the terminal went back to
// canonical, echoing mode with the monitor still running, so every key after it did nothing; Esc and Ctrl+C did nothing at
// all on that screen. Now Enter begins the setup, q and Esc leave (the monitor ends, 0, and the terminal comes back as it
// was), and Ctrl+C ends it with 130.
import { execFileSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, monitorHome } from './fixtures/ui-monitor-home.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port nothing listens on now (the monitor's companion takes it: `timmy watch` runs with its companion). */
async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function firstRunAnd(key: 'Enter' | 'C-j' | 'q' | 'Escape' | 'C-c') {
  const h = monitorHome('first-run', { git: true });
  // as `timmy watch` runs: with its browser companion (whose server alone kept the old monitor alive after q)
  const script = `sleep 0.5; S0=$(stty -g); ${process.execPath} --import ${LOADER} ${MONITOR} --companion-port ${await freePort()}; echo EXIT=$?; [ "$(stty -g)" = "$S0" ] && echo TTY=same || echo TTY=changed; sleep 60`;
  try {
    h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '100', '-y', '40', '-c', h.repo, 'bash', '--norc', '-c', script);
    await h.waitFor(/\[Enter\] Begin setup/);
    await sleep(800);
    const tty = h.tmux('display', '-p', '-t', 't', '#{pane_tty}').trim();
    // while the screen is up, the terminal is in raw mode: a key is the monitor's, never echoed
    const raw = /-icanon/.test(execFileSync('sh', ['-c', `stty -a < '${tty}'`], { encoding: 'utf8' }));
    h.tmux('send-keys', '-t', 't', key);
    if (key === 'Enter' || key === 'C-j') {
      await h.waitFor(/PICK A BRAIN/, 10_000);
      return { key, raw, acted: 'setup began' };
    }
    const exit = Number((await h.waitFor(/EXIT=(\d+)/, 15_000))[1]);
    const back = (await h.waitFor(/TTY=(\w+)/, 5_000))[1];
    return { key, raw, exit, tty: back, alternate: h.tmux('display', '-p', '-t', 't', '#{alternate_on}').trim() };
  } finally {
    await h.dispose();
  }
}

describe('the monitor\'s FIRST RUN screen in a PTY (R4 H87)', () => {
  it('Enter begins the setup', async () => {
    expect(await firstRunAnd('Enter')).toEqual({ key: 'Enter', raw: true, acted: 'setup began' });
  }, 90_000);
  // Ink reads a newline (Ctrl+J, or an Enter typed while the terminal was still line by line, which turns it into one) as
  // "enter", not "return": the first page took only "return"
  it('a newline (Ctrl+J) begins the setup too', async () => {
    expect(await firstRunAnd('C-j')).toEqual({ key: 'C-j', raw: true, acted: 'setup began' });
  }, 90_000);
  it('q leaves: the monitor ends (0) and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('q')).toEqual({ key: 'q', raw: true, exit: 0, tty: 'same', alternate: '0' });
  }, 90_000);
  it('Esc leaves: the monitor ends (0) and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('Escape')).toEqual({ key: 'Escape', raw: true, exit: 0, tty: 'same', alternate: '0' });
  }, 90_000);
  it('Ctrl+C ends it with 130 and the terminal comes back as it was', async () => {
    expect(await firstRunAnd('C-c')).toEqual({ key: 'C-c', raw: true, exit: 130, tty: 'same', alternate: '0' });
  }, 90_000);
});
