/**
 * The board's card for an After Effects flow (round R4, /iterate ae, helper H41), drawn in the Flows section
 * (src/repl/board-flows.ts hands a record with `target: 'ae'` here): the instruction, the script's line diff and its
 * compile check, each step's state (the agent, After Effects' /ae author run, aerender's render, the readback), the
 * frames the readback kept as pictures, the .aep, the render and the frames as links, After Effects' own report of the
 * comp before and after, and the readback's verdict with what it measured from the rendered file.
 *
 * As for every flow card, the record is an editable file: its values are verified only when a sealed `flow` receipt
 * names exactly its bytes; otherwise they are shown as the record says, not verified. Who measured what goes with each
 * number: After Effects' report is After Effects reading its own project, inside After Effects; the readback is the
 * rendered file read by ffprobe, ffmpeg and Timmy's pixel reading, outside After Effects (AE_READBACK_LABEL, said with
 * it). Every value comes from an editable file, so each is checked for its type before it is drawn, and every string is
 * escaped; links come from the Flows section's own helpers (a link only inside the project; text on the live board).
 */
import { AE_READBACK_LABEL, AE_REPORTED_BY, changeText, compileWords, isAeFlowRecord, type AeCompileCheck, type ScriptChange } from '../flows/iterate-ae.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

export { isAeFlowRecord };

/** What the Flows section lends a card: a project file as a link (or text), a copyable command, a picture of an image file. */
export interface AeCardHelpers {
  file: (p: unknown, label?: string) => string;
  cmd: (c: string) => string;
  thumb: (p: unknown) => string;
}
/** The card's record (as read from its file) and its check, as the Flows section holds them. */
export interface AeCardFlow { file: string; record: unknown; check: { status: 'verified' | 'unverified'; receipt?: string } }

type Obj = Record<string, unknown>;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const shortSha = (s: unknown): string => (typeof s === 'string' ? s.slice(0, 12) : '?');
const n3 = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000) / 1000) : '?');
const when = (iso: unknown): string => {
  const d = typeof iso === 'string' ? new Date(iso) : undefined;
  return d && !Number.isNaN(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
/** A value from a record in words: a point as "(240, 760)", a number rounded, a string as itself. */
const valueText = (v: unknown): string => {
  if (v === null || v === undefined) return 'nothing';
  if (Array.isArray(v)) return v.every(finite) ? `(${v.map(n3).join(', ')})` : '?';
  if (finite(v)) return n3(v);
  return typeof v === 'string' ? v : '?';
};
const cost = (a: Obj): string => (a.cost_usd === undefined ? '' : a.cost_usd === null ? ' · cost unknown' : finite(a.cost_usd) ? ` · cost $${a.cost_usd.toFixed(4)}${str(a.cost_basis) ? ` (${a.cost_basis as string})` : ''}` : '');
const MAX_FRAMES_SHOWN = 4;
const MAX_CHECK_ROWS = 40;
const MAX_LAYER_ROWS = 16;

// ── the script ───────────────────────────────────────────────────────────────────

function scriptBlock(s: Obj, h: AeCardHelpers): string {
  const before = obj(s.before);
  const after = obj(s.after);
  const change = obj(s.change);
  const syntax = obj(s.syntax);
  const shas = `sha256 ${shortSha(before?.sha256)}${after ? ` → ${shortSha(after.sha256)}` : ''}`;
  const bad = syntax?.checked === true && syntax.ok === false;
  const rows = [
    `<dt>file</dt><dd>${h.file(s.path)} <span class="tier">${esc(shas)}</span></dd>`,
    ...(change && finite(change.added) && finite(change.removed) && finite(change.hunks_total) ? [`<dt>change</dt><dd>${esc(changeText(change as unknown as ScriptChange))}</dd>`] : after ? [] : ['<dt>change</dt><dd>none recorded</dd>']),
    ...(syntax ? [`<dt>compile check</dt><dd class="${bad ? 'bad' : ''}">${esc(compileWords(syntax as unknown as AeCompileCheck))}</dd>`] : []),
    ...(str(before?.kept) ? [`<dt>before</dt><dd>${h.file(before!.kept, 'the script as it was before the agent ran')}</dd>`] : []),
  ].join('');
  const hunks = objs(change?.hunks);
  const diff = hunks.length
    ? `<pre class="diff">${hunks.map((k) => {
      const removed = list(k.removed);
      const added = list(k.added);
      return [
        `<span class="at">${esc(`@@ line ${n3(k.before_line)} → ${n3(k.after_line)}`)}</span>`,
        ...removed.map((l) => `<span class="removed">${esc(`- ${l}`)}</span>`),
        ...(finite(k.removed_total) && k.removed_total > removed.length ? [`<span class="at">${esc(`  … ${k.removed_total - removed.length} more taken out`)}</span>`] : []),
        ...added.map((l) => `<span class="added">${esc(`+ ${l}`)}</span>`),
        ...(finite(k.added_total) && k.added_total > added.length ? [`<span class="at">${esc(`  … ${k.added_total - added.length} more put in`)}</span>`] : []),
      ].join('\n');
    }).join('\n')}</pre>${finite(change?.hunks_total) && (change!.hunks_total as number) > hunks.length ? `<p class="meta">${esc(`and ${(change!.hunks_total as number) - hunks.length} more places in the record`)}</p>` : ''}`
    : '';
  return `<section class="params script"><h4>${esc(after ? 'the script, before → after' : 'the script')}</h4><dl>${rows}</dl>${diff}</section>`;
}

// ── the steps ────────────────────────────────────────────────────────────────────

function stepsBlock(r: Obj, h: AeCardHelpers): string {
  const rows: string[] = [];
  const a = obj(r.agent);
  if (a) {
    rows.push(`<dt>agent</dt><dd>${esc(`${valueText(a.agent)} ${valueText(a.run)}${str(a.model) ? ` · model ${a.model as string}` : ''} · ${valueText(a.route)} · ${str(a.outcome) ?? 'running'}${cost(a)}${str(a.receipt) ? ` · receipt ${a.receipt as string}` : ''}`)}${str(a.transcript) ? ` · ${h.file(a.transcript, 'transcript')}` : ''}</dd>`);
    const others = objs(a.others);
    if (others.length) rows.push(`<dt>also changed</dt><dd>${others.slice(0, 12).map((x) => `${h.file(x.path)} <span class="tier">${esc(valueText(x.how))}</span>`).join(', ')}</dd>`);
  }
  const au = obj(r.author);
  if (au) {
    const result = obj(au.result);
    rows.push(`<dt>After Effects</dt><dd>${esc(`${str(au.job) ? `job ${au.job as string} · ` : ''}/ae author${str(au.name) ? ` --name ${au.name as string}` : ''} · ${valueText(au.state)}${str(au.outcome) ? ` · judged ${au.outcome as string} by its result file` : ''}${str(au.ae_version) ? ` · After Effects ${au.ae_version as string}` : ''}${str(au.receipt) ? ` · receipt ${au.receipt as string}` : ''}`)}`
      + `${str(result?.path) ? ` · ${h.file(result!.path, 'its result')}` : ''}${str(au.log) ? ` · ${h.file(au.log, 'its output')}` : ''}</dd>`);
    if (str(au.why) && au.outcome !== 'ok') rows.push(`<dt>why</dt><dd>${esc(au.why)}</dd>`);
    if (str(au.error)) {
      const where = [...(str(au.stage) ? [`stage ${au.stage as string}`] : []), ...(finite(au.error_line) ? [`line ${au.error_line}`] : [])];
      rows.push(`<dt>error</dt><dd class="bad">${esc(`${au.error as string}${where.length ? ` (${where.join(', ')})` : ''}`)}</dd>`);
    }
    if (list(au.failure_files).length) rows.push(`<dt>kept</dt><dd>${list(au.failure_files).map((x) => h.file(x)).join(', ')}</dd>`);
  }
  const rd = obj(r.render);
  if (rd) {
    rows.push(`<dt>aerender</dt><dd>${esc(`${str(rd.job) ? `job ${rd.job as string} · ` : ''}the comp ${valueText(rd.comp)}${str(rd.requested) ? ` to ${rd.requested as string}` : ''}${typeof rd.om_template === 'string' ? ` · output module template "${rd.om_template}" (After Effects' own name, not checked by Timmy)` : ''} · ${valueText(rd.state)}${str(rd.outcome) ? ` · judged ${rd.outcome as string}` : ''}${str(rd.receipt) ? ` · receipt ${rd.receipt as string}` : ''}`)}`
      + `${str(rd.log) ? ` · ${h.file(rd.log, 'its output')}` : ''}</dd>`);
    const f = obj(rd.file);
    if (f && f.instead === true) rows.push(`<dt>written</dt><dd>${h.file(f.path)} ${esc(`instead of ${valueText(rd.requested)}: aerender's output module decides the container, and aerender gives the file that container's extension`)}</dd>`);
    if (str(rd.why) && rd.outcome !== 'ok') rows.push(`<dt>why</dt><dd>${esc(rd.why)}</dd>`);
    if (str(rd.error)) rows.push(`<dt>error</dt><dd class="bad">${esc(rd.error)}</dd>`);
    if (list(rd.failure_files).length) rows.push(`<dt>kept</dt><dd>${list(rd.failure_files).map((x) => h.file(x)).join(', ')}</dd>`);
  }
  const k = obj(r.readback);
  if (k) {
    const w = obj(k.worker);
    rows.push(`<dt>readback</dt><dd>${esc(`${w ? `${valueText(w.name)} ${valueText(w.version)} · ` : ''}${str(k.job) ? `job ${k.job as string} · ` : ''}${valueText(k.state)}${str(k.verdict) ? ` · ${k.verdict as string}` : ''}${str(k.receipt) ? ` · receipt ${k.receipt as string}` : ''}`)}`
      + `${str(k.log) ? ` · ${h.file(k.log, 'its output')}` : ''}</dd>`);
    if (str(k.setup)) rows.push(`<dt>setup</dt><dd>${esc(k.setup)}</dd>`);
  }
  return rows.length ? `<section class="steps"><h4>steps</h4><dl>${rows.join('')}</dl></section>` : '';
}

// ── before → after: After Effects' own report of the comp ────────────────────────

/** A comp's facts in words: "Main 1920x1080, 30 fps, 10 s, 3 layers". */
const compText = (c: Obj): string => {
  const size = Array.isArray(c.size) ? c.size : [];
  return `${valueText(c.comp)} ${n3(size[0])}x${n3(size[1])}, ${n3(c.fps)} fps, ${n3(c.duration)} s, ${finite(c.layers_total) ? c.layers_total : '?'} layer${c.layers_total === 1 ? '' : 's'}`;
};
/** A layer's Position as the record keeps it: its keys ("0 s (240, 760), 2 s (1680, 760)") or its value. */
const positionText = (p: unknown): string => {
  const o = obj(p);
  if (!o) return '–';
  const keys = Array.isArray(o.keys) ? o.keys.filter((k): k is unknown[] => Array.isArray(k) && k.length >= 2) : [];
  if (keys.length) return `${keys.map((k) => `${n3(k[0])} s ${valueText(k[1])}`).join(', ')}${finite(o.num_keys) && o.num_keys > keys.length ? `, … (${o.num_keys} keys)` : ''}`;
  return valueText(o.value);
};
const spanText = (s: unknown): string => (Array.isArray(s) && s.length === 2 ? `${n3(s[0])}–${n3(s[1])} s` : '–');
const colourText = (c: unknown): string => (Array.isArray(c) && c.length && c.every((x) => finite(x) || x === null) ? `[${c.map(n3).join(', ')}]` : '–');

function beforeAfterBlock(r: Obj, verified: boolean): string {
  const ba = obj(r.before_after);
  if (!ba) return '';
  const before = obj(ba.before);
  const after = obj(ba.after);
  const label = (m: Obj): string => `run ${String(m.run ?? '?').slice(0, 8)}${str(m.job) ? ` (job ${m.job as string})` : ''}`;
  const changes = list(ba.changes);
  const rows = [
    `<dt>before</dt><dd>${before ? `${esc(compText(before))} <span class="tier">${esc(label(before))}</span>` : esc(str(ba.before_note) ?? 'no earlier run')}</dd>`,
    `<dt>after</dt><dd>${after ? `${esc(compText(after))} <span class="tier">${esc(label(after))}</span>` : esc('no report of this run')}</dd>`,
    ...(before && after ? [`<dt>changed</dt><dd>${changes.length ? `<ul class="changes">${changes.slice(0, 12).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>${changes.length > 12 ? esc(` and ${changes.length - 12} more in the record`) : ''}` : esc('nothing After Effects reported changed')}</dd>`] : []),
    `<dt>reported by</dt><dd>${esc(AE_REPORTED_BY)}</dd>`,
  ].join('');
  // The layers as After Effects reported them in this run, with each one's Position before when there was a before.
  const was = new Map<string, Obj>();
  for (const l of objs(before?.layers)) if (typeof l.name === 'string' && !was.has(l.name)) was.set(l.name, l);
  const layers = objs(after?.layers);
  const shown = layers.slice(0, MAX_LAYER_ROWS);
  const table = shown.length
    ? `<div class="scroll"><table class="layers"><thead><tr><th>layer</th><th>kind</th><th>colour</th><th>in–out</th>${before ? '<th>Position before</th>' : ''}<th>Position</th></tr></thead><tbody>${shown.map((l) => {
      const old = typeof l.name === 'string' ? was.get(l.name) : undefined;
      const pos = positionText(l.position);
      const oldPos = old ? positionText(old.position) : 'not there';
      return `<tr><td>${esc(valueText(l.name))}${typeof l.text === 'string' ? ` <span class="tier">${esc(`"${l.text}"`)}</span>` : ''}</td><td>${esc(valueText(l.kind))}</td><td>${esc(colourText(l.colour))}</td><td>${esc(spanText(l.span))}</td>`
        + `${before ? `<td>${esc(oldPos)}</td>` : ''}<td${before && oldPos !== pos ? ' class="changed"' : ''}>${esc(pos)}</td></tr>`;
    }).join('')}</tbody></table></div>`
      + `<p class="meta">${esc(`positions in comp pixels, times in seconds, colours as After Effects' 0–1 RGB${layers.length > shown.length ? ` · ${shown.length} of ${layers.length} layers shown` : ''}${finite(after?.layers_total) && (after!.layers_total as number) > layers.length ? `; the record keeps ${layers.length} of ${after!.layers_total}` : ''}`)}</p>`
    : '';
  const heading = verified ? 'the comp, before → after: After Effects\' own report' : 'the comp, before → after: After Effects\' own report, as the record says (not verified)';
  return `<section class="${verified ? 'measured' : 'unverified'} beforeafter"><h4>${esc(heading)}</h4><dl>${rows}</dl>${table}</section>`;
}

// ── the readback ─────────────────────────────────────────────────────────────────

function checkRow(c: Obj): string {
  const passed = c.passed === true ? 'within' : c.passed === false ? 'outside' : 'not compared';
  const note = str(c.note) ? ` <span class="tier">${esc(c.note)}</span>` : '';
  const diff = c.difference === undefined || c.difference === null ? '–' : valueText(c.difference);
  return `<tr class="${c.passed === false ? 'bad' : ''}"><td>${esc(valueText(c.name))}</td><td>${esc(valueText(c.reported))}</td><td>${esc(valueText(c.measured))}</td><td>${esc(diff)}</td>`
    + `<td>${esc(`${passed}${str(c.tolerance) && c.passed !== null ? ` ${c.tolerance as string}` : ''}`)}${note}</td></tr>`;
}

function readbackBlock(r: Obj, h: AeCardHelpers, verified: boolean): string {
  const k = obj(r.readback);
  if (!k) return '';
  const rows: string[] = [];
  const notRun = k.state === 'not run';
  const verdict = str(k.verdict) ?? (notRun ? 'succeeded without readback' : 'none');
  rows.push(`<dt>verdict</dt><dd class="verdict verdict-${esc(verdict.replace(/[^a-z]/gi, ''))}">${esc(verdict)}</dd>`);
  if (notRun && str(k.setup)) rows.push(`<dt>setup</dt><dd>${esc(k.setup)}</dd>`);
  const p = obj(k.probe);
  if (p) {
    const fps = Array.isArray(p.fps) && p.fps.length === 2 ? ` (${valueText(p.fps[0])}/${valueText(p.fps[1])})` : '';
    rows.push(`<dt>the render</dt><dd>${esc(`${str(p.codec) ? `${p.codec as string}, ` : ''}${n3(p.width)}x${n3(p.height)}, ${n3(p.fps_value)} fps${fps}, ${n3(p.duration)} s, ${finite(p.frames) ? p.frames : '?'} frames`)} <span class="tier">${esc('ffprobe\'s reading of the file')}</span></dd>`);
  }
  if (finite(k.scale) && Array.isArray(k.scaled)) rows.push(`<dt>read at</dt><dd>${esc(`1/${k.scale} scale: ${valueText(k.scaled[0])}x${valueText(k.scaled[1])} pixels a frame, decoded by ffmpeg as 8-bit RGB`)}</dd>`);
  const t = obj(k.tolerance);
  if (t) rows.push(`<dt>tolerance</dt><dd>${esc(`positions within ${n3(t.x_px)} x ${n3(t.y_px)} comp pixels (${valueText(t.rule)}); a pixel is the layer's colour within ${n3(t.colour)}${str(t.colour_metric) ? ` (${t.colour_metric as string})` : ''}`)}</dd>`);
  if (str(k.reason) && k.verdict !== 'differs') rows.push(`<dt>why</dt><dd>${esc(k.reason)}</dd>`);
  const v = obj(k.video);
  const tools = obj(k.tools);
  const tool = (x: unknown, name: string): string => (str(obj(x)?.version) ? `${name} ${obj(x)!.version as string}` : name);
  if (v) rows.push(`<dt>file</dt><dd>${h.file(v.path)} <span class="tier">${esc(`sha256 ${shortSha(v.sha256)} · read by ${tool(tools?.ffprobe, 'ffprobe')} and ${tool(tools?.ffmpeg, 'ffmpeg')}`)}</span></dd>`);
  const checks = objs(k.checks);
  const shown = checks.slice(0, MAX_CHECK_ROWS);
  const table = shown.length
    ? `<div class="scroll"><table class="checks"><thead><tr><th>check</th><th>After Effects reported</th><th>the render, measured</th><th>difference</th><th>result</th></tr></thead><tbody>${shown.map(checkRow).join('')}</tbody></table></div>`
      + `${checks.length > shown.length ? `<p class="meta">${esc(`${shown.length} of ${checks.length} checks shown; the record has them all`)}</p>` : ''}`
    : '';
  const notCompared = list(k.not_compared);
  const left = notCompared.length ? `<p class="meta">${esc(`not compared: ${notCompared.slice(0, 8).join('; ')}${notCompared.length > 8 ? `; and ${notCompared.length - 8} more` : ''}`)}</p>` : '';
  const heading = notRun ? 'no readback: the render was not read back, so it is not compared with After Effects\' report' : verified ? 'the render, read back outside After Effects' : 'the render, read back outside After Effects, as the record says (not verified)';
  // What the readback is goes with what it measured; a readback that did not run measured nothing, so its label is not drawn.
  const label = notRun ? '' : `<p class="meta label">${esc(AE_READBACK_LABEL)}</p>`;
  return `<section class="${verified && !notRun ? 'measured' : 'unverified'} readback ae"><h4>${esc(heading)}</h4>${label}`
    + `<dl>${rows.join('')}</dl>${table}${left}</section>`;
}

/** The frames the readback kept, as pictures (none on the live board), each with its frame and time. */
function framesBlock(frames: Obj[], h: AeCardHelpers): string {
  const pictures = frames.slice(0, MAX_FRAMES_SHOWN).map((x) => {
    const pic = h.thumb(x.path);
    return pic ? `<figure>${pic}<figcaption>${esc(`frame ${valueText(x.frame)} · ${n3(x.time)} s`)}</figcaption></figure>` : '';
  }).filter(Boolean);
  return pictures.length ? `<div class="frames">${pictures.join('')}</div>` : '';
}

/** The card: drawn for a record whose target is 'ae' (isAeFlowRecord); `status` is the Flows section's verified line. */
export function aeFlowCard(f: AeCardFlow, h: AeCardHelpers, status: string): string {
  const r = obj(f.record) ?? {};
  const outcome = String(r.outcome ?? 'unknown');
  const script = obj(r.script) ?? {};
  const author = obj(r.author);
  const render = obj(r.render);
  const readback = obj(r.readback);
  const aep = obj(author?.aep);
  const video = obj(render?.file);
  const copy = obj(author?.copy);
  const plan = obj(readback?.plan);
  const frames = objs(readback?.frames).filter((x) => str(x.path));
  const receipts = obj(r.receipts) ?? {};
  const receiptWords = [
    ...(str(receipts.agent) ? [`agent ${receipts.agent as string}`] : []), ...(str(receipts.author) ? [`After Effects ${receipts.author as string}`] : []),
    ...(str(receipts.render) ? [`aerender ${receipts.render as string}`] : []), ...(str(receipts.readback) ? [`readback ${receipts.readback as string}`] : []),
    ...(f.check.status === 'verified' && f.check.receipt ? [`flow ${f.check.receipt}`] : []),
  ];
  const files = [
    ...(video && str(video.path) ? [`<li>${h.file(video.path)} <span class="tier">${esc(`the render · sha256 ${shortSha(video.sha256)}${finite(video.bytes) ? ` · ${video.bytes} bytes` : ''}${video.instead === true ? ` · written instead of ${valueText(render?.requested)}` : ''}`)}</span></li>`] : []),
    ...(aep && str(aep.path) ? [`<li>${h.file(aep.path)} <span class="tier">${esc(`the After Effects project · sha256 ${shortSha(aep.sha256)}`)}</span></li>`] : []),
    ...frames.slice(0, 6).map((x) => `<li>${h.file(x.path)} <span class="tier">${esc(`frame ${valueText(x.frame)} at ${n3(x.time)} s, as the readback read it · sha256 ${shortSha(x.sha256)}`)}</span></li>`),
    ...(frames.length > 6 ? [`<li>${esc(`and ${frames.length - 6} more frames in the record`)}</li>`] : []),
    ...(str(script.path) ? [`<li>${h.file(script.path)} <span class="tier">the script</span></li>`] : []),
    ...(copy && str(copy.path) ? [`<li>${h.file(copy.path)} <span class="tier">${esc('the copy After Effects ran, kept at submission')}</span></li>`] : []),
    ...(plan && str(plan.path) ? [`<li>${h.file(plan.path)} <span class="tier">${esc('the readback\'s plan: the layers and times it read')}</span></li>`] : []),
    `<li>${h.file(f.file)} <span class="tier">this record</span></li>`,
  ].join('');
  const verified = f.check.status === 'verified';
  const options = obj(r.options);
  const asked = [...(typeof options?.comp === 'string' ? [`--comp ${options.comp}`] : []), ...(typeof options?.om === 'string' ? [`--om ${options.om}`] : [])].join(' ');
  return `<article class="card flow ae"><div class="jobhead"><strong>${esc(valueText(r.id))}</strong> <span class="state state-${esc(outcome.replace(/[^a-z]/gi, ''))}">${esc(outcome)}</span></div>`
    + `<div class="meta">${esc(`iterate ae · ${valueText(script.path)}${asked ? ` ${asked}` : ''} · started ${when(r.started_at)}${r.ended_at ? ` · ended ${when(r.ended_at)}` : ''}${str(r.ended_in) ? ` · in the ${r.ended_in as string} step` : ''}`)}</div>`
    + `<p class="instruction">${esc(valueText(r.instruction))}</p>${status}`
    + `${str(r.why) ? `<p class="why">${esc(r.why)}</p>` : ''}${framesBlock(frames, h)}${scriptBlock(script, h)}${stepsBlock(r, h)}${beforeAfterBlock(r, verified)}${readbackBlock(r, h, verified)}`
    + `<section class="files"><h4>files</h4><ul>${files}</ul></section>`
    + `${receiptWords.length ? `<div class="meta">${esc(`receipts: ${receiptWords.join(' · ')}`)}</div>` : ''}`
    + `<div class="cmds">${[...(str(script.path) ? [h.cmd(`/open ${script.path as string}`)] : []), ...(video && str(video.path) ? [h.cmd(`/open ${video.path as string}`)] : []), ...(aep && str(aep.path) ? [h.cmd(`/open ${aep.path as string}`)] : []), h.cmd(`/open ${f.file}`), h.cmd('/iterate')].join('')}</div></article>`;
}

export const AE_FLOW_CSS = `
.flow.ae pre.diff { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
.flow.ae pre.diff .removed { color: ${HOMEBREW.failure}; }
.flow.ae pre.diff .added { color: ${HOMEBREW.accent}; }
.flow.ae dd.bad, .flow.ae tr.bad td { color: ${HOMEBREW.failure}; }
.flow.ae td.changed { color: ${HOMEBREW.accent}; }
.flow.ae section.beforeafter, .flow.ae section.readback.ae { padding: 2px 0 2px 10px; }
.flow.ae section.beforeafter.unverified, .flow.ae section.readback.ae.unverified { border-left: 3px solid ${HOMEBREW.lineStrong}; }
.flow.ae section.beforeafter.measured { border-left: 3px solid ${HOMEBREW.accent}; }
.flow.ae ul.changes { margin: 0; padding-left: 18px; }
.flow.ae .scroll { overflow-x: auto; max-width: 100%; }
.flow.ae table.layers, .flow.ae table.checks { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: ${TYPE.size.small}px; }
.flow.ae table th { text-align: left; color: ${HOMEBREW.textSecondary}; font-weight: ${TYPE.weight.body}; border-bottom: 1px solid ${HOMEBREW.line}; padding: 2px 6px 2px 0; }
.flow.ae table td { padding: 2px 6px 2px 0; overflow-wrap: anywhere; border-bottom: 1px solid ${HOMEBREW.line}; vertical-align: top; }
.flow.ae p.label { color: ${HOMEBREW.text}; }
.flow.ae .verdict-succeededwithoutreadback { color: ${HOMEBREW.attention}; }
.flow.ae .frames { display: flex; flex-wrap: wrap; gap: 8px; }
.flow.ae .frames figure { margin: 0; }
.flow.ae .frames img { height: 120px; max-width: 100%; }
.flow.ae .frames figcaption { font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; }
`;
