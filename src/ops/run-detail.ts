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
import { projectId, projectsHome, resolveInside, sameFolder } from '../project/index.js';
import { flowHandoff } from '../room/index.js';
import { flowOutputs as roomFlowOutputs } from '../room/index.js';
import { timmyHome } from '../utils/init.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { placeNew } from '../utils/place-new.js';
import { readChain, verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { chatTurnOf, TURN_FROM } from '../repl/seal.js';
import { operationReview, visible, type ChangeHow, type ReviewChange } from '../review/changes.js';
import { blockReceiptsOf, codeSha256 } from '../workflows/block-receipts.js';
import { blockCount } from '../workflows/block-count.js';
import { CHECKED_COPY, parseWorkflow, runOrder, type WorkflowBlock } from '../workflows/upmd.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import { buildIndex, flowOutputs, LESSONS_DIR, shaNow } from './card.js';
import { OPERATION_ID } from './context.js';
import { readRecords, runningFlowStates, sealOf, type RecordRead } from './evidence.js';
import { listOperationRecords, OPERATIONS_DIR, readOperationRecord, type OperationRecord, type OperationState } from './operations.js';
import { decideState, type RunOutcome } from './operations.js';
import { flowClaims, flowOutcome, jobOutcome, readProjectRecord, voxOutcome } from './outcome.js';
import { withProcessTable, writerState } from './process-proof.js';

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

function gather(id: string, o: RunDetailOptions): Extract<RunDetailResult, { ok: false }> | Facts {
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
  const b = built(operationId, o);
  return b.ok ? { ok: true, detail: b.detail } : b;
}

/** R6 (H144): the run detail with the facts it was made from (the inspection below reads the same facts once). */
function built(operationId: string, o: RunDetailOptions): { ok: true; f: Facts; detail: RunDetail; prediction: ReturnType<typeof predictionOf> } | Extract<RunDetailResult, { ok: false }> {
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
  return { ok: true, f, detail, prediction };
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
  // each read through one descriptor, never through a link (readHeld): the copy upmd read, then the document in the project
  const candidates: Array<{ read: () => Read; from: string }> = [];
  for (const j of jobs.filter((x) => x.operation === d.operation && x.kind === 'workflow')) {
    const copy = j.args.find((a) => path.basename(a) === CHECKED_COPY && /^w[0-9a-f]{8}$/.test(path.basename(path.dirname(a))));
    if (copy) candidates.push({ read: () => readHeld(folderReal(copy), copy, SOURCE_READ_MAX), from: `the copy upmd read (job ${j.id})` });
  }
  candidates.push({ read: () => readProject(d.project.root, rel, SOURCE_READ_MAX), from: `${rel} in the project` });
  for (const c of candidates) {
    const r = c.read();
    if (!r.ok || r.cut || r.sha256 !== doc.sha256) continue;
    const blocks = parseWorkflow(r.buf.toString('utf8'));
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

// ── the run inspected (R6, H144): its source, its changes, its outputs and its receipts ────────────────────

/*
 * R6 (H144; the operator's order of 2026-10-16, priority 3: "a workflow's source, changes, outputs and receipts"): one
 * operation's run as the companion's run detail and the Workbench's tab 3 show it, made here from Timmy's records, never on
 * a page:
 *   source    the workflow document and its blocks as upmd ran them: the copy /run kept for upmd (its sha256 the one the
 *             prediction sealed), else the document while it still holds those bytes; the document now beside it, and when
 *             it changed since, both hashes and a line diff (as it ran → now)
 *   changes   what the run wrote or changed, as Timmy's records name it (src/review/changes.ts operationReview, /review's own
 *             reading): each with a line diff against its version before the run where Timmy kept one (a flow's copy as
 *             read, an OpenHands before/ copy, the board's saves, /restore's), against nothing for a file the run added, and
 *             none, saying why, where no previous version is kept; an image drawn, a binary as its size and sha256; the
 *             /restore that can be done exactly, or why not
 *   outputs   the run's log (its bytes against the sha256 its receipt sealed) and the files it made, each previewed (text,
 *             JSON laid out, an image, a binary's size and sha256), with whether it still holds the bytes recorded
 *   receipts  intent → predict → run → receipt: each receipt of the operation verified now by Timmy's own verifier
 *             (src/utils/receipts.ts verifyReceiptIn: every link and body hash of its epoch up to it, and its signature),
 *             with what that checked; the operation's record (its intent) is said not to be a receipt
 *   actions   open a file, /review, /restore (where it can be done exactly), the run again: each with its command and what
 *             it does (reads, writes, runs); one of them the primary, from the run detail's next step
 * Nothing here runs, writes or seals. A preview is a reading of the file now, labelled as the bytes the run left only when
 * their sha256 is the one recorded.
 */

export const RUN_INSPECTION_VERSION = 1 as const;
/** The lines a text preview keeps by default (a page scrolls through them; the Workbench asks for fewer). */
export const PREVIEW_LINES = 400;
/** The most of a file a preview reads: a longer text is cut, saying so. */
export const PREVIEW_READ_MAX = 256 * 1024;
/** The most of a run's log read: its end. */
export const LOG_READ_MAX = 128 * 1024;
/** An image the companion's page draws is sent as a data: address up to this size; a larger one is named with its size. */
export const IMAGE_DATA_MAX = 1024 * 1024;
/** The most image bytes one inspection sends as data: addresses. */
const IMAGE_DATA_TOTAL = 4 * 1024 * 1024;
/** A line diff is made of texts up to this size on each side. */
const DIFF_TEXT_MAX = 512 * 1024;
/** Past this many cells (lines × lines of the parts that differ) the middle is counted as replaced whole. */
const DIFF_CELLS = 2_250_000;
/** The most diff lines one diff shows (the rest are counted). */
const DIFF_LINES_MAX = 600;
/** The most one file costs to read here: a larger one is shown from its first (or last) bytes and not hashed. */
const HASH_MAX = 16 * 1024 * 1024;
/** What one inspection reads of files in all to hash them: past it, a file is shown but not hashed (said so). */
const READ_TOTAL = 128 * 1024 * 1024;
/** The most of a workflow document read for its blocks (as it ran, and now). */
const SOURCE_READ_MAX = 2 * 1024 * 1024;
/** How a file is opened to be read: never through a link at its name, never waiting on a pipe. */
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
/** How many changes one inspection lists (src/review/changes.ts counts the rest). */
const CHANGES_MAX = 60;
/** How many outputs one inspection lists. */
const OUTPUTS_MAX = 40;
const LINE_CHARS = 400;

/** A file's content as Timmy can show it now: its text (JSON laid out), an image, or a binary's size and sha256. */
export type FilePreview =
  | { kind: 'text'; lines: string[]; more: number; bytes: number; sha256: string | null; json?: true; jsonWhy?: string; cut?: string }
  | { kind: 'image'; mime: string; bytes: number; sha256: string | null; width?: number; height?: number; data?: string; why?: string }
  | { kind: 'binary'; what: string; bytes: number; sha256: string | null }
  | { kind: 'none'; why: string };

/** A file now against the sha256 a record gives it. */
export interface FileNow {
  state: 'as recorded' | 'changed since' | 'gone' | 'not comparable' | 'not recorded';
  sha256?: string;
  words: string;
}

/** One place a diff changed: its header (`@@ -a,n +b,m @@`) and its lines, the unchanged ones around it as context. */
export interface DiffHunk { header: string; lines: Array<{ op: ' ' | '+' | '-'; text: string }> }
export type InspectDiff =
  | {
    shown: true;
    /** what it is drawn against: the kept previous version, nothing (the run added the file), or the document as it ran */
    against: 'kept' | 'nothing' | 'as ran';
    from: string; to: string; added: number; removed: number; hunks: DiffHunk[];
    /** changed lines not drawn (past DIFF_LINES_MAX) */
    more: number;
    method: string;
  }
  | { shown: false; why: string };

export interface InspectChange {
  /** project-relative */
  path: string;
  how: ChangeHow;
  by: string;
  /** sha256 before (null: not there) and as the run left it (null: deleted); absent: not recorded */
  before?: string | null;
  after?: string | null;
  /** the previous version: kept where, or why it is not */
  kept: { words: string; path?: string; state?: string };
  now: FileNow;
  diff: InspectDiff;
  /** the file now (an image drawn, a binary its size and sha256), said to be the bytes the run left only when they are */
  preview?: FilePreview & { of: string };
  /** the kept previous version of an image, drawn beside it */
  keptPreview?: FilePreview;
  /** its record and the receipt that sealed it, and that receipt's check now (/review's) */
  record?: string;
  receipt?: string;
  check: { status: string; words: string };
  restore: { offered: true; command: string; from: string } | { offered: false; why: string };
  note?: string;
  /** what to type in Timmy's REPL to see it there */
  open: string;
}

export interface InspectOutput {
  /** project-relative, or from ~ for a log in Timmy's jobs folder */
  path: string;
  kind: 'log' | 'file';
  /** what its records call it */
  what: string;
  /** the sha256 (and size) its record gives it, and which record */
  recorded?: { sha256?: string; bytes?: number; from: string };
  now: FileNow;
  preview: FilePreview;
  open?: string;
}

/** A receipt of the operation, verified now. */
export interface InspectReceipt {
  stage: 'predict' | 'run' | 'receipt';
  /** its short id (8 hex of its hash) */
  id: string;
  kind: string;
  subject?: string;
  ts?: string;
  hash: string;
  /** the receipt its prev_hash names (its short id), or 'genesis' (the start of its epoch) */
  prev: string;
  epoch: number;
  /** its place among the receipts of its epoch (1 = the first) */
  position: number;
  signed: boolean;
  /** verifyReceiptIn over the chain as read now: what it checked, or why it does not verify */
  verified: { ok: true; checked: string } | { ok: false; why: string };
}

export interface InspectSource {
  doc: string;
  block: string;
  order: string[];
  /** the sha256 the prediction sealed before upmd ran */
  asRan: { sha256: string | null; from: string };
  /** where its bytes as it ran are read from now */
  copy: { state: 'kept' | 'project' | 'missing' | 'differs'; where?: string; words: string };
  /** the document in the project now */
  now: { state: 'same' | 'changed' | 'gone' | 'unreadable'; sha256?: string; words: string };
  /** the blocks it ran, in order, as they ran: each one's code and its sha256 against the one its block receipt sealed */
  blocks: Array<{
    name: string; lang: string; deps: string[];
    /** the 1-based line of its first line of code in the document */
    firstLine: number;
    code: string[];
    sha256: string;
    sealed?: { receipt: string; sha256: string | null; matches: boolean | null };
    target: boolean;
  }>;
  blocksWhy?: string;
  /** the document as it ran → now, when it changed since */
  diff?: InspectDiff;
}

export interface InspectAction {
  id: 'open' | 'review' | 'restore' | 'run-again' | 'next';
  label: string;
  /** what to type in Timmy's REPL */
  command: string;
  /** what it does: reads (nothing written), writes (a project file), runs (starts a run) */
  effect: 'reads' | 'writes' | 'runs';
  words: string;
  path?: string;
  available: boolean;
  why?: string;
  primary: boolean;
}

export interface RunInspection {
  version: typeof RUN_INSPECTION_VERSION;
  operation: string;
  checkedAt: string;
  /** the request (its operation's record): not a receipt */
  intent: { request: string | null; via?: string; started?: string; from: string; sealed: string };
  source: InspectSource | { none: string };
  changes: { list: InspectChange[]; more: number; notes: string[] };
  outputs: InspectOutput[];
  receipts: { list: InspectReceipt[]; chain: { read: number; ok: boolean | null; words: string } };
  actions: InspectAction[];
}

export interface RunInspectionOptions extends RunDetailOptions {
  /** images up to this many bytes as data: addresses (the companion's page draws them); 0 or absent: none */
  images?: number;
  /** the lines a text preview keeps (default PREVIEW_LINES) */
  lines?: number;
  /** verifyReceiptIn over the chain read, as the caller keeps its answers (the Workbench's); Timmy's own verifier when absent */
  verify?: (hash: string) => { ok: true } | { ok: false; reason: string };
}

export type RunInspectionResult = { ok: true; inspection: RunInspection; detail: RunDetail } | { ok: false; refusal: RunDetailRefusal; why: string };

const IMAGE_MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const BINARY_WHAT: Readonly<Record<string, string>> = {
  '.stl': 'an STL mesh', '.glb': 'a glTF binary', '.blend': 'a Blender file', '.fcstd': 'a FreeCAD document', '.aep': 'an After Effects project',
  '.pdf': 'a PDF', '.zip': 'a zip archive', '.gz': 'a gzip archive', '.mp4': 'a video', '.mov': 'a video', '.wav': 'audio', '.mp3': 'audio', '.3mf': 'a 3MF model',
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const quoted = (rel: string): string => (/\s/.test(rel) ? `"${rel}"` : rel);
const lineOf = (s: string): string => { const v = visible(s.replace(/\r$/, '')); return v.length > LINE_CHARS ? `${v.slice(0, LINE_CHARS - 1)}…` : v; };
const linesOf = (t: string): string[] => { const l = t.split('\n'); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

/** Text from bytes when they are UTF-8 text (no NUL in the first 8 KB); a read cut inside a character keeps what is whole. */
function textOfBytes(buf: Buffer, cut: boolean): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  const dec = (b: Buffer): string | null => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; } };
  const whole = dec(buf);
  if (whole !== null || !cut) return whole;
  for (let k = 1; k <= 3 && k < buf.length; k++) { const t = dec(buf.subarray(0, buf.length - k)); if (t !== null) return t; }
  return null;
}

/** An image's size in pixels from its first bytes (PNG, GIF, JPEG; an SVG's width and height), where they say it. */
function imageSize(ext: string, buf: Buffer): { width?: number; height?: number } {
  try {
    if (ext === '.png' && buf.length >= 24 && buf.readUInt32BE(12) === 0x49484452) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === '.gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if ((ext === '.jpg' || ext === '.jpeg') && buf.length > 4) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (ext === '.svg') {
      const head = buf.subarray(0, 4096).toString('utf8');
      const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
      const num = (a: string): number | undefined => { const m = new RegExp(`\\b${a}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i').exec(tag); return m ? Number(m[1]) : undefined; };
      const w = num('width');
      const h = num('height');
      if (w && h) return { width: w, height: h };
      const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag);
      if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
    }
  } catch { /* its header does not say */ }
  return {};
}

/** What one inspection may still send and read: its lines per preview, image bytes, and bytes read to hash files. */
interface PreviewBudget { lines: number; images: number; left: number; read: number }

const kb = (n: number): string => `${Math.round(n / 1024)} KB`;

/** A file's bytes (its start, as read through one descriptor) as a preview; `max`: the most of it read. */
function previewOfBytes(rel: string, buf: Buffer, size: number, sha256: string | null, cut: boolean, max: number, b: PreviewBudget): FilePreview {
  const ext = path.extname(rel).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    const dims = imageSize(ext, buf);
    const base = { kind: 'image' as const, mime, bytes: size, sha256, ...dims };
    if (cut) return { ...base, why: `larger than the ${kb(max)} read here: not drawn` };
    if (!b.images) return { ...base, why: 'drawn by the companion\'s run detail; a terminal shows its size and sha256' };
    if (size > b.images) return { ...base, why: `larger than ${Math.round(b.images / 1024)} KB: not drawn here` };
    if (size > b.left) return { ...base, why: 'not drawn here: this run detail already carries its most image bytes' };
    b.left -= size;
    return { ...base, data: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const text = textOfBytes(buf, cut);
  if (text === null) return { kind: 'binary', what: BINARY_WHAT[ext] ?? 'a binary file (not UTF-8 text)', bytes: size, sha256 };
  const cutWords = cut ? `only its first ${kb(max)} are read here (it has ${size} bytes)` : undefined;
  if (ext === '.json' && !cut) {
    try {
      const all = linesOf(JSON.stringify(JSON.parse(text), null, 2)).map(lineOf);
      return { kind: 'text', json: true, lines: all.slice(0, b.lines), more: Math.max(0, all.length - b.lines), bytes: size, sha256 };
    } catch (e) {
      const all = linesOf(text).map(lineOf);
      return { kind: 'text', jsonWhy: `not valid JSON (${e instanceof Error ? e.message.split('\n')[0] : 'it does not parse'}): its text as it is`, lines: all.slice(0, b.lines), more: Math.max(0, all.length - b.lines), bytes: size, sha256 };
    }
  }
  const all = linesOf(text).map(lineOf);
  return { kind: 'text', lines: all.slice(0, b.lines), more: Math.max(0, all.length - b.lines), bytes: size, sha256, ...(cutWords ? { cut: cutWords } : {}) };
}

/** A file read (its kept bytes, its size, its sha256 when hashed, whether it was cut, the most read), or why not. */
type Read = { ok: true; rel: string; buf: Buffer; size: number; sha256: string | null; cut: boolean; max: number; unhashed?: string } | { ok: false; gone: boolean; why: string };

/**
 * A file read through one descriptor, never through a link (R6 lead: every preview reads so): its name is looked at (a
 * regular file, no link at its end), opened with O_NOFOLLOW | O_NONBLOCK, and the open file must be the one looked at (its
 * device and inode); once read, its name must still resolve, with no link on the way, to that same file. Else it changed
 * while it was read, and nothing of it is used. At most `max` bytes are kept (its start, or its end with `tail`), all read
 * through that descriptor; it is hashed through the same descriptor while it is no larger than HASH_MAX and the
 * inspection's read budget lasts (else said why not). `abs` has no link before its name (realpath'd by the caller).
 */
function readHeld(abs: string, shown: string, max: number, o: { tail?: boolean; budget?: { read: number } } = {}): Read {
  const changed = (how: string): Read => ({ ok: false, gone: false, why: `${shown} changed while it was read (${how}): nothing of it is shown` });
  let named: fs.BigIntStats;
  try { named = fs.lstatSync(abs, { bigint: true }); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, gone: code === 'ENOENT', why: code === 'ENOENT' ? `${shown} is not there now` : `${shown} cannot be looked at (${code ?? 'error'})` };
  }
  if (named.isSymbolicLink()) return { ok: false, gone: false, why: `${shown} is a symbolic link: not followed` };
  if (!named.isFile()) return { ok: false, gone: false, why: `${shown} is not a regular file` };
  let fd: number;
  try { fd = fs.openSync(abs, READ_FLAGS); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return changed('a symbolic link is at its name now');
    if (code === 'ENOENT') return { ok: false, gone: true, why: `${shown} is not there now` };
    return { ok: false, gone: false, why: `${shown} cannot be read (${code ?? 'error'})` };
  }
  try {
    const held = fs.fstatSync(fd, { bigint: true });
    if (!held.isFile()) return changed('it is not a regular file now');
    if (held.dev !== named.dev || held.ino !== named.ino) return changed('another file is at its name now');
    const size = Number(held.size);
    const keepLen = Math.min(size, max);
    const keepFrom = o.tail ? size - keepLen : 0;
    const hashes = size <= HASH_MAX && (!o.budget || o.budget.read >= size);
    if (hashes && o.budget) o.budget.read -= size;
    const hash = hashes ? createHash('sha256') : null;
    const keep = Buffer.alloc(keepLen);
    const end = hashes ? size : keepFrom + keepLen;
    const chunk = Buffer.alloc(Math.max(1, Math.min(1024 * 1024, end)));
    let at = hashes ? 0 : keepFrom;
    while (at < end) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - at), at);
      if (n <= 0) break;
      const part = chunk.subarray(0, n);
      hash?.update(part);
      const a = Math.max(at, keepFrom);
      const z = Math.min(at + n, keepFrom + keepLen);
      if (a < z) part.copy(keep, a - keepFrom, a - at, z - at);
      at += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    // its name still leads, with no link on the way, to the file read (a folder swapped for a link is caught here too)
    let again: fs.BigIntStats | null = null;
    let real = '';
    try { again = fs.lstatSync(abs, { bigint: true }); real = fs.realpathSync(abs); } catch { /* gone meanwhile */ }
    if (!again || again.isSymbolicLink() || again.dev !== held.dev || again.ino !== held.ino || real !== abs) return changed('its name leads elsewhere now');
    const moved = at < end || after.size !== held.size || after.mtimeNs !== held.mtimeNs;
    const unhashed = moved ? 'it changed while it was read: not hashed'
      : !hashes ? (size > HASH_MAX ? `larger than ${HASH_MAX / 1024 / 1024} MB: not hashed here` : 'not hashed here: this inspection has read its most bytes') : undefined;
    const filled = Math.max(0, Math.min(at, keepFrom + keepLen) - keepFrom);
    return { ok: true, rel: shown, buf: keep.subarray(0, filled), size, sha256: hash && !moved ? hash.digest('hex') : null, cut: size > max, max, ...(unhashed ? { unhashed } : {}) };
  } catch (e) {
    return { ok: false, gone: false, why: `${shown} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally { fs.closeSync(fd); }
}

/** A path with the links of its folders resolved and its own name kept (so a link at its name is still seen as one). */
function folderReal(abs: string): string {
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

/** A project file, inside the project and not private (resolveInside), read through one descriptor (readHeld); a link at
 *  its name is not followed. */
function readProject(root: string, rel: string, max: number, budget?: { read: number }): Read {
  const at = resolveInside(root, rel);
  if ('error' in at) return { ok: false, gone: false, why: at.error };
  // its own name, before resolveInside resolved a link there: a link is not followed, even to a file in the project
  try { if (fs.lstatSync(path.join(root, at.rel)).isSymbolicLink()) return { ok: false, gone: false, why: `${at.rel} is a symbolic link: not followed` }; } catch { /* not there: readHeld says so */ }
  return readHeld(at.path, at.rel, max, { budget });
}

/** A read as a preview, or why there is none. */
const previewOf = (r: Read, b: PreviewBudget): FilePreview => (r.ok ? previewOfBytes(r.rel, r.buf, r.size, r.sha256, r.cut, r.max, b) : { kind: 'none', why: r.why });

/** A file now against the sha256 recorded for it. */
function nowAgainst(r: Read, recorded: string | undefined, from: string): FileNow {
  if (!r.ok) return r.gone ? { state: 'gone', words: `gone since${recorded ? ` (${from} recorded sha256 ${recorded.slice(0, 12)})` : ''}` } : { state: 'not comparable', words: r.why };
  if (!r.sha256) return { state: 'not comparable', words: r.unhashed ?? 'not hashed here' };
  if (!recorded) return { state: 'not recorded', sha256: r.sha256, words: `no record names its sha256 (sha256 ${r.sha256.slice(0, 12)} now)` };
  return r.sha256 === recorded ? { state: 'as recorded', sha256: r.sha256, words: `the bytes ${from} recorded (sha256 ${r.sha256.slice(0, 12)})` }
    : { state: 'changed since', sha256: r.sha256, words: `changed since: sha256 ${r.sha256.slice(0, 12)} now, ${recorded.slice(0, 12)} as ${from} recorded` };
}

/**
 * A line diff of two texts, as unified hunks with `context` unchanged lines around each place that changed: the common start
 * and end set aside, the middle compared by its longest common subsequence (past DIFF_CELLS, counted as replaced whole), at
 * most DIFF_LINES_MAX changed lines drawn (`more` counts the rest).
 */
export function lineDiff(before: string, after: string, o: { context?: number; max?: number } = {}): { added: number; removed: number; hunks: DiffHunk[]; more: number; method: string } {
  const context = o.context ?? 2;
  const max = o.max ?? DIFF_LINES_MAX;
  const a = linesOf(before);
  const b = linesOf(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const n = am.length;
  const m = bm.length;
  // every line of both, in order: '=' (in both), '-' (before only), '+' (after only), with its line number on each side
  const ops: Array<{ op: ' ' | '-' | '+'; ai: number; bi: number }> = [];
  for (let i = 0; i < p; i++) ops.push({ op: ' ', ai: i, bi: i });
  let method = 'line diff (longest common subsequence)';
  if (n * m <= DIFF_CELLS) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ op: ' ', ai: p + i, bi: p + j }); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push({ op: '-', ai: p + i, bi: p + j }); i++; } else { ops.push({ op: '+', ai: p + i, bi: p + j }); j++; }
    }
    for (; i < n; i++) ops.push({ op: '-', ai: p + i, bi: p + m });
    for (; j < m; j++) ops.push({ op: '+', ai: p + n, bi: p + j });
  } else {
    method = 'the middle replaced whole (too long to compare line by line)';
    for (let i = 0; i < n; i++) ops.push({ op: '-', ai: p + i, bi: p });
    for (let j = 0; j < m; j++) ops.push({ op: '+', ai: p + n, bi: p + j });
  }
  for (let k = 0; k < s; k++) ops.push({ op: ' ', ai: a.length - s + k, bi: b.length - s + k });
  const added = ops.filter((x) => x.op === '+').length;
  const removed = ops.filter((x) => x.op === '-').length;
  // the places that changed, each widened by `context` lines; places closer than twice that are one hunk
  const hunks: DiffHunk[] = [];
  let shown = 0;
  let more = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === ' ') { k++; continue; }
    let start = Math.max(0, k - context);
    let end = k;
    for (;;) {
      while (end < ops.length && ops[end].op !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next].op === ' ' && next - end < 2 * context) next++;
      if (next < ops.length && ops[next].op !== ' ' && next - end <= 2 * context) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const part = ops.slice(start, stop);
    const changed = part.filter((x) => x.op !== ' ').length;
    if (shown >= max) { more += changed; k = stop; continue; }
    const aLines = part.filter((x) => x.op !== '+');
    const bLines = part.filter((x) => x.op !== '-');
    const aStart = aLines.length ? aLines[0].ai + 1 : (part[0]?.ai ?? 0);
    const bStart = bLines.length ? bLines[0].bi + 1 : (part[0]?.bi ?? 0);
    const lines: DiffHunk['lines'] = [];
    for (const x of part) {
      if (x.op !== ' ' && shown >= max) { more++; continue; }
      if (x.op !== ' ') shown++;
      lines.push({ op: x.op, text: lineOf(x.op === '+' ? b[x.bi] : a[x.ai]) });
    }
    hunks.push({ header: `@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`, lines });
    start = stop;
    k = stop;
  }
  return { added, removed, hunks, more, method };
}

/** A diff of two reads, when both are UTF-8 text small enough to compare; else why not. */
function diffOfReads(a: Read | { ok: true; empty: true }, b: Read | { ok: true; empty: true }, d: { against: 'kept' | 'nothing' | 'as ran'; from: string; to: string }): InspectDiff {
  const text = (r: Read | { ok: true; empty: true }): string | { why: string } => {
    if ('empty' in r) return '';
    if (!r.ok) return { why: r.why };
    if (r.cut || r.size > DIFF_TEXT_MAX) return { why: `larger than ${Math.round(DIFF_TEXT_MAX / 1024)} KB: no line diff` };
    const t = textOfBytes(r.buf, false);
    return t === null ? { why: `${r.rel} is not UTF-8 text: no line diff (its size and sha256 are shown)` } : t;
  };
  const x = text(a);
  const y = text(b);
  if (typeof x !== 'string') return { shown: false, why: x.why };
  if (typeof y !== 'string') return { shown: false, why: y.why };
  const ld = lineDiff(x, y);
  return { shown: true, against: d.against, from: d.from, to: d.to, ...ld };
}

/** The receipt a prev_hash names, by hash, as a short id; 'genesis' at an epoch's start. */
function receiptsInspected(f: Facts, verify: NonNullable<RunInspectionOptions['verify']>): RunInspection['receipts'] {
  const byHash = new Map<string, number>();
  f.chain.forEach((r, i) => { if (r && typeof r.hash === 'string') byHash.set(r.hash, i); });
  const positions = new Map<number, number>();
  const counted = new Map<number, number>();
  f.chain.forEach((r, i) => { const e = r?.epoch ?? 1; const n = (counted.get(e) ?? 0) + 1; counted.set(e, n); positions.set(i, n); });
  const mine = f.receipts.filter((r) => typeof r.hash === 'string');
  const anyOutcome = mine.some((r) => r.kind === 'workflow');
  const ended = f.rec ? f.rec.record.ended !== null : !f.jobs.some((j) => !j.endedAt);
  const list: InspectReceipt[] = mine.map((r, k) => {
    const at = byHash.get(r.hash) ?? -1;
    const epoch = r.epoch ?? 1;
    const prevAt = typeof r.prev_hash === 'string' ? byHash.get(r.prev_hash) : undefined;
    const prev = prevAt !== undefined ? short(f.chain[prevAt]) : /^genesis/.test(String(r.prev_hash)) ? 'genesis' : String(r.prev_hash ?? '?').slice(7, 15) || '?';
    const position = positions.get(at) ?? 0;
    let v: { ok: true } | { ok: false; reason: string };
    try { v = verify(r.hash); } catch (e) { v = { ok: false, reason: `it could not be checked (${e instanceof Error ? e.message : String(e)})` }; }
    const stage: InspectReceipt['stage'] = r.kind === 'predict' || r.kind === 'fleet.predict' ? 'predict'
      : r.kind === 'workflow' || (!anyOutcome && ended && k === mine.length - 1) ? 'receipt' : 'run';
    const checked = `its body hashes to ${r.hash.slice(0, 19)}…, recomputed now; its prev_hash ${prev === 'genesis' ? `starts epoch ${epoch}` : `is receipt ${prev}'s hash`}, and the ${plural(position, 'link')} and body hashes from the start of epoch ${epoch} up to it hold; its signature verifies against the signer key it carries`;
    return {
      stage, id: short(r), kind: r.kind, ...(r.subject ? { subject: f.scrub(String(r.subject)) } : {}), ...(r.ts ? { ts: r.ts } : {}),
      hash: r.hash, prev, epoch, position, signed: typeof r.signature === 'string' && typeof r.signer === 'string',
      verified: v.ok ? { ok: true, checked } : { ok: false, why: v.reason },
    };
  });
  // the chain up to the newest receipt of the operation, as that receipt's own check found it
  const last = list.at(-1);
  const chain = !last ? { read: f.chain.length, ok: null, words: `no receipt names this operation on the chain read (${plural(f.chain.length, 'receipt')})` }
    : last.verified.ok ? { read: f.chain.length, ok: true, words: `the chain verifies from the start of epoch ${last.epoch} up to receipt ${last.id}: ${plural(last.position, 'receipt')}, every link and body hash, and ${last.id}'s signature (verifyReceiptIn, now)` }
      : { read: f.chain.length, ok: false, words: `the chain up to receipt ${last.id} does not verify: ${last.verified.why}` };
  return { list, chain };
}

/** The workflow document and its blocks as upmd ran them, and the document now. */
function sourceInspected(f: Facts, prediction: ReturnType<typeof predictionOf>, b: PreviewBudget): RunInspection['source'] {
  if (!prediction?.doc || !prediction.block) {
    return { none: prediction?.geometry ? 'it ran no workflow document: its prediction is a recipe build\'s (its request is its intent)' : 'it ran no workflow document: no document\'s bytes were sealed before it ran' };
  }
  const doc = prediction.doc;
  const block = prediction.block;
  const sealed = prediction.docSha ?? null;
  const from = `prediction receipt ${short(prediction.receipt)}`;
  const job = workflowJobs(f).find((j) => j.label === `${doc} › ${block}`) ?? workflowJobs(f)[0];
  const copyAbs = job?.args.find((a) => path.basename(a) === CHECKED_COPY && /^w[0-9a-f]{8}$/.test(path.basename(path.dirname(a))));
  let asRan: Read | null = null;
  let copy: InspectSource['copy'];
  const copyRead = copyAbs ? readHeld(folderReal(copyAbs), tildePath(copyAbs, f.env), SOURCE_READ_MAX, { budget: b }) : null;
  if (copyRead?.ok && sealed && copyRead.sha256 === sealed) { asRan = copyRead; copy = { state: 'kept', where: copyRead.rel, words: `the copy upmd read (job ${job!.id}), its sha256 the one ${from} sealed` }; }
  else if (copyRead?.ok) copy = { state: 'differs', where: copyRead.rel, words: `the copy upmd read (job ${job!.id}) does not hold the bytes ${from} sealed (sha256 ${copyRead.sha256?.slice(0, 12) ?? 'not hashed'})` };
  else copy = { state: 'missing', words: copyAbs ? `the copy upmd read is not kept here (${copyRead && !copyRead.ok ? copyRead.why : 'not read'})` : 'its job record names no copy upmd read' };
  const nowRead = readProject(f.root, doc, SOURCE_READ_MAX, b);
  let now: InspectSource['now'];
  if (!nowRead.ok) now = nowRead.gone ? { state: 'gone', words: `${doc} is not in the project now` } : { state: 'unreadable', words: nowRead.why };
  else if (!nowRead.sha256) now = { state: 'unreadable', sha256: undefined, words: `${doc}: ${nowRead.unhashed ?? 'not hashed here'}` };
  else if (sealed && nowRead.sha256 === sealed) now = { state: 'same', sha256: nowRead.sha256, words: `${doc} still holds the bytes it ran from (sha256 ${sealed.slice(0, 12)})` };
  else now = { state: 'changed', sha256: nowRead.sha256, words: `${doc} changed since the run: sha256 ${nowRead.sha256.slice(0, 12)} now, ${sealed ? sealed.slice(0, 12) : 'not recorded'} as it ran` };
  if (!asRan && nowRead.ok && now.state === 'same') { asRan = nowRead; copy = { ...copy, state: copy.state === 'missing' ? 'project' : copy.state, words: `${copy.words}; ${doc} in the project still holds the bytes ${from} sealed, and they are read from there` }; }
  const out: InspectSource = { doc, block, order: prediction.order ?? [block], asRan: { sha256: sealed, from }, copy, now, blocks: [] };
  const text = asRan?.ok && !asRan.cut ? textOfBytes(asRan.buf, false) : null;
  if (text === null) out.blocksWhy = asRan ? 'the document as it ran is not UTF-8 text, or too large to show' : `its blocks as they ran are not shown: neither the copy upmd read nor ${doc} holds the bytes ${from} sealed now`;
  else {
    const all = parseWorkflow(text);
    const plan = runOrder(all, block);
    const blockReceipts = f.receipts.filter((r) => r.kind === 'workflow-block' && (!job || r.block?.run === job.id));
    for (const name of plan.order) {
      const wb = all.find((x) => x.name === name);
      if (!wb) continue;
      const br = blockReceipts.find((r) => r.block?.name === name);
      const mine = codeSha256(wb);
      const sealedCode = br?.block?.code_sha256 ?? null;
      out.blocks.push({
        name, lang: wb.lang || 'bash', deps: wb.deps, firstLine: wb.line + 1, code: linesOf(wb.code).slice(0, 200).map(lineOf), sha256: mine, target: name === block,
        ...(br ? { sealed: { receipt: short(br), sha256: sealedCode, matches: sealedCode ? sealedCode === mine : null } } : {}),
      });
    }
    if (now.state === 'changed' && nowRead.ok && asRan) out.diff = diffOfReads(asRan, nowRead, { against: 'as ran', from: `${doc} as it ran`, to: `${doc} now` });
  }
  return out;
}

/** What the run changed, as /review reads it (src/review/changes.ts), each with its diff, its preview and its restore. */
function changesInspected(f: Facts, b: PreviewBudget): RunInspection['changes'] {
  let review: ReturnType<typeof operationReview>;
  try {
    const ix = buildIndex({ root: f.root, projectId: f.pid, chain: f.chain, jobs: f.jobs, scrub: f.scrub });
    review = withProcessTable(() => operationReview(ix, f.id, { max: CHANGES_MAX }));
  } catch (e) {
    return { list: [], more: 0, notes: [`what it changed could not be read: ${f.scrub(e instanceof Error ? e.message.split('\n')[0] : String(e))}`] };
  }
  const list = review.changes.map((c: ReviewChange): InspectChange => {
    const file = c.how === 'deleted' ? null : readProject(f.root, c.path, PREVIEW_READ_MAX, b);
    const kept = c.kept ? readProject(f.root, c.kept.path, PREVIEW_READ_MAX, b) : null;
    let diff: InspectDiff;
    if (c.diff?.shown && kept) diff = diffOfReads(kept, c.how === 'deleted' ? { ok: true, empty: true } : file!, { against: 'kept', from: c.kept!.path, to: c.how === 'deleted' ? '(deleted by the run)' : c.path });
    else if (c.diff && !c.diff.shown) diff = { shown: false, why: c.diff.why };
    else if (c.how === 'added' && c.now.state === 'unchanged' && file) diff = diffOfReads({ ok: true, empty: true }, file, { against: 'nothing', from: '(not there before the run)', to: c.path });
    else if (c.how === 'written') diff = { shown: false, why: `no line diff: ${c.before === null ? 'it was not there before the run' : 'Timmy kept no previous version of it, and whether it was there before the run is not recorded'}` };
    else if (c.how === 'changed' && c.now.state !== 'unchanged') diff = { shown: false, why: `no line diff: ${c.now.words}` };
    else diff = { shown: false, why: `no line diff: ${c.keptWords}` };
    const of = c.now.state === 'unchanged' ? 'the file as the run left it' : c.now.state === 'changed since' ? 'the file now: it changed since the run' : 'the file now';
    const preview = file ? { ...previewOf(file, b), of } : undefined;
    const keptPreview = kept?.ok && IMAGE_MIME[path.extname(c.kept!.path).toLowerCase()] ? previewOf(kept, b) : undefined;
    return {
      path: c.path, how: c.how, by: f.scrub(c.by), ...(c.before !== undefined ? { before: c.before } : {}), ...(c.after !== undefined ? { after: c.after } : {}),
      kept: { words: f.scrub(c.keptWords), ...(c.kept ? { path: c.kept.path, state: c.kept.state } : {}) },
      now: { state: c.now.state === 'unchanged' ? 'as recorded' : c.now.state === 'changed since' ? 'changed since' : c.now.state === 'gone' ? 'gone' : 'not comparable', ...(c.now.sha256 ? { sha256: c.now.sha256 } : {}), words: f.scrub(c.now.words) },
      diff, ...(preview ? { preview } : {}), ...(keptPreview ? { keptPreview } : {}),
      ...(c.record ? { record: c.record } : {}), ...(c.receipt ? { receipt: c.receipt } : {}),
      check: { status: c.check.status, words: f.scrub(c.check.words) },
      restore: c.restore.offered ? { offered: true, command: c.restore.command, from: c.restore.from } : { offered: false, why: f.scrub(c.restore.why) },
      ...(c.note ? { note: f.scrub(c.note) } : {}),
      open: `/open ${quoted(c.path)}`,
    };
  });
  return { list, more: review.more, notes: review.notes.map((n) => f.scrub(n)) };
}

/** The run's logs and the files it made, each previewed. */
function outputsInspected(f: Facts, d: RunDetail, b: PreviewBudget): InspectOutput[] {
  const out: InspectOutput[] = [];
  const seen = new Set<string>();
  const outcomeOf = (job: string): Receipt | undefined => [...f.receipts].reverse().find((r) => r.job?.id === job && (r.kind === 'workflow' || r.kind === 'task' || r.kind === 'recipe' || r.kind === 'preview'));
  for (const j of f.jobs) {
    const shown = tildePath(j.logPath, f.env);
    if (seen.has(shown)) continue;
    seen.add(shown);
    const r = outcomeOf(j.id);
    const sealedLog = r?.job?.log_sha256;
    const read = readHeld(folderReal(j.logPath), shown, LOG_READ_MAX, { tail: true, budget: b });
    // its end: the last LOG_READ_MAX bytes, escape sequences removed, a run of blank lines kept as one
    let preview: FilePreview;
    if (!read.ok) preview = { kind: 'none', why: read.why };
    else {
      const lines = linesOf(read.buf.toString('utf8')).map((l) => lineOf(l.replace(LOG_ESCAPE, '').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, ''))).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
      if (read.cut) lines.shift();
      const keep = lines.slice(-b.lines);
      preview = { kind: 'text', lines: keep, more: lines.length - keep.length, bytes: read.size, sha256: read.sha256, ...(read.cut ? { cut: `only its last ${Math.round(LOG_READ_MAX / 1024)} KB are read here (it has ${read.size} bytes)` } : {}) };
    }
    const live = !j.endedAt;
    const now: FileNow = !read.ok ? nowAgainst(read, sealedLog, `receipt ${r ? short(r) : '?'}`)
      : sealedLog ? nowAgainst(read, sealedLog, `receipt ${short(r!)}`)
        : { state: 'not recorded', ...(read.sha256 ? { sha256: read.sha256 } : {}), words: live ? 'it runs: its receipt seals its log\'s sha256 as it ends' : 'no receipt of it names its log\'s sha256' };
    out.push({ path: shown, kind: 'log', what: `the log of job ${j.id} (${f.scrub(j.label).slice(0, 80)})`, ...(sealedLog ? { recorded: { sha256: sealedLog, from: `receipt ${short(r!)}` } } : {}), now, preview, open: `/jobs ${j.id}` });
  }
  const files: Array<{ path: string; what: string; sha256?: string; bytes?: number; from: string }> = [];
  for (const j of workflowJobs(f)) {
    const r = outcomeOf(j.id);
    for (const o of r?.outputs ?? []) if (typeof o.path === 'string') files.push({ path: o.path, what: 'an output-folder file whose time falls in the run (named by its times: another program may have written it)', ...(o.sha256 ? { sha256: o.sha256 } : {}), bytes: o.bytes, from: `receipt ${short(r!)}` });
  }
  for (const x of d.files) {
    if (x.role !== 'output' && x.role !== 'preview' && x.role !== 'native') continue;
    if (x.path.startsWith('~') || path.isAbsolute(x.path) || x.path.split('/').includes('.timmy')) continue;
    files.push({ path: x.path, what: x.role === 'preview' ? 'a preview it made' : x.role === 'native' ? 'an editable native file it made' : 'a file it made', ...(x.sha256 ? { sha256: x.sha256 } : {}), from: x.from });
  }
  for (const x of files) {
    if (seen.has(x.path) || out.length >= OUTPUTS_MAX) continue;
    seen.add(x.path);
    const read = readProject(f.root, x.path, PREVIEW_READ_MAX, b);
    out.push({ path: x.path, kind: 'file', what: x.what, recorded: { ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.bytes !== undefined ? { bytes: x.bytes } : {}), from: x.from }, now: nowAgainst(read, x.sha256, x.from), preview: previewOf(read, b), open: `/open ${quoted(x.path)}` });
  }
  return out;
}
const LOG_ESCAPE = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;

/** A REPL command's effect, by what it is. */
const effectOf = (cmd: string): InspectAction['effect'] => (/^\/(?:restore|recover|edit)\b/.test(cmd) ? 'writes' : /^\/(?:open|review|jobs|op|ops|room|receipts|workflows|files|results)\b/.test(cmd) ? 'reads' : 'runs');

/** Open, /review, /restore and the run again, each with its effect; one of them the primary (the run detail's next step). */
function actionsInspected(f: Facts, d: RunDetail, source: RunInspection['source'], changes: RunInspection['changes'], outputs: InspectOutput[]): InspectAction[] {
  const acts: InspectAction[] = [];
  const firstFile = changes.list.find((c) => c.how !== 'deleted') ?? null;
  const firstOut = outputs.find((o) => o.kind === 'file') ?? null;
  const openPath = firstFile?.path ?? firstOut?.path;
  if (openPath) acts.push({ id: 'open', label: `Open ${openPath}`, command: `/open ${quoted(openPath)}`, effect: 'reads', words: 'its preview here, from the file as it is now; /open shows it in Timmy\'s REPL', path: openPath, available: true, primary: false });
  acts.push({ id: 'review', label: 'Review', command: `/review ${f.id}`, effect: 'reads', words: 'every file this run changed, each checked now against what the run left, its kept previous version and its receipt; nothing is written', available: true, primary: false });
  if (changes.list.length) {
    const offered = changes.list.find((c) => c.restore.offered);
    if (offered && offered.restore.offered) acts.push({ id: 'restore', label: `Restore ${offered.path}`, command: offered.restore.command, effect: 'writes', words: `writes the kept previous version (${offered.restore.from}) back over ${offered.path}, only while it is exactly what the run left; its current version is kept first under .timmy/restore-history/, and an edit receipt is sealed`, path: offered.path, available: true, primary: false });
    else {
      const why = changes.list[0].restore.offered ? '' : (changes.list[0].restore as { why: string }).why;
      acts.push({ id: 'restore', label: 'Restore', command: '/restore <file> --from <kept previous version>', effect: 'writes', words: 'writes a kept previous version back over a file the run changed', available: false, why: `not now: ${why || 'no change of this run has a kept previous version'}`, primary: false });
    }
  }
  if ('doc' in source) acts.push({ id: 'run-again', label: 'Run again', command: `/run ${quoted(source.doc)} ${quoted(source.block)}`, effect: 'runs', words: `a new run of ${source.doc} as it is now: Timmy predicts and seals the order before upmd starts, and a destructive block asks first in a NEEDS YOU box`, available: true, primary: false });
  // the primary, by Timmy's verdict: a completed run's result to look at; a stopped one, or one that changed nothing, run
  // again; otherwise the run detail's own next step (see why, follow it); else /review
  const state = d.verdict.state;
  const byId = (id: InspectAction['id']): InspectAction | undefined => acts.find((a) => a.id === id && a.available);
  let primary: InspectAction | undefined = state === 'completed' ? byId('open') : state === 'cancelled' || state === 'recovered' || state === 'no change' ? byId('run-again') : undefined;
  const next = d.next?.command;
  if (!primary && next) {
    primary = acts.find((a) => a.available && (a.command === next || (a.id === 'run-again' && next.startsWith('/run '))));
    if (!primary) {
      primary = { id: 'next', label: d.next!.words.replace(/^./, (c) => c.toUpperCase()).slice(0, 80), command: next, effect: effectOf(next), words: d.next!.words, available: true, primary: false };
      acts.unshift(primary);
    }
  }
  (primary ?? byId('review') ?? acts.find((a) => a.available))!.primary = true;
  return acts;
}

/** One operation's run inspected (its source, changes, outputs, receipts and actions), or why there is none. Reads only. */
export function readRunInspection(operationId: string, o: RunInspectionOptions = {}): RunInspectionResult {
  const b = built(operationId, o);
  if (!b.ok) return b;
  const { f, detail, prediction } = b;
  const verify = o.verify ?? ((hash: string) => { const r = verifyReceiptIn(f.chain, hash); return r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason }; });
  const budget: PreviewBudget = { lines: Math.max(1, o.lines ?? PREVIEW_LINES), images: Math.max(0, o.images ?? 0), left: IMAGE_DATA_TOTAL, read: READ_TOTAL };
  const rec = f.rec?.record;
  const predictReceipt = f.receipts.find((r) => r.kind === 'predict' || r.kind === 'fleet.predict');
  const intent: RunInspection['intent'] = {
    request: rec ? f.scrub(rec.request) : detail.objective?.value ?? null,
    ...(rec ? { via: rec.via, started: rec.started } : {}),
    from: f.rec?.rel ?? detail.objective?.from ?? 'not recorded here',
    sealed: `not a receipt: Timmy writes an operation's record and nothing seals it${predictReceipt ? `; prediction receipt ${short(predictReceipt)} seals what it ran from${predictReceipt.files?.length ? ` (${predictReceipt.files.map((x) => `${x.path} sha256 ${String(x.sha256 ?? '').slice(0, 12)}`).join(', ')})` : ''}` : ''}`,
  };
  const source = sourceInspected(f, prediction, budget);
  const changes = changesInspected(f, budget);
  const outputs = outputsInspected(f, detail, budget);
  const receipts = receiptsInspected(f, verify);
  const actions = actionsInspected(f, detail, source, changes, outputs);
  return {
    ok: true, detail,
    inspection: { version: RUN_INSPECTION_VERSION, operation: f.id, checkedAt: f.now.toISOString(), intent, source, changes, outputs, receipts, actions },
  };
}

/** One operation's run inspected; throws RunDetailError (its refusal and why) when there is none. */
export function runInspection(operationId: string, o: RunInspectionOptions = {}): RunInspection {
  const r = readRunInspection(operationId, o);
  if (!r.ok) throw new RunDetailError(r.refusal, r.why);
  return r.inspection;
}
