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
/** R10 (H167): each run's summary in project context (H164's GET /api/journey/run/<op>: progress, result, receipt), by its id */
const rvSummaries = new Map();
/** A running run is read again this often while its detail is on screen. */
const RV_RUNNING_MS = 3000;

/** Elements whose children are blocks, rows or cells (each laid out as a block, a grid or a flex box): a line break
 *  between two of their children draws nothing and keeps the page's text worded apart, as its markup was before. */
const RV_BLOCKS = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'DIV', 'DETAILS']);

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

// R10 (H167; H168's F3, as on Home): the run's face says what happened in words; what its records say by id, hash or path
// (an operation, a job, a receipt, a sha256, a record's place under .timmy) is behind a Details control beside those words,
// whole: nothing is dropped, and nothing is said on the face that the Details does not back.
/** A Details control: its body's ids, hashes and paths, shown when a person opens it. */
function rvMore(...kids) {
  const body = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== '');
  if (!body.length) return null;
  return rvEl('details', { class: 'rv-more' }, rvEl('summary', null, 'Details'), rvEl('div', { class: 'rv-more-body' }, ...body));
}
/** A Details control as rows: [what, what its records say] (an empty one left out). */
function rvMoreRows(rows) {
  const kept = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
  return kept.length ? rvMore(rvEl('dl', { class: 'rv-more-dl' }, kept.flatMap(([k, v]) => [rvEl('dt', null, k), rvEl('dd', null, v)]))) : null;
}
/** An id or a hash as Timmy prints one: an operation (o + 8 hex), a job (j + 6 hex), a receipt or a sha256 (7 to 64 hex,
 *  one of them a letter, so a count is not taken for one). */
const RV_ID = /\b(?:o[0-9a-f]{8}|j[0-9a-f]{6}|(?:sha256_)?(?=[0-9]*[a-f])[0-9a-f]{7,64})\b/;
/**
 * R10 (H167; the lead's F3 finding in the companion check of 11c027d): the ids the run on screen gives the page: its
 * operation's, its run detail's receipts and prediction receipt, and each receipt the inspection lists with the one it links
 * to. RV_ID asks for a letter (so that a count is never taken for an id), and a receipt's id of eight digits (about 2% of them)
 * has none: the face drops the ids the page holds whatever their digits, by the same rules as the ones RV_ID finds. Set as
 * each run is drawn (rvDraw), longest first.
 */
let rvIds = [];
let rvIdsAt = null;
function rvKnowIds(d, ins) {
  const ids = new Set();
  const add = (v) => { const id = String(v ?? '').trim(); if (/^[0-9a-z]{6,64}$/i.test(id) && /[0-9]/.test(id)) ids.add(id); };
  if (d) {
    add(d.operation);
    for (const r of Array.isArray(d.receipts) ? d.receipts : []) add(r && r.id);
    if (d.prediction) add(d.prediction.receipt);
  }
  const list = ins && ins.receipts && Array.isArray(ins.receipts.list) ? ins.receipts.list : [];
  for (const r of list) { add(r && r.id); add(r && r.prev); }
  rvIds = [...ids].sort((a, b) => b.length - a.length);
  rvIdsAt = rvIds.length ? new RegExp(`\\b(?:${rvIds.join('|')})\\b`) : null;
}
/** Whether words name an id: one RV_ID finds, or one the run on screen gives the page. */
const rvHasId = (m) => RV_ID.test(m) || (rvIdsAt !== null && rvIdsAt.test(m));
/** A record's words for the face: a part in brackets that names an id or a hash, a last part after a colon that does, a
 *  sha256, and a place (a path) that does, taken out; a receipt, a job and an operation named by kind, not by id; an id the
 *  run gives the page, wherever else the words name it, taken out (its "'s" said as "its"). The whole words are in the
 *  Details beside them, so nothing the face says is new. */
function rvFace(w) {
  let s = String(w || '')
    .replace(/\s*\([^()]*\)/g, (m) => (rvHasId(m) ? '' : m))
    .replace(/:\s[^:;]*$/, (m) => (rvHasId(m) ? '' : m))
    .replace(/\b(prediction |block |edit |flow |run )?receipt [0-9a-f]{8}\b/g, (m, k) => `its ${k || ''}receipt`)
    .replace(/\bjob j[0-9a-f]{6}\b/g, 'the job')
    .replace(/\bflow f[0-9a-f]{8}\b/g, 'the flow')
    .replace(/\boperation o[0-9a-f]{8}\b/g, 'the operation')
    .replace(/\bsha256[: ](?:sha256_)?[0-9a-f]{7,}…?,?/g, '')
    .replace(/\bgit [0-9a-f]{7,40}\b/g, 'a git revision')
    .replace(/(?:\s(?:at|from|in|by))?\s*[^\s()]*\/[^\s()]*/g, (m) => (rvHasId(m) ? '' : m));
  for (const id of rvIds) {
    s = s.replace(new RegExp(`\\b${id}'s\\b`, 'g'), 'its').replace(new RegExp(`(?:\\s(?:at|from|in|by|of))?\\s*\\b${id}\\b`, 'g'), '');
  }
  return s.replace(/ {2,}/g, ' ').replace(/\s+([,;:.])(?=\s|$)/g, '$1').replace(/[,;:]\s*$/, '').trim();
}
/** Details rows for words whose face left something out (an id, a hash, a place), and for places always. */
const rvSaid = (label, words) => (words && rvFace(words) !== String(words) ? [label, String(words)] : null);

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

/** The run detail's own facts, as rows (each data-field, as before), split by the column they belong to; where each is
 *  from (a record, a receipt), the project's folder and id, and a next step's command, in the column's Details. */
function rvFacts(d) {
  const elapsed = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'not recorded';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  // a parent or a child run, in words; its operation's id in the Details (and the button's tip)
  const opLink = (id, words) => rvEl('button', { type: 'button', class: 'run-link', 'data-action': 'open-run', 'data-op': id, title: `operation ${id}` }, words);
  const COL = { objective: 'before', verdict: 'after', acceptance: 'after', related: 'after', next: 'after', summary: 'after' };
  const rows = { before: [], run: [], after: [] };
  const said = { before: [], run: [], after: [] };
  const row = (key, label, value, ...more) => {
    const col = COL[key] || 'run';
    rows[col].push(rvEl('div', { class: 'run-row', 'data-field': key }, rvEl('dt', null, label), rvEl('dd', null, value)));
    const m = more.flat().filter(Boolean);
    if (m.length) said[col].push([label, m.join('; ')]);
  };
  const from = (f) => (f ? `from ${f}` : null);
  const valueOf = (s) => (s && typeof s === 'object' ? String(s.value) : rvNone('not recorded'));
  const fromOf = (s) => (s && typeof s === 'object' ? from(s.from) : null);
  // a fact's words for the face (rvFace), and its whole words in the Details when the face left an id, a hash or a place out
  const whole = (w) => (w && rvFace(w) !== String(w) ? `in full: ${w}` : null);
  row('verdict', 'Timmy’s verdict', [rvEl('strong', { class: 'run-verdict', 'data-state': d.verdict.state }, d.verdict.state), ` · ${rvFace(d.verdict.words)}`], whole(d.verdict.words), from(d.verdict.from));
  row('stage', 'Workflow stage', `${d.stage.current ? `${d.stage.current} · ` : ''}${d.stage.done} of ${d.stage.total === null || d.stage.total === undefined ? 'an unrecorded number of' : d.stage.total} steps done`, from(d.stage.from));
  row('exits', 'Process exits', d.exits.length ? rvEl('ul', { class: 'run-list' }, d.exits.map((x) => rvEl('li', null, `${x.who}: ${x.code === null || x.code === undefined ? 'its exit is not known' : `exit ${x.code}`}${x.state ? ` (${x.state})` : ''}`))) : rvNone('none recorded'),
    d.exits.map((x) => (x.from ? `${x.who} from ${x.from}` : null)));
  row('freshness', 'Artifact freshness', `${d.freshness.state} · ${rvFace(d.freshness.why)}`, whole(d.freshness.why), from(d.freshness.from));
  row('acceptance', 'A person’s acceptance', `${d.acceptance.state}${d.acceptance.by ? ` by ${d.acceptance.by}` : ''}${d.acceptance.at ? `, ${rvWhen(d.acceptance.at)}` : ''}`, from(d.acceptance.from));
  row('objective', 'Objective', valueOf(d.objective), fromOf(d.objective));
  row('project', 'Project', d.project.name, `${d.project.root} · id ${d.project.id}`);
  row('source', 'Source revision', d.sourceRevision && typeof d.sourceRevision === 'object' ? rvFace(String(d.sourceRevision.value)) : rvNone('not recorded'), d.sourceRevision && typeof d.sourceRevision === 'object' ? whole(String(d.sourceRevision.value)) : null, fromOf(d.sourceRevision));
  const w = d.worker || {};
  const workers = [['model', w.model], ['harness', w.harness], ['environment', w.environment]].filter(([, v]) => v);
  row('worker', 'Worker', workers.length ? workers.map(([k, v]) => `${k} ${v && typeof v === 'object' ? String(v.value) : 'not recorded'}`).join('; ') : rvNone('not recorded'),
    workers.map(([k, v]) => (v && typeof v === 'object' && v.from ? `${k} from ${v.from}` : null)));
  row('time', 'Time', `started ${rvWhen(d.time.startedAt)} · ended ${rvWhen(d.time.endedAt)} · elapsed ${elapsed(d.time.elapsedMs)}`);
  row('related', 'Parent · children', [d.parent ? opLink(d.parent, 'its parent run') : rvNone('no parent'), ' · ', ...(d.children.length ? d.children.flatMap((c, i) => [i ? ' ' : '', opLink(c, `child run ${i + 1}`)]) : [rvNone('no children')])],
    d.parent ? `parent ${d.parent}` : null, d.children.length ? `children ${d.children.join(', ')}` : null);
  row('cost', 'Cost', d.cost.measured ? `$${Number(d.cost.usd).toFixed(4)} (reported)` : `unknown: ${rvFace(d.cost.why)}`, d.cost.measured ? from(d.cost.from) : whole(d.cost.why));
  row('next', 'Next', d.next ? rvFace(d.next.words) : rvNone('nothing recorded'), d.next ? whole(d.next.words) : null, d.next && d.next.command ? `its command: ${d.next.command}` : null);
  row('summary', 'Summary', d.summary && d.summary.path ? 'saved' : rvNone('none saved'), d.summary && d.summary.path ? `saved at ${d.summary.path}` : null);
  const dl = (k) => [rvEl('dl', { class: 'run-facts' }, rows[k]), rvMoreRows(said[k])];
  return { before: dl('before'), run: dl('run'), after: dl('after') };
}

/** The checks, predicted beside actual (as before); where each actual is from, in the Details under them. */
function rvChecks(d) {
  if (!d.checks.length) return rvEl('p', null, rvNone('No checks recorded.'));
  const word = (v) => (v === true ? 'differs' : v === false ? 'as predicted' : 'not compared');
  return [rvEl('table', { class: 'run-table' },
    rvEl('thead', null, rvEl('tr', null, rvEl('th', null, 'Check'), rvEl('th', null, 'Predicted'), rvEl('th', null, 'Actual'), rvEl('th', null, 'Compared'))),
    rvEl('tbody', null, d.checks.map((c) => rvEl('tr', { 'data-differs': String(c.differs) },
      rvEl('td', null, c.name), rvEl('td', null, c.predicted === null ? rvNone('none') : c.predicted), rvEl('td', null, c.actual),
      rvEl('td', { class: c.differs === false ? 'is-verified' : c.differs === true ? 'is-failed' : '' }, word(c.differs)))))),
  rvMoreRows(d.checks.map((c) => [c.name, c.from ? `its actual from ${c.from}` : null]))];
}

/** The files the run detail names (as before); each one's sha256 and record in the Details under them. A file of Timmy's
 *  own records (under .timmy: a job's log, an operation's record) is named by what it is; its place is in the Details. */
function rvFilesTable(d) {
  if (!d.files.length) return rvEl('p', null, rvNone('No files recorded.'));
  const own = (f) => /^\.timmy\//.test(String(f.path));
  return [rvEl('table', { class: 'run-table' },
    rvEl('thead', null, rvEl('tr', null, rvEl('th', null, 'File'), rvEl('th', null, 'Role'))),
    rvEl('tbody', null, d.files.map((f) => rvEl('tr', null, rvEl('td', null, own(f) ? 'Timmy’s record' : rvEl('code', null, f.path)), rvEl('td', null, f.role))))),
  rvMoreRows(d.files.map((f) => [own(f) ? `Timmy’s record (${f.role})` : f.path, [own(f) ? f.path : null, f.sha256 ? `sha256 ${String(f.sha256).slice(0, 12)}` : 'no sha256 recorded', f.from ? `from ${f.from}` : null].filter(Boolean).join(' · ')]))];
}

/** A diff: its counts and what it is against, then its hunks, each line with its marker (B5: + green, − red); the place of
 *  the version Timmy kept is its head's tip (and in the viewer's Details). */
function rvDiff(diff) {
  if (!diff || !diff.shown) return rvEl('p', { class: 'rv-why', 'data-rv-diff': 'none' }, diff ? diff.why : 'no diff');
  const against = diff.against === 'kept' ? 'against the version Timmy kept' : diff.against === 'nothing' ? 'against nothing: the run added it' : `${diff.from} → ${diff.to}`;
  const where = diff.against === 'kept' ? ` (${diff.from})` : '';
  const more = diff.more ? ` · ${diff.more} changed lines not drawn here` : '';
  return rvEl('div', { class: 'rv-diff-wrap' },
    rvEl('p', { class: 'rv-diff-head', title: `+${diff.added} −${diff.removed} · ${against}${where}${more}` }, rvEl('span', { class: 'rv-add-n' }, `+${diff.added}`), ' ', rvEl('span', { class: 'rv-del-n' }, `−${diff.removed}`), ` · ${against}`, more),
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
    // its type, size and bytes on the face; its sha256 in the Details beside them
    const facts = `${p.mime}${p.width && p.height ? ` · ${p.width} × ${p.height}` : ''} · ${rvBytes(p.bytes)}`;
    const sha = p.sha256 ? rvMore(`sha256 ${p.sha256}`) : null;
    if (!p.data) return rvEl('div', { class: 'rv-image is-absent' }, rvEl('p', null, rvEl('span', { class: 'rv-fig-facts' }, facts), sha), rvEl('p', { class: 'rv-why' }, p.why || 'not drawn here'));
    // a small image is drawn larger, its pixels kept square (its colors as they are). R6 lead: drawn to fit the viewer, and
    // a press on it shows it at size (panels.js TimmyEnlarge: data-enlarge names what it is)
    const words = `${o.caption ? `${o.caption} · ` : ''}${facts}`;
    return rvEl('figure', { class: `rv-image${p.width && p.width < 96 && p.height && p.height < 96 ? ' is-small' : ''}` },
      rvEl('button', { type: 'button', class: 'rv-enlarge', 'data-enlarge': words, title: 'Show it at size' }, rvEl('img', { src: p.data, alt: o.alt || 'the image as the server read it', 'data-rv-image': '' })),
      rvEl('figcaption', null, rvEl('span', { class: 'rv-fig-facts' }, words), sha));
  }
  if (p.kind === 'binary') return rvEl('div', { class: 'rv-binary', 'data-rv-binary': '' }, rvEl('p', null, `${p.what} · ${rvBytes(p.bytes)}${p.sha256 ? '' : ' · not hashed here'}`), p.sha256 ? rvMore(`sha256 ${p.sha256}`) : null);
  const first = o.firstLine || 1;
  return rvEl('div', { class: 'rv-text-wrap' },
    p.json || p.jsonWhy || p.cut || o.more ? rvEl('p', { class: 'rv-text-head' }, p.json ? 'JSON, laid out' : '', p.jsonWhy || '', p.cut ? `${p.json || p.jsonWhy ? ' · ' : ''}${p.cut}` : '', o.more || '') : null,
    o.earlier ? rvEl('p', { class: 'rv-why' }, o.earlier) : null,
    rvEl('pre', { class: `rv-text${p.json ? ' is-json' : ''}`, 'data-rv-text': '' }, p.lines.map((l, i) => rvEl('span', { class: 'rv-tl' }, rvEl('span', { class: 'rv-ln', 'aria-hidden': 'true' }, String(first + i)), l || ' '))),
    p.more ? rvEl('p', { class: 'rv-why' }, `and ${p.more} more line${p.more === 1 ? '' : 's'} (not sent to this page)`) : null);
}

/** A file now against its record: its words (their sha256 in the viewer's Details), and ✓ (green) only where the server
 *  found the bytes recorded. */
const rvNow = (now) => rvEl('p', { class: `rv-now${now.state === 'as recorded' ? ' is-verified' : now.state === 'changed since' || now.state === 'gone' ? ' is-failed' : ''}`, 'data-now': now.state },
  now.state === 'as recorded' ? '✓ ' : now.state === 'changed since' || now.state === 'gone' ? '✕ ' : '', rvFace(now.words));

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
  // what the records say by id, hash or place, for the viewer's Details (under its facts)
  const said = [];
  if (!sel) {
    show.push(rvEl('p', { class: 'rv-why' }, 'This run changed no file Timmy records, and made no output to show.'));
  } else if (sel === 's') {
    const s = ins.source;
    head.push(rvEl('span', { class: 'rv-v-path' }, s.doc), rvEl('span', { class: 'rv-v-tag' }, s.now.state === 'changed' ? 'the document as it ran → now' : 'the document as it ran'));
    show.push(s.diff ? rvDiff(s.diff) : rvEl('p', { class: 'rv-why' }, s.now.state === 'same' ? 'unchanged since the run: its blocks as they ran are in .intent' : s.blocksWhy || 'no diff'));
    facts.push(rvEl('p', { class: `rv-now${s.now.state === 'same' ? ' is-verified' : s.now.state === 'changed' ? ' is-failed' : ''}` }, s.now.state === 'same' ? '✓ ' : s.now.state === 'changed' ? '✕ ' : '', rvFace(s.now.words)));
    said.push(rvSaid('now', s.now.words));
    acts.push(rvCopyButton(`/open ${s.doc}`, 'Copy for the REPL', 'reads'));
  } else if (sel.startsWith('c:')) {
    const c = ins.changes.list[Number(sel.slice(2))];
    head.push(rvEl('span', { class: 'rv-v-path' }, c.path), rvEl('span', { class: 'rv-v-tag', 'data-how': c.how }, c.how));
    const image = c.preview && c.preview.kind === 'image';
    if (c.diff && c.diff.shown && !image) show.push(rvDiff(c.diff));
    if (image && c.keptPreview && c.keptPreview.kind === 'image') show.push(rvEl('div', { class: 'rv-pair' }, rvPreview(c.keptPreview, { caption: 'before: the version Timmy kept', alt: 'the version kept before the run' }), rvPreview(c.preview, { caption: c.preview.of, alt: c.preview.of })));
    else if (c.preview && !(c.diff && c.diff.shown && !image)) show.push(rvEl('p', { class: 'rv-of' }, c.preview.of), rvPreview(c.preview, { alt: c.preview.of }));
    if (c.diff && !c.diff.shown) facts.push(rvEl('p', { class: 'rv-why', 'data-rv-diff': 'none' }, rvFace(c.diff.why)));
    facts.push(rvEl('p', { class: 'rv-by' }, `${c.how} by ${rvFace(c.by)}`), rvNow(c.now),
      rvEl('p', { class: 'rv-kept' }, c.kept.state === 'ok' ? 'its previous version is kept' : rvFace(c.kept.words)));
    if (c.note) facts.push(rvEl('p', { class: 'rv-why' }, rvFace(c.note)));
    facts.push(rvEl('p', { class: `rv-check${c.check.status === 'verified' ? ' is-verified' : ' is-failed'}` }, c.check.status === 'verified' ? '✓ ' : '✕ ', rvFace(c.check.words)));
    said.push(c.diff && !c.diff.shown ? rvSaid('no line diff', c.diff.why) : null, rvSaid('by', c.by), rvSaid('now', c.now.words), c.kept.path ? ['kept', c.kept.words] : rvSaid('kept', c.kept.words),
      c.note ? rvSaid('note', c.note) : null, rvSaid('its check', c.check.words), c.record ? ['its record', c.record] : null);
    acts.push(rvCopyButton(c.open, 'Copy for the REPL', 'reads'));
    if (c.restore.offered) acts.push(rvCopyButton(c.restore.command, 'Restore', 'write', `${c.restore.command}: writes the kept previous version (${c.restore.from}) back over ${c.path}, only while it is exactly what the run left; its current version is kept first, and an edit receipt is sealed`));
    else { facts.push(rvEl('p', { class: 'rv-not-now', 'data-rv-restore': 'not offered' }, `Restore: not now: ${rvFace(c.restore.why)}`)); said.push(rvSaid('Restore', c.restore.why)); }
  } else {
    const o = ins.outputs[Number(sel.slice(2))];
    // a log's place names its job: the face says what it is, its place is in the Details
    head.push(rvEl('span', { class: 'rv-v-path' }, o.kind === 'log' ? rvFace(o.what) : o.path), rvEl('span', { class: 'rv-v-tag' }, o.kind === 'log' ? 'its log' : 'an output'));
    const earlier = o.kind === 'log' && o.preview.kind === 'text' && o.preview.more ? `${o.preview.more} earlier line${o.preview.more === 1 ? '' : 's'} not shown here (${o.open} shows its whole log in the REPL)` : null;
    // a log's last lines, numbered from the first of them shown
    show.push(rvPreview(o.kind === 'log' && o.preview.kind === 'text' ? { ...o.preview, more: 0 } : o.preview, { earlier: earlier && rvFace(earlier), alt: `${o.kind === 'log' ? rvFace(o.what) : o.path}, as the server read it`, firstLine: o.kind === 'log' && o.preview.kind === 'text' ? (o.preview.more || 0) + 1 : 1 }));
    const recorded = o.recorded ? `recorded: ${o.recorded.sha256 ? `sha256 ${rvShort(o.recorded.sha256)}` : 'no sha256'}${typeof o.recorded.bytes === 'number' ? `, ${rvBytes(o.recorded.bytes)}` : ''}, by ${o.recorded.from}` : null;
    facts.push(o.kind === 'log' ? null : rvEl('p', { class: 'rv-by' }, rvFace(o.what)), recorded ? rvEl('p', { class: 'rv-kept' }, rvFace(recorded)) : null, rvNow(o.now));
    said.push(o.kind === 'log' ? ['its place', o.path] : null, rvSaid('what', o.what), recorded ? ['recorded', recorded.replace(/^recorded: /, '')] : null, rvSaid('now', o.now.words), earlier ? rvSaid('earlier lines', earlier) : null);
    if (o.open) acts.push(rvCopyButton(o.open, 'Copy for the REPL', 'reads'));
  }
  const more = rvMoreRows(said);
  return rvEl('section', { class: 'rv-viewer', 'aria-label': 'The file chosen', 'data-rv-viewer': sel || 'none' },
    rvEl('div', { class: 'rv-v-head' }, ...head, rvEl('span', { class: 'rv-v-acts' }, ...acts)),
    rvScrollBox('rv-v-body', 'Its content', ...show, facts.length || more ? rvEl('div', { class: 'rv-v-facts' }, facts, more) : null));
}

/** A button that copies a command for Timmy's REPL: its label and what it does (R10, H168's F3: its label in words, not the
 *  command); the command in its title and, copied, in the note. */
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
    rvEl('span', { class: 'rv-pick-how' }, o.kind === 'log' ? 'log' : 'output'), ' ', rvEl('span', { class: 'rv-pick-path', title: o.kind === 'log' ? o.path : null }, o.kind === 'log' ? rvFace(o.what) : o.path), ' ',
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
  // the request (its operation's record, not a receipt): how and when it came on the face; its record's place and what
  // seals what it ran from (receipt ids, a sha256) in its Details
  const parts = [rvEl('div', { class: 'rv-card is-intent', 'data-rv-card': 'intent' },
    rvEl('h6', null, '.intent · ', rvEl('code', null, ins.intent.request || 'not recorded')),
    rvEl('p', { class: 'run-from' }, [ins.intent.via ? `via ${ins.intent.via}` : '', ins.intent.started ? `started ${rvWhen(ins.intent.started)}` : ''].filter(Boolean).join(' · ') || 'how it came is not recorded'),
    rvEl('p', { class: 'rv-why', 'data-rv-sealed-face': '' }, rvFace(ins.intent.sealed)),
    rvMore(rvEl('p', null, `its record: ${ins.intent.from}`), rvEl('p', { 'data-rv-sealed': '' }, ins.intent.sealed)))];
  const s = ins.source;
  if (!('doc' in s)) { parts.push(rvEl('p', { class: 'rv-why', 'data-rv-source': 'none' }, `Source: ${rvFace(s.none)}`)); return parts; }
  // the document now against the bytes it ran from, in words; the sha256 its prediction sealed, and the copy it was read
  // from, in its Details
  const src = [
    rvEl('h6', null, `source · ${s.doc} › ${s.block}`),
    rvEl('p', { class: `rv-now${s.now.state === 'same' ? ' is-verified' : s.now.state === 'changed' ? ' is-failed' : ''}`, 'data-rv-doc-now': s.now.state }, s.now.state === 'same' ? '✓ ' : s.now.state === 'changed' ? '✕ ' : '', rvFace(s.now.words)),
    rvEl('p', { class: 'rv-why' }, rvFace(s.copy.words)),
    rvMoreRows([['as it ran', `sha256 ${rvShort(s.asRan.sha256)}${s.asRan.from ? `, from ${s.asRan.from}` : ''}`], ['its copy', s.copy.words], ['now', s.now.words]]),
  ];
  if (s.now.state === 'changed') src.push(rvEl('button', { type: 'button', class: 'rv-copy', 'data-rv-sel': 's' }, 'Show its diff, as it ran → now'));
  for (const b of s.blocks) {
    // its code against the sha256 its block receipt sealed, in words; the receipt and the sha256s in its Details
    const sealed = b.sealed ? (b.sealed.matches === true ? rvEl('span', { class: 'is-verified' }, '✓ its code is the code its block receipt sealed') : b.sealed.matches === false ? rvEl('span', { class: 'is-failed' }, '✕ its code is not the code its block receipt sealed') : rvNone('its block receipt names no sha256 of its code')) : rvNone('no block receipt of this run names it');
    const ids = b.sealed ? rvMoreRows([['its block receipt', b.sealed.receipt], ['sealed', b.sealed.sha256 ? `sha256 ${rvShort(b.sealed.sha256)}` : 'no sha256'], ['its code', `sha256 ${rvShort(b.sha256)}`]]) : null;
    src.push(rvEl('div', { class: `rv-block${b.target ? ' is-target' : ''}`, 'data-rv-block': b.name },
      rvEl('p', { class: 'rv-block-head' }, rvEl('strong', null, b.name), ` · ${b.lang}${b.deps.length ? ` · needs ${b.deps.join(', ')}` : ''}${b.target ? ' · the block asked for' : ''}`),
      rvEl('pre', { class: 'rv-code' }, b.code.map((l, i) => rvEl('span', { class: 'rv-tl' }, rvEl('span', { class: 'rv-ln', 'aria-hidden': 'true' }, String(b.firstLine + i)), l || ' '))),
      rvEl('p', { class: 'rv-sealed' }, sealed), ids));
  }
  if (!s.blocks.length && s.blocksWhy) src.push(rvEl('p', { class: 'rv-why' }, rvFace(s.blocksWhy)));
  parts.push(rvEl('div', { class: 'rv-card is-source', 'data-rv-card': 'source' }, src));
  return parts;
}

/** A receipt's mark: ✓ verified now (green); ✕ not verified (amber), with why in words. What Timmy's verifier checked, and
 *  a why that names ids or hashes, are in the receipt's Details (rvReceiptMore). */
function rvReceiptMark(r) {
  return r.verified.ok
    ? rvEl('p', { class: 'rv-verified is-verified', 'data-verified': 'true' }, '✓ sealed and verified now')
    : rvEl('p', { class: 'rv-verified is-failed', 'data-verified': 'false' }, `✕ not verified: ${rvFace(r.verified.why)}`);
}
/** A receipt's Details: its id, its place on the chain, what it links to, and what Timmy's verifier checked (or why not). */
const rvReceiptMore = (r) => rvMoreRows([
  ['receipt', r.id],
  ['on the chain', `epoch ${r.epoch}, receipt ${r.position} · links to ${r.prev === 'genesis' ? `the start of epoch ${r.epoch}` : `receipt ${r.prev}`} · ${r.signed ? 'signed' : 'not signed'}`],
  r.verified.ok ? ['checked', r.verified.checked] : ['why not verified', r.verified.why],
]);

/** The receipts: the run's own (its outcome) as a card, then the chain intent → predict → run → receipt, each verified now;
 *  each receipt's id and what was checked in its Details. */
function rvReceipts(ins) {
  const list = ins.receipts.list;
  const outcome = [...list].reverse().find((r) => r.stage === 'receipt');
  const card = outcome
    ? rvEl('div', { class: `rv-card is-receipt${outcome.verified.ok ? ' is-verified' : ' is-failed'}`, 'data-rv-card': 'receipt', 'data-receipt': outcome.id },
      rvEl('h6', null, '.receipt · the run’s own'),
      rvEl('p', null, rvFace(`${outcome.kind}${outcome.subject ? ` · ${outcome.subject}` : ''}`)),
      rvEl('p', { class: 'run-from' }, `sealed ${rvWhen(outcome.ts)} · ${outcome.signed ? 'signed' : 'not signed'}`),
      rvReceiptMark(outcome), rvReceiptMore(outcome))
    : rvEl('div', { class: 'rv-card is-receipt', 'data-rv-card': 'receipt' }, rvEl('h6', null, '.receipt'), rvEl('p', { class: 'rv-why' }, list.length ? 'not sealed yet: the run\'s own receipt is sealed as it ends' : 'no receipt names this operation on the chain read'));
  const stageWord = { predict: '.predict', run: 'run', receipt: '.receipt' };
  const chain = rvEl('ol', { class: 'rv-chain', 'data-rv-chain': '' },
    rvEl('li', { 'data-stage': 'intent' }, rvEl('span', { class: 'rv-stage' }, '.intent'), ' the request · ', rvNone('not a receipt')),
    list.map((r) => rvEl('li', { 'data-stage': r.stage, 'data-receipt': r.id, 'data-verified': String(r.verified.ok) },
      rvEl('span', { class: 'rv-stage' }, stageWord[r.stage] || r.stage), ' · ', rvFace(`${r.kind}${r.subject ? ` · ${r.subject}` : ''}`),
      rvEl('span', { class: 'run-from' }, ` · ${rvClock(r.ts)}`),
      rvReceiptMark(r), rvReceiptMore(r))));
  const c = ins.receipts.chain;
  return [card, rvEl('h5', null, 'Receipts · intent → predict → run → receipt'), chain,
    rvEl('p', { class: `rv-chain-words${c.ok === true ? ' is-verified' : c.ok === false ? ' is-failed' : ''}`, 'data-rv-chain-ok': String(c.ok) }, c.ok === true ? '✓ ' : c.ok === false ? '✕ ' : '', rvFace(c.words)),
    rvMoreRows([['the chain', c.words]])];
}

/** The pipeline row: intent → predict → run → receipt, each stage's receipts as the server verified them (R10, H168's F3:
 *  in words, without their ids; each id is in the receipts' Details, and in its step's tip). */
function rvPipe(ins) {
  const of = (stage) => ins.receipts.list.filter((r) => r.stage === stage);
  const step = (stage, label) => {
    const rs = of(stage);
    const ok = rs.length && rs.every((r) => r.verified.ok);
    const bad = rs.filter((r) => !r.verified.ok).length;
    const words = !rs.length ? (stage === 'receipt' ? 'not sealed yet' : 'none') : ok ? `✓ ${rs.length === 1 ? 'verified now' : `${rs.length} receipts · verified now`}` : `✕ ${bad} of ${rs.length} not verified`;
    return rvEl('li', { class: `rv-pipe-step${ok ? ' is-verified' : bad ? ' is-failed' : ''}`, 'data-stage': stage, title: rs.length ? `receipt${rs.length === 1 ? '' : 's'} ${rs.map((r) => r.id).join(', ')}` : null }, rvEl('span', { class: 'rv-stage' }, label), ' ', words);
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
  // R10 (H167; H168's pattern 1): what the action does, in words; its command is its tip and what a press copies
  const says = (a) => (a ? [rvEl('strong', null, a.label), ` · ${effect(a)}: ${rvFace(a.available ? a.words : a.why)}`] : []);
  return rvEl('div', { class: 'rv-acts-row' },
    rvEl('ol', { class: 'rv-acts', 'aria-label': 'This run\'s actions', title: 'Open shows a file here; the others are commands for Timmy\'s REPL: a click copies one, and nothing runs from this page' }, ins.actions.map((a, i) => rvEl('li', null,
      rvEl('button', {
        type: 'button', class: `rv-act${a.primary ? ' is-primary' : ''}`, 'data-rv-act': a.id, 'data-rv-command': a.command, 'data-rv-path': a.path || null,
        'data-rv-says': `${a.command} · ${effect(a)}: ${a.available ? a.words : a.why}`, 'aria-disabled': a.available ? null : 'true', title: `${a.command}: ${a.available ? a.words : a.why}`,
      }, rvEl('span', { class: 'rv-act-n' }, `${i + 1}.`), ' ', rvEl('span', { class: 'rv-act-label' }, a.label), ' ', rvEl('span', { class: `rv-effect is-${a.effect}` }, effect(a)))))),
    rvEl('p', { class: 'rv-acts-cmd', 'data-rv-cmd': primary ? primary.id : '' }, ...says(primary)),
    rvEl('p', { class: 'rv-acts-note', role: 'status', 'aria-live': 'polite', 'data-rv-note': '' }));
}

/** R10 (H167): the run's progress, result and receipt in one row (H164's runSummary; until it is read, the run detail's own
 *  verdict and steps), each part in words; a receipt green only where the companion's server verified it now. */
function rvSummaryRow(sum, d) {
  const glyph = { completed: '✓', 'no change': '✓', failed: '✕', cancelled: '◼', running: '▶', 'waiting on you': '⚠' };
  const ms = d.time && typeof d.time.elapsedMs === 'number' ? d.time.elapsedMs : null;
  const took = ms === null ? null : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
  const parts = [];
  if (sum) {
    parts.push(rvEl('strong', { class: `rv-sum-state is-${String(sum.progress.state).replace(/\s+/g, '-')}` }, `${glyph[sum.progress.state] || '·'} ${sum.progress.state}`), ` · ${sum.progress.words}`);
    if (took) parts.push(` · ${took}`);
    const outs = (sum.result && sum.result.outputs) || [];
    parts.push(` · ${outs.length ? `${outs.length} ${outs.length === 1 ? 'file' : 'files'} written` : 'no file written'}`);
    parts.push(' · ', sum.receipt
      ? (sum.receipt.verified ? rvEl('span', { class: 'rv-sum-receipt is-verified' }, '✓ sealed and verified') : rvEl('span', { class: 'rv-sum-receipt tone-failed' }, `✕ sealed, not verified: ${sum.receipt.why || 'not said'}`))
      : rvEl('span', { class: 'rv-sum-receipt' }, sum.progress.state === 'running' ? 'its receipt is sealed as it ends' : 'no receipt sealed'));
  } else {
    parts.push(rvEl('strong', { class: 'rv-sum-state' }, `${glyph[d.verdict.state] || '·'} ${d.verdict.state}`), ` · ${d.stage.done} of ${d.stage.total === null || d.stage.total === undefined ? 'an unrecorded number of' : d.stage.total} steps`);
    if (took) parts.push(` · ${took}`);
  }
  return rvEl('p', { class: 'rv-summary', 'data-rv-summary': sum ? 'journey' : 'detail' }, ...parts,
    rvEl('button', { type: 'button', class: 'btn-action tiny rv-home', 'data-ws-tab': 'home', title: 'Home: the project\'s recent work' }, '← Recent work'));
}

/** The whole run: its head, its pipeline and actions, and its three columns. */
function rvView(d, ins, why) {
  const facts = rvFacts(d);
  const sel = ins ? rvSelected(ins) : null;
  if (rvShown) rvShown.sel = sel;
  // the prediction in words, when it was frozen; its receipt's id (and what was checked) in its Details
  const prediction = d.prediction
    ? rvEl('p', null, d.prediction.words, d.prediction.frozenAt ? rvEl('span', { class: 'run-from' }, ` · frozen ${rvWhen(d.prediction.frozenAt)}`) : null)
    : rvEl('p', null, rvNone('No prediction was recorded before this run.'));
  const predictReceipt = ins && d.prediction ? ins.receipts.list.find((r) => r.id === d.prediction.receipt) : null;
  const before = [
    ...(ins ? rvIntent(d, ins) : []),
    facts.before,
    rvEl('div', { class: 'rv-card is-predict', 'data-rv-card': 'predict' },
      rvEl('h5', null, 'Prediction (frozen before the result; not an observed receipt)'), prediction,
      predictReceipt ? [rvReceiptMark(predictReceipt), rvReceiptMore(predictReceipt)] : d.prediction ? rvMoreRows([['its receipt', d.prediction.receipt]]) : null),
  ];
  // the run: with an inspection, the viewer above and, under it, the files and the run detail's facts, each scrolling
  // R11 step 3 (H171; the terminal's words): where the run ran, in plain words: upmd runs its blocks on this computer, and no
  // sandbox ran, so none is named ("sandbox" never when none ran)
  const ran = ins ? ins.receipts.list.some((r) => r.stage === 'run') : d.receipts.length > 0;
  const where = rvEl('p', { class: 'rv-why', 'data-rv-ran': ran ? 'this-computer' : 'none' }, ran ? 'Ran on this computer; no sandbox.' : 'Not run yet: no run receipt.');
  const runFacts = [where, facts.run, rvEl('h5', null, 'Checks: predicted beside actual'), rvChecks(d), rvEl('h5', null, 'Files'), rvFilesTable(d)];
  const run = ins
    ? [rvViewer(ins, sel), rvScrollBox('rv-lower', 'The files the run changed and made, and its facts', rvFileList(ins, sel), runFacts)]
    : [rvEl('p', { class: 'rv-why', 'data-rv-inspection': 'none' }, why || 'This run was not inspected.'), runFacts];
  // not inspected: the receipts its run detail names, by kind; their ids in the Details under them
  const receipts = ins ? rvReceipts(ins) : [rvEl('h5', null, 'Receipts'), d.receipts.length
    ? [rvEl('ul', { class: 'run-list' }, d.receipts.map((r) => rvEl('li', { 'data-receipt': r.id }, rvFace(`${r.kind}${r.subject ? ` · ${r.subject}` : ''}`)))),
      rvMoreRows(d.receipts.map((r) => [r.kind, `receipt ${r.id}`]))]
    : rvEl('p', null, rvNone('No receipts recorded.'))];
  const after = [...receipts, facts.after, rvEl('h5', null, 'Not known (no record says)'), d.unknown.length
    ? [rvEl('ul', { class: 'run-list' }, d.unknown.map((u) => rvEl('li', null, rvEl('strong', null, u.field), `: ${rvFace(u.why)}`))), rvMoreRows(d.unknown.map((u) => rvSaid(u.field, u.why)))]
    : rvEl('p', null, rvNone('Nothing listed.'))];
  // a column: one box that scrolls (with its cue), or (the run, inspected) boxes of its own that each scroll
  const col = (cls, title, label, kids, own = true) => rvEl('section', { class: `rd-col${own ? ' rv-hold' : ' rv-split'} ${cls}`, 'aria-label': label },
    rvEl('h5', { class: 'rd-col-title' }, title),
    own ? rvEl('div', { class: 'rv-scroll', 'data-rv-scroll': '', tabindex: '0', 'aria-label': label }, kids) : rvEl('div', { class: 'rv-split-body' }, kids));
  // R10 (H167; the R10 brief's step 4, reference 12's top row): the run named in words (its request, as Home lists it), then its
  // progress, result and receipt in one row, in project context; its operation's id is its Details' (the title's tip, the facts)
  const sum = rvSummaries.get(d.operation) || null;
  return rvEl('article', { class: 'run-view', 'data-operation': d.operation, 'data-inspected': ins ? 'true' : 'false' },
    rvEl('header', { class: 'rv-head' },
      rvEl('h4', { class: 'run-title', title: `operation ${d.operation}` }, `${sum ? sum.title.replace(/(?:[\w.~-]+\/)+([\w.-]+)/g, '$1') : 'This run'} · ${d.project.name}`),
      rvEl('span', { class: 'rv-verdict', 'data-state': d.verdict.state }, d.verdict.state),
      rvEl('span', { class: 'rv-checked', 'data-rv-checked': ins ? ins.checkedAt : '', title: ins ? 'Timmy\'s verifier (verifyReceiptIn) checked each receipt on this companion\'s server' : null }, ins ? `checked ${rvClock(ins.checkedAt)} by this companion's server` : ''),
      rvEl('button', { type: 'button', class: 'btn-action tiny', 'data-rv-again': d.operation }, 'Check again'),
      // R10 (H167; H168's F3, as on Home): the run's operation, its record's place and the verifier, behind Details
      rvMoreRows([['operation', d.operation], ['its record', ins ? ins.intent.from : null], ['checked by', ins ? `Timmy's verifier (verifyReceiptIn), on this companion's server, ${rvWhen(ins.checkedAt)}` : null]])),
    rvSummaryRow(sum, d),
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
  // R10 (H167): the ids this run gives the page, which its face drops whatever their digits (rvKnowIds)
  rvKnowIds(body.detail, rvShown.inspection);
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
  if (!OPERATION_ID.test(id)) {
    say('run-error', 'not-an-id', 'Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it. Nothing was read.');
    const byId = document.getElementById('run-by-id');
    if (byId) byId.open = true;
    return;
  }
  // the address names the run (never the token: the page took it out of its address when it opened)
  if (address) { try { history.replaceState(null, '', `/run/${id}`); } catch (e) { /* the address stays as it was */ } }
  if (!companion.token || companion.refused) {
    rvShown = null;
    // the box these words name, opened (it is behind its Details control otherwise)
    const byId = document.getElementById('run-by-id');
    if (byId) byId.open = true;
    // R7 (H152; the R6 interaction review's N7: /run/<op> typed in the address bar has no token, and the remedy named only
    // `timmy watch`, q on HOME): why nothing was read, and the two ways to see this run with the token. The token is never kept
    // anywhere (no storage): an address opened by hand has none, by design.
    const code = (t) => rvEl('code', null, t);
    box.replaceChildren(rvEl('div', { class: 'run-error', 'data-run': 'no-token' },
      rvEl('p', null, `Run ${id} was not read: ${companion.refused ? 'this page’s token is not the companion’s' : 'this page has no token'}. Timmy gives the companion’s token only in the address it opens (after #), and the page keeps it in its memory, never in storage, so an address typed or opened by hand, as `, code(`/run/${id}`), ' was, carries none.'),
      rvEl('p', null, 'To see this run: in the Workbench (', code('timmy workbench'), '), select the run on its Workflows tab (3) and press ', code('c'), ': this page opens there with its token. Or in ', code('timmy watch'), ', press q on HOME, which shows the address with its token. Then type ', code(id), ' in this page’s Operation id box, above, and press Open its run detail.')));
    return;
  }
  if (!o.quiet) { rvShown = rvShown && rvShown.op === id ? rvShown : null; box.replaceChildren(rvEl('p', { class: 'run-empty' }, `Reading the run detail of ${id}…`)); }
  const project = document.getElementById('project')?.dataset.project;
  let r;
  let body = null;
  try {
    // R10 (H167): with H164's summary of it (its progress, result and receipt in words), read beside it; one not read leaves
    // the run detail's own words in the summary row
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    const [detail, summary] = await Promise.all([
      companion.fetch(`/api/run/${id}${q}`),
      companion.fetch(`/api/journey/run/${id}${q}`).then((x) => x.json()).catch(() => null),
    ]);
    r = detail;
    body = await r.json().catch(() => null);
    if (summary && summary.ok && summary.run) rvSummaries.set(id, summary.run);
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
    const [, ...rest] = String(el.dataset.rvSays || '').split(' · ');
    line.dataset.rvCmd = el.dataset.rvAct;
    line.replaceChildren(rvEl('strong', null, el.querySelector('.rv-act-label')?.textContent || ''), ` · ${rvFace(rest.join(' · '))}`);
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

// ── R11 round 7 (H169): the Workflows page and the Runs & receipts page on the shell's scaffold (SHELL CONTRACT v1) ──
//
// Two pages of the rail, drawn through TimmyPanels (companion.js draws a panel when its tab is shown and when a frame of
// another revision arrives) and registered with the shell (TimmyShell.page / .state) so the head, the band, the dock and the
// records area are the scaffold's. Their data is the companion's own records, read by src/companion/panels.ts:
//   Workflows         GET /api/panel/workflows/docs   the documents and their blocks in the board's words, the runs under
//                     (tab `workflows`)               way, ONE next action (a run starts in the terminal: this page starts none)
//   Runs & receipts   GET /api/panel/runs/list        every run and sealed receipt, newest first; a receipt's ✓ is drawn only
//                     (tab `logs`)                    where the companion's server verified it in that reading (never assumed)
// The run detail (#tab-run, above) stays in the Workflows page (SHELL CONTRACT v1 §2.1; companion.js's showRun() shows that
// page and opens the detail): a run opened from Runs & receipts goes there. The Runs page's older boxes (the socket log, the
// structured events, the latest receipt received) are its records (.page-records) once the scaffold is there.
// Nothing here starts, stops or writes anything; a command is copied, with what it does, for the terminal.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;
  const shell = () => (typeof TimmyShell !== 'undefined' && TimmyShell ? TimmyShell : null);
  const page = (id, reg) => { const s = shell(); if (s && typeof s.page === 'function') { try { s.page(id, reg); } catch (e) { /* the shell said why */ } } };
  const setState = (id, st, extra) => { const s = shell(); if (s && typeof s.state === 'function') { try { s.state(id, st, extra || {}); } catch (e) { /* the shell said why */ } } };
  const goTo = (legacy) => { const s = shell(); if (s && typeof s.go === 'function') s.go(legacy, 'h169'); else if (typeof showWorkspaceTab === 'function') showWorkspaceTab(legacy); };
  /** The kicker's number is the rail's order (SHELL CONTRACT v1 §2.3): the shell's own (TimmyShell.PAGES[].n) when it says, else the contract's. */
  const kickerN = (id, fallback) => { const s = shell(); const p = s && Array.isArray(s.PAGES) ? s.PAGES.find((x) => x && x.id === id) : null; return (p && p.n) || fallback; };
  /** A run's detail: companion.js's showRun() (the Workflows page, the detail, the picks marked), else the detail alone. */
  const showDetail = (op) => { if (typeof showRun === 'function') showRun(op); else if (typeof openRun === 'function') { goTo('workflows'); openRun(op); } };
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
  const took = (ms) => (typeof ms !== 'number' ? '' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };

  /** The panel's host inside a page's work (the shell's `.page-work`, else the section): the one index.html gives, else made. */
  function hostFor(tab, sectionId) {
    let host = document.querySelector(`[data-panel-host="${tab}"]`);
    if (host) return host;
    const section = document.getElementById(sectionId);
    if (!section) return null;
    const work = section.querySelector('.page-work') || section;
    host = document.createElement('div');
    host.className = `${tab}-host h169-host`;
    host.dataset.panelHost = tab;
    // after the shell's state slot (.page-state: the empty / error words), before the page's older boxes
    const slot = work.querySelector(':scope > .page-state');
    if (slot) slot.after(host); else work.prepend(host);
    return host;
  }
  /** A region of the page the shell draws (its context column, its records area), when the scaffold is there. */
  const region = (sectionId, cls) => { const s = document.getElementById(sectionId); return s ? s.querySelector(`.${cls}`) : null; };
  /** The shell draws a page's empty / error words itself (TimmyShell.state → .page-state); without it the page draws its own. */
  const shellStates = () => { const s = shell(); return Boolean(s && typeof s.state === 'function'); };
  /** Where a page's own tools go in the dock: the shell's .dock-tools when it made one, else the dock itself. */
  const dockToolsOf = (dock) => (dock && dock.querySelector(':scope > .dock-tools')) || dock;
  /** The page's records: a details box of our own inside .page-records (kept across draws), else nothing. */
  function recordsBox(sectionId, key, summary) {
    const rec = region(sectionId, 'page-records');
    if (!rec) return null;
    let box = rec.querySelector(`details[data-h169-records="${key}"]`);
    if (!box) {
      box = document.createElement('details');
      box.className = 'records h169-records';
      box.dataset.h169Records = key;
      const sum = document.createElement('summary');
      sum.textContent = summary;
      box.append(sum, document.createElement('div'));
      rec.append(box);
    }
    return box.lastElementChild;
  }
  async function copyWords(text, button, saidTo) {
    try {
      if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
      await navigator.clipboard.writeText(text);
      if (button) { button.dataset.copied = '1'; button.textContent = `Copied: ${text}`; }
      if (saidTo) saidTo.textContent = `Copied ${text}: paste it in the terminal (the Workbench, or the REPL). Nothing ran from this page.`;
    } catch (e) {
      if (saidTo) saidTo.textContent = `Could not copy (${e && e.message ? e.message : e}); the command is ${text}.`;
    }
  }

  // ── the Workflows page ──
  const WF = { project: null, host: null, ctx: null, answer: null, selected: null, timer: 0, asking: null, at: 0 };
  /** a draw-triggered read is skipped while one is under way, or within 1.5 s of the last (the frame moves often while a run runs) */
  const SOON_MS = 1500;
  const WF_SECTION = 'ws-workflows';
  const wfShown = () => Boolean(WF.host && document.contains(WF.host) && !WF.host.closest('[hidden]') && !document.hidden);

  /** The route's ONE next action as the head's primary; before the first read there is none of ours (the shell draws the frame's primary action meanwhile). No arrow in a label (D8: the shell draws the one →). */
  function wfPrimary(next) {
    if (!next) return null;
    if (next.kind === 'open' && next.operation) return { label: 'Open the run under way', run: () => showDetail(next.operation) };
    if (next.kind === 'open') return { label: 'Open Runs & receipts', run: () => goTo('logs') };
    if (next.kind === 'install') return { label: 'Copy: timmy doctor', run: () => copyWords(next.command || 'timmy doctor', null, WF.host && WF.host.querySelector('[data-wf="said"]')) };
    if (next.kind === 'create') return { label: 'Copy the starter command', run: () => copyWords(next.command, null, WF.host && WF.host.querySelector('[data-wf="said"]')) };
    return { label: `Copy: ${next.command}`, run: () => copyWords(next.command, null, WF.host && WF.host.querySelector('[data-wf="said"]')) };
  }

  function wfRegister(a) {
    const running = a && a.running ? a.running.length : 0;
    const docs = a ? a.docs.length : 0;
    page('workflows', {
      kicker: `${kickerN('workflows', '03')} / RUN A WORKFLOW`, title: docs ? 'Run the work the project describes.' : 'Describe the work as a workflow.',
      intro: docs ? 'Each document is Markdown with named blocks; a run starts in the terminal, and its receipt lands in Runs & receipts.' : 'A workflow is a Markdown file with named blocks (```bash [name:build]); the tray-workflow starter makes a project with one.',
      primary: a ? wfPrimary(a.next) : null, context: WF.selected ? 'selection' : null, dock: 'WORKFLOW TOOLS',
      band: a ? [{ k: 'Workflows', v: `${docs} document${docs === 1 ? '' : 's'} · ${running} running` }] : [],
    });
    if (!a) return;
    const errored = a.docs.find((d) => d.error);
    if (running) setState('workflows', 'running', { words: `${running} run${running === 1 ? '' : 's'} under way.` });
    else if (errored) setState('workflows', 'error', { words: `${errored.rel} could not be read whole: ${errored.error}.`, next: { label: 'Open Runs & receipts', run: () => goTo('logs') } });
    else if (!docs) setState('workflows', 'empty', { words: a.next.words, next: { label: 'Copy the starter command', run: () => copyWords(a.next.command, null, null) } });
    else setState('workflows', 'content');
  }

  function wfBlockRow(h, d, b) {
    const failed = /fail/.test(b.word);
    const ran = /\bran\b|completed|passed/.test(b.word);
    const row = h('li', { class: `wf-block${failed ? ' is-failed' : ''}${ran ? ' is-ran' : ''}${b.word === 'running' ? ' is-running' : ''}`, 'data-wf-block': b.name, 'data-word': b.word },
      h('span', { class: 'wf-glyph', 'aria-hidden': 'true' }, b.glyph || '·'),
      h('span', { class: 'wf-name' }, b.name, b.lang ? h('span', { class: 'wf-lang' }, ` ${b.lang}`) : null),
      h('span', { class: 'wf-word' }, b.word, b.detail ? ` · ${b.detail}` : ''),
      b.needs && b.needs.length ? h('span', { class: 'wf-needs' }, `needs ${b.needs.join(', ')}`) : null,
      h('span', { class: 'wf-acts' },
        h('button', { type: 'button', class: 'dock-btn wf-copy', 'data-wf-run': `${d.rel} ${b.name}`, title: 'Copies the terminal command that runs this block (its needs first); nothing runs from this page' }, 'Copy run command'),
        b.run ? h('button', { type: 'button', class: 'dock-btn', 'data-wf-open': b.run, title: 'Runs & receipts: its run' }, 'See its run') : null));
    return row;
  }

  function wfDraw() {
    const a = WF.answer; const h = WF.ctx.h; const host = WF.host;
    if (!a) return;
    const saidBefore = (host.querySelector('[data-wf="said"]') || {}).textContent || ''; // the last action's words stay through a redraw
    const docs = a.docs.map((d) => h('article', { class: `wf-doc${WF.selected === d.rel ? ' is-selected' : ''}${d.error ? ' is-failed' : ''}`, 'data-wf-doc': d.rel },
      h('header', { class: 'wf-doc-head' },
        h('button', { type: 'button', class: 'wf-doc-pick', 'data-wf-pick': d.rel, 'aria-pressed': WF.selected === d.rel ? 'true' : 'false' },
          h('span', { class: 'wf-doc-title' }, d.title || d.rel), h('span', { class: 'wf-doc-rel' }, d.title ? ` ${d.rel}` : '')),
        h('span', { class: 'wf-doc-count' }, d.error ? '✕ not read whole' : `${d.blocks.length} block${d.blocks.length === 1 ? '' : 's'}`)),
      d.error ? h('p', { class: 'wf-error' }, `✕ ${d.error}`) : h('ol', { class: 'wf-blocks' }, ...d.blocks.map((b) => wfBlockRow(h, d, b))),
      d.repeated.length ? h('p', { class: 'wf-note' }, `A name more than one block carries runs none of them: ${d.repeated.join(', ')}.`) : null));
    const running = a.running.length ? h('section', { class: 'wf-running', 'aria-label': 'Runs under way' },
      h('h3', { class: 'wf-h' }, 'Under way'),
      h('ul', null, ...a.running.map((r) => h('li', null, h('span', { class: 'wf-glyph', 'aria-hidden': 'true' }, '▶'), ` ${r.label} · ${r.word} · ${r.elapsed}`,
        r.operation ? h('button', { type: 'button', class: 'dock-btn', 'data-wf-open-op': r.operation }, 'Open its run detail') : null)))) : null;
    put(host,
      h('div', { class: 'wf-page' },
        running,
        h('section', { class: 'wf-docs', 'aria-label': 'Workflow documents' },
          docs.length ? docs : shellStates() ? null : h('p', { class: 'page-empty-words' }, a.next.words)),
        h('p', { class: 'wf-said', 'data-wf': 'said', 'aria-live': 'polite' }, saidBefore)));
    // the dock: this page's own tools (the shell moves the frame's actions there; ours follow)
    const dock = region(WF_SECTION, 'page-dock');
    if (dock) {
      let own = dock.querySelector('[data-h169-dock="workflows"]');
      if (!own) { own = document.createElement('span'); own.className = 'h169-dock dock-group'; own.dataset.h169Dock = 'workflows'; dockToolsOf(dock).append(own); }
      put(own,
        h('button', { type: 'button', class: 'dock-btn', 'data-wf-refresh': '1' }, 'Read again'),
        h('button', { type: 'button', class: 'dock-btn', 'data-wf-go': 'logs' }, 'Runs & receipts'),
        h('span', { class: 'dock-words' }, a.upmd ? 'Runner: upmd on this computer' : 'Runner: upmd not found on this computer'));
    }
    // the records: how this was read, and what could not be
    const rec = recordsBox(WF_SECTION, 'workflows', 'Records · how Workflows was read');
    if (rec) put(rec, h('p', null, `Read ${clock(a.at)} from the project's workflow documents, its job store and its receipts chain; nothing ran. The runner (upmd) ${a.upmd ? 'is' : 'is not'} on this computer's PATH.`),
      a.notes.length ? h('ul', null, ...a.notes.map((n) => h('li', { class: 'tone-failed' }, n))) : null,
      h('details', { class: 'ui-details' }, h('summary', null, 'Details · the terminal commands'), h('p', null, h('code', null, '/run <document> <block>'), ' runs a block and the blocks it needs first (the Workbench: R on the block). ', h('code', null, '/project new <name> --from tray-workflow'), ' makes a project with a workflow of its own.')));
    // the context column: the selected document
    wfContext();
  }

  function wfContext() {
    const ctxEl = region(WF_SECTION, 'page-context');
    if (!ctxEl) return;
    const a = WF.answer; const h = WF.ctx.h;
    const d = a && a.docs.find((x) => x.rel === WF.selected);
    let box = ctxEl.querySelector('[data-h169-context="workflows"]');
    if (!d) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('section'); box.className = 'ctx-box h169-context'; box.dataset.h169Context = 'workflows'; ctxEl.append(box); }
    const ran = d.blocks.filter((b) => /\bran\b|completed|passed/.test(b.word)).length;
    const failed = d.blocks.filter((b) => /fail/.test(b.word)).length;
    put(box,
      h('h3', { class: 'ctx-title' }, d.title || d.rel),
      h('dl', { class: 'ctx-facts' },
        h('dt', null, 'Document'), h('dd', null, h('code', null, d.rel)),
        h('dt', null, 'Blocks'), h('dd', null, `${d.blocks.length} · ${ran} ran · ${failed} failed · ${d.blocks.length - ran - failed} not run yet`),
        h('dt', null, 'Order'), h('dd', null, d.blocks.map((b) => b.name).join(' → ') || '—')),
      h('p', { class: 'ctx-words' }, 'A block runs with the blocks it needs first; its state here is the newest run\'s, from the job store and the receipt it sealed.'));
  }

  function wfRead(ctx, why) {
    if (WF.asking) return WF.asking;
    WF.at = Date.now();
    WF.asking = wfReadNow(ctx, why).finally(() => { WF.asking = null; });
    return WF.asking;
  }
  async function wfReadNow(ctx, why) {
    const host = WF.host;
    try {
      const r = await ctx.fetch(ctx.api('docs'));
      const body = await r.json().catch(() => null);
      if (!WF.host || WF.ctx !== ctx) return;
      if (!r.ok || !body || !body.ok) {
        put(host, ctx.h('p', { class: 'empty tone-failed' }, `✕ The workflows could not be read: ${(body && body.error) || `the companion answered HTTP ${r.status}`}.`));
        setState('workflows', 'error', { words: 'The workflows could not be read from the companion.', next: { label: 'Read again', run: () => wfRead(ctx, 'retry') } });
        return;
      }
      WF.answer = body;
      wfRegister(body);
      wfDraw();
      if (body.running.length && wfShown()) { clearTimeout(WF.timer); WF.timer = setTimeout(() => { if (wfShown()) wfRead(ctx, 'tick'); }, 4000); }
    } catch (e) {
      if (!WF.host) return;
      put(host, ctx.h('p', { class: 'empty tone-failed' }, `✕ The workflows could not be read: ${e && e.message ? e.message : e}.`));
    }
  }

  TimmyPanels.register('workflows', {
    draw(host, frame, ctx) {
      if (!ctx.own) { put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its workflows are not read here.')); return; }
      WF.host = host; WF.ctx = ctx;
      if (WF.project !== ctx.project) { WF.project = ctx.project; WF.answer = null; WF.selected = null; put(host, ctx.h('p', { class: 'empty' }, 'Reading this project\'s workflows…')); }
      wfRegister(WF.answer);
      if (!host.dataset.h169Bound) {
        host.dataset.h169Bound = '1';
        host.addEventListener('click', (event) => {
          const t = event.target instanceof Element ? event.target : null;
          if (!t) return;
          const copy = t.closest('[data-wf-run]');
          if (copy) { copyWords(`/run ${copy.dataset.wfRun}`, copy, host.querySelector('[data-wf="said"]')); return; }
          const pick = t.closest('[data-wf-pick]');
          if (pick) { WF.selected = WF.selected === pick.dataset.wfPick ? null : pick.dataset.wfPick; wfRegister(WF.answer); wfDraw(); return; }
          const open = t.closest('[data-wf-open-op]');
          if (open) { showDetail(open.dataset.wfOpenOp); return; }
          const see = t.closest('[data-wf-open]');
          if (see) { rlSelectRow(see.dataset.wfOpen); goTo('logs'); return; }
        });
      }
      const dock = region(WF_SECTION, 'page-dock');
      if (dock && !dock.dataset.h169Bound) {
        dock.dataset.h169Bound = '1';
        dock.addEventListener('click', (event) => {
          const t = event.target instanceof Element ? event.target : null;
          if (!t) return;
          if (t.closest('[data-wf-refresh]')) { wfRead(WF.ctx, 'refresh'); return; }
          const g = t.closest('[data-wf-go]'); if (g) goTo(g.dataset.wfGo);
        });
      }
      if (WF.answer && Date.now() - WF.at < SOON_MS) return WF.asking || undefined;
      return wfRead(ctx, 'draw');
    },
  });

  // ── the Runs & receipts page ──
  const RL = { project: null, host: null, ctx: null, answer: null, selected: null, timer: 0, want: null, wantRow: null, asking: null, at: 0 };
  const RL_SECTION = 'ws-logs';
  const rlShown = () => Boolean(RL.host && document.contains(RL.host) && !RL.host.closest('[hidden]') && !document.hidden);

  /** The receipt a link names: the Chat's a.cx-receipt goes to "#logs?receipt=<id>" (H171, 14:40 PT), id = the hash's first 8. */
  function rlWantFromHash() {
    const m = /^#logs\?(?:.*&)?receipt=([^&]+)/.exec(location.hash || '');
    try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
  }
  /** That record selected and scrolled to (its facts in the context column); one not in this list is said absent, in words. */
  function rlSelectReceipt(id) {
    RL.want = id;
    if (!RL.answer || !RL.host) return; // applied after the next read
    const hit = RL.answer.rows.find((r) => r.receipt && (r.receipt.short === id || r.receipt.hash === id || String(r.receipt.hash).slice(7).startsWith(id)));
    if (hit) {
      RL.selected = hit.id; RL.want = null;
      rlRegister(RL.answer); rlDraw();
      const row = RL.host.querySelector(`[data-rl-row="${CSS.escape(hit.id)}"]`);
      if (row) { row.scrollIntoView({ block: 'nearest' }); const b = row.querySelector('.rl-pick'); if (b) b.focus({ preventScroll: true }); }
      return;
    }
    RL.want = null;
    const said = RL.host.querySelector('[data-rl="said"]');
    if (said) said.textContent = `No record ${id} in this list (${RL.answer.rows.length} shown of ${RL.answer.total}): timmy receipts lists every receipt of the project.`;
  }
  /** A row named by its id (a job's id from the Workflows page): selected once the list holds it. */
  function rlSelectRow(id) {
    RL.wantRow = id || null;
    if (!RL.answer || !RL.host || !RL.wantRow) return;
    const hit = RL.answer.rows.find((r) => r.id === RL.wantRow || (r.job && r.job.id === RL.wantRow));
    RL.wantRow = null;
    if (!hit) return;
    RL.selected = hit.id; rlRegister(RL.answer); rlDraw();
  }
  document.addEventListener('timmy:open-receipt', (e) => { const id = e && e.detail ? e.detail.id : null; if (typeof id === 'string' && id) rlSelectReceipt(id); });
  window.addEventListener('hashchange', () => { const id = rlWantFromHash(); if (id) rlSelectReceipt(id); });

  /**
   * The frame's "Unfinished · <page> · Works now / Not yet" box (companion.js drawUnfinished prepends it to the section on every
   * frame; the shell's sheet orders it between the head and the band) is EVIDENCE, not a region: it moves into the page's
   * records, in a details open by default (what does not work here yet is this page's truth, so it stays readable), and the
   * scaffold reads head → band → body (the lead's D23 on H168's R106). A frame that no longer marks the tab takes the box away.
   */
  function foldUnfinished(section, frame, legacy) {
    if (!section) return;
    const rec = section.querySelector(':scope > .page-records');
    if (!rec) return;
    const marked = !frame || !Array.isArray(frame.tabs) ? null : frame.tabs.some((t) => t && String(t.id) === legacy && t.unfinished && typeof t.unfinished.works === 'string');
    let home = rec.querySelector(':scope > details.records[data-h169-records="unfinished"]');
    const top = section.querySelector(':scope > .unfinished');
    if (marked === false) { if (top) top.remove(); if (home) home.remove(); return; }
    if (!top) return;
    if (!home) {
      home = document.createElement('details');
      home.className = 'records h169-records';
      home.dataset.h169Records = 'unfinished';
      home.open = true;
      const sum = document.createElement('summary');
      sum.textContent = 'Unfinished · what works on this page now, and what does not yet';
      home.append(sum);
      rec.prepend(home);
    }
    for (const old of home.querySelectorAll(':scope > .unfinished')) old.remove();
    home.append(top);
  }

  /** The page's older boxes (the socket log, the events, the latest receipt) find their place at load: the page's records. */
  function rlArrange() {
    const section = document.getElementById(RL_SECTION);
    if (!section) return;
    const rec = section.querySelector('.page-records');
    const cols = section.querySelector('.cols-logs');
    if (rec && cols && !rec.contains(cols)) {
      const box = document.createElement('details');
      box.className = 'records h169-records';
      box.dataset.h169Records = 'logs-boxes';
      const sum = document.createElement('summary');
      sum.textContent = 'Records · this page\'s socket log, the structured events, the latest receipt it received';
      box.append(sum, cols);
      rec.append(box);
    }
  }

  function rlRegister(a) {
    const newest = a && a.rows.find((r) => r.operation);
    page('runs', { // the PAGE id (the rail's 'runs'); the panel's tab stays the legacy 'logs'
      kicker: `${kickerN('runs', '04')} / REVIEW WHAT RAN`, title: 'Every run, and its receipt.',
      intro: 'Newest first. A receipt\'s mark turns green only once this companion verified it against the project\'s chain; nothing is assumed.',
      // (before the first read there is no primary of ours: the shell draws the frame's primary action meanwhile)
      primary: !a ? null : newest ? { label: 'Open the newest run', run: () => showDetail(newest.operation) } : { label: 'Open Workflows', run: () => goTo('workflows') },
      context: RL.selected ? 'selection' : null, dock: 'RECORD TOOLS',
      band: a ? [{ k: 'Records', v: `${a.total} run${a.total === 1 ? '' : 's'} · ${a.rows.filter((r) => r.receipt && r.receipt.verified).length} verified` }] : [],
    });
    if (!a) return;
    if (a.running) setState('runs', 'running', { words: `${a.running} run${a.running === 1 ? '' : 's'} under way.` });
    else if (!a.total) setState('runs', 'empty', { words: 'No run and no receipt in this project yet. A chat turn or a workflow run seals the first one.', next: { label: 'Open Workflows', run: () => goTo('workflows') } });
    else setState('runs', 'content');
  }

  function rlRow(h, r) {
    const v = r.receipt;
    const rc = !v ? h('span', { class: 'rl-receipt is-none' }, r.state === 'running' ? 'receipt when it ends' : 'no receipt')
      : v.verified ? h('span', { class: 'rl-receipt is-verified', title: `${v.hash}: verified by this companion in this reading` }, '✓ ', h('code', null, v.short), ' verified')
        : h('span', { class: 'rl-receipt is-unverified', title: v.why || 'not verified' }, h('code', null, v.short), ` not verified${v.why ? `: ${v.why}` : ''}`);
    return h('li', { class: `rl-row is-${r.state}${RL.selected === r.id ? ' is-selected' : ''}`, 'data-rl-row': r.id, 'data-kind': r.kind, 'data-state': r.state },
      h('button', { type: 'button', class: 'rl-pick', 'data-rl-pick': r.id, 'aria-pressed': RL.selected === r.id ? 'true' : 'false' },
        h('span', { class: `rl-mark${r.state === 'failed' ? ' is-failed' : ''}`, 'aria-hidden': 'true' }, r.mark),
        h('span', { class: 'rl-line' }, r.line),
        h('span', { class: 'rl-model' }, r.model || 'no model recorded'),
        h('span', { class: 'rl-took' }, r.ms === null ? (r.state === 'running' ? 'running' : '') : took(r.ms)),
        h('time', { class: 'rl-when', datetime: r.at }, clock(r.at))),
      rc,
      h('span', { class: 'rl-acts' },
        r.operation ? h('button', { type: 'button', class: 'dock-btn', 'data-rl-open': r.operation, title: `its run detail (Workflows), operation ${r.operation}` }, 'Open') : null,
        r.turn ? h('button', { type: 'button', class: 'dock-btn', 'data-rl-chat': r.turn.id || '', title: 'the Chat, where the turn\'s words are' }, 'Chat') : null));
  }

  function rlDraw() {
    const a = RL.answer; const h = RL.ctx.h; const host = RL.host;
    if (!a) return;
    const saidBefore = (host.querySelector('[data-rl="said"]') || {}).textContent || ''; // the last action's words stay through a redraw
    put(host,
      h('div', { class: 'rl-page' },
        h('ol', { class: 'rl-list', 'aria-label': 'Runs and receipts, newest first' }, ...(a.rows.length ? a.rows.map((r) => rlRow(h, r)) : shellStates() ? [] : [h('li', { class: 'page-empty-words' }, 'No run and no receipt yet.')])),
        a.total > a.rows.length ? h('p', { class: 'rl-more' }, `${a.total - a.rows.length} older not shown here: timmy receipts lists them all.`) : null,
        h('p', { class: 'rl-said', 'data-rl': 'said', 'aria-live': 'polite' }, saidBefore)));
    const dock = region(RL_SECTION, 'page-dock');
    if (dock) {
      let own = dock.querySelector('[data-h169-dock="logs"]');
      if (!own) { own = document.createElement('span'); own.className = 'h169-dock dock-group'; own.dataset.h169Dock = 'logs'; dockToolsOf(dock).append(own); }
      put(own,
        h('button', { type: 'button', class: 'dock-btn', 'data-rl-refresh': '1' }, 'Read again'),
        h('button', { type: 'button', class: 'dock-btn', 'data-rl-copy': 'timmy verify', title: 'Copies the command that checks the whole chain' }, 'Copy: timmy verify'),
        h('span', { class: 'dock-words' }, `${a.rows.filter((r) => r.receipt && r.receipt.verified).length} of ${a.rows.filter((r) => r.receipt).length} receipts verified in this reading`));
    }
    const rec = recordsBox(RL_SECTION, 'runs', 'Records · how Runs & receipts was read');
    if (rec) put(rec, h('p', null, `Read ${clock(a.at)} from the project's job store and its receipts chain; each receipt shown was checked against the chain in that reading (verifyReceiptIn), and nothing is assumed.`),
      a.notes.length ? h('ul', null, ...a.notes.map((n) => h('li', { class: 'tone-failed' }, n))) : null);
    rlContext();
  }

  function rlContext() {
    const ctxEl = region(RL_SECTION, 'page-context');
    if (!ctxEl) return;
    const a = RL.answer; const h = RL.ctx.h;
    const r = a && a.rows.find((x) => x.id === RL.selected);
    let box = ctxEl.querySelector('[data-h169-context="logs"]');
    if (!r) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('section'); box.className = 'ctx-box h169-context'; box.dataset.h169Context = 'logs'; ctxEl.append(box); }
    put(box,
      h('h3', { class: 'ctx-title' }, r.line),
      h('dl', { class: 'ctx-facts' },
        h('dt', null, 'State'), h('dd', null, `${r.mark} ${r.state}`),
        h('dt', null, 'Model'), h('dd', null, r.model || 'not recorded'),
        h('dt', null, 'Took'), h('dd', null, r.ms === null ? 'not recorded' : took(r.ms)),
        h('dt', null, 'When'), h('dd', null, clock(r.at)),
        h('dt', null, 'Receipt'), h('dd', null, r.receipt ? `${r.receipt.verified ? '✓ verified in this reading' : `not verified${r.receipt.why ? `: ${r.receipt.why}` : ''}`}` : 'none'),
        r.turn ? [h('dt', null, 'Sent from'), h('dd', null, r.turn.from)] : null),
      h('details', { class: 'ui-details' }, h('summary', null, 'Details · ids and hashes'),
        h('dl', { class: 'ctx-facts' },
          r.receipt ? [h('dt', null, 'Hash'), h('dd', null, h('code', null, r.receipt.hash))] : null,
          r.operation ? [h('dt', null, 'Operation'), h('dd', null, h('code', null, r.operation))] : null,
          r.turn && r.turn.id ? [h('dt', null, 'Turn'), h('dd', null, h('code', null, r.turn.id))] : null,
          r.job ? [h('dt', null, 'Job'), h('dd', null, h('code', null, r.job.id))] : null)));
  }

  function rlRead(ctx) {
    if (RL.asking) return RL.asking;
    RL.at = Date.now();
    RL.asking = rlReadNow(ctx).finally(() => { RL.asking = null; });
    return RL.asking;
  }
  async function rlReadNow(ctx) {
    const host = RL.host;
    try {
      const r = await ctx.fetch(`/api/panel/runs/list${ctx.project ? `?project=${encodeURIComponent(ctx.project)}` : ''}`);
      const body = await r.json().catch(() => null);
      if (!RL.host || RL.ctx !== ctx) return;
      if (!r.ok || !body || !body.ok) {
        put(host, ctx.h('p', { class: 'empty tone-failed' }, `✕ The runs could not be read: ${(body && body.error) || `the companion answered HTTP ${r.status}`}.`));
        setState('runs', 'error', { words: 'The runs could not be read from the companion.', next: { label: 'Read again', run: () => rlRead(ctx) } });
        return;
      }
      RL.answer = body;
      rlRegister(body);
      rlDraw();
      if (RL.want) rlSelectReceipt(RL.want);
      if (RL.wantRow) rlSelectRow(RL.wantRow);
      if (body.running && rlShown()) { clearTimeout(RL.timer); RL.timer = setTimeout(() => { if (rlShown()) rlRead(ctx); }, 4000); }
    } catch (e) {
      if (!RL.host) return;
      put(host, ctx.h('p', { class: 'empty tone-failed' }, `✕ The runs could not be read: ${e && e.message ? e.message : e}.`));
    }
  }

  TimmyPanels.register('logs', {
    draw(host, frame, ctx) {
      rlArrange();
      foldUnfinished(document.getElementById(RL_SECTION), frame, 'logs');
      if (!ctx.own) { put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its runs are not read here.')); return; }
      RL.host = host; RL.ctx = ctx;
      if (RL.project !== ctx.project) { RL.project = ctx.project; RL.answer = null; RL.selected = null; put(host, ctx.h('p', { class: 'empty' }, 'Reading this project\'s runs and receipts…')); }
      rlRegister(RL.answer);
      if (!host.dataset.h169Bound) {
        host.dataset.h169Bound = '1';
        host.addEventListener('click', (event) => {
          const t = event.target instanceof Element ? event.target : null;
          if (!t) return;
          const open = t.closest('[data-rl-open]');
          if (open) { showDetail(open.dataset.rlOpen); return; }
          const chat = t.closest('[data-rl-chat]');
          // the Chat page, told which turn (a listener may scroll to it; none is required): the turn's words are there
          if (chat) { try { window.dispatchEvent(new CustomEvent('timmy:chat-show-turn', { detail: { id: chat.dataset.rlChat || null } })); } catch (e) { /* no event here */ } goTo('chat'); return; }
          const pick = t.closest('[data-rl-pick]');
          if (pick) { RL.selected = RL.selected === pick.dataset.rlPick ? null : pick.dataset.rlPick; rlRegister(RL.answer); rlDraw(); }
        });
      }
      const dock = region(RL_SECTION, 'page-dock');
      if (dock && !dock.dataset.h169Bound) {
        dock.dataset.h169Bound = '1';
        dock.addEventListener('click', (event) => {
          const t = event.target instanceof Element ? event.target : null;
          if (!t) return;
          if (t.closest('[data-rl-refresh]')) { rlRead(RL.ctx); return; }
          const c = t.closest('[data-rl-copy]'); if (c) copyWords(c.dataset.rlCopy, c, host.querySelector('[data-rl="said"]'));
        });
      }
      if (RL.answer && Date.now() - RL.at < SOON_MS) return RL.asking || undefined;
      return rlRead(ctx);
    },
  });

  // the hosts and the records' place, as soon as the page's markup is there (this script loads before companion.js; the
  // pages' sheet, /panel-run.css, is index.html's link)
  const ready = () => { hostFor('workflows', WF_SECTION); hostFor('logs', RL_SECTION); rlArrange(); RL.want = rlWantFromHash(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
})();
