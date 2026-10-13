/**
 * Round R4 (helper H68; r20, ledger row 162, finding 2): runs a REPL that ended left, for "Waiting on you"
 * (src/room/decisions.ts: its item for what a session that ended left, which /recover settles).
 *
 * On the Mac (r20) a REPL killed with SIGKILL during a plain `/agent qwen` run left the agent's process group running, and
 * "Waiting on you" said nothing: the decisions looked only at flows, recipe watchers and native runs, and only at jobs whose
 * process was gone. Here, read only from the records recovery acts on (nothing is stopped, written or sealed):
 *   - a code agent run (a plain /agent run, or an OpenHands run), as src/repl/recover-agents.ts and openhands-recover.ts
 *     find one: its own record (.timmy/agents/<run>/run.json) says "submitted" and no result.json is beside it; it is not
 *     the agent step of a flow that has no record yet (decisions.ts lists that flow; recover.ts ends both); and its job's
 *     record in this Timmy's jobs folder was left by a REPL that ended: that job still runs in its own process group, its
 *     process is gone (its record is stale), or an earlier recovery ended the job but not the run's own record;
 *   - a workflow run (/run) whose job still runs in its own process group (src/repl/workflow-recover.ts stops it; one whose
 *     process is gone, or that recovery recorded interrupted, decisions.ts lists as interrupted).
 * "Left by a REPL that ended" is proven as recovery proves it, never by age: the job's record names the REPL that started
 * it (its pid, and when it started), and no process with that pid runs now, or the one that does started at another time
 * (its pid was reused): src/ops/process-proof.ts writerState. A job of this process, of a REPL that still runs, of a record
 * that names no REPL (written before job records did), or whose REPL's state cannot be read, is not listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, AGENTS_DIR, RUN_RECORD, type AgentName } from '../code-agents/index.js';
import type { JobRecord } from '../jobs/index.js';
import { START_SLACK_MS, THIS_PROCESS, writerState } from '../ops/process-proof.js';
import { runOf } from '../repl/board-workflows.js';
import { flowRuns } from '../repl/recover-agents.js';
import { cleanLine } from './index.js';

/** One run a REPL that ended left, in words for "Waiting on you". */
export interface LeftRun {
  /** a code agent's run (a plain /agent run, or an OpenHands run), or a /run */
  kind: 'agent' | 'openhands' | 'workflow';
  /** its process group still runs; its process is gone; or an earlier recovery ended its job but not its run's record */
  how: 'running' | 'gone' | 'ended before';
  words: string;
  /** its own record in the project, when it has one */
  record?: string;
  /** the operation its record (or its job's) names */
  operation?: string;
  job: string;
  /** when it started (ms), for the order */
  at: number;
}

const LIVE: ReadonlySet<string> = new Set(['running', 'ready']);
/** A code agent's job, by its label (src/code-agents agentLabel): the agent and its run. */
const AGENT_JOB = /^agent (\S+) (a[0-9a-f]{8}):/;
/** The words every end recovery writes in a job's record begin with (as recover-agents.ts reads them). */
const ENDED_BY_RECOVERY = /^its REPL ended\b/;
const RECORD_MAX = 4 * 1024 * 1024;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const time = (iso: unknown): number => { const t = typeof iso === 'string' ? Date.parse(iso) : Number.NaN; return Number.isNaN(t) ? 0 : t; };

/**
 * Whether the REPL (or `timmy act`) that started a job is proven to have ended: its record names it, and no process with
 * its pid runs now, or the one that does started at another time (process-proof.ts writerState). A job this process
 * started is never left: its start, as the job manager noted it, is this process's within the proof's slack.
 */
export function starterGone(job: Pick<JobRecord, 'owner'>): boolean {
  const o = job.owner;
  if (!o) return false;
  if (o.pid === THIS_PROCESS.pid) {
    const at = Date.parse(o.startedAt);
    return Number.isFinite(at) && Math.abs(at - Date.parse(THIS_PROCESS.started)) > START_SLACK_MS;
  }
  return writerState({ pid: o.pid, started: o.startedAt }) === 'gone';
}

/** How a job was left by a REPL that ended, proven (see starterGone), or undefined when it was not. */
function leftHow(j: JobRecord, endedBefore: boolean): LeftRun['how'] | undefined {
  const how = j.stale ? 'gone'
    : LIVE.has(j.state) ? (typeof j.pid === 'number' ? 'running' : undefined)
      : endedBefore && j.state !== 'queued' && ENDED_BY_RECOVERY.test(j.error ?? '') ? 'ended before' : undefined;
  return how && starterGone(j) ? how : undefined;
}

/** A run's own record as its start wrote it (a regular file in the project, this run's), when it has no result.json. */
function submittedRecord(root: string, run: string): Obj | undefined {
  try {
    const dir = path.join(root, AGENTS_DIR, run);
    try { fs.lstatSync(path.join(dir, 'result.json')); return undefined; } catch { /* no result: it did not end in its REPL */ }
    const file = path.join(dir, RUN_RECORD);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    const rec = obj(JSON.parse(fs.readFileSync(file, 'utf8')));
    return rec && rec.run === run && rec.state === 'submitted' ? rec : undefined;
  } catch { return undefined; }
}

/** The code agent runs and workflow runs of these jobs (the project's) that a REPL that ended left; see the module comment. */
export function leftRuns(c: { root: string; jobs: readonly JobRecord[]; scrub: (t: string) => string }): LeftRun[] {
  const out: LeftRun[] = [];
  let ofFlows: Set<string> | undefined;
  for (const j of c.jobs) {
    if (j.kind === 'workflow') {
      if (j.stale || leftHow(j, false) !== 'running') continue;
      const r = runOf(j);
      const name = cleanLine(r ? `${r.doc} › ${r.target}` : j.label, c.scrub, 120);
      out.push({ kind: 'workflow', how: 'running', words: `workflow run ${j.id} (${name}) is still running in its own process group ${j.pid}, and the REPL that started it has ended`, job: j.id, ...(j.operation ? { operation: j.operation } : {}), at: time(j.startedAt) });
      continue;
    }
    const m = AGENT_JOB.exec(j.label);
    if (!m) continue;
    const how = leftHow(j, true);
    if (!how) continue;
    const run = m[2];
    ofFlows ??= flowRuns(c.root);
    if (ofFlows.has(run)) continue;
    const rec = submittedRecord(c.root, run);
    if (!rec || rec.job !== j.id) continue;
    const agent = String(rec.agent ?? m[1]);
    const earlier = `an earlier recovery ended its job (its record says ${j.state}), but its own record still says submitted`;
    let words: string;
    if (agent === 'openhands') {
      const container = str(obj(obj(rec.openhands)?.container)?.name);
      const who = `OpenHands run ${run} (job ${j.id}${container ? `, container ${cleanLine(container, c.scrub, 80)}` : ''})`;
      words = how === 'running' ? `${who}: its docker client is still running in its own process group ${j.pid}, and the REPL that started it has ended`
        : how === 'gone' ? `${who}: its docker client's process is gone and the REPL that started it has ended (whether its container still runs, /recover asks docker)`
          : `${who}: ${earlier}`;
    } else {
      const who = `agent run ${run} (${AGENTS[agent as AgentName]?.title ?? cleanLine(agent, c.scrub, 40)}, job ${j.id})`;
      words = how === 'running' ? `${who} is still running in its own process group ${j.pid}, and the REPL that started it has ended`
        : how === 'gone' ? `${who}: its process is gone and the REPL that started it has ended, so its record still says submitted, with no result`
          : `${who}: ${earlier}`;
    }
    const operation = str(rec.operation) ?? j.operation;
    out.push({
      kind: agent === 'openhands' ? 'openhands' : 'agent', how, words, record: `${AGENTS_DIR}/${run}/${RUN_RECORD}`, job: j.id,
      ...(operation ? { operation } : {}), at: time(rec.started_at) || time(j.startedAt),
    });
  }
  return out;
}
