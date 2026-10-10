/**
 * The board's card for a Blender flow (round R4, /iterate blender, helper H26), drawn in the Flows section
 * (src/repl/board-flows.ts hands a record with `target: 'blender'` here): the instruction, the script's change and its
 * Python check, each step's state, the render as a picture and the render, the .blend and the script as file links,
 * and the second pass's verdict with what it read back.
 *
 * As for every flow card, the record is an editable file: its values are verified only when a sealed `flow` receipt
 * names exactly its bytes; otherwise they are shown as the record says, not verified. What was read back is labelled
 * as what it is: the same application reading its own file in a separate process, a second pass, not an independent
 * implementation; its lengths are Blender units of a generated scene, shown with DOCTRINE §15's sentence. Every string
 * is escaped; links come from the Flows section's own helpers (a link only inside the project; text on the live board).
 */
import { DOCTRINE_15 } from '../flows/iterate.js';
import { BLEND_READBACK_SCOPE, changeText, isBlenderFlowRecord, syntaxText, type BlendCheck, type BlenderFlowRecord } from '../flows/iterate-blender.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { BoardFlow } from './board-flows.js';

export { isBlenderFlowRecord };

/** What the Flows section lends a card: a project file as a link (or text), a copyable command, a picture of an image file. */
export interface FlowCardHelpers {
  file: (p: unknown, label?: string) => string;
  cmd: (c: string) => string;
  thumb: (p: unknown) => string;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const shortSha = (s: unknown): string => (typeof s === 'string' ? s.slice(0, 12) : '?');
const when = (iso: unknown): string => {
  const d = typeof iso === 'string' ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
const nums = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(finite) ? v.map((n) => String(Math.round(n * 1e6) / 1e6)) : undefined);
/** dimensions as "2 x 2 x 2"; a location as "(0, 0.6, 1)" */
const vec = (v: unknown): string => nums(v)?.join(' x ') ?? '–';
const point = (v: unknown): string => { const n = nums(v); return n ? `(${n.join(', ')})` : '–'; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const capped = (xs: string[], max = 12): string => `${xs.slice(0, max).join(', ')}${xs.length > max ? ` and ${xs.length - max} more` : ''}` || 'none';
/** Objects shown in the card's table; the rest are counted (the record has them all). */
const OBJECT_ROWS = 24;

function scriptBlock(r: BlenderFlowRecord, h: FlowCardHelpers): string {
  const s = r.script;
  if (!s || typeof s !== 'object') return '';
  const shas = `sha256 ${shortSha(s.before?.sha256)}${s.after ? ` → ${shortSha(s.after.sha256)}` : ''}`;
  const rows = [
    `<dt>file</dt><dd>${h.file(s.path)} <span class="tier">${esc(shas)}</span></dd>`,
    ...(s.change && finite(s.change.added) ? [`<dt>change</dt><dd>${esc(changeText(s.change))}</dd>`] : s.after ? [] : ['<dt>change</dt><dd>none recorded</dd>']),
    ...(s.syntax ? [`<dt>python</dt><dd class="${s.syntax.checked && !s.syntax.ok ? 'bad' : ''}">${esc(syntaxText(s.syntax))}</dd>`] : []),
    ...(s.before?.kept ? [`<dt>before</dt><dd>${h.file(s.before.kept, 'the script as it was before the agent ran')}</dd>`] : []),
  ].join('');
  const hunks = Array.isArray(s.change?.hunks) ? s.change!.hunks : [];
  const diff = hunks.length
    ? `<pre class="diff">${hunks.map((k) => [
      `<span class="at">${esc(`@@ line ${k.before_line} → ${k.after_line}`)}</span>`,
      ...list(k.removed).map((l) => `<span class="removed">${esc(`- ${l}`)}</span>`),
      ...(k.removed_total > list(k.removed).length ? [`<span class="at">${esc(`  … ${k.removed_total - list(k.removed).length} more taken out`)}</span>`] : []),
      ...list(k.added).map((l) => `<span class="added">${esc(`+ ${l}`)}</span>`),
      ...(k.added_total > list(k.added).length ? [`<span class="at">${esc(`  … ${k.added_total - list(k.added).length} more put in`)}</span>`] : []),
    ].join('\n')).join('\n')}</pre>${s.change && s.change.hunks_total > hunks.length ? `<p class="meta">${esc(`and ${s.change.hunks_total - hunks.length} more places in the record`)}</p>` : ''}`
    : '';
  return `<section class="params script"><h4>${esc(s.after ? 'the script, before → after' : 'the script')}</h4><dl>${rows}</dl>${diff}</section>`;
}

function stepsBlock(r: BlenderFlowRecord, h: FlowCardHelpers): string {
  const rows: string[] = [];
  const a = r.agent;
  if (a) {
    const cost = a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : ` · cost $${Number(a.cost_usd).toFixed(4)}${a.cost_basis ? ` (${a.cost_basis})` : ''}`;
    rows.push(`<dt>agent</dt><dd>${esc(`${a.agent} ${a.run}${a.model ? ` · model ${a.model}` : ''} · ${a.route} · ${a.outcome ?? 'running'}${cost}${a.receipt ? ` · receipt ${a.receipt}` : ''}`)}${a.transcript ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`);
    if (Array.isArray(a.others) && a.others.length) rows.push(`<dt>also changed</dt><dd>${a.others.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(x.how)}</span>`).join(', ')}</dd>`);
  }
  const b = r.blender;
  if (b) {
    rows.push(`<dt>Blender</dt><dd>${esc(`${b.job ? `job ${b.job} · ` : ''}${b.state}${b.outcome ? ` · judged ${b.outcome} by its result file` : ''}${b.blender_version ? ` · ${b.blender_version}` : ''}${b.receipt ? ` · receipt ${b.receipt}` : ''}`)}`
      + `${b.result?.path ? ` · ${h.file(b.result.path, 'its result')}` : ''}${b.log ? ` · ${h.file(b.log, 'its output')}` : ''}</dd>`);
    if (b.why && b.outcome !== 'ok') rows.push(`<dt>why</dt><dd>${esc(b.why)}</dd>`);
    if (b.error) rows.push(`<dt>why</dt><dd>${esc(b.error)}</dd>`);
    if (Array.isArray(b.failure_files) && b.failure_files.length) rows.push(`<dt>kept</dt><dd>${b.failure_files.map((x) => h.file(x)).join(', ')}</dd>`);
  }
  const k = r.readback;
  if (k) {
    rows.push(`<dt>second pass</dt><dd>${esc(`${k.worker ? `${k.worker.name} ${k.worker.version} · ` : ''}${k.job ? `job ${k.job} · ` : ''}${k.state}${k.verdict ? ` · ${k.verdict}` : ''}${k.receipt ? ` · receipt ${k.receipt}` : ''}`)}${k.log ? ` · ${h.file(k.log, 'its output')}` : ''}</dd>`);
    if (k.reason && !k.read) rows.push(`<dt>why</dt><dd>${esc(k.reason)}</dd>`);
  }
  return rows.length ? `<section class="steps"><h4>steps</h4><dl>${rows.join('')}</dl></section>` : '';
}

/** A check's value in words, as read or as reported: names listed, a resolution as "640 x 400", frames as "1–250". */
function valueText(name: BlendCheck['name'], v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (name === 'resolution') return nums(v)?.join(' x ') ?? 'unknown';
  if (name === 'frame range') return nums(v)?.join('–') ?? 'unknown';
  if (name === 'materials' && !Array.isArray(v) && typeof v === 'object') return `in use: ${capped(list((v as { used?: unknown }).used))}`;
  return Array.isArray(v) ? capped(list(v)) : String(v);
}

function checkRow(c: BlendCheck): string {
  if (c.passed === null) return `<dt>${esc(c.name)}</dt><dd>${esc('not compared')} <span class="tier">${esc(c.note ?? '')}</span></dd>`;
  const note = c.note ? ` <span class="tier">${esc(c.note)}</span>` : '';
  if (c.passed) return `<dt>${esc(c.name)}</dt><dd>${esc(valueText(c.name, c.read))} <span class="tier">as the result reported</span>${note}</dd>`;
  return `<dt>${esc(c.name)}</dt><dd class="bad">${esc(c.differences.join('; '))} <span class="tier">${esc(`reported: ${valueText(c.name, c.reported)}`)}</span>${note}</dd>`;
}

/** What the second pass read, with its verdict: as measured when the record is verified, as recorded otherwise. */
function readbackBlock(r: BlenderFlowRecord, verified: boolean): string {
  const k = r.readback;
  const read = k?.read;
  if (!k || !read || !Array.isArray(read.objects)) return '';
  const heading = verified ? 'read back from the .blend by a second Blender process' : 'read back from the .blend, as the record says (not verified)';
  const checks = Array.isArray(k.checks) ? k.checks : [];
  const compared = checks.filter((c) => c.passed !== null).map((c) => c.name);
  const checked = new Set(checks.map((c) => c.name));
  const blend = k.blend;
  const cams = Array.isArray(read.cameras) ? read.cameras.map((c) => `${c.name}${finite(c.lens) || c.name === read.active_camera ? ` (${[...(finite(c.lens) ? [`lens ${c.lens} mm`] : []), ...(c.name === read.active_camera ? ['active'] : [])].join(', ')})` : ''}`) : [];
  const inFile = Array.isArray(read.materials) ? read.materials.map((m) => m.name) : [];
  const rows = [
    `<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none'))}">${esc(`${k.verdict ?? 'none'}${compared.length ? ` · compared: ${compared.join(', ')}` : ''}`)}</dd>`,
    ...checks.map(checkRow),
    ...(k.reason ? [`<dt>why</dt><dd>${esc(k.reason)}</dd>`] : []),
    `<dt>file</dt><dd>${esc(`sha256 ${shortSha(blend?.sha256_before)} before the read${blend?.sha256_after ? `, ${blend.sha256_after === blend.sha256_before ? 'the same after it' : `${shortSha(blend.sha256_after)} after it`}` : ''}${k.blender_version ? ` · ${k.blender_version}` : ''}`)}</dd>`,
    `<dt>cameras</dt><dd>${esc(cams.length ? capped(cams) : `none${read.active_camera ? ` (active: ${read.active_camera})` : ''}`)}</dd>`,
    `<dt>in the file</dt><dd>${esc(`materials: ${capped(inFile)}`)}</dd>`,
    ...(!checked.has('frame range') && Array.isArray(read.frame_range) ? [`<dt>frames</dt><dd>${esc(read.frame_range.join('–'))}</dd>`] : []),
    ...(!checked.has('resolution') && Array.isArray(read.render_resolution) ? [`<dt>resolution</dt><dd>${esc(`${read.render_resolution.join(' x ')}${finite(read.resolution_percentage) ? ` at ${read.resolution_percentage}%` : ''}`)}</dd>`] : []),
    ...(Array.isArray(read.scenes) && read.scenes.length ? [`<dt>scenes</dt><dd>${esc(read.scenes.map((s) => `${s.name}${finite(s.objects) ? ` (${s.objects} objects)` : ''}`).join(', '))}</dd>`] : []),
  ].join('');
  const shown = read.objects.slice(0, OBJECT_ROWS);
  const table = shown.length
    ? `<table class="objects"><thead><tr><th>object</th><th>type</th><th>dimensions</th><th>location</th></tr></thead><tbody>${shown.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.type)}</td><td>${esc(vec(o.dimensions))}</td><td>${esc(point(o.location))}</td></tr>`).join('')}</tbody></table>`
      + `<p class="meta">${esc(`dimensions and locations in Blender units, as Blender reported them${read.objects_total > shown.length ? ` · ${shown.length} of ${read.objects_total} objects shown; the record lists ${read.objects.length}` : ''}`)}</p>`
    : '';
  return `<section class="${verified ? 'measured' : 'unverified'} readback blend"><h4>${esc(heading)}</h4><p class="meta">${esc(BLEND_READBACK_SCOPE)}</p><dl>${rows}</dl>${table}<p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

/** The card: drawn for a record whose target is 'blender' (isBlenderFlowRecord); `status` is the Flows section's verified line. */
export function blenderFlowCard(f: BoardFlow, h: FlowCardHelpers, status: string): string {
  const r = f.record as unknown as BlenderFlowRecord;
  const outcome = String(r.outcome ?? 'unknown');
  const b = r.blender;
  const renders = Array.isArray(b?.renders) ? b!.renders! : [];
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.blender ? [`Blender ${r.receipts.blender}`] : []),
    ...(r.receipts?.readback ? [`second pass ${r.receipts.readback}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...renders.map((x) => `<li>${h.file(x.path)} <span class="tier">${esc(`the render · sha256 ${shortSha(x.sha256)}`)}</span></li>`),
    ...(b?.blend ? [`<li>${h.file(b.blend.path)} <span class="tier">${esc(`the .blend · sha256 ${shortSha(b.blend.sha256)}`)}</span></li>`] : []),
    ...(r.script?.path ? [`<li>${h.file(r.script.path)} <span class="tier">the script</span></li>`] : []),
    ...(b?.copy?.path ? [`<li>${h.file(b.copy.path)} <span class="tier">${esc('the copy Blender ran, kept at submission')}</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">this record</span></li>`,
  ].join('');
  const picture = renders.length ? h.thumb(renders[0].path) : '';
  return `<article class="card flow blender"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate blender · ${r.script?.path ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${status}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${picture}${scriptBlock(r, h)}${stepsBlock(r, h)}${readbackBlock(r, f.check.status === 'verified')}`
    + `<section class="files"><h4>files</h4><ul>${files}</ul></section>`
    + `${receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : ''}`
    + `<div class="cmds">${[...(r.script?.path ? [h.cmd(`/open ${r.script.path}`)] : []), ...(b?.blend ? [h.cmd(`/open ${b.blend.path}`)] : []), h.cmd(`/open ${f.file}`), h.cmd('/iterate')].join('')}</div></article>`;
}

export const BLENDER_FLOW_CSS = `
.flow pre.diff { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
.flow pre.diff .removed { color: ${HOMEBREW.failure}; }
.flow pre.diff .added { color: ${HOMEBREW.accent}; }
.flow dd.bad { color: ${HOMEBREW.failure}; }
.flow table.objects { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: ${TYPE.size.small}px; }
.flow table.objects th { text-align: left; color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; border-bottom: 1px solid ${HOMEBREW.line}; padding: 2px 6px 2px 0; }
.flow table.objects td { padding: 2px 6px 2px 0; overflow-wrap: anywhere; border-bottom: 1px solid ${HOMEBREW.line}; }
.flow.blender .thumb img { height: 180px; }
`;
