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
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;

  const SVG = 'http://www.w3.org/2000/svg';
  const PATH_DATA = /^(?:M-?\d+ -?\d+L-?\d+ -?\d+)*$/;
  const LIST_EVERY_MS = 2000;
  const LIST_AT_LEAST_MS = 10000;
  const CACHE_MAX = 24;
  // R6 lead: the smallest a label over the image is drawn on screen, in CSS pixels
  const LABEL_PX = 11;
  // the record an address names (…?vox=<id> or …#t=…&vox=<id>, as the Workbench's c can give it: src/workbench/voxvision-tab.ts
  // voxCompanionHint), read as this script loads, before the page takes the fragment out of the address
  const HINT = (() => { try { const m = /[?#&]vox=(v[0-9a-f]{8})(?:[&#]|$)/.exec(`${location.search}${location.hash}`); return m ? m[1] : ''; } catch (e) { return ''; } })();

  const S = {
    project: null, root: null, ctx: null, revision: null, listAt: 0, listSig: '', list: null, asking: null,
    sel: '', preview: null, previewSig: '', image: '', entity: '', frame: -1, imageAsk: 0, urls: new Map(), wanted: null,
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
    if (S.wanted === null) S.wanted = HINT;
  }

  // ── the skeleton: three columns of boxes ──
  function skeleton(h) {
    const box = (title, name, o = {}) => h('section', { class: `box${o.fit ? ' box-fit' : ''}${o.cls ? ` ${o.cls}` : ''}`, 'data-vox-box': name },
      h('h2', { class: 'box-title', 'data-vox': `${name}-title` }, title), h('div', { class: `box-body${o.body ? ` ${o.body}` : ''}`, 'data-vox': name }, h('p', { class: 'empty' }, 'Reading…')));
    const root = h('div', { class: 'vox-cols', 'data-vox': 'root' },
      h('div', { class: 'col-stack vox-left' },
        box('Records · results/vox', 'records', { fit: true, cls: 'vox-records-box' }),
        box('Entity tree', 'tree', { cls: 'vox-tree-box' })),
      h('div', { class: 'col-stack vox-centre' },
        h('section', { class: 'box vox-view-box', 'data-vox-box': 'view' },
          h('h2', { class: 'box-title', 'data-vox': 'view-title' }, 'Viewport'),
          h('div', { class: 'box-body vox-view-body' },
            h('div', { class: 'vox-fake', 'data-vox': 'fake', hidden: true }),
            h('div', { class: 'vox-image-tabs', 'data-vox': 'image-tabs', role: 'group', 'aria-label': 'The record\'s images' }),
            h('div', { class: 'vox-stage', 'data-vox': 'stage' }, h('p', { class: 'empty' }, 'Reading…')),
            h('p', { class: 'vox-caption', 'data-vox': 'caption' }))),
        box('Timeline', 'timeline', { fit: true, cls: 'vox-timeline-box' }),
        box('Commands for this record', 'actions', { fit: true, cls: 'vox-acts-box', body: 'vox-acts' })),
      h('div', { class: 'col-stack vox-right' },
        box('Pipeline · receipt', 'pipeline', { fit: true, cls: 'vox-pipeline-box' }),
        box('Values', 'values', { cls: 'vox-values-box' }),
        box('Engines on this computer', 'engines', { fit: true, cls: 'vox-engines-box' })));
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
      if (sig !== S.listSig || first) { S.listSig = sig; drawList(); markMore(); }
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
    const say = (name, words) => put(q(name), h('p', { class: 'empty' }, words));
    say('tree', 'No record to show yet: its inputs, what was observed and its values appear here.');
    say('stage', 'No record to show yet. A VoxVision record\'s image and what was measured over it are drawn here.');
    say('pipeline', 'No record yet: .intent → its tools → .receipt, as it ran, appear here.');
    say('values', 'No record yet.');
    say('engines', 'Read with a record.');
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
    drawPipeline();
    drawValues();
    drawEngines();
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
    put(el, img, over);
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
        // R6 lead: drawn again when the stage's size changes (a window resized, the tab shown after it was drawn hidden),
        // so the labels keep their size on screen
        if (typeof ResizeObserver === 'function') {
          let seen = Math.round(over.getBoundingClientRect().width);
          new ResizeObserver(() => {
            const w = Math.round(over.getBoundingClientRect().width);
            if (w > 0 && w !== seen && ask === S.imageAsk && over.isConnected) { seen = w; redrawSelection(); }
          }).observe(over);
        }
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

  function drawOverlays(over, im, list, img) {
    const W = (im.frame && im.frame[0]) || img.naturalWidth || 1;
    const H = (im.frame && im.frame[1]) || img.naturalHeight || 1;
    over.setAttribute('viewBox', `0 0 ${W} ${H}`);
    over.dataset.frame = `${W}x${H}`;
    const big = Math.max(W, H);
    const font = Math.max(8, Math.round(big / 42));
    // R6 lead (the lead's capture at 1376x768, 12:40 PT): a label is read on screen. The overlay draws in the image's own
    // pixels and the stage shows the image scaled (the review demo's 640 px image at about 267 px), so 1/42 of the image came
    // out near 6 px. Each label is now at least LABEL_PX on screen (the overlay's scale, as preserveAspectRatio meet draws it),
    // in two lines, what it is, then its provenance and evidence, each inside the image's frame; a line the frame cannot hold
    // at that size is shortened with "…" (its whole words stay in its title, the tree and the values).
    const box = over.getBoundingClientRect();
    const scale = box.width > 0 && box.height > 0 ? Math.min(box.width / W, box.height / H) : 0;
    const least = scale > 0 ? LABEL_PX / scale : 0;
    const sel = S.entity;
    const kids = [];
    for (const o of list) {
      const on = sel && (o.entity === sel || (findEntity(S.preview.entities, sel) || {}).overlays?.includes(o.id));
      const cls = `ov ov-${o.shape}${on ? ' is-selected' : ''}${o.provenance === 'generated' ? ' is-generated' : ''}${o.evidence === 'unverified' || o.evidence === 'stale' ? ' is-unverified' : ''}`;
      const common = { class: cls, 'data-vox-entity': o.entity, 'data-overlay': o.id, 'data-shape': o.shape, 'data-provenance': o.provenance, 'data-evidence': o.evidence };
      const p = o.points;
      let shape = null;
      let at = [0, 0];
      if (o.shape === 'box' && p.length === 4) { shape = svg('rect', { ...common, x: p[0], y: p[1], width: Math.max(0, p[2] - p[0]), height: Math.max(0, p[3] - p[1]) }); at = [p[0], p[1]]; }
      else if (o.shape === 'polygon' && p.length >= 6) { const pairs = []; for (let i = 0; i + 1 < p.length; i += 2) pairs.push(`${p[i]},${p[i + 1]}`); shape = svg('polygon', { ...common, points: pairs.join(' ') }); at = [Math.min(...p.filter((_, i) => i % 2 === 0)), Math.min(...p.filter((_, i) => i % 2 === 1))]; }
      else if (o.shape === 'point' && p.length >= 2) {
        const r = big / 90;
        const l = big / 36;
        shape = svg('g', common, svg('circle', { cx: p[0], cy: p[1], r }), svg('line', { x1: p[0] - l, y1: p[1], x2: p[0] + l, y2: p[1] }), svg('line', { x1: p[0], y1: p[1] - l, x2: p[0], y2: p[1] + l }));
        at = [p[0] + l * 0.6, p[1] + l + font];
      }
      if (!shape) continue;
      shape.append(svg('title', null, `${o.label} · provenance ${o.provenance} · evidence ${o.evidence}`));
      kids.push(shape);
      // the label stays inside the image's frame: smaller when wider than the frame (never under LABEL_PX on screen), moved
      // left when it would run past its right edge (a monospace advance of 0.62 em, as Monaspace Argon's). Its text is still
      // `<label> · <provenance> · <evidence>`, in two lines.
      // (the space between the two parts ends the first line, so the second starts at the label's left edge)
      let lines = [`${o.label} `, `· ${o.provenance} · ${o.evidence}`];
      const ems = (s) => s.length * 0.62;
      let fit = Math.min(Math.max(font, least), W / Math.max(...lines.map(ems)));
      if (fit < least) {
        fit = least;
        const max = Math.max(2, Math.floor(W / (fit * 0.62)));
        lines = lines.map((s) => (s.length > max ? `${s.slice(0, max - 1)}…` : s));
      }
      const step = fit * 1.2;
      const x = Math.max(0, Math.min(at[0], W - Math.max(...lines.map(ems)) * fit));
      const below = o.shape === 'point' ? at[1] - font + fit : at[1] - fit * 0.35 - step;
      const y = Math.max(fit, Math.min(below, H - step));
      kids.push(svg('text', { class: `ov-label${on ? ' is-selected' : ''}`, x, y, 'font-size': fit, 'data-vox-entity': o.entity, 'data-label-for': o.id },
        svg('tspan', { x, y }, lines[0]), svg('tspan', { x, dy: step }, lines[1])));
    }
    put(over, ...kids);
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
      ...p.actions.filter((a) => !a.enabled).map((a) => h('p', { class: 'vox-act-why' }, `${a.label}: not now: ${a.why}`)));
    const t = q('actions-title');
    if (t) t.textContent = 'Commands for this record · a press copies one for Timmy\'s terminal; nothing runs from this page';
  }

  // ── the right column ──
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
    const over = S.root.querySelector('.vox-overlay');
    const img = S.root.querySelector('.vox-img');
    const im = p.images.find((x) => x.key === S.image);
    if (over && img && im && img.complete && img.naturalWidth > 0) drawOverlays(over, im, p.overlays.filter((o) => o.image === im.key), img);
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
      if (!ctx.own) {
        S.root = null;
        put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its VoxVision records are not read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        reset(ctx.project);
        S.root = skeleton(ctx.h);
        put(host, S.root);
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
