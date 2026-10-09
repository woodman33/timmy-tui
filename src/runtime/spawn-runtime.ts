import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { assertPlanApproved } from './approval.js';
import { BaseAgentRuntime } from './base.js';
import type { ApprovedRunPlan, RunRequest, RunResult, RuntimeAvailability, RuntimeDescriptor, RuntimeEventSink } from './types.js';

export interface SpawnProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** SIGTERM after this many ms; the outcome then carries timedOut: true */
  timeoutMs?: number;
  /** cap on captured characters per stream; exceeding it terminates the child (spawnSync's maxBuffer) */
  maxBuffer?: number;
  /** start the child as the leader of its own process group, so killProcessGroup(child.pid, …) reaches
   *  everything it starts; the timeout and maxBuffer stops above then signal that group */
  detached?: boolean;
  /** keep stdout and stderr in the outcome (the default); false only streams them to onStdout and
   *  onStderr, so a long-lived child (a preview server) does not accumulate its output in memory */
  capture?: boolean;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ProcessOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** the spawn error (ENOENT …) or the buffer overrun; null when the child ran to a close */
  error: string | null;
}

/**
 * The nonblocking process runner: spawn, stream, capture, time out with SIGTERM — never spawnSync,
 * so a slow child leaves the event loop free. `child` is returned so a caller can track or cancel
 * it; `outcome` settles once on close or on a spawn error. SpawnAgentRuntime.execute and the engine
 * lane's steps (lanes/engines/step.mjs) both run through here.
 */
export function spawnProcess(command: string, args: string[], options: SpawnProcessOptions = {}): { child: ChildProcessWithoutNullStreams; outcome: Promise<ProcessOutcome> } {
  const detached = options.detached === true;
  const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached });
  const terminate = () => { if (detached && child.pid !== undefined) killProcessGroup(child.pid, 'SIGTERM'); else child.kill('SIGTERM'); };
  const outcome = new Promise<ProcessOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: string | null = null;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const max = options.maxBuffer ?? Infinity;
    const capture = options.capture !== false;
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr, timedOut, error });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { if (capture) stdout += text; options.onStdout?.(text); if (stdout.length > max) { error ??= `ENOBUFS: stdout exceeded maxBuffer (${max})`; terminate(); } });
    child.stderr.on('data', (text: string) => { if (capture) stderr += text; options.onStderr?.(text); if (stderr.length > max) { error ??= `ENOBUFS: stderr exceeded maxBuffer (${max})`; terminate(); } });
    child.once('error', (e) => { error = e.message; finish(null, null); });
    child.once('close', (code, signal) => finish(code, signal));
    if (options.timeoutMs && options.timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  });
  return { child, outcome };
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
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();

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

    const { child, outcome } = spawnProcess(plan.command, plan.args, {
      cwd: plan.request.cwd,
      env: { ...process.env, ...this.extraEnv },
      timeoutMs: plan.request.timeoutMs && plan.request.timeoutMs > 0 ? plan.request.timeoutMs : undefined,
      onStdout: text => void this.emit(sink, this.event(plan, 'output.stdout', { text })),
      onStderr: text => void this.emit(sink, this.event(plan, 'output.stderr', { text })),
    });
    this.active.set(plan.runId, child);
    const o = await outcome;
    this.active.delete(plan.runId);

    const status: RunResult['status'] = o.signal ? 'cancelled' : o.error ? 'failed' : o.status === 0 ? 'completed' : 'failed';
    const error = o.signal ? `Terminated by ${o.signal}` : o.error ?? undefined;
    const finishedAt = new Date().toISOString();
    const result: RunResult = { runId: plan.runId, runtimeId: plan.runtimeId, status, startedAt, finishedAt, exitCode: o.status, error };
    await this.emit(sink, this.event(plan, status === 'completed' ? 'run.completed' : 'run.failed', { exitCode: o.status, error }));
    return result;
  }

  async cancel(runId: string): Promise<boolean> {
    const child = this.active.get(runId);
    return child ? child.kill('SIGTERM') : false;
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
