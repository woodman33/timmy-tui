/**
 * Round R4 (H51): operations, one request each (a command typed in the REPL, a live-board action, a `timmy act` call),
 * and their records: .timmy/operations/<id>.json, schema timmy.operation/1. A record holds the request (the typed line,
 * with the project's folder written as "." and the home folder as "~"), when it started and ended, its state in words
 * and why, the operation it continues (`parent`, or null), the runs it started, and the process that writes it (its pid
 * and start, so a record left "running" by a Timmy that ended is told apart, by src/ops/process-proof.ts).
 *
 * A request gets an id at once (src/ops/context.ts carries it); its record is written once it starts something or seals a
 * receipt (a listing or /help leaves none), and always for `timmy act`, whose caller is told the id. A `timmy act` started
 * with TIMMY_OPERATION set to an operation this project holds, still running, joins it: everything it makes carries that
 * id, and the record stays its first process's; it follows only its own runs (for its exit code). An id it cannot join
 * (no record here, or one that has ended) is the `parent` of a new operation, the one it continues.
 *
 * The OperationLog follows this process's operations: the runs each starts (noted through the context), until its
 * request has returned and none of them runs; then it ends, its state decided by its runs' own records (src/ops/outcome
 * words in the Workspace). Nothing here reads another process's runs: the operation card does (src/ops/card.ts).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inOperation, newOperationId, OPERATION_ID, openScope, type OperationRunKind, type OperationScope } from './context.js';
import { THIS_PROCESS, writerState } from './process-proof.js';

export const OPERATIONS_DIR = '.timmy/operations';
export const OPERATION_SCHEMA = 'timmy.operation/1';
export const operationRel = (id: string): string => `${OPERATIONS_DIR}/${id}.json`;
/** A record is a few hundred bytes; anything past this is not one. */
const MAX_RECORD_BYTES = 256 * 1024;
/** How many runs a record lists (the rest are counted). */
const MAX_RUNS = 200;

export type OperationVia = 'repl' | 'board' | 'act';
/** An operation's state, in words: running, then how it ended. */
export type OperationState = 'running' | 'succeeded' | 'failed' | 'differs' | 'stopped' | 'refused' | 'answered';
export const OPERATION_STATES: readonly OperationState[] = ['running', 'succeeded', 'failed', 'differs', 'stopped', 'refused', 'answered'];

export interface OperationRun { kind: OperationRunKind; id: string; at: string }

export interface OperationRecord {
  schema: typeof OPERATION_SCHEMA;
  id: string;
  /** the typed line (a board action: the command it ran as), the project's folder as "." and the home folder as "~" */
  request: string;
  via: OperationVia;
  project: string;
  started: string;
  ended: string | null;
  state: OperationState;
  /** why it ended so, in a sentence; absent while it runs */
  why?: string;
  /** the operation it continues (an id it could not join), or null */
  parent: string | null;
  /** the runs it started in the process that began it, oldest first */
  runs: OperationRun[];
  /** how many runs were left off `runs` */
  more_runs?: number;
  /** the process that began it and writes this record */
  owner: { pid: number; started: string };
}

/** How one run ended, by its own record: its state, a few words, and the runs its record names (as `kind:id`). */
export interface RunOutcome {
  state: 'running' | 'succeeded' | 'failed' | 'differs' | 'stopped' | 'refused' | 'unknown';
  words: string;
  claims?: string[];
}

// ── the records ───────────────────────────────────────────────────────────────

/** The folder checked: inside the project, through no link. */
function folderInside(root: string, rel: string): { ok: true; abs: string } | { ok: false; error: string } {
  let real: string;
  try { real = fs.realpathSync(root); } catch { return { ok: false, error: 'the project folder is gone' }; }
  let at = real;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    try { if (fs.lstatSync(at).isSymbolicLink()) return { ok: false, error: `${path.relative(real, at).split(path.sep).join('/')} is a symbolic link; Timmy writes its records only in place` }; } catch { break; }
  }
  return { ok: true, abs: path.join(real, rel) };
}

/** Writes a record through a temporary file renamed over it, never through a link. */
export function writeOperationRecord(root: string, rec: OperationRecord): { ok: true; rel: string } | { ok: false; error: string } {
  const dir = folderInside(root, OPERATIONS_DIR);
  if (!dir.ok) return dir;
  try {
    fs.mkdirSync(dir.abs, { recursive: true });
    const abs = path.join(dir.abs, `${rec.id}.json`);
    try { if (fs.lstatSync(abs).isSymbolicLink()) return { ok: false, error: `${operationRel(rec.id)} is a symbolic link; it was left as it is` }; } catch { /* absent */ }
    const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, abs);
    return { ok: true, rel: operationRel(rec.id) };
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException).code ? `${(e as NodeJS.ErrnoException).code} in ${OPERATIONS_DIR}` : e instanceof Error ? e.message : String(e) };
  }
}

const str = (v: unknown): v is string => typeof v === 'string';

/** A record as read: checked field by field; anything malformed is named, never filled in. */
export function parseOperationRecord(raw: unknown, id?: string): { ok: true; record: OperationRecord } | { ok: false; error: string } {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!r) return { ok: false, error: 'not a JSON object' };
  if (r.schema !== OPERATION_SCHEMA) return { ok: false, error: `its schema is not ${OPERATION_SCHEMA}` };
  if (!str(r.id) || !OPERATION_ID.test(r.id) || (id && r.id !== id)) return { ok: false, error: 'its id is not this operation\'s' };
  if (!str(r.request) || !str(r.project) || !str(r.started) || !(r.ended === null || str(r.ended))) return { ok: false, error: 'its request, project or times are missing' };
  if (!str(r.state) || !OPERATION_STATES.includes(r.state as OperationState)) return { ok: false, error: `its state ${JSON.stringify(r.state)} is not one Timmy writes` };
  if (r.via !== 'repl' && r.via !== 'board' && r.via !== 'act') return { ok: false, error: 'it does not say where its request came from' };
  if (!(r.parent === null || (str(r.parent) && OPERATION_ID.test(r.parent)))) return { ok: false, error: 'its parent is not an operation id' };
  const runs = Array.isArray(r.runs) ? r.runs.filter((x): x is OperationRun => !!x && typeof x === 'object' && str((x as OperationRun).kind) && str((x as OperationRun).id)) : [];
  const owner = r.owner && typeof r.owner === 'object' ? r.owner as Record<string, unknown> : {};
  return {
    ok: true,
    record: {
      schema: OPERATION_SCHEMA, id: r.id, request: r.request, via: r.via, project: r.project, started: r.started, ended: r.ended as string | null,
      state: r.state as OperationState, ...(str(r.why) ? { why: r.why } : {}), parent: r.parent as string | null, runs: runs.map((x) => ({ kind: x.kind, id: x.id, at: str(x.at) ? x.at : '' })),
      ...(typeof r.more_runs === 'number' ? { more_runs: r.more_runs } : {}),
      owner: { pid: typeof owner.pid === 'number' ? owner.pid : 0, started: str(owner.started) ? owner.started : '' },
    },
  };
}

/** One record by id, or why it cannot be read. */
export function readOperationRecord(root: string, id: string): { ok: true; record: OperationRecord; rel: string } | { ok: false; rel: string; error: string } {
  const rel = operationRel(id);
  if (!OPERATION_ID.test(id)) return { ok: false, rel, error: `${id} is not an operation id (o and 8 hex digits)` };
  const dir = folderInside(root, OPERATIONS_DIR);
  if (!dir.ok) return { ok: false, rel, error: dir.error };
  try {
    const abs = path.join(dir.abs, `${id}.json`);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, rel, error: `${rel} is a symbolic link` };
    if (st.size > MAX_RECORD_BYTES) return { ok: false, rel, error: `${rel} is larger than an operation record` };
    const parsed = parseOperationRecord(JSON.parse(fs.readFileSync(abs, 'utf8')), id);
    return parsed.ok ? { ok: true, record: parsed.record, rel } : { ok: false, rel, error: parsed.error };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, rel, error: code === 'ENOENT' ? `no record ${rel} in this project` : code ? `${code} reading ${rel}` : e instanceof Error ? e.message : String(e) };
  }
}

/** The project's records, newest first, and the files that could not be read (each named with why). */
export function listOperationRecords(root: string, max = 40): { list: Array<{ record: OperationRecord; rel: string }>; unreadable: Array<{ rel: string; error: string }>; more: number } {
  const dir = folderInside(root, OPERATIONS_DIR);
  if (!dir.ok) return { list: [], unreadable: [], more: 0 };
  let names: string[];
  try { names = fs.readdirSync(dir.abs).filter((n) => /^o[0-9a-f]{8}\.json$/.test(n)); } catch { return { list: [], unreadable: [], more: 0 }; }
  const list: Array<{ record: OperationRecord; rel: string }> = [];
  const unreadable: Array<{ rel: string; error: string }> = [];
  for (const n of names) {
    const r = readOperationRecord(root, n.slice(0, -5));
    if (r.ok) list.push({ record: r.record, rel: r.rel }); else unreadable.push({ rel: r.rel, error: r.error });
  }
  list.sort((a, b) => (Date.parse(b.record.started) || 0) - (Date.parse(a.record.started) || 0) || b.record.id.localeCompare(a.record.id));
  return { list: list.slice(0, max), unreadable, more: Math.max(0, list.length - max) };
}

// ── this process's operations ─────────────────────────────────────────────────

export interface OperationLogDeps {
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string, root: string) => string;
  /** whether a run this process started still runs */
  live: (run: OperationRun, root: string) => boolean;
  /** how a run that no longer runs ended, by its own record */
  outcome: (run: OperationRun, root: string) => RunOutcome;
}

export interface OperationHandle {
  readonly id: string;
  readonly root: string;
  readonly project: string;
  readonly request: string;
  readonly via: OperationVia;
  readonly parent: string | null;
  /** this process joined an operation another process began: its record is that process's to write */
  readonly joined: boolean;
  readonly started: string;
  /** the runs this process started under it, oldest first */
  readonly runs: OperationRun[];
  /** set once this process's part of it has ended */
  ended?: { at: string; state: OperationState; why: string };
  /** written to its record file in the project (never for a joined one) */
  recorded: boolean;
  /** how many receipts this process sealed under it */
  seals: number;
  /** the last error writing its record, if any */
  writeError?: string;
}

interface Entry {
  h: OperationHandle;
  scope: OperationScope;
  commandDone: boolean;
  /** what the request itself said when it started nothing: refused (act reads its lines) */
  answer?: 'refused' | 'answered';
  /** a stop of the whole request is under way (a signal, a time limit): it ends stopped, with this why */
  stop?: string;
  close: () => void;
  waiters: Array<(h: OperationHandle) => void>;
}

/** The order an ended operation's state is decided in: the first state any of its runs has wins. */
const PRECEDENCE: ReadonlyArray<RunOutcome['state']> = ['stopped', 'failed', 'unknown', 'differs', 'refused', 'succeeded'];

/** An operation's state from how its runs ended (the runs another run's record names are counted with that run). */
export function decideState(outcomes: Array<{ run: OperationRun; out: RunOutcome }>, answer: 'refused' | 'answered' = 'answered'): { state: OperationState; why: string } {
  const claimed = new Set(outcomes.flatMap((o) => o.out.claims ?? []));
  const decisive = outcomes.filter((o) => !claimed.has(`${o.run.kind}:${o.run.id}`));
  if (!decisive.length) return { state: answer, why: answer === 'refused' ? 'it started nothing: the request was refused' : 'it started nothing: the request was answered' };
  const states = new Set(decisive.map((o) => o.out.state));
  // A run that says it still runs once nothing of it runs here did not finish its record: counted as not succeeded.
  const first = PRECEDENCE.find((s) => states.has(s)) ?? 'unknown';
  const state: OperationState = first === 'unknown' ? 'failed' : first;
  const words = decisive.map((o) => `${o.run.kind} ${o.run.id} ${o.out.words}`);
  const why = words.length > 6 ? `${words.slice(0, 6).join('; ')}; and ${words.length - 6} more` : words.join('; ');
  return { state, why };
}

export class OperationLog {
  private readonly entries = new Map<string, Entry>();
  private soon?: NodeJS.Timeout;
  private sweep?: NodeJS.Timeout;
  private newest?: OperationHandle;

  constructor(private readonly d: OperationLogDeps) {}

  /**
   * A new operation for a request, or (`join`) the operation named by TIMMY_OPERATION when this project holds it and it
   * still runs; an id it cannot join becomes the new one's parent. `record`: its record is written at once (`timmy act`),
   * otherwise once it starts something or seals a receipt.
   */
  begin(o: { request: string; via: OperationVia; root: string; project: string; join?: string; parent?: string | null; record?: boolean }): OperationHandle {
    const root = o.root;
    let joined: string | undefined;
    let parent = o.parent ?? null;
    if (o.join && OPERATION_ID.test(o.join)) {
      const held = readOperationRecord(root, o.join);
      // Joined only while it runs: its record says so and the Timmy that writes it still runs (never a stale record).
      if (held.ok && held.record.ended === null && writerState(held.record.owner) !== 'gone') joined = o.join;
      else parent = o.join;
    }
    const h: OperationHandle = {
      id: joined ?? newOperationId(), root, project: o.project, request: this.d.scrub(o.request.trim(), root).slice(0, 2000), via: o.via, parent,
      joined: !!joined, started: new Date().toISOString(), runs: [], recorded: false, seals: 0,
    };
    const e: Entry = { h, scope: { id: h.id, noteRun: (kind, id) => this.noteRun(e, kind, id), noteSeal: () => this.noteSeal(e) }, commandDone: false, close: () => {}, waiters: [] };
    e.close = openScope(e.scope);
    this.entries.set(h.id + (joined ? `@${randomBytes(3).toString('hex')}` : ''), e);
    this.newest = h;
    if (o.record && !joined) this.persist(e);
    return h;
  }

  /** Runs the request inside its operation; once it returns, the operation ends when none of its runs runs any more. */
  async run<T>(h: OperationHandle, fn: () => T | Promise<T>): Promise<T> {
    const e = this.entryOf(h);
    if (!e) return fn();
    try { return await inOperation(e.scope, fn); } finally {
      e.commandDone = true;
      this.check();
    }
  }

  /** What the request said when it started nothing: refused (act decides it from the request's own lines). */
  answer(h: OperationHandle, a: 'refused' | 'answered'): void { const e = this.entryOf(h); if (e) e.answer = a; }

  /** Whether this process's part of the operation still goes: its request, or a run it started. */
  live(h: OperationHandle): boolean {
    const e = this.entryOf(h);
    if (!e || h.ended) return false;
    return !e.commandDone || h.runs.some((r) => this.runLive(r, h.root));
  }

  /** Resolves once this process's part of the operation has ended. */
  done(h: OperationHandle): Promise<OperationHandle> {
    const e = this.entryOf(h);
    if (!e || h.ended) return Promise.resolve(h);
    return new Promise((resolve) => { e.waiters.push(resolve); this.check(); });
  }

  /**
   * A stop of the whole request is under way (`timmy act`'s signal, its time limit): once its runs have ended, it ends
   * stopped with this why first, then how each run ended (each run's own record says that).
   */
  stopping(h: OperationHandle, why: string): void { const e = this.entryOf(h); if (e && !h.ended) e.stop = why; }

  /** Ends it now with this state (a stop by a signal, a time limit), its record written. */
  end(h: OperationHandle, state: OperationState, why: string): void {
    const e = this.entryOf(h);
    if (!e || h.ended) return;
    this.finish(e, { state, why });
  }

  /** The newest operation this process began (or joined). */
  get latest(): OperationHandle | undefined { return this.newest; }

  /** The operations of this process not ended yet. */
  get open(): OperationHandle[] { return [...this.entries.values()].map((e) => e.h).filter((h) => !h.ended); }

  /** Looks at every open operation now: one whose request returned and none of whose runs runs ends. */
  check(): void {
    for (const e of [...this.entries.values()]) {
      if (e.h.ended || !e.commandDone) continue;
      if (e.h.runs.some((r) => this.runLive(r, e.h.root))) continue;
      const outcomes = e.h.runs.map((run) => ({ run, out: this.runOutcome(run, e.h.root) }));
      const decided = decideState(outcomes, e.answer);
      this.finish(e, e.stop ? { state: 'stopped', why: outcomes.length ? `${e.stop}; ${decided.why}` : e.stop } : decided);
    }
    this.arm();
  }

  /** Ends every operation still open (the process is ending), each by its runs as they are now. */
  closeAll(why = 'this Timmy ended before it did'): void {
    for (const e of [...this.entries.values()]) if (!e.h.ended) this.finish(e, { state: 'stopped', why });
    if (this.soon) clearTimeout(this.soon);
    if (this.sweep) clearTimeout(this.sweep);
  }

  private entryOf(h: OperationHandle): Entry | undefined {
    for (const e of this.entries.values()) if (e.h === h) return e;
    return undefined;
  }

  private runLive(run: OperationRun, root: string): boolean {
    try { return this.d.live(run, root); } catch { return false; }
  }

  private runOutcome(run: OperationRun, root: string): RunOutcome {
    try { return this.d.outcome(run, root); } catch (err) { return { state: 'unknown', words: `its record could not be read (${err instanceof Error ? err.message : String(err)})` }; }
  }

  private noteRun(e: Entry, kind: OperationRunKind, id: string): void {
    const h = e.h;
    if (h.runs.some((r) => r.kind === kind && r.id === id)) return;
    (h.runs as OperationRun[]).push({ kind, id, at: new Date().toISOString() });
    // A run started after this part ended (a job's callback starting another) opens it again.
    if (h.ended) h.ended = undefined;
    this.persist(e);
    this.later();
  }

  private noteSeal(e: Entry): void {
    e.h.seals += 1;
    if (!e.h.recorded) this.persist(e);
    // Later, not now: a flow or an action seals its last receipt just before it leaves the running lists.
    this.later();
  }

  private finish(e: Entry, end: { state: OperationState; why: string }): void {
    const h = e.h;
    h.ended = { at: new Date().toISOString(), state: end.state, why: end.why };
    if (h.recorded) this.persist(e);
    for (const w of e.waiters.splice(0)) w(h);
  }

  /** Writes the record (not a joined operation's: that is its first process's). */
  private persist(e: Entry): void {
    const h = e.h;
    if (h.joined) return;
    const shown = h.runs.slice(0, MAX_RUNS);
    const rec: OperationRecord = {
      schema: OPERATION_SCHEMA, id: h.id, request: h.request, via: h.via, project: h.project, started: h.started,
      ended: h.ended?.at ?? null, state: h.ended?.state ?? 'running', ...(h.ended ? { why: this.d.scrub(h.ended.why, h.root).slice(0, 2000) } : {}),
      parent: h.parent, runs: shown, ...(h.runs.length > shown.length ? { more_runs: h.runs.length - shown.length } : {}),
      owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started },
    };
    const w = writeOperationRecord(h.root, rec);
    if (w.ok) { h.recorded = true; h.writeError = undefined; } else h.writeError = w.error;
  }

  /** A check soon (coalesced): after the current step, so a run that just ended has left its running list. */
  private later(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = undefined; this.check(); }, 40);
    this.soon.unref?.();
  }

  /** While an operation is open, a check every second: a flow or an action ends without a job event. */
  private arm(): void {
    const open = [...this.entries.values()].some((e) => !e.h.ended);
    if (!open) {
      if (this.sweep) { clearTimeout(this.sweep); this.sweep = undefined; }
      for (const [k, e] of this.entries) if (e.h.ended && !e.waiters.length) { e.close(); if (e.h !== this.newest) this.entries.delete(k); }
      return;
    }
    if (this.sweep) return;
    this.sweep = setTimeout(() => { this.sweep = undefined; this.check(); }, 1000);
    this.sweep.unref?.();
  }
}
