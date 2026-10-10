/**
 * The board's cards for the OpenSCAD and FreeCAD flows (round R4, /iterate scad and /iterate freecad, helper H33), drawn
 * in the Flows section (src/repl/board-flows.ts hands a record with `target: 'scad'` or `target: 'freecad'` here):
 *
 *   OpenSCAD  the parameter diff (changed values marked; names added or removed), each step's state, the STL and the
 *             PNG preview as links (the PNG as a picture), Timmy's reading of the STL against OpenSCAD's own summary,
 *             and the before → after numbers with who measured them;
 *   FreeCAD   the script's line diff and its Python check, each step's state, the .FCStd and the STEP as links,
 *             FreeCAD's report against the readback's measurement, and the before → after numbers with who measured them.
 *
 * As for every flow card, the record is an editable file: its values are verified only when a sealed `flow` receipt
 * names exactly its bytes; otherwise they are shown as the record says, not verified. Every dimension is labelled as
 * measured from the CAD file, with who measured it and DOCTRINE §15's sentence. Every string is escaped; links come
 * from the Flows section's own helpers (a link only inside the project; text on the live board).
 */
import { DOCTRINE_15 } from '../flows/iterate.js';
import { changeText, isNativeFlowRecord, numText, sizeText, syntaxWords } from '../flows/iterate-native.js';
import { isScadFlowRecord, SCAD_COMPARE_SCOPE, scadVolumeText, type ScadFlowRecord, type ScadParamChange } from '../flows/iterate-scad.js';
import { isFreecadFlowRecord, type FreecadFlowRecord } from '../flows/iterate-freecad.js';
import { FREECAD_READBACK_SCOPE } from '../native/freecad.js';
import { scadLiteral, type ScadValue } from '../native/scad-params.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';
import type { FlowRecord } from '../flows/iterate.js';

export { isNativeFlowRecord };

/** What the Flows section lends a card: a project file as a link (or text), a copyable command, a picture of an image file. */
export interface NativeCardHelpers {
  file: (p: unknown, label?: string) => string;
  cmd: (c: string) => string;
  thumb: (p: unknown) => string;
}
/** The card's record and its check, as the Flows section holds them. */
export interface NativeCardFlow { file: string; record: FlowRecord; check: { status: 'verified' | 'unverified'; receipt?: string } }

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const shortSha = (s: unknown): string => (typeof s === 'string' ? s.slice(0, 12) : '?');
const when = (iso: unknown): string => {
  const d = typeof iso === 'string' ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const triple = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(finite);
const point = (v: unknown): string => (triple(v) ? `(${v.map(numText).join(', ')})` : '?');
const value = (v: unknown): string => (v === null || v === undefined ? 'none' : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? scadLiteral(v as ScadValue) : '?');
const cost = (a: { cost_usd?: number | null; cost_basis?: string }): string => (a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : ` · cost $${Number(a.cost_usd).toFixed(4)}${a.cost_basis ? ` (${a.cost_basis})` : ''}`);

/** The agent's row (and the files it changed that it should not have), as the other flow cards show it. */
function agentRows(a: FlowRecord['agent'] | undefined, h: NativeCardHelpers): string[] {
  if (!a) return [];
  const rows = [`<dt>agent</dt><dd>${esc(`${a.agent} ${a.run}${a.model ? ` · model ${a.model}` : ''} · ${a.route} · ${a.outcome ?? 'running'}${cost(a)}${a.receipt ? ` · receipt ${a.receipt}` : ''}`)}${a.transcript ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`];
  if (Array.isArray(a.others) && a.others.length) rows.push(`<dt>also changed</dt><dd>${a.others.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(x.how)}</span>`).join(', ')}</dd>`);
  return rows;
}

/** The before → after rows: an earlier judged-ok run of the same file and this run, each labelled with its run, and who measured them. */
function beforeAfterRows(ba: { measured_by?: unknown; before?: unknown; before_note?: unknown; after?: unknown } | undefined, show: (m: Record<string, unknown>) => string): string {
  if (!ba || typeof ba !== 'object') return '';
  const b = ba.before && typeof ba.before === 'object' ? ba.before as Record<string, unknown> : undefined;
  const a = ba.after && typeof ba.after === 'object' ? ba.after as Record<string, unknown> : undefined;
  const label = (m: Record<string, unknown>): string => `run ${String(m.run ?? '?').slice(0, 8)}${typeof m.job === 'string' ? ` (job ${m.job})` : ''}`;
  const rows = [
    `<dt>before</dt><dd>${b ? `${esc(show(b))} <span class="tier">${esc(label(b))}</span>` : esc(typeof ba.before_note === 'string' ? ba.before_note : 'no earlier run')}</dd>`,
    `<dt>after</dt><dd>${a ? `${esc(show(a))} <span class="tier">${esc(label(a))}</span>` : esc('no measurement of this run')}</dd>`,
    `<dt>measured by</dt><dd>${esc(typeof ba.measured_by === 'string' ? ba.measured_by : 'unknown')}</dd>`,
  ];
  return `<h4>${esc('before → after')}</h4><dl>${rows.join('')}</dl>`;
}

// ── OpenSCAD ─────────────────────────────────────────────────────────────────────

function scadParamsBlock(r: ScadFlowRecord, h: NativeCardHelpers): string {
  const p = r.parameters;
  if (!p || typeof p !== 'object') return '';
  const diff: ScadParamChange[] = Array.isArray(p.diff) ? p.diff : [];
  const before = p.before?.values && typeof p.before.values === 'object' ? p.before.values : {};
  const rows = diff.length
    ? diff.map((d) => `<dt>${esc(d.name)}</dt><dd>${d.changed ? `<span class="was">${esc(value(d.before))}</span> → <strong class="changed">${esc(value(d.after))}</strong> <span class="tier">${esc(d.before === null ? 'added' : d.after === null ? 'removed' : 'changed')}</span>` : esc(value(d.after))}</dd>`).join('')
    : Object.entries(before).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(value(v))}${p.after ? '' : ' <span class="tier">before; no new value</span>'}</dd>`).join('');
  const shas = `sha256 ${shortSha(p.before?.sha256)}${p.after ? ` → ${shortSha(p.after.sha256)}` : ''}`;
  const names = p.names && (list(p.names.added).length || list(p.names.removed).length)
    ? `<p class="nomodel">${esc(`the agent ${[...(list(p.names.added).length ? [`added ${list(p.names.added).join(', ')}`] : []), ...(list(p.names.removed).length ? [`removed ${list(p.names.removed).join(', ')}`] : [])].join(' and ')}: values only may change`)}</p>` : '';
  const invalid = p.invalid ? `<p class="nomodel">${esc(`the agent left a file that does not check (sha256 ${shortSha(p.invalid.sha256)}): ${p.invalid.error}`)}</p>` : '';
  return `<section class="params"><h4>${esc(diff.length ? 'parameters, before → after' : 'parameters before')}</h4><dl>${rows}</dl>`
    + `<p class="meta">${h.file(p.path)} ${esc(`· ${shas}`)}${p.before?.kept ? ` · ${h.file(p.before.kept, 'the file as it was before the agent ran')}` : ''}${r.model?.path ? ` · ${esc('for')} ${h.file(r.model.path)}` : ''}</p>${names}${invalid}</section>`;
}

function scadStepsBlock(r: ScadFlowRecord, h: NativeCardHelpers): string {
  const rows = agentRows(r.agent, h);
  const o = r.openscad;
  if (o) {
    rows.push(`<dt>OpenSCAD</dt><dd>${esc(`${o.job ? `job ${o.job} · ` : ''}${o.state}${o.outcome ? ` · judged ${o.outcome}` : ''}${o.version ? ` · ${o.version}` : ''}${o.receipt ? ` · receipt ${o.receipt}` : ''}`)}`
      + `${o.record ? ` · ${h.file(o.record, 'its run\'s folder')}` : ''}${o.log ? ` · ${h.file(o.log, 'its output')}` : ''}</dd>`);
    if (Array.isArray(o.defines) && o.defines.length) rows.push(`<dt>-D</dt><dd>${esc(o.defines.join(' '))}</dd>`);
    if (o.why && o.outcome !== 'ok') rows.push(`<dt>why</dt><dd>${esc(o.why)}</dd>`);
    if (o.error) rows.push(`<dt>why</dt><dd>${esc(o.error)}</dd>`);
    if (o.messages && Array.isArray(o.messages.lines) && o.messages.lines.length) rows.push(`<dt>its lines</dt><dd><pre class="diff">${o.messages.lines.slice(0, 8).map((l) => esc(l)).join('\n')}</pre></dd>`);
    if (Array.isArray(o.failure_files) && o.failure_files.length) rows.push(`<dt>kept</dt><dd>${o.failure_files.map((x) => h.file(x)).join(', ')}</dd>`);
  }
  const k = r.readback;
  if (k) rows.push(`<dt>readback</dt><dd>${esc(`Timmy's STL reading against OpenSCAD's summary · ${k.verdict ?? 'no verdict'}`)}</dd>`);
  return rows.length ? `<section class="steps"><h4>steps</h4><dl>${rows.join('')}</dl></section>` : '';
}

function scadMeasuredBlock(r: ScadFlowRecord, verified: boolean): string {
  const k = r.readback;
  const m = k?.measured;
  const ba = r.before_after;
  if (!k && !ba?.before) return '';
  const rows: string[] = [];
  if (k) rows.push(`<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none').replace(/[^a-z]/gi, ''))}">${esc(k.verdict === 'no summary' ? 'succeeded, no OpenSCAD summary to compare' : k.verdict ?? 'none')}</dd>`);
  if (m && triple(m.size)) {
    rows.push(
      `<dt>size</dt><dd>${esc(`${sizeText(m.size)} (x × y × z in the file's units: millimetres by OpenSCAD's convention)`)}</dd>`,
      `<dt>from, to</dt><dd>${esc(`${point(m.min)} to ${point(m.max)}`)}</dd>`,
      `<dt>volume</dt><dd>${esc(scadVolumeText(m))}</dd>`,
      `<dt>mesh</dt><dd>${esc(`${m.triangles} triangles · ${m.manifold ? 'closed (edge-manifold)' : 'not closed'} · ${m.oriented ? 'consistently oriented' : 'not consistently oriented'}`)}</dd>`,
      `<dt>file</dt><dd>${esc(`${m.stl} · sha256 ${shortSha(m.sha256)} · ${m.measured_by ?? 'Timmy\'s own reading'}`)}</dd>`,
    );
  }
  const s = k?.summary;
  if (s) {
    const box = triple(s.min) && triple(s.max) ? ` · ${point(s.min)} to ${point(s.max)}` : '';
    const said = s.state === 'written' ? (s.agrees === true ? 'agrees with Timmy\'s reading' : s.agrees === false ? `differs from Timmy's reading by up to ${numText(s.differs_by)}` : 'holds no bounding box') : s.state === 'refused' ? `refused by this OpenSCAD${s.line ? ` (${s.line})` : ''}` : s.state;
    rows.push(`<dt>${esc("OpenSCAD's summary")}</dt><dd>${esc(`${said}${box}`)} <span class="tier">${esc('its own report, not Timmy\'s')}</span></dd>`);
  }
  for (const c of (k?.checks ?? []).filter((x) => x.passed === false)) rows.push(`<dt>${esc(c.name)}</dt><dd class="bad">${esc(c.detail)}</dd>`);
  if (k?.reason && k.verdict !== 'differs') rows.push(`<dt>why</dt><dd>${esc(k.reason)}</dd>`);
  const heading = verified ? 'measured from the CAD file: Timmy\'s own reading of the exported STL, against OpenSCAD\'s own summary' : 'measured from the CAD file, as the record says (not verified)';
  const measure = (x: Record<string, unknown>): string => `${sizeText(x.size)}, volume ${finite(x.volume) ? numText(x.volume) : '?'}`;
  return `<section class="${verified ? 'measured' : 'unverified'} readback native"><h4>${esc(heading)}</h4><p class="meta">${esc(SCAD_COMPARE_SCOPE)}</p>`
    + `${rows.length ? `<dl>${rows.join('')}</dl>` : ''}${beforeAfterRows(ba, measure)}<p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

function scadCard(f: NativeCardFlow, h: NativeCardHelpers, status: string): string {
  const r = f.record as unknown as ScadFlowRecord;
  const outcome = String(r.outcome ?? 'unknown');
  const o = r.openscad;
  const stl = o?.stl?.made ? o.stl : undefined;
  const png = o?.png?.made ? o.png : undefined;
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.openscad ? [`OpenSCAD ${r.receipts.openscad}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...(stl ? [`<li>${h.file(stl.path)} <span class="tier">${esc(`the STL · sha256 ${shortSha(stl.sha256)}`)}</span></li>`] : []),
    ...(png ? [`<li>${h.file(png.path)} <span class="tier">${esc(`the preview · sha256 ${shortSha(png.sha256)}`)}</span></li>`] : []),
    ...(r.parameters?.path ? [`<li>${h.file(r.parameters.path)} <span class="tier">the parameter file</span></li>`] : []),
    ...(r.model?.path ? [`<li>${h.file(r.model.path)} <span class="tier">the model</span></li>`] : []),
    ...(o?.copy?.path ? [`<li>${h.file(o.copy.path)} <span class="tier">${esc('the copy OpenSCAD ran, kept at submission')}</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">this record</span></li>`,
  ].join('');
  return `<article class="card flow scad"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate scad · ${r.model?.path ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${status}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${png ? h.thumb(png.path) : ''}${scadParamsBlock(r, h)}${scadStepsBlock(r, h)}${scadMeasuredBlock(r, f.check.status === 'verified')}`
    + `<section class="files"><h4>files</h4><ul>${files}</ul></section>`
    + `${receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : ''}`
    + `<div class="cmds">${[...(r.parameters?.path ? [h.cmd(`/open ${r.parameters.path}`)] : []), ...(stl ? [h.cmd(`/open ${stl.path}`)] : []), h.cmd(`/open ${f.file}`), h.cmd('/iterate')].join('')}</div></article>`;
}

// ── FreeCAD ──────────────────────────────────────────────────────────────────────

function scriptBlock(r: FreecadFlowRecord, h: NativeCardHelpers): string {
  const s = r.script;
  if (!s || typeof s !== 'object') return '';
  const shas = `sha256 ${shortSha(s.before?.sha256)}${s.after ? ` → ${shortSha(s.after.sha256)}` : ''}`;
  const rows = [
    `<dt>file</dt><dd>${h.file(s.path)} <span class="tier">${esc(shas)}</span></dd>`,
    ...(s.change && finite(s.change.added) ? [`<dt>change</dt><dd>${esc(changeText(s.change))}</dd>`] : s.after ? [] : ['<dt>change</dt><dd>none recorded</dd>']),
    ...(s.syntax ? [`<dt>python</dt><dd class="${s.syntax.checked && !s.syntax.ok ? 'bad' : ''}">${esc(syntaxWords(s.syntax, 'FreeCAD'))}</dd>`] : []),
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

function freecadStepsBlock(r: FreecadFlowRecord, h: NativeCardHelpers): string {
  const rows = agentRows(r.agent, h);
  const c = r.freecad;
  if (c) {
    rows.push(`<dt>FreeCAD</dt><dd>${esc(`${c.job ? `job ${c.job} · ` : ''}${c.state}${c.outcome ? ` · judged ${c.outcome} by its result file` : ''}${c.version ? ` · FreeCAD ${c.version}` : ''}${c.receipt ? ` · receipt ${c.receipt}` : ''}`)}`
      + `${c.result?.path ? ` · ${h.file(c.result.path, 'its result')}` : ''}${c.log ? ` · ${h.file(c.log, 'its output')}` : ''}</dd>`);
    if (c.why && c.outcome !== 'ok') rows.push(`<dt>why</dt><dd>${esc(c.why)}</dd>`);
    if (c.error) rows.push(`<dt>error</dt><dd>${esc(c.error)}</dd>`);
    if (Array.isArray(c.checks) && c.checks.length) rows.push(`<dt>its checks</dt><dd>${esc(`the script's own: ${c.checks.filter((x) => x.passed).length} of ${c.checks.length} passed`)}</dd>`);
    if (Array.isArray(c.failure_files) && c.failure_files.length) rows.push(`<dt>kept</dt><dd>${c.failure_files.map((x) => h.file(x)).join(', ')}</dd>`);
  }
  const k = r.readback;
  if (k) {
    rows.push(`<dt>readback</dt><dd>${esc(`${k.worker ? `${k.worker.name} ${k.worker.version} · ` : ''}${k.job ? `job ${k.job} · ` : ''}${k.state}${k.verdict ? ` · ${k.verdict}` : ''}${k.receipt ? ` · receipt ${k.receipt}` : ''}`)}`
      + `${k.log ? ` · ${h.file(k.log, 'its output')}` : ''}${k.record ? ` · ${h.file(k.record, 'its record')}` : ''}</dd>`);
    if (k.setup) rows.push(`<dt>setup</dt><dd>${esc(k.setup)}</dd>`);
  }
  return rows.length ? `<section class="steps"><h4>steps</h4><dl>${rows.join('')}</dl></section>` : '';
}

/** A shape (FreeCAD's report, or the readback's measurement) in words: "1 valid solid, 100 x 60 x 6 mm, 35203.6 mm3". */
function shapeText(x: Record<string, unknown> | undefined): string {
  if (!x) return 'none';
  const b = x.bounds && typeof x.bounds === 'object' ? x.bounds as Record<string, unknown> : undefined;
  const size = b && triple(b.size) ? b.size : b && triple(b.min) && triple(b.max) ? (b.max as number[]).map((v, i) => v - (b.min as number[])[i]) : x.size;
  const valid = x.valid === true ? 'valid' : x.valid === false ? 'NOT valid' : 'validity not reported';
  return `${finite(x.solids) ? `${x.solids} ${valid} solid${x.solids === 1 ? '' : 's'}` : valid}, ${sizeText(size)} mm, ${finite(x.volume_mm3) ? `${numText(x.volume_mm3)} mm3` : 'no volume'}`;
}

function freecadMeasuredBlock(r: FreecadFlowRecord, verified: boolean): string {
  const k = r.readback;
  const c = r.freecad;
  const ba = r.before_after;
  if (!c?.reported && !k?.measured && !ba?.before) return '';
  const rows: string[] = [];
  if (k) rows.push(`<dt>verdict</dt><dd class="verdict verdict-${esc(String(k.verdict ?? 'none').replace(/[^a-z]/gi, ''))}">${esc(k.verdict ?? (k.state === 'not run' ? 'succeeded without readback' : 'none'))}${k.tolerance && finite(k.tolerance.bounds_mm) ? ` <span class="tier">${esc(`within ${k.tolerance.bounds_mm} mm and ${k.tolerance.volume_relative} relative`)}</span>` : ''}</dd>`);
  if (c?.reported) rows.push(`<dt>FreeCAD reported</dt><dd>${esc(`${c.step?.path ?? 'its STEP'}: ${shapeText(c.reported as unknown as Record<string, unknown>)}`)} <span class="tier">${esc('FreeCAD\'s own report of its own document')}</span></dd>`);
  if (k?.measured) rows.push(`<dt>readback measured</dt><dd>${esc(shapeText(k.measured))} <span class="tier">${esc(typeof k.measured.measured_by === 'string' ? k.measured.measured_by : 'the readback worker')}</span></dd>`);
  for (const x of (k?.checks ?? []).filter((y) => !y.passed)) rows.push(`<dt>${esc(x.name)}</dt><dd class="bad">${esc(`FreeCAD reported ${String(x.reported)}, the readback measured ${String(x.measured)}`)} <span class="tier">outside the tolerance</span></dd>`);
  if (k?.reason && k.verdict !== 'differs') rows.push(`<dt>why</dt><dd>${esc(k.reason)}</dd>`);
  const heading = verified ? 'measured from the CAD file: FreeCAD\'s report, and the STEP read back in its own process' : 'measured from the CAD file, as the record says (not verified)';
  const measure = (x: Record<string, unknown>): string => `${sizeText(x.size)} mm, ${finite(x.volume_mm3) ? `${numText(x.volume_mm3)} mm3` : '?'}${typeof x.step === 'string' ? ` in ${x.step}` : ''}`;
  return `<section class="${verified ? 'measured' : 'unverified'} readback native"><h4>${esc(heading)}</h4><p class="meta">${esc(FREECAD_READBACK_SCOPE)}</p>`
    + `${rows.length ? `<dl>${rows.join('')}</dl>` : ''}${beforeAfterRows(ba, measure)}<p class="doctrine">${esc(DOCTRINE_15)}</p></section>`;
}

function freecadCard(f: NativeCardFlow, h: NativeCardHelpers, status: string): string {
  const r = f.record as unknown as FreecadFlowRecord;
  const outcome = String(r.outcome ?? 'unknown');
  const c = r.freecad;
  const receipts = [
    ...(r.receipts?.agent ? [`agent ${r.receipts.agent}`] : []), ...(r.receipts?.freecad ? [`FreeCAD ${r.receipts.freecad}`] : []),
    ...(r.receipts?.readback ? [`readback ${r.receipts.readback}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const fcstd = Array.isArray(c?.fcstd) ? c!.fcstd! : [];
  const files = [
    ...fcstd.map((x) => `<li>${h.file(x.path)} <span class="tier">${esc(`the FreeCAD document · sha256 ${shortSha(x.sha256)}`)}</span></li>`),
    ...(c?.step ? [`<li>${h.file(c.step.path)} <span class="tier">${esc(`the STEP · sha256 ${shortSha(c.step.sha256)}`)}</span></li>`] : []),
    ...(r.script?.path ? [`<li>${h.file(r.script.path)} <span class="tier">the script</span></li>`] : []),
    ...(c?.copy?.path ? [`<li>${h.file(c.copy.path)} <span class="tier">${esc('the copy freecadcmd ran, kept at submission')}</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">this record</span></li>`,
  ].join('');
  return `<article class="card flow freecad"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate freecad · ${r.script?.path ?? ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${r.ended_in ? ` · in the ${r.ended_in} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${status}`
    + `${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}${scriptBlock(r, h)}${freecadStepsBlock(r, h)}${freecadMeasuredBlock(r, f.check.status === 'verified')}`
    + `<section class="files"><h4>files</h4><ul>${files}</ul></section>`
    + `${receipts.length ? `<div class="meta">${esc(`receipts: ${receipts.join(' · ')}`)}</div>` : ''}`
    + `<div class="cmds">${[...(r.script?.path ? [h.cmd(`/open ${r.script.path}`)] : []), ...(c?.step ? [h.cmd(`/open ${c.step.path}`)] : []), ...fcstd.slice(0, 1).map((x) => h.cmd(`/open ${x.path}`)), h.cmd(`/open ${f.file}`), h.cmd('/iterate')].join('')}</div></article>`;
}

/** The card for an OpenSCAD or FreeCAD flow (isNativeFlowRecord); `status` is the Flows section's verified line. */
export function nativeFlowCard(f: NativeCardFlow, h: NativeCardHelpers, status: string): string {
  if (isScadFlowRecord(f.record)) return scadCard(f, h, status);
  if (isFreecadFlowRecord(f.record)) return freecadCard(f, h, status);
  // a record that says scad or freecad but lacks its parts: the record's own words, as recorded
  const r = f.record;
  return `<article class="card flow"><div class="jobhead"><strong>${esc(r.id)}</strong> <span class="state">${esc(String(r.outcome ?? 'unknown'))}</span></div>`
    + `<p class="instruction">${esc(r.instruction ?? '')}</p>${status}${r.why ? `<p class="why">${esc(r.why)}</p>` : ''}<section class="files"><h4>files</h4><ul><li>${h.file(f.file)} <span class="tier">this record</span></li></ul></section></article>`;
}

export const NATIVE_FLOW_CSS = `
.flow pre.diff { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
.flow pre.diff .removed { color: ${HOMEBREW.failure}; }
.flow pre.diff .added { color: ${HOMEBREW.accent}; }
.flow dd.bad { color: ${HOMEBREW.failure}; }
.flow section.readback.native { padding: 2px 0 2px 10px; }
.flow section.readback.native.unverified { border-left: 3px solid ${HOMEBREW.lineStrong}; }
.flow .verdict-nosummary { color: ${HOMEBREW.attention}; }
.flow.scad .thumb img { height: 180px; }
`;
