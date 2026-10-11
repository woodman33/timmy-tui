/**
 * Round R4 (helper H73): what Timmy judged of a job, for every view that draws a job's mark: `/jobs` and the Jobs part of
 * `/results` (src/repl/workspace.ts jobLine), the board's Jobs section, the Control Room's other jobs, `/op` cards and the
 * REPL's notice when a job ends.
 *
 * On the Mac (u23, ledger row 166) an `/unreal` run whose script reported ok: false was judged failed (its verdict, its
 * native receipt with status failed, its operation "✖ failed"), while `/jobs` said "✓ j437b34 completed", by the job's exit
 * 0; r20 and r21 saw the same for OpenHands runs Timmy judged unknown (H69: the views "mark the docker client by its exit 0.
 * This is true for every code agent"). A process that ends with 0 has not been judged. Where Timmy keeps a judgement of a job,
 * that judgement is shown, each kind by its own judge, as the one table below (JOB_KINDS) says; for the kinds whose own end is
 * the judgement, today's reading stays.
 *
 * The marks: ✓ only for a judged success; ? for a judgement of unknown, and for a job of a judged kind whose judgement is not
 * there (never ✓ by its exit); ✖ for a judged failure (failed, differs, timed out); a stop's blank for a run that was stopped;
 * the running bullet while it runs. Every judge's words go through the caller's scrub and lose their control characters.
 * Nothing here runs, writes or seals anything: it reads the records the judges wrote.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS_DIR, listAgentRuns } from '../code-agents/index.js';
import { cleanText } from '../connectors/mcp-records.js';
import { FLOWS_DIR } from '../flows/iterate.js';
import type { JobRecord } from '../jobs/index.js';
import type { Receipt } from '../utils/receipts.js';
import { VOX_DIR } from '../vox/record.js';

/** The kinds of job, as their judges tell them apart. */
export type JobKind = 'workflow' | 'preview' | 'recipe' | 'task' | 'agent' | 'native' | 'readback' | 'vox' | 'look';

export interface JobKindRow {
  /** what a job of this kind is */
  what: string;
  /** exit: its own end is the judgement (today's reading stays); record: Timmy's judgement in a record decides */
  by: 'exit' | 'record';
  /** the judge, in a few words */
  judge: string;
}

/**
 * The one table of job kinds: which kinds are judged by their own end, and which by a record Timmy writes after it. A job
 * is of the kind a record that names it says (an agent run's run.json, a native run's started.json and verdicts, a readback's
 * line, a flow's readback, a VoxVision record, an observe receipt), else of the kind its label says (jobKind).
 */
export const JOB_KINDS: Readonly<Record<JobKind, JobKindRow>> = {
  workflow: { what: 'a /run of a upmd workflow document', by: 'exit', judge: "its blocks' exits (each block is a shell command; upmd stops at the first that fails)" },
  preview: { what: 'a /preview server', by: 'exit', judge: 'its own state: ready once its address answers, then its exit' },
  recipe: { what: 'a recipe watcher (/recipe, a flow\'s build step)', by: 'exit', judge: "its watcher's exit: 0 only once the recipe's signed result verified and its exports were copied" },
  task: { what: 'any other job', by: 'exit', judge: 'its own exit' },
  agent: { what: 'a code agent run (/agent, a flow\'s agent step)', by: 'record', judge: 'its result.json' },
  native: { what: 'a native app run (/blender, /openscad, /freecad, /illustrator, /unreal, …)', by: 'record', judge: 'its verdict' },
  readback: { what: 'a readback (a second process reading a run\'s file back)', by: 'record', judge: "its readback's verdict" },
  vox: { what: 'a tool of a VoxVision action (/inspect, /measure, /detect, /compare, /vox view)', by: 'record', judge: 'its VoxVision record' },
  look: { what: 'a Look measurement (/observe)', by: 'record', judge: 'its observe receipt' },
};

/** How a job's outcome is marked: only a judged success is ok. */
export type JobMark = 'ok' | 'unknown' | 'failed' | 'stopped' | 'running';

export interface JobJudgement {
  kind: JobKind;
  by: 'exit' | 'record';
  mark: JobMark;
  /** its outcome in a word or two: the judge's own word where a record judged it, else the job's state */
  word: string;
  /** the judge's own words, cleaned, scrubbed and cut (a record's judgement only) */
  why?: string;
  /** who judged, in words ("its verdict", "its result.json"); a record's judgement, or a judged kind's missing one */
  judge?: string;
  /** the record that holds the judgement, project-relative */
  record?: string;
  /** the job's own end, in words, beside a record's judgement: "its process completed (exit 0)" */
  exit?: string;
  /** a judged kind whose judgement is not here: `why` names the judge itself */
  missing?: true;
}

/** A judgement a record keeps of a job; `record`, the project file that keeps it (absent: a receipt names no file). */
interface Kept { kind: JobKind; outcome: string; why?: string; stopped?: boolean; record?: string }

export interface JudgeIndex {
  /** each job a record judged, by its id: the newest judgement of it */
  byJob: Map<string, Kept>;
  /** each job a record names, with the kind it names it as (judged or not yet) */
  kindOf: Map<string, JobKind>;
  /** each native run's newest verdict, by its run token (the Control Room's and /op's native rows) */
  byRun: Map<string, Kept & { job?: string }>;
  scrub: (t: string) => string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const JOB_ID = /^j[0-9a-f]{6}$/;
/** Where native runs keep their folders (src/native/index.ts NATIVE_RUNS_DIR), as a project path. */
const NATIVE_REL = '.timmy/native';
const RUN_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_JOB = /^agent \S+ a[0-9a-f]{8}:/;
const LIVE: ReadonlySet<string> = new Set(['queued', 'running', 'ready']);
const RECORD_MAX = 2 * 1024 * 1024;
const LINES_MAX = 8 * 1024 * 1024;
/** How many VoxVision records and flow records are read (the newest by name order is not known: the first so many). */
const FILES_MAX = 400;
/** How long a judge's words may be in a job's line. */
export const WHY_MAX = 160;

/** A record's words as a job line shows them: control characters and escapes out, one line, scrubbed, cut. */
export function judgeWords(text: unknown, scrub: (t: string) => string = (t) => t, max = WHY_MAX): string {
  const t = scrub(cleanText(String(text ?? ''))).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function readSmall(abs: string, max = RECORD_MAX): string | undefined {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > max) return undefined;
    return fs.readFileSync(abs, 'utf8');
  } catch { return undefined; }
}
const readJson = (abs: string): unknown => { const t = readSmall(abs); if (t === undefined) return undefined; try { return JSON.parse(t) as unknown; } catch { return undefined; } };
/** A JSON-lines file's objects, oldest first; a torn line is skipped, never repaired. */
function readLines(abs: string): Obj[] {
  const t = readSmall(abs, LINES_MAX);
  if (!t) return [];
  const out: Obj[] = [];
  for (const line of t.split('\n')) { if (!line.trim()) continue; try { const o = obj(JSON.parse(line)); if (o) out.push(o); } catch { /* skipped */ } }
  return out;
}
const listDir = (abs: string, test: RegExp): string[] => { try { return fs.readdirSync(abs).filter((n) => test.test(n)).sort(); } catch { return []; } };

/**
 * Reads, once, every judgement the project's records keep of its jobs: agent runs (result.json, or run.json ended by
 * recovery), native runs (verdicts.jsonl, started.json), readbacks (each native run's readbacks.jsonl, each flow record's
 * readback), VoxVision records (each tool's job) and observe receipts (each Look job). A record that cannot be read is
 * skipped: its job is then shown as not judged here, never as judged.
 */
export function judgeIndex(o: { root: string; chain?: readonly Receipt[]; projectId?: string; scrub?: (t: string) => string; flows?: ReadonlyArray<{ record: unknown; file: string }> }): JudgeIndex {
  const ix: JudgeIndex = { byJob: new Map(), kindOf: new Map(), byRun: new Map(), scrub: o.scrub ?? ((t) => t) };
  const judged = (job: unknown, k: Kept): void => { const id = str(job); if (!id || !JOB_ID.test(id)) return; ix.byJob.set(id, k); ix.kindOf.set(id, k.kind); };
  const named = (job: unknown, kind: JobKind): void => { const id = str(job); if (id && JOB_ID.test(id) && !ix.kindOf.has(id)) ix.kindOf.set(id, kind); };
  // Code agents: Timmy's judgement in result.json; a run.json that recovery ended says interrupted (no result was written).
  try {
    for (const r of listAgentRuns(o.root)) {
      const rec = `${AGENTS_DIR}/${r.run}/${r.outcome ? 'result.json' : 'run.json'}`;
      if (r.outcome) judged(r.job, { kind: 'agent', outcome: r.outcome, ...(r.why ? { why: r.why } : {}), record: rec });
      else if (r.state === 'interrupted') judged(r.job, { kind: 'agent', outcome: 'interrupted', why: r.why ?? 'its REPL ended first; no result was written', stopped: true, record: rec });
      else named(r.job, 'agent');
    }
  } catch { /* no agent runs read */ }
  // Native runs: each verdict line names its job; started.json names the job of a run not judged yet; readbacks.jsonl
  // (Unreal's and FreeCAD's) names each readback's job and verdict.
  const nativeDir = path.join(o.root, NATIVE_REL);
  for (const run of listDir(nativeDir, RUN_TOKEN)) {
    const dir = path.join(nativeDir, run);
    const started = obj(readJson(path.join(dir, 'started.json')));
    named(started?.job, 'native');
    const rel = `${NATIVE_REL}/${run}/verdicts.jsonl`;
    let unnamed: Kept | undefined;
    for (const v of readLines(path.join(dir, 'verdicts.jsonl'))) {
      const outcome = str(v.outcome);
      if (!outcome) continue;
      const stopped = obj(v.exit)?.state === 'cancelled';
      // R4 (H64): an Illustrator verdict carries Timmy's own reading of its export; one that differs is "differs".
      const differs = outcome === 'ok' && obj(v.readback)?.verdict === 'differs';
      const k: Kept = { kind: 'native', outcome: differs ? 'differs' : outcome, ...(str(v.why) ? { why: str(v.why) } : {}), ...(stopped ? { stopped } : {}), record: rel };
      if (str(v.job)) judged(v.job, k); else unnamed = k;
      ix.byRun.set(run, { ...k, ...(str(v.job) ? { job: str(v.job) } : {}) });
    }
    // A verdict line that names no job (judged with no job record at hand) judges the job its started.json names.
    const startedJob = str(started?.job);
    if (unnamed && startedJob && !ix.byJob.has(startedJob)) judged(startedJob, unnamed);
    const rbRel = `${NATIVE_REL}/${run}/readbacks.jsonl`;
    for (const l of readLines(path.join(dir, 'readbacks.jsonl'))) {
      const verdict = str(l.verdict);
      const stopped = l.state === 'cancelled';
      judged(l.job, { kind: 'readback', outcome: verdict ?? (stopped ? 'stopped' : 'not judged'), ...(str(l.reason) ? { why: str(l.reason) } : {}), ...(stopped ? { stopped } : {}), record: rbRel });
    }
  }
  // A flow's readback (the tray's STEP readback, Blender's, After Effects'): its part names its job and verdict.
  const flows = o.flows ?? listDir(path.join(o.root, FLOWS_DIR), /^f[0-9a-f]{8}\.json$/).slice(0, FILES_MAX).map((n) => ({ file: `${FLOWS_DIR}/${n}`, record: readJson(path.join(o.root, FLOWS_DIR, n)) }));
  for (const f of flows) {
    const rb = obj(obj(f.record)?.readback);
    if (!rb || !str(rb.job)) continue;
    const verdict = str(rb.verdict);
    const stopped = rb.state === 'cancelled';
    if (verdict || stopped) judged(rb.job, { kind: 'readback', outcome: verdict ?? 'stopped', ...(str(rb.reason) ? { why: str(rb.reason) } : {}), ...(stopped ? { stopped } : {}), record: f.file });
    else named(rb.job, 'readback');
  }
  // VoxVision: each tool's job, judged by its action's record (its status, and its first failure's words).
  for (const n of listDir(path.join(o.root, VOX_DIR), /^v[0-9a-f]{8}\.json$/).slice(0, FILES_MAX)) {
    const r = obj(readJson(path.join(o.root, VOX_DIR, n)));
    const status = str(r?.status);
    if (!r || !status || !Array.isArray(r.tools)) continue;
    const failure = Array.isArray(r.failures) ? obj(r.failures[0]) : undefined;
    for (const t of r.tools.map(obj)) judged(obj(t?.job)?.id, { kind: 'vox', outcome: status, ...(str(failure?.message) ? { why: str(failure?.message) } : {}), ...(status === 'cancelled' ? { stopped: true } : {}), record: `${VOX_DIR}/${n}` });
  }
  // Look: each measurement's job, judged by its observe receipt.
  for (const r of o.chain ?? []) {
    if (!r || r.kind !== 'observe' || (o.projectId && r.project_id !== o.projectId)) continue;
    const status = r.status ?? 'ok';
    const out = str(r.outputs?.[0]?.path);
    judged(r.job?.id, { kind: 'look', outcome: status === 'ok' ? 'observed' : status, ...(str(obj(r.observation)?.error) ? { why: str(obj(r.observation)?.error) } : {}), ...(status === 'cancelled' ? { stopped: true } : {}), ...(out && !out.startsWith('/') && !out.includes('..') ? { record: out } : {}) });
  }
  return ix;
}

/** A job's kind by its own record's kind and label, when no record names it (the labels Timmy gives its jobs). */
export function jobKind(j: Pick<JobRecord, 'kind' | 'label'>): JobKind {
  if (j.kind === 'workflow') return 'workflow';
  if (j.kind === 'server') return 'preview';
  if (/^look /.test(j.label)) return 'look';
  if (/^vox /.test(j.label)) return 'vox';
  if (/^readback /.test(j.label)) return 'readback';
  if (/^recipe /.test(j.label)) return 'recipe';
  if (AGENT_JOB.test(j.label)) return 'agent';
  return 'task';
}

/** A judge's word as a mark: only a judged success is ok. */
function markOf(k: Pick<Kept, 'outcome' | 'stopped'>): JobMark {
  if (k.stopped) return 'stopped';
  switch (k.outcome) {
    case 'completed': case 'ok': case 'agrees': case 'matches': case 'observed': return 'ok';
    case 'failed': case 'differs': case 'timed out': return 'failed';
    case 'cancelled': case 'stopped': case 'interrupted': return 'stopped';
    default: return 'unknown';
  }
}

/** A judge's outcome word (an agent's result, a verdict, a readback's) as a mark: only a judged success is ok. */
export const outcomeMark = (outcome: string, stopped = false): JobMark => markOf({ outcome, stopped });

/** The word a judge's outcome is said with. */
const wordOf = (k: Kept): string => (k.stopped && k.kind !== 'agent' ? 'stopped' : k.outcome === 'cancelled' ? 'stopped' : k.outcome);

/** The job's own end, in words, beside a record's judgement. */
function exitWords(j: Pick<JobRecord, 'state' | 'exitCode' | 'signal' | 'error' | 'stale'>): string {
  if (j.stale) return `its process is gone (its record says ${j.state})`;
  const how = j.error ? j.error : typeof j.exitCode === 'number' ? `exit ${j.exitCode}` : j.signal ? `ended by ${j.signal}` : '';
  return `its process ${j.state === 'cancelled' ? 'was stopped' : j.state}${how ? ` (${how})` : ''}`;
}

/**
 * A job's outcome as Timmy judged it. A job that runs is running (a preview that answers is ready). A kind its own exit
 * judges reads as today. A judged kind reads as its record judged it; with no judgement here: stopped when it was stopped,
 * failed when its process failed, and otherwise "not judged" with ?, never ✓ by its exit.
 */
export function jobJudgement(j: JobRecord, ix?: JudgeIndex, o: { whyMax?: number } = {}): JobJudgement {
  const kept = ix?.byJob.get(j.id);
  const kind = kept?.kind ?? ix?.kindOf.get(j.id) ?? jobKind(j);
  const row = JOB_KINDS[kind];
  if (!j.stale && LIVE.has(j.state)) return { kind, by: row.by, mark: j.state === 'ready' ? 'ok' : 'running', word: j.state };
  if (row.by === 'exit') {
    const mark: JobMark = j.state === 'completed' ? 'ok' : j.state === 'failed' ? 'failed' : j.state === 'cancelled' ? 'stopped' : 'running';
    return { kind, by: 'exit', mark, word: j.state };
  }
  const scrub = ix?.scrub ?? ((t: string) => t);
  if (kept) {
    return {
      kind, by: 'record', mark: markOf(kept), word: wordOf(kept), judge: row.judge, ...(kept.record ? { record: kept.record } : {}), exit: exitWords(j),
      ...(kept.why ? { why: judgeWords(kept.why, scrub, o.whyMax) } : {}),
    };
  }
  // No judgement of a judged kind here: its words say which judge has none (the line shows them alone: `missing`).
  const base = { kind, by: 'record' as const, judge: row.judge, exit: exitWords(j), missing: true as const };
  const none = `${row.judge} has no judgement of it here`;
  if (j.state === 'cancelled') return { ...base, mark: 'stopped', word: 'stopped', why: `stopped; ${none}` };
  if (j.state === 'failed' && !j.stale) return { ...base, mark: 'failed', word: 'failed', why: `${judgeWords(j.error ?? `exit ${j.exitCode ?? j.signal ?? '?'}`, scrub)}; ${none}` };
  return {
    ...base, mark: 'unknown', word: 'not judged',
    why: j.stale ? `${none}, and its process is gone` : `${none} yet, so its ${typeof j.exitCode === 'number' ? `exit ${j.exitCode}` : 'end'} is not taken as a success`,
  };
}

/** A mark as the terminal draws it: ✓, ✖, ?, a stop's blank, the running bullet. */
export function markGlyph(m: JobMark, g: { ok: string; fail: string; bullet: string }): string {
  return m === 'ok' ? g.ok : m === 'failed' ? g.fail : m === 'unknown' ? '?' : m === 'stopped' ? ' ' : g.bullet;
}

/** "its verdict: the script reported ok: false" (or, with no judgement here, the words that say so), or "" for a job its
 *  own exit judges. */
export const judgedWords = (r: JobJudgement): string => (r.by !== 'record' || !r.judge ? '' : r.missing ? r.why ?? '' : `${r.judge}${r.why ? `: ${r.why}` : ''}`);
/** The same as a sentence on its own (the board's job card): "judged by its verdict: …", or the words that say none is here. */
export const judgedLine = (r: JobJudgement): string => { const w = judgedWords(r); return !w || r.missing ? w : `judged by ${w}`; };
