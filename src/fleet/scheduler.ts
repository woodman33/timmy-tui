/**
 * Round R4 (lead): runs a fleet plan through a backend — admission, bounded concurrency, allocation with its identity
 * written first, sessions, streamed events with resume, collection before teardown, and three separate teardown steps.
 *
 * What it keeps (the operator, 2026-10-15):
 *   - Never more than min(plan concurrency, provider maximum) workers at once; the rest wait in the queue.
 *   - An allocation's key and request id are flushed to the ledger before the provider is asked; an unknown create is
 *     settled by lookup() before anything else is created for that worker; one that cannot be settled stays unknown
 *     and waits for a person.
 *   - A plan that wants one VM (or microVM or provider sandbox) per worker never lets a child session share its
 *     parent's sandbox: children are not allowed, and a child that starts there anyway fails that worker.
 *   - Upstream "completed" is delivery: results are collected, and "verified" stays "not run" until an acceptance check
 *     passes. Stopping the harness, closing the session and destroying the compute are recorded separately.
 *   - A cancel (a signal, or the plan's CANCEL file written by another process) never starts new work; queued workers
 *     are cancelled without being admitted; running ones are stopped, collected and torn down.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Backend, NativeEvent } from './backend.js';
import { checkPlan, type FleetPlan } from './plan.js';
import { FleetLedger, workerDir, writeWhole, type FleetCounts, type WorkerRecord } from './ledger.js';
import { WorkerEvents, type StoredEvent } from './events.js';

export interface FleetTimeouts {
  /** A create (or an accepted create becoming ready) that takes longer becomes "unknown". */
  createMs: number;
  /** A task that runs longer is stopped. */
  taskMs: number;
  /** How many resumes in a row may bring nothing new before the worker fails. */
  reconnects: number;
}

export const DEFAULT_TIMEOUTS: FleetTimeouts = { createMs: 60_000, taskMs: 30 * 60_000, reconnects: 5 };

export interface RunOptions {
  backend: Backend;
  ledger: FleetLedger;
  signal?: AbortSignal;
  timeouts?: Partial<FleetTimeouts>;
  onEvent?: (worker: number, event: StoredEvent) => void;
  onChange?: (worker: WorkerRecord) => void;
}

export interface RunResult {
  planId: string;
  status: 'refused' | 'finished' | 'stopped';
  refusals: string[];
  counts: FleetCounts;
  peakActive: number;
}

const isDedicatedStrict = (plan: FleetPlan): boolean =>
  plan.perWorker === 'dedicated' && (plan.isolation === 'vm' || plan.isolation === 'microvm' || plan.isolation === 'provider-sandbox');

/** Refusals that depend on the runtime (the provider's are in checkPlan). */
export function checkRuntime(plan: FleetPlan, backend: Backend): string[] {
  const rc = backend.runtime.capabilities();
  const p: string[] = [];
  if (!rc.available) p.push(`runtime "${rc.runtime}" is unavailable: ${rc.unavailableReason ?? 'no reason given'}`);
  if (!rc.sessions) p.push(`runtime "${rc.runtime}" cannot open sessions`);
  if (!rc.events) p.push(`runtime "${rc.runtime}" cannot stream events`);
  if (!rc.close) p.push(`runtime "${rc.runtime}" cannot close a session`);
  if (!rc.harnesses.includes(plan.harness)) p.push(`runtime "${rc.runtime}" has no "${plan.harness}" harness (it has: ${rc.harnesses.join(', ') || 'none'})`);
  const pc = backend.provisioner.capabilities();
  if (isDedicatedStrict(plan) && rc.childSpawn === 'may-share-parent' && !pc.childSpawnCanBeDisabled && !pc.childSpawnDetected) {
    p.push(`runtime "${rc.runtime}" may start child sessions in the parent's sandbox and cannot be told not to`);
  }
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** A relative result path that stays inside the result folder, or undefined. */
export function safeResultPath(p: string): string | undefined {
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (!norm || norm === '.' || norm.startsWith('/') || norm === '..' || norm.startsWith('../') || norm.includes('/../')) return undefined;
  return norm;
}

export async function runFleet(opts: RunOptions): Promise<RunResult> {
  const { backend, ledger } = opts;
  const plan = ledger.plan;
  const t: FleetTimeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const caps = backend.provisioner.capabilities();
  const refusals = [...checkPlan(plan, caps), ...checkRuntime(plan, backend)];
  if (refusals.length) {
    for (const w of ledger.snapshot().workers) ledger.record(w.index, 'refused', (r) => { r.phase = 'refused'; r.reason = refusals[0]; });
    ledger.setStatus('finished');
    return { planId: plan.id, status: 'refused', refusals, counts: ledger.counts(), peakActive: 0 };
  }
  ledger.setStatus('running');
  ledger.claimRunner();
  const fleetAbort = new AbortController();
  const stopAll = () => { if (!fleetAbort.signal.aborted) fleetAbort.abort(); };
  opts.signal?.addEventListener('abort', stopAll, { once: true });
  if (opts.signal?.aborted) stopAll();
  const watcher = setInterval(() => { if (ledger.cancelAsked()) stopAll(); }, 200);
  const cap = Math.max(1, Math.min(plan.concurrency, caps.maxConcurrent));
  const queue = ledger.snapshot().workers.filter((w) => w.phase === 'queued').map((w) => w.index);
  const active = new Map<number, Promise<void>>();
  let peakActive = 0;
  const cancelled = () => fleetAbort.signal.aborted || ledger.cancelAsked();
  const changed = (index: number) => opts.onChange?.(ledger.worker(index));
  try {
    while (queue.length || active.size) {
      while (queue.length && active.size < cap && !cancelled()) {
        const index = queue.shift()!;
        const run = runWorker(index, opts, t, fleetAbort.signal).catch((e: unknown) => {
          ledger.record(index, 'error', (r) => { r.phase = 'failed'; r.reason = `Timmy's own error: ${(e as Error).message}`; });
        }).finally(() => { active.delete(index); changed(index); });
        active.set(index, run);
        peakActive = Math.max(peakActive, active.size);
      }
      if (cancelled()) {
        stopAll();
        while (queue.length) {
          const index = queue.shift()!;
          ledger.record(index, 'cancelled before admission', (r) => { r.phase = 'cancelled'; r.reason = 'the plan was cancelled before this worker was admitted'; });
          changed(index);
        }
      }
      if (active.size) await Promise.race(active.values());
    }
  } finally {
    clearInterval(watcher);
    opts.signal?.removeEventListener('abort', stopAll);
    ledger.releaseRunner();
  }
  const stopped = cancelled();
  ledger.setStatus(stopped ? 'stopped' : 'finished');
  return { planId: plan.id, status: stopped ? 'stopped' : 'finished', refusals: [], counts: ledger.counts(), peakActive };
}

async function runWorker(index: number, opts: RunOptions, t: FleetTimeouts, fleetSignal: AbortSignal): Promise<void> {
  const { backend, ledger } = opts;
  const plan = ledger.plan;
  const { provisioner, runtime } = backend;
  const rcaps = runtime.capabilities();
  const strict = isDedicatedStrict(plan);
  const now = () => new Date().toISOString();

  ledger.record(index, 'admitted', (w) => { w.phase = 'admitted'; w.admittedAt = now(); });

  // Allocation: identity first, then the call; settle an unknown outcome before anything else.
  let providerId: string | undefined;
  for (;;) {
    if (fleetSignal.aborted) {
      ledger.record(index, 'cancelled before allocation', (r) => { r.phase = 'cancelled'; r.reason = 'the plan was cancelled before compute was asked for'; });
      return;
    }
    const w = ledger.worker(index);
    const key = w.allocationKey;
    const requestId = `${key}:create`;
    ledger.record(index, 'reserved', (r) => { r.phase = 'allocating'; r.compute = { ...r.compute, state: 'reserved', requestId }; }, { requestId });
    ledger.record(index, 'creating', (r) => { r.compute.state = 'creating'; });
    const spec = {
      planId: plan.id, workerIndex: index, allocationKey: key, isolation: plan.isolation, limits: plan.limits, ttlMinutes: plan.ttlMinutes,
      labels: { 'timmy.plan': plan.id, 'timmy.operation': plan.operationId, 'timmy.worker': String(index), 'timmy.allocation': key },
    };
    const out = await withTimeout(provisioner.create(spec, requestId), t.createMs);
    if (out === 'timeout' || out.outcome === 'unknown') {
      const why = out === 'timeout' ? `no answer to the create within ${t.createMs} ms` : out.reason;
      ledger.record(index, 'create outcome unknown', (r) => { r.compute.state = 'unknown'; r.compute.reason = why; r.phase = 'unknown'; }, { reason: why });
      const found = await provisioner.lookup(key);
      if (found.state === 'ready' && found.record) {
        providerId = found.record.providerId;
        const expiresAt = found.record.expiresAt;
        const pid = providerId;
        ledger.record(index, 'reconciled: created', (r) => { r.compute.state = 'live'; r.compute.providerId = pid; r.compute.expiresAt = expiresAt; r.phase = 'allocating'; }, { providerId: pid });
        break;
      }
      if (found.state === 'absent') {
        ledger.record(index, 'reconciled: absent', (r) => { r.compute.state = 'absent'; }, { reason: 'the provider holds nothing for this allocation key' });
        if (w.attempt >= 2) {
          ledger.record(index, 'gave up', (r) => { r.phase = 'failed'; r.reason = 'two creates ended without compute'; });
          return;
        }
        ledger.record(index, 'new attempt', (r) => {
          r.attempt += 1;
          r.allocationKey = `${plan.id}:w${String(index).padStart(3, '0')}:a${r.attempt}`;
          r.compute = { state: 'none', isolation: plan.isolation };
        });
        continue;
      }
      ledger.record(index, 'unknown kept', (r) => {
        r.phase = 'unknown';
        r.reason = `the provider could not say whether compute exists (${found.state}); a person must check before anything is created again`;
      });
      return;
    }
    if (out.outcome === 'refused') {
      ledger.record(index, 'create refused', (r) => { r.compute.state = 'refused'; r.compute.reason = out.reason; r.phase = 'refused'; r.reason = out.reason; }, { reason: out.reason });
      return;
    }
    let expiresAt: string | undefined;
    if (out.outcome === 'accepted') {
      // accepted is not ready: wait for the provider to say so, within the create timeout
      const deadline = Date.now() + t.createMs;
      while (Date.now() < deadline && !providerId) {
        const found = await provisioner.lookup(key);
        if (found.state === 'ready' && found.record) { providerId = found.record.providerId; expiresAt = found.record.expiresAt; break; }
        if (found.state === 'failed' || found.state === 'absent') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!providerId) {
        ledger.record(index, 'accepted, not ready', (r) => { r.compute.state = 'unknown'; r.phase = 'unknown'; r.reason = 'the provider accepted the create but did not say it was ready in time'; });
        return;
      }
    } else {
      providerId = out.providerId;
      expiresAt = out.expiresAt;
    }
    const pid = providerId;
    ledger.record(index, 'compute live', (r) => { r.compute.state = 'live'; r.compute.providerId = pid; r.compute.expiresAt = expiresAt; }, { providerId: pid });
    break;
  }
  if (!providerId) return;

  // Session: accepted is not running; its id is recorded before any event is read.
  const key = ledger.worker(index).allocationKey;
  const task = plan.tasks[index - 1];
  const opened = await runtime.open(providerId, { harness: plan.harness, model: plan.model, prompt: task.prompt, allowChildren: !strict }, `${key}:open`);
  const sessionId = opened.sessionId;
  ledger.record(index, 'session accepted', (r) => { r.session = { ...r.session, state: 'accepted', sessionId, requestId: `${key}:open` }; r.phase = 'running'; }, { sessionId });

  const events = new WorkerEvents(workerDir(ledger.projectRoot, plan.id, index));
  const taskAbort = new AbortController();
  const onOuterAbort = () => taskAbort.abort();
  fleetSignal.addEventListener('abort', onOuterAbort, { once: true });
  if (fleetSignal.aborted) taskAbort.abort();
  const taskTimer = setTimeout(() => taskAbort.abort(), t.taskMs);
  let terminal: 'delivered' | 'failed' | 'expired' | 'interrupted' | 'violation' | undefined;
  let reason: string | undefined;
  let emptyResumes = 0;
  ledger.record(index, 'streaming', (r) => { r.session.state = 'running'; });
  try {
    while (!terminal) {
      let sawAny = false;
      for await (const e of runtime.events(sessionId, events.afterSeq, taskAbort.signal)) {
        const stored = events.add(e);
        if (!stored) continue;
        sawAny = true;
        opts.onEvent?.(index, stored);
        const verdict = judgeEvent(e, strict);
        if (verdict) { terminal = verdict.terminal; reason = verdict.reason; }
        ledger.record(index, 'event', (r) => { r.session.cursor = events.afterSeq; r.session.events = events.count; });
        if (terminal) break;
      }
      if (terminal) break;
      if (taskAbort.signal.aborted) {
        terminal = 'interrupted';
        reason = fleetSignal.aborted ? 'the plan was cancelled' : `the task ran past ${t.taskMs} ms`;
        break;
      }
      // The stream ended without an end: ask, then resume from the cursor.
      const st = await runtime.status(sessionId);
      if ((st.state === 'completed' || st.state === 'failed' || st.state === 'interrupted') && st.lastSeq <= events.afterSeq) {
        terminal = st.state === 'completed' ? 'delivered' : st.state === 'failed' ? 'failed' : 'interrupted';
        reason = `the runtime says ${st.state}`;
        break;
      }
      emptyResumes = sawAny ? 0 : emptyResumes + 1;
      ledger.record(index, 'stream dropped; resuming', (r) => { r.session.cursor = events.afterSeq; }, { reason: `resume after event ${events.afterSeq}` });
      if (emptyResumes > t.reconnects) {
        terminal = 'failed';
        reason = `the event stream ended ${emptyResumes} times in a row with nothing new, and the runtime did not say the session ended`;
      }
    }
  } finally {
    clearTimeout(taskTimer);
    fleetSignal.removeEventListener('abort', onOuterAbort);
  }

  // Collect before any teardown; delivered is not verified.
  const phase = terminal === 'delivered' ? 'delivered' : terminal === 'expired' ? 'expired' : terminal === 'interrupted' ? 'interrupted' : 'failed';
  ledger.record(index, terminal ?? 'ended', (r) => {
    r.phase = phase;
    r.reason = reason;
    r.session.state = terminal === 'delivered' ? 'delivered' : terminal === 'interrupted' ? 'interrupted' : 'failed';
    if (terminal === 'expired') r.compute.state = 'expired';
  }, { reason });
  await collectWorker(ledger, backend, index);

  // Teardown: three separate steps, each recorded.
  const st = await runtime.status(sessionId).catch(() => ({ state: 'unknown' as const, lastSeq: 0 }));
  if (rcaps.interrupt && (st.state === 'running' || st.state === 'accepted' || st.state === 'starting' || st.state === 'waiting' || terminal === 'violation')) {
    await runtime.interrupt(sessionId, `${key}:interrupt`);
    ledger.record(index, 'harness stopped', (r) => { r.session.harnessStopped = true; }, { sessionId });
  }
  await runtime.close(sessionId, `${key}:close`);
  ledger.record(index, 'session closed', (r) => { r.session.state = 'closed'; }, { sessionId });
  await destroyCompute(ledger, backend, index);
}

function judgeEvent(e: NativeEvent, strict: boolean): { terminal: 'delivered' | 'failed' | 'expired' | 'interrupted' | 'violation'; reason: string } | undefined {
  if (e.type === 'child.spawned' && strict && (e.data as { sharedWithParent?: boolean }).sharedWithParent) {
    return { terminal: 'violation', reason: "a child session started in the parent's sandbox, which breaks this plan's one-sandbox-per-worker isolation; its work is not counted" };
  }
  if (e.type === 'session.completed') return { terminal: 'delivered', reason: 'the runtime said completed (delivered; not verified)' };
  if (e.type === 'session.failed') return { terminal: 'failed', reason: String((e.data as { reason?: unknown }).reason ?? 'failed') };
  if (e.type === 'compute.expired') return { terminal: 'expired', reason: 'the compute expired before the session ended' };
  if (e.type === 'session.interrupted') return { terminal: 'interrupted', reason: 'interrupted' };
  return undefined;
}

/** Copies a worker's result files into its folder before any teardown; a failure is recorded, never hidden. */
export async function collectWorker(ledger: FleetLedger, backend: Backend, index: number): Promise<void> {
  const w = ledger.worker(index);
  if (!w.session.sessionId || w.result.collected) return;
  try {
    const got = await backend.runtime.collect(w.session.sessionId);
    const dir = path.join(workerDir(ledger.projectRoot, ledger.plan.id, index), 'result');
    let files = 0;
    let bytes = 0;
    const manifest: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const f of got.files) {
      const rel = safeResultPath(f.path);
      if (!rel) continue;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), f.content, { mode: 0o600 });
      files += 1;
      bytes += f.bytes;
      manifest.push({ path: rel, bytes: f.bytes, sha256: f.sha256 });
    }
    writeWhole(path.join(dir, 'MANIFEST.json'), `${JSON.stringify({ worker: index, session: w.session.sessionId, files: manifest, collectedAt: new Date().toISOString(), note: 'delivered by the runtime; not verified by Timmy' }, null, 2)}\n`);
    ledger.record(index, 'collected', (r) => { r.result = { ...r.result, collected: true, files, bytes, summary: got.summary }; });
  } catch (e) {
    ledger.record(index, 'collect failed', (r) => {
      r.result = { ...r.result, collected: false };
      r.reason = `${r.reason ? `${r.reason}; ` : ''}nothing collected: ${(e as Error).message}`;
    });
  }
}

export async function destroyCompute(ledger: FleetLedger, backend: Backend, index: number): Promise<void> {
  const w = ledger.worker(index);
  const providerId = w.compute.providerId;
  if (!providerId || w.compute.state === 'destroyed') return;
  ledger.record(index, 'destroying', (r) => { r.compute.state = 'destroying'; }, { providerId });
  const out = await backend.provisioner.destroy(providerId, `${w.allocationKey}:destroy`);
  ledger.record(index, out.outcome === 'destroyed' ? 'compute destroyed' : `destroy: ${out.outcome}`, (r) => {
    r.compute.state = out.outcome === 'destroyed' ? 'destroyed' : out.outcome === 'absent' ? 'absent' : 'unknown';
  }, { providerId, reason: out.reason });
}

/**
 * Settles what a crash or a lost answer left: unknown or half-made allocations (by lookup), sessions Timmy lost track of
 * (by recover), and compute labelled with this plan that the ledger does not hold or no longer needs (orphans).
 */
export async function reconcileFleet(ledger: FleetLedger, backend: Backend): Promise<{ settled: string[]; orphansDestroyed: string[]; stillUnknown: number[] }> {
  const settled: string[] = [];
  const stillUnknown: number[] = [];
  for (const w of ledger.snapshot().workers) {
    if (w.compute.state === 'unknown' || w.compute.state === 'creating' || w.compute.state === 'reserved') {
      const found = await backend.provisioner.lookup(w.allocationKey);
      if (found.state === 'ready' && found.record) {
        const pid = found.record.providerId;
        ledger.record(w.index, 'reconciled: live', (r) => { r.compute.state = 'live'; r.compute.providerId = pid; }, { providerId: pid });
        settled.push(`worker ${w.index}: compute exists (${pid})`);
        if (!w.session.sessionId) {
          await destroyCompute(ledger, backend, w.index);
          ledger.record(w.index, 'not resumed', (r) => {
            if (r.phase === 'unknown' || r.phase === 'allocating') { r.phase = 'failed'; r.reason = 'its compute was made but no session was opened; the compute was destroyed'; }
          });
          settled.push(`worker ${w.index}: compute destroyed (no session was ever opened on it)`);
        }
      } else if (found.state === 'absent') {
        ledger.record(w.index, 'reconciled: absent', (r) => { r.compute.state = 'absent'; if (r.phase === 'unknown' || r.phase === 'allocating') { r.phase = 'failed'; r.reason = 'no compute was made'; } });
        settled.push(`worker ${w.index}: no compute exists`);
      } else stillUnknown.push(w.index);
    }
    if (w.session.sessionId && (w.session.state === 'running' || w.session.state === 'accepted')) {
      const rec = await backend.runtime.recover(w.session.sessionId);
      ledger.record(w.index, 'session recovered', (r) => {
        r.session.state = rec?.state === 'completed' ? 'delivered' : rec?.state === 'failed' ? 'failed' : rec ? r.session.state : 'closed';
      }, { sessionId: w.session.sessionId, reason: rec ? `the runtime says ${rec.state}` : 'the runtime no longer knows this session' });
      settled.push(`worker ${w.index}: session ${rec ? rec.state : 'unknown to the runtime'}`);
    }
  }
  const orphansDestroyed: string[] = [];
  const held = new Map(ledger.snapshot().workers.filter((w) => w.compute.providerId).map((w) => [w.compute.providerId as string, w]));
  for (const rec of await backend.provisioner.list({ 'timmy.plan': ledger.plan.id })) {
    if (rec.state === 'destroyed' || rec.state === 'absent') continue;
    const owner = held.get(rec.providerId);
    const needed = owner && (owner.phase === 'running' || owner.phase === 'allocating') && owner.compute.state === 'live';
    if (!needed) {
      const out = await backend.provisioner.destroy(rec.providerId, `${rec.allocationKey}:orphan-destroy`);
      orphansDestroyed.push(`${rec.providerId} (${out.outcome})`);
      if (owner) ledger.record(owner.index, 'orphan destroyed', (r) => { if (out.outcome === 'destroyed') r.compute.state = 'destroyed'; }, { providerId: rec.providerId });
    }
  }
  return { settled, orphansDestroyed, stillUnknown };
}
