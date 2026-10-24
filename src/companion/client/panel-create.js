// R7 (H153): the 3D & Motion panel (tab 6; the 3D part of reference 06), drawn into data-panel-host="create" (panels.js says
// how a panel registers and what it is given). Its routes are src/companion/panels/create.ts; what they answer is made by
// src/vox/meshes.ts from the shown project's own files.
//
// Three working columns:
//   left    the project's meshes (its STL, OBJ and PLY files, and a STEP's tessellations a VoxVision record names), each with
//           its kind, its triangle count or why it was not measured; under them the Rerun recordings Timmy can read (their header facts, and what
//           stays unknown with why) and Rerun's viewer as this computer has it (found is not run: nothing here starts it).
//           R9 (H159): each recording also says what the installed Rerun CLI read of it (src/vox/rrd-cli.ts: its entities,
//           timelines and their ranges, with who read them), "being read" while it reads, or each fact unknown with why
//   centre  the view you can turn: Timmy's own drawing of the selected file's triangles on a plain canvas (orthographic, flat
//           shading by each face's normal under one fixed light, painter's order; no WebGL, no library, no model). Drag or
//           the arrow keys turn it, the wheel or + and − zoom, F, T, S and I show the front, top, side and an isometric view,
//           R resets. The mesh is content: neutral greys, never amber or green. Above the cap it draws an even pick of the
//           triangles and says "showing N of M"; the measurements are always of the whole file.
//   right   what Timmy's own reader of its kind (STL, OBJ or PLY: src/native/*-readback.ts) measured from the whole file:
//           triangles, corners, box, area, volume, topology, an OBJ's or PLY's faces and what its reader ignored, the file's
//           own words, where it came from, and DOCTRINE §15's sentence
//
// The view draws the bytes the list measured: it asks for them by their sha256, and a file changed since is read again.
// Every number drawn is the list's; nothing here invents a value.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;

  const LIST_EVERY_MS = 2000;
  const LIST_AT_LEAST_MS = 10000;
  const STEP_DEG = 15;
  const DRAG_DEG_PER_PX = 0.5;
  const ZOOM_STEP = 1.25;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 16;
  const SHADES = 64;
  // the named views, with the axes src/vox/projection.ts gives front, top and side (the file's own x, y and z)
  const VIEWS = {
    front: { yaw: 0, pitch: 0, name: 'front', words: 'seen from −y: x to the right, z up' },
    top: { yaw: 0, pitch: 90, name: 'top', words: 'seen from +z: x to the right, y up' },
    side: { yaw: 90, pitch: 0, name: 'side', words: 'seen from +x: y to the right, z up' },
    iso: { yaw: 45, pitch: 35.26, name: 'isometric', words: 'seen from +x, −y and +z at equal angles' },
  };
  const FIRST = 'iso';
  // R8 (H154): each kind of mesh file in its word
  const KIND = { stl: 'STL', obj: 'OBJ', ply: 'PLY' };
  const readerName = (m) => (m && m.reader && m.reader.name) || "Timmy's own reader";
  const KEY_VIEW = { f: 'front', t: 'top', s: 'side', i: 'iso' };
  // neutral greys for the mesh (content), darkest to lightest
  const GREYS = Array.from({ length: SHADES }, (_, s) => { const v = Math.round(46 + (s / (SHADES - 1)) * 186); return `rgb(${v}, ${v}, ${v})`; });

  // R9 (H159; H160's ask): the mesh an address names (…?mesh=<its path as lowercase hex of its UTF-8 bytes>, or in the #hash),
  // as the Workbench's c gives it: chosen on the first list when the list names it. R10 (H167; H164's openTarget, the R9
  // review's F5 and F6): a recording the same way (recording=<its path as hex>), and Home's "Open it in 3D & Motion" (the
  // page's timmy:create-show); when the list does not name what was asked, the tab says so, in words (H164's
  // GET /api/journey/open: what was asked, why it is not shown and what is shown instead), never silently another
  const hexParam = (name) => { try { const m = new RegExp(`[?#&]${name}=((?:[0-9a-f]{2}){1,1024})(?:[&#]|$)`).exec(`${location.search}${location.hash}`); return m ? new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(m[1].match(/../g).map((x) => parseInt(x, 16)))) : ''; } catch (e) { return ''; } };
  const HINT = hexParam('mesh');
  const HINT_REC = hexParam('recording');
  // what the address asked of this tab, as a query for the companion (its tab, mesh and recording only: never the token)
  const ASKED = (() => { try { return `${location.search.replace(/^\?/, '')}&${location.hash.replace(/^#/, '')}`.split('&').filter((x) => /^(?:tab|mesh|recording)=/.test(x)).join('&'); } catch (e) { return ''; } })();
  /** words with each project path said by its file's name (a notice says what, in words; the list shows the paths) */
  const names = (t) => String(t || '').replace(/(?:[\w.~-]+\/)+([\w.-]+)/g, '$1');

  const S = {
    project: null, root: null, ctx: null, revision: null, listAt: 0, list: null, listSig: '', asking: null,
    sel: '', mesh: null, meshAsk: 0, view: null, drag: null, frame: 0, observer: null, again: 0,
    // R10 (H167): the recording chosen (by an address or Home), the mesh Home asked for, and the tab's notice about what was asked
    rec: HINT_REC, wantMesh: '', notice: '', noticeAsked: false,
  };

  const q = (name) => (S.root ? S.root.querySelector(`[data-create="${name}"]`) : null);
  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  /** a measure as the STL reader says it: seven significant digits, no trailing zeros, -0 as 0 */
  const num = (v) => { if (typeof v !== 'number' || !Number.isFinite(v)) return String(v); const s = String(Number(v.toPrecision(7))); return s === '-0' ? '0' : s; };
  const triple = (v) => (Array.isArray(v) ? v.map(num).join(', ') : 'unknown');
  const bytesWords = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
  const freshView = () => Object.assign({ zoom: 1, key: FIRST }, VIEWS[FIRST]);
  function markMore() {
    if (!S.root) return;
    for (const body of S.root.querySelectorAll('.box > .box-body')) {
      const box = body.parentElement;
      const more = body.clientHeight > 0 && body.scrollHeight - body.scrollTop - body.clientHeight > 2;
      if (more) box.dataset.more = '1'; else delete box.dataset.more;
    }
  }

  function reset(project) {
    S.project = project; S.list = null; S.listSig = ''; S.listAt = 0; S.sel = ''; S.mesh = null; S.meshAsk += 1; S.view = freshView(); S.drag = null;
  }

  // ── the skeleton: three columns of boxes ──
  function skeleton(h) {
    const box = (title, name, cls, body = '') => h('section', { class: `box ${cls}`, 'data-create-box': name },
      h('h2', { class: 'box-title', 'data-create': `${name}-title` }, title),
      h('div', { class: `box-body${body ? ` ${body}` : ''}`, 'data-create': name }, h('p', { class: 'empty' }, 'Reading…')));
    const key = (k, label, words) => h('button', { type: 'button', class: 'btn-action tiny create-key', 'data-create-key': k, 'aria-keyshortcuts': k === '+' ? 'Plus' : k === '-' ? 'Minus' : k.toUpperCase(), title: words }, label);
    const root = h('div', { class: 'create-cols', 'data-create': 'root' },
      h('div', { class: 'col-stack create-left' },
        h('p', { class: 'create-notice', 'data-create': 'notice', role: 'status', hidden: true }),
        box('Meshes in this project', 'meshes', 'create-meshes-box'),
        box('Recordings Timmy can read (.rrd)', 'recordings', 'create-recordings-box')),
      h('div', { class: 'col-stack create-centre' },
        h('section', { class: 'box create-view-box', 'data-create-box': 'view' },
          h('h2', { class: 'box-title', 'data-create': 'view-title' }, 'The view you can turn'),
          h('div', { class: 'box-body create-view-body' },
            h('p', { class: 'create-label', 'data-create': 'label' }),
            h('div', { class: 'create-stage', 'data-create': 'stage' },
              h('canvas', { class: 'create-canvas', 'data-create': 'canvas', tabindex: '0', role: 'img', 'aria-label': 'No mesh drawn yet', hidden: true }),
              h('p', { class: 'create-stage-note', 'data-create': 'note' }, 'Reading…')),
            h('div', { class: 'create-view-bar' },
              h('span', { class: 'create-view-name', 'data-create': 'view-name', 'aria-live': 'polite' }),
              h('span', { class: 'create-count', 'data-create': 'count' })),
            h('div', { class: 'create-keys', role: 'group', 'aria-label': 'Turn the view (keys F, T, S, I, R, + and −; arrows turn it)' },
              key('f', 'F front', 'The front view (key F)'), key('t', 'T top', 'The top view (key T)'), key('s', 'S side', 'The side view (key S)'),
              key('i', 'I isometric', 'An isometric view (key I)'), key('r', 'R reset', 'Back to the first view, at its size (key R)'),
              key('+', '+ zoom in', 'Closer (key +, or the wheel)'), key('-', '− zoom out', 'Farther (key −, or the wheel)')),
            h('p', { class: 'create-hint' }, 'Drag or arrows: turn · wheel or + −: zoom · F T S I: front, top, side, isometric · R: reset')))),
      h('div', { class: 'col-stack create-right' },
        box('Measured from the file', 'measure', 'create-measure-box', 'create-measure-body')));
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    const cv = root.querySelector('[data-create="canvas"]');
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    if (typeof ResizeObserver === 'function') {
      if (S.observer) S.observer.disconnect();
      S.observer = new ResizeObserver(() => paint());
      S.observer.observe(root.querySelector('[data-create="stage"]'));
    }
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
        const r = await ctx.fetch(ctx.api('meshes'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      if (!body || body.ok !== true) {
        put(q('meshes'), ctx.h('p', { class: 'empty tone-failed', 'data-create-error': 'meshes' }, `✕ The meshes could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`));
        return;
      }
      if (S.project !== ctx.project) return; // the page switched project while this was asked
      const sig = JSON.stringify([body.meshes.map((m) => [m.path, m.bytes, m.readback ? m.readback.sha256 : m.why, m.origin.words]), body.recordings.map((r) => [r.path, r.bytes, r.why || '', r.cli ? `${r.cli.state} ${r.cli.words}` : '', r.origin ? r.origin.words : '']), body.viewer.state, body.more, body.recordingsMore]);
      const first = S.list === null;
      S.list = body;
      // a mesh still being measured, or a recording the Rerun CLI is reading: the list is read again in a moment while this tab
      // is shown, whether or not this answer changed anything (R9 H159: a recording being read answers the same until it is done)
      if ((body.pending > 0 || body.recordingsPending > 0) && !S.again) S.again = setTimeout(() => { S.again = 0; if (S.root && document.contains(S.root) && !S.root.closest('[hidden]')) { S.listAt = 0; void refreshList(); } }, 1200);
      if (sig === S.listSig && !first) return;
      S.listSig = sig;
      const paths = body.meshes.map((m) => m.path);
      const asked = S.wantMesh || (first ? HINT : '');
      if (asked && paths.includes(asked)) { S.sel = asked; S.wantMesh = ''; }
      else if (!S.sel || !paths.includes(S.sel)) S.sel = (body.meshes.find((m) => m.readback) || body.meshes[0] || { path: '' }).path;
      drawList(); drawRecordings(); drawMeasure();
      if (first) void askNotice();
      const row = body.meshes.find((m) => m.path === S.sel);
      const want = row && row.readback ? row.readback.sha256 : '';
      if (!S.mesh || S.mesh.path !== S.sel || S.mesh.sha !== want) await loadMesh(row);
      markMore();
    })().finally(() => { S.asking = null; });
    return S.asking;
  }

  function drawList() {
    const h = S.ctx.h;
    const L = S.list;
    const el = q('meshes');
    put(q('meshes-title'), `Meshes in this project (${L.meshes.length + L.more})`);
    if (!L.meshes.length) {
      put(el, h('p', { class: 'empty', 'data-create-empty': 'meshes' }, 'No mesh in this project yet: an .stl, .obj or .ply file in it is listed here and drawn. In Timmy\'s terminal, ',
        h('button', { type: 'button', class: 'cmd', 'data-copy': '/add <file>' }, '/add <file>'), ' copies one in (a local change). A STEP is listed once ',
        h('button', { type: 'button', class: 'cmd', 'data-copy': '/vox view <record>' }, '/vox view <record>'), ' has made its tessellation (that needs OCP).'));
    } else {
      put(el, h('ol', { class: 'create-list' }, L.meshes.map((m) => h('li', null,
        h('button', { type: 'button', class: 'create-mesh', 'data-create-mesh': m.path, 'aria-current': m.path === S.sel ? 'true' : 'false' },
          h('span', { class: 'create-mesh-path' }, m.path),
          h('span', { class: 'create-mesh-sub' }, [
            m.kind === 'tessellation' ? `tessellation of ${m.tessellation.from}` : (KIND[m.kind] || String(m.kind).toUpperCase()),
            m.readback ? `${m.readback.triangles} triangle${m.readback.triangles === 1 ? '' : 's'}` : m.pending ? 'being measured…' : 'not measured',
            bytesWords(m.bytes),
          ].join(' · ')))))),
      L.more ? h('p', { class: 'create-note' }, `and ${L.more} more not listed here (the list names the first ${L.meshes.length}, by path)`) : null,
      L.walk && L.walk.truncated ? h('p', { class: 'create-note' }, `Only the first ${L.walk.files} files and folders of the project were looked through: a mesh past them is not listed.`) : null);
    }
  }
  const markList = () => { if (S.root) for (const b of S.root.querySelectorAll('.create-mesh')) b.setAttribute('aria-current', b.dataset.createMesh === S.sel ? 'true' : 'false'); };

  // R10 (H167; the R9 review's F6): what the address asked of this tab and what is shown for it, in words, when they differ
  async function askNotice() {
    if (S.noticeAsked || !/(?:^|&)(?:mesh|recording)=/.test(ASKED)) return;
    S.noticeAsked = true;
    try {
      const r = await S.ctx.fetch(`/api/journey/open?${ASKED}${S.project ? `&project=${encodeURIComponent(S.project)}` : ''}`);
      const b = await r.json().catch(() => null);
      S.notice = b && b.ok && b.notice ? names(b.notice) : '';
    } catch (e) { S.notice = ''; }
    drawNotice();
  }
  function drawNotice() {
    const el = q('notice');
    if (!el) return;
    el.textContent = S.notice || '';
    el.hidden = !S.notice;
  }

  function drawRecordings() {
    const h = S.ctx.h;
    const L = S.list;
    const v = L.viewer;
    const viewer = h('div', { class: 'create-viewer', 'data-create-viewer': v.state },
      h('p', { class: 'create-viewer-state' }, `${v.name}: ${v.state}`),
      h('p', { class: 'create-note' }, v.words),
      v.setup ? h('button', { type: 'button', class: 'cmd', 'data-copy': v.setup }, v.setup) : null);
    if (!L.recordings.length) {
      put(q('recordings'), h('p', { class: 'empty', 'data-create-empty': 'recordings' }, 'No Rerun recording (.rrd) in this project.'), viewer);
      return;
    }
    put(q('recordings'), L.recordings.map((r) => {
      const f = r.facts;
      if (!f) return h('div', { class: `create-rec${r.path === S.rec ? ' is-chosen' : ''}`, 'data-create-recording': r.path, 'aria-current': r.path === S.rec ? 'true' : null }, h('p', { class: 'create-rec-path' }, r.path), h('p', { class: 'create-note' }, `${bytesWords(r.bytes)} · not read: ${r.why || 'unknown'}`),
        r.cli ? h('dl', null, cliRows(h, r.cli)) : null);
      const stores = f.stores.map((s) => [s.kind, s.application ? `application ${s.application}` : '', s.recording ? `recording ${s.recording}` : ''].filter(Boolean).join(' · ')).join('; ');
      return h('div', { class: `create-rec${r.path === S.rec ? ' is-chosen' : ''}`, 'data-create-recording': r.path, 'aria-current': r.path === S.rec ? 'true' : null },
        h('p', { class: 'create-rec-path' }, r.path),
        h('dl', null,
          h('dt', null, 'header (read by Timmy from the file)'), h('dd', { 'data-rec': 'header' }, `written by ${f.writer} · compression ${f.compression} · ${f.serializer} · ${bytesWords(f.bytes)}`),
          h('dt', null, 'messages'), h('dd', { 'data-rec': 'messages' }, `${f.messages.storeInfo} store info · ${f.messages.chunks} data chunks · ${f.messages.blueprint} blueprint${f.messages.other ? ` · ${f.messages.other} other` : ''}${f.ended ? ' · ends with its end marker' : ' · no end marker'}${f.footer ? ' and a footer' : ''}`),
          stores ? h('dt', null, 'stores') : null, stores ? h('dd', { 'data-rec': 'stores' }, stores) : null,
          f.stopped ? h('dt', null, 'stopped') : null, f.stopped ? h('dd', null, f.stopped) : null,
          r.cli ? cliRows(h, r.cli) : null,
          r.origin ? [h('dt', null, 'written by'), h('dd', { 'data-rec': 'origin' }, r.origin.words)] : null,
          h('dt', null, "not decoded by Timmy's own reader"), h('dd', { 'data-rec': 'unknown' }, f.unknown.entities)));
    }), L.recordingsMore ? h('p', { class: 'create-note' }, `and ${L.recordingsMore} more not listed here`) : null, viewer);
  }

  // R9 (H159): what the installed Rerun CLI read of a recording, row by row: who read it, Rerun's own check, the entities (and
  // the static ones), each timeline with its kind and range; or each fact unknown with why ("being read" while it reads)
  function cliRows(h, c) {
    const out = [];
    const row = (k, label, value) => out.push(h('dt', null, label), h('dd', { 'data-rec': k }, value));
    const said = (u) => (u.reason === 'being-read' ? u.why : `unknown: ${u.why}`);
    row('cli', 'read by the Rerun CLI', c.words);
    if (c.verify.state === 'passed') row('verify', "Rerun's own check", c.verify.words);
    else if (c.verify.state === 'failed') row('verify', "Rerun's own check", `✕ failed: ${c.verify.why}`);
    const e = c.entities;
    const t = c.timelines;
    if (e.state !== 'read' && t.state !== 'read' && e.why === t.why) { row('entities', 'entities and timelines', said(e)); return out; }
    if (e.state === 'read') {
      row('entities', `entities (${e.count})`, e.paths.join(' · '));
      if (e.static.state !== 'read') row('static', 'static (logged on no timeline)', said(e.static));
      else if (e.static.paths.length) row('static', 'static (logged on no timeline)', e.static.paths.join(' · '));
      if (e.stores.length > 1) row('stores-cli', 'counted together, across', e.stores.map((s) => `${s.kind} ${s.application} (${s.entities})`).join(' · '));
    } else row('entities', 'entities', said(e));
    if (t.state !== 'read') { row('timelines', 'timelines', said(t)); return out; }
    // rrd stats lists the timelines of every store in the file together (a blueprint's beside the recording's), as it does the entities
    out.push(h('dt', null, `timelines (${t.list.length}${e.state === 'read' && e.stores.length > 1 ? ", across the file's stores" : ''})`));
    if (!t.list.length) out.push(h('dd', { 'data-rec': 'timelines' }, 'none: every entity is static'));
    for (const x of t.list) {
      const same = x.kind.state !== 'read' && x.range.state !== 'read' && x.kind.why === x.range.why;
      const kind = x.kind.state === 'read' ? x.kind.kind : `kind ${said(x.kind)}`;
      const range = x.range.state === 'read' ? x.range.words : `range ${said(x.range)}`;
      out.push(h('dd', { 'data-rec-timeline': x.name }, same ? `${x.name} · ${said(x.kind)}` : `${x.name} · ${kind} · ${range}`));
    }
    return out;
  }

  // ── the measurements ──
  function drawMeasure() {
    const h = S.ctx.h;
    const L = S.list;
    const m = L.meshes.find((x) => x.path === S.sel);
    const el = q('measure');
    if (!m) { put(q('measure-title'), 'Measured from the file'); put(el, h('p', { class: 'empty' }, 'No mesh to measure in this project.')); return; }
    const row = (k, label, value) => [h('dt', null, label), h('dd', { 'data-measure': k }, value)];
    const r = m.readback;
    put(q('measure-title'), `Measured from the file · ${m.path}`);
    const reader = (m.reader && m.reader.words) || L.reader;
    const origin = row('origin', `where it came from (provenance ${m.origin.provenance})`, m.origin.words);
    const said = m.declared ? row('declared', `the file says (${m.declared.what}; its own words, not checked)`, m.declared.words) : [];
    if (!r) {
      put(el, h('dl', { class: 'create-measure' }, row('why', 'not measured', m.why || 'unknown'), origin, said),
        h('p', { class: 'create-doctrine', 'data-create': 'doctrine' }, L.doctrine));
      return;
    }
    const b = r.bbox;
    put(el,
      h('p', { class: 'create-note', 'data-create': 'reader' }, reader),
      h('dl', { class: 'create-measure' },
        row('triangles', 'triangles', String(r.triangles)),
        row('corners', 'corners (joined only where bit-identical)', String(r.corners)),
        row('box-min', 'box: least x, y, z', b ? triple(b.min) : 'none'),
        row('box-max', 'box: greatest x, y, z', b ? triple(b.max) : 'none'),
        row('box-size', 'box: size', b ? b.size.map(num).join(' × ') : 'none'),
        row('area', 'surface area', num(r.area)),
        row('volume', 'volume', m.volume),
        row('topology', 'topology', m.topology),
        m.faces ? row('faces', 'faces', m.faces) : [],
        row('format', 'file', `${m.format || `${r.format === 'binary' ? 'binary' : 'ASCII'} STL`} · ${bytesWords(r.bytes)} · sha256 ${r.sha256.slice(0, 12)}…`),
        r.ply ? row('stored', 'stored as', `${r.ply.coordinates}; corners as ${r.ply.indices}`) : [],
        r.precision ? row('precision', 'coordinates', r.precision) : [],
        m.ignored ? row('ignored', 'not measured', m.ignored) : [],
        row('units', 'units', r.units),
        origin, said,
        m.tessellation ? row('tessellation', 'tessellated', `from ${m.tessellation.from} by ${m.tessellation.made_by}, within ${m.tessellation.tolerance}; ${m.tessellation.sealed === true ? 'a vox receipt sealed these bytes' : m.tessellation.sealed === false ? 'no vox receipt of this project seals these bytes' : 'no receipt was checked here'}`) : []),
      h('p', { class: 'create-doctrine', 'data-create': 'doctrine' }, L.doctrine));
  }

  // ── the mesh's triangles ──
  async function loadMesh(row) {
    const ask = ++S.meshAsk;
    S.mesh = null;
    put(q('view-title'), row ? `The view you can turn · ${row.path}` : 'The view you can turn');
    put(q('label'), S.list ? S.list.view : '');
    put(q('count'), '');
    if (!row) { stageNote('No mesh in this project to draw.'); paint(); return; }
    if (!row.readback && row.pending) { stageNote(`${row.path} is being measured by ${readerName(row)}: it is drawn once the list holds its measurements.`); paint(); return; }
    if (!row.readback) { stageNote(`Not drawn: ${row.path} was not measured (${row.why || 'unknown'}).`); paint(); return; }
    stageNote(`Reading ${row.path}…`);
    const ctx = S.ctx;
    let r = null;
    try { r = await ctx.fetch(ctx.api(`mesh?path=${encodeURIComponent(row.path)}&sha=${row.readback.sha256}`)); } catch (e) { r = null; }
    if (ask !== S.meshAsk) return;
    if (!r || !r.ok) {
      let words = r ? `the companion answered HTTP ${r.status}` : 'the companion did not answer';
      try { const b = r ? await r.json() : null; if (b && b.error) words = b.error; } catch (e) { /* the status says it */ }
      if (ask !== S.meshAsk) return;
      if (r && r.status === 409) { S.listSig = ''; S.listAt = 0; stageNote(`${row.path} changed since it was listed: reading the list again…`); setTimeout(() => { if (S.ctx) void refreshList(); }, 0); return; }
      stageNote(`✕ Not drawn: ${words}`, true);
      return;
    }
    const buf = await r.arrayBuffer();
    if (ask !== S.meshAsk) return;
    const counts = /^(\d+)\/(\d+)$/.exec(r.headers.get('X-Timmy-Triangles') || '');
    const shown = Math.floor(buf.byteLength / 36);
    const dv = new DataView(buf);
    const tris = new Float32Array(shown * 9);
    for (let i = 0; i < tris.length; i += 1) tris[i] = dv.getFloat32(i * 4, true);
    const b = row.readback.bbox;
    const centre = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0, 0];
    const radius = b ? Math.max(1e-9, Math.hypot(b.size[0], b.size[1], b.size[2]) / 2) : 1;
    const total = counts ? Number(counts[2]) : row.readback.triangles;
    S.mesh = {
      path: row.path, sha: row.readback.sha256, tris, shown, total, centre, radius,
      // a closed, consistently oriented mesh drawn whole: its faces turned away are hidden behind the others
      cull: row.readback.oriented && shown === total, sign: row.readback.volume >= 0 ? 1 : -1,
      proj: new Float32Array(shown * 6), depth: new Float32Array(shown), shade: new Uint8Array(shown), order: new Uint32Array(shown),
    };
    const agrees = counts && Number(counts[1]) === shown && row.view && row.view.shown === shown && row.view.total === total;
    put(q('count'), agrees ? row.view.words : `showing ${shown} of ${total} triangles (the list said ${row.view ? `${row.view.shown} of ${row.view.total}` : 'nothing'})`);
    const cv = q('canvas');
    if (cv) cv.hidden = false;
    const note = q('note');
    if (note) note.hidden = true;
    describeView();
    paint();
  }

  function stageNote(words, failed = false) {
    const note = q('note');
    const cv = q('canvas');
    if (cv) cv.hidden = true;
    if (note) { note.hidden = false; note.textContent = words; note.classList.toggle('tone-failed', failed); }
    describeView();
  }

  // ── the view ──
  function describeView() {
    const v = S.view;
    const words = v.key === 'turned' ? `turned by hand: ${Math.round(v.yaw)}° around z from the front, ${Math.round(v.pitch)}° above it` : `${v.name} · ${v.words}`;
    const zoom = Math.abs(v.zoom - 1) < 1e-9 ? '' : ` · zoom ${num(Math.round(v.zoom * 100) / 100)}×`;
    put(q('view-name'), `${words}${zoom}`);
    for (const b of S.root ? S.root.querySelectorAll('[data-create-key]') : []) {
      const k = b.dataset.createKey;
      if (KEY_VIEW[k]) b.setAttribute('aria-pressed', KEY_VIEW[k] === v.key ? 'true' : 'false');
    }
    const cv = q('canvas');
    if (cv) cv.setAttribute('aria-label', S.mesh ? `Timmy's own view of ${S.mesh.path}'s triangles: ${words}` : 'No mesh drawn');
    if (cv) cv.dataset.view = v.key;
  }
  function setView(key) { S.view = Object.assign({ zoom: S.view.zoom, key }, VIEWS[key]); describeView(); paint(); }
  function turn(dyaw, dpitch) {
    const v = S.view;
    S.view = { key: 'turned', name: 'turned', words: '', zoom: v.zoom, yaw: (((v.yaw + dyaw) % 360) + 540) % 360 - 180, pitch: Math.max(-90, Math.min(90, v.pitch + dpitch)) };
    describeView(); paint();
  }
  function zoomBy(f) { S.view.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, S.view.zoom * f)); describeView(); paint(); }
  function act(k) {
    if (KEY_VIEW[k]) { setView(KEY_VIEW[k]); return true; }
    if (k === 'r') { S.view = freshView(); describeView(); paint(); return true; }
    if (k === '+') { zoomBy(ZOOM_STEP); return true; }
    if (k === '-') { zoomBy(1 / ZOOM_STEP); return true; }
    return false;
  }

  /** Draws on the next frame (a drag or a resize asks many times; one drawing answers them). */
  function paint() {
    if (S.frame) return;
    S.frame = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16))(() => { S.frame = 0; render(); });
  }

  function render() {
    const cv = q('canvas');
    const stage = q('stage');
    if (!cv || !stage || cv.hidden) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(stage.clientWidth * dpr));
    const ch = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const g = cv.getContext('2d');
    if (!g) return;
    g.fillStyle = getComputedStyle(stage).backgroundColor || 'rgb(7, 7, 7)';
    g.fillRect(0, 0, cw, ch);
    const m = S.mesh;
    if (!m || !m.shown) return;
    const tris = m.tris;
    const rad = Math.PI / 180;
    const sy = Math.sin(S.view.yaw * rad), cy = Math.cos(S.view.yaw * rad);
    const sp = Math.sin(S.view.pitch * rad), cp = Math.cos(S.view.pitch * rad);
    // toward the viewer, the screen's right and its up, in the file's axes
    const dx = sy * cp, dy = -cy * cp, dz = sp;
    const rx = cy, ry = sy, rz = 0;
    const ux = -sp * sy, uy = sp * cy, uz = cp;
    // the one light: fixed beside the viewer, above and to the left of the line of sight
    let lx = -0.35 * rx + 0.55 * ux + 0.76 * dx, ly = -0.35 * ry + 0.55 * uy + 0.76 * dy, lz = -0.35 * rz + 0.55 * uz + 0.76 * dz;
    const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
    const scale = (Math.min(cw, ch) * 0.46 / m.radius) * S.view.zoom;
    const ox = cw / 2, oy = ch / 2;
    const [c0, c1, c2] = m.centre;
    const P = m.proj, depth = m.depth, shade = m.shade, order = m.order;
    let k = 0;
    for (let t = 0; t < m.shown; t += 1) {
      const o = t * 9;
      let z = 0;
      for (let c = 0; c < 3; c += 1) {
        const X = tris[o + c * 3] - c0, Y = tris[o + c * 3 + 1] - c1, Z = tris[o + c * 3 + 2] - c2;
        P[t * 6 + c * 2] = ox + (X * rx + Y * ry + Z * rz) * scale;
        P[t * 6 + c * 2 + 1] = oy - (X * ux + Y * uy + Z * uz) * scale;
        z += X * dx + Y * dy + Z * dz;
      }
      // the face's normal from the order of its corners, as Timmy's reader measures it
      const ax = tris[o + 3] - tris[o], ay = tris[o + 4] - tris[o + 1], az = tris[o + 5] - tris[o + 2];
      const bx = tris[o + 6] - tris[o], by = tris[o + 7] - tris[o + 1], bz = tris[o + 8] - tris[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0)) continue; // no area: nothing to draw
      nx /= len; ny /= len; nz /= len;
      const facing = nx * dx + ny * dy + nz * dz;
      if (m.cull && facing * m.sign < 0) continue;
      // flat shading by the side of the face that is seen, under the one light
      const lit = Math.max(0, (facing < 0 ? -1 : 1) * (nx * lx + ny * ly + nz * lz));
      shade[k] = Math.round((0.18 + 0.82 * lit) * (SHADES - 1));
      depth[k] = z / 3;
      order[k] = t;
      k += 1;
    }
    // painter's order, the farthest first: each triangle's depth (scaled to whole steps of 1/2^20 of the mesh's size, past the
    // view's own) and its place packed into one number, sorted as numbers (exact: below 2^53)
    let zmin = Infinity;
    for (let i = 0; i < k; i += 1) if (depth[i] < zmin) zmin = depth[i];
    const keys = new Float64Array(k);
    const step = (2 * m.radius) / 1048576;
    for (let i = 0; i < k; i += 1) keys[i] = Math.min(4194303, Math.max(0, Math.floor((depth[i] - zmin) / step))) * 65536 * 1024 + i;
    keys.sort();
    // the seams between triangles are covered by a stroke of their own colour; while a large mesh is dragged, only at rest
    const seams = !(S.drag && S.drag.moved && k > 5000);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1, dpr * 0.75);
    let cur = -1;
    const flush = () => { g.fill(); if (seams) g.stroke(); };
    for (let i = 0; i < k; i += 1) {
      const j = keys[i] % 67108864;
      if (shade[j] !== cur) {
        if (cur >= 0) flush();
        cur = shade[j];
        g.fillStyle = GREYS[cur];
        g.strokeStyle = GREYS[cur];
        g.beginPath();
      }
      const p = order[j] * 6;
      const x0 = P[p], y0 = P[p + 1];
      let x1 = P[p + 2], y1 = P[p + 3], x2 = P[p + 4], y2 = P[p + 5];
      // every triangle wound one way, so overlapping ones in one path all fill (the nonzero rule)
      if ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0) < 0) { const tx = x1, ty = y1; x1 = x2; y1 = y2; x2 = tx; y2 = ty; }
      g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath();
    }
    if (cur >= 0) flush();
    cv.dataset.drawn = String(k);
  }

  // ── what a person does ──
  function onClick(event) {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) return;
    const mesh = t.closest('[data-create-mesh]');
    if (mesh) {
      const p = mesh.dataset.createMesh;
      if (p !== S.sel && S.list) { S.sel = p; markList(); drawMeasure(); void loadMesh(S.list.meshes.find((m) => m.path === p)); markMore(); }
      return;
    }
    const key = t.closest('[data-create-key]');
    if (key) act(key.dataset.createKey);
  }
  function onKey(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !t.closest('[data-create-box="view"]')) return;
    const k = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const handled = k === 'ArrowLeft' ? (turn(STEP_DEG, 0), true) : k === 'ArrowRight' ? (turn(-STEP_DEG, 0), true)
      : k === 'ArrowUp' ? (turn(0, -STEP_DEG), true) : k === 'ArrowDown' ? (turn(0, STEP_DEG), true)
        : k === '=' ? act('+') : k === '_' ? act('-') : act(k);
    if (handled) event.preventDefault();
  }
  function onDown(event) {
    if (!S.mesh || event.button !== 0) return;
    S.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: S.view.yaw, pitch: S.view.pitch, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* the pointer is gone */ }
    event.currentTarget.classList.add('is-dragging');
    event.currentTarget.focus({ preventScroll: true });
  }
  function onMove(event) {
    const d = S.drag;
    if (!d || d.id !== event.pointerId) return;
    const mx = event.clientX - d.x, my = event.clientY - d.y;
    if (!d.moved && Math.abs(mx) + Math.abs(my) < 2) return;
    d.moved = true;
    S.view = { key: 'turned', name: 'turned', words: '', zoom: S.view.zoom, yaw: ((((d.yaw - mx * DRAG_DEG_PER_PX) % 360) + 540) % 360) - 180, pitch: Math.max(-90, Math.min(90, d.pitch + my * DRAG_DEG_PER_PX)) };
    describeView(); paint();
  }
  function onUp(event) {
    if (!S.drag || S.drag.id !== event.pointerId) return;
    const moved = S.drag.moved;
    S.drag = null;
    event.currentTarget.classList.remove('is-dragging');
    if (moved) paint(); // at rest: drawn again with its seams covered
  }
  function onWheel(event) {
    if (!S.mesh) return;
    event.preventDefault();
    zoomBy(Math.exp(-Math.max(-400, Math.min(400, event.deltaY)) * 0.0015));
  }

  // R10 (H167): Home's "Open it in 3D & Motion" names the mesh or the recording (companion.js openWork): chosen here as an
  // address would choose it, now if the list names it, else when the list is next read
  document.addEventListener('timmy:create-show', (e) => {
    const d = (e && e.detail) || {};
    if (d.mesh) {
      const row = S.list && S.list.meshes.find((m) => m.path === d.mesh);
      if (row) { S.sel = d.mesh; S.wantMesh = ''; markList(); drawMeasure(); void loadMesh(row); markMore(); } else S.wantMesh = d.mesh;
    }
    if (d.recording) { S.rec = d.recording; if (S.list) { drawRecordings(); S.root?.querySelector('.create-rec.is-chosen')?.scrollIntoView({ block: 'nearest' }); } }
  });

  TimmyPanels.register('create', {
    draw(host, frame, ctx) {
      S.ctx = ctx;
      if (!ctx.own) {
        S.root = null;
        put(host, ctx.h('p', { class: 'empty' }, 'Not shown: the frame is another project\'s, so its meshes are not read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        reset(ctx.project);
        S.root = skeleton(ctx.h);
        put(host, S.root);
        describeView();
        drawNotice();
      }
      const now = Date.now();
      const rev = frame && frame.revision;
      if (S.list && now - S.listAt < LIST_EVERY_MS) return undefined;
      if (S.list && rev === S.revision && now - S.listAt < LIST_AT_LEAST_MS) return undefined;
      S.revision = rev;
      return refreshList();
    },
  });
})();
