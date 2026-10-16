/**
 * R5 (H137): the body of tab 7, Control Room (src/contracts/workspace.ts TABS: "Devices, harnesses, jobs, chat turns and
 * decisions: what runs, what ended, what waits"), laid out as the operator's references 07 and 14 lay theirs out:
 *
 *   ROSTER (left)    the harnesses: the six lane programs (src/agent/lanes.ts DEFAULT_LANE_BINDINGS, as /lanes and timmy
 *                    tools have them), each found on PATH, a FAKE stand-in (its own first lines say so) or not installed, and
 *                    running only when a record shows it (a live job of /agent <lane>, or a dispatch record that says so);
 *                    this computer's surfaces (the Workbench, the REPL, the companion, Studio) as the workspace frame's
 *                    connections and the records say; the devices of Timmy Connect (src/connect/read.ts readConnect), each
 *                    with its last probe and the word for it
 *   PANES (centre)   one box per running job, with its log's last lines (read again at each tick of the Workbench, as the pane
 *                    says: no job of Timmy's tells a reader that it printed), and per chat turn being answered (its hold,
 *                    src/agent/chat-turn.ts runningTurns, read only); in the PANES_MAX slots they leave, the newest ended runs
 *                    as quiet panes with their exit and receipt (green only when verifyReceiptIn confirms it in this reading);
 *                    the selected pane's frame amber and heavy
 *   right            WAITING ON YOU (the decisions, as the Control Room always had them), the selected run's detail (the one
 *                    run detail, src/contracts/run-detail.ts), RECENT and CHAT TURNS (sealed, every surface's)
 *
 * From 120 terminal columns the three sit side by side (src/workbench/tab-columns.ts, as tabs 0 and 8), each keeping its
 * selection in its own rows (a clipped column says which of its rows show: "↓ a–b of n rows"); below that they are stacked:
 * the panes, what waits, the run detail, the recent runs and turns, then the roster. From GRID_FROM body cells (160 terminal
 * columns) the panes are the references' 2×2 grid, the roster compact and the right column narrower: ← → move inside a row,
 * ↑ ↓ between rows; more panes than four are said, with how to reach them. A terminal draws no picture: live previews
 * (carbonyl) are not drawn here, and the companion (c) shows pages. Marks: ▶ running (never ●, which is a live connection
 * only), ✓ completed or verified, ✕ failed (amber), ■ stopped; every mark has its word beside it.
 *
 * readControl reads files only: nothing here runs a program, contacts a device, writes, or asks the network.
 */
import { accessSync, closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { runningTurns, surfaceWords, type OtherTurn } from '../agent/chat-turn.js';
import { DEFAULT_LANE_BINDINGS, LANE_RUNNERS } from '../agent/lanes.js';
import { readConnect, type ConnectView } from '../connect/read.js';
import type { ChatSurface } from '../contracts/chat-session.js';
import type { JobRecord } from '../jobs/index.js';
import { LIVE_FOR_MS, turnStopWords } from '../ops/workspace-frame.js';
import { sameFolder } from '../project/index.js';
import type { Decision as WaitDecision } from '../room/decisions.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes, tildePath } from '../utils/home-scrub.js';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import type { Glyphs } from './frame.js';
import { connectionMark, tookWords, turnEndWords } from './hub.js';
import type { Data, TurnRow, TurnView, Ui } from './model.js';
import { lineText } from './output.js';
import { TURNS_SHOWN, type JobRow } from './state.js';
import {
  card, clipRows, fieldRows, flow, heading, onBar, para, rowsOf, S, selectedIn, sideBySide, sideBySideAt, RULE_CELLS, widths, type TabCtx,
} from './tab-columns.js';
import { clock, count, cut, fit, lineCells, took, wrapText, type Line, type Role, type Seg } from './text.js';

type Env = Record<string, string | undefined>;

/** The Workbench list the tab's selection is kept in (src/workbench/screen.ts: `center:<workspace>`). */
export const CONTROL_LIST = 'center:control';
/** How many panes the Control Room fills (the references' 2×2 grid): every run that is running first, then the newest ended
 *  runs in the slots left, as quiet panes. More running than this: the grid shows four at a time and says how many more. */
export const PANES_MAX = 4;
/** How many of a pane's log lines are drawn: at least (where there is room), and at most. */
export const TAIL_MIN = 3;
export const TAIL_MAX = 6;
/** The panes as a 2×2 grid from this many body cells (160 terminal columns give 156): a compact roster, two panes of at least
 *  GRID_PANE_MIN cells side by side, a narrower right column, and the two rules between them. Below it the panes stack. */
export const GRID_PANE_MIN = 44;
const GRID_GAP = 1;
const ROSTER_MIN = 22;
const RIGHT_MIN = 36;
export const GRID_FROM = ROSTER_MIN + 2 * GRID_PANE_MIN + GRID_GAP + RIGHT_MIN + 2 * RULE_CELLS;
/** How many rows of panes the grid shows at a time; a pane's height there, at least (else the keys and the words below the
 *  grid give it their rows) and at most (a taller grid leaves the rest below it). */
const GRID_ROWS = 2;
const PANE_H_MIN = 8;
const PANE_H_MAX = 14;
/** The Workbench's own tick (src/workbench/controller.ts), when the reading is not told it: a pane's log is read this often. */
const TICK_MS = 1000;
/** The most bytes of a log's end read for its last lines. */
const TAIL_BYTES = 16 * 1024;
/** How many ended runs RECENT counts and lists (the newest), as the Control Room always did. */
export const RECENT_MAX = 30;
/** The columns' shares of the body: the roster, the panes, the right column (side by side from 120 terminal columns: tab-columns.ts). */
const WEIGHTS = [25, 40, 35] as const;

/** The line under the panes: a terminal draws no picture (the operator's reference 07 shows carbonyl previews). */
// R5 (H131; the QA of e7f853e, defect 2): no Timmy surface draws a live preview yet; the companion's page is this, in words
export const PREVIEWS_WORDS = 'No Timmy surface draws live previews (carbonyl) yet; the companion (c) shows this tab\'s runs and chat turns in a browser page, in words.';
/** What the references' Add harness, Remove harness, Add pane, Remove pane and Broadcast are, in Timmy now (words only: nothing
 *  here is drawn as a button). */
export const HARNESS_WORDS = 'Add a harness: install its program (/lanes says how); timmy watch --lanes starts the lanes. Remove a harness, add or remove a pane (the panes follow what runs), broadcast to every pane: not in Timmy yet.';
/** Today's words about a turn being answered (the Control Room's, since R4 H117). */
export const TURN_STOP_WORDS = 'A turn being answered now is on the surface that sent it, where Esc (the Workbench) or Ctrl+C (the REPL) stops it.';

/** The six lane programs, in their sessions' order (src/agent/lanes.ts DEFAULT_LANE_BINDINGS: /lanes and timmy tools read them). */
export const LANE_ORDER: readonly string[] = Object.keys(DEFAULT_LANE_BINDINGS).sort((a, b) => Number(a) - Number(b)).map((k) => DEFAULT_LANE_BINDINGS[k]);

const key = (k: string): Seg => S(`[${k}]`, 'action');
/** A key and what it does, the words wrapped under themselves beside the key where the row is narrow (never cut). */
const keyRows = (k: string, words: string, w: number): Line[] => {
  const pad = k.length + 3;
  const [first = '', ...rest] = wrapText(words, Math.max(6, w - pad));
  return [[key(k), S(` ${first}`, 'secondary')], ...rest.map((r): Line => [S(' '.repeat(pad)), S(r, 'secondary')])];
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ago = (iso: string | number | undefined | null, now: number): string => {
  const t = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return 'at an unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

// ── the reading ────────────────────────────────────────────────────────────────

export interface LaneRow {
  id: string;
  label: string;
  /** found: an executable file of its name on PATH (found, not checked: nothing runs it); fake: that file is a FAKE stand-in
   *  (its own first lines say so, as the review package's do); none: not on PATH */
  program: 'found' | 'fake' | 'none';
  /** where it was found, from ~ */
  path?: string;
  /** how to install it (src/agent/lanes.ts), as /lanes says it */
  install?: string;
  /** what a record shows running it: a live job of /agent <lane>, or a dispatch record that says it runs (its tmux session is
   *  not asked); absent: no process or record shows it running, so it is never said to run */
  running?: { by: 'job' | 'dispatch'; id: string; since: string };
  /** its newest ended run here (a job of /agent <lane>) */
  last?: { id: string; word: string; mark: JobRow['mark']; at: string };
}

/** A device's last probe, in one word: live (an answer seen within the frame's 30 minutes), reached (longer ago), unreachable,
 *  needs you (a host key to confirm), refused (its key refused, or its host key changed), error, or not probed. */
export type DeviceState = 'live' | 'reached' | 'unreachable' | 'needs you' | 'refused' | 'error' | 'not probed';

export interface DeviceRow {
  id: string;
  name: string;
  state: DeviceState;
  /** its last probe's words (paths from ~), or what probes it */
  words: string;
  at: string | null;
  /** what waits on a person for it (src/connect/words.ts deviceNeeds) */
  needs: string[];
  /** its remote jobs as Timmy last knew them: how many its status files said run, and how many there are */
  running: number;
  jobs: number;
}

/** A chat turn being answered now, as its hold names it (src/agent/chat-turn.ts OtherTurn). */
export interface LiveTurnRow { surface: ChatSurface; pid: number; taken: string; mine: boolean; proof: 'alive' | 'unknown'; /** R5 (H131): its hold's id, the turn's identity */ id?: string }

/** A pane's log: its last lines (escapes removed, homes written from ~, the project's folder as .), or why there are none.
 *  `every`: while the job runs, how often its log is read again (the Workbench's tick: no job of Timmy's tells a reader of its
 *  log that it printed, so the pane says how often it looks). */
export type PaneTail = ({ lines: string[] } | { why: string }) & { every?: number };

/** A quiet pane's receipt, checked in this reading: verified (verifyReceiptIn: its chain link, body hash and signature), not
 *  verified with why, or not found on the chain read here. */
export type ReceiptCheck = { state: 'verified' } | { state: 'failed'; reason: string } | { state: 'not found'; reason: string };

export interface ControlData {
  /** when this reading was made (ISO) */
  at: string;
  lanes: LaneRow[];
  devices: DeviceRow[];
  /** the chat turns being answered now (their holds in <project>/.timmy/chat-turns, read without removing a stale one) */
  turns: LiveTurnRow[];
  /** each pane's log, by job id */
  tails: Record<string, PaneTail>;
  /** each quiet pane's receipt, by job id */
  receipts: Record<string, ReceiptCheck>;
  /** what could not be read, each with why */
  notes: string[];
}

export interface ControlReadInput {
  /** the project shown */
  root: string;
  /** Timmy's home (Timmy Connect's records are under it); TIMMY_HOME, else ~/timmy */
  home?: string;
  /** PATH (where the lane programs are looked for) and the home folders the words are written from */
  env?: Env;
  /** the job store as the Workbench read it: each job's log is named by its record */
  records: readonly JobRecord[];
  /** the project's jobs (src/workbench/state.ts readJobs), newest first, and this Workbench's runs in another project */
  jobs: readonly JobRow[];
  away?: readonly JobRow[];
  /** the chain the project's seals go to, for the quiet panes' receipts (none: they are said not verified here) */
  chain?: readonly Receipt[];
  now?: number;
  /** the turns being answered (a test's FAKE); else runningTurns, read only */
  turns?: () => readonly OtherTurn[];
  /** Timmy Connect's records (a test's FAKE); else readConnect */
  connect?: (home: string) => ConnectView;
  /** what each running job printed as the Workbench read it for Activity (src/workbench/output.ts OutputWatch: its log from a
   *  byte offset, every tick, a drawing run read as its blocks' output): a running pane's lines are these where its job is read */
  output?: { watching(job: string): boolean; lines(job: string): ReadonlyArray<{ text: string }> };
  /** how often the Workbench reads again while the tab is shown (its tick, ms); TICK_MS when not said */
  tickMs?: number;
}

/** Where `program` is on PATH (the first executable file of its name), or null: nothing is run. */
function onPathFile(program: string, env: Env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, program);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** A FAKE lane stand-in says so in its own first lines (scripts/review/fake-lanes: "# FAKE lane stand-in …"). */
export const STAND_IN = /FAKE lane stand-in|FAKE LANE/;

/** Whether the file found is a FAKE stand-in: its first 1 KB read (never run). */
function standIn(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return STAND_IN.test(buf.subarray(0, n).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/** The lane a job of /agent runs (src/code-agents agentLabel: "agent <name> a<8 hex>: <task>"), or null. */
export const agentOf = (label: string): string | null => /^agent ([a-z][a-z0-9-]*) a[0-9a-f]{8}: /.exec(label)?.[1] ?? null;

/** The dispatch records (<project>/.timmy/dispatch, src/utils/dispatch.ts) that say a lane runs: their files read, nothing
 *  asked of tmux (a record can say running after its session is gone: the roster says it is the record's word). */
function dispatchRunning(root: string, notes: string[]): Array<{ id: string; harness: string; since: string }> {
  const dir = join(root, '.timmy', 'dispatch');
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') notes.push(`The dispatch records could not be read (${code ?? 'error'}): no lane is said to run from them`);
    return [];
  }
  const out: Array<{ id: string; harness: string; since: string }> = [];
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { id?: unknown; lifecycle?: unknown; dispatched_at?: unknown; plan?: { harnesses?: unknown } };
      const h = Array.isArray(s.plan?.harnesses) ? (s.plan!.harnesses as unknown[])[0] : undefined;
      if (s.lifecycle === 'running' && typeof s.id === 'string' && typeof h === 'string') out.push({ id: s.id, harness: h, since: typeof s.dispatched_at === 'string' ? s.dispatched_at : '' });
    } catch { /* not a dispatch record: it shows nothing running */ }
  }
  return out.sort((a, b) => b.since.localeCompare(a.since));
}

function laneRows(root: string, env: Env, rows: readonly JobRow[], notes: string[]): LaneRow[] {
  const dispatched = dispatchRunning(root, notes);
  return LANE_ORDER.map((id): LaneRow => {
    const r = LANE_RUNNERS[id];
    const file = r ? onPathFile(r.cmd, env) : null;
    const program: LaneRow['program'] = !file ? 'none' : standIn(file) ? 'fake' : 'found';
    const job = rows.find((j) => j.live && agentOf(j.label) === id);
    const dp = dispatched.find((x) => x.harness === id);
    const last = rows.find((j) => !j.live && agentOf(j.label) === id);
    return {
      id, label: r?.label ?? id, program,
      ...(file ? { path: tildePath(file, env as NodeJS.ProcessEnv) } : {}),
      ...(r?.install ? { install: r.install } : {}),
      ...(job ? { running: { by: 'job' as const, id: job.id, since: job.startedAt } } : dp ? { running: { by: 'dispatch' as const, id: dp.id, since: dp.since } } : {}),
      ...(last ? { last: { id: last.id, word: last.word, mark: last.mark, at: last.endedAt ?? last.startedAt } } : {}),
    };
  });
}

function deviceRows(home: string, now: number, connect: (home: string) => ConnectView, env: Env, notes: string[]): DeviceRow[] {
  let v: ConnectView;
  try { v = connect(home); } catch (e) { notes.push(`Timmy Connect's records could not be read: ${msg(e)}`); return []; }
  for (const u of v.unreadable) notes.push(`Timmy Connect: ${u.record} could not be read (${u.why}); its state is unknown`);
  return v.devices.map((d): DeviceRow => {
    const p = d.probe;
    const t = p ? Date.parse(p.at) : Number.NaN;
    const state: DeviceState = !p ? 'not probed'
      : p.outcome === 'connected' ? (Number.isFinite(t) && now - t <= LIVE_FOR_MS ? 'live' : 'reached')
        : p.outcome === 'unreachable' ? 'unreachable'
          : p.outcome === 'host-key-unconfirmed' ? 'needs you'
            : p.outcome === 'host-key-changed' || p.outcome === 'auth-refused' ? 'refused' : 'error';
    const jobs = v.jobs.filter((j) => j.device === d.id);
    return {
      id: d.id, name: d.name, state, words: scrubHomes(p ? p.words : `not probed yet: timmy connect probe ${d.id}`, env as NodeJS.ProcessEnv),
      at: p?.at ?? null, needs: d.needs.map((n) => scrubHomes(n, env as NodeJS.ProcessEnv)), running: jobs.filter((j) => j.state === 'running').length, jobs: jobs.length,
    };
  });
}

/** A log's last `n` printed lines (each as a terminal would leave it: after its last carriage return), or why none. */
function tailOf(file: string, n: number, clean: (t: string) => string): PaneTail {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === 'ENOENT' ? 'no log yet (it printed nothing, or never started)' : `its log could not be read (${code ?? 'error'})` };
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    const got = readSync(fd, buf, 0, buf.length, from);
    const raw = buf.subarray(0, got).toString('utf8').split('\n');
    // a read that starts inside a line leaves that line out
    if (from > 0) raw.shift();
    const lines = raw.map((l) => {
      const shown = l.split('\r').filter((p) => p.trim()).pop() ?? '';
      return clean(lineText(shown));
    }).filter((l) => l.trim());
    return { lines: lines.slice(-n) };
  } catch (e) {
    return { why: `its log could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    try { closeSync(fd); } catch { /* closed */ }
  }
}

/** A job's receipt (its short id, as the job store keeps it) checked against `chain`: found by its id and its job, then
 *  verified there (src/utils/receipts.ts verifyReceiptIn). */
export function checkReceipt(chain: readonly Receipt[], job: string, short: string): ReceiptCheck {
  const found = chain.filter((r) => typeof r.hash === 'string' && r.hash.slice(7, 15) === short && r.job?.id === job);
  if (!found.length) return { state: 'not found', reason: 'not found on the chain read here' };
  if (found.length > 1) return { state: 'not found', reason: 'more than one receipt of this job has this id' };
  const v = verifyReceiptIn(chain, found[0].hash);
  return v.ok ? { state: 'verified' } : { state: 'failed', reason: v.reason };
}

/** The jobs drawn as panes: every live one of the project, and this Workbench's runs in another project (`away`, as the
 *  Control Room always listed them apart); then, in the PANES_MAX slots the running ones (chat turns being answered among them)
 *  leave, the project's newest ended runs, as quiet panes. */
export function paneJobs(jobs: readonly JobRow[], away: readonly JobRow[], turnsRunning: number): { live: JobRow[]; away: JobRow[]; quiet: JobRow[] } {
  const live = jobs.filter((j) => j.live);
  const elsewhere = away.filter((j) => j.live);
  const left = Math.max(0, PANES_MAX - live.length - elsewhere.length - turnsRunning);
  return { live, away: elsewhere, quiet: jobs.filter((j) => !j.live).slice(0, left) };
}

/**
 * The tab's reading: the lanes on PATH and what records show them running, the devices of Timmy Connect, the turns being
 * answered, each pane's log and each quiet pane's receipt. Reads files only.
 */
export function readControl(i: ControlReadInput): ControlData {
  const env = i.env ?? process.env;
  const now = i.now ?? Date.now();
  const notes: string[] = [];
  let turns: LiveTurnRow[] = [];
  try {
    turns = [...(i.turns ? i.turns() : runningTurns(i.root, undefined, { readOnly: true }))].map((t) => ({ surface: t.surface, pid: t.pid, taken: t.taken, mine: t.mine, proof: t.proof, ...(t.id ? { id: t.id } : {}) }));
  } catch (e) { notes.push(`The chat turns being answered could not be read: ${msg(e)}`); }
  const away = i.away ?? [];
  const lanes = laneRows(i.root, env, [...i.jobs, ...away], notes);
  const devices = deviceRows(i.home ?? timmyHome(env), now, i.connect ?? readConnect, env, notes);
  const panes = paneJobs(i.jobs, away, turns.length);
  const tails: Record<string, PaneTail> = {};
  const receipts: Record<string, ReceiptCheck> = {};
  const every = i.tickMs ?? TICK_MS;
  for (const j of [...panes.live, ...panes.away, ...panes.quiet]) {
    // a running job: the lines the Workbench read of it for Activity (the same lines, read from where it last looked), else its
    // log's end; either way read again at the next tick, as the pane says. An ended one: its log's end, as it ended.
    if (j.live && i.output?.watching(j.id)) { tails[j.id] = { lines: i.output.lines(j.id).map((l) => l.text).filter((t) => t.trim()).slice(-TAIL_MAX), every }; continue; }
    const rec = i.records.find((r) => r.id === j.id);
    const tail = rec ? tailOf(rec.logPath, TAIL_MAX, (t) => scrubHomes(t.split(j.root).join('.'), env as NodeJS.ProcessEnv)) : { why: 'its record was not read here' };
    tails[j.id] = j.live ? { ...tail, every } : tail;
  }
  if (i.chain) for (const j of panes.quiet) if (j.receipt) receipts[j.id] = checkReceipt(i.chain, j.id, j.receipt);
  return { at: new Date(now).toISOString(), lanes, devices, turns, tails, receipts, notes };
}

// ── the items ──────────────────────────────────────────────────────────────────

/** The tab's selectable things, in the order the arrows move through them: the panes (running jobs and turns, or the quiet
 *  ones), what waits on you, the recent runs, the sealed chat turns. Keys as the Control Room always had them. */
export type ControlItem =
  | { kind: 'job'; key: string; job: JobRow }
  | { kind: 'live-turn'; key: string; live: LiveTurnRow }
  | { kind: 'decision'; key: string; decision: WaitDecision }
  | { kind: 'turn'; key: string; turn: TurnRow };

/** The View shape (src/workbench/model.ts) over the tab's own items; `x`: the cells of the body an item is drawn in, when the
 *  columns sit side by side (a click on that row in another column is not on it). */
export interface ControlView {
  lines: Line[];
  items: Array<{ line: number; item: ControlItem; rows?: number; x?: { from: number; to: number }; near?: Near }>;
}

/** Where each arrow moves from an item drawn in a grid (the item's place among the view's items); an arrow it does not name
 *  moves as in any list (↑ ↓ to the item before or after; ← → nowhere). */
export interface Near { up?: number; down?: number; left?: number; right?: number }

/** The columns' widths where the panes are a grid (GRID_FROM body cells and wider): the roster compact, two panes of at least
 *  GRID_PANE_MIN cells side by side in the middle, the right column narrower; what is beyond the least shared 15 : 55 : 30. */
export function gridWidths(W: number): [number, number, number] {
  const total = W - 2 * RULE_CELLS;
  const extra = Math.max(0, total - (GRID_FROM - 2 * RULE_CELLS));
  const roster = ROSTER_MIN + Math.floor(extra * 0.15);
  const right = RIGHT_MIN + Math.floor(extra * 0.3);
  return [roster, total - roster - right, right];
}

/** Where the arrows move from the `i`th of `n` panes laid out two to a row (row by row): ← → inside its row, ↑ ↓ to the pane
 *  above or below it; at the grid's top and bottom rows ↑ ↓ move on as in any list. */
export function gridNear(i: number, n: number): Near {
  const out: Near = {};
  if (i % 2 === 0 && i + 1 < n) out.right = i + 1;
  if (i % 2 === 1) out.left = i - 1;
  if (i + 2 < n) out.down = i + 2;
  if (i - 2 >= 0) out.up = i - 2;
  return out;
}

/** A live turn's key: its surface, its process and when it took the project. */
export const liveTurnKey = (t: LiveTurnRow): string => `live-turn:${t.surface}:${t.pid}:${t.taken}`;

/** What the tab is drawn from: TabCtx's parts (src/workbench/tab-columns.ts: side by side from 120 terminal columns, decided by
 *  ViewCtx.columns), and the parts of ViewCtx the Control Room reads besides (src/workbench/views.ts). */
export interface ControlCtx extends TabCtx {
  ui: Pick<Ui, 'cursor'> & Partial<Pick<Ui, 'companion' | 'studio'>>;
  data: Pick<Data, 'project' | 'jobs' | 'decisions' | 'details'> & Partial<Pick<Data, 'away' | 'turns' | 'frame' | 'turn'>>;
  /** whether the run detail can be read here (ViewCtx.can) */
  can?: { detail: boolean; detailWhy?: string };
}

/** A selectable item's name (src/workbench/views.ts itemName) and its operation (operationOf), for Context and Activity. */
export function controlItemName(item: ControlItem): string {
  switch (item.kind) {
    case 'job': return `${item.job.id} ${item.job.label}`;
    case 'live-turn': return `the chat turn being answered in ${surfaceWords(item.live.surface)}`;
    case 'decision': return item.decision.title;
    default: return `chat turn ${item.turn.receipt}`;
  }
}

// ── the marks ──────────────────────────────────────────────────────────────────

/** A job's mark: ▶ running (never ●: that is a live connection), ✓ completed, ✕ failed (amber), ■ stopped, = no change, ? not
 *  known; its word is always beside it. */
export function jobMark(j: Pick<JobRow, 'mark' | 'live'>, g: Glyphs): { glyph: string; role: Role } {
  if (j.mark === 'running' || (j.live && j.mark !== 'failed')) return { glyph: g.next, role: 'text' };
  if (j.mark === 'ok') return { glyph: g.ok, role: 'text' };
  if (j.mark === 'failed') return { glyph: g.fail, role: 'failure' };
  if (j.mark === 'stopped') return { glyph: g.unicode ? '■' : '#', role: 'text' };
  if (j.mark === 'unchanged') return { glyph: '=', role: 'text' };
  return { glyph: '?', role: 'secondary' };
}

/** Who started a job, in the Control Room's words. */
const whoOf = (j: JobRow): string => (j.owner === 'workbench' ? 'this Workbench' : j.owner === 'live-session' ? 'another session' : j.owner === 'ended-session' ? 'an ended session' : 'started by: not recorded');

/** A sealed turn's mark, as a job's: answered ✓, stopped ■, failed ✕. */
const turnMark = (t: TurnRow, g: Glyphs): { glyph: string; role: Role } => (
  t.state === 'answered' ? { glyph: g.ok, role: 'text' } : t.state === 'failed' ? { glyph: g.fail, role: 'failure' } : { glyph: g.unicode ? '■' : '#', role: 'text' });

/** The surface a sealed turn was sent from, in the Control Room's words. */
const TURN_SURFACE: Readonly<Record<TurnRow['surface'], string>> = { repl: 'the REPL', monitor: 'the monitor', workbench: 'the Workbench', companion: 'a companion page' };

/** A device's mark and word (and a shorter word): ● live green only for an answer seen within the frame's 30 minutes. */
export function deviceMark(d: Pick<DeviceRow, 'state' | 'at'>, g: Glyphs, now: number): { glyph: string; word: string; short: string; role: Role } {
  switch (d.state) {
    case 'live': return { glyph: g.bullet, word: `live, reached ${ago(d.at, now)}`, short: 'live', role: 'live' };
    case 'reached': return { glyph: g.ring, word: `reached ${ago(d.at, now)}`, short: 'reached', role: 'text' };
    case 'unreachable': return { glyph: g.fail, word: 'unreachable', short: 'unreachable', role: 'failure' };
    case 'needs you': return { glyph: g.warn, word: 'needs you', short: 'needs you', role: 'attention' };
    case 'refused': return { glyph: g.fail, word: 'refused', short: 'refused', role: 'failure' };
    case 'error': return { glyph: g.fail, word: 'error', short: 'error', role: 'failure' };
    default: return { glyph: '?', word: 'not probed', short: 'not probed', role: 'secondary' };
  }
}

/** A lane's mark and word (and a shorter word, for a narrow column): ▶ running only when a record shows it; FAKE when its
 *  program is a stand-in; found (on PATH, not checked: nothing runs it); not installed. */
export function laneMark(l: LaneRow, g: Glyphs): { glyph: string; word: string; short: string; role: Role } {
  if (l.running) return { glyph: g.next, word: `running ${l.running.id}`, short: 'running', role: 'text' };
  if (l.program === 'fake') return { glyph: g.ring, word: 'FAKE stand-in', short: 'FAKE', role: 'strong' };
  if (l.program === 'found') return { glyph: g.ring, word: 'found (not checked)', short: 'found', role: 'text' };
  return { glyph: g.dot, word: 'not installed', short: 'not installed', role: 'secondary' };
}

// ── drawing ────────────────────────────────────────────────────────────────────

/** Rows of a selectable item: the cursor's marker on its first row, the selection bar on each (tab-columns.ts onBar: its quiet
 *  words in the primary text colour, as #8E8E93 on the bar's #333 is below the contrast floor), each fitted to `w`. */
function itemRows(lines: readonly Line[], selected: boolean, g: Glyphs, w: number): Line[] {
  return lines.map((l, i) => {
    const row: Line = [S(i === 0 && selected ? `${g.cursor} ` : '  ', 'action'), ...l];
    return fit(selected ? onBar(row) : row, w, g.ellipsis);
  });
}

/** One row when it fits in `w`, else the rows given (the fullest wording first, never cut where another fits). */
const oneOr = (w: number, one: Line, rows: readonly Line[]): Line[] => (lineCells(one) <= w ? [one] : [...rows]);

/** Pieces on rows of `w` cells, joined by ` · `, each whole where it fits a row (tab-columns.ts flow, one group). */
const flowRows = (pieces: readonly string[], w: number, role: Role, g: Glyphs): Line[] => flow([pieces.filter(Boolean)], w, '', ` ${g.sep} `, role, g.ellipsis);

/** A quiet pane's exit and receipt, on one row where they fit (else two): the receipt green only when verifyReceiptIn confirmed
 *  it in this reading; amber with ✕ when it does not verify; quiet when it is not found here. */
function exitAndReceipt(j: JobRow, d: ControlData | undefined, g: Glyphs, w: number): Line[] {
  const exit: Line = [S(j.exitCode === undefined ? 'exit not recorded' : j.exitCode === null ? 'no exit code' : `exit ${j.exitCode}`, 'secondary')];
  const v = d?.receipts[j.id];
  const [words, role]: [string, Role] = !j.receipt ? ['no receipt', 'secondary']
    : v?.state === 'verified' ? [`${g.ok} receipt ${j.receipt} verified`, 'live']
      : v?.state === 'failed' ? [`${g.fail} receipt ${j.receipt} does not verify: ${v.reason}`, 'failure']
        : [`receipt ${j.receipt} (${v ? v.reason : 'not verified here'})`, 'secondary'];
  // the receipt's words are never cut: wrapped under themselves where the pane is narrow
  return oneOr(w, [...exit, S(` ${g.sep} `, 'secondary'), S(words, role)], [exit, ...wrapText(words, Math.max(6, w)).map((t) => [S(t, role)])]);
}

/** A pane's parts: its title and note on the box's edge, the rows above its log (always drawn), its log's lines (the newest
 *  kept where the pane is short) and the rows below them (always drawn). */
interface PaneParts { title: Seg[]; note: Seg[]; head: Line[]; tail: Line[]; foot: Line[]; selected: boolean }

/** A pane `w` cells wide: `height` rows tall when given (its log's oldest lines left out where the rows are few, blank rows
 *  under them where they are many: the panes of a grid's row are one height), else as tall as its parts. Selected: its frame
 *  amber and heavy. */
function drawPane(p: PaneParts, w: number, g: Glyphs, height?: number): Line[] {
  let body: Line[] = [...p.head, ...p.tail, ...p.foot];
  if (height !== undefined) {
    const room = Math.max(0, height - 2);
    const keep = Math.max(0, room - p.head.length - p.foot.length);
    body = [...p.head, ...p.tail.slice(Math.max(0, p.tail.length - keep)), ...p.foot].slice(0, room);
    while (body.length < room) body.push([]);
  }
  return card({ w, title: p.title, note: p.note, body, edge: p.selected ? 'focus' : 'border', heavy: p.selected, g });
}

/** "1 s", "0.5 s": an interval in the pane's words. */
const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`;

/** A job's pane: its id on the edge (its elapsed time, or when it ended, at the edge's end), its mark, word and label (its blocks
 *  beside them where they fit), recovery's state and where it runs when they apply, who started it with its operation, its
 *  log's last lines (at most `tailRows`), and how its log is read (a running job: every tick) or (a quiet pane) its exit and
 *  receipt. */
function jobParts(j: JobRow, c: ControlCtx, d: ControlData | undefined, w: number, selected: boolean, quiet: boolean, tailRows = TAIL_MAX): PaneParts {
  const g = c.g;
  const m = jobMark(j, g);
  const inner = Math.max(1, w - 4);
  const role: Role = quiet ? 'text' : 'strong';
  // its mark and word, then its label and its blocks: on one row where they fit, else the label wrapped under them (the word is
  // never cut) and the blocks with who started it
  const state: Line = [S(`${m.glyph} `, m.role), S(j.word, m.role)];
  const labelled: Line = [...state, S(`  ${j.label}`, role)];
  const withBlocks: Line = [...labelled, ...(j.blocks ? [S(` ${g.sep} ${j.blocks}`, 'secondary')] : [])];
  const blocksAbove = lineCells(withBlocks) <= inner;
  const head: Line[] = blocksAbove ? [withBlocks] : oneOr(inner, labelled, [state, ...wrapText(j.label, Math.max(6, inner)).slice(0, 2).map((t) => [S(t, role)])]);
  const where = sameFolder(j.root, c.data.project.root) ? '' : `in ${j.project}`;
  // R4 (H112): a job a session left, in recovery's words (left running, stale, ended by recovery), never as one of ours
  const recovery = j.recovery && j.recovery.state !== j.word ? j.recovery.state : '';
  if (recovery || where) head.push([...(recovery ? [S(recovery, 'attention')] : []), ...(where ? [S(`${recovery ? ` ${g.sep} ` : ''}${where}`, 'secondary')] : [])]);
  // who started it, its operation (its blocks where they were not above): each whole, on as many rows as the pane's width takes
  head.push(...flowRows([whoOf(j), j.operation ?? 'no operation', blocksAbove ? '' : j.blocks ?? ''], inner, 'secondary', g));
  const t = d?.tails[j.id];
  const tail: Line[] = !t ? [[S('reading its log…', 'secondary')]]
    : 'why' in t ? para(t.why, inner)
      : !t.lines.length ? [[S(quiet ? 'it printed nothing' : 'nothing printed yet', 'secondary')]]
        : t.lines.slice(-tailRows).map((l): Line => [S(cut(l, inner, g.ellipsis), quiet ? 'secondary' : 'text')]);
  // how its lines come: read again at each tick while it runs (said, as the reading is a look, not a stream)
  const foot: Line[] = quiet ? exitAndReceipt(j, d, g, inner) : t?.every ? [[S(`log read every ${seconds(t.every)}`, 'secondary')]] : [];
  const note = [S(j.live ? j.elapsed : `ended ${ago(j.endedAt ?? j.startedAt, c.now)}`, 'secondary')];
  return { title: [S(j.id, selected ? 'focus' : 'strong')], note, head, tail, foot, selected };
}

/** How a turn being answered is stopped, where it was sent from, in the frame's words (src/ops/workspace-frame.ts
 *  turnStopWords). R5 (H131; the QA of e7f853e, item 16): x here asks another surface's turn to stop, by its id. */
const turnStop = (t: Pick<LiveTurnRow, 'surface' | 'mine' | 'id'>): string => (t.mine ? 'Esc in its composer stops it' : `${turnStopWords(t.surface)} stops it${t.id ? '; x here asks it to stop' : ''}`);

/** R5 (H131; the operator's 22:32 order, item 1): the turns being answered, less any whose own receipt is sealed (its hold is let
 *  go a moment after): matched by the turn's identity, never by surface and time. */
const liveTurnsOf = (d: ControlData | undefined, sealed: readonly TurnRow[]): LiveTurnRow[] => (d?.turns ?? []).filter((t) => !t.id || !sealed.some((x) => x.turn === t.id));

/** A chat turn's pane: whose surface, which process, since when; the Workbench's own turn its tools as they run (its words
 *  are drawn in Chat, never here); how it is stopped. */
function turnParts(t: LiveTurnRow, c: ControlCtx, w: number, selected: boolean): PaneParts {
  const g = c.g;
  const inner = Math.max(8, w - 4);
  const state: Line = [S(`${g.next} `, 'text'), S('answering', 'text')];
  const head: Line[] = oneOr(inner, [...state, S(`  from ${surfaceWords(t.surface)}`, 'strong')], [state, [S(`from ${surfaceWords(t.surface)}`, 'strong')]]);
  head.push(...flowRows([t.mine ? 'this process' : `pid ${t.pid}`, `since ${clock(t.taken)}`], inner, 'secondary', g));
  if (t.proof === 'unknown') head.push(...para('its process\'s start could not be read, so it is taken as running', inner));
  const tail: Line[] = [];
  const own = t.mine && t.surface === 'workbench' && c.data.turn?.state === 'sending' ? c.data.turn : undefined;
  if (own) {
    for (const x of own.tools.slice(-3)) tail.push([S(`${x.phase === 'start' ? g.next : g.ok} ${x.name}`, 'text'), S(x.outcome ? ` ${x.outcome}` : x.phase === 'start' ? ' running' : '', 'secondary')]);
    tail.push([S(own.answer ? `the answer so far: ${count(own.answer.length, 'character')} (2 Chat shows it)` : 'no answer yet', 'secondary')]);
  } else tail.push(...para('its words are where it was sent', inner));
  const ms = c.now - Date.parse(t.taken);
  return { title: [S('chat turn', selected ? 'focus' : 'strong')], note: [S(took(Number.isFinite(ms) ? ms : null), 'secondary')], head, tail, foot: para(turnStop(t), inner), selected };
}

/** What waits on you, one decision: its title (⚠, wrapped, never cut), what is needed, its first command. */
function decisionRows(x: WaitDecision, w: number, g: Glyphs): Line[] {
  const room = Math.max(8, w - 2);
  const [first = '', ...rest] = wrapText(x.title, Math.max(6, room - 2));
  const out: Line[] = [[S(`${g.warn} `, 'attention'), S(first, 'strong')], ...rest.map((r) => [S(`  ${r}`, 'strong')])];
  out.push(...wrapText(x.needed, Math.max(6, room - 2)).slice(0, 2).map((r) => [S(`  ${r}`, 'secondary')]));
  if (x.commands[0]) out.push([S('  '), S(x.commands[0], 'action')]);
  return out;
}

/** A recent run: one row where it fits (as the Control Room's row: its mark, id, word, label, blocks, time, operation, who),
 *  else its mark, id and word with its label where they fit (else the label wrapped under them), recovery's state, then the
 *  rest, each piece whole (an operation is never cut); `dense` (a column too short for every row), the rest on one row, cut at
 *  its end as the Control Room's rows always were. */
function recentRows(j: JobRow, c: ControlCtx, w: number, dense: boolean): Line[] {
  const g = c.g;
  const room = w - 2;
  const m = jobMark(j, g);
  const head: Line = [S(`${m.glyph} `, m.role), S(j.id, 'strong'), S(`  ${j.word}`, m.role)];
  const recovery = j.recovery && j.recovery.state !== j.word ? j.recovery.state : '';
  const where = sameFolder(j.root, c.data.project.root) ? '' : `in ${j.project}`;
  // the row's order is the Control Room's (R4 H112): its label, recovery's state, where, its blocks, its time, its operation, who
  const pieces = [where, j.blocks ?? '', j.elapsed, j.operation ?? 'no operation', whoOf(j), ago(j.endedAt ?? j.startedAt, c.now)].filter(Boolean);
  const labelled: Line = [...head, S(`  ${j.label}`, 'text')];
  const one: Line = [...labelled, ...(recovery ? [S(` ${g.sep} ${recovery}`, 'attention')] : []), S(` ${g.sep} ${pieces.join(` ${g.sep} `)}`, 'secondary')];
  if (lineCells(one) <= room) return [one];
  const said = recovery ? para(recovery, room, 'attention', '  ') : [];
  if (dense) return [head, ...said, [S(`  ${j.label}`, 'text'), S(` ${g.sep} ${pieces.join(` ${g.sep} `)}`, 'secondary')]];
  return [
    ...(lineCells(labelled) <= room ? [labelled] : [head, ...para(j.label, room, 'text', '  ')]),
    ...said,
    ...flow([pieces], room, '  ', ` ${g.sep} `, 'secondary', g.ellipsis),
  ];
}

/** A sealed chat turn: one row where it fits (the Control Room's), else its mark, receipt, how it ended and where from (where
 *  they fit on that row), then the rest, each piece whole (an operation is never cut); `dense`, the rest on one row, cut at
 *  its end. */
function sealedTurnRows(t: TurnRow, c: ControlCtx, w: number, dense: boolean): Line[] {
  const g = c.g;
  const room = w - 2;
  const m = turnMark(t, g);
  // R5 (H131; the QA of e7f853e, item 17): a stop another surface asked for, in the frame's words: "stopped (asked from …)"
  const head: Line = [S(`${m.glyph} `, m.role), S(t.receipt, 'strong'), S(`  ${turnEndWords(t)}`, m.role)];
  const from = `from ${TURN_SURFACE[t.surface]}`;
  const rest = [t.model ?? 'model not recorded', took(t.ms), t.operation ?? 'no operation', ago(t.at, c.now)];
  const sent: Line = [...head, S(` ${from}`, 'text')];
  const one: Line = [...sent, S(` ${g.sep} ${rest.join(` ${g.sep} `)}`, 'secondary')];
  if (lineCells(one) <= room) return [one];
  if (dense) return [head, [S(`  ${from}`, 'text'), S(` ${g.sep} ${rest.join(` ${g.sep} `)}`, 'secondary')]];
  return lineCells(sent) <= room
    ? [sent, ...flow([rest], room, '  ', ` ${g.sep} `, 'secondary', g.ellipsis)]
    : [head, ...flow([[from, ...rest]], room, '  ', ` ${g.sep} `, 'secondary', g.ellipsis)];
}

/** The selected run's detail, compact (the shared run detail; Context's Inspector has the whole of it). */
function detailRows(c: ControlCtx, item: ControlItem | null, w: number): Line[] {
  const g = c.g;
  const op = item?.kind === 'job' ? item.job.operation ?? null : item?.kind === 'turn' ? item.turn.operation : null;
  const head: Line = [heading('Run detail'), S(op ? ` ${g.sep} ${op}` : '', 'strong')];
  const f = (label: string, value: string, role: Role = 'text'): Line[] => {
    const [first = '', ...rest] = wrapText(value, Math.max(6, w - 10));
    return [[S(label.padEnd(9), 'secondary'), S(` ${first}`, role)], ...rest.map((r) => [S(' '.repeat(10)), S(r, role)])];
  };
  if (!item || item.kind === 'decision') return [head, ...para('the selected pane\'s run, once a pane or a run is selected (↑ ↓)', w)];
  if (item.kind === 'live-turn') return [head, ...para('a turn being answered has none until its receipt is sealed', w)];
  if (!op) return [head, ...para(`this ${item.kind === 'job' ? 'job' : 'turn'} names no operation`, w)];
  if (c.can && !c.can.detail) return [head, ...para(c.can.detailWhy ?? 'not available here', w)];
  const l = c.data.details[op];
  if (!l || l.state === 'idle' || l.state === 'loading') return [head, [S('reading…', 'secondary')]];
  if (l.state === 'failed') return [head, ...para(l.why, w, 'failure')];
  const r = l.value;
  const out: Line[] = [head];
  const verdict = r.verdict.words.startsWith(r.verdict.state) ? r.verdict.words : `${r.verdict.state} ${g.sep} ${r.verdict.words}`;
  out.push(...f('Verdict', verdict, r.verdict.state === 'failed' ? 'failure' : 'strong'));
  const now = r.stage.current ?? (r.time.endedAt !== null ? 'ended' : 'no step named yet');
  out.push(...f('Stage', `${now} ${g.sep} ${r.stage.total === null ? `${r.stage.done} done` : `${r.stage.done} of ${r.stage.total} done`}`));
  for (const e of r.exits.slice(0, 2)) out.push(...f('Exit', `${e.who}: ${e.code ?? 'none'}${e.state ? ` (${e.state})` : ''}`, 'secondary'));
  // R5 (H131; the QA of e7f853e, defect 24): each duration labelled with what it measures
  out.push(...f('Took', tookWords(r.time, item.kind === 'job' ? { kind: 'job', ms: item.job.elapsedMs, running: item.job.live } : item.kind === 'turn' ? { kind: 'turn', ms: item.turn.ms } : undefined)));
  if (r.receipts.length) out.push(...f('Receipts', r.receipts.slice(0, 3).map((x) => x.id).join(', '), 'secondary'));
  if (r.next) out.push(...f('Next', `${r.next.words}${r.next.command ? `: ${r.next.command}` : ''}`, 'action'));
  for (const u of r.unknown.slice(0, 1)) out.push(...f('Unknown', `${u.field}: ${u.why}`, 'secondary'));
  out.push(...para('i: Context\'s Inspector has the whole of it', w));
  return out;
}

/** This computer's surfaces: the Workbench (this one), the REPL and any other surface a record names, the companion and Studio
 *  as the workspace frame's connections say (● live green only for an observed answer). */
function surfaceRows(c: ControlCtx, d: ControlData | undefined): RosterEntry[] {
  const g = c.g;
  const out: RosterEntry[] = [{ glyph: g.next, name: 'Workbench', word: 'running (this one)', short: 'running', role: 'text' }];
  const turns = liveTurnsOf(d, c.data.turns ?? []);
  const repl = turns.find((t) => t.surface === 'repl');
  out.push(repl ? { glyph: g.next, name: 'REPL', word: `answering a turn (pid ${repl.pid})`, short: 'answering', role: 'text' } : { glyph: '?', name: 'REPL', word: 'not recorded', short: 'not recorded', role: 'secondary' });
  for (const t of turns.filter((x) => x.surface === 'monitor')) out.push({ glyph: g.next, name: 'monitor', word: `answering a turn (pid ${t.pid})`, short: 'answering', role: 'text' });
  // a job another live session started: a session that runs (whether it is a REPL is not recorded)
  const pids = [...new Set([...(c.data.jobs ?? []), ...(c.data.away ?? [])].filter((j) => j.live && j.owner === 'live-session').map((j) => /\(pid (\d+)\)/.exec(j.ownerWords)?.[1] ?? '?'))];
  for (const p of pids) out.push({ glyph: g.next, name: 'session', word: `pid ${p} runs a job`, short: 'runs a job', role: 'text' });
  for (const id of ['companion', 'studio'] as const) {
    const conn = c.data.frame?.connections.find((x) => x.id === id);
    const s = id === 'companion' ? c.ui.companion : c.ui.studio;
    const mark = conn ? connectionMark(conn.state, g) : { text: '? unknown', role: 'secondary' as Role };
    const [glyph = '?', ...word] = mark.text.split(' ');
    out.push({ glyph, name: id === 'companion' ? 'companion' : 'Studio', word: `${word.join(' ')}${s?.serving ? ', served here' : ''}`, short: word.join(' '), role: mark.role });
  }
  return out;
}

/** One roster entry: its mark, its name, its word (and a shorter one), and the role of both. */
interface RosterEntry { glyph: string; name: string; word: string; short: string; role: Role; nameRole?: Role }

/** A roster entry on one row where it fits (its word, else its shorter word), else its word on a row of its own. */
function rosterRow(e: RosterEntry, w: number, pad: number): Line[] {
  const one = (word: string): Line => [S(`${e.glyph} `, e.nameRole ?? e.role), S(e.name.padEnd(pad), 'text'), S(` ${word}`, e.role)];
  if (lineCells(one(e.word)) <= w) return [one(e.word)];
  if (lineCells(one(e.short)) <= w) return [one(e.short)];
  // its word on a row of its own: the whole word where it fits, else the shorter one
  const word = lineCells([S(`  ${e.word}`)]) <= w ? e.word : e.short;
  return [[S(`${e.glyph} `, e.nameRole ?? e.role), S(e.name, 'text')], [S(`  ${word}`, e.role)]];
}

/** Entries as rows, their names padded to the longest of the group (at most 10 cells). */
const rosterRows = (entries: readonly RosterEntry[], w: number): Line[] => {
  const pad = Math.min(10, Math.max(0, ...entries.map((e) => e.name.length)));
  return entries.flatMap((e) => rosterRow(e, w, pad));
};

/** The roster column: HARNESSES (the lanes), SURFACES, DEVICES, and what could not be read. Where the lanes not installed would
 *  each take two rows, they share one entry ("· not installed: pi, jcode"), each still named with its word. */
function rosterLines(c: ControlCtx, d: ControlData | undefined, w: number): Line[] {
  const g = c.g;
  const out: Line[] = [[heading(`Harnesses (${LANE_ORDER.length})`)]];
  if (!d) out.push([S('reading…', 'secondary')]);
  else {
    const entries = d.lanes.map((l): RosterEntry & { none: boolean } => {
      const m = laneMark(l, g);
      return { glyph: m.glyph, name: l.id, word: m.word, short: m.short, role: m.role, nameRole: m.role === 'strong' ? 'text' : m.role, none: l.program === 'none' && !l.running };
    });
    const pad = Math.min(10, Math.max(0, ...entries.map((e) => e.name.length)));
    const none = entries.filter((e) => e.none);
    const grouped = none.length > 1 && none.some((e) => rosterRow(e, w, pad).length > 1);
    for (const e of entries) if (!grouped || !e.none) out.push(...rosterRow(e, w, pad));
    if (grouped) out.push(...wrapText(`not installed: ${none.map((e) => e.name).join(', ')}`, Math.max(6, w - 2)).map((t, i) => [S(i ? '  ' : `${g.dot} `, 'secondary'), S(t, 'secondary')]));
  }
  out.push([]);
  const surfaces = surfaceRows(c, d);
  out.push([heading(`Surfaces (${surfaces.length})`)]);
  out.push(...rosterRows(surfaces, w));
  out.push([]);
  out.push([heading(`Devices (${d ? d.devices.length : '…'})`)]);
  if (!d) out.push([S('reading…', 'secondary')]);
  else if (!d.devices.length) out.push(...para('none added: timmy connect add <name> <user>@<address>', w));
  else {
    const pad = Math.min(10, Math.max(0, ...d.devices.map((v) => v.name.length)));
    for (const v of d.devices) {
      const m = deviceMark(v, g, c.now);
      out.push(...rosterRow({ glyph: m.glyph, name: v.name, word: m.word, short: m.short, role: m.role }, w, pad));
      if (v.running) out.push(...para(`${g.next} ${count(v.running, 'remote job')} running`, w, 'text', '  '));
      for (const n of v.needs.slice(0, 1)) out.push(...para(n, w, 'attention', '  '));
    }
  }
  for (const n of d?.notes ?? []) out.push([], ...para(n, w, 'failure'));
  return out;
}

/** A column's blocks: rows, and the item (by its place in the items) a block draws; `detail`, the selected run's detail. */
interface Block { lines: Line[]; at?: number; detail?: true }

/** The rows of `blocks`, the run detail's counted at its least (the blank row above it, its title and one row), so that moving
 *  the selection does not change how dense the lists under it are. */
const listRows = (blocks: readonly Block[]): number => blocks.reduce((n, b) => n + (b.detail ? Math.min(b.lines.length, 3) : b.lines.length), 0);

/**
 * Which of a column's `total` rows show in `room` rows (marks included), row by row: from the top while the selected block
 * (`at` its index, -1 for none; `starts` and `heights` the blocks' rows) shows whole there; else the last rows, where it
 * starts among them; else ending with it (starting with it, when it is taller than the rows left between two marks).
 */
function rowWindow(starts: readonly number[], heights: readonly number[], total: number, at: number, room: number): { from: number; to: number } {
  if (total <= room) return { from: 0, to: total };
  const s0 = at >= 0 ? starts[at] : 0;
  const s1 = at >= 0 ? s0 + heights[at] : 0;
  const top = { from: 0, to: Math.max(1, room - 1) };
  if (s1 <= room - 1) return top;
  if (total - s0 <= room - 1) return { from: total - (room - 1), to: total };
  const between = Math.max(1, room - 2);
  const from = heights[at] <= between ? s1 - between : s0;
  return from > 0 ? { from, to: Math.min(total, from + between) } : top;
}

/** A column `room` rows tall at most: its blocks' rows, windowed around the selected block where they do not all fit (rowWindow;
 *  a mark says which rows show, in tab-columns.ts windowMarked's words: "↑ n more above", "↓ a–b of n rows"), then its
 *  `foot`, which always shows. A block cut by the window is placed by the rows of it that show. */
function columnOf(blocks: readonly Block[], sel: number, room: number, w: number, g: Glyphs, foot: readonly Line[] = []): { lines: Line[]; placed: Array<{ at: number; line: number; rows: number }> } {
  const kept = foot.slice(0, Math.max(0, room - 2));
  const r = Math.max(1, room - kept.length);
  const rows: Line[] = [];
  const starts: number[] = [];
  for (const b of blocks) { starts.push(rows.length); rows.push(...b.lines); }
  const total = rows.length;
  const { from, to } = rowWindow(starts, blocks.map((b) => b.lines.length), total, blocks.findIndex((b) => b.at === sel), r);
  const range = `${from + 1}–${to} of ${total} rows`;
  const above: Line | null = from > 0 ? fit([S(to < total ? `${g.unicode ? '↑' : '^'} ${from} more above` : `${g.unicode ? '↑' : '^'} ${range}`, 'secondary')], w, g.ellipsis) : null;
  const below: Line | null = to < total ? fit([S(`${g.unicode ? '↓' : 'v'} ${range}`, 'secondary')], w, g.ellipsis) : null;
  const shift = above ? 1 : 0;
  const placed: Array<{ at: number; line: number; rows: number }> = [];
  blocks.forEach((b, i) => {
    const a = Math.max(starts[i], from);
    const z = Math.min(starts[i] + b.lines.length, to);
    if (b.at !== undefined && z > a) placed.push({ at: b.at, line: a - from + shift, rows: z - a });
  });
  const lines = [...(above ? [above] : []), ...rows.slice(from, to), ...(below ? [below] : [])];
  return { lines: rowsOf([...lines, ...kept], w, room, g.ellipsis), placed };
}

/**
 * Tab 7's body: the roster, the panes and the right column side by side from 120 terminal columns (tab-columns.ts
 * sideBySideAt), or stacked below that; every row at most `c.width` cells. The items are the panes, what waits on you, the sealed chat turns and the recent runs (R5 H131: the turns first, in view), in
 * that order at every size: side by side, each column keeps the selection in its own rows (an item out of view has line -1;
 * one in view has the cells it is drawn in), stacked, the body scrolls as every other view does.
 */
export function controlRoomView(c: ControlCtx, d: ControlData | undefined): ControlView {
  const { g, width: W } = c;
  const liveTurns = liveTurnsOf(d, c.data.turns ?? []);
  const panes = paneJobs(c.data.jobs, c.data.away ?? [], liveTurns.length);
  const quietIds = new Set(panes.quiet.map((j) => j.id));
  const ended = c.data.jobs.filter((j) => !j.live).slice(0, RECENT_MAX);
  const decisions = c.data.decisions.items;
  const sealed = c.data.turns ?? [];
  const all: ControlItem[] = [
    ...panes.live.map((job): ControlItem => ({ kind: 'job', key: `job:${job.id}`, job })),
    ...liveTurns.map((live): ControlItem => ({ kind: 'live-turn', key: liveTurnKey(live), live })),
    ...panes.away.map((job): ControlItem => ({ kind: 'job', key: `job:${job.id}`, job })),
    ...panes.quiet.map((job): ControlItem => ({ kind: 'job', key: `job:${job.id}`, job })),
    ...decisions.map((decision): ControlItem => ({ kind: 'decision', key: `decision:${decision.key}`, decision })),
    // R5 (H131; the QA of e7f853e, defect 10): the sealed chat turns before the run detail and the recent runs, so they are in
    // view at 160x45 (they were below the fold); the items in the order drawn
    ...sealed.map((turn): ControlItem => ({ kind: 'turn', key: `turn:${turn.receipt}`, turn })),
    ...ended.filter((j) => !quietIds.has(j.id)).map((job): ControlItem => ({ kind: 'job', key: `job:${job.id}`, job })),
  ];
  const sel = selectedIn(c.ui, CONTROL_LIST, all.length);
  const selected = sel >= 0 ? all[sel] : null;
  const paneCount = panes.live.length + liveTurns.length + panes.away.length + panes.quiet.length;
  const side = sideBySideAt(c);
  // from GRID_FROM body cells (160 terminal columns, Context's drawer shut), the panes are a 2×2 grid; below, they stack
  const grid = side && W >= GRID_FROM;
  const [wa, wb, wc] = !side ? [W, W, W] : grid ? gridWidths(W) : widths(W - 2 * RULE_CELLS, WEIGHTS);
  const room = Math.max(1, c.height);
  /** The parts of the `i`th pane (a job, or a chat turn being answered), `w` cells wide. */
  const partsOf = (i: number, w: number, tailRows?: number): PaneParts | null => {
    const it = all[i];
    if (it?.kind === 'live-turn') return turnParts(it.live, c, w, i === sel);
    if (it?.kind === 'job') return jobParts(it.job, c, d, w, i === sel, quietIds.has(it.job.id), tailRows);
    return null;
  };

  const running = panes.live.length + liveTurns.length;
  const awayTitle = (w: number): Line[] => wrapText(`Running in another project, started here (${panes.away.length})`, Math.max(6, w)).map((t): Line => [heading(t)]);

  // stacked panes (below GRID_FROM): what runs, this Workbench's runs elsewhere, the newest ended (quiet), one under another,
  // then what a terminal cannot draw
  const paneBlocks = (w: number): Block[] => {
    const b: Block[] = [];
    b.push({ lines: [[heading(`Running now (${running})`)]] });
    if (!running) b.push({ lines: para('Nothing runs in this project.', w) });
    // each pane's log lines: as many as the column has room for, TAIL_MIN to TAIL_MAX
    const base = 5 + (panes.quiet.length ? 1 : 0);
    const tailRows = side ? Math.max(TAIL_MIN, Math.min(TAIL_MAX, Math.floor((room - 6) / Math.max(1, paneCount)) - base)) : TAIL_MIN + 1;
    for (let i = 0; i < paneCount; i++) {
      // this Workbench's runs in another project keep running when the project changes (R4 H112): apart, under their own title
      if (i === running && panes.away.length) b.push({ lines: [[], ...awayTitle(w)] });
      if (i === running + panes.away.length && panes.quiet.length) b.push({ lines: [[], [heading(`Newest ended runs (${panes.quiet.length})`)]] });
      const parts = partsOf(i, w, tailRows);
      if (parts) b.push({ lines: drawPane(parts, w, g), at: i });
    }
    // stacked, what a terminal cannot draw follows the panes; side by side it is the column's foot, always shown (previewsFoot)
    if (!side) b.push({ lines: [[], ...para(PREVIEWS_WORDS, w)] });
    return b;
  };

  // the panes as the references' 2×2 grid: what runs first, then the newest ended, two to a row, the rows' panes one height;
  // two rows at a time, around the selected pane, a line saying how many more there are and how to reach them; then the keys,
  // what is not in Timmy, and what a terminal cannot draw
  const gridColumn = (w: number): { lines: Line[]; placed: Array<{ at: number; line: number; rows: number; from: number; to: number }> } => {
    const pw = Math.floor((w - GRID_GAP) / 2);
    const gap = w - 2 * pw;
    const top: Line[] = oneOr(w, [heading(`Running now (${running})`), ...(panes.quiet.length ? [S(`  ${g.sep}  `, 'secondary'), heading(`Newest ended runs (${panes.quiet.length})`)] : [])],
      [[heading(`Running now (${running})`)], ...(panes.quiet.length ? [[heading(`Newest ended runs (${panes.quiet.length})`)]] : [])]);
    if (!running) top.push(...para('Nothing runs in this project.', w));
    if (panes.away.length) top.push(...awayTitle(w));
    const rowsAll = Math.ceil(paneCount / 2);
    const selRow = sel >= 0 && sel < paneCount ? Math.floor(sel / 2) : 0;
    const r0 = Math.max(0, Math.min(rowsAll - GRID_ROWS, selRow - GRID_ROWS + 1));
    const r1 = Math.min(rowsAll, r0 + GRID_ROWS);
    const above = r0 * 2;
    const below = Math.max(0, paneCount - r1 * 2);
    const up = g.unicode ? '↑' : '^';
    const down = g.unicode ? '↓' : 'v';
    const more: Line[] = above || below ? flow([[...(above ? [`+${above} more above: ${up} moves to them`] : []), ...(below ? [`+${below} more below: ${down} moves to them`] : [])]], w, '', `  ${g.sep}  `, 'secondary', g.ellipsis) : [];
    const arrows = g.unicode ? '←→↑↓' : 'arrows';
    // R5 (H131; the QA of e7f853e, defect 16): the keys of the panes that exist (none with no pane; x only with a running one;
    // the arrows only with two or more)
    const paneKeys = ([[['x', 'stops the selected pane\'s job'], running > 0], [['Enter', 'its run detail'], paneCount > 0], [[arrows, 'between panes'], paneCount > 1]] as const)
      .filter(([, on]) => on).map(([k]) => k);
    const keys = paneKeys.length ? oneOr(w, paneKeys.flatMap(([k, words], i) => [...(i ? [S(`  ${g.sep}  `, 'secondary')] : []), key(k), S(` ${words}`, 'secondary')]), paneKeys.flatMap(([k, words]) => keyRows(k, words, w))) : [];
    const full: Line[] = [[], ...keys, ...para(HARNESS_WORDS, w), [], ...para(PREVIEWS_WORDS, w)];
    const least: Line[] = [[], ...para(PREVIEWS_WORDS, w)];
    const shown = r1 - r0;
    const heightWith = (foot: readonly Line[]): number => (shown ? Math.floor((room - top.length - more.length - foot.length) / shown) : 0);
    // the keys and the words of what is not in Timmy where the panes keep a useful height; else what a terminal cannot draw only
    const foot = !shown || heightWith(full) >= PANE_H_MIN ? full : least;
    const H = Math.max(3, Math.min(PANE_H_MAX, heightWith(foot)));
    const lines: Line[] = [...top];
    const placed: Array<{ at: number; line: number; rows: number; from: number; to: number }> = [];
    for (let r = r0; r < r1; r++) {
      const pair: Line[][] = [[], []];
      for (let k = 0; k < 2; k++) {
        const i = r * 2 + k;
        const parts = i < paneCount ? partsOf(i, pw) : null;
        if (!parts) continue;
        pair[k] = drawPane(parts, pw, g, H);
        const from = k ? pw + gap : 0;
        placed.push({ at: i, line: lines.length, rows: H, from, to: from + pw });
      }
      for (let y = 0; y < H; y++) lines.push([...fit(pair[0][y] ?? [], pw, g.ellipsis), S(' '.repeat(gap)), ...fit(pair[1][y] ?? [], pw, g.ellipsis)]);
    }
    lines.push(...more, ...foot);
    return { lines: rowsOf(lines, w, room, g.ellipsis), placed };
  };
  const previewsFoot = (w: number): Line[] => [[], ...para(PREVIEWS_WORDS, w)];
  // the keys, and what the references' Add harness, Remove harness and Broadcast are here (side by side: only where they fit
  // without clipping the panes)
  const keysBlock = (w: number): Block => {
    // R5 (H131; the QA of e7f853e, defect 16): the keys of the panes that exist (none with no pane; x only with a running one)
    const paneKeys = ([[['x', 'stops the selected pane\'s job'], running > 0], [['Enter', 'its run detail'], paneCount > 0]] as const).filter(([, on]) => on).map(([k]) => k);
    const keys = paneKeys.length ? oneOr(w, paneKeys.flatMap(([k, words], i) => [...(i ? [S(`  ${g.sep}  `, 'secondary')] : []), key(k), S(` ${words}`, 'secondary')]), paneKeys.flatMap(([k, words]) => keyRows(k, words, w))) : [];
    return { lines: [[], ...keys, ...para(HARNESS_WORDS, w)] };
  };

  // the right column: what waits on you, the selected run's detail, the recent runs, the sealed chat turns (`dense`: each run
  // and turn on two rows, cut at their end)
  const rightBlocks = (w: number, dense = false): Block[] => {
    const b: Block[] = [];
    let i = paneCount;
    const waiting = c.data.decisions.total;
    b.push({ lines: oneOr(w, [heading(`Waiting on you (${waiting})`), S(waiting ? `  ${g.warn} nothing is done until you do it` : '', 'attention')],
      [[heading(`Waiting on you (${waiting})`)], ...(waiting ? para(`${g.warn} nothing is done until you do it`, w, 'attention') : [])]) });
    if (!decisions.length) b.push({ lines: para('Nothing waits on you.', w) });
    for (const x of decisions) { b.push({ lines: itemRows(decisionRows(x, w, g), i === sel, g, w), at: i }); i += 1; }
    if (c.data.decisions.more) b.push({ lines: para(`and ${c.data.decisions.more} more: /decisions in the REPL lists them`, w) });
    // R5 (H131; the QA of e7f853e, defect 10): the sealed chat turns next, in view at 160x45 (under the run detail they were not)
    b.push({ lines: [[], [heading(`Chat turns (${sealed.length})`)]] });
    if (!sealed.length) b.push({ lines: para('No chat turn of this project is sealed yet: a turn is listed once its receipt is sealed, from whichever surface sent it (the REPL, the Workbench, the monitor, a companion page).', w) });
    for (const t of sealed) { b.push({ lines: itemRows(sealedTurnRows(t, c, w, dense), i === sel, g, w), at: i }); i += 1; }
    if (sealed.length >= TURNS_SHOWN) b.push({ lines: para(`The newest ${TURNS_SHOWN} are listed.`, w) });
    b.push({ lines: para(TURN_STOP_WORDS, w) });
    b.push({ lines: [[], ...detailRows(c, selected, w)], detail: true });
    b.push({ lines: [[], [heading(`Recent (${ended.length})`)]] });
    if (!ended.length) b.push({ lines: para('No job has run in this project yet.', w) });
    if (panes.quiet.length) b.push({ lines: para(panes.quiet.length === 1 ? 'the newest is drawn as a pane' : `the newest ${panes.quiet.length} are drawn as panes`, w) });
    for (const j of ended) {
      if (quietIds.has(j.id)) continue;
      b.push({ lines: itemRows(recentRows(j, c, w, dense), i === sel, g, w), at: i });
      i += 1;
    }
    for (const n of c.data.decisions.notes) b.push({ lines: para(n, w, 'failure') });
    return b;
  };

  const items: ControlView['items'] = all.map((item, i) => ({ line: -1, item, ...(grid && i < paneCount ? { near: gridNear(i, paneCount) } : {}) }));
  if (side) {
    const x0 = [0, wa + RULE_CELLS, wa + RULE_CELLS + wb + RULE_CELLS];
    // the grid places each pane in its own cells (a click is on the pane under it)
    const gridded = grid ? gridColumn(wb) : null;
    for (const p of gridded?.placed ?? []) items[p.at] = { ...items[p.at], line: p.line, rows: p.rows, x: { from: x0[1] + p.from, to: x0[1] + p.to } };
    const cols = [
      { lines: clipRows(rosterLines(c, d, wa), wa, room, g), placed: [] as Array<{ at: number; line: number; rows: number }> },
      gridded ? { lines: gridded.lines, placed: [] as Array<{ at: number; line: number; rows: number }> } : (() => {
        const blocks = paneBlocks(wb);
        const foot = previewsFoot(wb);
        const keys = keysBlock(wb);
        const used = blocks.reduce((n, b) => n + b.lines.length, 0);
        return columnOf(used + keys.lines.length + foot.length <= room ? [...blocks, keys] : blocks, sel, room, wb, g, foot);
      })(),
      // every row whole where the column holds them all, else the runs and turns dense (the column then windowed as it needs)
      (() => {
        const whole = rightBlocks(wc);
        return columnOf(listRows(whole) <= room ? whole : rightBlocks(wc, true), sel, room, wc, g);
      })(),
    ];
    const ws = [wa, wb, wc];
    cols.forEach((col, k) => { for (const p of col.placed) items[p.at] = { line: p.line, item: all[p.at], ...(p.rows > 1 ? { rows: p.rows } : {}), x: { from: x0[k], to: x0[k] + ws[k] } }; });
    const height = Math.max(...cols.map((col) => col.lines.length));
    return { lines: sideBySide(cols.map((col, k) => ({ w: ws[k], lines: col.lines })), height, g), items };
  }

  // stacked: the panes, what waits, the run detail, the recent runs and turns, then the roster; the body scrolls to the selection
  const lines: Line[] = [];
  for (const b of [...paneBlocks(W), keysBlock(W), { lines: [[]] }, ...rightBlocks(W), { lines: [[]] }, { lines: rosterLines(c, d, W) }] as Block[]) {
    if (b.at !== undefined) items[b.at] = { line: lines.length, item: all[b.at], ...(b.lines.length > 1 ? { rows: b.lines.length } : {}) };
    lines.push(...b.lines.map((l) => (lineCells(l) > W ? fit(l, W, g.ellipsis) : l)));
  }
  return { lines, items };
}

// ── the Inspector ──────────────────────────────────────────────────────────────

/** The Inspector's rows for a chat turn being answered (src/workbench/views.ts inspectorTab, kind 'live-turn'): its hold's
 *  words, never the turn's own (they are on the surface that sent it); the Workbench's own turn its tools and operation too. */
export function liveTurnDetail(t: LiveTurnRow, w: number, g: Glyphs, now: number, own?: TurnView): Line[] {
  const out: Line[] = [[heading('Chat turn being answered')]];
  const f = (l: string, v: string, r: Role = 'text'): void => { out.push(...fieldRows(l, v, w, r)); };
  f('From', surfaceWords(t.surface), 'strong');
  f('Process', t.mine ? 'this process' : `pid ${t.pid}`);
  f('Since', `${clock(t.taken)} (${ago(t.taken, now)})`);
  f('Running', `${g.next} running for ${took(now - Date.parse(t.taken))}`);
  f('Proof', t.proof === 'alive' ? 'its process runs (its start matches its hold)' : 'its process\'s start could not be read, so it is taken as running');
  f('Stops', turnStop(t));
  const mine = t.mine && t.surface === 'workbench' && own?.state === 'sending' ? own : undefined;
  if (mine) {
    if (mine.operation) f('Operation', mine.operation);
    for (const x of mine.tools.slice(-6)) out.push([S(`  ${x.phase === 'start' ? g.next : g.ok} ${x.name}`, 'text'), S(x.outcome ? ` ${x.outcome}` : x.phase === 'start' ? ' running' : '', 'secondary')]);
    f('Answer', mine.answer ? `${count(mine.answer.length, 'character')} so far (2 Chat shows them)` : 'none yet');
  }
  out.push([], ...para('Its words are on the surface that sent it. Once it ends, its receipt is sealed and it is listed under Chat turns, with the message and the answer kept as hashes only.', w));
  return out;
}
