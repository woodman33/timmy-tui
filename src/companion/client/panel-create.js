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
//
// R11 round 7 (H176; the operator's order "finish the product experience", SHELL CONTRACT v1): the page is Motion & 3D on the
// scaffold: it registers itself with the shell (the shell's own words for the page — the rail's number, CREATE IN 3D, "From a
// parameter to a possibility." — stand; the one primary next action Open the Houdini starter in Studio), and its work is the guided
// starter flow (01 Define the geometry ·
// 02 Set the parameters · 03 Cook in Houdini) over the three columns: the preview central (the view you can turn), the editable
// sources beside it (the meshes, the project's parameter files with their values and the workflow documents with their blocks,
// read by GET /api/panel/create/sources; editing, Save, Rebuild and Run are Studio's parameter and workflow nodes and the typed
// commands: nothing on this page runs), and the measurements on the right. The Houdini lane is said as probed (flag off, armed
// without a binary, or on PATH: available is not exercised), the three Houdini starters open in Studio's New board. Without the
// shell (a page before it lands) the panel draws its own head, so the page reads the same.
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
    // R11 round 7 (H176): the guided flow's sources (parameter files, workflows, the starters, the Houdini lane), and the step in focus
    sources: null, sourcesSig: '', sourcesAt: 0, askingSources: null, step: '01', pageSig: '',
    // item 6: the words a step's verb just said (its state line holds them for a moment), and the timer that lets go of them
    said: null, saidTimer: 0,
  };
  const HERE = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
  // R11 round 7 (H176): the page's own sheet (src/companion/client/panel-create.css; src/companion/server.ts serves it beside
  // companion.css). index.html links it once the shell's lines land; until then, and on any page without the line, the panel asks
  // for it itself (the same file once: never a second link), so the view's flex chain holds in every order the branches land.
  (function ensureSheet(href) {
    try {
      if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.dataset.panelSheet = 'create';
      document.head.appendChild(link);
    } catch (e) { /* the page keeps companion.css's boxes */ }
  })('/panel-create.css');
  /** The shell, when it is on the page (SHELL CONTRACT v1); null before it lands: the panel then draws its own head. */
  const shell = () => (typeof window.TimmyShell === 'object' && window.TimmyShell && typeof window.TimmyShell.page === 'function' ? window.TimmyShell : null);
  // the page's one-line description (the lead's 17:41 ruling: where you are and what you can do here, in plain words, true to
  // what exists: no native Houdini operation is configured — a cook happens in Houdini once it is connected)
  const INTRO = 'Build 3D and motion from parameters: open a Houdini starter on this project\'s board, set its parameters, and review the meshes Timmy reads here; a cook runs in Houdini once it is connected (none is configured yet).';
  const STEPS = [
    { n: '01', verb: 'Define the geometry', box: 'meshes', guide: 'The meshes Timmy can read in this project, measured from the whole file, and the view you can turn.' },
    { n: '02', verb: 'Set the parameters', box: 'params', guide: "The project's parameter files, as the live board reads them. Save and Rebuild are Studio's parameter node, or the typed command." },
    { n: '03', verb: 'Cook in Houdini', box: 'workflows', guide: 'A cook is a workflow block a REPL runs, or Houdini itself. Nothing on this page calls Houdini.' },
  ];
  // R11 round 7 (H176; the operator's 19:18 order, item 6: "make Houdini starter nodes actionable"): EACH step carries ONE verb that
  // does something now, beside its state line (the state from the project's own sources: GET /api/panel/create/meshes and /sources):
  //   01 Add a mesh                /add <file> copied for Timmy's terminal, with its words (the companion adds no file itself)
  //   02 Edit the parameters       Timmy Studio opened (a grant minted by POST /api/panel/studio/open when the Studio's token file is
  //                                in this Timmy home): the project's parameter node is the editable card there, Save through the
  //                                live board; no parameter file yet → "Add a parameter file" copies /add <file> with its words
  //   03 Copy the hython command   the engine shelf's own headless invocation (lanes/engines/houdini/templates/procedural-asset/
  //                                script.py's first line), the mesh in the view filled in, and the honest line beside it: Houdini
  //                                is not connected on this companion — this copies the command, nothing runs. Never a fabricated run.
  const ADD_COMMAND = '/add <file>';
  const HYTHON_SCRIPT = 'lanes/engines/houdini/templates/procedural-asset/script.py';
  const hythonCommand = (mesh) => `hython ${HYTHON_SCRIPT} ${mesh || '<mesh file>'} <out dir> ${mesh ? mesh.replace(/^.*\//, '').replace(/\.[^.]+$/, '') || '<stem>' : '<stem>'}`;
  /** The honest line beside the copied Houdini command, from the lane as probed (nothing on this page calls Houdini). */
  const houdiniLine = (lane) => (lane && lane.status === 'ready'
    ? `${lane.bin || 'houdini-mcp'} is on this computer's PATH and the lane is armed, but nothing on this page calls it: this copies the command, nothing runs.`
    : 'Houdini is not connected on this companion: this copies the command, nothing runs.');
  const ADD_WORDS = {
    mesh: `Copied ${ADD_COMMAND} for Timmy's terminal: type it with the mesh's path (an .stl, .obj or .ply file); Timmy copies the file into this project (a local change), and it is listed and drawn here. Nothing ran on this page.`,
    params: `Copied ${ADD_COMMAND} for Timmy's terminal: a parameter file is a tray recipe (recipes/tray.params.json) or an OpenSCAD model with its parameters beside it; type the command with its path, and it is listed here with its values. Nothing ran on this page.`,
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
    S.sources = null; S.sourcesSig = ''; S.sourcesAt = 0; S.step = '01'; S.pageSig = '';
    S.said = null; if (S.saidTimer) { clearTimeout(S.saidTimer); S.saidTimer = 0; }
  }

  // ── the skeleton: three columns of boxes ──
  function skeleton(h) {
    const box = (title, name, cls, body = '') => h('section', { class: `box ${cls}`, 'data-create-box': name },
      h('h2', { class: 'box-title', 'data-create': `${name}-title` }, title),
      h('div', { class: `box-body${body ? ` ${body}` : ''}`, 'data-create': name }, h('p', { class: 'empty' }, 'Reading…')));
    const key = (k, label, words) => h('button', { type: 'button', class: 'btn-action tiny create-key', 'data-create-key': k, 'aria-keyshortcuts': k === '+' ? 'Plus' : k === '-' ? 'Minus' : k.toUpperCase(), title: words }, label);
    // a step card: its number, its name, its state line (the project's own words) and its ONE verb (a button that does something now)
    const stepCard = (st) => h('div', { class: 'create-step', 'data-create-step': st.n, 'data-current': st.n === S.step ? 'true' : 'false', role: 'group', 'aria-label': `Step ${st.n}: ${st.verb}` },
      h('span', { class: 'create-step-n' }, st.n), h('span', { class: 'create-step-verb' }, st.verb), h('span', { class: 'create-step-state', 'data-create-step-state': st.n, role: 'status' }, 'reading…'),
      h('button', { type: 'button', class: 'btn-action tiny create-step-do', 'data-create-do': st.n, disabled: true }, 'reading…'));
    const root = h('div', { class: 'create-page', 'data-create': 'root' },
      // the panel's own head, drawn only while the shell is not on the page (the shell draws the page's head from the registration)
      // (the page's words are the shell's: PAGES motion — a page without the shell has no rail number, so the kicker names the page)
      shell() ? null : h('header', { class: 'create-head', 'data-create': 'head' },
        h('p', { class: 'create-kicker' }, 'MOTION & 3D / CREATE IN 3D'),
        h('h2', { class: 'create-title' }, 'From a parameter to a possibility.'),
        h('p', { class: 'create-intro' }, INTRO)),
      h('div', { class: 'create-flow', role: 'group', 'aria-label': 'The guided starter flow', 'data-create': 'flow' }, STEPS.map(stepCard)),
      h('div', { class: 'create-cols', 'data-create': 'cols' },
      h('div', { class: 'col-stack create-left' },
        h('p', { class: 'create-notice', 'data-create': 'notice', role: 'status', hidden: true }),
        box('Meshes in this project', 'meshes', 'create-meshes-box'),
        box('Parameter files', 'params', 'create-params-box'),
        box('Workflows', 'workflows', 'create-workflows-box'),
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
        box('Measured from the file', 'measure', 'create-measure-box', 'create-measure-body'),
        box('Houdini', 'houdini', 'create-houdini-box'))));
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

  // ── R11 round 7 (H176): the sources (parameter files, workflows, the starters, the Houdini lane), read only ──
  async function refreshSources() {
    const ctx = S.ctx;
    if (S.askingSources) return S.askingSources;
    S.sourcesAt = Date.now();
    S.askingSources = (async () => {
      let body = null;
      let status = 0;
      try {
        const r = await ctx.fetch(ctx.api('sources'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      if (S.project !== ctx.project) return;
      if (!body || body.ok !== true) {
        const words = `✕ The parameter files and workflows could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`;
        put(q('params'), ctx.h('p', { class: 'empty tone-failed', 'data-create-error': 'sources' }, words));
        put(q('workflows'), ctx.h('p', { class: 'empty tone-failed' }, words));
        return;
      }
      const sig = JSON.stringify([body.params, body.workflows, body.starters, body.houdini, body.studio, body.notes]);
      if (sig === S.sourcesSig) return;
      S.sourcesSig = sig;
      S.sources = body;
      drawSources();
      drawFlow();
      registerPage();
      markMore();
    })().finally(() => { S.askingSources = null; });
    return S.askingSources;
  }

  /** Where Studio answers, for a link on this computer; elsewhere its address is said. */
  const studioAt = () => String((S.sources && S.sources.studio) || '').replace(/\/+$/, '');
  function studioLink(h, label, title) {
    const at = studioAt();
    if (!at) return h('span', { class: 'create-note' }, label);
    return HERE
      ? h('a', { class: 'btn-action tiny create-studio', 'data-create-studio': '1', href: `${at}/`, target: '_blank', rel: 'noopener noreferrer', title }, label)
      : h('span', { class: 'create-note', 'data-create-studio': 'away' }, `${label}: open ${at}/ on the computer that runs Timmy`);
  }

  function drawSources() {
    const h = S.ctx.h;
    const src = S.sources;
    if (!src) return;
    // 02: the parameter files, each with its values as the live board reads them, what runs on it and where
    put(q('params-title'), `Parameter files (${src.params.length})`);
    if (!src.params.length) {
      put(q('params'), h('p', { class: 'empty', 'data-create-empty': 'params' }, 'No parameter file in this project yet: a tray recipe (recipes/tray.params.json) or an OpenSCAD model with its parameters beside it is listed here, with its values.'));
    } else {
      put(q('params'), src.params.map((pf) => h('div', { class: 'create-source', 'data-create-params': pf.id, 'data-engine': pf.engine },
        h('p', { class: 'create-source-title' }, pf.title),
        h('p', { class: 'create-note' }, pf.state),
        pf.values.length ? h('dl', { class: 'create-values' }, pf.values.map((v) => [h('dt', null, v.name), h('dd', null, `${v.value}${v.unit ? ` ${v.unit}` : ''}`)])) : null,
        pf.more ? h('p', { class: 'create-note' }, `and ${pf.more} more values`) : null,
        h('p', { class: 'create-source-acts' },
          pf.save.offered ? h('span', { class: 'create-note' }, `Edit and ${pf.rebuild ? 'rebuild ' : 'save '}in Studio: its parameter node (Nodes), which runs through the live board.`) : h('span', { class: 'create-note' }, `Not editable from the board: ${pf.save.why || 'its detail was not read'}.`),
          ' ', h('button', { type: 'button', class: 'cmd', 'data-copy': pf.command, title: 'Type this in Timmy' }, pf.command)),
        pf.receipt ? h('details', { class: 'ui-details create-details' }, h('summary', null, 'Details'), h('p', { class: 'create-note' }, `receipt ${pf.receipt}${pf.file ? ` · ${pf.file}` : ''}`)) : null)));
    }
    // 03: the workflows, each block with the state its newest run left and the typed /run that takes it; which names hython
    put(q('workflows-title'), `Workflows (${src.workflows.length})`);
    if (!src.workflows.length) {
      put(q('workflows'), h('p', { class: 'empty', 'data-create-empty': 'workflows' }, 'No workflow document in this project yet (a markdown document with named blocks). A cook is a block a REPL runs; nothing here runs one.'));
    } else {
      put(q('workflows'), src.workflows.map((w) => h('div', { class: 'create-source', 'data-create-workflow': w.id, 'data-houdini': w.houdini ? 'named' : 'none' },
        h('p', { class: 'create-source-title' }, w.title),
        h('p', { class: 'create-note' }, [w.state, w.houdini ? 'a block of it names hython or houdini' : 'no block of it names Houdini', w.running ? 'running now' : ''].filter(Boolean).join(' · ')),
        w.notRunnable ? h('p', { class: 'create-note tone-failed' }, w.notRunnable) : null,
        w.blocks.length ? h('ul', { class: 'create-blocks' }, w.blocks.map((b) => h('li', { class: 'create-block', 'data-block-word': b.word },
          h('span', { class: 'create-block-name' }, `${b.glyph ? `${b.glyph} ` : ''}${b.name}`), ' ', h('span', { class: 'create-note' }, b.word), ' ',
          b.command ? h('button', { type: 'button', class: 'cmd', 'data-copy': b.command, title: 'Type this in Timmy: it runs there, as a job of the REPL that holds the project' }, b.command) : h('span', { class: 'create-note' }, 'not offered to /run')))) : null,
        w.last ? h('p', { class: 'create-note' }, `newest run: ${w.last.word}${w.last.met === true ? ' · prediction met' : w.last.met === false ? ' · prediction not met' : ''}${w.last.receipt ? ` · receipt ${w.last.receipt}` : ' · no receipt'}${w.last.endedAt ? ` · ended ${w.last.endedAt}` : ''}`) : h('p', { class: 'create-note' }, 'no run recorded here (this page names no jobs folder; Workflows reads the runs)'))));
    }
    // the Houdini lane as probed, and the starters that open in Studio
    const lane = src.houdini;
    put(q('houdini-title'), 'Houdini');
    put(q('houdini'),
      h('p', { class: 'create-lane', 'data-create-lane': lane.status }, lane.words),
      h('p', { class: 'create-note' }, 'A snippet on a board is text to copy; a Houdini snippet\'s presence is never a working native operation.'),
      h('h3', { class: 'create-sub' }, 'Guided blank starters'),
      h('ul', { class: 'create-starters' }, src.starters.map((t) => h('li', { class: 'create-starter', 'data-create-starter': t.id },
        h('p', { class: 'create-source-title' }, t.title),
        h('p', { class: 'create-note' }, t.intro),
        h('ol', { class: 'create-starter-steps' }, t.steps.map((st) => h('li', null, h('span', { class: 'create-step-n' }, st.n), ' ', st.verb)))))),
      h('p', { class: 'create-source-acts' }, studioLink(h, 'Open a starter in Studio', 'Opens Timmy Studio on this computer: New board lists the Houdini starters under their own group'), ' ', h('span', { class: 'create-note' }, 'In Studio: New board → Houdini starters, blank. A starter opens on a page of this project\'s board; nodes added from Nodes land in its steps.')),
      src.notes && src.notes.length ? h('details', { class: 'ui-details create-details' }, h('summary', null, 'Details'), src.notes.map((n) => h('p', { class: 'create-note' }, n))) : null);
  }

  /** A mesh's name for the state line (its path's last part; the list shows the paths). */
  const meshName = (p) => String(p || '').replace(/^.*\//, '');
  /**
   * What each step's verb does now (item 6), from what the page has read: { label, title, act } — act one of
   * { kind: 'copy', command, words } (copied for Timmy's terminal, the words said in the step's state line) or
   * { kind: 'studio', words } (Timmy Studio opened, with a grant when one can be made here); null while the sources are not read.
   */
  function stepDo(n) {
    const L = S.list;
    const src = S.sources;
    if (n === '01') return { label: 'Add a mesh', title: `Copies ${ADD_COMMAND} for Timmy's terminal (the companion adds no file itself)`, act: { kind: 'copy', command: ADD_COMMAND, words: ADD_WORDS.mesh } };
    if (n === '02') {
      if (!src) return null;
      if (!src.params.length) return { label: 'Add a parameter file', title: `Copies ${ADD_COMMAND} for Timmy's terminal: no parameter file is in this project yet`, act: { kind: 'copy', command: ADD_COMMAND, words: ADD_WORDS.params } };
      const at = studioAt();
      if (!HERE || !at) return { label: 'Edit the parameters', title: at ? `Studio runs on the computer that runs Timmy: open ${at}/ there; its parameter node is the editable card` : 'Studio\'s address is not known yet', act: null };
      return { label: 'Edit the parameters', title: 'Opens Timmy Studio: the project\'s parameter node is the editable card there (Nodes; it lands in a Houdini starter\'s step 02), and Save goes through the live board', act: { kind: 'studio', words: `Opened Timmy Studio for ${src.params.length === 1 ? faceName(src.params[0].title) : `${src.params.length} parameter files`}: in Studio, Nodes adds the parameter node (it lands in a Houdini starter's step 02); its values are typed there and Save goes through the live board. Nothing on this page edits a file.` } };
    }
    if (!src) return null;
    const mesh = L && S.sel ? S.sel : '';
    const command = hythonCommand(mesh);
    return { label: 'Copy the hython command', title: houdiniLine(src.houdini), act: { kind: 'copy', command, words: `Copied the hython command for a terminal on a computer with Houdini${mesh ? ` (${meshName(mesh)} as its mesh)` : ''}: ${command}. ${houdiniLine(src.houdini)}` } };
  }
  const faceName = (t) => String(t || '').replace(/^(?:[\w.~-]+\/)+/, '');

  /** The three step cards' one-line states (the project's own words) and verbs, from what the page has read; the step in focus is the paper card. */
  function drawFlow() {
    const L = S.list;
    const src = S.sources;
    const words = {
      '01': !L ? 'reading…' : L.meshes.length ? `${L.meshes.length + L.more} mesh${L.meshes.length + L.more === 1 ? '' : 'es'}${S.sel ? ` · ${meshName(S.sel)} in the view` : ''}` : 'no mesh in this project yet',
      '02': !src ? 'reading…' : src.params.length ? `${src.params.length} parameter file${src.params.length === 1 ? '' : 's'} · ${src.params.map((pf) => `${faceName(pf.title)}: ${pf.state}`).join(' · ')}` : 'no parameter file in this project yet',
      '03': !src ? 'reading…' : [
        src.workflows.length ? `${src.workflows.length} workflow${src.workflows.length === 1 ? '' : 's'} · ${src.workflows.map((w) => `${faceName(w.title)}: ${w.state}`).join(' · ')}` : 'no workflow document in this project yet',
        src.houdini.status === 'flag_off' ? 'no native Houdini operation' : src.houdini.status === 'not_configured' ? 'lane armed, no houdini-mcp on PATH' : 'houdini-mcp on PATH · not exercised here',
      ].join(' · '),
    };
    for (const st of STEPS) {
      const el = S.root && S.root.querySelector(`[data-create-step-state="${st.n}"]`);
      // (a copied command's words hold the line for a moment: S.said names the step and its words; the line is one line, shortened
      // with an ellipsis where the card is narrower than it, and its title says it whole)
      if (el && !(S.said && S.said.n === st.n)) { el.textContent = words[st.n]; el.title = words[st.n]; }
      const b = S.root && S.root.querySelector(`[data-create-step="${st.n}"]`);
      if (b) {
        b.setAttribute('data-current', st.n === S.step ? 'true' : 'false');
        // the card's title says the step whole — its verb and its state — where the card is narrower than its words
        b.title = `Step ${st.n} — ${st.verb}: ${words[st.n]}. ${st.guide}`;
      }
      const d = S.root && S.root.querySelector(`[data-create-do="${st.n}"]`);
      if (d) {
        const plan = stepDo(st.n);
        d.textContent = plan ? plan.label : 'reading…';
        d.title = plan ? plan.title : 'The verb is drawn once the project is read';
        d.disabled = !plan || !plan.act;
        d.dataset.createDoKind = plan && plan.act ? plan.act.kind : 'none';
      }
    }
  }

  /** The page on the scaffold (SHELL CONTRACT v1 §2.3): its kicker, title, intro, the one primary next action, its state. */
  function registerPage() {
    const sh = shell();
    if (!sh) return;
    const at = studioAt();
    const L = S.list;
    const empty = Boolean(L && !L.meshes.length && S.sources && !S.sources.params.length);
    // registered again only as what it says changes (the shell redraws the head and dock on each call: a reading every few
    // seconds that says the same must not take a focused button away)
    const sig = JSON.stringify([at, empty]);
    if (sig === S.pageSig) return;
    S.pageSig = sig;
    try {
      // (no kicker or title of the panel's own: the shell's words for Motion & 3D stand, with the rail's number; the intro is the page's)
      sh.page('motion', {
        intro: INTRO,
        primary: HERE && at
          ? { label: 'Open the Houdini starter', run: () => { try { window.open(`${at}/`, '_blank', 'noopener'); } catch (e) { /* the link in the work is the same */ } } }
          : { label: 'Open the Houdini starter', disabled: true, why: at ? `Studio runs on the computer that runs Timmy: open ${at}/ there` : 'Studio\'s address is not known yet' },
        context: null,
        dock: 'HOUDINI TOOLS',
      });
      if (empty) sh.state('motion', 'empty', { words: 'No mesh and no parameter file in this project yet. Add a mesh with /add <file>, or start from a Houdini starter in Studio.', next: { label: 'Open the Houdini starter', run: () => { if (HERE && at) window.open(`${at}/`, '_blank', 'noopener'); } } });
      else sh.state('motion', 'content');
    } catch (e) { /* the shell's registration is a courtesy: the panel's own work is drawn either way */ }
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
      drawList(); drawRecordings(); drawMeasure(); drawFlow(); registerPage();
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
      if (p !== S.sel && S.list) { S.sel = p; markList(); drawMeasure(); drawFlow(); void loadMesh(S.list.meshes.find((m) => m.path === p)); markMore(); }
      return;
    }
    const key = t.closest('[data-create-key]');
    if (key) { act(key.dataset.createKey); return; }
    // R11 round 7 (H176; item 6): a step's verb does its one thing now (a command copied with its words, or Studio opened), and the
    // step comes into focus with its box
    const does = t.closest('[data-create-do]');
    if (does) { void doStep(does.dataset.createDo, does); return; }
    // a step card brings its box into view (01 the meshes and the view, 02 the parameter files, 03 the workflows and Houdini)
    const step = t.closest('[data-create-step]');
    if (step) focusStep(step.dataset.createStep);
  }
  function focusStep(n) {
    const st = STEPS.find((x) => x.n === n);
    if (!st) return;
    S.step = n;
    drawFlow();
    const box = S.root && S.root.querySelector(`[data-create-box="${st.box}"]`);
    if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest' });
  }
  /** The words a step's verb says, in its state line (6 s), then the state again; the shell's toast says them too when it is there. */
  function say(n, words, failed = false) {
    S.said = { n, words };
    if (S.saidTimer) clearTimeout(S.saidTimer);
    const el = S.root && S.root.querySelector(`[data-create-step-state="${n}"]`);
    if (el) { el.textContent = words; el.classList.toggle('tone-failed', failed); }
    S.saidTimer = setTimeout(() => { S.saidTimer = 0; S.said = null; if (el) el.classList.remove('tone-failed'); drawFlow(); }, 6000);
    try { const sh = shell(); if (sh && typeof sh.toast === 'function') sh.toast(words); } catch (e) { /* the line says them */ }
  }
  /** Copies `text` for Timmy's terminal: the clipboard when the page may write it; false when it would not. */
  async function copyText(text) {
    try {
      if (!window.isSecureContext || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { return false; }
  }
  async function doStep(n, button) {
    const plan = stepDo(n);
    if (!plan || !plan.act) return;
    focusStep(n);
    button.disabled = true;
    try {
      if (plan.act.kind === 'copy') {
        const ok = await copyText(plan.act.command);
        say(n, ok ? plan.act.words : `Not copied (this browser would not): the command is ${plan.act.command}. ${n === '03' ? houdiniLine(S.sources && S.sources.houdini) : 'Nothing ran on this page.'}`, !ok);
      } else if (plan.act.kind === 'studio') {
        openStudio(n, plan.act.words);
      }
    } finally { button.disabled = false; drawFlow(); }
  }
  /**
   * Opens Timmy Studio from a step (item 6, 02): the window opens in the click, then the companion is asked for the Studio's address
   * with a one-time grant (POST /api/panel/studio/open, the Canvas page's route: made when the Studio's token file is in this Timmy
   * home) and the window goes there; without a grant it goes to the Studio's plain address, and the step says why.
   */
  function openStudio(n, words) {
    const at = studioAt();
    let w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    const go = (url) => { try { if (w && !w.closed) w.location.href = url; else window.open(url, '_blank', 'noopener'); } catch (e) { /* the address is in the Houdini box */ } };
    const ctx = S.ctx;
    if (!ctx || !at) { go(`${at}/`); say(n, words); return; }
    ctx.fetch(`/api/panel/studio/open${S.project ? `?project=${encodeURIComponent(S.project)}` : ''}`, { method: 'POST' }).then((r) => r.json().catch(() => null)).then((b) => {
      const t = b && b.ok === true && b.target ? b.target : null;
      if (t && t.ok === true && typeof t.url === 'string') { go(t.url); say(n, words); return; }
      go(`${at}/`);
      say(n, `${words} ${t && typeof t.why === 'string' ? t.why : 'The companion could not make a grant for Studio: its page says what to type in Timmy.'}`);
    }).catch(() => { go(`${at}/`); say(n, words); });
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
      // R11 round 7 (H176): the sources (read only) beside the meshes, at most every LIST_AT_LEAST_MS or on a new frame
      if (!S.sources || rev !== S.revision || now - S.sourcesAt >= LIST_AT_LEAST_MS) void refreshSources();
      if (S.list && now - S.listAt < LIST_EVERY_MS) return undefined;
      if (S.list && rev === S.revision && now - S.listAt < LIST_AT_LEAST_MS) return undefined;
      S.revision = rev;
      return refreshList();
    },
  });
})();
