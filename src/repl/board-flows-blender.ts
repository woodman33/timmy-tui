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
 *
 * Round R4 (H37): the objects whose size changed between a judged-ok Blender run of the script from before the flow and
 * Blender's run in it, with a count of the rest ("Cube 2 × 2 × 2 → 3 × 3 × 3 (Blender's report; the second pass
 * agrees)"), and the second pass's `dimensions` check among its checks.
 *
 * Round R4 (H40, review R4-4): a list in the record that is not a list, or entries in it that are not Timmy's (a check
 * that is not an object, a failing check without its differences, an object without a name), are left out or said as
 * such, and the card says what it left out; the Flows section draws each card inside a guard as well.
 *
 * Round R4 (H45): the step strip (agent, checks, blender, readback), a summary in view (the change, the second pass's
 * verdict, the object sizes before → after with who measured them in one line and DOCTRINE §15), the render, the
 * artifacts with their /open commands; the second pass's checks, the script's diff, the steps and the files in <details>.
 */
import { DOCTRINE_15, type OtherChange } from '../flows/iterate.js';
import {
  BLEND_READBACK_SCOPE, changeText, DIMENSIONS_SCOPE, dimensionsText, isBlenderFlowRecord, isDimensionsSummary, syntaxText, toleranceText, type BlendCheck,
  type BlenderFlowRecord, type ScriptHunk,
} from '../flows/iterate-blender.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { BoardFlow } from './board-flows.js';
import { artifactsHtml, detailsHtml, nextHtml, opensByDefault, recordStrip, summaryHtml, verdictWord } from './board-steps.js';

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

/**
 * R4 (H40): a record's list, read as Timmy writes it (as src/repl/board-flows.ts reads one): the entries that are
 * objects and pass `ok`, how many are not (`odd`), and whether a value is there that is not a list (`notList`).
 */
type Entries<T> = { items: T[]; odd: number; notList: boolean };
function entries<T>(v: unknown, ok: (x: Record<string, unknown>) => boolean = () => true): Entries<T> {
  if (!Array.isArray(v)) return { items: [], odd: 0, notList: v !== undefined && v !== null };
  const items = v.filter((x) => !!x && typeof x === 'object' && !Array.isArray(x) && ok(x as Record<string, unknown>)) as T[];
  return { items, odd: v.length - items.length, notList: false };
}
const named = (x: Record<string, unknown>): boolean => typeof x.name === 'string';
const pathed = (x: Record<string, unknown>): boolean => typeof x.path === 'string';
const leftOut = (e: Entries<unknown>, what: string): string => (e.notList
  ? `${what}: not a list, so not shown`
  : e.odd ? `${e.odd} ${e.odd === 1 ? 'entry' : 'entries'} of ${what} not in the form Timmy writes, so not shown` : '');
const notShownRow = (e: Entries<unknown>, what: string): string => { const t = leftOut(e, what); return t ? `<dt>not shown</dt><dd class="nomodel">${esc(t)}</dd>` : ''; };
const notShownItem = (e: Entries<unknown>, what: string): string => { const t = leftOut(e, what); return t ? `<li class="nomodel">${esc(t)}</li>` : ''; };
const notShownPara = (e: Entries<unknown>, what: string): string => { const t = leftOut(e, what); return t ? `<p class="nomodel">${esc(t)}</p>` : ''; };
/** R4 (H40): a dimensions summary's unit settings as Timmy writes them: none, or each field absent, a word, or (scale_length) a number. */
const unitsAsWritten = (u: unknown): boolean => {
  if (u === null) return true;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  const o = u as Record<string, unknown>;
  return (o.system === undefined || typeof o.system === 'string') && (o.length_unit === undefined || typeof o.length_unit === 'string') && (o.scale_length === undefined || finite(o.scale_length));
};

function scriptBlock(r: BlenderFlowRecord, h: FlowCardHelpers): string {
  const s = r.script;
  if (!s || typeof s !== 'object') return '';
  const shas = `sha256 ${shortSha(s.before?.sha256)}${s.after ? ` → ${shortSha(s.after.sha256)}` : ''}`;
  const rows = [
    `<dt>file</dt><dd>${h.file(s.path)} <span class="tier">${esc(shas)}</span></dd>`,
    ...(s.change && finite(s.change.added) && finite(s.change.removed) && finite(s.change.hunks_total) ? [`<dt>change</dt><dd>${esc(changeText(s.change))}</dd>`]
      // R4 (H40): a change there in a form Timmy does not write is said, not counted
      : s.change !== undefined && s.change !== null ? [`<dt>change</dt><dd class="nomodel">${esc('not in the form Timmy writes, so not shown')}</dd>`]
        : s.after ? [] : ['<dt>change</dt><dd>none recorded</dd>']),
    ...(s.syntax ? [`<dt>python</dt><dd class="${s.syntax.checked && !s.syntax.ok ? 'bad' : ''}">${esc(syntaxText(s.syntax))}</dd>`] : []),
    ...(s.before?.kept ? [`<dt>before</dt><dd>${h.file(s.before.kept, 'the script as it was before the agent ran')}</dd>`] : []),
  ].join('');
  // R4 (H40): a place that is not one of Timmy's (no lines to start at) is left out, and said
  const places = entries<ScriptHunk>(s.change?.hunks, (k) => finite(k.before_line) && finite(k.after_line));
  const hunks = places.items;
  const listed = hunks.length + places.odd;
  const diff = hunks.length
    ? `<pre class="diff">${hunks.map((k) => [
      `<span class="at">${esc(`@@ line ${k.before_line} → ${k.after_line}`)}</span>`,
      ...list(k.removed).map((l) => `<span class="removed">${esc(`- ${l}`)}</span>`),
      ...(k.removed_total > list(k.removed).length ? [`<span class="at">${esc(`  … ${k.removed_total - list(k.removed).length} more taken out`)}</span>`] : []),
      ...list(k.added).map((l) => `<span class="added">${esc(`+ ${l}`)}</span>`),
      ...(k.added_total > list(k.added).length ? [`<span class="at">${esc(`  … ${k.added_total - list(k.added).length} more put in`)}</span>`] : []),
    ].join('\n')).join('\n')}</pre>${s.change && s.change.hunks_total > listed ? `<p class="meta">${esc(`and ${s.change.hunks_total - listed} more places in the record`)}</p>` : ''}`
    : '';
  return `<section class="params script"><h4>${esc(s.after ? 'the script, before → after' : 'the script')}</h4><dl>${rows}</dl>${diff}${notShownPara(places, 'the places the script changed')}</section>`;
}

function stepsBlock(r: BlenderFlowRecord, h: FlowCardHelpers): string {
  const rows: string[] = [];
  const a = r.agent;
  if (a) {
    const cost = a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : ` · cost $${Number(a.cost_usd).toFixed(4)}${a.cost_basis ? ` (${a.cost_basis})` : ''}`;
    rows.push(`<dt>agent</dt><dd>${esc(`${a.agent} ${a.run}${a.model ? ` · model ${a.model}` : ''} · ${a.route} · ${a.outcome ?? 'running'}${cost}${a.receipt ? ` · receipt ${a.receipt}` : ''}`)}${a.transcript ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`);
    const others = entries<OtherChange>(a.others, pathed);
    if (others.items.length) rows.push(`<dt>also changed</dt><dd>${others.items.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(x.how)}</span>`).join(', ')}</dd>`);
    rows.push(notShownRow(others, 'the files it also changed'));
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
function valueText(name: BlendCheck['name'], v: unknown, tolerance?: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (name === 'resolution') return nums(v)?.join(' x ') ?? 'unknown';
  if (name === 'frame range') return nums(v)?.join('–') ?? 'unknown';
  if (name === 'dimensions') {
    const n = (v as { objects?: unknown }).objects;
    if (!finite(n)) return 'unknown';
    return `${n} object${n === 1 ? '' : 's'} with a size${finite(tolerance) ? `, each within ${toleranceText(tolerance)} (min, max and size per axis)` : ''}`;
  }
  if (name === 'materials' && !Array.isArray(v) && typeof v === 'object') return `in use: ${capped(list((v as { used?: unknown }).used))}`;
  return Array.isArray(v) ? capped(list(v)) : String(v);
}

function checkRow(c: BlendCheck): string {
  if (c.passed === null) return `<dt>${esc(c.name)}</dt><dd>${esc('not compared')} <span class="tier">${esc(c.note ?? '')}</span></dd>`;
  const note = c.note ? ` <span class="tier">${esc(c.note)}</span>` : '';
  if (c.passed) return `<dt>${esc(c.name)}</dt><dd>${esc(valueText(c.name, c.read, c.tolerance))} <span class="tier">as the result reported</span>${note}</dd>`;
  // R4 (H40, review R4-4): a failing check without its list of differences still says it failed, and that they are not there
  const said = list(c.differences);
  return `<dt>${esc(c.name)}</dt><dd class="bad">${esc(said.length ? said.join('; ') : 'differs; the record holds no differences in the form Timmy writes')} <span class="tier">${esc(`reported: ${valueText(c.name, c.reported)}`)}</span>${note}</dd>`;
}

/** What the second pass read, with its verdict: as measured when the record is verified, as recorded otherwise. */
function readbackBlock(r: BlenderFlowRecord, verified: boolean): string {
  const k = r.readback;
  const read = k?.read;
  if (!k || !read || !Array.isArray(read.objects)) return '';
  const heading = verified ? 'read back from the .blend by a second Blender process' : 'read back from the .blend, as the record says (not verified)';
  // R4 (H40): each list read as Timmy writes it; what is not is left out, and said
  const checkList = entries<BlendCheck>(k.checks, named);
  const checks = checkList.items;
  const compared = checks.filter((c) => c.passed !== null).map((c) => c.name);
  const checked = new Set(checks.map((c) => c.name));
  const blend = k.blend;
  const cameras = entries<{ name: string; lens?: unknown }>(read.cameras, named);
  const cams = cameras.items.map((c) => `${c.name}${finite(c.lens) || c.name === read.active_camera ? ` (${[...(finite(c.lens) ? [`lens ${c.lens} mm`] : []), ...(c.name === read.active_camera ? ['active'] : [])].join(', ')})` : ''}`);
  const materials = entries<{ name: string }>(read.materials, named);
  const inFile = materials.items.map((m) => m.name);
  const scenes = entries<{ name: string; objects?: unknown }>(read.scenes, named);
  const objects = entries<{ name: string; type?: unknown; dimensions?: unknown; location?: unknown }>(read.objects, named);
  const rows = [
    `<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none'))}">${esc(`${k.verdict ?? 'none'}${compared.length ? ` · compared: ${compared.join(', ')}` : ''}`)}</dd>`,
    ...checks.map(checkRow),
    notShownRow(checkList, 'the second pass\'s checks'),
    ...(k.reason ? [`<dt>why</dt><dd>${esc(k.reason)}</dd>`] : []),
    `<dt>file</dt><dd>${esc(`sha256 ${shortSha(blend?.sha256_before)} before the read${blend?.sha256_after ? `, ${blend.sha256_after === blend.sha256_before ? 'the same after it' : `${shortSha(blend.sha256_after)} after it`}` : ''}${k.blender_version ? ` · ${k.blender_version}` : ''}`)}</dd>`,
    `<dt>cameras</dt><dd>${esc(cams.length ? capped(cams) : `none${read.active_camera ? ` (active: ${read.active_camera})` : ''}`)}</dd>`,
    notShownRow(cameras, 'the cameras read'),
    `<dt>in the file</dt><dd>${esc(`materials: ${capped(inFile)}`)}</dd>`,
    notShownRow(materials, 'the materials read'),
    ...(!checked.has('frame range') && Array.isArray(read.frame_range) ? [`<dt>frames</dt><dd>${esc(read.frame_range.join('–'))}</dd>`] : []),
    ...(!checked.has('resolution') && Array.isArray(read.render_resolution) ? [`<dt>resolution</dt><dd>${esc(`${read.render_resolution.join(' x ')}${finite(read.resolution_percentage) ? ` at ${read.resolution_percentage}%` : ''}`)}</dd>`] : []),
    ...(scenes.items.length ? [`<dt>scenes</dt><dd>${esc(scenes.items.map((s) => `${s.name}${finite(s.objects) ? ` (${s.objects} objects)` : ''}`).join(', '))}</dd>`] : []),
    notShownRow(scenes, 'the scenes read'),
    notShownRow(objects, 'the objects read'),
  ].join('');
  const shown = objects.items.slice(0, OBJECT_ROWS);
  const table = shown.length
    ? `<table class="objects"><thead><tr><th>object</th><th>type</th><th>dimensions</th><th>location</th></tr></thead><tbody>${shown.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.type)}</td><td>${esc(vec(o.dimensions))}</td><td>${esc(point(o.location))}</td></tr>`).join('')}</tbody></table>`
      + `<p class="meta">${esc(`dimensions and locations in Blender units, as Blender reported them${read.objects_total > shown.length ? ` · ${shown.length} of ${read.objects_total} objects shown; the record lists ${read.objects.length}` : ''}`)}</p>`
    : '';
  return `<section class="${verified ? 'measured' : 'unverified'} readback blend"><h4>${esc(heading)}</h4><p class="meta">${esc(BLEND_READBACK_SCOPE)}</p><dl>${rows}</dl>${table}<p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

/**
 * R4 (H37): the objects whose size changed, a count of the rest, where the sizes before come from, the units and the
 * tolerance; as measured when the record is verified, as recorded otherwise. DOCTRINE §15's sentence when the readback
 * block (which carries it) is not drawn.
 */
function dimensionsBlock(r: BlenderFlowRecord, verified: boolean, doctrine: boolean): string {
  const d = (r as { dimensions?: unknown }).dimensions;
  if (d === undefined) return '';
  const heading = verified ? 'object sizes, before → after' : 'object sizes, before → after, as the record says (not verified)';
  // R4 (H40): the unit settings too must be as Timmy writes them (each a word or a number), or the sizes are not put in words
  const body = isDimensionsSummary(d) && unitsAsWritten(d.units)
    ? (() => {
      const t = dimensionsText(d);
      return `<p class="sizes${d.after.agrees === false ? ' bad' : ''}">${esc(t.sizes)}</p><p class="meta">${esc(t.detail)}</p>`;
    })()
    : `<p class="meta">${esc('the record\'s dimensions are not in the form Timmy writes, so they are not shown')}</p>`;
  return `<section class="${verified ? 'measured' : 'unverified'} dimensions"><h4>${esc(heading)}</h4>${body}<p class="meta">${esc(DIMENSIONS_SCOPE)}</p>${doctrine ? `<p class="doctrine">${esc(DOCTRINE_15)}</p>` : ''}</section>`;
}

/**
 * R4 (H45): the summary, always in view: the script's change and its Python check, the second pass's verdict, and the
 * objects whose size changed, with who measured what in one line and DOCTRINE §15 (as the record says, not verified,
 * when no flow receipt sealed its bytes).
 */
function blenderSummary(r: BlenderFlowRecord, verified: boolean): string {
  const rows: Array<[string, string]> = [];
  const s = r.script && typeof r.script === 'object' ? r.script : undefined;
  const ch = s?.change;
  const syntax = s?.syntax && typeof s.syntax === 'object' ? s.syntax : undefined;
  const python = !syntax ? '' : syntax.checked ? (syntax.ok ? 'parses as Python' : 'does not parse as Python') : 'not checked as Python';
  const change = ch && finite(ch.added) && finite(ch.removed) && finite(ch.hunks_total) ? changeText(ch) : '';
  if (change || python) rows.push(['change', esc([change, python].filter(Boolean).join(' · '))]);
  const k = r.readback && typeof r.readback === 'object' ? r.readback : undefined;
  const compared = entries<BlendCheck>(k?.checks, named).items.filter((c) => c.passed !== null).map((c) => String(c.name));
  if (k?.verdict) rows.push(['verdict', `${verdictWord(String(k.verdict))}${esc(compared.length ? `compared by the second pass: ${compared.join(', ')}` : 'the second pass')}`]);
  const d = (r as { dimensions?: unknown }).dimensions;
  const sizes = d !== undefined && isDimensionsSummary(d) && unitsAsWritten(d.units) ? dimensionsText(d).sizes : '';
  if (sizes) rows.push(['object sizes', esc(sizes)]);
  const read = !!k?.read && Array.isArray(k.read.objects);
  const who = sizes || read
    ? `<p class="who">${esc(verified
      ? 'Blender reported the sizes in its run; a second Blender process read the saved .blend back: the same application reading its own file, not an independent implementation; lengths in Blender units of a generated scene'
      : 'Blender\'s report and the second pass, as the record says (not verified); lengths in Blender units of a generated scene')}</p><p class="doctrine">${esc(DOCTRINE_15)}</p>`
    : '';
  return summaryHtml(rows, who);
}

/** The card: drawn for a record whose target is 'blender' (isBlenderFlowRecord); `status` is the Flows section's verified line. */
export function blenderFlowCard(f: BoardFlow, h: FlowCardHelpers, status: string): string {
  const r = f.record as unknown as BlenderFlowRecord;
  const id = String(r.id);
  const outcome = String(r.outcome ?? 'unknown');
  const open = opensByDefault(outcome);
  const b = r.blender;
  const shots = entries<{ path: string; sha256: string }>(b?.renders, pathed);
  const renders = shots.items;
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.blender ? [`Blender ${r.receipts.blender}`] : []),
    ...(r.receipts?.readback ? [`second pass ${r.receipts.readback}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...renders.map((x) => `<li>${h.file(x.path)} <span class="tier">${esc(`the render · sha256 ${shortSha(x.sha256)}`)}</span></li>`),
    notShownItem(shots, 'the renders'),
    ...(b?.blend ? [`<li>${h.file(b.blend.path)} <span class="tier">${esc(`the .blend · sha256 ${shortSha(b.blend.sha256)}`)}</span></li>`] : []),
    ...(r.script?.path ? [`<li>${h.file(r.script.path)} <span class="tier">the script</span></li>`] : []),
    ...(b?.copy?.path ? [`<li>${h.file(b.copy.path)} <span class="tier">${esc('the copy Blender ran, kept at submission')}</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">${esc(f.live ? 'its state file (no record yet)' : 'this record')}</span></li>`,
  ].filter(Boolean);
  const picture = renders.length ? h.thumb(renders[0].path) : '';
  const verified = f.check.status === 'verified';
  const readback = readbackBlock(r, verified);
  // R4 (H45): what a person opens, each with its /open command (the commands are here only, once each).
  const artifacts = artifactsHtml([
    ...(b?.blend ? [{ role: '.blend', path: b.blend.path, note: 'the saved scene' }] : []),
    ...(r.script?.path ? [{ role: 'script', path: r.script.path, note: 'what the agent changed' }] : []),
    ...(renders.length ? [{ role: 'render', path: renders[0].path }] : []),
    { role: f.live ? 'state file' : 'record', path: f.file },
  ], h, receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : '');
  return `<article class="card flow blender"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate blender · ${r.script?.path ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${recordStrip(r, id)}${status}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${nextHtml(r, h)}${blenderSummary(r, verified)}${picture}${artifacts}`
    + detailsHtml({ id, part: 'checks', summary: 'the second pass: its checks, the object sizes, scope and DOCTRINE §15', body: `${dimensionsBlock(r, verified, !readback)}${readback}`, open })
    + detailsHtml({ id, part: 'change', summary: r.script?.after ? 'the script, before → after' : 'the script', body: scriptBlock(r, h), open })
    + detailsHtml({ id, part: 'steps', summary: 'the steps: jobs, receipts and raw output', body: stepsBlock(r, h), open })
    + detailsHtml({ id, part: 'files', summary: `files (${files.length})`, body: `<section class="files"><h4>files</h4><ul>${files.join('')}</ul></section>`, open })
    + `<div class="cmds">${[...(f.live ? [h.cmd(`/stop ${id}`)] : []), h.cmd('/iterate')].join('')}</div></article>`;
}

export const BLENDER_FLOW_CSS = `
.flow pre.diff { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
.flow pre.diff .removed { color: ${HOMEBREW.failure}; }
.flow pre.diff .added { color: ${HOMEBREW.accent}; }
.flow dd.bad { color: ${HOMEBREW.failure}; }
.flow .dimensions p.sizes { margin: 4px 0 0; overflow-wrap: anywhere; }
.flow .dimensions p.sizes.bad { color: ${HOMEBREW.failure}; }
.flow table.objects { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: ${TYPE.size.small}px; }
.flow table.objects th { text-align: left; color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; border-bottom: 1px solid ${HOMEBREW.line}; padding: 2px 6px 2px 0; }
.flow table.objects td { padding: 2px 6px 2px 0; overflow-wrap: anywhere; border-bottom: 1px solid ${HOMEBREW.line}; }
.flow.blender .thumb img { height: 180px; }
`;
