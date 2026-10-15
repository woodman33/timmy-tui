/**
 * Round R4 (lead): the fleet's own records, in the project's folder — the plan, every allocation's transitions, each
 * worker's state, events and collected result.
 *
 *   .timmy/fleet/<plan id>/plan.json          the plan as made (never edited)
 *   .timmy/fleet/<plan id>/allocations.jsonl  every transition, appended and flushed before the call it announces
 *   .timmy/fleet/<plan id>/state.json         the workers as they stand (rewritten whole; a reader never sees half)
 *   .timmy/fleet/<plan id>/w<NNN>/events.jsonl  normalized events beside the native ones (redacted)
 *   .timmy/fleet/<plan id>/w<NNN>/cursor.json   the last native event read, so a reconnect resumes there
 *   .timmy/fleet/<plan id>/w<NNN>/result/       what was collected before any teardown
 *
 * An allocation's identity (its key and request id) is written BEFORE the provider is asked to create it, so a crash
 * between the two leaves a record that reconcile() can settle; an unknown outcome is never retried blind.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FleetPlan, IsolationClass } from './plan.js';

export type ComputePhase = 'none' | 'reserved' | 'creating' | 'unknown' | 'live' | 'refused' | 'failed' | 'expired' | 'destroying' | 'destroyed' | 'absent';
export type SessionPhase = 'none' | 'accepted' | 'running' | 'delivered' | 'failed' | 'interrupted' | 'closing' | 'closed';
export type WorkerPhase = 'queued' | 'admitted' | 'allocating' | 'unknown' | 'running' | 'delivered' | 'failed' | 'interrupted' | 'expired' | 'refused' | 'cancelled';

export interface WorkerRecord {
  index: number;
  taskId: string;
  title: string;
  phase: WorkerPhase;
  attempt: number;
  allocationKey: string;
  compute: { state: ComputePhase; providerId?: string; isolation: IsolationClass; requestId?: string; expiresAt?: string; reason?: string };
  session: { state: SessionPhase; sessionId?: string; requestId?: string; cursor: number; events: number; harnessStopped?: boolean };
  result: { collected: boolean; files: number; bytes: number; summary?: string; verified: 'not run' | 'passed' | 'failed' };
  /** When admission let this worker start (a worker cancelled while queued was never admitted). */
  admittedAt?: string;
  updatedAt: string;
  reason?: string;
}

export interface FleetState {
  planId: string;
  operationId: string;
  status: 'planned' | 'running' | 'stopping' | 'stopped' | 'finished';
  workers: WorkerRecord[];
  updatedAt: string;
  cancelRequested: boolean;
}

export interface Transition {
  at: string;
  worker: number;
  allocationKey: string;
  what: string;
  providerId?: string;
  sessionId?: string;
  requestId?: string;
  reason?: string;
}

/** The counts the operator asked to keep apart, never folded into one number. */
export interface FleetCounts {
  requested: number;
  admitted: number;
  queued: number;
  allocating: number;
  running: number;
  liveAllocations: number;
  unknownAllocations: number;
  delivered: number;
  verified: number;
  failed: number;
  cancelled: number;
  refused: number;
}

export const fleetRoot = (projectRoot: string): string => path.join(projectRoot, '.timmy', 'fleet');
export const planDir = (projectRoot: string, planId: string): string => path.join(fleetRoot(projectRoot), planId);
export const workerDir = (projectRoot: string, planId: string, index: number): string => path.join(planDir(projectRoot, planId), `w${String(index).padStart(3, '0')}`);
export const allocationKey = (planId: string, index: number, attempt: number): string => `${planId}:w${String(index).padStart(3, '0')}:a${attempt}`;

/** Writes a whole file so a reader sees the old one or the new one, never half (temp in the same folder, then rename). */
export function writeWhole(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Appends one line and flushes it to disk before returning. */
export function appendFlushed(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn last line from a crash is skipped, never guessed */ }
  }
  return out;
}

export class FleetLedger {
  private state: FleetState;

  private constructor(readonly projectRoot: string, readonly plan: FleetPlan, state: FleetState) {
    this.state = state;
  }

  get dir(): string { return planDir(this.projectRoot, this.plan.id); }

  /** Writes a new plan's folder; refuses to overwrite a plan that exists. */
  static create(projectRoot: string, plan: FleetPlan): FleetLedger {
    const dir = planDir(projectRoot, plan.id);
    fs.mkdirSync(fleetRoot(projectRoot), { recursive: true });
    fs.mkdirSync(dir, { recursive: false }); // throws when the plan id exists
    writeWhole(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const now = new Date().toISOString();
    const workers: WorkerRecord[] = plan.tasks.map((t, i) => ({
      index: i + 1,
      taskId: t.id,
      title: t.title,
      phase: 'queued',
      attempt: 1,
      allocationKey: allocationKey(plan.id, i + 1, 1),
      compute: { state: 'none', isolation: plan.isolation },
      session: { state: 'none', cursor: 0, events: 0 },
      result: { collected: false, files: 0, bytes: 0, verified: 'not run' },
      updatedAt: now,
    }));
    const ledger = new FleetLedger(projectRoot, plan, { planId: plan.id, operationId: plan.operationId, status: 'planned', workers, updatedAt: now, cancelRequested: false });
    ledger.save();
    return ledger;
  }

  static open(projectRoot: string, planId: string): FleetLedger {
    const dir = planDir(projectRoot, planId);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as FleetPlan;
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as FleetState;
    return new FleetLedger(projectRoot, plan, state);
  }

  static list(projectRoot: string): string[] {
    const root = fleetRoot(projectRoot);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((d) => /^f[0-9a-f]{8}$/.test(d) && fs.existsSync(path.join(root, d, 'state.json'))).sort();
  }

  snapshot(): FleetState {
    return JSON.parse(JSON.stringify(this.state)) as FleetState;
  }

  worker(index: number): WorkerRecord {
    const w = this.state.workers[index - 1];
    if (!w) throw new Error(`no worker ${index} in plan ${this.plan.id}`);
    return w;
  }

  /** Records a transition (flushed) and the new worker state (whole file). */
  record(index: number, what: string, change: (w: WorkerRecord) => void, extra: Partial<Transition> = {}): WorkerRecord {
    const w = this.worker(index);
    change(w);
    w.updatedAt = new Date().toISOString();
    appendFlushed(path.join(this.dir, 'allocations.jsonl'), JSON.stringify({ at: w.updatedAt, worker: index, allocationKey: w.allocationKey, what, ...extra }));
    this.save();
    return w;
  }

  setStatus(status: FleetState['status']): void {
    this.state.status = status;
    this.save();
  }

  requestCancel(): void {
    this.state.cancelRequested = true;
    this.save();
  }

  transitions(): Transition[] {
    return readJsonl<Transition>(path.join(this.dir, 'allocations.jsonl'));
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    writeWhole(path.join(this.dir, 'state.json'), `${JSON.stringify(this.state, null, 2)}\n`);
  }

  counts(): FleetCounts {
    return countWorkers(this.plan.agents, this.state.workers);
  }
}

export function countWorkers(requested: number, workers: WorkerRecord[]): FleetCounts {
  const c: FleetCounts = { requested, admitted: 0, queued: 0, allocating: 0, running: 0, liveAllocations: 0, unknownAllocations: 0, delivered: 0, verified: 0, failed: 0, cancelled: 0, refused: 0 };
  for (const w of workers) {
    if (w.phase === 'queued') c.queued += 1;
    if (w.admittedAt) c.admitted += 1;
    if (w.phase === 'allocating') c.allocating += 1;
    if (w.session.state === 'running' || w.session.state === 'accepted') c.running += 1;
    if (w.compute.state === 'live' || w.compute.state === 'creating') c.liveAllocations += 1;
    if (w.compute.state === 'unknown') c.unknownAllocations += 1;
    if (w.phase === 'delivered') c.delivered += 1;
    if (w.result.verified === 'passed') c.verified += 1;
    if (w.phase === 'failed' || w.phase === 'expired') c.failed += 1;
    if (w.phase === 'cancelled' || w.phase === 'interrupted') c.cancelled += 1;
    if (w.phase === 'refused') c.refused += 1;
  }
  return c;
}
