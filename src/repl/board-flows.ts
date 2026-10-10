/**
 * The board's Flows section (round R4, /iterate, helper H24): each flow record (results/flows/<flow-id>.json) as
 * a card: the instruction, the parameters before and after (changed values marked), each step's state, the
 * readback's verdict with the values it measured from the CAD file, the editable artifacts as file links (the
 * STEP, the STLs, the parameter file) and the receipts. src/repl/board.ts draws the section from here.
 *
 * A record is an editable file, so a card is verified only when a sealed `flow` receipt of this project names
 * exactly its bytes (its sha256); otherwise its values are shown as recorded, not verified, and the card says
 * why. A measured value is never drawn without the words "measured from the CAD file" and DOCTRINE §15's
 * sentence: the readback measures the file, never a physical part. Every string is escaped; a path from a
 * record becomes a link only when it is inside the project.
 *
 * Round R4 (H40, review R4-4): a record that passes the schema and id check can still hold parts in a form Timmy does
 * not write (a hand edit, an older or newer Timmy, a merge resolved by hand). A list that is not a list, or entries that
 * are not Timmy's, are left out of the card and the card says so; and each card is drawn inside a guard, so a record
 * that still cannot be drawn becomes an "unreadable record" card naming its file and why, never a failure of the whole
 * section (the board snapshot, the live board's state).
 *
 * Round R4 (H45): every card has a step strip (each step's state in words, the step it ended in marked; board-steps.ts),
 * keeps its summary in view (the instruction, the outcome, the verdict with who measured what in one line, the key
 * before → after numbers, the artifacts with their /open commands) and puts the long parts in <details> (the checks with
 * their scope and DOCTRINE §15, the change in full, the steps with their raw logs, the files), open when the flow failed
 * or differs. A flow that runs has no record yet: its state file (.timmy/flows/<id>/state.json) is drawn as a running
 * card, said to be its state file as its session last wrote it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diffText, DOCTRINE_15, FLOW_ID, FLOW_SCHEMA, FLOW_WORK_DIR, flowRecordPath, mm3Text, mmText, toleranceText, type FlowRecord, type OtherChange, type ParamChange, type ReadbackCheck } from '../flows/iterate.js';
import { artifactsHtml, detailsHtml, nextHtml, opensByDefault, recordStrip, STEPS_CSS, summaryHtml, verdictWord } from './board-steps.js';
// R4 (H26): a Blender flow's card (/iterate blender).
import { BLENDER_FLOW_CSS, blenderFlowCard, isBlenderFlowRecord } from './board-flows-blender.js';
// R4 (H33): an OpenSCAD or FreeCAD flow's card (/iterate scad, /iterate freecad).
import { isNativeFlowRecord, NATIVE_FLOW_CSS, nativeFlowCard } from './board-flows-native.js';
import { AE_FLOW_CSS, aeFlowCard, isAeFlowRecord } from './board-flows-ae.js'; // R4 (H41): an After Effects flow's card (/iterate ae)
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';

export interface BoardFlowCheck { status: 'verified' | 'unverified'; receipt?: string; reasons: string[] }
export interface BoardFlow {
  /** The record file, relative to the project (for a flow that runs: its state file). */
  file: string;
  /** The record as shown (its free text with the project's folder as "." and the home folder as "~"). */
  record: FlowRecord;
  check: BoardFlowCheck;
  /** R4 (H45): a flow with no record yet, drawn from its state file: when its session last wrote it (ISO). */
  live?: { written: string };
}
/** R4 (H45): `running`, the flows whose state file says they run and that have no record yet (newest first). */
export interface BoardFlows { list: BoardFlow[]; more: number; running?: BoardFlow[] }

/** How many flows a board shows; the rest are counted. */
export const FLOWS_SHOWN = 12;
const RECORD_MAX = 1024 * 1024;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => num(n) !== undefined);

/**
 * R4 (H40): a record's list, read as Timmy writes it: the entries that are objects (and pass `ok`), how many are not
 * (`odd`), and whether a value is there that is not a list at all (`notList`). Nothing is guessed from the rest.
 */
type Entries<T> = { items: T[]; odd: number; notList: boolean };
function entries<T>(v: unknown, ok: (x: Record<string, unknown>) => boolean = () => true): Entries<T> {
  if (!Array.isArray(v)) return { items: [], odd: 0, notList: v !== undefined && v !== null };
  const items = v.filter((x) => !!x && typeof x === 'object' && !Array.isArray(x) && ok(x as Record<string, unknown>)) as T[];
  return { items, odd: v.length - items.length, notList: false };
}
const named = (x: Record<string, unknown>): boolean => typeof x.name === 'string';
const pathed = (x: Record<string, unknown>): boolean => typeof x.path === 'string';
/** What a card left out of a record's list, in words ('' when nothing was). */
const leftOut = (e: Entries<unknown>, what: string): string => (e.notList
  ? `${what}: not a list, so not shown`
  : e.odd ? `${e.odd} ${e.odd === 1 ? 'entry' : 'entries'} of ${what} not in the form Timmy writes, so not shown` : '');
/** The same as a row of a card's list (<dl>), or as an item of its files (<ul>). */
const notShownRow = (e: Entries<unknown>, what: string): string => { const t = leftOut(e, what); return t ? `<dt>not shown</dt><dd class="nomodel">${esc(t)}</dd>` : ''; };
const notShownItem = (e: Entries<unknown>, what: string): string => { const t = leftOut(e, what); return t ? `<li class="nomodel">${esc(t)}</li>` : ''; };

/** A path inside the project as '/'-separated parts, or null (absolute, a URL, or one that climbs out): as board.ts. */
function relPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('~')) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** Whether a sealed `flow` receipt of this project names exactly these bytes of the record file. */
export function checkFlowRecord(file: string, fileSha256: string, receipts: readonly Receipt[], projectId: string): BoardFlowCheck {
  const named = receipts.filter((r) => r.kind === 'flow' && r.project_id === projectId && (r.outputs ?? []).some((o) => o.path === file));
  if (!named.length) return { status: 'unverified', reasons: ['no flow receipt names this file'] };
  const exact = [...named].reverse().find((r) => (r.outputs ?? []).some((o) => o.path === file && o.sha256 === fileSha256));
  if (exact) return { status: 'verified', receipt: String(exact.hash).slice(7, 15), reasons: [] };
  return { status: 'unverified', reasons: ['the file changed after it was sealed: its sha256 is not the one its flow receipt sealed'] };
}

/**
 * The flow records among these project files (results/flows/*.json), newest first, each read, checked against the
 * runs chain and made ready to show. A file that is not a flow record is left out. R4 (H45): with them, the flows that
 * run (`running`): a state file in .timmy/flows/<id>/ that says the flow runs, with no record at results/flows/<id>.json.
 */
export function readBoardFlows(root: string, rels: string[], o: { receipts: readonly Receipt[]; projectId: string; scrub: (text: string) => string }): BoardFlows {
  const all: Array<BoardFlow & { at: string }> = [];
  for (const rel of rels) {
    let buf: Buffer;
    try {
      const abs = path.join(root, rel);
      if (fs.lstatSync(abs).isSymbolicLink() || fs.statSync(abs).size > RECORD_MAX) continue;
      buf = fs.readFileSync(abs);
    } catch { continue; }
    let shown: FlowRecord;
    try {
      const raw = JSON.parse(buf.toString('utf8')) as FlowRecord;
      if (!raw || typeof raw !== 'object' || raw.schema !== FLOW_SCHEMA || typeof raw.id !== 'string') continue;
      shown = JSON.parse(o.scrub(buf.toString('utf8'))) as FlowRecord;
    } catch { continue; }
    const sha = createHash('sha256').update(buf).digest('hex');
    all.push({ file: rel, record: shown, check: checkFlowRecord(rel, sha, o.receipts, o.projectId), at: String(shown.started_at ?? '') });
  }
  all.sort((a, b) => b.at.localeCompare(a.at));
  const running = readRunningFlows(root, new Set(all.map((f) => String(f.record.id))), o.scrub);
  return { list: all.slice(0, FLOWS_SHOWN).map(({ at: _at, ...f }) => f), more: Math.max(0, all.length - FLOWS_SHOWN), ...(running.length ? { running } : {}) };
}

/** Whether anything (a file, a link, a folder) is at this path. */
const lexists = (abs: string): boolean => { try { fs.lstatSync(abs); return true; } catch { return false; } };

/**
 * R4 (H45): the flows that run, from their state files (.timmy/flows/<id>/state.json, which each flow's session writes at
 * each step; src/repl/recover.ts reads the same files): a regular file inside the project, a flow state of this id whose
 * outcome is still `running`, and no file at results/flows/<id>.json (a flow with a record has ended). Newest first, at
 * most FLOWS_SHOWN. The state is what its session last wrote: a session that ended leaves it saying `running` until
 * /recover records the flow as interrupted, and the card says so.
 */
function readRunningFlows(root: string, recorded: ReadonlySet<string>, scrub: (text: string) => string): BoardFlow[] {
  let ids: string[];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
    ids = fs.readdirSync(path.join(root, FLOW_WORK_DIR)).filter((n) => FLOW_ID.test(n));
  } catch { return []; }
  const found: Array<BoardFlow & { at: number }> = [];
  for (const id of ids) {
    if (recorded.has(id) || lexists(path.join(root, flowRecordPath(id)))) continue;
    const rel = `${FLOW_WORK_DIR}/${id}/state.json`;
    const abs = path.join(root, rel);
    let buf: Buffer;
    let mtime: number;
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > RECORD_MAX) continue;
      if (!fs.realpathSync(path.dirname(abs)).startsWith(realRoot + path.sep)) continue;
      buf = fs.readFileSync(abs);
      mtime = st.mtimeMs;
    } catch { continue; }
    let shown: FlowRecord;
    try {
      const raw = JSON.parse(buf.toString('utf8')) as FlowRecord;
      if (!raw || typeof raw !== 'object' || raw.schema !== FLOW_SCHEMA || raw.id !== id || raw.outcome !== 'running') continue;
      shown = JSON.parse(scrub(buf.toString('utf8'))) as FlowRecord;
    } catch { continue; }
    const written = new Date(mtime).toISOString();
    found.push({ file: rel, record: shown, check: { status: 'unverified', reasons: ['no record yet: this is its state file'] }, live: { written }, at: mtime });
  }
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, FLOWS_SHOWN).map(({ at: _at, ...f }) => f);
}

// ── HTML ─────────────────────────────────────────────────────────────────────────

interface Draw { live: boolean; base: string }

function helpers(d: Draw) {
  const base = /^(?:\.\.\/)*$/.test(d.base) ? d.base : '';
  const href = (rel: string): string => esc(base + rel.split('/').map(encodeURIComponent).join('/'));
  /** A link to a project file (text on the live board, which serves no files); text alone for a path outside the project. */
  const file = (p: unknown, label?: string): string => {
    const rel = relPath(p);
    if (!rel) return `<span class="name">${esc(String(p ?? ''))}</span> <span class="tier">not a project path</span>`;
    return d.live ? `<span class="name">${esc(label ?? rel)}</span>` : `<a class="name" href="${href(rel)}">${esc(label ?? rel)}</a>`;
  };
  const cmd = (c: string): string => `<button type="button" class="cmd" data-cmd="${esc(c)}" title="Copy this command"><code>${esc(c)}</code></button>`;
  /** R4 (H26): a picture of an image file in the project (none on the live board, which serves no files). */
  const thumb = (p: unknown): string => {
    const rel = relPath(p);
    return !rel || d.live ? '' : `<a class="thumb" href="${href(rel)}"><img src="${href(rel)}" alt="${esc(rel)}" loading="lazy"></a>`;
  };
  return { file, cmd, thumb };
}

const shortSha = (s: unknown): string => (typeof s === 'string' ? s.slice(0, 12) : '?');
const n = (v: unknown): string => (num(v) === undefined ? 'none' : String(Math.round((v as number) * 1e6) / 1e6));
const when = (iso: unknown): string => {
  const d = typeof iso === 'string' ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};

function paramsBlock(r: FlowRecord, h: ReturnType<typeof helpers>): string {
  const p = r.parameters;
  if (!p || typeof p !== 'object') return '';
  // R4 (H40): a diff that is not a list, or entries in it that are not Timmy's, are said, never drawn as values
  const d = entries<ParamChange>(p.diff, named);
  const diff = Array.isArray(p.diff) ? d.items : undefined;
  const before = p.before?.values ?? {};
  const rows = diff
    ? diff.map((x) => `<dt>${esc(x.name)}</dt><dd>${x.changed ? `<span class="was">${esc(n(x.before))}</span> → <strong class="changed">${esc(n(x.after))}</strong> <span class="tier">changed</span>` : esc(n(x.after))}</dd>`).join('')
    : Object.entries(before).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(n(v))}${p.after ? '' : ' <span class="tier">before; no new value</span>'}</dd>`).join('');
  const shas = `sha256 ${shortSha(p.before?.sha256)}${p.after ? ` → ${shortSha(p.after.sha256)}` : ''}`;
  const invalid = p.invalid ? `<p class="nomodel">${esc(`the agent left an invalid file (sha256 ${shortSha(p.invalid.sha256)}): ${p.invalid.error}`)}</p>` : '';
  return `<section class="params"><h4>${esc(diff ? 'parameters, before → after (mm)' : 'parameters before (mm)')}</h4><dl>${rows}${notShownRow(d, 'the parameter diff')}</dl>`
    + `<p class="meta">${h.file(p.path)} ${esc(`· ${shas}${p.created ? ' · written from the recipe card\'s defaults before the agent ran' : ''}`)}</p>${invalid}</section>`;
}

function stepsBlock(r: FlowRecord, h: ReturnType<typeof helpers>): string {
  const rows: string[] = [];
  const a = r.agent;
  if (a) {
    const cost = a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : ` · cost $${Number(a.cost_usd).toFixed(4)}${a.cost_basis ? ` (${a.cost_basis})` : ''}`;
    rows.push(`<dt>agent</dt><dd>${esc(`${a.agent} ${a.run}${a.model ? ` · model ${a.model}` : ''} · ${a.route} · ${a.outcome ?? 'running'}${cost}${a.receipt ? ` · receipt ${a.receipt}` : ''}`)}${a.transcript ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`);
    const others = entries<OtherChange>(a.others, pathed);
    if (others.items.length) rows.push(`<dt>also changed</dt><dd>${others.items.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(x.how)}</span>`).join(', ')}</dd>`);
    rows.push(notShownRow(others, 'the files it also changed'));
  }
  const b = r.rebuild;
  if (b) {
    const pred = b.predicted && triple(b.predicted.bounds_mm) && num(b.predicted.volume_mm3) !== undefined ? ` · predicted ${mmText(b.predicted.bounds_mm)} mm, ${mm3Text(b.predicted.volume_mm3)} mm3 (analytic, sealed before the build${b.prediction_receipt ? `: receipt ${b.prediction_receipt}` : ''})` : '';
    rows.push(`<dt>rebuild</dt><dd>${esc(`${b.operation ? `recipe job ${b.operation} · ` : ''}${b.state}${b.progress && b.progress !== 'finished' ? ` (${b.progress})` : ''}${pred}${b.receipt ? ` · receipt ${b.receipt}` : ''}`)}</dd>`);
    if (Array.isArray(b.failure_files) && b.failure_files.length) rows.push(`<dt>kept</dt><dd>${b.failure_files.map((f) => h.file(f)).join(', ')}</dd>`);
  }
  const k = r.readback;
  if (k) rows.push(`<dt>readback</dt><dd>${esc(`${k.worker ? `${k.worker.name} ${k.worker.version} · ` : ''}${k.state}${k.verdict ? ` · ${k.verdict}` : ''}${k.receipt ? ` · receipt ${k.receipt}` : ''}`)}${k.log ? ` · ${h.file(k.log, 'its output')}` : ''}</dd>`);
  return rows.length ? `<section class="steps"><h4>steps</h4><dl>${rows.join('')}</dl></section>` : '';
}

/** The readback's measured values, labelled as measured from the CAD file, with DOCTRINE §15; as recorded when not verified. */
function readbackBlock(r: FlowRecord, check: BoardFlowCheck): string {
  const k = r.readback;
  const m = k?.measured;
  if (!k || !m || !triple(m.bounds_mm) || num(m.volume_mm3) === undefined) return '';
  const verified = check.status === 'verified';
  const pred = r.rebuild?.predicted;
  const heading = verified ? 'measured from the CAD file (the STEP read back in its own process)' : 'measured from the CAD file, as the record says (not verified)';
  const tol = k.tolerance && num(k.tolerance.bounds_mm) !== undefined && num(k.tolerance.volume_relative) !== undefined ? `within ${toleranceText(k.tolerance)} of the prediction` : '';
  const checks = entries<ReadbackCheck>(k.checks, named);
  const failing = checks.items.filter((c) => !c.passed);
  const rows = [
    `<dt>bounds</dt><dd>${esc(`${mmText(m.bounds_mm)} mm`)}${pred && triple(pred.bounds_mm) ? ` <span class="tier">${esc(`predicted ${mmText(pred.bounds_mm)} mm`)}</span>` : ''}</dd>`,
    `<dt>volume</dt><dd>${esc(`${mm3Text(m.volume_mm3)} mm3`)}${pred && num(pred.volume_mm3) !== undefined ? ` <span class="tier">${esc(`predicted ${mm3Text(pred.volume_mm3)} mm3`)}</span>` : ''}</dd>`,
    `<dt>shape</dt><dd>${esc(`${m.solids} solid${m.solids === 1 ? '' : 's'}, ${m.valid ? 'valid' : 'not valid'}`)}</dd>`,
    `<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none'))}">${esc(`${k.verdict ?? 'none'}${tol ? ` · ${tol}` : ''}`)}</dd>`,
    ...failing.map((c) => `<dt>${esc(c.name)}</dt><dd>${esc(`measured ${String(c.measured)}, predicted ${String(c.predicted)}${c.difference !== null && num(c.difference) !== undefined ? `, difference ${(c.difference as number).toPrecision(3)}` : ''}`)} <span class="tier">outside the tolerance</span></dd>`),
    notShownRow(checks, 'the readback\'s checks'),
    `<dt>file</dt><dd>${esc(`sha256 ${shortSha(m.sha256)}${k.worker ? ` · ${k.worker.name} ${k.worker.version}` : ''}`)}</dd>`,
  ].join('');
  return `<section class="${verified ? 'measured' : 'unverified'} readback"><h4>${esc(heading)}</h4><dl>${rows}</dl><p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

/**
 * The card's verified line: verified by the flow receipt that sealed exactly the record's bytes, or not, and why. R4
 * (H45): a flow with no record yet says that what is drawn is its state file, when it was written, and what /recover does.
 */
function statusLine(f: BoardFlow): string {
  if (f.live) {
    return `<div class="status status-running"><strong>running</strong> ${esc(`no record yet: this card is drawn from its state file (${f.file}) as its session last wrote it, at ${when(f.live.written)}; the record is written when the flow ends. If the REPL running it has ended, /recover records it as interrupted.`)}</div>`;
  }
  const check = f.check;
  if (check.status === 'verified') return `<div class="status status-verified"><strong>verified</strong> ${esc(`receipt ${check.receipt ?? '?'} sealed this record, and it is unchanged since`)}</div>`;
  return `<div class="status status-unverified"><strong>unverified</strong> ${esc('this record\'s values are as the file says, not verified')}<ul class="reasons">${check.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

/**
 * R4 (H45): the tray card's summary, always in view: the parameters that changed, the readback's verdict, and the
 * measured size beside the sealed prediction, with who measured it in one line and DOCTRINE §15 (as the record says,
 * not verified, when no flow receipt sealed its bytes).
 */
function traySummary(r: FlowRecord, check: BoardFlowCheck): string {
  const rows: Array<[string, string]> = [];
  const p = r.parameters;
  if (p && typeof p === 'object' && p.diff !== undefined && p.diff !== null) rows.push(['changed (mm)', esc(diffText(p.diff))]);
  const k = r.readback;
  const m = k?.measured;
  const measured = !!m && triple(m.bounds_mm) && num(m.volume_mm3) !== undefined;
  const tol = k?.tolerance && num(k.tolerance.bounds_mm) !== undefined && num(k.tolerance.volume_relative) !== undefined ? ` ${esc(`within ${toleranceText(k.tolerance)} of the prediction`)}` : '';
  if (k && (k.verdict || measured)) rows.push(['verdict', `${verdictWord(String(k.verdict ?? 'none'))}${measured ? tol : ''}`]);
  const pred = r.rebuild?.predicted;
  if (measured) {
    const predicted = pred && triple(pred.bounds_mm) && num(pred.volume_mm3) !== undefined ? ` <span class="tier">${esc(`predicted ${mmText(pred.bounds_mm)} mm, ${mm3Text(pred.volume_mm3)} mm3, sealed before the build`)}</span>` : '';
    rows.push(['measured', `${esc(`${mmText(m!.bounds_mm)} mm, ${mm3Text(m!.volume_mm3)} mm3`)}${predicted}`]);
  }
  const verified = check.status === 'verified';
  const worker = k?.worker && typeof k.worker.name === 'string' ? ` by ${k.worker.name} ${String(k.worker.version ?? '')}`.trimEnd() : '';
  const who = measured
    ? `<p class="who">${esc(verified ? `measured from the CAD file: the delivered STEP read back in its own process${worker}; a measurement of the file, not of a physical part` : 'measured from the CAD file, as the record says (not verified)')}</p><p class="doctrine">${esc(DOCTRINE_15)}</p>`
    : '';
  return summaryHtml(rows, who);
}

function flowCard(f: BoardFlow, h: ReturnType<typeof helpers>): string {
  if (isBlenderFlowRecord(f.record)) return blenderFlowCard(f, h, statusLine(f)); // R4 (H26)
  if (isNativeFlowRecord(f.record)) return nativeFlowCard(f, h, statusLine(f)); // R4 (H33)
  if (isAeFlowRecord(f.record)) return aeFlowCard(f, h, statusLine(f)); // R4 (H41)
  const r = f.record;
  const id = String(r.id);
  const outcome = String(r.outcome ?? 'unknown');
  const open = opensByDefault(outcome);
  const outputs = entries<{ path: string; sha256: string }>(r.rebuild?.outputs, pathed);
  const editable = outputs.items.filter((o) => /\.(step|stp|stl)$/i.test(o.path));
  const step = outputs.items.find((o) => /\.(step|stp)$/i.test(o.path));
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.prediction ? [`prediction ${r.receipts.prediction}`] : []),
    ...(r.receipts?.build ? [`build ${r.receipts.build}`] : []), ...(r.receipts?.readback ? [`readback ${r.receipts.readback}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...editable.map((o) => `<li>${h.file(o.path)} <span class="tier">${esc(`sha256 ${shortSha(o.sha256)}`)}</span></li>`),
    notShownItem(outputs, 'the rebuild\'s outputs'),
    ...(r.parameters?.path ? [`<li>${h.file(r.parameters.path)} <span class="tier">the parameter file</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">${esc(f.live ? 'its state file (no record yet)' : 'this record')}</span></li>`,
  ];
  // R4 (H45): what a person opens, each with its /open command (the commands are here only, once each).
  const artifacts = artifactsHtml([
    ...(step ? [{ role: 'STEP', path: step.path, note: 'the delivered CAD file' }] : []),
    ...(r.parameters?.path ? [{ role: 'parameters', path: r.parameters.path, note: 'what the agent changed' }] : []),
    { role: f.live ? 'state file' : 'record', path: f.file },
  ], h, receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : '');
  return `<article class="card flow"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate ${r.recipe ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${recordStrip(r, id)}${statusLine(f)}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${nextHtml(r, h)}${traySummary(r, f.check)}${artifacts}`
    + detailsHtml({ id, part: 'checks', summary: 'the readback: its checks, scope and DOCTRINE §15', body: readbackBlock(r, f.check), open })
    + detailsHtml({ id, part: 'change', summary: r.parameters?.after ? 'the parameters, before → after' : 'the parameters', body: paramsBlock(r, h), open })
    + detailsHtml({ id, part: 'steps', summary: 'the steps: jobs, receipts and raw output', body: stepsBlock(r, h), open })
    + detailsHtml({ id, part: 'files', summary: `files (${files.filter(Boolean).length})`, body: `<section class="files"><h4>files</h4><ul>${files.join('')}</ul></section>`, open })
    + `<div class="cmds">${[...(f.live ? [h.cmd(`/stop ${id}`)] : []), h.cmd('/iterate')].join('')}</div></article>`;
}

/**
 * R4 (H40, review R4-4): what stands in for a card that could not be drawn: the record's file, why (the error, as
 * raised), its verified line, and the command that opens the file. Nothing from the record's inside is read again here.
 */
function unreadableCard(f: BoardFlow, h: ReturnType<typeof helpers>, err: unknown): string {
  const why = `its card could not be drawn: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300)}`;
  let status = '';
  try { status = statusLine(f); } catch { status = ''; }
  return `<article class="card flow unreadable"><div class="jobhead"><strong>${esc(path.posix.basename(f.file, '.json'))}</strong> <span class="state state-unreadable">unreadable</span></div>`
    + `<p class="nomodel">${esc(`unreadable record: ${f.file} (${why})`)}</p>${status}`
    + `<section class="files"><h4>files</h4><ul><li>${h.file(f.file)} <span class="tier">this record</span></li></ul></section>`
    + `<div class="cmds">${[h.cmd(`/open ${f.file}`), h.cmd('/iterate')].join('')}</div></article>`;
}

/** R4 (H40, review R4-4): each card inside a guard, so one record cannot take the section (and the board) down with it. */
function guardedCard(f: BoardFlow, h: ReturnType<typeof helpers>): string {
  try { return flowCard(f, h); } catch (err) { return unreadableCard(f, h, err); }
}

/**
 * The Flows section: its table-of-contents entry and its HTML (a heading, the cards or what to do, what was left off).
 * R4 (H45): the flows that run (no record yet) come first, under their own heading; the count is of records.
 */
export function flowsSection(flows: BoardFlows, d: Draw): { toc: string; html: string } {
  const h = helpers(d);
  const total = flows.list.length + flows.more;
  const running = flows.running ?? [];
  return {
    toc: `<a href="#flows">Flows <b>${total}</b></a>`,
    html: [
      `<h2 id="flows">Flows <span class="count">${total}</span></h2>`,
      running.length ? `<h3 id="flows-running">${esc('Running now, as their state files say')} <span class="count">${running.length}</span></h3><div class="grid wide">${running.map((f) => guardedCard(f, h)).join('')}</div>` : '',
      flows.list.length
        ? `${running.length ? `<h3 id="flows-recorded">${esc('Recorded')} <span class="count">${total}</span></h3>` : ''}<div class="grid wide">${flows.list.map((f) => guardedCard(f, h)).join('')}</div>`
        : `<p class="empty">${esc('No flows yet: /iterate tray "<instruction>" has a local agent change the parameters, rebuilds the tray and reads it back; /iterate blender <script.py> "<instruction>" does the same for a Blender script; /iterate scad <model.scad> and /iterate freecad <script.py> for OpenSCAD and FreeCAD.')}</p>`,
      flows.more > 0 ? `<p class="more">${esc(`and ${flows.more} more: /iterate`)}</p>` : '',
    ].join('\n'),
  };
}

export const FLOWS_CSS = `
.flow .instruction { margin: 0; font-weight: ${TYPE.weight.strong}; overflow-wrap: anywhere; }
.flow .why { margin: 0; color: ${HOMEBREW.textSecondary}; font-size: ${TYPE.size.small}px; overflow-wrap: anywhere; }
.flow .was { color: ${HOMEBREW.textSecondary}; text-decoration: line-through; }
.flow .changed { color: ${HOMEBREW.accent}; }
.flow section.params, .flow section.steps, .flow section.files { border-left: 3px solid ${HOMEBREW.lineStrong}; padding: 2px 0 2px 10px; }
.flow section.readback.measured { border-left: 3px solid ${HOMEBREW.lineStrong}; padding: 2px 0 2px 10px; }
.flow section.files ul { margin: 0; padding-left: 18px; font-size: ${TYPE.size.small}px; }
.flow .doctrine { margin: 6px 0 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.text}; }
.flow .verdict-matches { color: ${HOMEBREW.text}; }
.flow .verdict-differs, .flow .verdict-failed { color: ${HOMEBREW.failure}; }
/* Green is for actions: an outcome or a seal keeps its word in the text colour, on a flow card and (R4, H46) on every other card. */
.state-succeeded { color: ${HOMEBREW.text}; }
.state-differs, .state-stopped { color: ${HOMEBREW.attention}; }
.state-unreadable { color: ${HOMEBREW.failure}; }
${BLENDER_FLOW_CSS}${NATIVE_FLOW_CSS}${AE_FLOW_CSS}${STEPS_CSS}`;
