/**
 * Round R4 (helper H59; r18, ledger row 157, defect 4): code agent runs an ended session left (a plain /agent run, or the
 * agent step of a flow whose record is written), asked by the Workspace's recovery pass after flows and native runs, before
 * OpenHands' containers (src/repl/recover.ts calls RecoverDeps.agents; the Workspace gives this part and that one).
 *
 * A run is looked at only when its own record says it was submitted and no result was written (.timmy/agents/<run>/run.json
 * "submitted", no result.json beside it), it is not an OpenHands run (its container is src/repl/openhands-recover.ts's to
 * stop, by its labels), and it is not the agent step of a flow that has no record yet (recover.ts ends that job and this
 * record with the flow). Then by its job's own record in this Timmy's jobs folder:
 *   - the job runs in this REPL: nothing; in another session that still runs: left as it is (said on /recover);
 *   - the job was left running by a REPL that has ended, proven by the process table as recover.ts proves a flow step's job
 *     (leftBehind): its process group is stopped (stopLeft: SIGTERM, then SIGKILL after 2 s), its job's record ended
 *     (cancelled, saying so), and the run's record ended as interrupted; not proven: nothing is stopped, and the line says
 *     what runs and how to stop it;
 *   - the job's record is stale (its process gone; read again after a short wait): its job's record is ended (failed, "its
 *     REPL ended; its process is gone") and the run's record ended as interrupted;
 *   - an earlier recovery ended the job's record (its words begin "its REPL ended") but not the run's (as on the Mac at r18):
 *     the run's record is ended with those words;
 *   - a job that ended in its own REPL, or one not in this jobs folder, is left as it is (the latter said on /recover).
 * Each run's record is ended once through the code-agent module's writer (src/code-agents/run-end.ts), never with a result,
 * and the end is sealed as one recover receipt naming the record's bytes. Nothing is started, rerun or deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, AGENTS_DIR, RUN_RECORD, type AgentName, type AgentRunRecord } from '../code-agents/index.js';
import { endLeftAgentRun, runRecordRel, type LeftRunEnd, type LeftRunEnded } from '../code-agents/run-end.js';
import { FLOW_ID, FLOW_WORK_DIR, flowRecordPath } from '../flows/iterate.js';
import type { JobRecord } from '../jobs/index.js';
import { OPERATION_ID } from '../ops/context.js';
import { projectId } from '../project/index.js';
import { GONE_WORDS, leftBehind, processTable, SETTLE_MS, stopLeft, type LeftJob, type LeftStop, type Proc, type RecoverDeps, type RecoveryItem } from './recover.js';

export interface AgentRecoverDeps {
  root: string;
  project: string;
  jobs: RecoverDeps['jobs'];
  seal: RecoverDeps['seal'];
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string) => string;
  /** whether this REPL started the job */
  mine: (jobId: string) => boolean;
  /** false once this REPL is ending: nothing more is stopped or written */
  open: () => boolean;
  settleMs?: number;
  now?: () => number;
  /** test seam: the process table (recover.ts processTable) */
  table?: () => Proc[] | undefined;
}

const RUN_ID = /^a[0-9a-f]{8}$/;
const JOB_ID = /^j[0-9a-f]{6}$/;
const RECORD_MAX = 4 * 1024 * 1024;
/** The words every end recovery writes in a job's record begin with (recover.ts, openhands-recover.ts). */
const ENDED_BY_RECOVERY = /^its REPL ended\b/;
const LIVE: ReadonlySet<string> = new Set(['running', 'ready', 'queued']);

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const lexists = (abs: string): boolean => { try { fs.lstatSync(abs); return true; } catch { return false; } };
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const titleOf = (agent: unknown): string => AGENTS[agent as AgentName]?.title ?? String(agent ?? 'a code agent');

/** A run's record as its start wrote it: a regular file in the project, this run's, or undefined. */
function readRecord(root: string, run: string): AgentRunRecord | undefined {
  try {
    const file = path.join(root, AGENTS_DIR, run, RUN_RECORD);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentRunRecord;
    return rec && typeof rec === 'object' && rec.run === run ? rec : undefined;
  } catch { return undefined; }
}

/** The agent runs of the flows that have no record yet: recover.ts's to end with their flows (R4, H68: decisions.ts lists those flows). */
export function flowRuns(root: string): Set<string> {
  const out = new Set<string>();
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(root, FLOW_WORK_DIR)).filter((n) => FLOW_ID.test(n)); } catch { return out; }
  for (const id of ids) {
    if (lexists(path.join(root, flowRecordPath(id)))) continue;
    try {
      const file = path.join(root, FLOW_WORK_DIR, id, 'state.json');
      if (!fs.lstatSync(file).isFile()) continue;
      const run = (JSON.parse(fs.readFileSync(file, 'utf8')) as { agent?: { run?: unknown } }).agent?.run;
      if (typeof run === 'string') out.add(run);
    } catch { /* unreadable: recover.ts says so for its flow */ }
  }
  return out;
}

type Plan = { run: string; record: AgentRunRecord; job: JobRecord; act: 'stop' | 'gone' | 'ended before' };

/** What the records say now (reads only): the runs to act on, and the ones seen and left. */
function survey(d: AgentRecoverDeps, tableOnce: () => Proc[] | undefined): { plans: Plan[]; left: RecoveryItem[] } {
  const plans: Plan[] = [];
  const left: RecoveryItem[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(d.root, AGENTS_DIR)).filter((n) => RUN_ID.test(n)).sort(); } catch { return { plans, left }; }
  const ofFlows = flowRuns(d.root);
  for (const run of names) {
    if (ofFlows.has(run) || lexists(path.join(d.root, AGENTS_DIR, run, 'result.json'))) continue;
    const record = readRecord(d.root, run);
    if (!record || record.state !== 'submitted' || record.agent === 'openhands' || typeof record.job !== 'string' || !JOB_ID.test(record.job)) continue;
    const who = `agent run ${run} (${titleOf(record.agent)}, job ${record.job})`;
    let job: JobRecord | undefined;
    try { job = d.jobs.get(record.job); } catch { job = undefined; }
    if (!job) {
      left.push({ kind: 'agent-run', id: run, did: 'left', job: record.job, text: `${who} has no result, and its job is not in this Timmy's jobs folder, so whether it still runs cannot be told here: its record was left as it is` });
      continue;
    }
    if (job.stale) { plans.push({ run, record, job, act: 'gone' }); continue; }
    if (LIVE.has(job.state)) {
      if (d.mine(job.id)) continue;
      const lb = leftBehind(job, tableOnce());
      if (lb.kind === 'orphan') plans.push({ run, record, job, act: 'stop' });
      else left.push(leftItem(d, run, who, job, lb));
      continue;
    }
    // Ended: by an earlier recovery (its own words) with the run's record left unfinished, or in its own REPL (left as it is).
    if (ENDED_BY_RECOVERY.test(job.error ?? '')) plans.push({ run, record, job, act: 'ended before' });
  }
  return { plans, left };
}

/** A live job of a run, left as it is: run by another session, just ended, or left by an ended REPL without proof. */
function leftItem(d: AgentRecoverDeps, run: string, who: string, job: JobRecord, lb: LeftJob): RecoveryItem {
  if (lb.kind === 'gone') return { kind: 'agent-run', id: run, did: 'left', job: job.id, text: `${who}: the processes of its job have just ended: /recover again to record it` };
  if (lb.kind === 'unproven') {
    const cut = (s: string): string => (s.length > 72 ? `${s.slice(0, 71)}…` : s);
    const shown = lb.members.slice(0, 4).map((p) => `pid ${p.pid} (${cut(d.scrub(p.args))})`).join(', ');
    const more = lb.members.length > 4 ? ` and ${lb.members.length - 4} more` : '';
    const runs = lb.members.length ? `${plural(lb.members.length, 'process', 'processes')} of its process group ${lb.pgid} still run${lb.members.length === 1 ? 's' : ''}: ${shown}${more}` : `its process group ${lb.pgid} may still run`;
    return { kind: 'agent-run', id: run, did: 'left', attention: true, job: job.id, text: `${who} was left running by a REPL that has ended; ${runs}. Nothing was stopped, because ${lb.why}: kill -TERM -- -${lb.pgid} stops the group (then kill -KILL -- -${lb.pgid} if any of it is left), and /recover records the run once it has ended` };
  }
  const why = lb.kind === 'theirs' && lb.why ? `, as far as Timmy can tell: ${lb.why}` : '';
  return { kind: 'agent-run', id: run, did: 'left', job: job.id, text: `${who} still runs (another session${why}): /recover again once it has ended` };
}

/** Finds and ends the code agent runs an ended session left in this project; see the module comment. Never throws. */
export async function recoverAgentRuns(d: AgentRecoverDeps): Promise<RecoveryItem[]> {
  let table: Proc[] | undefined | null = null;
  const tableOnce = (): Proc[] | undefined => (table === null ? (table = (d.table ?? processTable)()) : table);
  let s: ReturnType<typeof survey>;
  try { s = survey(d, tableOnce); } catch (e) { return [{ kind: 'agent-run', id: 'agents', did: 'failed', text: `the agent runs could not be read: ${d.scrub(message(e))}` }]; }
  if (s.plans.some((p) => p.act === 'gone')) {
    // A stale record is believed only when it is still stale after a moment: an alive session records its job's end at once.
    await sleep(d.settleMs ?? SETTLE_MS);
    table = null;
    const before = new Map(s.plans.map((p) => [p.run, p.act]));
    try { s = survey(d, tableOnce); } catch (e) { return [{ kind: 'agent-run', id: 'agents', did: 'failed', text: `the agent runs could not be read: ${d.scrub(message(e))}` }]; }
    s.plans = s.plans.filter((p) => p.act !== 'gone' || before.get(p.run) === 'gone');
  }
  const done: RecoveryItem[] = [];
  for (const p of s.plans) {
    if (!d.open()) { done.push({ kind: 'agent-run', id: p.run, did: 'left', job: p.job.id, text: `agent run ${p.run}: not picked up, because this REPL is ending` }); continue; }
    try { done.push(await act(d, p)); } catch (e) { done.push({ kind: 'agent-run', id: p.run, did: 'failed', job: p.job.id, text: `agent run ${p.run} could not be picked up: ${d.scrub(message(e))}` }); }
  }
  return [...done, ...s.left];
}

/** One run: its job stopped or ended as its plan says, then its record ended and the end sealed. */
async function act(d: AgentRecoverDeps, p: Plan): Promise<RecoveryItem> {
  const who = `agent run ${p.run} (${titleOf(p.record.agent)}, job ${p.job.id})`;
  let end: LeftRunEnd;
  let job: { id: string; state: string; error?: string; endedAt?: string };
  let how: string;
  let stopped: LeftStop | undefined;
  if (p.act === 'stop') {
    const r = await stopLeft(d, p.job);
    if ('kind' in r) return leftItem(d, p.run, who, p.job, r.kind === 'orphan' ? { kind: 'theirs' } : r);
    stopped = r;
    const now = d.jobs.get(p.job.id);
    const recorded = r.recorded ?? (now && !LIVE.has(now.state) ? { state: now.state, error: now.error ?? '' } : undefined);
    if (!recorded) return { kind: 'agent-run', id: p.run, did: 'failed', job: p.job.id, stopped: r, attention: true, text: `${who}: recovery stopped its process group ${r.process_group}, but its job's record could not be ended, so its record ${runRecordRel(p.run)} was left as it is` };
    job = { id: p.job.id, state: recorded.state, ...(recorded.error ? { error: recorded.error } : {}) };
    end = { how: 'stopped', stopped: { process_group: r.process_group, processes: r.processes, signals: [...r.signals], cleanup: r.cleanup } };
    how = `was left running by a REPL that ended: recovery stopped its process group ${r.process_group} (${plural(r.processes, 'process', 'processes')}) with ${r.signals.join(', then ')}${r.cleanup === 'unresolved' ? `, and some of it did not stop: kill -KILL -- -${r.process_group}` : ''}; its job record now says ${recorded.state}`;
  } else if (p.act === 'gone') {
    let ended: JobRecord | undefined;
    try { ended = d.jobs.endLeft?.(p.job.id, { state: 'failed', error: GONE_WORDS }); } catch { ended = undefined; }
    if (!ended) {
      // Another session's recovery may have ended it meanwhile: then its words are taken as an earlier recovery's.
      const now = d.jobs.get(p.job.id);
      if (!now || LIVE.has(now.state) || now.stale || !ENDED_BY_RECOVERY.test(now.error ?? '')) return { kind: 'agent-run', id: p.run, did: 'left', job: p.job.id, text: `${who}: its job's record could not be ended (it changed meanwhile): /recover again` };
      return act(d, { ...p, job: now, act: 'ended before' });
    }
    job = { id: ended.id, state: ended.state, ...(ended.error ? { error: ended.error } : {}) };
    end = { how: 'gone' };
    how = `was left running by a REPL that ended, and its process is gone: its job record now says ${ended.state}: ${ended.error ?? GONE_WORDS}`;
  } else {
    job = { id: p.job.id, state: p.job.state, ...(p.job.error ? { error: p.job.error } : {}), ...(p.job.endedAt ? { endedAt: p.job.endedAt } : {}) };
    end = { how: 'ended before' };
    how = `: an earlier recovery ended its job (its record says ${p.job.state}: ${p.job.error ?? ''}), but not its own record`;
  }
  const w: LeftRunEnded = endLeftAgentRun(d.root, p.run, { job, end, ...(d.now ? { now: d.now } : {}) });
  const lead = p.act === 'ended before' ? `${who}${how}` : `${who} ${how}`;
  if (!w.ok) return { kind: 'agent-run', id: p.run, did: 'failed', job: p.job.id, ...(stopped ? { stopped } : {}), attention: true, text: `${lead}; its record ${w.path} was left as it is: ${w.why}` };
  const why = w.record.why ?? '';
  const operation = typeof p.record.operation === 'string' && OPERATION_ID.test(p.record.operation) ? { operation_id: p.record.operation } : {};
  let receipt: string | undefined;
  try {
    receipt = d.seal({
      kind: 'recover', subject: `recover · agent · ${p.record.agent} · ${p.run} · interrupted`, policy: 'human-gated', status: stopped?.cleanup === 'unresolved' ? 'failed' : 'ok',
      ...operation, // the request the run belonged to, not the one that recovered it
      project: d.project, project_id: projectId(d.root),
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
      sources: [{
        operation: p.run, agent: p.record.agent, job: p.job.id,
        action: p.act === 'stop' ? 'stopped its process group' : p.act === 'gone' ? 'found its process gone' : 'ended its record as its job record says',
        why: d.scrub(why),
        ...(stopped ? { process_group: stopped.process_group, processes: stopped.processes, signals: stopped.signals, cleanup: stopped.cleanup } : {}),
      }],
    });
  } catch { receipt = undefined; }
  return {
    kind: 'agent-run', id: p.run, did: 'interrupted', job: p.job.id, record: w.path, ...(receipt ? { receipt } : {}), ...(stopped ? { stopped } : {}),
    ...(stopped?.cleanup === 'unresolved' ? { attention: true } : {}),
    text: `${lead}; its record ${w.path} now says interrupted (no result was written)${receipt ? `; receipt ${receipt}` : '; the receipt could not be sealed'}`,
  };
}
