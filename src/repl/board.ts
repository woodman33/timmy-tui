/**
 * The project reference board (round R2): a read-only HTML snapshot of the active project — its
 * references, workflows, jobs and results — where every card links to the real file and shows the exact
 * Timmy command that acts on it. `/board` (src/repl/workspace.ts) gathers the data and writes the page to
 * <project>/.timmy/board/index.html; this module only turns plain data into HTML, so it is easy to test.
 *
 * The page is self-contained: every string is escaped, every link is relative to the board's folder, no
 * absolute path is written, nothing is fetched from elsewhere (no CDN, no web font: an installed
 * Monaspace Argon is used when there is one), and its one script copies a command when it is clicked.
 * What Look measured and what a model claimed stay in separate, labelled blocks (AGENTS.md §4).
 *
 * The independent review of 40022d9: an observation file is editable, so a value is drawn as measured only
 * when its own tier is exactly "deterministic computation" AND the card's provenance check (src/evidence/
 * observation-check.ts, made by /board) is `verified`. Every other value — another tier, no tier, a
 * malformed entry, or any value of an unverified or stale record — goes to a separate "not verified" block,
 * as recorded, never drawn or worded as a measurement. A card with no check is not verified.
 */
import { checkObservation, type KeptFileReader, type ObservationCheck } from '../evidence/observation-check.js';
// R4 (/iterate): the Flows section's cards (src/repl/board-flows.ts).
import { FLOWS_CSS, flowsSection, type BoardFlows } from './board-flows.js';
import { humanBytes } from '../project/index.js';
import { kindOf } from '../project/intake.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';
import { DETERMINISTIC } from '../vision/look.js';
// Round R4 (H22): parameter, workflow-graph and result cards (their own modules; small hooks here).
import { CARDS_CSS, renderParamsCard, renderResultCards, type ParamsCard, type ResultCard } from './board-cards.js';
import { kit } from './board-kit.js';
import { NODES_CSS, renderWorkflowCard, type WorkflowDocInput } from './board-nodes.js';
// Round R4 (H49): the VoxVision section (src/repl/board-vox.ts).
import { VOX_CSS, voxSection, type BoardVox } from './board-vox.js';

export interface BoardFile { rel: string; bytes: number; sha256?: string; kind?: string }
/** A workflow document: its named blocks (R4: with language and command), its sha256 and whether the live board edits it. */
export type BoardWorkflow = WorkflowDocInput;
export interface BoardJob {
  id: string; state: string; label: string; seconds?: string; receipt?: string; kind?: string;
  /** Round R3, live board: a running job this REPL started, which its Stop button may stop. */
  stoppable?: boolean;
}
export interface BoardMeasurement {
  name: string;
  value: unknown;
  unit?: string;
  note?: string;
  /** The tier the record gives this value, verbatim; absent when it gives none (or not as text). */
  tier?: string;
  /** Not an object with a name and a text tier: `value` is then the whole entry as recorded. */
  malformed?: boolean;
}
/**
 * An interpretation's evidence as the record gives it (`interpretation.evidence`, written from
 * src/vision/evidence.ts's InterpretationEvidence): admitted references with the measurement each names,
 * a refusal (`unknown`, with its reason), or a record that could not be read as either.
 */
export type BoardEvidence =
  | { admission: 'admitted_references'; handles: Array<{ handle_id: string; measurement?: string }> }
  | { admission: 'unknown'; reason?: string }
  | { admission: 'unreadable' };
export interface BoardInterpretation {
  status: string; model?: string; question?: string; answer?: string; cost_usd?: number; reason?: string; evidence?: BoardEvidence;
  /** R4 (H20): the file keeps only the answer's first 64 KB (`answer_bytes` its whole size); `answer_full`, where the whole of it is */
  answer_truncated?: boolean; answer_bytes?: number; answer_full?: BoardKept;
}
/** R4 (H20): where a record says the whole of a cut text is kept (a project path, or Timmy's own kept folder), or why it is not. */
export type BoardKept = { path: string; bytes?: number; store?: 'timmy' } | { error: string };
/**
 * R3 (H14): the qualified answer of /observe --qualify (the record's `qualified` section), as the record
 * gives it: admitted with the handles it cites and their values, or why there is no admitted answer, with
 * the model's raw output as it came. An admitted answer is a model's claim whose citations point at
 * measured values; the board never draws it as a measurement.
 */
export interface BoardQualified {
  status: string;
  model?: string;
  question?: string;
  answer?: string;
  /** with status admitted: what it cites, as recorded */
  cites: Array<{ handle_id: string; measurement: string; value: unknown; unit?: string }>;
  /** the refusal reason (the admission controller's code), when one was decided */
  refusal?: string;
  reason?: string;
  raw_output?: string;
  raw_output_truncated?: boolean;
  /** R4 (H20): with a cut raw output or answer, its whole size and where the whole of it is kept */
  raw_output_bytes?: number;
  raw_output_full?: BoardKept;
  answer_truncated?: boolean;
  answer_bytes?: number;
  answer_full?: BoardKept;
  /** absent: no request went out; null: one did and its cost is unknown */
  cost_usd?: number | null;
  run_id?: string;
}
export interface BoardObservation {
  /** The observation file, relative to the project. */
  file: string;
  madeAt?: string;
  /** The image Look read; absent when the record names no path inside the project. */
  source?: { path: string; sha256?: string };
  image?: { width: number; height: number; channels?: number };
  measurements: BoardMeasurement[];
  interpretation?: BoardInterpretation;
  /** R3 (H14): the qualified answer, when the record has one. */
  qualified?: BoardQualified;
  job?: string;
  /** Its provenance check (checkObservation); without one the card is shown as not verified. */
  check?: ObservationCheck;
}
export type BoardPart = 'references' | 'workflows' | 'jobs' | 'outputs' | 'observations' | 'results';
export interface BoardInput {
  project: string;
  /** When the snapshot was made, as it is shown. */
  madeAt: string;
  /** From the board's folder to the project's, made of ../ only: '../../' for .timmy/board/. */
  base: string;
  references: BoardFile[];
  workflows: BoardWorkflow[];
  jobs: BoardJob[];
  outputs: BoardFile[];
  /** Newest first. */
  observations: BoardObservation[];
  /** How many of each were left off the board. */
  more?: Partial<Record<BoardPart, number>>;
  /** Round R4 (H22): the tray recipe's parameter card (src/repl/board-cards.ts); absent: no Parameters section. */
  params?: ParamsCard;
  /** Round R4 (H22): one card per result, newest first (src/repl/board-cards.ts gatherResults); absent: none drawn. */
  results?: ResultCard[];
  /**
   * Round R3: drawn for the live board (src/repl/board-live.ts), served on 127.0.0.1: Stop, Run and Observe
   * buttons carry structured data-* attributes, file names are text (that page serves no files, so no
   * links and no thumbnails), and colour swatches carry their colour as data for the page's script
   * (its Content-Security-Policy allows no style attribute). Absent: the read-only snapshot, unchanged.
   */
  live?: boolean;
  /** R4 (/iterate): the flow records, newest first, each checked (board-flows.ts); absent: no Flows section. */
  flows?: BoardFlows;
  /** R4 (H49): VoxVision's tools, files and records (board-vox.ts); absent: no VoxVision section. */
  vox?: BoardVox;
}

/** Where `/board` writes the page, relative to the project, and the way back from there. */
export const BOARD_FILE = '.timmy/board/index.html';
export const BOARD_BASE = '../../';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
/**
 * A model's answer as HTML (round R2): escaped first, then only **bold** and `code` are drawn, each within
 * one line, so the claim reads as written without its Markdown marks and can carry no markup of its own.
 * Line breaks and list numbers stay as text (the block keeps white-space: pre-wrap).
 */
const claimHtml = (s: string): string => esc(s)
  .split(/(`[^`\n]+`)/)
  .map((part) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') && !part.includes('\n')
    ? `<code>${part.slice(1, -1)}</code>`
    // As in Markdown: the marks hug their text (`a ** b` is not bold), and code keeps its asterisks.
    : part.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>')))
  .join('');
/** Round R3: how much of a model's answer a card shows; the observation file keeps the whole of it. */
const BOARD_ANSWER_CHARS = 4000;
const SHOWN_IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const HEX = /^#[0-9a-f]{6}$/i;

/** A path inside the project as '/'-separated parts, or null: absolute, a URL, or one that climbs out. */
export function projectRel(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** `interpretation.evidence` read strictly: admitted only with at least one handle, each with a text id. */
function readEvidence(v: unknown): BoardEvidence | undefined {
  if (v === undefined) return undefined;
  const e = obj(v);
  if (e?.admission === 'admitted_references' && Array.isArray(e.handles) && e.handles.length) {
    const handles = e.handles.map((h) => (typeof h === 'string' && h ? { handle_id: h } : str(obj(h)?.handle_id)
      ? { handle_id: str(obj(h)?.handle_id)!, ...(str(obj(h)?.measurement) ? { measurement: str(obj(h)?.measurement) } : {}) } : null));
    if (handles.every((h) => h !== null)) return { admission: 'admitted_references', handles: handles as Array<{ handle_id: string; measurement?: string }> };
    return { admission: 'unreadable' };
  }
  if (e?.admission === 'unknown') return { admission: 'unknown', ...(str(e.reason) ? { reason: str(e.reason) } : {}) };
  return { admission: 'unreadable' };
}

/** R4 (H20): a record's `<field>_full` in the board's shape: where the whole text is, or why it is kept nowhere. */
function keptPlace(v: unknown): BoardKept | undefined {
  const k = obj(v);
  if (!k) return undefined;
  const path = projectRel(k.path);
  if (k.store === 'timmy' && str(k.path)) return { path: str(k.path)!, store: 'timmy', ...(num(k.bytes) !== undefined ? { bytes: num(k.bytes) } : {}) };
  if (path) return { path, ...(num(k.bytes) !== undefined ? { bytes: num(k.bytes) } : {}) };
  return { error: str(k.error) ?? 'the record names no place that keeps it' };
}

/** R4 (H20): a text's cut flag, whole size and kept place, as a record gives them under `field`. */
function cutText(r: Record<string, unknown>, field: 'answer' | 'raw_output'): Record<string, unknown> {
  if (r[`${field}_truncated`] !== true) return {};
  return {
    [`${field}_truncated`]: true,
    ...(num(r[`${field}_bytes`]) !== undefined ? { [`${field}_bytes`]: num(r[`${field}_bytes`]) } : {}),
    ...(keptPlace(r[`${field}_full`]) ? { [`${field}_full`]: keptPlace(r[`${field}_full`]) } : {}),
  };
}

/** R3 (H14): a record's `qualified` section in the board's shape; null when it has none, or none readable as one. */
function readQualified(v: unknown): BoardQualified | null {
  const q = obj(v);
  const status = str(q?.status);
  if (!q || !status) return null;
  const cites = Array.isArray(q.cites) ? q.cites.flatMap((c) => {
    const o = obj(c);
    return o && str(o.handle_id) && str(o.measurement)
      ? [{ handle_id: str(o.handle_id)!, measurement: str(o.measurement)!, value: o.value, ...(str(o.unit) ? { unit: str(o.unit) } : {}) }]
      : [];
  }) : [];
  return {
    status, cites,
    ...Object.fromEntries((['model', 'question', 'answer', 'refusal', 'reason', 'raw_output', 'run_id'] as const).flatMap((k) => (typeof q[k] === 'string' ? [[k, q[k]]] : []))),
    ...cutText(q, 'raw_output'), ...cutText(q, 'answer'),
    ...(num(q.cost_usd) !== undefined ? { cost_usd: num(q.cost_usd) } : q.cost_usd === null ? { cost_usd: null } : {}),
  };
}

/** What /board knows about an observation file besides its JSON: what checkObservation needs. */
export interface ObservationProvenance {
  /** The record as written (before any scrubbing for display); the `json` read when omitted. */
  record?: unknown;
  /** The sha256 of the file's bytes now. */
  fileSha256: string | undefined;
  /** The project image's sha256 now: null when it is not there, undefined when it could not be hashed. */
  currentSourceSha256: string | null | undefined;
  receipts: readonly Receipt[];
  projectId?: string;
  /** R4 (H20): reads a file a record names as keeping a whole text (checkObservation's rule 6). */
  readKept?: KeptFileReader;
}

/**
 * An observation file as /observe writes it (results/observations/*.json, src/vision/look.ts), read into
 * the board's shape; null when it is not one. A source path that leaves the project is dropped. Each
 * value keeps the tier the file gives it. With its provenance, the card carries checkObservation's result;
 * without it, the card has no check and is shown as not verified.
 */
export function readObservationRecord(file: string, json: unknown, provenance?: ObservationProvenance): BoardObservation | null {
  const r = obj(json);
  const look = obj(r?.look);
  if (!r || !look || !Array.isArray(look.measurements)) return null;
  const src = obj(r.source);
  const path = projectRel(src?.path);
  const img = obj(look.image);
  const width = num(img?.width);
  const height = num(img?.height);
  const it = obj(r.interpretation);
  const status = str(it?.status);
  const measurements: BoardMeasurement[] = [];
  for (const m of look.measurements) {
    const o = obj(m);
    const name = str(o?.name);
    // An entry is kept even when it is malformed: dropping it would hide what the file says.
    if (!o || !name || (o.tier !== undefined && typeof o.tier !== 'string')) {
      measurements.push({ name: name ?? '(an entry with no name)', value: m, malformed: true });
      continue;
    }
    measurements.push({
      name, value: o.value, ...(str(o.unit) ? { unit: str(o.unit) } : {}), ...(str(o.note) ? { note: str(o.note) } : {}),
      ...(str(o.tier) ? { tier: str(o.tier) } : {}),
    });
  }
  const job = str(obj(r.job)?.id);
  return {
    file,
    ...(str(r.made_at) ? { madeAt: str(r.made_at) } : {}),
    ...(path ? { source: { path, ...(str(src?.sha256) ? { sha256: str(src?.sha256) } : {}) } } : {}),
    ...(width !== undefined && height !== undefined ? { image: { width, height, ...(num(img?.channels) !== undefined ? { channels: num(img?.channels) } : {}) } } : {}),
    measurements,
    ...(it && status ? {
      interpretation: {
        status,
        ...Object.fromEntries((['model', 'question', 'answer', 'reason'] as const).flatMap((k) => (str(it[k]) ? [[k, str(it[k])]] : []))),
        ...(num(it.cost_usd) !== undefined ? { cost_usd: num(it.cost_usd) } : {}),
        ...(readEvidence(it.evidence) ? { evidence: readEvidence(it.evidence) } : {}),
        ...cutText(it, 'answer'),
      },
    } : {}),
    ...(readQualified(r.qualified) ? { qualified: readQualified(r.qualified)! } : {}),
    ...(job ? { job } : {}),
    ...(provenance ? { check: checkObservation({ ...provenance, record: provenance.record ?? json, file }) } : {}),
  };
}

/** An ISO time as "YYYY-MM-DD HH:MM UTC"; anything else as it is. */
export const utcStamp = (when: string | Date): string => {
  const d = typeof when === 'string' ? new Date(when) : when;
  return Number.isNaN(d.getTime()) ? String(when) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

// ── HTML pieces ──────────────────────────────────────────────────────────────

const kindLabel = (f: BoardFile): string => {
  const k = f.kind ?? kindOf(f.rel, Buffer.alloc(0)).kind;
  return k === '3d' ? '3D' : k;
};

function render(input: BoardInput) {
  const live = input.live === true;
  const base = /^(?:\.\.\/)*$/.test(input.base) ? input.base : '';
  const href = (rel: string): string => esc(base + rel.split('/').map(encodeURIComponent).join('/'));
  const fileLink = (rel: string, cls = 'name'): string => (live ? `<span class="${cls}">${esc(rel)}</span>` : `<a class="${cls}" href="${href(rel)}">${esc(rel)}</a>`);
  const cmd = (c: string): string => `<button type="button" class="cmd" data-cmd="${esc(c)}" title="Copy this command"><code>${esc(c)}</code></button>`;
  const cmds = (list: string[]): string => `<div class="cmds">${list.map(cmd).join('')}</div>`;
  /** /observe takes a quoted path when it has spaces; /open and /run read the rest of the line. */
  const quoted = (rel: string): string => (/\s/.test(rel) ? `"${rel}"` : rel);
  const thumb = (rel: string): string => (live ? '' : `<a class="thumb" href="${href(rel)}"><img src="${href(rel)}" alt="${esc(rel)}" loading="lazy"></a>`);
  /** A live board's action button: what it does as escaped data-* attributes, never as command text. */
  const act = (label: string, data: Record<string, string>): string => (live
    ? `<button type="button" class="act" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${esc(label)}</button>`
    : '');
  const empty = (what: string): string => `<p class="empty">${esc(what)}</p>`;
  const more = (part: BoardPart, how: string): string => {
    const n = input.more?.[part] ?? 0;
    return n > 0 ? `<p class="more">${esc(`and ${n} more: ${how}`)}</p>` : '';
  };
  return { live, href, fileLink, cmd, cmds, quoted, thumb, act, empty, more };
}

function referenceCard(f: BoardFile, h: ReturnType<typeof render>): string {
  const kind = kindLabel(f);
  const image = kind === 'image';
  const meta = [humanBytes(f.bytes), ...(f.sha256 ? [`sha256 ${f.sha256.slice(0, 12)}`] : [])].join(' · ');
  return `<article class="card">${image && SHOWN_IMAGE.test(f.rel) ? h.thumb(f.rel) : ''}`
    + `${h.fileLink(f.rel)}<div class="meta"><span class="kind">${esc(kind)}</span> ${esc(meta)}</div>`
    + `${image ? h.act('Observe', { act: 'observe', file: f.rel }) : ''}${h.cmds([...(image ? [`/observe ${h.quoted(f.rel)}`] : []), `/open ${f.rel}`])}</article>`;
}

function jobCard(j: BoardJob, h: ReturnType<typeof render>): string {
  const meta = [...(j.seconds ? [j.seconds] : []), ...(j.receipt ? [`receipt ${j.receipt}`] : [])].join(' · ');
  return `<article class="card"${h.live ? ` data-job-card="${esc(j.id)}"` : ''}><div class="jobhead"><strong>${esc(j.id)}</strong> <span class="state state-${esc(j.state.replace(/[^a-z]/gi, ''))}">${esc(j.state)}</span></div>`
    + `<div class="label">${esc(j.label)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}${h.live && j.stoppable ? h.act('Stop', { act: 'stop', job: j.id }) : ''}${h.cmds([`/jobs ${j.id}`])}</article>`;
}

function outputCard(f: BoardFile, h: ReturnType<typeof render>): string {
  const kind = kindLabel(f);
  return `<article class="card">${kind === 'image' && SHOWN_IMAGE.test(f.rel) ? h.thumb(f.rel) : ''}`
    + `${h.fileLink(f.rel)}<div class="meta"><span class="kind">${esc(kind)}</span> ${esc(humanBytes(f.bytes))}${f.sha256 ? esc(` · sha256 ${f.sha256.slice(0, 12)}`) : ''}</div>`
    + `${kind === 'image' ? h.act('Observe', { act: 'observe', file: f.rel }) : ''}${h.cmds([`/open ${f.rel}`])}</article>`;
}

const percent = (v: number): string => `${Number((v * 100).toFixed(2))}%`;
const words = (name: string): string => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const swatch = (hex: string, live = false): string => (live ? `<span class="swatch" data-swatch="${esc(hex)}"></span>` : `<span class="swatch" style="background:${hex}"></span>`);
const plain = (v: unknown): string => {
  if (v === null || v === undefined) return 'not measured';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
};

/** One measurement in plain words: a row of the measured block. */
function measurementRow(m: BoardMeasurement, live = false): string {
  const row = (label: string, value: string): string => `<dt>${esc(label)}</dt><dd>${value}</dd>`;
  const notMeasured = (label: string): string => row(label, esc(`not measured${m.note ? `: ${m.note}` : ''}`));
  switch (m.name) {
    case 'mean_color': {
      const hex = str(obj(m.value)?.hex);
      return hex && HEX.test(hex) ? row('Mean colour', `${swatch(hex, live)}${esc(hex)}`) : notMeasured('Mean colour');
    }
    case 'dominant_colors': {
      if (!Array.isArray(m.value)) return notMeasured('Dominant colours');
      const items = m.value.map((c) => {
        const hex = str(obj(c)?.hex);
        const share = num(obj(c)?.share);
        return hex && HEX.test(hex) ? `<span class="color">${swatch(hex, live)}${esc(hex)}${share !== undefined ? ` ${esc(percent(share))}` : ''}</span>` : '<span class="color">(not a #rrggbb colour)</span>';
      });
      return row('Dominant colours', items.length ? items.join(' ') : 'none');
    }
    case 'qr_codes_decoded': {
      if (!Array.isArray(m.value)) return notMeasured('QR codes decoded');
      const texts = m.value.map((c) => str(obj(c)?.text)).filter((t): t is string => !!t);
      return row('QR codes decoded', texts.length ? texts.map((t) => `<span class="qr">${esc(t)}</span>`).join(', ') : 'none decoded (a small, blurred or steep code can be missed)');
    }
    case 'aruco_markers': {
      if (!Array.isArray(m.value)) return notMeasured('ArUco marker ids');
      const ids = m.value.map((c) => num(obj(c)?.id)).filter((i): i is number => i !== undefined);
      return row('ArUco marker ids', ids.length ? esc(ids.join(', ')) : 'none found (4x4_50 dictionary only)');
    }
    case 'sharpness':
      return num(m.value) === undefined ? notMeasured('Sharpness') : row('Sharpness', esc(`${m.value}${m.unit ? ` · ${m.unit}` : ''}`));
    case 'edge_density':
      return num(m.value) === undefined ? notMeasured('Edge density') : row('Edge density', esc(`${percent(m.value as number)} of pixels`));
    default:
      return row(words(m.name), esc(`${plain(m.value)}${m.unit && m.value !== null && m.value !== undefined ? ` · ${m.unit}` : ''}`));
  }
}

/** One value of the "not verified" block: its name and value as recorded, and the tier it was given. */
function unverifiedRow(m: BoardMeasurement, cardVerified: boolean): string {
  const tier = m.malformed ? 'malformed entry'
    : m.tier === DETERMINISTIC ? (cardVerified ? `tier: ${DETERMINISTIC}` : `recorded as ${DETERMINISTIC}`)
      : m.tier ? `tier: ${m.tier}` : 'no tier recorded';
  const unit = m.unit && m.value !== null && m.value !== undefined ? ` · ${m.unit}` : '';
  return `<dt>${esc(m.name)}</dt><dd>${esc(`${plain(m.value)}${unit}`)} <span class="tier">${esc(tier)}</span></dd>`;
}

/**
 * What a model's claim rests on (AGENTS.md §4): the references the admission run admitted — each a handle
 * observed in that run and cited through the cite tool — or plainly none. An admission says where a claim
 * points, not that it is right; in a file that is not verified, it is only what the file records.
 */
function evidenceLine(e: BoardEvidence | undefined, status: ObservationCheck['status'] | undefined, deterministicNames: ReadonlySet<string>): string {
  if (e?.admission === 'admitted_references') {
    const refs = e.handles.map((h) => {
      const id = h.handle_id.length > 14 ? `${h.handle_id.slice(0, 11)}…` : h.handle_id;
      const name = h.measurement ?? '(a measurement not named)';
      return `${name}${h.measurement && deterministicNames.has(h.measurement) ? '' : ' [not a deterministic value in this record]'} (${id})`;
    }).join(', ');
    const how = 'Each is a handle observed in its run and cited; an admission says where the claim points, not that it is right';
    const scope = status === 'verified' ? '' : status === 'stale' ? '; about an earlier version of the image' : '; as recorded in a file that is not verified';
    return `<p class="evidence admitted">${esc(`admitted references: ${refs}. ${how}${scope}`)}</p>`;
  }
  const why = e?.admission === 'unknown' ? ` (its evidence was refused: ${e.reason ?? 'no reason recorded'})`
    : e?.admission === 'unreadable' ? ' (its evidence record could not be read)' : '';
  return `<p class="evidence none">${esc(`no admitted evidence: a claim, not a measurement${why}`)}</p>`;
}

/**
 * R4 (H20): a text the file keeps only the start of: where the whole of it is kept and how big it is (a link to a
 * project file; Timmy's own kept folder by name), or why it could not be kept. Never the whole text itself.
 */
function wholeNote(label: string, cut: boolean | undefined, bytes: number | undefined, full: BoardKept | undefined, h: ReturnType<typeof render>): string {
  if (!cut) return '';
  const lead = `the file keeps the first 64 KB of the ${label}; the whole of it${bytes !== undefined ? ` (${humanBytes(bytes)})` : ''}`;
  if (full && 'path' in full) {
    const where = full.store === 'timmy' ? esc(`Timmy's own kept folder (${full.path})`) : h.fileLink(full.path, 'file');
    return `<p class="meta">${esc(`${lead} is kept at `)}${where}</p>`;
  }
  return `<p class="meta">${esc(`${lead} could not be kept${full && 'error' in full ? `: ${full.error}` : ''}`)}</p>`;
}

/**
 * R3 (H14): the qualified answer (/observe --qualify). Admitted: "model answer (a claim), citing …" with each cited
 * value, marked measured only on a verified card; the answer stays a claim. The heading puts "measured" on the cited
 * values, never next to the answer (review M7), so it cannot be read as a measured answer. Otherwise: why there is no admitted answer,
 * and the raw output as it came, labelled as not a claim. Distinct from an uncited claim and from measured values.
 */
function qualifiedBlock(q: BoardQualified, status: ObservationCheck['status'] | undefined, h: ReturnType<typeof render>): string {
  const cost = q.cost_usd === undefined ? 'no request sent' : q.cost_usd === null ? 'cost unknown' : `cost $${q.cost_usd.toFixed(4)}`;
  if (q.status === 'admitted') {
    const verified = status === 'verified';
    const names = q.cites.map((c) => c.measurement).join(', ') || '(nothing)';
    const as = verified ? 'measured' : status === 'stale' ? 'measured from an earlier version of the image' : 'as recorded, not verified';
    const meta = [`model ${q.model ?? 'unknown'}`, cost, ...(q.run_id ? [`run ${q.run_id.slice(0, 8)}`] : []), 'semantic correctness not verified'].join(' · ');
    const rows = q.cites.map((c) => {
      const id = c.handle_id.length > 14 ? `${c.handle_id.slice(0, 11)}…` : c.handle_id;
      const unit = c.unit && c.value !== null && c.value !== undefined ? ` · ${c.unit}` : '';
      return `<dt>${esc(c.measurement)}</dt><dd>${esc(`${plain(c.value)}${unit}`)} <span class="tier">${esc(`${as} · cited as ${id}`)}</span></dd>`;
    }).join('');
    const heading = verified ? `model answer (a claim), citing measured values: ${names}` : `model answer (a claim), citing ${names} (not verified)`;
    return `<section class="qualified"><h4>${esc(heading)}</h4><p class="meta">${esc(meta)}</p>`
      + `${q.question ? `<p class="asked">${esc(`Asked: ${q.question}`)}</p>` : ''}<p class="answer">${q.answer ? claimHtml(q.answer.length > BOARD_ANSWER_CHARS ? `${q.answer.slice(0, BOARD_ANSWER_CHARS)}…` : q.answer) : esc('(no answer text)')}</p>`
      + `${wholeNote('answer', q.answer_truncated, q.answer_bytes, q.answer_full, h)}${wholeNote('raw output', q.raw_output_truncated, q.raw_output_bytes, q.raw_output_full, h)}`
      + `${rows ? `<dl class="cited">${rows}</dl>` : ''}`
      + `<p class="evidence">${esc(verified
        ? "A model's claim: each citation is a handle observed in its run and cited through the cite tool, pointing at a measured value; the answer itself is not a measurement, and whether it is right is not verified."
        : 'Not verified: this answer and its citations are shown as the file records them (see why above); not measurements.')}</p></section>`;
  }
  const why = `${q.status}${q.refusal ? ` (${q.refusal})` : ''}${q.reason ? `: ${q.reason}` : ''}`;
  const raw = q.raw_output
    ? `<p class="meta">${esc('raw output, kept exactly as returned; not a claim')}</p><pre class="raw">${esc(q.raw_output.length > BOARD_ANSWER_CHARS ? `${q.raw_output.slice(0, BOARD_ANSWER_CHARS)}…` : q.raw_output)}</pre>`
      + wholeNote('raw output', q.raw_output_truncated, q.raw_output_bytes, q.raw_output_full, h)
    : '';
  return `<section class="qualified refused"><h4>${esc('no admitted model answer')}</h4><p class="meta">${esc([`model ${q.model ?? 'unknown'}`, cost].join(' · '))}</p><p class="nomodel">${esc(why)}</p>${raw}</section>`;
}

/** The card's provenance, said plainly: verified (by which receipt), or why not. */
function statusBlock(o: BoardObservation): string {
  const c: ObservationCheck = o.check ?? { status: 'unverified', reasons: ['its provenance was not checked'] };
  if (c.status === 'verified') {
    return `<div class="status status-verified"><strong>verified</strong> ${esc(`${c.receipt ? `receipt ${c.receipt}` : 'its observe receipt'} sealed this file, and ${o.source?.path ?? 'its image'} is unchanged since`)}</div>`;
  }
  const lead = c.status === 'stale' ? 'measured from an earlier version of the image; not known to hold for it now' : 'these values are not verified';
  const reasons = c.reasons.length ? c.reasons : ['no reason was given'];
  return `<div class="status status-${c.status === 'stale' ? 'stale' : 'unverified'}"><strong>${c.status === 'stale' ? 'stale' : 'unverified'}</strong> ${esc(lead)}`
    + `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
}

function observationCard(o: BoardObservation, h: ReturnType<typeof render>): string {
  const src = o.source?.path;
  const head = `<div class="obshead">${src && SHOWN_IMAGE.test(src) ? h.thumb(src) : ''}<div>`
    + `${src ? h.fileLink(src) : '<span class="name">(an image outside the project)</span>'}`
    + `<div class="meta">${esc([`observed ${o.madeAt ? utcStamp(o.madeAt) : 'at an unknown time'}`, ...(o.job ? [`job ${o.job}`] : [])].join(' · '))}</div>`
    + `<div class="meta">file ${h.fileLink(o.file, 'file')}</div></div></div>`;
  // Measured: a deterministic value of a verified record. Everything else is shown as recorded, not verified.
  const verified = o.check?.status === 'verified';
  const isMeasured = (m: BoardMeasurement): boolean => verified && !m.malformed && m.tier === DETERMINISTIC;
  const sizeText = o.image ? `${o.image.width} × ${o.image.height} px${o.image.channels !== undefined ? `, ${o.image.channels} channel${o.image.channels === 1 ? '' : 's'}` : ''}` : '';
  const size = sizeText && verified ? `<dt>Image size</dt><dd>${esc(sizeText)}</dd>` : '';
  const rows = o.measurements.filter(isMeasured).map((m) => measurementRow(m, h.live)).join('');
  const others = o.measurements.filter((m) => !isMeasured(m));
  const measured = verified
    ? `<section class="measured"><h4>measured (deterministic computation)</h4>${size || rows ? `<dl>${size}${rows}</dl>` : '<p class="empty">No measurements in this record.</p>'}</section>`
    : '';
  const recordedSize = sizeText && !verified ? `<dt>image size</dt><dd>${esc(sizeText)} <span class="tier">as recorded</span></dd>` : '';
  const unverifiedHeading = o.check?.status === 'stale'
    ? 'not verified for the image as it is now: values from an earlier version of it'
    : 'not verified: values as the file records them, not measurements';
  const unverified = others.length || recordedSize
    ? `<section class="unverified"><h4>${esc(unverifiedHeading)}</h4><dl>${recordedSize}${others.map((m) => unverifiedRow(m, verified)).join('')}</dl></section>`
    : '';
  const i = o.interpretation;
  let model = '';
  if (i && i.status === 'answered') {
    const meta = [`model ${i.model ?? 'unknown'}`, i.cost_usd !== undefined ? `cost $${i.cost_usd.toFixed(4)}` : 'cost not reported'].join(' · ');
    model = `<section class="claim"><h4>${esc("the model's claim")}</h4><p class="meta">${esc(meta)}</p>`
      + `${i.question ? `<p class="asked">${esc(`Asked: ${i.question}`)}</p>` : ''}<p class="answer">${i.answer ? claimHtml(i.answer.length > BOARD_ANSWER_CHARS ? `${i.answer.slice(0, BOARD_ANSWER_CHARS)}…` : i.answer) : esc('(no answer text)')}</p>${i.answer && i.answer.length > BOARD_ANSWER_CHARS ? `<p class="meta">${esc(`${i.answer.length - BOARD_ANSWER_CHARS} more characters in the observation file`)}</p>` : ''}`
      + wholeNote('answer', i.answer_truncated, i.answer_bytes, i.answer_full, h)
      + `${evidenceLine(i.evidence, o.check?.status, new Set(o.measurements.filter((m) => !m.malformed && m.tier === DETERMINISTIC).map((m) => m.name)))}</section>`;
  } else if (i) {
    model = `<p class="nomodel">${esc(`No model claim: ${i.status}${i.model ? ` (${i.model})` : ''}${i.reason ? `: ${i.reason}` : ''}`)}</p>`;
  }
  const qualified = o.qualified ? qualifiedBlock(o.qualified, o.check?.status, h) : '';
  return `<article class="card obs">${head}${statusBlock(o)}${measured}${unverified}${model}${qualified}${src && SHOWN_IMAGE.test(src) ? h.act('Observe again', { act: 'observe', file: src }) : ''}${h.cmds([`/open ${o.file}`, ...(src ? [`/observe ${h.quoted(src)}`] : [])])}</article>`;
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: ${HOMEBREW.ground}; color: ${HOMEBREW.text}; font-family: ${TYPE.stack}; font-size: ${TYPE.size.body}px; line-height: ${TYPE.lineHeight}; }
header, main, footer { max-width: 1280px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 24px; }
h1 { font-size: 22px; font-weight: ${TYPE.weight.heading}; margin: 0 0 4px; }
h1 .project { color: ${HOMEBREW.accent}; }
.sub { color: ${HOMEBREW.textSecondary}; margin: 0 0 12px; }
.toc { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 0 14px; border-bottom: 1px solid ${HOMEBREW.line}; }
.toc a { color: ${HOMEBREW.text}; text-decoration: none; text-transform: uppercase; letter-spacing: .06em; font-size: ${TYPE.size.small}px; }
.toc a:hover, .toc a:focus-visible { color: ${HOMEBREW.accent}; }
.toc b { color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; }
h2 { font-size: ${TYPE.size.h1}px; font-weight: ${TYPE.weight.heading}; margin: 28px 0 12px; text-transform: uppercase; letter-spacing: .08em; }
h3 { font-size: ${TYPE.size.h2}px; font-weight: ${TYPE.weight.strong}; margin: 20px 0 10px; text-transform: uppercase; letter-spacing: .06em; color: ${HOMEBREW.textSecondary}; }
.count { color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(250px, 100%), 1fr)); gap: 12px; }
.grid.wide { grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr)); }
.card { background: ${HOMEBREW.surface}; border: 1px solid ${HOMEBREW.line}; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.name, .file, .label { overflow-wrap: anywhere; }
a { color: ${HOMEBREW.link}; }
a.name { font-weight: ${TYPE.weight.strong}; text-decoration: none; }
a.name:hover, a.name:focus-visible { text-decoration: underline; }
.thumb { display: block; background: ${HOMEBREW.raised}; border-radius: 6px; overflow: hidden; }
.thumb img { display: block; width: 100%; height: 160px; object-fit: contain; }
.obshead { display: grid; grid-template-columns: minmax(0, 120px) minmax(0, 1fr); gap: 12px; align-items: start; }
.obshead .thumb img { height: 96px; }
.meta { color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.kind { display: inline-block; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 999px; padding: 0 7px; margin-right: 4px; text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.text}; }
.cmds { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
.cmd { font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.accent}; background: ${HOMEBREW.raised}; border: 1px solid ${HOMEBREW.line}; border-radius: 6px; padding: 3px 8px; cursor: copy; text-align: left; max-width: 100%; overflow-wrap: anywhere; }
.cmd code { font: inherit; }
.cmd:hover, .cmd:focus-visible { border-color: ${HOMEBREW.accent}; outline: none; }
.cmd[data-copied]::after { content: "  copied"; color: ${HOMEBREW.textSecondary}; }
.blocks { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; }
.blocks li::marker { color: ${HOMEBREW.textSecondary}; }
.block { font-weight: ${TYPE.weight.strong}; margin-right: 8px; }
.deps { color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; margin-right: 8px; }
.blocks .cmd { margin-left: 2px; }
.jobhead { display: flex; justify-content: space-between; gap: 8px; }
.state { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; color: ${HOMEBREW.textSecondary}; }
.state-failed { color: ${HOMEBREW.failure}; }
.state-running, .state-queued { color: ${HOMEBREW.attention}; }
section.measured, section.claim, section.unverified, section.qualified { border-left: 3px solid ${HOMEBREW.lineStrong}; padding: 2px 0 2px 10px; }
section.qualified { border-left-color: ${HOMEBREW.ai}; border-left-style: double; }
section.qualified h4 { color: ${HOMEBREW.ai}; }
section.qualified.refused { border-left-color: ${HOMEBREW.attention}; }
section.qualified.refused h4 { color: ${HOMEBREW.attention}; }
.qualified .meta { margin: 0; }
.qualified dl.cited { margin-top: 6px; }
pre.raw { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
section.claim { border-left-color: ${HOMEBREW.ai}; }
section.unverified { border-left-style: dashed; border-left-color: ${HOMEBREW.attention}; }
h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: ${HOMEBREW.textSecondary}; }
section.claim h4 { color: ${HOMEBREW.ai}; }
section.unverified h4 { color: ${HOMEBREW.attention}; }
section.unverified dd { color: ${HOMEBREW.textSecondary}; }
.tier { font-size: 11px; color: ${HOMEBREW.textSecondary}; font-style: italic; margin-left: 6px; }
.status { font-size: ${TYPE.size.small}px; margin: 0; overflow-wrap: anywhere; }
.status strong { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; margin-right: 6px; }
.status-verified strong { color: ${HOMEBREW.accent}; }
.status-unverified strong, .status-stale strong { color: ${HOMEBREW.attention}; }
.status .reasons { margin: 4px 0 0; padding-left: 18px; color: ${HOMEBREW.textSecondary}; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0; font-size: ${TYPE.size.small}px; }
dt { color: ${HOMEBREW.textSecondary}; }
dd { margin: 0; overflow-wrap: anywhere; }
.color { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; white-space: nowrap; }
.swatch { display: inline-block; width: 14px; height: 14px; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }
.qr { color: ${HOMEBREW.text}; }
.asked { color: ${HOMEBREW.textSecondary}; margin: 0; font-size: ${TYPE.size.small}px; }
.answer { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.answer code, .answer strong { font: inherit; font-weight: 600; }
.claim .meta { margin: 0; }
.evidence { margin: 6px 0 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; overflow-wrap: anywhere; }
.evidence.none { font-style: italic; }
.nomodel { color: ${HOMEBREW.attention}; font-size: ${TYPE.size.small}px; margin: 0; }
.empty, .more { color: ${HOMEBREW.textSecondary}; margin: 0; }
.more { margin-top: 10px; }
footer { color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; padding-top: 32px; padding-bottom: 32px; }
@media (max-width: 520px) { .obshead { grid-template-columns: minmax(0, 1fr); } h1 { font-size: 19px; } }
${FLOWS_CSS}`;

/** Copies a command when it is clicked; where the clipboard is refused, selects it to copy by hand. */
const SCRIPT = `
document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
  if (!b) return;
  var c = b.getAttribute('data-cmd');
  var shown = function () { b.setAttribute('data-copied', ''); setTimeout(function () { b.removeAttribute('data-copied'); }, 1400); };
  var select = function () { var s = window.getSelection(); if (s) s.selectAllChildren(b); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c).then(shown, select); else select();
});
`;

/** The board's table of contents and main sections: the snapshot's body, and what the live board's state carries. */
export function renderBoardBody(input: BoardInput): { toc: string; main: string } {
  const h = render(input);
  const k = kit({ live: h.live, base: input.base });
  const grid = (cards: string[], wide = false): string => `<div class="grid${wide ? ' wide' : ''}">${cards.join('')}</div>`;
  const heading = (id: string, label: string, n: number): string => `<h2 id="${id}">${esc(label)} <span class="count">${n}</span></h2>`;
  const total = (part: BoardPart, shown: number): number => shown + (input.more?.[part] ?? 0);
  const counts: Array<[BoardPart, string, number]> = [
    ['references', 'References', total('references', input.references.length)],
    ['workflows', 'Workflows', total('workflows', input.workflows.length)],
    ['jobs', 'Jobs', total('jobs', input.jobs.length)],
    ...(input.results ? [['results', 'Results', total('results', input.results.length)] as [BoardPart, string, number]] : []),
    ['outputs', 'Outputs', total('outputs', input.outputs.length)],
    ['observations', 'Observations', total('observations', input.observations.length)],
  ];
  const n = Object.fromEntries(counts.map(([k, , c]) => [k, c])) as Record<BoardPart, number>;
  const params = input.params ? '<a href="#parameters">Parameters</a>' : '';
  const flows = input.flows ? flowsSection(input.flows, { live: h.live, base: input.base }) : undefined;
  const vox = input.vox ? voxSection(input.vox, { kit: k, base: input.base }) : undefined;
  return {
    toc: `<nav class="toc">${counts.slice(0, 2).map(([id, label, c]) => `<a href="#${id}">${esc(label)} <b>${c}</b></a>`).join('')}${params}${counts.slice(2).map(([id, label, c]) => `<a href="#${id}">${esc(label)} <b>${c}</b></a>`).join('')}${flows?.toc ?? ''}${vox?.toc ?? ''}</nav>`,
    main: [
      heading('references', 'References', n.references),
      input.references.length ? grid(input.references.map((f) => referenceCard(f, h))) : h.empty('No references yet: /add <file> copies a file into refs/.'),
      h.more('references', '/files references'),
      heading('workflows', 'Workflows', n.workflows),
      input.workflows.length ? grid(input.workflows.map((w) => renderWorkflowCard(w, k)), true) : h.empty('No workflows yet: write Markdown with a named block (```bash [name:build]), then /workflows.'),
      h.more('workflows', '/workflows'),
      ...(input.params ? ['<h2 id="parameters">Parameters</h2>', `<div class="grid wide">${renderParamsCard(input.params, k)}</div>`] : []),
      heading('jobs', 'Jobs', n.jobs),
      input.jobs.length ? grid(input.jobs.map((j) => jobCard(j, h))) : h.empty('No jobs yet: /run <file> <block> starts a workflow; /preview serves the project.'),
      h.more('jobs', '/jobs'),
      '<h2 id="results">Results</h2>',
      ...(input.results ? [
        `<h3 id="result-cards">Recent results <span class="count">${n.results}</span></h3>`,
        input.results.length ? renderResultCards(input.results, k) : h.empty('No results yet: a recipe, a workflow run, a native app, a code agent or /observe makes one.'),
        h.more('results', '/results'),
      ] : []),
      `<h3 id="outputs">Outputs <span class="count">${n.outputs}</span></h3>`,
      input.outputs.length ? grid(input.outputs.map((f) => outputCard(f, h))) : h.empty('No outputs yet: a build writes them (dist/, build/, out/, outputs/).'),
      h.more('outputs', '/files outputs'),
      `<h3 id="observations">Observations <span class="count">${n.observations}</span></h3>`,
      input.observations.length ? grid(input.observations.map((o) => observationCard(o, h)), true) : h.empty('No observations yet: /observe <image>'),
      h.more('observations', '/results'),
      flows?.html ?? '',
      vox?.html ?? '',
    ].join('\n'),
  };
}

/** The board's stylesheet, shared by the snapshot and the live board's page (R4: with the new cards' rules). */
export const BOARD_CSS = CSS + CARDS_CSS + NODES_CSS + VOX_CSS;

/** The board as one self-contained HTML page. */
export function renderBoard(input: BoardInput): string {
  const { toc, main } = renderBoardBody({ ...input, live: false });
  const title = `Board · ${input.project}`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${BOARD_CSS}</style>`,
    '</head>',
    '<body>',
    '<header>',
    `<h1>Board · <span class="project">${esc(input.project)}</span></h1>`,
    `<p class="sub">${esc(`read-only snapshot, made ${input.madeAt}; act with the commands shown`)}</p>`,
    `<p class="sub">${esc('A green command copies itself when clicked: paste it into Timmy. Links open the files themselves.')}</p>`,
    toc,
    '</header>',
    '<main>',
    main,
    '</main>',
    `<footer>${esc(`Made by /board from ${input.project}: a snapshot, not a live view; /board again makes a new one. Measured values are deterministic computations on the pixels, shown as measured only when an observe receipt sealed the file and its image is unchanged; a model's claim is not a measurement.`)}</footer>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
