/**
 * Round R4 (helper H52): an OpenHands run in the REPL (src/code-agents/openhands.ts plans it, openhands-run.ts does its
 * docker, copy and write-back). The Workspace calls these from /agent's own start, stop and seal (src/repl/workspace.ts,
 * hooks marked "R4 (H52)"):
 *
 *   preflight   before anything is written: the worker is in this Timmy, docker's daemon answers, the image is there
 *               (built from Timmy's Dockerfile), and this machine's Ollama lists the model; otherwise "needs setup"
 *               with the exact step, and nothing is started
 *   prepare     after the snapshot the run is judged by: its copy of the project and its worker, in its run folder
 *   started     its container is this REPL's: /stop, Timmy's time limit and the REPL's end stop it by its name and
 *               labels (docker stop, then docker kill), and a job that ends otherwise has its container checked
 *   finish      as its job ends, before its result is sealed: the write-back, its record and its outcome
 *
 * Every stop of a container is kept in the run's folder (container.json), with what it found and ran.
 *
 * R4 (H62; ledger row 159): every stop of a run stops its container FIRST, then waits, bounded, for its docker client (the
 * job) to end by itself as the container ends, so the worker's own last line is relayed and kept; only a client still
 * there after that is signalled. The job's spec carries that first part (JobSpec.stopFirst, from stopFirst() here), so
 * /stop, /stop all, `timmy act`'s stop, the REPL's end and both time limits take the same order: OpenHands' own limit
 * (the plan's timeoutMs: its container first, then its job through JobManager.timeOut) and the job's own, above it, as the
 * backstop. A stop asked with words ("with /stop", "by timmy act (SIGINT received)", "as the REPL ended") keeps them.
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_DIR, DEFAULT_BASE_URL, type AgentOutcome, type AgentPlan, type AgentProgress, type ChangeSet, type Snapshot } from '../code-agents/index.js';
import {
  dockerClientEnv, OPENHANDS_BUILD, OPENHANDS_DOCKERFILE, OPENHANDS_IMAGE, OPENHANDS_LIMITS, OPENHANDS_SDK, OPENHANDS_WORKER, openHandsSaid, toolCallWords, workerLastWords, writeBackShort,
  zeroStepsWhy, type ContainerStop, type OpenHandsContainer, type OpenHandsRecord,
} from '../code-agents/openhands.js';
import { discardRunDir, dockerSetup, makeCopy, ollamaListed, openHandsWorker, stopContainer, writeBack } from '../code-agents/openhands-run.js';
import type { JobRecord, JobSpec, StopEnding, StopOrder } from '../jobs/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { packageRoot } from '../utils/asset-dirs.js';
import { cancelledWhy, stopReason } from '../utils/stop-words.js';

type Line = Segment[];
type Env = Record<string, string | undefined>;

/**
 * R4 (H62): how long a run's container stop is waited for before its docker client is signalled anyway. docker's own
 * answers are bounded (openhands-run.ts: docker ps 15 s each, docker stop its 10 s grace and 20 s more, docker kill 20 s):
 * 95 s at most in all.
 */
export const STOP_ANSWER_MS = 100_000;
/** R4 (H62): how long its docker client is then given to end by itself (it ends as its container ends, the worker's last
 *  line relayed); only a client still there after that is signalled (SIGTERM, then SIGKILL after the jobs' grace). */
export const CLIENT_EXIT_MS = 15_000;

/** One run's state while it goes, kept on /agent's own run state (AgentRunState.openhands). */
export interface OpenHandsRunState {
  container: OpenHandsContainer;
  run: string;
  root: string;
  job?: string;
  bin: string;
  env: Env;
  /** the copy as made: the baseline its changes are read against */
  copied: Snapshot;
  /** its part of the run's record (run.json, then result.json) */
  record: OpenHandsRecord;
  stopping?: Promise<ContainerStop>;
  /** the stop asked first (it is the one: a later ask gets its answer): why, when, and (R4, H62) who, in its words */
  asked?: { why: ContainerStop['why']; at: string; by?: string };
  stops: ContainerStop[];
  timer?: NodeJS.Timeout;
  /** R4 (H62): its time limits: OpenHands' own (the plan's timeoutMs) and its job's own, the backstop above it */
  limits?: { openhands: number; job: number };
  /** R4 (H62): which time limit came first: OpenHands' own (its container stopped first) or the job's own (the backstop) */
  limit?: { by: 'openhands' | 'job'; at: string };
}

export interface OpenHandsDeps {
  glyphs: GlyphSet;
  notify: (line: Line) => void;
  /** test seam: the fetch the Ollama check uses (a FAKE Ollama in tests) */
  fetch?: typeof fetch;
  /** R4 (H62): ends a run's job at OpenHands' own time limit (JobManager.timeOut): the job's stop, its container first */
  timeOut?: (jobId: string) => Promise<unknown>;
}

export type Preflight = { ok: true; version: string; imageId: string; worker: string } | { ok: false; error: string };

const shortId = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12);

export class OpenHandsRuns {
  /** this REPL's runs whose container may still run, by their job's id */
  private readonly live = new Map<string, OpenHandsRunState>();

  constructor(private readonly d: OpenHandsDeps) {}

  /** Whether a run could start now, checked before anything is written (see the module comment). */
  async preflight(plan: AgentPlan, env: Env, bin: string): Promise<Preflight> {
    const worker = openHandsWorker();
    if (!worker) return { ok: false, error: `Needs setup: ${OPENHANDS_WORKER} is not in this Timmy, so OpenHands cannot run here (reinstall Timmy). Nothing was started.` };
    const where = packageRoot(import.meta.url) ?? 'Timmy\'s package root';
    const d = await dockerSetup(bin, env);
    if (d.state === 'no daemon') return { ok: false, error: `Needs setup: the Docker daemon did not answer${d.detail ? ` (${d.detail})` : ''}: start your Docker engine (OrbStack, Docker Desktop or Rancher Desktop), then /agent openhands --local again. Nothing was started.` };
    if (d.state === 'no image') return { ok: false, error: `Needs setup: the image ${OPENHANDS_IMAGE} is not built. Build it once, in ${where}: ${OPENHANDS_BUILD} (Timmy never builds or pulls it by itself). Nothing was started.` };
    if (d.state === 'other image') return { ok: false, error: `Needs setup: the image ${OPENHANDS_IMAGE} here was not built from ${OPENHANDS_DOCKERFILE} (${d.detail ?? 'its label differs'}). Build it again, in ${where}: ${OPENHANDS_BUILD}. Nothing was started.` };
    if (d.state !== 'ready') return { ok: false, error: `docker did not answer as expected${'detail' in d && d.detail ? ` (${d.detail})` : ''}: docker info shows what is wrong. Nothing was started.` };
    const model = plan.model ?? '';
    const listed = await ollamaListed(env.TIMMY_AGENT_BASE_URL?.trim() || DEFAULT_BASE_URL, model, this.d.fetch ? { fetch: this.d.fetch } : {});
    if (!listed.ok) return { ok: false, error: listed.error };
    return { ok: true, version: `${OPENHANDS_IMAGE} (image ${shortId(d.imageId)}, labelled openhands-sdk ${OPENHANDS_SDK}; docker ${d.server})`, imageId: d.imageId, worker };
  }

  /** The run's copy of the project and its worker, from the snapshot it is judged by; its record's start. */
  prepare(plan: AgentPlan, root: string, run: string, before: { files: Snapshot; truncated: boolean }, pre: { imageId: string; worker: string }, bin: string, env: Env): { ok: true; state: OpenHandsRunState } | { ok: false; error: string } {
    const c = plan.container!;
    const made = makeCopy({ root, container: c, before: before.files, truncated: before.truncated, workerSource: pre.worker });
    if (!made.ok) { discardRunDir(root, run); return made; }
    const record: OpenHandsRecord = {
      image: c.image, image_id: pre.imageId,
      container: { name: c.name, labels: { ...c.labels } },
      worker: { path: `${AGENTS_DIR}/${run}/worker/timmy_openhands.py`, sha256: made.worker.sha256 },
      limits: { cpus: OPENHANDS_LIMITS.cpus, memory: OPENHANDS_LIMITS.memory, pids: OPENHANDS_LIMITS.pids, max_iterations: c.maxIterations },
      copy: { path: `${AGENTS_DIR}/${run}/work`, files: made.files, bytes: made.bytes, kept: true },
    };
    return { ok: true, state: { container: c, run, root, bin, env, copied: made.copied, record, stops: [], limits: { openhands: plan.timeoutMs, job: plan.jobTimeoutMs ?? plan.timeoutMs } } };
  }

  /** Its job has started: its container is this REPL's to stop, and Timmy's time limit stops it too. */
  started(job: JobRecord, st: OpenHandsRunState, timeoutMs: number): void {
    st.job = job.id;
    this.live.set(job.id, st);
    this.keep(st);
    // R4 (H62): OpenHands' own time limit: its container first, then its job (JobManager.timeOut). The job's own limit,
    // set above this one (the plan's jobTimeoutMs), stays as the backstop.
    const t = setTimeout(() => void this.atLimit(job.id), timeoutMs);
    t.unref?.();
    st.timer = t;
  }

  /**
   * R4 (H62): its job's stop's first part (JobSpec.stopFirst): its container is stopped (or the stop already asked, with its
   * words, is awaited) before its docker client is signalled; the client is then given CLIENT_EXIT_MS to end by itself.
   */
  stopFirst(st: OpenHandsRunState): NonNullable<JobSpec['stopFirst']> {
    return {
      answerMs: STOP_ANSWER_MS, exitMs: CLIENT_EXIT_MS,
      run: (ending: StopEnding) => {
        const timedOut = ending.error === 'timed out';
        // The job's own limit, with no stop asked before it: the backstop came first (OpenHands' own stop had not).
        if (timedOut && !st.stopping && !st.limit) st.limit = { by: 'job', at: new Date().toISOString() };
        return this.stopFor(st, timedOut ? 'time limit' : 'stop');
      },
    };
  }

  /** Stops a run's container by its name and labels (once: a second ask gets the first one's answer); undefined when not this REPL's. */
  stopping(jobId: string, why: ContainerStop['why'], by?: string): Promise<ContainerStop> | undefined {
    const st = this.live.get(jobId);
    return st ? this.stopFor(st, why, by) : undefined;
  }

  /** Every live run's container (/stop all, the REPL's end), each asked at once (before any job's stop), with these words. */
  async stopAll(why: ContainerStop['why'], by?: string): Promise<ContainerStop[]> {
    const asked = [...this.live.keys()].map((id) => this.stopping(id, why, by)).filter((p): p is Promise<ContainerStop> => !!p);
    return Promise.all(asked);
  }

  /** The stop of a run's container, asked once: its why and (R4, H62) its words are the first ask's, kept in its record. */
  private stopFor(st: OpenHandsRunState, why: ContainerStop['why'], by?: string): Promise<ContainerStop> {
    if (!st.stopping) {
      const words = by ? stopReason(by) : '';
      st.asked = { why, at: new Date().toISOString(), ...(words ? { by: words } : {}) };
      st.stopping = stopContainer(st.bin, st.env, { name: st.container.name, labels: st.container.labels }, why).then((r) => {
        const kept: ContainerStop = words ? { ...r, by: words } : r;
        st.stops.push(kept);
        st.record.stop = kept;
        this.keep(st);
        return kept;
      });
    }
    return st.stopping;
  }

  /** The process exits at once (a second Ctrl+C): each live container is asked to stop, without waiting (this REPL started it). */
  killNow(): void {
    for (const st of this.live.values()) {
      if (st.stopping) continue;
      try {
        const child = spawn(st.bin, ['stop', '--time', '5', st.container.name], { detached: true, stdio: 'ignore', env: { ...process.env, ...dockerClientEnv(st.env) } });
        child.on('error', () => { /* recovery finds it by its labels and record */ });
        child.unref();
      } catch { /* recovery finds it by its labels and record */ }
    }
  }

  /**
   * Its job has ended (sealAgent, before the result is sealed): the write-back, its record, its outcome. A run that did
   * not complete writes nothing into the project. `only` keeps, of the project's own before/after comparison, the files
   * Timmy wrote from the copy (anything else that changed meanwhile was not the agent's).
   */
  finish(job: JobRecord, st: OpenHandsRunState, judged: { outcome: AgentOutcome; why: string }, progress: AgentProgress, before: Snapshot): {
    judged: { outcome: AgentOutcome; why: string }; record: OpenHandsRecord; receipt: NonNullable<import('../utils/receipts.js').Receipt['openhands']>; only: (c: ChangeSet) => ChangeSet;
  } {
    const timedOut = job.error === 'timed out';
    if (st.timer) { clearTimeout(st.timer); st.timer = undefined; }
    const completed = judged.outcome === 'completed';
    const reason = judged.outcome === 'cancelled' ? 'it was stopped' : judged.outcome === 'timed out' ? 'Timmy\'s time limit ended it' : judged.outcome === 'unknown' ? 'it never said it finished' : 'it did not finish';
    const wb = writeBack({ root: st.root, run: st.run, container: st.container, before, copied: st.copied, completed, ...(completed ? {} : { reason }) });
    const said = openHandsSaid(progress);
    st.record.reported = {
      sdk: said.sdk ?? null, ...(said.status ? { status: said.status } : {}), ...(said.steps !== undefined ? { steps: said.steps } : {}), ...(said.tools ? { tools: said.tools } : {}),
      // R4 (H69): the route and the model's tool calls as its started line said them, and a text answer read as a tool call
      ...(said.route ? { route: said.route } : {}), ...(said.toolCalls ? { tool_calls: said.toolCalls } : {}), ...(said.sdkTools ? { sdk_tools: said.sdkTools } : {}),
      ...(said.registered ? { registered: said.registered } : {}), ...(said.litellm !== undefined ? { litellm: said.litellm } : {}), ...(said.textCall ? { text_call: said.textCall } : {}),
    };
    st.record.copy_changes = wb.copyChanges;
    st.record.writeback = wb.writeback;
    st.record.copy.kept = true;
    // The copy goes once everything in it was written back; otherwise it is the agent's work, kept for the operator.
    if (!wb.copyKept) { try { rmSync(st.container.work, { recursive: true, force: true }); st.record.copy.kept = false; } catch { /* kept */ } }
    if (!st.record.stop && st.asked) st.record.stop = { why: st.asked.why, at: st.asked.at, name: st.container.name, result: 'asked', steps: [], ...(st.asked.by ? { by: st.asked.by } : {}) };
    // R4 (H62): how its docker client ended after its container's stop, and which time limit came first.
    if (job.stopOrder) st.record.client = { container_stop: job.stopOrder.first, ended: job.stopOrder.group === 'ended by itself' ? 'by itself' : job.stopOrder.group };
    if (timedOut && st.limit) st.record.limit = { by: st.limit.by, at: st.limit.at, ms: st.limit.by === 'job' ? st.limits?.job ?? 0 : st.limits?.openhands ?? 0 };
    const w = wb.writeback;
    let out = judged;
    // R4 (H62): a run Timmy stopped says who stopped it, how its container and then its docker client ended (each docker
    // command with its exit), and the worker's own last line.
    if (judged.outcome === 'cancelled' || judged.outcome === 'timed out') out = { outcome: judged.outcome, why: `${judged.outcome === 'cancelled' ? cancelledWhy(st.asked?.by) : limitHead(st)}: ${stoppedHow(st.record.stop, job)}; ${workerLastWords(progress)}` };
    else if (completed && (w.state === 'refused' || w.state === 'partial')) out = { outcome: 'failed', why: `it finished in its container, but its changes were ${w.state === 'partial' ? 'only partly written' : 'not written'} into the project: ${w.why}` };
    // R4 (H69; ledger row 162, r20): finished after 0 steps with nothing changed in its copy: the SDK ends its run on any answer
    // without a tool call, so whether it did the task is not known; never completed (a run of one step or more keeps the next line)
    else if (completed && w.state === 'nothing to write' && said.steps === 0) out = { outcome: 'unknown', why: zeroStepsWhy(progress) };
    else if (completed && w.state === 'nothing to write') out = { outcome: 'completed', why: `${judged.why}; it changed nothing in its copy` };
    else if (completed) out = { outcome: 'completed', why: `${judged.why}; its changes were written into the project: ${w.why}${w.not_written.length ? `; ${w.not_written.length} change${w.not_written.length === 1 ? ' was' : 's were'} not (result.json names ${w.not_written.length === 1 ? 'it' : 'them'})` : ''}` };
    const written = new Set(w.written.map((x) => x.path));
    const only = (c: ChangeSet): ChangeSet => ({ added: c.added.filter((x) => written.has(x.path)), changed: c.changed.filter((x) => written.has(x.path)), deleted: c.deleted.filter((x) => written.has(x.path)) });
    const receipt = {
      image: st.record.image, ...(st.record.image_id ? { image_id: st.record.image_id } : {}), container: st.container.name, labels: { ...st.container.labels },
      worker_sha256: st.record.worker.sha256, sdk_reported: st.record.reported.sdk,
      copy: { files: st.record.copy.files, bytes: st.record.copy.bytes, kept: st.record.copy.kept === true },
      writeback: { state: w.state, written: w.written.length, not_written: w.not_written.length },
      // R4 (H62): who stopped it, each docker command with its exit, how its docker client then ended, which limit came first
      ...(st.record.stop ? {
        stop: {
          why: st.record.stop.why, result: st.record.stop.result, ...(st.record.stop.by ? { by: st.record.stop.by } : {}), steps: st.record.stop.steps.map((s) => ({ ...s })),
          ...(st.record.client ? { client: st.record.client.ended } : {}), ...(st.record.limit ? { limit: st.record.limit.by } : {}),
        },
      } : {}),
    };
    this.keep(st);
    // No container outlives its job: one that ended otherwise than by /stop, the time limit or its own end is checked.
    if (job.state !== 'completed' && !timedOut && !st.stopping) void this.stopping(job.id, 'its job ended')?.then((r) => this.notice(st, r, true));
    void (st.stopping ?? Promise.resolve()).finally(() => this.live.delete(job.id));
    return { judged: out, record: st.record, receipt, only };
  }

  /** The lines /stop adds for a run's container: what was found, and what was done. */
  stopLines(r: ContainerStop | undefined): Line[] {
    if (!r) return [];
    const bad = r.result === 'unresolved' || r.result === 'unchecked';
    return [[{ text: `  ${bad ? this.d.glyphs.fail : ' '} `, role: bad ? 'failure' : undefined }, { text: stopWords(r), role: bad ? 'failure' : 'secondary' }]];
  }

  /**
   * R4 (H62): OpenHands' own time limit has passed, before the job's own: its container is stopped first (with no stop
   * asked before), then its job is ended timed out (JobManager.timeOut), whose stop awaits that container stop and gives
   * its docker client its time to end by itself.
   */
  private async atLimit(jobId: string): Promise<void> {
    const st = this.live.get(jobId);
    if (!st || st.stopping) return;
    st.limit = { by: 'openhands', at: new Date().toISOString() };
    const r = this.stopFor(st, 'time limit');
    void Promise.resolve(this.d.timeOut?.(jobId)).catch(() => undefined);
    this.notice(st, await r, true);
  }

  /** A stop that did something, or could not, said once as a notice (a container already gone says nothing). */
  private notice(st: OpenHandsRunState, r: ContainerStop, quiet: boolean): void {
    if (quiet && r.result === 'gone') return;
    const bad = r.result === 'unresolved' || r.result === 'unchecked';
    this.d.notify([{ text: `  ${bad ? this.d.glyphs.fail : this.d.glyphs.bullet} `, role: bad ? 'failure' : undefined }, { text: `agent openhands ${st.run}`, role: 'strong' }, { text: `  ${stopWords(r)}`, role: bad ? 'failure' : 'secondary' }]);
  }

  /** The run's container.json: its container, and every stop of it (not sealed: it is rewritten as stops end). */
  private keep(st: OpenHandsRunState): void {
    try {
      writeFileSync(join(st.container.dir, 'container.json'), `${JSON.stringify({ name: st.container.name, labels: st.container.labels, image: st.record.image, image_id: st.record.image_id, job: st.job, stops: st.stops }, null, 2)}\n`);
    } catch { /* the run's record still names its container */ }
  }
}

/** R4 (H62): a time limit as it is said: "15m 30s", "1s". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
}

/** R4 (H62): which time limit ended a run, in words: OpenHands' own (its container stopped first), or the job's own (the backstop). */
export function limitHead(st: Pick<OpenHandsRunState, 'limit' | 'limits'>): string {
  const own = st.limits ? ` (${duration(st.limits.openhands)}: its wall time and a grace period)` : '';
  if (st.limit?.by === 'job') return `the job's own time limit, the backstop${st.limits ? ` (${duration(st.limits.job)})` : ''}, ended it: OpenHands' own stop at its time limit${st.limits ? ` (${duration(st.limits.openhands)})` : ''} had not come`;
  return `Timmy's time limit passed${own}`;
}

/** R4 (H62): a container stop's docker commands, each with its exit: "docker stop --time 10 timmy-oh-… exited 0, then …". */
export function stopSteps(r: ContainerStop): string {
  return r.steps.map((s) => `${s.command} ${s.exit === null ? 'gave no answer' : `exited ${s.exit}`}`).join(', then ');
}

/**
 * R4 (H62): how Timmy stopped a run: first its container (what ended it, each docker command with its exit), then its
 * docker client, the job (it ended by itself as its container ended, or Timmy signalled it: JobRecord.stopOrder).
 */
export function stoppedHow(stop: ContainerStop | undefined, job: { exitCode?: number | null; signal?: string | null; stopOrder?: StopOrder }): string {
  const exit = job.signal ? `signal ${job.signal}` : typeof job.exitCode === 'number' ? `exit ${job.exitCode}` : 'its exit not recorded';
  // No container stop was asked before its job's end: its docker client ended first (finish() then checks its container).
  if (!stop) return `its docker client had already ended (${exit}) before Timmy stopped its container; its container is checked by its name and labels after its job's end`;
  const n = stop.name;
  const what = stop.result === 'stopped' ? `docker stop ended its container ${n}`
    : stop.result === 'killed' ? `docker stop did not end its container ${n}, and docker kill did`
    : stop.result === 'ended' ? `its container ${n} ended while Timmy stopped it, not by docker kill`
    : stop.result === 'gone' ? `its container ${n} had already ended`
    : stop.result === 'unresolved' ? `its container ${n} still ran after docker stop and docker kill`
    : stop.result === 'unchecked' ? `its container ${n} could not be checked${stop.detail ? ` (${stop.detail})` : ''}`
    : `the stop of its container ${n} was asked`;
  const o = job.stopOrder;
  // Each docker command with its exit, and when Timmy went on without that stop's answer (its bound).
  const said = [stop.steps.length ? stopSteps(stop) : '', o?.first === 'no answer' ? `no answer within ${duration(STOP_ANSWER_MS)}` : ''].filter(Boolean).join('; ');
  const client = !o ? `its docker client had ended (${exit})`
    : o.group === 'ended by itself' ? `its docker client ended by itself (${exit})`
    : `its docker client did not end by itself within ${duration(CLIENT_EXIT_MS)}, so Timmy ended it (${o.group === 'SIGKILL' ? 'SIGTERM, then SIGKILL' : 'SIGTERM'}; ${exit})`;
  return `first ${what}${said ? ` (${said})` : ''}, then ${client}`;
}

/** A container stop in words. */
export function stopWords(r: ContainerStop): string {
  const when = r.why === 'time limit' ? ' at Timmy\'s time limit' : r.why === 'its job ended' ? ' after its job ended' : r.why === 'the REPL ended' ? ' as the REPL ended' : r.why === 'recovery' ? ' by recovery' : '';
  switch (r.result) {
    case 'stopped': return `its container ${r.name} was stopped by its name and labels${when} (docker stop)`;
    case 'killed': return `its container ${r.name} did not stop with docker stop${when}: docker kill ended it`;
    case 'ended': return `its container ${r.name} ended while Timmy stopped it${when}, not by docker kill${r.detail ? ` (${r.detail})` : ''}`;
    case 'gone': return `its container ${r.name} had already ended`;
    case 'unresolved': return `its container ${r.name} still runs after docker stop and docker kill${when}${r.detail ? ` (${r.detail})` : ''}: docker kill ${r.name}, or your Docker engine's own list of containers`;
    case 'unchecked': return `its container ${r.name} could not be checked${when}${r.detail ? ` (${r.detail})` : ''}: docker stop ${r.name} stops it`;
    default: return `its container ${r.name}: a stop was asked${when}`;
  }
}

/** /agent last's line for an OpenHands run: its container and image, its copy, and what reached the project. */
export function openHandsLastLine(r: { openhands?: OpenHandsRecord }, sep: string): string | undefined {
  const o = r.openhands;
  if (!o) return undefined;
  const copy = `a copy of ${o.copy.files} file${o.copy.files === 1 ? '' : 's'} ${o.copy.kept === false ? '(removed once written back)' : `(kept in ${o.copy.path}/)`}`;
  const sdk = o.reported ? `${sep}it reported openhands-sdk ${o.reported.sdk ?? '(no version)'}` : '';
  // R4 (H69): LiteLLM's route and how the model's tool calls went, as its started line said them (an older worker says neither)
  const route = o.reported?.route ? `${sep}route ${o.reported.route}, ${toolCallWords({ ...(o.reported.tool_calls ? { toolCalls: o.reported.tool_calls } : {}), ...(o.reported.sdk_tools ? { sdkTools: o.reported.sdk_tools } : {}) })}` : '';
  return `${o.container.name}${sep}${o.image}${sdk}${route}${sep}${copy}${o.writeback ? `${sep}${writeBackShort(o.writeback)}` : ''}`;
}
