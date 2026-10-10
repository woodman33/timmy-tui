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
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DOCTRINE_15, FLOW_SCHEMA, mm3Text, mmText, toleranceText, type FlowRecord } from '../flows/iterate.js';
// R4 (H26): a Blender flow's card (/iterate blender).
import { BLENDER_FLOW_CSS, blenderFlowCard, isBlenderFlowRecord } from './board-flows-blender.js';
// R4 (H33): an OpenSCAD or FreeCAD flow's card (/iterate scad, /iterate freecad).
import { isNativeFlowRecord, NATIVE_FLOW_CSS, nativeFlowCard } from './board-flows-native.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { Receipt } from '../utils/receipts.js';

export interface BoardFlowCheck { status: 'verified' | 'unverified'; receipt?: string; reasons: string[] }
export interface BoardFlow {
  /** The record file, relative to the project. */
  file: string;
  /** The record as shown (its free text with the project's folder as "." and the home folder as "~"). */
  record: FlowRecord;
  check: BoardFlowCheck;
}
export interface BoardFlows { list: BoardFlow[]; more: number }

/** How many flows a board shows; the rest are counted. */
export const FLOWS_SHOWN = 12;
const RECORD_MAX = 1024 * 1024;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => num(n) !== undefined);

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
 * runs chain and made ready to show. A file that is not a flow record is left out.
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
  return { list: all.slice(0, FLOWS_SHOWN).map(({ at: _at, ...f }) => f), more: Math.max(0, all.length - FLOWS_SHOWN) };
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
  const diff = Array.isArray(p.diff) ? p.diff : undefined;
  const before = p.before?.values ?? {};
  const rows = diff
    ? diff.map((d) => `<dt>${esc(d.name)}</dt><dd>${d.changed ? `<span class="was">${esc(n(d.before))}</span> → <strong class="changed">${esc(n(d.after))}</strong> <span class="tier">changed</span>` : esc(n(d.after))}</dd>`).join('')
    : Object.entries(before).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(n(v))}${p.after ? '' : ' <span class="tier">before; no new value</span>'}</dd>`).join('');
  const shas = `sha256 ${shortSha(p.before?.sha256)}${p.after ? ` → ${shortSha(p.after.sha256)}` : ''}`;
  const invalid = p.invalid ? `<p class="nomodel">${esc(`the agent left an invalid file (sha256 ${shortSha(p.invalid.sha256)}): ${p.invalid.error}`)}</p>` : '';
  return `<section class="params"><h4>${esc(diff ? 'parameters, before → after (mm)' : 'parameters before (mm)')}</h4><dl>${rows}</dl>`
    + `<p class="meta">${h.file(p.path)} ${esc(`· ${shas}${p.created ? ' · written from the recipe card\'s defaults before the agent ran' : ''}`)}</p>${invalid}</section>`;
}

function stepsBlock(r: FlowRecord, h: ReturnType<typeof helpers>): string {
  const rows: string[] = [];
  const a = r.agent;
  if (a) {
    const cost = a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : ` · cost $${Number(a.cost_usd).toFixed(4)}${a.cost_basis ? ` (${a.cost_basis})` : ''}`;
    rows.push(`<dt>agent</dt><dd>${esc(`${a.agent} ${a.run}${a.model ? ` · model ${a.model}` : ''} · ${a.route} · ${a.outcome ?? 'running'}${cost}${a.receipt ? ` · receipt ${a.receipt}` : ''}`)}${a.transcript ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`);
    if (Array.isArray(a.others) && a.others.length) rows.push(`<dt>also changed</dt><dd>${a.others.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(x.how)}</span>`).join(', ')}</dd>`);
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
  const failing = Array.isArray(k.checks) ? k.checks.filter((c) => !c.passed) : [];
  const rows = [
    `<dt>bounds</dt><dd>${esc(`${mmText(m.bounds_mm)} mm`)}${pred && triple(pred.bounds_mm) ? ` <span class="tier">${esc(`predicted ${mmText(pred.bounds_mm)} mm`)}</span>` : ''}</dd>`,
    `<dt>volume</dt><dd>${esc(`${mm3Text(m.volume_mm3)} mm3`)}${pred && num(pred.volume_mm3) !== undefined ? ` <span class="tier">${esc(`predicted ${mm3Text(pred.volume_mm3)} mm3`)}</span>` : ''}</dd>`,
    `<dt>shape</dt><dd>${esc(`${m.solids} solid${m.solids === 1 ? '' : 's'}, ${m.valid ? 'valid' : 'not valid'}`)}</dd>`,
    `<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none'))}">${esc(`${k.verdict ?? 'none'}${tol ? ` · ${tol}` : ''}`)}</dd>`,
    ...failing.map((c) => `<dt>${esc(c.name)}</dt><dd>${esc(`measured ${String(c.measured)}, predicted ${String(c.predicted)}${c.difference !== null && num(c.difference) !== undefined ? `, difference ${(c.difference as number).toPrecision(3)}` : ''}`)} <span class="tier">outside the tolerance</span></dd>`),
    `<dt>file</dt><dd>${esc(`sha256 ${shortSha(m.sha256)}${k.worker ? ` · ${k.worker.name} ${k.worker.version}` : ''}`)}</dd>`,
  ].join('');
  return `<section class="${verified ? 'measured' : 'unverified'} readback"><h4>${esc(heading)}</h4><dl>${rows}</dl><p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

function statusLine(check: BoardFlowCheck): string {
  if (check.status === 'verified') return `<div class="status status-verified"><strong>verified</strong> ${esc(`receipt ${check.receipt ?? '?'} sealed this record, and it is unchanged since`)}</div>`;
  return `<div class="status status-unverified"><strong>unverified</strong> ${esc('this record\'s values are as the file says, not verified')}<ul class="reasons">${check.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}

function flowCard(f: BoardFlow, h: ReturnType<typeof helpers>): string {
  if (isBlenderFlowRecord(f.record)) return blenderFlowCard(f, h, statusLine(f.check)); // R4 (H26)
  if (isNativeFlowRecord(f.record)) return nativeFlowCard(f, h, statusLine(f.check)); // R4 (H33)
  const r = f.record;
  const outcome = String(r.outcome ?? 'unknown');
  const outputs = Array.isArray(r.rebuild?.outputs) ? r.rebuild!.outputs! : [];
  const editable = outputs.filter((o) => /\.(step|stp|stl)$/i.test(String(o.path)));
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.prediction ? [`prediction ${r.receipts.prediction}`] : []),
    ...(r.receipts?.build ? [`build ${r.receipts.build}`] : []), ...(r.receipts?.readback ? [`readback ${r.receipts.readback}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...editable.map((o) => `<li>${h.file(o.path)} <span class="tier">${esc(`sha256 ${shortSha(o.sha256)}`)}</span></li>`),
    ...(r.parameters?.path ? [`<li>${h.file(r.parameters.path)} <span class="tier">the parameter file</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">this record</span></li>`,
  ].join('');
  return `<article class="card flow"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate ${r.recipe ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${statusLine(f.check)}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${paramsBlock(r, h)}${stepsBlock(r, h)}${readbackBlock(r, f.check)}`
    + `<section class="files"><h4>files</h4><ul>${files}</ul></section>`
    + `${receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : ''}`
    + `<div class="cmds">${[h.cmd(`/open ${f.file}`), ...(r.parameters?.path ? [h.cmd(`/open ${r.parameters.path}`)] : []), h.cmd('/iterate')].join('')}</div></article>`;
}

/** The Flows section: its table-of-contents entry and its HTML (a heading, the cards or what to do, what was left off). */
export function flowsSection(flows: BoardFlows, d: Draw): { toc: string; html: string } {
  const h = helpers(d);
  const total = flows.list.length + flows.more;
  return {
    toc: `<a href="#flows">Flows <b>${total}</b></a>`,
    html: [
      `<h2 id="flows">Flows <span class="count">${total}</span></h2>`,
      flows.list.length
        ? `<div class="grid wide">${flows.list.map((f) => flowCard(f, h)).join('')}</div>`
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
.flow section.readback.measured { border-left: 3px solid ${HOMEBREW.accent}; padding: 2px 0 2px 10px; }
.flow section.files ul { margin: 0; padding-left: 18px; font-size: ${TYPE.size.small}px; }
.flow .doctrine { margin: 6px 0 0; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.text}; }
.flow .verdict-matches { color: ${HOMEBREW.accent}; }
.flow .verdict-differs, .flow .verdict-failed { color: ${HOMEBREW.failure}; }
.state-succeeded { color: ${HOMEBREW.accent}; }
.state-differs, .state-stopped { color: ${HOMEBREW.attention}; }
${BLENDER_FLOW_CSS}${NATIVE_FLOW_CSS}`;
