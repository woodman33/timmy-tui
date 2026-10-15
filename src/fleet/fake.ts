/**
 * Round R4 (lead): a FAKE fleet backend for offline tests and the offline end-to-end slice. Nothing here allocates compute,
 * runs a harness or calls a model: it keeps records in memory and replays scripted events, and everything it says is
 * labelled FAKE. It exists so the fleet's real code (admission, ledger, scheduler, events, collection) can be exercised
 * with 100 workers, faults and reconnects, and kept apart from any real Core or VM validation.
 */
import { createHash } from 'node:crypto';
import type { IsolationClass, ProviderCapabilities } from './plan.js';
import type {
  AllocationSpec, ComputeRecord, ComputeState, CreateOutcome, NativeEvent, Provisioner, Runtime, RuntimeCapabilities, SessionOpen, SessionState,
} from './backend.js';

/** Faults the FAKE backend can be told to produce, per worker index. */
export interface FakeFaults {
  /** create() answers "unknown"; lookup() later finds the compute ("created") or nothing ("absent"). */
  createUnknown?: Map<number, 'created' | 'absent'>;
  /** create() refuses. */
  refuse?: Set<number>;
  /** The event stream drops after this many events (once per worker), so the caller must resume from its cursor. */
  dropAfter?: Map<number, number>;
  /** The session fails instead of completing. */
  fail?: Set<number>;
  /** The compute expires before the session ends. */
  expire?: Set<number>;
  /** A child session starts in the parent's sandbox when children are allowed. */
  childInParent?: Set<number>;
  /** An event carries a credential-like string, to prove it is redacted before storage. */
  leakToken?: Set<number>;
  /** create() never settles until this promise does (for timeout tests). */
  hangCreate?: Map<number, Promise<void>>;
}

export interface FakeOptions {
  isolation?: IsolationClass[];
  maxConcurrent?: number;
  childSpawn?: RuntimeCapabilities['childSpawn'];
  childSpawnCanBeDisabled?: boolean;
  paid?: boolean;
  usdPerWorkerMinute?: number;
  messagesPerTask?: number;
  faults?: FakeFaults;
}

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const workerOf = (allocationKey: string): number => Number((/:w(\d+):/.exec(allocationKey) ?? [])[1] ?? -1);

/**
 * A credential-shaped FAKE string (never a real key) used by the redaction tests: the OpenRouter prefix that
 * src/utils/redact.ts removes, with a tail too short to be a key (the privacy gate's key pattern needs 20 characters).
 */
export const FAKE_LEAKED_TOKEN = 'sk-or-v1-FAKEFAKE';

export class FakeProvisioner implements Provisioner {
  readonly records = new Map<string, ComputeRecord>();
  private readonly byRequest = new Map<string, CreateOutcome>();
  private next = 1;
  peakLive = 0;
  creates = 0;
  destroys = 0;

  constructor(private readonly opts: FakeOptions = {}) {}

  capabilities(): ProviderCapabilities {
    return {
      provider: 'fake',
      label: 'FAKE (offline test backend: no compute, no cost)',
      available: true,
      isolation: this.opts.isolation ?? ['shared-session', 'container', 'provider-sandbox', 'microvm', 'vm'],
      maxConcurrent: this.opts.maxConcurrent ?? 100,
      paid: this.opts.paid ?? false,
      remote: false,
      childSpawnMayShareParent: (this.opts.childSpawn ?? 'may-share-parent') === 'may-share-parent',
      childSpawnCanBeDisabled: this.opts.childSpawnCanBeDisabled ?? true,
      snapshots: false,
      maxTtlMinutes: 120,
      usdPerWorkerMinute: this.opts.usdPerWorkerMinute,
    };
  }

  live(): number {
    return [...this.records.values()].filter((r) => r.state === 'ready' || r.state === 'creating').length;
  }

  async create(spec: AllocationSpec, requestId: string): Promise<CreateOutcome> {
    const seen = this.byRequest.get(requestId);
    if (seen) return seen; // the same request id never makes a second machine
    const w = spec.workerIndex;
    const hang = this.opts.faults?.hangCreate?.get(w);
    if (hang) await hang;
    await yieldNow();
    let out: CreateOutcome;
    if (this.opts.faults?.refuse?.has(w)) out = { outcome: 'refused', reason: 'FAKE: refused by the scripted fault' };
    else if (this.live() >= (this.opts.maxConcurrent ?? 100)) out = { outcome: 'refused', reason: 'FAKE: quota reached' };
    else {
      const providerId = `fake-${spec.isolation}-${String(this.next++).padStart(3, '0')}`;
      const unknown = this.opts.faults?.createUnknown?.get(w);
      if (unknown !== 'absent') {
        this.records.set(spec.allocationKey, { providerId, allocationKey: spec.allocationKey, state: 'ready', isolation: spec.isolation, labels: spec.labels, expiresAt: new Date(Date.now() + spec.ttlMinutes * 60_000).toISOString() });
        this.creates += 1;
        this.peakLive = Math.max(this.peakLive, this.live());
      }
      out = unknown ? { outcome: 'unknown', reason: 'FAKE: the create call timed out before an answer' } : { outcome: 'created', providerId };
    }
    this.byRequest.set(requestId, out);
    return out;
  }

  async lookup(allocationKey: string): Promise<{ state: ComputeState; record?: ComputeRecord }> {
    await yieldNow();
    const r = this.records.get(allocationKey);
    if (r && this.opts.faults?.expire?.has(workerOf(allocationKey)) && r.state === 'ready') r.state = 'expired';
    return r ? { state: r.state, record: { ...r } } : { state: 'absent' };
  }

  async destroy(providerId: string): Promise<{ outcome: 'destroyed' | 'absent' }> {
    await yieldNow();
    for (const r of this.records.values()) {
      if (r.providerId === providerId) {
        if (r.state === 'destroyed') return { outcome: 'destroyed' };
        r.state = 'destroyed';
        this.destroys += 1;
        return { outcome: 'destroyed' };
      }
    }
    return { outcome: 'absent' };
  }

  async list(labels: Record<string, string>): Promise<ComputeRecord[]> {
    await yieldNow();
    return [...this.records.values()].filter((r) => Object.entries(labels).every(([k, v]) => r.labels[k] === v)).map((r) => ({ ...r }));
  }

  /** Test hook: compute that exists at the provider but not in Timmy's ledger (an orphan). */
  plantOrphan(planId: string, workerIndex: number, isolation: IsolationClass): string {
    const providerId = `fake-${isolation}-orphan-${workerIndex}`;
    const allocationKey = `${planId}:w${workerIndex}:orphan`;
    this.records.set(allocationKey, { providerId, allocationKey, state: 'ready', isolation, labels: { 'timmy.plan': planId } });
    return providerId;
  }
}

interface FakeSession {
  id: string;
  computeId: string;
  worker: number;
  events: NativeEvent[];
  state: SessionState;
  dropped: boolean;
  closed: boolean;
  prompt: string;
  harness: string;
  model: string;
  allowChildren: boolean;
}

export class FakeRuntime implements Runtime {
  readonly sessions = new Map<string, FakeSession>();
  private readonly byRequest = new Map<string, string>();
  private next = 1;
  opens = 0;
  peakRunning = 0;

  constructor(private readonly provisioner: FakeProvisioner, private readonly opts: FakeOptions = {}) {}

  capabilities(): RuntimeCapabilities {
    return {
      runtime: 'fake',
      label: 'FAKE (scripted events; no harness runs, no model is called)',
      available: true,
      sessions: true, messages: true, events: true, status: true, queue: false, interrupt: true, close: true, recover: true,
      childSpawn: this.opts.childSpawn ?? 'may-share-parent',
      harnesses: ['codex', 'claude-code', 'pi', 'openhands', 'opencode'],
    };
  }

  running(): number {
    return [...this.sessions.values()].filter((s) => s.state === 'running' || s.state === 'starting').length;
  }

  private worker(computeId: string): number {
    for (const r of this.provisioner.records.values()) if (r.providerId === computeId) return workerOf(r.allocationKey);
    return -1;
  }

  async open(computeId: string, task: { harness: string; model: string; prompt: string; allowChildren: boolean }, requestId: string): Promise<SessionOpen> {
    const seen = this.byRequest.get(requestId);
    if (seen) return { sessionId: seen, accepted: true };
    await yieldNow();
    const id = `fake-session-${String(this.next++).padStart(3, '0')}`;
    const worker = this.worker(computeId);
    this.sessions.set(id, { id, computeId, worker, events: [], state: 'accepted', dropped: false, closed: false, prompt: task.prompt, harness: task.harness, model: task.model, allowChildren: task.allowChildren });
    this.byRequest.set(requestId, id);
    this.opens += 1;
    this.script(this.sessions.get(id)!);
    return { sessionId: id, accepted: true };
  }

  /** The whole scripted story of a session, decided at open; events() releases it a piece at a time. */
  private script(s: FakeSession): void {
    const f = this.opts.faults ?? {};
    const at = () => new Date().toISOString();
    let seq = 0;
    const push = (type: string, data: Record<string, unknown>) => s.events.push({ seq: ++seq, type, at: at(), data });
    push('session.started', { harness: s.harness, model: s.model, note: 'FAKE' });
    const n = this.opts.messagesPerTask ?? 3;
    for (let i = 1; i <= n; i++) push('message', { role: 'assistant', text: `FAKE worker ${s.worker} step ${i} of ${n}` });
    if (f.leakToken?.has(s.worker)) push('tool', { name: 'shell', output: `export OPENROUTER_API_KEY=${FAKE_LEAKED_TOKEN}` });
    if (f.childInParent?.has(s.worker) && s.allowChildren) push('child.spawned', { child: `${s.id}-child`, sandbox: s.computeId, sharedWithParent: true });
    if (f.expire?.has(s.worker)) push('compute.expired', { computeId: s.computeId });
    else if (f.fail?.has(s.worker)) push('session.failed', { reason: 'FAKE: scripted failure' });
    else push('session.completed', { summary: `FAKE result of worker ${s.worker}` });
  }

  async send(sessionId: string): Promise<{ accepted: true }> {
    if (!this.sessions.has(sessionId)) throw new Error(`FAKE: no session ${sessionId}`);
    return { accepted: true };
  }

  async *events(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<NativeEvent> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`FAKE: no session ${sessionId}`);
    if (s.state === 'accepted') s.state = 'running';
    this.peakRunning = Math.max(this.peakRunning, this.running());
    const dropAt = this.opts.faults?.dropAfter?.get(s.worker);
    let sent = 0;
    for (const e of s.events) {
      if (e.seq <= afterSeq) continue;
      if (signal?.aborted || s.state === 'interrupted') return;
      if (dropAt !== undefined && !s.dropped && sent === dropAt) {
        s.dropped = true;
        return; // the connection drops; the caller resumes from its cursor
      }
      await yieldNow();
      sent += 1;
      if (e.type === 'session.completed') s.state = 'completed';
      if (e.type === 'session.failed' || e.type === 'compute.expired') s.state = 'failed';
      yield e;
    }
  }

  async status(sessionId: string): Promise<{ state: SessionState; lastSeq: number }> {
    const s = this.sessions.get(sessionId);
    return s ? { state: s.state, lastSeq: s.events.length } : { state: 'unknown', lastSeq: 0 };
  }

  async interrupt(sessionId: string): Promise<{ accepted: true }> {
    const s = this.sessions.get(sessionId);
    if (s && s.state !== 'completed' && s.state !== 'failed') {
      s.state = 'interrupted';
      s.events.push({ seq: s.events.length + 1, type: 'session.interrupted', at: new Date().toISOString(), data: {} });
    }
    return { accepted: true };
  }

  async close(sessionId: string): Promise<{ accepted: true }> {
    const s = this.sessions.get(sessionId);
    if (s) s.closed = true;
    return { accepted: true };
  }

  async recover(sessionId: string): Promise<{ state: SessionState; lastSeq: number } | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { state: s.state, lastSeq: s.events.length } : undefined;
  }

  async collect(sessionId: string): Promise<{ files: Array<{ path: string; bytes: number; sha256: string; content: Buffer }>; summary?: string }> {
    const s = this.sessions.get(sessionId);
    if (!s) return { files: [] };
    const content = Buffer.from(`FAKE result of worker ${s.worker}\nprompt: ${s.prompt}\n`);
    return { files: [{ path: 'RESULT.md', bytes: content.length, sha256: sha(content), content }], summary: `FAKE result of worker ${s.worker}` };
  }
}

export function fakeBackend(opts: FakeOptions = {}): { provisioner: FakeProvisioner; runtime: FakeRuntime } {
  const provisioner = new FakeProvisioner(opts);
  return { provisioner, runtime: new FakeRuntime(provisioner, opts) };
}
