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
import {
  CHILD_REFUSAL, cloudroomAvailability, cloudroomBackend, cloudroomRequestId, openCloudroomBackend, promptIdFor, sessionIdFor, UNKNOWN_REASON,
  writeCloudroomConfig, type CloudroomBackend, type CloudroomBackendOptions,
} from '../src/fleet/cloudroom/index.js';
import type { Backend, Provisioner } from '../src/fleet/backend.js';
import { checkPlan, makePlan, type PlanInput } from '../src/fleet/plan.js';
import { FleetLedger, planDir, workerDir } from '../src/fleet/ledger.js';
import { reconcileFleet, runFleet } from '../src/fleet/scheduler.js';
import { WorkerEvents } from '../src/fleet/events.js';
import { FAKE_LEAKED_TOKEN } from '../src/fleet/fake.js';
import { planFleet, runPlan } from '../src/fleet/service.js';

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

// ---------------------------------------------------------------- the fleet on a FAKE Core (Timmy's real scheduler)

const input = (root: string, over: Partial<PlanInput> = {}): PlanInput => ({
  project: { root, revision: 'abc1234', dirty: false },
  operationId: 'o0000cccc',
  agents: 3,
  concurrency: 3,
  provider: 'cloudroom',
  isolation: 'shared-session',
  harness: 'codex',
  model: 'fake-model',
  prompt: 'FAKE task: say hello',
  ...over,
});

const backendOn = async (core: FakeCore, over: Partial<CloudroomBackendOptions> = {}): Promise<CloudroomBackend> => {
  const b = cloudroomBackend({ url: core.url, token: core.token, mode: 'fake', maxConcurrent: 10, timeoutMs: 5000, retryDelayMs: 20, ...over });
  const r = await b.refresh();
  expect(r.ready).toBe(true);
  return b;
};

const startPlan = (root: string, over: Partial<PlanInput> = {}) => {
  const plan = makePlan(input(root, over));
  return { plan, ledger: FleetLedger.create(root, plan) };
};

const ids = (allocationKey: string) => {
  const startId = cloudroomRequestId(`${allocationKey}:open`);
  return { startId, sessionId: sessionIdFor(startId), promptId: promptIdFor(startId) };
};
const posts = (core: FakeCore, p: string) => core.calls.filter((c) => c.method === 'POST' && c.path === p);
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('the shared-Core provisioner and the runtime capabilities', () => {
  it('one compute for every worker, nothing made or stopped, and a plan asking for more isolation is refused in words', async () => {
    const core = await fakeCore();
    const b = await backendOn(core);
    const caps = b.provisioner.capabilities();
    expect(caps).toMatchObject({
      provider: 'cloudroom', available: true, isolation: ['shared-session'], maxConcurrent: 10, paid: false, remote: true,
      childSpawnMayShareParent: true, childSpawnCanBeDisabled: false, childSpawnDetected: true, snapshots: false,
    });
    expect(caps.label).toBe(FAKE_CORE_LABEL);
    const root = project();
    expect(checkPlan(makePlan(input(root)), caps)).toEqual([]);
    expect(checkPlan(makePlan(input(root, { isolation: 'vm' })), caps).join('\n')).toMatch(/cannot give a virtual machine .*refused rather than run with less/);
    const spec = { planId: 'f00000001', workerIndex: 1, allocationKey: 'f00000001:w001:a1', isolation: 'shared-session' as const, limits: { cpu: 1, ramGb: 1, diskGb: 1 }, ttlMinutes: 5, labels: {} };
    expect(await b.provisioner.create(spec, 'f00000001:w001:a1:create')).toEqual({ outcome: 'created', providerId: 'cloudroom-core:fake-core' });
    expect(await b.provisioner.create({ ...spec, workerIndex: 2, allocationKey: 'f00000001:w002:a1' }, 'x')).toEqual({ outcome: 'created', providerId: 'cloudroom-core:fake-core' });
    expect(await b.provisioner.create({ ...spec, isolation: 'vm' }, 'y')).toMatchObject({ outcome: 'refused', reason: /only a session on a shared machine/ });
    expect(await b.provisioner.destroy('cloudroom-core:fake-core', 'd')).toMatchObject({ outcome: 'absent', reason: expect.stringMatching(/not Timmy's to stop/) });
    expect(await b.provisioner.list({ 'timmy.plan': 'f00000001' })).toEqual([]);
    expect(core.sessionIds()).toEqual([]); // a create makes nothing on the Core
    core.setReady(false);
    expect(await b.provisioner.create(spec, 'z')).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/not ready \(HTTP 503/) });
    expect((await b.provisioner.lookup('f00000001:w001:a1')).state).toBe('unknown');
    core.setReady(true);
    expect(await b.provisioner.lookup('f00000001:w001:a1')).toMatchObject({ state: 'ready', record: { providerId: 'cloudroom-core:fake-core', isolation: 'shared-session' } });

    const rc = b.runtime.capabilities();
    expect(rc).toMatchObject({ runtime: 'cloudroom', available: true, sessions: true, events: true, close: true, interrupt: true, childSpawn: 'may-share-parent', harnesses: ['codex', 'claude-code', 'pi'] });
    expect(JSON.stringify(rc)).not.toContain('/srv/fake-core'); // the Core's repository path is never kept
    const plain = await backendOn(await fakeCore({ features: ['stop', 'resume'] }));
    expect(plain.runtime.capabilities().childSpawn).toBe('none'); // no child_threads or subagents flag: no children
    const unread = cloudroomBackend({ url: core.url, token: core.token, mode: 'fake' });
    expect(unread.runtime.capabilities()).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/have not been read yet/) });
    const wrong = cloudroomBackend({ url: core.url, token: 'FAKE-wrong-token-0000', mode: 'fake', retryDelayMs: 1 });
    const r = await wrong.refresh();
    expect(r).toMatchObject({ ready: false, why: expect.stringMatching(/refused Timmy's token \(HTTP 401\)/) });
    expect(r.runtime).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/authentication failed \(HTTP 401\)/) });
  });
});

describe('the fleet on a FAKE Core: runFleet, the ledger and the event store are real', () => {
  it('one session per worker with ids derived from Timmy\'s; delivered, not verified; collected before close; the Core is left running', async () => {
    const core = await fakeCore();
    const backend = await backendOn(core);
    const root = project();
    const { plan, ledger } = startPlan(root);
    const res = await runFleet({ backend, ledger });
    expect(res.status).toBe('finished');
    expect(res.counts).toMatchObject({ requested: 3, admitted: 3, delivered: 3, verified: 0, failed: 0, liveAllocations: 0 });
    for (const w of ledger.snapshot().workers) {
      const { startId, sessionId, promptId } = ids(w.allocationKey);
      expect(startId).toBe(`${w.allocationKey.replace(/:/g, '_')}_open`);
      expect(w.session).toMatchObject({ sessionId, state: 'closed' });
      expect(w.compute).toMatchObject({ providerId: 'cloudroom-core:fake-core', state: 'absent' }); // never stopped: not Timmy's
      expect(w.result).toMatchObject({ collected: true, files: 2, verified: 'not run' });
      expect(w.result.summary).toMatch(/FAKE output 1 .*the work stays on the Core machine \(branch fake\//);
      expect(posts(core, '/v1/sessions').filter((c) => c.body?.request_id === startId)).toHaveLength(1);
      expect(posts(core, `/v1/sessions/${sessionId}/prompts`).map((c) => c.body)).toEqual([{ request_id: promptId, text: 'FAKE task: say hello' }]);
      const dir = path.join(workerDir(root, plan.id, w.index), 'result');
      expect(fs.readFileSync(path.join(dir, 'FINAL-MESSAGE.md'), 'utf8')).toMatch(/^FAKE output 1 from codex in session cr_/);
      const ws = JSON.parse(fs.readFileSync(path.join(dir, 'WORKSPACE.json'), 'utf8')) as Record<string, unknown>;
      expect(ws).toMatchObject({ session: sessionId, branch: `fake/${sessionId}`, note: expect.stringMatching(/stays on the Cloudroom Core machine.*not verified by Timmy/) });
      expect(ws.head).toMatch(/^[0-9a-f]{40}$/);
      expect(Object.keys(ws)).not.toContain('path');
      // the FAKE's own request log: every collect read (event pages, workspace) comes before the close
      const at = (f: (c: (typeof core.calls)[number]) => boolean) => core.calls.reduce((last, c, i) => (f(c) ? i : last), -1);
      const lastCollect = Math.max(at((c) => c.path.startsWith(`/v1/sessions/${sessionId}/events?`)), at((c) => c.path === `/v1/sessions/${sessionId}/workspace`));
      const close = core.calls.findIndex((c) => c.method === 'POST' && c.path === `/v1/sessions/${sessionId}/close`);
      expect(lastCollect).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(lastCollect);
      expect(core.calls[close].body).toEqual({ request_id: cloudroomRequestId(`${w.allocationKey}:close`) });
      expect(core.sessionState(sessionId)).toBe('closed');
      const order = ledger.transitions().filter((t) => t.worker === w.index).map((t) => t.what);
      expect(order.indexOf('collected')).toBeLessThan(order.indexOf('session closed'));
    }
    const evs = new WorkerEvents(workerDir(root, plan.id, 1)).all();
    expect(evs.map((e) => e.kind)).toEqual(expect.arrayContaining(['session.started', 'message', 'delivered']));
    const delivered = evs.find((e) => e.kind === 'delivered')!;
    expect(delivered.text).toMatch(/^delivered \(the runtime said completed; not verified\): FAKE output 1/);
    expect(delivered.native.data).toMatchObject({ kind: 'receipt', data: { command: 'prompt', state: 'completed' } }); // Core's record, kept
    expect(evs.find((e) => e.kind === 'message')!.native.data).toMatchObject({ kind: 'text_delta', native: expect.stringContaining('"fake":true') });
    expect(JSON.stringify(evs)).not.toContain('/srv/fake-core'); // the Core machine's folders are left out
    expect(core.openNow()).toBe(0);
  }, 60_000);

  it('a dropped event stream resumes from the persisted cursor: no record lost, none repeated', async () => {
    const core = await fakeCore({ faults: ({ worker }) => (worker === 2 ? { dropStreamAfter: 4, deltas: 4 } : undefined) });
    const backend = await backendOn(core);
    const root = project();
    const { plan, ledger } = startPlan(root);
    await runFleet({ backend, ledger });
    expect(ledger.worker(2).phase).toBe('delivered');
    const { sessionId } = ids(ledger.worker(2).allocationKey);
    const stored = new WorkerEvents(workerDir(root, plan.id, 2)).all();
    const seqs = stored.map((e) => e.native.seq);
    expect(seqs).toEqual([...new Set(seqs)]);
    expect(stored.map((e) => e.n)).toEqual(stored.map((_, i) => i + 1));
    const coreSeqs = core.records(sessionId).map((r) => r.sequence as number);
    expect(seqs).toEqual(coreSeqs.filter((s) => s <= seqs[seqs.length - 1])); // every record up to the end, once, in order
    expect(stored.at(-1)!.kind).toBe('delivered');
    expect(ledger.transitions().some((t) => t.worker === 2 && t.what === 'stream dropped; resuming')).toBe(true);
    const streams = core.calls.filter((c) => c.path.startsWith(`/v1/sessions/${sessionId}/stream?`));
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(streams[1].path).toBe(`/v1/sessions/${sessionId}/stream?after=${seqs[3]}`); // after the 4th record, the last one stored
  }, 60_000);

  it('a child request is answered with a refusal well inside the window, and Core\'s fallback never fires', async () => {
    const core = await fakeCore({ childAnswerWindowMs: 3000, faults: ({ worker }) => (worker === 1 ? { childRequest: true } : undefined) });
    const backend = await backendOn(core);
    const root = project();
    const { plan, ledger } = startPlan(root, { agents: 2, concurrency: 2 });
    const res = await runFleet({ backend, ledger });
    expect(res.counts.delivered).toBe(2); // a shared-session plan: the refused child changes nothing else
    const { sessionId } = ids(ledger.worker(1).allocationKey);
    expect(core.childRequests).toHaveLength(1);
    const asked = core.childRequests[0];
    expect(asked.sessionId).toBe(sessionId);
    const answers = core.childAnswers.filter((a) => a.sessionId === sessionId);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ id: asked.id, status: 202, body: { error: CHILD_REFUSAL } });
    expect(answers[0].at - asked.at).toBeLessThan(3000);
    expect(core.fallbacks()).toBe(0);
    expect(core.records(sessionId).some((r) => r.kind === 'child_thread')).toBe(false);
    expect(JSON.stringify(core.records(sessionId))).toContain("The child could not start in its own sandbox: Timmy's fleet starts no sandboxes for children");
    const refused = new WorkerEvents(workerDir(root, plan.id, 1)).all().find((e) => e.native.type === 'child.refused')!;
    expect(refused.native.data).toMatchObject({ child: asked.id, refusal: CHILD_REFUSAL, answer: { sent: true, status: 202 }, kind: 'child_request' });

    // the negative control: with nobody answering, the FAKE Core's fallback does fire (so the test above means something)
    const control = await fakeCore({ childAnswerWindowMs: 150, faults: () => ({ childRequest: true }) });
    const raw = new CloudroomClient({ url: control.url, token: control.token });
    for (const id of ['ctrl_a', 'ctrl_b']) {
      await raw.start(id, 'codex');
      await raw.prompt(`cr_${id}`, `${id}_p`, 'FAKE task');
      await until(async () => (await raw.requestState(`cr_${id}`, `${id}_p`)).state === 'completed', 10_000, `${id} to complete`);
    }
    expect(control.records('cr_ctrl_a').map((r) => r.kind)).toEqual(expect.arrayContaining(['child_request', 'child_thread']));
    const second = control.records('cr_ctrl_b').map((r) => r.kind);
    expect(second).toContain('child_thread');
    expect(second).not.toContain('child_request'); // within 5 minutes of a miss, every spawn shares its parent's folder unasked
    expect(control.fallbacks()).toBe(2);
    await expect(raw.answerChild('cr_ctrl_a', control.childRequests[0].id, { error: 'late' })).rejects.toMatchObject({ status: 409 });
  }, 60_000);

  it('a --shared-sandbox child fails its worker under a strict plan (a FAKE stand-in for one Core per VM): detected, interrupted, closed', async () => {
    const core = await fakeCore({ faults: ({ worker }) => (worker === 2 ? { sharedChild: true, holdAfterChildMs: 3000 } : undefined) });
    const shared = await backendOn(core);
    // No Core-per-VM provisioner exists; this stand-in claims "vm" so the strict path can be exercised. Labelled FAKE.
    const perVm: Provisioner = {
      capabilities: () => ({ ...shared.provisioner.capabilities(), label: 'FAKE stand-in: one Cloudroom Core per VM (simulated; no VM exists)', isolation: ['vm'] }),
      create: (spec, id) => shared.provisioner.create({ ...spec, isolation: 'shared-session' }, id),
      lookup: (k) => shared.provisioner.lookup(k),
      destroy: (p, id) => shared.provisioner.destroy(p, id),
      list: (l) => shared.provisioner.list(l),
    };
    const backend: Backend = { provisioner: perVm, runtime: shared.runtime };
    const root = project();
    const { plan, ledger } = startPlan(root, { isolation: 'vm' });
    expect(plan.perWorker).toBe('dedicated');
    const res = await runFleet({ backend, ledger });
    expect(res.status).toBe('finished'); // not refused: the child path is detected, not prevented
    const w2 = ledger.worker(2);
    expect(w2.phase).toBe('failed');
    expect(w2.reason).toMatch(/parent's sandbox, which breaks this plan's one-sandbox-per-worker isolation/);
    expect(w2.session.harnessStopped).toBe(true);
    const { sessionId, promptId } = ids(w2.allocationKey);
    expect(posts(core, `/v1/sessions/${sessionId}/interrupt`).map((c) => c.body)).toEqual([{ request_id: cloudroomRequestId(`${w2.allocationKey}:interrupt`), target_request_id: promptId }]);
    await until(() => core.sessionState(sessionId) === 'closed', 5000, 'the FAKE Core to finish the close');
    expect(core.receipt(sessionId, promptId)?.state).toBe('interrupted');
    const child = new WorkerEvents(workerDir(root, plan.id, 2)).all().find((e) => e.kind === 'child')!;
    expect(child.text).toMatch(/child session cr_child_fakechild\d+ started IN THE PARENT'S SANDBOX/);
    expect(child.native.data).toMatchObject({ via: 'child_thread', kind: 'child_thread', sharedWithParent: true });
    expect(ledger.worker(1).phase).toBe('delivered');
    expect(ledger.worker(3).phase).toBe('delivered');
  }, 60_000);

  it('an unknown (or unknown_after_restart) receipt fails its worker, and nothing is ever resent', async () => {
    const core = await fakeCore({ faults: ({ worker }) => (worker === 1 ? { unknownReceipt: 'unknown' } : worker === 2 ? { unknownReceipt: 'unknown_after_restart' } : undefined) });
    const backend = await backendOn(core);
    const root = project();
    const { plan, ledger } = startPlan(root);
    const res = await runFleet({ backend, ledger });
    expect(res.counts).toMatchObject({ delivered: 1, failed: 2 });
    for (const [index, state] of [[1, 'unknown'], [2, 'unknown_after_restart']] as const) {
      const w = ledger.worker(index);
      expect(w).toMatchObject({ phase: 'failed', reason: UNKNOWN_REASON });
      const { sessionId, promptId } = ids(w.allocationKey);
      expect(posts(core, `/v1/sessions/${sessionId}/prompts`).map((c) => c.body?.request_id)).toEqual([promptId]);
      expect(core.receipt(sessionId, promptId)?.state).toBe(state);
      expect(core.calls.some((c) => c.path === `/v1/sessions/${sessionId}/resume`)).toBe(false);
      expect(core.sessionState(sessionId)).toBe('closed');
      const failed = new WorkerEvents(workerDir(root, plan.id, index)).all().find((e) => e.kind === 'failed')!;
      expect(failed.text).toBe(`failed: ${UNKNOWN_REASON}`);
      expect(failed.native.data).toMatchObject({ receiptState: state, kind: 'receipt' });
    }
    const before = core.calls.filter((c) => c.method === 'POST').length;
    await reconcileFleet(FleetLedger.open(root, plan.id), backend); // a later reconcile resends nothing either
    expect(core.calls.filter((c) => c.method === 'POST').length).toBe(before);
  }, 60_000);

  it('an unconfirmed command goes again with the same id: a 503 on the first prompt, and a 202 that came too late', async () => {
    const core = await fakeCore({ faults: ({ worker }) => (worker === 1 ? { prompt503: 1 } : worker === 2 ? { slowAcceptMs: 900 } : undefined) });
    const backend = await backendOn(core, { timeoutMs: 400 });
    const root = project();
    const { ledger } = startPlan(root);
    const res = await runFleet({ backend, ledger });
    expect(res.counts.delivered).toBe(3);
    const w1 = ids(ledger.worker(1).allocationKey);
    const prompts = posts(core, `/v1/sessions/${w1.sessionId}/prompts`);
    expect(prompts.map((c) => [c.status, c.body?.request_id])).toEqual([[503, w1.promptId], [202, w1.promptId]]);
    expect(core.records(w1.sessionId).filter((r) => r.kind === 'state' && (r.data as { state?: string }).state === 'starting_turn')).toHaveLength(1);
    const w2 = ids(ledger.worker(2).allocationKey);
    const starts = posts(core, '/v1/sessions').filter((c) => c.body?.request_id === w2.startId);
    expect(starts).toHaveLength(2); // the first 202 arrived after the client's 400 ms; the same id went again
    expect(core.sessionIds()).toHaveLength(3); // and no second session was made
  }, 60_000);

  it('cancel by signal: each running worker gets an interrupt and a close, each with its own derived id; queued ones never reach the Core', async () => {
    const core = await fakeCore({ stepDelayMs: 25, faults: () => ({ deltas: 60 }) });
    const backend = await backendOn(core);
    const root = project();
    const { ledger } = startPlan(root, { agents: 6, concurrency: 2 });
    const abort = new AbortController();
    const messages = new Map<number, number>();
    const res = await runFleet({
      backend, ledger, signal: abort.signal,
      onEvent: (w, e) => {
        if (e.kind !== 'message') return;
        messages.set(w, (messages.get(w) ?? 0) + 1);
        if ([...messages.values()].filter((n) => n >= 2).length === 2) abort.abort();
      },
    });
    expect(res.status).toBe('stopped');
    const stopped = ledger.snapshot().workers.filter((w) => w.phase === 'interrupted');
    expect(stopped).toHaveLength(2);
    for (const w of stopped) {
      const { sessionId, promptId } = ids(w.allocationKey);
      const interrupt = posts(core, `/v1/sessions/${sessionId}/interrupt`).map((c) => c.body);
      const close = posts(core, `/v1/sessions/${sessionId}/close`).map((c) => c.body);
      expect(interrupt).toEqual([{ request_id: cloudroomRequestId(`${w.allocationKey}:interrupt`), target_request_id: promptId }]);
      expect(close).toEqual([{ request_id: cloudroomRequestId(`${w.allocationKey}:close`) }]);
      expect(interrupt[0]?.request_id).not.toBe(close[0]?.request_id);
      expect(w.session.harnessStopped).toBe(true);
      await until(() => core.sessionState(sessionId) === 'closed', 5000, 'the FAKE Core to finish the close');
      expect(core.receipt(sessionId, promptId)?.state).toBe('interrupted');
    }
    expect(ledger.snapshot().workers.filter((w) => w.phase === 'cancelled')).toHaveLength(4);
    expect(core.sessionIds()).toHaveLength(2);
  }, 60_000);

  it('a cancel while the session is still starting: its queued task never runs (a stop pauses the queue, then the close fails it)', async () => {
    const core = await fakeCore({ stepDelayMs: 150 });
    const backend = await backendOn(core);
    const root = project();
    const { ledger } = startPlan(root, { agents: 1, concurrency: 1 });
    const abort = new AbortController();
    const res = await runFleet({ backend, ledger, signal: abort.signal, onEvent: () => abort.abort() });
    expect(res.status).toBe('stopped');
    const w = ledger.worker(1);
    expect(w.phase).toBe('interrupted');
    const { sessionId, promptId } = ids(w.allocationKey);
    expect(posts(core, `/v1/sessions/${sessionId}/interrupt`)).toHaveLength(0); // never the active turn
    expect(posts(core, `/v1/sessions/${sessionId}/stop`).map((c) => c.body)).toEqual([{ request_id: cloudroomRequestId(`${w.allocationKey}:interrupt:stop`) }]);
    expect(posts(core, `/v1/sessions/${sessionId}/close`).filter((c) => c.status === 202).map((c) => c.body)).toEqual([{ request_id: cloudroomRequestId(`${w.allocationKey}:close`) }]);
    await until(() => core.sessionState(sessionId) === 'closed', 5000, 'the FAKE Core to finish the close');
    expect(core.receipt(sessionId, promptId)?.state).toBe('failed');
    expect(core.records(sessionId).some((r) => r.kind === 'state' && (r.data as { request_id?: string }).request_id === promptId)).toBe(false); // no turn ever began
  }, 60_000);

  it('redaction: no token reaches any .timmy file, nor the Core machine\'s folders; a credential in the output is redacted', async () => {
    const core = await fakeCore({ faults: ({ worker }) => (worker === 1 ? { leakText: `export OPENROUTER_API_KEY=${FAKE_LEAKED_TOKEN} ` } : undefined) });
    const backend = await backendOn(core);
    const root = project();
    const { plan, ledger } = startPlan(root, { agents: 2, concurrency: 2 });
    await runFleet({ backend, ledger });
    expect(ledger.worker(1).phase).toBe('delivered');
    // and a refused run with a wrong token, whose refusal is written to its ledger
    const wrongToken = 'FAKE-wrong-token-0000';
    const wrong = cloudroomBackend({ url: core.url, token: wrongToken, mode: 'fake', retryDelayMs: 1 });
    await wrong.refresh();
    const refusedPlan = startPlan(root, { agents: 1, concurrency: 1 });
    const refused = await runFleet({ backend: wrong, ledger: refusedPlan.ledger });
    expect(refused.status).toBe('refused');
    expect(refused.refusals.join('\n')).toMatch(/authentication failed \(HTTP 401\)/);
    const files = walk(path.join(root, '.timmy'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text).not.toContain(core.token);
      expect(text).not.toContain(wrongToken);
      expect(text).not.toContain(FAKE_LEAKED_TOKEN);
      expect(text).not.toContain('/srv/fake-core');
    }
    expect(fs.readFileSync(path.join(workerDir(root, plan.id, 1), 'result', 'FINAL-MESSAGE.md'), 'utf8')).toContain('[REDACTED_OPENROUTER_KEY]');
    expect(fs.readdirSync(planDir(root, plan.id))).toEqual(expect.arrayContaining(['plan.json', 'state.json', 'allocations.jsonl']));
  }, 60_000);

  it('100 workers on one FAKE Core with a concurrency cap of 8: never more than 8 open, 100 sessions, a budget of 100 prompts', async () => {
    const core = await fakeCore({ stepDelayMs: 1 });
    const backend = await backendOn(core, { maxConcurrent: 8 });
    const root = project();
    const { ledger } = startPlan(root, { agents: 100, concurrency: 8 });
    const t0 = performance.now();
    const res = await runFleet({ backend, ledger });
    const ms = Math.round(performance.now() - t0);
    console.info(`[FAKE Cloudroom Core, offline simulation] 100 workers, at most 8 at once: ${ms} ms wall time`);
    expect(res.status).toBe('finished');
    expect(res.counts).toMatchObject({ requested: 100, admitted: 100, delivered: 100, failed: 0, verified: 0, queued: 0, running: 0 });
    expect(res.peakActive).toBeLessThanOrEqual(8);
    expect(core.peakOpen()).toBeLessThanOrEqual(8);
    expect(core.sessionIds()).toHaveLength(100);
    expect(core.openNow()).toBe(0);
    const starts = posts(core, '/v1/sessions');
    const prompts = core.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/prompts'));
    expect(starts).toHaveLength(100);
    expect(new Set(starts.map((c) => c.body?.request_id)).size).toBe(100);
    expect(prompts).toHaveLength(100); // the budget: one prompt per worker (one model turn on a real Core), none resent
    expect(new Set(prompts.map((c) => c.body?.request_id)).size).toBe(100);
  }, 180_000);
});

describe('request ids and config', () => {
  it("maps Timmy's request ids deterministically: ':' to '_', at most 64 characters, a hash for anything longer or odd", () => {
    expect(cloudroomRequestId('f645a0527:w001:a1:open')).toBe('f645a0527_w001_a1_open');
    expect(cloudroomRequestId('f645a0527:w001:a1:open')).toBe(cloudroomRequestId('f645a0527:w001:a1:open'));
    const long = `f645a0527:w001:a1:${'x'.repeat(80)}`;
    expect(cloudroomRequestId(long)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(cloudroomRequestId(`${long}y`)).not.toBe(cloudroomRequestId(long));
    expect(cloudroomRequestId('a:b')).toBe('a_b');
    expect(cloudroomRequestId('a_b')).not.toBe('a_b'); // an id that already holds "_" is hashed, so it never meets "a:b"
    for (const odd of ['plan with spaces', 'ünïcode:id', 'a/b']) expect(cloudroomRequestId(odd)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(promptIdFor('f645a0527_w001_a1_open')).toBe('f645a0527_w001_a1_open_prompt');
    expect(sessionIdFor('f645a0527_w001_a1_open')).toBe('cr_f645a0527_w001_a1_open');
  });

  it('the flag, the 0600 token file read only when a request is made, and a config that holds no credential', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudroom-home-'));
    roots.push(home);
    expect(cloudroomAvailability({}, home)).toMatchObject({ available: false, mode: 'off', why: expect.stringMatching(/TIMMY_FLEET_CLOUDROOM is not set: set it to 1 .*or to "fake"/) });
    expect(cloudroomAvailability({ TIMMY_FLEET_CLOUDROOM: 'fake' }, home)).toMatchObject({ available: true, mode: 'fake', why: expect.stringMatching(/FAKE Cloudroom Core \(simulation/) });
    expect(cloudroomAvailability({ TIMMY_FLEET_CLOUDROOM: 'yes' }, home)).toMatchObject({ available: false });
    expect(cloudroomAvailability({ TIMMY_FLEET_CLOUDROOM: '1' }, home)).toMatchObject({ available: false, mode: 'real', why: expect.stringMatching(/timmy fleet connect cloudroom <url> --token-file <file>/) });

    const core = await fakeCore(); // stands in for a configured Core: it is on 127.0.0.1, so plain http is allowed
    const tokenFile = path.join(home, 'core-token');
    fs.writeFileSync(tokenFile, `${core.token}\n`, { mode: 0o644 });
    fs.chmodSync(tokenFile, 0o644);
    expect(() => writeCloudroomConfig(home, { url: core.url, tokenFile })).toThrow(/allows group or other access \(mode 0644\)/);
    fs.chmodSync(tokenFile, 0o600);
    expect(() => writeCloudroomConfig(home, { url: 'http://core.example.com', tokenFile })).toThrow(/HTTPS/);
    const written = writeCloudroomConfig(home, { url: core.url, tokenFile, label: 'test-core', maxConcurrent: 2 });
    expect(fs.statSync(written.path).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(written.path, 'utf8');
    expect(text).not.toContain(core.token);
    expect(JSON.parse(text)).toEqual({ url: core.url, token_file: tokenFile, label: 'test-core', max_concurrent: 2 });
    expect(cloudroomAvailability({ TIMMY_FLEET_CLOUDROOM: '1' }, home)).toMatchObject({ available: true, mode: 'real', why: expect.stringMatching(/"test-core".*at most 2 sessions.*not verified/) });

    fs.writeFileSync(written.path, JSON.stringify({ url: core.url, token_file: tokenFile, token: core.token }));
    const holds = cloudroomAvailability({ TIMMY_FLEET_CLOUDROOM: '1' }, home);
    expect(holds).toMatchObject({ available: false, why: expect.stringMatching(/must not hold a credential/) });
    expect(holds.why).not.toContain(core.token);
    writeCloudroomConfig(home, { url: core.url, tokenFile, label: 'test-core', maxConcurrent: 2 });

    const opened = await openCloudroomBackend({ TIMMY_FLEET_CLOUDROOM: '1' }, home);
    if (!opened.ok) throw new Error(opened.why);
    expect(opened.ready).toBe(true);
    expect(opened.backend.provisioner.capabilities()).toMatchObject({ maxConcurrent: 2, label: expect.stringMatching(/"test-core".*not verified/) });
    const client = opened.backend.runtime.client;
    fs.writeFileSync(tokenFile, 'FAKE-rotated-token-1\n'); // read again at the next request
    await expect(client.ready()).rejects.toMatchObject({ status: 401 });
    fs.writeFileSync(tokenFile, `${core.token}\n`);
    await expect(client.ready()).resolves.toMatchObject({ ready: true });
    fs.chmodSync(tokenFile, 0o640);
    const before = core.calls.length;
    const loose = await client.ready().catch((e: unknown) => e);
    expect(loose).toBeInstanceOf(CloudroomError);
    expect((loose as Error).message).toMatch(/allows group or other access \(mode 0640\)/);
    expect(shown(loose)).not.toContain(core.token);
    expect(core.calls.length).toBe(before); // refused before any request was made

    const fake = await openCloudroomBackend({ TIMMY_FLEET_CLOUDROOM: 'fake' }, home);
    if (!fake.ok) throw new Error(fake.why);
    expect(fake.backend.mode).toBe('fake');
    expect(fake.backend.label).toBe(FAKE_CORE_LABEL);
    expect(fake.backend.runtime.capabilities().available).toBe(true);
    await fake.backend.shutdown();
  });

  it("the fleet service plans and runs on the FAKE Core through backendFor, as the lead's wiring will", async () => {
    const core = await fakeCore();
    const backend = await backendOn(core);
    const root = project();
    const opts = { backendFor: (id: string) => (id === 'cloudroom' ? backend : undefined) };
    const planned = planFleet(root, { agents: 4, concurrency: 2, provider: 'cloudroom', isolation: 'shared-session', harness: 'codex', model: 'fake-model', prompt: 'FAKE task' }, opts);
    if (!planned.ok) throw new Error(planned.refusals.join('; '));
    expect(planned.preview.lines.join('\n')).toContain(`on ${FAKE_CORE_LABEL}`);
    expect(planned.preview.isolationWords).toMatch(/^a session on a shared machine/);
    const run = await runPlan(root, planned.plan.id, { ...opts, by: 'person' });
    expect(run.status).toBe('finished');
    expect(run.counts.delivered).toBe(4);
    expect(run.backend).toBe(FAKE_CORE_LABEL);
    expect(core.sessionIds()).toHaveLength(4);
  }, 60_000);
});
