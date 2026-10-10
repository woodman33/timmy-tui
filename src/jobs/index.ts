/**
 * Background jobs for the REPL: builds, upmd workflow runs and preview servers run while the REPL stays
 * usable, with visible progress, results, and a cancellation that also stops what the job started.
 *
 * Each job is one child process run through spawnProcess (src/runtime/spawn-runtime.ts) as the leader
 * of its own process group, so stop() and the time limits signal the whole group. Every state comes
 * from an actual event: the spawn, the exit, the ready address answering, a stop or a time limit.
 * A record (<dir>/<id>.json, rewritten through a temp file and a rename at every change) and a private
 * log (<dir>/<id>.log: stdout and stderr lines combined) let a later session list what ran.
 *
 * A detached group does not receive the terminal's Ctrl+C: whoever owns the manager (the REPL) calls
 * stopAll() before it exits. Round R4 (H46): each record names that owner (its pid and start), so when a REPL
 * ended without its stop path, a later session's recovery can tell which jobs it left and record their end
 * (endLeft) once their processes are gone or stopped.
 *
 * What a job covers is its process group. A process that leaves the group (setsid, a daemon that
 * detaches itself) is not tracked, stopped or reported here (independent verification of b1ede23).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { groupLive } from '../runtime/process-group.js';
import { killProcessGroup, spawnProcess, type ProcessOutcome } from '../runtime/spawn-runtime.js';
// Round R4 (H51): each job carries the operation that started it; its callbacks run back inside that operation.
import { inOperationId, jobEnvironment, operationField, OPERATION_ID } from '../ops/context.js';

export type JobKind = 'task' | 'workflow' | 'server';
export type JobState = 'queued' | 'running' | 'ready' | 'completed' | 'failed' | 'cancelled';
export interface JobStep { name: string; index?: number; state: 'running' | 'completed' | 'failed'; code?: number }
export interface JobRecord {
  /** 'j' + 6 hex chars, unique in the jobs dir */
  id: string;
  kind: JobKind; label: string;
  /** project name */
  project: string;
  /** folder the job runs in */
  root: string;
  command: string; args: string[];
  state: JobState;
  pid?: number;
  startedAt: string; endedAt?: string; readyAt?: string;
  exitCode?: number | null; signal?: string | null;
  /** servers: the address that answered */
  url?: string;
  /** filled by parseLine (workflows) */
  steps: JobStep[];
  /** full combined output, private */
  logPath: string;
  /** output lines so far */
  lines: number;
  error?: string;
  /** set from the seal callback */
  receipt?: string;
  /** a persisted record whose process is gone without a final state */
  stale?: boolean;
  /** what happened beyond the state, in a sentence: its first process ended while what it started kept running */
  note?: string;
  /** Round R4: after a stop of this manager's (/stop, the time limit, stopWhen, not ready), or (H46) of a later
   *  session's recovery that stopped the group its ended REPL left running (endLeft): 'complete' when no process of
   *  the job's group ran any more, 'unresolved' when some still did after the SIGKILL wait (error says so). About the
   *  process group only, like the job itself. Absent when no stop ran. */
  cleanup?: 'complete' | 'unresolved';
  /** Round R4 (H46): the process whose manager started the job (a REPL's): its pid and when it started. While that
   *  process runs, the job's first process is its child; a later session's recovery tells by this whether the job was
   *  left running by a REPL that ended (src/repl/recover.ts). Absent in records written before R4 (H46). */
  owner?: { pid: number; startedAt: string };
  /** Round R4 (H51): the operation (one request) that started the job (src/ops/context.ts); its process gets it as
   *  TIMMY_OPERATION. Absent in records written before, and for a job no request started. */
  operation?: string;
}
export interface JobSpec {
  kind: JobKind; label: string; project: string; root: string;
  command: string; args: string[];
  /** added to this process's environment */
  env?: NodeJS.ProcessEnv;
  /** whole-job limit: stop the group, end 'failed' with error 'timed out' */
  timeoutMs?: number;
  /** servers: 'ready' once an HTTP request to url gets ANY response (timeoutMs: how long to wait, default 60 s) */
  ready?: { url: string; timeoutMs?: number };
  /** may push or update job.steps */
  parseLine?: (line: string, job: JobRecord) => void;
  /** R2: stop the job, failed with this error, when a line of its output matches (an app waiting for a person) */
  stopWhen?: { pattern: RegExp; error: string };
  /**
   * Round R4 (H25): 'closed' ends the child's stdin as soon as it is spawned, so it reads the end of its input at
   * once: for a program that reads piped stdin to its end (codex exec appends piped stdin to its prompt), since a
   * job's stdin is a pipe nothing here ever writes. Absent: the pipe stays open, as before.
   */
  stdin?: 'closed';
}
export interface JobManagerOptions { dir: string; onChange?: (job: JobRecord) => void; seal?: (job: JobRecord) => string | undefined; now?: () => Date }

const KINDS: ReadonlySet<string> = new Set<JobKind>(['task', 'workflow', 'server']);
const STATES: ReadonlySet<string> = new Set<JobState>(['queued', 'running', 'ready', 'completed', 'failed', 'cancelled']);
const STEP_STATES: ReadonlySet<string> = new Set<JobStep['state']>(['running', 'completed', 'failed']);
const JOB_ID = /^j[0-9a-f]{6}$/;
const RECORD_FILE = /^(j[0-9a-f]{6})\.json$/;
/** the ready address is asked again POLL_MS after each unanswered request; each request gets PROBE_MS */
const POLL_MS = 200;
const PROBE_MS = 1000;
/** how long a server may take to answer when its spec names no ready.timeoutMs */
const READY_MS = 60_000;
const GRACE_MS = 2000;
/** after SIGKILL, how long to wait for the group to go before giving up on it */
const KILL_WAIT_MS = 3000;
const WATCH_MS = 25;
/** while the first process has ended and what it started still runs, how often the group is checked */
const LINGER_POLL_MS = 250;
/** setTimeout's ceiling; a longer limit is no limit */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** a line longer than this is cut into pieces of this size, so one endless line cannot grow without bound */
const MAX_LINE = 64 * 1024;
/** what a job's error says when its stop could not end every process of its group */
const NOT_STOPPED = 'some processes it started did not stop';
const TAIL_LINES = 20;
/** Round R4 (H46): this process, as the owner of the jobs its managers start: its pid and when it started (from its uptime). */
const OWNER = { pid: process.pid, startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString() };
/** The states of a job that has not ended. */
const LIVE_STATES: ReadonlySet<string> = new Set<JobState>(['queued', 'running', 'ready']);

interface Ending { state: 'cancelled' | 'failed'; error?: string }

interface Entry {
  job: JobRecord;
  spec: JobSpec;
  seq: number;
  /** the open log while the job runs */
  fd?: number;
  child?: ChildProcessWithoutNullStreams;
  /** set once the process has closed (or failed to spawn) */
  outcome?: ProcessOutcome;
  /** why this manager is stopping the job; set before the first signal */
  ending?: Ending;
  /** the stop sequence under way, if any; it ends the job when the group is gone */
  stopping?: Promise<void>;
  finished: boolean;
  timers: Set<NodeJS.Timeout>;
  out: LineSplitter;
  err: LineSplitter;
  done: Promise<JobRecord>;
  resolveDone: (job: JobRecord) => void;
  readyWaiters: Array<(job: JobRecord) => void>;
}

export class JobManager {
  private readonly dir: string;
  private readonly opts: JobManagerOptions;
  private readonly jobs = new Map<string, Entry>();
  private seq = 0;

  constructor(opts: JobManagerOptions) {
    if (!opts || typeof opts.dir !== 'string' || !opts.dir) throw new TypeError('JobManager needs a jobs dir');
    this.opts = opts;
    this.dir = path.resolve(opts.dir);
  }

  /** Start a job; returns at once (state 'queued') while the process starts and runs in the background. */
  start(spec: JobSpec): JobRecord {
    checkSpec(spec);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const { id, fd } = this.claim();
    const job: JobRecord = {
      id, kind: spec.kind, label: spec.label, project: spec.project, root: path.resolve(spec.root),
      command: spec.command, args: [...spec.args], state: 'queued', startedAt: this.stamp(),
      steps: [], logPath: this.logFile(id), lines: 0, owner: { ...OWNER },
      // Round R4 (H51): the operation this job is started in, if any (and the run noted with it).
      ...operationField('job', id),
    };
    let resolveDone: (job: JobRecord) => void = () => undefined;
    const done = new Promise<JobRecord>((resolve) => { resolveDone = resolve; });
    const entry: Entry = { job, spec, seq: ++this.seq, fd, finished: false, timers: new Set(), out: new LineSplitter(), err: new LineSplitter(), done, resolveDone, readyWaiters: [] };
    this.jobs.set(id, entry);
    this.changed(entry);
    const limit = spec.timeoutMs;
    if (limit !== undefined && limit > 0) this.timer(entry, limit, () => void this.terminate(entry, { state: 'failed', error: 'timed out' }));
    if (spec.kind === 'server' && spec.ready) {
      // the address must not answer before this server exists, or its answer would not be this server's
      const url = spec.ready.url;
      void answers(url).then((busy) => {
        if (entry.finished) return;
        if (busy) this.finish(entry, 'failed', { error: `${url} already answered before this server started` });
        else this.launch(entry);
      });
    } else {
      this.launch(entry);
    }
    return snapshot(job);
  }

  /** SIGTERM the job's process group, SIGKILL it after graceMs; the job ends 'cancelled' once the group is gone.
   *  A job another session started is returned as listed and left alone (its pid may belong to someone else by now). */
  async stop(id: string, graceMs = GRACE_MS): Promise<JobRecord | undefined> {
    const entry = this.jobs.get(id);
    if (!entry) return this.get(id);
    if (!entry.finished) await this.terminate(entry, { state: 'cancelled' }, Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : GRACE_MS);
    return snapshot(entry.job);
  }

  get(id: string): JobRecord | undefined {
    const entry = this.jobs.get(id);
    if (entry) return snapshot(entry.job);
    return JOB_ID.test(id) ? this.readPersisted(id) : undefined;
  }

  /** This manager's jobs and the records earlier sessions left in the dir, newest first. */
  list(): JobRecord[] {
    const rows = [...this.jobs.values()].map((entry) => ({ job: snapshot(entry.job), seq: entry.seq }));
    for (const id of this.persistedIds()) {
      if (this.jobs.has(id)) continue;
      const job = this.readPersisted(id);
      if (job) rows.push({ job, seq: 0 });
    }
    return rows.sort((a, b) => time(b.job.startedAt) - time(a.job.startedAt) || b.seq - a.seq).map((row) => row.job);
  }

  /** The last n complete lines of the job's log. */
  tail(id: string, n = TAIL_LINES): string[] {
    const count = Math.floor(n);
    if (!JOB_ID.test(id) || !(count > 0)) return [];
    return lastLines(this.logFile(id), count);
  }

  /** Resolves at a terminal state. A job another session started resolves at once with its record as listed. */
  done(id: string): Promise<JobRecord> {
    const entry = this.jobs.get(id);
    return entry ? entry.done.then(snapshot) : this.asListed(id);
  }

  /** Resolves at 'ready' or at a terminal state (a task or workflow is never ready). */
  ready(id: string): Promise<JobRecord> {
    const entry = this.jobs.get(id);
    if (!entry) return this.asListed(id);
    if (entry.finished || entry.job.state === 'ready') return Promise.resolve(snapshot(entry.job));
    return new Promise((resolve) => { entry.readyWaiters.push(resolve); });
  }

  /** Stop every job of this manager that is still going (the REPL's exit). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((entry) => !entry.finished).map((entry) => this.stop(entry.job.id)));
  }

  /**
   * Round R4 (H46): records the end of a job another session left in the jobs folder, through this module's own writer:
   * what a later session's recovery found or did once that session's REPL had ended (src/repl/recover.ts): the job's
   * process was gone, or recovery stopped its process group. Only a record still in a live state (queued, running,
   * ready) is changed, never a job of this manager; how the job's process exited is not known here, so the exit code
   * and signal are recorded as null. Returns the record as written, or undefined when nothing was written.
   */
  endLeft(id: string, end: { state: 'failed' | 'cancelled'; error: string; cleanup?: 'complete' | 'unresolved' }): JobRecord | undefined {
    if (this.jobs.has(id) || !JOB_ID.test(id)) return undefined;
    const left = this.readPersisted(id);
    if (!left || !LIVE_STATES.has(left.state)) return undefined;
    const { stale: _stale, ...job } = left;
    const ended: JobRecord = { ...job, state: end.state, endedAt: this.stamp(), exitCode: null, signal: null, error: end.error, ...(end.cleanup ? { cleanup: end.cleanup } : {}) };
    return this.persist(ended) ? snapshot(ended) : undefined;
  }

  /** Round R4 (H29): signal a job's process group at once, without waiting (the REPL exiting at once). Only a job of
   *  this manager that is still going; once its first process has exited, only its group, never that pid alone. */
  signalNow(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.jobs.get(id);
    const child = entry?.child;
    if (!entry || entry.finished || child?.pid === undefined) return false;
    return killProcessGroup(child.pid, signal, { leaderExited: leaderExited(child) });
  }

  private launch(entry: Entry): void {
    const { job, spec } = entry;
    let folder = false;
    try { folder = statSync(job.root).isDirectory(); } catch { /* missing */ }
    if (!folder) { this.finish(entry, 'failed', { error: `no such folder: ${job.root}` }); return; }
    let started: ReturnType<typeof spawnProcess>;
    try {
      started = spawnProcess(job.command, job.args, {
        // Round R4 (H51): TIMMY_OPERATION is the job's own operation, or absent (never one inherited from elsewhere).
        cwd: job.root, env: jobEnvironment(process.env, spec.env, job.operation), detached: true, capture: false,
        onStdout: (text) => this.output(entry, entry.out, text),
        onStderr: (text) => this.output(entry, entry.err, text),
      });
    } catch (e) {
      this.finish(entry, 'failed', { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const { child, outcome } = started;
    entry.child = child;
    if (spec.stdin === 'closed') {
      child.stdin.on('error', () => { /* the child is gone or never started: its outcome says so */ });
      child.stdin.end();
    }
    child.once('spawn', () => {
      if (entry.finished) return;
      job.pid = child.pid;
      this.setState(entry, 'running');
      if (spec.kind === 'server' && spec.ready && !entry.ending) this.watchReady(entry, spec.ready);
    });
    void outcome.then((o) => {
      entry.outcome = o;
      this.flush(entry);
      if (!entry.stopping) this.settle(entry);
    });
  }

  /** The process has closed (or never spawned): end the job by what happened. */
  private settle(entry: Entry): void {
    const o = entry.outcome;
    if (entry.finished || !o) return;
    const { job, spec } = entry;
    const exit = { exitCode: o.status, signal: o.signal };
    if (o.error !== null && job.pid === undefined) return this.finish(entry, 'failed', { ...exit, error: o.error });
    if (entry.ending) return this.finish(entry, entry.ending.state, { ...exit, error: entry.ending.error });
    // Review at c7475458: the first process ending is not the job ending while what it started still runs.
    // The job keeps its state (running, or ready) until the group is gone, so /stop and the exit reach it.
    if (job.pid !== undefined && groupLive(job.pid)) {
      if (job.note === undefined) {
        job.note = `its first process ended (${o.signal ? `signal ${o.signal}` : `exit ${o.status}`}) while processes it started kept running`;
        this.changed(entry);
      }
      this.timer(entry, LINGER_POLL_MS, () => { if (!entry.stopping) this.settle(entry); });
      return;
    }
    if (o.error !== null) return this.finish(entry, 'failed', { ...exit, error: o.error });
    if (spec.kind === 'server' && spec.ready && job.readyAt === undefined) return this.finish(entry, 'failed', { ...exit, error: 'exited before it was ready' });
    this.finish(entry, o.status === 0 ? 'completed' : 'failed', exit);
  }

  /** Stop the whole process group: SIGTERM, then SIGKILL after graceMs; the job ends as `ending` once the group is gone. */
  private terminate(entry: Entry, ending: Ending, graceMs = GRACE_MS): Promise<void> {
    if (entry.finished) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    entry.ending ??= ending;
    const child = entry.child;
    if (!child) {
      // not started yet (a server's address check is still out): nothing to signal
      this.finish(entry, entry.ending.state, { error: entry.ending.error });
      return Promise.resolve();
    }
    const sequence = async (): Promise<void> => {
      const pid = child.pid;
      if (pid === undefined) { await waitFor(() => entry.outcome !== undefined, KILL_WAIT_MS); return; }  // a spawn error on its way
      const gone = () => entry.outcome !== undefined && !groupLive(pid);
      killProcessGroup(pid, 'SIGTERM', { leaderExited: leaderExited(child) });
      if (await waitFor(gone, graceMs)) return;
      killProcessGroup(pid, 'SIGKILL', { leaderExited: leaderExited(child) });
      if (await waitFor(gone, KILL_WAIT_MS)) return;
      if (entry.outcome === undefined && (child.exitCode !== null || child.signalCode !== null)) {
        // the leader is gone but a process that left its group still holds the output pipes: let go of them
        child.stdout.destroy();
        child.stderr.destroy();
        await waitFor(() => entry.outcome !== undefined, KILL_WAIT_MS);
      }
    };
    entry.stopping = sequence().finally(() => {
      entry.stopping = undefined;
      // A stop that could not end every process of the group says so: the job is not reported as fully stopped.
      // Round R4 (H16): also when its ending already had a reason (timed out …), and in a structured field.
      const pid = child.pid;
      if (pid !== undefined && entry.ending) {
        const left = groupLive(pid);
        entry.job.cleanup = left ? 'unresolved' : 'complete';
        if (left) entry.ending = { ...entry.ending, error: entry.ending.error ? `${entry.ending.error}; ${NOT_STOPPED}` : NOT_STOPPED };
      }
      this.settle(entry);
    });
    return entry.stopping;
  }

  /** Servers: ask the ready address until it answers, the job ends, or ready.timeoutMs passes. */
  private watchReady(entry: Entry, ready: { url: string; timeoutMs?: number }): void {
    const limit = ready.timeoutMs ?? READY_MS;
    if (limit > 0) {
      this.timer(entry, limit, () => {
        if (entry.job.state === 'running') void this.terminate(entry, { state: 'failed', error: `not ready: no answer from ${ready.url} within ${limit} ms` });
      });
    }
    const waiting = () => !entry.finished && !entry.ending && entry.job.state === 'running';
    const attempt = (): void => {
      if (!waiting()) return;
      void answers(ready.url).then((answered) => {
        if (!waiting()) return;
        if (!answered) { this.timer(entry, POLL_MS, attempt); return; }
        entry.job.url = ready.url;
        this.setState(entry, 'ready');
        for (const resolve of entry.readyWaiters.splice(0)) resolve(snapshot(entry.job));
      });
    };
    attempt();
  }

  private finish(entry: Entry, state: 'completed' | 'failed' | 'cancelled', end: { exitCode?: number | null; signal?: string | null; error?: string }): void {
    if (entry.finished) return;
    entry.finished = true;
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    this.flush(entry);
    if (entry.fd !== undefined) {
      try { closeSync(entry.fd); } catch { /* already closed */ }
      entry.fd = undefined;
    }
    const { job } = entry;
    job.state = state;
    job.endedAt = this.stamp();
    job.exitCode = end.exitCode ?? null;
    job.signal = end.signal ?? null;
    if (end.error !== undefined) job.error = end.error;
    if (this.opts.seal) {
      try {
        // Round R4 (H51): sealed inside the job's own operation, whichever request ended it (a /stop, a time limit).
        const seal = this.opts.seal;
        const receipt = inOperationId(job.operation, () => seal(snapshot(job)));
        if (typeof receipt === 'string') job.receipt = receipt;
      } catch { /* a seal that throws leaves no receipt; the outcome stands */ }
    }
    this.changed(entry);
    for (const resolve of entry.readyWaiters.splice(0)) resolve(snapshot(job));
    entry.resolveDone(snapshot(job));
  }

  private setState(entry: Entry, state: 'running' | 'ready'): void {
    entry.job.state = state;
    if (state === 'ready') entry.job.readyAt = this.stamp();
    this.changed(entry);
  }

  /** Persist the record, then tell the listener: every state change and every new or updated step. */
  private changed(entry: Entry): void {
    this.persist(entry.job);
    if (!this.opts.onChange) return;
    const onChange = this.opts.onChange;
    // Round R4 (H51): the listener runs inside the job's own operation (what it seals or starts belongs to that request).
    try { inOperationId(entry.job.operation, () => onChange(snapshot(entry.job))); } catch { /* a listener's failure is not the job's */ }
  }

  private output(entry: Entry, splitter: LineSplitter, text: string): void {
    if (entry.finished) return;
    const lines = splitter.push(text);
    if (lines.length) this.record(entry, lines);
  }

  /** The streams have ended: their last unterminated lines are lines too. */
  private flush(entry: Entry): void {
    const lines = [...entry.out.end(), ...entry.err.end()];
    if (lines.length) this.record(entry, lines);
  }

  private record(entry: Entry, lines: string[]): void {
    if (entry.fd !== undefined) {
      try { writeAll(entry.fd, `${lines.join('\n')}\n`); } catch { /* a full disk loses log text, not the job */ }
    }
    entry.job.lines += lines.length;
    if (entry.spec.parseLine) for (const line of lines) this.parse(entry, entry.spec.parseLine, line);
    // R2 (the Mac run): an app that asks a question and waits for a person would only end at the time limit.
    const stop = entry.spec.stopWhen;
    if (stop && !entry.ending && !entry.finished && lines.some((line) => stop.pattern.test(line))) void this.terminate(entry, { state: 'failed', error: stop.error });
  }

  private parse(entry: Entry, parseLine: NonNullable<JobSpec['parseLine']>, line: string): void {
    const { job } = entry;
    try {
      const before = JSON.stringify(job.steps);
      // the parser sees a copy that shares job.steps: pushing to or updating the steps is the change it can make
      const view: JobRecord = { ...job, args: [...job.args] };
      try { parseLine(line, view); } catch { /* a parser that throws on a line leaves the job running */ }
      if (view.steps !== job.steps && Array.isArray(view.steps)) job.steps = view.steps;
      if (JSON.stringify(job.steps) !== before) this.changed(entry);
    } catch { /* steps that cannot be serialized are not recorded */ }
  }

  private timer(entry: Entry, ms: number, run: () => void): void {
    if (!Number.isFinite(ms) || ms > MAX_TIMER_MS) return;
    const timer = setTimeout(() => { entry.timers.delete(timer); run(); }, ms);
    timer.unref();
    entry.timers.add(timer);
  }

  /** A fresh id: 'j' and 6 hex digits, unused here and in the dir; creating its log exclusively claims it. */
  private claim(): { id: string; fd: number } {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = `j${randomBytes(3).toString('hex')}`;
      if (this.jobs.has(id) || existsSync(this.recordFile(id))) continue;
      try { return { id, fd: openSync(this.logFile(id), 'wx', 0o600) }; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new Error('no free job id in the jobs dir');
  }

  /** Writes the record through a temp file and a rename; whether it was written. */
  private persist(job: JobRecord): boolean {
    const file = this.recordFile(job.id);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
      return true;
    } catch {
      try { unlinkSync(temp); } catch { /* never written */ }
      return false;
    }
  }

  /** A record left in the dir, stale when it never reached a final state and its process is gone. */
  private readPersisted(id: string): JobRecord | undefined {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.recordFile(id), 'utf8')); } catch { return undefined; }
    const job = parseRecord(raw, id, this.logFile(id));
    if (job && (job.state === 'running' || job.state === 'ready') && !pidAlive(job.pid) && !(job.pid !== undefined && groupLive(job.pid))) job.stale = true;
    return job;
  }

  private persistedIds(): string[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.map((name) => RECORD_FILE.exec(name)?.[1]).filter((id): id is string => id !== undefined);
  }

  private asListed(id: string): Promise<JobRecord> {
    const job = this.get(id);
    return job ? Promise.resolve(job) : Promise.reject(new Error(`no job ${id}`));
  }

  private stamp(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private recordFile(id: string): string { return path.join(this.dir, `${id}.json`); }
  private logFile(id: string): string { return path.join(this.dir, `${id}.log`); }
}

/** Splits a stream's text into lines: \n and \r\n end a line (also when split across chunks), and so does
 *  a lone \r (a progress redraw), except at a line's start, where it makes no line of its own. */
class LineSplitter {
  private rest = '';

  push(text: string): string[] {
    const buffer = this.rest + text;
    // a final \r may be half of a \r\n: it is decided with the next chunk
    const held = buffer.endsWith('\r');
    const body = held ? buffer.slice(0, -1) : buffer;
    const lines: string[] = [];
    const eol = /\r\n|\r|\n/g;
    let start = 0;
    for (let m = eol.exec(body); m; m = eol.exec(body)) {
      const line = body.slice(start, m.index);
      start = m.index + m[0].length;
      if (m[0] === '\r' && !line) continue;
      lines.push(line);
    }
    let rest = body.slice(start);
    while (rest.length > MAX_LINE) { lines.push(rest.slice(0, MAX_LINE)); rest = rest.slice(MAX_LINE); }
    this.rest = held ? `${rest}\r` : rest;
    return lines;
  }

  end(): string[] {
    const last = this.rest.endsWith('\r') ? this.rest.slice(0, -1) : this.rest;
    this.rest = '';
    return last ? [last] : [];
  }
}

function checkSpec(spec: JobSpec): void {
  if (!spec || !KINDS.has(spec.kind)) throw new TypeError('a job kind is task, workflow or server');
  if (typeof spec.command !== 'string' || !spec.command) throw new TypeError('a job needs a command');
  if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === 'string')) throw new TypeError('job args are strings');
  if (typeof spec.label !== 'string' || typeof spec.project !== 'string') throw new TypeError('a job needs a label and a project');
  if (typeof spec.root !== 'string' || !spec.root) throw new TypeError('a job needs a root folder');
  if (spec.ready === undefined) return;
  if (spec.kind !== 'server') throw new TypeError('only a server job has a ready address');
  let protocol = '';
  try { protocol = new URL(spec.ready.url).protocol; } catch { /* not a URL */ }
  if (protocol !== 'http:' && protocol !== 'https:') throw new TypeError(`ready.url is not an http(s) address: ${String(spec.ready.url)}`);
}

/** Whether an HTTP request to url gets any response at all: any status, redirects not followed. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) { resolve(true); return; }
      const left = deadline - performance.now();
      if (left <= 0) { resolve(false); return; }
      setTimeout(check, Math.min(WATCH_MS, left));
    };
    check();
  });
}

// Whether any process of a job's group still runs: groupLive (../runtime/process-group.ts, moved there in
// round R4 so spawnProcess asks it the same way).

/** Round R4 (H29): the job's first process has exited and been reaped: its pid may be another process's by now. */
function leaderExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeAll(fd: number, text: string): void {
  const data = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < data.length;) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) return;
    offset += written;
  }
}

/** The last n complete lines of a log, read backwards from its end. */
function lastLines(file: string, n: number): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const chunks: Buffer[] = [];
    let position = fstatSync(fd).size;
    let newlines = 0;
    while (position > 0 && newlines <= n) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      const read = readSync(fd, chunk, 0, length, position);
      for (let i = chunk.indexOf(10); i !== -1 && i < read; i = chunk.indexOf(10, i + 1)) newlines++;
      chunks.unshift(chunk.subarray(0, read));
    }
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (position > 0) lines.shift(); // the first piece began mid-line
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

function snapshot(job: JobRecord): JobRecord {
  return { ...job, args: [...job.args], steps: job.steps.map((step) => (step && typeof step === 'object' ? { ...step } : step)) };
}

function time(stamp: string): number {
  const t = Date.parse(stamp);
  return Number.isNaN(t) ? 0 : t;
}

/** A persisted record, rebuilt from its known fields; anything malformed is not listed. */
function parseRecord(raw: unknown, id: string, logPath: string): JobRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === 'string';
  if (r.id !== id || !text(r.kind) || !KINDS.has(r.kind) || !text(r.state) || !STATES.has(r.state)) return undefined;
  if (!text(r.label) || !text(r.project) || !text(r.root) || !text(r.command) || !text(r.startedAt)) return undefined;
  if (!Array.isArray(r.args) || !r.args.every(text)) return undefined;
  const job: JobRecord = {
    id, kind: r.kind as JobKind, label: r.label, project: r.project, root: r.root, command: r.command, args: [...r.args],
    state: r.state as JobState, startedAt: r.startedAt, steps: Array.isArray(r.steps) ? r.steps.flatMap(parseStep) : [],
    logPath, lines: typeof r.lines === 'number' && Number.isFinite(r.lines) ? r.lines : 0,
  };
  if (typeof r.pid === 'number' && Number.isInteger(r.pid)) job.pid = r.pid;
  if (text(r.endedAt)) job.endedAt = r.endedAt;
  if (text(r.readyAt)) job.readyAt = r.readyAt;
  if (typeof r.exitCode === 'number' || r.exitCode === null) job.exitCode = r.exitCode;
  if (text(r.signal) || r.signal === null) job.signal = r.signal;
  if (text(r.url)) job.url = r.url;
  if (text(r.error)) job.error = r.error;
  if (text(r.receipt)) job.receipt = r.receipt;
  if (text(r.note)) job.note = r.note;
  if (r.cleanup === 'complete' || r.cleanup === 'unresolved') job.cleanup = r.cleanup;
  const owner = r.owner && typeof r.owner === 'object' ? r.owner as Record<string, unknown> : undefined;
  if (owner && typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0 && text(owner.startedAt)) job.owner = { pid: owner.pid, startedAt: owner.startedAt };
  if (text(r.operation) && OPERATION_ID.test(r.operation)) job.operation = r.operation;
  return job;
}

function parseStep(raw: unknown): JobStep[] {
  if (!raw || typeof raw !== 'object') return [];
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || typeof s.state !== 'string' || !STEP_STATES.has(s.state)) return [];
  const step: JobStep = { name: s.name, state: s.state as JobStep['state'] };
  if (typeof s.index === 'number') step.index = s.index;
  if (typeof s.code === 'number') step.code = s.code;
  return [step];
}
