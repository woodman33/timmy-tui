/**
 * Round R4 (H121): Timmy's Cloudroom Core adapter (src/fleet/cloudroom/) against a FAKE Cloudroom Core
 * (src/fleet/cloudroom/fake-core.ts) — an in-process node:http server on 127.0.0.1 with a random port and a random
 * token. No real Core, VM, harness, model or network beyond 127.0.0.1 is touched. REAL here: the adapted client, the
 * runtime, the provisioner, the config checks, and Timmy's own scheduler, ledger and event store (runFleet on a
 * FleetLedger in a temporary git project). Everything the FAKE Core says is a simulation of Core 3949daa's contract.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudroomClient, CloudroomConnectionError, CloudroomError, coreUrlProblem } from '../src/fleet/cloudroom/client.js';
import { FAKE_CORE_LABEL, startFakeCore, type FakeCore, type FakeCoreOptions } from '../src/fleet/cloudroom/fake-core.js';

const cores: FakeCore[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const c of cores) await c.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const fakeCore = async (o: FakeCoreOptions = {}): Promise<FakeCore> => {
  const c = await startFakeCore(o);
  cores.push(c);
  return c;
};

/** A temporary git project (empty: the plan names its own revision). */
const project = (): string => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cloudroom-'));
  roots.push(r);
  spawnSync('git', ['init', '-q'], { cwd: r });
  return r;
};

async function until(check: () => boolean | Promise<boolean>, ms = 10_000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every string an error shows: its message, stack, JSON and Core's own text. */
const shown = (e: unknown): string => {
  const x = e as Error & { detail?: unknown };
  return `${x?.message}\n${x?.stack}\n${JSON.stringify(e)}\n${String(x?.detail)}`;
};

describe('the adapted client against the FAKE Core: the contract', () => {
  it('202 is accepted, never completed; a retried id returns the same receipt and runs nothing twice; other content is refused', async () => {
    const core = await fakeCore();
    const client = new CloudroomClient({ url: core.url, token: core.token, timeoutMs: 5000 });
    const a = await client.start('contract_start', 'codex', { model: 'fake-model' });
    expect(a.session_id).toBe('cr_contract_start'); // Core: "cr_" plus the start request's id
    expect(a.receipt).toMatchObject({ request_id: 'contract_start', command: 'start', state: 'accepted' });
    const again = await client.start('contract_start', 'codex', { model: 'fake-model' });
    expect({ ...again.receipt, state: 'x', workspace: undefined }).toEqual({ ...a.receipt, state: 'x', workspace: undefined });
    expect(core.sessionIds()).toEqual(['cr_contract_start']);
    await expect(client.start('contract_start', 'codex', { model: 'another-model' })).rejects.toMatchObject({ status: 409, code: 'request_conflict', coreCode: 'request_conflict' });

    const p = await client.prompt('cr_contract_start', 'contract_p1', 'FAKE task');
    expect(p.receipt).toMatchObject({ request_id: 'contract_p1', command: 'prompt', state: 'accepted', input: { text: 'FAKE task' } });
    const p2 = await client.prompt('cr_contract_start', 'contract_p1', 'FAKE task');
    expect(p2.receipt.request_id).toBe('contract_p1');
    await expect(client.prompt('cr_contract_start', 'contract_p1', 'other text')).rejects.toMatchObject({ status: 409, code: 'request_conflict' });
    await until(async () => (await client.requestState('cr_contract_start', 'contract_p1')).state === 'completed', 10_000, 'the prompt to complete');
    const turns = core.records('cr_contract_start').filter((r) => r.kind === 'state' && (r.data as { state?: string }).state === 'starting_turn');
    expect(turns).toHaveLength(1); // the retried prompt id ran once
    expect(core.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sessions/cr_contract_start/prompts')).toHaveLength(3);
  });

  it('a missing or wrong token gets 401, and no token appears in any error', async () => {
    const core = await fakeCore();
    const bare = await fetch(`${core.url}/v1/ready`);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toBe('Bearer');
    expect(await bare.json()).toMatchObject({ error: 'unauthorized', fake: FAKE_CORE_LABEL });
    const wrongToken = 'FAKE-wrong-token-0000';
    const bad = new CloudroomClient({ url: core.url, token: wrongToken, timeoutMs: 5000 });
    const errors: unknown[] = [];
    const attempt = async (f: () => Promise<unknown>) => { try { await f(); errors.push(new Error('no error')); } catch (e) { errors.push(e); } };
    await attempt(() => bad.ready());
    await attempt(() => bad.start('wrong_token_start'));
    await attempt(() => bad.session('cr_anything'));
    await attempt(async () => { for await (const _ of bad.stream('cr_anything', { signal: AbortSignal.timeout(2000) })) { /* nothing */ } });
    for (const e of errors) {
      expect(e).toBeInstanceOf(CloudroomError);
      expect((e as CloudroomError).status).toBe(401);
      expect((e as CloudroomError).message).toBe('Cloudroom authentication failed (HTTP 401)');
      expect((e as CloudroomError).detail).toBeNull(); // a 401 body is never read
    }
    expect(core.sessionIds()).toEqual([]); // nothing started with the wrong token

    // the right token's failures: a conflict, an unknown session, a refused id, a closed port, an unreadable token
    const good = new CloudroomClient({ url: core.url, token: core.token, timeoutMs: 5000 });
    await good.start('token_errors', 'codex');
    await attempt(() => good.start('token_errors', 'pi'));
    await attempt(() => good.session('cr_unknown_session'));
    await attempt(() => good.start('bad id with spaces'));
    const closed = http.createServer();
    closed.listen(0, '127.0.0.1');
    await new Promise((r) => closed.once('listening', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    await attempt(() => new CloudroomClient({ url: `http://127.0.0.1:${port}`, token: core.token, timeoutMs: 2000 }).ready());
    await attempt(() => new CloudroomClient({ url: core.url, token: () => { throw new Error('the token file is gone'); } }).ready());
    expect(errors[5]).toMatchObject({ status: 404, detail: 'session not found' });
    expect(errors[7]).toBeInstanceOf(CloudroomConnectionError);
    for (const e of errors) {
      expect(shown(e)).not.toContain(core.token);
      expect(shown(e)).not.toContain(wrongToken);
    }
    expect(JSON.stringify(good)).toBe('{}');
    expect(JSON.stringify(bad)).toBe('{}');
  });

  it('keeps the URL rules: https, or http on loopback only, and never credentials, a query or a fragment', () => {
    for (const ok of ['http://127.0.0.1:9840', 'http://localhost:9840', 'http://[::1]:9840', 'https://core.example.com']) expect(coreUrlProblem(ok)).toBeUndefined();
    for (const bad of ['http://core.example.com', 'https://user:pass@core.example.com', 'https://core.example.com?x=1', 'https://core.example.com#x', 'file:///tmp/core', 'not a url']) {
      expect(coreUrlProblem(bad)).toBeDefined();
      expect(() => new CloudroomClient({ url: bad, token: 'FAKE-token-123' })).toThrow(CloudroomError);
    }
    for (const token of ['', ' ', 'with space', 'tab\there', 'line\nbreak']) expect(() => new CloudroomClient({ url: 'https://core.example.com', token })).toThrow(/token/);
  });

  it('pages events (at most 256, sequences not contiguous across sessions), streams SSE records, and reads one request and the recovery check', async () => {
    const core = await fakeCore({ stepDelayMs: 1 });
    const client = new CloudroomClient({ url: core.url, token: core.token, timeoutMs: 5000 });
    await Promise.all(['shape_a', 'shape_b'].map(async (id) => {
      await client.start(id, 'codex');
      await client.prompt(`cr_${id}`, `${id}_p`, 'FAKE task');
    }));
    await until(async () => (await client.requestState('cr_shape_a', 'shape_a_p')).state === 'completed' && (await client.requestState('cr_shape_b', 'shape_b_p')).state === 'completed', 10_000, 'both prompts');
    const page = await client.eventsPage('cr_shape_a', 0);
    expect(page.length).toBeGreaterThan(5);
    expect(page.map((r) => r.sequence)).toEqual([...page.map((r) => r.sequence)].sort((x, y) => x - y));
    const other = await client.eventsPage('cr_shape_b', 0);
    const all = new Set([...page, ...other].map((r) => r.sequence));
    expect(all.size).toBe(page.length + other.length); // one journal: no sequence is shared
    expect(page.map((r) => r.kind)).toEqual(expect.arrayContaining(['receipt', 'state', 'native_identity', 'text_delta', 'item_completed', 'checkpoint']));
    expect(page.find((r) => r.kind === 'text_delta')?.native).toContain('"fake":true'); // the harness's own line rides beside the record
    const later = await client.eventsPage('cr_shape_a', page[2].sequence);
    expect(later[0].sequence).toBe(page[3].sequence);

    const streamed: number[] = [];
    for await (const rec of client.stream('cr_shape_a', { after: page[1].sequence, signal: AbortSignal.timeout(5000) })) {
      streamed.push(rec.sequence);
      if (streamed.length === page.length - 2) break; // Core's stream never ends by itself; leaving the loop closes it
    }
    expect(streamed).toEqual(page.slice(2).map((r) => r.sequence));
    await until(() => core.calls.filter((c) => c.path.startsWith('/v1/sessions/cr_shape_a/stream')).every((c) => c.status === 200));

    expect(await client.requestState('cr_shape_a', 'shape_a_p')).toEqual({ archived: false, state: 'completed', error: null });
    expect(await client.requestState('cr_shape_a', 'never_sent')).toEqual({ archived: false, state: null, error: null });
    expect(await client.recovery('cr_shape_a')).toMatchObject({ status: 'ready' });
    const ws = await client.sessionWorkspace('cr_shape_a');
    expect(ws.branch).toBe('fake/cr_shape_a');
    expect(ws.head).toMatch(/^[0-9a-f]{40}$/);
    const list = await client.listSessions();
    expect(list.total).toBe(2);
    const session = await client.session('cr_shape_a');
    expect(session).toMatchObject({ session_id: 'cr_shape_a', harness: 'codex', state: 'idle', current_request: null, queue: [] });
    expect(session.receipts.shape_a_p.state).toBe('completed');
  });
});
