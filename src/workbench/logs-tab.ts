/**
 * R5 (H134): the body of tab 0, Logs & Receipts (src/contracts/workspace.ts TABS: "raw output, structured events and the
 * receipt chain, linked by operation id"), laid out as the operator's reference 10 lays it out, with 13's session-log feel:
 *
 *   the chain line   verifyChain over the store this project's seals go to (src/workbench/state.ts chainOf), run in this
 *                    reading: "✓ chain verified: N receipts" (green) only when every epoch's links and body hashes verified
 *                    now; ✕ and the reason (amber) when they did not; "no receipts yet" when nothing is sealed. Never from a
 *                    cached or assumed state.
 *   (a) event log    newest first, one list: the project's receipts on the chain (#place, kind, subject, how it ended), its
 *                    operations (.timmy/operations), its jobs' events (start, blocks, end: the Activity strip's) and the
 *                    store's other events (`timmy events`). The selected row has its raw line under it; the Inspector has it
 *                    whole (the order: "keep raw logs alongside summaries").
 *   (b) sequence     the selected row's operation as cards: .intent → .predict → sandbox / run → .receipt, from its record and
 *                    its receipts. .intent and .predict amber; a receipt green only when verifyReceiptIn confirms it against
 *                    this reading's chain; a step with no record says "not recorded", never invented.
 *   (c) raw output   the selected run's own log (the job's log file), its last lines, each cut at the column's edge.
 *
 * From 120 columns the three sit side by side, below that they are stacked; each keeps the selection in its own rows, so the
 * body never scrolls away from it. readLogs reads files only: nothing here runs, seals, writes or asks the network.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { busPath } from '../bus/index.js';
import { JobManager, type JobRecord } from '../jobs/index.js';
import { JOB_CANCELLED, receiptSubjectWords, TURN_STOPPED } from '../contracts/stop-words.js';
import { readFleetView } from '../fleet/service.js';
import { listOperationRecords, readOperationRecord, type OperationRecord } from '../ops/operations.js';
import { projectId } from '../project/index.js';
import { chatTurnOf } from '../repl/seal.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { formatCostUsd, readChain, receiptsPath, verifyChain, verifyReceiptIn, type Receipt, type VerifyResult } from '../utils/receipts.js';
import type { Glyphs } from './frame.js';
import { lineText } from './output.js';
import { readJobs, type JobRow } from './state.js';
import {
  card, clipRows, fieldRows, heading, onBar, para, previewNote, rowsOf, S, selectedIn, sideBySide, sideBySideAt, RULE_CELLS, widths, windowBlocks, type TabCtx,
  type TabView,
} from './tab-columns.js';
import { clock, cut, fit, lineCells, pick, spread, type Line, type Role, type Seg } from './text.js';

type Env = Record<string, string | undefined>;

/** The Workbench list the event log's selection is kept in (src/workbench/screen.ts: `center:<workspace>`). */
export const LOGS_LIST = 'center:logs';
/** R5 (H131; the QA of e7f853e, defect 2): what no Timmy surface draws of this tab yet, and what the companion shows of it */
const LOGS_NONE = 'No Timmy surface replays runs yet.';
const LOGS_C = 'events and receipts in words';
/** How many events the log lists (the newest). */
export const LOG_MAX = 80;
/** How many of a run's last lines are read. */
export const TAIL_LINES = 60;
/** How many runs' logs one reading reads (the newest of those the listed events name). */
export const TAIL_JOBS = 16;
/** How much of a raw line is kept (the Inspector wraps it whole; a longer one says where the rest is). */
export const RAW_MAX = 16_000;
/** The most bytes of a log's end read for its tail. */
const TAIL_BYTES = 64 * 1024;

// ── the reading ────────────────────────────────────────────────────────────────

export type LogTone = 'text' | 'quiet' | 'attention' | 'failure';
export type LogSource = 'receipt' | 'operation' | 'job' | 'bus';

/** One row of the event log, as its record says it; `raw` is the line (or the record's fields) it was read from. */
export interface LogEvent {
  /** its own name, the same at every reading (the selection stays on it while rows arrive) */
  key: string;
  source: LogSource;
  /** when, as recorded (ISO) */
  at: string;
  /** a receipt's place on the chain (1 = the first sealed); the other rows have their time only */
  seq?: number;
  /** the event's name: a receipt's kind, job.start, job.step, job.end, operation, or the bus event's kind */
  tag: string;
  summary: string;
  /** how it ended or stands, in words; the tone is how it is drawn (never green: a row is not a verification) */
  status: { word: string; tone: LogTone };
  operation?: string;
  job?: string;
  /** a receipt's hash */
  hash?: string;
  raw: { where: string; text: string };
}

/** The chain line's facts, from verifyChain in this reading. */
export interface ChainCheck {
  /** verified: every epoch verifies; partial: the current epoch verifies, an earlier one does not (kept as incident
   *  evidence); broken: the current epoch does not; empty: nothing is sealed; unreadable: the store could not be read */
  state: 'verified' | 'partial' | 'broken' | 'empty' | 'unreadable';
  /** every receipt verifyChain read, all epochs */
  count: number;
  current: { epoch: number; count: number };
  epochs: number;
  incidents: Array<{ epoch: number; reason: string }>;
  reason?: string;
  brokenAt?: string;
  /** the store's file, from the project (or ~) */
  store: string;
}

/** An operation the listed events name: its record (or why there is none), its receipts on the chain and its jobs. */
export interface OpInfo {
  id: string;
  record: OperationRecord | null;
  /** why there is no record: none in the project, or it could not be read (`unreadable`) */
  why?: string;
  unreadable?: boolean;
  /** its receipts' hashes, in the chain's order */
  receipts: string[];
  /** its jobs, the newest first */
  jobs: string[];
  /** the other runs its record names (a fleet plan, a flow, a VoxVision action…), as kind and id */
  runs: Array<{ kind: string; id: string }>;
}

/** A fleet plan an operation ran, as its own files say it (src/fleet/service.ts readFleetView). */
export interface FleetRun { backend: string; simulation: boolean; status: string; requested: number; delivered: number; failed: number }

/** A job the listed events or operations name: its row (as the Workbench judges it) and the end of its log. */
export interface JobInfo {
  row: JobRow;
  /** its log file, from the project (or ~) */
  log: string;
  /** how many lines it printed, as its record counts them */
  lines: number;
  tail: { lines: string[] } | { why: string };
}

export type ReceiptVerdict = { ok: true } | { ok: false; reason: string };

export interface LogsData {
  /** when this reading was made (ISO) */
  at: string;
  root: string;
  chain: ChainCheck;
  /** the chain as readChain read it in this reading: verifyReceiptIn's chain */
  receipts: readonly Receipt[];
  /** a receipt's place on the chain, by hash (1 = the first) */
  seq: ReadonlyMap<string, number>;
  /** newest first */
  events: LogEvent[];
  /** events not listed (older than the LOG_MAX newest) */
  more: number;
  /** receipts of the store that name another project, or none and no operation of this one (not listed) */
  foreign: number;
  ops: Record<string, OpInfo>;
  jobs: Record<string, JobInfo>;
  /** the fleet plans the listed operations ran, by plan id */
  fleets: Record<string, FleetRun>;
  /** what could not be read, each with why */
  notes: string[];
  /** verifyReceiptIn's verdicts, by hash, made against `receipts` the first time a receipt is shown (this reading's only) */
  checks: Map<string, ReceiptVerdict>;
}

export interface LogsReadInput {
  /** Timmy's home (the job store is <home>/jobs) */
  home: string;
  /** the project's folder */
  root: string;
  /** TIMMY_STORE decides the store, as src/workbench/state.ts chainOf does */
  env?: Env;
  /** the job records, when the caller has read them (else they are read from <home>/jobs) */
  records?: readonly JobRecord[];
  now?: number;
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** A file from the project ("./…" without the dot), else from ~. */
function shownPath(p: string, root: string, env: Env): string {
  const r = relative(root, p);
  if (r && !r.startsWith('..') && !isAbsolute(r)) return r.split(sep).join('/');
  return tildePath(p, env as NodeJS.ProcessEnv);
}

/** Text as it may be shown: the project's folder as ".", home folders as "~", control characters gone. */
const scrubFor = (root: string, env: Env) => (t: string): string => scrubHomes(t.split(root).join('.'), env as NodeJS.ProcessEnv);

function chainCheckOf(v: VerifyResult, store: string): ChainCheck {
  const cur = v.segments.find((s) => s.epoch === v.current_epoch);
  const incidents = v.segments.filter((s) => s.epoch !== v.current_epoch && !s.ok).map((s) => ({ epoch: s.epoch, reason: s.reason ?? `broken at ${s.brokenAt ?? 'a receipt'}` }));
  const base = { count: v.count, current: { epoch: v.current_epoch, count: cur?.count ?? 0 }, epochs: v.segments.length, incidents, store };
  if (!v.count) return { ...base, state: 'empty' };
  if (!v.ok) return { ...base, state: 'broken', ...(v.reason ? { reason: v.reason } : {}), ...(v.brokenAt ? { brokenAt: v.brokenAt } : {}) };
  return { ...base, state: incidents.length ? 'partial' : 'verified' };
}

/** The store's lines, each with its number (1 = the first line): a receipt line by its hash, and the bus events. */
function storeLines(file: string): { receipt: Map<string, { n: number; text: string }>; bus: Array<{ n: number; text: string; ev: { ts?: unknown; kind: string; payload?: unknown } }> } {
  const receipt = new Map<string, { n: number; text: string }>();
  const bus: Array<{ n: number; text: string; ev: { ts?: unknown; kind: string; payload?: unknown } }> = [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { receipt, bus }; }
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let v: unknown;
    try { v = JSON.parse(l); } catch { return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.hash === 'string') receipt.set(o.hash, { n: i + 1, text: l });
    else if (typeof o.kind === 'string') bus.push({ n: i + 1, text: l, ev: { ts: o.ts, kind: o.kind, payload: o.payload } });
  });
  return { receipt, bus };
}

/** The last `n` lines of a file (a long one is read from near its end: its first, cut line is left out). */
function tailOf(file: string, n: number): { lines: string[] } | { why: string } {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === 'ENOENT' ? 'it has no log file (it printed nothing, or never started)' : `its log could not be read (${code ?? 'error'})` };
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const got = readSync(fd, buf, 0, buf.length, from);
    const lines = buf.subarray(0, got).toString('utf8').split(/\r\n|\n|\r/);
    if (lines.at(-1) === '') lines.pop();
    if (from > 0) lines.shift();
    return { lines: lines.slice(-n) };
  } catch (e) {
    return { why: `its log could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    closeSync(fd);
  }
}

// R7 (H150; H148's N5): the one table's words (src/contracts/stop-words.ts): a chat turn's cancelled receipt is a turn
// "stopped"; any other, a job's among them, "cancelled" (before, every one was "stopped"). The receipt keeps its sealed status.
const receiptStatus = (r: Pick<Receipt, 'status' | 'kind' | 'subject'>): LogEvent['status'] => {
  const s = r.status;
  return s === 'failed' ? { word: 'failed', tone: 'failure' } : s === 'denied' ? { word: 'denied', tone: 'failure' }
    : s === 'cancelled' ? { word: chatTurnOf(r) ? TURN_STOPPED : JOB_CANCELLED, tone: 'text' } : s === 'surfaced' ? { word: 'surfaced', tone: 'quiet' } : { word: 'sealed', tone: 'text' };
};

const opStatus = (s: OperationRecord['state']): LogEvent['status'] => (
  s === 'failed' || s === 'refused' || s === 'interrupted' ? { word: s, tone: 'failure' } : s === 'differs' ? { word: s, tone: 'attention' } : { word: s, tone: 'text' });

const compact = (o: unknown): string => { try { return JSON.stringify(o) ?? ''; } catch { return ''; } };

/** A bus event's payload in a few words: its own words where it has them, else its fields. */
function busWords(kind: string, payload: unknown): string {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const said = [p.subject, p.words, p.message, p.command, p.path, p.status].find(str);
  return said ?? (Object.keys(p).length ? compact(p) : kind);
}

/**
 * The tab's reading: the chain verified (verifyChain), the project's receipts, operations, jobs and the store's other events
 * as one log, the operations and jobs those rows name, and the ends of their logs. Reads files only.
 */
export function readLogs(i: LogsReadInput): LogsData {
  const env = i.env ?? process.env;
  const root = i.root;
  const now = i.now ?? Date.now();
  const id = projectId(root);
  const scrub = scrubFor(root, env);
  const notes: string[] = [];
  // the store this project's seals go to: TIMMY_STORE when it is set, else the project's own (state.ts chainOf)
  const dir = env.TIMMY_STORE ? undefined : root;
  const file = receiptsPath('runs', dir);
  const store = shownPath(file, root, env);
  let chain: ChainCheck;
  try {
    chain = chainCheckOf(verifyChain('runs', dir), store);
  } catch (e) {
    chain = { state: 'unreadable', count: 0, current: { epoch: 1, count: 0 }, epochs: 0, incidents: [], reason: e instanceof Error ? e.message : String(e), store };
  }
  let receipts: Receipt[] = [];
  try { receipts = readChain('runs', dir); } catch (e) { notes.push(`The receipts could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  const seq = new Map(receipts.map((r, n) => [r.hash, n + 1] as const));
  const lines = storeLines(file);
  const busFile = busPath(dir);
  const busLines = busFile === file ? lines.bus : storeLines(busFile).bus;

  // this project's operations (their ids from the folder; the newest 40 read whole) and jobs
  const opIds = new Set<string>();
  try { for (const n of readdirSync(join(root, '.timmy', 'operations'))) if (/^o[0-9a-f]{8}\.json$/.test(n)) opIds.add(n.slice(0, -5)); } catch { /* none yet */ }
  const listed = listOperationRecords(root, 40);
  for (const u of listed.unreadable) notes.push(`${u.rel} could not be read: ${u.error}`);
  const records = new Map(listed.list.map((x) => [x.record.id, x.record] as const));
  let jobRecords: readonly JobRecord[] = i.records ?? [];
  if (!i.records) {
    try { jobRecords = new JobManager({ dir: join(i.home, 'jobs') }).list(); } catch (e) { notes.push(`The job records could not be read: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const rows = readJobs(jobRecords, root, { mine: new Set(), chain: receipts });
  const recordOf = new Map(jobRecords.map((r) => [r.id, r] as const));
  const jobIds = new Set(rows.map((r) => r.id));

  // the store is the project's own (not shared): its every receipt is this project's
  let own = false;
  if (dir) { try { own = realpathSync(join(root, '.timmy', 'receipts')) === realpathSync(join(file, '..')); } catch { own = false; } }
  const ours = (r: Receipt): boolean => own || r.project_id === id || (str(r.operation_id) && opIds.has(r.operation_id)) || (!!r.job && jobIds.has(r.job.id));

  const all: LogEvent[] = [];
  let foreign = 0;
  // the receipts, from the newest (a long chain: the newest LOG_MAX of this project's)
  let taken = 0;
  for (let n = receipts.length - 1; n >= 0 && taken < LOG_MAX; n -= 1) {
    const r = receipts[n];
    if (!ours(r)) { foreign += 1; continue; }
    taken += 1;
    const line = lines.receipt.get(r.hash);
    all.push({
      // R7 (H150; H148's N5): a stopped turn's subject in the table's words ("repl · stopped (asked from …)", never "cancelled")
      key: `rc:${r.hash.slice(7, 23)}`, source: 'receipt', at: r.ts, seq: n + 1, tag: r.kind || 'receipt', summary: scrub(receiptSubjectWords(r)),
      status: receiptStatus(r), ...(str(r.operation_id) ? { operation: r.operation_id } : {}), ...(r.job?.id ? { job: r.job.id } : {}), hash: r.hash,
      raw: { where: line ? `${store}:${line.n}` : store, text: scrub(line?.text ?? compact(r)).slice(0, RAW_MAX) },
    });
  }
  // the operations, one row each at their latest time (its end, else its start)
  for (const { record: o, rel } of listed.list) {
    all.push({
      key: `op:${o.id}`, source: 'operation', at: o.ended ?? o.started, tag: 'operation', summary: scrub(o.request), status: opStatus(o.state), operation: o.id,
      raw: { where: rel, text: scrub(compact(o)).slice(0, RAW_MAX) },
    });
  }
  // the jobs' events: each job's start, each block's start and end, and its end (src/workbench/state.ts jobEvents' names)
  for (const j of rows.slice(0, 24)) {
    const rec = recordOf.get(j.id);
    const where = rec ? shownPath(join(rec.logPath, '..', `${j.id}.json`), root, env) : `job ${j.id}`;
    const op = j.operation ? { operation: j.operation } : {};
    all.push({ key: `job:${j.id}:start`, source: 'job', at: j.startedAt, tag: 'job.start', summary: scrub(`${j.id} ${j.label}`), status: { word: j.live ? 'running' : 'started', tone: 'quiet' }, job: j.id, ...op, raw: { where, text: scrub(compact({ id: j.id, kind: j.kind, label: j.label, startedAt: j.startedAt, operation: j.operation })) } });
    j.steps.forEach((s, k) => {
      if (s.startedAt) all.push({ key: `job:${j.id}:s${k}:start`, source: 'job', at: s.startedAt, tag: 'job.step', summary: scrub(`${j.id} ${s.name}`), status: { word: 'started', tone: 'quiet' }, job: j.id, ...op, raw: { where, text: scrub(compact(s)) } });
      if (s.endedAt) {
        const word = s.outcome ?? s.state;
        all.push({
          key: `job:${j.id}:s${k}:end`, source: 'job', at: s.endedAt, tag: 'job.step', summary: scrub(`${j.id} ${s.name}${s.code !== undefined ? ` (exit ${s.code})` : ''}`),
          status: { word, tone: s.state === 'failed' && !s.outcome ? 'failure' : s.state === 'interrupted' ? 'attention' : 'text' }, job: j.id, ...op, raw: { where, text: scrub(compact(s)) },
        });
      }
    });
    if (j.endedAt) {
      all.push({
        key: `job:${j.id}:end`, source: 'job', at: j.endedAt, tag: 'job.end', summary: scrub(`${j.id} ${j.label}${j.blocks ? `: ${j.blocks}` : ''}${j.error ? `: ${j.error}` : ''}`),
        status: { word: j.word, tone: j.mark === 'failed' ? 'failure' : j.mark === 'unknown' ? 'attention' : 'text' }, job: j.id, ...op,
        raw: { where, text: scrub(compact({ state: j.state, endedAt: j.endedAt, exitCode: j.exitCode, error: j.error, receipt: j.receipt })) },
      });
    }
  }
  // the store's other events (`timmy events`); a receipt's own "receipt.sealed" is its receipt row above. A shared store's events
  // are listed only when they name this project
  let busTaken = 0;
  for (let n = busLines.length - 1; n >= 0 && busTaken < LOG_MAX; n -= 1) {
    const b = busLines[n];
    if (b.ev.kind === 'receipt.sealed') continue;
    const p = b.ev.payload && typeof b.ev.payload === 'object' ? b.ev.payload as Record<string, unknown> : {};
    if (!own && p.project_id !== id && p.project !== root) continue;
    busTaken += 1;
    all.push({
      key: `bus:${b.n}`, source: 'bus', at: str(b.ev.ts) ? b.ev.ts : '', tag: b.ev.kind, summary: scrub(busWords(b.ev.kind, b.ev.payload)).slice(0, 400),
      status: b.ev.kind === 'approval.required' ? { word: 'waits on you', tone: 'attention' } : { word: str(p.status) ? p.status : '', tone: 'quiet' },
      ...(str(p.operation) ? { operation: p.operation } : {}),
      raw: { where: `${shownPath(busFile, root, env)}:${b.n}`, text: scrub(b.text).slice(0, RAW_MAX) },
    });
  }
  const time = (e: LogEvent): number => { const t = Date.parse(e.at); return Number.isFinite(t) ? t : 0; };
  all.sort((a, b) => time(b) - time(a) || (b.seq ?? 0) - (a.seq ?? 0) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const events = all.slice(0, LOG_MAX);

  // the operations and jobs the listed rows name
  const byOp = new Map<string, string[]>();
  for (const r of receipts) if (str(r.operation_id)) { const l = byOp.get(r.operation_id) ?? []; l.push(r.hash); byOp.set(r.operation_id, l); }
  const ops: Record<string, OpInfo> = {};
  for (const e of events) {
    const o = e.operation;
    if (!o || ops[o]) continue;
    let record = records.get(o) ?? null;
    let why: string | undefined;
    let unreadable = false;
    if (!record) {
      const read = readOperationRecord(root, o);
      if (read.ok) record = read.record;
      else { why = read.error; unreadable = !/^no record /.test(read.error); }
    }
    const runs = (record?.runs ?? []).filter((x) => x.kind === 'job').map((x) => x.id);
    const jobs = [...new Set([...rows.filter((j) => j.operation === o).map((j) => j.id), ...runs])];
    const other = (record?.runs ?? []).filter((x) => x.kind !== 'job').map((x) => ({ kind: x.kind, id: x.id }));
    ops[o] = { id: o, record, ...(why ? { why } : {}), ...(unreadable ? { unreadable } : {}), receipts: byOp.get(o) ?? [], jobs, runs: other };
  }
  // the fleet plans those operations ran, from the plans' own files
  const fleets: Record<string, FleetRun> = {};
  for (const o of Object.values(ops)) {
    for (const r of o.runs) {
      if (r.kind !== 'fleet' || fleets[r.id]) continue;
      const v = readFleetView(root, r.id);
      if (v) fleets[r.id] = { backend: v.backend, simulation: v.simulation, status: v.status, requested: v.counts.requested, delivered: v.counts.delivered, failed: v.counts.failed };
    }
  }
  const named = new Set<string>();
  for (const e of events) if (e.job) named.add(e.job);
  for (const o of Object.values(ops)) for (const j of o.jobs) named.add(j);
  const shownRows = rows.filter((j) => named.has(j.id));
  const jobs: Record<string, JobInfo> = {};
  shownRows.forEach((j, n) => {
    const rec = recordOf.get(j.id);
    const tail: JobInfo['tail'] = !rec ? { why: 'its record was not read' }
      : n < TAIL_JOBS ? (() => { const t = tailOf(rec.logPath, TAIL_LINES); return 'lines' in t ? { lines: t.lines.map((l) => scrub(lineText(l))) } : t; })()
        : { why: `not read in this reading (the logs of the newest ${TAIL_JOBS} runs are)` };
    jobs[j.id] = { row: j, log: rec ? shownPath(rec.logPath, root, env) : `job ${j.id}`, lines: rec?.lines ?? 0, tail };
  });
  return { at: new Date(now).toISOString(), root, chain, receipts, seq, events, more: Math.max(0, all.length - events.length), foreign, ops, jobs, fleets, notes, checks: new Map() };
}

/**
 * Whether a receipt verifies where it stands, as verifyReceiptIn says against this reading's chain (its links and body hash
 * from its epoch's start, and its signature): asked the first time the receipt is shown, kept for this reading only.
 */
export function receiptVerdict(d: LogsData, hash: string): ReceiptVerdict {
  const had = d.checks.get(hash);
  if (had) return had;
  let v: ReceiptVerdict;
  try {
    const r = verifyReceiptIn(d.receipts, hash);
    v = r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (e) {
    v = { ok: false, reason: `it could not be checked: ${e instanceof Error ? e.message : String(e)}` };
  }
  d.checks.set(hash, v);
  return v;
}

// ── the items ──────────────────────────────────────────────────────────────────

/** The tab's selectable rows: a receipt, an operation, or another event (a job's, the bus's). */
export type LogsItem =
  | { kind: 'log-receipt'; key: string; event: LogEvent }
  | { kind: 'log-op'; key: string; event: LogEvent }
  | { kind: 'log-event'; key: string; event: LogEvent };

export const itemOfEvent = (e: LogEvent): LogsItem => (
  e.source === 'receipt' ? { kind: 'log-receipt', key: `log:${e.key}`, event: e }
    : e.source === 'operation' ? { kind: 'log-op', key: `log:${e.key}`, event: e } : { kind: 'log-event', key: `log:${e.key}`, event: e });

/** A row's name, for the Tools tab and Activity (src/workbench/views.ts itemName). */
export function logsItemName(item: LogsItem): string {
  const e = item.event;
  if (item.kind === 'log-receipt') return `receipt #${e.seq ?? '?'} ${e.tag}`;
  if (item.kind === 'log-op') return `operation ${e.operation ?? ''}`.trim();
  return `${e.tag} ${e.summary}`.trim();
}

// ── the view ───────────────────────────────────────────────────────────────────

const toneRole = (t: LogTone): Role => (t === 'failure' ? 'failure' : t === 'attention' ? 'attention' : t === 'quiet' ? 'secondary' : 'text');
const statusText = (s: LogEvent['status'], g: Glyphs): string => (s.tone === 'failure' ? `${g.fail} ${s.word}` : s.tone === 'attention' ? `${g.warn} ${s.word}` : s.word);

const VIA: Readonly<Record<string, string>> = { repl: 'the REPL', board: 'the board', act: 'timmy act', md: 'timmy md', workbench: 'the Workbench', fleet: 'timmy fleet' };

/**
 * One event as rows `w` cells wide (the reference's columns: seq, time, tag, summary, status): one row from 64 cells; two
 * below that (its words under it, its status on the first row from 40 cells, else on the second). The selected one has its
 * raw line under it. `linked`: it belongs to the selected row's operation (a quiet mark in the gutter says so).
 */
function eventRows(e: LogEvent, w: number, o: { selected: boolean; linked: boolean; seqW: number; g: Glyphs }): Line[] {
  const { g } = o;
  const sel = o.selected ? { selected: true } : {};
  const all = (l: Line): Line => (o.selected ? onBar(l) : l);
  const mark: Seg = o.selected ? S(`${g.cursor} `, 'accent', sel) : o.linked ? S(`${g.dot} `, 'secondary') : S('  ');
  const seq = e.seq !== undefined ? `#${e.seq}` : '';
  const status: Seg[] = e.status.word ? [S(statusText(e.status, g), toneRole(e.status.tone), sel)] : [];
  const out: Line[] = [];
  if (w >= 64) {
    const tagW = Math.min(16, Math.max(8, Math.floor(w * 0.16)));
    const left: Line = [mark, S(`${clock(e.at)} `, 'secondary', sel), S(`${seq.padEnd(o.seqW)}${o.seqW ? ' ' : ''}`, 'secondary', sel), S(`${cut(e.tag, tagW, g.ellipsis).padEnd(tagW)} `, 'strong', sel), S(e.summary, 'text', sel)];
    out.push(all(spread(left, status, w, g.ellipsis)));
    if (o.selected) out.push(fit([S('    raw ', 'secondary'), S(`${e.raw.where} `, 'secondary'), S(e.raw.text, 'secondary')], w, g.ellipsis));
    return out;
  }
  const head: Line = [mark, S(`${clock(e.at)} `, 'secondary', sel), ...(seq ? [S(`${seq} `, 'secondary', sel)] : []), S(e.tag, 'strong', sel)];
  const words: Line = [S('    ', 'text', sel), S(e.summary, 'text', sel)];
  if (w >= 40) out.push(all(spread(head, status, w, g.ellipsis)), all(fit(words, w, g.ellipsis)));
  else out.push(all(fit(head, w, g.ellipsis)), all(spread(words, status, w, g.ellipsis)));
  // a narrow column shows the raw line's words first; where it was read is in the Inspector
  if (o.selected) out.push(fit([S('    raw ', 'secondary'), S(e.raw.text, 'secondary')], w, g.ellipsis));
  return out;
}

/**
 * The chain line: the chain verified in this reading (green), or ✕ and why (amber), or no receipts yet. Its first part is
 * kept first (cut at its end when even it does not fit); the parts after it are each whole or left out, in their order.
 */
export function chainLine(ch: ChainCheck, g: Glyphs, w: number): Line {
  const n = (k: number): string => k.toLocaleString('en-US');
  const q = (t: string): Line => [S(t, 'secondary')];
  const sep = S(` ${g.sep} `, 'secondary');
  const epochs = q(ch.epochs > 1 ? `${ch.epochs} epochs` : `epoch ${ch.current.epoch}`);
  const line = (first: Line, rest: Line[]): Line => {
    const kept = pick(rest, w - lineCells(first) - 3, sep);
    return fit(kept.length ? [...first, sep, ...kept] : first, w, g.ellipsis);
  };
  switch (ch.state) {
    case 'verified':
      return line([S(`${g.ok} chain verified: ${n(ch.count)} receipt${ch.count === 1 ? '' : 's'}`, 'live')], [q('in this reading'), epochs, q('links and body hashes (verifyChain)'), q(ch.store)]);
    case 'partial':
      // the earlier epoch that does not verify is said with the current one's verification, never left out
      return line([
        S(`${g.ok} epoch ${ch.current.epoch} verified: ${n(ch.current.count)} receipt${ch.current.count === 1 ? '' : 's'}`, 'live'), sep,
        S(`${g.fail} ${ch.incidents.map((x) => `epoch ${x.epoch} does not verify: ${x.reason}`).join('; ')}`, 'failure'),
      ], [q('kept as incident evidence'), q('in this reading'), q(ch.store)]);
    case 'broken':
      return line([S(`${g.fail} chain does not verify: ${ch.reason ?? 'a link or a body hash does not match'}`, 'failure')], [q(`${n(ch.count)} receipts read`), epochs, q(ch.store)]);
    case 'unreadable':
      return line([S(`${g.fail} the chain could not be read: ${ch.reason ?? 'unknown'}`, 'failure')], [q(ch.store)]);
    default:
      return line([S('no receipts yet', 'text')], [q(`nothing is sealed in ${ch.store}`), q('a run seals its receipts there')]);
  }
}

/** One stage of an operation's sequence: its label, how its card is drawn, its words, and its receipt when it has one. */
export interface Stage {
  name: 'intent' | 'predict' | 'run' | 'receipt';
  label: string;
  /** the card's edge and its label: amber for .intent and .predict, green for a verified receipt, amber ✕ for what failed,
   *  grey for structure, quiet for what is not recorded */
  role: Role;
  note?: string;
  rows: Line[];
  hash?: string;
}

const PREDICT = (k: string): boolean => k === 'predict' || k.endsWith('.predict') || k.endsWith('-prediction');

/** A receipt's verdict: its mark and word first, a segment of their own (kept whole where its reason is cut), then why. */
function verdictRow(v: ReceiptVerdict, g: Glyphs): Line {
  return v.ok
    ? [S(`${g.ok} verified`, 'live'), S(': link, body hash and signature (verifyReceiptIn, this reading)', 'secondary')]
    : [S(`${g.fail} does not verify`, 'failure'), S(`: ${v.reason}`, 'failure')];
}

/** The operation's four stages, from its record, its receipts and its jobs: what no record says is "not recorded". */
export function stagesOf(d: LogsData, opId: string, g: Glyphs): Stage[] {
  const op = d.ops[opId];
  const byHash = new Map(d.receipts.map((r) => [r.hash, r] as const));
  const mine = (op?.receipts ?? []).map((h) => byHash.get(h)).filter((r): r is Receipt => !!r);
  const notRecorded = (name: Stage['name'], label: string, why: string): Stage => ({ name, label, role: 'secondary', rows: [[S('not recorded', 'secondary')], [S(why, 'secondary')]] });
  const job = op?.jobs.map((j) => d.jobs[j]).find((x) => !!x);
  const started = job ? Date.parse(job.row.startedAt) : Number.NaN;
  // .intent: the operation's request, from its record
  const intent: Stage = op?.record
    ? { name: 'intent', label: '.intent', role: 'accent', note: opId, rows: [[S(op.record.request, 'text')], [S(`${VIA[op.record.via] ?? op.record.via} ${g.sep} ${clock(op.record.started)}`, 'secondary')]] }
    : op?.unreadable
      ? { name: 'intent', label: '.intent', role: 'failure', note: opId, rows: [[S(`${g.fail} its record could not be read`, 'failure')], [S(op.why ?? '', 'secondary')]] }
      : notRecorded('intent', '.intent', `no .timmy/operations/${opId}.json in this project`);
  // .predict: the prediction sealed for it
  const p = [...mine].reverse().find((r) => PREDICT(r.kind));
  let predict: Stage;
  if (!p) predict = notRecorded('predict', '.predict', 'no prediction is sealed for this operation');
  else {
    // first what matters most (rows are left out from the end where a card has little room): sealed before the run or not,
    // whether it verifies, then what it predicted
    const at = Date.parse(p.ts);
    const order: Line = Number.isFinite(started) && Number.isFinite(at)
      ? (at <= started ? [S('sealed before the run started', 'text')] : [S(`${g.fail} sealed after the run started`, 'failure')]) : [S(`sealed ${clock(p.ts)}`, 'text')];
    const what = p.prediction ? `${p.prediction.doc} › ${p.prediction.block}: ${p.prediction.order.join(` ${g.arrow} `)}`
      : p.fleet ? `${p.fleet.workers} workers, ${p.fleet.isolation} on ${p.fleet.backend}${p.fleet.simulation ? ' (simulation)' : ''}` : p.subject;
    predict = {
      name: 'predict', label: '.predict', role: 'accent', note: `#${d.seq.get(p.hash) ?? '?'}`, hash: p.hash,
      rows: [order, verdictRow(receiptVerdict(d, p.hash), g), [S(what, 'text')]],
    };
  }
  // sandbox / run: its job (upmd or another runner on this computer; a sandbox only when a record names one), its fleet
  // plan (as the plan's files say it, else as its receipts do), or the other runs its record names
  let run: Stage;
  const box = mine.find((r) => r.openhands)?.openhands;
  const fleet = [...mine].reverse().find((r) => r.fleet)?.fleet;
  const planId = op?.runs.find((r) => r.kind === 'fleet')?.id;
  const plan = planId ? d.fleets[planId] : undefined;
  if (job) {
    const j = job.row;
    const runner = j.kind === 'workflow' ? 'upmd' : `a ${j.kind} job`;
    const failed = j.mark === 'failed';
    run = {
      name: 'run', label: 'sandbox / run', role: failed ? 'failure' : 'border', note: j.id,
      rows: [
        [S(j.label, 'text')],
        [S(failed ? `${g.fail} ${j.word}` : j.word, failed ? 'failure' : 'text'), S(` ${g.sep} ${j.live ? `running ${j.elapsed}` : `took ${j.elapsed}`}${j.exitCode !== undefined && j.exitCode !== null ? ` ${g.sep} exit ${j.exitCode}` : ''}`, 'secondary')],
        [S(box ? `sandbox: container ${box.container} (${box.image})` : `sandbox: none recorded; ${runner} ran it on this computer`, 'secondary')],
      ],
    };
  } else if (planId && plan) {
    run = {
      name: 'run', label: 'sandbox / run', role: plan.failed ? 'failure' : 'border',
      rows: [
        [S(`fleet ${planId} ${g.sep} ${plan.simulation ? `${plan.backend} (simulation)` : plan.backend}`, 'text')],
        [S(plan.status, 'text'), S(` ${g.sep} ${plan.delivered} of ${plan.requested} done (not verified)${plan.failed ? `, ${plan.failed} failed` : ''}`, plan.failed ? 'failure' : 'secondary')],
      ],
    };
  } else if (fleet) {
    run = {
      name: 'run', label: 'sandbox / run', role: 'border',
      rows: [[S(`fleet ${fleet.plan} ${g.sep} ${fleet.simulation ? `${fleet.backend} (simulation)` : fleet.backend}`, 'text')], [S(`${fleet.workers} workers, ${fleet.isolation}${fleet.status ? ` ${g.sep} ${fleet.status}` : ''}`, 'secondary')]],
    };
  } else if (op?.runs.length) {
    run = {
      name: 'run', label: 'sandbox / run', role: 'border',
      rows: [[S(op.runs.slice(0, 3).map((r) => `${r.kind} ${r.id}`).join(` ${g.sep} `), 'text')], [S('as its operation record names it; its own record is not read here', 'secondary')]],
    };
  } else run = notRecorded('run', 'sandbox / run', 'no job or run of this operation is recorded');
  // .receipt: the operation's own receipt (its run's), green only when verifyReceiptIn confirms it now
  const own = [...mine].reverse().find((r) => r.kind === 'workflow' || r.kind === 'fleet.run') ?? [...mine].reverse().find((r) => !PREDICT(r.kind));
  let receipt: Stage;
  if (!own) {
    receipt = job?.row.live
      ? { name: 'receipt', label: '.receipt', role: 'secondary', rows: [[S('not sealed yet: it runs', 'secondary')]] }
      : notRecorded('receipt', '.receipt', 'no receipt of this operation is sealed');
  } else {
    const v = receiptVerdict(d, own.hash);
    const st = receiptStatus(own);
    receipt = {
      name: 'receipt', label: '.receipt', role: v.ok ? 'live' : 'failure', note: `#${d.seq.get(own.hash) ?? '?'}`, hash: own.hash,
      rows: [[S(`${own.kind} `, 'text'), S(statusText(st, g), toneRole(st.tone)), S(` ${g.sep} ${clock(own.ts)}`, 'secondary')], verdictRow(v, g), [S(receiptSubjectWords(own), 'text')]],
    };
  }
  return [intent, predict, run, receipt];
}

/** The stages as cards `w` cells wide (the selected row's receipt drawn heavy), each with its first rows only when room is short. */
function stageCards(stages: readonly Stage[], w: number, room: number, selHash: string | undefined, g: Glyphs): Line[] {
  // as many rows of each as fit: three, then two, then one
  for (const per of [3, 2, 1]) {
    const need = stages.reduce((n, s) => n + 2 + Math.min(per, s.rows.length), 0);
    if (need <= room || per === 1) {
      return stages.flatMap((s) => card({
        w, g, title: [S(s.label, s.role === 'secondary' ? 'secondary' : s.role, { bold: s.role !== 'secondary' })], ...(s.note ? { note: [S(s.note, 'secondary')] } : {}),
        body: s.rows.slice(0, per), edge: s.role === 'secondary' ? 'border' : s.role, heavy: !!selHash && s.hash === selHash,
      }));
    }
  }
  return [];
}

/** The stages as one row each (the stacked layout): the label in its role, then its words (the operation's id is the
 *  heading's, so .intent's note is left out). */
function stageLines(stages: readonly Stage[], w: number, g: Glyphs): Line[] {
  return stages.map((s) => {
    const words = s.rows.slice(0, 3).flatMap((r, i) => (i ? [S(` ${g.sep} `, 'secondary'), ...r] : r));
    const note = s.note && s.name !== 'intent' ? [S(`${s.note} `, 'secondary')] : [];
    return fit([S(`  ${s.label.padEnd(14)}`, s.role === 'border' ? 'strong' : s.role, { bold: s.role !== 'secondary' }), ...note, ...words], w, g.ellipsis);
  });
}

/** The selected row's job: the one it names, else its operation's newest. */
function jobOfEvent(d: LogsData, e: LogEvent | undefined): JobInfo | undefined {
  if (!e) return undefined;
  if (e.job && d.jobs[e.job]) return d.jobs[e.job];
  const op = e.operation ? d.ops[e.operation] : undefined;
  return op?.jobs.map((j) => d.jobs[j]).find((x) => !!x);
}

/** The raw output column: the run's log's last lines, each cut at `w`; why when there are none. */
function rawRows(d: LogsData, e: LogEvent | undefined, w: number, room: number, g: Glyphs): { head: Line; rows: Line[] } {
  const job = jobOfEvent(d, e);
  if (!e) return { head: [heading('Raw output')], rows: [[S('No row is selected.', 'secondary')]] };
  if (!job) return { head: [heading('Raw output')], rows: para(e.job ? `${e.job}: its record is not among this project's jobs read here.` : 'This row names no run: there is no output to show.', w) };
  const t = job.tail;
  if (!('lines' in t)) return { head: [heading('Raw output'), S(` ${g.sep} ${job.row.id}`, 'secondary')], rows: para(`${job.row.id}: ${t.why}.`, w) };
  // the heading's parts each whole or left out; where the log's name does not fit beside it, it is the first row
  const file: Line = [S(job.log.split('/').pop() ?? job.log, 'secondary')];
  const count = (k: number): Line => [S(`last ${k}${job.lines ? ` of ${job.lines}` : ''}`, 'secondary')];
  const sep = S(` ${g.sep} `, 'secondary');
  const named = (k: number): { head: Line; sub: Line[] } => {
    const head = pick([[heading('Raw output')], file, count(k)], w, sep);
    return head.includes(file[0]) ? { head, sub: [] } : { head, sub: [pick([file, count(k)], w, sep)] };
  };
  const shown = t.lines.slice(-Math.max(1, room - named(t.lines.length).sub.length));
  const { head, sub } = named(shown.length);
  if (!shown.length) return { head, rows: [...sub, [S(`${job.row.id} printed nothing${job.row.live ? ' yet' : ''}.`, 'secondary')]] };
  return { head, rows: [...sub, ...shown.map((l) => [S(l || ' ', 'text')])] };
}

/** The sequence column's heading: the operation and its state, or that the row names none. */
function opHead(d: LogsData, e: LogEvent | undefined, g: Glyphs): Line {
  const o = e?.operation;
  if (!o) return [heading('Operation')];
  const rec = d.ops[o]?.record;
  return [heading('Operation'), S(` ${o}`, 'strong'), ...(rec ? [S(` ${g.sep} `, 'secondary'), S(statusText(opStatus(rec.state), g), toneRole(opStatus(rec.state).tone))] : [])];
}

/**
 * Tab 0's body: the chain line, then (a) the event log, (b) the selected row's operation as cards and (c) its run's raw
 * output, side by side from 120 columns and stacked below; every row at most `c.width` cells. The items are the log's rows,
 * in its order at every size (only where they are drawn changes): a row out of view has line -1.
 */
export function logsView(c: TabCtx, d: LogsData | undefined): TabView<LogsItem> {
  const { g, width: W, height: H } = c;
  if (!d) return { lines: [fit([S('Reading the log and the receipt chain…', 'secondary')], W, g.ellipsis)], items: [] };
  const all = d.events.map(itemOfEvent);
  const sel = selectedIn(c.ui, LOGS_LIST, all.length);
  const e = sel >= 0 ? all[sel].event : undefined;
  const lines: Line[] = [chainLine(d.chain, g, W)];
  const items: TabView<LogsItem>['items'] = all.map((item) => ({ line: -1, item }));
  const seqW = Math.max(0, ...d.events.filter((x) => x.seq !== undefined).map((x) => `#${x.seq}`.length));
  const emptyRows = (w: number): Line[] => para('Nothing is recorded in this project yet. A run fills this log: /run <document> <block> in the REPL (its operation, its job and its receipts appear here).', w);
  // the event log in `w` cells under its heading, windowed to `room` rows around the selection; items placed from row `top`
  const logBlock = (w: number, room: number, top: number): Line[] => {
    const n = d.events.length;
    const head = (note: string): Line => {
      const full: Line = [heading('Event log'), S(` ${g.sep} newest first`, 'secondary')];
      return spread(lineCells(full) + 1 + note.length <= w ? full : [heading('Event log')], note ? [S(note, 'secondary')] : [], w, g.ellipsis);
    };
    if (!n) return [head(''), ...emptyRows(w)];
    const blocks = d.events.map((x, i) => eventRows(x, w, { selected: i === sel, linked: i !== sel && !!e?.operation && x.operation === e.operation, seqW, g }));
    const win = windowBlocks(blocks.map((b) => b.length), sel, room);
    const out: Line[] = [];
    for (let i = win.start; i < win.end; i++) {
      items[i] = { line: top + out.length, item: all[i], ...(blocks[i].length > 1 ? { rows: blocks[i].length } : {}) };
      out.push(...blocks[i]);
    }
    const range = win.start > 0 || win.end < n ? `${win.start + 1}–${win.end} of ${n}` : `${n}`;
    return [head(`${range}${d.more ? ` (the newest of ${n + d.more} read)` : ''}`), ...out.slice(0, room)];
  };
  const stages = e?.operation ? stagesOf(d, e.operation, g) : null;
  const noOp = (w: number): Line[] => para(e ? 'This row names no operation: there is no sequence to show.' : 'No row is selected.', w);
  const selHash = e?.hash;

  if (sideBySideAt(c)) {
    // (a) | (b) | (c), under the chain line and a row of air
    const air = H >= 10 ? 1 : 0;
    if (air) lines.push([]);
    const room = Math.max(1, H - lines.length);
    const [wa, wb, wc] = widths(W - 2 * RULE_CELLS, [38, 34, 28], 14);
    // the log's heading is the columns' first row; its rows start under it
    const colA: Line[] = logBlock(wa, room - 1, lines.length + 1);
    const colB: Line[] = [opHead(d, e, g), ...(stages ? stageCards(stages, wb, room - 1, selHash, g) : noOp(wb))];
    // the run's output as text, then what a terminal cannot draw of it and where it is seen
    const note = previewNote(wc, g, LOGS_NONE, LOGS_C);
    const raw = rawRows(d, e, wc, Math.max(1, room - 1 - note.length), g);
    const colC: Line[] = [raw.head, ...raw.rows, ...note];
    lines.push(...sideBySide([
      { w: wa, lines: rowsOf(colA, wa, room, g.ellipsis) }, { w: wb, lines: clipRows(colB, wb, room, g) }, { w: wc, lines: clipRows(colC, wc, room, g) },
    ], room, g));
    return { lines, items };
  }

  // stacked: (a), then (b), then (c), each in its share of the rows; each says which of its rows show
  const note = previewNote(W, g, LOGS_NONE, LOGS_C);
  const fixed = 1 + 1 + (stages ? 4 : 1) + 1 + note.length;
  const rest = Math.max(2, H - lines.length - fixed);
  const logRoom = Math.max(2, Math.ceil(rest * 0.6));
  const rawRoom = Math.max(1, rest - logRoom);
  lines.push(...logBlock(W, logRoom, lines.length + 1));
  lines.push(fit(opHead(d, e, g), W, g.ellipsis));
  lines.push(...(stages ? stageLines(stages, W, g) : noOp(W).slice(0, 1)));
  const raw = rawRows(d, e, W - 4, rawRoom, g);
  lines.push(fit(raw.head, W, g.ellipsis));
  lines.push(...raw.rows.slice(0, rawRoom).map((l) => fit([S('    '), ...l], W, g.ellipsis)));
  lines.push(...note);
  return { lines: lines.slice(0, Math.max(1, H)).map((l) => (lineCells(l) > W ? fit(l, W, g.ellipsis) : l)), items: items.map((x) => (x.line >= H ? { ...x, line: -1 } : x)) };
}

// ── the Inspector ──────────────────────────────────────────────────────────────

/** The Inspector's rows for a selected row of the log: what it is, every field its record has, and its raw line whole. */
export function logsDetail(item: LogsItem, d: LogsData | undefined, w: number, g: Glyphs): Line[] {
  const e = item.event;
  const out: Line[] = [];
  const f = (label: string, value: string, role: Role = 'text'): void => { out.push(...fieldRows(label, value, w, role)); };
  if (item.kind === 'log-receipt') {
    const r = d?.receipts.find((x) => x.hash === e.hash);
    out.push([heading('Receipt')]);
    f('Place', `#${e.seq ?? '?'} on the chain${d ? ` (${d.chain.store})` : ''}`);
    f('Kind', e.tag, 'strong');
    f('Subject', e.summary);
    f('Sealed', clock(e.at));
    f('Status', statusText(e.status, g), toneRole(e.status.tone));
    f('Operation', e.operation ?? 'none recorded');
    if (e.job) f('Job', e.job);
    if (r) {
      f('Hash', r.hash.slice(7, 23));
      f('Links to', r.prev_hash.startsWith('sha256_') ? r.prev_hash.slice(7, 23) : r.prev_hash);
      f('Epoch', String(r.epoch ?? 1));
      f('Signed', r.signature ? 'yes: an ed25519 signature is on it' : 'no signature on it');
      f('Cost', formatCostUsd(r));
      const v = d ? receiptVerdict(d, r.hash) : null;
      if (v?.ok) {
        out.push([S(`${'Verified'.padEnd(10)} `, 'secondary'), S(`${g.ok} verified`, 'live')]);
        out.push(...para('its link and body hash from its epoch\'s start, and its signature, against this reading\'s chain (verifyReceiptIn)', w, 'secondary', ' '.repeat(11)));
      } else if (v) out.push(...fieldRows('Verified', `${g.fail} does not verify: ${v.reason}`, w, 'failure'));
    } else out.push(...para('Its receipt is not on the chain as read in this reading.', w, 'attention'));
  } else if (item.kind === 'log-op') {
    const op = e.operation ? d?.ops[e.operation] : undefined;
    const rec = op?.record;
    out.push([heading('Operation')]);
    f('Id', e.operation ?? '?', 'strong');
    if (rec) {
      f('Request', rec.request);
      f('From', VIA[rec.via] ?? rec.via);
      f('State', statusText(opStatus(rec.state), g), toneRole(opStatus(rec.state).tone));
      if (rec.why) f('Why', rec.why);
      f('Started', clock(rec.started));
      f('Ended', rec.ended ? clock(rec.ended) : 'not yet');
      if (rec.parent) f('Continues', rec.parent);
      f('Runs', rec.runs.length ? rec.runs.map((x) => `${x.kind} ${x.id}`).join(', ') : 'none recorded');
    } else f('Record', op?.why ?? 'not recorded', op?.unreadable ? 'failure' : 'secondary');
    f('Receipts', op ? String(op.receipts.length) : 'not read');
  } else {
    out.push([heading(e.source === 'bus' ? 'Event (the store\'s bus)' : 'Event')]);
    f('Name', e.tag, 'strong');
    f('When', clock(e.at));
    f('Words', e.summary);
    if (e.status.word) f('Status', statusText(e.status, g), toneRole(e.status.tone));
    if (e.job) f('Job', e.job);
    f('Operation', e.operation ?? 'none recorded');
  }
  out.push([]);
  out.push([heading('Raw'), S(` ${g.sep} ${e.raw.where}`, 'secondary')]);
  out.push(...para(e.raw.text, w, 'text', '  '));
  if (e.raw.text.length >= RAW_MAX) out.push(...para(`(its first ${RAW_MAX.toLocaleString('en-US')} characters; the whole line is in ${e.raw.where})`, w, 'secondary', '  '));
  return out;
}
