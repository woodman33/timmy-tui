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
      // The companion starts after the first paint, so on a loaded machine its note can land seconds after
      // the screen is up (SUITE-01 once read the log too early): wait for the note itself, then look at
      // the screen, which by then would show the note if it were drawn there.
      const file = join(h.repo, 'logs', 'companion.log');
      const note = new RegExp(`Companion port ${port} busy; using \\d+\\.`);
      const read = (): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
      for (const end = Date.now() + 30_000; !note.test(read()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      // The operator's 22:23 order: the port the note names is one the companion may take (cli.tsx tries the
      // port asked for, then the next three) and the companion answers there, on its read-only canvas route.
      const used = Number(new RegExp(`Companion port ${port} busy; using (\\d+)\\.`).exec(read())?.[1]);
      const answer = await fetch(`http://127.0.0.1:${used}/api/canvas`, { signal: AbortSignal.timeout(5000) })
        .then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }), (e: Error) => ({ status: 0, body: { error: e.message } as Record<string, unknown> }));
      expect({ allowed: used > port && used <= port + 3, status: answer.status, jobs: Array.isArray(answer.body.jobs), open: typeof answer.body.open })
        .toEqual({ allowed: true, status: 200, jobs: true, open: 'string' });
      await new Promise((r) => setTimeout(r, 500));
      const screen = h.tmux('capture-pane', '-p', '-t', 't');
      expect({ top: screen.split('\n')[0].slice(0, 5), onScreen: /busy; using/.test(screen), logged: note.test(read()) })
        .toEqual({ top: 'TIMMY', onScreen: false, logged: true });
    } finally {
      await h.dispose();
      taken.close();
    }
  }, 90_000);
});
