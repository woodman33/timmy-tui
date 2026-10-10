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
 */
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_DIR, DEFAULT_BASE_URL, type AgentOutcome, type AgentPlan, type AgentProgress, type ChangeSet, type Snapshot } from '../code-agents/index.js';
import {
  dockerClientEnv, OPENHANDS_BUILD, OPENHANDS_DOCKERFILE, OPENHANDS_IMAGE, OPENHANDS_LIMITS, OPENHANDS_SDK, OPENHANDS_WORKER, openHandsSaid, writeBackShort,
  type ContainerStop, type OpenHandsContainer, type OpenHandsRecord,
} from '../code-agents/openhands.js';
import { discardRunDir, dockerSetup, makeCopy, ollamaListed, openHandsWorker, stopContainer, writeBack } from '../code-agents/openhands-run.js';
import type { JobRecord } from '../jobs/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import { packageRoot } from '../utils/asset-dirs.js';

type Line = Segment[];
type Env = Record<string, string | undefined>;

/** The container is stopped this long after Timmy's time limit has ended the job's process group (which sets its end first). */
export const LIMIT_AFTER_MS = 100;

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
  asked?: { why: ContainerStop['why']; at: string };
  stops: ContainerStop[];
  timer?: NodeJS.Timeout;
}

export interface OpenHandsDeps {
  glyphs: GlyphSet;
  notify: (line: Line) => void;
  /** test seam: the fetch the Ollama check uses (a FAKE Ollama in tests) */
  fetch?: typeof fetch;
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
    return { ok: true, state: { container: c, run, root, bin, env, copied: made.copied, record, stops: [] } };
  }

  /** Its job has started: its container is this REPL's to stop, and Timmy's time limit stops it too. */
  started(job: JobRecord, st: OpenHandsRunState, timeoutMs: number): void {
    st.job = job.id;
    this.live.set(job.id, st);
    this.keep(st);
    // The job's own time limit ends its process group first (and records it timed out); then its container, by name.
    const t = setTimeout(() => void this.atLimit(job.id), timeoutMs + LIMIT_AFTER_MS);
    t.unref?.();
    st.timer = t;
  }

  /** Stops a run's container by its name and labels (once: a second ask gets the first one's answer); undefined when not this REPL's. */
  stopping(jobId: string, why: ContainerStop['why']): Promise<ContainerStop> | undefined {
    const st = this.live.get(jobId);
    if (!st) return undefined;
    if (!st.stopping) {
      st.asked = { why, at: new Date().toISOString() };
      st.stopping = stopContainer(st.bin, st.env, { name: st.container.name, labels: st.container.labels }, why).then((r) => {
        st.stops.push(r);
        st.record.stop = r;
        this.keep(st);
        return r;
      });
    }
    return st.stopping;
  }

  /** Every live run's container (/stop all, the REPL's end). */
  async stopAll(why: ContainerStop['why']): Promise<ContainerStop[]> {
    const asked = [...this.live.keys()].map((id) => this.stopping(id, why)).filter((p): p is Promise<ContainerStop> => !!p);
    return Promise.all(asked);
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
    if (st.timer && !timedOut) { clearTimeout(st.timer); st.timer = undefined; }
    const completed = judged.outcome === 'completed';
    const reason = judged.outcome === 'cancelled' ? 'it was stopped' : judged.outcome === 'timed out' ? 'Timmy\'s time limit ended it' : judged.outcome === 'unknown' ? 'it never said it finished' : 'it did not finish';
    const wb = writeBack({ root: st.root, run: st.run, container: st.container, before, copied: st.copied, completed, ...(completed ? {} : { reason }) });
    const said = openHandsSaid(progress);
    st.record.reported = { sdk: said.sdk ?? null, ...(said.status ? { status: said.status } : {}), ...(said.steps !== undefined ? { steps: said.steps } : {}), ...(said.tools ? { tools: said.tools } : {}) };
    st.record.copy_changes = wb.copyChanges;
    st.record.writeback = wb.writeback;
    st.record.copy.kept = true;
    // The copy goes once everything in it was written back; otherwise it is the agent's work, kept for the operator.
    if (!wb.copyKept) { try { rmSync(st.container.work, { recursive: true, force: true }); st.record.copy.kept = false; } catch { /* kept */ } }
    if (!st.record.stop && st.asked) st.record.stop = { why: st.asked.why, at: st.asked.at, name: st.container.name, result: 'asked', steps: [] };
    const w = wb.writeback;
    let out = judged;
    if (completed && (w.state === 'refused' || w.state === 'partial')) out = { outcome: 'failed', why: `it finished in its container, but its changes were ${w.state === 'partial' ? 'only partly written' : 'not written'} into the project: ${w.why}` };
    else if (completed && w.state === 'nothing to write') out = { outcome: 'completed', why: `${judged.why}; it changed nothing in its copy` };
    else if (completed) out = { outcome: 'completed', why: `${judged.why}; its changes were written into the project: ${w.why}${w.not_written.length ? `; ${w.not_written.length} change${w.not_written.length === 1 ? ' was' : 's were'} not (result.json names ${w.not_written.length === 1 ? 'it' : 'them'})` : ''}` };
    const written = new Set(w.written.map((x) => x.path));
    const only = (c: ChangeSet): ChangeSet => ({ added: c.added.filter((x) => written.has(x.path)), changed: c.changed.filter((x) => written.has(x.path)), deleted: c.deleted.filter((x) => written.has(x.path)) });
    const receipt = {
      image: st.record.image, ...(st.record.image_id ? { image_id: st.record.image_id } : {}), container: st.container.name, labels: { ...st.container.labels },
      worker_sha256: st.record.worker.sha256, sdk_reported: st.record.reported.sdk,
      copy: { files: st.record.copy.files, bytes: st.record.copy.bytes, kept: st.record.copy.kept === true },
      writeback: { state: w.state, written: w.written.length, not_written: w.not_written.length },
      ...(st.record.stop ? { stop: { why: st.record.stop.why, result: st.record.stop.result } } : {}),
    };
    this.keep(st);
    // No container outlives its job: one that ended otherwise than by /stop, the time limit or its own end is checked.
    if (job.state !== 'completed' && !timedOut && !st.stopping) void this.stopping(job.id, 'its job ended')?.then((r) => this.notice(st, r, true));
    if (!timedOut) void (st.stopping ?? Promise.resolve()).finally(() => this.live.delete(job.id));
    return { judged: out, record: st.record, receipt, only };
  }

  /** The lines /stop adds for a run's container: what was found, and what was done. */
  stopLines(r: ContainerStop | undefined): Line[] {
    if (!r) return [];
    const bad = r.result === 'unresolved' || r.result === 'unchecked';
    return [[{ text: `  ${bad ? this.d.glyphs.fail : ' '} `, role: bad ? 'failure' : undefined }, { text: stopWords(r), role: bad ? 'failure' : 'secondary' }]];
  }

  /** Timmy's time limit has passed: the job's own limit ended its process group; its container is stopped by name too. */
  private async atLimit(jobId: string): Promise<void> {
    const st = this.live.get(jobId);
    if (!st) return;
    const r = await this.stopping(jobId, 'time limit');
    if (r) this.notice(st, r, true);
    this.live.delete(jobId);
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

/** A container stop in words. */
export function stopWords(r: ContainerStop): string {
  const when = r.why === 'time limit' ? ' at Timmy\'s time limit' : r.why === 'its job ended' ? ' after its job ended' : r.why === 'the REPL ended' ? ' as the REPL ended' : r.why === 'recovery' ? ' by recovery' : '';
  switch (r.result) {
    case 'stopped': return `its container ${r.name} was stopped by its name and labels${when} (docker stop)`;
    case 'killed': return `its container ${r.name} did not stop with docker stop${when}: docker kill ended it`;
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
  return `${o.container.name}${sep}${o.image}${sdk}${sep}${copy}${o.writeback ? `${sep}${writeBackShort(o.writeback)}` : ''}`;
}
