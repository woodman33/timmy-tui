/**
 * Round R4 (H75): what Timmy Canvas's own drawn cards show (companion/studio-canvas/src/cards.js), built from the SAME readers
 * the board uses and nothing of its own. GET /api/project?detail=1 (src/studio/project-link.ts) gives each project card a
 * `detail` in one of three shapes:
 *
 *   workflow  a workflow document's blocks in order with their live states (connectWorkflow's nodes, as the board draws its
 *             graph), its newest run with each block's state, the run's outcome receipt and what its files are now
 *   params    a parameter file's values with their units, meanings and ranges (the tray recipe's paramsCard, an OpenSCAD
 *             model's readScadParams), the sha256 a save must still find, whether the live board's save path takes it, and
 *             for the tray recipe its newest build (the board's own recipe result card, recipeResults)
 *   result    a flow (readBoardFlows), a VoxVision record (readBoardVox) or a Control Room run (gatherRoom): the outcome and
 *             verdict in words, whether a receipt verifies the record now (verified, stale or not), its outputs each with the
 *             sha256 it was written with and what the file is now, labelled facts, and the images the board shows
 *
 * Nothing here writes, runs or seals. Every string goes through the caller's `t` (src/studio/project-cards.ts cardText: the
 * project's folder as ".", the home folder as "~", any other absolute path as <path>); paths are project-relative.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mm3Text, mmText, toleranceText } from '../flows/iterate.js';
import type { ScadParamsRead, ScadValue } from '../native/scad-params.js';
import { DOCTRINE_15, PARAMETER_HELP, PARAMETER_NAMES } from '../recipes/index.js';
import type { ParamsCard, ResultCard } from '../repl/board-cards.js';
import type { BoardFlow } from '../repl/board-flows.js';
import type { WorkflowDocInput } from '../repl/board-nodes.js';
import type { VoxCard } from '../repl/board-vox.js';
import { NODE_GLYPH, type NodeWord } from '../repl/board-workflows.js';
import type { RoomRun } from '../room/index.js';
import { blockDetail } from '../workflows/run-blocks.js';

/** One line of text for a card (cardText bound to the project). */
export type Text = (v: unknown, max?: number) => string;
/** A colour for the outcome words: they stay in the text colour unless they failed or need attention (R4 H46). */
export type Tone = 'ok' | 'failed' | 'running' | 'attention' | 'neutral';

export interface DetailBlock {
  name: string;
  /** upmd's block number in the document (unique) */
  key: string;
  word: string;
  glyph: string;
  /** exit code and own time, in words */
  detail: string;
  needs: string[];
  /** the block can be written as /run's second argument (and the document as its first) */
  runnable: boolean;
  /** its command's first lines (technical detail) */
  command: string[];
}

export interface WorkflowDetail {
  type: 'workflow';
  doc: string;
  /** the document's sha256 as the server read it now */
  sha256: string | null;
  /** the document can be written as /run's first argument */
  runnable: boolean;
  blocks: DetailBlock[];
  /** the newest run of the document */
  last: null | {
    job: string; target: string; word: string; met: boolean | null; receipt: string | null; predicted: string | null;
    startedAt: string; endedAt: string | null; took: string | null; error: string | null; note: string | null;
    blocks: Array<{ name: string; word: string; glyph: string; detail: string }>;
    outputs: Array<{ path: string; now: string }>; more: number;
  };
  /** the newest run is still going */
  running: boolean;
}

export interface DetailValue {
  name: string;
  value: number | string | boolean;
  kind: 'number' | 'text' | 'boolean';
  unit?: string;
  help?: string;
  /** the recipe's own default, when it differs from the value */
  default?: number;
}

/** A result as the board's result card says it (src/repl/board-cards.ts ResultCard), scrubbed. */
export interface BoardResult {
  title: string;
  at: string | null;
  word: string;
  tone: Tone;
  detail: string;
  facts: Array<{ label: string; value: string; how: string }>;
  files: Array<{ path: string; note: string }>;
  receipts: string[];
  notice: string | null;
}

export interface ParamsDetail {
  type: 'params';
  engine: 'tray' | 'scad';
  file: string;
  state: 'ok' | 'none' | 'unusable';
  error: string | null;
  /** what a save must still find: the file's sha256 (64 hex), null when there is no file, 'unreadable' when it cannot be hashed */
  base: string | null;
  recipe: string | null;
  model: string | null;
  values: DetailValue[];
  more: number;
  fixed: string | null;
  units: string | null;
  /** whether the live board's save path takes this file (the REPL checks again), and why not */
  save: { offered: boolean; why: string | null };
  /** Rebuild: the live board's rebuild action (the tray recipe's /recipe) */
  rebuild: boolean;
  /** how to run it by hand: /recipe tray, /scad <model> */
  run: string;
  /** the tray recipe's newest build, as the board's recipe result card says it */
  build: BoardResult | null;
  notice: string | null;
}

export interface ResultDetail {
  type: 'result';
  source: 'flow' | 'vox' | 'run';
  verdict: { word: string; tone: Tone; words: string };
  /** whether a receipt verifies the record now: verified, stale (changed since it was sealed), unverified, or none (not
   *  checked); `words` say the rest (the card puts the status word before them) */
  check: { status: 'verified' | 'stale' | 'unverified' | 'none'; words: string; receipt: string | null };
  outputs: Array<{ path: string; sha256: string | null; bytes: number | null; now: string }>;
  facts: Array<{ label: string; value: string; how: string }>;
  /** the images the board shows for it (VoxVision highlights of a verified or stale record), served by GET /api/project/image */
  images: Array<{ path: string; type: string }>;
  lines: string[];
  started: string | null;
  ended: string | null;
  notice: string | null;
}

export type CardDetail = WorkflowDetail | ParamsDetail | ResultDetail;

const oneWord = (s: string): boolean => s.length > 0 && !/\s/.test(s);
const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(num);
const OUTPUTS = 12;
const HASH_LIMIT = 8 * 1024 * 1024;

/** A path inside the project as '/'-separated parts, or null (absolute, a URL, or one that climbs out). */
export function inProject(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

const hashes = new Map<string, { size: number; mtime: number; sha: string }>();
/** A project file's sha256 now (kept by size and time), or why not: never through a link, never past 8 MB. */
export function shaNow(root: string, rel: string): { sha: string; bytes: number } | { why: 'gone' | 'large' | 'link' | 'unreadable' } {
  const abs = join(root, ...rel.split('/'));
  let st;
  try { st = lstatSync(abs); } catch { return { why: 'gone' }; }
  if (st.isSymbolicLink()) return { why: 'link' };
  if (!st.isFile()) return { why: 'gone' };
  if (st.size > HASH_LIMIT) return { why: 'large' };
  const kept = hashes.get(abs);
  if (kept && kept.size === st.size && kept.mtime === st.mtimeMs) return { sha: kept.sha, bytes: st.size };
  try {
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
    hashes.set(abs, { size: st.size, mtime: st.mtimeMs, sha });
    if (hashes.size > 512) hashes.delete(hashes.keys().next().value!);
    return { sha, bytes: st.size };
  } catch { return { why: 'unreadable' }; }
}

/** What a written file is now, beside the sha256 it was written with: in words. */
function nowWords(root: string, rel: string, sealed: string | null, by: string): { now: string; sha: string | null; bytes: number | null } {
  const now = shaNow(root, rel);
  if (!('sha' in now)) {
    const why = now.why === 'gone' ? 'not there now' : now.why === 'large' ? 'there now, larger than 8 MB: not compared' : now.why === 'link' ? 'a link now: not read' : 'there now, but unreadable';
    return { now: why, sha: null, bytes: null };
  }
  if (sealed === null) return { now: `there now (sha256 ${now.sha.slice(0, 12)}); ${by} names no sha256 to compare it with`, sha: null, bytes: now.bytes };
  return { now: now.sha === sealed ? `as ${by} wrote it` : `changed since ${by} wrote it (now sha256 ${now.sha.slice(0, 12)})`, sha: sealed, bytes: now.bytes };
}

const firstLines = (code: string | undefined, n: number, t: Text): string[] => {
  const lines = String(code ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() !== '');
  return start < 0 ? [] : lines.slice(start, start + n).map((l) => t(l, 160));
};
const glyph = (w: string): string => NODE_GLYPH[w as NodeWord] ?? '?';
const seconds = (ms: number | undefined): string | null => (num(ms) ? `${(ms / 1000).toFixed(1)} s` : null);

// ── the workflow card ─────────────────────────────────────────────────────────

/** A workflow document as the board connects it (connectWorkflow): its blocks with their states and its newest run. */
export function workflowDetail(w: WorkflowDocInput, t: Text): WorkflowDetail {
  const c = w.connected;
  const docOk = oneWord(w.rel);
  const byName = new Map(w.blocks.map((b) => [b.name, b]));
  const nodes = c?.nodes ?? w.blocks.map((b, i) => ({ key: String(b.index ?? `p${i + 1}`), name: b.name, word: 'not run yet' as NodeWord, detail: '', command: b.code }));
  const blocks: DetailBlock[] = nodes.slice(0, 64).map((n) => ({
    name: t(n.name, 80), key: t(n.key, 12), word: n.word, glyph: glyph(n.word), detail: t(n.detail, 120),
    needs: (byName.get(n.name)?.deps ?? []).slice(0, 16).map((d) => t(d, 80)),
    runnable: docOk && oneWord(n.name),
    command: firstLines(n.command ?? byName.get(n.name)?.code, 3, t),
  }));
  const run = c ? c.runs.find((r) => r.job === c.latest) ?? null : null;
  const last: WorkflowDetail['last'] = run ? {
    job: t(run.job, 40), target: t(run.target, 80), word: t(run.word, 40), met: typeof run.met === 'boolean' ? run.met : null,
    receipt: run.receipt ? t(run.receipt, 40) : null, predicted: run.predicted ? t(run.predicted, 40) : null,
    startedAt: t(run.startedAt, 40), endedAt: run.endedAt ? t(run.endedAt, 40) : null, took: seconds(run.ms),
    error: run.error ? t(run.error, 300) : null, note: run.note ? t(run.note, 300) : null,
    blocks: run.blocks.slice(0, 64).map((b) => ({ name: t(b.name, 80), word: b.word, glyph: glyph(b.word), detail: t(blockDetail(b), 120) })),
    outputs: run.outputs.slice(0, OUTPUTS).map((o) => ({ path: t(o.rel, 300), now: t(o.note, 120) })), more: run.outputsMore,
  } : null;
  return {
    type: 'workflow', doc: t(w.rel, 300), sha256: w.sha256 ?? null, runnable: docOk, blocks, last,
    running: !!run && (run.word === 'running' || run.word === 'starting'),
  };
}

// ── the parameter card ───────────────────────────────────────────────────────

/** A result card of the board (the recipe's), scrubbed to plain strings. */
export function boardResult(r: ResultCard, t: Text): BoardResult {
  return {
    title: t(r.title, 160), at: r.at ? t(r.at, 40) : null, word: t(r.status.word, 40), tone: r.status.tone, detail: t(r.status.detail ?? '', 300),
    facts: (r.facts ?? []).slice(0, 12).map((f) => ({ label: t(f.label, 60), value: t(f.value, 160), how: t(f.how, 200) })),
    files: (r.files ?? []).slice(0, OUTPUTS).map((f) => ({ path: t(f.rel, 300), note: t(f.note ?? '', 60) })),
    receipts: (r.receipts ?? []).slice(0, 6).map((x) => t(`${x.id}${x.what ? ` (${x.what})` : ''}`, 80)),
    notice: r.notice ? t(r.notice, 300) : null,
  };
}

/** The tray recipe's parameter file, as the board's parameter card reads it, with its newest build. */
export function trayDetail(p: ParamsCard, build: ResultCard | undefined, t: Text): ParamsDetail {
  const f = p.file;
  return {
    type: 'params', engine: 'tray', file: t(p.path, 300), state: f.state, error: f.state === 'unusable' ? t(f.error, 300) : null,
    base: f.state === 'none' ? null : f.state === 'ok' ? f.sha256 : f.sha256 ?? 'unreadable',
    recipe: t(p.recipe, 40), model: null,
    values: PARAMETER_NAMES.map((n) => ({
      name: n, value: p.values[n], kind: 'number' as const, unit: 'mm', help: t(PARAMETER_HELP[n], 200),
      ...(p.values[n] !== p.defaults[n] ? { default: p.defaults[n] } : {}),
    })),
    more: 0, fixed: Object.entries(p.fixed).map(([n, v]) => `${n} ${fmt(v)}`).join(', ') || null, units: t(p.units, 80),
    // The live board always shows the tray recipe's card, so its save path takes this file (the REPL checks it again).
    save: { offered: true, why: null }, rebuild: true, run: `/recipe ${t(p.recipe, 40)}`,
    build: build ? boardResult(build, t) : null, notice: DOCTRINE_15,
  };
}

const kindOf = (v: ScadValue): DetailValue['kind'] => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text');

/**
 * An OpenSCAD model's parameter file. `editable`: a workflow block names it, so the live board shows its form and its save
 * (set-scad-params) takes it; the board has no Rebuild for OpenSCAD (the typed /scad runs it).
 */
export function scadDetail(model: string, file: string, read: ScadParamsRead, editable: boolean, t: Text): ParamsDetail {
  const state: ParamsDetail['state'] = !read.ok ? 'unusable' : read.exists ? 'ok' : 'none';
  const entries = read.ok && read.exists ? Object.entries(read.parameters) : [];
  const why = !editable ? `no workflow block names ${file}: the live board saves an OpenSCAD parameter file only from a workflow card that shows it`
    : state === 'none' ? `${file} is not there yet: the live board saves into an existing file`
      : state === 'unusable' ? `${file} is not usable: the live board saves only a usable file` : null;
  return {
    type: 'params', engine: 'scad', file: t(file, 300), state, error: !read.ok ? t(read.error, 300) : null,
    base: read.ok && read.exists ? read.sha256 : !read.ok ? read.sha256 ?? 'unreadable' : null,
    recipe: null, model: t(model, 300),
    values: entries.slice(0, 40).map(([name, value]) => ({ name: t(name, 80), value: typeof value === 'string' ? t(value, 400) : value, kind: kindOf(value) })),
    more: Math.max(0, entries.length - 40), fixed: null, units: null,
    save: { offered: why === null, why: why === null ? null : t(why, 300) }, rebuild: false, run: oneWord(model) ? `/scad ${t(model, 300)}` : `/open ${t(file, 300)}`,
    build: null, notice: null,
  };
}

// ── the result card ──────────────────────────────────────────────────────────

/** A flow: its outcome, the readback's verdict with what it measured, its rebuild's outputs, and whether its receipt verifies it now. */
export function flowResult(f: BoardFlow, root: string, t: Text): ResultDetail {
  const rec = f.record;
  if (f.live) {
    const step = typeof (rec as unknown as { step?: unknown }).step === 'string' ? `its ${(rec as unknown as { step: string }).step} step` : 'a step its state file does not name';
    return {
      type: 'result', source: 'flow', verdict: { word: 'running', tone: 'running', words: t(`running: ${step}, as its state file says (written ${f.live.written})`) },
      check: { status: 'none', words: 'a running flow has no record yet: its state file is shown, and no receipt seals it', receipt: null },
      outputs: [], facts: [], images: [], lines: [t(rec.instruction ?? '', 300)].filter(Boolean), started: rec.started_at ? t(rec.started_at, 40) : null, ended: null, notice: null,
    };
  }
  const verified = f.check.status === 'verified';
  const k = rec.readback;
  const outcome = String(rec.outcome ?? 'unknown');
  const facts: ResultDetail['facts'] = [];
  if (k) facts.push({ label: 'verdict', value: t(k.verdict ?? 'none', 40), how: t(`the readback (${k.state})${k.tolerance ? `, tolerance ${toleranceText(k.tolerance)}` : ''}`, 200) });
  const m = k?.measured;
  const measured = !!m && triple(m.bounds_mm) && num(m.volume_mm3);
  if (measured) {
    facts.push({
      label: 'measured', value: `${mmText(m!.bounds_mm)} mm, ${mm3Text(m!.volume_mm3)} mm3`,
      how: verified ? 'measured from the CAD file: the delivered STEP read back in its own process; a measurement of the file, not of a physical part' : 'measured from the CAD file, as the record says (not verified)',
    });
  }
  const p = rec.rebuild?.predicted;
  if (p && triple(p.bounds_mm) && num(p.volume_mm3)) facts.push({ label: 'predicted', value: `${mmText(p.bounds_mm)} mm, ${mm3Text(p.volume_mm3)} mm3`, how: 'in the sealed prediction' });
  const outputs = (rec.rebuild?.outputs ?? []).slice(0, OUTPUTS).flatMap((o) => {
    const rel = inProject(o.path);
    if (!rel) return [];
    const w = nowWords(root, rel, typeof o.sha256 === 'string' ? o.sha256 : null, 'the flow');
    return [{ path: t(rel, 300), sha256: w.sha, bytes: num(o.bytes) ? o.bytes : w.bytes, now: t(w.now, 160) }];
  });
  const tone: Tone = outcome === 'failed' || k?.verdict === 'differs' || k?.verdict === 'failed' ? 'failed' : outcome === 'succeeded' ? 'ok' : 'attention';
  return {
    type: 'result', source: 'flow',
    verdict: { word: t(outcome, 40), tone, words: t(`${outcome}${k?.verdict ? `, readback ${k.verdict}` : ''}${verified ? '' : ' (as the file says)'}`, 200) },
    check: verified
      ? { status: 'verified', words: t(`receipt ${f.check.receipt} sealed these bytes`, 200), receipt: f.check.receipt ? t(f.check.receipt, 40) : null }
      : { status: 'unverified', words: t(f.check.reasons.join('; ') || 'no reason was given', 400), receipt: null },
    outputs, facts, images: [], lines: [t(rec.instruction ?? '', 300)].filter(Boolean),
    started: rec.started_at ? t(rec.started_at, 40) : null, ended: rec.ended_at ? t(rec.ended_at, 40) : null,
    notice: measured ? DOCTRINE_15 : null,
  };
}

/** What the board prints for a value it shows. */
const plain = (v: unknown): string => (v === null || v === undefined ? 'not measured' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A VoxVision record: its status, its check, its labelled metrics, its highlights (the images the board shows) and its files. */
export function voxResult(v: VoxCard, receipt: string | null, root: string, t: Text): ResultDetail {
  const status = v.check.status;
  const checkWords = status === 'verified' ? `receipt ${receipt ?? '?'} sealed it` : v.check.reasons.join('; ') || 'no reason was given';
  const facts = [...v.metrics, ...v.claims].slice(0, 16).map((m) => ({
    label: t(m.title || m.name, 80), value: t(`${plain(m.value)}${m.unit ? ` ${m.unit}` : ''}${m.of ? ` (of ${m.of})` : ''}`, 160),
    how: t(m.said ? `${m.said.word}${m.said.note ? `: ${m.said.note}` : ''}` : m.tier ?? m.method ?? 'as the record says', 300),
  }));
  const shown = status === 'unverified' ? [] : v.highlights.filter((h) => h.shown);
  const outputs = v.highlights.slice(0, OUTPUTS).flatMap((h) => {
    const rel = inProject(h.path);
    if (!rel) return [];
    const w = nowWords(root, rel, typeof h.sha256 === 'string' ? h.sha256 : null, 'the record');
    return [{ path: t(rel, 300), sha256: w.sha, bytes: w.bytes, now: t(w.now, 160) }];
  });
  const failed = v.failures.length > 0;
  return {
    type: 'result', source: 'vox',
    verdict: { word: t(v.status, 40), tone: failed ? 'failed' : status === 'verified' ? 'ok' : 'attention', words: t(`${v.action} · ${v.status}${failed ? ` · ${v.failures.length} failure${v.failures.length === 1 ? '' : 's'}` : ''}`, 200) },
    check: { status, words: t(checkWords, 400), receipt: status === 'verified' && receipt ? t(receipt, 40) : null },
    outputs, facts,
    images: shown.slice(0, 6).map((h) => ({ path: t(h.path, 300), type: h.type === 'image/svg+xml' || /\.svg$/i.test(h.path) ? 'image/svg+xml' : 'image/png' })),
    lines: [
      ...(v.inputs.length ? [t(`inputs: ${v.inputs.map((i) => `${i.path}${i.kind ? ` (${i.kind})` : ''}`).join(', ')}`, 300)] : []),
      ...v.failures.slice(0, 4).map((x) => t(`${x.tool}: ${x.code}: ${x.message}`, 300)),
    ],
    started: v.madeAt ? t(v.madeAt, 40) : null, ended: null,
    notice: v.doctrine || v.inputs.some((i) => ['stl', 'step', 'blend', 'ply'].includes(String(i.kind))) ? DOCTRINE_15 : null,
  };
}

/** A Control Room run: its state, owner, route, cost as recorded, receipt as its record names it, and its outputs now. */
export function runResult(r: RoomRun, root: string, t: Text): ResultDetail {
  const facts: ResultDetail['facts'] = [
    { label: 'owner', value: t(r.owner, 120), how: r.role ? t(`role ${r.role}`, 80) : 'role not recorded' },
    ...(r.harness ? [{ label: 'harness', value: t(r.harness, 120), how: 'as recorded' }] : []),
    ...(r.model ? [{ label: 'model', value: t(r.model, 120), how: r.endpoint ? `${r.endpoint} endpoint` : 'endpoint not recorded' }] : []),
    { label: 'route', value: t(r.route, 200), how: 'the route rule, in words' },
    { label: 'cost', value: r.cost.kind === 'known' && num(r.cost.usd) ? `$${r.cost.usd}` : r.cost.kind, how: t(r.cost.words, 200) },
    ...(r.elapsed ? [{ label: 'time', value: t(r.elapsed, 40), how: r.running ? 'so far' : 'as recorded' }] : []),
  ];
  const outputs = r.outputs.slice(0, OUTPUTS).flatMap((o) => {
    const rel = inProject(o.path);
    if (!rel) return [];
    const w = nowWords(root, rel, null, 'its record');
    return [{ path: t(rel, 300), sha256: null, bytes: w.bytes, now: t(`${o.role}: ${w.now}`, 200) }];
  });
  const missing = (r.missing ?? []).slice(0, 6).map((m) => t(`${m.role} ${m.path}: ${m.words}`, 200));
  const tone: Tone = r.tone === 'failed' ? 'failed' : r.tone === 'running' ? 'running' : r.tone === 'attention' ? 'attention' : r.tone === 'ok' ? 'ok' : 'neutral';
  return {
    type: 'result', source: 'run',
    verdict: { word: t(r.state, 40), tone, words: t(`${r.state}${r.step ? ` · ${r.step}` : ''}${r.progress ? ` · ${r.progress}` : ''}`, 300) },
    // The Control Room names a run's receipt as its record does; it is not checked here.
    check: { status: 'none', words: r.receipt ? t(`its record names receipt ${r.receipt}; not checked against the chain here`, 200) : 'no receipt is recorded for it', receipt: r.receipt ? t(r.receipt, 40) : null },
    outputs, facts, images: [], lines: [...(r.recordNote ? [t(r.recordNote, 300)] : []), ...missing],
    started: r.startedAt ? t(r.startedAt, 40) : null, ended: r.endedAt ? t(r.endedAt, 40) : null, notice: null,
  };
}
