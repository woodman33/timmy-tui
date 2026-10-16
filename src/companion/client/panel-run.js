// R6 (H144): the Workflows tab's run detail, page side (loaded before companion.js; the server side is
// src/companion/run-detail.ts, the producer src/ops/run-detail.ts).
//
// One operation's run, as GET /api/run/<operation id> answers it: its run detail (src/contracts/run-detail.ts) and the run
// INSPECTED (src/ops/run-detail.ts RunInspection), both made from Timmy's records on the companion's server:
//   .intent · .predict   the request; the workflow document and its blocks as upmd ran them (the copy /run kept, its
//                        sha256 the one the prediction sealed), the document now beside it (both hashes, and a diff, when
//                        it changed since); the prediction, frozen before the run
//   the run              a viewer for the file chosen (its diff against the version Timmy kept, an image drawn, a text or
//                        JSON shown, a binary's size and sha256), the files the run changed and its log and outputs, and
//                        the run detail's own facts
//   .receipt             the run's receipt and the chain intent → predict → run → receipt, each receipt marked verified
//                        only where the server's answer says Timmy's verifier (verifyReceiptIn) verified it when the answer
//                        was made, with what it checked; this page verifies nothing and assumes no mark
// and the run's actions: Open shows a file in the viewer (the preview is the server's reading of the file); Review, Restore
// and Run again are commands for Timmy's REPL, copied, each with what it does (reads, write, runs): the companion has no
// path of its own that writes or runs with a person's approval. One of them is the primary, marked by a brighter neutral
// border only: the strip's primary is the page's one amber next step (B10), so these take amber only with focus.
//
// Every box that scrolls says "more below ↓" on its lower edge while there is more below. Content keeps its own colors (an
// image is drawn as it is); diff markers keep + green and − red (DESIGN.md §10 B5). Nothing here is written with
// innerHTML: every element is made, its words set as text.

/** The newest ask (an answer to an older one is not drawn over it), the run drawn now, and the re-read of a running one. */
let rvAsked = 0;
let rvShown = null;
let rvTimer = null;
/** A running run is read again this often while its detail is on screen. */
const RV_RUNNING_MS = 3000;

/** Elements whose children are blocks, rows or cells (each laid out as a block, a grid or a flex box): a line break
 *  between two of their children draws nothing and keeps the page's text worded apart, as its markup was before. */
const RV_BLOCKS = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'DIV']);

/** An element: its attributes (null, undefined and false left out) and its children (text as text). */
function rvEl(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const blocks = RV_BLOCKS.has(el.tagName);
  let after = false;
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    const node = kid instanceof Node ? kid : document.createTextNode(String(kid));
    if (blocks && after && node.nodeType === Node.ELEMENT_NODE) el.append('\n');
    el.append(node);
    after = node.nodeType === Node.ELEMENT_NODE;
  }
  return el;
}
const rvShort = (sha) => (sha ? `${String(sha).slice(0, 12)}` : 'none');
const rvFrom = (f) => (f ? rvEl('span', { class: 'run-from' }, ` from ${f}`) : null);
const rvNone = (words) => rvEl('span', { class: 'run-none' }, words);
const rvBytes = (n) => (typeof n !== 'number' ? 'size not recorded' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
function rvWhen(t) {
  if (!t) return 'not recorded';
  const x = new Date(t);
  if (Number.isNaN(x.getTime())) return String(t);
  return typeof dateTimeOf === 'function' ? dateTimeOf(x) : x.toISOString();
}
function rvClock(t) {
  const x = new Date(t);
  if (Number.isNaN(x.getTime())) return String(t || 'not recorded');
  return typeof clockOf === 'function' ? clockOf(t) : x.toISOString().slice(11, 19);
}

/** A box whose body scrolls, with its "more below ↓" cue on its lower edge (rvMark sets it). */
function rvScrollBox(cls, label, ...kids) {
  return rvEl('div', { class: `rv-hold ${cls}` }, rvEl('div', { class: 'rv-scroll', 'data-rv-scroll': '', tabindex: '0', 'aria-label': label }, ...kids));
}

/** Each scrolling box in `scope` marked while its content goes on below its edge. */
function rvMark(scope) {
  for (const el of (scope || document).querySelectorAll('[data-rv-scroll]')) {
    const holder = el.parentElement;
    if (!holder) continue;
    const more = el.clientHeight > 0 && el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    if (more && holder.dataset.more !== '1') holder.dataset.more = '1';
    else if (!more && holder.dataset.more !== undefined) delete holder.dataset.more;
  }
}
document.addEventListener('scroll', (e) => { if (e.target instanceof Element && e.target.hasAttribute('data-rv-scroll')) rvMark(e.target.parentElement); }, true);
window.addEventListener('resize', () => rvMark());

// ── the parts ─────────────────────────────────────────────────────────────────

/** The run detail's own facts, as rows (each data-field, as before), split by the column they belong to. */
function rvFacts(d) {
  const sourced = (s) => (s && typeof s === 'object' ? [String(s.value), rvFrom(s.from)] : [rvNone('not recorded')]);
  const elapsed = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'not recorded';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const opLink = (id) => rvEl('button', { type: 'button', class: 'run-link', 'data-action': 'open-run', 'data-op': id }, id);
  const COL = { objective: 'before', verdict: 'after', acceptance: 'after', related: 'after', next: 'after', summary: 'after' };
  const rows = { before: [], run: [], after: [] };
  const row = (key, label, ...value) => rows[COL[key] || 'run'].push(rvEl('div', { class: 'run-row', 'data-field': key }, rvEl('dt', null, label), rvEl('dd', null, ...value)));
  row('verdict', 'Timmy’s verdict', rvEl('strong', { class: 'run-verdict', 'data-state': d.verdict.state }, d.verdict.state), ` · ${d.verdict.words}`, rvFrom(d.verdict.from));
  row('stage', 'Workflow stage', `${d.stage.current ? `${d.stage.current} · ` : ''}${d.stage.done} of ${d.stage.total === null || d.stage.total === undefined ? 'an unrecorded number of' : d.stage.total} steps done`, rvFrom(d.stage.from));
  row('exits', 'Process exits', d.exits.length ? rvEl('ul', { class: 'run-list' }, d.exits.map((x) => rvEl('li', null, `${x.who}: ${x.code === null || x.code === undefined ? 'its exit is not known' : `exit ${x.code}`}${x.state ? ` (${x.state})` : ''}`, rvFrom(x.from)))) : rvNone('none recorded'));
  row('freshness', 'Artifact freshness', `${d.freshness.state} · ${d.freshness.why}`, rvFrom(d.freshness.from));
  row('acceptance', 'A person’s acceptance', `${d.acceptance.state}${d.acceptance.by ? ` by ${d.acceptance.by}` : ''}${d.acceptance.at ? `, ${rvWhen(d.acceptance.at)}` : ''}`, rvFrom(d.acceptance.from));
  row('objective', 'Objective', ...sourced(d.objective));
  row('project', 'Project', d.project.name, rvEl('span', { class: 'run-from' }, ` ${d.project.root} · id ${d.project.id}`));
  row('source', 'Source revision', ...sourced(d.sourceRevision));
  const w = d.worker || {};
  const workers = [['model', w.model], ['harness', w.harness], ['environment', w.environment]].filter(([, v]) => v);
  row('worker', 'Worker', ...(workers.length ? workers.flatMap(([k, v], i) => [i ? '; ' : '', `${k} `, ...sourced(v)]) : [rvNone('not recorded')]));
  row('time', 'Time', `started ${rvWhen(d.time.startedAt)} · ended ${rvWhen(d.time.endedAt)} · elapsed ${elapsed(d.time.elapsedMs)}`);
  row('related', 'Parent · children', d.parent ? opLink(d.parent) : rvNone('no parent'), ' · ', ...(d.children.length ? d.children.flatMap((c, i) => [i ? ' ' : '', opLink(c)]) : [rvNone('no children')]));
  row('cost', 'Cost', ...(d.cost.measured ? [`$${Number(d.cost.usd).toFixed(4)} (reported)`, rvFrom(d.cost.from)] : [`unknown: ${d.cost.why}`]));
  row('next', 'Next', d.next ? d.next.words : rvNone('nothing recorded'), d.next && d.next.command ? [' ', rvEl('code', null, d.next.command)] : null);
  row('summary', 'Summary', d.summary && d.summary.path ? rvEl('code', null, d.summary.path) : rvNone('none saved'));
  const dl = (k) => rvEl('dl', { class: 'run-facts' }, rows[k]);
  return { before: dl('before'), run: dl('run'), after: dl('after') };
}

/** The checks, predicted beside actual (as before). */
function rvChecks(d) {
  if (!d.checks.length) return rvEl('p', null, rvNone('No checks recorded.'));
  const word = (v) => (v === true ? 'differs' : v === false ? 'as predicted' : 'not compared');
  return rvEl('table', { class: 'run-table' },
    rvEl('thead', null, rvEl('tr', null, rvEl('th', null, 'Check'), rvEl('th', null, 'Predicted'), rvEl('th', null, 'Actual'), rvEl('th', null, 'Compared'))),
    rvEl('tbody', null, d.checks.map((c) => rvEl('tr', { 'data-differs': String(c.differs) },
      rvEl('td', null, c.name), rvEl('td', null, c.predicted === null ? rvNone('none') : c.predicted), rvEl('td', null, c.actual, rvFrom(c.from)),
      rvEl('td', { class: c.differs === false ? 'is-verified' : c.differs === true ? 'is-failed' : '' }, word(c.differs))))));
}

/** The files the run detail names (as before). */
function rvFilesTable(d) {
  if (!d.files.length) return rvEl('p', null, rvNone('No files recorded.'));
  return rvEl('table', { class: 'run-table' },
    rvEl('thead', null, rvEl('tr', null, rvEl('th', null, 'File'), rvEl('th', null, 'Role'), rvEl('th', null, 'sha256'))),
    rvEl('tbody', null, d.files.map((f) => rvEl('tr', null, rvEl('td', null, rvEl('code', null, f.path), rvFrom(f.from)), rvEl('td', null, f.role), rvEl('td', null, f.sha256 ? rvEl('code', null, String(f.sha256).slice(0, 12)) : rvNone('none'))))));
}

/** A diff: its counts and what it is against, then its hunks, each line with its marker (B5: + green, − red). */
function rvDiff(diff) {
  if (!diff || !diff.shown) return rvEl('p', { class: 'rv-why', 'data-rv-diff': 'none' }, diff ? diff.why : 'no diff');
  const against = diff.against === 'kept' ? `against the version Timmy kept (${diff.from})` : diff.against === 'nothing' ? 'against nothing: the run added it' : `${diff.from} → ${diff.to}`;
  const more = diff.more ? ` · ${diff.more} changed lines not drawn here` : '';
  return rvEl('div', { class: 'rv-diff-wrap' },
    rvEl('p', { class: 'rv-diff-head', title: `+${diff.added} −${diff.removed} · ${against}${more}` }, rvEl('span', { class: 'rv-add-n' }, `+${diff.added}`), ' ', rvEl('span', { class: 'rv-del-n' }, `−${diff.removed}`), ` · ${against}`, more),
    rvEl('pre', { class: 'rv-diff', 'data-rv-diff': 'shown' }, diff.hunks.map((h) => [
      rvEl('span', { class: 'rv-hunk' }, h.header),
      h.lines.map((l) => rvEl('span', { class: 'rv-dl', 'data-op': l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same' }, rvEl('span', { class: 'rv-mark', 'aria-hidden': 'true' }, l.op === '+' ? '+' : l.op === '-' ? '−' : ' '), l.text || ' ')),
    ])));
}

/** A preview: text (JSON laid out) with line numbers, an image drawn, a binary's size and sha256, or why none. */
function rvPreview(p, o = {}) {
  if (!p) return rvEl('p', { class: 'rv-why' }, 'no preview');
  if (p.kind === 'none') return rvEl('p', { class: 'rv-why' }, p.why);
  if (p.kind === 'image') {
    const facts = `${p.mime}${p.width && p.height ? ` · ${p.width} × ${p.height}` : ''} · ${rvBytes(p.bytes)}${p.sha256 ? ` · sha256 ${rvShort(p.sha256)}` : ''}`;
    if (!p.data) return rvEl('div', { class: 'rv-image is-absent' }, rvEl('p', null, facts), rvEl('p', { class: 'rv-why' }, p.why || 'not drawn here'));
    // a small image is drawn larger, its pixels kept square (its colors as they are)
    return rvEl('figure', { class: `rv-image${p.width && p.width < 96 && p.height && p.height < 96 ? ' is-small' : ''}` }, rvEl('img', { src: p.data, alt: o.alt || 'the image as the server read it', 'data-rv-image': '' }), rvEl('figcaption', null, o.caption ? `${o.caption} · ` : '', facts));
  }
  if (p.kind === 'binary') return rvEl('p', { class: 'rv-binary', 'data-rv-binary': '' }, `${p.what} · ${rvBytes(p.bytes)}${p.sha256 ? ` · sha256 ${p.sha256}` : ' · not hashed here'}`);
  const first = o.firstLine || 1;
  return rvEl('div', { class: 'rv-text-wrap' },
    p.json || p.jsonWhy || p.cut || o.more ? rvEl('p', { class: 'rv-text-head' }, p.json ? 'JSON, laid out' : '', p.jsonWhy || '', p.cut ? `${p.json || p.jsonWhy ? ' · ' : ''}${p.cut}` : '', o.more || '') : null,
    o.earlier ? rvEl('p', { class: 'rv-why' }, o.earlier) : null,
    rvEl('pre', { class: `rv-text${p.json ? ' is-json' : ''}`, 'data-rv-text': '' }, p.lines.map((l, i) => rvEl('span', { class: 'rv-tl' }, rvEl('span', { class: 'rv-ln', 'aria-hidden': 'true' }, String(first + i)), l || ' '))),
    p.more ? rvEl('p', { class: 'rv-why' }, `and ${p.more} more line${p.more === 1 ? '' : 's'} (not sent to this page)`) : null);
}

/** A file now against its record: its words, and ✓ (green) only where the server found the bytes recorded. */
const rvNow = (now) => rvEl('p', { class: `rv-now${now.state === 'as recorded' ? ' is-verified' : now.state === 'changed since' || now.state === 'gone' ? ' is-failed' : ''}`, 'data-now': now.state },
  now.state === 'as recorded' ? '✓ ' : now.state === 'changed since' || now.state === 'gone' ? '✕ ' : '', now.words);

/** The selected item of the viewer: a change (c:<i>), an output (o:<i>), or the document as it ran (s). */
function rvSelected(ins) {
  const sel = rvShown && rvShown.sel;
  const ok = (s) => (s === 's' && 'doc' in ins.source) || (/^c:\d+$/.test(s || '') && ins.changes.list[Number(s.slice(2))]) || (/^o:\d+$/.test(s || '') && ins.outputs[Number(s.slice(2))]);
  if (sel && ok(sel)) return sel;
  const withDiff = ins.changes.list.findIndex((c) => c.diff && c.diff.shown);
  if (withDiff >= 0) return `c:${withDiff}`;
  if (ins.changes.list.length) return 'c:0';
  const file = ins.outputs.findIndex((o) => o.kind === 'file');
  if (file >= 0) return `o:${file}`;
  if (ins.outputs.length) return 'o:0';
  return 'doc' in ins.source ? 's' : null;
}

/** The viewer: the chosen file's diff or preview first, then its facts, and what can be done with it. */
function rvViewer(ins, sel) {
  const head = [];
  const show = [];
  const facts = [];
  const acts = [];
  if (!sel) {
    show.push(rvEl('p', { class: 'rv-why' }, 'This run changed no file Timmy records, and made no output to show.'));
  } else if (sel === 's') {
    const s = ins.source;
    head.push(rvEl('span', { class: 'rv-v-path' }, s.doc), rvEl('span', { class: 'rv-v-tag' }, s.now.state === 'changed' ? 'the document as it ran → now' : 'the document as it ran'));
    show.push(s.diff ? rvDiff(s.diff) : rvEl('p', { class: 'rv-why' }, s.now.state === 'same' ? 'unchanged since the run: its blocks as they ran are in .intent' : s.blocksWhy || 'no diff'));
    facts.push(rvEl('p', { class: `rv-now${s.now.state === 'same' ? ' is-verified' : s.now.state === 'changed' ? ' is-failed' : ''}` }, s.now.state === 'same' ? '✓ ' : s.now.state === 'changed' ? '✕ ' : '', s.now.words));
    acts.push(rvCopyButton(`/open ${s.doc}`, '/open', 'reads'));
  } else if (sel.startsWith('c:')) {
    const c = ins.changes.list[Number(sel.slice(2))];
    head.push(rvEl('span', { class: 'rv-v-path' }, c.path), rvEl('span', { class: 'rv-v-tag', 'data-how': c.how }, c.how));
    const image = c.preview && c.preview.kind === 'image';
    if (c.diff && c.diff.shown && !image) show.push(rvDiff(c.diff));
    if (image && c.keptPreview && c.keptPreview.kind === 'image') show.push(rvEl('div', { class: 'rv-pair' }, rvPreview(c.keptPreview, { caption: 'before: the version Timmy kept', alt: 'the version kept before the run' }), rvPreview(c.preview, { caption: c.preview.of, alt: c.preview.of })));
    else if (c.preview && !(c.diff && c.diff.shown && !image)) show.push(rvEl('p', { class: 'rv-of' }, c.preview.of), rvPreview(c.preview, { alt: c.preview.of }));
    if (c.diff && !c.diff.shown) facts.push(rvDiff(c.diff));
    facts.push(rvEl('p', { class: 'rv-by' }, `${c.how} by ${c.by}`), rvNow(c.now), rvEl('p', { class: 'rv-kept' }, c.kept.words));
    if (c.note) facts.push(rvEl('p', { class: 'rv-why' }, c.note));
    facts.push(rvEl('p', { class: `rv-check${c.check.status === 'verified' ? ' is-verified' : ' is-failed'}` }, c.check.status === 'verified' ? '✓ ' : '✕ ', c.check.words, c.record ? rvFrom(c.record) : null));
    acts.push(rvCopyButton(c.open, '/open', 'reads'));
    if (c.restore.offered) acts.push(rvCopyButton(c.restore.command, 'Restore', 'write', `${c.restore.command}: writes the kept previous version (${c.restore.from}) back over ${c.path}, only while it is exactly what the run left; its current version is kept first, and an edit receipt is sealed`));
    else facts.push(rvEl('p', { class: 'rv-not-now', 'data-rv-restore': 'not offered' }, `Restore: not now: ${c.restore.why}`));
  } else {
    const o = ins.outputs[Number(sel.slice(2))];
    head.push(rvEl('span', { class: 'rv-v-path' }, o.path), rvEl('span', { class: 'rv-v-tag' }, o.kind === 'log' ? 'its log' : 'an output'));
    const earlier = o.kind === 'log' && o.preview.kind === 'text' && o.preview.more ? `${o.preview.more} earlier line${o.preview.more === 1 ? '' : 's'} not shown here (${o.open} shows its whole log in the REPL)` : null;
    // a log's last lines, numbered from the first of them shown
    show.push(rvPreview(o.kind === 'log' && o.preview.kind === 'text' ? { ...o.preview, more: 0 } : o.preview, { earlier, alt: `${o.path}, as the server read it`, firstLine: o.kind === 'log' && o.preview.kind === 'text' ? (o.preview.more || 0) + 1 : 1 }));
    facts.push(rvEl('p', { class: 'rv-by' }, o.what), o.recorded ? rvEl('p', { class: 'rv-kept' }, `recorded: ${o.recorded.sha256 ? `sha256 ${rvShort(o.recorded.sha256)}` : 'no sha256'}${typeof o.recorded.bytes === 'number' ? `, ${rvBytes(o.recorded.bytes)}` : ''}, by ${o.recorded.from}`) : null, rvNow(o.now));
    if (o.open) acts.push(rvCopyButton(o.open, o.open.split(' ')[0], 'reads'));
  }
  return rvEl('section', { class: 'rv-viewer', 'aria-label': 'The file chosen', 'data-rv-viewer': sel || 'none' },
    rvEl('div', { class: 'rv-v-head' }, ...head, rvEl('span', { class: 'rv-v-acts' }, ...acts)),
    rvScrollBox('rv-v-body', 'Its content', ...show, facts.length ? rvEl('div', { class: 'rv-v-facts' }, facts) : null));
}

/** A button that copies a command for Timmy's REPL: its label and what it does; the command in its title and, copied, in the note. */
function rvCopyButton(command, label, effect, words) {
  return rvEl('button', { type: 'button', class: 'rv-copy', 'data-rv-copy': command, 'data-rv-effect': effect, title: words || `${command}: copied for Timmy's REPL` },
    rvEl('span', null, label), ' ', rvEl('span', { class: `rv-effect is-${effect === 'write' ? 'writes' : effect}` }, effect));
}

/** The files the run changed, then its log and outputs: each a row that opens it in the viewer. */
function rvFileList(ins, sel) {
  const pick = (key, ...kids) => rvEl('li', null, rvEl('button', { type: 'button', class: 'rv-pick', 'data-rv-sel': key, 'aria-current': sel === key ? 'true' : 'false' }, ...kids));
  const changes = ins.changes.list.map((c, i) => pick(`c:${i}`,
    rvEl('span', { class: 'rv-pick-how', 'data-how': c.how }, c.how), ' ', rvEl('span', { class: 'rv-pick-path' }, c.path), ' ',
    rvEl('span', { class: 'rv-pick-what' }, c.diff && c.diff.shown ? `+${c.diff.added} −${c.diff.removed}` : c.preview && c.preview.kind === 'image' ? 'image' : c.preview && c.preview.kind === 'binary' ? `binary · ${rvBytes(c.preview.bytes)}` : c.preview && c.preview.kind === 'text' ? (c.preview.json ? 'JSON' : 'text') : ''),
    c.restore.offered ? rvEl('span', { class: 'rv-pick-what' }, ' · restore offered') : null));
  const outs = ins.outputs.map((o, i) => pick(`o:${i}`,
    rvEl('span', { class: 'rv-pick-how' }, o.kind === 'log' ? 'log' : 'output'), ' ', rvEl('span', { class: 'rv-pick-path' }, o.path), ' ',
    rvEl('span', { class: 'rv-pick-what' }, o.preview.kind === 'image' ? 'image' : o.preview.kind === 'binary' ? `binary · ${rvBytes(o.preview.bytes)}` : o.preview.kind === 'text' ? `${o.preview.json ? 'JSON' : 'text'} · ${o.preview.lines.length + (o.preview.more || 0)} lines` : o.preview.why)));
  return rvEl('div', { class: 'rv-files' },
    rvEl('h5', null, `Changed by the run · ${ins.changes.list.length}${ins.changes.more ? ` (and ${ins.changes.more} more)` : ''}`),
    changes.length ? rvEl('ul', { class: 'rv-picks', 'data-rv-list': 'changes' }, changes) : rvEl('p', { class: 'rv-why' }, 'none that Timmy records'),
    ins.changes.notes.length ? rvEl('ul', { class: 'rv-notes' }, ins.changes.notes.map((n) => rvEl('li', null, n))) : null,
    rvEl('h5', null, `Its log and outputs · ${ins.outputs.length}`),
    outs.length ? rvEl('ul', { class: 'rv-picks', 'data-rv-list': 'outputs' }, outs) : rvEl('p', { class: 'rv-why' }, 'none recorded'),
    'doc' in ins.source ? rvEl('ul', { class: 'rv-picks', 'data-rv-list': 'source' }, pick('s', rvEl('span', { class: 'rv-pick-how' }, 'source'), ' ', rvEl('span', { class: 'rv-pick-path' }, ins.source.doc), ' ', rvEl('span', { class: 'rv-pick-what' }, ins.source.now.state === 'changed' ? 'changed since the run' : 'as it ran'))) : null);
}

/** The intent and the source: the request, the document and its blocks as they ran, the document now. */
function rvIntent(d, ins) {
  const parts = [rvEl('div', { class: 'rv-card is-intent', 'data-rv-card': 'intent' },
    rvEl('h6', null, '.intent · ', rvEl('code', null, ins.intent.request || 'not recorded')),
    rvEl('p', { class: 'run-from' }, [ins.intent.via ? `via ${ins.intent.via}` : '', ins.intent.started ? `started ${rvWhen(ins.intent.started)}` : '', ins.intent.from].filter(Boolean).join(' · ')),
    rvEl('p', { class: 'rv-why', 'data-rv-sealed': '' }, ins.intent.sealed))];
  const s = ins.source;
  if (!('doc' in s)) { parts.push(rvEl('p', { class: 'rv-why', 'data-rv-source': 'none' }, `Source: ${s.none}`)); return parts; }
  const src = [
    rvEl('h6', null, `source · ${s.doc} › ${s.block}`),
    rvEl('p', null, `as it ran: sha256 ${rvShort(s.asRan.sha256)}`, rvFrom(s.asRan.from)),
    rvEl('p', { class: 'rv-why' }, s.copy.words),
    rvEl('p', { class: `rv-now${s.now.state === 'same' ? ' is-verified' : s.now.state === 'changed' ? ' is-failed' : ''}`, 'data-rv-doc-now': s.now.state }, s.now.state === 'same' ? '✓ ' : s.now.state === 'changed' ? '✕ ' : '', s.now.words),
  ];
  if (s.now.state === 'changed') src.push(rvEl('button', { type: 'button', class: 'rv-copy', 'data-rv-sel': 's' }, 'Show its diff, as it ran → now'));
  for (const b of s.blocks) {
    const sealed = b.sealed ? (b.sealed.matches === true ? rvEl('span', { class: 'is-verified' }, `✓ its code's sha256 is the one block receipt ${b.sealed.receipt} sealed`) : b.sealed.matches === false ? rvEl('span', { class: 'is-failed' }, `✕ its code's sha256 is not the one block receipt ${b.sealed.receipt} sealed`) : rvNone(`block receipt ${b.sealed.receipt} names no sha256 of its code`)) : rvNone('no block receipt of this run names it');
    src.push(rvEl('div', { class: `rv-block${b.target ? ' is-target' : ''}`, 'data-rv-block': b.name },
      rvEl('p', { class: 'rv-block-head' }, rvEl('strong', null, b.name), ` · ${b.lang}${b.deps.length ? ` · needs ${b.deps.join(', ')}` : ''}${b.target ? ' · the block asked for' : ''}`),
      rvEl('pre', { class: 'rv-code' }, b.code.map((l, i) => rvEl('span', { class: 'rv-tl' }, rvEl('span', { class: 'rv-ln', 'aria-hidden': 'true' }, String(b.firstLine + i)), l || ' '))),
      rvEl('p', { class: 'rv-sealed' }, sealed)));
  }
  if (!s.blocks.length && s.blocksWhy) src.push(rvEl('p', { class: 'rv-why' }, s.blocksWhy));
  parts.push(rvEl('div', { class: 'rv-card is-source', 'data-rv-card': 'source' }, src));
  return parts;
}

/** A receipt's mark: ✓ verified now (green), with what Timmy's verifier checked; ✕ not verified (amber), with why. */
function rvReceiptMark(r) {
  return r.verified.ok
    ? rvEl('p', { class: 'rv-verified is-verified', 'data-verified': 'true' }, '✓ sealed and verified now', rvEl('span', { class: 'rv-checked-words' }, `: ${r.verified.checked}`))
    : rvEl('p', { class: 'rv-verified is-failed', 'data-verified': 'false' }, `✕ not verified: ${r.verified.why}`);
}

/** The receipts: the run's own (its outcome) as a card, then the chain intent → predict → run → receipt, each verified now. */
function rvReceipts(ins) {
  const list = ins.receipts.list;
  const outcome = [...list].reverse().find((r) => r.stage === 'receipt');
  const card = outcome
    ? rvEl('div', { class: `rv-card is-receipt${outcome.verified.ok ? ' is-verified' : ' is-failed'}`, 'data-rv-card': 'receipt' },
      rvEl('h6', null, `.receipt · ${outcome.id}`),
      rvEl('p', null, `${outcome.kind}${outcome.subject ? ` · ${outcome.subject}` : ''}`),
      rvEl('p', { class: 'run-from' }, `sealed ${rvWhen(outcome.ts)} · epoch ${outcome.epoch}, receipt ${outcome.position} · ${outcome.signed ? 'signed' : 'not signed'}`),
      rvReceiptMark(outcome))
    : rvEl('div', { class: 'rv-card is-receipt', 'data-rv-card': 'receipt' }, rvEl('h6', null, '.receipt'), rvEl('p', { class: 'rv-why' }, list.length ? 'not sealed yet: the run\'s own receipt is sealed as it ends' : 'no receipt names this operation on the chain read'));
  const stageWord = { predict: '.predict', run: 'run', receipt: '.receipt' };
  const chain = rvEl('ol', { class: 'rv-chain', 'data-rv-chain': '' },
    rvEl('li', { 'data-stage': 'intent' }, rvEl('span', { class: 'rv-stage' }, '.intent'), ' the request · ', rvNone('not a receipt')),
    list.map((r) => rvEl('li', { 'data-stage': r.stage, 'data-receipt': r.id, 'data-verified': String(r.verified.ok) },
      rvEl('span', { class: 'rv-stage' }, stageWord[r.stage] || r.stage), ' ', rvEl('code', null, r.id), ` · ${r.kind}${r.subject ? ` · ${r.subject}` : ''}`,
      rvEl('span', { class: 'run-from' }, ` · ${rvClock(r.ts)} · links to ${r.prev === 'genesis' ? `the start of epoch ${r.epoch}` : r.prev}`),
      rvReceiptMark(r))));
  return [card, rvEl('h5', null, 'Receipts · intent → predict → run → receipt'), chain,
    rvEl('p', { class: `rv-chain-words${ins.receipts.chain.ok === true ? ' is-verified' : ins.receipts.chain.ok === false ? ' is-failed' : ''}`, 'data-rv-chain-ok': String(ins.receipts.chain.ok) }, ins.receipts.chain.ok === true ? '✓ ' : ins.receipts.chain.ok === false ? '✕ ' : '', ins.receipts.chain.words)];
}

/** The pipeline row: intent → predict → run → receipt, each stage's receipts as the server verified them. */
function rvPipe(ins) {
  const of = (stage) => ins.receipts.list.filter((r) => r.stage === stage);
  const step = (stage, label) => {
    const rs = of(stage);
    const ok = rs.length && rs.every((r) => r.verified.ok);
    const bad = rs.filter((r) => !r.verified.ok).length;
    const words = !rs.length ? (stage === 'receipt' ? 'not sealed yet' : 'none') : ok ? `✓ ${rs.length === 1 ? rs[0].id : `${rs.length} receipts`} · verified now` : `✕ ${bad} of ${rs.length} not verified`;
    return rvEl('li', { class: `rv-pipe-step${ok ? ' is-verified' : bad ? ' is-failed' : ''}`, 'data-stage': stage }, rvEl('span', { class: 'rv-stage' }, label), ' ', words);
  };
  return rvEl('ol', { class: 'rv-pipe', 'aria-label': 'intent → predict → run → receipt' },
    rvEl('li', { class: 'rv-pipe-step is-intent', 'data-stage': 'intent' }, rvEl('span', { class: 'rv-stage' }, '.intent'), ' the request · not a receipt'),
    step('predict', '.predict'), step('run', 'run'), step('receipt', '.receipt'));
}

/** The run's actions: Open (here), Review, Restore and Run again (commands, copied), each with its effect; one primary. The
 *  line under them says the command of the one pointed at or focused (the primary's until then) and what it does. */
function rvActions(ins) {
  const effect = (a) => (a.effect === 'writes' ? 'write' : a.effect === 'runs' ? 'runs' : 'reads');
  const primary = ins.actions.find((a) => a.primary) || ins.actions[0];
  const says = (a) => (a ? [rvEl('code', { class: 'rv-cmd-now' }, a.command), ` · ${effect(a)}: ${a.available ? a.words : a.why}`] : []);
  return rvEl('div', { class: 'rv-acts-row' },
    rvEl('ol', { class: 'rv-acts', 'aria-label': 'This run\'s actions', title: 'Open shows a file here; the others are commands for Timmy\'s REPL: a click copies one, and nothing runs from this page' }, ins.actions.map((a, i) => rvEl('li', null,
      rvEl('button', {
        type: 'button', class: `rv-act${a.primary ? ' is-primary' : ''}`, 'data-rv-act': a.id, 'data-rv-command': a.command, 'data-rv-path': a.path || null,
        'data-rv-says': `${a.command} · ${effect(a)}: ${a.available ? a.words : a.why}`, 'aria-disabled': a.available ? null : 'true', title: `${a.command}: ${a.available ? a.words : a.why}`,
      }, rvEl('span', { class: 'rv-act-n' }, `${i + 1}.`), ' ', rvEl('span', { class: 'rv-act-label' }, a.label), ' ', rvEl('span', { class: `rv-effect is-${a.effect}` }, effect(a)))))),
    rvEl('p', { class: 'rv-acts-cmd', 'data-rv-cmd': primary ? primary.id : '' }, ...says(primary)),
    rvEl('p', { class: 'rv-acts-note', role: 'status', 'aria-live': 'polite', 'data-rv-note': '' }));
}

/** The whole run: its head, its pipeline and actions, and its three columns. */
function rvView(d, ins, why) {
  const facts = rvFacts(d);
  const sel = ins ? rvSelected(ins) : null;
  if (rvShown) rvShown.sel = sel;
  const prediction = d.prediction
    ? rvEl('p', null, d.prediction.words, rvEl('span', { class: 'run-from' }, ` receipt ${d.prediction.receipt}${d.prediction.frozenAt ? `, frozen ${rvWhen(d.prediction.frozenAt)}` : ''}`))
    : rvEl('p', null, rvNone('No prediction was recorded before this run.'));
  const predictReceipt = ins && d.prediction ? ins.receipts.list.find((r) => r.id === d.prediction.receipt) : null;
  const before = [
    ...(ins ? rvIntent(d, ins) : []),
    facts.before,
    rvEl('div', { class: 'rv-card is-predict', 'data-rv-card': 'predict' },
      rvEl('h5', null, 'Prediction (frozen before the result; not an observed receipt)'), prediction,
      predictReceipt ? rvReceiptMark(predictReceipt) : null),
  ];
  // the run: with an inspection, the viewer above and, under it, the files and the run detail's facts, each scrolling
  const runFacts = [facts.run, rvEl('h5', null, 'Checks: predicted beside actual'), rvChecks(d), rvEl('h5', null, 'Files'), rvFilesTable(d)];
  const run = ins
    ? [rvViewer(ins, sel), rvScrollBox('rv-lower', 'The files the run changed and made, and its facts', rvFileList(ins, sel), runFacts)]
    : [rvEl('p', { class: 'rv-why', 'data-rv-inspection': 'none' }, why || 'This run was not inspected.'), runFacts];
  const receipts = ins ? rvReceipts(ins) : [rvEl('h5', null, 'Receipts'), d.receipts.length
    ? rvEl('ul', { class: 'run-list' }, d.receipts.map((r) => rvEl('li', null, rvEl('code', null, r.id), ` · ${r.kind}${r.subject ? ` · ${r.subject}` : ''}`)))
    : rvEl('p', null, rvNone('No receipts recorded.'))];
  const after = [...receipts, facts.after, rvEl('h5', null, 'Not known (no record says)'), d.unknown.length
    ? rvEl('ul', { class: 'run-list' }, d.unknown.map((u) => rvEl('li', null, rvEl('strong', null, u.field), `: ${u.why}`)))
    : rvEl('p', null, rvNone('Nothing listed.'))];
  // a column: one box that scrolls (with its cue), or (the run, inspected) boxes of its own that each scroll
  const col = (cls, title, label, kids, own = true) => rvEl('section', { class: `rd-col${own ? ' rv-hold' : ' rv-split'} ${cls}`, 'aria-label': label },
    rvEl('h5', { class: 'rd-col-title' }, title),
    own ? rvEl('div', { class: 'rv-scroll', 'data-rv-scroll': '', tabindex: '0', 'aria-label': label }, kids) : rvEl('div', { class: 'rv-split-body' }, kids));
  return rvEl('article', { class: 'run-view', 'data-operation': d.operation, 'data-inspected': ins ? 'true' : 'false' },
    rvEl('header', { class: 'rv-head' },
      rvEl('h4', { class: 'run-title' }, 'Run ', rvEl('code', null, d.operation), ` · ${d.project.name}`),
      rvEl('span', { class: 'rv-verdict', 'data-state': d.verdict.state }, d.verdict.state),
      rvEl('span', { class: 'rv-checked', 'data-rv-checked': ins ? ins.checkedAt : '' }, ins ? `checked ${rvClock(ins.checkedAt)} by this companion's server (Timmy's verifier, verifyReceiptIn)` : ''),
      rvEl('button', { type: 'button', class: 'btn-action tiny', 'data-rv-again': d.operation }, 'Check again')),
    ins ? rvPipe(ins) : null,
    ins ? rvActions(ins) : null,
    rvEl('div', { class: 'rv-cols' },
      col('rd-before', '.intent · .predict · before the run', 'Before the run: its intent, its source and its prediction', before),
      col('rd-run', 'the run · its changes and outputs', 'The run: its changes, outputs and facts', run, !ins),
      col('rd-after', '.receipt · after the run', 'After the run: its receipts, verified now, and the verdict', after)));
}

// ── reading and drawing ───────────────────────────────────────────────────────

/** Draws an answer into the box, keeping the viewer's choice and each column's place on a re-read of the same run. */
function rvDraw(box, body, op) {
  const same = rvShown && rvShown.op === op;
  const tops = same ? [...box.querySelectorAll('[data-rv-scroll]')].map((el) => el.scrollTop) : [];
  if (!same) rvShown = { op, sel: null };
  rvShown.detail = body.detail;
  rvShown.inspection = body.inspection || null;
  rvShown.why = body.inspectionWhy || null;
  box.replaceChildren(rvView(body.detail, rvShown.inspection, rvShown.why));
  if (same) [...box.querySelectorAll('[data-rv-scroll]')].forEach((el, i) => { if (tops[i]) el.scrollTop = tops[i]; });
  requestAnimationFrame(() => { rvMark(box); if (typeof markOverflow === 'function') markOverflow(); });
}

/** Reads and draws the run detail of `op` for the project this page shows; `address`: this page's address says /run/<op>;
 *  `o.quiet`: a re-read of the run on screen (its view stays until the answer comes). */
async function openRun(op, address = true, o = {}) {
  const box = document.getElementById('run-detail');
  const input = document.getElementById('run-op');
  if (!box) return;
  const mine = ++rvAsked;
  if (rvTimer) { clearTimeout(rvTimer); rvTimer = null; }
  const id = String(op || '').trim();
  if (input && input.value !== id && !o.quiet) input.value = id;
  // the run a person opened stays open: a frame drawn meanwhile does not open the newest run over it (openNewestRun)
  if (OPERATION_ID.test(id) && typeof workspace === 'object' && workspace) workspace.run = id;
  const say = (cls, kind, words, extra) => { rvShown = null; box.replaceChildren(rvEl('p', Object.assign({ class: cls, 'data-run': kind }, extra || {}), words)); };
  if (!OPERATION_ID.test(id)) { say('run-error', 'not-an-id', 'Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it. Nothing was read.'); return; }
  // the address names the run (never the token: the page took it out of its address when it opened)
  if (address) { try { history.replaceState(null, '', `/run/${id}`); } catch (e) { /* the address stays as it was */ } }
  if (!companion.token || companion.refused) {
    rvShown = null;
    box.replaceChildren(rvEl('p', { class: 'run-error', 'data-run': 'no-token' }, 'The run detail is read with the companion’s token, which this page does not have, so nothing was read. Open the companion from Timmy: in ', rvEl('code', null, 'timmy watch'), ', press q on HOME.'));
    return;
  }
  if (!o.quiet) { rvShown = rvShown && rvShown.op === id ? rvShown : null; box.replaceChildren(rvEl('p', { class: 'run-empty' }, `Reading the run detail of ${id}…`)); }
  const project = document.getElementById('project')?.dataset.project;
  let r;
  let body = null;
  try {
    r = await companion.fetch(`/api/run/${id}${project ? `?project=${encodeURIComponent(project)}` : ''}`);
    body = await r.json().catch(() => null);
  } catch (e) {
    if (mine !== rvAsked) return;
    if (!o.quiet) say('run-error', 'unreachable', `The companion could not be reached to read the run detail of ${id}.`);
    return;
  }
  if (mine !== rvAsked) return;
  if (!r.ok || !body || body.ok !== true || !body.detail) {
    say('run-error', 'refused', (body && body.error) || `The companion answered HTTP ${r.status}, so no run detail is shown.`, { 'data-status': r.status });
    return;
  }
  rvDraw(box, body, id);
  if (!o.quiet && typeof appendToLocalLogs === 'function') appendToLocalLogs('INFO', `Run detail: ${id}`);
  // a run still going on is read again while it is on screen
  const live = ['running', 'queued', 'cancelling', 'needs you'].includes(body.detail.verdict && body.detail.verdict.state);
  if (live) rvTimer = setTimeout(() => { const page = document.getElementById('ws-workflows'); if (rvShown && rvShown.op === id && page && !page.hidden && !document.hidden) openRun(id, false, { quiet: true }); }, RV_RUNNING_MS);
}

/** A command copied for Timmy's REPL, said in the actions' note (the button keeps its words). */
async function rvCopy(text, button) {
  const note = button.closest('.run-view')?.querySelector('[data-rv-note]');
  let words;
  try {
    if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
    await navigator.clipboard.writeText(text);
    words = `Copied: ${text}. Paste it in Timmy's REPL (timmy); nothing ran from this page.`;
  } catch (e) {
    words = `Not copied (this browser would not): type it in Timmy's REPL: ${text}`;
  }
  if (note) { note.textContent = words; note.dataset.copied = text; }
}

// an action pointed at or focused says its command and what it does on the line under the actions
for (const kind of ['pointerover', 'focusin']) {
  document.addEventListener(kind, (event) => {
    const el = event.target instanceof Element ? event.target.closest('#run-detail [data-rv-act]') : null;
    const line = el && el.closest('.rv-acts-row')?.querySelector('[data-rv-cmd]');
    if (!el || !line || line.dataset.rvCmd === el.dataset.rvAct) return;
    const [cmd, ...rest] = String(el.dataset.rvSays || '').split(' · ');
    line.dataset.rvCmd = el.dataset.rvAct;
    line.replaceChildren(rvEl('code', { class: 'rv-cmd-now' }, cmd), ` · ${rest.join(' · ')}`);
  });
}

// the page's clicks on a run detail: a file to show, a command to copy, the run read again
document.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-rv-sel], [data-rv-act], [data-rv-copy], [data-rv-again]') : null;
  if (!el || !el.closest('#run-detail')) return;
  if (el.dataset.rvAgain) { openRun(el.dataset.rvAgain, false, { quiet: true }); return; }
  if (el.dataset.rvCopy) { rvCopy(el.dataset.rvCopy, el); return; }
  const box = document.getElementById('run-detail');
  if (el.dataset.rvSel !== undefined && rvShown && rvShown.detail) {
    rvShown.sel = el.dataset.rvSel;
    rvDraw(box, { detail: rvShown.detail, inspection: rvShown.inspection, inspectionWhy: rvShown.why }, rvShown.op);
    box.querySelector('[data-rv-viewer] [data-rv-scroll]')?.focus({ preventScroll: true });
    return;
  }
  if (el.dataset.rvAct !== undefined) {
    if (el.getAttribute('aria-disabled') === 'true') { const note = el.closest('.run-view')?.querySelector('[data-rv-note]'); if (note) note.textContent = el.title; return; }
    if (el.dataset.rvAct === 'open' && rvShown && rvShown.inspection) {
      const p = el.dataset.rvPath;
      const ins = rvShown.inspection;
      const c = ins.changes.list.findIndex((x) => x.path === p);
      const out = ins.outputs.findIndex((x) => x.path === p);
      rvShown.sel = c >= 0 ? `c:${c}` : out >= 0 ? `o:${out}` : rvShown.sel;
      rvDraw(box, { detail: rvShown.detail, inspection: ins, inspectionWhy: rvShown.why }, rvShown.op);
      const note = box.querySelector('[data-rv-note]');
      if (note) note.textContent = `${p}: its preview is in the viewer; ${el.dataset.rvCommand} shows it in Timmy's REPL.`;
      return;
    }
    rvCopy(el.dataset.rvCommand, el);
  }
});
