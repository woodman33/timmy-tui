/**
 * Pi Durable S1 (R4 H118), plan i.4: cancellation and pausing. REAL: Pi worker processes started by the supervisor,
 * pi-durable 1.1.0's Conversation.abort, Harness.abortTask, Harness.close and recovery, the effect ledger, project
 * files, the store lock. FAKE: the model (pi-ai's scripted faux provider; its requests are logged) and the fixture
 * projects. A tool that honours or ignores its abort signal is S1's fixture write with `ignore_abort`.
 *
 * - Stop while a tool honours its signal: the stop returns in milliseconds (spike D1: 6 ms); the ledger, read back,
 *   says the write had already happened.
 * - Stop while a tool ignores its signal: the stop waits for the tool (spike D2: 5 s) and Pi records the call "aborted",
 *   while the ledger's readback shows the work completed: Timmy reports the ledger, not Pi's word.
 * - Stop while paused, then Resume: settles the plan's open question (b.3, risk k.18) whether Harness.abortTask on a
 *   paused worker settles: it returns "marked" at once and the run does NOT settle while paused (its tasks stay live,
 *   abort-marked, its submission placed); the mark persists, and at Resume the run ends cancelled with no new progress
 *   (no read, no model request).
 * - Pause on exit (the default the plan proposes; the operator has not decided it): `shutdown` closes the Harness,
 *   records `paused` on each live run, withdraws worker.json and exits; the next worker starts paused and shows the run
 *   paused (not interrupted); Resume continues it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readOwner } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import { alive, anyAlive, cleanup, delegate, effects, ended, fauxCalls, INSTALLED, project, reads, sha, SKIP_WHY, sleep, start, status, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

const write = (delay: number, ignore = false) => ({
  first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: delay, ...(ignore ? { ignore_abort: true } : {}) } },
});

describe.skipIf(!INSTALLED)(`Stop, pause and resume (plan i.4)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('Stop while a tool honours its signal: answered in ms; the run ends cancelled; the ledger says the write happened (D1)', async () => {
    const root = project('pause-d1', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, write(20_000));
    await until('the write to be running', () => effects(root, d.run).some((e) => e.state === 'started'));
    const stop = await a.client.request<{ result: string; ms: number; status: string }>('stop', { run: d.run });
    expect(stop.result).toMatch(/^aborted/);
    expect(stop.ms).toBeLessThan(5000);
    expect(stop.status).toBe('cancelled');
    const s = await status(a.client, d.run);
    expect(s.submission).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    expect(s.stop_requested).toMatchObject({ by: 'test' });
    expect(s.entries.find((e) => e.kind === 'pi.tool-result')?.text).toMatch(/Tool slow_write was aborted/);
    const ledger = effects(root, d.run);
    expect(ledger.map((e) => e.state)).toEqual(['started', 'ended']);
    expect(ledger[1].outcome).toBe('stopped by its abort signal after the write');
    expect(ledger[1].readback).toEqual({ sha256: sha('new bytes') });
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new bytes');
    await a.client.request('shutdown');
    a.client.close();
  });

  it('Stop while a tool ignores its signal: the stop waits for it; Pi says "aborted", the ledger shows the work completed (D2)', async () => {
    const root = project('pause-d2', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, write(3000, true));
    await until('the write to be running', () => effects(root, d.run).some((e) => e.state === 'started'));
    const stop = await a.client.request<{ result: string; ms: number; status: string }>('stop', { run: d.run });
    expect(stop.ms).toBeGreaterThan(1500);
    expect(stop.status).toBe('cancelled');
    const s = await status(a.client, d.run);
    expect(s.entries.find((e) => e.kind === 'pi.tool-result')?.text).toMatch(/Tool slow_write was aborted/);
    const ledger = effects(root, d.run);
    expect(ledger.map((e) => e.state)).toEqual(['started', 'ended']);
    expect(ledger[1].outcome).toBe('written');
    expect(ledger[1].readback).toEqual({ sha256: sha('new bytes') });
    await a.client.request('shutdown');
    a.client.close();
  });

  it('Stop while paused, then Resume: abortTask is marked but does not settle while paused; at Resume the run ends cancelled with no new progress', async () => {
    const root = project('pause-stop', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 20_000 } } });
    await until('the read to be running', () => reads(root, d.run).length === 1);
    const paused = await a.client.request<{ scheduling: string; runs: string[] }>('pause');
    expect(paused).toEqual({ scheduling: 'paused', runs: [d.run] });
    expect(readOwner(piPaths(root))?.scheduling).toBe('paused');
    // the paused worker still holds the store: its lock was never let go by the pause
    expect((await status(a.client, d.run)).status).toBe('paused');

    const stop = await a.client.request<{ result: string; ms: number; status: string }>('stop', { run: d.run });
    expect(stop.result).toMatch(/^abort marked while paused: .*task \d+ \(pi\.generation\) marked/);
    expect(stop.ms).toBeLessThan(5000);
    // the open question (plan b.3, k.18): abortTask on a paused worker commits the mark and returns; it does not settle
    await sleep(1500);
    const held = await status(a.client, d.run);
    expect(held.status).toBe('paused');
    expect(held.submission?.status).toBe('placed');
    expect(held.tasks.length).toBeGreaterThan(0);
    expect(held.tasks.every((t) => t.abort_requested)).toBe(true);
    expect(held.ended).toBeNull();
    const readsBefore = reads(root, d.run).length;
    const callsBefore = fauxCalls(root, d.run).length;

    await a.client.request('resume');
    const end = await ended(a.client, d.run);
    expect(end.status).toBe('cancelled');
    expect(end.submission).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    expect(end.tasks).toEqual([]);
    await sleep(500);
    expect(reads(root, d.run)).toHaveLength(readsBefore); // the replay-safe read did not run again
    expect(fauxCalls(root, d.run)).toHaveLength(callsBefore); // and no model request went out
    await a.client.request('shutdown');
    a.client.close();
  });

  it('pause on exit: shutdown records the live run paused and exits; the next worker starts paused, shows it paused, and Resume continues it', async () => {
    const root = project('pause-exit', { 'b.txt': 'x' });
    const a = await start(root);
    const pid = a.client.hello.pid;
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 4000 } } });
    await until('the read to be running', () => reads(root, d.run).length === 1);
    expect(await a.client.request<{ on_exit: string }>('shutdown')).toMatchObject({ on_exit: 'pause' });
    a.client.close();
    await until('the worker to exit', () => !alive(pid), 30_000);
    const p = piPaths(root);
    expect(existsSync(p.owner)).toBe(false);
    expect(existsSync(p.token)).toBe(false);
    expect(readFileSync(p.log, 'utf8')).toMatch(/exited cleanly; 1 live run\(s\) recorded paused/);

    const b = await start(root);
    expect(b.how).toBe('started');
    expect(b.client.hello.scheduling).toBe('paused');
    const s = await status(b.client, d.run);
    expect(s.status).toBe('paused');
    expect(s.paused?.why).toMatch(/^Timmy exited \(shutdown asked by test\)/);
    expect(s.interrupted).toBeNull();
    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('completed');
    expect(end.entries.filter((e) => e.kind === 'pi.tool-result')).toHaveLength(1);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
