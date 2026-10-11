import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lanAddresses } from '../src/utils/local-request.js';
import { LOADER, MONITOR, monitorHome } from './fixtures/ui-monitor-home.js';

/** A port nothing listens on now (the monitor's companion takes it). */
async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

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
      // port asked for, then the next three) and the companion answers there. R4 (H84): on its canvas route it asks for
      // its token (the page itself is open), and its log names its address without the token and says where it is shown.
      const used = Number(new RegExp(`Companion port ${port} busy; using (\\d+)\\.`).exec(read())?.[1]);
      const answer = await fetch(`http://127.0.0.1:${used}/api/canvas`, { signal: AbortSignal.timeout(5000) })
        .then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }), (e: Error) => ({ status: 0, body: { error: e.message } as Record<string, unknown> }));
      const page = await fetch(`http://127.0.0.1:${used}/`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status, () => 0);
      expect({ allowed: used > port && used <= port + 3, status: answer.status, words: /timmy watch/.test(String(answer.body.error)), page })
        .toEqual({ allowed: true, status: 401, words: true, page: 200 });
      for (const end = Date.now() + 10_000; !/\[Browser companion\]/.test(read()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      expect({ address: read().includes(`http://127.0.0.1:${used}/`), where: /press q on the monitor's HOME/.test(read()), token: /#t=[0-9a-f]{64}/.test(read()) })
        .toEqual({ address: true, where: true, token: false });
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

describe('the monitor\'s pairing card (q on HOME)', () => {
  // R4 (H84): the companion's address carries its token, so the monitor shows it only on its pairing card (q on HOME), where
  // the operator started it; with --lan, the card adds the network address as a QR code and says what that means.
  it('q on HOME shows the companion\'s address with its token; with --lan its network address, its QR code and plain words', async () => {
    for (const lan of [false, true]) {
      const port = await freePort();
      const h = monitorHome('initialized');
      try {
        h.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 't', '-x', '170', '-y', '60', '-c', h.repo, 'bash', '--norc', '-c',
          `${process.execPath} --import ${LOADER} ${MONITOR} --companion-port ${port}${lan ? ' --lan' : ''}; sleep 30`);
        await h.waitFor(/YOUR JOURNEY/, 45_000);
        const file = join(h.repo, 'logs', 'companion.log');
        const read = (): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
        for (const end = Date.now() + 30_000; !/\[Browser companion\]/.test(read()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
        h.tmux('send-keys', '-t', 't', 'q');
        await h.waitFor(/COMPANION PAIR/, 15_000);
        const local = (await h.waitFor(new RegExp(`http://127\\.0\\.0\\.1:${port}/#t=([0-9a-f]{64})`), 15_000))[1];
        const ok = await fetch(`http://127.0.0.1:${port}/api/auth`, { headers: { Authorization: `Bearer ${local}` } }).then((r) => r.json() as Promise<Record<string, unknown>>);
        expect(ok).toEqual({ ok: true, lan });
        const screen = h.tmux('capture-pane', '-p', '-t', 't');
        // the log never holds the token, with or without --lan
        expect(read().includes(local)).toBe(false);
        if (!lan) {
          expect(screen).toMatch(/timmy watch --lan/);
          continue;
        }
        expect(screen).toMatch(/plain HTTP on your local network/);
        expect(screen).toMatch(/QR code holds the token/);
        expect(screen).toMatch(/only on a network you trust/);
        expect(screen).toMatch(/[▀▄█]{6}/);
        const a = lanAddresses()[0];
        if (!a) { console.warn('ui-monitor-companion-pty: no network address here, so the --lan address was not checked'); continue; }
        expect(screen).toContain(`http://${a}:${port}/#t=${local}`);
        const there = (auth: boolean): Promise<number> => fetch(`http://${a}:${port}/api/auth`, { headers: auth ? { Authorization: `Bearer ${local}` } : {} }).then((r) => r.status);
        expect([await there(false), await there(true)]).toEqual([401, 200]);
        expect(read()).toContain(`http://${a}:${port}/`);
      } finally {
        await h.dispose();
      }
    }
  }, 180_000);
});
