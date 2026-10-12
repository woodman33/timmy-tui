/**
 * Pi Durable S1 (R4 H118), plan i.8: one store, one owner. REAL: Pi worker processes (node --import tsx, detached, as
 * the supervisor starts them), pi-durable 1.1.0's SQLite store opened with `locking_mode = EXCLUSIVE`, SIGKILL, and
 * node:sqlite openers in this process. FAKE: the model of the one run (pi-ai's scripted faux provider) and the fixture
 * project (a temporary folder).
 *
 * Reproduces H115's spike I: a second opener of a held store fails with "database is locked"; after the holder is
 * SIGKILLed the operating system has released the lock, and the next opener finds the data intact. The worker that
 * finds the store held exits 3 and names the owner (spike C is why: an unlocked second opener rewrote the owner's work).
 */
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { readOwner } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { workerCommand } from '../src/pi-durable/supervisor.js';
import { anyAlive, cleanup, delegate, ended, INSTALLED, killWorker, project, SKIP_WHY, start, status } from './helpers/pi-durable.js';

afterAll(() => { cleanup(); });

/** Runs one worker process directly (not through the supervisor) and waits for it to exit. */
function runWorker(root: string): Promise<{ code: number | null; stderr: string; ms: number }> {
  const { command, args } = workerCommand();
  const t0 = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args, '--project', root], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('exit', (code) => { clearTimeout(kill); resolveRun({ code, stderr, ms: Date.now() - t0 }); });
  });
}

describe.skipIf(!INSTALLED)(`the Pi worker's store lock (plan i.8, spike I)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('a second worker on a held store fails "database is locked", exits 3 naming the owner; the owner still answers', async () => {
    const root = project('lock-second');
    const a = await start(root);
    expect(a.how).toBe('started');
    const owner = readOwner(piPaths(root));
    expect(owner?.pid).toBe(a.client.hello.pid);

    const second = await runWorker(root);
    expect(second.code).toBe(3);
    expect(second.stderr).toMatch(/database is locked/);
    expect(second.stderr).toContain(`pid ${owner!.pid}`);
    // the loser wrote nothing over the owner's record
    expect(readOwner(piPaths(root))?.pid).toBe(owner!.pid);
    const hello = await a.client.request<{ pid: number; project_id: string }>('hello', { token: 'ignored after the first hello' });
    expect(hello.pid).toBe(owner!.pid);
    a.client.close();
  });

  it('a plain node:sqlite reader (what a UI must never be) is refused too while the worker holds the store', async () => {
    const root = project('lock-reader');
    const a = await start(root);
    const { DatabaseSync } = await import('node:sqlite');
    const t0 = Date.now();
    let error = '';
    try {
      const d = new DatabaseSync(piPaths(root).store, { timeout: 500 });
      try { d.prepare('SELECT count(*) AS n FROM conversations').get(); } finally { d.close(); }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    expect(error).toMatch(/database is locked/);
    expect(Date.now() - t0).toBeLessThan(20_000);
    a.client.close();
  });

  it('after the holder is SIGKILLed the lock is released: the next worker opens the store with its data intact', async () => {
    const root = project('lock-kill');
    const a = await start(root);
    const d = await delegate(a.client, { first: { text: 'FAKE answer kept across the kill.' } });
    expect(d.ok).toBe(true);
    const before = await ended(a.client, d.run);
    expect(before.status).toBe('completed');
    a.client.close();

    const killed = await killWorker(root);
    const t0 = Date.now();
    const b = await start(root);
    const reopenMs = Date.now() - t0;
    expect(b.how).toBe('started');
    expect(b.client.hello.pid).not.toBe(killed);
    // nothing was live, so the new worker is not paused
    expect(b.client.hello.scheduling).toBe('running');
    const after = await status(b.client, d.run);
    expect(after.status).toBe('completed');
    expect(after.submission?.id).toBe(before.submission?.id);
    expect(after.entries.map((e) => e.kind)).toEqual(before.entries.map((e) => e.kind));
    expect(after.entries.at(-1)?.text).toBe('FAKE answer kept across the kill.');
    expect(reopenMs).toBeLessThan(45_000);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running', async () => {
    cleanup();
    expect(anyAlive()).toEqual([]);
  });
});
