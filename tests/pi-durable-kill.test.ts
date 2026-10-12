/**
 * Pi Durable S1 (R4 H118), plan i.1: termination and restart. REAL: Pi worker processes (detached, started by the
 * supervisor), SIGKILL from this test at a chosen point, pi-durable 1.1.0's SQLite store and recovery, the effect
 * ledger and its reconciliation, the guard, project files. FAKE: the model (pi-ai's scripted faux provider, one script
 * per run: no request leaves the machine; its requests are logged to .timmy/pi/faux-calls.jsonl) and the fixture
 * projects. The kill window is a tool's `delay_ms` (S1's fixture tools) or a slow FAKE stream (tokens_per_second).
 *
 * Each case reproduces one of H115's spike runs, now through Timmy's worker:
 * (a) SIGKILL during a safe read: it reruns by itself after the restart: 2 reads, one result (spike B).
 * (b) SIGKILL during an unsafe write: the call comes back "interrupted and may have partially run"; the ledger shows
 *     `started` with no end; the restarted worker reads the file back and ends the entry (observed); the FAKE model's
 *     repeat writes nothing (compare-and-set): one effect (spikes A0–A3, with Timmy's reconcile).
 * (c) SIGKILL during a model stream: the partial becomes an aborted assistant entry, the request is sent again, and
 *     the cost words say unknown (spike G).
 * A restarted worker holding live work starts PAUSED; nothing runs until Resume.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { IN_FLIGHT_COST } from '../src/pi-durable/worker.js';
import { anyAlive, cleanup, delegate, effects, ended, fauxCalls, INSTALLED, killWorker, project, reads, sha, SKIP_WHY, sleep, start, status, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

describe.skipIf(!INSTALLED)(`SIGKILL of the Pi worker and its restart (plan i.1)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('(a) during a safe read: paused at restart, then the read reruns by itself: 2 reads, one result (spike B)', async () => {
    const root = project('kill-read', { 'b.txt': 'read me' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 6000 } } });
    expect(d.ok).toBe(true);
    await until('the read to be running', () => reads(root, d.run).length === 1);
    a.client.close();
    const killed = await killWorker(root);

    const b = await start(root);
    expect(b.client.hello.pid).not.toBe(killed);
    expect(b.client.hello.scheduling).toBe('paused');
    const paused = await status(b.client, d.run);
    expect(paused.status).toBe('interrupted');
    expect(paused.tasks.find((t) => t.kind === 'pi.tool')).toMatchObject({ status: 'pending', phase: 'execute' });
    await sleep(500);
    expect(reads(root, d.run)).toHaveLength(1); // paused: nothing reran yet

    const resumed = await b.client.request<{ resumed: { run: string; submission: number; same: boolean }[] }>('resume');
    expect(resumed.resumed).toEqual([{ run: d.run, submission: d.submission, same: true }]);
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('completed');
    const r = reads(root, d.run);
    expect(r).toHaveLength(2);
    expect(r[1].call_id).toBe(r[0].call_id); // the same call, rerun
    expect(r[1].pid).not.toBe(r[0].pid);
    expect(end.entries.filter((e) => e.kind === 'pi.tool-result')).toHaveLength(1);
    expect(end.entries.at(-1)?.text).toBe('Done (FAKE answer).');
    expect(fauxCalls(root, d.run)).toHaveLength(2); // the first request, and the answer after the read: no extra request
    expect(end.submission?.id).toBe(d.submission);
    expect(end.user_entries).toBe(1);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('(b) during an unsafe write: interrupted, ledger started; the restart reconciles it by sha256; the repeat writes nothing: one effect', async () => {
    const root = project('kill-write', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: 15_000 } } });
    expect(d.ok).toBe(true);
    await until('the write to have happened, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    expect(effects(root, d.run).map((e) => e.state)).toEqual(['started']);

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('paused');
    const paused = await status(b.client, d.run);
    expect(paused.status).toBe('interrupted');
    expect(paused.tasks.find((t) => t.kind === 'pi.tool')).toMatchObject({ phase: 'execute' });
    const reconciled = effects(root, d.run).at(-1)!;
    expect(reconciled).toMatchObject({ state: 'ended', by: 'reconcile', readback: { sha256: sha('new bytes') } });
    expect(reconciled.outcome).toMatch(/the file has the new bytes/);

    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('completed');
    const results = end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text);
    expect(results[0]).toMatch(/Tool slow_write was interrupted and may have partially run/);
    expect(results[1]).toMatch(/no write: a\.txt already has these bytes/);
    expect(effects(root, d.run).filter((e) => e.state === 'started')).toHaveLength(1); // one effect
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new bytes');
    await b.client.request('shutdown');
    b.client.close();
  });

  it('(c) during a model stream: the partial becomes an aborted entry, the request is sent again, the cost is unknown (spike G)', async () => {
    const root = project('kill-stream');
    const a = await start(root);
    const d = await delegate(a.client, { first: { text: 'A long FAKE answer ', repeat: 30 }, tokens_per_second: 20 });
    expect(d.ok).toBe(true);
    await until('the FAKE model to be streaming', () => fauxCalls(root, d.run).length === 1);
    await sleep(2500); // partials are committed every 100 ms
    a.client.close();
    await killWorker(root);

    const b = await start(root);
    expect(b.client.hello.scheduling).toBe('paused');
    const paused = await status(b.client, d.run);
    expect(paused.status).toBe('interrupted');
    expect(paused.tasks.find((t) => t.kind === 'pi.generation')).toMatchObject({ phase: 'request' });
    expect(paused.cost).toMatchObject({ usd: null, basis: 'unknown', measured: false, words: IN_FLIGHT_COST });
    expect(fauxCalls(root, d.run)).toHaveLength(1);

    await b.client.request('resume');
    const end = await ended(b.client, d.run, 90_000);
    expect(end.status).toBe('completed');
    const calls = fauxCalls(root, d.run);
    expect(calls).toHaveLength(2); // the request in flight at the kill was sent again
    expect(calls[1].last_role).toBe('user');
    const assistant = end.entries.filter((e) => e.kind === 'pi.assistant');
    expect(assistant.map((e) => e.stop)).toEqual(['aborted', 'stop']);
    expect(assistant[0].text.length).toBeGreaterThan(0);
    expect(end.cost).toMatchObject({ usd: null, words: IN_FLIGHT_COST }); // the resend does not make the cost known again
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
