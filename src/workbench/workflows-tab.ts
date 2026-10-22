/**
 * R5 (H136): tab 3 Workflows, its body, as the operator's references lay it out (codex-ui-references 03, modern, and 12,
 * classic): three working columns from 120 terminal columns, stacked below.
 *
 *   left     the plan: each workflow document's named blocks with their states (the selected row amber while the list has
 *            the keyboard); under them the selected block's .intent card (its document, its name, its command and what it
 *            needs) and the .predict card of its newest run (the prediction sealed before upmd ran, its receipt, and "frozen
 *            before the run" only when the run detail's frozenAt is earlier than the run's start, else not recorded)
 *   centre   the sandbox and the run: where it runs (this computer, in the project folder, by upmd, and the environment its
 *            run detail names, its env lock; no record names an isolated environment for a workflow run, so none is drawn),
 *            the newest run's blocks with their states, R6 (H144): its source (the document as it ran, its sha256, and whether
 *            it holds those bytes now, both hashes when not), its changes (each file it wrote or changed, and the first one's
 *            line diff against the version Timmy kept, + and − marked), the last lines of its log (cut with an ellipsis,
 *            never wrapped through a border), the RUN box (what Enter does now, and to which block), and where the companion
 *            draws its diffs, images and outputs
 *   right    the receipt and its review: the newest run's receipt card (green and "verified" only when verifyReceiptIn
 *            passes in this reading) and, R6 (H144), each stage's receipts (.predict, run, .receipt) as verified now, the
 *            run detail's checks (predicted against actual), its verdict, and timmy op <id>
 *
 * The operator's order (Intent → Predict → Sandbox → Review → Run → Logs → Receipt → Analyze) reads left to right: Review is
 * the Run confirm and, for a destructive command, its NEEDS YOU box, both asked before anything runs; Analyze is the checks.
 *
 * Each block's state is read from the newest job record each frame (refreshBlockStates: the reading the board's card makes,
 * src/repl/board-workflows.ts connectWorkflow), so a row never says waiting once its job has ended (the review of 2026-10-15
 * saw it lag by more than 2 s: the documents are read every few seconds, the jobs every second). The selected block's newest
 * run is read by readWorkflowsTab (its record, its log's last lines, its receipt verified); its run detail is the one
 * producer's (src/ops/run-detail.ts readRunDetail, read by the controller), never computed here, and so is the run
 * inspected (R6, H144: src/ops/run-detail.ts readRunInspection, its source, changes, outputs and receipts, the companion's
 * run detail's reading too), read here at most every INSPECT_MS while the chain and the run's record stay the same.
 *
 * Marks, one meaning each (the review of 2026-10-15): ● is only a live connection and ○ a configured one, so a block or a run
 * that runs is ▶ running and one that waits is … waiting; ✓ completed or verified, ✕ failed (amber), ■ stopped. Green is only
 * a check that passed or a receipt verified in this reading; .intent and .predict are amber, as is what has the keyboard. The
 * references' pictures (a CAD cutaway, a browser preview) are not drawn: a terminal cannot, and the body says where they are
 * seen. Nothing here runs, writes or seals; the records' own words are shown, and what no record says is "not recorded".
 */
import type { RunDetail } from '../contracts/run-detail.js';
import type { JobRecord } from '../jobs/index.js';
import { readRunInspection, type InspectChange, type InspectReceipt, type RunInspection } from '../ops/run-detail.js';
import { NODE_GLYPH, runOf, type NodeWord } from '../repl/board-workflows.js';
import type { Receipt } from '../utils/receipts.js';
import { blockDetail, runBlocks } from '../workflows/run-blocks.js';
import { noChangeOf } from '../workflows/run-verdict.js';
import { isLiveRun } from '../workflows/upmd-live.js';
import type { Glyphs } from './frame.js';
import type { Data, Item, Lazy, View } from './model.js';
import { lineText } from './output.js';
import type { BlockRow, WorkflowDoc, WorkflowsView } from './state.js';
import { card, clipRows, onBar, RULE_CELLS, S, sideBySide, sideBySideAt, widths, windowMarked } from './tab-columns.js';
import { cells, clip, clock, count, cut, fit, lineCells, took, wrapText, type Line, type Role, type Seg } from './text.js';
import { actionsOf, runOfBlock, selectedAction, type ViewCtx } from './views.js';
import { JOB_CANCELLED, stepStateWords } from '../contracts/stop-words.js'; // R6 (H140)

// ── the readers ────────────────────────────────────────────────────────────────

/** A block's place in the readings: its document and its name. */
export const blockKey = (doc: string, block: string): string => `${doc}\u0000${block}`;

/** How many of a document's runs are read, newest first (the board's card reads as many: src/repl/board-workflows.ts). */
const RUNS_READ = 20;
/** How many of a log's last lines are read. */
export const TAIL_READ = 40;
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Each job's outcome receipt (kind workflow, the newest sealed for it), one pass over a chain as read; kept per reading. */
const outcomes = new WeakMap<readonly Receipt[], Map<string, Receipt>>();
function outcomeOf(chain: readonly Receipt[], job: string): Receipt | undefined {
  let m = outcomes.get(chain);
  if (!m) {
    m = new Map();
    for (const r of chain) if (r && r.kind === 'workflow' && typeof r.job?.id === 'string') m.set(r.job.id, r);
    outcomes.set(chain, m);
  }
  return m.get(job);
}

/**
 * R5 (H131; the QA of e7f853e, defect 7): whether a record, as read, still says its job runs while the chain already holds the
 * job's outcome receipt (sealed when it ended): the records are then older than the chain, and are read again before the
 * row, the strip and the verdict are drawn from them, so no screen says running and completed at once.
 */
export function endedOnChain(records: readonly JobRecord[], chain: readonly Receipt[]): boolean {
  return records.some((j) => !j.stale && !TERMINAL.has(j.state) && outcomeOf(chain, j.id) !== undefined);
}

/** The order a run was to run its blocks: as its outcome sealed it, else as its record keeps it, else the document's now (the
 *  board's card reads it so: src/repl/board-workflows.ts readRun). */
function orderOf(j: JobRecord, target: string, doc: WorkflowDoc, outcome: Receipt | undefined): string[] {
  const sealed = outcome?.prediction?.order;
  const sealedOrder = Array.isArray(sealed) ? sealed.filter((x): x is string => typeof x === 'string') : undefined;
  return sealedOrder ?? j.expected?.steps ?? doc.blocks.find((b) => b.name === target)?.order ?? [target];
}

/** A document's runs, newest first: the job records whose upmd arguments (else label) name it, with what each ran. */
function runsOfDoc(doc: WorkflowDoc, records: readonly JobRecord[], chain: readonly Receipt[]): Array<{ j: JobRecord; target: string; order: string[] }> {
  const out: Array<{ j: JobRecord; target: string; order: string[] }> = [];
  for (const j of records) {
    const r = runOf(j);
    if (!r || r.doc !== doc.rel) continue;
    out.push({ j, target: r.target, order: orderOf(j, r.target, doc, outcomeOf(chain, j.id)) });
    if (out.length >= RUNS_READ) break;
  }
  return out;
}

/**
 * The documents with each block's state read again from the job records of this reading (`records`, newest first): the newest
 * run that includes the block decides its word, its exit code and own time, and the job it comes from, by the one reading of a
 * run's blocks (src/workflows/run-blocks.ts runBlocks), as the board's card and /workflows read them. A block no run includes
 * is not run yet. The documents themselves (their blocks, needs and commands) are as last read.
 */
export function refreshBlockStates(view: WorkflowsView, records: readonly JobRecord[], chain: readonly Receipt[]): WorkflowsView {
  return {
    ...view,
    docs: view.docs.map((d) => {
      if (!d.blocks.length) return d;
      const runs = runsOfDoc(d, records, chain).map((r) => ({ job: r.j.id, blocks: runBlocks(r.j, r.order) }));
      return {
        ...d,
        blocks: d.blocks.map((b): BlockRow => {
          const run = runs.find((r) => r.blocks.some((x) => x.name === b.name));
          const at = run?.blocks.find((x) => x.name === b.name);
          const word: NodeWord = at?.word ?? 'not run yet';
          const { run: _was, ...rest } = b;
          return { ...rest, word, glyph: NODE_GLYPH[word], detail: at ? blockDetail(at) : '', ...(run && at ? { run: run.job } : {}) };
        }),
      };
    }),
  };
}

/** A sealed receipt as the card shows it, verified in this reading (or why not). */
export interface ReceiptNow {
  /** its short id (8 hex of its hash) */
  id: string;
  kind: string;
  hash: string;
  /** when it was sealed */
  ts: string;
  /** verifyReceiptIn over this reading's chain: ok, or why not */
  verified: { ok: true } | { ok: false; why: string };
}

/** The selected block's newest run, as its records say it. */
export interface RunNow {
  job: string;
  /** what it ran: `<doc> › <block>` (the block it was asked for; the selected one may be among the blocks it needs) */
  label: string;
  target: string;
  operation: string | null;
  /** the run in its record's words, as the board's card says them: starting, running, completed, failed, stopped,
   *  interrupted, no change */
  word: string;
  live: boolean;
  /** its record says it runs, and no process of it does (its session ended without recording its end) */
  stale: boolean;
  /** its record's state (for when its run detail is read again) */
  state: JobRecord['state'];
  startedAt: string;
  endedAt: string | null;
  /** upmd ran it on a pty (each block's start and end seen as they happened), else over a pipe */
  pty: boolean;
  /** its blocks in run order, each with its state (src/workflows/run-blocks.ts runBlocks) */
  steps: Array<{ name: string; word: NodeWord; detail: string }>;
  /** the last lines of its log (escape sequences removed; home folders as ~), oldest first; why there are none */
  tail: { lines: string[]; why?: string };
  /** its outcome receipt (sealed when it ended) */
  receipt: ReceiptNow | null;
  /** its job record names a receipt (the seal's short id), when none is found on the chain read */
  named?: string;
}

/** R6 (H144): the newest run inspected by the producer (src/ops/run-detail.ts readRunInspection), or why it was not. */
export type InspectionNow = { op: string; value: RunInspection } | { op: string; why: string };

/** What tab 3 read for the selected block (src/workbench/controller.ts, each frame while the tab is shown). */
export interface WorkflowsTabData {
  /** the block it was read for (blockKey), '' for none */
  for: string;
  at: number;
  /** its newest run; null: none has run it */
  run: RunNow | null;
  /** R6 (H144): its newest run inspected (its source, changes, outputs and receipts), when its job names an operation */
  inspection?: InspectionNow;
}

export interface WorkflowsTabInput {
  /** the job records as this frame read them (the job store's, newest first) */
  records: readonly JobRecord[];
  /** the runs chain as this frame read it */
  chain: readonly Receipt[];
  /** the block whose newest run is read: the list's selected one */
  selected: { doc: WorkflowDoc; block: string } | null;
  /** the last `n` lines of a job's log (the job store's own reader: JobManager.tail) */
  tail: (job: JobRecord, n: number) => string[];
  /** verifyReceiptIn over this reading's chain (the caller keeps one answer per chain read and hash) */
  verify: (hash: string) => { ok: true } | { ok: false; reason: string };
  /** a job's own text with the project folder as "." and a home folder as "~" */
  scrub?: (text: string) => string;
  now: number;
}

const shortOf = (r: Pick<Receipt, 'hash' | 'id'>): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));

/** R6 (H144): how many lines of each file's preview the inspection keeps for this tab (it draws a few of them). */
const INSPECT_LINES = 12;
/** R6 (H144): a run is inspected again at most this often while the chain read and its record stay the same (its files
 *  may change meanwhile); a new chain reading or a change of its record inspects it again at once. */
export const INSPECT_MS = 5000;
/** Each chain reading by its identity (the controller keeps one array per reading of the chain's file). */
const chainIds = new WeakMap<readonly Receipt[], number>();
let chainCount = 0;
const chainId = (chain: readonly Receipt[]): number => { let n = chainIds.get(chain); if (n === undefined) { n = ++chainCount; chainIds.set(chain, n); } return n; };
/** The last inspection of each operation: what it was read for, when, and what it gave. */
const inspected = new Map<string, { sig: string; at: number; got: InspectionNow }>();

/** R6 (H144): a run inspected by the producer, reused while what it was read for is the same and it is younger than INSPECT_MS. */
function inspectionOf(j: JobRecord, op: string, o: WorkflowsTabInput): InspectionNow {
  const sig = `${chainId(o.chain)}:${j.id}:${j.state}:${j.endedAt ?? ''}:${j.root}`;
  const was = inspected.get(op);
  if (was && was.sig === sig && o.now >= was.at && o.now - was.at < INSPECT_MS) return was.got;
  let got: InspectionNow;
  try {
    const r = readRunInspection(op, { project: j.root, jobs: o.records, chain: o.chain, lines: INSPECT_LINES, verify: o.verify });
    got = r.ok ? { op, value: r.inspection } : { op, why: r.why };
  } catch (e) {
    got = { op, why: `it could not be inspected (${e instanceof Error ? e.message.split('\n')[0] : String(e)})` };
  }
  inspected.delete(op);
  inspected.set(op, { sig, at: o.now, got });
  // the newest few kept
  while (inspected.size > 12) inspected.delete(inspected.keys().next().value as string);
  return got;
}

/** The run in its record's words, as the board's card says them (src/repl/board-workflows.ts readRun). */
export function runWord(j: Pick<JobRecord, 'kind' | 'state' | 'steps' | 'stale' | 'interrupted'>): string {
  if (j.stale || j.interrupted) return 'interrupted';
  if (j.state === 'cancelled') return JOB_CANCELLED; // R6 (H140): a job's word (src/contracts/stop-words.ts)
  if (j.state === 'queued') return 'starting';
  if (j.state === 'ready') return 'running';
  return noChangeOf(j) ? 'no change' : j.state;
}

/**
 * The selected block's newest run (the newest job record of its document whose run includes it), read from its records: its
 * blocks' states, its log's last lines and its outcome receipt, verified by `verify` in this reading. Reads only.
 */
export function readWorkflowsTab(o: WorkflowsTabInput): WorkflowsTabData {
  const sel = o.selected;
  if (!sel) return { for: '', at: o.now, run: null };
  const key = blockKey(sel.doc.rel, sel.block);
  const found = runsOfDoc(sel.doc, o.records, o.chain).find((r) => runBlocks(r.j, r.order).some((b) => b.name === sel.block));
  if (!found) return { for: key, at: o.now, run: null };
  const { j, target, order } = found;
  const scrub = o.scrub ?? ((t: string) => t);
  const live = !j.stale && !TERMINAL.has(j.state);
  let raw: string[] = [];
  let why: string | undefined;
  try { raw = o.tail(j, TAIL_READ); } catch (e) { why = `its log could not be read (${e instanceof Error ? e.message : String(e)})`; }
  const lines = raw.map((l) => scrub(lineText(l))).filter((l) => l.trim());
  if (!why && !lines.length) why = live ? 'nothing printed yet' : 'its log has no lines';
  // R5 (H131; the QA of e7f853e, defect 7): the outcome receipt follows the record: one that still runs, as read, shows none yet
  // (its record is read again first: src/workbench/controller.ts readWorkflowsTab), so the card never says verified beside a
  // row that says waiting
  const outcome = live ? undefined : outcomeOf(o.chain, j.id);
  let receipt: ReceiptNow | null = null;
  if (outcome && typeof outcome.hash === 'string') {
    let v: { ok: true } | { ok: false; reason: string };
    try { v = o.verify(outcome.hash); } catch (e) { v = { ok: false, reason: `it could not be checked (${e instanceof Error ? e.message : String(e)})` }; }
    receipt = { id: shortOf(outcome), kind: outcome.kind, hash: outcome.hash, ts: outcome.ts, verified: v.ok ? { ok: true } : { ok: false, why: v.reason } };
  }
  return {
    for: key, at: o.now,
    run: {
      job: j.id, label: scrub(j.label), target, operation: j.operation ?? null, word: runWord(j), live, stale: j.stale === true, state: j.state,
      startedAt: j.startedAt, endedAt: j.endedAt ?? null, pty: isLiveRun(j.args),
      steps: runBlocks(j, order).map((b) => ({ name: b.name, word: b.word, detail: blockDetail(b) })),
      tail: { lines: lines.slice(-TAIL_READ), ...(why ? { why } : {}) },
      receipt, ...(!receipt && j.receipt ? { named: j.receipt } : {}),
    },
    // R6 (H144): the run inspected by the producer, the companion's run detail's reading (read here no more than INSPECT_MS)
    ...(j.operation ? { inspection: inspectionOf(j, j.operation, o) } : {}),
  };
}

// ── the marks ──────────────────────────────────────────────────────────────────

/**
 * A block's or a run's state as a mark and a role, its word always beside it (the review of 2026-10-15: one meaning per mark):
 * ▶ running and … waiting (never ● or ○, a live and a configured connection's), ✓ completed, ✕ failed (amber), ■ stopped.
 */
export function stateMark(word: string, g: Pick<Glyphs, 'unicode' | 'ok' | 'fail' | 'next' | 'ellipsis' | 'dot' | 'warn'>): { glyph: string; role: Role } {
  switch (word) {
    case 'running': return { glyph: g.next, role: 'text' };
    case 'waiting': case 'starting': return { glyph: g.ellipsis, role: 'secondary' };
    case 'completed': return { glyph: g.ok, role: 'text' };
    case 'failed': return { glyph: g.fail, role: 'failure' };
    case 'stopped': case 'cancelled': return { glyph: g.unicode ? '■' : '#', role: 'text' };
    case 'interrupted': return { glyph: '!', role: 'attention' };
    case 'no change': return { glyph: '=', role: 'text' };
    case 'not run': return { glyph: g.unicode ? '–' : '-', role: 'secondary' };
    case 'not seen': return { glyph: g.unicode ? '◌' : '~', role: 'secondary' };
    case 'not run yet': return { glyph: g.dot, role: 'secondary' };
    default: return { glyph: '?', role: 'secondary' };
  }
}

/** The run detail's verdict as a mark (its words beside it): never green (a verdict is Timmy's judgement, not a check). */
function verdictMark(state: string, g: Glyphs): { glyph: string; role: Role } {
  switch (state) {
    case 'needs you': return { glyph: g.warn, role: 'attention' };
    case 'queued': return { glyph: g.ellipsis, role: 'secondary' };
    case 'cancelling': case 'cancelled': return { glyph: g.unicode ? '■' : '#', role: 'text' };
    case 'recovered': return { glyph: '!', role: 'attention' };
    default: return stateMark(state, g);
  }
}

// ── drawing parts (the shared ones: src/workbench/tab-columns.ts) ──────────────

const heading = (text: string, rest = ''): Line => [S(text.toUpperCase(), 'secondary', { bold: true }), ...(rest ? [S(` ${rest}`, 'secondary')] : [])];
const key = (k: string): Seg => S(`[${k}]`, 'action');

/** A heading and its words on one row where they fit whole, else the heading, then its words under it (never cut); with
 *  `gloss`, words that only gloss the heading, left out where they do not fit beside it. */
function head(title: string, rest: string, w: number, g: Glyphs, gloss = false): Line[] {
  const one = heading(title, `${g.sep} ${rest}`);
  if (lineCells(one) <= w) return [one];
  return gloss ? [heading(title)] : [heading(title), ...wrapText(rest, Math.max(4, w), g.ellipsis).map((t): Line => [S(t, 'secondary')])];
}

/** Wrapped text as rows of one role, each at most `w` cells (an indent counts); at most `max` rows, the last cut. */
function para(text: string, w: number, role: Role = 'secondary', indent = '', max = Infinity, ellipsis = '…'): Line[] {
  const rows = wrapText(text, Math.max(4, w - cells(indent)), ellipsis);
  const kept = rows.slice(0, Math.max(1, max));
  if (rows.length > kept.length) kept[kept.length - 1] = cut(`${kept[kept.length - 1]} ${rows.slice(kept.length).join(' ')}`, Math.max(4, w - cells(indent)), ellipsis);
  return kept.map((t) => [S(`${indent}${t}`, role)]);
}

/** label value, the value wrapped under itself (at most `max` rows); where the padded label leaves too little room, the label
 *  is padded no further, and where even that leaves too little, the label goes on its own row. */
function fieldRows(label: string, value: string, w: number, role: Role = 'text', o: { pad?: number; max?: number; ellipsis?: string } = {}): Line[] {
  let pad = o.pad ?? 9;
  if (w - pad - 1 < Math.min(8, cells(value)) || (cells(value) > w - pad - 1 && cells(value) <= w - cells(label) - 1)) pad = cells(label);
  const room = w - pad - 1;
  if (room < Math.min(8, cells(value))) return [[S(label, 'secondary')], ...para(value, w, role, '  ', o.max ?? 2, o.ellipsis)];
  const rows = para(value, room, role, '', o.max ?? 2, o.ellipsis);
  return rows.map((r, i) => [S(i ? ' '.repeat(pad + 1) : `${label.padEnd(pad)} `, 'secondary'), ...r]);
}

/** A card's title in a card `w` cells wide: `name` and its suffix (.intent, .predict, .receipt), the name cut where both do
 *  not fit (the suffix alone where not even four of its letters would), the suffix whole. */
function titled(name: string, suffix: string, w: number, ellipsis: string): string {
  const room = w - 7;
  if (cells(`${name}${suffix}`) <= room) return `${name}${suffix}`;
  return room - cells(suffix) >= 4 ? `${cut(name, room - cells(suffix), ellipsis)}${suffix}` : suffix;
}

/** A row on the selection's bar (the shared one: every segment selected, quiet words in the primary text colour), its name and
 *  cursor amber while the list has the keyboard. */
// (R7 H150: its name only; a command on it keeps the text's colour: commands are not amber, B10)
const onBarHere = (l: Line, focused: boolean): Line => onBar(l).map((s) => (focused && s.role === 'strong' ? { ...s, role: 'focus' as Role } : s));

/** A card's note where the shared card draws it beside a title that stays whole (else none). */
const noteFor = (title: string, note: string, w: number): Seg[] | undefined => (cells(title) + cells(note) + 7 <= w - 2 ? [S(note, 'secondary')] : undefined);

/** The three columns' widths in a body `total` cells wide: the plan, the sandbox and the receipt (36 : 37 : 27), the rules apart. */
export function columnWidths(total: number): [number, number, number] {
  const [l, m, r] = widths(Math.max(36, total - 2 * RULE_CELLS), [36, 37, 27], 12);
  return [l, m, r];
}

// ── the view ───────────────────────────────────────────────────────────────────

/** What the body is drawn with (src/workbench/views.ts ViewCtx, with the terminal's width where the caller passes it). */
export type TabViewCtx = ViewCtx;

/** The rows of the plan: each document's head, its notes and its blocks (an item each, in the order the cursor moves). */
interface PlanRow { line: Line; item?: Item }

/** The list's rows, and its items in order: every block (a document with none: the document), as before (R4, H110). */
function planRows(c: TabViewCtx, w: number, cur: number): { rows: PlanRow[]; items: Item[]; selRow: number } {
  const { g } = c;
  const focused = c.ui.focus === 'center';
  const rows: PlanRow[] = [];
  const items: Item[] = [];
  let selRow = -1;
  const nameW = Math.min(14, Math.max(4, ...c.data.workflows.docs.flatMap((d) => d.blocks.map((b) => cells(b.name)))));
  for (const d of c.data.workflows.docs) {
    const docHead: Line = [S(d.rel, 'strong'), S(` ${g.sep} ${count(d.blocks.length, 'block')}`, 'secondary')];
    // its title only where it fits whole
    const titled: Line = [...docHead, S(` ${g.sep} ${d.title ?? ''}`, 'secondary')];
    rows.push({ line: d.title && lineCells(titled) <= w ? titled : docHead });
    if (d.error) for (const l of para(`${g.fail} not read: ${d.error}`, w, 'failure', '  ', 2, g.ellipsis)) rows.push({ line: l });
    if (d.repeated.length) for (const l of para(`${g.warn} not runnable: it names ${d.repeated.join(', ')} more than once; none of them can run`, w, 'attention', '  ', 2, g.ellipsis)) rows.push({ line: l });
    if (!d.blocks.length) {
      const item: Item = { kind: 'doc', key: `doc:${d.rel}`, doc: d };
      const sel = items.length === cur;
      if (sel) selRow = rows.length;
      const l: Line = [S(sel ? `${g.cursor} ` : '  ', 'accent'), S('no named blocks', 'secondary')];
      rows.push({ line: sel ? onBarHere(l, focused) : l, item });
      items.push(item);
      continue;
    }
    for (const b of d.blocks) {
      const item: Item = { kind: 'block', key: `block:${d.rel}:${b.key}`, doc: d, block: b };
      const sel = items.length === cur;
      if (sel) selRow = rows.length;
      const m = stateMark(b.word, g);
      const state = `${m.glyph} ${stepStateWords(b.word)}`;
      const keyText = w >= 30 ? `${b.key.padStart(2)} ` : '';
      const risky = b.risky.length ? ` ${g.warn}` : '';
      const room = Math.max(4, Math.min(nameW, w - 2 - cells(keyText) - cells(risky) - 1 - cells(state)));
      const name = cut(b.name, room, g.ellipsis);
      const l: Line = [
        S(sel ? `${g.cursor} ` : '  ', 'accent'), S(keyText, 'secondary'), S(`${name}${' '.repeat(Math.max(0, room - cells(name)))}`, 'strong'),
        S(risky, 'attention'), S(' '), S(state, m.role),
      ];
      // its exit code and own time where they fit whole (the row is never cut inside them)
      if (b.detail && lineCells(l) + 1 + cells(b.detail) <= w) l.push(S(` ${b.detail}`, 'secondary'));
      rows.push({ line: sel ? onBarHere(l, focused) : l, item });
      items.push(item);
    }
  }
  return { rows, items, selRow };
}

/** The selected block's .intent card: its document, its command and what it needs, as the document has them now (its name is
 *  the card's title, its number the title's note). */
function intentCard(d: WorkflowDoc, b: BlockRow, w: number, g: Glyphs): Line[] {
  const iw = Math.max(4, w - 4);
  const rows: Line[] = [];
  const o = { ellipsis: g.ellipsis };
  rows.push(...fieldRows('document', d.rel, iw, 'text', o));
  const cmd = (b.command ?? '').split('\n').filter((l) => l.trim());
  // R10 (H163; H168's F4, pass 2a): the command by what it is, its lines the Inspector's ([i]: the block's COMMAND)
  rows.push(...fieldRows('command', cmd.length ? `${count(cmd.length, 'line')} of ${b.lang || 'shell'} ([i] shows ${cmd.length === 1 ? 'it' : 'them'})` : 'not read (the document carries none here)', iw, cmd.length ? 'text' : 'secondary', o));
  rows.push(...fieldRows('needs', b.needs.length ? b.needs.join(', ') : 'nothing', iw, 'text', o));
  // the order it runs in, where that is more than the block itself (its needs first)
  if (b.order.length && !(b.order.length === 1 && b.order[0] === b.name)) rows.push(...fieldRows('runs', b.order.join(` ${g.arrow} `), iw, 'text', o));
  if (b.missing.length) rows.push(...para(`${g.fail} not runnable: it needs ${b.missing.join(', ')}, which the document does not have`, iw, 'failure', '', 2, g.ellipsis));
  if (b.cycle?.length) rows.push(...para(`${g.fail} not runnable: its needs go round (${b.cycle.join(` ${g.arrow} `)})`, iw, 'failure', '', 2, g.ellipsis));
  if (d.repeated.includes(b.name)) rows.push(...para(`${g.warn} not runnable: the document names ${b.name} more than once`, iw, 'attention', '', 2, g.ellipsis));
  if (b.risky.length) rows.push(...para(`${g.warn} needs you before it runs`, iw, 'attention', '', 2, g.ellipsis));
  else rows.push(...para('no destructive command', iw, 'secondary', '', 2, g.ellipsis));
  const title = titled(b.name, '.intent', w, g.ellipsis);
  const note = noteFor(title, `block ${b.key}`, w);
  return card({ w, title: [S(title, 'accent', { bold: true })], ...(note ? { note } : {}), body: rows, edge: 'accent', g });
}

/** The selected block's newest run, when this frame read it for that block; undefined: not read for it (yet). */
function runFor(c: TabViewCtx, d: WorkflowDoc, b: BlockRow): RunNow | null | undefined {
  const t = c.data.workflowsTab;
  return t && t.for === blockKey(d.rel, b.name) ? t.run : undefined;
}

/** A run's detail (src/contracts/run-detail.ts), as the controller read it through the one producer. */
function detailFor(c: TabViewCtx, run: RunNow | null | undefined): Lazy<RunDetail> | undefined {
  return run?.operation ? c.data.details[run.operation] : undefined;
}

/** Why the run detail is not drawn, in words, or null when it is ready. */
function detailWhy(c: TabViewCtx, run: RunNow, d: Lazy<RunDetail> | undefined): { words: string; role: Role } | null {
  if (!run.operation) return { words: `not recorded: its job ${run.job} names no operation`, role: 'secondary' };
  if (!c.can.detail) return { words: `not recorded here: ${c.can.detailWhy ?? 'the run detail cannot be read here'}`, role: 'secondary' };
  if (!d || d.state === 'idle' || d.state === 'loading') return { words: `reading the run detail of ${run.operation}…`, role: 'secondary' };
  if (d.state === 'failed') return { words: `${c.g.fail} its run detail could not be read: ${d.why}`, role: 'failure' };
  return null;
}

/** The .predict card of the block's newest run: the prediction sealed before it, its receipt, and whether it was frozen before
 *  the run started (only when the run detail's frozenAt is earlier than the run's start; else not recorded). */
function predictCard(c: TabViewCtx, b: BlockRow, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  const iw = Math.max(4, w - 4);
  const rows: Line[] = [];
  const o = { ellipsis: g.ellipsis };
  if (run === undefined) rows.push(...para('reading its newest run…', iw, 'secondary', '', 2, g.ellipsis));
  else if (run === null) rows.push(...para('not recorded: nothing has run it yet. A run seals its prediction before it starts.', iw, 'secondary', '', 4, g.ellipsis));
  else {
    const d = detailFor(c, run);
    const why = detailWhy(c, run, d);
    if (why) rows.push(...para(why.words, iw, why.role, '', 3, g.ellipsis));
    else {
      const detail = (d as Extract<Lazy<RunDetail>, { state: 'ready' }>).value;
      const p = detail.prediction;
      if (!p) rows.push(...para(`not recorded: ${detail.unknown.find((u) => u.field === 'prediction')?.why ?? 'no prediction of this run is sealed'}`, iw, 'secondary', '', 3, g.ellipsis));
      else {
        // first, frozen before the run only where its record proves it: sealed earlier than the run's job started (its time
        // beside it where that fits whole), so a clipped column keeps it; then the sealed prediction's own words (the card's
        // title says what they are) and the receipt that sealed them
        const frozen = p.frozenAt ? Date.parse(p.frozenAt) : Number.NaN;
        const started = Date.parse(run.startedAt);
        if (Number.isFinite(frozen) && Number.isFinite(started) && frozen < started) {
          const at = ` ${g.sep} sealed ${clock(p.frozenAt)}`;
          rows.push([S('frozen before the run', 'text'), ...(cells(`frozen before the run${at}`) <= iw ? [S(at, 'secondary')] : [])]);
        } else rows.push(...para('frozen before the run: not recorded', iw, 'secondary', '', 2, g.ellipsis));
        // R10 (H167): its words with the request as the run it asks for; its receipt's id is the Inspector's ([i])
        rows.push(...para(p.words.replace(/^\/run (\S+) (\S+):/, 'run $1 › $2:'), iw, 'text', '', 4, g.ellipsis));
        rows.push([S(`${g.ok} sealed`, 'text'), S(' before the run', 'secondary')]);
      }
    }
  }
  const title = titled(b.name, '.predict', w, g.ellipsis);
  return card({ w, title: [S(title, 'accent', { bold: true })], body: rows, edge: 'accent', g });
}

/** Where a run runs, as its records say it: this computer, in the project folder, by upmd (on a pty or over a pipe); the
 *  environment its run detail names, when it names one. */
function sandboxRows(c: TabViewCtx, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  const rows: Line[] = [...head('Sandbox', 'where it runs', w, g)];
  // (R10 H163; H168's F4: the runner, upmd, is the Inspector's, [i])
  rows.push(...para('this computer, in the project folder', w, 'text', '', 2, g.ellipsis));
  // R10 (H167): the runner's file and the environment its run detail names are the Inspector's ([i]), not this column's
  void run;
  return rows;
}

/** The newest run's blocks with their states (the run named first: it may be one asked for a later block, which runs the
 *  blocks it needs first). */
function stepsRows(c: TabViewCtx, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  if (run === undefined) return [heading('Steps'), [S('reading its newest run…', 'secondary')]];
  if (run === null) return [heading('Steps'), ...para('not run yet: no job has run this block', w, 'secondary', '', 2, g.ellipsis)];
  const m = stateMark(run.word, g);
  const since = Date.parse(run.startedAt);
  const ended = run.endedAt ? Date.parse(run.endedAt) : c.now;
  const long = Number.isFinite(since) && Number.isFinite(ended) ? took(Math.max(0, ended - since)) : 'time unknown';
  // its state is never cut: on the heading's row where it fits whole, else on a row of its own; its time beside what it ran
  // (or under it), never broken across rows
  const state: Line = [S(`${m.glyph} ${run.word}`, m.role)];
  const timed: Line = [...state, S(` ${g.sep} ${long}`, 'secondary')];
  // R10 (H167): progress, steps done of all, in words; the job's id is the Inspector's
  const done = run.steps.filter((x) => x.word === 'completed').length;
  const progress = run.steps.length ? ` ${g.sep} ${done} of ${count(run.steps.length, 'step')}` : '';
  const one: Line = [...heading('Progress'), S(` ${g.sep} `, 'secondary'), ...state, S(progress, 'secondary')];
  const label = `${run.label}${run.stale ? ' (its record is stale)' : ''}`;
  const rows: Line[] = [];
  if (lineCells(one) <= w) {
    rows.push(one);
    if (cells(`${label} ${g.sep} ${long}`) <= w) rows.push([S(`${label} ${g.sep} ${long}`, 'secondary')]);
    else rows.push(...para(label, w, 'secondary', '', 2, g.ellipsis), [S(long, 'secondary')]);
  } else {
    rows.push([...heading('Progress'), S(progress, 'secondary')], lineCells(timed) <= w ? timed : state, ...para(label, w, 'secondary', '', 2, g.ellipsis));
    if (lineCells(timed) > w) rows.push([S(long, 'secondary')]);
  }
  for (const s of run.steps) {
    const sm = stateMark(s.word, g);
    const l: Line = [S(`${sm.glyph} `, sm.role), S(s.name, 'strong'), S(` ${stepStateWords(s.word)}`, sm.role)];
    if (s.detail && lineCells(l) + 3 + cells(s.detail) <= w) l.push(S(` ${g.sep} ${s.detail}`, 'secondary'));
    rows.push(l);
  }
  return rows;
}

/** R6 (H144): the selected block's newest run inspected, when this frame read it for that run's operation. */
function inspectionFor(c: TabViewCtx, run: RunNow | null | undefined): InspectionNow | undefined {
  const t = c.data.workflowsTab;
  return run?.operation && t?.inspection?.op === run.operation ? t.inspection : undefined;
}

const short12 = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : 'not recorded');

/**
 * R6 (H144): the run's source, as the producer read it: the document as upmd ran it (its sha256, the one its prediction
 * sealed, and where those bytes were read from) and the document now (✓ when it holds those bytes; ✕ and both hashes, with
 * the size of its diff, when it changed since). Nothing for a run that ran no workflow document.
 */
function sourceRows(c: TabViewCtx, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  const ins = inspectionFor(c, run);
  if (!ins || !('value' in ins)) return [];
  const s = ins.value.source;
  if (!('doc' in s)) return [];
  const rows: Line[] = [...head('Source', `${s.doc} as it ran`, w, g)];
  const from = s.copy.state === 'kept' ? 'the copy the run read' : s.copy.state === 'project' ? `${s.doc} in the project` : '';
  if (s.now.state === 'same') {
    const l: Line = [S(`${g.ok} `, 'live'), S('the same bytes now', 'text')];
    if (from && lineCells(l) + cells(` ${g.sep} read from ${from}`) <= w) l.push(S(` ${g.sep} read from ${from}`, 'secondary'));
    rows.push(l);
  } else if (s.now.state === 'changed') {
    const diff = s.diff?.shown ? ` (+${s.diff.added} −${s.diff.removed})` : '';
    rows.push(...para(`${g.fail} changed since the run${diff}`, w, 'failure', '', 2, g.ellipsis));
  } else rows.push(...para(s.now.words, w, 'secondary', '', 2, g.ellipsis));
  return rows;
}

/** A change's kind of content in a few words: its diff's size, an image, a binary, a text or a JSON. */
function changeWhat(ch: InspectChange): string {
  if (ch.diff.shown) return `+${ch.diff.added} −${ch.diff.removed}`;
  const p = ch.preview;
  if (!p) return '';
  if (p.kind === 'image') return `image${p.width && p.height ? ` ${p.width}×${p.height}` : ''}`;
  if (p.kind === 'binary') return `binary ${p.bytes} B`;
  if (p.kind === 'text') return p.json ? 'JSON' : `text ${p.lines.length + p.more} lines`;
  return '';
}

/**
 * R6 (H144): what the run changed, as /review reads it (the producer's inspection): a row per file (how, its path, its
 * content's kind or its diff's size, whether it is still what the run left, and whether /restore can bring its kept version
 * back), then the first one with a line diff: each hunk's head and its lines from the one before its first change to the one
 * after its last, or only its changed lines where the room is short, + and − marked (the terminal has no diff colours: the
 * marks carry it), within `room` rows; the files give way to the diff's first five rows.
 */
function changesRows(c: TabViewCtx, run: RunNow | null | undefined, w: number, room: number): Line[] {
  const { g } = c;
  if (!run?.operation) return [];
  const ins = inspectionFor(c, run);
  if (!ins) return [...head('Result', 'what it wrote', w, g, true), [S('reading…', 'secondary')]];
  if (!('value' in ins)) return [...head('Result', 'what it wrote', w, g, true), ...para(`not read: ${ins.why}`, w, 'secondary', '', 2, g.ellipsis)];
  const i = ins.value;
  const list = i.changes.list;
  const total = list.length + i.changes.more;
  // (R10 H167: a note's job id said as what it is: the Inspector names it)
  if (!total) return [...head('Result', 'none that Timmy records', w, g), ...(i.changes.notes[0] ? para(i.changes.notes[0].replace(/\bworkflow run j[0-9a-f]{6}: ?/, '').replace(/\bj[0-9a-f]{6}\b/g, 'its job'), w, 'secondary', '', 2, g.ellipsis) : [])];
  // R10 (H167): the result: the files it wrote, in words (the review command is the Inspector's)
  const rows: Line[] = [...head('Result', `${count(total, 'file')} written`, w, g, true)];
  // the first change with a line diff: each hunk's head, then its lines from the one before its first change to the one after
  // its last (`full`), or only its changed lines where the room is short (`core`): a terminal's few rows go to what changed
  const withDiff = list.find((x) => x.diff.shown);
  type DiffRow = { op: '@' | ' ' | '+' | '-'; text: string };
  const full: DiffRow[] = [];
  const core: DiffRow[] = [];
  if (withDiff?.diff.shown) {
    for (const h of withDiff.diff.hunks) {
      const changed = h.lines.map((l, k) => (l.op !== ' ' ? k : -1)).filter((k) => k >= 0);
      const from = Math.max(0, (changed[0] ?? 0) - 1);
      const to = Math.min(h.lines.length, (changed.at(-1) ?? h.lines.length - 1) + 2);
      full.push({ op: '@', text: h.header }, ...h.lines.slice(from, to));
      core.push({ op: '@', text: h.header }, ...h.lines.filter((l) => l.op !== ' '));
    }
  }
  // the files: as many as leave the diff its first five rows (where the room allows), the rest counted on a row of their own
  // (the heading says how many there are, so that row gives way first)
  const need = Math.min(full.length, 5);
  const filesMax = Math.max(1, room - rows.length - need);
  const shown = list.length <= filesMax ? list : list.slice(0, Math.max(1, filesMax - 1));
  const moreRow = total > shown.length && shown.length < filesMax;
  for (const ch of shown) {
    const how = ch.how.padEnd(7);
    // its content, then whether it is still what the run left (said only when it is not), and /restore's offer
    const now = ch.now.state === 'changed since' ? 'changed since the run' : ch.now.state === 'gone' ? 'gone since the run' : '';
    // its path whole: where the row is too narrow for all of it, its content's kind gives way first, then the rest
    const parts = [changeWhat(ch), now, ch.restore.offered ? 'restore offered' : ''].filter(Boolean);
    while (parts.length && cells(how) + 1 + cells(ch.path) + 1 + cells(parts.join(` ${g.sep} `)) > w) parts.shift();
    const extra = parts.join(` ${g.sep} `);
    const pathRoom = Math.max(4, w - cells(how) - 1 - (extra ? cells(extra) + 1 : 0));
    rows.push([S(`${how} `, 'secondary'), S(cut(ch.path, pathRoom, g.ellipsis), 'text'), ...(extra ? [S(` ${extra}`, 'secondary')] : [])]);
  }
  if (moreRow) rows.push([S(cut(`${g.ellipsis} ${count(total - shown.length, 'more file')} (c: all of them in the companion)`, w, g.ellipsis), 'secondary')]);
  if (withDiff?.diff.shown && full.length && rows.length < room) {
    const d = withDiff.diff;
    const against = d.against === 'kept' ? 'against the version Timmy kept' : d.against === 'nothing' ? 'added by the run' : 'as it ran → now';
    const named = shown.includes(withDiff) ? against : `${withDiff.path} ${against}`;
    const left = room - rows.length;
    const pick = full.length <= left ? full : core.length <= left ? core : core.slice(0, Math.max(1, left - 1));
    pick.forEach((l, k) => {
      if (l.op === '@') rows.push([S(cut(k ? l.text : `${l.text} ${named}`, w, g.ellipsis), 'secondary')]);
      // R8 (H157): a file's own line, cut where the row ends (src/workbench/text.ts clip), never moved back to a word
      else rows.push([S(l.op === '+' ? '+ ' : l.op === '-' ? '− ' : '  ', l.op === ' ' ? 'secondary' : 'strong'), S(clip(l.text || ' ', Math.max(1, w - 2), g.ellipsis), l.op === ' ' ? 'secondary' : 'text')]);
    });
    const missing = (pick === full ? full : core).length - pick.length;
    if (missing > 0) rows.push([S(cut(`${g.ellipsis} ${count(missing, 'more changed line')} (the companion draws the whole diff)`, w, g.ellipsis), 'secondary')]);
  }
  return rows;
}

/** R6 (H144): each stage's receipts as verified now (✓ green only where verifyReceiptIn passed in this reading; ✕ amber). */
function chainRow(ins: InspectionNow | undefined, w: number, g: Glyphs): Line[] {
  if (!ins || !('value' in ins)) return [];
  const list = ins.value.receipts.list;
  if (!list.length) return [];
  const stage = (st: InspectReceipt['stage'], name: string): Seg[] => {
    const rs = list.filter((r) => r.stage === st);
    if (!rs.length) return [];
    const bad = rs.filter((r) => !r.verified.ok).length;
    return [S(`${name} `, 'text'), bad ? S(`${g.fail}${rs.length > 1 ? ` ${bad} of ${rs.length}` : ''}`, 'failure') : S(`${g.ok}${rs.length > 1 ? ` ${rs.length}` : ''}`, 'live')];
  };
  const parts = [stage('predict', '.predict'), stage('run', 'run'), stage('receipt', '.receipt')].filter((p) => p.length);
  const one: Line = parts.flatMap((p, k) => (k ? [S(` ${g.sep} `, 'secondary'), ...p] : p));
  return lineCells(one) <= w ? [one] : parts.map((p) => p);
}

/** The newest run's log, its last lines (`room` rows at most, a count of the earlier ones first), each cut at the column's
 *  edge with an ellipsis, never wrapped. */
function outputRows(c: TabViewCtx, run: RunNow | null | undefined, w: number, room: number): Line[] {
  const { g } = c;
  if (run === undefined) return [heading('Output'), [S('reading…', 'secondary')]];
  if (run === null) return [heading('Output'), ...para('none yet: a run\'s log shows here', w, 'secondary', '', 2, g.ellipsis)];
  const rows: Line[] = [...head('Output', 'its log\'s last lines', w, g, true)];
  const all = run.tail.lines;
  if (!all.length) return [...rows, ...para(`none: ${run.tail.why ?? 'its log has no lines'}`, w, 'secondary', '', 2, g.ellipsis)];
  const fits = Math.max(1, room);
  const shown = all.length > fits ? all.slice(-Math.max(1, fits - 1)) : all;
  if (shown.length < all.length) {
    const earlier = `${g.ellipsis} ${count(all.length - shown.length, 'earlier line')}`;
    rows.push([S(earlier, 'secondary')]);
  }
  // R8 (H157): what the run printed, cut where the row ends (src/workbench/text.ts clip), never moved back to a word
  for (const l of shown) rows.push([S(clip(l, w, g.ellipsis), 'text')]);
  return rows;
}

/** What Enter does in the body now, and to which block: the RUN box (heavy amber while this list has the keyboard). */
function runBox(c: TabViewCtx, d: WorkflowDoc, b: BlockRow, w: number): Line[] {
  const { g } = c;
  const iw = Math.max(4, w - 4);
  const item: Item = { kind: 'block', key: `block:${d.rel}:${b.key}`, doc: d, block: b };
  const run = actionsOf(c, item).find((a) => a.key === 'Enter');
  const here = c.ui.focus === 'center';
  const rows: Line[] = [];
  if (!here) {
    // the review of 2026-10-15: with another block selected, row 2's primary named APPROVAL.md › tidy while the body said
    // "[Enter] Run it here": Enter acts where the keyboard is, and the box says so before anything is pressed
    const { acts, at } = selectedAction(c);
    const zone = c.ui.focus === 'top' ? `row 2${acts[at] ? ` (${acts[at].n} ${acts[at].label})` : ''}` : c.ui.focus === 'right' ? 'Context' : c.ui.focus === 'bottom' ? 'Activity & log' : 'the navigation';
    rows.push(...para(`Enter acts on ${zone} now. Tab to this list: then Enter runs ${d.rel} › ${b.name}`, iw, 'secondary', '', 4, g.ellipsis));
  } else if (run?.enabled) {
    // (R10 H163; H168's F4: that it is the REPL's own /run is the Inspector's, [i])
    rows.push([key('Enter'), S(' Run it here', 'text')], ...para('one job; it asks first', iw, 'secondary', '', 2, g.ellipsis));
  } else {
    // R10 (H167; H168's F4): a run going on, by what it is (its job's and operation's ids are the Inspector's, [i])
    const going = runOfBlock(c, d.rel, b.name);
    rows.push(...para(`Not from here now: ${going ? going.plain : run?.why ?? 'not available'}`, iw, 'secondary', '', 4, g.ellipsis));
  }
  rows.push(...fieldRows('runs', b.order.join(` ${g.arrow} `), iw, 'text', { pad: 5, max: 2, ellipsis: g.ellipsis }));
  if (b.risky.length) rows.push(...para(`${g.warn} its NEEDS YOU box asks first`, iw, 'attention', '', 2, g.ellipsis));
  const going = runOfBlock(c, d.rel, b.name);
  if (going && here) rows.push(...para('x stops it', iw, 'secondary', '', 1, g.ellipsis));
  // (R10 H167; H168's F4: the commands that run it in the REPL and in a shell are the Inspector's, [i])
  // the block it runs, named whole on the box's edge where it fits, else its name there and its document first inside
  const full = `RUN ${d.rel} › ${b.name}`;
  const fits = cells(full) <= w - 7;
  if (!fits) rows.unshift([S(`${d.rel} ›`, 'secondary'), S(` ${b.name}`, 'strong')]);
  // R10 (H163; H168's F4, pass 2a): a plain action in structure's colours, whichever zone has the keyboard: amber is the focus's
  // and the one primary's (row 2), and the list's own selection marks the block Enter runs
  return card({ w, title: [S(fits ? full : `RUN ${cut(b.name, Math.max(1, w - 10), g.ellipsis)}`, 'strong')], body: rows, edge: 'border', g });
}

/** The one line where the references draw a picture: a terminal says the run in words, and where it is drawn. */
// R5 (H131; the QA of e7f853e, defect 2): no Timmy surface had a run's preview. R6 (H144): the companion's run detail draws
// the run's changes (their diffs), its images and its outputs
// R10 (H167): c opens the companion on this run (its address names it, H164's openTarget); its page's path is the Inspector's
const previewWords = (op: string | null | undefined): string => `The companion (c) draws this run's diffs, images and outputs${op ? ', on its Workflows tab' : ''}.`;

/**
 * R10 (H167): what the run's columns leave out, for the Inspector ([i]): the job's and the operation's ids, the receipt's id,
 * kind and hash, the document's sha256 as it ran and now, the runner and the environment its run detail names, and the
 * commands that show it all in the REPL. Empty when the block has no run read.
 */
export function runDetailRows(c: TabViewCtx, w: number): Line[] {
  const { g } = c;
  const rows: Line[] = [];
  const f = (k: string, v: string): void => { rows.push(...fieldRows(k, v, w, 'text', { pad: 11, max: 3, ellipsis: g.ellipsis })); };
  // R10 (H167; H168's F4): the selected block's own commands, which the RUN box no longer shows: the REPL's and a shell's
  const sel = selectedBlock(c);
  if (sel) {
    rows.push(heading('The selected block · commands'));
    f('REPL', `/run ${sel.doc.rel} ${sel.block.name}`);
    f('shell', `timmy md ${sel.doc.rel} ${sel.block.name}`);
    // (R10 H163; H168's F4: what the RUN box and the plan say in words)
    f('Enter', 'runs it as the REPL\'s own /run does: one job; it asks first');
    if (c.data.workflows.upmd) f('runner', 'upmd, found on this computer');
  }
  const t = c.data.workflowsTab;
  const run = t?.run;
  if (!run) return rows;
  if (rows.length) rows.push([]);
  rows.push(heading('Its newest run · details'));
  f('job', run.job);
  f('operation', run.operation ?? 'none named');
  if (run.receipt) { f('receipt', `${run.receipt.id} (${run.receipt.kind})`); f('hash', run.receipt.hash); }
  else if (run.named) f('receipt', `${run.named} (named by its job record; not on the chain read here)`);
  const ins = inspectionFor(c, run);
  if (ins && 'value' in ins && 'doc' in ins.value.source) {
    const src = ins.value.source;
    f('as it ran', `${src.doc} · sha256 ${src.asRan.sha256 ?? 'not recorded'}`);
    if ('sha256' in src.now && src.now.sha256) f('now', `sha256 ${src.now.sha256}`);
  }
  const d = detailFor(c, run);
  const detail = d?.state === 'ready' ? d.value : undefined;
  const runner = detail?.worker.harness?.value ?? (run.pty ? 'upmd on a pty' : 'upmd');
  f('runner', runner);
  if (detail?.worker.environment) f('environment', detail.worker.environment.value);
  if (run.operation) f('commands', `/op ${run.operation} · /review ${run.operation} · /jobs ${run.job} · timmy op ${run.operation} (a shell)`);
  return rows;
}

/**
 * R10 (H167; H168's F4, reference 12's top row): the selected block's newest run in one row, as Home says a run: the block, its
 * state, its steps done of all, its time, the files it wrote and its receipt (✓ sealed and verified only where verifyReceiptIn
 * passed in this reading). Shorter words before cutting: its time, then its steps, give way first. Nothing before a run is read.
 */
export function runSummaryRow(c: TabViewCtx, d: WorkflowDoc, b: BlockRow, run: RunNow | null | undefined, w: number): Line | null {
  const { g } = c;
  if (!run) return null;
  const m = stateMark(run.word, g);
  const done = run.steps.filter((x) => x.word === 'completed').length;
  const since = Date.parse(run.startedAt);
  const ended = run.endedAt ? Date.parse(run.endedAt) : c.now;
  const long = Number.isFinite(since) && Number.isFinite(ended) ? took(Math.max(0, ended - since)) : '';
  const ins = inspectionFor(c, run);
  const files = ins && 'value' in ins ? ins.value.changes.list.length + ins.value.changes.more : null;
  const receipt: Seg = run.receipt
    ? (run.receipt.verified.ok ? S(`${g.ok} sealed and verified`, 'live') : S(`${g.fail} sealed, not verified`, 'failure'))
    : S(run.named ? `${g.fail} its receipt is not on the chain read here` : run.live ? 'its receipt is sealed as it ends' : 'no receipt sealed', run.named ? 'failure' : 'secondary');
  const parts: Array<{ seg: Seg; drop: number }> = [
    { seg: S(`${d.rel} › ${b.name}`, 'strong'), drop: 9 },
    { seg: S(`${m.glyph} ${run.word}`, m.role), drop: 9 },
    ...(run.steps.length ? [{ seg: S(`${done} of ${count(run.steps.length, 'step')}`, 'text'), drop: 2 }] : []),
    ...(long ? [{ seg: S(long, 'secondary'), drop: 1 }] : []),
    ...(files !== null ? [{ seg: S(files ? `${count(files, 'file')} written` : 'no file written', 'text'), drop: 3 }] : []),
    { seg: receipt, drop: 9 },
  ];
  const line = (ps: typeof parts): Line => ps.flatMap((p, k) => (k ? [S(` ${g.sep} `, 'secondary'), p.seg] : [p.seg]));
  let kept = parts;
  for (const level of [1, 2, 3]) { if (lineCells(line(kept)) <= w) break; kept = kept.filter((p) => p.drop > level); }
  return fit(line(kept), w, g.ellipsis);
}

/** The newest run's receipt card: green and verified only when verifyReceiptIn passed in this reading. */
function receiptCard(c: TabViewCtx, b: BlockRow, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  const iw = Math.max(4, w - 4);
  const rows: Line[] = [];
  let edge: Role = 'border';
  const o = { pad: 6, ellipsis: g.ellipsis };
  if (run === undefined) rows.push(...para('reading its newest run…', iw, 'secondary', '', 2, g.ellipsis));
  else if (run === null) rows.push(...para('not recorded: nothing has run it, so nothing is sealed', iw, 'secondary', '', 3, g.ellipsis));
  else if (!run.receipt) {
    if (run.named) rows.push(...para(`${g.fail} not verified: its job record names it, and it is not on the chain read here`, iw, 'failure', '', 3, g.ellipsis));
    else rows.push(...para(run.live ? 'not sealed yet: it runs; its receipt is sealed as it ends' : 'none sealed for this run', iw, 'secondary', '', 3, g.ellipsis));
    if (run.named) edge = 'failure';
  } else {
    const r = run.receipt;
    // R10 (H167): sealed and verified, in words (its id and kind are the Inspector's)
    if (r.verified.ok) { edge = 'live'; rows.push([S(`${g.ok} sealed and verified`, 'live')], [S(`sealed ${clock(r.ts)}`, 'secondary')], ...para('its link, body and signature, read now', iw, 'secondary', '', 2, g.ellipsis)); }
    else { edge = 'failure'; rows.push([S(`sealed ${clock(r.ts)}`, 'text')], ...para(`${g.fail} not verified: ${r.verified.why}`, iw, 'failure', '', 4, g.ellipsis)); }
  }
  // R6 (H144): each stage's receipts of the run (the producer's inspection), as verified now
  if (run) rows.push(...chainRow(inspectionFor(c, run), iw, g));
  const title = titled(b.name, '.receipt', w, g.ellipsis);
  return card({ w, title: [S(title, edge === 'live' ? 'live' : edge === 'failure' ? 'failure' : 'strong', { bold: true })], body: rows, edge, g });
}

/** The run detail's checks, predicted against actual (green only for one that passed), its verdict, and timmy op <id>. */
function reviewRows(c: TabViewCtx, run: RunNow | null | undefined, w: number): Line[] {
  const { g } = c;
  const rows: Line[] = [...head('Checks', 'predicted vs actual', w, g)];
  const d = detailFor(c, run);
  const why = run ? detailWhy(c, run, d) : null;
  const detail = !why && d?.state === 'ready' ? d.value : undefined;
  if (run === undefined) rows.push([S('reading…', 'secondary')]);
  else if (run === null) rows.push(...para('not recorded: nothing has run', w, 'secondary', '', 2, g.ellipsis));
  else if (why) rows.push(...para(why.words, w, why.role, '', 3, g.ellipsis));
  else if (detail && !detail.checks.length) rows.push(...para('none recorded for this run', w, 'secondary', '', 2, g.ellipsis));
  else if (detail) {
    for (const ch of detail.checks.slice(0, 8)) {
      const mark = ch.differs === false ? { glyph: g.ok, role: 'live' as Role, word: 'matches' } : ch.differs === true ? { glyph: g.fail, role: 'failure' as Role, word: 'differs' } : { glyph: '?', role: 'secondary' as Role, word: 'not known yet' };
      const named: Line = [S(`${mark.glyph} `, mark.role), S(ch.name, mark.role === 'secondary' ? 'text' : mark.role)];
      // its word beside its name where it fits whole, else on the row under it
      if (lineCells(named) + 1 + cells(mark.word) <= w) rows.push([...named, S(` ${mark.word}`, mark.role)]);
      else rows.push(named, [S('  '), S(mark.word, mark.role)]);
      rows.push(...para(`${ch.predicted ?? 'no prediction'} ${g.arrow} ${ch.actual}`, w, 'secondary', '  ', 2, g.ellipsis));
    }
    // (R10 H167; H168's F4: the rest where the whole run is drawn, in words; the command that prints them is the Inspector's)
    if (detail.checks.length > 8) rows.push([S(`and ${detail.checks.length - 8} more: the companion (c) lists them all`, 'secondary')]);
  }
  rows.push([], heading('Verdict'));
  if (run === undefined) rows.push([S('reading…', 'secondary')]);
  else if (run === null) rows.push([S('not run yet', 'secondary')]);
  else if (detail) {
    const v = detail.verdict;
    const vm = verdictMark(v.state, g);
    rows.push([S(`${vm.glyph} `, vm.role), S(v.state, vm.role === 'secondary' ? 'text' : vm.role, { bold: true })]);
    const said = v.words.startsWith(v.state) ? v.words.slice(v.state.length).replace(/^[:\s·-]+/, '') : v.words;
    // R10 (H167): a job by its label (its id is the Inspector's)
    const words = said.replace(/\bjob j[0-9a-f]{6} /g, '').replace(/\bj[0-9a-f]{6}\b/g, 'its job');
    if (words) rows.push(...para(words, w, 'secondary', '', 3, g.ellipsis));
  } else {
    // its run detail is not here: the run's own record, in its words (never a verdict made here)
    const m = stateMark(run.word, g);
    rows.push([S(`${m.glyph} `, m.role), S(run.word, m.role === 'secondary' ? 'text' : m.role, { bold: true })], [S('(its job record\'s word)', 'secondary')]);
  }
  // (R10 H167; H168's F4: the whole run detail's command and the operation's id are the Inspector's, [i])
  return rows;
}

/** The plan column's head: upmd as found, or the step that installs it. */
function planHead(c: TabViewCtx, w: number): Line[] {
  const { g } = c;
  const wf = c.data.workflows;
  // (R10 H163; H168's F4: the runner by what it is; its name and the command that installs it are the Inspector's, [i])
  if (wf.upmd) return [heading('Plan', `${g.sep} its runner is installed`)];
  return [[S('PLAN', 'secondary', { bold: true }), S(` ${g.sep} `, 'secondary'), S('the workflow runner is not installed', 'attention')], ...para('[i] says how to install it; nothing can run until it is', w, 'secondary', '', 2, g.ellipsis)];
}

/** No workflow document: what a workflow is, and where a starter is. */
function noDocs(w: number, g: Glyphs): Line[] {
  return [
    [S('No workflow documents in this project.', 'strong')],
    ...para('A workflow is a Markdown file with named blocks, such as ```bash [name:build]. Templates has the tray-workflow starter, a whole request as one operation.', w, 'secondary', '', 6, g.ellipsis),
  ];
}

/**
 * Tab 3's body: three working columns side by side from 120 terminal columns (each exactly its width, joined by rules; a
 * column too long for the body is clipped and says "1–N of M"), stacked below (the list, what Enter does, then the cards,
 * the sandbox and the receipt). Its items are the blocks (a document without blocks: the document), in the order of today's
 * list, so every key and click acts as before; Enter on a block opens its Run confirm (src/workbench/controller.ts).
 */
export function workflowsTabView(c0: ViewCtx): View {
  const c = c0 as TabViewCtx;
  const { data, g } = c;
  const W = Math.max(1, c.width);
  const H = Math.max(1, c.height);
  const wide = sideBySideAt(c);
  const all = data.workflows.docs.flatMap((d) => (d.blocks.length ? d.blocks.map(() => 1) : [1])).length;
  const cur = Math.max(0, Math.min(all - 1, c.ui.cursor['center:workflows'] ?? 0));
  const [lw, cw, rw] = wide ? columnWidths(W) : [W, W, W];
  const plan = planRows(c, lw, cur);
  const sel = plan.items[cur];
  const selDoc = sel && (sel.kind === 'block' || sel.kind === 'doc') ? sel.doc : undefined;
  const selBlock = sel?.kind === 'block' ? sel.block : undefined;
  const run = selDoc && selBlock ? runFor(c, selDoc, selBlock) : null;

  // R10 (H163): read right after the first frame; until then neither the documents nor upmd are known, so neither is said
  if (data.workflows.reading) return { lines: [fit([S('The workflow documents are being read…', 'secondary')], W, g.ellipsis)], items: [] };
  if (!data.workflows.docs.length) return { lines: [...planHead(c, W), [], ...noDocs(W, g)].map((l) => fit(l, W, g.ellipsis)), items: [] };

  if (!wide) {
    // stacked: the list first (the screen keeps its selected row in view), what Enter does under it, then the rest in order
    const lines: Line[] = [...planHead(c, W)];
    const items: View['items'] = [];
    for (const r of plan.rows) { if (r.item) items.push({ line: lines.length, item: r.item }); lines.push(r.line); }
    if (selDoc && selBlock) {
      // R10 (H167; H168's F4): the newest run in one row, as Home says it, above what Enter does
      const summary = runSummaryRow(c, selDoc, selBlock, run, W);
      lines.push([], ...(summary ? [summary] : []), ...runBox(c, selDoc, selBlock, W), [], ...intentCard(selDoc, selBlock, W, g), ...predictCard(c, selBlock, run, W));
      lines.push([], ...sandboxRows(c, run, W), ...stepsRows(c, run, W), ...sourceRows(c, run, W), ...changesRows(c, run, W, 12), ...outputRows(c, run, W, 8), ...para(previewWords(run?.operation), W, 'secondary', '', 4, g.ellipsis));
      lines.push([], ...receiptCard(c, selBlock, run, W), ...reviewRows(c, run, W));
    }
    return { lines: lines.map((l) => fit(l, W, g.ellipsis)), items };
  }

  // ── side by side ──
  // R10 (H167; H168's F4; reference 12's top row): the selected block's newest run in one row across the three columns (its
  // state, steps, time, the files it wrote, its receipt); the columns take the rows under it
  const summary = selDoc && selBlock ? runSummaryRow(c, selDoc, selBlock, run, W) : null;
  const HB = summary ? Math.max(1, H - 1) : H;
  // the left column: the head, the list (windowed to keep the selected row in view), the .intent and .predict cards, and
  // (R6, H144) the run's source under them where it fits beside the whole list (else in the centre column)
  const head = planHead(c, lw);
  const cards0 = selDoc && selBlock ? [...intentCard(selDoc, selBlock, lw, g), ...predictCard(c, selBlock, run, lw)] : [];
  const sourceLeft = cards0.length ? sourceRows(c, run, lw) : [];
  const leftHere = sourceLeft.length > 0 && head.length + plan.rows.length + 1 + cards0.length + 1 + sourceLeft.length <= HB;
  const cards = leftHere ? [...cards0, [], ...sourceLeft] : cards0;
  // the list keeps at least a third of the column (all of it when shorter); the cards take what is left, clipped when they
  // do not fit (the column then says which of its rows show)
  const floor = Math.min(plan.rows.length, Math.max(5, Math.floor((HB - head.length) / 3)));
  const listRoom = Math.max(floor, HB - head.length - (cards.length ? cards.length + 1 : 0));
  const win = windowMarked(plan.rows.map(() => 1), plan.selRow, listRoom, g, lw);
  const left: Line[] = [...head];
  if (win.above) left.push(win.above);
  const first = left.length;
  for (let i = win.start; i < win.end; i += 1) left.push(plan.rows[i].line);
  if (win.below) left.push(win.below);
  if (cards.length) left.push([], ...cards);
  // every item is the list's, in its order (the cursor moves through each); one outside the window is on no row drawn
  const items: View['items'] = [];
  plan.rows.forEach((r, i) => { if (r.item) items.push({ line: i < win.start ? -1 : i >= win.end ? HB + 1 : first + i - win.start, item: r.item }); });

  // the centre column: where it runs, the steps, the log's last lines, the RUN box, the preview line
  const centre: Line[] = [];
  if (selDoc && selBlock) {
    const box = runBox(c, selDoc, selBlock, cw);
    const note = para(previewWords(run?.operation), cw, 'secondary', '', 4, g.ellipsis);
    const sandbox = sandboxRows(c, run, cw);
    const steps = stepsRows(c, run, cw);
    const source = leftHere ? [] : sourceRows(c, run, cw);
    // R6 (H144): its changes take what the rest leaves but the log's three rows once the run has ended (three fifths of it while
    // it runs; at least four rows), the log's last lines the remainder (a blank row before the box). R10 (H167; H168's F4: the
    // RUN box was cut at the column's foot): where the column is short, the log's lines give way first, then the changes' rows,
    // so the box and the line under it stay whole
    const free = HB - sandbox.length - steps.length - source.length - 1 - box.length - note.length;
    // (the log's heading, its "earlier lines" row and one line: three rows)
    const changes = changesRows(c, run, cw, Math.max(Math.min(4, Math.max(2, free - 3)), run && !run.live ? free - 3 : Math.floor((free - 3) * 0.6)));
    const tailRoom = Math.max(1, free - changes.length - 1);
    const output = free - changes.length >= 3 ? outputRows(c, run, cw, tailRoom) : [];
    centre.push(...sandbox, ...steps, ...source, ...changes, ...output, []);
    // a click on [Enter] selects the row under it first: the box's [Enter] is kept off every row a block of the list is on
    const lastItemRow = Math.max(-1, ...items.filter((x) => x.line >= 0 && x.line < HB).map((x) => x.line));
    const enterAt = box.findIndex((l) => l.some((s) => s.text === '[Enter]'));
    if (enterAt >= 0) while (centre.length + enterAt <= lastItemRow && centre.length + box.length + note.length < HB) centre.push([]);
    centre.push(...box, ...note);
  } else centre.push(...sandboxRows(c, null, cw));

  // the right column: the receipt card, the checks, the verdict
  const right: Line[] = selBlock ? [...receiptCard(c, selBlock, run, rw), [], ...reviewRows(c, run, rw)] : [];

  // each column clipped to the body (one too long says which of its rows show), side by side between rules
  const cols = [{ w: lw, lines: clipRows(left, lw, HB, g) }, { w: cw, lines: clipRows(centre, cw, HB, g) }, { w: rw, lines: clipRows(right, rw, HB, g) }];
  const body = sideBySide(cols, Math.min(HB, Math.max(...cols.map((x) => x.lines.length))), g);
  if (!summary) return { lines: body, items };
  return { lines: [summary, ...body], items: items.map((x) => ({ ...x, line: x.line >= 0 ? x.line + 1 : x.line })) };
}

/** The block the list's cursor is on (the Follow selected artifact setting aside), for the controller's reading. */
export function selectedBlock(c: Pick<ViewCtx, 'ui' | 'data'>): { doc: WorkflowDoc; block: BlockRow } | null {
  const all = c.data.workflows.docs.flatMap((d) => (d.blocks.length ? d.blocks.map((b) => ({ d, b: b as BlockRow | null })) : [{ d, b: null as BlockRow | null }]));
  if (!all.length) return null;
  const at = all[Math.max(0, Math.min(all.length - 1, c.ui.cursor['center:workflows'] ?? 0))];
  return at.b ? { doc: at.d, block: at.b } : null;
}
