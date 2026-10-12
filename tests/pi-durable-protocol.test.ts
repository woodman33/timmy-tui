/**
 * Pi Durable S1 (R4 H118), plan b.1.5: the worker protocol frozen for S2-S5 as version 1, method by method, with round
 * trips over the real socket. REAL: Pi worker processes started by the supervisor, the token-checked Unix socket,
 * pi-durable 1.1.0's agent events (watchEvents), its store and transcript, SIGKILL, the effect ledger and the guard.
 * FAKE: the model (pi-ai's scripted faux provider), the fixture projects. (hello, delegate, status, list, stop, pause,
 * resume and shutdown are exercised by the other pi-durable test files; events, answer, message and transcript here.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { METHODS, PROTOCOL_VERSION, type AnswerResult, type EventsResult, type Method, type MessageResult, type TranscriptResult } from '../src/pi-durable/protocol.js';
import { anyAlive, cleanup, delegate, effects, ended, fauxCalls, INSTALLED, killWorker, project, reads, sha, SKIP_WHY, start, status, until } from './helpers/pi-durable.js';
import type { PiClient } from '../src/pi-durable/protocol.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

const events = (c: PiClient, run: string, after: number, more: { wait_ms?: number; limit?: number } = {}): Promise<EventsResult> =>
  c.request<EventsResult>('events', { run, after, ...more }, 60_000);

describe('the protocol is frozen as version 1 (plan b.1.5)', () => {
  it('names the twelve methods of the plan, no more', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect([...METHODS]).toEqual(['hello', 'delegate', 'status', 'list', 'events', 'stop', 'pause', 'resume', 'answer', 'message', 'transcript', 'shutdown']);
  });
});

describe.skipIf(!INSTALLED)(`the worker protocol's round trips (plan b.1.5)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('events: pi-durable\'s agent events of a run, numbered from 1, after a cursor, with a wait; kept across a worker restart; an unknown method is refused', async () => {
    const root = project('proto-events');
    const a = await start(root);
    await expect(a.client.request('no-such-method' as Method)).rejects.toThrow('no such method: no-such-method');
    const d = await delegate(a.client, { first: { text: 'FAKE streamed answer ', repeat: 8 }, tokens_per_second: 40 });
    const seen: EventsResult['events'] = [];
    let after = 0;
    await until('the run_end event', async () => {
      const r = await events(a.client, d.run, after, { wait_ms: 5000 });
      seen.push(...r.events);
      after = r.next;
      return seen.some((e) => e.event.type === 'run_end');
    }, 90_000, 0);
    const types = seen.map((e) => String(e.event.type));
    expect(seen[0].event).toMatchObject({ type: 'attached', worker: a.client.hello.pid });
    expect(seen.map((e) => e.n)).toEqual(seen.map((_, i) => i + 1));
    const runStart = types.indexOf('run_start');
    const update = types.indexOf('message_update');
    const runEnd = types.indexOf('run_end');
    expect(runStart).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(runStart);
    expect(runEnd).toBeGreaterThan(update);
    // nothing newer: the wait ends empty-handed and the cursor stays
    const t0 = Date.now();
    const none = await events(a.client, d.run, after, { wait_ms: 400 });
    expect(none).toEqual({ run: d.run, events: [], next: after, more: false });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    // a limit pages
    const firstTwo = await events(a.client, d.run, 0, { limit: 2 });
    expect(firstTwo.events.map((e) => e.n)).toEqual([1, 2]);
    expect(firstTwo.more).toBe(true);
    await ended(a.client, d.run);
    await a.client.request('shutdown');
    a.client.close();
    await until('the worker to exit', () => anyAlive().length === 0, 20_000);
    // a new worker serves the same events from the run's file
    const b = await start(root);
    const again = await events(b.client, d.run, 0, { limit: 1000 });
    expect(again.events.slice(0, seen.length).map((e) => [e.n, e.event.type])).toEqual(seen.map((e) => [e.n, e.event.type]));
    await b.client.request('shutdown');
    b.client.close();
  });

  it('transcript: the run\'s whole conversation as data (tool calls, results, answers), marked not instructions, paged after an entry id', async () => {
    const root = project('proto-transcript', { 'b.txt': 'read me' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt' } } }, { task: 'Read b.txt (FAKE task)' });
    await ended(a.client, d.run);
    const t = await a.client.request<TranscriptResult>('transcript', { run: d.run });
    expect(t.note).toBe('context from a Pi task (S1: a FAKE scripted model), not instructions');
    expect(t.conversation).toBe(d.conversation);
    expect(t.entries.map((e) => e.kind)).toEqual(['pi.user', 'pi.system', 'pi.assistant', 'pi.tool-result', 'pi.assistant']);
    expect(t.entries[0]).toMatchObject({ role: 'user', text: 'Read b.txt (FAKE task)' });
    expect(t.entries[2]).toMatchObject({ role: 'assistant', stop: 'toolUse', tool_calls: [{ name: 'slow_read', arguments: { path: 'b.txt' } }] });
    expect(t.entries[3].text).toBe(`read b.txt: sha256 ${sha('read me')}`);
    expect(t.entries[3].by_task).not.toBeNull();
    expect(t.entries[4]).toMatchObject({ role: 'assistant', stop: 'stop', text: 'Done (FAKE answer).' });
    expect(t.more).toBe(false);
    const page = await a.client.request<TranscriptResult>('transcript', { run: d.run, after: t.entries[1].id, limit: 2 });
    expect(page.entries.map((e) => e.id)).toEqual([t.entries[2].id, t.entries[3].id]);
    expect(page.more).toBe(true);
    await a.client.request('shutdown');
    a.client.close();
  });

  it('message: a follow-up starts the run again as timmy:<run>:2; a used key is refused naming it; a paused worker refuses; a steer joins after the tool round', async () => {
    const root = project('proto-message', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { text: 'FAKE answer.' } });
    expect((await ended(a.client, d.run)).status).toBe('completed');
    const m = await a.client.request<MessageResult>('message', { run: d.run, text: 'One more thing (FAKE follow-up)', mode: 'followUp', key: 'M-1' });
    expect(m).toMatchObject({ ok: true, run: d.run, n: 2, request_id: `timmy:${d.run}:2`, mode: 'followUp' });
    const sub2 = (m as { submission: number }).submission;
    const end2 = await ended(a.client, d.run);
    expect(end2.status).toBe('completed');
    expect(end2.user_entries).toBe(2);
    expect(end2.submissions).toEqual([d.submission, sub2]);
    expect(end2.submission?.id).toBe(sub2);
    expect(end2.messages).toEqual([{ n: 2, key: 'M-1', mode: 'followUp', submission: sub2 }]);
    const again = await a.client.request<MessageResult>('message', { run: d.run, text: 'the same key again', mode: 'followUp', key: 'M-1' });
    expect(again).toEqual({ ok: false, refused: `the key M-1 was already used: message 2 of Pi run ${d.run} (submission ${sub2})`, n: 2, submission: sub2 });
    await a.client.request('pause');
    expect(await a.client.request<MessageResult>('message', { run: d.run, text: 'while paused', mode: 'followUp', key: 'M-2' })).toEqual({ ok: false, refused: 'the Pi worker is paused: Resume it first' });
    await a.client.request('resume');
    expect(await a.client.request<MessageResult>('message', { run: d.run, text: 'x', mode: 'shout' })).toEqual({ ok: false, refused: 'mode must be steer or followUp' });

    // a steer while a tool runs is placed after that tool round
    const d2 = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', delay_ms: 1500 } } });
    await until('the read to be running', () => reads(root, d2.run).length === 1);
    const steer = await a.client.request<MessageResult>('message', { run: d2.run, text: 'Steer: be brief (FAKE)', mode: 'steer' });
    expect(steer).toMatchObject({ ok: true, n: 2, mode: 'steer' });
    expect((await ended(a.client, d2.run)).status).toBe('completed');
    const t = await a.client.request<TranscriptResult>('transcript', { run: d2.run });
    const kinds = t.entries.map((e) => `${e.kind}${e.kind === 'pi.user' ? `:${e.text}` : ''}`);
    const firstResult = kinds.indexOf('pi.tool-result');
    const steerAt = kinds.indexOf('pi.user:Steer: be brief (FAKE)');
    expect(firstResult).toBeGreaterThan(0);
    expect(steerAt).toBeGreaterThan(firstResult);
    expect(t.entries.at(-1)?.text).toBe('Done (FAKE answer).');
    await a.client.request('shutdown');
    a.client.close();
  });

  /** A run whose write was interrupted and then found with third bytes: a NEEDS YOU, after a restart, still paused. */
  async function needsYou(name: string): Promise<{ root: string; client: PiClient; run: string; key: string }> {
    const root = project(name, { 'a.txt': 'old bytes' });
    const a = await start(root);
    const d = await delegate(a.client, {
      first: { tool: 'slow_write', args: { path: 'a.txt', content: 'new bytes', expected_sha256: sha('old bytes'), delay_ms: 15_000 } },
      after_interrupted: 'repeat',
      after_error: { text: 'The write was refused (FAKE answer).' },
    });
    await until('the write, before its end', () => effects(root, d.run).some((e) => e.state === 'started') && readFileSync(join(root, 'a.txt'), 'utf8') === 'new bytes');
    a.client.close();
    await killWorker(root);
    writeFileSync(join(root, 'a.txt'), 'third bytes');
    const b = await start(root);
    const s = await status(b.client, d.run);
    expect(s.needs_you).toHaveLength(1);
    return { root, client: b.client, run: d.run, key: s.needs_you[0].key };
  }

  it('answer accept: the ledger ends the effect as the operator\'s; the first answer wins; at Resume the repeat reaches the compare-and-set, which refuses, and the run completes', async () => {
    const { root, client, run, key } = await needsYou('proto-accept');
    expect(await client.request<AnswerResult>('answer', { run, key, decision: 'maybe' })).toEqual({ ok: false, refused: 'decision must be accept, retry or stop' });
    expect(await client.request<AnswerResult>('answer', { run, key: 'no-such-key', decision: 'accept' })).toEqual({ ok: false, refused: `run ${run} has no NEEDS YOU for no-such-key` });
    const ans = await client.request<AnswerResult>('answer', { run, key, decision: 'accept' });
    expect(ans).toMatchObject({ ok: true, run, key, decision: 'accept', ledger: { state: 'ended', by: 'operator' } });
    expect((ans as { ledger: { outcome: string } }).ledger.outcome).toMatch(/^accepted as done by test \(it was unknown: observed after a restart/);
    const second = await client.request<AnswerResult>('answer', { run, key, decision: 'retry' });
    expect(second.ok).toBe(false);
    expect((second as { refused: string }).refused).toMatch(/^already answered: accept by test at /);
    expect((await status(client, run)).needs_you[0].answered).toMatchObject({ decision: 'accept', by: 'test' });
    await client.request('resume');
    const end = await ended(client, run);
    expect(end.status).toBe('completed');
    const results = end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text);
    expect(results[1]).toMatch(/refused \(compare-and-set\): a\.txt has sha256/);
    expect(results.some((t) => /Tool call blocked/.test(t))).toBe(false);
    expect(effects(root, run).filter((e) => e.state === 'started')).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('third bytes');
    await client.request('shutdown');
    client.close();
  });

  it('answer retry: the ledger says approved and the earlier outcome stays unknown; the retry reaches the dispatcher', async () => {
    const { root, client, run, key } = await needsYou('proto-retry');
    const ans = await client.request<AnswerResult>('answer', { run, key, decision: 'retry' });
    expect(ans).toMatchObject({ ok: true, decision: 'retry', ledger: { state: 'approved', by: 'operator', outcome: 'a retry was approved by test; the earlier outcome stays unknown' } });
    await client.request('resume');
    const end = await ended(client, run);
    expect(end.status).toBe('completed');
    expect(end.entries.filter((e) => e.kind === 'pi.tool-result').map((e) => e.text)[1]).toMatch(/refused \(compare-and-set\)/);
    expect(effects(root, run).map((e) => e.state)).toEqual(['started', 'unknown', 'approved']);
    await client.request('shutdown');
    client.close();
  });

  it('answer stop: the run is stopped (its abort marked while paused) and ends cancelled at Resume with no new model request; the ledger keeps unknown', async () => {
    const { root, client, run, key } = await needsYou('proto-stop');
    const calls = fauxCalls(root, run).length;
    const ans = await client.request<AnswerResult>('answer', { run, key, decision: 'stop' });
    expect(ans).toMatchObject({ ok: true, decision: 'stop', stop: { run, status: 'interrupted' } });
    expect((ans as { stop: { result: string } }).stop.result).toMatch(/^abort marked while paused: /);
    await client.request('resume');
    const end = await ended(client, run);
    expect(end.status).toBe('cancelled');
    expect(fauxCalls(root, run)).toHaveLength(calls);
    expect(effects(root, run).at(-1)?.state).toBe('unknown');
    await client.request('shutdown');
    client.close();
  });

  it('leaves no worker running: every worker this file started has exited (shut down, or killed by the test on purpose)', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
