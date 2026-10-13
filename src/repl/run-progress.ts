/**
 * Round R4 (H99, gap 5): progress lines while a /run runs. On the Mac (r24) nothing moved for the four minutes a /run took:
 * the block's own `timmy act` ran the flow, its agent and its rebuild in another process, and the REPL said nothing until
 * the block ended.
 *
 * While a /run job of this REPL goes on, this follower reads, about once a second, what the run's own records say now:
 *   - the job's record: the block that runs (on a pty upmd says it as it starts; over a pipe a block is seen only when it
 *     ends, so the line says how many ended instead of guessing which runs);
 *   - the flow a block started (the run's operation id is in the flow's state file, .timmy/flows/<id>/state.json): its
 *     step (agent, checks, the app's run, readback) as its session last wrote it, and once it has ended, the outcome its
 *     record says (results/flows/<id>.json), until the block that ran it ends;
 *   - the code agent of that operation (its own record, .timmy/agents/<run>/): the tool calls and messages its progress log
 *     holds (each a line the agent's own stream gave) and the latest line.
 * A line is printed when one of these changes (a block's start at once, another change at most one every `minGapMs`), and,
 * while nothing changes, one every `quietMs` with the time it has run. What changes comes first (R4, H99, the review: a line
 * cut at 80 columns keeps it): "still running: agent a…: 4 tool calls, 1 message so far; latest: tool edit box.params.json ·
 * flow f… (/iterate scad) in its agent step · change · run 1 min 30 s" (the run's time, never the block's). A block's end is
 * said by the job's own notice (src/repl/workspace.ts changed()); the quiet is counted from it. Nothing is invented: what no
 * record says is not said (the agent's turns are not counted: its stream says them only at its end), and over a pipe the
 * block that runs is not named. The lines go through the REPL's notices (the same path a job's end line takes), so the
 * REPL's main loop is not changed; a status line kept in place would need it (src/repl/main.ts).
 *
 * It reads only; it writes, seals and starts nothing. Its timer is unref'd: it never keeps the process alive.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { AGENTS_DIR, readProgressTail, RUN_RECORD } from '../code-agents/index.js';
import { FLOW_ID, FLOW_SCHEMA, FLOW_WORK_DIR, flowRecordPath } from '../flows/iterate.js';
import { blockCount } from '../workflows/block-count.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';

type Line = Segment[];

/** The defaults: a look every second, a line at least every 15 s while it runs, two lines for changes at least 2 s apart. */
export const PROGRESS_TICK_MS = 1000;
export const PROGRESS_QUIET_MS = 15_000;
export const PROGRESS_MIN_GAP_MS = 2000;

export interface RunProgressDeps {
  jobs: { get(id: string): JobRecord | undefined };
  notify: (line: Line) => void;
  glyphs: GlyphSet;
  /** the project's folder written as "." and the home folder as "~" */
  scrub: (text: string, root: string) => string;
  now?: () => number;
  /** how often it reads the records (default PROGRESS_TICK_MS) */
  tickMs?: number;
  /** the longest it stays quiet while the run goes on (default PROGRESS_QUIET_MS) */
  quietMs?: number;
  /** the least time between two lines for a change other than a block's start (default PROGRESS_MIN_GAP_MS) */
  minGapMs?: number;
}

/** What the records say of a run now. */
export interface RunFacts {
  /** the block that runs, as upmd said it (a run on a pty); undefined when it is not known (a pipe) or none runs */
  block?: string;
  ended: number;
  of?: number;
  elapsedMs: number;
  /** the operation's flow that runs, with its step; or, once none runs, the one that ended last ('ended', with its record's
   *  outcome and when its record was written) */
  flow?: { id: string; kind: string; step: string; outcome?: string; endedAt?: number };
  /** the agent's tool calls and messages as its progress log holds them, and its latest line */
  agent?: { run: string; tools: number; messages: number; latest?: string };
}

interface Followed {
  job: string; root: string; operation?: string; order: string[]; live: boolean;
  /** the flow's and the agent's facts as last said (their signature), the block last said to run, the blocks ended as last
   *  seen and when the last of them was seen to end */
  last?: string; lastBlock?: string; ended?: number; blockEndedAt?: number;
  /** when something was last said of the run (a line here, or the job's own notice of a block's end); when a line here was */
  at: number; lineAt: number;
  /** R4 (H99, the review): the records read between looks (src/repl/run-progress.ts RecordCache) */
  cache: RecordCache;
}

/** A duration as the progress lines say it: 45 s, 1 min 30 s, 1 h 5 min. */
export function elapsedWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** A line of an agent's progress log (src/code-agents/index.ts progressLine): a tool call, or a message. */
const TOOL_LINE = /^tool {2}/;
const SAYS_LINE = /^says {2}/;
const cutTo = (t: string, n: number): string => (Array.from(t).length > n ? `${Array.from(t).slice(0, n - 1).join('')}…` : t);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const RECORD_MAX = 1024 * 1024;

/**
 * R4 (H99, the review: a look read every flow's state file and every agent's run record each second): what a follower keeps
 * between looks. A file is read again only when its time or size changed; a record of another operation (a flow's or an
 * agent's operation is fixed when it starts), or one written before the run began, is never read again.
 */
export interface RecordCache {
  files: Map<string, { mtimeMs: number; size: number; value: Record<string, unknown> | undefined }>;
  others: Set<string>;
  logs: Map<string, { mtimeMs: number; size: number; tools: number; messages: number; latest?: string }>;
}
export const newRecordCache = (): RecordCache => ({ files: new Map(), others: new Set(), logs: new Map() });

/** A file's time and size, or undefined when it is not a regular file of a record's size. */
function statOf(abs: string): fs.Stats | undefined {
  try { const st = fs.lstatSync(abs); return st.isFile() && st.size <= RECORD_MAX ? st : undefined; } catch { return undefined; }
}

/** A JSON object file of at most RECORD_MAX bytes, and when it was written (read again only when it changed). */
function readObject(abs: string, cache?: RecordCache): { value: Record<string, unknown>; at: number } | undefined {
  const st = statOf(abs);
  if (!st) return undefined;
  const hit = cache?.files.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value ? { value: hit.value, at: st.mtimeMs } : undefined;
  let value: Record<string, unknown> | undefined;
  try { const v: unknown = JSON.parse(fs.readFileSync(abs, 'utf8')); value = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { value = undefined; }
  // a file being written reads as nothing, and is read again once its time or size changes
  cache?.files.set(abs, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value ? { value, at: st.mtimeMs } : undefined;
}

/**
 * The flow of an operation, from its state file (.timmy/flows/<id>/state.json): the one that runs now (the newest written,
 * should one operation run two), its id, kind and step; else the newest that has ended, with the outcome its record says
 * (results/flows/<id>.json; a flow with a record has ended). Undefined when the operation has no flow (yet). `since`: state
 * files written before it are not this run's, and are not read.
 */
export function flowOf(root: string, operation: string, o: { since?: number; cache?: RecordCache } = {}): RunFacts['flow'] {
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(root, FLOW_WORK_DIR)).filter((n) => FLOW_ID.test(n)); } catch { return undefined; }
  let running: { flow: NonNullable<RunFacts['flow']>; at: number } | undefined;
  let ended: { flow: NonNullable<RunFacts['flow']>; at: number } | undefined;
  for (const id of ids) {
    const key = `flow:${id}`;
    if (o.cache?.others.has(key)) continue;
    const abs = path.join(root, FLOW_WORK_DIR, id, 'state.json');
    const st = statOf(abs);
    if (!st) continue;
    if (o.since !== undefined && st.mtimeMs < o.since) { o.cache?.others.add(key); continue; }
    const s = readObject(abs, o.cache);
    if (!s) continue; // a state file being written is read at the next look
    if (s.value.schema !== FLOW_SCHEMA || s.value.id !== id || s.value.operation !== operation) { o.cache?.others.add(key); continue; }
    const kind = typeof s.value.target === 'string' ? s.value.target : 'tray';
    const recAbs = path.join(root, flowRecordPath(id));
    const rec = statOf(recAbs) ? readObject(recAbs, o.cache) ?? { value: {}, at: s.at } : undefined;
    if (rec) {
      if (!ended || rec.at > ended.at) ended = { flow: { id, kind, step: 'ended', ...(typeof rec.value.outcome === 'string' ? { outcome: rec.value.outcome } : {}), endedAt: rec.at }, at: rec.at };
    } else if (s.value.outcome === 'running' && (!running || s.at > running.at)) {
      running = { flow: { id, kind, step: typeof s.value.step === 'string' ? s.value.step : 'unknown' }, at: s.at };
    }
  }
  return (running ?? ended)?.flow;
}

/** An agent's progress log counted: its tool calls and messages and its latest line (counted again only when it changed). */
function progressOf(root: string, run: string, cache?: RecordCache): { tools: number; messages: number; latest?: string } {
  const abs = path.join(root, AGENTS_DIR, run, 'progress.log');
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(abs); } catch { st = undefined; }
  const hit = st ? cache?.logs.get(abs) : undefined;
  if (st && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { tools: hit.tools, messages: hit.messages, ...(hit.latest ? { latest: hit.latest } : {}) };
  let lines: string[] = [];
  try { lines = readProgressTail(root, run, Number.MAX_SAFE_INTEGER).flatMap((l) => l.split('\n')).filter((l) => l.trim()); } catch { lines = []; }
  const latest = lines.at(-1)?.replace(/\s+/g, ' ').trim();
  const counted = { tools: lines.filter((l) => TOOL_LINE.test(l)).length, messages: lines.filter((l) => SAYS_LINE.test(l)).length, ...(latest ? { latest } : {}) };
  if (st && st.isFile()) cache?.logs.set(abs, { mtimeMs: st.mtimeMs, size: st.size, ...counted });
  return counted;
}

/**
 * The code agent of an operation that runs now, from its own record (.timmy/agents/<run>/run.json, written as it starts; a
 * run with a result or an end has ended): its progress log's tool calls and messages, its latest line. Only the runs whose
 * record was written since `since` (the /run's start) are read, each again only when it changed.
 */
export function runningAgentOf(root: string, operation: string, since = 0, cache?: RecordCache): RunFacts['agent'] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, AGENTS_DIR)).filter((n) => /^a[0-9a-f]{8}$/.test(n)); } catch { return undefined; }
  let found: { run: string; at: number } | undefined;
  for (const n of names) {
    const key = `agent:${n}`;
    if (cache?.others.has(key)) continue;
    const abs = path.join(root, AGENTS_DIR, n, RUN_RECORD);
    const st = statOf(abs);
    if (!st) continue;
    if (st.mtimeMs < since) { cache?.others.add(key); continue; }
    const rec = readObject(abs, cache);
    if (!rec) continue;
    if (rec.value.run !== n || rec.value.operation !== operation) { cache?.others.add(key); continue; }
    // one that has ended (its record says so, or its result is written) does not run again
    if (rec.value.outcome !== undefined || rec.value.state === 'ended' || rec.value.state === 'interrupted' || fs.existsSync(path.join(root, AGENTS_DIR, n, 'result.json'))) { cache?.others.add(key); continue; }
    if (!found || rec.at > found.at) found = { run: n, at: rec.at };
  }
  if (!found) return undefined;
  return { run: found.run, ...progressOf(root, found.run, cache) };
}

/** What the records of a /run say now (never more than they say). `live`: whether its blocks come as they start (a pty). */
export function runFacts(j: JobRecord, f: { root: string; operation?: string; order: readonly string[]; live: boolean }, now: number, cache?: RecordCache): RunFacts {
  const count = blockCount(j, { order: f.order });
  const running = j.steps.find((s) => s.state === 'running');
  const started = Date.parse(j.startedAt);
  // a record's time is its file's: a second's slack for a clock that writes it a little before the job's start is read
  const since = Number.isFinite(started) ? started - 1000 : 0;
  const flow = f.operation ? flowOf(f.root, f.operation, { since, ...(cache ? { cache } : {}) }) : undefined;
  const agent = f.operation ? runningAgentOf(f.root, f.operation, since, cache) : undefined;
  return {
    ended: count.ended, ...(count.of !== undefined ? { of: count.of } : {}),
    ...(f.live && running ? { block: running.name } : {}),
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    ...(flow ? { flow } : {}), ...(agent ? { agent } : {}),
  };
}

/** The facts as the words of a progress line, after "running:" or "still running:". */
export function progressWords(p: RunFacts, sep: string, scrub: (t: string) => string = (t) => t): string {
  const block = p.block ?? `${p.ended}${p.of !== undefined ? ` of ${p.of}` : ''} ${p.of === 1 || (p.of === undefined && p.ended === 1) ? 'block' : 'blocks'} ended`;
  const agent = p.agent
    ? `agent ${p.agent.run}: ${p.agent.tools || p.agent.messages ? `${plural(p.agent.tools, 'tool call')}, ${plural(p.agent.messages, 'message')} so far` : 'no tool call or message in its progress log yet'}${p.agent.latest ? `; latest: ${cutTo(scrub(p.agent.latest), 100)}` : ''}`
    : undefined;
  // R4 (H99, the review): what changes first (the agent's counts and latest action), then the flow, then the block and the
  // time the run has taken (the run's, never the block's): a line cut at 80 columns keeps what moved
  return [
    ...(agent ? [agent] : []),
    ...(p.flow ? [`flow ${p.flow.id} (/iterate ${p.flow.kind}) ${p.flow.step === 'ended' ? `ended: ${p.flow.outcome ?? 'its record holds no outcome'}` : `in its ${p.flow.step} step`}`] : []),
    block,
    `run ${elapsedWords(p.elapsedMs)}`,
  ].join(sep);
}

/** What a change other than a block's start is measured by: the flow's step, the agent's progress. (A block's end is the
 *  job's own notice, src/repl/workspace.ts changed().) */
const signature = (p: RunFacts): string => JSON.stringify([p.flow?.id ?? null, p.flow?.step ?? null, p.flow?.outcome ?? null, p.agent?.run ?? null, p.agent?.tools ?? null, p.agent?.messages ?? null, p.agent?.latest ?? null]);
const NOTHING = signature({ ended: 0, elapsedMs: 0 });

export class RunProgress {
  private readonly runs = new Map<string, Followed>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly d: RunProgressDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** Follows a /run job of this REPL from its start until it ends. */
  follow(job: string, o: { root: string; operation?: string; order: string[]; live: boolean }): void {
    this.runs.set(job, { job, root: o.root, order: o.order, live: o.live, ...(o.operation ? { operation: o.operation } : {}), at: this.now(), lineAt: 0, cache: newRecordCache() });
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.d.tickMs ?? PROGRESS_TICK_MS);
      this.timer.unref();
    }
  }

  /** The runs it follows now (their job ids). */
  following(): string[] { return [...this.runs.keys()]; }

  /** Stops following every run (the REPL is ending). */
  stopAll(): void {
    this.runs.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** One look at every run followed: a line for a change, or for a quiet that has lasted `quietMs`. */
  tick(): void {
    const now = this.now();
    for (const f of [...this.runs.values()]) {
      const j = this.d.jobs.get(f.job);
      if (!j || j.stale || (j.state !== 'queued' && j.state !== 'running')) { this.runs.delete(f.job); continue; }
      let p: RunFacts;
      try { p = runFacts(j, f, now, f.cache); } catch { continue; }
      // a block that ended was said by the job's own notice as it ended: the quiet is counted from there
      if (f.ended !== undefined && p.ended !== f.ended) { f.at = now; f.blockEndedAt = now; }
      f.ended = p.ended;
      // a flow that ended before the last block's end was an earlier block's: it is not said of the blocks after it
      if (p.flow?.step === 'ended' && f.blockEndedAt !== undefined && (p.flow.endedAt ?? 0) <= f.blockEndedAt) { const { flow: _earlier, ...rest } = p; p = rest; }
      const sig = signature(p);
      const started = p.block !== undefined && p.block !== f.lastBlock;
      const changed = sig !== (f.last ?? NOTHING);
      let word: 'running' | 'still running' | undefined;
      if (started || (changed && now - f.lineAt >= (this.d.minGapMs ?? PROGRESS_MIN_GAP_MS))) word = 'running';
      else if (!changed && now - f.at >= (this.d.quietMs ?? PROGRESS_QUIET_MS)) word = 'still running';
      if (!word) {
        // the block that ran has ended and none runs yet: its end is the job's own notice, so nothing more is said of it
        if (p.block === undefined) f.lastBlock = undefined;
        continue;
      }
      f.last = sig;
      f.lastBlock = p.block;
      f.at = now;
      f.lineAt = now;
      const g = this.d.glyphs;
      this.d.notify([{ text: `  ${g.bullet} ` }, { text: f.job, role: 'strong' }, { text: `  ${word}: ${progressWords(p, ` ${g.sep} `, (t) => this.d.scrub(t, f.root))}`, role: 'secondary' }]);
    }
    if (!this.runs.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}
