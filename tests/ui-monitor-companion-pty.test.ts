import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOADER, MONITOR, monitorHome } from './fixtures/ui-monitor-home.js';

// Fourth order, step 2, found in Terminal on the Mac (row 52): with the companion's port taken, the
// monitor wrote "Companion port ... busy; using ..." over its own screen, in dim, above its header.
// The screen holds only the monitor; the note goes to the companion's log, beside its URL and QR code.
describe('the monitor and a companion port that is taken', () => {
  it('keeps the note off the screen and writes it to the companion\'s log', async () => {
    const taken = createServer().listen(0);
    await new Promise((r) => taken.once('listening', r));
    const port = (taken.address() as AddressInfo).port;
    const h = monitorHome('initialized');
    try {
      h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '120', '-y', '40', '-c', h.repo, 'bash', '--norc', '-c',
        `${process.execPath} --import ${LOADER} ${MONITOR} --companion-port ${port}; sleep 30`);
      await h.waitFor(/YOUR JOURNEY/, 45_000);
      await new Promise((r) => setTimeout(r, 1_500));
      const screen = h.tmux('capture-pane', '-p', '-t', 't');
      const log = readFileSync(join(h.repo, 'logs', 'companion.log'), 'utf8');
      expect({ top: screen.split('\n')[0].slice(0, 5), onScreen: /busy; using/.test(screen), logged: log.includes(`Companion port ${port} busy; using ${port + 1}.`) })
        .toEqual({ top: 'TIMMY', onScreen: false, logged: true });
    } finally {
      await h.dispose();
      taken.close();
    }
  }, 90_000);
});
