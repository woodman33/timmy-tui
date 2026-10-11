/**
 * Round R4 (H22): the live board's edits. `/board live` (src/repl/board-live.ts) takes them at POST /edit, with
 * the same protections as its actions (127.0.0.1 only, its own Host and Origin, the bearer token, JSON only,
 * a size limit, one at a time in the actions' queue), and hands each to `applyBoardEdit`. There are two, each
 * an exact shape checked on the server; neither runs a command:
 * - `set-params`: the tray recipe's parameter file, checked by the recipe's own rules (src/repl/board-cards.ts); refused
 *   while an /iterate flow runs in the project, which the Workspace passes in the context (`flowIn`; the R4 review, R4-3);
 * - `save-workflow`: a workflow document's named blocks, rewritten in place (src/repl/board-nodes.ts).
 *
 * EDIT_SCRIPT is the page's side: the node editor and the parameter form. It never sees the token: the live
 * board's own script hands it a `send` function (TimmyBoardEdit.attach). It builds every element with
 * createElement and textContent, and marks a card it is editing with data-editing, so the live page does not
 * redraw the board over unsaved work (jobs still update in place).
 *
 * R4 (H45): the parameter form shows each edited field's before → after beside the saved value, and offers Save only
 * while a value differs from the one it was drawn with (or the file there is not usable); typing the drawn values back
 * makes the card clean again.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { checkScadParams, paramsFileFor, readScadParams, scadParamsText, type ScadValue } from '../native/scad-params.js';
import { writeProjectFile } from '../project/index.js';
import { saveParams } from './board-cards.js';
import { filePlace, keepPrevious, saveWorkflow, type EditAnswer, type EditContext } from './board-nodes.js';
import { WORKFLOW_SCRIPT } from './board-workflows.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

/** The largest edit body read; a larger one is refused before it is parsed. */
export const EDIT_LIMIT = 256 * 1024;

/** An edit body, checked and applied: the answer for the page and one line for the transcript. */
export function applyBoardEdit(body: unknown, ctx: EditContext): EditAnswer {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, text: 'An edit is a JSON object.', line: 'refused an edit: not a JSON object' };
  const o = body as Record<string, unknown>;
  if (o.action === 'set-params') return saveParams(o, ctx);
  if (o.action === 'save-workflow') return saveWorkflow(o, ctx);
  if (o.action === 'set-scad-params') return saveScadParams(o, ctx);
  return { status: 400, text: 'Unknown edit: set-params, set-scad-params and save-workflow are the edits.', line: 'refused an unknown edit' };
}

// ── R4 (H47): an OpenSCAD model's parameter file, saved from the board ─────────

/** Where the previous versions of an OpenSCAD parameter file are kept (each under its own path). */
export const SCAD_HISTORY_DIR = '.timmy/params-history/scad';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const keysAre = (o: Record<string, unknown>, keys: string[]): boolean => {
  const have = Object.keys(o).sort();
  return have.length === keys.length && [...keys].sort().every((x, i) => have[i] === x);
};
const reply = (status: number, text: string, line = text): EditAnswer => ({ status, text, line });
const CONTROL = /[\x00-\x1f\x7f]/;
const kindWords = (v: unknown): string => (typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'true or false' : typeof v === 'string' ? 'text' : v === null ? 'null' : Array.isArray(v) ? 'a list' : 'something else');
const shown = (v: ScadValue): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * `set-scad-params`: {"action":"set-scad-params","model":"<model.scad>","base":"<sha256 of its parameter file as shown>",
 * "parameters":{"<name>": <value>, …}}. It mirrors set-params (src/repl/board-cards.ts saveParams):
 * - the model is one whose parameter file the board shows now (`<model>.params.json`, src/native/scad-params.ts);
 * - refused (409) while an /iterate flow runs in the project (its agent may be changing this very file), and when the file
 *   changed since the board showed it (its sha256 is not `base`);
 * - the parameters are the file's own names, each once, each value of the kind the file gives it (the board changes
 *   values, not names or kinds), every value checked by the scad-params rules (checkScadParams);
 * - the file is a regular file in place (no link on its way); its previous bytes are kept under
 *   .timmy/params-history/scad/<file>/ first, then it is replaced atomically, and an edit receipt is sealed.
 * Nothing runs. The answer says what changed, or why nothing was written.
 */
export function saveScadParams(body: Record<string, unknown>, ctx: EditContext): EditAnswer {
  if (!keysAre(body, ['action', 'model', 'base', 'parameters']) || typeof body.model !== 'string' || !body.model || body.model.length > 512 || CONTROL.test(body.model)
    || typeof body.base !== 'string' || !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) {
    return reply(400, 'An OpenSCAD parameter save is {"action":"set-scad-params","model":"<model.scad>","base":"<sha256>","parameters":{…}}.');
  }
  const model = body.model;
  if (!/\.scad$/i.test(model) || !(ctx.scadModels ?? []).includes(model)) return reply(404, `No OpenSCAD parameter card for ${model.slice(0, 80)} on this board.`);
  const base = body.base;
  if (!/^[0-9a-f]{64}$/.test(base)) return reply(400, 'base is the 64 hex characters of the parameter file as the board showed it.');
  const rel = paramsFileFor(model);
  // Not while a flow runs here, whatever the file's sha256 is now; nothing is read or written.
  const flow = ctx.flowIn?.();
  if (flow) {
    const who = flow.id ? `flow ${flow.id} is running` : 'a flow is being started';
    // R4 (H51): a flow another Timmy process runs here is named with that process; it is stopped there.
    if (flow.elsewhere) return reply(409, `${who} in this project ${flow.elsewhere}: save after it ends`, `refused an OpenSCAD parameter save: ${who} in this project ${flow.elsewhere}`);
    return reply(409, `${who} in this project: save after it ends, or /stop it`, `refused an OpenSCAD parameter save: ${who} in this project`);
  }
  const now = readScadParams(ctx.root, model);
  if (!now.ok) return reply(422, `${rel} is not usable: ${now.error}. Nothing was written; /edit ${rel} fixes it.`, `refused an OpenSCAD parameter save: ${rel} is not usable`);
  if (!now.exists) return reply(409, `${rel} is not there any more; nothing was written.`, `refused an OpenSCAD parameter save: ${rel} is gone`);
  if (now.sha256 !== base) {
    return reply(409, `${rel} changed since the board showed it (it is now sha256 ${now.sha256.slice(0, 12)}); nothing was written. Discard shows it as it is now.`, `refused an OpenSCAD parameter save: ${rel} changed since the board showed it`);
  }
  const given = body.parameters as Record<string, unknown>;
  const names = Object.keys(now.parameters);
  if (!keysAre(given, names)) return reply(400, `The parameters of ${rel} are ${names.join(', ') || '(none)'}, each once: the board changes values, not names.`);
  for (const n of names) {
    const was = now.parameters[n];
    const v = given[n];
    if (typeof v !== typeof was) {
      return reply(422, `Refused: ${n} is ${kindWords(was)} in ${rel}, and ${String(JSON.stringify(v)).slice(0, 40)} is ${kindWords(v)}: the board keeps each parameter's kind. Nothing was written.`, `refused an OpenSCAD parameter save: ${n} changed its kind`);
    }
  }
  const checked = checkScadParams(given);
  if (!checked.ok) return reply(422, `Refused: ${checked.error}. Nothing was written; ${rel} is as it was.`, `refused an OpenSCAD parameter save: ${checked.error}`);
  const next: Record<string, ScadValue> = Object.fromEntries(names.map((n) => [n, checked.parameters[n]]));
  const words = names.map((n) => (Object.is(now.parameters[n], next[n]) ? `${n} ${shown(next[n])}` : `${n} ${shown(now.parameters[n])} → ${shown(next[n])}`)).join(', ');
  if (names.every((n) => Object.is(now.parameters[n], next[n]))) return reply(200, `No change: ${rel} already holds ${words} (sha256 ${base.slice(0, 12)}); nothing was written.`, `no change to ${rel}`);
  // In place: a regular file, reached through no link; its bytes still the ones shown.
  const place = filePlace(ctx.root, rel);
  if (!place.ok) return reply(place.status, `${place.error} Nothing was written.`);
  let bytes: Buffer;
  try { bytes = readFileSync(place.value.abs); } catch { return reply(409, `${rel} could not be read again; nothing was written.`); }
  if (sha(bytes) !== base) return reply(409, `${rel} changed while it was being saved; nothing was written.`);
  const kept = keepPrevious(ctx.root, rel, bytes, { dir: SCAD_HISTORY_DIR, ext: '.json' });
  if (!kept.ok) return reply(500, `Nothing was written: the previous version of ${rel} could not be kept (${kept.error}).`);
  let text: string;
  try { text = scadParamsText(posix.basename(model), next); } catch (e) { return reply(422, `Refused: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`); }
  try { if (sha(readFileSync(place.value.abs)) !== base) return reply(409, `${rel} changed while it was being saved; nothing was written over it (the version shown is kept at ${kept.rel}).`); } catch { return reply(409, `${rel} went away while it was being saved; nothing was written.`); }
  const w = writeProjectFile(ctx.root, rel, text);
  if (!w.ok) return reply(500, `${rel} could not be written (${w.error}); the previous version is kept at ${kept.rel}.`);
  let receipt: string | undefined;
  try {
    receipt = ctx.seal?.({
      kind: 'edit', subject: `edit · ${rel} · OpenSCAD parameters from the live board`, policy: 'human-gated', status: 'ok', project: ctx.project, project_id: ctx.projectId,
      files: [{ path: rel, sha256: w.sha256, previous_sha256: base, created: false, bytes: w.bytes }],
      sources: [{ path: kept.rel, sha256: base, role: 'previous version' }],
    });
  } catch { receipt = undefined; }
  return reply(200,
    `Saved ${rel}: ${words}. sha256 ${w.sha256.slice(0, 12)} (was ${base.slice(0, 12)}); the previous version is kept at ${kept.rel}${receipt ? `; receipt ${receipt}` : '; no receipt was sealed'}. /scad ${model} takes these values.`,
    `saved ${rel}: ${words}${receipt ? ` · receipt ${receipt}` : ''}`);
}

/** The page's editor. Runs before the live board's script, which calls TimmyBoardEdit.attach({ send, refresh }). */
export const EDIT_SCRIPT = `
var TimmyBoardEdit = (function () {
  'use strict';
  var api = null;
  var NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/;
  var mk = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  var btn = function (label, attr, cls) { var b = mk('button', cls || 'act quiet', label); b.type = 'button'; b.setAttribute(attr, ''); return b; };
  var out = function (text, bad) { var o = document.getElementById('out'); if (!o) return; o.hidden = false; o.textContent = text; o.className = bad ? 'bad' : ''; };
  var unreachable = 'The edit did not reach Timmy: is /board live still running?';

  /* ── the node editor ── */
  var rowOf = function (m, t) {
    var li = t.closest('[data-row]');
    if (!li) return null;
    var id = Number(li.getAttribute('data-row'));
    for (var i = 0; i < m.rows.length; i++) if (m.rows[i].id === id) return m.rows[i];
    return null;
  };
  var nameOf = function (m, id) { for (var i = 0; i < m.rows.length; i++) if (m.rows[i].id === id) return m.rows[i].name; return ''; };
  var say = function (m, text, bad) {
    m.msg = { t: text, bad: !!bad };
    var p = m.card.querySelector('[data-wf-msg]');
    if (p) { p.textContent = text; p.className = 'wf-msg' + (bad ? ' bad' : ''); }
  };
  var drawNeeds = function (m) {
    var count = Object.create(null);
    m.rows.forEach(function (r) { count[r.name] = (count[r.name] || 0) + 1; });
    m.rows.forEach(function (r) {
      var li = m.card.querySelector('[data-row="' + r.id + '"]');
      if (!li) return;
      var box = li.querySelector('[data-needs]');
      while (box.firstChild) box.removeChild(box.firstChild);
      box.appendChild(mk('span', 'wf-needs-label', 'needs'));
      var others = 0;
      m.rows.forEach(function (o) {
        if (o.id === r.id) return;
        others++;
        var lab = mk('label', 'wf-need');
        var cb = mk('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-need', String(o.id));
        cb.checked = r.needs.some(function (n) { return n.id === o.id; });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' ' + (o.name || '(no name yet)')));
        box.appendChild(lab);
      });
      r.needs.forEach(function (n, k) {
        if (n.missing === undefined) return;
        var chip = mk('span', 'wf-need wf-missing', n.missing + ' (no block has this name) ');
        var x = btn('drop', 'data-wf-drop');
        x.setAttribute('data-drop', String(k));
        chip.appendChild(x);
        box.appendChild(chip);
      });
      if (!others && !r.needs.length) box.appendChild(mk('span', 'wf-need', 'nothing: it is the only block'));
      var input = li.querySelector('[data-field="name"]');
      var why = !NAME.test(r.name) ? 'letters, digits, _, . and -, starting and ending with a letter, digit or _' : count[r.name] > 1 ? 'two blocks have this name' : '';
      input.className = 'wf-in wf-name-in' + (why ? ' bad' : '');
      input.title = why;
    });
  };
  var draw = function (m) {
    var box = m.card.querySelector('.wf-editor');
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(mk('p', 'meta', 'Editing ' + m.doc + ': blocks run in the order of their needs. Save rewrites only the named blocks; the prose around them stays as it is, and the previous version is kept.'));
    var list = mk('ol', 'wf-rows');
    m.rows.forEach(function (r, i) {
      var li = mk('li', 'wf-row');
      li.setAttribute('data-row', String(r.id));
      var head = mk('div', 'wf-row-head');
      var name = mk('input', 'wf-in wf-name-in');
      name.type = 'text'; name.value = r.name; name.maxLength = 64; name.spellcheck = false;
      name.setAttribute('data-field', 'name'); name.setAttribute('aria-label', 'block name');
      var lang = mk('input', 'wf-in wf-lang-in');
      lang.type = 'text'; lang.value = r.lang; lang.maxLength = 32; lang.spellcheck = false;
      lang.setAttribute('data-field', 'lang'); lang.setAttribute('aria-label', 'language');
      head.appendChild(name);
      head.appendChild(lang);
      var up = btn('Up', 'data-wf-up'); up.disabled = i === 0;
      var down = btn('Down', 'data-wf-down'); down.disabled = i === m.rows.length - 1;
      head.appendChild(up);
      head.appendChild(down);
      head.appendChild(btn('Remove', 'data-wf-remove'));
      li.appendChild(head);
      var cmd = mk('textarea', 'wf-in wf-cmd');
      cmd.value = r.command; cmd.spellcheck = false;
      cmd.rows = Math.min(12, Math.max(2, r.command.split('\\n').length + 1));
      cmd.setAttribute('data-field', 'command'); cmd.setAttribute('aria-label', 'command of ' + r.name);
      li.appendChild(cmd);
      var needs = mk('div', 'wf-needs');
      needs.setAttribute('data-needs', '');
      li.appendChild(needs);
      list.appendChild(li);
    });
    box.appendChild(list);
    var bar = mk('div', 'wf-actions');
    bar.appendChild(btn('Add block', 'data-wf-add'));
    bar.appendChild(btn('Save', 'data-wf-save', 'act'));
    bar.appendChild(btn('Discard', 'data-wf-discard'));
    box.appendChild(bar);
    var msg = mk('p', 'wf-msg');
    msg.setAttribute('data-wf-msg', '');
    msg.setAttribute('role', 'status');
    box.appendChild(msg);
    if (m.msg) say(m, m.msg.t, m.msg.bad);
    drawNeeds(m);
  };
  var open = function (card) {
    if (card.timmyModel) return;
    var data;
    try { data = JSON.parse(card.getAttribute('data-wf') || '[]'); } catch (e) { return; }
    var m = { card: card, doc: card.getAttribute('data-wf-doc'), sha256: card.getAttribute('data-wf-sha'), rows: [], next: 1, msg: null };
    var first = Object.create(null);
    data.forEach(function (n) {
      var id = m.next++;
      m.rows.push({ id: id, from: n.index, name: n.name, lang: n.lang, command: n.code, needs: [] });
      if (first[n.name] === undefined) first[n.name] = id;
    });
    data.forEach(function (n, i) {
      n.deps.forEach(function (d) { m.rows[i].needs.push(first[d] !== undefined ? { id: first[d] } : { missing: d }); });
    });
    card.timmyModel = m;
    card.setAttribute('data-editing', '');
    var b = card.querySelector('[data-wf-edit]');
    if (b) b.hidden = true;
    card.querySelector('.wf-editor').hidden = false;
    draw(m);
    wfEditing(card, true);
  };
  var close = function (m) {
    var card = m.card;
    card.timmyModel = null;
    card.removeAttribute('data-editing');
    var box = card.querySelector('.wf-editor');
    while (box.firstChild) box.removeChild(box.firstChild);
    box.hidden = true;
    var b = card.querySelector('[data-wf-edit]');
    if (b) b.hidden = false;
    wfEditing(card, false);
  };
  var fresh = function (m) {
    var taken = Object.create(null);
    m.rows.forEach(function (r) { taken[r.name] = true; });
    for (var n = m.rows.length + 1; ; n++) if (!taken['step-' + n]) return 'step-' + n;
  };
  var save = function (m, b) {
    if (!api) return;
    var body = { action: 'save-workflow', doc: m.doc, sha256: m.sha256, blocks: m.rows.map(function (r) {
      var o = { name: r.name, lang: r.lang, needs: r.needs.map(function (n) { return n.id !== undefined ? nameOf(m, n.id) : n.missing; }), command: r.command };
      if (r.from !== undefined) o.from = r.from;
      return o;
    }) };
    b.disabled = true;
    say(m, 'Saving…', false);
    api.send(body).then(function (x) {
      b.disabled = false;
      if (x.ok) { close(m); out(x.t, false); api.refresh(); } else say(m, x.t, true);
    }, function () { b.disabled = false; say(m, unreachable, true); });
  };
  var workflowClick = function (m, t) {
    var b = t.closest('button');
    if (!b || b.disabled) return;
    var r = rowOf(m, b);
    if (b.hasAttribute('data-wf-add')) { m.rows.push({ id: m.next++, name: fresh(m), lang: 'bash', command: '', needs: [] }); draw(m); return; }
    if (b.hasAttribute('data-wf-save')) { save(m, b); return; }
    if (b.hasAttribute('data-wf-discard')) { close(m); if (api) api.refresh(); return; }
    if (!r) return;
    var i = m.rows.indexOf(r);
    if (b.hasAttribute('data-wf-up') && i > 0) { m.rows.splice(i, 1); m.rows.splice(i - 1, 0, r); draw(m); }
    else if (b.hasAttribute('data-wf-down') && i < m.rows.length - 1) { m.rows.splice(i, 1); m.rows.splice(i + 1, 0, r); draw(m); }
    else if (b.hasAttribute('data-wf-remove')) {
      m.rows.splice(i, 1);
      m.rows.forEach(function (o) { o.needs = o.needs.filter(function (n) { return n.id !== r.id; }); });
      draw(m);
    } else if (b.hasAttribute('data-wf-drop')) { r.needs.splice(Number(b.getAttribute('data-drop')), 1); drawNeeds(m); }
  };

  /* ── the parameter form ── */
  var paramsMsg = function (p, text, bad) {
    var e = p.querySelector('[data-params-msg]');
    if (!e) return;
    e.hidden = !text; e.textContent = text; e.className = 'params-msg' + (bad ? ' bad' : '');
  };
  var rebuildOf = function (p) { return p.querySelector('button[data-act="rebuild"]'); };
  /* R4 (H45): a field differs from the value it was drawn with (the saved file's, or the recipe's default): as numbers when both are. */
  var sameValue = function (a, b) {
    var x = String(a).trim(), y = String(b).trim();
    if (x !== '' && y !== '' && isFinite(Number(x)) && isFinite(Number(y))) return Number(x) === Number(y);
    return x === y;
  };
  /* Each edited field's before → after beside it; Save only while a value differs (or the file there is not usable). How many differ. */
  var markParams = function (p) {
    var fields = p.querySelectorAll('[data-param]');
    var changed = 0;
    for (var i = 0; i < fields.length; i++) {
      var differs = !sameValue(fields[i].value, fields[i].defaultValue);
      if (differs) changed++;
      var row = fields[i].closest('tr');
      if (!row) continue;
      if (differs) row.setAttribute('data-edited', ''); else row.removeAttribute('data-edited');
      var c = row.querySelector('[data-param-change]');
      if (c) c.textContent = differs ? ' → ' + (String(fields[i].value).trim() || '(empty)') : '';
    }
    var save = p.querySelector('[data-params-save]');
    if (save) save.disabled = !(changed || p.getAttribute('data-params-file') === 'unusable');
    return changed;
  };
  var dirtyParams = function (p) {
    if (p.hasAttribute('data-editing')) return;
    p.setAttribute('data-editing', '');
    var r = rebuildOf(p);
    if (r) { r.disabled = true; r.title = 'Save first: Rebuild uses the saved file'; }
    paramsMsg(p, 'Not saved yet: Save keeps these values; Rebuild uses the saved file.', false);
  };
  var cleanParams = function (p) {
    p.removeAttribute('data-editing');
    var r = rebuildOf(p);
    if (r) { r.disabled = false; r.title = ''; }
  };
  /* An input: the marks and Save follow it; back to the drawn values, the card is clean again. */
  var editParams = function (p) {
    if (markParams(p)) dirtyParams(p);
    else if (p.hasAttribute('data-editing')) { cleanParams(p); paramsMsg(p, '', false); }
  };
  var paramsClick = function (p, t) {
    var b = t.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-params-discard')) {
      var inputs = p.querySelectorAll('[data-param]');
      for (var i = 0; i < inputs.length; i++) inputs[i].value = inputs[i].defaultValue;
      markParams(p);
      cleanParams(p); paramsMsg(p, '', false);
      if (api) api.refresh();
      return;
    }
    if (!b.hasAttribute('data-params-save') || !api) return;
    var values = {};
    var fields = p.querySelectorAll('[data-param]');
    for (var k = 0; k < fields.length; k++) {
      var v = String(fields[k].value).trim();
      values[fields[k].getAttribute('data-param')] = v !== '' && isFinite(Number(v)) ? Number(v) : v;
    }
    var base = p.getAttribute('data-params-base');
    b.disabled = true;
    paramsMsg(p, 'Saving…', false);
    api.send({ action: 'set-params', recipe: p.getAttribute('data-params'), base: base === 'none' ? null : base, parameters: values }).then(function (x) {
      if (x.ok) {
        // Saved: these values are what the card stands for now, until the board draws it again from the file.
        for (var j = 0; j < fields.length; j++) fields[j].defaultValue = fields[j].value;
        markParams(p); cleanParams(p); paramsMsg(p, x.t, false); out(x.t, false); api.refresh();
      } else { markParams(p); paramsMsg(p, x.t, true); }
    }, function () { markParams(p); paramsMsg(p, unreachable, true); });
  };

${WORKFLOW_SCRIPT}
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    // R4 (H47): the connected card first (a node or a chip, the run bar, the inspector's command, OpenSCAD parameters)
    if (wfClick(t)) return;
    var edit = t.closest('[data-wf-edit]');
    if (edit) { var c = edit.closest('[data-wf-doc]'); if (c && !c.querySelector('[data-wf-cmd-dirty]')) open(c); return; }
    // R4 (H47): a parameter card inside a workflow card is its own form, also while the block editor is open
    var p = t.closest('[data-params]');
    if (p) { paramsClick(p, t); wfGuardOf(p); return; }
    var card = t.closest('[data-wf-doc]');
    if (card && card.timmyModel) { workflowClick(card.timmyModel, t); return; }
  });
  document.addEventListener('input', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (wfInput(t)) return;
    var card = t.closest('[data-wf-doc]');
    var m = card && card.timmyModel;
    if (m && t.hasAttribute('data-field')) {
      var r = rowOf(m, t);
      if (!r) return;
      var f = t.getAttribute('data-field');
      r[f] = t.value;
      if (f === 'name') drawNeeds(m);
      return;
    }
    var p = t.closest('[data-params]');
    if (p && t.hasAttribute('data-param')) { editParams(p); wfGuardOf(p); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t || !t.hasAttribute('data-need')) return;
    var card = t.closest('[data-wf-doc]');
    var m = card && card.timmyModel;
    var r = m && rowOf(m, t);
    if (!r) return;
    var id = Number(t.getAttribute('data-need'));
    r.needs = r.needs.filter(function (n) { return n.id !== id; });
    if (t.checked) r.needs.push({ id: id });
  });
  return { attach: function (o) { api = o; }, states: wfStates };
})();
`;

export const EDIT_CSS = `
.act.quiet { color: ${HOMEBREW.text}; background: ${HOMEBREW.raised}; border-color: ${HOMEBREW.lineStrong}; font-weight: ${TYPE.weight.body}; }
.act[hidden] { display: none; }
.wf-editor { border-top: 1px solid ${HOMEBREW.line}; padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.wf-editor[hidden] { display: none; }
.wf-rows { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 10px; }
.wf-row { display: flex; flex-direction: column; gap: 6px; }
.wf-row-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wf-in { font: inherit; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.text}; background: ${HOMEBREW.ground}; border: 1px solid ${HOMEBREW.lineStrong}; border-radius: 4px; padding: 3px 6px; }
.wf-in:focus-visible { outline: 2px solid ${HOMEBREW.accent}; outline-offset: 1px; }
.wf-in.bad { border-color: ${HOMEBREW.failure}; }
.wf-name-in { width: 14em; font-weight: ${TYPE.weight.strong}; }
.wf-lang-in { width: 7em; }
.wf-cmd { width: 100%; resize: vertical; white-space: pre; overflow-wrap: normal; overflow-x: auto; }
.wf-needs { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: ${TYPE.size.small}px; color: ${HOMEBREW.textSecondary}; align-items: center; }
.wf-needs-label { text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
.wf-need { display: inline-flex; align-items: center; gap: 4px; color: ${HOMEBREW.text}; }
.wf-missing { color: ${HOMEBREW.attention}; }
`;
