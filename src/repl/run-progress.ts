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
 * while nothing changes, one every `quietMs` with the time it has run: "still running: change, 1 min 30 s · flow f… (/iterate
 * scad) in its agent step · agent a…: 4 tool calls, 1 message so far; latest: tool edit box.params.json". A block's end is
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
/** A JSON object file of at most RECORD_MAX bytes, and when it was written; undefined when it is not one (yet). */
function readObject(abs: string): { value: Record<string, unknown>; at: number } | undefined {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > RECORD_MAX) return undefined;
    const v: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Record<string, unknown>, at: st.mtimeMs } : undefined;
  } catch { return undefined; }
}

/**
 * The flow of an operation, from its state file (.timmy/flows/<id>/state.json): the one that runs now (the newest written,
 * should one operation run two), its id, kind and step; else the newest that has ended, with the outcome its record says
 * (results/flows/<id>.json; a flow with a record has ended). Undefined when the operation has no flow (yet).
 */
export function flowOf(root: string, operation: string): RunFacts['flow'] {
  let ids: string[] = [];
  try { ids = fs.readdirSync(path.join(root, FLOW_WORK_DIR)).filter((n) => FLOW_ID.test(n)); } catch { return undefined; }
  let running: { flow: NonNullable<RunFacts['flow']>; at: number } | undefined;
  let ended: { flow: NonNullable<RunFacts['flow']>; at: number } | undefined;
  for (const id of ids) {
    const s = readObject(path.join(root, FLOW_WORK_DIR, id, 'state.json'));
    if (!s || s.value.schema !== FLOW_SCHEMA || s.value.id !== id || s.value.operation !== operation) continue; // a state file being written is read at the next look
    const kind = typeof s.value.target === 'string' ? s.value.target : 'tray';
    const rec = fs.existsSync(path.join(root, flowRecordPath(id))) ? readObject(path.join(root, flowRecordPath(id))) ?? { value: {}, at: s.at } : undefined;
    if (rec) {
      if (!ended || rec.at > ended.at) ended = { flow: { id, kind, step: 'ended', ...(typeof rec.value.outcome === 'string' ? { outcome: rec.value.outcome } : {}), endedAt: rec.at }, at: rec.at };
    } else if (s.value.outcome === 'running' && (!running || s.at > running.at)) {
      running = { flow: { id, kind, step: typeof s.value.step === 'string' ? s.value.step : 'unknown' }, at: s.at };
    }
  }
  return (running ?? ended)?.flow;
}

/**
 * The code agent of an operation that runs now, from its own record (.timmy/agents/<run>/run.json, written as it starts; a
 * run with a result or an end has ended): its progress log's tool calls and messages, its latest line. Only the runs whose
 * record was written since `since` (the /run's start) are read.
 */
export function runningAgentOf(root: string, operation: string, since = 0): RunFacts['agent'] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(root, AGENTS_DIR)).filter((n) => /^a[0-9a-f]{8}$/.test(n)); } catch { return undefined; }
  let found: { run: string; at: number } | undefined;
  for (const n of names) {
    const rec = readObject(path.join(root, AGENTS_DIR, n, RUN_RECORD));
    if (!rec || rec.at < since || rec.value.run !== n || rec.value.operation !== operation) continue;
    if (rec.value.outcome !== undefined || rec.value.state === 'ended' || rec.value.state === 'interrupted') continue;
    if (fs.existsSync(path.join(root, AGENTS_DIR, n, 'result.json'))) continue; // its result is written: it has ended
    if (!found || rec.at > found.at) found = { run: n, at: rec.at };
  }
  if (!found) return undefined;
  const r = found;
  let lines: string[] = [];
  try { lines = readProgressTail(root, r.run, Number.MAX_SAFE_INTEGER).flatMap((l) => l.split('\n')).filter((l) => l.trim()); } catch { lines = []; }
  const latest = lines.at(-1);
  return {
    run: r.run, tools: lines.filter((l) => TOOL_LINE.test(l)).length, messages: lines.filter((l) => SAYS_LINE.test(l)).length,
    ...(latest ? { latest: latest.replace(/\s+/g, ' ').trim() } : {}),
  };
}

/** What the records of a /run say now (never more than they say). `live`: whether its blocks come as they start (a pty). */
export function runFacts(j: JobRecord, f: { root: string; operation?: string; order: readonly string[]; live: boolean }, now: number): RunFacts {
  const count = blockCount(j, { order: f.order });
  const running = j.steps.find((s) => s.state === 'running');
  const started = Date.parse(j.startedAt);
  const flow = f.operation ? flowOf(f.root, f.operation) : undefined;
  // a record's time is its file's: a second's slack for a clock that writes it a little before the job's start is read
  const agent = f.operation ? runningAgentOf(f.root, f.operation, Number.isFinite(started) ? started - 1000 : 0) : undefined;
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
  return [
    `${block}, ${elapsedWords(p.elapsedMs)}`,
    ...(p.flow ? [`flow ${p.flow.id} (/iterate ${p.flow.kind}) ${p.flow.step === 'ended' ? `ended: ${p.flow.outcome ?? 'its record holds no outcome'}` : `in its ${p.flow.step} step`}`] : []),
    ...(agent ? [agent] : []),
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
    this.runs.set(job, { job, root: o.root, order: o.order, live: o.live, ...(o.operation ? { operation: o.operation } : {}), at: this.now(), lineAt: 0 });
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
      try { p = runFacts(j, f, now); } catch { continue; }
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
