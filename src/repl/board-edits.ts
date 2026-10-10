/**
 * Round R4 (H22): the live board's edits. `/board live` (src/repl/board-live.ts) takes them at POST /edit, with
 * the same protections as its actions (127.0.0.1 only, its own Host and Origin, the bearer token, JSON only,
 * a size limit, one at a time in the actions' queue), and hands each to `applyBoardEdit`. There are two, each
 * an exact shape checked on the server; neither runs a command:
 * - `set-params`: the tray recipe's parameter file, checked by the recipe's own rules (src/repl/board-cards.ts);
 * - `save-workflow`: a workflow document's named blocks, rewritten in place (src/repl/board-nodes.ts).
 *
 * EDIT_SCRIPT is the page's side: the node editor and the parameter form. It never sees the token: the live
 * board's own script hands it a `send` function (TimmyBoardEdit.attach). It builds every element with
 * createElement and textContent, and marks a card it is editing with data-editing, so the live page does not
 * redraw the board over unsaved work (jobs still update in place).
 */
import { saveParams } from './board-cards.js';
import { saveWorkflow, type EditAnswer, type EditContext } from './board-nodes.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

/** The largest edit body read; a larger one is refused before it is parsed. */
export const EDIT_LIMIT = 256 * 1024;

/** An edit body, checked and applied: the answer for the page and one line for the transcript. */
export function applyBoardEdit(body: unknown, ctx: EditContext): EditAnswer {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, text: 'An edit is a JSON object.', line: 'refused an edit: not a JSON object' };
  const o = body as Record<string, unknown>;
  if (o.action === 'set-params') return saveParams(o, ctx);
  if (o.action === 'save-workflow') return saveWorkflow(o, ctx);
  return { status: 400, text: 'Unknown edit: set-params and save-workflow are the edits.', line: 'refused an unknown edit' };
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
  var paramsClick = function (p, t) {
    var b = t.closest('button');
    if (!b || b.disabled) return;
    if (b.hasAttribute('data-params-discard')) {
      var inputs = p.querySelectorAll('[data-param]');
      for (var i = 0; i < inputs.length; i++) inputs[i].value = inputs[i].defaultValue;
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
      b.disabled = false;
      if (x.ok) { cleanParams(p); paramsMsg(p, x.t, false); out(x.t, false); api.refresh(); } else paramsMsg(p, x.t, true);
    }, function () { b.disabled = false; paramsMsg(p, unreachable, true); });
  };

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var edit = t.closest('[data-wf-edit]');
    if (edit) { var c = edit.closest('[data-wf-doc]'); if (c) open(c); return; }
    var card = t.closest('[data-wf-doc]');
    if (card && card.timmyModel) { workflowClick(card.timmyModel, t); return; }
    var p = t.closest('[data-params]');
    if (p) paramsClick(p, t);
  });
  document.addEventListener('input', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
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
    if (p && t.hasAttribute('data-param')) dirtyParams(p);
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
  return { attach: function (o) { api = o; } };
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
