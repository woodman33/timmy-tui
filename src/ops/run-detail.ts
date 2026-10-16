/**
 * Round R4 (H102, part 2): the one run detail (src/contracts/run-detail.ts RunDetail) every surface renders: the terminal
 * Workbench, the companion, Timmy Studio's operation cards and `timmy op`. "Use one shared Run detail view, linkable from
 * Chat, Studio nodes, Activity, Control Room, God's Eye View and result cards" (the operator, 2026-10-11).
 *
 * Made from the records that exist now, each value with where it came from (`from`: a record path relative to the project,
 * `receipt <short id>`, or `job <id>` for a record in Timmy's jobs folder):
 *   the operation's record    .timmy/operations/<id>.json: the request's own words, its parent, its state and why
 *   its children              the operations whose record names it as their parent
 *   its jobs                  Timmy's jobs folder (<TIMMY_HOME>/jobs), the records naming the operation: a /run's job with
 *                             its blocks, a flow's step jobs; each one's own exit, apart from Timmy's verdict
 *   its receipts              the runs chain, as `timmy act` seals it from the project's folder: the prediction sealed before
 *                             a /run (frozen; never shown as an observed receipt), each block's, the run's, the flow's ...
 *   its flows                 results/flows/<id>.json naming the operation (read by name, all of them; a running flow's
 *                             state file in .timmy/flows/<id>/), each checked against its flow receipt
 *   its VoxVision records     results/vox/<id>.json naming the operation
 *   its code agent and native runs, and the lessons it made
 *
 * Kept apart, as the operator asked: the workflow stage (steps done of total, never a percentage), each process's own exit,
 * Timmy's verdict (src/ops/outcome.ts's words: no change, failed, cancelled and recovered kept apart from any exit), the
 * artifact's freshness (its recorded bytes against the bytes now) and a person's acceptance. What no record says is listed in
 * `unknown` with why, never guessed; a cost is a reported number, or unknown with why, never an invented 0. No file is picked
 * by its time. Nothing here runs, writes or seals; the executive summary is written only by writeRunSummary, when asked.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DETAIL_VERSION, type RunDetail, type RunFileRole, type RunVerdict, type Sourced } from '../contracts/run-detail.js';
import { AGENTS_DIR, listAgentRuns, type AgentRunRecord } from '../code-agents/index.js';
import { NO_CHANGE } from '../flows/iterate.js';
import { JobManager, type JobRecord } from '../jobs/index.js';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import { projectId, projectsHome, sameFolder } from '../project/index.js';
import { flowHandoff } from '../room/index.js';
import { flowOutputs as roomFlowOutputs } from '../room/index.js';
import { timmyHome } from '../utils/init.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { placeNew } from '../utils/place-new.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { chatTurnOf, TURN_FROM } from '../repl/seal.js';
import { blockReceiptsOf } from '../workflows/block-receipts.js';
import { blockCount } from '../workflows/block-count.js';
import { CHECKED_COPY, parseWorkflow, runOrder, type WorkflowBlock } from '../workflows/upmd.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import { flowOutputs, LESSONS_DIR, shaNow } from './card.js';
import { OPERATION_ID } from './context.js';
import { readRecords, runningFlowStates, sealOf, type RecordRead } from './evidence.js';
import { listOperationRecords, OPERATIONS_DIR, readOperationRecord, type OperationRecord, type OperationState } from './operations.js';
import { decideState, type RunOutcome } from './operations.js';
import { flowClaims, flowOutcome, jobOutcome, readProjectRecord, voxOutcome } from './outcome.js';
import { writerState } from './process-proof.js';

export type { RunDetail } from '../contracts/run-detail.js';

export interface RunDetailOptions {
  /** the project folder (default: the current folder, as `timmy act` and `timmy evidence` take it) */
  project?: string;
  /** Timmy's jobs folder (default: <TIMMY_HOME>/jobs) */
  jobsDir?: string;
  /** the jobs to read instead of the jobs folder's (a REPL passes its own manager's list) */
  jobs?: readonly JobRecord[];
  /** the runs chain (default: read from the project's folder, as `timmy act` seals it there) */
  chain?: readonly Receipt[];
  /** whose home folders are written "~" (default: this process's environment) */
  env?: NodeJS.ProcessEnv;
  /** a NEEDS YOU box waiting for this operation in the caller's own process (the REPL's waitingApprovals), in words */
  waiting?: (operation: string) => string | undefined;
  now?: () => Date;
}

/** Why no run detail was made: an id that is not one, an operation this project has no record of, another project's, or a
 *  record that cannot be read. */
export type RunDetailRefusal = 'not an id' | 'unknown' | 'other project' | 'unreadable';
export type RunDetailResult =
  | { ok: true; detail: RunDetail }
  | { ok: false; refusal: RunDetailRefusal; why: string; elsewhere?: { name: string; root?: string } };

export class RunDetailError extends Error {
  constructor(readonly refusal: RunDetailRefusal, message: string, readonly elsewhere?: { name: string; root?: string }) { super(message); }
}

/** Where `timmy op <id> --save` keeps the executive summary: the operation's own folder beside its record. */
export const summaryRel = (id: string): string => `${OPERATIONS_DIR}/${id}/summary.md`;
/** The run detail's JSON schema name (`timmy op --json`). */
export const RUN_DETAIL_SCHEMA = 'timmy.run-detail/1';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const short = (r: Pick<Receipt, 'hash' | 'id'>): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const SHA = /^[0-9a-f]{64}$/;
const relOk = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !p.includes('\0');
const time = (s: unknown): number | undefined => { const t = typeof s === 'string' ? Date.parse(s) : Number.NaN; return Number.isFinite(t) ? t : undefined; };

// ── reading ───────────────────────────────────────────────────────────────────

/** The runs chain as `timmy act` reads and seals it from the project's folder (TIMMY_STORE, else the store the folder pins). */
export function projectChain(root: string): Receipt[] {
  try { return process.env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

/** The records Timmy's jobs folder holds (read only: a job manager that starts nothing). */
export function jobsIn(dir: string): JobRecord[] {
  try { return new JobManager({ dir }).list(); } catch { return []; }
}

interface Facts {
  id: string;
  root: string;
  name: string;
  pid: string;
  scrub: (t: string) => string;
  env: NodeJS.ProcessEnv;
  now: Date;
  rec?: { record: OperationRecord; rel: string };
  jobs: JobRecord[];
  receipts: Receipt[];
  chain: readonly Receipt[];
  flows: Array<RecordRead & { check?: string }>;
  running: Array<{ id: string; rel: string; step?: string; value: Obj }>;
  voxes: Array<RecordRead & { check?: string }>;
  agents: AgentRunRecord[];
  natives: Array<{ run: string; rec: NonNullable<ReturnType<typeof readNativeRecord>> }>;
  lessons: Array<{ id: string; rel: string }>;
  unreadable: Array<{ rel: string; why: string }>;
  unknown: Array<{ field: string; why: string }>;
  waiting?: (operation: string) => string | undefined;
}

/** The lessons the operation made (a lesson's own `operation`), by name. */
function lessonsOf(root: string, id: string): Array<{ id: string; rel: string }> {
  let names: string[];
  try { names = fs.readdirSync(path.join(root, LESSONS_DIR)).filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n)).sort(); } catch { return []; }
  const out: Array<{ id: string; rel: string }> = [];
  for (const n of names.slice(0, 400)) {
    try {
      const abs = path.join(root, LESSONS_DIR, n);
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > 256 * 1024) continue;
      const v = obj(JSON.parse(fs.readFileSync(abs, 'utf8')));
      if (v && v.operation === id) out.push({ id: str(v.id) ?? n.slice(0, -5), rel: `${LESSONS_DIR}/${n}` });
    } catch { /* not one */ }
  }
  return out;
}

/** Where else an operation id is known: Timmy's jobs folder (a job's own project folder), the runs chain (a receipt's project),
 *  or another project under the Timmy home holding its record. */
function elsewhere(id: string, root: string, pid: string, allJobs: readonly JobRecord[], chain: readonly Receipt[]): { name: string; root?: string; by: string } | undefined {
  const job = allJobs.find((j) => j.operation === id && !sameFolder(j.root, root));
  if (job) return { name: job.project, root: job.root, by: `its job ${job.id} ran there` };
  let names: string[] = [];
  try { names = fs.readdirSync(projectsHome()).sort(); } catch { names = []; }
  for (const n of names) {
    const other = path.join(projectsHome(), n);
    if (sameFolder(other, root)) continue;
    if (fs.existsSync(path.join(other, OPERATIONS_DIR, `${id}.json`))) return { name: n, root: other, by: `its record is there (${OPERATIONS_DIR}/${id}.json)` };
  }
  const r = chain.find((x) => x.operation_id === id && x.project_id !== pid);
  if (r) return { name: String(r.project ?? 'another project'), by: `receipt ${short(r)} names it, for project ${String(r.project ?? '?')} (id ${String(r.project_id ?? '?')}); its folder is not recorded there` };
  return undefined;
}

function gather(id: string, o: RunDetailOptions): RunDetailResult | Facts {
  let root = path.resolve(o.project ?? process.cwd());
  try { root = fs.realpathSync(root); } catch { return { ok: false, refusal: 'unknown', why: `the project folder ${o.project ?? '.'} is not there` }; }
  const env = o.env ?? process.env;
  const realRoot = root;
  const scrub = (t: string): string => scrubHomes(t.split(realRoot).join('.'), env);
  const name = path.basename(root) || root;
  if (!OPERATION_ID.test(id)) return { ok: false, refusal: 'not an id', why: `${id} is not an operation id (o and 8 hex digits): /ops lists them` };
  const pid = projectId(root);
  const chain = o.chain ?? projectChain(root);
  const allJobs = o.jobs ? [...o.jobs] : jobsIn(o.jobsDir ?? path.join(timmyHome(), 'jobs'));
  const unreadable: Array<{ rel: string; why: string }> = [];
  const held = readOperationRecord(root, id);
  if (!held.ok && !/^no record /.test(held.error)) {
    return { ok: false, refusal: 'unreadable', why: `operation ${id}'s record ${held.rel} cannot be read: ${held.error}` };
  }
  const jobs = allJobs.filter((j) => j.operation === id && sameFolder(j.root, root));
  const receipts = chain.filter((r) => r && r.project_id === pid && r.operation_id === id);
  const flowRead = readRecords(root, 'flow');
  const voxRead = readRecords(root, 'vox');
  for (const u of [...flowRead.unreadable, ...voxRead.unreadable]) unreadable.push(u);
  // each record with the receipt that sealed its bytes under this operation, where one did
  const sealed = <T extends RecordRead>(r: T): T & { check?: string } => {
    const s = sealOf(chain, r, pid, id);
    return { ...r, ...(s.ok ? { check: short(s.receipt) } : {}) };
  };
  const flows = flowRead.list.filter((f) => f.operation === id).map(sealed);
  const running = runningFlowStates(root, id);
  const voxes = voxRead.list.filter((v) => v.operation === id).map(sealed);
  let agents: AgentRunRecord[] = [];
  try { agents = listAgentRuns(root).filter((a) => a.operation === id).sort((a, b) => a.run.localeCompare(b.run)); } catch { agents = []; }
  const natives: Facts['natives'] = [];
  try {
    for (const n of listNativeRuns(root)) {
      let rec: ReturnType<typeof readNativeRecord>;
      try { rec = readNativeRecord(root, n.run); } catch { rec = undefined; }
      if (rec && (rec.job as { operation?: string }).operation === id) natives.push({ run: n.run, rec });
    }
  } catch { /* none */ }
  natives.sort((a, b) => a.run.localeCompare(b.run));
  const lessons = lessonsOf(root, id);
  const known = held.ok || jobs.length || receipts.length || flows.length || running.length || voxes.length || agents.length || natives.length;
  if (!known) {
    const there = elsewhere(id, root, pid, allJobs, chain);
    if (there) {
      const at = there.root ? scrubHomes(there.root, env) : undefined;
      return {
        ok: false, refusal: 'other project', elsewhere: { name: there.name, ...(at ? { root: at } : {}) },
        why: `operation ${id} is not ${name}'s: it is ${there.name}'s (${there.by})${at ? `; timmy op ${id} --project ${at}` : ''}`,
      };
    }
    return { ok: false, refusal: 'unknown', why: `no record, job or receipt of ${name} names operation ${id} (${OPERATIONS_DIR}/, Timmy's jobs folder, the runs chain): /ops lists this project's operations` };
  }
  return {
    id, root, name, pid, scrub, env, now: (o.now ?? (() => new Date()))(), ...(held.ok ? { rec: { record: held.record, rel: held.rel } } : {}),
    jobs: [...jobs].sort((a, b) => a.id.localeCompare(b.id)), receipts, chain, flows, running, voxes, agents, natives, lessons, unreadable, unknown: [],
  };
}

// ── the parts ─────────────────────────────────────────────────────────────────

const VERDICT_OF: Readonly<Record<OperationState, RunVerdict>> = {
  running: 'running', succeeded: 'completed', answered: 'completed', failed: 'failed', differs: 'failed', 'no change': 'no change',
  stopped: 'cancelled', interrupted: 'recovered',
  // A refusal started nothing: a person's setup, choice or approval is what it waits on (its words say which).
  refused: 'needs you',
};

/** The workflow runs (a /run's job) of the operation, by id. */
const workflowJobs = (f: Facts): JobRecord[] => f.jobs.filter((j) => j.kind === 'workflow');

/** The operation's state from its runs' own records, when it has no record of its own here (src/ops/outcome.ts). */
function decidedFromRuns(f: Facts): { state: OperationState; why: string } {
  const outcomes: Array<{ run: { kind: 'job' | 'flow' | 'vox' | 'agent'; id: string; at: string }; out: RunOutcome }> = [];
  for (const j of f.jobs) outcomes.push({ run: { kind: 'job', id: j.id, at: '' }, out: jobOutcome(j) });
  for (const fl of f.flows) outcomes.push({ run: { kind: 'flow', id: fl.id, at: '' }, out: flowOutcome(fl.value) });
  for (const v of f.voxes) outcomes.push({ run: { kind: 'vox', id: v.id, at: '' }, out: voxOutcome(v.value) });
  if (f.running.length || outcomes.some((x) => x.out.state === 'running')) return { state: 'running', why: 'a run of it runs' };
  const d = decideState(outcomes);
  return { state: d.state, why: d.why };
}

function verdictOf(f: Facts, stage: RunDetail['stage']): RunDetail['verdict'] {
  const rec = f.rec?.record;
  if (rec && rec.ended === null) {
    const w = writerState(rec.owner);
    if (w === 'gone') {
      return { state: 'unknown', words: 'left running: its record says it runs, and the Timmy that began it has ended; /recover records how its runs ended', from: f.rec!.rel };
    }
    const box = f.waiting?.(f.id);
    if (box) return { state: 'needs you', words: `needs you: ${box}`, from: f.rec!.rel };
    const queued = f.jobs.length > 0 && f.jobs.every((j) => j.state === 'queued');
    if (queued) return { state: 'queued', words: 'queued: its job has not started', from: f.rec!.rel };
    return { state: 'running', words: `running${stage.current ? `: ${stage.current}` : ''}`, from: f.rec!.rel };
  }
  if (rec) {
    const state = VERDICT_OF[rec.state] ?? 'unknown';
    const why = rec.why ? f.scrub(rec.why) : '';
    return { state, words: `${rec.state}${why ? `: ${why}` : ''}`, from: f.rec!.rel };
  }
  const d = decidedFromRuns(f);
  const box = d.state === 'running' ? f.waiting?.(f.id) : undefined;
  return { state: box ? 'needs you' : VERDICT_OF[d.state] ?? 'unknown', words: `${d.state}: ${f.scrub(d.why)} (no record of the operation here; decided from its runs' own records)`, from: 'its runs\' records' };
}

/** The prediction receipt of a /run of this operation (its order, frozen before the run), or of a flow's recipe build. */
function predictionOf(f: Facts): { receipt: Receipt; doc?: string; block?: string; order?: string[]; docSha?: string; geometry?: { bounds: number[]; volume: number } } | undefined {
  const runPredict = f.receipts.find((r) => r.kind === 'predict' && obj((r as unknown as Obj).prediction));
  if (runPredict) {
    const p = obj((runPredict as unknown as Obj).prediction)!;
    const doc = str(p.doc);
    const order = Array.isArray(p.order) ? p.order.filter((x): x is string => typeof x === 'string') : undefined;
    const docSha = (runPredict.files ?? []).find((x) => x.path === doc)?.sha256;
    return { receipt: runPredict, ...(doc ? { doc } : {}), ...(str(p.block) ? { block: str(p.block) } : {}), ...(order ? { order } : {}), ...(docSha ? { docSha } : {}) };
  }
  for (const fl of f.flows) {
    const id = str(obj(fl.value.rebuild)?.prediction_receipt);
    if (!id) continue;
    const r = f.chain.find((x) => x.kind === 'predict' && x.project_id === f.pid && (short(x) === id || x.hash === id || x.id === id));
    const src = r ? list((r as unknown as Obj).sources).find((s) => Array.isArray(s.bounds_mm) && num(s.volume_mm3) !== undefined) : undefined;
    if (r && src) return { receipt: r, geometry: { bounds: (src.bounds_mm as unknown[]).map(Number), volume: Number(src.volume_mm3) } };
  }
  return undefined;
}

const mm = (v: number): string => String(Number(v.toPrecision(7)));

function stageOf(f: Facts, prediction: ReturnType<typeof predictionOf>): RunDetail['stage'] {
  const runs = workflowJobs(f);
  if (runs.length) {
    const j = runs.find((x) => x.label === `${prediction?.doc} › ${prediction?.block}`) ?? runs[0];
    const count = blockCount(j, { ...(prediction?.order ? { order: prediction.order } : {}), receipts: blockReceiptsOf(f.chain, j.id) });
    const now = count.blocks.find((b) => b.word === 'running');
    return { current: now ? now.name : null, done: count.ended, total: count.of ?? null, from: `job ${j.id}` };
  }
  if (f.running.length) {
    const r = f.running[0];
    return { current: r.step ?? null, done: 0, total: null, from: r.rel };
  }
  if (f.flows.length) {
    const fl = f.flows[0];
    let steps: ReturnType<typeof flowHandoff> = [];
    try { steps = flowHandoff(fl.value); } catch { steps = []; }
    const ended = steps.filter((s) => s.state === 'completed' || s.state === 'failed' || s.state === 'stopped' || s.state === 'interrupted' || s.state === NO_CHANGE).length;
    const now = steps.find((s) => s.state === 'running');
    return { current: now ? now.name : null, done: ended, total: steps.length || null, from: fl.rel };
  }
  if (f.voxes.length) {
    const ended = f.voxes.filter((v) => String(v.value.status ?? '') !== 'running').length;
    return { current: null, done: ended, total: f.voxes.length, from: f.voxes[0].rel };
  }
  f.unknown.push({ field: 'stage', why: 'no workflow run, flow or VoxVision action of this operation records its steps' });
  return { current: null, done: 0, total: null, from: f.rec?.rel ?? 'its runs\' records' };
}

function exitsOf(f: Facts, prediction: ReturnType<typeof predictionOf>): RunDetail['exits'] {
  const out: RunDetail['exits'] = [];
  const jobById = new Map(f.jobs.map((j) => [j.id, j]));
  for (const j of workflowJobs(f)) {
    out.push({ who: `upmd${isLiveRun(j.args) ? ', through its pty wrapper' : ''} (job ${j.id})`, code: j.exitCode ?? null, state: j.state, from: `job ${j.id}` });
    const count = blockCount(j, { ...(prediction?.order ? { order: prediction.order } : {}), receipts: blockReceiptsOf(f.chain, j.id) });
    for (const b of count.blocks) {
      if (b.word === 'waiting' || b.word === 'not run' || b.word === 'not seen') continue;
      out.push({ who: `block ${b.name}`, code: b.code ?? null, state: b.word, from: b.receipt ? `receipt ${b.receipt}` : `job ${j.id}` });
    }
  }
  const claimed = new Set<string>();
  for (const fl of f.flows) {
    const v = fl.value;
    const parts: Array<[string, unknown]> = [['agent', obj(v.agent)?.job], ['rebuild (the recipe\'s job)', obj(v.rebuild)?.job], ['readback', obj(v.readback)?.job]];
    const agentName = str(obj(v.agent)?.agent);
    for (const [what, jid] of parts) {
      if (typeof jid !== 'string') continue;
      claimed.add(jid);
      const j = jobById.get(jid);
      const who = `flow ${fl.id} ${what === 'agent' && agentName ? `agent ${agentName}` : what} (job ${jid})`;
      out.push(j ? { who, code: j.exitCode ?? null, state: j.state, from: `job ${jid}` } : { who, code: null, state: 'its job record is not in this Timmy\'s jobs folder', from: fl.rel });
    }
    for (const c of flowClaims(v)) if (c.startsWith('job:')) claimed.add(c.slice(4));
  }
  for (const a of f.agents) {
    if (claimed.has(a.job)) continue;
    claimed.add(a.job);
    out.push({ who: `agent ${a.agent} (run ${a.run})`, code: a.exit_code ?? null, ...(a.outcome ? { state: a.outcome } : {}), from: `${AGENTS_DIR}/${a.run}/result.json` });
  }
  for (const n of f.natives) {
    const last = n.rec.verdicts.at(-1);
    if (n.rec.started?.job) claimed.add(n.rec.started.job);
    out.push({ who: `${n.rec.job.app} run ${n.run.slice(0, 8)}`, code: last?.exit?.code ?? null, state: last ? `${last.exit?.state ?? 'unknown'}; judged ${last.outcome}` : 'not judged', from: `.timmy/native/${n.run}/job.json` });
  }
  for (const v of f.voxes) {
    for (const t of list(v.value.tools)) {
      const jb = obj(t.job);
      const jid = str(jb?.id);
      if (!jid) continue;
      claimed.add(jid);
      out.push({ who: `VoxVision ${v.id} ${String(t.tool ?? 'tool')} (job ${jid})`, code: num(jb?.exit_code) ?? null, ...(str(jb?.state) ? { state: str(jb?.state) } : {}), from: v.rel });
    }
  }
  for (const j of f.jobs) {
    if (j.kind === 'workflow' || claimed.has(j.id)) continue;
    out.push({ who: `job ${j.id} (${f.scrub(j.label).slice(0, 80)})`, code: j.exitCode ?? null, state: j.state, from: `job ${j.id}` });
  }
  return out;
}

/** The checks: each predicted block against how it ended, each flow's readback against its sealed prediction, each VoxVision
 *  comparison with its source's own report. */
function checksOf(f: Facts, prediction: ReturnType<typeof predictionOf>): RunDetail['checks'] {
  const out: RunDetail['checks'] = [];
  const job = workflowJobs(f).find((x) => x.label === `${prediction?.doc} › ${prediction?.block}`) ?? workflowJobs(f)[0];
  if (prediction?.order) {
    const count = job ? blockCount(job, { order: prediction.order, receipts: blockReceiptsOf(f.chain, job.id) }) : undefined;
    for (const name of prediction.order) {
      const b = count?.blocks.find((x) => x.name === name);
      const word = b?.word ?? 'not seen';
      const actual = b?.code !== undefined ? `exit ${b.code}${word === 'completed' ? '' : ` (${word})`}` : word;
      const differs = b?.code !== undefined ? b.code !== 0 : word === 'waiting' || word === 'running' || word === 'not seen' || word === 'unknown' ? null : true;
      out.push({ name: `block ${name}`, predicted: 'exits 0', actual, differs, from: b?.receipt ? `receipt ${b.receipt}` : job ? `job ${job.id}` : `receipt ${short(prediction.receipt)}` });
    }
  }
  for (const fl of f.flows) {
    const rb = obj(fl.value.readback);
    const checks = list(rb?.checks);
    for (const c of checks) {
      const p = c.predicted;
      const m = c.measured;
      out.push({
        name: `flow ${fl.id} ${String(c.name ?? 'check')}`, predicted: p === undefined || p === null ? null : typeof p === 'number' ? mm(p) : JSON.stringify(p),
        actual: typeof m === 'number' ? mm(m) : m === undefined ? 'not measured' : JSON.stringify(m), differs: typeof c.passed === 'boolean' ? !c.passed : null, from: fl.rel,
      });
    }
    const verdict = str(rb?.verdict);
    if (!checks.length && verdict) out.push({ name: `flow ${fl.id} readback`, predicted: 'matches the sealed prediction', actual: verdict, differs: verdict !== 'matches', from: fl.rel });
    if (String(fl.value.outcome) === NO_CHANGE) {
      const lb = obj(fl.value.last_build);
      out.push({ name: `flow ${fl.id} last build`, predicted: null, actual: `${String(lb?.state ?? 'not recorded')}${str(lb?.words) ? `: ${f.scrub(str(lb?.words)!)}` : ''}`, differs: null, from: fl.rel });
    }
  }
  for (const v of f.voxes) {
    for (const c of list(v.value.checks)) {
      for (const x of list(c.compared)) {
        out.push({ name: `VoxVision ${v.id} ${String(x.what ?? x.metric ?? 'value')}`, predicted: x.reported === undefined ? null : String(x.reported), actual: x.measured === undefined ? 'not measured' : String(x.measured), differs: typeof x.within === 'boolean' ? !x.within : null, from: v.rel });
      }
    }
  }
  return out;
}

/** A file's role by what its record calls it and its kind. */
function roleOfFile(role: string, rel: string): RunFileRole {
  if (/record|result$/.test(role)) return 'record';
  if (/log|transcript/.test(role)) return 'log';
  if (/^editable/.test(role) || /\.(blend|FCStd|aep|ai|c4d|uproject|umap|hip)$/i.test(rel)) return 'native';
  if (/render|preview|highlight/.test(role) || /\.(png|jpe?g|webp|svg|mp4|mov|gif)$/i.test(rel)) return 'preview';
  if (/parameters|source/.test(role)) return 'source';
  return 'output';
}

function filesOf(f: Facts, prediction: ReturnType<typeof predictionOf>): RunDetail['files'] {
  const out: RunDetail['files'] = [];
  const seen = new Set<string>();
  const add = (p: string, role: RunFileRole, from: string, sha256?: string): void => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ path: p, role, ...(sha256 && SHA.test(sha256) ? { sha256 } : {}), from });
  };
  if (prediction?.doc) add(prediction.doc, 'input', `receipt ${short(prediction.receipt)}`, prediction.docSha);
  for (const j of workflowJobs(f)) {
    const copy = j.args.find((a) => path.basename(a) === CHECKED_COPY && /^w[0-9a-f]{8}$/.test(path.basename(path.dirname(a))));
    if (copy) add(tildePath(copy, f.env), 'input', `job ${j.id}`, prediction?.docSha);
  }
  for (const fl of f.flows) {
    const v = fl.value;
    add(fl.rel, 'record', fl.check ? `receipt ${fl.check}` : fl.rel, fl.sha256);
    const before = obj(obj(v.parameters)?.before);
    const pathOf = str(obj(v.parameters)?.path) ?? str(obj(v.script)?.path);
    // The editable source: its bytes after the change where the flow changed it, else as it started from them.
    const after = obj(obj(v.parameters)?.after) ?? obj(obj(v.script)?.after);
    if (pathOf) add(pathOf, 'source', fl.rel, str(after?.sha256) ?? str(before?.sha256) ?? str(obj(obj(v.script)?.before)?.sha256));
    for (const o of flowOutputs(v)) add(o.path, roleOfFile(o.role, o.path), fl.rel, o.sha256);
    if (String(v.outcome) === NO_CHANGE) {
      // The last build its check found as recorded: not made by this run (it made no change), so a reference, not an output.
      const lb = obj(v.last_build);
      for (const c of list(lb?.checks)) {
        const w = str(c.what);
        const p = w?.startsWith('its export ') ? w.slice('its export '.length) : w;
        if (relOk(p) && c.same === true && str(c.recorded) && /\.[A-Za-z0-9]+$/.test(p) && !/ /.test(p)) add(p, 'reference', fl.rel, str(c.recorded));
      }
    }
    let room: ReturnType<typeof roomFlowOutputs> = [];
    try { room = roomFlowOutputs(v, fl.rel); } catch { room = []; }
    for (const o of room) add(o.path, roleOfFile(o.role, o.path), fl.rel);
  }
  for (const r of f.running) add(r.rel, 'record', r.rel);
  for (const v of f.voxes) {
    for (const i of list(v.value.inputs)) if (relOk(i.path)) add(i.path, 'input', v.rel, str(i.sha256));
    add(v.rel, 'record', v.check ? `receipt ${v.check}` : v.rel, v.sha256);
    for (const h of list(v.value.highlights)) if (relOk(h.path)) add(h.path, 'preview', v.rel, str(h.sha256));
    for (const t of list(v.value.tools)) { const raw = obj(t.raw); if (relOk(raw?.path)) add(String(raw!.path), 'log', v.rel, str(raw?.sha256)); }
  }
  for (const a of f.agents) {
    add(`${AGENTS_DIR}/${a.run}/result.json`, 'record', `${AGENTS_DIR}/${a.run}/result.json`);
    if (relOk(a.transcript)) add(a.transcript, 'log', `${AGENTS_DIR}/${a.run}/result.json`);
  }
  for (const n of f.natives) {
    const rec = `.timmy/native/${n.run}/job.json`;
    add(rec, 'record', rec);
    for (const x of n.rec.verdicts.at(-1)?.files ?? []) {
      const p = str((x as { path?: unknown }).path);
      if (relOk(p) && (x as { present?: boolean }).present && (x as { written?: boolean }).written) add(p, roleOfFile('', p), rec, str((x as { sha256?: unknown }).sha256));
    }
  }
  for (const l of f.lessons) add(l.rel, 'record', l.rel);
  for (const j of f.jobs) add(tildePath(j.logPath, f.env), 'log', `job ${j.id}`);
  if (f.rec) add(f.rec.rel, 'record', f.rec.rel);
  if (fs.existsSync(path.join(f.root, summaryRel(f.id)))) add(summaryRel(f.id), 'record', summaryRel(f.id));
  return out;
}

/**
 * Whether what it made is still as it was made, from its inputs: each project file its records name with a sha256 (what it
 * made, its editable source, the last build a run that made no change checked, what it ran from) against the bytes there
 * now; a run that made no change, as its own check found the last build. Stale when any of them is gone or changed since (or
 * its check found the last build stale); current when they have the bytes recorded; unknown, with why, when nothing it made
 * or checked is named with a sha256.
 */
function freshnessOf(f: Facts, files: RunDetail['files']): RunDetail['freshness'] {
  const local = (x: RunDetail['files'][number]): boolean => !!x.sha256 && !x.path.startsWith('~') && !path.isAbsolute(x.path);
  const made = files.filter((x) => local(x) && (x.role === 'output' || x.role === 'native' || x.role === 'source' || x.role === 'preview' || x.role === 'reference'));
  const inputs = files.filter((x) => local(x) && x.role === 'input');
  const now = new Map([...made, ...inputs].map((x) => [x.path, shaNow(f.root, x.path)]));
  for (const x of [...made, ...inputs]) {
    const n = now.get(x.path);
    const what = x.role === 'input' ? `${x.path} (what it ran from)` : x.path;
    if (n === null) return { state: 'stale', why: `${what} is gone since the run (it was sha256 ${x.sha256!.slice(0, 12)})`, from: x.from };
    if (typeof n === 'string' && n !== 'large' && n !== x.sha256) return { state: 'stale', why: `${what} changed since the run: sha256 ${n.slice(0, 12)} now, ${x.sha256!.slice(0, 12)} as recorded`, from: x.from };
  }
  const noChange = f.flows.find((fl) => String(fl.value.outcome) === NO_CHANGE);
  const lb = noChange ? obj(noChange.value.last_build) : undefined;
  const checked = (state: string): string => `it made no change; its check${str(lb?.checked_at) ? ` (${String(lb!.checked_at)})` : ''} found the last build ${state}${str(lb?.words) ? `: ${f.scrub(str(lb?.words)!)}` : ''}`;
  // A last build its own check found stale stays stale: its inputs changed since it was built, whatever its exports' bytes.
  if (noChange && str(lb?.state) === 'stale') return { state: 'stale', why: checked('stale'), from: noChange.rel };
  const read = made.filter((x) => { const n = now.get(x.path); return typeof n === 'string' && n !== 'large'; });
  const files_ = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
  const unread = made.length - read.length;
  const also = `${inputs.length ? `; what it ran from (${inputs.map((x) => x.path).join(', ')}) is as recorded too` : ''}${unread ? `; ${unread} could not be read now` : ''}`;
  if (noChange && str(lb?.state) === 'current') {
    return { state: 'current', why: `${checked('current')}${read.length ? `; the ${files_(read.length)} its records name with a sha256 ${read.length === 1 ? 'has' : 'have'} those bytes now` : ''}${also}`, from: noChange.rel };
  }
  if (read.length) {
    return { state: 'current', why: `the ${files_(read.length)} its records name with a sha256 (what it made, and its source) ${read.length === 1 ? 'has' : 'have'} the bytes recorded${also}`, from: read[0].from };
  }
  if (made.length) return { state: 'unknown', why: `none of the ${made.length} files its records name could be read now (${made[0].path} first)` };
  if (inputs.length) {
    return { state: 'unknown', why: `no file it made is named with a sha256, so whether its result is still as it was made cannot be checked; what it ran from (${inputs.map((x) => x.path).join(', ')}) is as recorded`, from: inputs[0].from };
  }
  return { state: 'unknown', why: 'no record of this operation names a file with its sha256, so whether its result is still as it was made cannot be checked' };
}

/** The model, harness and environment its records name. */
function workerOf(f: Facts): RunDetail['worker'] {
  const w: RunDetail['worker'] = {};
  const models: Array<Sourced<string>> = [];
  const harness: Array<Sourced<string>> = [];
  for (const fl of f.flows) {
    const a = obj(fl.value.agent);
    if (str(a?.model)) models.push({ value: String(a!.model), from: fl.rel });
    if (str(a?.agent)) harness.push({ value: `${String(a!.agent)}${str(a?.version) ? ` ${String(a!.version)}` : ''} (${String(a?.route ?? a?.where ?? 'route not recorded')})`, from: fl.rel });
  }
  for (const a of f.agents) {
    if (a.model) models.push({ value: a.model, from: `${AGENTS_DIR}/${a.run}/result.json` });
    harness.push({ value: `${a.agent}${a.agent_version ? ` ${a.agent_version}` : ''} (${a.endpoint} endpoint)`, from: `${AGENTS_DIR}/${a.run}/result.json` });
  }
  for (const n of f.natives) harness.push({ value: n.rec.job.app, from: `.timmy/native/${n.run}/job.json` });
  // R4 lead: a chat turn of the operation (any surface's: src/repl/seal.ts chatTurnOf): the model that answered (else the one
  // asked for) and the surface it was sent from, on the chat's route (OpenRouter, or the local route through Ollama)
  for (const r of f.receipts) {
    const turn = chatTurnOf(r);
    if (!turn) continue;
    const model = str(r.model_resolved) ?? str(r.model_requested);
    if (model) models.push({ value: model, from: `receipt ${short(r)}` });
    harness.push({ value: `${TURN_FROM[turn.surface]} chat, ${r.via === 'ollama' ? 'the local route through Ollama' : 'the OpenRouter route'}`, from: `receipt ${short(r)}` });
  }
  for (const v of f.voxes) for (const t of list(v.value.tools)) if (str(t.name)) harness.push({ value: `${String(t.name)}${str(t.version) ? ` ${String(t.version)}` : ''}`, from: v.rel });
  if (workflowJobs(f).length) harness.unshift({ value: `upmd${workflowJobs(f).some((j) => isLiveRun(j.args)) ? ' on a pty (workers/upmd/pty_run.py)' : ''}`, from: `job ${workflowJobs(f)[0].id}` });
  const uniq = (xs: Array<Sourced<string>>): Array<Sourced<string>> => xs.filter((x, i) => xs.findIndex((y) => y.value === x.value) === i);
  const m = uniq(models);
  if (m.length) w.model = { value: m.map((x) => x.value).join('; '), from: m[0].from };
  else f.unknown.push({ field: 'worker.model', why: 'no record of this operation names a model (no code agent or model ran in it, or its record does not say which)' });
  const h = uniq(harness);
  if (h.length) w.harness = { value: h.map((x) => x.value).join('; '), from: h[0].from };
  const lock = f.receipts.map((r) => obj((r as unknown as Obj).env_lock)).find((x) => x && obj(x.os));
  if (lock) {
    const os = obj(lock.os)!;
    w.environment = { value: `${String(os.platform ?? '?')} ${String(os.version ?? os.build ?? '')}`.trim() + ` ${String(lock.arch ?? '')}`.trimEnd(), from: `receipt ${short(f.receipts.find((r) => obj((r as unknown as Obj).env_lock) === lock)!)}` };
  } else f.unknown.push({ field: 'worker.environment', why: 'no receipt of this operation records its environment (env_lock)' });
  return w;
}

function timeOf(f: Facts): RunDetail['time'] {
  const rec = f.rec?.record;
  const starts = [rec?.started, ...f.jobs.map((j) => j.startedAt), ...f.receipts.map((r) => r.ts)].map(time).filter((x): x is number => x !== undefined);
  const startedAt = rec?.started ?? (starts.length ? new Date(Math.min(...starts)).toISOString() : null);
  let endedAt: string | null = rec ? rec.ended : null;
  if (!rec) {
    const ends = f.jobs.map((j) => time(j.endedAt)).filter((x): x is number => x !== undefined);
    const live = f.jobs.some((j) => !j.endedAt) || f.running.length > 0;
    endedAt = !live && ends.length ? new Date(Math.max(...ends)).toISOString() : null;
  }
  const a = time(startedAt);
  const b = endedAt ? time(endedAt) : f.now.getTime();
  return { startedAt, endedAt, elapsedMs: a !== undefined && b !== undefined && b >= a ? b - a : null };
}

/** The cost: what each run that asks a model or a priced service reported (code agents, a model's interpretation, a chat
 *  turn), summed when every one reported a number; unknown, with why, otherwise. Never an invented 0. */
function costOf(f: Facts): RunDetail['cost'] {
  const parts: Array<{ usd: number | null; from: string; what: string }> = [];
  const agentRuns = new Set(f.agents.map((a) => a.run));
  for (const a of f.agents) {
    if (a.cost_usd === undefined) parts.push({ usd: null, from: `${AGENTS_DIR}/${a.run}/result.json`, what: `agent run ${a.run} records no cost` });
    else parts.push({ usd: a.cost_usd, from: `${AGENTS_DIR}/${a.run}/result.json`, what: `agent run ${a.run}${a.cost_usd === null ? ' made a request and no cost came back' : a.cost_basis ? ` (${a.cost_basis})` : ''}` });
  }
  for (const fl of f.flows) {
    const a = obj(fl.value.agent);
    if (!a || (str(a.run) && agentRuns.has(String(a.run)))) continue;
    const c = a.cost_usd;
    parts.push({ usd: typeof c === 'number' ? c : null, from: fl.rel, what: `flow ${fl.id}'s agent ${typeof c === 'number' ? `(${String(a.cost_basis ?? 'as its record says')})` : c === null ? 'made a request and no cost came back' : 'records no cost'}` });
  }
  for (const r of f.receipts) {
    const o = obj(obj((r as unknown as Obj).observation)?.interpretation);
    if (o && ('cost_usd' in o)) parts.push({ usd: typeof o.cost_usd === 'number' ? o.cost_usd : null, from: `receipt ${short(r)}`, what: `a model's interpretation (receipt ${short(r)})` });
    // R4 lead: every surface's chat turn (the REPL's, the Workbench's, a monitor's, a companion page's)
    const turn = chatTurnOf(r);
    if (turn) parts.push({ usd: r.cost_measured === false || typeof r.cost_usd !== 'number' ? null : r.cost_usd, from: `receipt ${short(r)}`, what: `a chat turn${turn.surface === 'repl' ? '' : ` from ${TURN_FROM[turn.surface]}`} (receipt ${short(r)})` });
  }
  if (!parts.length) return { usd: null, measured: false, why: 'no record of this operation reports a request to a model or another priced service, so no cost is recorded (none is invented)' };
  const missing = parts.find((p) => p.usd === null);
  if (missing) return { usd: null, measured: false, why: `unknown: ${missing.what}` };
  const usd = parts.reduce((s, p) => s + (p.usd as number), 0);
  return { usd: Number(usd.toFixed(6)), measured: true, from: parts.map((p) => p.from).filter((x, i, a) => a.indexOf(x) === i).join('; ') };
}

/** One practical next action, from the verdict and what the records name. */
function nextOf(f: Facts, d: Pick<RunDetail, 'verdict' | 'files' | 'freshness'>, prediction: ReturnType<typeof predictionOf>): RunDetail['next'] {
  const again = prediction?.doc && prediction.block ? `/run ${prediction.doc} ${prediction.block}` : f.rec?.record.request ? f.scrub(f.rec.record.request) : undefined;
  const job = workflowJobs(f)[0] ?? f.jobs[0];
  switch (d.verdict.state) {
    case 'queued':
    case 'running':
    case 'cancelling':
      return job ? { words: `follow it; /stop ${job.id} stops it`, command: `/jobs ${job.id}` } : f.running[0] ? { words: `follow it; /stop ${f.running[0].id} stops it`, command: `/room ${f.running[0].id}` } : { words: 'follow it in the Control Room', command: '/room' };
    case 'needs you':
      return d.verdict.words.startsWith('needs you: ')
        ? { words: 'answer its NEEDS YOU box in the REPL: y runs it once; n, Esc or Enter deny it' }
        : { words: `do what its refusal names, then ask again: ${d.verdict.words.replace(/^refused: /, '')}`, ...(again ? { command: again } : {}) };
    case 'no change': {
      const fl = f.flows.find((x) => String(x.value.outcome) === NO_CHANGE);
      const lb = fl ? obj(fl.value.last_build) : undefined;
      if (str(lb?.state) === 'stale' || d.freshness.state === 'stale') {
        const rebuild = /(\/recipe tray|\/scad \S+|\/freecad \S+|\/blender \S+)/.exec(String(lb?.words ?? ''))?.[1];
        return { words: 'nothing was changed, and the last build no longer matches its inputs: rebuild it', ...(rebuild ? { command: rebuild } : {}) };
      }
      return { words: `nothing was changed: edit the request${prediction?.doc ? ` in ${prediction.doc}` : ''}, then run it again`, ...(again ? { command: again } : {}) };
    }
    case 'completed': {
      const out = d.files.find((x) => x.role === 'output' || x.role === 'native') ?? d.files.find((x) => x.role === 'preview');
      if (out) return { words: `review its result: ${out.path}`, command: /\.(step|stp)$/i.test(out.path) ? `/inspect ${out.path}` : /\.stl$/i.test(out.path) ? `/measure ${out.path}` : `/open ${out.path}` };
      return { words: 'review what it did', command: `/op ${f.id}` };
    }
    case 'failed': {
      const fl = f.flows.find((x) => !['succeeded', NO_CHANGE].includes(String(x.value.outcome)));
      if (fl) return { words: `see why flow ${fl.id} ${String(fl.value.outcome)}: its steps and logs`, command: `/room ${fl.id}` };
      return job ? { words: `see why: its blocks and log`, command: `/jobs ${job.id}` } : { words: 'see why', command: `/op ${f.id}` };
    }
    case 'cancelled':
      return { words: 'it was stopped: run it again when you want it', ...(again ? { command: again } : {}) };
    case 'recovered':
      return { words: 'it was interrupted when the Timmy running it ended, and recovery recorded it: run it again', ...(again ? { command: again } : {}) };
    default:
      return d.verdict.words.startsWith('left running') ? { words: 'record how its runs ended', command: '/recover' } : { words: 'look at its records', command: `/op ${f.id}` };
  }
}

// ── the run detail ────────────────────────────────────────────────────────────

/** One operation's run detail, or why there is none (never thrown). Reads only. */
export function readRunDetail(operationId: string, o: RunDetailOptions = {}): RunDetailResult {
  const g = gather(operationId.trim(), o);
  if ('ok' in g) return g;
  const f: Facts = o.waiting ? { ...g, waiting: o.waiting } : g;
  const rec = f.rec?.record;
  const prediction = predictionOf(f);
  const stage = stageOf(f, prediction);
  const verdict = verdictOf(f, stage);
  const files = filesOf(f, prediction);
  const freshness = freshnessOf(f, files);
  const worker = workerOf(f);
  const time = timeOf(f);
  // the request's own words
  let objective: RunDetail['objective'] = rec ? { value: f.scrub(rec.request), from: f.rec!.rel } : null;
  if (!objective) {
    const fl = f.flows.find((x) => str(x.value.instruction));
    const wj = workflowJobs(f)[0];
    if (fl) objective = { value: f.scrub(String(fl.value.instruction)), from: fl.rel };
    else if (wj) objective = { value: `/run ${f.scrub(wj.label).replace(' › ', ' ')}`, from: `job ${wj.id}` };
    else f.unknown.push({ field: 'objective', why: 'no record of this operation here keeps its request (its record is not in this project)' });
  }
  // the source revision the run started from: the recipe's bytes as sealed before it ran, or the editable source's before a change
  let sourceRevision: RunDetail['sourceRevision'] = null;
  // R4 lead: a fleet run's prediction receipt names its plan, and the plan records the git revision it was made at
  const fleetPredict = f.receipts.find((r) => r.kind === 'fleet.predict' && typeof (r as unknown as { fleet?: { plan?: unknown } }).fleet?.plan === 'string');
  const fleetPlanId = fleetPredict ? String((fleetPredict as unknown as { fleet: { plan: string } }).fleet.plan) : undefined;
  const fleetPlan = fleetPlanId && /^f[0-9a-f]{8}$/.test(fleetPlanId) ? readProjectRecord(f.root, `.timmy/fleet/${fleetPlanId}/plan.json`) : undefined;
  const fleetProject = fleetPlan?.ok ? obj(obj(fleetPlan.value)?.project) : undefined;
  if (fleetPlanId && str(fleetProject?.revision)) sourceRevision = { value: `git ${str(fleetProject?.revision)}${fleetProject?.dirty === true ? ' with uncommitted changes' : ''} (the revision the fleet plan was made at)`, from: `.timmy/fleet/${fleetPlanId}/plan.json` };
  else if (prediction?.doc && prediction.docSha) sourceRevision = { value: `${prediction.doc} sha256:${prediction.docSha} (the document the prediction sealed before upmd ran; no git revision is recorded)`, from: `receipt ${short(prediction.receipt)}` };
  else {
    const fl = f.flows.find((x) => str(obj(obj(x.value.parameters)?.before)?.sha256) || str(obj(obj(x.value.script)?.before)?.sha256));
    if (fl) {
      const part = obj(fl.value.parameters) ?? obj(fl.value.script)!;
      sourceRevision = { value: `${String(part.path ?? '?')} sha256:${String(obj(part.before)?.sha256)} (before the change; no git revision is recorded)`, from: fl.rel };
    } else f.unknown.push({ field: 'sourceRevision', why: 'no record of this operation names a revision of the project or of a document it started from (Timmy records no git revision for a run)' });
  }
  const checks = checksOf(f, prediction);
  const receipts = f.receipts.map((r) => ({ id: short(r), kind: r.kind, ...(r.subject ? { subject: f.scrub(String(r.subject)) } : {}) }));
  const cost = costOf(f);
  let predictionOut: RunDetail['prediction'] = null;
  if (prediction?.order) {
    const p = obj((prediction.receipt as unknown as Obj).prediction);
    const risky = list(p?.risky).map((x) => String(x.name ?? '?'));
    predictionOut = {
      words: `/run ${prediction.doc} ${prediction.block}: ${prediction.order.join(' → ')}, each block exits 0${risky.length ? `; asked first in a NEEDS YOU box: ${risky.join(', ')}` : ''}`,
      receipt: short(prediction.receipt), frozenAt: prediction.receipt.ts ?? null,
    };
  } else if (prediction?.geometry) {
    predictionOut = { words: `the recipe's prediction: ${prediction.geometry.bounds.map(mm).join(' × ')} mm, ${mm(prediction.geometry.volume)} mm³`, receipt: short(prediction.receipt), frozenAt: prediction.receipt.ts ?? null };
  } else if (fleetPredict) {
    predictionOut = { words: f.scrub(String(fleetPredict.subject ?? `fleet ${fleetPlanId}`)), receipt: short(fleetPredict), frozenAt: fleetPredict.ts ?? null };
  } else f.unknown.push({ field: 'prediction', why: 'no prediction receipt of this operation: it ran no workflow and no recipe build (nothing was predicted before it ran)' });
  if (time.endedAt === null && verdict.state !== 'running' && verdict.state !== 'queued' && verdict.state !== 'needs you') f.unknown.push({ field: 'time.endedAt', why: 'its records do not say when it ended' });
  for (const u of f.unreadable) f.unknown.push({ field: 'records', why: `${u.rel} could not be read (${u.why}): whether it is this operation's is not known` });
  const summary = fs.existsSync(path.join(f.root, summaryRel(f.id))) ? summaryRel(f.id) : null;
  const detail: RunDetail = {
    version: RUN_DETAIL_VERSION, operation: f.id, parent: rec?.parent ?? null, children: childrenOf(f),
    project: { name: rec?.project ?? f.name, root: f.root, id: f.pid },
    objective, sourceRevision, verdict, stage, exits: exitsOf(f, prediction), freshness,
    acceptance: { state: 'not reviewed' },
    worker, time, prediction: predictionOut, checks, files, receipts, cost, summary: { path: summary },
    next: null, unknown: f.unknown,
  };
  detail.next = nextOf(f, detail, prediction);
  return { ok: true, detail };
}

/** The operations whose record names this one as its parent, by their start then id (each one's own record says so). */
function childrenOf(f: Facts): string[] {
  const all = listOperationRecords(f.root, 100_000).list.filter((r) => r.record.parent === f.id);
  return all.sort((a, b) => (time(a.record.started) ?? 0) - (time(b.record.started) ?? 0) || a.record.id.localeCompare(b.record.id)).map((r) => r.record.id);
}

/** One operation's run detail; throws RunDetailError (its refusal and why) when there is none. */
export function runDetail(operationId: string, o: RunDetailOptions = {}): RunDetail {
  const r = readRunDetail(operationId, o);
  if (!r.ok) throw new RunDetailError(r.refusal, r.why, r.elsewhere);
  return r.detail;
}

// ── the recipe as it ran ──────────────────────────────────────────────────────

/**
 * The run's own recipe, as upmd read it: the blocks of the order its prediction sealed, from the private copy /run kept for
 * upmd (<jobs folder>/runs/w<8 hex>/checked.md, named by the run's job) while it still holds the bytes the prediction sealed,
 * else from the document in the project while it does. Undefined, with why, when neither holds them now.
 */
export function runRecipe(d: RunDetail, o: { jobs?: readonly JobRecord[]; jobsDir?: string } = {}): { blocks: WorkflowBlock[]; doc: string; target: string; from: string } | { why: string } {
  const p = d.prediction;
  const doc = d.files.find((x) => x.role === 'input' && !x.path.startsWith('~') && x.from === `receipt ${p?.receipt}`);
  const m = p ? /^\/run (\S+) (\S+):/.exec(p.words) : null;
  if (!p || !m || !doc?.sha256) return { why: 'it ran no workflow whose prediction sealed its document' };
  const [, rel, target] = m;
  const jobs = o.jobs ?? jobsIn(o.jobsDir ?? path.join(timmyHome(), 'jobs'));
  const candidates: Array<{ abs: string; from: string }> = [];
  for (const j of jobs.filter((x) => x.operation === d.operation && x.kind === 'workflow')) {
    const copy = j.args.find((a) => path.basename(a) === CHECKED_COPY && /^w[0-9a-f]{8}$/.test(path.basename(path.dirname(a))));
    if (copy) candidates.push({ abs: copy, from: `the copy upmd read (job ${j.id})` });
  }
  candidates.push({ abs: path.join(d.project.root, rel), from: `${rel} in the project` });
  for (const c of candidates) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(c.abs); } catch { continue; }
    if (sha(bytes) !== doc.sha256) continue;
    const blocks = parseWorkflow(bytes.toString('utf8'));
    const plan = runOrder(blocks, target);
    const chosen = plan.order.map((n) => blocks.find((b) => b.name === n)).filter((b): b is WorkflowBlock => !!b);
    return { blocks: chosen, doc: rel, target, from: `${c.from}, its sha256 the one prediction receipt ${p.receipt} sealed` };
  }
  return { why: `${rel} no longer holds the bytes prediction receipt ${p.receipt} sealed (sha256 ${doc.sha256.slice(0, 12)}), and the copy upmd read is not kept here` };
}

// ── the executive summary ─────────────────────────────────────────────────────

const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const dur = (ms: number | null): string => (ms === null ? 'unknown' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
/** A fence longer than any run of backticks in the code, so a block holding a fence stays one block. */
const fenceFor = (code: string): string => '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((x) => x[0].length + 1)));

/**
 * The executive summary of a run, in Markdown, made from its run detail alone (no model is asked): the objective, Timmy's
 * verdict beside the stage, each exit, the freshness and the acceptance kept apart; the frozen prediction beside each check;
 * the files, worker, cost, receipts and next action; and the run's own recipe as it ran, each block a fenced block naming it
 * (upmd reads it: a heading per part, `bash [name:…]` per block). The same detail always gives the same text.
 */
export function runSummaryMarkdown(d: RunDetail, recipe?: ReturnType<typeof runRecipe>): string {
  const L: string[] = [];
  const objective = d.objective?.value ?? 'not recorded';
  L.push(`# Run ${d.operation}: ${d.verdict.state}`, '');
  L.push(`Objective: ${objective}`, '');
  L.push(`Project: ${d.project.name} (project id ${d.project.id})${d.parent ? ` · continues ${d.parent}` : ''}${d.children.length ? ` · continued by ${d.children.join(', ')}` : ''}`, '');
  L.push(`Started ${d.time.startedAt ?? 'unknown'} · ended ${d.time.endedAt ?? (d.verdict.state === 'running' ? 'not yet' : 'unknown')} · ${d.time.endedAt ? 'took' : 'elapsed'} ${dur(d.time.elapsedMs)}`, '');
  if (d.sourceRevision) L.push(`Source: ${d.sourceRevision.value} (${d.sourceRevision.from})`, '');
  L.push('## Outcome', '');
  L.push(`- Timmy's verdict: ${d.verdict.state}. ${d.verdict.words} (${d.verdict.from})`);
  L.push(`- Stage: ${d.stage.total === null ? `${d.stage.done} steps ended (the planned count is not recorded)` : `${d.stage.done} of ${d.stage.total} steps ended`}${d.stage.current ? `; now ${d.stage.current}` : ''} (${d.stage.from})`);
  L.push(`- Exits: ${d.exits.length ? d.exits.map((e) => `${e.who} ${e.code === null ? 'no exit code' : `exit ${e.code}`}${e.state ? ` (${e.state})` : ''}`).join('; ') : 'none recorded'}`);
  L.push(`- Freshness: ${d.freshness.state}: ${d.freshness.why}`);
  L.push(`- Acceptance: ${d.acceptance.state}${d.acceptance.by ? ` by ${d.acceptance.by}` : ''}`);
  L.push('');
  L.push('## Prediction and checks', '');
  L.push(d.prediction ? `Predicted before the run, frozen at ${d.prediction.frozenAt ?? 'an unrecorded time'} (receipt ${d.prediction.receipt}): ${d.prediction.words}.` : 'Nothing was predicted before it ran.', '');
  if (d.checks.length) {
    L.push('| Check | Predicted | Actual | Differs | From |', '|---|---|---|---|---|');
    for (const c of d.checks) L.push(`| ${cell(c.name)} | ${cell(c.predicted ?? 'not predicted')} | ${cell(c.actual)} | ${c.differs === null ? 'not known' : c.differs ? 'yes' : 'no'} | ${cell(c.from)} |`);
  } else L.push('No check of it is recorded.');
  L.push('');
  L.push('## Files', '');
  // The summary itself is not one of its own rows: the text made again after it is kept is the text kept.
  const files = d.files.filter((x) => x.path !== summaryRel(d.operation));
  if (files.length) {
    L.push('| Path | Role | sha256 | From |', '|---|---|---|---|');
    for (const x of files) L.push(`| ${cell(x.path)} | ${x.role} | ${x.sha256 ? x.sha256.slice(0, 12) : ''} | ${cell(x.from)} |`);
  } else L.push('No file of it is recorded.');
  L.push('');
  L.push('## Worker and cost', '');
  L.push(`- Model: ${d.worker.model ? `${d.worker.model.value} (${d.worker.model.from})` : 'not recorded'}`);
  L.push(`- Harness: ${d.worker.harness ? `${d.worker.harness.value} (${d.worker.harness.from})` : 'not recorded'}`);
  L.push(`- Environment: ${d.worker.environment ? `${d.worker.environment.value} (${d.worker.environment.from})` : 'not recorded'}`);
  L.push(`- Cost: ${d.cost.measured ? `$${d.cost.usd.toFixed(4)} as reported (${d.cost.from})` : `unknown: ${d.cost.why}`}`);
  L.push('');
  L.push('## Receipts', '');
  L.push(d.receipts.length ? d.receipts.map((r) => `- ${r.id} ${r.kind}${r.subject ? `: ${r.subject}` : ''}`).join('\n') : 'No receipt names it.', '');
  L.push('## Next', '');
  L.push(d.next ? `${d.next.words}${d.next.command ? `: \`${d.next.command}\`` : ''}` : 'Nothing to do.', '');
  if (d.unknown.length) {
    L.push('## Not recorded', '');
    for (const u of d.unknown) L.push(`- ${u.field}: ${u.why}`);
    L.push('');
  }
  L.push('## Recipe', '');
  if (recipe && 'blocks' in recipe && recipe.blocks.length) {
    L.push(`The run's own recipe, ${recipe.doc} › ${recipe.target}, as upmd read it (${recipe.from}). Running it again is \`/run ${recipe.doc} ${recipe.target}\`: Timmy reads the document as it is then, predicts and asks again; these blocks are this run's record.`, '');
    for (const b of recipe.blocks) {
      const fence = fenceFor(b.code);
      L.push(`${fence}${b.lang ?? 'bash'} [name:${b.name}${b.deps.length ? `, deps:${b.deps.join(', ')}` : ''}]`, b.code, fence, '');
    }
  } else {
    L.push(`${recipe && 'why' in recipe ? `The recipe as it ran is not shown: ${recipe.why}.` : 'It ran no workflow recipe.'}${d.objective ? ` Its request was: \`${d.objective.value.replace(/`/g, '\'')}\`` : ''}`, '');
  }
  return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * Keeps a run's executive summary beside its records (summaryRel: .timmy/operations/<id>/summary.md), never over a file
 * already there and never through a link: its path, or why it was not written.
 */
export function writeRunSummary(root: string, id: string, markdown: string): { ok: true; rel: string; sha256: string } | { ok: false; rel: string; why: string } {
  const rel = summaryRel(id);
  if (!OPERATION_ID.test(id)) return { ok: false, rel, why: `${id} is not an operation id` };
  let real: string;
  try { real = fs.realpathSync(root); } catch { return { ok: false, rel, why: 'the project folder is gone' }; }
  let at = real;
  const parts = rel.split('/');
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part);
    try {
      const st = fs.lstatSync(at);
      if (st.isSymbolicLink()) return { ok: false, rel, why: `${path.relative(real, at)} is a symbolic link; Timmy writes beside its records only in place` };
      if (!st.isDirectory()) return { ok: false, rel, why: `${path.relative(real, at)} is not a folder` };
    } catch {
      try { fs.mkdirSync(at); } catch (e) { return { ok: false, rel, why: `${path.relative(real, at)} could not be made (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
    }
  }
  const dest = path.join(real, rel);
  try { fs.lstatSync(dest); return { ok: false, rel, why: `${rel} is already there; a kept summary is never written over` }; } catch { /* free */ }
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, markdown, { flag: 'wx', mode: 0o644 });
    const how = placeNew(tmp, dest);
    if (how === 'linked') fs.unlinkSync(tmp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, rel, why: code === 'EEXIST' ? `${rel} is already there; a kept summary is never written over` : `${rel} could not be written (${code ?? 'error'})` };
  }
  return { ok: true, rel, sha256: sha(markdown) };
}

/** The JSON `timmy op --json` prints: the run detail with its schema. */
export const runDetailJson = (d: RunDetail): Obj => ({ schema: RUN_DETAIL_SCHEMA, ...d });
