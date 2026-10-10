import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { assertPlanApproved } from './approval.js';
import { BaseAgentRuntime } from './base.js';
import { groupLive } from './process-group.js';
import type { ApprovedRunPlan, RunRequest, RunResult, RuntimeAvailability, RuntimeDescriptor, RuntimeEventSink } from './types.js';

export interface SpawnProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stop the child after this many ms (SIGTERM, then SIGKILL; see killGraceMs); the outcome then carries timedOut: true */
  timeoutMs?: number;
  /** cap on captured characters per stream; exceeding it stops the child the same way (spawnSync's maxBuffer) */
  maxBuffer?: number;
  /** start the child as the leader of its own process group, so killProcessGroup(child.pid, …) reaches
   *  everything it starts; the stops (time limit, maxBuffer, stop()) then signal that group */
  detached?: boolean;
  /** keep stdout and stderr in the outcome (the default); false only streams them to onStdout and
   *  onStderr, so a long-lived child (a preview server) does not accumulate its output in memory */
  capture?: boolean;
  /** Round R3: after a stop's SIGTERM, SIGKILL follows this many ms later when the child has not ended
   *  (default KILL_GRACE_MS) — a process that ignores SIGTERM cannot keep the outcome pending */
  killGraceMs?: number;
  /** Round R3: after that SIGKILL, how long the output may stay open before the outcome settles anyway,
   *  its streams let go (default CLOSE_WAIT_MS): a process that left the group can hold them open.
   *  Round R4: for a detached child, also how long its process group may take to go after that SIGKILL */
  closeWaitMs?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ProcessOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** the spawn error (ENOENT …), the buffer overrun, or why the outcome settled while the output was still
   *  open after a stop; null when the child ran to a close */
  error: string | null;
  /** Round R3: how far a stop by this runner went: 'SIGTERM' delivered (and the child ended on it or after),
   *  'SIGKILL' delivered after the grace period; null when this runner delivered no signal (the child ended
   *  by itself, or was already gone when the stop came). Round R4: once a detached child has ended, its group
   *  is signalled only while a process of it still runs (a zombie stops nothing), so 'SIGKILL' means that a
   *  running process needed it */
  killed: 'SIGTERM' | 'SIGKILL' | null;
  /** Round R4: what was left of a detached child's process group when the outcome settled.
   *  'complete': a stop (stop(), the time limit, maxBuffer) had begun, and no process of the group ran any more.
   *  'unresolved': a stop had begun, and processes of the group were still there closeWaitMs after the SIGKILL;
   *  error says so. 'left-running', information only: no stop began, the child ended by itself while processes
   *  of its group still ran, and they were left running (nothing here signals them).
   *  Absent when there is no group to look at (a child started without detached, Windows), or when the child
   *  ended by itself and nothing of its group was left. About the group only: a process that left the group
   *  is not covered (error says when one still held the output). */
  cleanup?: 'complete' | 'unresolved' | 'left-running';
}

export interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  outcome: Promise<ProcessOutcome>;
  /** Stops the child (its process group when detached) as the time limit does: SIGTERM, then SIGKILL after
   *  killGraceMs, then the outcome settles even if the output stays open. True while the outcome is still to
   *  settle (a second call joins the first stop); false once it has settled. Round R4: a detached child's
   *  outcome settles once no process of its group runs, the leader's end alone does not settle it. */
  stop: () => boolean;
}

/** How long a stopped child has between SIGTERM and SIGKILL, unless the caller says otherwise. */
export const KILL_GRACE_MS = 2000;
/** How long the output may stay open after SIGKILL before the outcome settles without it. */
export const CLOSE_WAIT_MS = 1000;
/** Round R4: while a stopped child has ended and the rest of its process group has not, how often the group is checked. */
const GROUP_POLL_MS = 25;

const msOr = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

/**
 * The nonblocking process runner: spawn, stream, capture, time out — never spawnSync, so a slow child
 * leaves the event loop free. `child` is returned so a caller can track it and `stop` so it can cancel it;
 * `outcome` settles once: on close, on a spawn error, or — after a stop's SIGTERM and SIGKILL — when the
 * output is still open closeWaitMs after the SIGKILL. SpawnAgentRuntime.execute and the engine lane's
 * steps (lanes/engines/step.mjs) both run through here. (JobManager runs its own stop sequence on the
 * child it gets from here, and passes none of the stops above.)
 *
 * Round R4 (task H16): once a stop has begun, a detached child's close settles the outcome only when no
 * process of its group runs (./process-group.ts). A leader that obeys SIGTERM can end while a member of its
 * group that ignores it runs on; the stop goes on (SIGKILL to the group after the grace period) until the
 * group is gone, at most closeWaitMs after the SIGKILL, and then says if it is not.
 */
export function spawnProcess(command: string, args: string[], options: SpawnProcessOptions = {}): SpawnedProcess {
  const detached = options.detached === true;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached });
  const grace = msOr(options.killGraceMs, KILL_GRACE_MS);
  const closeWait = msOr(options.closeWaitMs, CLOSE_WAIT_MS);
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  /** Round R4: the POSIX process group a detached child leads (its pid is the group's id); Windows has none. */
  const group = detached && process.platform !== 'win32' && child.pid !== undefined && child.pid > 1 ? child.pid : undefined;
  /** The child (or its group); once the child has exited its pid may be another process's: only its group then. */
  const signalChild = (signal: NodeJS.Signals): boolean => {
    if (detached && child.pid !== undefined) {
      if (!exited()) return killProcessGroup(child.pid, signal);
      if (process.platform === 'win32' || child.pid <= 1) return false;
      // Round R4: a group left with zombies only has nothing to stop (the kernel still "delivers" to them)
      if (!groupLive(child.pid)) return false;
      try { process.kill(-child.pid, signal); return true; } catch { return false; }
    }
    return exited() ? false : child.kill(signal);
  };
  let settled = false;
  let stopping = false;
  let killed: ProcessOutcome['killed'] = null;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void): void => {
    const t = setTimeout(() => { timers.delete(t); run(); }, ms);
    timers.add(t);
  };
  let letGo = (): void => {};
  const stop = (): boolean => {
    if (settled) return false;
    if (stopping) return true;
    stopping = true;
    if (signalChild('SIGTERM')) killed = 'SIGTERM';
    later(grace, () => {
      if (settled) return;
      if (signalChild('SIGKILL')) killed = 'SIGKILL';
      later(closeWait, () => letGo());
    });
    return true;
  };
  const outcome = new Promise<ProcessOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    /** Round R4: the child's close, held while a stop waits for the rest of its process group */
    let closed: { status: number | null; signal: NodeJS.Signals | null } | undefined;
    const max = options.maxBuffer ?? Infinity;
    const capture = options.capture !== false;
    const finish = (status: number | null, signal: NodeJS.Signals | null, cleanup?: ProcessOutcome['cleanup']) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      resolve({ status, signal, stdout, stderr, timedOut, error, killed, ...(cleanup ? { cleanup } : {}) });
    };
    // Round R4: the child closed during a stop while its group still ran. The stop's timers go on (SIGKILL
    // to the group after the grace period, then letGo); the outcome settles as soon as the group is gone.
    const awaitGroup = (): void => {
      if (settled || closed === undefined || group === undefined) return;
      if (!groupLive(group)) { finish(closed.status, closed.signal, 'complete'); return; }
      later(GROUP_POLL_MS, awaitGroup);
    };
    // The stop has run its course and the output is still open, or its group still runs: settle without
    // them, and say why.
    letGo = () => {
      if (settled) return;
      const left = group !== undefined && groupLive(group);
      const why = !exited()
        ? `the process did not end after ${killed ?? 'its stop'}: its output was let go and it may still run`
        : left
          ? `process group ${group} still had processes ${killed === 'SIGKILL' ? 'after SIGKILL' : 'that SIGKILL could not reach'}: cleanup unresolved${closed ? '' : '; its output was let go'}`
          : detached
            ? 'output still open after the process group was stopped: a process it started outside its group may still run'
            : 'output still open after the process was stopped: a process it started may still run';
      error = error === null ? why : `${error}; ${why}`;
      if (closed === undefined) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const cleanup = group === undefined ? undefined : left || !exited() ? 'unresolved' : 'complete';
      if (closed) finish(closed.status, closed.signal, cleanup);
      else finish(child.exitCode, child.signalCode, cleanup);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { if (capture) stdout += text; options.onStdout?.(text); if (stdout.length > max) { error ??= `ENOBUFS: stdout exceeded maxBuffer (${max})`; stop(); } });
    child.stderr.on('data', (text: string) => { if (capture) stderr += text; options.onStderr?.(text); if (stderr.length > max) { error ??= `ENOBUFS: stderr exceeded maxBuffer (${max})`; stop(); } });
    child.once('error', (e) => { error = e.message; finish(null, null); });
    child.once('close', (code, signal) => {
      if (group === undefined) { finish(code, signal); return; }
      // Round R4: no stop has begun: what the child left running is noted and left alone.
      if (!stopping) { finish(code, signal, groupLive(group) ? 'left-running' : undefined); return; }
      // A stop has begun: the child's end is not its group's.
      closed = { status: code, signal };
      awaitGroup();
    });
    if (options.timeoutMs && options.timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  });
  return { child, outcome, stop };
}

/**
 * Signal a whole process group: the group a detached child leads (spawnProcess's `detached`), so the
 * signal reaches every process that child started. Falls back to the single pid when there is no such
 * group (a child spawned without `detached`, or Windows). Returns whether a signal was delivered.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  // 0 and 1 are refused: process.kill(-0) is this process's own group and process.kill(-1) is every process
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal); return true; } catch { /* no such group, or not permitted: the pid alone */ }
  }
  try { process.kill(pid, signal); return true; } catch { return false; }
}

export interface SpawnRuntimeOptions {
  descriptor: RuntimeDescriptor & { command: string };
  buildArgs: (request: RunRequest) => string[];
  versionArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class SpawnAgentRuntime extends BaseAgentRuntime {
  readonly descriptor: RuntimeDescriptor & { command: string };
  private readonly buildArgs: SpawnRuntimeOptions['buildArgs'];
  private readonly versionArgs: string[];
  private readonly extraEnv?: NodeJS.ProcessEnv;
  /** each running plan's stop (round R3: SIGTERM, then SIGKILL after the grace period) */
  private readonly active = new Map<string, () => boolean>();

  constructor(options: SpawnRuntimeOptions) {
    super();
    this.descriptor = options.descriptor;
    this.buildArgs = options.buildArgs;
    this.versionArgs = options.versionArgs ?? ['--version'];
    this.extraEnv = options.env;
  }

  override async plan(request: RunRequest) {
    const plan = await super.plan(request);
    return { ...plan, command: this.descriptor.command, args: this.buildArgs(plan.request) };
  }

  async detect(): Promise<RuntimeAvailability> {
    const missingEnv = (this.descriptor.requiredEnv ?? []).filter(name => !process.env[name]);
    if (missingEnv.length) return { available: false, missingEnv, reason: `Missing environment: ${missingEnv.join(', ')}` };

    const executable = await resolveExecutable(this.descriptor.command);
    if (!executable) return { available: false, reason: `${this.descriptor.command} is not installed or not on PATH` };

    const version = await captureVersion(executable, this.versionArgs, this.extraEnv);
    return { available: true, version };
  }

  async execute(plan: ApprovedRunPlan, sink?: RuntimeEventSink): Promise<RunResult> {
    assertPlanApproved(plan);
    if (!plan.command || !plan.args) throw new Error(`Run plan ${plan.runId} has no spawn command`);

    const startedAt = new Date().toISOString();
    await this.emit(sink, this.event(plan, 'process.started', { command: plan.command, args: plan.args, cwd: plan.request.cwd }));

    const { outcome, stop } = spawnProcess(plan.command, plan.args, {
      cwd: plan.request.cwd,
      env: { ...process.env, ...this.extraEnv },
      timeoutMs: plan.request.timeoutMs && plan.request.timeoutMs > 0 ? plan.request.timeoutMs : undefined,
      onStdout: text => void this.emit(sink, this.event(plan, 'output.stdout', { text })),
      onStderr: text => void this.emit(sink, this.event(plan, 'output.stderr', { text })),
    });
    this.active.set(plan.runId, stop);
    const o = await outcome;
    this.active.delete(plan.runId);

    const status: RunResult['status'] = o.signal ? 'cancelled' : o.error ? 'failed' : o.status === 0 ? 'completed' : 'failed';
    const error = o.signal ? `Terminated by ${o.signal}${o.error ? ` (${o.error})` : ''}` : o.error ?? undefined;
    const finishedAt = new Date().toISOString();
    const result: RunResult = { runId: plan.runId, runtimeId: plan.runtimeId, status, startedAt, finishedAt, exitCode: o.status, error };
    await this.emit(sink, this.event(plan, status === 'completed' ? 'run.completed' : 'run.failed', { exitCode: o.status, error }));
    return result;
  }

  /** SIGTERM, then SIGKILL after the grace period when the run does not end (round R3). */
  async cancel(runId: string): Promise<boolean> {
    const stop = this.active.get(runId);
    return stop ? stop() : false;
  }
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    try { await access(command); return command; } catch { return undefined; }
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  return undefined;
}

function captureVersion(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', () => resolve(undefined));
    child.once('close', () => resolve((stdout.trim() || stderr.trim()).split(/\r?\n/, 1)[0] || undefined));
  });
}
