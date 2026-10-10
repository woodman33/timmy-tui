/**
 * Round R4 (helper H68; r20, ledger row 162, finding 3): the operations a recovery pass settles.
 *
 * An operation's record (.timmy/operations/<id>.json, src/ops/operations.ts) is written only by the process that began it
 * (a REPL, or `timmy act`), which ends it once its request has returned and none of its runs runs. A process killed first
 * left its record saying "running" for ever, and its card "…it was left as it was", even after /recover had ended its runs.
 *
 * Asked last in a recovery pass (src/repl/recover.ts, RecoverDeps.operations), once the pass has ended what it could, this
 * ends each record that still says it runs, through the operations module's writer (endLeftOperation), when both hold:
 *   - the process that began it is proven gone: no process with its pid runs now, or one that started at another time
 *     (src/ops/process-proof.ts writerState, the pid and start proof recovery applies); one whose state cannot be read
 *     counts as running, and its operation is left open;
 *   - nothing of it runs or waits on recovery, in any process: no job naming it, or that its record lists, is queued,
 *     running or ready in this Timmy's jobs folder (a live process that joined it runs its jobs under its id, so it is
 *     left open while that process's run runs); no flow of it says it runs without a record; no code agent run of it says
 *     "submitted" while its job runs, is stale, is not in this jobs folder or was ended by a recovery that has not ended
 *     the run's own record yet; no native run of it that started waits to be judged (one stopped with /stop is not
 *     judged); and every job its record lists is in this jobs folder (one that is not cannot be told: left open).
 * Its record then says "interrupted", ended now, and why in words: which process ended, then each of its runs as its own
 * record says it ended (a run another run's record names counts with that run), those recovery ended first. No run's result
 * is claimed for the operation, nothing is sealed (operation records are written, never sealed), and nothing else changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, RUN_RECORD } from '../code-agents/index.js';
import { MCP_CALL_ID, MCP_CALLS_DIR } from '../connectors/mcp-records.js';
import { FLOW_WORK_DIR, FLOWS_DIR, flowRecordPath } from '../flows/iterate.js';
import type { JobRecord } from '../jobs/index.js';
import { NATIVE_APPS, readNativeRecord, type NativeApp } from '../native/index.js';
import type { RecoveryItem } from '../repl/recover.js';
import { VOX_ID, voxRecordPath } from '../vox/record.js';
import { OPERATION_ID } from './context.js';
import { endLeftOperation, listOperationRecords, readOperationRecord, type OperationRecord } from './operations.js';
import { flowClaims, readProjectRecord, voxOutcome } from './outcome.js';
import { writerState } from './process-proof.js';

export interface OperationRecoverDeps {
  /** the project folder looked at */
  root: string;
  /** this Timmy's jobs folder (JobManager list and get): its own jobs and the records other sessions left there */
  jobs: { list(): JobRecord[]; get(id: string): JobRecord | undefined };
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string) => string;
  /** false once this REPL is ending: nothing more is written */
  open: () => boolean;
  now?: () => number;
}

/** How many of the project's operation records are looked at, newest first. */
const MAX_RECORDS = 400;
const RECORD_MAX = 4 * 1024 * 1024;
const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);
/** The words every end a recovery writes in a job's record begins with (recover.ts, workflow-recover.ts, openhands-recover.ts). */
const BY_RECOVERY = /^(?:interrupted: )?its REPL ended\b/;
const JOB_ID = /^j[0-9a-f]{6}$/;
const NATIVE_RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The id of each kind of run an operation names (a record's runs are only looked up by an id of their kind). */
const RUN_IDS: Readonly<Record<string, RegExp>> = { job: JOB_ID, flow: /^f[0-9a-f]{8}$/, agent: /^a[0-9a-f]{8}$/, native: NATIVE_RUN, vox: VOX_ID, mcp: MCP_CALL_ID };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

interface Run { kind: string; id: string }
/** A run as its own record says it is now: still going or waiting on recovery (pending), or ended, and in words. */
type Ended = { pending: false; words: string; byRecovery: boolean; claims: string[] };
type RunEnd = { pending: true; words: string } | Ended;
const pending = (words: string): RunEnd => ({ pending: true, words });
const ended = (words: string, byRecovery = false, claims: string[] = []): Ended => ({ pending: false, words, byRecovery, claims });
const isRun = (r: Run): boolean => !!RUN_IDS[r.kind]?.test(r.id);

/** Every run of the project's records that names an operation (the jobs folder's jobs, flows, code agent runs, native runs). */
function runIndex(d: OperationRecoverDeps): Map<string, Run[]> {
  const out = new Map<string, Run[]>();
  const add = (op: unknown, run: Run): void => {
    if (typeof op !== 'string' || !OPERATION_ID.test(op)) return;
    const list = out.get(op) ?? [];
    if (!list.some((r) => r.kind === run.kind && r.id === run.id)) list.push(run);
    out.set(op, list);
  };
  let jobs: JobRecord[] = [];
  try { jobs = d.jobs.list(); } catch { jobs = []; }
  for (const j of jobs) add(j.operation, { kind: 'job', id: j.id });
  const names = (rel: string, test: RegExp): string[] => { try { return fs.readdirSync(path.join(d.root, rel)).filter((n) => test.test(n)).sort(); } catch { return []; } };
  for (const n of names(FLOWS_DIR, /^f[0-9a-f]{8}\.json$/)) {
    const r = readProjectRecord(d.root, `${FLOWS_DIR}/${n}`);
    if (r.ok) add(obj(r.value)?.operation, { kind: 'flow', id: n.slice(0, -5) });
  }
  for (const id of names(FLOW_WORK_DIR, RUN_IDS.flow)) {
    const r = readProjectRecord(d.root, `${FLOW_WORK_DIR}/${id}/state.json`);
    if (r.ok) add(obj(r.value)?.operation, { kind: 'flow', id });
  }
  for (const run of names(AGENTS_DIR, RUN_IDS.agent)) {
    const r = readProjectRecord(d.root, `${AGENTS_DIR}/${run}/${RUN_RECORD}`, RECORD_MAX);
    if (r.ok) add(obj(r.value)?.operation, { kind: 'agent', id: run });
  }
  for (const run of names('.timmy/native', NATIVE_RUN)) {
    const r = readProjectRecord(d.root, `.timmy/native/${run}/job.json`);
    if (r.ok) add(obj(r.value)?.operation, { kind: 'native', id: run });
  }
  return out;
}

/** A job's name in words: a workflow run by its document and block, else its id. */
function jobName(d: OperationRecoverDeps, j: JobRecord): string {
  return j.kind === 'workflow' ? `workflow run ${j.id} (${d.scrub(j.label).slice(0, 80)})` : `job ${j.id}`;
}

/** A job's record in this Timmy's jobs folder, or undefined. */
function jobOf(d: OperationRecoverDeps, id: string | undefined): JobRecord | undefined {
  try { return id && JOB_ID.test(id) ? d.jobs.get(id) : undefined; } catch { return undefined; }
}

/** How one run of an operation is now, by its own record (and, for a job, its record in this Timmy's jobs folder). */
function endOf(d: OperationRecoverDeps, run: Run, who: string): RunEnd {
  const root = d.root;
  switch (run.kind) {
    case 'job': {
      const j = jobOf(d, run.id);
      if (!j) return pending(`job ${run.id}: its record is not in this Timmy's jobs folder, so whether it runs cannot be told`);
      if (j.stale) return ended(`${jobName(d, j)}: its process is gone, and its record still says ${j.state}`);
      if (LIVE.has(j.state)) return pending(`${jobName(d, j)} ${j.state}`);
      return ended(`${jobName(d, j)} ${j.state}${j.error ? ` (${d.scrub(j.error).slice(0, 300)})` : ''}`, BY_RECOVERY.test(j.error ?? ''));
    }
    case 'flow': {
      const rec = readProjectRecord(root, flowRecordPath(run.id));
      if (rec.ok) {
        const r = obj(rec.value) ?? {};
        const outcome = str(r.outcome) ?? 'unknown';
        const step = str(r.ended_in);
        return ended(`flow ${run.id} ${outcome}${outcome !== 'succeeded' && step ? ` in its ${step} step` : ''}`, !!obj(r.recovered), flowClaims(r));
      }
      const state = readProjectRecord(root, `${FLOW_WORK_DIR}/${run.id}/state.json`);
      const s = state.ok ? obj(state.value) : undefined;
      if (s?.outcome === 'running') return pending(`flow ${run.id} says its ${str(s.step) ?? '?'} step runs, with no record yet`);
      return ended(`flow ${run.id}: no record (its ${who} ended before it wrote one)`, false, s ? flowClaims(s) : []);
    }
    case 'agent': {
      const result = readProjectRecord(root, `${AGENTS_DIR}/${run.id}/result.json`, RECORD_MAX);
      const r = result.ok ? obj(result.value) : undefined;
      if (r) { const job = str(r.job); return ended(`agent run ${run.id} ${str(r.outcome) ?? 'ended'}`, false, job && JOB_ID.test(job) ? [`job:${job}`] : []); }
      const own = readProjectRecord(root, `${AGENTS_DIR}/${run.id}/${RUN_RECORD}`, RECORD_MAX);
      const v = own.ok ? obj(own.value) : undefined;
      if (!v) return ended(`agent run ${run.id}: no record`);
      const jobId = str(v.job);
      const claims = jobId && JOB_ID.test(jobId) ? [`job:${jobId}`] : [];
      if (v.state === 'interrupted') return ended(`agent run ${run.id} interrupted${str(v.why) ? ` (${d.scrub(String(v.why)).slice(0, 300)})` : ''}`, obj(v.recovered)?.by === 'recovery', claims);
      if (v.state !== 'submitted') return ended(`agent run ${run.id} ${str(v.state) ?? 'ended'}`, false, claims);
      // Submitted, no result: it waits on recovery while its job runs, is stale, is not here, or was ended by a recovery
      // (recover-agents.ts then ends the run's record); a job that ended in its own REPL leaves nothing for recovery to do.
      const j = jobOf(d, jobId);
      if (!j || j.stale || LIVE.has(j.state) || BY_RECOVERY.test(j.error ?? '')) return pending(`agent run ${run.id} has no result, and its record says submitted`);
      return ended(`agent run ${run.id}: its job ${j.id} ${j.state}, and its ${who} ended before it wrote the run's result`, false, claims);
    }
    case 'native': {
      let rec: ReturnType<typeof readNativeRecord>;
      try { rec = readNativeRecord(root, run.id); } catch { rec = undefined; }
      const name = `${rec ? NATIVE_APPS[rec.job.app as NativeApp]?.name ?? rec.job.app : 'native'} run ${run.id.slice(0, 8)}`;
      if (!rec) return ended(`${name}: no record`);
      const jobId = rec.started?.job;
      const claims = jobId && JOB_ID.test(jobId) ? [`job:${jobId}`] : [];
      const last = rec.verdicts.at(-1);
      if (last) return ended(`${name} judged ${last.outcome}`, false, claims);
      if (!rec.started) return ended(`${name} did not start`);
      const j = jobOf(d, jobId);
      if (j && !j.stale && j.state === 'cancelled') return ended(`${name} stopped before it was judged`, false, claims);
      return pending(`${name} is not judged yet`);
    }
    case 'vox': {
      const rec = readProjectRecord(root, voxRecordPath(run.id));
      if (!rec.ok) return ended(`VoxVision ${run.id}: no record (its ${who} ended while it ran)`);
      const out = voxOutcome(rec.value);
      return ended(`VoxVision ${run.id} ${out.words}`, false, out.claims ?? []);
    }
    case 'mcp': {
      const rec = readProjectRecord(root, `${MCP_CALLS_DIR}/${run.id}/call.json`);
      return ended(rec.ok ? `MCP call ${run.id} ${str(obj(rec.value)?.outcome) ?? 'recorded'}` : `MCP call ${run.id}: no record (its ${who} ended while it ran)`);
    }
    default: return pending(`${run.kind} ${run.id}: a run Timmy does not know`);
  }
}

/** Why it ended, in words: which process ended, then its runs as their own records say (those recovery ended first). */
function whyOf(who: string, looked: Array<{ run: Run; end: Ended }>): string {
  const claimed = new Set(looked.flatMap((x) => x.end.claims));
  const decisive = looked.filter((x) => !claimed.has(`${x.run.kind}:${x.run.id}`));
  const list = (words: string[]): string => (words.length > 8 ? `${words.slice(0, 8).join('; ')}; and ${words.length - 8} more` : words.join('; '));
  const by = decisive.filter((x) => x.end.byRecovery).map((x) => x.end.words);
  const other = decisive.filter((x) => !x.end.byRecovery).map((x) => x.end.words);
  const parts = [`its ${who} ended before it did`];
  if (by.length) parts.push(`recovery ended its runs: ${list(by)}`);
  if (other.length) parts.push(`${by.length ? 'its other runs had ended' : 'its runs had ended'}: ${list(other)}`);
  if (!decisive.length) parts.push('it had started no run');
  return parts.join('; ');
}

/** Ends the operations of the project that recovery has settled; see the module comment. Never throws. */
export function recoverOperations(d: OperationRecoverDeps): RecoveryItem[] {
  let records: Array<{ record: OperationRecord; rel: string }>;
  try { records = listOperationRecords(d.root, MAX_RECORDS).list; } catch { return []; }
  // The process that began it: proven gone (never by its age; 'unknown' counts as running).
  const open = records.filter((r) => r.record.ended === null && writerState(r.record.owner) === 'gone');
  if (!open.length) return [];
  let index: Map<string, Run[]>;
  try { index = runIndex(d); } catch (e) { return [{ kind: 'operation', id: 'operations', did: 'failed', text: `the operations could not be checked: ${d.scrub(e instanceof Error ? e.message : String(e))}` }]; }
  const items: RecoveryItem[] = [];
  for (const { record } of open) {
    const id = record.id;
    const who = record.via === 'act' ? 'timmy act' : 'REPL';
    const runs: Run[] = [];
    for (const r of [...record.runs, ...(index.get(id) ?? [])]) if (isRun(r) && !runs.some((x) => x.kind === r.kind && x.id === r.id)) runs.push({ kind: r.kind, id: r.id });
    const looked = runs.map((run) => ({ run, end: endOf(d, run, who) }));
    // Something of it still runs, or waits on recovery (or cannot be told): left open as it is.
    if (looked.some((x) => x.end.pending)) continue;
    const request = d.scrub(record.request);
    const req = request.length > 70 ? `${request.slice(0, 69)}…` : request;
    if (!d.open()) { items.push({ kind: 'operation', id, did: 'left', text: `operation ${id} (${req}): not ended, because this REPL is ending` }); continue; }
    const why = whyOf(who, looked as Array<{ run: Run; end: Ended }>);
    const w = endLeftOperation(d.root, id, { why: d.scrub(why), at: new Date((d.now ?? Date.now)()).toISOString() });
    if (!w.ok) {
      // Ended meanwhile (another session's recovery), or its process is not proven gone any more: said as it is now.
      const now = readOperationRecord(d.root, id);
      const left = now.ok && (now.record.ended !== null || writerState(now.record.owner) !== 'gone');
      items.push({ kind: 'operation', id, did: left ? 'left' : 'failed', record: w.rel, text: `operation ${id} (${req}): ${left ? 'left as it is' : 'each of its runs has ended, but its record could not be ended'}: ${d.scrub(w.error)}` });
      continue;
    }
    items.push({
      kind: 'operation', id, did: 'interrupted', state: 'interrupted', record: w.rel,
      text: `operation ${id} (${req}): the ${who} that began it has ended${looked.length ? ' and each of its runs has ended' : ', and it had started no run'}, so its record ${w.rel} now says interrupted (no run's result is claimed for it)`,
    });
  }
  return items;
}
