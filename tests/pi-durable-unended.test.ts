/**
 * Pi Durable S1 (R4 H118), fix S5 of H119's review: no run stays unended. Before the fix, a worker that found nothing
 * live at its start never followed or placed the runs not ended: a run whose submission settled before its end was
 * written, and a run recorded but never submitted (a kill between its record and its conversation or submission, or a
 * placement that threw), stayed unended for good, and Timmy's start-up pass counted them as pending on every start
 * (starting a worker each time). Resume skipped a run with no conversation the same way.
 *
 * Now, whenever scheduling starts (the worker's start with nothing live, and Resume), every run not ended is followed
 * when its submission exists (an end that settled already is recorded at once), placed again by its request id when it
 * never submitted (pi-durable dedupes the request id), or ended with words when placing it fails.
 *
 * REAL: Pi worker processes started by the supervisor, SIGKILL, pi-durable 1.1.0's store, Timmy's start-up pass
 * (recoverOnStart). FAKE: the model (pi-ai's scripted faux provider), the fixture projects, and the run records this
 * test writes or edits while no worker runs (the states a kill at the wrong moment leaves).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { piPaths } from '../src/pi-durable/paths.js';
import type { TranscriptResult } from '../src/pi-durable/protocol.js';
import { readRun, RUN_SCHEMA, writeRun, type RunFile } from '../src/pi-durable/runs.js';
import { recoverOnStart } from '../src/pi-durable/supervisor.js';
import { anyAlive, cleanup, delegate, ended, INSTALLED, killWorker, project, reads, SKIP_WHY, start, status, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

/** A run record as delegate writes it before placing the run: FAKE, written by the test while no worker runs. */
const recorded = (root: string, run: string, extra: Partial<RunFile> = {}): RunFile => writeRun(piPaths(root), {
  schema: RUN_SCHEMA, run, task: 'FAKE task recorded but never placed', request_id: `timmy:${run}:1`,
  model: { route: 'faux', provider: `faux-${run}`, model: 'faux-1', fake: true, script: { first: { text: `FAKE answer of run ${run} after its placement.` } } },
  created: new Date().toISOString(), updated: '', ...extra,
});

describe.skipIf(!INSTALLED)(`no run stays unended (fix S5)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('a run whose submission settled before its end was written: the next worker records its end at start; nothing stays pending', async () => {
    const root = project('unended-settled');
    const a = await start(root);
    const d = await delegate(a.client, { first: { text: 'FAKE answer.' } });
    expect((await ended(a.client, d.run)).status).toBe('completed');
    await a.client.request('shutdown');
    a.client.close();
    await until('the worker to exit', () => anyAlive().length === 0, 30_000);
    // the state a kill between the settle and the record leaves: the store says done, the run record has no end
    const r = readRun(piPaths(root), d.run)!;
    writeRun(piPaths(root), { ...r, ended: null });

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('running'); // nothing live: the worker runs
    await until('the end to be recorded', () => readRun(piPaths(root), d.run)?.ended?.status === 'completed', 15_000);
    expect(await recoverOnStart(root)).toEqual({ started: false, resumed: false, words: 'nothing pending: the Pi worker is not started' });
    await b.client.request('shutdown');
    b.client.close();
  });

  it('a run recorded but never placed (no conversation): the next worker places it at start, by its request id, and it runs to its end', async () => {
    const root = project('unended-unplaced');
    recorded(root, 'aaaa0001');
    const a = await start(root);
    expect(a.client.hello.scheduling).toBe('running');
    const end = await ended(a.client, 'aaaa0001', 30_000);
    expect(end.status).toBe('completed');
    expect(end.submissions).toHaveLength(1);
    expect(end.submission?.request_id).toBe('timmy:aaaa0001:1');
    expect(end.resubmitted).toEqual([expect.objectContaining({ submission: end.submissions[0], same: false, first: true })]);
    const t = await a.client.request<TranscriptResult>('transcript', { run: 'aaaa0001' });
    expect(t.entries.at(-1)?.text).toBe('FAKE answer of run aaaa0001 after its placement.');
    expect(await recoverOnStart(root)).toEqual({ started: false, resumed: false, words: 'nothing pending: the Pi worker is not started' });
    await a.client.request('shutdown');
    a.client.close();
  });

  it('a run whose placement fails at start is ended with words, not left pending', async () => {
    const root = project('unended-broken');
    recorded(root, 'aaaa0002', { conversation: 424_242 }); // a conversation the store does not have
    const a = await start(root);
    await until('the run to be ended', () => readRun(piPaths(root), 'aaaa0002')?.ended, 15_000);
    const s = await status(a.client, 'aaaa0002') as Awaited<ReturnType<typeof status>> & { ended: { status: string; why?: string } };
    expect(s.status).toBe('failed');
    expect(s.ended.why).toMatch(/^its task could not be placed again when the worker started: conversation 424242 of run aaaa0002 is missing from the store; nothing of it ran$/);
    expect(await recoverOnStart(root)).toEqual({ started: false, resumed: false, words: 'nothing pending: the Pi worker is not started' });
    await a.client.request('shutdown');
    a.client.close();
  });

  it('paused at start (another run holds live work): a run never placed is placed at Resume, and both end', async () => {
    const root = project('unended-resume', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 6000 } } });
    await until('the read to be running', () => reads(root, d.run).length === 1);
    a.client.close();
    await killWorker(root);
    recorded(root, 'aaaa0003');

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('paused');
    expect((await status(b.client, 'aaaa0003')).status).toBe('queued');
    await b.client.request('resume');
    expect((await ended(b.client, d.run)).status).toBe('completed');
    const end = await ended(b.client, 'aaaa0003', 30_000);
    expect(end.status).toBe('completed');
    expect(end.resubmitted).toEqual([expect.objectContaining({ same: false, first: true })]);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
