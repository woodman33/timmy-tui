/**
 * Round R4 (helper H52): recovery of OpenHands containers a session left running when it ended without its own stop path
 * (src/repl/recover.ts asks this as the last part of its pass, at a REPL's start and on /recover).
 *
 * A container is a candidate only when docker lists it by Timmy's labels (timmy.project = this project's id, and a
 * timmy.run) AND that run's own record in .timmy/agents/<run>/ says it is an OpenHands run whose container has exactly
 * that name and those labels: never a container found by its name alone, and never by its labels alone. It is stopped
 * (docker stop, then docker kill, openhands-run.ts stopContainer) only when no live session follows it, in the spirit of
 * the proof rule recover.ts applies to process groups:
 *   - its run has a result (the session that ran it recorded its end), or
 *   - its job's record is stale (no final state, and its process is gone; read again after a short wait), or ended, or
 *   - its job still runs and the process table proves the REPL that started it has ended (recover.ts leftBehind).
 * A job that is not in this Timmy's jobs folder, or a REPL that still runs, leaves it as it is; the lines say how to
 * stop it. Each stop is kept in the run's container.json and sealed as a recover receipt; the job's own record, when it
 * was left running or stale, has its end recorded through the job module's writer, and then (R4, H59) the run's own
 * record is ended as interrupted, with no result (src/code-agents/run-end.ts). Nothing is started, removed or rerun.
 *
 * R4 (H62; H59's note, ledger row 160): a run with no result whose container no longer runs (docker lists none of its
 * containers, or only an ended one) is ended too, when its job's record was left by a REPL that ended: a stale job (its
 * docker client gone as well; read again after a short wait) has its record ended cancelled, "its REPL ended; its
 * container was already gone", and the run's record interrupted; a job an earlier recovery ended without ending the run's
 * record has the run's record ended with its words. One recover receipt each, naming the record's bytes; nothing is
 * claimed about its result, and nothing is stopped (there is nothing left to stop).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, type AgentRunRecord } from '../code-agents/index.js';
import { endLeftAgentRun, type LeftRunEnd } from '../code-agents/run-end.js'; // R4 (H59): the run's own record, ended with its job
import { LABEL_PROJECT, LABEL_RUN } from '../code-agents/openhands.js';
import { listByLabels, stopContainer } from '../code-agents/openhands-run.js';
import type { JobRecord } from '../jobs/index.js';
import { OPERATION_ID } from '../ops/context.js';
import { projectId } from '../project/index.js';
import { leftBehind, processTable, SETTLE_MS, type Proc, type RecoverDeps, type RecoveryItem } from './recover.js';
import { stopWords } from './openhands.js';

type Env = Record<string, string | undefined>;

export interface OpenHandsRecoverDeps {
  root: string;
  project: string;
  jobs: RecoverDeps['jobs'];
  seal: RecoverDeps['seal'];
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string) => string;
  /** whether this REPL started the job */
  mine: (jobId: string) => boolean;
  open: () => boolean;
  /** docker, as /agent would run it (null: not on PATH) */
  bin: string | null;
  env: Env;
  settleMs?: number;
  /** test seam: the process table (recover.ts processTable) */
  table?: () => Proc[] | undefined;
}

interface Run { run: string; record: AgentRunRecord; ended: boolean; dir: string }
const RUN_ID = /^a[0-9a-f]{8}$/;
const LIVE: ReadonlySet<string> = new Set(['running', 'restarting', 'paused']);
/** R4 (H62): the words a stale OpenHands job's record ends with when its container was already gone. */
export const CONTAINER_GONE_WORDS = 'its REPL ended; its container was already gone';
/** R4 (H62): the states docker lists a container in once it has ended (it runs no more). */
const ENDED: ReadonlySet<string> = new Set(['exited', 'dead', 'removing']);
/** The words every end recovery writes in a job's record begin with (as recover-agents.ts reads them). */
const ENDED_BY_RECOVERY = /^its REPL ended\b/;
const JOB_LIVE: ReadonlySet<string> = new Set(['running', 'ready', 'queued']);
/** R4 (H62): a run with no result whose container runs no more, and how its job's record was left. */
interface Gone { r: Run; job: JobRecord; act: 'gone' | 'ended before' }
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const read = (file: string): AgentRunRecord | undefined => {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AgentRunRecord;
  } catch { return undefined; }
};

/** This project's OpenHands runs, by their records (result.json when it ended, else run.json); nothing is contacted. */
function openHandsRuns(root: string): Map<string, Run> {
  const out = new Map<string, Run>();
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, AGENTS_DIR)); } catch { return out; }
  for (const run of names) {
    if (!RUN_ID.test(run)) continue;
    const dir = path.join(root, AGENTS_DIR, run);
    const result = read(path.join(dir, 'result.json'));
    const started = read(path.join(dir, 'run.json'));
    const record = result?.run === run && result.outcome ? result : started?.run === run ? started : undefined;
    if (record?.agent !== 'openhands' || !record.openhands?.container?.name) continue;
    out.set(run, { run, record, ended: !!(result?.run === run && result.outcome), dir });
  }
  return out;
}

/** Appends a stop to the run's container.json (its stops, as the REPL that ran it keeps them). */
function keepStop(dir: string, stop: unknown): void {
  const file = path.join(dir, 'container.json');
  let kept: Record<string, unknown> = {};
  try { const st = fs.lstatSync(file); if (st.isFile()) kept = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { kept = {}; }
  const stops = Array.isArray(kept.stops) ? kept.stops : [];
  try { fs.writeFileSync(file, `${JSON.stringify({ ...kept, stops: [...stops, stop] }, null, 2)}\n`); } catch { /* the receipt keeps it */ }
}

type Decision = { act: 'stop'; why: string; job?: JobRecord; viaStale: boolean } | { act: 'leave'; why: string; attention: boolean };

/** Whether a session still follows the run's container: see the module comment. */
function decide(d: OpenHandsRecoverDeps, r: Run, table: () => Proc[] | undefined): Decision {
  if (r.ended) return { act: 'stop', why: `its run ended (${r.record.outcome}) and no REPL follows its container`, viaStale: false };
  const id = typeof r.record.job === 'string' ? r.record.job : '';
  const job = id ? d.jobs.get(id) : undefined;
  if (!job) return { act: 'leave', attention: true, why: `its job ${id || '(not recorded)'} is not in this Timmy's jobs folder, so whether a session follows it cannot be told` };
  if (job.stale) return { act: 'stop', why: `its job ${job.id} was left ${job.state} and its process is gone`, job, viaStale: true };
  if (job.state !== 'running' && job.state !== 'ready' && job.state !== 'queued') return { act: 'stop', why: `its job ${job.id} ${job.state}, and no REPL follows its container`, job, viaStale: false };
  const left = leftBehind(job, table());
  if (left.kind === 'theirs') return { act: 'leave', attention: false, why: `its job ${job.id} still runs (another session${left.why ? `, as far as Timmy can tell: ${left.why}` : ''})` };
  return { act: 'stop', why: `its job ${job.id} was left running by a REPL that has ended`, job, viaStale: false };
}

/**
 * R4 (H62): ends the records of a run whose REPL ended and whose container is already gone (see the module comment): its
 * job's record (stale: cancelled with CONTAINER_GONE_WORDS), then the run's own record, interrupted, and one recover
 * receipt naming that record's bytes. Nothing is claimed about its result; nothing is written into the project.
 */
function endGone(d: OpenHandsRecoverDeps, g: Gone): RecoveryItem {
  const c = g.r.record.openhands!.container;
  const who = `OpenHands run ${g.r.run} (job ${g.job.id})`;
  let job: { id: string; state: string; error?: string; endedAt?: string };
  let end: LeftRunEnd;
  let how: string;
  if (g.act === 'gone') {
    let recorded: JobRecord | undefined;
    try { recorded = d.jobs.endLeft?.(g.job.id, { state: 'cancelled', error: CONTAINER_GONE_WORDS }); } catch { recorded = undefined; }
    if (!recorded) return { kind: 'agent-run', id: g.r.run, did: 'left', job: g.job.id, text: `${who}: its job's record could not be ended (it changed meanwhile): /recover again` };
    job = { id: recorded.id, state: recorded.state, ...(recorded.error ? { error: recorded.error } : {}) };
    end = { how: 'container gone', container: c.name };
    how = `its REPL ended, and its job's process and its container ${c.name} were already gone; its job record now says ${recorded.state}: ${recorded.error ?? CONTAINER_GONE_WORDS}`;
  } else {
    job = { id: g.job.id, state: g.job.state, ...(g.job.error ? { error: g.job.error } : {}), ...(g.job.endedAt ? { endedAt: g.job.endedAt } : {}) };
    end = { how: 'ended before' };
    how = `an earlier recovery ended its job (its record says ${g.job.state}: ${g.job.error ?? ''}) but not its own record, and its container ${c.name} runs no more`;
  }
  const w = endLeftAgentRun(d.root, g.r.run, { job, end });
  if (!w.ok) return { kind: 'agent-run', id: g.r.run, did: 'failed', attention: true, job: g.job.id, text: `${who}: ${d.scrub(how)}; its record ${w.path} was left as it is: ${w.why}` };
  const operation = typeof g.r.record.operation === 'string' && OPERATION_ID.test(g.r.record.operation) ? { operation_id: g.r.record.operation } : {};
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'recover', subject: `recover · agent · openhands · ${g.r.run} · interrupted`, policy: 'human-gated', status: 'ok',
      ...operation, // the request the run belonged to, not the one that recovered it
      project: d.project, project_id: projectId(d.root),
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{
        operation: g.r.run, agent: 'openhands', job: g.job.id, container: c.name, labels: { ...c.labels },
        action: g.act === 'gone' ? 'found its job\'s process and its container gone' : 'ended its record as its job record says',
        why: d.scrub(w.record.why ?? ''),
      }],
    });
  } catch { receipt = undefined; }
  return {
    kind: 'agent-run', id: g.r.run, did: 'interrupted', job: g.job.id, record: w.path, ...(receipt ? { receipt } : {}),
    text: `${who}: ${d.scrub(how)}; its record ${w.path} now says interrupted (no result was written); nothing was written into the project${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}`,
  };
}

/** Finds and stops OpenHands containers an ended session left running in this project; see the module comment. */
export async function recoverOpenHands(d: OpenHandsRecoverDeps): Promise<RecoveryItem[]> {
  const runs = openHandsRuns(d.root);
  if (!runs.size) return [];
  const unfinished = [...runs.values()].filter((r) => !r.ended && !(typeof r.record.job === 'string' && d.mine(r.record.job)));
  if (!d.bin) {
    return unfinished.map((r) => ({ kind: 'agent' as const, id: r.run, did: 'left' as const, attention: true, text: `OpenHands run ${r.run} has no result, and docker is not on PATH, so whether its container ${r.record.openhands!.container.name} still runs cannot be checked` }));
  }
  const pid = projectId(d.root);
  const listed = await listByLabels(d.bin, d.env, { [LABEL_PROJECT]: pid, [LABEL_RUN]: '' });
  if (!listed.ok) {
    return unfinished.map((r) => ({ kind: 'agent' as const, id: r.run, did: 'left' as const, attention: true, text: `OpenHands run ${r.run} has no result, and its container ${r.record.openhands!.container.name} could not be checked (${d.scrub(listed.error)}): docker stop ${r.record.openhands!.container.name} stops it if it runs` }));
  }
  let table: Proc[] | undefined | null = null;
  const tableOnce = (): Proc[] | undefined => (table === null ? (table = (d.table ?? processTable)()) : table);
  const items: RecoveryItem[] = [];
  const plans: Array<{ r: Run; name: string; labels: Record<string, string>; decision: Extract<Decision, { act: 'stop' }> }> = [];
  for (const c of listed.listed) {
    if (!LIVE.has(c.state) || c.project !== pid || !RUN_ID.test(c.run)) continue;
    const r = runs.get(c.run);
    const name = c.names[0] ?? c.id.slice(0, 12);
    if (!r) {
      items.push({ kind: 'agent', id: c.run, did: 'left', attention: true, text: `a container labelled for this project's run ${c.run} (${name}) runs, but no OpenHands run record ${c.run} is here: it was not stopped (never by its labels alone): docker stop ${name} stops it` });
      continue;
    }
    const want = r.record.openhands!.container;
    const labels = { [LABEL_RUN]: c.run, [LABEL_PROJECT]: pid };
    if (!c.names.includes(want.name) || want.labels[LABEL_RUN] !== c.run || want.labels[LABEL_PROJECT] !== pid) {
      items.push({ kind: 'agent', id: c.run, did: 'left', attention: true, text: `a container labelled for OpenHands run ${c.run} (${name}) is not the one its record names (${want.name}): it was not stopped: docker stop ${name} stops it` });
      continue;
    }
    if (typeof r.record.job === 'string' && d.mine(r.record.job)) continue;
    const decision = decide(d, r, tableOnce);
    if (decision.act === 'leave') {
      items.push({ kind: 'agent', id: r.run, did: 'left', ...(decision.attention ? { attention: true } : {}), ...(r.record.job ? { job: r.record.job } : {}), text: `OpenHands run ${r.run}: its container ${want.name} still runs; ${decision.why}: it was not stopped${decision.attention ? `; docker stop ${want.name} stops it` : ''}` });
      continue;
    }
    plans.push({ r, name: want.name, labels, decision });
  }
  // R4 (H62): the runs with no result whose container runs no more (docker lists none of this run's, or only an ended one).
  const running = new Set(listed.listed.filter((c) => c.project === pid && !ENDED.has(c.state)).map((c) => c.run));
  const gone: Gone[] = [];
  for (const r of runs.values()) {
    if (r.ended || running.has(r.run) || r.record.state !== 'submitted') continue;
    const id = typeof r.record.job === 'string' ? r.record.job : '';
    if (!id || d.mine(id)) continue;
    const job = d.jobs.get(id);
    if (!job) continue;
    if (job.stale) gone.push({ r, job, act: 'gone' });
    else if (!JOB_LIVE.has(job.state) && ENDED_BY_RECOVERY.test(job.error ?? '')) gone.push({ r, job, act: 'ended before' });
  }
  // A container that carries the run's name without its labels is not Timmy's, and Timmy never judges by a name alone: the
  // run is then left as it is. docker is asked for its whole list (no name filter); the names are only compared here.
  if (gone.length) {
    const all = await listByLabels(d.bin, d.env, {});
    for (const g of gone.splice(0)) {
      const name = g.r.record.openhands!.container.name;
      if (!all.ok) { items.push({ kind: 'agent-run', id: g.r.run, did: 'left', job: g.job.id, text: `OpenHands run ${g.r.run}: no container with its labels runs, but docker's whole list could not be read (${d.scrub(all.error)}), so whether ${name} is gone cannot be told: its records were left as they are` }); continue; }
      if (all.listed.some((c) => c.names.includes(name) && !(c.run === g.r.run && c.project === pid))) { items.push({ kind: 'agent-run', id: g.r.run, did: 'left', job: g.job.id, text: `OpenHands run ${g.r.run}: no container with its labels runs, but a container named ${name} without them is there (not Timmy's; never judged by its name alone): its records were left as they are` }); continue; }
      gone.push(g);
    }
  }
  // A stale job record is believed only when it is still stale after a moment (a live session records its end at once).
  const skip = new Set<string>();
  if (plans.some((p) => p.decision.viaStale) || gone.some((g) => g.act === 'gone')) {
    await sleep(d.settleMs ?? SETTLE_MS);
    for (const p of plans) {
      if (!p.decision.viaStale || !p.decision.job) continue;
      const now = d.jobs.get(p.decision.job.id);
      if (now && !now.stale && (now.state === 'running' || now.state === 'ready' || now.state === 'queued')) {
        items.push({ kind: 'agent', id: p.r.run, did: 'left', job: now.id, text: `OpenHands run ${p.r.run}: its job ${now.id} runs in a session after all: its container ${p.name} was left as it is` });
        skip.add(p.r.run);
      }
    }
    for (const g of gone) {
      if (g.act !== 'gone') continue;
      const now = d.jobs.get(g.job.id);
      if (now?.stale) continue;
      // Recorded by its own session meanwhile (or it runs after all): that session's records stand.
      skip.add(g.r.run);
      if (now && JOB_LIVE.has(now.state)) items.push({ kind: 'agent-run', id: g.r.run, did: 'left', job: now.id, text: `OpenHands run ${g.r.run}: its job ${now.id} runs in a session after all: its records were left as they are` });
    }
  }
  for (const g of gone) {
    if (skip.has(g.r.run)) continue;
    if (!d.open()) { items.push({ kind: 'agent-run', id: g.r.run, did: 'left', job: g.job.id, text: `OpenHands run ${g.r.run}: not picked up, because this REPL is ending` }); continue; }
    items.push(endGone(d, g));
  }
  for (const p of plans) {
    if (skip.has(p.r.run)) continue;
    if (!d.open()) { items.push({ kind: 'agent', id: p.r.run, did: 'left', text: `OpenHands run ${p.r.run}: its container ${p.name} was not stopped, because this REPL is ending` }); continue; }
    const stop = await stopContainer(d.bin, d.env, { name: p.name, labels: p.labels }, 'recovery');
    keepStop(p.r.dir, stop);
    if (stop.result === 'gone') { items.push({ kind: 'agent', id: p.r.run, did: 'left', text: `OpenHands run ${p.r.run}: ${stopWords(stop)} when recovery came to stop it` }); continue; }
    const job = p.decision.job;
    const stopped = stop.result === 'stopped' || stop.result === 'killed' || stop.result === 'ended'; // 'ended': gone after recovery's stop began (row 159)
    // The job's own record: its end, through the job module's writer, once its container (and so its docker client) stopped.
    let recorded: JobRecord | undefined;
    const steps = stop.steps.map((s) => s.command.split(' ').slice(0, 2).join(' ')).join(', then ');
    if (job && stopped) {
      try { recorded = d.jobs.endLeft?.(job.id, { state: 'cancelled', error: `its REPL ended; recovery stopped its container ${p.name} (${steps})` }); } catch { recorded = undefined; }
    }
    // R4 (H59): then the run's own record, ended as interrupted (no result is written: its copy's changes never come back).
    const runEnd = recorded ? endLeftAgentRun(d.root, p.r.run, { job: { id: recorded.id, state: recorded.state, ...(recorded.error ? { error: recorded.error } : {}) }, end: { how: 'container stopped', container: p.name, steps } }) : undefined;
    let receipt: string | undefined;
    try {
      receipt = d.seal({
        kind: 'recover', subject: `recover · agent · openhands · ${p.r.run} · container ${stop.result}`, policy: 'human-gated', status: stopped ? 'ok' : 'failed',
        project: d.project, project_id: projectId(d.root),
        ...(runEnd?.ok ? { outputs: [{ path: runEnd.path, sha256: runEnd.sha256, bytes: runEnd.bytes }] } : {}), // R4 (H59)
        sources: [{ operation: p.r.run, agent: 'openhands', action: `container ${stop.result}`, container: p.name, labels: p.labels, ...(job ? { job: job.id } : {}), why: d.scrub(p.decision.why), steps: stop.steps, ...(stop.detail ? { detail: d.scrub(stop.detail) } : {}) }],
      });
    } catch { receipt = undefined; }
    const did = stopped ? 'stopped' as const : 'failed' as const;
    const runWords = runEnd ? runEnd.ok ? `; its record ${runEnd.path} now says interrupted (no result was written)` : `; its record ${runEnd.path} was left as it is: ${runEnd.why}` : '';
    items.push({
      kind: 'agent', id: p.r.run, did, ...(job ? { job: job.id } : {}), ...(receipt ? { receipt } : {}), ...(did === 'failed' ? { attention: true } : {}),
      text: `OpenHands run ${p.r.run}: ${d.scrub(p.decision.why)}; ${stopWords(stop)}${recorded ? `; its job record now says ${recorded.state}` : ''}; nothing was written into the project${receipt ? `; receipt ${receipt}` : ''}${runWords}`,
    });
  }
  return items;
}
