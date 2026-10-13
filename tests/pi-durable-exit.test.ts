/**
 * Pi Durable S1 (R4 H118), fix S3 of H119's review: the worker's exit cannot be held open by a connection. REAL: a Pi
 * worker process started by the supervisor, its Unix socket, pi-durable 1.1.0's Harness.close (which waits for a tool
 * that ignores its abort signal: spike D2), a raw connection that never says hello, and a late client with the right
 * token. FAKE: the model (pi-ai's scripted faux provider) and the fixture project.
 *
 * Before the fix the worker's exit waited for every connection to end, ended only authenticated ones, and still
 * accepted hello while closing: a Timmy attaching during the exit kept the worker alive forever, holding the store's
 * lock and worker.json while no longer listening. Now a hello while closing is refused with words, every connection is
 * ended, and the wait for them has a time limit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readOwner } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { PiClient } from '../src/pi-durable/protocol.js';
import { alive, anyAlive, cleanup, delegate, effects, INSTALLED, project, sha, SKIP_WHY, start, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
const sockets: Socket[] = [];
afterAll(() => { for (const s of sockets) s.destroy(); cleanup(); });

describe.skipIf(!INSTALLED)(`the worker's exit (fix S3)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('while the worker shuts down, a late hello is refused with words, an idle connection does not hold it, and it exits and withdraws its record (S3)', async () => {
    const root = project('exit-during-shutdown', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const pid = a.client.hello.pid;
    const owner = readOwner(piPaths(root))!;
    const token = readFileSync(piPaths(root).token, 'utf8').trim();
    // a tool that ignores its abort signal keeps the Harness closing for about 4 s: the window this test attaches in
    const d = await delegate(a.client, { first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: 4000, ignore_abort: true } } });
    await until('the deaf write to be running', () => effects(root, d.run).some((e) => e.state === 'started'));
    await a.client.request('shutdown');
    // a connection that never says hello
    const idle = createConnection(owner.socket);
    sockets.push(idle);
    idle.on('error', () => undefined);
    await new Promise<void>((r) => { idle.once('connect', () => r()); });
    // a Timmy that says hello now, with the right token
    await expect(PiClient.connect(owner.socket, { token, pid: process.pid, surface: 'late-timmy' }, 5000)).rejects.toThrow(/^the Pi worker is shutting down/);
    await until('the worker to exit', () => !alive(pid), 30_000, 50);
    expect(existsSync(piPaths(root).owner)).toBe(false);
    expect(existsSync(owner.socket)).toBe(false);
    expect(readFileSync(piPaths(root).log, 'utf8')).toMatch(/exited cleanly; 1 live run\(s\) recorded paused/);
    a.client.close();
  });

  it('leaves no worker running: every worker this file started has exited', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
