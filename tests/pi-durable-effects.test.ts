/**
 * Pi Durable S1 (R4 H118), plan i.3: interrupted side effects. REAL: Pi worker processes started by the supervisor,
 * SIGKILL, pi-durable 1.1.0's recovery ("interrupted and may have partially run"), the effect ledger
 * (.timmy/pi/effects.jsonl), the reconciler, the guard hooks and the host abort, project files and their sha256. FAKE:
 * the model (pi-ai's scripted faux provider; this script repeats a refused call as H115's looping model did, spike A1)
 * and the fixture projects. The reconciler's three outcomes are also checked in this process, on a ledger written by
 * hand (no worker).
 *
 * - A compare-and-set write killed after the write and before `ended` reconciles by sha256 to `ended (observed)`.
 * - The model repeating an interrupted write whose outcome is unknown (the file now has neither the old nor the new
 *   bytes) is refused by the guard: one effect (A0 had two without the guard; A3 one with it), and the run is aborted at
 *   that first refusal (A2): the FAKE model gets no request after it, though its script would repeat forever (A1).
 * - Not in S1: the trial shell case of i.3 (S6's trial copy and trial_shell do not exist yet).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EffectLedger, effectKey } from '../src/pi-durable/effects.js';
import { reconcileOpen } from '../src/pi-durable/reconcile.js';
import { anyAlive, cleanup, delegate, effects, ended, fauxCalls, INSTALLED, killWorker, project, sha, SKIP_WHY, sleep, start, status, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
const dirs: string[] = [];
afterAll(() => { cleanup(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the reconciler, on a ledger written by hand (no worker, no model)', () => {
  it('ends an effect observed written, ends one observed not written, and marks unknown one with third bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-durable-reconcile-'));
    dirs.push(root);
    const ledger = new EffectLedger(join(root, '.timmy', 'pi', 'effects.jsonl'));
    const open = (target: string, run: string) => ledger.append({ key: effectKey('slow_write', target, run), run, tool: 'slow_write', target, state: 'started', expected_sha256: sha('old'), new_sha256: sha('new'), by: 'tool' });
    writeFileSync(join(root, 'written.txt'), 'new');
    writeFileSync(join(root, 'unwritten.txt'), 'old');
    writeFileSync(join(root, 'other.txt'), 'someone else');
    open('written.txt', 'aaaaaaaa');
    open('unwritten.txt', 'aaaaaaaa');
    open('other.txt', 'aaaaaaaa');
    ledger.append({ key: effectKey('slow_write', 'closed.txt', 'aaaaaaaa'), run: 'aaaaaaaa', tool: 'slow_write', target: 'closed.txt', state: 'ended', by: 'tool' });
    const out = reconcileOpen(ledger, root);
    expect(out.map((r) => [r.key.split(':')[1], r.state])).toEqual([['written.txt', 'ended'], ['unwritten.txt', 'ended'], ['other.txt', 'unknown']]);
    expect(out[0].outcome).toMatch(/new bytes \(the write happened\)/);
    expect(out[1].outcome).toMatch(/old bytes \(the write did not happen\)/);
    expect(out[2].outcome).toMatch(/neither the old nor the new bytes: NEEDS YOU/);
    expect(ledger.open()).toEqual([]);
    expect(ledger.unreconciled(effectKey('slow_write', 'other.txt', 'aaaaaaaa'))?.state).toBe('unknown');
    expect(ledger.unreconciled(effectKey('slow_write', 'written.txt', 'aaaaaaaa'))).toBeUndefined();
    // a second pass finds nothing open: reconciliation appends once
    expect(reconcileOpen(ledger, root)).toEqual([]);
  });
});

describe.skipIf(!INSTALLED)(`interrupted side effects through the worker (plan i.3)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  const script = (delay: number) => ({
    first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: delay } },
    after_interrupted: 'repeat' as const,
    after_blocked: 'repeat' as const, // a model that keeps repeating a refused call (spike A1)
  });

  it('a compare-and-set write killed after the write and before `ended` reconciles by sha256 to ended (observed)', async () => {
    const root = project('effects-reconcile', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, script(15_000));
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    const before = effects(root, d.run);
    expect(before.map((e) => e.state)).toEqual(['started']);
    expect(before[0]).toMatchObject({ key: effectKey('slow_write', 'a.txt', d.run), expected_sha256: sha('old bytes'), new_sha256: sha('new bytes') });

    const b = await start(root); // reconciliation runs at start, before anything is scheduled
    const after = effects(root, d.run);
    expect(after.map((e) => `${e.state}/${e.by}`)).toEqual(['started/tool', 'ended/reconcile']);
    expect(after[1].outcome).toBe('observed after a restart: the file has the new bytes (the write happened)');
    expect(after[1].readback).toEqual({ sha256: sha('new bytes') });
    expect((await status(b.client, d.run)).needs_you).toEqual([]);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('the model repeating an interrupted write of unknown outcome is refused: one effect, and the run is aborted at the first refusal (A3, A2)', async () => {
    const root = project('effects-block', { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, script(15_000));
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    // while no worker runs, the file changes again: neither the old bytes nor the new
    writeFileSync(join(root, 'a.txt'), 'third bytes');
    const callsBefore = fauxCalls(root, d.run).length;

    const b = await start(root);
    const paused = await status(b.client, d.run);
    expect(paused.effects.at(-1)).toMatchObject({ state: 'unknown', by: 'reconcile', readback: { sha256: sha('third bytes') } });
    expect(paused.needs_you).toHaveLength(1);
    expect(paused.needs_you[0].why).toMatch(/neither the old nor the new bytes: NEEDS YOU/);

    await b.client.request('resume');
    const end = await ended(b.client, d.run);
    expect(end.status).toBe('needs you');
    expect(end.submission).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    const results = end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text);
    expect(results[0]).toMatch(/Tool slow_write was interrupted and may have partially run/);
    expect(results.filter((t) => /Tool call blocked: NEEDS YOU/.test(t))).toHaveLength(1); // refused once, not 12 times (A1)
    // after the restart the FAKE model was asked exactly once (its repeat); nothing after the refusal
    const after = fauxCalls(root, d.run).slice(callsBefore);
    expect(after).toHaveLength(1);
    expect(after[0].last_text).toMatch(/was interrupted/);
    // one effect: the original write's `started`, never a second
    expect(effects(root, d.run).filter((e) => e.state === 'started')).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('third bytes');
    expect(end.needs_you.length).toBeGreaterThanOrEqual(2); // the reconcile's unknown, then the refusal
    expect(end.needs_you.at(-1)?.why).toMatch(/^NEEDS YOU: an earlier slow_write of a\.txt in this run is of unknown outcome/);
    await sleep(500);
    expect(fauxCalls(root, d.run).slice(callsBefore)).toHaveLength(1);
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
