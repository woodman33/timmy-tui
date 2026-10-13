/**
 * Pi Durable S1 (R4 H118), fix S2 of H119's review: every answer of the worker protocol stays well under its 1 MiB line
 * limit. Before the fix, transcript (up to 2000 entries, tool-call arguments uncut), events (up to 1000 of up to 16 KB)
 * and status.effects had no size limit, while a client ends its own connection at any line over 1 MiB: the request
 * failed with "the Pi worker closed the connection", and if that was the last lease the worker paused and exited.
 *
 * Now pages are limited by bytes (PAGE_BYTES, or a smaller `max_bytes`) with `more: true` and a cursor; a transcript cuts
 * long text and tool-call arguments with words saying so; status shows the newest effect records that fit, with words;
 * an answer that would still be over the line limit is replaced by an error with words, and the connection stays; a
 * path or a command too long to record is refused by the tool. The `events` wait is documented as it is: 25 s at most.
 *
 * REAL: the protocol's server and client over a Unix socket in this process; Pi's tools called in this process; Pi
 * worker processes started by the supervisor, their store and transcript. FAKE: the model (pi-ai's scripted faux
 * provider), the fixture projects, and the padding written into a run's events file and the effect ledger while no
 * worker runs (labelled fake in each line).
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PiApi, ToolResult, ToolSpec } from '../src/pi-durable/adapter/pi-api.js';
import { EffectLedger } from '../src/pi-durable/effects.js';
import { sha256Hex } from '../src/pi-durable/owner.js';
import { piPaths } from '../src/pi-durable/paths.js';
import * as protocol from '../src/pi-durable/protocol.js';
import { MAX_LINE, PiClient, PROTOCOL_VERSION, serve, type EventsResult, type HelloResult, type MessageResult, type TranscriptResult } from '../src/pi-durable/protocol.js';
import { eventsPath } from '../src/pi-durable/runs.js';
import { slowTools } from '../src/pi-durable/slow-tools.js';
import { anyAlive, cleanup, delegate, effects, ended, INSTALLED, project, SKIP_WHY, start, status, until } from './helpers/pi-durable.js';

vi.setConfig({ testTimeout: 180_000 }); // worker starts and restarts, under a loaded suite
afterAll(() => { cleanup(); });

const bytesOf = (x: unknown): number => Buffer.byteLength(JSON.stringify(x));
const PAGE = (protocol as Record<string, unknown>).PAGE_BYTES as number;
const stubPi = { schema: { object: (f: unknown) => f, string: () => ({}), integer: () => ({}), boolean: () => ({}), array: () => ({}), optional: (s: unknown) => s } } as unknown as PiApi;
const said = (r: ToolResult): string => r.content.map((c) => c.text).join('');

describe('the protocol\'s limits, in this process (fix S2)', () => {
  it('pages are limited by bytes, well under the line limit; the events wait is 25 s at most, as documented', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(PAGE).toBeGreaterThan(0);
    expect(PAGE * 3).toBeLessThan(MAX_LINE);
    expect((protocol as Record<string, unknown>).MAX_EVENTS_WAIT_MS).toBe(25_000);
  });

  it('an answer over the 1 MiB line limit is replaced by an error with words that fit its method, and the connection stays', async () => {
    const socket = join(tmpdir(), `timmy-pi-test-${randomBytes(4).toString('hex')}.sock`);
    const token = 'FAKE-token-for-this-test';
    const big = new Set(['status', 'transcript', 'list', 'stop']);
    const server = await serve(socket, sha256Hex(token), async (method) => (big.has(method) ? { big: 'b'.repeat(2_000_000) } : { small: true }), () => ({ protocol: PROTOCOL_VERSION } as unknown as HelloResult));
    try {
      const c = await PiClient.connect(socket, { token, surface: 'test' });
      const over = (method: string, hint: string): RegExp => new RegExp(`^the answer to ${method} is 2,000,0\\d\\d bytes, over the protocol's 1 MiB line limit: it was not sent \\(${hint}\\)$`);
      await expect(c.request('status', { run: 'aaaaaaaa' })).rejects.toThrow(over('status', 'status has no page: read the run in pages with transcript and events'));
      await expect(c.request('transcript', { run: 'aaaaaaaa' })).rejects.toThrow(over('transcript', 'ask for a smaller page with max_bytes or limit'));
      await expect(c.request('list')).rejects.toThrow(over('list', 'list has no page: the project has more runs than one answer can hold'));
      await expect(c.request('stop', { run: 'aaaaaaaa' })).rejects.toThrow(over('stop', 'stop has no smaller form'));
      expect(await c.request('events', { run: 'aaaaaaaa' })).toEqual({ small: true }); // the same connection still answers
      c.close();
    } finally { await server.close(2000); }
  });

  it('a path or a command too long to record is refused by the tool, and nothing is recorded or run', async () => {
    const root = project('pages-tools', { 'a.txt': 'x' });
    const p = piPaths(root);
    const ledger = new EffectLedger(p.effects);
    const tools = slowTools(stubPi, { root, ledger, readsLog: join(p.dir, 'reads.jsonl'), trialShell: true, runOf: () => 'aaaaaaaa' });
    const tool = (name: string): ToolSpec => tools.find((t) => t.name === name) as ToolSpec;
    const api = { taskId: 1, conversationId: 1, callId: 'call-1' };
    const longPath = `${'x'.repeat(1100)}.txt`;
    const w = await tool('slow_write').execute({ path: longPath, content: 'y', expected_sha256: 'absent' }, api, {});
    expect([w.isError, said(w)]).toEqual([true, 'refused: the path is 1,104 characters long; Pi\'s file tools take at most 1,024']);
    const r = await tool('slow_read').execute({ path: longPath }, api, {});
    expect([r.isError, said(r)]).toEqual([true, 'refused: the path is 1,104 characters long; Pi\'s file tools take at most 1,024']);
    const argv = [process.execPath, '-e', '0', 'z'.repeat(9000)];
    const s = await tool('trial_shell').execute({ argv }, api, {});
    expect([s.isError, said(s)]).toEqual([true, `refused: the command is ${(argv.join('').length).toLocaleString('en-US')} characters long; trial_shell takes at most 8,192`]);
    expect(ledger.all()).toEqual([]);
  });
});

describe.skipIf(!INSTALLED)(`the worker's answers stay under the line limit (fix S2)${INSTALLED ? '' : ` — skipped: ${SKIP_WHY}`}`, () => {
  it('transcript: tool-call arguments of 200 KB are cut with words; pages are limited by bytes, with more and a cursor that reaches every entry', async () => {
    const root = project('pages-transcript', { 'b.txt': 'read me' });
    const a = await start(root);
    const pad = 'p'.repeat(200_000); // FAKE: an argument the tool ignores, as a model may send
    const d = await delegate(a.client, { first: { tool: 'slow_read', args: { path: 'b.txt', pad } }, after_result: { text: 'Read it (FAKE answer).' } });
    await ended(a.client, d.run);
    for (let i = 2; i <= 6; i++) {
      const m = await a.client.request<MessageResult>('message', { run: d.run, text: `Again (FAKE follow-up ${i})`, mode: 'followUp' });
      expect(m.ok).toBe(true);
      expect((await ended(a.client, d.run)).status).toBe('completed');
    }
    // six tool calls of 200 KB each: 1.2 MB of arguments in this conversation
    const t = await a.client.request<TranscriptResult>('transcript', { run: d.run });
    expect(bytesOf(t)).toBeLessThan(PAGE);
    expect(t.more).toBe(false);
    const calls = t.entries.flatMap((e) => e.tool_calls as { name: string; arguments: unknown; arguments_cut?: string }[]);
    expect(calls).toHaveLength(6);
    for (const c of calls) {
      expect(c.name).toBe('slow_read');
      expect(typeof c.arguments).toBe('string');
      expect((c.arguments as string).length).toBe(2000);
      expect((c.arguments as string).startsWith('{"path":"b.txt","pad":"ppp')).toBe(true);
      expect(c.arguments_cut).toMatch(/^its arguments are 200,0\d\d characters as JSON: `arguments` holds their first 2,000, as text$/);
    }
    // small pages: each under its byte limit, all entries reached through the cursor, in order, once
    const ids: number[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await a.client.request<TranscriptResult & { next: number }>('transcript', { run: d.run, after, max_bytes: 16_384 });
      pages += 1;
      expect(bytesOf(page)).toBeLessThan(16_384 + 4096);
      ids.push(...page.entries.map((e) => e.id));
      if (!page.more) break;
      expect(page.next).toBe(page.entries.at(-1)!.id);
      after = page.next;
    }
    expect(pages).toBeGreaterThan(1);
    expect(ids).toEqual(t.entries.map((e) => e.id));
    await a.client.request('shutdown');
    a.client.close();
  });

  it('events and status: a run with 1.5 MB of events and 1.5 MB of effect records answers in pages and with the newest records, under the limit', async () => {
    const root = project('pages-events', { 'b.txt': 'x' });
    const a = await start(root);
    const d = await delegate(a.client, { first: { text: 'FAKE answer.' } });
    await ended(a.client, d.run);
    await a.client.request('shutdown');
    a.client.close();
    await until('the worker to exit', () => anyAlive().length === 0, 30_000);
    // FAKE padding, written while no worker runs: 100 events of 15 KB and 6,000 effect records
    const p = piPaths(root);
    const file = eventsPath(p, d.run);
    const last = readFileSync(file, 'utf8').trim().split('\n').length;
    for (let i = 1; i <= 100; i++) appendFileSync(file, `${JSON.stringify({ n: last + i, at: new Date().toISOString(), event: { type: 'fake_padding', fake: true, pad: 'e'.repeat(15_000) } })}\n`);
    const at = new Date().toISOString();
    appendFileSync(p.effects, Array.from({ length: 6000 }, (_, i) => `${JSON.stringify({ key: `slow_write:fake-${i}.txt:${d.run}`, run: d.run, tool: 'slow_write', target: `fake-${i}.txt`, state: 'ended', outcome: 'FAKE record written by the test while no worker ran', by: 'tool', pid: 1, at })}\n`).join(''));
    expect(readFileSync(file).length).toBeGreaterThan(MAX_LINE);
    expect(readFileSync(p.effects).length).toBeGreaterThan(MAX_LINE);

    const b = await start(root);
    const first = await b.client.request<EventsResult>('events', { run: d.run, after: 0, limit: 1000 });
    expect(bytesOf(first)).toBeLessThan(PAGE);
    expect(first.more).toBe(true);
    expect(first.next).toBe(first.events.at(-1)!.n);
    const seen = [...first.events.map((e) => e.n)];
    let after = first.next;
    for (;;) {
      const page = await b.client.request<EventsResult>('events', { run: d.run, after, limit: 1000 });
      expect(bytesOf(page)).toBeLessThan(PAGE);
      seen.push(...page.events.map((e) => e.n));
      if (!page.more) break;
      after = page.next;
    }
    expect(seen).toEqual(Array.from({ length: last + 100 }, (_, i) => i + 1));

    const s = await status(b.client, d.run) as Awaited<ReturnType<typeof status>> & { effects_cut: string | null };
    expect(bytesOf(s)).toBeLessThan(PAGE);
    expect(s.effects.length).toBeGreaterThan(10);
    expect(s.effects.length).toBeLessThan(6000);
    expect(s.effects.at(-1)?.key).toBe(`slow_write:fake-5999.txt:${d.run}`); // the newest are kept
    expect(s.effects_cut).toBe(`the run has 6,000 effect records; the newest ${s.effects.length.toLocaleString('en-US')} are shown (the ledger keeps them all)`);
    expect(effects(root, d.run)).toHaveLength(6000); // the ledger itself is untouched
    await b.client.request('shutdown');
    b.client.close();
  });

  it('leaves no worker running: every worker this file started has exited', async () => {
    await until('every worker to have exited', () => anyAlive().length === 0, 30_000);
    expect(anyAlive()).toEqual([]);
    cleanup();
  });
});
