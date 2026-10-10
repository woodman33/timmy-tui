/**
 * Round R4 (H47): one connected workflow card per workflow document, on the board's snapshot and on `/board live`, and
 * the same connected summary in the REPL (`/workflows <file>`). The operator's direction (02:26): "make upmd's readable
 * instructions, editable nodes, parameters, execution and results one connected workflow".
 *
 * A card joins what Timmy already has; nothing here runs a block or rebuilds upmd:
 *   instructions   the document's own prose (src/workflows/markdown.ts), each named block drawn in place as a chip that
 *                  leads to its node; the Markdown as written is one click away (a closed <details>, and on the
 *                  snapshot a link to the file)
 *   graph          the node graph of src/repl/board-nodes.ts, each node with its state in words
 *   inspector      for the selected node (the snapshot lists every node's, each in a closed <details>): its name,
 *                  language and needs; its command (editable on the live board through the existing `save-workflow`
 *                  edit); its last result from the run records; the parameter files its command names
 *   parameters     a block whose command names `recipes/tray.params.json` shows the tray recipe's checked card
 *                  (src/repl/board-cards.ts); one that names an OpenSCAD model's `<model>.params.json` (the model sits
 *                  beside it) shows that file with the scad-params checker's rules, saved through `set-scad-params`
 *                  (src/repl/board-edits.ts). They are found by a plain match of the file's path in the command's text,
 *                  and the card says so; no other kind of parameter is offered
 *   execution      Run up to here is `/run <file> <block>`: upmd runs the block after the blocks it needs, in runOrder's
 *                  order (src/workflows/upmd.ts; upmd 0.2.7's `--ci -b <name>`, as observed). Run this block is that same
 *                  run when the block needs nothing; for a block with needs it is not offered, because no observed upmd
 *                  mode runs a block without them. Stop is the existing /stop of the Jobs section
 *   results        a run's job record and its sealed outcome: each block's state (waiting, running, completed, failed,
 *                  stopped, interrupted, not run), exit code and, for a run this REPL watched, its own time; the files
 *                  the run wrote (from the outcome receipt; a run's files are not attributed to one block) and the
 *                  outcome receipt. A run whose job record is stale (its session ended while it ran) is interrupted:
 *                  the card says so and gives `/run <file> <block>` again; nothing resumes a run
 *
 * Every string is escaped. Colour never stands alone: each state is a word, each glyph its own shape; green is for
 * interaction (the selection, the primary action), never for an outcome.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { paramsFileFor, readScadParams, SCAD_LIMITS, type ScadValue } from '../native/scad-params.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Segment } from '../term/theme.js';
import type { Receipt } from '../utils/receipts.js';
import { markdownLinks, renderMarkdown } from '../workflows/markdown.js';
import { parseWorkflow, runOrder, type WorkflowBlock } from '../workflows/upmd.js';
import { renderParamsCard, type ParamsCard } from './board-cards.js';
import { esc, stamp, type Kit } from './board-kit.js';
import type { NodeInput, WorkflowDocInput } from './board-nodes.js';

type Line = Segment[];

// ── the connected data ───────────────────────────────────────────────────────

/** A block's state, always in words. */
export type NodeWord = 'waiting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'not run' | 'not run yet' | 'unknown';
export const NODE_GLYPH: Record<NodeWord, string> = { waiting: '○', running: '●', completed: '✓', failed: '✕', stopped: '■', interrupted: '!', 'not run': '–', 'not run yet': '·', unknown: '?' };
/** The class a state word gives (colour and border only; the word and the glyph carry the meaning). */
export const wordClass = (w: string): string => `wfs-${w.replace(/[^a-z]/g, '')}`;

/** A parameter file a block's command names, found by a plain match of its path in the command's text. */
export type ParamRef = { kind: 'tray'; path: string } | { kind: 'scad'; path: string; model: string };

/** An OpenSCAD model's parameter file as the board shows it (src/native/scad-params.ts readScadParams). */
export interface ScadParamsView {
  /** the model, relative to the project (box.scad) */
  model: string;
  /** its parameter file (box.params.json) */
  path: string;
  file: { state: 'none' } | { state: 'ok'; sha256: string; parameters: Record<string, ScadValue> } | { state: 'unusable'; error: string; sha256?: string };
}

/** One run of the document (a /run job), as its job record and its sealed outcome say. */
export interface WorkflowRun {
  job: string;
  /** the block /run named; upmd ran it after the blocks it needs */
  target: string;
  /** the blocks in run order */
  order: string[];
  /** where that order comes from */
  orderFrom: 'prediction' | 'sealed' | 'document';
  /** the run in words: starting, running, completed, failed, stopped, interrupted */
  word: string;
  /** started by this REPL and still going: the Jobs section's Stop (and /stop) can stop it */
  stoppable: boolean;
  /** the record of a run this REPL did not start (an earlier session, or another one) */
  foreign: boolean;
  startedAt: string;
  endedAt?: string;
  ms?: number;
  error?: string;
  /** the outcome receipt (its short id), sealed when the run ended */
  receipt?: string;
  /** whether the sealed prediction was met */
  met?: boolean;
  /** the prediction receipt sealed before it ran, when known */
  predicted?: string;
  /** each block of the run, in order, with its state, exit code and (for a run this REPL watched) its own time */
  blocks: Array<{ name: string; word: NodeWord; code?: number; ms?: number }>;
  /** the block that was running when an interrupted run's session ended */
  interruptedAt?: string;
  /** the files the run wrote, from its sealed outcome (at most 8 here), each with what it is now */
  outputs: Array<{ rel: string; note: string }>;
  outputsMore: number;
  /** the document's sha256 when it ran (from its prediction receipt), when that receipt is found */
  docSha256?: string;
}

/** A node as the card draws it. */
export interface NodeView {
  /** the block's key: upmd's block number (unique in the document) */
  key: string;
  name: string;
  word: NodeWord;
  /** a few words after the state: exit code, own time */
  detail: string;
  /** the run its state comes from (the newest run that included it) */
  run?: string;
  /** its whole command, as parseWorkflow reads it from the document's text (absent when the text was not read) */
  command?: string;
  /** what Run up to here runs: the block after what it needs, as runOrder predicts */
  order: string[];
  missing: string[];
  cycle?: string[];
  neededBy: string[];
  params: ParamRef[];
}

export interface ConnectedWorkflow {
  /** one per named block, in the document's order */
  nodes: NodeView[];
  /** the runs the card names, newest first: the newest of the document, and the ones its nodes' states come from */
  runs: WorkflowRun[];
  /** the newest run of the document */
  latest?: string;
  /** the tray recipe's card, when a block names its file */
  tray?: ParamsCard;
  scad: ScadParamsView[];
  /** the project files the document's prose links to that are there */
  files: string[];
  /** upmd was found (UPMD_BIN, or upmd on PATH); absent when not looked for */
  upmd?: boolean;
}

/**
 * When each block of a run started and ended, as Timmy saw upmd's start and end lines (this REPL's runs only, in
 * memory): the Workspace notes every change of a workflow job. A block's own time is known only here.
 */
export class StepClock {
  private readonly runs = new Map<string, Array<{ start?: number; end?: number }>>();
  note(job: Pick<JobRecord, 'id' | 'steps'>, now = Date.now()): void {
    let t = this.runs.get(job.id);
    if (!t) {
      t = [];
      this.runs.set(job.id, t);
      if (this.runs.size > 64) this.runs.delete(this.runs.keys().next().value!);
    }
    job.steps.forEach((s, i) => {
      const e = (t![i] ??= {});
      if (e.start === undefined && e.end === undefined && s.state === 'running') e.start = now;
      if (e.end === undefined && s.state !== 'running') e.end = now;
    });
  }
  /** a block's own time in ms: only when its start and its end were both seen */
  ms(job: string, i: number): number | undefined {
    const e = this.runs.get(job)?.[i];
    return e?.start !== undefined && e.end !== undefined ? Math.max(0, e.end - e.start) : undefined;
  }
}

export interface ConnectContext {
  root: string;
  /** this project's jobs, newest first */
  jobs: readonly JobRecord[];
  chain: readonly Receipt[];
  /** the project's files (relative), for the prose's links and the OpenSCAD models */
  files: readonly string[];
  /** this REPL's prediction for a run it started */
  prediction?: (job: string) => { order: string[]; receipt?: string } | undefined;
  /** this REPL started the job (only those can be stopped here) */
  mine?: (job: string) => boolean;
  clock?: StepClock;
  /** the tray recipe's card (read when a block names its file) */
  tray?: () => ParamsCard | undefined;
  /** upmd was found */
  upmd?: boolean;
}

export const TRAY_PARAMS = 'recipes/tray.params.json';
/** How many of a document's runs are read, newest first, and how many output files a run shows. */
const RUNS_READ = 20;
const OUTPUTS_SHOWN = 8;
/** Larger outputs are not hashed again to say whether they changed since the run. */
const OUTPUT_HASH_LIMIT = 8 * 1024 * 1024;
/** The prose drawn: up to this much of the document (the rest is one click away). */
export const TEXT_DRAWN = 256 * 1024;

const PATH_CHAR = /[A-Za-z0-9_\-./]/;
/**
 * Whether a command's text names a file by its path: the path itself, not inside a longer name (`mybox.params.json`,
 * `out/box.params.json`, `box.params.json.bak`); `./` before it counts. A plain match of the text: the command is not
 * run or parsed, so whether it reads the file is not known.
 */
export function mentions(text: string, rel: string): boolean {
  if (!rel) return false;
  for (let i = text.indexOf(rel); i >= 0; i = text.indexOf(rel, i + 1)) {
    const after = text[i + rel.length] ?? '';
    if (after && PATH_CHAR.test(after)) continue;
    const before = i > 0 ? text[i - 1] : '';
    if (!before || !PATH_CHAR.test(before)) return true;
    if (before === '/' && text[i - 2] === '.' && (i < 3 || !PATH_CHAR.test(text[i - 3]))) return true;
  }
  return false;
}

/** The parameter files a command names: the tray recipe's, and each OpenSCAD model's `<model>.params.json`. */
export function paramRefs(code: string, scadModels: readonly string[]): ParamRef[] {
  const refs: ParamRef[] = [];
  if (mentions(code, TRAY_PARAMS)) refs.push({ kind: 'tray', path: TRAY_PARAMS });
  for (const model of scadModels) {
    const path = paramsFileFor(model);
    if (path !== TRAY_PARAMS && mentions(code, path) && !refs.some((r) => r.path === path)) refs.push({ kind: 'scad', path, model });
  }
  return refs;
}

/** A /run job's document and block, from its upmd arguments (`--ci -b <block> -d <dir> <file>`), else its label. */
export function runOf(j: Pick<JobRecord, 'kind' | 'args' | 'root' | 'label'>): { doc: string; target: string } | undefined {
  if (j.kind !== 'workflow') return undefined;
  const b = j.args.indexOf('-b');
  const file = j.args[j.args.length - 1];
  if (b >= 0 && j.args[b + 1] && file && isAbsolute(file)) {
    const rel = relative(j.root, file).split(sep).join('/');
    if (rel && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)) return { doc: rel, target: j.args[b + 1] };
  }
  const at = j.label.lastIndexOf(' › ');
  return at > 0 ? { doc: j.label.slice(0, at), target: j.label.slice(at + 3) } : undefined;
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const outputHashes = new Map<string, { size: number; mtime: number; sha: string }>();
/** A file's sha256 now (cached by size and time), or why not. */
function hashNow(root: string, rel: string): { sha: string } | { why: 'gone' | 'large' | 'unreadable' } {
  const abs = join(root, ...rel.split('/'));
  let st;
  try { st = statSync(abs); } catch { return { why: 'gone' }; }
  if (!st.isFile()) return { why: 'gone' };
  if (st.size > OUTPUT_HASH_LIMIT) return { why: 'large' };
  const kept = outputHashes.get(abs);
  if (kept && kept.size === st.size && kept.mtime === st.mtimeMs) return { sha: kept.sha };
  try {
    const h = sha(readFileSync(abs));
    outputHashes.set(abs, { size: st.size, mtime: st.mtimeMs, sha: h });
    if (outputHashes.size > 256) outputHashes.delete(outputHashes.keys().next().value!);
    return { sha: h };
  } catch { return { why: 'unreadable' }; }
}

/** A path inside the project as '/'-separated parts, or null (absolute, a URL, or one that climbs out). */
function inProject(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

const shortOf = (r: Receipt): string | undefined => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : undefined);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** The blocks of a document as runOrder reads them (a name and its needs). */
const asBlocks = (nodes: NodeInput[]): WorkflowBlock[] => nodes.map((n, i) => ({ index: n.index ?? i + 1, name: n.name, lang: n.lang ?? '', deps: n.deps, line: 0, code: n.code ?? '' }));

/** One /run job of the document, read from its record and the receipts. */
function readRun(j: JobRecord, target: string, w: WorkflowDocInput, c: ConnectContext): WorkflowRun {
  const outcome = [...c.chain].reverse().find((r) => r.kind === 'workflow' && r.job?.id === j.id);
  const pred = c.prediction?.(j.id);
  const sealed = outcome?.prediction;
  const order = pred?.order ?? (Array.isArray(sealed?.order) ? sealed!.order.filter((x): x is string => typeof x === 'string') : undefined);
  const orderFrom: WorkflowRun['orderFrom'] = pred ? 'prediction' : order ? 'sealed' : 'document';
  const steps = j.steps;
  const runOrderNow = order ?? runOrder(asBlocks(w.blocks), target).order;
  const live = !j.stale && !TERMINAL.has(j.state);
  const word = j.stale ? 'interrupted' : j.state === 'cancelled' ? 'stopped' : j.state === 'queued' ? 'starting' : j.state === 'ready' ? 'running' : j.state;
  const names = [...runOrderNow, ...steps.map((s) => s.name).filter((n) => !runOrderNow.includes(n))];
  const blocks = names.map((name) => {
    let at = -1;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].name === name) { at = i; break; }
    const s = at >= 0 ? steps[at] : undefined;
    const ms = at >= 0 ? c.clock?.ms(j.id, at) : undefined;
    let nw: NodeWord;
    if (!s) nw = live ? 'waiting' : 'not run';
    else if (s.state !== 'running') nw = s.state;
    else nw = live ? 'running' : j.stale ? 'interrupted' : j.state === 'cancelled' ? 'stopped' : 'unknown';
    return { name, word: nw, ...(s?.code !== undefined ? { code: s.code } : {}), ...(ms !== undefined ? { ms } : {}) };
  });
  const files = (outcome?.outputs ?? []).flatMap((o) => { const rel = inProject(o.path); return rel ? [{ rel, sealed: typeof o.sha256 === 'string' ? o.sha256 : undefined }] : []; });
  const outputs = files.slice(0, OUTPUTS_SHOWN).map((f) => {
    const now = hashNow(c.root, f.rel);
    const note = 'sha' in now
      ? (f.sealed === undefined ? 'there now (the outcome sealed no sha256 for it)' : now.sha === f.sealed ? 'as the run wrote it' : 'changed since the run')
      : now.why === 'gone' ? 'not there now' : now.why === 'large' ? 'there now (larger than 8 MB: not compared)' : 'there now, but unreadable';
    return { rel: f.rel, note };
  });
  // The prediction receipt sealed before the run: the document's sha256 then.
  const predId = pred?.receipt ?? (typeof sealed?.receipt === 'string' ? sealed.receipt : undefined);
  const predReceipt = predId ? c.chain.find((r) => r.kind === 'predict' && shortOf(r) === predId) : undefined;
  const docSha = predReceipt?.files?.find((f) => f.path === w.rel)?.sha256;
  const ended = j.endedAt ? Date.parse(j.endedAt) : Number.NaN;
  const began = Date.parse(j.startedAt);
  return {
    job: j.id, target, order: runOrderNow, orderFrom, word, stoppable: live && (c.mine?.(j.id) ?? false), foreign: !(c.mine?.(j.id) ?? false),
    startedAt: j.startedAt, ...(j.endedAt ? { endedAt: j.endedAt } : {}), ...(Number.isFinite(ended) && Number.isFinite(began) ? { ms: Math.max(0, ended - began) } : {}),
    ...(j.error ? { error: j.error } : {}), ...(j.receipt ? { receipt: j.receipt } : {}),
    ...(typeof sealed?.met === 'boolean' ? { met: sealed.met } : {}), ...(predId ? { predicted: predId } : {}),
    blocks, ...(j.stale ? { interruptedAt: blocks.find((b) => b.word === 'interrupted')?.name } : {}),
    outputs, outputsMore: Math.max(0, files.length - OUTPUTS_SHOWN), ...(docSha ? { docSha256: docSha } : {}),
  };
}

const seconds = (ms: number): string => (ms < 100 ? 'under 0.1 s' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/** A block's state in a run as a few words: exit code and own time. */
function detailOf(b: { word: NodeWord; code?: number; ms?: number }): string {
  return [b.code !== undefined ? `exit ${b.code}` : '', b.ms !== undefined ? seconds(b.ms) : ''].filter(Boolean).join(' · ');
}

/**
 * The document connected to its runs, its blocks' last results and the parameter files they name. `w` is the board's
 * view of the document (workflowForBoard); the result is the same view with `connected` set.
 */
export function connectWorkflow(w: WorkflowDocInput, c: ConnectContext): WorkflowDocInput {
  const docRuns = c.jobs.flatMap((j) => { const r = runOf(j); return r && r.doc === w.rel ? [{ j, target: r.target }] : []; }).slice(0, RUNS_READ);
  const runs = docRuns.map(({ j, target }) => readRun(j, target, w, c));
  const scadModels = c.files.filter((f) => /\.scad$/i.test(f));
  const blocks = asBlocks(w.blocks);
  // The whole commands, from the text (a document the board does not edit carries only their first lines).
  let whole: Map<number, string> | undefined;
  try { whole = w.text !== undefined ? new Map(parseWorkflow(w.text).map((b) => [b.index, b.code])) : undefined; } catch { whole = undefined; }
  const used = new Set<string>();
  const nodes = w.blocks.map((b, i): NodeView => {
    const run = runs.find((r) => r.blocks.some((x) => x.name === b.name));
    const at = run?.blocks.find((x) => x.name === b.name);
    if (run && at) used.add(run.job);
    const plan = runOrder(blocks, b.name);
    const command = b.index !== undefined ? whole?.get(b.index) : undefined;
    return {
      key: String(b.index ?? `p${i + 1}`), name: b.name, word: at?.word ?? 'not run yet', detail: at ? detailOf(at) : '', ...(run ? { run: run.job } : {}),
      ...(command !== undefined ? { command } : {}),
      order: plan.order, missing: plan.missing, ...(plan.cycle ? { cycle: plan.cycle } : {}),
      neededBy: w.blocks.filter((o) => o.deps.includes(b.name)).map((o) => o.name),
      params: paramRefs(command ?? b.code ?? '', scadModels),
    };
  });
  const latest = runs[0]?.job;
  if (latest) used.add(latest);
  const refs = nodes.flatMap((n) => n.params);
  const scad: ScadParamsView[] = [];
  for (const r of refs) {
    if (r.kind !== 'scad' || scad.some((s) => s.model === r.model) || scad.length >= 6) continue;
    const read = readScadParams(c.root, r.model);
    scad.push({
      model: r.model, path: r.path,
      file: !read.ok ? { state: 'unusable', error: read.error, ...(read.sha256 ? { sha256: read.sha256 } : {}) } : read.exists ? { state: 'ok', sha256: read.sha256, parameters: read.parameters } : { state: 'none' },
    });
  }
  let tray: ParamsCard | undefined;
  if (refs.some((r) => r.kind === 'tray')) { try { tray = c.tray?.(); } catch { tray = undefined; } }
  const have = new Set(c.files);
  let files: string[] = [];
  try { files = w.text !== undefined ? markdownLinks(w.text, w.rel).filter((f) => have.has(f)) : []; } catch { files = []; }
  return {
    ...w,
    connected: {
      nodes, runs: runs.filter((r) => used.has(r.job)), ...(latest ? { latest } : {}), ...(tray ? { tray } : {}), scad, files, ...(c.upmd !== undefined ? { upmd: c.upmd } : {}),
    },
  };
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** A node's anchor on the snapshot (its inspector's id): the document's hash and the block's key. */
export const nodeAnchor = (doc: string, key: string): string => `wfn-${sha(doc).slice(0, 10)}-${key.replace(/[^A-Za-z0-9_-]/g, '')}`;

/** The state of each block for the graph, by position: the word, the glyph, the class and the detail. */
export function graphStates(w: WorkflowDocInput): Array<{ word: string; glyph: string; cls: string; detail: string }> | undefined {
  const c = w.connected;
  if (!c) return undefined;
  return c.nodes.map((n) => ({ word: n.word, glyph: NODE_GLYPH[n.word], cls: wordClass(n.word), detail: n.detail }));
}

const runOf2 = (c: ConnectedWorkflow, id: string | undefined): WorkflowRun | undefined => (id ? c.runs.find((r) => r.job === id) : undefined);
const arrow = (order: string[]): string => order.join(' → ');
/** The runs this card's run actions stand for: what /run <doc> <block> runs, in words. */
const runWords = (n: NodeView): string => (n.order.length > 1 ? `${arrow(n.order)}` : n.name);

/** A word with its glyph, as an inline label; the class colours it, the word and glyph carry it. */
const wordHtml = (word: string, detail = ''): string => `<span class="wf-word ${wordClass(word)}"><span class="wf-glyph" aria-hidden="true">${esc(NODE_GLYPH[word as NodeWord] ?? '·')}</span> <strong>${esc(word)}</strong>${detail ? ` <span class="wf-detail">${esc(detail)}</span>` : ''}</span>`;

/**
 * The card's run bar: the document's newest run in words (running, completed, failed at a block, stopped,
 * interrupted), with Stop (the Jobs section's own Stop button, pressed for you) while this REPL's run is going.
 */
export function runBarHtml(w: WorkflowDocInput, k: Kit): string {
  const c = w.connected;
  if (!c) return '';
  const upmd = c.upmd !== false ? '' : `<p class="wf-note">${esc('upmd was not found here (UPMD_BIN, or upmd on PATH): a run says so and runs nothing. Setup: brew install rezigned/tap/upmd')}</p>`;
  const r = runOf2(c, c.latest);
  if (!r) return `<div class="wfx-run wfx-run-none"><p class="meta">${esc(`No run of ${w.rel} yet. Run up to here on a block runs it through upmd as /run ${w.rel} <block>: the prediction is sealed first, the outcome after.`)}</p>${upmd}</div>`;
  const what = `${r.target}${r.order.length > 1 ? ` (${arrow(r.order)})` : ''}`;
  const steps = r.blocks.map((b) => `${b.name} ${b.word}`).join(', ');
  const failedAt = r.blocks.find((b) => b.word === 'failed');
  const when = `started ${stamp(r.startedAt)}${r.endedAt ? `, ended ${stamp(r.endedAt)}` : ''}${r.ms !== undefined && r.endedAt ? ` (${seconds(r.ms)})` : ''}`;
  const head = r.word === 'interrupted' ? 'interrupted run' : r.word === 'running' || r.word === 'starting' ? 'run' : 'last run';
  const rerun = c.nodes.find((n) => n.name === r.target);
  const cls = r.word === 'interrupted' ? ' wfx-run-interrupted' : r.word === 'failed' ? ' wfx-run-failed' : r.word === 'running' || r.word === 'starting' ? ' wfx-run-live' : '';
  const lines: string[] = [];
  if (r.word === 'interrupted') {
    lines.push(`The session that ran ${r.job} ended while ${r.interruptedAt ?? 'a block'} was running; its process is gone, so how it ended is not known. upmd does not resume a run, and Timmy does not either: /run ${w.rel} ${r.target} runs it again${r.order.length > 1 ? ` from ${r.order[0]}` : ''}.`);
  } else if (r.word === 'failed') {
    lines.push(failedAt ? `${failedAt.name} failed${failedAt.code !== undefined ? ` with exit ${failedAt.code}` : ''}; upmd stopped the chain there.` : `It failed${r.error ? `: ${r.error}` : ''}.`);
  } else if (r.word === 'stopped') {
    lines.push('Stopped with /stop (or Stop) before it ended.');
  }
  const facts = [
    r.receipt ? `outcome receipt ${r.receipt}` : r.word === 'running' || r.word === 'starting' ? 'its outcome is sealed when it ends' : r.word === 'interrupted' ? 'no outcome was sealed' : '',
    r.met === undefined ? '' : r.met ? 'its sealed prediction was met' : 'its sealed prediction was missed',
    r.foreign && (r.word === 'running' || r.word === 'starting') ? 'started by another session: this REPL cannot stop it' : '',
  ].filter(Boolean).join(' · ');
  const acts = k.live
    ? [
      ...(r.stoppable ? [`<button type="button" class="act act-stop" data-wf-stop="${esc(r.job)}">Stop</button>`] : []),
      ...(r.word === 'interrupted' && rerun && !rerun.missing.length && !rerun.cycle ? [`<button type="button" class="act" data-wf-rerun="${esc(rerun.key)}">Run ${esc(r.target)} again</button>`] : []),
    ].join('')
    : '';
  const cmds = [...(r.stoppable ? [`/stop ${r.job}`] : []), ...(r.word === 'interrupted' ? [`/run ${w.rel} ${r.target}`] : []), `/jobs ${r.job}`];
  return `<div class="wfx-run${cls}" role="status"><div class="wfx-run-head"><span class="wfx-run-label">${esc(head)}</span> <strong class="wfx-run-job">${esc(r.job)}</strong> <span class="wfx-run-what">${esc(what)}</span> ${wordHtml(r.word)}</div>`
    + `<p class="meta">${esc(`${steps ? `${steps} · ` : ''}${when}`)}</p>${lines.map((l) => `<p class="wfx-run-say">${esc(l)}</p>`).join('')}`
    + `${facts ? `<p class="meta">${esc(facts)}</p>` : ''}${acts ? `<div class="wf-acts">${acts}</div>` : ''}${k.cmds(cmds)}${upmd}</div>`;
}

/** A chip for a named block, drawn in the prose where the block is: it selects (live) or leads to (snapshot) its node. */
function chipHtml(w: WorkflowDocInput, n: NodeView | undefined, block: { index: number; name: string; lang: string }, k: Kit, selected: string | undefined): string {
  const key = n?.key ?? String(block.index);
  const word = n?.word ?? 'not run yet';
  const inner = `<span class="wf-glyph" aria-hidden="true">${esc(NODE_GLYPH[word])}</span><span class="wf-chip-name">${esc(block.name)}</span>`
    + `${block.lang ? `<span class="wf-chip-lang">${esc(block.lang)}</span>` : ''}<span class="wf-chip-state">${esc(word)}</span>`;
  const label = `${block.name}${block.lang ? `, a ${block.lang} block` : ''}: ${word}`;
  if (k.live) return `<button type="button" class="wf-chip ${wordClass(word)}${key === selected ? ' wf-sel' : ''}" data-wf-select="${esc(key)}" aria-pressed="${key === selected}" aria-label="${esc(`${label}. Show it in the inspector`)}">${inner}</button>`;
  return `<a class="wf-chip ${wordClass(word)}" href="#${esc(nodeAnchor(w.rel, key))}" aria-label="${esc(`${label}. Its details`)}">${inner}</a>`;
}

/** The instructions column: the document's prose with its blocks as chips, and the Markdown as written one click away. */
export function instructionsHtml(w: WorkflowDocInput, k: Kit, selected?: string): string {
  const c = w.connected;
  const byIndex = new Map<number, NodeView>();
  w.blocks.forEach((b, i) => { if (c?.nodes[i] && b.index !== undefined) byIndex.set(b.index, c.nodes[i]); });
  const have = new Set(c?.files ?? []);
  const open = k.live ? '' : ` ${k.fileLink(w.rel, 'file')}`;
  if (w.text === undefined) {
    return `<section class="wfx-doc"><h4>${esc('instructions')}</h4><p class="meta">${esc(`The prose of ${w.rel} is not drawn here: it was not read whole, or it is larger than ${TEXT_DRAWN / 1024} KB.`)}${open}</p></section>`;
  }
  let html: string;
  try {
    html = renderMarkdown(w.text, {
      doc: w.rel,
      chip: (b) => chipHtml(w, byIndex.get(b.index), b, k, selected),
      file: (rel, text) => (k.live ? `<span class="md-a md-file" title="${esc(`a project file: /open ${rel}`)}">${text}</span>`
        : have.has(rel) ? `<a class="md-a md-file" href="${esc(fileHref(rel))}">${text}</a>` : `<span class="md-a md-nolink" title="${esc(`${rel} is not a file of the project`)}">${text}</span>`),
    });
  } catch (err) {
    html = `<p class="meta">${esc(`The prose could not be drawn: ${err instanceof Error ? err.message : String(err)}.`)}</p>`;
  }
  const source = `<details class="wfx-src" data-keep="${esc(`wf:${w.rel}:source`)}"><summary>${esc(`open ${w.rel}: the Markdown as written`)}</summary><pre class="wfx-src-text">${esc(w.text)}</pre></details>`;
  return `<section class="wfx-doc" aria-label="${esc(`the instructions of ${w.rel}`)}"><h4>${esc('instructions')}${open}</h4>${html}${source}</section>`;
}

/** The snapshot's links lead from .timmy/board/ back to the project: '../../' and the path, each part encoded. */
const fileHref = (rel: string): string => `../../${rel.split('/').map(encodeURIComponent).join('/')}`;

/** The tray card for a block, as board-cards draws it (its own form on the live board). */
function trayHtml(c: ConnectedWorkflow, k: Kit): string {
  if (!c.tray) return `<p class="meta">${esc(`${TRAY_PARAMS}: its card could not be read.`)}</p>`;
  try { return renderParamsCard(c.tray, k); } catch (err) { return `<p class="meta">${esc(`${TRAY_PARAMS}: ${err instanceof Error ? err.message : String(err)}`)}</p>`; }
}

/** An OpenSCAD value as the form shows it. */
const scadShown = (v: ScadValue): string => (typeof v === 'string' ? v : String(v));
const kindOf = (v: ScadValue): 'number' | 'boolean' | 'text' => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text');

/**
 * An OpenSCAD model's parameter file, with the scad-params checker's rules. On the live board a usable file is a form:
 * each value in its kind (a number, true or false, or text); Save sends `set-scad-params`, checked on the server.
 */
export function renderScadParams(v: ScadParamsView, k: Kit): string {
  const f = v.file;
  const state = f.state === 'ok'
    ? `<div class="status status-verified"><strong>saved</strong> ${esc(`${v.path} · sha256 ${f.sha256.slice(0, 12)} · /scad ${v.model} takes it as its defaults; name=value words override it`)}</div>`
    : f.state === 'none'
      ? `<div class="status status-none"><strong>no file</strong> ${esc(`no ${v.path} beside ${v.model}: the model runs with its own values. The board does not write a first file (Timmy cannot read a model's defaults out of its .scad reliably): make one with /edit ${v.path}, naming the values at the model's top.`)}</div>`
      : `<div class="status status-unverified"><strong>not usable</strong> ${esc(`${v.path}: ${f.error}. /scad ${v.model} refuses to start until it is fixed (/edit ${v.path}); the board does not save over it.`)}</div>`;
  const rows = f.state === 'ok' ? Object.entries(f.parameters).map(([name, value]) => {
    const kind = kindOf(value);
    const shown = scadShown(value);
    const input = !k.live ? `<span class="param-value">${esc(shown)}</span>`
      : kind === 'boolean'
        ? `<select class="param-input" data-scad-param="${esc(name)}" data-kind="boolean" data-saved="${esc(shown)}" aria-label="${esc(`${name}, true or false`)}"><option value="true"${value === true ? ' selected' : ''}>true</option><option value="false"${value === false ? ' selected' : ''}>false</option></select>`
        : `<input type="text" class="param-input" data-scad-param="${esc(name)}" data-kind="${kind}" data-saved="${esc(shown)}" value="${esc(shown)}" maxlength="${SCAD_LIMITS.text}" spellcheck="false" aria-label="${esc(`${name}, ${kind === 'number' ? 'a number' : 'text'}`)}"${kind === 'number' ? ' inputmode="decimal"' : ''}>`;
    const saved = k.live ? `<td class="saved"><span class="param-saved">${esc(shown)}</span><span class="param-change" data-param-change></span></td>` : '';
    return `<tr><th scope="row">${esc(name)}</th><td>${input}</td>${saved}<td class="help">${esc(kind === 'number' ? 'a number' : kind === 'boolean' ? 'true or false' : 'text')}</td></tr>`;
  }).join('') : '';
  const table = rows ? `<table class="param-table"><thead><tr><th scope="col">parameter</th><th scope="col">value</th>${k.live ? '<th scope="col">saved</th>' : ''}<th scope="col">kind</th></tr></thead><tbody>${rows}</tbody></table>` : '';
  const rules = `Each value is a number, true or false, or text without control characters (up to ${SCAD_LIMITS.text} characters): OpenSCAD reads each -D value as code, so Timmy writes every value itself. The board changes values only: the names and their kinds stay as the file has them.`;
  const live = k.live && f.state === 'ok'
    ? `<div class="param-actions"><button type="button" class="act" data-scad-save disabled>Save parameters</button><button type="button" class="act quiet" data-scad-discard>Discard</button></div><p class="params-msg" data-scad-msg hidden></p>`
      + `<p class="meta">${esc(`Save checks the values with these rules and keeps the previous file under .timmy/params-history/scad/; while an /iterate flow runs in this project, Save is refused.`)}</p>`
    : '';
  const data = k.live && f.state === 'ok' ? ` data-scad-params="${esc(v.model)}" data-scad-base="${esc(f.sha256)}"` : '';
  return `<article class="card wide params scad-params"${data}><div class="jobhead"><span>${f.state === 'none' ? `<span class="name">${esc(v.path)}</span>` : k.fileLink(v.path)}</span> <span class="kind">${esc('OpenSCAD parameters')}</span></div>`
    + `<div class="meta">${esc(`for ${v.model} (timmy.scad-params/1)`)}</div>${state}${table}<p class="meta">${esc(rules)}</p>${live}`
    + `${k.cmds([`/scad ${v.model}`, ...(f.state === 'none' ? [`/edit ${v.path}`] : [`/open ${v.path}`])])}</article>`;
}

/** What a node's last result is, in words: its state in its run, the run, the outcome receipt and the files written. */
function lastHtml(w: WorkflowDocInput, n: NodeView, c: ConnectedWorkflow, k: Kit): string {
  const r = runOf2(c, n.run);
  const at = r?.blocks.find((b) => b.name === n.name);
  if (!r || !at) {
    return `<section class="wf-last"><h4>last result</h4><p class="meta">${esc(`${n.name} has not run in any run of ${w.rel} that Timmy's job records hold.`)}</p></section>`;
  }
  const own = at.ms !== undefined ? `${seconds(at.ms)} its own time`
    : r.ms !== undefined && r.endedAt ? (r.blocks.length === 1 ? `the run took ${seconds(r.ms)} (upmd and this one block)` : `its own time was not recorded; the run took ${seconds(r.ms)} for ${r.blocks.length} blocks`) : '';
  const lead = at.word === 'running' ? `running now in ${r.job}` : at.word === 'waiting' ? `waiting in ${r.job}: it runs after ${r.blocks.slice(0, r.blocks.findIndex((b) => b.name === n.name)).map((b) => b.name).join(', ') || 'what it needs'}` : `in run ${r.job}`;
  const say = at.word === 'interrupted' ? `It was running when the session that ran ${r.job} ended; how it ended is not known. Nothing resumes it: /run ${w.rel} ${r.target} runs it again.`
    : at.word === 'not run' ? `upmd did not reach it in ${r.job}${r.blocks.some((b) => b.word === 'failed') ? ` (the chain stopped at ${r.blocks.find((b) => b.word === 'failed')!.name})` : ''}.`
      : at.word === 'unknown' ? `The run ended before upmd said how ${n.name} ended.` : '';
  const files = r.outputs.length
    ? `<ul class="rfiles">${r.outputs.map((o) => `<li>${k.fileLink(o.rel, 'file')} <span class="tier">${esc(o.note)}</span></li>`).join('')}</ul>${r.outputsMore ? `<p class="meta">${esc(`and ${r.outputsMore} more in the outcome receipt`)}</p>` : ''}`
      + `<p class="meta">${esc('The files the run wrote, from its sealed outcome; a run\'s files are not attributed to one block.')}</p>`
    : r.receipt ? `<p class="meta">${esc('Its sealed outcome names no output file.')}</p>` : '';
  const facts = [
    `${r.target}${r.order.length > 1 ? ` (${arrow(r.order)})` : ''}`, `started ${stamp(r.startedAt)}`,
    r.receipt ? `outcome receipt ${r.receipt}` : '', r.met === undefined ? '' : r.met ? 'prediction met' : 'prediction missed',
    r.docSha256 && w.sha256 && r.docSha256 !== w.sha256 ? `it ran an earlier version of ${w.rel} (sha256 ${r.docSha256.slice(0, 12)})` : '',
  ].filter(Boolean).join(' · ');
  return `<section class="wf-last"><h4>last result</h4><p class="wf-last-word">${wordHtml(at.word, [at.code !== undefined ? `exit ${at.code}` : '', own].filter(Boolean).join(' · '))}</p>`
    + `<p class="meta">${esc(`${lead}: ${facts}`)}</p>${say ? `<p class="wf-say">${esc(say)}</p>` : ''}${files}</section>`;
}

/** Run up to here and Run this block for a node, and what each runs, in words. */
function runHtml(w: WorkflowDocInput, n: NodeView, c: ConnectedWorkflow, k: Kit): string {
  const cmd = `/run ${w.rel} ${n.name}`;
  if (n.missing.length || n.cycle) {
    const why = n.cycle ? `its needs loop (${n.cycle.join(' → ')})` : `it needs ${n.missing.join(', ')}, which ${w.rel} does not define`;
    return `<section class="wf-runs"><h4>run</h4><p class="wf-say">${esc(`Not runnable as it is: ${why}. /run refuses it the same way; nothing runs.`)}</p></section>`;
  }
  const alone = n.order.length === 1;
  const say = alone
    ? `${n.name} needs nothing, so upmd runs it alone: Run this block is ${cmd}. The prediction is sealed first, the outcome after.`
    : `Run up to here is ${cmd}: upmd runs ${arrow(n.order)}, ${n.name} after the blocks it needs. The prediction is sealed first, the outcome after.`;
  const notAlone = alone ? '' : `Run this block alone is not offered: upmd runs a block after the blocks it needs, and Timmy does not run a block without them.`;
  const buttons = k.live
    ? alone
      ? k.act('Run this block', { act: 'run', doc: w.rel, block: n.name })
      : `${k.act('Run up to here', { act: 'run', doc: w.rel, block: n.name })}<button type="button" class="act quiet" disabled title="${esc(notAlone)}">Run this block</button>`
    : '';
  const live = c.runs.find((r) => r.job === c.latest && (r.word === 'running' || r.word === 'starting'));
  const busy = live && k.live ? `<p class="meta">${esc(`${live.job} is running now (${live.target}); another run starts beside it.`)}</p>` : '';
  return `<section class="wf-runs"><h4>run</h4>${buttons ? `<div class="wf-acts">${buttons}</div>` : ''}<p class="meta">${esc(say)}</p>${notAlone ? `<p class="meta">${esc(notAlone)}</p>` : ''}${busy}${k.cmds([cmd])}</section>`;
}

/** The command: editable on the live board (the existing save-workflow edit), else as text. */
function commandHtml(w: WorkflowDocInput, b: NodeInput, n: NodeView, k: Kit, editable: boolean): string {
  const code = editable ? b.code : n.command ?? b.code;
  if (code === undefined) return `<section class="wf-command"><h4>command</h4><p class="meta">${esc('Its command was not read.')}</p></section>`;
  const whole = n.command !== undefined || b.lines === undefined || b.lines <= code.split('\n').length;
  if (k.live && editable) {
    return `<section class="wf-command"><h4>command</h4><textarea class="wf-in wf-cmd wf-cmd-edit" data-wf-cmd="${esc(n.key)}" rows="${Math.min(14, Math.max(3, code.split('\n').length + 1))}" spellcheck="false" aria-label="${esc(`the command of ${n.name}`)}">${esc(code)}</textarea>`
      + `<div class="wf-acts"><button type="button" class="act" data-wf-cmd-save="${esc(n.key)}" disabled>Save command</button><button type="button" class="act quiet" data-wf-cmd-discard="${esc(n.key)}">Discard</button></div>`
      + `<p class="wf-msg" data-wf-cmd-msg="${esc(n.key)}" role="status"></p>`
      + `<p class="meta">${esc(`Save rewrites only this block of ${w.rel} (the prose around it stays; the previous version is kept under .timmy/workflow-history/); while it is not saved, Run waits.`)}</p></section>`;
  }
  const why = k.live ? `<p class="meta">${esc(`The board does not edit ${w.rel}: ${w.readOnly ?? 'its blocks were not read whole'}. /edit ${w.rel} opens your editor.`)}</p>` : '';
  return `<section class="wf-command"><h4>command</h4><pre class="wf-cmd-ro">${esc(code)}</pre>${whole ? '' : `<p class="meta">${esc(`the first lines of ${b.lines} (the rest: open ${w.rel})`)}</p>`}${why}</section>`;
}

/** The parameter files a node's command names, each with its checked card. */
function paramsHtml(n: NodeView, c: ConnectedWorkflow, k: Kit): string {
  if (!n.params.length) {
    return `<section class="wf-params"><h4>parameter files</h4><p class="meta">${esc(`Its command names no parameter file Timmy knows (${TRAY_PARAMS}, or an OpenSCAD model's <model>.params.json beside its .scad), by a plain match of the path in its text.`)}</p></section>`;
  }
  const cards = n.params.map((p) => (p.kind === 'tray' ? trayHtml(c, k) : (() => { const v = c.scad.find((s) => s.model === p.model); return v ? renderScadParams(v, k) : ''; })())).join('');
  return `<section class="wf-params"><h4>parameter files its command names</h4><p class="meta">${esc(`${n.params.map((p) => p.path).join(', ')}: found by a plain match of each file's path in the command's text. The command is not run or parsed to find them, so whether it reads them is not checked.`)}</p>${cards}</section>`;
}

/** The technical details of a node: closed by default. */
function techHtml(w: WorkflowDocInput, b: NodeInput, n: NodeView, c: ConnectedWorkflow): string {
  const r = runOf2(c, n.run);
  const rows: Array<[string, string]> = [
    ['upmd runs', `upmd --ci -b ${n.name} -d . ${w.rel} (with the project's folder and the document's full path)`],
    ['its own time', "from when Timmy saw upmd's start line for the block to its end line; known only for the runs this REPL watched"],
    ['block', `${b.index !== undefined ? `block ${b.index} of ${w.rel} (upmd numbers every fenced block, named or not)` : 'its number was not read'}`],
    ...(w.sha256 ? [['document', `sha256 ${w.sha256}`] as [string, string]] : []),
    ...(r ? [['its run', `${r.job}: order from ${r.orderFrom === 'prediction' ? "this REPL's prediction" : r.orderFrom === 'sealed' ? 'the sealed outcome' : 'the document as it is now'}${r.predicted ? ` · prediction receipt ${r.predicted}` : ''}${r.receipt ? ` · outcome receipt ${r.receipt}` : ''}`] as [string, string]] : []),
  ];
  return `<details class="wf-tech" data-keep="${esc(`wf:${w.rel}:${n.key}:tech`)}"><summary>${esc('technical details')}</summary><dl>${rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join('')}</dl></details>`;
}

/**
 * The inspector: on the live board one panel per node, the selected one shown (the page's script shows another when a
 * node or a chip is chosen); on the snapshot every node's, each in a closed <details> that its chip and node lead to.
 */
export function inspectorsHtml(w: WorkflowDocInput, k: Kit, editable: boolean, selected?: string): string {
  const c = w.connected;
  if (!c) return '';
  const panels = w.blocks.map((b, i) => {
    const n = c.nodes[i];
    if (!n) return '';
    const facts: Array<[string, string]> = [
      ['language', b.lang || 'none'],
      ['needs', b.deps.length ? b.deps.join(', ') : 'nothing'],
      ['needed by', n.neededBy.length ? n.neededBy.join(', ') : 'nothing'],
      ['runs as', n.order.length > 1 ? arrow(n.order) : `${n.name} alone`],
    ];
    const body = `<dl class="wf-facts">${facts.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join('')}</dl>`
      + commandHtml(w, b, n, k, editable) + runHtml(w, n, c, k) + lastHtml(w, n, c, k) + paramsHtml(n, c, k) + techHtml(w, b, n, c);
    const head = `<span class="wf-insp-name">${esc(n.name)}</span>${b.lang ? ` <span class="lang">${esc(b.lang)}</span>` : ''} ${wordHtml(n.word, n.detail)}`;
    if (k.live) return `<section class="wf-insp" data-wf-insp="${esc(n.key)}"${n.key === selected ? '' : ' hidden'} aria-label="${esc(`block ${n.name}`)}"><div class="wf-insp-head">${head}</div>${body}</section>`;
    // The anchor is inside the details, so following a chip or a node to it opens them (as browsers reveal a target).
    return `<details class="wf-insp"><summary><span class="wf-insp-head">${head}</span></summary><div class="wf-insp-body" id="${esc(nodeAnchor(w.rel, n.key))}">${body}</div></details>`;
  }).join('');
  const lead = k.live ? 'Select a block in the graph or in the instructions to inspect it.' : 'Every block, each in its own section: a chip or a node leads here.';
  return `<section class="wfx-insp" aria-label="${esc(`the inspector of ${w.rel}`)}"><h4>${esc(k.live ? 'inspector' : 'blocks')}</h4><p class="meta">${esc(lead)}</p>${panels}</section>`;
}

// ── the REPL's /workflows <file> ─────────────────────────────────────────────

/** `/workflows <file>`: the blocks in order with their needs and last results, the parameter files they name, the
 *  newest run, and the next commands; the same connected data as the board's card. */
export function workflowSummaryLines(w: WorkflowDocInput, o: { sep: string; link: (rel: string) => string; upmd: { version: string | null } | null; title?: string }): Line[] {
  const c = w.connected;
  const lines: Line[] = [];
  const meta = [`${w.blocks.length} named block${w.blocks.length === 1 ? '' : 's'}`, ...(w.sha256 ? [`sha256 ${w.sha256.slice(0, 12)}`] : []), o.upmd ? `upmd ${o.upmd.version ?? '(version unknown)'}` : 'upmd is not installed: brew install rezigned/tap/upmd'].join(o.sep);
  lines.push([{ text: '  ' }, { text: o.link(w.rel), role: 'strong' }, { text: `  workflow${o.sep}${meta}`, role: o.upmd ? 'secondary' : 'estimate' }]);
  if (o.title) lines.push([{ text: `  ${o.title}`, role: 'secondary' }]);
  if (!c || !w.blocks.length) return [...lines, [{ text: '  No named blocks: upmd runs blocks named like ```bash [name:build]', role: 'secondary' }]];
  const width = Math.min(18, Math.max(...w.blocks.map((b) => b.name.length)) + 1);
  for (const [i, b] of w.blocks.entries()) {
    const n = c.nodes[i];
    const needs = b.deps.length ? `needs ${b.deps.join(', ')}` : '';
    const r = runOf2(c, n.run);
    const last = r ? `${n.word}${n.detail ? ` ${n.detail}` : ''}${o.sep}${r.job}${r.endedAt ? ` ${stamp(r.endedAt)}` : ` started ${stamp(r.startedAt)}`}${r.receipt ? `${o.sep}receipt ${r.receipt}` : ''}` : 'not run yet';
    const role: Segment['role'] = n.word === 'failed' ? 'failure' : n.word === 'interrupted' || n.word === 'running' || n.word === 'stopped' ? 'estimate' : undefined;
    lines.push([{ text: `   ${String(b.index ?? '').padStart(2)} ${b.name.padEnd(width)}` }, { text: `${(b.lang ?? '').padEnd(6)}${needs ? ` ${needs}` : ''}`, role: 'secondary' }, { text: `  ${NODE_GLYPH[n.word]} `, role }, { text: last, role: role ?? 'secondary' }]);
    for (const p of n.params) {
      const v = p.kind === 'scad' ? c.scad.find((s) => s.model === p.model) : undefined;
      const said = p.kind === 'tray'
        ? c.tray ? `${Object.entries(c.tray.values).map(([k, x]) => `${k} ${x}`).join(', ')} mm${o.sep}${c.tray.file.state === 'ok' ? `saved, sha256 ${c.tray.file.sha256.slice(0, 12)}` : c.tray.file.state === 'none' ? "no file yet: the recipe's defaults" : `not usable: ${c.tray.file.error}`}` : 'its card could not be read'
        : !v ? '' : v.file.state === 'ok' ? `${Object.entries(v.file.parameters).map(([k, x]) => `${k} ${typeof x === 'string' ? JSON.stringify(x) : String(x)}`).join(', ')}${o.sep}for ${v.model}, sha256 ${v.file.sha256.slice(0, 12)}` : v.file.state === 'none' ? `no file yet beside ${v.model}` : `not usable: ${v.file.error}`;
      lines.push([{ text: `      ${p.kind === 'tray' ? 'tray parameters' : 'OpenSCAD parameters'} ` , role: 'secondary' }, { text: o.link(p.path) }, { text: `  ${said}${o.sep}found by a plain match of its path in the command`, role: 'secondary' }]);
    }
  }
  const r = runOf2(c, c.latest);
  if (r) {
    const what = `${r.target}${r.order.length > 1 ? ` (${arrow(r.order)})` : ''}`;
    const steps = r.blocks.map((b) => `${b.name} ${b.word}`).join(', ');
    const role: Segment['role'] = r.word === 'failed' ? 'failure' : r.word === 'interrupted' ? 'estimate' : 'strong';
    const label = r.word === 'interrupted' ? '  Interrupted ' : r.word === 'running' || r.word === 'starting' ? '  Running   ' : '  Last run  ';
    lines.push([{ text: label, role: 'secondary' }, { text: r.job, role: 'strong' }, { text: `  ${what}${o.sep}`, role: 'secondary' }, { text: r.word, role }, { text: `${o.sep}${steps}${r.ms !== undefined && r.endedAt ? `${o.sep}${seconds(r.ms)}` : ''}${r.receipt ? `${o.sep}outcome receipt ${r.receipt}` : ''}${r.met === undefined ? '' : r.met ? `${o.sep}prediction met` : `${o.sep}prediction missed`}`, role: 'secondary' }]);
    if (r.word === 'interrupted') lines.push([{ text: `             its session ended while ${r.interruptedAt ?? 'a block'} ran; its process is gone. Nothing resumes it: /run ${w.rel} ${r.target} runs it again.`, role: 'estimate' }]);
    if (r.outputs.length) lines.push([{ text: '             wrote ', role: 'secondary' }, ...r.outputs.flatMap((f, i): Segment[] => [...(i ? [{ text: ', ', role: 'secondary' as const }] : []), { text: o.link(f.rel) }, { text: ` (${f.note})`, role: 'secondary' }]), ...(r.outputsMore ? [{ text: ` and ${r.outputsMore} more`, role: 'secondary' as const }] : [])]);
  }
  // The next commands: each block nothing needs (its run covers what it needs), a stop, the board.
  const leaves = c.nodes.filter((n) => !n.neededBy.length && !n.missing.length && !n.cycle).slice(0, 4);
  const next: string[] = [
    ...(r?.stoppable ? [`/stop ${r.job}`] : []),
    ...leaves.map((n) => `/run ${w.rel} ${n.name}${n.order.length > 1 ? `  (${arrow(n.order)})` : ''}`),
    '/board live', `/open ${w.rel}`,
  ];
  lines.push([{ text: '  Next      ', role: 'secondary' }, { text: next[0], role: 'strong' }]);
  for (const n of next.slice(1)) lines.push([{ text: '            ' }, { text: n, role: 'strong' }]);
  return lines;
}

// ── the live page's part ─────────────────────────────────────────────────────

/**
 * The connected card's part of the live page's editor script (src/repl/board-edits.ts EDIT_SCRIPT inlines it, inside its
 * closure, so it shares `api`, `out` and `unreachable`; it never sees the token):
 * - a node in the graph or a chip in the instructions selects its block: the inspector shows that block's panel, and the
 *   node and its chips are marked (aria-pressed and a class). The choice is kept in this page's memory only, and put back
 *   after the live board draws its sections again (a MutationObserver on #main);
 * - the inspector's command: while it differs from the saved one the card is marked data-editing (the live board does
 *   not draw over it) and Run waits; Save sends the existing `save-workflow` edit with every block as the card read it
 *   and this one command changed; Discard puts the saved command back;
 * - an OpenSCAD parameter form: each value typed by its kind; Save sends `set-scad-params`;
 * - the run bar's Stop presses the Jobs section's own Stop for that job (the existing /stop path), and Run again presses
 *   the block's own Run; nothing here sends an action itself.
 * Every element it changes is the server's; text is set with textContent. Nothing is stored outside the page's memory.
 */
export const WORKFLOW_SCRIPT = `
  /* ── R4 (H47): the connected workflow card ── */
  var wfSel = Object.create(null);
  var wfCard = function (t) { return t && t.closest ? t.closest('[data-wfx]') : null; };
  var wfKey = function (el) { return el.getAttribute('data-wf-node') || el.getAttribute('data-wf-select'); };
  var wfBy = function (root, attr, key) {
    var all = root.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute(attr) === key) return all[i];
    return null;
  };
  var wfSelect = function (card, key) {
    var panels = card.querySelectorAll('[data-wf-insp]');
    if (!wfBy(card, 'data-wf-insp', key)) return false;
    for (var i = 0; i < panels.length; i++) panels[i].hidden = panels[i].getAttribute('data-wf-insp') !== key;
    var marks = card.querySelectorAll('[data-wf-node], [data-wf-select]');
    for (var k = 0; k < marks.length; k++) {
      var on = wfKey(marks[k]) === key;
      marks[k].setAttribute('aria-pressed', on ? 'true' : 'false');
      if (marks[k].classList) marks[k].classList[on ? 'add' : 'remove']('wf-sel');
    }
    wfSel[card.getAttribute('data-wfx')] = key;
    return true;
  };
  /* The shown panel, scrolled into view when a chip chose it and it is out of sight. */
  var wfReveal = function (card) {
    var panels = card.querySelectorAll('[data-wf-insp]');
    for (var i = 0; i < panels.length; i++) {
      if (panels[i].hidden || !panels[i].getBoundingClientRect || !panels[i].scrollIntoView) continue;
      var r = panels[i].getBoundingClientRect();
      if (r.top < 0 || r.top > (window.innerHeight || 0) - 60) panels[i].scrollIntoView({ block: 'start' });
    }
  };
  /* Run waits while anything in the card is not saved: a command, parameters, the block editor. */
  var wfGuard = function (card) {
    var dirty = card.hasAttribute('data-editing') || !!card.querySelector('[data-editing]') || !!card.querySelector('[data-wf-cmd-dirty]');
    var runs = card.querySelectorAll('button[data-act="run"], button[data-wf-rerun]');
    for (var i = 0; i < runs.length; i++) {
      if (dirty && !runs[i].hasAttribute('data-wf-held')) { runs[i].disabled = true; runs[i].setAttribute('data-wf-held', ''); runs[i].title = 'Save first: Run uses the saved files'; }
      else if (!dirty && runs[i].hasAttribute('data-wf-held')) { runs[i].disabled = false; runs[i].removeAttribute('data-wf-held'); runs[i].title = ''; }
    }
  };
  var wfGuardOf = function (el) { var c = wfCard(el); if (c) wfGuard(c); };
  var wfRestore = function () {
    var cards = document.querySelectorAll('[data-wfx]');
    for (var i = 0; i < cards.length; i++) {
      var k = wfSel[cards[i].getAttribute('data-wfx')];
      if (k !== undefined) wfSelect(cards[i], k);
      wfGuard(cards[i]);
    }
  };
  var wfMain = document.getElementById ? document.getElementById('main') : null;
  if (wfMain && typeof MutationObserver === 'function') new MutationObserver(wfRestore).observe(wfMain, { childList: true });
  /* The block editor open: the inspector's commands are read-only meanwhile. */
  var wfEditing = function (card, on) {
    var tas = card.querySelectorAll('[data-wf-cmd]');
    for (var i = 0; i < tas.length; i++) tas[i].readOnly = !!on;
    wfGuard(card);
  };

  /* the inspector's command */
  var wfCmdMsg = function (card, key, text, bad) { var m = wfBy(card, 'data-wf-cmd-msg', key); if (m) { m.textContent = text; m.className = 'wf-msg' + (bad ? ' bad' : ''); } };
  var wfCmdInput = function (ta, quiet) {
    var card = wfCard(ta);
    if (!card) return;
    var key = ta.getAttribute('data-wf-cmd');
    var dirty = ta.value !== ta.defaultValue;
    if (dirty) ta.setAttribute('data-wf-cmd-dirty', ''); else ta.removeAttribute('data-wf-cmd-dirty');
    var save = wfBy(card, 'data-wf-cmd-save', key);
    if (save) save.disabled = !dirty;
    var any = !!card.querySelector('[data-wf-cmd-dirty]');
    if (any) card.setAttribute('data-editing', ''); else if (!card.timmyModel) card.removeAttribute('data-editing');
    var edit = card.querySelector('[data-wf-edit]');
    if (edit) edit.disabled = any;
    if (!quiet) wfCmdMsg(card, key, dirty ? 'Not saved yet: Save command rewrites this block; Run uses the saved document.' : '', false);
    wfGuard(card);
  };
  var wfCmdSave = function (card, key, b) {
    var ta = wfBy(card, 'data-wf-cmd', key);
    if (!ta || !api) return;
    var data;
    try { data = JSON.parse(card.getAttribute('data-wf') || '[]'); } catch (e) { return; }
    var body = { action: 'save-workflow', doc: card.getAttribute('data-wf-doc'), sha256: card.getAttribute('data-wf-sha'), blocks: data.map(function (n) {
      return { from: n.index, name: n.name, lang: n.lang, needs: n.deps, command: String(n.index) === key ? ta.value : n.code };
    }) };
    b.disabled = true;
    wfCmdMsg(card, key, 'Saving…', false);
    api.send(body).then(function (x) {
      if (x.ok) { ta.defaultValue = ta.value; wfCmdInput(ta, true); wfCmdMsg(card, key, x.t, false); out(x.t, false); api.refresh(); }
      else { b.disabled = false; wfCmdMsg(card, key, x.t, true); }
    }, function () { b.disabled = false; wfCmdMsg(card, key, unreachable, true); });
  };

  /* an OpenSCAD parameter form */
  var WF_NUMBER = /^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$/;
  var wfScadMsg = function (p, text, bad) { var e = p.querySelector('[data-scad-msg]'); if (!e) return; e.hidden = !text; e.textContent = text; e.className = 'params-msg' + (bad ? ' bad' : ''); };
  var wfScadMark = function (p) {
    var fields = p.querySelectorAll('[data-scad-param]');
    var changed = 0;
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var v = String(f.value), saved = f.getAttribute('data-saved') || '';
      var differs = f.getAttribute('data-kind') === 'number' && WF_NUMBER.test(v.trim()) && WF_NUMBER.test(saved.trim()) ? Number(v) !== Number(saved) : v !== saved;
      if (differs) changed++;
      var row = f.closest('tr');
      if (!row) continue;
      if (differs) row.setAttribute('data-edited', ''); else row.removeAttribute('data-edited');
      var c = row.querySelector('[data-param-change]');
      if (c) c.textContent = differs ? ' → ' + (v === '' ? '(empty)' : v) : '';
    }
    var save = p.querySelector('[data-scad-save]');
    if (save) save.disabled = !changed;
    if (changed) p.setAttribute('data-editing', ''); else p.removeAttribute('data-editing');
    wfGuardOf(p);
    return changed;
  };
  var wfScadSave = function (p, b) {
    if (!api) return;
    var values = {};
    var fields = p.querySelectorAll('[data-scad-param]');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], kind = f.getAttribute('data-kind'), v = String(f.value);
      values[f.getAttribute('data-scad-param')] = kind === 'number' ? (WF_NUMBER.test(v.trim()) ? Number(v) : v) : kind === 'boolean' ? (v === 'true' ? true : v === 'false' ? false : v) : v;
    }
    b.disabled = true;
    wfScadMsg(p, 'Saving…', false);
    api.send({ action: 'set-scad-params', model: p.getAttribute('data-scad-params'), base: p.getAttribute('data-scad-base'), parameters: values }).then(function (x) {
      if (x.ok) { for (var j = 0; j < fields.length; j++) fields[j].setAttribute('data-saved', String(fields[j].value)); wfScadMark(p); wfScadMsg(p, x.t, false); out(x.t, false); api.refresh(); }
      else { wfScadMark(p); wfScadMsg(p, x.t, true); }
    }, function () { wfScadMark(p); wfScadMsg(p, unreachable, true); });
  };

  /* the run bar: Stop and Run again press the board's own buttons */
  var wfProxy = function (card, b) {
    var target = null;
    if (b.hasAttribute('data-wf-stop')) {
      var job = b.getAttribute('data-wf-stop');
      var stops = document.querySelectorAll('[data-job-card] button[data-act="stop"]');
      for (var i = 0; i < stops.length; i++) if (stops[i].getAttribute('data-job') === job) target = stops[i];
      if (!target || target.hidden) { out(job + ' has no Stop on this board now (it may have ended): /stop ' + job + ' in Timmy stops it if it still runs.', true); return; }
    } else {
      var panel = card ? wfBy(card, 'data-wf-insp', b.getAttribute('data-wf-rerun')) : null;
      target = panel ? panel.querySelector('button[data-act="run"]') : null;
      if (!target) { out('That block has no Run on this board now.', true); return; }
    }
    if (!target.disabled) target.click();
  };

  /* a click the connected card takes: true when it was its */
  var wfClick = function (t) {
    var sel = t.closest('[data-wf-node], [data-wf-select]');
    if (sel) { var sc = wfCard(sel); if (sc && wfSelect(sc, wfKey(sel)) && sel.hasAttribute('data-wf-select')) wfReveal(sc); return true; }
    var b = t.closest('button');
    if (!b || b.disabled) return false;
    var card = wfCard(b);
    if (b.hasAttribute('data-wf-stop') || b.hasAttribute('data-wf-rerun')) { wfProxy(card, b); return true; }
    if (card && b.hasAttribute('data-wf-cmd-save')) { wfCmdSave(card, b.getAttribute('data-wf-cmd-save'), b); return true; }
    if (card && b.hasAttribute('data-wf-cmd-discard')) {
      var ta = wfBy(card, 'data-wf-cmd', b.getAttribute('data-wf-cmd-discard'));
      if (ta && !ta.readOnly) { ta.value = ta.defaultValue; wfCmdInput(ta); }
      return true;
    }
    var p = b.closest('[data-scad-params]');
    if (p && b.hasAttribute('data-scad-save')) { wfScadSave(p, b); return true; }
    if (p && b.hasAttribute('data-scad-discard')) {
      var fields = p.querySelectorAll('[data-scad-param]');
      for (var i = 0; i < fields.length; i++) fields[i].value = fields[i].getAttribute('data-saved') || '';
      wfScadMark(p); wfScadMsg(p, '', false);
      if (api) api.refresh();
      return true;
    }
    return false;
  };
  /* an input the connected card takes: true when it was its */
  var wfInput = function (t) {
    if (t.hasAttribute('data-wf-cmd')) { wfCmdInput(t); return true; }
    if (t.hasAttribute('data-scad-param')) {
      var p = t.closest('[data-scad-params]');
      if (p) wfScadMsg(p, wfScadMark(p) ? 'Not saved yet: Save checks these values and keeps the previous file; a run reads the saved file.' : '', false);
      return true;
    }
    return false;
  };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var n = e.target && e.target.closest ? e.target.closest('[data-wf-node]') : null;
    if (!n) return;
    e.preventDefault();
    var c = wfCard(n);
    if (c) wfSelect(c, wfKey(n));
  });
`;

// ── the look ─────────────────────────────────────────────────────────────────

export const WORKFLOWS_CSS = `
.grid > .card.wfx { grid-column: 1 / -1; }
.wfx .wfx-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.wfx .wfx-doc, .wfx .wfx-insp { min-width: 0; display: flex; flex-direction: column; gap: 6px; border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 8px 10px; background: ${HOMEBREW.ground}; }
.wfx .wfx-doc { position: sticky; top: 8px; max-height: calc(100vh - 16px); overflow: auto; }
.wfx h4 { margin: 4px 0 2px; }
.wfx h4 .file { text-transform: none; letter-spacing: 0; font-size: ${TYPE.size.small}px; margin-left: 8px; }
.wfx .wf-graph-cap { margin: 0; }
.wfx-run { border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.wfx-run p { margin: 0; }
.wfx-run-live { border-color: ${HOMEBREW.attention}; }
.wfx-run-failed { border-color: ${HOMEBREW.failure}; }
.wfx-run-interrupted { border-color: ${HOMEBREW.attention}; border-style: dashed; }
.wfx-run-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.wfx-run-label { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.wfx-run-say, .wf-say { font-size: ${TYPE.size.small}px; color: ${HOMEBREW.text}; overflow-wrap: anywhere; margin: 0; }
.wf-note { color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; margin: 0; }
.wf-acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wf-acts .act[disabled] { opacity: .5; cursor: not-allowed; }
.act.act-stop { color: ${HOMEBREW.text}; background: ${HOMEBREW.raised}; border-color: ${HOMEBREW.failure}; }
.wf-word { font-size: ${TYPE.size.small}px; white-space: nowrap; }
.wf-word strong { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
.wf-word .wf-detail { color: ${HOMEBREW.textSecondary}; white-space: normal; }
.wf-glyph { display: inline-block; min-width: 1em; text-align: center; font-weight: ${TYPE.weight.strong}; }
.wfs-completed { color: ${HOMEBREW.text}; }
.wfs-running, .wfs-stopped, .wfs-interrupted { color: ${HOMEBREW.attention}; }
.wfs-failed { color: ${HOMEBREW.failure}; }
.wfs-waiting, .wfs-notrun, .wfs-notrunyet, .wfs-unknown { color: ${HOMEBREW.textSecondary}; }
.md { font-size: ${TYPE.size.body}px; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 6px; }
.md .md-h { margin: 6px 0 0; text-transform: none; letter-spacing: 0; color: ${HOMEBREW.text}; font-weight: ${TYPE.weight.heading}; }
.md .md-h1 { font-size: 16px; }
.md .md-h2 { font-size: 15px; }
.md .md-h3, .md .md-h4, .md .md-h5, .md .md-h6 { font-size: ${TYPE.size.body}px; }
.md .md-p, .md .md-raw { margin: 0; }
.md .md-raw { white-space: pre-wrap; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; }
.md .md-list { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 3px; }
.md .md-quote { margin: 0; border-left: 3px solid ${HOMEBREW.lineStrong}; padding: 2px 0 2px 10px; color: ${HOMEBREW.textSecondary}; }
.md .md-hr { border: 0; border-top: 1px solid ${HOMEBREW.line}; margin: 4px 0; width: 100%; }
.md .md-code, .wfx-src-text, .wf-cmd-ro { margin: 0; white-space: pre; overflow-x: auto; background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-radius: 4px; padding: 6px 8px; font: inherit; font-size: ${TYPE.size.small}px; }
.md .md-lang { float: right; color: ${HOMEBREW.textSecondary}; font-size: 11px; margin-left: 8px; }
.md .md-c { background: ${HOMEBREW.raised}; border-radius: 3px; padding: 0 3px; font: inherit; font-size: ${TYPE.size.small}px; }
.md .md-more { margin: 0; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; font-style: italic; }
.md .md-a.md-web, .md .md-a.md-file { color: ${HOMEBREW.link}; }
.md span.md-a.md-file { text-decoration: underline dotted; }
.md .md-nolink { text-decoration: underline dotted ${HOMEBREW.lineStrong}; }
.wf-chip { font: inherit; font-size: ${TYPE.size.small}px; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: 2px 0; padding: 3px 10px; background: ${HOMEBREW.raised}; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 999px; cursor: pointer; text-decoration: none; text-align: left; align-self: flex-start; }
.wf-chip .wf-chip-name { color: ${HOMEBREW.text}; font-weight: ${TYPE.weight.strong}; overflow-wrap: anywhere; }
.wf-chip .wf-chip-lang { color: ${HOMEBREW.textSecondary}; font-size: 11px; }
.wf-chip .wf-chip-state { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.wf-chip:hover, .wf-chip:focus-visible { border-color: ${HOMEBREW.accent}; outline: none; }
.wf-chip.wf-sel { border-color: ${HOMEBREW.accent}; box-shadow: 0 0 0 1px ${HOMEBREW.accent}; }
.wf-insp { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wf-insp[hidden] { display: none; }
details.wf-insp { border-top: 1px solid ${HOMEBREW.line}; padding-top: 6px; }
details.wf-insp > summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
details.wf-insp > summary::-webkit-details-marker { display: none; }
details.wf-insp > summary::before { content: "▸"; color: ${HOMEBREW.textSecondary}; }
details.wf-insp[open] > summary::before { content: "▾"; }
details.wf-insp > summary:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; }
.wf-insp-body { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 4px; scroll-margin-top: 48px; }
.wf-insp-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.wf-insp-name { font-weight: ${TYPE.weight.heading}; font-size: 15px; color: ${HOMEBREW.text}; }
.wf-insp section { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wf-insp section p { margin: 0; }
dl.wf-facts { font-size: ${TYPE.size.small}px; }
.wf-cmd-edit { min-height: 4.5em; }
.wf-msg { margin: 0; font-size: ${TYPE.size.small}px; white-space: pre-wrap; overflow-wrap: anywhere; }
.wf-msg.bad { color: ${HOMEBREW.failure}; }
.wf-insp .card.params { background: ${HOMEBREW.surface}; }
.wf-tech { border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 0 8px; }
.wf-tech > summary, .wfx-src > summary { cursor: pointer; padding: 4px 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; text-transform: uppercase; letter-spacing: .06em; }
.wf-tech > summary:focus-visible, .wfx-src > summary:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; }
.wf-tech dl { margin: 0 0 8px; }
.wfx-src-text { max-height: 420px; overflow: auto; }
.wf-node { cursor: pointer; }
.wf-node:focus { outline: none; }
.wf-node:focus-visible .wf-box, .wf-node:hover .wf-box { stroke: ${HOMEBREW.accent}; }
.wf-node.wf-sel .wf-box { stroke: ${HOMEBREW.accent}; stroke-width: 2.5; }
.wf-state { font-size: 11px; font-weight: ${TYPE.weight.strong}; letter-spacing: .03em; }
.wf-state.wfs-completed { fill: ${HOMEBREW.text}; }
.wf-state.wfs-running, .wf-state.wfs-stopped, .wf-state.wfs-interrupted { fill: ${HOMEBREW.attention}; }
.wf-state.wfs-failed { fill: ${HOMEBREW.failure}; }
.wf-state.wfs-waiting, .wf-state.wfs-notrun, .wf-state.wfs-notrunyet, .wf-state.wfs-unknown { fill: ${HOMEBREW.textSecondary}; }
.wf-box.wfs-running, .wf-box.wfs-interrupted, .wf-box.wfs-stopped { stroke: ${HOMEBREW.attention}; }
.wf-box.wfs-failed { stroke: ${HOMEBREW.failure}; }
.wf-box.wfs-waiting { stroke-dasharray: 5 3; }
.wf-box.wfs-notrun { stroke-dasharray: 2 3; }
@media (max-width: 860px) { .wfx .wfx-cols { grid-template-columns: minmax(0, 1fr); } .wfx .wfx-doc { position: static; max-height: none; } }
`;
