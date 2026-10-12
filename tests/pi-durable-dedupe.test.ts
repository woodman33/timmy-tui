/**
 * Pi Durable S1 (R4 H118), plan i.2: duplicate submission and resume. REAL: Pi worker processes started by the
 * supervisor (two at once in the last case), SIGKILL, pi-durable 1.1.0's SQLite store and its request-id dedupe, the
 * exclusive lock, the socket protocol. FAKE: the model (pi-ai's scripted faux provider) and the fixture projects.
 *
 * - The same key twice: one Pi submission; the second delegation is refused with words naming the run (plan c.3).
 * - The same request id after a restart: the worker's Resume submits each live run's task again with its own request
 *   id, and pi-durable hands back the same submission (spike A1: "submission 8 again"); a delegation repeated across the
 *   restart is refused, naming the run, from the store's own submission record.
 * - Two ensureWorker calls at once: one worker. The second start finds the store locked and exits 3; its caller
 *   attaches to the first. Both callers then reach the same worker, and a key delegated from both at once makes one
 *   submission.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readOwner } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { anyAlive, alive, cleanup, delegate, ended, fauxCalls, INSTALLED, killWorker, project, reads, SKIP_WHY, sleep, start, status, until } from './helpers/pi-durable.js';

afterAll(() => { cleanup(); });

const quick = { first: { text: 'FAKE answer.' } } as const;

describe.skipIf(!INSTALLED)(`duplicate submission and resume (plan i.2)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('the same key twice: one submission; the second is refused with words, while it runs and after it ended', async () => {
    const root = project('dedupe-key', { 'b.txt': 'x' });
    const a = await start(root);
    const first = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 1500 } } }, { key: 'K-1' });
    expect(first).toMatchObject({ ok: true, started: true });
    const whileRunning = await delegate(a.client, quick, { key: 'K-1' });
    expect(whileRunning.ok).toBe(false);
    expect(whileRunning.refused).toBe(`the key K-1 was already used: Pi run ${first.run} (submission ${first.submission}, placed)`);
    expect(whileRunning.run).toBe(first.run);
    const end = await ended(a.client, first.run);
    expect(end.status).toBe('completed');
    const afterEnd = await delegate(a.client, quick, { key: 'K-1' });
    expect(afterEnd.refused).toBe(`the key K-1 was already used: Pi run ${first.run} (submission ${first.submission}, done)`);
    const list = await a.client.request<{ runs: { run: string; key: string }[] }>('list');
    expect(list.runs.filter((r) => r.key === 'K-1')).toHaveLength(1);
    expect((await status(a.client, first.run)).user_entries).toBe(1);
    // another key is another run
    const other = await delegate(a.client, quick, { key: 'K-2' });
    expect(other.ok).toBe(true);
    expect(other.run).not.toBe(first.run);
    await ended(a.client, other.run);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('the same request id after a restart: the store gives back the same submission; a repeated delegation is refused, naming the run', async () => {
    const root = project('dedupe-restart', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 6000 } } }, { key: 'K-R' });
    expect(d.request_id).toBe(`timmy:${d.run}:1`);
    await until('the read to be running', () => reads(root, d.run).length === 1);
    a.client.close();
    await killWorker(root);

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('paused');
    const again = await delegate(b.client, quick, { key: 'K-R' });
    expect(again.ok).toBe(false);
    expect(again.refused).toBe(`the key K-R was already used: Pi run ${d.run} (submission ${d.submission}, placed)`);
    const resumed = await b.client.request<{ resumed: { run: string; submission: number; same: boolean }[] }>('resume');
    expect(resumed.resumed).toEqual([{ run: d.run, submission: d.submission, same: true }]);
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('completed');
    expect(end.submission).toMatchObject({ id: d.submission, status: 'done', request_id: d.request_id });
    expect(end.resubmitted).toEqual([expect.objectContaining({ submission: d.submission, same: true })]);
    expect(end.user_entries).toBe(1); // one input in the transcript: no second submission was placed
    expect(fauxCalls(root, d.run).filter((c) => c.last_role === 'user')).toHaveLength(1);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('two ensureWorker calls at once: one worker; the second start exits 3 and its caller attaches; one submission for one key', async () => {
    const root = project('dedupe-two');
    const [x, y] = await Promise.all([start(root), start(root)]);
    expect(x.client.hello.pid).toBe(y.client.hello.pid);
    const owner = readOwner(piPaths(root))!;
    expect(owner.pid).toBe(x.client.hello.pid);
    const hows = [x.how, y.how].sort();
    expect(hows).toEqual(['attached after exit 3', 'started']);
    const loser = x.how === 'started' ? y : x;
    expect(loser.spawned).toBeDefined();
    expect(loser.spawned).not.toBe(owner.pid);
    expect(loser.spawnedExit).toBe(3);
    expect(alive(loser.spawned!)).toBe(false);
    expect(alive(owner.pid)).toBe(true);

    const [p, q] = await Promise.all([delegate(x.client, quick, { key: 'K-both' }), delegate(y.client, quick, { key: 'K-both' })]);
    const started = [p, q].filter((r) => r.ok);
    const refused = [p, q].filter((r) => !r.ok);
    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].refused).toMatch(new RegExp(`^the key K-both was already used: Pi run ${started[0].run} \\(submission ${started[0].submission}, `));
    await ended(x.client, started[0].run);
    expect((await x.client.request<{ runs: unknown[] }>('list')).runs).toHaveLength(1);
    await x.client.request('shutdown');
    x.client.close();
    y.client.close();
    await until('the worker to exit', () => !alive(owner.pid), 20_000);
  });

  it('leaves no worker running', async () => {
    await sleep(1000);
    cleanup();
    expect(anyAlive()).toEqual([]);
  });
});
