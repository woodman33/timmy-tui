/**
 * Round R4 (lead): the fleet core against the FAKE backend (src/fleet/fake.ts) — no compute, no harness, no model, no
 * network. REAL: Timmy's own plan checks, ledger, scheduler, event store and reconciliation, writing to a temporary
 * project folder. What these tests show is simulation, kept apart from any real Core or VM validation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkPlan, infraCeilingUsd, makePlan, MAX_WORKERS, type PlanInput } from '../src/fleet/plan.js';
import { FleetLedger, planDir, readJsonl, runnerOf, workerDir, type Transition } from '../src/fleet/ledger.js';
import { fakeBackend, FAKE_LEAKED_TOKEN, FakeProvisioner, FakeRuntime, type FakeOptions } from '../src/fleet/fake.js';
import { reconcileFleet, runFleet, safeResultPath } from '../src/fleet/scheduler.js';
import { WorkerEvents, type StoredEvent } from '../src/fleet/events.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const project = (): string => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-core-'));
  roots.push(r);
  return r;
};
const input = (root: string, over: Partial<PlanInput> = {}): PlanInput => ({
  project: { root, revision: 'abc1234', dirty: false },
  operationId: 'o0000aaaa',
  agents: 10,
  concurrency: 3,
  provider: 'fake',
  isolation: 'vm',
  harness: 'codex',
  model: 'fake-model',
  prompt: 'FAKE task',
  ...over,
});
const start = (root: string, over: Partial<PlanInput> = {}, fake: FakeOptions = {}) => {
  const backend = fakeBackend(fake);
  const plan = makePlan(input(root, over));
  const ledger = FleetLedger.create(root, plan);
  return { backend, plan, ledger };
};

describe('fleet plan checks', () => {
  it('refuses what a provider cannot give, in words, and never clamps', () => {
    const root = project();
    const caps = new FakeProvisioner({ isolation: ['container'] }).capabilities();
    expect(checkPlan(makePlan(input(root, { isolation: 'vm' })), caps).join('\n')).toMatch(/cannot give a virtual machine .*refused rather than run with less/);
    expect(checkPlan(makePlan(input(root, { agents: 101 })), new FakeProvisioner().capabilities()).join('\n')).toMatch(`workers must be 1 to ${MAX_WORKERS}`);
    expect(checkPlan(makePlan(input(root, { agents: 4, concurrency: 5 })), new FakeProvisioner().capabilities()).join('\n')).toMatch(/concurrency 5 is more than the 4 workers/);
    const strict = new FakeProvisioner({ childSpawn: 'may-share-parent', childSpawnCanBeDisabled: false }).capabilities();
    expect(checkPlan(makePlan(input(root)), strict).join('\n')).toMatch(/child sessions in their parent's sandbox .* cannot be kept/);
  });

  it('paid compute needs a TTL and a budget; local-only and free-only policies hold', () => {
    const root = project();
    const paid = new FakeProvisioner({ paid: true, usdPerWorkerMinute: 0.01 }).capabilities();
    const p = makePlan(input(root, { policy: { freeOnly: false }, budgets: { infraUsd: 0 } }));
    expect(checkPlan(p, paid).join('\n')).toMatch(/infrastructure budget above \$0/);
    expect(checkPlan(makePlan(input(root)), paid).join('\n')).toMatch(/free only and provider "fake" costs money/);
    const remote = { ...new FakeProvisioner().capabilities(), remote: true };
    expect(checkPlan(makePlan(input(root, { policy: { localOnly: true } })), remote).join('\n')).toMatch(/local only/);
    // 100 workers x 30 min x $0.01 = $30 as a stated ceiling; a free provider's is $0; an unstated price is unknown
    expect(infraCeilingUsd(makePlan(input(root, { agents: 100, concurrency: 4 })), paid)).toBe(30);
    expect(infraCeilingUsd(makePlan(input(root)), new FakeProvisioner().capabilities())).toBe(0);
    expect(infraCeilingUsd(makePlan(input(root)), new FakeProvisioner({ paid: true }).capabilities())).toBeUndefined();
  });
});

describe('100 simulated workers', () => {
  it('runs 100 workers, never more than the cap at once, each with its own FAKE vm, collected before teardown', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 100, concurrency: 4 });
    const res = await runFleet({ backend, ledger });
    expect(res.status).toBe('finished');
    expect(res.peakActive).toBeLessThanOrEqual(4);
    expect(backend.provisioner.peakLive).toBeLessThanOrEqual(4);
    expect(backend.runtime.peakRunning).toBeLessThanOrEqual(4);
    expect(res.counts).toMatchObject({ requested: 100, admitted: 100, queued: 0, running: 0, liveAllocations: 0, unknownAllocations: 0, delivered: 100, verified: 0, failed: 0 });
    expect(backend.provisioner.creates).toBe(100);
    expect(backend.provisioner.destroys).toBe(100);
    const ids = new Set(ledger.snapshot().workers.map((w) => w.compute.providerId));
    expect(ids.size).toBe(100); // one distinct allocation per worker
    for (const w of ledger.snapshot().workers) {
      expect(w.compute.state).toBe('destroyed');
      expect(w.session.state).toBe('closed');
      expect(w.result).toMatchObject({ collected: true, files: 1, verified: 'not run' });
      expect(fs.existsSync(path.join(workerDir(root, plan.id, w.index), 'result', 'MANIFEST.json'))).toBe(true);
    }
    // the reservation is flushed before the create, and the result collected before the session closes
    const tr = readJsonl<Transition>(path.join(planDir(root, plan.id), 'allocations.jsonl'));
    for (const w of ledger.snapshot().workers) {
      const mine = tr.filter((x) => x.worker === w.index).map((x) => x.what);
      expect(mine.indexOf('reserved')).toBeLessThan(mine.indexOf('creating'));
      expect(mine.indexOf('collected')).toBeLessThan(mine.indexOf('session closed'));
      expect(mine.indexOf('session closed')).toBeLessThan(mine.indexOf('compute destroyed'));
    }
    expect(runnerOf(root, plan.id)).toBeUndefined();
  }, 60_000);

  it('a second run of a finished plan creates nothing, and a resent request id never makes a second machine or session', async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 5, concurrency: 5 });
    await runFleet({ backend, ledger });
    const creates = backend.provisioner.creates;
    const again = await runFleet({ backend, ledger });
    expect(again.counts.delivered).toBe(5);
    expect(backend.provisioner.creates).toBe(creates);
    const p = new FakeProvisioner();
    const spec = { planId: 'fdeadbeef', workerIndex: 1, allocationKey: 'fdeadbeef:w001:a1', isolation: 'vm' as const, limits: { cpu: 1, ramGb: 1, diskGb: 1 }, ttlMinutes: 5, labels: {} };
    const a = await p.create(spec, 'r1');
    const b = await p.create(spec, 'r1');
    expect(a).toEqual(b);
    expect(p.creates).toBe(1);
    const rt = new FakeRuntime(p);
    const id = a.outcome === 'created' ? a.providerId : '';
    const s1 = await rt.open(id, { harness: 'codex', model: 'm', prompt: 'x', allowChildren: false }, 'open-1');
    const s2 = await rt.open(id, { harness: 'codex', model: 'm', prompt: 'x', allowChildren: false }, 'open-1');
    expect(s1.sessionId).toBe(s2.sessionId);
    expect(rt.opens).toBe(1);
  });
});

describe('faults', () => {
  it('a dropped event stream resumes from the stored cursor: no event lost, none repeated', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 3, concurrency: 3 }, { messagesPerTask: 6, faults: { dropAfter: new Map([[2, 3]]) } });
    await runFleet({ backend, ledger });
    const w2 = ledger.worker(2);
    expect(w2.phase).toBe('delivered');
    const stored = new WorkerEvents(workerDir(root, plan.id, 2)).all();
    const seqs = stored.map((e) => e.native.seq);
    expect(seqs).toEqual([...new Set(seqs)]);
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
    expect(stored.map((e) => e.n)).toEqual(stored.map((_, i) => i + 1));
    expect(seqs.length).toBe(1 + 6 + 1); // started, 6 messages, completed
    expect(ledger.transitions().some((t) => t.worker === 2 && t.what === 'stream dropped; resuming')).toBe(true);
  });

  it('an unknown create is settled by lookup before anything else; absent means a new attempt, found means go on', async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 3, concurrency: 3 }, { faults: { createUnknown: new Map<number, 'created' | 'absent'>([[1, 'created'], [2, 'absent']]) } });
    await runFleet({ backend, ledger });
    expect(ledger.worker(1)).toMatchObject({ phase: 'delivered', attempt: 1 });
    expect(ledger.worker(2)).toMatchObject({ phase: 'delivered', attempt: 2 });
    expect(ledger.worker(2).allocationKey).toMatch(/:w002:a2$/);
    const tr = ledger.transitions().filter((t) => t.worker === 1).map((t) => t.what);
    expect(tr).toContain('create outcome unknown');
    expect(tr).toContain('reconciled: created');
  });

  it('an outcome nobody can settle stays unknown, waits for a person, and nothing is created again', async () => {
    const root = project();
    const fake = fakeBackend({ faults: { createUnknown: new Map([[1, 'created']]) } });
    const provisioner = Object.assign(Object.create(Object.getPrototypeOf(fake.provisioner)), fake.provisioner) as FakeProvisioner;
    provisioner.lookup = async () => ({ state: 'unknown' });
    const backend = { provisioner, runtime: fake.runtime };
    const ledger = FleetLedger.create(root, makePlan(input(root, { agents: 1, concurrency: 1 })));
    await runFleet({ backend, ledger });
    expect(ledger.worker(1).phase).toBe('unknown');
    expect(ledger.worker(1).reason).toMatch(/a person must check before anything is created again/);
    expect(ledger.counts().unknownAllocations).toBe(1);
    expect(provisioner.creates).toBe(1);
  });

  it('allocation timeouts: a create that never answers is unknown; compute that appears later is an orphan, and reconcile destroys it', async () => {
    const root = project();
    let release!: () => void;
    const hang = new Promise<void>((r) => { release = r; });
    const { backend, plan, ledger } = start(root, { agents: 2, concurrency: 2 }, { faults: { hangCreate: new Map([[1, hang]]) } });
    const res = await runFleet({ backend, ledger, timeouts: { createMs: 50 } });
    expect(res.counts.delivered).toBe(1);
    expect(ledger.worker(1)).toMatchObject({ phase: 'failed', reason: 'two creates ended without compute' });
    release();
    await new Promise((r) => setTimeout(r, 50)); // the provider now makes both late machines
    const late = await backend.provisioner.list({ 'timmy.plan': plan.id });
    expect(late.filter((r) => r.state === 'ready').length).toBe(2);
    const rec = await reconcileFleet(ledger, backend);
    expect(rec.orphansDestroyed.length).toBe(2);
    expect((await backend.provisioner.list({ 'timmy.plan': plan.id })).every((r) => r.state === 'destroyed')).toBe(true);
  });

  it("a dedicated-VM plan never lets a child share its parent's sandbox: children are not allowed, and one that starts anyway fails the worker", async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 3, concurrency: 3 }, { faults: { childInParent: new Set([1]), childIgnoresFlag: new Set([2]) } });
    await runFleet({ backend, ledger });
    expect([...backend.runtime.sessions.values()].every((s) => s.allowChildren === false)).toBe(true);
    expect(ledger.worker(1).phase).toBe('delivered'); // the runtime honoured "no children"
    expect(ledger.worker(2)).toMatchObject({ phase: 'failed' });
    expect(ledger.worker(2).reason).toMatch(/parent's sandbox, which breaks this plan's one-sandbox-per-worker isolation/);
    expect(ledger.worker(2).session.harnessStopped).toBe(true);
    expect(ledger.worker(2).compute.state).toBe('destroyed');
    expect(ledger.counts().delivered).toBe(2);
  });

  it('refuses before any create when the runtime cannot be told to keep children apart', async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 3, concurrency: 3 }, { childSpawn: 'may-share-parent', childSpawnCanBeDisabled: false });
    const res = await runFleet({ backend, ledger });
    expect(res.status).toBe('refused');
    expect(res.refusals.join('\n')).toMatch(/parent's sandbox/);
    expect(backend.provisioner.creates).toBe(0);
    expect(ledger.counts()).toMatchObject({ refused: 3, admitted: 0 });
  });

  it('credentials in events are redacted before anything is written', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 2, concurrency: 2 }, { faults: { leakToken: new Set([1]) } });
    await runFleet({ backend, ledger });
    const tool = new WorkerEvents(workerDir(root, plan.id, 1)).all().find((e: StoredEvent) => e.kind === 'tool');
    expect(tool?.text).toContain('[REDACTED_OPENROUTER_KEY]');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(planDir(root, plan.id))) expect(fs.readFileSync(f, 'utf8')).not.toContain(FAKE_LEAKED_TOKEN);
  });

  it('expired compute: the worker is expired, nothing is collected (and that is said), and teardown still runs', async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 2, concurrency: 2 }, { faults: { expire: new Set([2]) } });
    await runFleet({ backend, ledger });
    expect(ledger.worker(2)).toMatchObject({ phase: 'expired' });
    expect(ledger.worker(2).result.collected).toBe(false);
    expect(ledger.worker(2).reason).toMatch(/nothing collected: FAKE: the compute expired/);
    expect(ledger.worker(2).compute.state).toBe('destroyed');
    expect(ledger.worker(1).phase).toBe('delivered');
  });

  it('cleanup after a partial failure: refusals and failures leave no live compute behind', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 6, concurrency: 3 }, { faults: { refuse: new Set([2]), fail: new Set([3, 5]) } });
    const res = await runFleet({ backend, ledger });
    expect(res.counts).toMatchObject({ delivered: 3, failed: 2, refused: 1, liveAllocations: 0 });
    expect((await backend.provisioner.list({ 'timmy.plan': plan.id })).filter((r) => r.state !== 'destroyed')).toEqual([]);
  });
});

describe('cancellation and recovery', () => {
  it('a cancel stops new work: queued workers are never admitted, running ones are stopped, collected and torn down', async () => {
    const root = project();
    const { backend, ledger } = start(root, { agents: 20, concurrency: 2 }, { messagesPerTask: 20, eventDelayMs: 5 });
    const abort = new AbortController();
    let delivered = 0;
    const res = await runFleet({ backend, ledger, signal: abort.signal, onChange: (w) => { if (w.phase === 'delivered' && ++delivered === 2) abort.abort(); } });
    expect(res.status).toBe('stopped');
    const c = res.counts;
    expect(c.delivered + c.cancelled).toBe(20);
    expect(c.admitted).toBeLessThan(20);
    expect(ledger.snapshot().workers.some((w) => w.phase === 'queued')).toBe(false);
    for (const w of ledger.snapshot().workers.filter((x) => x.phase === 'interrupted')) {
      expect(w.session.harnessStopped).toBe(true);
      expect(w.compute.state).toBe('destroyed');
    }
    expect(backend.provisioner.live()).toBe(0);
  }, 60_000);

  it('another process stops a running plan through its CANCEL file', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 6, concurrency: 2 }, { messagesPerTask: 50, eventDelayMs: 10 });
    const run = runFleet({ backend, ledger });
    await new Promise((r) => setTimeout(r, 120));
    expect(runnerOf(root, plan.id)?.pid).toBe(process.pid);
    FleetLedger.open(root, plan.id).requestCancel(); // as `timmy fleet stop` would, from another process
    const res = await run;
    expect(res.status).toBe('stopped');
    expect(backend.provisioner.live()).toBe(0);
  }, 60_000);

  it('after a crash between a reservation and its answer, reconcile finds the compute, destroys what no session uses, and says so', async () => {
    const root = project();
    const { backend, plan, ledger } = start(root, { agents: 1, concurrency: 1 });
    const w = ledger.worker(1);
    ledger.record(1, 'reserved', (r) => { r.phase = 'allocating'; r.compute.state = 'reserved'; });
    ledger.record(1, 'creating', (r) => { r.compute.state = 'creating'; });
    // the provider made it; the answer was lost with the process
    await backend.provisioner.create({ planId: plan.id, workerIndex: 1, allocationKey: w.allocationKey, isolation: 'vm', limits: plan.limits, ttlMinutes: 30, labels: { 'timmy.plan': plan.id } }, `${w.allocationKey}:create`);
    const reopened = FleetLedger.open(root, plan.id); // a new process
    const rec = await reconcileFleet(reopened, backend);
    expect(rec.settled.join('\n')).toMatch(/compute destroyed \(no session was ever opened on it\)/);
    expect(reopened.worker(1)).toMatchObject({ phase: 'failed' });
    expect(backend.provisioner.live()).toBe(0);
  });

  it('collected result paths stay inside the result folder', () => {
    expect(safeResultPath('RESULT.md')).toBe('RESULT.md');
    expect(safeResultPath('a/b.txt')).toBe('a/b.txt');
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', '..', '.']) expect(safeResultPath(bad)).toBeUndefined();
  });
});
