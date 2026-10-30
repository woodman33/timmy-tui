import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpenHandsAttemptStore } from '../src/utils/openhands-attempts.js';
import { planHashOf } from '../src/utils/approvals.js';
import type { OpenHandsLifecycle, OpenHandsResult } from '../src/utils/openhands-adapter.js';

const mocks = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', async original => ({
  ...await original<typeof import('child_process')>(), spawnSync: mocks.spawn,
}));
vi.mock('../src/utils/openhands-adapter.js', async original => ({
  ...await original<typeof import('../src/utils/openhands-adapter.js')>(),
  runOpenHandsTask: mocks.run, openHandsPreflight: () => ({ ok: true }),
}));
import { dispatchContainerized, pauseOrCancelLane, type DispatchPlan, type StoredPlan } from '../src/utils/dispatch.js';
import { openHandsAttemptPath } from '../src/utils/openhands-adapter.js';

const dirs: string[] = [];
const stores: OpenHandsAttemptStore[] = [];
const plan: DispatchPlan = {
  schema_version: 'dispatch/0.1', objective: 'offline fixture', deliverables: ['patch'],
  acceptance_tests: ['fixture-check'], harnesses: ['openhands'],
  model_policy: { requested: 'local', allow_paid: false, max_spend_usd: 0 },
  copies: 1, cadence: { mode: 'parallel', depends_on: [] }, context_manifest: [],
  repo_ref: 'fixture-rev', workspace: { kind: 'docker' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] },
  limits: { cost_usd: 0, wall_ms: 1000 }, retry_limit: 1,
  approval: { required: true, mode: 'manual' }, expected_artifacts: ['patch'],
  telemetry: { redact: true, events: true },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-oh-dispatch-test-')); dirs.push(dir);
  const file = join(dir, '.timmy', 'dispatch', 'fixture.json');
  mkdirSync(join(dir, '.timmy', 'dispatch'), { recursive: true });
  const record: StoredPlan = { id: 'fixture', plan, plan_hash: planHashOf(plan),
    approved_hash: planHashOf(plan), lifecycle: 'armed' };
  const save = (value: StoredPlan) => writeFileSync(file, JSON.stringify(value));
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as StoredPlan;
  save(record);
  const store = new OpenHandsAttemptStore(openHandsAttemptPath(dir)); stores.push(store);
  const scope = { principal: 'local-operator', project: resolve(dir), operation: record.id, sourceRevision: 'fixture-rev' };
  return { dir, record, store, scope, save, read };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let complete!: (result: OpenHandsResult) => void;
  const promise = new Promise<OpenHandsResult>(resolve => { complete = resolve; });
  return { promise, complete };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TIMMY_DISPATCH_DRYRUN', '0');
  mocks.spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OpenHands dispatch cancellation (no worker or model executed)', () => {
  it('revokes a persisted attempt without an in-memory controller after restart', () => {
    const f = fixture();
    const attempt = f.store.begin(f.scope);
    f.save({ ...f.record, lifecycle: 'running', openhands_attempt: attempt });
    expect(pauseOrCancelLane(f.record.id, 'cancel', f.dir).ok).toBe(true);
    expect(f.store.complete(attempt, { ok: true, patch: 'late fixture patch',
      workdir: '/fixture', planHash: f.record.plan_hash }).status).toBe('cancelled');
    expect(f.store.current(f.scope)).toBeNull();
    expect(f.read().lifecycle).toBe('archived');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('keeps cancellation archived when a late successful worker resolves', async () => {
    const f = fixture(), pending = deferred();
    const attempt = f.store.begin(f.scope);
    let lifecycle!: OpenHandsLifecycle;
    mocks.run.mockImplementation((_options, internal) => {
      lifecycle = internal;
      lifecycle.onAttempt?.(attempt);
      return pending.promise;
    });
    expect((await dispatchContainerized(f.record.id, f.dir)).ok).toBe(true);
    expect(f.read().openhands_attempt?.attemptId).toBe(attempt.attemptId);
    pauseOrCancelLane(f.record.id, 'cancel', f.dir);
    expect(lifecycle.signal?.aborted).toBe(true);
    pending.complete({ ok: true, attempt });
    await settle();
    expect(f.read().lifecycle).toBe('archived');
  });

  it('ignores an old early failure without an attempt after a newer dispatch starts', async () => {
    const f = fixture(), old = deferred(), fresh = deferred();
    mocks.run.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await dispatchContainerized(f.record.id, f.dir);
    // Trusted test fixture models a separately re-armed newer dispatch.
    f.save({ ...f.read(), lifecycle: 'armed' });
    await dispatchContainerized(f.record.id, f.dir);
    old.complete({ ok: false, note: 'old preflight failure' });
    await settle();
    expect(f.read().lifecycle).toBe('running');
    fresh.complete({ ok: false, note: 'fresh failure' });
    await settle();
    expect(f.read().lifecycle).toBe('failed');
    expect(f.read().blocked?.note).toBe('fresh failure');
  });
});
