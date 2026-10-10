/**
 * Round R4 (H60): the decisions waiting on a person in the active project, for the Control Room (`/room`, the board's
 * Control Room section, snapshot and live) and `/decisions`. The owner's brief: the Control Room shows the decisions
 * pending on a person. Each item says what is needed, why (the record or check that says so) and the exact typed command
 * or setup step; nothing here runs, seals, writes or answers anything: every item ends "nothing is done until you do it".
 *
 * What is read, each through the reader that already exists:
 *   approvals    the NEEDS YOU calls waiting in this REPL (src/repl/approvals.ts waitingApprovals)
 *   stale saves  the live board's saves this REPL refused because the file changed on disk since the board showed it
 *                (src/room/stale-saves.ts)
 *   left behind  what a Timmy session that ended left in the project, which /recover settles: a flow whose state file says
 *                a step runs while that step's job is stale (or nothing of it has run for FLOW_QUIET_MS), a recipe whose
 *                newest watcher job is stale, a native run not judged whose job is stale (src/repl/recover.ts's own rules,
 *                read only: its survey is not run here)
 *   setup        the /tools rows that say "needs setup" for a tool a run of this project used or tried (agent runs, native
 *                runs, flows, recipe jobs, MCP calls, observations), as the Control Room last checked /tools; and
 *                VoxVision's tools that need setup for a tool a VoxVision record of this project names. The other rows of
 *                /tools that need setup are counted (/tools lists them)
 *   runs         the newest flow of each target that ended needing a person (interrupted; its readback differs; failed in
 *                its checks or readback step), and the newest run of each workflow block that was interrupted (its job
 *                record stale): a later run of the same target or block settles an earlier one
 *   memory       draft lessons (awaiting /lesson check) and stale ones (src/memory/lessons.ts, checked now, read only)
 *
 * Order: what blocks a running or requested operation first (a NEEDS YOU box, a refused save), then what an ended session
 * left, the setup the project's runs need, the runs that ended needing a person, and the lessons; newest first in each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, listAgentRuns, type AgentName } from '../code-agents/index.js';
import { CODEX_LOCAL_ROUTE } from '../code-agents/codex-local.js';
import { readMcpCalls } from '../connectors/mcp-records.js';
import type { JobRecord } from '../jobs/index.js';
import type { OperationCard } from '../ops/card.js';
import { checkLesson, listLessons, oneLine, problemsText } from '../memory/lessons.js';
import { listNativeRuns, NATIVE_APPS, readNativeRecord, type NativeApp } from '../native/index.js';
import { RECIPE_ID } from '../recipes/index.js';
import type { WaitingApproval } from '../repl/approvals.js';
import { readBoardFlows, type BoardFlow, type BoardFlows } from '../repl/board-flows.js';
import { flowKind } from '../repl/board-steps.js';
import { runOf } from '../repl/board-workflows.js';
import { FLOW_QUIET_MS } from '../repl/recover.js';
import type { Receipt } from '../utils/receipts.js';
import type { ToolStatus } from '../vox/tools.js';
import { cleanLine, type RoomTools } from './index.js';
import type { StaleSave } from './stale-saves.js';

// ── the model ─────────────────────────────────────────────────────────────────

export type DecisionKind = 'approval' | 'stale-save' | 'left' | 'setup' | 'interrupted' | 'differs' | 'failed' | 'lesson';

export interface Decision {
  /** stable across reads: what it is about */
  key: string;
  kind: DecisionKind;
  /** it blocks a running or requested operation (a NEEDS YOU box, a refused save) */
  blocks: boolean;
  /** what waits, in a few words */
  title: string;
  /** what is needed of the person */
  needed: string;
  /** why: the record or check that says so */
  why: string;
  /** the record behind it, relative to the project */
  record?: string;
  /** the receipt that sealed that record, by its short id */
  receipt?: string;
  /** setup steps that are not Timmy commands (an install, a licence, an app setting, a key), as /tools words them */
  steps?: string[];
  /** keys to press where the box is (a NEEDS YOU box), not commands */
  keys?: string[];
  /** the exact typed commands, in order */
  commands: string[];
  /** the operation (one request) it belongs to, when a record names one */
  operation?: string;
  /** the run it is about (a flow, a job), when there is one */
  run?: string;
  /** when (ms), for the order */
  at: number;
}

export interface DecisionsView {
  /** the first `max`, in order */
  items: Decision[];
  /** how many more are waiting beyond those */
  more: number;
  total: number;
  /** the /tools rows needing setup that no run of this project used or tried (/tools lists them) */
  otherSetup: number;
  /** when /tools was last checked here, or why the setup part is not known */
  tools: { checkedAt?: string; note?: string };
  /** every item that names an operation (shown or counted), by operation: what the operation cards mark */
  operations: Record<string, string[]>;
  notes: string[];
}

/** Every item says this. */
export const NOTHING_DONE = 'Nothing is done until you do it.';
/** How many items the Control Room shows; /decisions shows DECISIONS_ALL. */
export const DECISIONS_SHOWN = 6;
export const DECISIONS_ALL = 20;

/** What the decisions read; the Workspace gives its own (src/repl/workspace.ts). */
export interface DecisionContext {
  root: string;
  projectId: string;
  /** this project's jobs, newest first (the board's own list) */
  jobs: readonly JobRecord[];
  chain: readonly Receipt[];
  /** the board's flows, when at hand (else read here, by the board's reader) */
  flows?: BoardFlows;
  /** the flows this REPL runs */
  activeFlows?: readonly string[];
  approvals?: readonly WaitingApproval[];
  staleSaves?: readonly StaleSave[];
  /** the /tools rows as the Control Room last checked them */
  tools?: RoomTools;
  /** VoxVision's tools as checked now: asked only when a VoxVision record of the project names a tool */
  voxTools?: () => readonly ToolStatus[];
  /** the project's folder as "." and the home folder as "~" */
  scrub: (text: string) => string;
  now?: () => number;
  /** how many to keep (the rest are counted) */
  max?: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const time = (iso: unknown): number => { const t = typeof iso === 'string' ? Date.parse(iso) : Number.NaN; return Number.isNaN(t) ? 0 : t; };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (h: string | null | undefined): string => (h ? h.slice(0, 12) : 'none');
const stamp = (ms: number): string => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time');
const day = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 10) : 'an unknown day');
const LIVE = new Set(['queued', 'running', 'ready']);
const liveJob = (j: JobRecord | undefined): boolean => !!j && LIVE.has(j.state) && !j.stale;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * One argument as Timmy's command lines read it (splitCommandLine: quotes group and are taken off; no escapes): plain
 * when it has no space or quote; else double quotes, or single quotes; else runs of each, joined.
 */
export function quoteArg(s: string): string {
  if (s && !/[\s"']/.test(s)) return s;
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return s.split(/(")/).filter((p) => p !== '').map((p) => (p === '"' ? `'"'` : `"${p}"`)).join('');
}

/** The tier of a kind: what blocks first. */
const TIER: Readonly<Record<DecisionKind, number>> = { approval: 0, 'stale-save': 1, left: 2, setup: 3, interrupted: 4, differs: 4, failed: 4, lesson: 5 };

// ── approvals and refused saves ─────────────────────────────────────────────────

function approvalItems(c: DecisionContext): Decision[] {
  return (c.approvals ?? []).map((a): Decision => {
    const summary = cleanLine(a.summary, c.scrub, 100);
    const keys = ['y: allow it once', ...(a.session ? ['a: allow it for this session'] : []), 'n, Esc or Enter: deny it'];
    return {
      key: `approval:${a.since}:${a.tool}`, kind: 'approval', blocks: true,
      title: `NEEDS YOU: ${a.tool}${summary ? ` (${summary})` : ''}`,
      needed: a.shown ? 'answer the NEEDS YOU box in the REPL; the call waits for it' : 'answer its NEEDS YOU box in the REPL once the box before it is answered; the call waits for it',
      why: `the chat agent asked to run ${a.tool}, and Timmy asks first because it ${cleanLine(a.reason, c.scrub, 160)}`,
      keys, commands: [], ...(a.operation ? { operation: a.operation } : {}), at: a.since,
    };
  });
}

function staleSaveItems(c: DecisionContext): Decision[] {
  return (c.staleSaves ?? []).map((s): Decision => ({
    key: `stale-save:${s.file}`, kind: 'stale-save', blocks: true,
    title: `${s.file} changed on disk after the board showed it`,
    needed: 'decide which version to keep: Discard on its card on the board shows the file as it is now; edit and save again from there, or keep the file as it is',
    why: `the board refused your save of ${s.what} at ${stamp(s.at)}: the file is ${s.found ? `sha256 ${short(s.found)}` : 'not there'} now and the board had shown ${s.shown ? `sha256 ${short(s.shown)}` : 'no file'}; nothing was written`,
    record: s.file,
    commands: [`/open ${quoteArg(s.file)}`, ...(/\.md$/i.test(s.file) ? [`/workflows ${quoteArg(s.file)}`] : [])],
    ...(s.operation ? { operation: s.operation } : {}), at: s.at,
  }));
}

// ── what an ended session left (settled by /recover) ────────────────────────────

/** The record part each flow step keeps its job in (src/repl/iterate*.ts). */
const STEP_JOB: Readonly<Record<string, string>> = { agent: 'agent', build: 'rebuild', blender: 'blender', openscad: 'openscad', freecad: 'freecad', author: 'author', render: 'render', readback: 'readback' };
const APP_WORDS: Readonly<Record<string, string>> = { c4dpy: 'Cinema 4D', aerender: 'After Effects render', blender: 'Blender', afterfx: 'After Effects script', openscad: 'OpenSCAD', freecad: 'FreeCAD' };

function leftItems(c: DecisionContext, flows: BoardFlows, now: number): Decision[] {
  const jobOf = (id: string | undefined): JobRecord | undefined => (id ? c.jobs.find((j) => j.id === id) : undefined);
  const found: Array<{ words: string; record?: string; at: number; operation?: string }> = [];
  // Flows whose state file says a step runs, run by no live job of any session.
  for (const f of flows.running ?? []) {
    const r = f.record as unknown as Obj;
    const id = String(r.id ?? '');
    if ((c.activeFlows ?? []).includes(id)) continue;
    const step = String(r.step ?? '?');
    const jobId = str(obj(r[STEP_JOB[step] ?? ''])?.job);
    const job = jobOf(jobId);
    if (liveJob(job)) continue;
    const kind = flowKind(r) ?? 'flow';
    const written = time(f.live?.written);
    if (job?.stale) {
      found.push({ words: `flow ${id} (/iterate ${kind}): its state file says its ${step} step runs, and that step's job ${job.id} was left ${job.state} by a session whose process is gone`, record: f.file, at: written, ...(str(r.operation) ? { operation: String(r.operation) } : {}) });
      continue;
    }
    const quiet = now - Math.max(written, time(job?.endedAt));
    if (written && quiet >= FLOW_QUIET_MS) {
      found.push({ words: `flow ${id} (/iterate ${kind}): its state file says its ${step} step runs, no job of that step runs here, and nothing about it has changed for ${Math.round(quiet / 60_000)} min`, record: f.file, at: written, ...(str(r.operation) ? { operation: String(r.operation) } : {}) });
    }
  }
  // Recipes whose newest watcher job was left running by a session whose process is gone.
  const watchers = new Map<string, JobRecord[]>();
  for (const j of c.jobs) {
    if (!j.label.startsWith(`recipe ${RECIPE_ID} `)) continue;
    const uuid = UUID.exec(j.label)?.[1];
    if (uuid) watchers.set(uuid, [...(watchers.get(uuid) ?? []), j]);
  }
  for (const [uuid, list] of watchers) {
    const newest = [...list].sort((a, b) => time(b.startedAt) - time(a.startedAt))[0];
    if (!newest?.stale || list.some((j) => liveJob(j))) continue;
    found.push({ words: `recipe job ${uuid}: its newest watcher ${newest.id} was left ${newest.state} by a session whose process is gone`, record: `.timmy/recipe-jobs/${uuid}/job.json`, at: time(newest.startedAt), ...(newest.operation ? { operation: newest.operation } : {}) });
  }
  // Native runs that started, are not judged, and whose job ended with its session (or is not here and is past its time limit).
  let natives: ReturnType<typeof listNativeRuns> = [];
  try { natives = listNativeRuns(c.root); } catch { natives = []; }
  for (const n of natives) {
    if (n.verdicts.length) continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(c.root, n.run); } catch { rec = undefined; }
    const jobId = rec?.started?.job;
    if (!rec || typeof jobId !== 'string') continue;
    const job = jobOf(jobId);
    const name = `${APP_WORDS[n.app] ?? NATIVE_APPS[n.app as NativeApp]?.name ?? n.app} run ${n.run.slice(0, 8)}`;
    if (job?.stale) {
      found.push({ words: `${name}: not judged yet, and its job ${job.id} was left ${job.state} by a session whose process is gone`, record: `.timmy/native/${n.run}/job.json`, at: time(n.started_at) });
      continue;
    }
    if (job) continue;
    const until = time(rec.job.started_at) + (typeof rec.job.timeout_ms === 'number' ? rec.job.timeout_ms : 0) + 60_000;
    if (until && now >= until) found.push({ words: `${name}: not judged yet; its job ${jobId} is not in this Timmy's jobs folder and its time limit has passed`, record: `.timmy/native/${n.run}/job.json`, at: time(n.started_at) });
  }
  if (!found.length) return [];
  found.sort((a, b) => b.at - a.at);
  const first = found[0];
  return [{
    key: 'left', kind: 'left', blocks: false,
    title: `${found.length} ${found.length === 1 ? 'run was' : 'runs were'} left by a Timmy session that ended`,
    needed: 'type /recover: it reads what each left and settles what verifies (an interrupted flow gets its final record, a recipe job is followed again or its exports delivered, a native run is judged from its own result file); it runs nothing again, and it says what it leaves as it is',
    why: found.slice(0, 5).map((f) => f.words).join('; ') + (found.length > 5 ? `; and ${found.length - 5} more` : ''),
    ...(first.record ? { record: first.record } : {}),
    commands: ['/recover'],
    ...(first.operation ? { operation: first.operation } : {}), at: first.at,
  }];
}

// ── the setup the project's runs need ──────────────────────────────────────────

/** The /tools row of a code agent, as its exercised index keys it (src/code-agents agentExercisedIndex). */
function agentRow(name: unknown, local: boolean): string | undefined {
  switch (name) {
    case 'claude': return 'claude-code';
    case 'codex': return local ? CODEX_LOCAL_ROUTE : 'codex';
    case 'qwen': return 'qwen-code';
    case 'opencode': return 'opencode';
    case 'openhands': return 'openhands';
    default: return undefined;
  }
}
/** The /tools rows of the app steps of a flow of each kind. */
const FLOW_ROWS: Readonly<Record<string, string[]>> = { tray: ['recipe-tray'], scad: ['openscad'], freecad: ['freecad'], blender: ['blender'], ae: ['afterfx', 'aerender'] };

interface ToolUse { row: string; by: string; at: number; operation?: string }

/** Which /tools rows this project's own runs used or tried, each with its newest run. */
export function toolUses(c: Pick<DecisionContext, 'root' | 'chain' | 'projectId' | 'scrub'>, flows: BoardFlows): Map<string, ToolUse> {
  const uses = new Map<string, ToolUse>();
  const add = (u: ToolUse): void => { const had = uses.get(u.row); if (!had || had.at < u.at) uses.set(u.row, u); };
  let agents: ReturnType<typeof listAgentRuns> = [];
  try { agents = listAgentRuns(c.root); } catch { agents = []; }
  for (const r of agents) {
    const row = agentRow(r.agent, r.endpoint === 'local');
    if (row) add({ row, by: `/agent run ${r.run} (${AGENTS[r.agent as AgentName]?.title ?? String(r.agent)})`, at: time(r.started_at), ...(r.operation ? { operation: r.operation } : {}) });
  }
  let natives: ReturnType<typeof listNativeRuns> = [];
  try { natives = listNativeRuns(c.root); } catch { natives = []; }
  for (const n of natives) add({ row: n.app, by: `${APP_WORDS[n.app] ?? n.app} run ${n.run.slice(0, 8)}`, at: time(n.started_at) });
  for (const f of [...(flows.running ?? []), ...flows.list]) {
    const r = f.record as unknown as Obj;
    const kind = flowKind(r);
    if (!kind) continue;
    const by = `flow ${String(r.id)} (/iterate ${kind})`;
    const at = time(r.started_at);
    const operation = str(r.operation);
    for (const row of FLOW_ROWS[kind] ?? []) add({ row, by, at, ...(operation ? { operation } : {}) });
    const a = obj(r.agent);
    const row = agentRow(a?.agent, /^local endpoint/.test(String(a?.route ?? '')));
    if (row) add({ row, by, at, ...(operation ? { operation } : {}) });
  }
  try {
    for (const id of fs.readdirSync(path.join(c.root, '.timmy', 'recipe-jobs')).filter((n) => UUID.test(n))) {
      let at = 0;
      try { at = fs.statSync(path.join(c.root, '.timmy', 'recipe-jobs', id)).mtimeMs; } catch { at = 0; }
      add({ row: 'recipe-tray', by: `recipe job ${id}`, at });
    }
  } catch { /* no recipe jobs */ }
  try {
    for (const m of readMcpCalls(c.root, c.chain, 40).list) {
      const at = time(m.record.started_at);
      const by = `MCP call ${m.record.id} (${cleanLine(m.record.server, c.scrub, 40)}, ${m.record.route} route)`;
      add({ row: `mcp-cli:${m.record.route}`, by, at, ...(m.record.operation ? { operation: m.record.operation } : {}) });
      add({ row: 'mcp-cli', by, at, ...(m.record.operation ? { operation: m.record.operation } : {}) });
    }
  } catch { /* no MCP calls */ }
  for (const r of c.chain) {
    if (!r || r.project_id !== c.projectId) continue;
    const by = `${r.kind === 'turn' ? 'a chat turn' : 'an observation'} (receipt ${String(r.hash ?? '').slice(7, 15)})`;
    const op = str(r.operation_id) ? { operation: String(r.operation_id) } : {};
    if (r.kind === 'observe') add({ row: 'look', by, at: time(r.ts), ...op });
    // A chat turn asked the model through the REPL's key.
    if (r.kind === 'turn') { add({ row: 'openrouter', by, at: time(r.ts), ...op }); add({ row: 'repl', by, at: time(r.ts), ...op }); }
  }
  return uses;
}

/** The VoxVision records of the project (newest 40), with the tools each names and those it ended needing. */
function voxRecords(root: string, scrub: (t: string) => string): Array<{ file: string; action: string; at: number; command?: string; used: Set<string>; needed: Set<string>; operation?: string }> {
  let names: string[];
  try { names = fs.readdirSync(path.join(root, 'results', 'vox')).filter((n) => /^v[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
  const timed = names.map((n) => { let t = 0; try { t = fs.statSync(path.join(root, 'results', 'vox', n)).mtimeMs; } catch { t = 0; } return { n, t }; }).sort((a, b) => b.t - a.t).slice(0, 40);
  const out: ReturnType<typeof voxRecords> = [];
  for (const { n, t } of timed) {
    let r: Obj | undefined;
    try {
      const abs = path.join(root, 'results', 'vox', n);
      if (fs.lstatSync(abs).isSymbolicLink() || fs.statSync(abs).size > 1024 * 1024) continue;
      r = obj(JSON.parse(fs.readFileSync(abs, 'utf8')));
    } catch { continue; }
    if (!r || r.schema !== 'timmy.vox/1') continue;
    const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
    const used = new Set(list(r.tools).map((x) => str(x.tool)).filter((x): x is string => !!x));
    const needed = new Set(list(r.failures).filter((x) => str(x.setup)).map((x) => str(x.tool)).filter((x): x is string => !!x));
    out.push({ file: `results/vox/${n}`, action: str(r.action) ?? '?', at: time(r.made_at) || t, ...(str(r.command) ? { command: scrub(String(r.command)) } : {}), used, needed, ...(str(r.operation) ? { operation: String(r.operation) } : {}) });
  }
  return out;
}

function setupItems(c: DecisionContext, flows: BoardFlows): { items: Decision[]; other: number } {
  const items: Decision[] = [];
  let other = 0;
  // The runs are read only when some row needs setup (the live board reads this every 2 s).
  if (c.tools && c.tools.rows.some((r) => r.rung === 'needs setup')) {
    const uses = toolUses(c, flows);
    for (const row of c.tools.rows) {
      if (row.rung !== 'needs setup') continue;
      const use = uses.get(row.id);
      if (!use) { other++; continue; }
      items.push({
        key: `setup:${row.id}`, kind: 'setup', blocks: false,
        title: `${row.name.trim()} needs setup`,
        needed: row.setup ? 'do its setup step, then /tools checks it again' : 'set it up (/tools names no step for it), then /tools checks it again',
        why: `/tools found at ${stamp(time(c.tools.checkedAt))}: ${cleanLine(row.detail, c.scrub, 160)}; the newest run of this project that used it: ${use.by}, ${day(use.at)}`,
        ...(row.setup ? { steps: [cleanLine(row.setup, c.scrub, 300)] } : {}),
        commands: ['/tools'], ...(use.operation ? { operation: use.operation } : {}), at: use.at,
      });
    }
  }
  const records = c.voxTools ? voxRecords(c.root, c.scrub) : [];
  if (records.some((r) => r.used.size || r.needed.size)) {
    const needing = (c.voxTools?.() ?? []).filter((t) => t.state === 'needs setup');
    for (const t of needing) {
      const rec = records.find((r) => r.needed.has(t.tool) || r.used.has(t.tool));
      if (!rec) continue;
      items.push({
        key: `setup:vox:${t.tool}`, kind: 'setup', blocks: false,
        title: `VoxVision: ${t.name} needs setup`,
        needed: 'do its setup step, then run the action again',
        why: `VoxVision checked it now: ${cleanLine(t.detail, c.scrub, 160)}; its ${rec.action} record of ${day(rec.at)} ${rec.needed.has(t.tool) ? 'ended needing it' : 'used it'}`,
        record: rec.file,
        ...(t.setup ? { steps: [cleanLine(t.setup, c.scrub, 300)] } : {}),
        commands: rec.command ? [cleanLine(rec.command, undefined, 200)] : [], ...(rec.operation ? { operation: rec.operation } : {}), at: rec.at,
      });
    }
  }
  return { items, other };
}

// ── runs that ended needing a person ────────────────────────────────────────────

/** What a flow acted on: the parameter file, model or script it names (one key per target). */
function flowTarget(r: Obj, kind: string): string {
  const p = (k: string): string | undefined => str(obj(r[k])?.path);
  return `${kind}:${(kind === 'scad' ? p('model') : kind === 'tray' ? p('parameters') : p('script')) ?? '?'}`;
}

/** The typed command that starts a new flow like this one, from its file as it is now (as recover.ts words it). */
export function againCommand(record: unknown): string | undefined {
  const r = obj(record);
  const kind = flowKind(r);
  const instruction = str(r?.instruction);
  if (!r || !kind || !instruction) return undefined;
  if (kind === 'tray') return `/iterate tray ${quoteArg(instruction)}`;
  const file = kind === 'scad' ? str(obj(r.model)?.path) : str(obj(r.script)?.path);
  return file ? `/iterate ${kind} ${quoteArg(file)} ${quoteArg(instruction)}` : undefined;
}

function flowItems(c: DecisionContext, flows: BoardFlows): Decision[] {
  const items: Decision[] = [];
  const seen = new Set<string>();
  const all: BoardFlow[] = [...(flows.running ?? []), ...flows.list];
  for (const f of all) {
    const r = f.record as unknown as Obj;
    const kind = flowKind(r);
    if (!kind) continue;
    const target = flowTarget(r, kind);
    if (seen.has(target)) continue;
    seen.add(target);
    const outcome = String(r.outcome ?? '');
    const endedIn = str(r.ended_in);
    const id = String(r.id);
    const differs = outcome === 'differs';
    const failedCheck = outcome === 'failed' && (endedIn === 'checks' || endedIn === 'readback');
    if (f.live || !(outcome === 'interrupted' || differs || failedCheck)) continue;
    const again = againCommand(r);
    const verified = f.check.status === 'verified';
    const unverified = verified ? '' : ` (not verified: ${cleanLine(f.check.reasons.join('; ') || 'no flow receipt sealed it', c.scrub, 160)})`;
    const said = cleanLine(str(r.why) ?? 'it gives no reason', c.scrub, 220);
    const base = { record: f.file, ...(verified && f.check.receipt ? { receipt: f.check.receipt } : {}), ...(str(r.operation) ? { operation: String(r.operation) } : {}), run: id, at: time(r.ended_at) || time(r.started_at), blocks: false };
    if (outcome === 'interrupted') {
      items.push({
        ...base, key: `flow:${id}`, kind: 'interrupted',
        title: `flow ${id} (/iterate ${kind}) was interrupted in its ${endedIn ?? '?'} step`,
        needed: again ? 'decide whether to run it again: nothing resumes a flow; the command below starts a new one from its file as it is now' : 'decide whether to run it again: nothing resumes a flow (its record names no file or instruction to start a new one from)',
        why: `its record${unverified} says: ${said}`,
        commands: [...(again ? [again] : []), `/room ${id}`],
      });
    } else {
      items.push({
        ...base, key: `flow:${id}`, kind: differs ? 'differs' : 'failed',
        title: differs ? `flow ${id} (/iterate ${kind}) ended differing: its readback did not match` : `flow ${id} (/iterate ${kind}) failed in its ${endedIn} step`,
        needed: differs ? 'look at what differs (/room shows its steps), then keep the result, or change the instruction and run it again' : 'look at why (/room shows its steps), then run it again, or change the instruction',
        why: `its record${unverified} says: ${said}`,
        commands: [`/room ${id}`, `/open ${quoteArg(f.file)}`, ...(again ? [again] : [])],
      });
    }
  }
  return items;
}

function workflowItems(c: DecisionContext): Decision[] {
  const items: Decision[] = [];
  const seen = new Set<string>();
  const runs = c.jobs.filter((j) => j.kind === 'workflow').sort((a, b) => time(b.startedAt) - time(a.startedAt));
  for (const j of runs) {
    const run = runOf(j);
    if (!run) continue;
    const key = `${run.doc}\0${run.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!j.stale) continue;
    const block = j.steps.find((s) => s.state === 'running')?.name;
    items.push({
      key: `workflow:${j.id}`, kind: 'interrupted', blocks: false,
      title: `workflow run ${j.id} (${cleanLine(`${run.doc} › ${run.target}`, c.scrub, 120)}) was interrupted`,
      needed: 'decide whether to run it again: upmd does not resume a run, and Timmy does not either',
      why: `its job record says ${j.state} and its process is gone: the session that ran it ended while ${block ? cleanLine(block, c.scrub, 60) : 'a block'} ran`,
      commands: [`/run ${quoteArg(run.doc)} ${quoteArg(run.target)}`, `/jobs ${j.id}`],
      ...(j.operation ? { operation: j.operation } : {}), run: j.id, at: time(j.startedAt),
    });
  }
  return items;
}

// ── memory ──────────────────────────────────────────────────────────────────────

/** How many lessons are checked here, newest first (each check hashes its evidence; the live board reads this every 2 s). */
export const LESSONS_CHECKED = 60;

function lessonItems(c: DecisionContext, notes: string[]): Decision[] {
  const { lessons } = listLessons(c.root);
  const items: Decision[] = [];
  const newest = [...lessons].sort((a, b) => (time(b.lesson.created) - time(a.lesson.created)));
  if (newest.length > LESSONS_CHECKED) notes.push(`${newest.length - LESSONS_CHECKED} older lessons are not checked here: /lesson check all checks every one.`);
  for (const read of newest.slice(0, LESSONS_CHECKED)) {
    const l = read.lesson;
    if (l.status === 'retired') continue;
    const now = checkLesson(l, { root: c.root, chain: c.chain, projectId: c.projectId });
    const text = cleanLine(oneLine(l.text, 80), c.scrub, 80);
    const problems = cleanLine(problemsText(now.problems), c.scrub, 220);
    const base = { record: read.rel, ...(l.operation ? { operation: l.operation } : {}), at: time(l.checked) || time(l.created), blocks: false, kind: 'lesson' as const, key: `lesson:${l.id}` };
    if (l.status === 'draft') {
      items.push({
        ...base, title: `lesson ${l.id} is a draft: "${text}"`,
        needed: 'check it against its evidence: only a checked lesson is given to an agent',
        why: `recorded draft; ${now.status === 'checked' ? 'its evidence checks now' : `its evidence does not check now: ${problems}`}`,
        commands: [`/lesson check ${l.id}`, `/lesson ${l.id}`],
      });
    } else if (now.status === 'stale') {
      items.push({
        ...base, title: `lesson ${l.id} is stale: "${text}"`,
        needed: 'decide whether it still holds: restore its evidence and check it again, or retire it; it is not given to an agent meanwhile',
        why: `recorded ${l.status}${l.status === 'checked' ? ', but its evidence changed since' : ''}: ${problems}`,
        commands: [`/lesson ${l.id}`, `/lesson check ${l.id}`, `/lesson retire ${l.id}`],
      });
    } else if (l.status === 'stale') {
      items.push({
        ...base, title: `lesson ${l.id} is recorded stale, and its evidence checks again: "${text}"`,
        needed: 'check it again, so that it is given to agents again',
        why: 'recorded stale; every evidence file has its bytes now and every receipt it names verifies',
        commands: [`/lesson check ${l.id}`],
      });
    }
  }
  return items;
}

// ── the whole list ────────────────────────────────────────────────────────────

/** The board's flows, when the caller has none at hand: read and checked by the board's own reader. */
function readFlows(c: DecisionContext): BoardFlows {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(c.root, 'results', 'flows')).filter((n) => /^f[0-9a-f]{8}\.json$/.test(n)); } catch { names = []; }
  return readBoardFlows(c.root, names.map((n) => `results/flows/${n}`), { receipts: c.chain, projectId: c.projectId, scrub: c.scrub });
}

/**
 * Everything waiting on a person in the project, in order (what blocks first, then newest first in each part), the first
 * `max` kept and the rest counted. A part that cannot be read is said in a note; it never stops the others.
 */
export function gatherDecisions(c: DecisionContext): DecisionsView {
  const now = (c.now ?? Date.now)();
  const notes: string[] = [];
  const part = <T>(what: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e) { notes.push(`${what} could not be read: ${cleanLine(message(e), c.scrub, 160)}`); return fallback; }
  };
  const flows = c.flows ?? part('The flows', () => readFlows(c), { list: [], more: 0 });
  const setup = part('The setup the runs need', () => setupItems(c, flows), { items: [], other: 0 });
  const all: Decision[] = [
    ...part('The approvals', () => approvalItems(c), []),
    ...part("The board's refused saves", () => staleSaveItems(c), []),
    ...part('What an ended session left', () => leftItems(c, flows, now), []),
    ...setup.items,
    ...part('The flows', () => flowItems(c, flows), []),
    ...part('The workflow runs', () => workflowItems(c), []),
    ...part('The lessons', () => lessonItems(c, notes), []),
  ];
  all.sort((a, b) => TIER[a.kind] - TIER[b.kind] || b.at - a.at);
  const max = Math.max(1, c.max ?? DECISIONS_SHOWN);
  if (flows.more > 0) notes.push(`${flows.more} older flow records are not read here (the newest are).`);
  const operations: Record<string, string[]> = {};
  for (const d of all) if (d.operation) (operations[d.operation] ??= []).push(d.title);
  return {
    items: all.slice(0, max), more: Math.max(0, all.length - max), total: all.length, otherSetup: setup.other,
    tools: c.tools ? { checkedAt: c.tools.checkedAt, ...(c.tools.note ? { note: c.tools.note } : {}) } : { note: 'the tools are not checked yet in this session: /decisions or /room checks them (OpenRouter is not contacted)' },
    operations, notes,
  };
}

/** Marks each operation card that has an item waiting on a person (any item: shown in the room or counted). */
export function markWaiting(cards: OperationCard[] | undefined, v: Pick<DecisionsView, 'operations'> | undefined): void {
  if (!cards || !v) return;
  for (const c of cards) {
    const w = v.operations[c.id];
    if (w?.length) c.waiting = [...w];
  }
}
