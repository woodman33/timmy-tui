/**
 * Round R4 (H51): how a run of an operation ended, read from the run's own record, in the words an operation's state is
 * decided by (src/ops/operations.ts decideState): a job's final state; a flow's outcome (and its readback's verdict); a
 * VoxVision record's status; a code agent's judged outcome; a native run's judgement; an MCP call's outcome. A run whose
 * record names other runs (a flow its agent run, its step jobs and its app's run; an action its tool jobs; an agent run
 * its job) claims them, so they are counted once, with it. Nothing is guessed: a record that cannot be read is
 * "unknown", which an operation counts as not succeeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { AGENTS_DIR } from '../code-agents/index.js';
import { flowRecordPath } from '../flows/iterate.js';
import { voxRecordPath } from '../vox/record.js';
import { MCP_CALLS_DIR } from '../connectors/mcp-records.js';
import { readNativeRecord } from '../native/index.js';
import { unrealRunOutcome } from '../native/unreal-readback.js';
import type { OperationRun, RunOutcome } from './operations.js';

const JOB_ID = /^j[0-9a-f]{6}$/;
const AGENT_RUN = /^a[0-9a-f]{8}$/;
const NATIVE_RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A small JSON record in the project, or why not (never through a link). */
export function readProjectRecord(root: string, rel: string, max = 1024 * 1024): { ok: true; value: unknown; text: string } | { ok: false; error: string } {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, error: `${rel} is a symbolic link` };
    if (!st.isFile()) return { ok: false, error: `${rel} is not a file` };
    if (st.size > max) return { ok: false, error: `${rel} is larger than such a record` };
    const text = fs.readFileSync(abs, 'utf8');
    return { ok: true, value: JSON.parse(text), text };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? `${rel} is not there` : code ? `${code} reading ${rel}` : `${rel} is not JSON` };
  }
}

/** The runs a flow record names: its agent run, each step's job, each app's run. */
export function flowClaims(record: unknown): string[] {
  const r = obj(record) ?? {};
  const out = new Set<string>();
  for (const v of Object.values(r)) {
    const part = obj(v);
    if (!part) continue;
    if (str(part.job) && JOB_ID.test(String(part.job))) out.add(`job:${String(part.job)}`);
    const run = str(part.run);
    if (run && AGENT_RUN.test(run)) out.add(`agent:${run}`);
    else if (run && NATIVE_RUN.test(run)) out.add(`native:${run}`);
  }
  return [...out];
}

/** A flow's outcome as an operation counts it: succeeded; differs; failed (Timmy's checks stopped it, or it failed); stopped (/stop, interrupted). */
export function flowOutcome(record: unknown): RunOutcome {
  const r = obj(record) ?? {};
  const outcome = String(r.outcome ?? 'unknown');
  const verdict = str(obj(r.readback)?.verdict);
  const ended = str(r.ended_in);
  const words = `${outcome}${verdict ? ` (readback ${verdict})` : ''}${outcome !== 'succeeded' && ended ? `, ended in its ${ended} step` : ''}`;
  const state: RunOutcome['state'] = outcome === 'succeeded' ? 'succeeded' : outcome === 'differs' ? 'differs'
    : outcome === 'cancelled' || outcome === 'interrupted' ? 'stopped' : outcome === 'running' ? 'running' : outcome === 'failed' || outcome === 'stopped' ? 'failed' : 'unknown';
  return { state, words, claims: flowClaims(r) };
}

/** A VoxVision record's status as an operation counts it: only ok succeeds; needs setup is a refusal; cancelled is stopped. */
export function voxOutcome(record: unknown): RunOutcome {
  const r = obj(record) ?? {};
  const status = String(r.status ?? 'unknown');
  const tools = Array.isArray(r.tools) ? r.tools.map(obj).filter((t): t is Obj => !!t) : [];
  const claims = tools.flatMap((t) => { const j = str(obj(t.job)?.id); return j && JOB_ID.test(j) ? [`job:${j}`] : []; });
  const state: RunOutcome['state'] = status === 'ok' ? 'succeeded' : status === 'needs-setup' ? 'refused' : status === 'cancelled' ? 'stopped'
    : status === 'untrusted' || status === 'partial' || status === 'failed' ? 'failed' : 'unknown';
  return { state, words: status, claims };
}

/** A job's final state: completed, failed, stopped. */
export function jobOutcome(j: JobRecord | undefined): RunOutcome {
  if (!j) return { state: 'unknown', words: 'its job record is not in this Timmy\'s jobs folder' };
  if (j.stale) return { state: 'stopped', words: `${j.state}; its process is gone` };
  if (j.state === 'completed') return { state: 'succeeded', words: 'completed' };
  if (j.state === 'cancelled') return { state: 'stopped', words: 'stopped' };
  if (j.state === 'failed') return { state: 'failed', words: `failed${j.error ? `: ${j.error.slice(0, 160)}` : ''}` };
  return { state: 'running', words: j.state };
}

/** How one run of an operation ended (or that it runs), by its own record in the project and, for a job, its job record. */
export function runOutcome(run: OperationRun, root: string, jobs: { get(id: string): JobRecord | undefined }): RunOutcome {
  switch (run.kind) {
    case 'job': return jobOutcome(jobs.get(run.id));
    case 'flow': {
      const r = readProjectRecord(root, flowRecordPath(run.id));
      return r.ok ? flowOutcome(r.value) : { state: 'unknown', words: `no record: ${r.error}` };
    }
    case 'vox': {
      const r = readProjectRecord(root, voxRecordPath(run.id));
      return r.ok ? voxOutcome(r.value) : { state: 'unknown', words: `no record: ${r.error}` };
    }
    case 'agent': {
      const r = readProjectRecord(root, `${AGENTS_DIR}/${run.id}/result.json`);
      const v = r.ok ? obj(r.value) : undefined;
      const job = str(v?.job);
      const claims = job && JOB_ID.test(job) ? [`job:${job}`] : [];
      const outcome = str(v?.outcome);
      if (!outcome) return { state: 'unknown', words: r.ok ? 'its result names no outcome' : `no result: ${r.error}`, claims };
      return { state: outcome === 'completed' ? 'succeeded' : outcome === 'cancelled' ? 'stopped' : 'failed', words: outcome, claims };
    }
    case 'native': {
      let rec: ReturnType<typeof readNativeRecord>;
      try { rec = readNativeRecord(root, run.id); } catch (e) { return { state: 'unknown', words: e instanceof Error ? e.message : String(e) }; }
      if (!rec) return { state: 'unknown', words: 'no record of the run' };
      const job = rec.started?.job;
      const claims = job && JOB_ID.test(job) ? [`job:${job}`] : [];
      const last = rec.verdicts.at(-1);
      // R4 (H63): an Unreal run's first pass is never trusted alone: its readback's verdict decides (and its readback jobs are its own).
      if (last && rec.job.app === 'unreal') return unrealRunOutcome(rec.dir, last, rec.result, claims);
      if (last) return { state: last.outcome === 'ok' ? 'succeeded' : 'failed', words: `${last.outcome} (judged by its result file)`, claims };
      const j = job ? jobs.get(job) : undefined;
      if (j?.state === 'cancelled') return { state: 'stopped', words: 'stopped before it was judged', claims };
      return { state: 'unknown', words: 'not judged', claims };
    }
    case 'mcp': {
      const r = readProjectRecord(root, `${MCP_CALLS_DIR}/${run.id}/call.json`);
      const v = r.ok ? obj(r.value) : undefined;
      const outcome = str(v?.outcome);
      if (!outcome) return { state: 'unknown', words: r.ok ? 'its record names no outcome' : `no record: ${r.error}` };
      return { state: outcome === 'answered' && v?.isError !== true ? 'succeeded' : outcome === 'stopped' ? 'stopped' : 'failed', words: outcome };
    }
    default: return { state: 'unknown', words: 'a run Timmy does not know' };
  }
}
