/**
 * Round R4 (H48): the Timmy Control Room's picture of the active project. The operator's direction (02:26): "expose
 * agent ownership, harness/model routing, progress, handoffs, costs, cancellation and outputs."
 *
 * For every run of the project it says who owns it (the crew), how it is routed (its harness and version, its model,
 * its endpoint class and the route rule in words), where it is (its state in words, its step, how long it has run,
 * its last progress line), what it handed to whom (a flow's steps; an agent run's job and result), what it cost as
 * recorded, what it left (its outputs) and whether this REPL can stop it. The board draws it (src/repl/board-room.ts)
 * and `/room` prints it (src/room/text.ts). Nothing here runs, seals, writes or contacts anything: it only reads what
 * the runs themselves recorded, through the readers that already exist (listAgentRuns, listNativeRuns, readMcpCalls,
 * recipeResults, the board's flow reader and step strip, the job records and the runs chain).
 *
 * The evidence rules, in order:
 * - A cost comes only from what was recorded: a run's sealed receipt first, else its own record. By the absent / null /
 *   number rule, an unknown cost stays unknown with its reason, never 0; a lower bound stays "at least". A run on a local
 *   endpoint is free only because its record says so. Nothing here computes or shows a budget remaining.
 * - One charge seen through two records (an agent run's result.json and its receipt; a flow receipt that restates its
 *   agent step's cost; the same receipt read twice) is counted once: every cost has a key naming the charge.
 * - A run is stoppable here only when this REPL started it (a job) or runs it (a flow): the Stop it offers is the typed
 *   /stop through the live board's existing checks. Nothing here can stop anything by itself.
 * - "Used" (exercised) on a tool comes only from the /tools ladder, which reads it from a run's own sealed record.
 * - Every path shown is project-relative; free text goes through the caller's scrub (the project's folder as ".", the
 *   home folder as "~") and loses its control characters.
 * - R4 (H59): an agent run's or a flow's output is listed only when its file is there; a file its record names that is not
 *   there is named as missing, in words ("result.json: not written"), never as an output (src/room/outputs.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, AGENTS_DIR, endpointClass, listAgentRuns, readProgressTail, type AgentName, type AgentRunRecord } from '../code-agents/index.js';
import { openHandsRouteWords } from '../code-agents/openhands.js';
import type { CapabilityRow, Rung } from '../capabilities/index.js';
import { cleanText, readMcpCalls } from '../connectors/mcp-records.js';
import type { JobRecord } from '../jobs/index.js';
import { listNativeRuns, NATIVE_APPS, readNativeRecord, type NativeApp } from '../native/index.js';
import { RECIPE_ID } from '../recipes/index.js';
import { recipeResults } from '../repl/board-cards.js';
import { FLOWS_SHOWN, readBoardFlows, type BoardFlow, type BoardFlows } from '../repl/board-flows.js';
import { flowKind, flowSteps, projectPath, type StepState } from '../repl/board-steps.js';
import type { BoardObservation } from '../repl/board.js';
import { declaredUnknownCostUsd, hasMeasuredCostUsd, type Receipt } from '../utils/receipts.js';
import type { OperationCard } from '../ops/card.js';
import { liveProgram } from '../workflows/upmd-live.js';
// R4 (H59): an output only when its file is there; a file a record names that is not there is named as missing, in words
import { sealedBy, splitOutputs, type RoomMissing } from './outputs.js';
import type { DecisionsView } from './decisions.js';

// ── the model ─────────────────────────────────────────────────────────────────

/** Who owns a run: the groups of the crew, in the order they are drawn. */
export type RoomKind = 'chat' | 'agent' | 'flow' | 'native' | 'recipe' | 'mcp' | 'look' | 'job';
export const ROOM_KINDS: readonly RoomKind[] = ['chat', 'agent', 'flow', 'native', 'recipe', 'mcp', 'look', 'job'];
export const GROUP_TITLE: Readonly<Record<RoomKind, string>> = {
  chat: 'Chat agent (your turns)',
  agent: 'Code agents',
  flow: 'Flows (/iterate)',
  native: 'Native apps',
  recipe: 'Recipes',
  mcp: 'MCP calls',
  look: 'Look (/observe)',
  job: 'Other jobs (workflow runs, previews, tasks)',
};
/** How many recent runs of each group are shown (running ones are always shown); the rest are counted. */
export const RECENT_MAX: Readonly<Record<RoomKind, number>> = { chat: 5, agent: 5, flow: 5, native: 4, recipe: 4, mcp: 5, look: 5, job: 6 };

/** The colour a state is drawn in: only a colour, the word always says it (never green: an outcome is not an action). */
export type Tone = 'running' | 'ok' | 'failed' | 'stopped' | 'attention' | 'neutral';

/**
 * A run's cost as recorded. known: an amount its receipt or record gives (summed); free: a local endpoint, recorded as
 * no charge; unknown: a charge may have been made and its amount was not recorded (with why; never 0); none: its record
 * carries no cost at all (a native app, a recipe, an MCP call, a job): never counted as free, never summed.
 */
export interface RoomCost {
  kind: 'known' | 'free' | 'unknown' | 'none';
  /** known only: the recorded amount, in USD */
  usd?: number;
  /** unknown only: an amount recorded as a lower bound (a cancelled turn), never summed as a cost */
  atLeast?: number;
  /** the basis of a known cost or a free run, why a cost is unknown, or why none is recorded, in words */
  words: string;
}

/** One step of a handoff: who did it, its job, its state in words and its receipt, each only as the record names it. */
export interface RoomStep {
  name: string;
  owner: string;
  state: StepState | string;
  job?: string;
  receipt?: string;
  /** a few words from the record (a recipe job's id, a verdict) */
  detail?: string;
  /** the step a flow ended in, or runs now */
  here?: string;
}

/** A file a run's own record names, inside the project. */
export interface RoomOutput { role: string; path: string }

export interface RoomRun {
  kind: RoomKind;
  /** its own id: a job, an agent run, a flow, a native run token, a recipe job, an MCP call, a turn's receipt */
  id: string;
  /** who owns it */
  owner: string;
  /** its harness and version, as recorded ("version not recorded" when it is not) */
  harness?: string;
  model?: string;
  /** where its model or program ran: this machine, or over the network; absent when the record does not say */
  endpoint?: 'local' | 'remote';
  /** the route rule in words ("local endpoint, no charge", "paid: your Claude account") */
  route: string;
  /** its state in words, and the colour it is drawn in */
  state: string;
  tone: Tone;
  running: boolean;
  step?: string;
  startedAt?: string;
  endedAt?: string;
  /** how long it ran (or has run): coarse while it runs, so a live page does not redraw every poll */
  elapsed?: string;
  /** its last progress line, sanitised (control characters out, the project's and home folders scrubbed) */
  progress?: string;
  /** its record, project-relative */
  record?: string;
  /** a note on its record (a flow record no receipt sealed) */
  recordNote?: string;
  receipt?: string;
  job?: string;
  /** what this REPL can stop it with: /stop <job> or /stop <flow>, through the live board's Stop (never anything else) */
  stop?: { kind: 'job' | 'flow'; id: string };
  /** why this REPL does not stop it (another session's flow, a recipe no job of this REPL follows), and the typed command
   *  that reaches it, when there is one; without a hint, a running run this REPL cannot stop is one another session started */
  hint?: { words: string; command?: string };
  /** "the agent step of flow f…" and the like */
  partOf?: string;
  cost: RoomCost;
  /** the charge's key: a run whose charge another record also names shares its key, so it is counted once */
  costKey: string;
  /** the files its record names that are there now (R4, H59: an agent run's and a flow's are looked for) */
  outputs: RoomOutput[];
  /** R4 (H59): the files its record names that are not there, each named in words ("not written"), never as an output */
  missing?: RoomMissing[];
  /** every receipt its record names, beside the run's own */
  receipts?: string[];
  handoff?: RoomStep[];
  /** for ordering: when it started (running) or last changed (recent), in ms */
  at: number;
  /** R4 (H51): the operation (one request) it belongs to, as its record or receipt names it */
  operation?: string;
  /** R4 (H51): its role in its operation, from its kind: planner, builder, checker, observer, or "role not recorded" */
  role?: string;
}

export interface RoomGroup { kind: RoomKind; title: string; running: RoomRun[]; recent: RoomRun[]; more: number; note?: string }

/** The project's costs, as recorded: never a remaining budget. */
export interface RoomCosts {
  /** the sum of the known amounts */
  knownUsd: number;
  /** how many charges have a known amount (free runs are counted apart) */
  known: number;
  unknown: number;
  free: number;
  /** the lower bounds recorded beside unknown costs, summed: shown as "at least", never as a total */
  atLeastUsd: number;
}

/** The /tools ladder as the Control Room last checked it. */
export interface RoomTools { checkedAt: string; rows: CapabilityRow[]; note?: string }

/** What the board and /room draw: bounded and free of anything that changes on every poll. */
export interface RoomView {
  project: string;
  groups: RoomGroup[];
  /** every running run, any owner, newest first */
  running: RoomRun[];
  costs: RoomCosts;
  tools?: RoomTools;
  notes: string[];
  /** R4 (H51): the recent operations, running first, each followed through what it made (src/ops/card.ts) */
  operations?: OperationCard[];
  /** R4 (H60): what waits on a person in the project, what blocks first (src/room/decisions.ts) */
  decisions?: DecisionsView;
}

export interface Room {
  view: RoomView;
  /** every run the room read, unbounded (what /room <id> looks in) */
  all: RoomRun[];
}

/** What the room reads; the Workspace gives its own (src/repl/workspace.ts), a test gives FAKE ones. */
export interface RoomContext {
  root: string;
  project: string;
  projectId: string;
  /** this project's jobs, newest first (the board's own list) */
  jobs: readonly JobRecord[];
  /** the runs chain */
  chain: readonly Receipt[];
  /** the board's flows (records checked against the chain, running ones from their state files), already scrubbed */
  flows?: BoardFlows;
  /** the board's observation records (for one no receipt sealed) */
  observations?: readonly BoardObservation[];
  /** whether this REPL started a job, so its Stop is offered */
  mine: (jobId: string) => boolean;
  /** the flows this REPL runs (their Stop is offered) */
  activeFlows: readonly string[];
  /** a Look job whose measurement ended while its model is asked */
  asking?: (jobId: string) => { model: string; since: number; sent: boolean } | undefined;
  /** the project's folder as "." and the home folder as "~" */
  scrub: (text: string) => string;
  now?: () => number;
  tools?: RoomTools;
}

// ── small helpers ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const LIVE = new Set(['queued', 'running', 'ready']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const time = (iso: unknown): number => { const t = typeof iso === 'string' ? Date.parse(iso) : Number.NaN; return Number.isNaN(t) ? 0 : t; };
/** A receipt's short id, as the REPL names it. */
export const shortReceipt = (r: { hash?: unknown; id?: unknown }): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const usd = (n: number): string => `$${n.toFixed(4)}`;
const PROGRESS_MAX = 160;

/** A line of text as the room shows it: control characters and escapes out, one line, the folders scrubbed, cut. */
export function cleanLine(text: unknown, scrub: (t: string) => string = (t) => t, max = PROGRESS_MAX): string {
  const t = scrub(cleanText(String(text ?? ''))).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * How long a run took or has taken. While it runs, coarse (under a minute, then whole minutes), so the live board's
 * page is not redrawn on every poll; once it ended, to the second.
 */
export function elapsedWords(ms: number | undefined, running: boolean): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const s = ms / 1000;
  if (running) {
    if (s < 60) return 'under a minute';
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 120) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The route rule in words, from a run's recorded endpoint class and where it ran: "local endpoint, no charge" (the
 * endpoint rule of src/code-agents: a loopback endpoint and a model tag that is not a cloud one), "paid: your Claude
 * account" for an account agent, "paid: remote endpoint <host>" for any other endpoint. Nothing else is inferred.
 */
export function routeWords(o: { endpoint?: unknown; where?: unknown }): string {
  const where = str(o.where);
  if (o.endpoint === 'local') return 'local endpoint, no charge';
  if (o.endpoint === 'remote') {
    if (!where) return 'paid: a remote endpoint';
    return /^(your |the account)/.test(where) ? `paid: ${where}` : `paid: remote endpoint ${where}`;
  }
  return 'route not recorded';
}

// ── costs ─────────────────────────────────────────────────────────────────────

const none = (words: string): RoomCost => ({ kind: 'none', words });
/** A cost basis that names a local endpoint ("local endpoint", as sealAgent writes it; "a local endpoint: …" in a flow record's words). */
const localBasis = (basis: string | undefined): boolean => !!basis && /^(?:a )?local endpoint\b/i.test(basis);

/**
 * An agent run's cost from its record (result.json or run.json): the reported amount, free on a local endpoint, unknown
 * when it reported none; while it runs, free when its recorded route is a local endpoint, otherwise not known yet.
 */
export function agentRecordCost(r: Pick<AgentRunRecord, 'cost_usd' | 'cost_basis' | 'endpoint' | 'outcome'>, running: boolean): RoomCost {
  const basis = str(r.cost_basis);
  if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
    if (localBasis(basis) && r.cost_usd === 0) return { kind: 'free', words: 'free: a local endpoint, recorded as no charge' };
    return { kind: 'known', usd: r.cost_usd, words: `${usd(r.cost_usd)}, ${basis ?? 'as its record gives it'}` };
  }
  if (r.cost_usd === null) return { kind: 'unknown', words: `unknown: ${basis?.replace(/^unknown:\s*/, '') ?? 'no cost was reported'}` };
  if (r.endpoint === 'local') return { kind: 'free', words: `free: its recorded route is a local endpoint${running ? '; its cost is recorded when it ends' : ''}` };
  return { kind: 'unknown', words: running ? 'unknown yet: it runs on a paid route; its cost is recorded when it ends' : 'unknown: no cost was recorded (no result was written)' };
}

/**
 * A receipt's cost by the evidence rule of src/utils/receipts.ts: hasMeasuredCostUsd is a known amount; a declared
 * unknown (cost_measured: false) is unknown, with any amount it carries kept as a lower bound; neither field: none.
 */
function receiptCost(r: Receipt, words: { known: string; unknown: string; none: string }): RoomCost {
  if (hasMeasuredCostUsd(r)) return { kind: 'known', usd: r.cost_usd!, words: `${usd(r.cost_usd!)}, ${words.known}` };
  if (declaredUnknownCostUsd(r)) {
    const lower = num(r.cost_usd);
    return { kind: 'unknown', ...(lower && lower > 0 ? { atLeast: lower } : {}), words: `unknown: ${words.unknown}${lower && lower > 0 ? ` (at least ${usd(lower)} was reported)` : ''}` };
  }
  return none(words.none);
}

/** One charge as a key and its cost: entries that share a key are one charge, counted once. */
export interface CostEntry { key: string; cost: RoomCost }

/**
 * The charges the runs chain records for this project, each under the key of the run it belongs to: a turn's own
 * receipt; an agent run (agent:<run>); an observation (look:<job>); a flow receipt's cost is its agent step's, so it is
 * keyed to that agent run when its child receipts name the agent's receipt; any other receipt that records a cost, by
 * its own hash. The first receipt of a key wins, so the same receipt read twice is one charge.
 */
export function receiptCosts(chain: readonly Receipt[], projectId: string): Map<string, CostEntry & { receipt: string }> {
  const out = new Map<string, CostEntry & { receipt: string }>();
  const mine = chain.filter((r) => r && r.project_id === projectId);
  const agentRunOf = new Map<string, string>();
  for (const r of mine) if (r.kind === 'agent' && str(r.agent?.run)) agentRunOf.set(shortReceipt(r), r.agent!.run);
  const put = (key: string, r: Receipt, cost: RoomCost): void => { if (!out.has(key)) out.set(key, { key, cost, receipt: shortReceipt(r) }); };
  for (const r of mine) {
    const hasCost = hasMeasuredCostUsd(r) || declaredUnknownCostUsd(r) === 1;
    if (r.kind === 'turn') {
      put(`turn:${String(r.hash)}`, r, receiptCost(r, { known: 'as its receipt sealed it', unknown: 'its receipt marks the cost incomplete (a cancel, or a response that reported no charge)', none: 'its receipt records no cost' }));
    } else if (r.kind === 'agent' && str(r.agent?.run)) {
      const basis = str(r.agent?.cost_basis);
      const c = receiptCost(r, { known: basis ?? 'as its receipt sealed it', unknown: basis?.replace(/^unknown:\s*/, '') ?? 'no cost was reported', none: 'its receipt records no cost' });
      put(`agent:${r.agent!.run}`, r, c.kind === 'known' && c.usd === 0 && localBasis(basis) ? { kind: 'free', words: 'free: a local endpoint, sealed as no charge' } : c);
    } else if (r.kind === 'observe') {
      put(`look:${str(r.job?.id) ?? String(r.hash)}`, r, receiptCost(r, { known: 'as the response reported it, sealed on its receipt', unknown: 'a request went out and no cost was reported', none: 'no model request went out' }));
    } else if (r.kind === 'flow' && hasCost) {
      const child = (r.child_receipts ?? []).map((c) => agentRunOf.get(String(c))).find((x): x is string => !!x);
      put(child ? `agent:${child}` : `flow:${String(r.hash)}`, r, receiptCost(r, { known: "its agent step's, as its flow receipt sealed it", unknown: "its agent step's, which no response reported", none: '' }));
    } else if (hasCost) {
      // A measured 0 on a receipt that names no model, no tokens and no request is no charge at all: nothing was asked
      // (the recipe's prediction seals cost_usd: 0; r18, ledger row 157, counted it as "$0.0000 known (1 run)").
      if (hasMeasuredCostUsd(r) && r.cost_usd === 0 && !r.model_requested && !r.model_resolved && r.tokens === undefined) continue;
      put(`receipt:${String(r.hash)}`, r, receiptCost(r, { known: `as its ${r.kind} receipt sealed it`, unknown: `its ${r.kind} receipt marks the cost unknown`, none: '' }));
    }
  }
  return out;
}

/**
 * The project's costs from its charges: each key once (the first entry of a key wins: give the receipts first). Known
 * amounts are summed; free and unknown charges are counted; nothing is ever subtracted from anything.
 */
export function sumCosts(entries: Iterable<CostEntry>): RoomCosts {
  const seen = new Map<string, RoomCost>();
  for (const e of entries) if (!seen.has(e.key)) seen.set(e.key, e.cost);
  const out: RoomCosts = { knownUsd: 0, known: 0, unknown: 0, free: 0, atLeastUsd: 0 };
  for (const c of seen.values()) {
    if (c.kind === 'known' && typeof c.usd === 'number') { out.knownUsd += c.usd; out.known += 1; }
    else if (c.kind === 'free') out.free += 1;
    else if (c.kind === 'unknown') { out.unknown += 1; if (c.atLeast) out.atLeastUsd += c.atLeast; }
  }
  return out;
}

/** The costs line's parts: the known sum, the unknown count (with any lower bound), the free count, and what is not counted. */
export function costParts(c: RoomCosts): { known: string; unknown: string; free: string; rest: string } {
  const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;
  return {
    known: c.known ? `${usd(c.knownUsd)} known (${n(c.known, 'run')})` : 'no known cost recorded',
    unknown: `${n(c.unknown, 'run')} of unknown cost${c.atLeastUsd > 0 ? ` (at least ${usd(c.atLeastUsd)} reported on them)` : ''}`,
    free: `${n(c.free, 'run')} free (local endpoint)`,
    rest: 'runs that record no cost are not counted',
  };
}

/** The project's costs in one line: the known sum, the unknown and free counts; never a remaining budget, never 0 for unknown. */
export function costsLine(c: RoomCosts): string {
  const p = costParts(c);
  return `${p.known} · ${p.unknown} · ${p.free}; ${p.rest}`;
}

// ── each owner's runs ─────────────────────────────────────────────────────────

const AGENT_OWNER = (name: unknown): string => AGENTS[name as AgentName]?.title ?? String(name ?? 'a code agent');
/** A job's label names the flow it serves: "… · flow f0123abcd". */
const FLOW_OF_LABEL = /· flow (f[0-9a-f]{8})\b/;
const RECIPE_JOB = /^job ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) · /;

interface Ctx extends RoomContext {
  nowMs: number;
  /** the jobs another owner stands for (the rest are "other jobs") */
  claimed: Set<string>;
  /** each job's newest receipt in the chain */
  receiptOfJob: Map<string, Receipt>;
}

function jobOf(c: Ctx, id: string | undefined): JobRecord | undefined { return id ? c.jobs.find((j) => j.id === id) : undefined; }
/** Why a running run with neither a Stop nor a hint is not stopped here: it runs only when its job is live, and this REPL did not start it. */
export const NOT_OURS = 'Another Timmy session started it, so this REPL does not stop it.';
const liveJob = (j: JobRecord | undefined): boolean => !!j && LIVE.has(j.state) && !j.stale;
const jobWords = (j: JobRecord): string => (j.stale ? `${j.state}; its process is gone (from an earlier session)` : j.state === 'cancelled' ? 'stopped' : j.state);
const stopFor = (c: Ctx, j: JobRecord | undefined): RoomRun['stop'] => (j && liveJob(j) && c.mine(j.id) ? { kind: 'job', id: j.id } : undefined);
const span = (c: Ctx, start: number, end: number | undefined, running: boolean): string | undefined => (start ? elapsedWords((end ?? c.nowMs) - start, running) : undefined);

/** The chat agent's turns: the model each asked for and how it ended, from its sealed receipt (a turn being answered has none yet). */
function chatRuns(c: Ctx): RoomRun[] {
  const seen = new Set<string>();
  // The same receipt read twice is one turn.
  const turns = c.chain.filter((r) => r && r.kind === 'turn' && r.project_id === c.projectId && !seen.has(String(r.hash)) && !!seen.add(String(r.hash)));
  return turns.map((r): RoomRun => {
    const end = time(r.ts);
    const ms = num(r.ms);
    const start = ms !== undefined && end ? end - ms : 0;
    const tools = Array.isArray(r.tool_outcomes) ? r.tool_outcomes : [];
    const status = r.status ?? 'ok';
    const state = status === 'ok' ? 'answered' : status === 'cancelled' ? `cancelled${r.cancelled_at ? ` (${r.cancelled_at.replace(/-/g, ' ')})` : ''}` : String(status);
    const said = tools.slice(0, 4).map((t) => `${t.name} ${t.outcome}`).join(', ') + (tools.length > 4 ? ` and ${tools.length - 4} more` : '');
    return {
      kind: 'chat', id: shortReceipt(r), owner: 'Timmy chat agent', harness: 'Timmy REPL (version not recorded)',
      ...(str(r.model_requested) ? { model: r.model_requested } : {}),
      route: 'not recorded on its receipt (it names the model asked for, not the endpoint that answered)',
      state, tone: status === 'ok' ? 'ok' : status === 'cancelled' ? 'stopped' : 'failed', running: false,
      step: `${tools.length} tool call${tools.length === 1 ? '' : 's'}`,
      ...(start ? { startedAt: new Date(start).toISOString() } : {}), ...(end ? { endedAt: r.ts } : {}),
      ...(ms !== undefined ? { elapsed: elapsedWords(ms, false) } : {}),
      ...(said ? { progress: cleanLine(said, c.scrub) } : {}),
      receipt: shortReceipt(r),
      cost: none('its receipt records no cost'), costKey: `turn:${String(r.hash)}`,
      outputs: (r.files ?? []).flatMap((f) => { const p = projectPath(f.path); return p ? [{ role: f.created ? 'created' : 'written', path: p }] : []; }).slice(0, 12),
      at: end,
    };
  });
}

/** The code agents' runs (/agent, and each flow's agent step): .timmy/agents/<run>/, result.json or run.json. */
function agentRuns(c: Ctx, flowOfRun: ReadonlyMap<string, string>): RoomRun[] {
  let records: AgentRunRecord[] = [];
  try { records = listAgentRuns(c.root); } catch { records = []; }
  return records.map((r): RoomRun => {
    if (str(r.job)) c.claimed.add(r.job);
    const job = jobOf(c, r.job);
    const ended = !!r.outcome;
    // R4 (H59): a run whose REPL ended first, its record ended by recovery: interrupted, in its record's words (never a result).
    const interrupted = !ended && r.state === 'interrupted';
    const running = !ended && !interrupted && liveJob(job);
    const state = r.outcome === 'cancelled' ? 'stopped' : r.outcome
      ?? (interrupted ? `interrupted: ${cleanLine(r.why ?? 'its REPL ended first; no result was written', c.scrub, 240)}`
        : running ? (job!.state === 'queued' ? 'starting' : 'running') : job ? `${jobWords(job)}; no result was written` : 'not finished here: no result was written (its REPL ended first)');
    // Its process found gone by recovery: when it ended is not recorded, so no end time or duration is shown.
    const endUnknown = interrupted && r.recovered?.process === 'gone';
    const tone: Tone = r.outcome === 'completed' ? 'ok' : r.outcome === 'failed' || r.outcome === 'timed out' ? 'failed' : r.outcome === 'cancelled' ? 'stopped' : running ? 'running' : 'attention';
    const dir = `${AGENTS_DIR}/${r.run}`;
    const record = `${dir}/${ended ? 'result.json' : 'run.json'}`;
    const files = r.files;
    const named: RoomOutput[] = [
      ...(files ? [...files.added.map((f) => ({ role: 'added', path: f.path })), ...files.changed.map((f) => ({ role: 'changed', path: f.path }))] : []),
      ...(r.final_message?.file ? [{ role: 'its final message', path: `${dir}/${r.final_message.file}` }] : []),
      ...(r.transcript ? [{ role: 'transcript', path: `${dir}/${r.transcript}` }] : []),
      { role: 'record', path: record },
    ].flatMap((o) => { const p = projectPath(o.path); return p ? [{ role: o.role, path: p }] : []; }).slice(0, 16);
    const { outputs, missing } = splitOutputs(c.root, named); // R4 (H59)
    const receipt = r.receipt ?? (interrupted ? sealedBy(c.root, record, c.chain, c.projectId) : undefined);
    let tail: string[] = [];
    try { tail = readProgressTail(c.root, r.run, 1); } catch { tail = []; }
    const start = time(r.started_at);
    const flow = flowOfRun.get(r.run);
    const outcomeWords = r.outcome ? `${r.outcome}${r.why ? `: ${cleanLine(r.why, c.scrub, 120)}` : ''}` : running ? 'not written yet' : 'none written';
    return {
      kind: 'agent', id: r.run, owner: AGENT_OWNER(r.agent),
      harness: `${AGENTS[r.agent]?.bin ?? r.agent} ${r.agent_version ? cleanLine(r.agent_version, c.scrub, 60) : '(version not recorded)'}`,
      // R4 (H52): an OpenHands run says what its container isolates, and what it does not.
      model: r.model ?? 'its default model (none named)', endpoint: r.endpoint === 'local' ? 'local' : 'remote', route: r.agent === 'openhands' ? openHandsRouteWords(r) : routeWords(r),
      state, tone, running,
      ...(flow ? { partOf: `the agent step of flow ${flow}`, step: 'agent step' } : {}),
      ...(start ? { startedAt: r.started_at } : {}), ...(r.ended_at && !endUnknown ? { endedAt: r.ended_at } : {}),
      ...(start && !endUnknown ? { elapsed: span(c, start, r.ended_at ? time(r.ended_at) : job?.endedAt ? time(job.endedAt) : undefined, running) } : {}),
      ...(tail.length ? { progress: cleanLine(tail.at(-1), c.scrub) } : {}),
      record, ...(receipt ? { receipt } : {}), ...(str(r.job) ? { job: r.job } : {}),
      ...(stopFor(c, job) ? { stop: stopFor(c, job) } : {}),
      cost: agentRecordCost(r, running), costKey: `agent:${r.run}`,
      outputs, ...(missing.length ? { missing } : {}),
      handoff: [
        { name: 'job', owner: AGENT_OWNER(r.agent), state: job ? jobWords(job) : ended ? 'ended (its job record is not here)' : 'not found here', ...(str(r.job) ? { job: r.job } : {}) },
        { name: 'result', owner: 'Timmy (its result.json, read by its own rules)', state: outcomeWords, ...(r.receipt ? { receipt: r.receipt } : {}) },
      ],
      at: running ? start : time(r.ended_at) || start,
    };
  });
}

/** Each step's owner in a flow, by the step the record names (src/repl/iterate*.ts runs these). */
function stepOwner(step: string, r: Obj, kind: string): string {
  const part = (k: string): Obj | undefined => obj(r[k]);
  const versioned = (name: string, v: unknown): string => (str(v) ? `${name} (${cleanLine(v, undefined, 100)})` : name);
  switch (step) {
    case 'agent': return AGENT_OWNER(part('agent')?.agent);
    case 'checks': return "Timmy's own checks (no model)";
    case 'build': return `the CadQuery recipe (${str(r.recipe) ?? RECIPE_ID})`;
    case 'blender': return versioned('Blender', part('blender')?.blender_version);
    case 'openscad': return versioned('OpenSCAD', part('openscad')?.version);
    case 'freecad': return versioned('FreeCAD', part('freecad')?.version);
    case 'author': return versioned('After Effects (scripting)', part('author')?.ae_version);
    case 'render': return 'After Effects (aerender)';
    case 'readback': {
      const w = obj(part('readback')?.worker);
      if (str(w?.name)) return `${cleanLine(w!.name, undefined, 60)}${str(w?.version) ? ` ${cleanLine(w!.version, undefined, 100)}` : ''}`;
      return kind === 'scad' ? "Timmy's STL reader" : 'the readback worker (not named in the record)';
    }
    default: return 'Timmy';
  }
}
/** The record part each step keeps its job and receipt in, and the key its receipt has under `receipts`. */
const STEP_PART: Readonly<Record<string, string>> = { agent: 'agent', build: 'rebuild', blender: 'blender', openscad: 'openscad', freecad: 'freecad', author: 'author', render: 'render', readback: 'readback' };

/**
 * A flow's handoff chain, from its record alone: each step in order (the board's step strip decides the order and each
 * state, src/repl/board-steps.ts), with who did it, its job id and its receipt where the record names them. A step that
 * did not run says so; nothing is filled in.
 */
export function flowHandoff(record: unknown): RoomStep[] {
  const r = obj(record);
  const strip = flowSteps(r);
  if (!r || !strip) return [];
  const receipts = obj(r.receipts) ?? {};
  return strip.steps.map((s): RoomStep => {
    const partKey = STEP_PART[s.step];
    const part = partKey ? obj(r[partKey]) : undefined;
    const job = str(part?.job);
    const receipt = str(part?.receipt) ?? str(receipts[s.step]);
    const operation = s.step === 'build' ? str(part?.operation) : undefined;
    // The strip's few words, without what this step already says: its job, its agent's name, the recipe job's short id.
    const agentName = s.step === 'agent' ? str(obj(r.agent)?.agent) : undefined;
    const words = s.detail.split(' · ').filter((w) => w && w !== `job ${job}` && w !== agentName && !(operation && w.startsWith('recipe job ')));
    const detail = [operation ? `recipe job ${operation}` : '', ...words].filter(Boolean).join(' · ');
    return { name: s.name, owner: stepOwner(s.step, r, strip.kind), state: s.state, ...(job ? { job } : {}), ...(receipt ? { receipt } : {}), ...(detail ? { detail } : {}), ...(s.here ? { here: s.here } : {}) };
  });
}

/** The files a flow's own record names, inside the project: its editable natives and exports first, its record and logs last. */
export function flowOutputs(record: unknown, file: string): RoomOutput[] {
  const r = obj(record) ?? {};
  const p = (k: string): Obj | undefined => obj(r[k]);
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
  const out: Array<{ role: string; path: unknown }> = [
    ...list(p('rebuild')?.outputs).map((o) => ({ role: /\.(step|stp)$/i.test(String(o.path)) ? 'STEP' : 'export', path: o.path })),
    { role: 'editable .blend', path: obj(p('blender')?.blend)?.path },
    ...list(p('blender')?.renders).map((o) => ({ role: 'render', path: o.path })),
    { role: 'STL', path: obj(p('openscad')?.stl)?.path },
    { role: 'preview', path: obj(p('openscad')?.png)?.path },
    ...list(p('freecad')?.fcstd).map((o) => ({ role: 'editable .FCStd', path: o.path })),
    { role: 'STEP', path: obj(p('freecad')?.step)?.path },
    { role: 'editable .aep', path: obj(p('author')?.aep)?.path },
    { role: 'render', path: obj(p('render')?.file)?.path },
    { role: 'parameters', path: p('parameters')?.path },
    { role: 'the source the agent changed', path: obj(r.script)?.path ?? obj(r.model)?.path },
    { role: 'agent transcript', path: p('agent')?.transcript },
    { role: 'agent result', path: p('agent')?.result },
    { role: 'readback log', path: p('readback')?.log },
    ...['blender', 'openscad', 'freecad', 'author', 'render'].map((k) => ({ role: `${k} log`, path: p(k)?.log })),
    { role: 'record', path: file },
  ];
  const seen = new Set<string>();
  return out.flatMap((o) => {
    const rel = projectPath(o.path);
    if (!rel || seen.has(rel)) return [];
    seen.add(rel);
    return [{ role: o.role, path: rel }];
  });
}

/** The flows: running ones from their state files (no record yet), then their records, each checked by the board. */
function flowRuns(c: Ctx, flows: BoardFlows): RoomRun[] {
  const all: BoardFlow[] = [...(flows.running ?? []), ...flows.list];
  return all.map((f): RoomRun => {
    const r = f.record as unknown as Obj;
    const id = String(r.id ?? path.posix.basename(f.file, '.json'));
    const kind = flowKind(r) ?? 'flow';
    const outcome = String(r.outcome ?? 'unknown');
    const running = !!f.live && outcome === 'running';
    const ours = running && c.activeFlows.includes(id);
    const agent = obj(r.agent);
    for (const k of Object.values(STEP_PART)) { const j = str(obj(r[k])?.job); if (j) c.claimed.add(j); }
    const step = str(r.step);
    const handoff = flowHandoff(r);
    let progress: string | undefined;
    if (running && step === 'agent' && str(agent?.run)) {
      try { progress = readProgressTail(c.root, String(agent!.run), 1).at(-1); } catch { progress = undefined; }
    }
    progress ??= running ? handoff.find((s) => s.here)?.detail : str(r.why);
    const start = time(r.started_at);
    const route = str(agent?.route);
    const recordCost = agent ? agentRecordCost({ cost_usd: agent.cost_usd as number | null | undefined, cost_basis: str(agent.cost_basis), endpoint: route && /^local endpoint/.test(route) ? 'local' : 'remote', outcome: str(agent.outcome) as AgentRunRecord['outcome'] }, running)
      : none('its record names no agent step');
    const verified = f.check.status === 'verified';
    const { outputs, missing } = splitOutputs(c.root, flowOutputs(r, f.file)); // R4 (H59)
    return {
      kind: 'flow', id, owner: `Timmy flow (/iterate ${kind})`, harness: `/iterate ${kind}`,
      ...(str(agent?.model) ? { model: String(agent!.model) } : {}),
      ...(route ? { endpoint: /^local endpoint/.test(route) ? 'local' as const : 'remote' as const } : {}),
      route: route ? `its agent step: ${cleanLine(route, c.scrub, 80)}` : 'not recorded',
      state: running ? (ours ? 'running' : "running, as its state file says (this REPL does not run it)") : outcome, tone: running ? 'running' : outcome === 'succeeded' ? 'ok' : outcome === 'failed' || outcome === 'differs' ? 'failed' : outcome === 'cancelled' || outcome === 'stopped' ? 'stopped' : 'attention',
      running,
      ...(running && step ? { step: `its ${step} step` } : str(r.ended_in) ? { step: `ended in its ${String(r.ended_in)} step` } : {}),
      ...(start ? { startedAt: String(r.started_at), elapsed: span(c, start, time(r.ended_at) || undefined, running) } : {}),
      ...(str(r.ended_at) ? { endedAt: String(r.ended_at) } : {}),
      ...(progress ? { progress: cleanLine(progress, c.scrub) } : {}),
      record: f.file,
      ...(f.live ? { recordNote: 'its state file: no record yet' } : verified ? {} : { recordNote: `not verified: ${cleanLine(f.check.reasons.join('; ') || 'no reason was given', c.scrub, 120)}` }),
      ...(verified && f.check.receipt ? { receipt: f.check.receipt } : {}),
      ...(ours ? { stop: { kind: 'flow' as const, id } } : running ? { hint: { words: 'This REPL does not run this flow, so it does not stop it. If the REPL that ran it has ended, /recover records it as interrupted (it says when).', command: '/recover' } } : {}),
      cost: recordCost, costKey: str(agent?.run) ? `agent:${String(agent!.run)}` : `flow:${id}`,
      outputs, ...(missing.length ? { missing } : {}),
      receipts: Object.values(obj(r.receipts) ?? {}).filter((x): x is string => typeof x === 'string'),
      handoff,
      at: running ? start : time(r.ended_at) || start,
    };
  });
}

/** The native app runs (.timmy/native/<run>/): judged by their own result files; the newest few read in full. */
function nativeRuns(c: Ctx, flowOfJob: ReadonlyMap<string, string>): RoomRun[] {
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(c.root); } catch { runs = []; }
  const sealed = new Map<string, Receipt>();
  for (const r of c.chain) if (r && r.kind === 'native' && r.project_id === c.projectId && str(r.native?.run)) { sealed.set(r.native!.run!, r); if (str(r.job?.id)) c.claimed.add(r.job!.id); }
  return runs.map((n, i): RoomRun => {
    // A run not judged yet is read in full (its job may run); judged ones, the newest few.
    let rec: ReturnType<typeof readNativeRecord>;
    const last = n.verdicts.at(-1);
    if (!last || i < RECENT_MAX.native) { try { rec = readNativeRecord(c.root, n.run); } catch { rec = undefined; } }
    const jobId = rec?.started?.job ?? last?.job;
    if (jobId) c.claimed.add(jobId);
    const job = jobOf(c, jobId);
    const running = !last && liveJob(job);
    const app = NATIVE_APPS[n.app as NativeApp];
    const receipt = sealed.get(n.run);
    const version = str(receipt?.native?.blender_version) ?? str(receipt?.native?.c4d_version) ?? str(receipt?.native?.unreal_version); // R4 (H63)
    const state = last ? (last.outcome === 'ok' ? 'ok (judged by its result file)' : `${last.outcome}: ${cleanLine(last.why, c.scrub, 120)}`)
      : running ? 'running' : rec?.started ? (job ? `${jobWords(job)}; not judged yet` : 'not judged yet (its job is not listed here)') : 'submitted; it has not started';
    const flow = jobId ? flowOfJob.get(jobId) ?? FLOW_OF_LABEL.exec(job?.label ?? '')?.[1] : undefined;
    const start = time(n.started_at);
    const end = last ? time(last.judged_at) : job?.endedAt ? time(job.endedAt) : undefined;
    const outputs: RoomOutput[] = (last?.files ?? []).flatMap((f) => {
      const p = projectPath(f.path);
      return p && !f.outside && f.present && f.written ? [{ role: 'written by this run', path: p }] : [];
    }).slice(0, 12);
    return {
      kind: 'native', id: n.run, owner: app?.name ?? n.app, harness: `${app?.program ?? n.app} ${version ? cleanLine(version, c.scrub, 40) : '(version not recorded)'}`,
      endpoint: 'local', route: 'this machine (a native app); no cost recorded',
      state, tone: running ? 'running' : !last ? 'attention' : last.outcome === 'ok' ? 'ok' : last.outcome === 'failed' ? 'failed' : 'attention', running,
      ...(rec?.job.label ? { step: cleanLine(rec.job.label, c.scrub, 80) } : {}),
      ...(start ? { startedAt: n.started_at, elapsed: span(c, start, end, running) } : {}),
      record: `.timmy/native/${n.run}/job.json`,
      ...(receipt ? { receipt: shortReceipt(receipt) } : {}), ...(jobId ? { job: jobId } : {}),
      ...(stopFor(c, job) ? { stop: stopFor(c, job) } : {}),
      ...(flow ? { partOf: `a step of flow ${flow}` } : {}),
      cost: none('no cost recorded: a native app on this machine'), costKey: `native:${n.run}`,
      outputs: [...outputs, { role: 'record', path: `.timmy/native/${n.run}/job.json` }],
      at: running ? start : end || start,
    };
  });
}

/** The recipe jobs (.timmy/recipe-jobs/<uuid>/), read through the board's own (cached) recipe cards. */
function recipeRuns(c: Ctx, flowOfOperation: ReadonlyMap<string, string>): RoomRun[] {
  let cards: ReturnType<typeof recipeResults> = [];
  try { cards = recipeResults(c.root, RECENT_MAX.recipe); } catch { cards = []; }
  const watchers = c.jobs.filter((j) => j.label.startsWith(`recipe ${RECIPE_ID} `));
  for (const w of watchers) c.claimed.add(w.id);
  return cards.map((card, i): RoomRun => {
    const uuid = RECIPE_JOB.exec(card.lines?.[0] ?? '')?.[1];
    const state = card.status.word;
    const active = state === 'running' || state === 'queued';
    const watcher = uuid ? watchers.find((w) => w.label.includes(uuid) && liveJob(w)) : undefined;
    const stop = active ? stopFor(c, watcher) : undefined;
    const flow = uuid ? flowOfOperation.get(uuid) : undefined;
    const at = time(card.at);
    return {
      kind: 'recipe', id: uuid ?? `recipe-${i}`, owner: `the CadQuery recipe (${RECIPE_ID})`, harness: '/recipe tray (a durable job)',
      endpoint: 'local', route: 'this machine (the recipe worker); no cost recorded',
      state: active ? state : `${state}${card.status.detail ? `: ${cleanLine(card.status.detail, c.scrub, 120)}` : ''}`,
      tone: card.status.tone === 'ok' ? 'ok' : card.status.tone === 'failed' ? 'failed' : active ? 'running' : card.status.tone === 'running' ? 'running' : 'attention',
      running: active,
      ...(active && card.status.detail ? { progress: cleanLine(card.status.detail, c.scrub) } : {}),
      ...(at ? { startedAt: card.at, ...(active ? { elapsed: span(c, at, undefined, true) } : {}) } : {}),
      ...(uuid ? { record: `.timmy/recipe-jobs/${uuid}/job.json` } : {}),
      ...(card.receipts?.[0] ? { receipt: card.receipts[0].id } : {}),
      ...(watcher ? { job: watcher.id } : {}),
      ...(stop ? { stop } : active && uuid ? { hint: { words: `No job of this REPL follows this recipe, so it does not stop it: /recipe cancel ${uuid} asks the recipe's own cancel.`, command: `/recipe cancel ${uuid}` } } : {}),
      ...(flow ? { partOf: `the build step of flow ${flow}` } : {}),
      cost: none('no cost recorded: the recipe worker on this machine'), costKey: `recipe:${uuid ?? i}`,
      outputs: (card.files ?? []).flatMap((f) => { const p = projectPath(f.rel); return p ? [{ role: f.note ?? 'file', path: p }] : []; }),
      at,
    };
  });
}

/** The MCP calls (.timmy/mcp/<call>/call.json), each checked against its mcp.call receipt by readMcpCalls. */
function mcpRuns(c: Ctx): RoomRun[] {
  let read: ReturnType<typeof readMcpCalls>;
  try { read = readMcpCalls(c.root, c.chain, RECENT_MAX.mcp); } catch { return []; }
  return read.list.map((m): RoomRun => {
    const r = m.record;
    const url = str(r.url);
    const endpoint = r.transport === 'stdio' ? 'local' : url ? (endpointClass(url, undefined).local ? 'local' : 'remote') : undefined;
    const start = time(r.started_at);
    return {
      kind: 'mcp', id: r.id, owner: `MCP server ${cleanLine(r.server, c.scrub, 60)}`, harness: `${r.route} route (${cleanLine(r.transport, c.scrub, 20)})`,
      ...(endpoint ? { endpoint } : {}),
      route: `${r.route} over ${cleanLine(r.transport, c.scrub, 20)}${url ? ` to ${cleanLine(url, c.scrub, 80)}` : ''}; no cost recorded`,
      state: r.isError === true ? `${r.outcome} (the server answered with its own error)` : r.outcome,
      tone: r.outcome === 'answered' && r.isError !== true ? 'ok' : r.outcome === 'needs authorization' ? 'attention' : r.outcome === 'stopped' ? 'stopped' : 'failed',
      running: false, step: `tool ${cleanLine(r.tool, c.scrub, 60)}`,
      ...(start ? { startedAt: r.started_at } : {}), ...(str(r.ended_at) ? { endedAt: r.ended_at } : {}),
      ...(num(r.ms) !== undefined ? { elapsed: elapsedWords(r.ms, false) } : {}),
      ...(r.outcome !== 'answered' && str(r.error) ? { progress: cleanLine(r.error, c.scrub) } : {}),
      record: m.call,
      ...(m.check.status === 'verified' ? { receipt: m.check.receipt } : { recordNote: `not verified: ${m.check.reason}` }),
      cost: none('no cost recorded on an MCP call'), costKey: `mcp:${r.id}`,
      outputs: [{ role: 'record', path: m.call }, ...(m.output ? [{ role: 'raw output', path: m.output }] : [])],
      at: start,
    };
  });
}

/** Look: running measurements (and a model being asked), then the observations their receipts sealed, then any file no receipt names. */
function lookRuns(c: Ctx): RoomRun[] {
  const out: RoomRun[] = [];
  const seenJobs = new Set<string>();
  const looks = c.jobs.filter((j) => j.label.startsWith('look '));
  for (const j of looks) c.claimed.add(j.id);
  for (const j of looks) {
    const asking = c.asking?.(j.id);
    if (!liveJob(j) && !asking) continue;
    seenJobs.add(j.id);
    const start = time(j.startedAt);
    out.push({
      kind: 'look', id: j.id, owner: 'Look (OpenCV, on this machine)', harness: 'workers/look',
      ...(asking ? { model: asking.model, endpoint: 'remote' as const } : { endpoint: 'local' as const }),
      route: asking ? (asking.sent ? 'paid: a request sent to the model' : 'paid when sent: the model is about to be asked; nothing sent yet') : 'this machine: Look measures; no model asked yet',
      state: asking ? `measured; asking ${asking.model}` : 'measuring', tone: 'running', running: true,
      step: cleanLine(j.label, c.scrub, 80),
      ...(start ? { startedAt: j.startedAt, elapsed: span(c, start, undefined, true) } : {}),
      // While its model is asked the measurement's job has ended; /stop <job> still reaches the request (Workspace.stopAsking),
      // so the room's Stop is that same typed stop. Only this REPL's own observations are asking, never another session's.
      job: j.id, ...(stopFor(c, j) ? { stop: stopFor(c, j) } : asking && c.mine(j.id) ? { stop: { kind: 'job' as const, id: j.id } } : {}),
      cost: asking?.sent ? { kind: 'unknown', words: 'unknown yet: a request is out; its cost is recorded when it ends' } : none('no model request has gone out'),
      costKey: `look:${j.id}`, outputs: [], at: start,
    });
  }
  const sealedFiles = new Set<string>();
  const receipts = c.chain.filter((r) => r && r.kind === 'observe' && r.project_id === c.projectId);
  for (const r of receipts) {
    const job = str(r.job?.id);
    const file = projectPath(r.outputs?.[0]?.path);
    if (file) sealedFiles.add(file);
    if (job && seenJobs.has(job)) continue;
    if (job) seenJobs.add(job);
    const o = obj(r.observation);
    const spent = obj(o?.qualified) ?? obj(o?.interpretation);
    const asked = !!spent && ('cost_usd' in spent || hasMeasuredCostUsd(r) || declaredUnknownCostUsd(r) === 1);
    const model = str(spent?.model) ?? str(r.model_resolved) ?? str(r.model_requested);
    const status = r.status ?? 'ok';
    const end = time(r.ts);
    const ms = num(r.job?.ms);
    const kept = obj(o?.kept);
    const keptAt = str(kept?.path) && kept?.store !== 'timmy' ? projectPath(kept?.path) : null;
    const source = projectPath(r.files?.[0]?.path);
    out.push({
      kind: 'look', id: job ?? shortReceipt(r), owner: 'Look (OpenCV, on this machine)', harness: str(o?.worker) ? cleanLine(o!.worker, c.scrub, 60) : 'workers/look (version not recorded)',
      ...(model ? { model } : {}), endpoint: asked ? 'remote' : 'local',
      route: asked ? `paid: a request sent to ${model ?? 'the model'}` : 'this machine: Look measures; no model asked',
      state: status === 'ok' ? (spent ? `observed; ${String(spent.status ?? 'model asked')}` : 'observed') : status === 'cancelled' ? 'stopped' : `failed${str(o?.error) ? `: ${cleanLine(o!.error, c.scrub, 100)}` : ''}`,
      tone: status === 'ok' ? 'ok' : status === 'cancelled' ? 'stopped' : 'failed', running: false,
      ...(source ? { step: `observed ${source}` } : {}),
      ...(end ? { endedAt: r.ts } : {}), ...(ms !== undefined ? { elapsed: elapsedWords(ms, false) } : {}),
      ...(file ? { record: file } : keptAt ? { record: keptAt, recordNote: 'its observation file could not be written; the record is kept here' } : {}),
      receipt: shortReceipt(r), ...(job ? { job } : {}),
      cost: none('no model request went out'), costKey: `look:${job ?? String(r.hash)}`,
      outputs: [...(source ? [{ role: 'the image', path: source }] : []), ...(file ? [{ role: 'observation', path: file }] : keptAt ? [{ role: 'kept record', path: keptAt }] : [])],
      at: end,
    });
  }
  // An observation file no observe receipt names: shown as recorded; its cost unknown when a model was asked.
  for (const b of c.observations ?? []) {
    if (sealedFiles.has(b.file) || (b.job && seenJobs.has(b.job))) continue;
    const asked = (b.interpretation && b.interpretation.status !== 'not asked') || (b.qualified && b.qualified.cost_usd !== undefined);
    const model = b.qualified?.model ?? b.interpretation?.model;
    const at = time(b.madeAt);
    out.push({
      kind: 'look', id: b.job ?? b.file, owner: 'Look (OpenCV, on this machine)', harness: 'workers/look (version not recorded)',
      ...(model ? { model } : {}), endpoint: asked ? 'remote' : 'local', route: asked ? `paid: a request sent to ${model ?? 'the model'}` : 'this machine: Look measures; no model asked',
      state: 'observed, as its file says (no observe receipt names it)', tone: 'attention', running: false,
      ...(b.source?.path ? { step: `observed ${b.source.path}` } : {}), ...(b.madeAt ? { endedAt: b.madeAt } : {}),
      record: b.file, recordNote: 'not sealed: no observe receipt names this file', ...(b.job ? { job: b.job } : {}),
      cost: asked ? { kind: 'unknown', words: 'unknown: no receipt sealed what its model request cost' } : none('no model request went out'),
      costKey: `look:${b.job ?? b.file}`,
      outputs: [...(b.source?.path ? [{ role: 'the image', path: b.source.path }] : []), { role: 'observation', path: b.file }],
      at,
    });
  }
  return out;
}

/** The project's other jobs (workflow runs, previews, plain tasks): what no other owner stands for. */
function jobRuns(c: Ctx): RoomRun[] {
  return c.jobs.filter((j) => !c.claimed.has(j.id) && !FLOW_OF_LABEL.test(j.label)).map((j): RoomRun => {
    const running = liveJob(j);
    const rec = j.receipt ? c.receiptOfJob.get(j.id) : undefined;
    const done = j.steps.filter((s) => s.state !== 'running').length;
    const runningStep = j.steps.find((s) => s.state === 'running');
    const failedStep = j.steps.find((s) => s.state === 'failed');
    const start = time(j.startedAt);
    const owner = j.kind === 'workflow' ? 'upmd (a workflow run)' : j.kind === 'server' ? 'a preview server' : /^readback /.test(j.label) ? 'a readback worker' : 'a task';
    const program = path.basename(liveProgram(j) ?? j.command); // R4 (H58): a /run on a pty names upmd, not its wrapper's python3
    return {
      kind: 'job', id: j.id, owner, harness: program ? cleanLine(program, c.scrub, 40) : 'its program (not named)',
      endpoint: 'local', route: 'this machine (a job); no cost recorded',
      state: j.state === 'ready' ? `ready${j.url ? ` at ${cleanLine(j.url, c.scrub, 60)}` : ''}` : jobWords(j),
      tone: running ? 'running' : j.state === 'completed' ? 'ok' : j.state === 'failed' ? 'failed' : j.state === 'cancelled' ? 'stopped' : 'attention', running,
      step: cleanLine(j.label, c.scrub, 80),
      ...(start ? { startedAt: j.startedAt, elapsed: span(c, start, j.endedAt ? time(j.endedAt) : undefined, running) } : {}),
      ...(j.endedAt ? { endedAt: j.endedAt } : {}),
      ...(j.steps.length ? { progress: cleanLine(`${done} of ${j.steps.length} steps${runningStep ? `; ${runningStep.name} running` : failedStep ? `; ${failedStep.name} failed${failedStep.code !== undefined ? `, exit ${failedStep.code}` : ''}` : ''}`, c.scrub) }
        : j.error ? { progress: cleanLine(j.error, c.scrub) } : j.note ? { progress: cleanLine(j.note, c.scrub) } : {}),
      ...(j.receipt ? { receipt: j.receipt } : {}), job: j.id,
      ...(stopFor(c, j) ? { stop: stopFor(c, j) } : {}),
      cost: none('no cost recorded: a job on this machine'), costKey: `job:${j.id}`,
      outputs: (rec?.outputs ?? []).flatMap((o) => { const p = projectPath(o.path); return p ? [{ role: 'written during the job', path: p }] : []; }).slice(0, 12),
      at: running ? start : time(j.endedAt) || start,
    };
  });
}

// ── the whole picture ─────────────────────────────────────────────────────────

/** The flow records of a project, when the caller has none at hand: read and checked by the board's own reader. */
function readFlows(c: RoomContext): BoardFlows {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(c.root, 'results', 'flows')).filter((n) => /^f[0-9a-f]{8}\.json$/.test(n)); } catch { names = []; }
  return readBoardFlows(c.root, names.map((n) => `results/flows/${n}`), { receipts: c.chain, projectId: c.projectId, scrub: c.scrub });
}

/**
 * Every run of the project, grouped by who owns it: in each group the running ones first, then the recent ones, newest
 * first and bounded (the rest counted). Each run's cost is its receipt's when a receipt seals it, else its record's.
 */
export function gatherRoom(context: RoomContext): Room {
  const receiptOfJob = new Map<string, Receipt>();
  for (const r of context.chain) { const id = r ? str(r.job?.id) : undefined; if (id) receiptOfJob.set(id, r); }
  const c: Ctx = { ...context, nowMs: (context.now ?? Date.now)(), claimed: new Set(), receiptOfJob };
  const flows = context.flows ?? readFlows(context);
  // Who serves which flow: its agent run, its step jobs, its recipe job (each named by the flow record).
  const flowOfRun = new Map<string, string>();
  const flowOfJob = new Map<string, string>();
  const flowOfOperation = new Map<string, string>();
  for (const f of [...(flows.running ?? []), ...flows.list]) {
    const r = f.record as unknown as Obj;
    const id = String(r.id ?? '');
    const run = str(obj(r.agent)?.run);
    if (run) flowOfRun.set(run, id);
    for (const k of Object.values(STEP_PART)) { const j = str(obj(r[k])?.job); if (j) flowOfJob.set(j, id); }
    const op = str(obj(r.rebuild)?.operation);
    if (op) flowOfOperation.set(op, id);
  }
  const byKind: Record<RoomKind, RoomRun[]> = {
    chat: chatRuns(c), agent: agentRuns(c, flowOfRun), flow: flowRuns(c, flows), native: nativeRuns(c, flowOfJob),
    recipe: recipeRuns(c, flowOfOperation), mcp: mcpRuns(c), look: lookRuns(c), job: [],
  };
  for (const id of flowOfJob.keys()) c.claimed.add(id);
  byKind.job = jobRuns(c);
  // A run's cost: its receipt's when one seals its charge, else its record's.
  const sealed = receiptCosts(c.chain, c.projectId);
  const all: RoomRun[] = [];
  for (const k of ROOM_KINDS) {
    for (const run of byKind[k]) {
      const s = sealed.get(run.costKey);
      if (s && (run.kind !== 'flow' || s.cost.kind !== 'none')) run.cost = s.cost;
      all.push(run);
    }
  }
  const costs = sumCosts([...sealed.values(), ...all.map((r) => ({ key: r.costKey, cost: r.cost }))]);
  const newest = (a: RoomRun, b: RoomRun): number => b.at - a.at;
  const groups = ROOM_KINDS.map((k): RoomGroup => {
    const runs = byKind[k];
    const running = runs.filter((r) => r.running).sort(newest);
    const rest = runs.filter((r) => !r.running).sort(newest);
    const max = RECENT_MAX[k];
    return {
      kind: k, title: GROUP_TITLE[k], running, recent: rest.slice(0, max), more: Math.max(0, rest.length - max) + (k === 'flow' ? flows.more : 0),
      ...(k === 'chat' ? { note: 'A turn is shown once its receipt is sealed; one being answered now is in the REPL, where Ctrl+C cancels it.' } : {}),
      ...(k === 'mcp' ? { note: 'An MCP call is kept once it ends; one in progress is in the REPL.' } : {}),
    };
  });
  const notes: string[] = [];
  if (flows.more > 0) notes.push(`${flows.more} older flow records are not read here (the board reads the newest ${FLOWS_SHOWN}).`);
  return {
    view: {
      project: c.project, groups, running: all.filter((r) => r.running).sort(newest).slice(0, 40), costs,
      ...(c.tools ? { tools: c.tools } : {}), notes,
    },
    all,
  };
}

/**
 * One run by its id: a job, an agent run, a flow, a native run (or its first 8 characters), a recipe job (or its first
 * 8), an MCP call, a turn's or an observation's receipt. Exact ids first, then a unique prefix of 8 or more.
 */
export function findRun(all: readonly RoomRun[], id: string): RoomRun | undefined {
  const q = id.trim();
  if (!q) return undefined;
  const exact = all.find((r) => r.id === q) ?? all.find((r) => r.job === q && r.kind !== 'job') ?? all.find((r) => r.job === q) ?? all.find((r) => r.receipt === q);
  if (exact) return exact;
  if (q.length < 8) return undefined;
  const prefix = all.filter((r) => r.id.startsWith(q));
  return prefix.length === 1 ? prefix[0] : undefined;
}

// ── tools and connections ─────────────────────────────────────────────────────

/**
 * A panel group; `advanced`, the rows outside the named groups (an advanced view: the board folds it away). R4 (H65): `apart`,
 * a group the panel draws on its own whose rows /room's needs-setup line still counts with the other rows (VoxVision's).
 */
export interface ToolGroup { title: string; rows: Array<CapabilityRow & { missing?: true }>; note?: string; advanced?: true; apart?: true }

/** Which /tools rows go in which panel group. */
const CREATIVE = ['blender', 'openscad', 'freecad', 'afterfx', 'aerender', 'c4dpy', 'recipe-tray'];
const AGENTS_ROWS = ['claude-code', 'codex', 'codex-local', 'qwen-code', 'opencode'];
const MODEL_ROWS = ['openrouter', 'ollama'];
const VISION = (id: string): boolean => id === 'look' || id === 'adapters' || id.startsWith('adapter:') || id === 'spatial-review';
const MCP = (id: string): boolean => id === 'mcp-cli' || id.startsWith('mcp-cli:');
/** R4 (H65, H61's note in ledger row 160): VoxVision's own rows (src/vox/tools.ts voxCapabilityRows, ids vox:<tool>). */
const VOX = (id: string): boolean => id.startsWith('vox:');
const VOX_NOTE = 'VoxVision\'s own readers and viewers, for /inspect, /measure, /detect, /compare and /vox view: built in or found is here, not run; an action says whether each works.';

/**
 * The /tools ladder as the panel's groups: the creative apps (Blender, OpenSCAD, FreeCAD, After Effects, Cinema 4D,
 * Houdini, the CadQuery recipe), the agents, MCP, the vision tools, VoxVision's readers and viewers, the models, then every
 * other row. A row is kept as /tools gives it (its rung, its detail, its setup step, its "used" date); Houdini has no /tools
 * row, and the panel says only that.
 */
export function toolGroups(rows: readonly CapabilityRow[]): ToolGroup[] {
  const by = (ids: readonly string[]): CapabilityRow[] => ids.flatMap((id) => rows.filter((r) => r.id === id));
  const used = new Set<string>();
  const take = (list: CapabilityRow[]): CapabilityRow[] => { for (const r of list) used.add(r.id); return list; };
  const creative = take(by(CREATIVE));
  const houdini: CapabilityRow & { missing: true } = { id: 'houdini', kind: 'adapter', name: 'Houdini', rung: 'not built', detail: '/tools has no row for Houdini, so nothing was checked here', missing: true };
  const groups: ToolGroup[] = [
    { title: 'Creative apps', rows: [...creative, ...(rows.some((r) => /houdini/i.test(r.id)) ? [] : [houdini])] },
    { title: 'Agents', rows: take(by(AGENTS_ROWS)) },
    { title: 'MCP', rows: take(rows.filter((r) => MCP(r.id))) },
    { title: 'Vision', rows: take(rows.filter((r) => VISION(r.id))) },
    { title: 'VoxVision', rows: take(rows.filter((r) => VOX(r.id))), note: VOX_NOTE, apart: true },
    { title: 'Models', rows: take(by(MODEL_ROWS)), note: 'The Control Room does not contact OpenRouter: /tools checks the key.' },
  ];
  const rest = rows.filter((r) => !used.has(r.id));
  if (rest.length) groups.push({ title: 'Everything else /tools checks', rows: rest, advanced: true });
  return groups.filter((g) => g.rows.length);
}

/** The named groups' rows that need setup (the step shown), in the panel's order; /tools' other rows are counted apart. */
export function needsSetup(rows: readonly CapabilityRow[]): CapabilityRow[] {
  return toolGroups(rows).filter((g) => !g.advanced && !g.apart).flatMap((g) => g.rows.filter((r) => r.rung === 'needs setup' && !('missing' in r)));
}

/** How many rows the named groups hold (Houdini's placeholder not counted), and how many of /tools' other rows need setup. */
export function setupCounts(rows: readonly CapabilityRow[]): { named: number; otherNeedSetup: number } {
  const groups = toolGroups(rows);
  return {
    named: groups.filter((g) => !g.advanced && !g.apart).reduce((n, g) => n + g.rows.filter((r) => !('missing' in r)).length, 0),
    otherNeedSetup: groups.filter((g) => g.advanced || g.apart).reduce((n, g) => n + g.rows.filter((r) => r.rung === 'needs setup').length, 0),
  };
}

/** A tools check's rows with the project's and home folders scrubbed from their words (the /tools wording otherwise kept). */
export function scrubRows(rows: readonly CapabilityRow[], scrub: (t: string) => string): CapabilityRow[] {
  return rows.map((r) => ({ ...r, name: scrub(r.name), detail: scrub(r.detail), ...(r.setup ? { setup: scrub(r.setup) } : {}) }));
}

/** A rung as the ladder words it (src/capabilities/render.ts's legend). */
export const RUNG_WORDS: Readonly<Record<Rung, string>> = {
  'reachable': 'answered just now', 'installed': 'here, not contacted', 'needs setup': 'do the step', 'not built': 'planned only',
};
