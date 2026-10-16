/**
 * R5 (H134): the body of tab 5, VoxVision (src/contracts/workspace.ts TABS: "every 2D and 3D vision tool with its observed
 * status, and this project's observations"), laid out as the operator's references 04, 05, 15 and 16 lay theirs out, in
 * words (a terminal draws no image):
 *
 *   PIPELINE   what this computer can run, in order: .intent → each VoxVision tool found here → .receipt; then the tools
 *              that need setup, each marked "needs setup" (its step is under it in TOOLS)
 *   TOOLS      the VoxVision family's capability rows (src/capabilities, the rows /tools and the old view read: src/workbench
 *              nav.ts FAMILY_ROWS), each with its rung; one that needs setup with its step
 *   RECORDS    the project's VoxVision records (results/vox/v*.json, timmy.vox/1), newest first: the action, when, the tools
 *              it used or needed, its status, and whether a vox receipt sealed exactly its bytes (src/repl/board-vox.ts
 *              readVoxRecord, the board's own reading)
 *   DETAIL     the selected record: its values, a model's claims and what failed; its receipt, "✓ verified" only when
 *              verifyReceiptIn passes in this reading; the operator's verdict (not recorded: timmy.vox/1 keeps none); and that
 *              images, depth, voxels and 3D are drawn by Rerun's viewer (/vox view) or the companion (c), never here
 *
 * R6 (H143): the same record the companion's tab 5 draws (src/vox/preview.ts, the page's own reading of it), in words: its
 * ENTITIES (what was measured over its images, each with its provenance and evidence state), its FRAMES (a video's sampled
 * times, each with what was measured there) and its FILES (each image, shown in the companion or why not; a mesh, drawn
 * there as three views; a recording); the companion draws them (c: Companion · Show, tab 5, voxCompanionHint for the
 * address); no Timmy surface draws depth or voxels; Rerun's own viewer shows the files where it is installed.
 *
 * From 120 columns the three sit side by side under the pipeline, below that they stack (the selected record's detail under
 * it). readVox reads files only: no tool runs, no viewer opens, nothing is asked over the network.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityRow } from '../capabilities/index.js';
import { humanBytes, projectId } from '../project/index.js';
import { readVoxRecord, type VoxCard, type VoxCardMetric } from '../repl/board-vox.js';
import { scrubHomes } from '../utils/home-scrub.js';
import type { Receipt } from '../utils/receipts.js';
import { LATER_LAYERS } from '../vox/layers.js';
import { VOX_DIR, VOX_ID } from '../vox/record.js';
import { valueWords } from '../vox/tools.js';
import { previewOfCard, type VoxPreview } from '../vox/preview.js';
import type { Glyphs } from './frame.js';
import type { Lazy } from './model.js';
import { FAMILY_ROWS } from './nav.js';
import {
  clipRows, fieldRows, heading, limitRows, onBar, para, rowsOf, S, selectedIn, sideBySide, sideBySideAt, RULE_CELLS, widths, windowMarked, type TabCtx, type TabView,
} from './tab-columns.js';
import {
  capDetail, capItem, capRows, checkReceipt, chips, inViewRows, lazyRows, notHere, verdictSegs, type CapItem, type ReceiptVerdict,
} from './tab-parts.js';
import { clock, fit, lineCells, spread, type Line, type Role, type Seg } from './text.js';

type Env = Record<string, string | undefined>;

/** The Workbench list the tab's selection is kept in (src/workbench/screen.ts: `center:<workspace>`). */
export const VOX_LIST = 'center:voxvision';
/** How many records are read (the newest). */
export const VOX_SHOWN = 24;
/** The command that makes the first record (src/repl/commands.ts: /inspect, a VoxVision action). */
export const INSPECT_COMMAND = '/inspect <file>';

// ── the reading ────────────────────────────────────────────────────────────────

/** A record as this reading found it. */
export interface VoxRow {
  /** the board's reading of the record (src/repl/board-vox.ts readVoxRecord): its strings with the project as "." and
   *  home folders as "~"; its check says whether a vox receipt sealed exactly these bytes and its inputs are unchanged */
  card: VoxCard;
  /** the operation (one request) it was made in, when the record names one */
  operation?: string;
  /** when it was made (its made_at, else the file's time), in ms */
  at: number;
  /** the newest vox receipt of this project that names the record (the action's, or a /vox view's since) */
  seal?: { hash: string; seq: number; ts: string; status: string };
  /** how many vox receipts of this project name it */
  seals: number;
  /** R6 (H143): the record as the companion's tab 5 draws it (src/vox/preview.ts), light: no mesh drawn here; absent when it
   *  could not be made */
  preview?: VoxPreview;
}

export interface VoxData {
  /** when this reading was made (ISO) */
  at: string;
  root: string;
  rows: VoxRow[];
  /** records not read (older than the newest VOX_SHOWN) */
  more: number;
  /** files in results/vox that are not a VoxVision record Timmy can read, each with why */
  unreadable: Array<{ file: string; why: string }>;
  /** the chain read (the caller's), and each receipt checked in this reading (verifyReceiptIn, asked when shown) */
  receipts: readonly Receipt[];
  checks: Map<string, ReceiptVerdict>;
}

export interface VoxReadInput {
  /** the project's folder (its records in results/vox) */
  root: string;
  /** the runs chain as the caller read it (src/workbench/state.ts chainOf: TIMMY_STORE, else the project's own store) */
  chain: readonly Receipt[];
  /** for the home folders shown as "~" */
  env?: Env;
  now?: number;
}

/** Every string of a value with the project as "." and home folders as "~" (a record keeps what its tools printed). */
function scrubDeep<T>(v: T, scrub: (t: string) => string): T {
  if (typeof v === 'string') return scrub(v) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, scrub)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, scrub)])) as T;
  return v;
}

/** The tab's reading: the project's newest VoxVision records, each checked against the chain the caller read. Files only. */
export function readVox(i: VoxReadInput): VoxData {
  const env = i.env ?? process.env;
  const root = i.root;
  const scrub = (t: string): string => scrubHomes(t.split(root).join('.'), env as NodeJS.ProcessEnv);
  const pid = projectId(root);
  const dir = join(root, VOX_DIR);
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && VOX_ID.test(n.slice(0, -5))); } catch { names = []; }
  const timed = names.map((n) => { let t = 0; try { t = statSync(join(dir, n)).mtimeMs; } catch { t = 0; } return { n, t }; }).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  const rows: VoxRow[] = [];
  const unreadable: VoxData['unreadable'] = [];
  for (const { n, t } of timed.slice(0, VOX_SHOWN)) {
    const file = `${VOX_DIR}/${n}`;
    let bytes: Buffer;
    try {
      const st = lstatSync(join(dir, n));
      if (st.isSymbolicLink() || !st.isFile()) { unreadable.push({ file, why: 'it is not a plain file' }); continue; }
      if (st.size > 1024 * 1024) { unreadable.push({ file, why: 'it is larger than 1 MB' }); continue; }
      bytes = readFileSync(join(dir, n));
    } catch (e) { unreadable.push({ file, why: `it could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }); continue; }
    const text = bytes.toString('utf8');
    const card = readVoxRecord({ root, file, text, fileSha256: createHash('sha256').update(bytes).digest('hex'), chain: i.chain, projectId: pid });
    if (!card) { unreadable.push({ file, why: 'it is not a VoxVision record (timmy.vox/1) Timmy can read' }); continue; }
    let operation: string | undefined;
    let raw: Record<string, unknown> = {};
    try { raw = JSON.parse(text) as Record<string, unknown>; const o = raw.operation; if (typeof o === 'string' && o) operation = o; } catch { /* read above */ }
    let seal: VoxRow['seal'];
    let seals = 0;
    for (let k = i.chain.length - 1; k >= 0; k--) {
      const r = i.chain[k];
      if (r.kind !== 'vox' || r.project_id !== pid || r.outputs?.[0]?.path !== file) continue;
      seals += 1;
      seal ??= { hash: r.hash, seq: k + 1, ts: r.ts, status: r.status ?? 'unknown' };
    }
    const made = Date.parse(card.madeAt ?? '');
    const shown = scrubDeep(card, scrub);
    let preview: VoxPreview | undefined;
    try { preview = previewOfCard({ root, chain: i.chain, env: env as NodeJS.ProcessEnv }, shown, raw, operation); } catch { preview = undefined; }
    rows.push({ card: shown, ...(operation ? { operation } : {}), at: Number.isFinite(made) ? made : t, ...(seal ? { seal } : {}), seals, ...(preview ? { preview } : {}) });
  }
  rows.sort((a, b) => b.at - a.at);
  return { at: new Date(i.now ?? Date.now()).toISOString(), root, rows, more: Math.max(0, timed.length - VOX_SHOWN), unreadable, receipts: i.chain, checks: new Map() };
}

/** Whether a record's receipt verifies in this reading (verifyReceiptIn), asked the first time it is shown. */
export const voxReceiptVerdict = (d: VoxData, hash: string): ReceiptVerdict => checkReceipt(d.receipts, d.checks, hash);

// ── the items ──────────────────────────────────────────────────────────────────

/** The tab's selectable rows: a record (first, newest first), then a tool (the Inspector's own `cap` case details it). */
export type VoxItem = { kind: 'vox-record'; key: string; row: VoxRow } | CapItem;

export const voxItemName = (item: VoxItem): string => (item.kind === 'vox-record' ? `VoxVision record ${item.row.card.id}` : item.row.name.trim());
export const voxItemOperation = (item: VoxItem): string | null => (item.kind === 'vox-record' ? item.row.operation ?? null : null);

// ── the view ───────────────────────────────────────────────────────────────────

/** The VoxVision family's rows, as the old view and /tools have them (src/workbench/nav.ts FAMILY_ROWS.voxvision). */
export function familyRows(caps: Lazy<CapabilityRow[]>): CapabilityRow[] {
  const match = FAMILY_ROWS.voxvision;
  return caps.state === 'ready' && match ? caps.value.filter((r) => match(r.id, r.kind)) : [];
}

/** The tools an action can run, in the order /tools lists them: VoxVision's own rows (vox:*), not the layers it has no use of yet. */
const LATER = new Set(LATER_LAYERS.map((l) => `vox:${l.tool}`));
const stagesOf = (rows: readonly CapabilityRow[]): CapabilityRow[] => rows.filter((r) => r.id.startsWith('vox:') && !LATER.has(r.id));
/** A tool's name without its note in brackets ("Look (OpenCV)": "Look"), for a stage. */
const stageName = (name: string): string => name.trim().replace(/\s*\([^)]*\)$/, '') || name.trim();

/**
 * The pipeline: what this computer can run, in order (.intent → each tool found here → .receipt), and the tools that need
 * setup, each marked so. `max`: the rows it may take (the last says how many stages it leaves out).
 */
export function pipelineRows(caps: Lazy<CapabilityRow[]>, w: number, g: Glyphs, max?: number): Line[] {
  const lead: Line = [S('PIPELINE ', 'secondary', { bold: true })];
  if (caps.state !== 'ready') {
    return [fit([...lead, S(caps.state === 'failed' ? `${g.fail} Timmy's tools could not be read: ${caps.why}` : 'reading Timmy\'s tools…', caps.state === 'failed' ? 'failure' : 'secondary')], w, g.ellipsis)];
  }
  const stages = stagesOf(familyRows(caps));
  const ready = stages.filter((r) => !notHere(r));
  const setup = stages.filter(notHere);
  const arrow = S(` ${g.arrow} `, 'secondary');
  const parts: Line[] = [[S('.intent', 'action')], ...(ready.length ? ready.map((r): Line => [S(stageName(r.name), 'text')]) : [[S('no VoxVision tool can run here yet', 'secondary')]]), [S('.receipt', 'strong')]];
  const more = (n: number): string => `and ${n} more`;
  const out = chips(parts, w, { sep: arrow, ellipsis: g.ellipsis, lead, indent: '  ', ...(max !== undefined ? { max: Math.max(1, max - (setup.length ? 1 : 0)), more } : {}) });
  if (setup.length) {
    const said: Line = [S('  needs setup: ', 'secondary')];
    const rows = chips(setup.map((r): Line => [S(stageName(r.name), 'secondary')]), w, { sep: S(` ${g.sep} `, 'secondary'), ellipsis: g.ellipsis, lead: said, indent: '    ', ...(max !== undefined ? { max: Math.max(1, max - out.length), more } : {}) });
    out.push(...rows);
  }
  return out;
}

const STATUS: Readonly<Record<string, { word: string; role: Role; glyph?: 'fail' | 'warn' }>> = {
  ok: { word: 'ok', role: 'text' }, untrusted: { word: 'untrusted', role: 'attention', glyph: 'warn' }, 'needs-setup': { word: 'needs setup', role: 'secondary' },
  failed: { word: 'failed', role: 'failure', glyph: 'fail' }, cancelled: { word: 'cancelled', role: 'secondary' }, partial: { word: 'partial', role: 'attention', glyph: 'warn' },
};
/** A record's status in its word, with ✕ or ⚠ where it failed or holds only partly. */
function statusSeg(s: string, g: Glyphs, sel: { selected?: true }): Seg {
  const x = STATUS[s] ?? { word: s, role: 'secondary' as Role };
  return S(`${x.glyph === 'fail' ? `${g.fail} ` : x.glyph === 'warn' ? `${g.warn} ` : ''}${x.word}`, x.role, sel);
}

/** Whether the record's bytes are the ones a vox receipt sealed, and its inputs the ones it names, in a few words. */
function sealWords(r: VoxRow, g: Glyphs): Seg {
  const c = r.card.check;
  // the mark and its word, short enough for a narrow column (the detail says why)
  if (c.status === 'verified') return S('sealed', 'secondary');
  if (c.status === 'stale') return S(`${g.warn} stale`, 'attention');
  return S(r.seal ? `${g.fail} changed after sealing` : 'not sealed', r.seal ? 'failure' : 'secondary');
}

/** The tools a record used, and those it needed (a failure with a setup step). */
function toolsWords(r: VoxRow): { used: string; needed: string } {
  const used = [...new Set(r.card.tools.map((t) => t.tool))].join(', ');
  const needed = [...new Set(r.card.failures.filter((f) => f.code === 'needs-setup' || f.setup).map((f) => f.tool))].join(', ');
  return { used, needed };
}

/** One record as rows `w` cells wide: its id and status; its action and time; the tools it used or needed and its seal. */
function recordRows(r: VoxRow, w: number, selected: boolean, g: Glyphs): Line[] {
  const sel = selected ? { selected: true as const } : {};
  const ind = w >= 44 ? '    ' : '  ';
  const left: Line = [selected ? S(`${g.cursor} `, 'action', sel) : S('  '), S(r.card.id, 'strong', sel), S(` ${r.card.action}`, 'text', sel)];
  const status = statusSeg(r.card.status, g, sel);
  const bar = (l: Line): Line => (selected ? onBar(l) : l);
  const t = toolsWords(r);
  // the seal's words, what it needed (a step to do) and what it used: each part whole, on as many rows as it takes
  const parts: Line[] = [[sealWords(r, g)], ...(t.needed ? [[S(`needed ${t.needed}`, 'secondary')]] : []), [S(t.used ? `used ${t.used}` : 'no tool ran', 'secondary')]];
  const more = (lead: Line): Line[] => chips(parts, w, { sep: S(` ${g.sep} `, 'secondary'), ellipsis: g.ellipsis, lead, indent: ind });
  // wide: the id, action and status on one row; narrow: the status under the id (an id is never cut for it)
  if (lineCells(left) + 1 + lineCells([status]) <= w) {
    return [bar(spread(left, [status], w, g.ellipsis)), ...more([S(ind), S(`${clock(r.card.madeAt)} ${g.sep} `, 'secondary')])];
  }
  return [bar(fit(left, w, g.ellipsis)), spread([S(ind), S(clock(r.card.madeAt), 'secondary')], [S(status.text, status.role)], w, g.ellipsis), ...more([S(ind)])];
}

/** A value's line: its title, its value with its unit, and its status word (the record's, or the board's derived one). */
function metricLine(m: VoxCardMetric, w: number, g: Glyphs, indent = '  '): Line {
  const word = m.said?.word ?? 'unknown';
  const role: Role = word === 'stale' || word === 'unknown' ? 'attention' : word === 'model prediction' ? 'secondary' : 'text';
  const value = m.malformed ? 'a malformed entry' : valueWords(m.value, m.unit, m.name);
  return fit([S(indent), S(`${m.of ? `${m.of === 'delta' ? 'Δ' : m.of} ` : ''}${m.title} `, 'secondary'), S(value, 'strong'), S(` ${g.sep} `, 'secondary'), S(word, role)], w, g.ellipsis);
}

/**
 * Where a record's image, what was measured over it, its frames and its mesh views are seen (R6 H143): the companion draws them
 * (c); a terminal draws none; no Timmy surface draws depth or voxels; Rerun's own viewer shows its files where it is installed.
 */
const seenRows = (id: string, w: number, g: Glyphs): Line[] => [
  ...limitRows('A terminal draws no image.', { c: 'this record\'s image with what was measured over it, its frames and its mesh views (tab 5)' }, w, g),
  ...para(`No Timmy surface draws depth or voxels (no adapter here). Rerun's own viewer shows its files, where it is installed (/vox view ${id}).`, w, 'secondary'),
];

/** R6 (H143): what the companion's address carries so that it opens on tab 5 with this record selected (panel-vox.js reads vox=). */
export const voxCompanionHint = (item: VoxItem | undefined): string => `tab=voxvision${item && item.kind === 'vox-record' ? `&vox=${item.row.card.id}` : ''}`;

/**
 * R6 (H143): the record as the companion's tab 5 draws it, in words: ENTITIES (what was measured over its images, each with its
 * provenance and evidence state), FRAMES (a video's sampled times) and FILES (each image, mesh and recording, and where each is
 * drawn). `per`: the most rows of each list where room is short.
 */
export function previewRows(r: VoxRow, w: number, g: Glyphs, per = 6): Line[] {
  const out: Line[] = [];
  const list = <T>(title: string, items: readonly T[], rows: (x: T) => Line[], empty?: string): void => {
    out.push([S(title.toUpperCase(), 'secondary', { bold: true }), S(` ${items.length}`, 'secondary')]);
    if (!items.length && empty) out.push(...para(empty, w, 'secondary', '  '));
    for (const x of items.slice(0, per)) out.push(...rows(x));
    if (items.length > per) out.push([S(`  and ${items.length - per} more (the Inspector has them all)`, 'secondary')]);
  };
  const pv = r.preview;
  if (pv) {
    const observed = (pv.entities[0]?.children ?? []).find((k) => k.id === 'observations');
    const obs = observed?.children ?? [];
    list('Entities', obs, (e) => [
      fit([S('  '), S(`${e.path} `, 'secondary'), S(e.label, 'text'), S(` ${g.sep} ${e.provenance ?? 'not recorded'} · ${e.evidence ?? 'unknown'}`, 'secondary')], w, g.ellipsis),
      ...(e.detail ? para(e.detail, w, 'secondary', '    ') : []),
    ], `none drawn: ${observed?.detail ?? 'nothing with a place in an image was recorded'}`);
    if (pv.frames.length) {
      out.push([S('FRAMES', 'secondary', { bold: true }), S(` ${pv.frames.length}`, 'secondary')]);
      out.push(...para(`${pv.frames.map((f) => f.label).join('; ')}: the companion draws each with what was measured there, on a timeline (each frame's box and centroid are under ENTITIES)`, w, 'text', '  '));
    }
    const files = [
      ...pv.images.map((x) => ({ path: x.path, words: `${x.role === 'input' ? 'the observed image' : x.title}${x.servable ? ' · drawn in the companion' : ` · not shown: ${x.why ?? 'not checked'}`}` })),
      ...pv.spatial.map((x) => ({ path: x.source, words: x.why ? `a mesh · not drawn: ${x.why}` : 'a mesh · drawn as three views in the companion' })),
      ...pv.recordings.map((x) => ({ path: x.path, words: 'a Rerun recording · what Timmy reads of it is in the companion' })),
    ];
    list('Files', files, (x) => para(`${x.path} ${g.sep} ${x.words}`, w, 'text', '  '), 'no image, mesh or recording');
  }
  return out;
}

/**
 * The selected record's detail: what it is; what failed or needs setup, each with its step; its receipt verified now or
 * not, and whether it vouches for these bytes and inputs; the operator's verdict; its values and a model's claims (each list
 * its first `per` where room is short); its inputs. Where its images and 3D are seen is the caller's to add (a column keeps
 * it in view: seenRows).
 */
export function recordDetail(r: VoxRow, d: VoxData, w: number, g: Glyphs, per = 6, o: { preview?: boolean } = {}): Line[] {
  const c = r.card;
  const out: Line[] = [[S('RECORD ', 'secondary', { bold: true }), S(c.id, 'strong')]];
  out.push(fit([S(`${c.action} `, 'text'), statusSeg(c.status, g, {}), S(` ${g.sep} ${clock(c.madeAt)}`, 'secondary')], w, g.ellipsis));
  if (c.command) out.push(...para(c.command, w, 'strong'));
  if (r.operation) out.push(fit([S('operation ', 'secondary'), S(r.operation, 'text')], w, g.ellipsis));
  const list = <T>(title: string, items: readonly T[], rows: (x: T) => Line[], empty?: string): void => {
    out.push([S(title.toUpperCase(), 'secondary', { bold: true }), S(` ${items.length}`, 'secondary')]);
    if (!items.length && empty) out.push(...para(empty, w, 'secondary', '  '));
    for (const x of items.slice(0, per)) out.push(...rows(x));
    if (items.length > per) out.push([S(`  and ${items.length - per} more (the Inspector has them all)`, 'secondary')]);
  };
  // what failed or needs setup first (what a person does next), each with its step
  if (c.failures.length) {
    list('Failed or needs setup', c.failures, (f) => [
      fit([S(`  ${f.code === 'needs-setup' ? '' : `${g.fail} `}${f.tool} ${f.code}: `, f.code === 'needs-setup' ? 'secondary' : 'failure'), S(f.message, f.code === 'needs-setup' ? 'secondary' : 'failure')], w, g.ellipsis),
      ...(f.setup ? [fit([S('    do: ', 'secondary'), S(f.setup, 'text')], w, g.ellipsis)] : []),
    ]);
  }
  // its receipt: green only when verifyReceiptIn confirms it in this reading; whether it vouches for these bytes and inputs
  out.push([S('RECEIPT', 'secondary', { bold: true }), S(r.seal ? ` #${r.seal.seq} ${g.sep} vox ${g.sep} ${clock(r.seal.ts)}${r.seals > 1 ? ` ${g.sep} ${r.seals} name it` : ''}` : '', 'secondary')]);
  if (!r.seal) out.push(...para('not sealed: no vox receipt of this project names this record', w, 'secondary', '  '));
  else {
    out.push(fit([S('  '), ...verdictSegs(voxReceiptVerdict(d, r.seal.hash), g, w < 60)], w, g.ellipsis));
    const ch = c.check;
    if (ch.status === 'verified') out.push(...para('its bytes and inputs are the ones it sealed', w, 'secondary', '  '));
    else for (const why of ch.reasons.slice(0, 2)) out.push(...para(`${ch.status === 'stale' ? `${g.warn} stale` : `${g.fail} not this record`}: ${why}`, w, ch.status === 'stale' ? 'attention' : 'failure', '  '));
  }
  out.push(...fieldRows('Verdict', 'not recorded: a VoxVision record (timmy.vox/1) keeps no operator verdict', w, 'secondary', 8));
  list('Values', c.metrics.filter((m) => !m.name.startsWith('file_')), (m) => [metricLine(m, w, g)], 'none: no tool gave a value');
  if (c.claims.length) list('Claims', c.claims, (m) => [metricLine(m, w, g)]);
  // R6 (H143): the same record as the companion draws it: what was measured over its images, its frames, its files
  if (o.preview !== false) out.push(...previewRows(r, w, g, per));
  list('Inputs', c.inputs, (x) => [fit([S('  '), S(x.path, 'text'), S(` ${g.sep} ${x.kind ?? 'other'}${typeof x.bytes === 'number' ? ` ${g.sep} ${humanBytes(x.bytes)}` : ''}`, 'secondary')], w, g.ellipsis)]);
  return out;
}

/** The selected row's detail for a body's column (a record's, or a tool's), and where images and 3D are seen. */
function detailOf(item: VoxItem | undefined, d: VoxData, w: number, g: Glyphs, per?: number): { rows: Line[]; seen: Line[] } {
  if (!item) return { rows: [[heading('Record')], ...para(`No record yet. ${INSPECT_COMMAND} in the REPL makes one.`, w, 'secondary')], seen: seenRows('<record id>', w, g) };
  return item.kind === 'vox-record' ? { rows: recordDetail(item.row, d, w, g, per), seen: seenRows(item.row.card.id, w, g) } : { rows: capDetail(item.row, w, g), seen: seenRows('<record id>', w, g) };
}

/**
 * Tab 5's body: the pipeline, then the tools, the records and the selected row's detail, side by side from 120 columns (the
 * records clickable; the tools reached with the keys), stacked below with the detail under the selected row. Every row at
 * most `c.width` cells. The items are the records (newest first), then the tools, in that order at every size.
 */
export function voxView(c: TabCtx, caps: Lazy<CapabilityRow[]>, d: VoxData | undefined): TabView<VoxItem> {
  const { g, width: W, height: H } = c;
  if (!d) return { lines: [fit([S('Reading this project\'s VoxVision records…', 'secondary')], W, g.ellipsis)], items: [] };
  const tools = familyRows(caps);
  const all: VoxItem[] = [...d.rows.map((row): VoxItem => ({ kind: 'vox-record', key: `vox:${row.card.id}`, row })), ...tools.map(capItem)];
  const sel = selectedIn(c.ui, VOX_LIST, all.length);
  const items: TabView<VoxItem>['items'] = all.map((item) => ({ line: -1, item }));
  const nRec = d.rows.length;
  const toolsHead = (w: number): Line => spread([S('TOOLS', 'secondary', { bold: true })], [S(caps.state === 'ready' ? `${tools.filter((r) => !notHere(r)).length} of ${tools.length} here` : '', 'secondary')], w, g.ellipsis);
  const toolRows = (w: number): Line[] => lazyRows(caps, 'Timmy\'s tools', w, c.now) ?? (tools.length ? [] : para('No VoxVision tool is registered in this revision.', w));
  const recordsHead = (w: number): Line => spread([S('RECORDS', 'secondary', { bold: true }), S(` ${g.sep} results/vox`, 'secondary')], [S(nRec ? `${nRec}${d.more ? ` of ${nRec + d.more}` : ''}` : '', 'secondary')], w, g.ellipsis);
  const emptyRecords = (w: number): Line[] => [...para('No VoxVision record yet.', w, 'text', '  '), fit([S('  '), S(INSPECT_COMMAND, 'strong'), S(' in the REPL makes one', 'secondary')], w, g.ellipsis)];
  const unread = (w: number): Line[] => d.unreadable.slice(0, 3).flatMap((u) => para(`${u.file}: ${u.why}`, w, 'failure', '  '));
  const lines: Line[] = [];

  if (sideBySideAt(c)) {
    lines.push(...pipelineRows(caps, W, g, H >= 20 ? 3 : 2));
    if (H >= 12) lines.push([]);
    const room = Math.max(1, H - lines.length);
    const [wl, wc, wr] = widths(W - 2 * RULE_CELLS, [32, 30, 38], 14);
    // the records (centre): windowed around the selection when it is a record; their lines are the clickable ones
    const recBlocks = d.rows.map((row, i) => recordRows(row, wc, i === sel, g));
    const recSel = sel >= 0 && sel < nRec ? sel : -1;
    const recWin = windowMarked(recBlocks.map((b) => b.length), recSel, room - 1, g, wc);
    const centre: Line[] = [recordsHead(wc)];
    if (recWin.above) centre.push(recWin.above);
    const top = lines.length;
    for (let i = recWin.start; i < recWin.end; i++) {
      items[i] = { line: top + centre.length, item: all[i], ...(recBlocks[i].length > 1 ? { rows: recBlocks[i].length } : {}) };
      centre.push(...recBlocks[i]);
    }
    if (recWin.below) centre.push(recWin.below);
    if (!nRec) centre.push(...emptyRecords(wc));
    centre.push(...unread(wc));
    // the tools (left): windowed around the selection when it is a tool; reached with the keys (a click on a row of this
    // column would land on the record beside it, so their lines are not given)
    const toolBlocks = tools.map((r, k) => capRows(r, wl, nRec + k === sel, g));
    const toolSel = sel >= nRec ? sel - nRec : -1;
    const head = toolRows(wl);
    const toolWin = windowMarked(toolBlocks.map((b) => b.length), toolSel, room - 1 - head.length, g, wl);
    const left: Line[] = [toolsHead(wl), ...head, ...(toolWin.above ? [toolWin.above] : [])];
    for (let k = toolWin.start; k < toolWin.end; k++) left.push(...toolBlocks[k]);
    if (toolWin.below) left.push(toolWin.below);
    // the detail (right): clipped at the room (saying which of its rows show), where images and 3D are seen kept under it
    const right = detailOf(sel >= 0 ? all[sel] : undefined, d, wr, g, room >= 24 ? 6 : 3);
    const shown = [...clipRows(right.rows, wr, Math.max(1, room - right.seen.length), g), ...right.seen];
    lines.push(...sideBySide([
      { w: wl, lines: rowsOf(left, wl, room, g.ellipsis) }, { w: wc, lines: rowsOf(centre, wc, room, g.ellipsis) }, { w: wr, lines: rowsOf(shown, wr, room, g.ellipsis) },
    ], room, g));
    for (const x of items) if (x.line >= top + room) x.line = -1;
    return { lines, items };
  }

  // stacked: the pipeline, the records (the selected one's detail under it), then the tools (the selected one's under it);
  // the body scrolls to the selection (opening at its top while the selection starts on the first page), and the screen says
  // which rows show
  lines.push(...pipelineRows(caps, W, g), []);
  lines.push(recordsHead(W));
  if (!nRec) lines.push(...emptyRecords(W));
  d.rows.forEach((row, i) => {
    const block = recordRows(row, W, i === sel, g);
    const more = i === sel ? [...recordDetail(row, d, W - 4, g, 8), ...seenRows(row.card.id, W - 4, g)].map((l) => [S('    '), ...l]) : [];
    items[i] = { line: lines.length, item: all[i], rows: i === sel ? inViewRows(lines.length, block.length + more.length, H) : block.length };
    lines.push(...block, ...more);
  });
  lines.push(...unread(W), [], toolsHead(W), ...toolRows(W));
  tools.forEach((r, k) => {
    const block = capRows(r, W, nRec + k === sel, g);
    const more = nRec + k === sel ? [...capDetail(r, W - 4, g, false), ...seenRows('<record id>', W - 4, g)].map((l) => [S('    '), ...l]) : [];
    items[nRec + k] = { line: lines.length, item: all[nRec + k], rows: nRec + k === sel ? inViewRows(lines.length, block.length + more.length, H) : block.length };
    lines.push(...block, ...more);
  });
  if (sel < 0) lines.push([], ...seenRows('<record id>', W, g));
  return { lines: lines.map((l) => (lineCells(l) > W ? fit(l, W, g.ellipsis) : l)), items };
}

// ── the Inspector ──────────────────────────────────────────────────────────────

/** The Inspector's rows for a selected record: every value, claim, failure and input, its tools, highlights and views, and
 *  its receipt verified now (a tool's rows are the Inspector's own `cap` case). */
export function voxDetail(item: Extract<VoxItem, { kind: 'vox-record' }>, d: VoxData | undefined, w: number, g: Glyphs): Line[] {
  const r = item.row;
  if (!d) return [[heading('Record')], [S('Reading…', 'secondary')]];
  const out: Line[] = [...recordDetail(r, d, w, g, 1000, { preview: false })];
  const c = r.card;
  out.push([], [heading('Tools'), S(` ${g.sep} ${c.tools.length}`, 'secondary')]);
  for (const t of c.tools) out.push(...para(`${t.tool}: ${[t.name, t.version].filter(Boolean).join(' ') || 'Timmy\'s own reader'}${t.ran ? ` ${g.sep} ${t.ran === 'job' ? `job ${t.job ?? ''} ${t.state ?? ''}`.trim() : 'in Timmy\'s process'}` : ''}${t.status ? ` ${g.sep} ${t.status}` : ''}`, w, 'text', '  '));
  out.push(...fieldRows('Highlights', `${c.highlights.length}${c.highlights.length ? `: ${c.highlights.filter((h) => h.shown).length} shown on the board (their bytes sealed)` : ''}`, w, 'secondary'));
  if (c.views?.length) out.push(...fieldRows('Views', `${c.views.length} in ${c.views.map((v) => v.viewer).join(', ')} (/vox view), the last at ${clock(c.views[c.views.length - 1].at)}`, w, 'secondary'));
  for (const n of c.notes.slice(0, 6)) out.push(...para(n, w, 'secondary', '  '));
  if (c.doctrine) out.push(...para('A measurement of a CAD or mesh file is never a measurement of a physical part (DOCTRINE §15).', w, 'secondary'));
  out.push(...fieldRows('Record', `${c.file}${r.seal ? ` ${g.sep} receipt ${r.seal.hash.slice(7, 19)}` : ''}`, w, 'secondary'));
  // R6 (H143): the record as the companion draws it, after its tools
  out.push([], ...previewRows(r, w, g, 1000));
  // R5 (H131; the QA of e7f853e, defect 2): where its images and 3D are seen, last (its words are longer now, and truthful)
  out.push([], ...seenRows(r.card.id, w, g));
  return out;
}
