// R6 (H143): the VoxVision panel (tab 5; references 04, 05, 15 and 16), drawn into data-panel-host="voxvision" (panels.js
// says how a panel registers and what it is given). Its routes are src/companion/panels/vox.ts; what they answer is made by
// src/vox/preview.ts from the project's own records.
//
// Three working columns, as the references lay theirs out:
//   left    the project's records (results/vox, newest first) and the selected record's entity tree: its inputs, what was
//           observed over its images, its images, meshes, recordings, values and receipt; selecting one highlights it
//   centre  the viewport: the observed image with what was measured drawn over it (boxes, polygons, points, each labelled
//           with its provenance and evidence state), or a mesh as three views, or what Timmy reads of a recording; the
//           timeline of a video's sampled frames (a frame chosen changes the image); the record's commands
//   right   the pipeline as the record ran it (.intent → its tools → .receipt) with what this computer has not (SAM 3,
//           Depth Anything 3 …) named as such; the receipt, green only when verified; the values; the engines; the verdict
//
// Images come through the panel's own file route with the page's token in a header, and are shown as data: images (the
// page's policy allows those). Every word drawn is the record's or the preview's; nothing here invents a value.
//
// R11 round 7 (H170; the operator's order of 2026-10-24, "VoxVision/Card Lab inspiration must retain honest evidence";
// H175's SHELL CONTRACT v1): the page's purpose and words (the study's: "04 / OBSERVE & COMPARE · See the detail. Keep the
// evidence."), the ONE primary next action (the record's own next command for Timmy's terminal, copied; with no record, the
// command that makes one — nothing runs from this page, and the words say so), the honest EVIDENCE block at the top of the
// right column: observed facts · candidate matches · model scores · calibrated probabilities · measurement tolerances · price
// uncertainty as DIFFERENT rows, each read from the record and "Unknown" with why when the record holds none; the raw
// output and refusals preserved; the receipt row says what a seal proves (integrity and authorship) and what it does not (a
// conclusion); the model-authored-fields row says what the admission rule (AGENTS.md §4: a handle enum observed in this run
// and a cite(handle_id) call) finds on the record — today, nothing admitted: every model value is a claim, shown as one.
// The page's section is the shell's scaffold (H175's commit 2): the panel registers the page (TimmyShell.page / state —
// the head is the shell's, the kicker's number the rail's) and puts the record's commands in the dock's tools. The sheet
// /panel-vox.css is linked once by this script when the page has not linked it.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;
  if (!document.querySelector('link[href="/panel-vox.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/panel-vox.css'; document.head.append(l); }
  const PAGE_WORDS = Object.freeze({
    kicker: 'OBSERVE & COMPARE',
    title: 'See the detail. Keep the evidence.',
    intro: 'Choose a source, ask a precise question, and inspect what the tools observed.',
    // (H168's R107: the primary is a verb phrase without syntax; the command itself stands in the Records box and the record's
    // Commands box, each a copy button)
    emptyNext: 'Copy the detect command',
    nothingRuns: 'A press copies the command for Timmy’s terminal; nothing runs from this page.',
  });
  /** The evidence rows' names (the order's six quantities, kept apart), then the receipt and the admission rule. */
  const EVIDENCE_ROWS = Object.freeze([
    ['observed', 'Observed facts'], ['candidates', 'Candidate matches'], ['scores', 'Model scores'], ['calibrated', 'Calibrated probabilities'],
    ['tolerances', 'Measurement tolerances'], ['price', 'Price uncertainty'], ['receipt', 'Receipt'], ['admitted', 'Model-authored fields'],
  ]);

  const SVG = 'http://www.w3.org/2000/svg';
  const PATH_DATA = /^(?:M-?\d+ -?\d+L-?\d+ -?\d+)*$/;
  const LIST_EVERY_MS = 2000;
  const LIST_AT_LEAST_MS = 10000;
  const CACHE_MAX = 24;
  // R6 lead: the smallest an SVG's words are drawn on screen, in CSS pixels (R7 H152: a mesh view's axis words; the marks'
  // labels are the page's own text, on a band outside the image)
  const LABEL_PX = 11;
  // the record an address names (…?vox=<id> or …#t=…&vox=<id>, as the Workbench's c can give it: src/workbench/voxvision-tab.ts
  // voxCompanionHint), read as this script loads, before the page takes the fragment out of the address
  const HINT = (() => { try { const m = /[?#&]vox=(v[0-9a-f]{8})(?:[&#]|$)/.exec(`${location.search}${location.hash}`); return m ? m[1] : ''; } catch (e) { return ''; } })();

  const S = {
    project: null, root: null, host: null, ctx: null, revision: null, listAt: 0, listSig: '', list: null, asking: null,
    sel: '', preview: null, previewSig: '', image: '', entity: '', frame: -1, imageAsk: 0, urls: new Map(), wanted: null, stageWatch: null,
  };

  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const q = (name) => (S.root ? S.root.querySelector(`[data-vox="${name}"]`) : null);
  /** el's children replaced by these (nulls and falses left out, arrays flattened): replaceChildren alone writes "null" */
  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  /** the page's "more below ↓" on the panel's boxes whose content goes on below their edge (the page marks its own) */
  function markMore() {
    if (!S.root) return;
    for (const body of S.root.querySelectorAll('.box > .box-body')) {
      const box = body.parentElement;
      const more = body.clientHeight > 0 && body.scrollHeight - body.scrollTop - body.clientHeight > 2;
      if (more) box.dataset.more = '1'; else delete box.dataset.more;
    }
  }
  const clock = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, month: 'short', day: 'numeric' }) : 'when not recorded'; };
  const statusWord = (s) => (s === 'needs-setup' ? 'needs setup' : s || 'unknown');

  function reset(project) {
    S.project = project; S.listSig = ''; S.list = null; S.sel = ''; S.preview = null; S.previewSig = ''; S.image = ''; S.entity = ''; S.frame = -1; S.listAt = 0;
    S.urls.clear();
    if (S.stageWatch) { S.stageWatch.disconnect(); S.stageWatch = null; }
    if (S.wanted === null) S.wanted = HINT;
  }

  // ── the page (R11 round 7): the shell's scaffold, or the panel's own head ──
  const shellOf = () => (typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.page === 'function' ? TimmyShell : null);
  /** The page's section and the scaffold's regions in it (SHELL CONTRACT v1 §2.2), when the shell drew them. */
  function scaffoldOf(host) {
    const section = host.closest('section.page') || host.closest('.ws-page') || null;
    if (!section) return null;
    const dock = section.querySelector(':scope > .page-dock');
    let tools = dock ? dock.querySelector(':scope > .dock-tools') : null;
    if (dock && !tools) { tools = document.createElement('div'); tools.className = 'dock-tools'; dock.append(tools); }
    return { section, dock: tools, records: section.querySelector(':scope > .page-records') };
  }
  /** The rail's number for this page (the shell's), before the kicker's verb phrase. */
  const kickerOf = (sh) => { const p = sh && sh.PAGES && sh.PAGES.find ? sh.PAGES.find((x) => x.id === 'voxvision') : null; return `${p && p.n ? `${p.n} / ` : ''}${PAGE_WORDS.kicker}`; };
  /**
   * The ONE primary next action: the record's own next command, copied for the terminal; with no record, the command that makes
   * one. The label is a verb phrase without syntax (H168's R107): "Copy the command to measure it" — the command itself is drawn in
   * the record's Commands box beside its label, and in the Records box's empty note.
   */
  function primaryOf() {
    const p = S.preview;
    const a = p ? p.actions.find((x) => x.primary) : null;
    if (a) return { label: `Copy the command to ${String(a.label).charAt(0).toLowerCase()}${String(a.label).slice(1)}`, run: () => copyText(a.enabled ? a.command : ''), disabled: !a.enabled, why: a.enabled ? '' : (a.why || 'not available now') };
    return { label: PAGE_WORDS.emptyNext, run: () => copyText('/detect <image>'), disabled: false, why: '' };
  }
  function copyText(text) {
    if (!text) return;
    try { const b = S.root && S.root.querySelector(`[data-copy="${CSS.escape(text)}"]`); if (b) { b.click(); return; } } catch (e) { /* the clipboard below */ }
    try { if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(text); } catch (e) { /* the words stay on the page */ }
  }
  /** The page registered with the shell (its head, primary, state), when the shell has the scaffold; else the panel's own head follows. */
  function registerPage() {
    const sh = shellOf();
    const stateWord = S.list === null ? 'content' : (S.list.records && S.list.records.length ? 'content' : 'empty');
    if (sh) {
      const pr = primaryOf();
      // (the primary's title carries the page's rule: a press copies the command; nothing runs from this page)
      try { sh.page('voxvision', { kicker: kickerOf(sh), title: PAGE_WORDS.title, intro: PAGE_WORDS.intro, primary: { label: pr.label, run: pr.run, disabled: pr.disabled, why: pr.disabled ? pr.why : PAGE_WORDS.nothingRuns }, context: 'selection', dock: 'VOXVISION TOOLS' }); } catch (e) { /* the shell says */ }
      if (typeof sh.state === 'function') { try { sh.state('voxvision', stateWord, stateWord === 'empty' ? { words: 'No VoxVision record in this project yet.', next: { label: PAGE_WORDS.emptyNext, run: () => copyText('/detect <image>') } } : undefined); } catch (e) { /* as above */ } }
    }
    drawDock();
  }
  /** The page's tools in the shell's dock (the record's commands, each copied for the terminal; the viewer's command), when the dock is there. */
  function drawDock() {
    const sc = S.host ? scaffoldOf(S.host) : null;
    if (!sc || !sc.dock) return;
    const h = S.ctx.h;
    for (const old of sc.dock.querySelectorAll('[data-vox-dock]')) old.remove();
    const p = S.preview;
    const acts = p ? p.actions.slice(0, 4) : [];
    for (const a of acts) {
      const b = h('button', { type: 'button', class: 'dock-btn vox-dock-btn', 'data-vox-dock': a.label, 'aria-disabled': a.enabled ? 'false' : 'true', title: a.enabled ? `${PAGE_WORDS.nothingRuns} ${a.effect}` : `Not now: ${a.why || 'not available'}` }, a.label);
      b.addEventListener('click', () => { if (a.enabled) copyText(a.command); });
      sc.dock.append(b);
    }
    if (!acts.length) sc.dock.append(h('span', { class: 'dock-note vox-dock-note', 'data-vox-dock': 'none' }, 'The record’s commands appear here.'));
  }

  // ── the skeleton: three columns of boxes (the page's head, band and dock are the shell's) ──
  function skeleton(h) {
    const box = (title, name, o = {}) => h('section', { class: `box${o.fit ? ' box-fit' : ''}${o.cls ? ` ${o.cls}` : ''}`, 'data-vox-box': name },
      h('h2', { class: 'box-title', 'data-vox': `${name}-title` }, title), h('div', { class: `box-body${o.body ? ` ${o.body}` : ''}`, 'data-vox': name }, h('p', { class: 'empty' }, 'Reading…')));
    // R7 (H152; the R6 review's defect 16: the viewport squeezed to 48% at 1376x768): the centre column is the viewport's (and
    // a video's timeline); the record's commands sit under its entity tree, so the image has the larger share of the panel
    const cols = h('div', { class: 'vox-cols', 'data-vox': 'cols' },
      h('div', { class: 'col-stack vox-left' },
        box('Records · results/vox', 'records', { fit: true, cls: 'vox-records-box' }),
        box('Entity tree', 'tree', { cls: 'vox-tree-box' }),
        box('Commands for this record', 'actions', { fit: true, cls: 'vox-acts-box', body: 'vox-acts' })),
      h('div', { class: 'col-stack vox-centre' },
        h('section', { class: 'box vox-view-box', 'data-vox-box': 'view' },
          h('h2', { class: 'box-title', 'data-vox': 'view-title' }, 'Viewport'),
          h('div', { class: 'box-body vox-view-body' },
            h('div', { class: 'vox-fake', 'data-vox': 'fake', hidden: true }),
            h('div', { class: 'vox-image-tabs', 'data-vox': 'image-tabs', role: 'group', 'aria-label': 'The record\'s images' }),
            h('div', { class: 'vox-stage', 'data-vox': 'stage' }, h('p', { class: 'empty' }, 'Reading…')),
            h('p', { class: 'vox-caption', 'data-vox': 'caption' }))),
        box('Timeline', 'timeline', { fit: true, cls: 'vox-timeline-box' })),
      h('div', { class: 'col-stack vox-right' },
        // R11 round 7: the honest evidence block first — the context of the selected record, each quantity its own row
        box('Evidence · read from the record', 'evidence', { fit: true, cls: 'vox-evidence-box' }),
        box('Pipeline · receipt', 'pipeline', { fit: true, cls: 'vox-pipeline-box' }),
        box('Values', 'values', { cls: 'vox-values-box' }),
        box('Engines on this computer', 'engines', { fit: true, cls: 'vox-engines-box' })));
    const root = h('div', { class: 'vox-page', 'data-vox': 'root' }, cols);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    return root;
  }

  // ── the list ──
  async function refreshList() {
    const ctx = S.ctx;
    if (S.asking) return S.asking;
    S.listAt = Date.now();
    S.asking = (async () => {
      let body = null;
      let status = 0;
      try {
        const r = await ctx.fetch(ctx.api('records'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      if (!body || body.ok !== true) {
        const el = q('records');
        if (el) put(el, ctx.h('p', { class: 'empty tone-failed', 'data-vox-error': 'records' }, `✕ The records could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`));
        return;
      }
      const sig = JSON.stringify(body.records.map((r) => [r.id, r.status, r.check.status, r.receipt.short || '', r.receipt.verified, r.counts]));
      const first = S.list === null;
      S.list = body;
      if (sig !== S.listSig || first) { S.listSig = sig; drawList(); markMore(); registerPage(); }
      const ids = body.records.map((r) => r.id);
      let want = S.sel && ids.includes(S.sel) ? S.sel : '';
      if (!want && S.wanted && ids.includes(S.wanted)) want = S.wanted;
      if (!want) want = ids[0] || '';
      const row = body.records.find((r) => r.id === want);
      const rowSig = row ? JSON.stringify([row.status, row.check, row.receipt.short || '', row.receipt.verified, row.counts]) : '';
      if (want !== S.sel || rowSig !== S.previewSig || !S.preview) {
        S.sel = want;
        S.previewSig = rowSig;
        markList();
        if (want) await loadPreview(want); else drawNone();
      }
    })().finally(() => { S.asking = null; });
    return S.asking;
  }

  function drawList() {
    const h = S.ctx.h;
    const el = q('records');
    if (!el) return;
    const L = S.list;
    if (!L.records.length) {
      put(el, h('p', { class: 'empty', 'data-vox-empty': 'records' }, 'No VoxVision record in this project yet. In Timmy\'s terminal, ', h('button', { type: 'button', class: 'cmd', 'data-copy': '/detect <image>' }, '/detect <image>'), ' or ', h('button', { type: 'button', class: 'cmd', 'data-copy': '/inspect <file>' }, '/inspect <file>'), ' makes one (a local change, with a vox receipt).'));
    } else {
      put(el, h('ol', { class: 'vox-records' }, L.records.map((r) => h('li', null,
        h('button', { type: 'button', class: 'vox-rec', 'data-vox-record': r.id, 'aria-current': r.id === S.sel ? 'true' : 'false' },
          h('span', { class: 'vox-rec-head' }, h('span', { class: 'vox-rec-id' }, r.id), ' ', h('span', { class: 'vox-rec-action' }, r.action), ' ',
            h('span', { class: `vox-rec-status st-${r.status}` }, `${r.status === 'failed' ? '✕ ' : ''}${statusWord(r.status)}`), r.fake ? h('span', { class: 'vox-tag-fake' }, ' FAKE') : null),
          h('span', { class: 'vox-rec-inputs' }, r.inputs.map((x) => `${x.role ? `${x.role}: ` : ''}${x.path}`).join(' · ') || 'no input'),
          h('span', { class: 'vox-rec-meta' }, clock(r.madeAt), ' · ',
            r.receipt.verified ? h('span', { class: 'vox-receipt-mark is-verified', 'data-verified': 'true' }, `✓ receipt ${r.receipt.short}`)
              : h('span', { class: `vox-receipt-mark${r.check.status === 'stale' ? ' tone-attention' : ''}`, 'data-verified': 'false' }, r.receipt.short ? `receipt ${r.receipt.short}, not verified` : 'not sealed'),
            r.check.status === 'stale' ? h('span', { class: 'tone-attention' }, ' · stale') : null,
            ` · ${r.counts.overlays} drawn · ${r.counts.values} values${r.counts.frames ? ` · ${r.counts.frames} frames` : ''}`))))));
    }
    const more = [];
    if (L.more) more.push(h('p', { class: 'empty' }, `and ${L.more} older records in results/vox (the newest ${L.records.length} are listed)`));
    for (const u of L.unreadable.slice(0, 3)) more.push(h('p', { class: 'empty tone-failed' }, `✕ ${u.file}: ${u.why}`));
    el.append(...more);
    const t = q('records-title');
    if (t) t.textContent = `Records · results/vox · ${L.records.length}${L.more ? ` of ${L.records.length + L.more}` : ''}`;
  }
  function markList() {
    for (const b of (S.root ? S.root.querySelectorAll('[data-vox-record]') : [])) b.setAttribute('aria-current', b.dataset.voxRecord === S.sel ? 'true' : 'false');
  }

  function drawNone() {
    const h = S.ctx.h;
    S.preview = null;
    registerPage();
    const say = (name, words) => put(q(name), h('p', { class: 'empty' }, words));
    say('tree', 'No record to show yet: its inputs, what was observed and its values appear here.');
    say('stage', 'No record to show yet. A VoxVision record\'s image and what was measured over it are drawn here.');
    say('pipeline', 'No record yet: .intent → its tools → .receipt, as it ran, appear here.');
    say('values', 'No record yet.');
    say('engines', 'Read with a record.');
    say('evidence', 'No record yet: with one, each quantity has its own row here — observed facts, candidate matches, model scores, calibrated probabilities, measurement tolerances, price uncertainty — and says Unknown when the record holds none.');
    say('timeline', 'No frames: a video record\'s sampled frames are a timeline here.');
    put(q('actions'));
    const cap = q('caption'); if (cap) cap.textContent = '';
    put(q('image-tabs'));
    const fake = q('fake'); if (fake) fake.hidden = true;
    const t = q('view-title'); if (t) t.textContent = 'Viewport';
  }

  // ── one record ──
  async function loadPreview(id) {
    const ctx = S.ctx;
    let body = null;
    let status = 0;
    try {
      const r = await ctx.fetch(ctx.api(`record?id=${encodeURIComponent(id)}`));
      status = r.status;
      body = await r.json().catch(() => null);
    } catch (e) { body = null; }
    if (S.sel !== id) return;
    if (!body || body.ok !== true) {
      const el = q('stage');
      if (el) put(el, ctx.h('p', { class: 'empty tone-failed', 'data-vox-error': 'record' }, `✕ Record ${id} could not be read: ${(body && body.error) || (status ? `HTTP ${status}` : 'the companion did not answer')}.`));
      return;
    }
    const p = body.preview;
    const was = S.preview && S.preview.id === p.id;
    S.preview = p;
    if (!was || !p.images.some((x) => x.key === S.image)) S.image = defaultImage(p);
    if (!was || !findEntity(p.entities, S.entity)) S.entity = '';
    const fi = p.frames.findIndex((f) => f.image === S.image);
    S.frame = fi;
    drawPreview();
  }

  const defaultImage = (p) => {
    const input = p.images.find((x) => x.role === 'input' && x.servable);
    if (input) return input.key;
    if (p.spatial.some((x) => x.views)) return 'spatial';
    const frame = p.frames.length ? p.frames[0].image : '';
    if (frame) return frame;
    const any = p.images.find((x) => x.servable);
    return any ? any.key : (p.spatial.length ? 'spatial' : p.recordings.length ? 'recording' : '');
  };
  function findEntity(list, id) {
    for (const e of list || []) { if (e.id === id) return e; const k = findEntity(e.children, id); if (k) return k; }
    return null;
  }

  function drawPreview() {
    drawTree();
    drawStageTabs();
    drawStage();
    drawTimeline();
    drawActions();
    drawEvidence();
    drawPipeline();
    drawValues();
    drawEngines();
    registerPage();
    const p = S.preview;
    const fake = q('fake');
    if (fake) { fake.hidden = !p.fake.is; fake.textContent = p.fake.is ? p.fake.words : ''; }
    markMore();
  }

  // ── the entity tree ──
  function drawTree() {
    const h = S.ctx.h;
    const el = q('tree');
    if (!el) return;
    const p = S.preview;
    const item = (e) => {
      const kids = e.children && e.children.length ? h('ul', { role: 'group' }, e.children.map(item)) : null;
      const on = e.id === S.entity;
      return h('li', { role: 'treeitem', 'aria-expanded': kids ? 'true' : null, 'data-kind': e.kind },
        h('button', { type: 'button', class: `vox-ent kind-${e.kind}${e.provenance === 'generated' ? ' is-generated' : ''}`, 'data-vox-entity': e.id, 'aria-current': on ? 'true' : 'false', title: e.path },
          h('span', { class: 'vox-ent-path' }, e.path), ' ', h('span', { class: 'vox-ent-label' }, e.label)),
        e.detail ? h('span', { class: 'vox-ent-detail' }, e.detail) : null,
        kids);
    };
    put(el, h('ul', { class: 'vox-tree', role: 'tree', 'aria-label': `Entities of record ${p.id}` }, p.entities.map(item)));
    const t = q('tree-title');
    if (t) t.textContent = `Entity tree · ${p.id}`;
  }

  // ── the viewport ──
  function drawStageTabs() {
    const h = S.ctx.h;
    const el = q('image-tabs');
    if (!el) return;
    const p = S.preview;
    const tabs = p.images.filter((x) => x.role !== 'frame').map((x) => ({ key: x.key, label: x.role === 'input' ? `observed: ${x.path.split('/').pop()}` : x.title, ok: x.servable }));
    if (p.frames.length) tabs.push({ key: p.frames[Math.max(0, S.frame)].image, label: `frames (${p.frames.length})`, ok: true, frames: true });
    if (p.spatial.length) tabs.push({ key: 'spatial', label: `mesh views (${p.spatial.length})`, ok: true });
    if (p.recordings.length) tabs.push({ key: 'recording', label: `recording (${p.recordings.length})`, ok: true });
    put(el, ...(tabs.length > 1 ? tabs.map((t) => h('button', { type: 'button', class: 'vox-image-tab', 'data-vox-image': t.key, 'aria-pressed': (t.frames ? S.frame >= 0 : S.image === t.key) ? 'true' : 'false' }, t.label, t.ok ? null : ' (not shown)')) : []));
  }

  function drawStage() {
    const h = S.ctx.h;
    const el = q('stage');
    const cap = q('caption');
    const title = q('view-title');
    if (!el) return;
    const p = S.preview;
    // R7 (H152): no label band until an image's marks are laid out (a mesh's views and a recording fill the stage)
    el.dataset.band = 'none';
    if (S.image === 'spatial') { drawSpatial(el, cap, title); return; }
    if (S.image === 'recording') { drawRecording(el, cap, title); return; }
    const im = p.images.find((x) => x.key === S.image);
    if (!im) {
      put(el, h('p', { class: 'empty', 'data-vox-empty': 'stage' }, p.images.length ? 'No image of this record can be shown: each says why under images in the entity tree.' : `No image: this record (${p.action} of ${p.inputs.map((x) => x.kindWords).join(', ') || 'no input'}) observed no image.`));
      if (cap) cap.textContent = '';
      if (title) title.textContent = `Viewport · ${p.id}`;
      return;
    }
    if (title) title.textContent = `Viewport · ${p.id} · ${im.title}`;
    if (!im.servable) {
      put(el, h('p', { class: 'empty', 'data-vox-empty': 'stage' }, `Not shown: ${im.why || 'not checked'}.`));
      if (cap) cap.textContent = '';
      return;
    }
    const img = h('img', { class: 'vox-img', alt: `${im.title} (record ${p.id})`, 'data-vox-img': im.key, 'data-path': im.path });
    const over = svg('svg', { class: 'vox-overlay', 'data-vox-overlay': im.key, preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': 'What was measured over the image' });
    // R7 (H152): the image and its marks in a frame of the image's own aspect; the marks' labels on a band outside it, each
    // tied to its mark by a leader line
    const frameBox = h('div', { class: 'vox-frame', 'data-vox': 'frame' }, img, over);
    const labels = h('ol', { class: 'vox-labels', 'data-vox': 'labels', 'aria-label': 'What each mark over the image is: its provenance and evidence' });
    const leaders = svg('svg', { class: 'vox-leaders', 'data-vox': 'leaders', 'aria-hidden': 'true' });
    el.dataset.band = 'none';
    put(el, frameBox, labels, leaders);
    const mine = p.overlays.filter((o) => o.image === im.key);
    if (cap) {
      put(cap,
        h('span', null, im.role === 'input' ? `the observed file${im.matches === false ? '' : ' (its bytes are the ones the record names)'}` : `${im.title}: provenance ${im.provenance} · evidence ${im.evidence}${im.word && im.word !== 'measured' ? ` · ${im.word}` : ''}`),
        im.note && im.role === 'input' ? h('span', { class: 'tone-attention' }, ` · ${im.note}`) : null,
        mine.length ? h('span', null, ` · drawn over it (${im.unit || 'px'}): `, legendOf(mine)) : h('span', { 'data-vox-empty': 'overlays' }, im.role === 'input' ? ` · nothing drawn over it: ${noneWhy()}` : ' · what it shows is drawn into the file itself'));
    }
    const ask = ++S.imageAsk;
    imageData(p.id, im.path).then((url) => {
      if (ask !== S.imageAsk) return;
      img.addEventListener('load', () => {
        if (ask !== S.imageAsk) return;
        drawOverlays(over, im, mine, img);
        drawLabels(labels, mine);
        layoutStage(el, im, mine);
        // R6 lead, R7 (H152): laid out again when the stage's size changes (a window resized, the tab shown after it was drawn
        // hidden) or the page's face has loaded (the labels' widths change), and the leaders when the band scrolls
        if (typeof ResizeObserver === 'function') {
          // one watch of the stage at a time (the stage stays; the image in it changes)
          if (S.stageWatch) S.stageWatch.disconnect();
          let seen = '';
          S.stageWatch = new ResizeObserver(() => {
            const size = `${el.clientWidth}x${el.clientHeight}`;
            if (el.clientWidth > 0 && size !== seen && ask === S.imageAsk && el.isConnected) { seen = size; layoutStage(el, im, mine); }
          });
          S.stageWatch.observe(el);
        }
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (ask === S.imageAsk && el.isConnected) layoutStage(el, im, mine); });
        labels.addEventListener('scroll', () => { if (ask === S.imageAsk) drawLeaders(el, im, mine); }, { passive: true });
      }, { once: true });
      img.src = url;
    }, (err) => {
      if (ask !== S.imageAsk) return;
      put(el, h('p', { class: 'empty tone-failed', 'data-vox-error': 'image' }, `✕ ${im.path} could not be shown: ${err && err.message ? err.message : String(err)}`));
    });
  }

  /** why nothing is drawn over the observed image (the tree's words for its observations) */
  const noneWhy = () => { const g = findEntity(S.preview.entities, 'observations'); return (g && g.detail) || 'nothing with a place in the image was recorded'; };

  function legendOf(list) {
    const h = S.ctx.h;
    const kinds = new Map();
    for (const o of list) { const k = `${o.provenance} · ${o.evidence}`; kinds.set(k, (kinds.get(k) || 0) + 1); }
    return [...kinds.entries()].map(([k, n], i) => h('span', { class: 'vox-legend-item', 'data-legend': k }, `${i ? '; ' : ''}${n} ${k}`));
  }

  /** An image of the record as a data: URL (fetched with the token; kept for the next draw). */
  async function imageData(id, path) {
    const key = `${id}|${path}`;
    if (S.urls.has(key)) return S.urls.get(key);
    const ctx = S.ctx;
    const r = await ctx.fetch(ctx.api(`file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`));
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      throw new Error((body && body.error) || `the companion answered HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const url = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('the image could not be read in the page'));
      fr.readAsDataURL(blob);
    });
    if (S.urls.size >= CACHE_MAX) S.urls.delete(S.urls.keys().next().value);
    S.urls.set(key, url);
    return url;
  }

  /** whether mark `o` belongs to the entity selected now (itself, or one of the group's marks) */
  const isOn = (o) => Boolean(S.entity) && (o.entity === S.entity || ((findEntity(S.preview.entities, S.entity) || {}).overlays || []).includes(o.id));

  /** What was measured over the image, in the image's own pixel frame: its boxes, polygons and points (their labels are not here). */
  function drawOverlays(over, im, list, img) {
    const W = (im.frame && im.frame[0]) || img.naturalWidth || 1;
    const H = (im.frame && im.frame[1]) || img.naturalHeight || 1;
    over.setAttribute('viewBox', `0 0 ${W} ${H}`);
    over.dataset.frame = `${W}x${H}`;
    const big = Math.max(W, H);
    const kids = [];
    for (const o of list) {
      const on = isOn(o);
      const cls = `ov ov-${o.shape}${on ? ' is-selected' : ''}${o.provenance === 'generated' ? ' is-generated' : ''}${o.evidence === 'unverified' || o.evidence === 'stale' ? ' is-unverified' : ''}`;
      const common = { class: cls, 'data-vox-entity': o.entity, 'data-overlay': o.id, 'data-shape': o.shape, 'data-provenance': o.provenance, 'data-evidence': o.evidence };
      const p = o.points;
      let shape = null;
      if (o.shape === 'box' && p.length === 4) shape = svg('rect', { ...common, x: p[0], y: p[1], width: Math.max(0, p[2] - p[0]), height: Math.max(0, p[3] - p[1]) });
      else if (o.shape === 'polygon' && p.length >= 6) { const pairs = []; for (let i = 0; i + 1 < p.length; i += 2) pairs.push(`${p[i]},${p[i + 1]}`); shape = svg('polygon', { ...common, points: pairs.join(' ') }); }
      else if (o.shape === 'point' && p.length >= 2) {
        const r = big / 90;
        const l = big / 36;
        shape = svg('g', common, svg('circle', { cx: p[0], cy: p[1], r }), svg('line', { x1: p[0] - l, y1: p[1], x2: p[0] + l, y2: p[1] }), svg('line', { x1: p[0], y1: p[1] - l, x2: p[0], y2: p[1] + l }));
      }
      if (!shape) continue;
      shape.append(svg('title', null, `${o.label} · provenance ${o.provenance} · evidence ${o.evidence}`));
      kids.push(shape);
    }
    put(over, ...kids);
  }

  // R7 (H152; the R6 review's defect 16: at 1376x768 the image was drawn at 48% and the labels drawn over it covered the image's
  // own red words): each mark's label is on a band outside the image, below it or beside it, whichever leaves the image the
  // larger, at the page's own type size (11 px or more, B9), and tied to its mark by a leader line from the label's edge to
  // the mark's nearest edge (and by its selection: a label pressed selects its entity, which turns both amber). Its words are
  // the ones the labels had: `<what> · <provenance> · <evidence>`, never shortened (the band wraps them).
  function drawLabels(list, marks) {
    const h = S.ctx.h;
    put(list, marks.map((o) => h('li', { class: 'vox-label-row' },
      h('button', { type: 'button', class: `vox-label${isOn(o) ? ' is-selected' : ''}`, 'data-label-for': o.id, 'data-vox-entity': o.entity, 'data-shape': o.shape,
        title: `${o.label} · provenance ${o.provenance} · evidence ${o.evidence}` },
      h('span', { class: 'vox-label-what' }, o.label), ' ', h('span', { class: 'vox-label-tags' }, `· ${o.provenance} · ${o.evidence}`)))));
  }

  /** a mark's bounds in the image's pixels: [x0, y0, x1, y1] (a point's are the point) */
  function boundsOf(o) {
    const p = o.points;
    if (o.shape === 'box' && p.length === 4) return [Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.max(p[0], p[2]), Math.max(p[1], p[3])];
    if (o.shape === 'point' && p.length >= 2) return [p[0], p[1], p[0], p[1]];
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);
    return xs.length && ys.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
  }

  const BAND_GAP = 8;
  /**
   * Sizes the image's frame at the image's own aspect, as large as the stage allows beside its label band: the band below the
   * image (as wide as the stage, as tall as its labels) or beside it (as wide as its longest label, at most 40% of the stage),
   * whichever leaves the image the larger. Then the leader lines.
   */
  function layoutStage(stage, im, marks) {
    const box = stage.querySelector('.vox-frame');
    const list = stage.querySelector('.vox-labels');
    const img = stage.querySelector('.vox-img');
    if (!box || !list || !img || !(img.naturalWidth > 0)) return;
    const W = (im.frame && im.frame[0]) || img.naturalWidth;
    const H = (im.frame && im.frame[1]) || img.naturalHeight;
    const cs = getComputedStyle(stage);
    const sw = stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const sh = stage.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (!(sw > 0 && sh > 0 && W > 0 && H > 0)) return;
    let best = { band: 'none', scale: Math.min(sw / W, sh / H), bw: 0 };
    if (marks.length) {
      box.style.width = '0px';
      box.style.height = '0px';
      // below: the band as wide as the stage
      stage.dataset.band = 'below';
      list.style.width = '';
      const bh = Math.min(list.scrollHeight, sh * 0.45);
      const below = { band: 'below', scale: Math.min(sw / W, (sh - bh - BAND_GAP) / H), bw: 0 };
      // beside: as wide as the longest label on one line, at most 40% of the stage (its labels wrap there)
      list.classList.add('is-measuring');
      const longest = Math.max(0, ...[...list.querySelectorAll('.vox-label')].map((b) => b.scrollWidth));
      list.classList.remove('is-measuring');
      const bw = Math.round(Math.min(Math.max(longest + 2, 150), sw * 0.4));
      stage.dataset.band = 'right';
      list.style.width = `${bw}px`;
      const right = { band: 'right', scale: list.scrollHeight <= sh ? Math.min((sw - bw - BAND_GAP) / W, sh / H) : 0, bw };
      best = right.scale > below.scale * 1.02 ? right : below;
    }
    stage.dataset.band = best.band;
    list.style.width = best.band === 'right' ? `${best.bw}px` : '';
    const s = Math.max(0, best.scale);
    box.style.width = `${Math.floor(W * s)}px`;
    box.style.height = `${Math.floor(H * s)}px`;
    box.dataset.scale = String(Math.round(s * 1000) / 1000);
    drawLeaders(stage, im, marks);
  }

  /** The leader lines: from each label the band shows to its mark's nearest edge, in the stage's own pixels. */
  function drawLeaders(stage, im, marks) {
    const lead = stage.querySelector('.vox-leaders');
    const box = stage.querySelector('.vox-frame');
    const list = stage.querySelector('.vox-labels');
    const img = stage.querySelector('.vox-img');
    if (!lead || !box || !list || !img) return;
    // in the leaders' own pixels: the SVG covers the stage's padding box
    const sr = lead.getBoundingClientRect();
    const fr = box.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    const W = (im.frame && im.frame[0]) || img.naturalWidth || 1;
    const H = (im.frame && im.frame[1]) || img.naturalHeight || 1;
    const s = fr.width / W;
    lead.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(sr.width))} ${Math.max(1, Math.round(sr.height))}`);
    const clamp = (v, a, b) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
    const X = (x) => fr.left - sr.left + clamp(x, 0, W) * s;
    const Y = (y) => fr.top - sr.top + clamp(y, 0, H) * s;
    const right = stage.dataset.band === 'right';
    const kids = [];
    if (s > 0 && stage.dataset.band !== 'none') {
      for (const o of marks) {
        const b = list.querySelector(`.vox-label[data-label-for="${CSS.escape(o.id)}"]`);
        if (!b) continue;
        const r = b.getBoundingClientRect();
        // a label scrolled out of the band's view has no line until it is shown
        if (r.bottom < lr.top + 2 || r.top > lr.bottom - 2 || r.right < lr.left + 2 || r.left > lr.right - 2) continue;
        const [x0, y0, x1, y1] = boundsOf(o);
        let ax; let ay; let lx; let ly;
        if (right) {
          ax = X(x1);
          ay = clamp((r.top + r.bottom) / 2 - sr.top, Y(y0), Y(y1));
          lx = r.left - sr.left;
          ly = clamp(ay, r.top - sr.top + 4, r.bottom - sr.top - 4);
        } else {
          ax = clamp((r.left + r.right) / 2 - sr.left, X(x0), X(x1));
          ay = Y(y1);
          lx = clamp(ax, r.left - sr.left + 6, r.right - sr.left - 6);
          ly = r.top - sr.top;
        }
        const sel = isOn(o) ? ' is-selected' : '';
        kids.push(svg('line', { class: `vox-leader${sel}`, x1: ax.toFixed(1), y1: ay.toFixed(1), x2: lx.toFixed(1), y2: ly.toFixed(1), 'data-label-for': o.id }),
          svg('circle', { class: `vox-leader-end${sel}`, cx: ax.toFixed(1), cy: ay.toFixed(1), r: 2.5, 'data-label-for': o.id }));
      }
    }
    put(lead, ...kids);
  }

  function drawSpatial(el, cap, title) {
    const h = S.ctx.h;
    const p = S.preview;
    if (title) title.textContent = `Viewport · ${p.id} · mesh views`;
    const blocks = p.spatial.map((s) => {
      if (!s.views) return h('div', { class: 'vox-mesh', 'data-vox-mesh': s.source }, h('p', { class: 'vox-mesh-what' }, s.what), h('p', { class: 'empty' }, `Not drawn: ${s.why || s.words}`));
      const views = s.views.map((v) => {
        const pad = Math.round(Math.max(v.size[0], v.size[1]) / 9);
        const [w, hh] = v.size;
        const pathOk = PATH_DATA.test(v.d);
        const fig = svg('svg', { class: 'vox-proj-svg', viewBox: `${-pad} ${-pad} ${w + 2 * pad} ${hh + 2 * pad}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': `${v.name} view of ${s.source}`, 'data-view': v.name },
          svg('rect', { class: 'vox-proj-frame', x: 0, y: 0, width: w, height: hh }),
          pathOk ? svg('path', { class: 'vox-proj-lines', d: v.d }) : null,
          svg('text', { class: 'vox-proj-axis', x: w, y: hh + pad * 0.9, 'text-anchor': 'end', 'font-size': Math.round(Math.max(w, hh) / 16) }, `${v.axes[0]} →`),
          svg('text', { class: 'vox-proj-axis', x: 0, y: -pad * 0.25, 'font-size': Math.round(Math.max(w, hh) / 16) }, `↑ ${v.axes[1]}`));
        return h('figure', { class: 'vox-proj', 'data-view': v.name, 'data-lines': String(v.drawn) },
          fig, h('figcaption', null, `${v.name} · ${v.from}${v.drawn < v.total ? ` · ${v.drawn} of ${v.total} lines` : ''}`));
      });
      return h('div', { class: 'vox-mesh', 'data-vox-mesh': s.source },
        h('p', { class: 'vox-mesh-what' }, s.what),
        h('div', { class: 'vox-views' }, views),
        h('p', { class: 'vox-mesh-words' }, `${s.words} · in ${s.unit} · provenance ${s.provenance} · evidence ${s.evidence}`));
    });
    put(el, h('div', { class: 'vox-spatial' }, blocks));
    if (cap) put(cap, h('span', null, (p.spatial[0] && p.spatial[0].method) || 'a mesh drawn from its own triangles'), p.doctrine ? h('span', { class: 'vox-doctrine' }, ` · ${p.doctrine}`) : null);
    // R7 (H152, B9): each view's axis words at LABEL_PX or more on screen, at the scale the view is drawn (laid out first)
    requestAnimationFrame(() => {
      for (const fig of el.querySelectorAll('.vox-proj-svg')) {
        const m = fig.getScreenCTM && fig.getScreenCTM();
        const scale = m ? Math.hypot(m.a, m.b) : 0;
        if (!(scale > 0)) continue;
        for (const t of fig.querySelectorAll('.vox-proj-axis')) {
          const now = Number(t.getAttribute('font-size')) || 0;
          if (now * scale < LABEL_PX) t.setAttribute('font-size', String(Math.ceil((LABEL_PX / scale) * 100) / 100));
        }
      }
    });
  }

  function drawRecording(el, cap, title) {
    const h = S.ctx.h;
    const p = S.preview;
    if (title) title.textContent = `Viewport · ${p.id} · recording`;
    put(el, h('div', { class: 'vox-recordings' }, p.recordings.map((r) => {
      const f = r.facts;
      const row = (k, v) => h('div', { class: 'vox-fact' }, h('dt', null, k), h('dd', null, v));
      return h('dl', { class: 'vox-recording', 'data-vox-recording': r.path },
        row('file', r.path),
        ...(f ? [
          row('written by', `${f.writer} (its header)`), row('encoding', `${f.compression} compression, ${f.serializer} messages`),
          row('messages', `${f.messages.chunks} data chunks · ${f.messages.storeInfo} store infos · ${f.messages.blueprint} blueprint activations${f.messages.other ? ` · ${f.messages.other} other` : ''}${f.ended ? '' : ' · no end marker read'}${f.footer ? ' · a footer' : ''}`),
          row('stores', f.stores.map((s) => `${s.kind}${s.application ? ` · ${s.application}` : ''}${s.recording ? ` · ${s.recording}` : ''}`).join('; ') || 'none named'),
          row('entities', `unknown to Timmy: ${f.unknown.entities}`), row('frames', `unknown to Timmy: ${f.unknown.frames}`), row('time range', `unknown to Timmy: ${f.unknown.timeRange}`),
          ...(f.stopped ? [row('read', `stopped: ${f.stopped}`)] : []),
        ] : [row('read', `not read: ${r.why || 'not read'}`)]),
        row('Rerun\'s viewer', `${r.viewer.state} · ${r.viewer.words}`));
    })));
    if (cap) cap.textContent = 'Read by Timmy from the file\'s own bytes (its header and message frames); Rerun\'s viewer shows the rest.';
  }

  // ── the timeline: a video's sampled frames ──
  function drawTimeline() {
    const h = S.ctx.h;
    const el = q('timeline');
    const boxEl = S.root.querySelector('[data-vox-box="timeline"]');
    if (!el) return;
    const p = S.preview;
    if (boxEl) { boxEl.dataset.frames = String(p.frames.length); boxEl.hidden = p.frames.length < 2; }
    if (p.frames.length < 2) {
      put(el, h('p', { class: 'empty', 'data-vox-empty': 'timeline' }, p.frames.length === 1 ? `One sampled frame (${p.frames[0].label}): a timeline needs two or more.` : 'No timeline: this record has no sampled frames (a video\'s /detect … --at t1,t2 samples them).'));
      return;
    }
    const tt = q('timeline-title');
    if (tt) tt.textContent = `Timeline · source time · ${p.frames.length} sampled frames`;
    const times = p.frames.map((f) => f.time).filter((t) => typeof t === 'number');
    const t0 = times.length ? Math.min(...times) : 0;
    const t1 = times.length ? Math.max(...times) : 1;
    put(el, 
      h('ol', { class: 'vox-timeline', 'aria-label': `${p.frames.length} sampled frames` }, p.frames.map((f) => h('li', { class: 'vox-tick-at', 'data-at': t1 > t0 && typeof f.time === 'number' ? String(Math.round(((f.time - t0) / (t1 - t0)) * 100)) : '' },
        h('button', { type: 'button', class: 'vox-tick', 'data-vox-frame': String(f.index), 'aria-current': f.index === S.frame ? 'true' : 'false', title: `${f.label}: ${f.overlays.length} drawn` }, f.label)))),
      h('p', { class: 'vox-timeline-note' }, `source time, ${typeof t0 === 'number' ? `${Number(t0.toPrecision(6))}` : '?'} s to ${Number(t1.toPrecision(6))} s · a frame with no measured region has nothing drawn (absent is not zero)`));
  }

  // ── the commands for this record ──
  function drawActions() {
    const h = S.ctx.h;
    const el = q('actions');
    if (!el) return;
    const p = S.preview;
    const primary = p.actions.find((a) => a.primary);
    put(el, 
      ...p.actions.map((a) => h('button', {
        type: 'button', class: `cmd vox-act${a.primary ? ' is-next' : ''}`, 'data-copy': a.enabled ? a.command : null, 'aria-disabled': a.enabled ? 'false' : 'true',
        'data-vox-action': a.label, title: a.enabled ? `Copies ${a.command} for Timmy's terminal: ${a.effect}` : `Not now: ${a.why || 'not available'}`,
      }, h('span', { class: 'vox-act-label' }, a.label), ' ', h('span', { class: 'vox-act-cmd' }, a.command))),
      primary ? h('p', { class: 'vox-act-why', 'data-vox': 'next' }, `next: ${primary.effect}`) : null,
      ...p.actions.filter((a) => !a.enabled).map((a) => h('p', { class: 'vox-act-why' }, `${a.label}: not now: ${a.why}`)),
      // R7 (H152): said in the box, not in its title (a title the narrow column cuts with "…")
      h('p', { class: 'vox-act-why', 'data-vox': 'acts-how' }, 'A press copies one for Timmy\'s terminal; nothing runs from this page.'));
    const t = q('actions-title');
    if (t) t.textContent = 'Commands for this record';
  }

  // ── the right column ──
  /**
   * R11 round 7: the honest evidence rows, each read from the record (the preview's data: inputs, values with their words,
   * the model's claims, the checks, the receipt, the failures), each "Unknown" with why when the record holds none. The six
   * quantities are kept apart: an observed fact is not a candidate, a model's score is not a probability, a tolerance is
   * not a price. Nothing here is computed from a model; nothing is a percentage the page made up.
   */
  function evidenceRows(p) {
    const measured = p.values.filter((v) => !v.claim && v.provenance === 'measured');
    const claims = p.values.filter((v) => v.claim);
    const predictions = [];
    const walk = (list) => { for (const e of list || []) { if (/^\/observations\/roboflow\//.test(e.path)) predictions.push(e); walk(e.children); } };
    walk(p.entities);
    const scored = predictions.map((e) => { const m = /^(.*?)\s+(\d+(?:\.\d+)?)$/.exec(e.label); return m ? { what: m[1], score: m[2] } : null; }).filter(Boolean);
    const inputs = p.inputs.map((i) => `${i.role ? `${i.role}: ` : ''}${i.path} (${i.kindWords}${typeof i.bytes === 'number' ? `, ${i.bytes} B` : ''}${i.sha256 ? `, sha256 ${i.sha256.slice(0, 12)}` : ''}${i.matches === false ? ', changed since' : i.matches === true ? ', bytes as recorded' : ''})`);
    const tolerance = p.checks.length ? p.checks.map((c) => `${c.agrees ? '✓' : '✕'} ${c.words}`).join(' · ') : (measured.find((v) => v.method) ? `method only: ${measured.filter((v) => v.method).map((v) => `${v.title} by ${v.method}`).join('; ')} — no tolerance recorded` : '');
    const r = p.receipt;
    const rows = {
      observed: inputs.length || measured.length ? { known: true, words: `${inputs.join('; ') || 'no input named'}${measured.length ? ` · ${measured.length} measured value${measured.length === 1 ? '' : 's'} (${measured.map((v) => v.title).join(', ')})` : ' · no measured value'}` } : { known: false, words: 'Unknown — the record names no input and holds no measured value.' },
      candidates: predictions.length ? { known: true, words: `${predictions.length} candidate${predictions.length === 1 ? '' : 's'} from a model (Roboflow): ${[...new Set(scored.map((x) => x.what))].join(', ') || predictions.map((e) => e.label).join(', ')} — a candidate is a model’s suggestion, not an identification.` } : (claims.length ? { known: true, words: `${claims.length} model claim${claims.length === 1 ? '' : 's'}: ${claims.map((v) => v.title).join(', ')} — claims, not identifications.` } : { known: false, words: 'Unknown — no model returned a candidate for this record.' }),
      scores: scored.length ? { known: true, words: `${scored.map((x) => `${x.what} ${x.score}`).join(', ')} — a model’s score, not a probability and not a measurement.` } : { known: false, words: 'Unknown — no model score is recorded.' },
      calibrated: { known: false, words: 'Unknown — no calibration is recorded for a model on this record; a score is never shown as a probability.' },
      tolerances: tolerance ? { known: p.checks.length > 0, words: tolerance } : { known: false, words: 'Unknown — no tolerance is recorded with these values.' },
      price: { known: false, words: 'Unknown — VoxVision records no price; a price needs a market source and carries its own uncertainty.' },
      receipt: r.verified ? { known: true, words: `✓ sealed and verified · receipt ${r.short}. A seal proves the record’s integrity and authorship; it does not prove a model’s conclusion is correct.` } : { known: false, words: `${r.short ? `receipt ${r.short} · not verified` : 'not sealed'}${p.check.reasons.length ? `: ${p.check.reasons.join('; ')}` : ''}. A valid receipt would prove integrity and authorship, not a conclusion.` },
      admitted: { known: false, words: `${claims.length ? `${claims.length} model-authored value${claims.length === 1 ? '' : 's'} on this record, none admitted` : 'No model-authored value admitted'}: the record carries no observed-handle set of this run and no cite(handle_id) call, so a model value here is a claim (model prediction), shown as one — never evidence.${p.failures.length ? ` Raw output and refusals kept: ${p.failures.map((f) => `${f.tool} ${f.code}: ${f.message}`).join('; ')}.` : ''}` },
    };
    return EVIDENCE_ROWS.map(([key, name]) => ({ key, name, ...rows[key] }));
  }
  function drawEvidence() {
    const h = S.ctx.h;
    const el = q('evidence');
    if (!el) return;
    const p = S.preview;
    const rows = evidenceRows(p);
    put(el,
      h('p', { class: 'vox-ev-lead' }, 'Each quantity on its own row, read from the record; Unknown where the record holds none.'),
      h('dl', { class: 'vox-ev', 'aria-label': `Evidence of record ${p.id}` }, rows.map((r) => h('div', { class: `vox-ev-row${r.known ? '' : ' is-unknown'}${r.key === 'receipt' && r.known ? ' is-verified' : ''}`, 'data-vox-ev': r.key, 'data-known': r.known ? 'true' : 'false' },
        h('dt', null, r.name), h('dd', null, r.known ? r.words : h('span', null, h('span', { class: 'vox-ev-unknown' }, 'Unknown'), r.words.replace(/^Unknown/, '')))))),
      p.doctrine ? h('p', { class: 'vox-doctrine' }, p.doctrine) : null);
    const t = q('evidence-title');
    if (t) t.textContent = `Evidence · read from record ${p.id}`;
  }

  function drawPipeline() {
    const h = S.ctx.h;
    const el = q('pipeline');
    if (!el) return;
    const p = S.preview;
    const steps = p.pipeline.steps.map((s, i) => [
      i ? h('span', { class: 'vox-arrow', 'aria-hidden': 'true' }, '→') : null,
      h('span', { class: `vox-step tone-${s.tone}${s.tone === 'verified' ? ' is-verified' : ''}`, 'data-step': s.name, 'data-state': s.state, title: s.words }, s.tone === 'verified' ? '✓ ' : s.tone === 'failed' ? '✕ ' : '', `${s.name} · ${s.state}`),
    ]);
    const r = p.receipt;
    put(el,
      h('div', { class: 'vox-steps', 'data-vox': 'steps' }, steps.flat()),
      h('div', { class: `vox-receipt${r.verified ? ' is-verified' : ''}`, 'data-vox': 'receipt', 'data-verified': r.verified ? 'true' : 'false' },
        h('p', { class: `vox-receipt-mark${r.verified ? ' is-verified' : ''}` }, r.verified ? `✓ sealed and verified · receipt ${r.short}` : r.short ? `receipt ${r.short} · not verified` : 'not sealed'),
        h('p', { class: 'vox-receipt-words' }, r.words, r.at ? ` · sealed ${clock(r.at)}` : ''),
        p.check.status === 'stale' ? h('p', { class: 'tone-attention', 'data-vox': 'stale' }, `stale: ${p.check.reasons.join('; ')}`) : null,
        p.check.status === 'unverified' && p.check.reasons.length ? h('p', { class: 'tone-attention' }, `✕ not verified: ${p.check.reasons.join('; ')}`) : null),
      h('p', { class: 'vox-verdict', 'data-vox': 'verdict' }, p.verdict),
      h('p', { class: 'vox-absent', 'data-vox': 'absent' }, 'Not on this computer: ', p.pipeline.absent.map((e, i) => h('span', { class: `vox-absent-item tone-${e.tone}`, 'data-engine': e.name, title: e.words }, `${i ? ' · ' : ''}${e.name} ${e.state}`))),
      ...p.pipeline.steps.filter((s) => s.setup).map((s) => h('p', { class: 'vox-setup' }, `${s.name} needs setup: `, h('button', { type: 'button', class: 'cmd', 'data-copy': s.setup }, s.setup))),
      ...p.checks.map((c) => h('p', { class: `vox-check${c.agrees ? ' is-verified' : ' tone-attention'}` }, c.agrees ? `✓ passed: ${c.words}` : c.words)),
      p.together ? h('p', { class: 'vox-together' }, p.together.words) : null,
      ...p.failures.filter((f) => f.code !== 'needs-setup').map((f) => h('p', { class: 'tone-attention' }, `✕ ${f.tool} ${f.code}: ${f.message}`)));
  }

  function drawValues() {
    const h = S.ctx.h;
    const el = q('values');
    if (!el) return;
    const p = S.preview;
    if (!p.values.length) { put(el, h('p', { class: 'empty' }, 'No value: no tool gave one (what failed or needs setup is under the pipeline).')); return; }
    const sel = findEntity(p.entities, S.entity);
    put(el, h('ul', { class: 'vox-vals', 'aria-label': `${p.values.length} values of record ${p.id}` }, p.values.map((v) => h('li', { class: `vox-val${v.claim ? ' is-claim' : ''}`, 'data-value': v.name, 'aria-current': sel && sel.value === v.name ? 'true' : 'false', title: [v.method, v.measured_by].filter(Boolean).join(' · ') || null },
        h('span', { class: 'vox-val-title' }, `${v.of ? `${v.of === 'delta' ? 'Δ' : v.of} ` : ''}${v.title}`),
        h('span', { class: 'vox-val-text' }, v.text),
        h('span', { class: 'vox-val-tags' }, h('span', { class: `vox-word w-${v.word.replace(/\s+/g, '-')}` }, v.word), ` provenance ${v.provenance} · evidence ${v.evidence}`, v.note && v.word !== 'measured' ? ` · ${v.note}` : ''),
        null))),
    p.notes.length ? h('details', { class: 'vox-notes' }, h('summary', null, `the record's notes (${p.notes.length})`), h('ul', null, p.notes.map((n) => h('li', null, n)))) : null,
    p.doctrine ? h('p', { class: 'vox-doctrine' }, p.doctrine) : null);
  }

  function drawEngines() {
    const h = S.ctx.h;
    const el = q('engines');
    if (!el) return;
    const p = S.preview;
    put(el, h('ul', { class: 'vox-engines' }, p.engines.map((e) => h('li', { class: `vox-engine tone-${e.tone}`, 'data-engine': e.name, 'data-state': e.state, title: e.words },
      h('span', { class: 'vox-engine-line' }, h('span', { class: 'vox-engine-name' }, e.name), ' · ', h('span', { class: 'vox-engine-state' }, e.state)),
      e.setup && e.tone === 'setup' ? h('button', { type: 'button', class: 'cmd', 'data-copy': e.setup, title: 'Copies the step for a terminal' }, e.setup) : null))),
    h('p', { class: 'empty' }, 'Found is not working: a tool runs only when an action uses it, and its record says whether it ran.'));
  }

  // ── selection ──
  function selectEntity(id) {
    const p = S.preview;
    if (!p) return;
    S.entity = S.entity === id ? '' : id;
    const e = findEntity(p.entities, S.entity);
    if (e && e.image && e.image !== S.image) {
      S.image = e.image;
      S.frame = p.frames.findIndex((f) => f.image === S.image);
      drawStageTabs(); drawStage(); drawTimeline();
    } else redrawSelection();
    for (const b of S.root.querySelectorAll('.vox-ent')) b.setAttribute('aria-current', b.dataset.voxEntity === S.entity ? 'true' : 'false');
    for (const r of S.root.querySelectorAll('.vox-val[data-value]')) r.setAttribute('aria-current', e && e.value === r.dataset.value ? 'true' : 'false');
  }
  function redrawSelection() {
    const p = S.preview;
    const stage = q('stage');
    const over = S.root.querySelector('.vox-overlay');
    const img = S.root.querySelector('.vox-img');
    const list = S.root.querySelector('.vox-labels');
    const im = p.images.find((x) => x.key === S.image);
    if (!stage || !over || !img || !list || !im || !img.complete || !(img.naturalWidth > 0)) return;
    const marks = p.overlays.filter((o) => o.image === im.key);
    drawOverlays(over, im, marks, img);
    drawLabels(list, marks);
    layoutStage(stage, im, marks);
  }
  function selectImage(key) {
    if (!S.preview) return;
    S.image = key;
    S.frame = S.preview.frames.findIndex((f) => f.image === key);
    drawStageTabs(); drawStage(); drawTimeline();
  }
  function selectFrame(i) {
    const p = S.preview;
    if (!p || !p.frames[i]) return;
    S.frame = i;
    S.image = p.frames[i].image;
    drawStageTabs(); drawStage(); drawTimeline();
    const b = S.root.querySelector(`[data-vox-frame="${i}"]`);
    if (b) b.focus({ preventScroll: true });
  }

  function onClick(event) {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) return;
    const rec = t.closest('[data-vox-record]');
    if (rec) { const id = rec.dataset.voxRecord; if (id !== S.sel) { S.sel = id; S.previewSig = ''; S.entity = ''; markList(); loadPreview(id); } return; }
    const ent = t.closest('[data-vox-entity]');
    if (ent) { selectEntity(ent.dataset.voxEntity || ent.getAttribute('data-vox-entity')); return; }
    const im = t.closest('[data-vox-image]');
    if (im) { selectImage(im.dataset.voxImage); return; }
    const fr = t.closest('[data-vox-frame]');
    if (fr) { selectFrame(Number(fr.dataset.voxFrame)); }
  }
  function onKey(event) {
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !S.preview) return;
    if (t.matches('[data-vox-frame]') && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      const n = S.preview.frames.length;
      selectFrame((Number(t.dataset.voxFrame) + (event.key === 'ArrowRight' ? 1 : n - 1)) % n);
    }
  }

  TimmyPanels.register('voxvision', {
    draw(host, frame, ctx) {
      S.ctx = ctx;
      S.host = host;
      if (!ctx.own) {
        S.root = null;
        put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its VoxVision records are not read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        reset(ctx.project);
        S.root = skeleton(ctx.h);
        put(host, S.root);
        registerPage();
      }
      const now = Date.now();
      const rev = frame && frame.revision;
      if (S.list && now - S.listAt < LIST_EVERY_MS) return undefined;
      if (S.list && rev === S.revision && now - S.listAt < LIST_AT_LEAST_MS) return undefined;
      S.revision = rev;
      return refreshList();
    },
  });

  // R6 lead: another part of the page opens one of the shown project's records here (Home's newest images: "Open in
  // VoxVision"): the record named is chosen now when the list already holds it, else when the list is next read.
  document.addEventListener('timmy:vox-show', (e) => {
    const id = e && e.detail && typeof e.detail.id === 'string' && /^v[0-9a-f]{8}$/.test(e.detail.id) ? e.detail.id : '';
    if (!id) return;
    S.wanted = id;
    const row = S.root && S.list ? S.list.records.find((r) => r.id === id) : null;
    if (row && S.sel !== id) {
      S.sel = id;
      S.previewSig = JSON.stringify([row.status, row.check, row.receipt.short || '', row.receipt.verified, row.counts]);
      markList();
      void loadPreview(id);
    } else if (!row) S.sel = '';
  });
})();
