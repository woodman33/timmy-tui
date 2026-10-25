// R6 (H145): the Studio panel (tab 4; reference 06), drawn into data-panel-host="studio" (panels.js says how a panel registers
// and what it is given). Its routes are src/companion/panels/studio.ts; what they answer is read from the shown project's own
// board as Studio last saved it (src/studio/board-items.ts).
//
// What is on the board, in reading order (page by page, top to bottom, left to right): the artifact cards (a VoxVision record,
// an operation's run, a receipt), the reference images, Timmy's cards, and the words on it, each with its page, its draft mark
// (a draft of Timmy's waiting for Accept or Discard in Studio), its thumbnail and what it opens:
//   a VoxVision record    button data-open-vox="<id>": the page opens it in tab 5 (companion.js's own click handler)
//   an operation          button data-open-run="<op>": the page opens its run in Workflows (tab 3), at /run/<op>
//   a receipt             Studio's receipt page, linked on this computer only (from a phone, its address is said)
//   a thumbnail           button data-enlarge="<its words>" around it: the page shows the image at size (panels.js)
// Another project's card on this board is named as kept apart, and nothing of it is read. Thumbnails come through the panels'
// routes with the page's token in a header and are shown as data: images (the page's policy allows those). Every word drawn is
// the board's or the route's; nothing here invents a value. The panel reads again every few seconds while its tab is on screen,
// and drops an answer that comes back after the page changed project.
//
// R11 round 7 (H176; the operator's order "finish the product experience", SHELL CONTRACT v1): the page is Canvas on the scaffold.
// It registers itself with the shell (the shell's own words for the page — the rail's number, SHAPE THE WORK, "A workspace you can
// think in." — stand; the one primary next action Open Timmy Studio; the selected item as the page's context), its dock holds the
// page's tools (Open Timmy Studio · Read the board again), its records the
// board's revision, where Studio answers and the Houdini starters New board offers; the empty, content and error states are the
// shell's (an unreadable board is the error state, with Read again as its next action). The work stays the list: a row chosen
// (a click, Enter) is the selected item, drawn in the context column with its links. Without the shell (a page before it lands)
// the panel draws its own head, dock, context and records inside its host, so the page reads the same.
(() => {
  'use strict';
  if (typeof TimmyPanels === 'undefined') return;

  const EVERY_MS = 4000;
  const AT_LEAST_MS = 1500;
  const CACHE_MAX = 48;
  const HERE = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(location.hostname);
  // R11 round 7 (H176): the page's own sheet (src/companion/client/panel-studio.css; src/companion/server.ts serves it beside
  // companion.css). index.html links it once the shell's lines land; until then, and on any page without the line, the panel asks
  // for it itself (the same file once: never a second link), so the list's flex chain holds in every order the branches land.
  (function ensureSheet(href) {
    try {
      if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.dataset.panelSheet = 'studio';
      document.head.appendChild(link);
    } catch (e) { /* the page keeps companion.css's boxes */ }
  })('/panel-studio.css');
  const SUB_WORDS = {
    vox: 'VoxVision record', run: 'operation', receipt: 'receipt', workflow: 'workflow', params: 'parameters', result: 'result', flow: 'flow',
    note: 'note', text: 'text', geo: 'shape', frame: 'frame',
  };

  const S = { project: null, host: null, root: null, ctx: null, at: 0, sig: '', answer: null, asking: null, ticket: 0, thumbs: new Map(), timer: null,
    // R11 round 7 (H176): the selected item (its shape id), drawn in the page's context; what the page last registered with the shell
    selected: '', pageSig: '',
    // the board page the map draws (chosen by its tab; else the selected item's page, else the fullest)
    mapPage: '',
    // why the last Open Timmy Studio opened the plain address (no grant could be made), said in the records
    openWhy: '' };
  /** The shell, when it is on the page (SHELL CONTRACT v1); null before it lands: the panel then draws its own head, dock, context and records. */
  const shell = () => (typeof window.TimmyShell === 'object' && window.TimmyShell && typeof window.TimmyShell.page === 'function' ? window.TimmyShell : null);
  /** The page's section on the scaffold (its dock, context and records), or null. */
  const section = () => (S.host ? S.host.closest('section.page[data-page="canvas"], section[data-page="canvas"]') : null);
  const region = (cls) => { const sec = section(); return sec ? sec.querySelector(`.${cls}`) : null; };

  const put = (el, ...kids) => { if (el) el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  const q = (name) => (S.root ? (S.root.matches(`[data-studio="${name}"]`) ? S.root : S.root.querySelector(`[data-studio="${name}"]`)) : null);
  const pageProject = () => document.getElementById('project')?.dataset.project || '';
  const when = (iso) => {
    const t = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return Number.isNaN(t.getTime()) ? String(iso || '') : `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** What kind of thing an item is, in words (its head line). */
  function kindWords(it) {
    const sub = SUB_WORDS[it.sub] || it.sub || '';
    if (it.kind === 'artifact') return `artifact · ${sub || 'record'}`;
    if (it.kind === 'reference') return 'reference image';
    if (it.kind === 'card') return `card · ${sub || 'card'}`;
    if (it.kind === 'words') return sub || 'words';
    if (it.kind === 'image') return 'image';
    if (it.kind === 'other-project') return 'kept apart';
    return it.kind;
  }

  /** The board's counts in words: "2 artifacts · 1 reference image · 3 notes and texts". */
  function countWords(c) {
    const parts = [];
    if (c.artifact) parts.push(plural(c.artifact, 'artifact', 'artifacts'));
    if (c.reference) parts.push(plural(c.reference, 'reference image', 'reference images'));
    if (c.card) parts.push(plural(c.card, 'card', 'cards'));
    if (c.image) parts.push(plural(c.image, 'image', 'images'));
    if (c.words) parts.push(`${c.words} with words (notes, texts, frames)`);
    if (c['other-project']) parts.push(`${c['other-project']} of another project, kept apart`);
    return parts.join(' · ');
  }

  function reset(project) {
    S.project = project; S.ticket += 1; S.answer = null; S.sig = ''; S.at = 0; S.root = null; S.selected = ''; S.pageSig = ''; S.mapPage = ''; S.openWhy = '';
    S.thumbs.clear();
  }

  function skeleton(h) {
    const root = h('div', { class: 'sb-page', 'data-studio': 'page' },
      // the panel's own head, drawn only while the shell is not on the page (the shell's page head replaces it)
      // (the page's words are the shell's: PAGES canvas — a page without the shell has no rail number, so the kicker names the page)
      shell() ? null : h('header', { class: 'sb-page-head', 'data-studio': 'head' },
        h('p', { class: 'sb-page-kicker' }, 'CANVAS / SHAPE THE WORK'),
        h('h2', { class: 'sb-page-title' }, 'A workspace you can think in.'),
        h('p', { class: 'sb-page-intro' }, 'Arrange references, parameters and results on a persistent project canvas.')),
      h('div', { class: 'sb-body' },
        h('section', { class: 'box sb-box', 'aria-labelledby': 'studio-board-title', 'data-studio': 'root' },
          h('h2', { class: 'box-title', id: 'studio-board-title', 'data-studio': 'title' }, 'On the board'),
          h('div', { class: 'box-body' },
            h('p', { class: 'sb-summary', 'data-studio': 'summary', role: 'status' }, 'Reading the board…'),
            // R11 round 7 (H176; the lead's D14 R88): the board's map — each item where it sits on its page, drawn from the saved
            // board (the preview, since the Studio itself cannot be embedded here: the companion's page policy frames only itself)
            h('div', { class: 'sb-map', 'data-studio': 'map', hidden: true }),
            h('ol', { class: 'sb-list', 'data-studio': 'list' }),
            h('p', { class: 'sb-foot', 'data-studio': 'foot' }))),
        // the selected item's context, drawn here while the shell's context column is not on the page
        shell() ? null : h('aside', { class: 'box sb-context', 'data-studio': 'context-own', 'aria-label': 'The selected item' },
          h('h2', { class: 'box-title' }, 'Selected'), h('div', { class: 'box-body', 'data-studio': 'context' }, h('p', { class: 'empty' }, 'Choose an item on the board: its links and words show here.')))),
      shell() ? null : h('div', { class: 'sb-dock', 'data-studio': 'dock-own' }, h('span', { class: 'sb-dock-label' }, 'CANVAS TOOLS'), h('span', { 'data-studio': 'dock' })),
      shell() ? null : h('div', { class: 'sb-records', 'data-studio': 'records-own' }));
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    return root;
  }

  /** The page on the scaffold (SHELL CONTRACT v1 §2.3): its head, the one primary next action, the state; drawn again as the board is read. */
  function registerPage() {
    const sh = shell();
    if (!sh) return;
    const a = S.answer;
    const studio = String((a && a.studio) || '').replace(/\/+$/, '');
    const name = a && a.project ? a.project.name : 'this project';
    const state = !a ? 'content' : a.board.unreadable ? 'error' : !a.items.length ? 'empty' : 'content';
    // registered again only as what it says changes (the shell redraws the head and dock on each call: a reading every few
    // seconds that says the same must not take a focused button away)
    const sig = JSON.stringify([studio, name, state]);
    if (sig === S.pageSig) return;
    S.pageSig = sig;
    try {
      // (no kicker, title or intro of the panel's own: the shell's words for Canvas stand, with the rail's number)
      sh.page('canvas', {
        primary: HERE && studio
          ? { label: 'Open Timmy Studio', run: () => openStudio() }
          : { label: 'Open Timmy Studio', disabled: true, why: studio ? `Studio runs on the computer that runs Timmy: open ${studio}/ there` : 'Studio\'s address is not known yet' },
        context: 'selection',
        dock: 'CANVAS TOOLS',
      });
      if (!a) sh.state('canvas', 'content');
      else if (a.board.unreadable) sh.state('canvas', 'error', { words: `${name}'s saved board could not be read, so nothing of it is listed. Studio keeps such a file aside when it opens the board; nothing was changed here.`, next: { label: 'Read the board again', run: () => { S.sig = ''; void read(); } } });
      else if (!a.items.length) sh.state('canvas', 'empty', { words: `Nothing on ${name}'s board yet. In Studio, its side panel places the project's artifacts, reference images and nodes on it, and New board opens a guided starter.`, next: HERE && studio ? { label: 'Open Timmy Studio', run: () => openStudio() } : undefined });
      else sh.state('canvas', 'content');
    } catch (e) { /* the shell's registration is a courtesy: the panel's own work is drawn either way */ }
  }

  /**
   * R11 round 7 (H176; D14 R88): Open Timmy Studio opens a page that LOADS: the window is opened in the click (so no blocker stops
   * it), then the companion is asked for the Studio's address with a one-time grant (POST /api/panel/studio/open: made when the
   * Studio's token file is in this Timmy home), and the window goes there; without a grant it goes to the Studio's plain address,
   * which says what to type in Timmy, and the page's band says why.
   */
  function openStudio() {
    const a = S.answer;
    const studio = String((a && a.studio) || '').replace(/\/+$/, '');
    let w = null;
    try { w = window.open('', '_blank'); } catch (e) { w = null; }
    const go = (url) => { try { if (w && !w.closed) w.location.href = url; else window.open(url, '_blank', 'noopener'); } catch (e) { /* the address is in the records */ } };
    const ctx = S.ctx;
    if (!ctx || !studio) { go(`${studio}/`); return; }
    ctx.fetch(ctx.api('open'), { method: 'POST' }).then((r) => r.json().catch(() => null)).then((b) => {
      const t = b && b.ok === true && b.target ? b.target : null;
      if (t && t.ok === true && typeof t.url === 'string') { go(t.url); return; }
      go(`${studio}/`);
      const why = t && typeof t.why === 'string' ? t.why : 'The companion could not make a grant for Studio.';
      S.openWhy = why;
      drawRecords(ctx.h);
      try { if (shell()) shell().toast(why); } catch (e) { /* the records say it */ }
    }).catch(() => go(`${studio}/`));
  }

  /** The page's tools, in the shell's dock when it is there (else the panel's own row): Read the board again (Open Timmy Studio is the page's primary). */
  function drawDock(h) {
    const a = S.answer;
    const studio = String((a && a.studio) || '').replace(/\/+$/, '');
    // the shell's dock keeps a slot for the page's own tools (.dock-tools, beside its label and the frame's strip); without the shell, the panel's own row
    const shellDock = region('page-dock');
    const dock = (shellDock && (shellDock.querySelector(':scope > .dock-tools') || shellDock)) || (S.root && S.root.querySelector('[data-studio="dock"]'));
    if (!dock) return;
    const own = dock.querySelector('[data-studio-dock="canvas"]');
    // (the lead's D14 R88: ONE way to open Studio — the page's primary next action; the dock holds the page's other tool only)
    void studio;
    const tools = h('span', { 'data-studio-dock': 'canvas', class: 'sb-tools' },
      h('button', { type: 'button', class: 'dock-btn btn-action tiny', 'data-studio-act': 'again', title: 'Reads the board from Timmy\'s home again' }, 'Read the board again'));
    if (own) own.replaceWith(tools); else dock.append(tools);
  }

  /** The page's records: the board's revision and where it is saved, Studio's address, the starters New board offers (quiet, expandable). */
  function drawRecords(h) {
    const a = S.answer;
    const host = region('page-records') || (S.root && S.root.querySelector('[data-studio="records-own"]'));
    if (!host || !a) return;
    const studio = String(a.studio || '').replace(/\/+$/, '');
    const own = host.querySelector('[data-studio-records="canvas"]');
    const rec = h('details', { class: 'records sb-rec', 'data-studio-records': 'canvas' },
      h('summary', null, `Records · revision ${a.board.revision ?? 'none'}${a.board.savedAt ? `, saved ${when(a.board.savedAt)}` : ''}`),
      h('p', { class: 'sb-rec-line' }, a.board.unreadable ? 'The saved board could not be read.' : `${a.project.name}'s board, as Studio last saved it: ${countWords(a.counts) || 'nothing on it'}${a.drafts.length ? ` · ${plural(a.drafts.length, 'draft', 'drafts')} waiting for Accept or Discard in Studio` : ''}.`),
      a.oldLayout ? h('p', { class: 'sb-rec-line' }, a.oldLayout) : null,
      h('p', { class: 'sb-rec-line' }, 'Studio: ', h('code', { class: 'sb-addr' }, `${studio}/`), HERE ? ' (Open Timmy Studio, above, opens it with a one-time grant when the Studio\'s token file is in this Timmy home)' : ' on the computer that runs Timmy'),
      S.openWhy ? h('p', { class: 'sb-rec-line sb-rec-muted', 'data-studio': 'open-why' }, S.openWhy) : null,
      Array.isArray(a.starters) && a.starters.length ? h('details', { class: 'ui-details sb-starters' }, h('summary', null, `Houdini starters New board offers (${a.starters.length})`),
        h('ul', { class: 'sb-starter-list' }, a.starters.map((t) => h('li', { 'data-studio-starter': t.id }, h('strong', null, t.title), ' — ', t.steps.join(' · '), '. ', h('span', { class: 'sb-rec-muted' }, t.intro))))) : null);
    if (own) own.replaceWith(rec); else host.append(rec);
  }

  /** The selected item in the page's context (the shell's column, else the panel's own box): its kind, words, page and links. */
  function drawContext(h) {
    const a = S.answer;
    const host = region('page-context') || (S.root && S.root.querySelector('[data-studio="context"]'));
    if (!host) return;
    const it = a && a.items.find((x) => x.shape === S.selected);
    const own = host.querySelector('[data-studio-context="canvas"]');
    const box = h('div', { 'data-studio-context': 'canvas', class: 'sb-ctx' },
      !it ? h('p', { class: 'empty', 'data-studio': 'context-empty' }, a && a.items.length ? 'Choose an item on the board (a click, or Enter on its row): its links and words show here.' : 'Nothing to choose yet.') : [
        h('p', { class: 'sb-kind' }, kindWords(it)),
        h('p', { class: 'sb-ctx-title' }, it.title),
        it.excerpt && it.excerpt !== it.title ? h('p', { class: 'sb-excerpt' }, it.excerpt) : null,
        h('p', { class: 'sb-where' }, `on ${it.page}`),
        it.draft ? h('p', { class: 'sb-draft' }, `Timmy's draft ${it.draft}: waiting for your Accept or Discard in Studio.`) : null,
        it.fake ? h('p', { class: 'sb-fake' }, 'FAKE: made by a test double, as its record says.') : null,
        actsOf(it, h),
        it.ref ? h('details', { class: 'ui-details' }, h('summary', null, 'Details'), h('p', { class: 'sb-rec-muted' }, `${it.ref.path} · ${it.ref.bytes} bytes · sha256 ${it.ref.sha256.slice(0, 12)}… · from ${it.ref.from}`)) : null,
        h('details', { class: 'ui-details' }, h('summary', null, 'Details'), h('p', { class: 'sb-rec-muted' }, `shape ${it.shape}`)),
      ]);
    if (own) own.replaceWith(box); else host.append(box);
  }

  function select(shape) {
    S.selected = shape === S.selected ? '' : shape;
    for (const li of S.root ? S.root.querySelectorAll('[data-shape]') : []) li.setAttribute('aria-current', li.dataset.shape === S.selected ? 'true' : 'false');
    drawContext(S.ctx.h);
  }

  // ── R11 round 7 (H176; D14 R88): the board's map — the page's work beside the list ──
  /** An item's box on its page as the map draws it: a shape without a size gets a card's (notes and texts carry none in the record). */
  const MAP_DEFAULT = { w: 200, h: 120 };
  const boxOf = (it) => { const b = it.box || { x: 0, y: 0, w: 0, h: 0 }; return { x: b.x, y: b.y, w: b.w > 0 ? b.w : MAP_DEFAULT.w, h: b.h > 0 ? b.h : MAP_DEFAULT.h }; };
  /** The pages of the board with their items, in the board's order. */
  function mapPages(a) {
    const pages = new Map();
    for (const it of a.items) { if (!pages.has(it.page)) pages.set(it.page, []); pages.get(it.page).push(it); }
    return [...pages.entries()].map(([name, items]) => ({ name, items }));
  }
  /** The page the map draws: the one chosen by its tab, else the selected item's, else the fullest. */
  function mapPage(a) {
    const pages = mapPages(a);
    if (!pages.length) return null;
    const asked = S.mapPage && pages.find((p) => p.name === S.mapPage);
    const withSelected = S.selected && pages.find((p) => p.items.some((it) => it.shape === S.selected));
    return asked || withSelected || pages.reduce((best, p) => (p.items.length > best.items.length ? p : best), pages[0]);
  }
  /** The map: an SVG of the chosen page (its items as boxes, labelled where they are wide enough), the page tabs when the board has more than one. */
  function drawMap(h) {
    const a = S.answer;
    const host = q('map');
    if (!host) return;
    const page = a && !a.board.unreadable ? mapPage(a) : null;
    if (!page) { host.hidden = true; put(host); return; }
    const pages = mapPages(a);
    const boxes = page.items.map((it) => ({ it, b: boxOf(it) }));
    const pad = 48;
    const minX = Math.min(...boxes.map((x) => x.b.x)) - pad;
    const minY = Math.min(...boxes.map((x) => x.b.y)) - pad;
    const maxX = Math.max(...boxes.map((x) => x.b.x + x.b.w)) + pad;
    const maxY = Math.max(...boxes.map((x) => x.b.y + x.b.h)) + pad;
    const w = Math.max(1, maxX - minX);
    const ht = Math.max(1, maxY - minY);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'sb-map-svg');
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${ht}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `The board's page ${page.name}: ${plural(page.items.length, 'item', 'items')} where they sit`);
    svg.dataset.page = page.name;
    // the page's ground and the items, each a box with its kind; the words are the list's (the map says where, the list what)
    const ground = document.createElementNS(ns, 'rect');
    ground.setAttribute('class', 'sb-map-ground');
    ground.setAttribute('x', String(minX)); ground.setAttribute('y', String(minY)); ground.setAttribute('width', String(w)); ground.setAttribute('height', String(ht));
    svg.append(ground);
    // a label's size follows the page's scale (about 14 px on screen for a page 1600 units wide shown at ~600 px)
    const unit = Math.max(10, Math.round(w / 48));
    for (const { it, b } of boxes) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `sb-map-item kind-${it.kind}${it.draft ? ' is-draft' : ''}${it.shape === S.selected ? ' is-selected' : ''}`);
      g.dataset.shape = it.shape;
      g.dataset.kind = it.kind;
      g.setAttribute('role', 'button');
      g.setAttribute('tabindex', '0');
      g.setAttribute('aria-label', `${kindWords(it)}: ${it.title}${it.draft ? ' (a draft waiting in Studio)' : ''}`);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(b.x)); r.setAttribute('y', String(b.y)); r.setAttribute('width', String(b.w)); r.setAttribute('height', String(b.h));
      r.setAttribute('rx', String(Math.round(unit * 0.6)));
      g.append(r);
      if (b.w >= unit * 6 && b.h >= unit * 1.8) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', String(b.x + unit * 0.8)); t.setAttribute('y', String(b.y + unit * 1.6));
        t.setAttribute('font-size', String(unit));
        const room = Math.max(3, Math.floor((b.w - unit * 1.6) / (unit * 0.56)));
        const words = Array.from(it.title || kindWords(it));
        t.textContent = words.length > room ? `${words.slice(0, Math.max(1, room - 1)).join('')}…` : words.join('');
        g.append(t);
      }
      svg.append(g);
    }
    const tabs = pages.length > 1 ? h('div', { class: 'sb-map-pages', role: 'tablist', 'aria-label': 'The board\'s pages' },
      pages.map((p) => h('button', { type: 'button', role: 'tab', class: 'sb-map-page', 'data-map-page': p.name, 'aria-selected': p.name === page.name ? 'true' : 'false' }, `${p.name} · ${p.items.length}`))) : null;
    put(host, tabs, svg, h('p', { class: 'sb-map-foot' }, `The board as Studio last saved it, page ${page.name}: ${plural(page.items.length, 'item', 'items')} where they sit (a drawing of the saved board, not the live canvas; a box names its item in the list).`));
    host.hidden = false;
  }
  function onClick(event) {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) return;
    if (t.closest('[data-studio-act="again"]')) { S.sig = ''; void read(); return; }
    // the map: a box chooses its item (and brings its row into view); a page tab chooses the page drawn
    const tab = t.closest('[data-map-page]');
    if (tab) { S.mapPage = tab.dataset.mapPage; drawMap(S.ctx.h); return; }
    const box = t.closest('.sb-map-item[data-shape]');
    if (box) {
      select(box.dataset.shape);
      drawMap(S.ctx.h);
      const row = S.root && S.root.querySelector(`.sb-item[data-shape="${CSS.escape(box.dataset.shape)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
    // a row chosen (not one of its own controls: Open in VoxVision, Open run, a receipt link, a thumbnail)
    if (t.closest('button, a, summary')) return;
    const row = t.closest('[data-shape]');
    if (row) { select(row.dataset.shape); drawMap(S.ctx.h); }
  }
  function onKey(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const t = event.target instanceof Element ? event.target : null;
    if (!t || !t.matches('[data-shape]')) return;
    event.preventDefault();
    select(t.dataset.shape);
    drawMap(S.ctx.h);
  }

  // ── reading ──
  async function read() {
    // one read at a time for the project shown; a read still out for the project before does not hold this one up
    if (S.asking && S.asking.ticket === S.ticket) return S.asking.promise;
    const ctx = S.ctx;
    const mine = S.ticket;
    const project = S.project;
    S.at = Date.now();
    const promise = (async () => {
      let body = null;
      let status = 0;
      try {
        const r = await ctx.fetch(ctx.api('board'));
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (e) { body = null; }
      // an answer that comes back after the page changed project is dropped: it is never drawn under another project's name
      if (mine !== S.ticket || (project && pageProject() && pageProject() !== project)) return;
      if (!body || body.ok !== true) {
        S.sig = '';
        put(q('summary'), `✕ The board could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`);
        q('summary')?.classList.add('tone-failed');
        put(q('list'));
        const sh = shell();
        if (sh) { try { sh.state('canvas', 'error', { words: `The board could not be read: ${(body && body.error) || (status ? `the companion answered HTTP ${status}` : 'the companion did not answer')}.`, next: { label: 'Read the board again', run: () => { S.sig = ''; void read(); } } }); } catch (e) { /* the summary says it */ } }
        return;
      }
      if (project && body.project && body.project.id !== project) return;
      const sig = JSON.stringify([body.project, body.board, body.items, body.counts, body.drafts, body.more, body.studio, body.oldLayout]);
      if (sig === S.sig) return;
      S.sig = sig;
      S.answer = body;
      draw();
    })().finally(() => { if (S.asking && S.asking.promise === promise) S.asking = null; });
    S.asking = { ticket: mine, promise };
    return promise;
  }

  /** A thumbnail as a data: URL (fetched with the token; kept for the next draw of this project). */
  async function thumbData(src) {
    if (S.thumbs.has(src)) return S.thumbs.get(src);
    const ctx = S.ctx;
    const project = S.project;
    const r = await ctx.fetch(`${src}${project ? `${src.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}` : ''}`);
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
    if (project !== S.project) throw new Error('the page shows another project now');
    if (S.thumbs.size >= CACHE_MAX) S.thumbs.delete(S.thumbs.keys().next().value);
    S.thumbs.set(src, url);
    return url;
  }

  // ── drawing ──
  function thumbOf(it, h) {
    if (!it.thumb) return null;
    const words = `${it.title} · ${it.thumb.path} (${kindWords(it)} on ${S.answer.project.name}'s board)`;
    const img = h('img', { class: 'sb-img', alt: words, 'data-path': it.thumb.path });
    const btn = h('button', { type: 'button', class: 'sb-thumb', 'data-enlarge': words, title: `${words}: shown at size` }, img);
    const mine = S.ticket;
    thumbData(it.thumb.src).then((url) => { if (mine === S.ticket) img.src = url; }).catch((err) => {
      if (mine !== S.ticket) return;
      btn.replaceWith(h('span', { class: 'sb-thumb-failed', 'data-path': it.thumb.path, title: `not shown: ${err.message}` }, '✕ not shown'));
    });
    return btn;
  }

  function actsOf(it, h) {
    const t = it.target || {};
    const studio = String(S.answer.studio || '').replace(/\/+$/, '');
    const acts = [];
    if (t.vox) acts.push(h('button', { type: 'button', class: 'btn-action tiny sb-open', 'data-open-vox': t.vox, title: `Opens VoxVision record ${t.vox} in tab 5` }, `Open ${t.vox} in VoxVision`));
    if (t.run) acts.push(h('button', { type: 'button', class: 'btn-action tiny sb-open', 'data-open-run': t.run, title: `Opens run ${t.run} in Workflows` }, `Open run ${t.run}`));
    if (t.receipt) {
      const href = `${studio}/receipts/${encodeURIComponent(t.receipt)}`;
      acts.push(HERE
        ? h('a', { class: 'sb-link', 'data-receipt': t.receipt, href, target: '_blank', rel: 'noopener noreferrer' }, `Receipt ${t.receipt.slice(0, 8)} in Studio`)
        : h('span', { class: 'sb-addr', 'data-receipt': t.receipt }, `Receipt ${t.receipt.slice(0, 8)}: open ${href} on the computer that runs Timmy`));
    }
    return acts.length ? h('p', { class: 'sb-acts' }, acts) : null;
  }

  function itemOf(it, h) {
    // R11 round 7 (H176): a row is a choice (the selected item is the page's context): focusable, chosen by a click or Enter
    return h('li', { class: `sb-item kind-${it.kind}${it.thumb ? '' : ' no-thumb'}`, 'data-shape': it.shape, 'data-kind': it.kind, 'data-sub': it.sub || '', tabindex: '0', 'aria-current': it.shape === S.selected ? 'true' : 'false', title: 'Choose this item: its links and words show in the page\'s context' },
      thumbOf(it, h),
      h('div', { class: 'sb-text' },
        h('p', { class: 'sb-head' },
          h('span', { class: 'sb-kind' }, kindWords(it)),
          it.fake ? [' ', h('span', { class: 'sb-fake', title: 'made by a test double, as its record says' }, 'FAKE')] : null,
          it.draft ? [' ', h('span', { class: 'sb-draft', 'data-draft': it.draft, title: `${it.draft}: Timmy's draft, waiting for Accept or Discard in Studio` }, 'draft · waiting in Studio')] : null),
        h('p', { class: 'sb-title' }, it.title),
        it.excerpt && it.excerpt !== it.title ? h('p', { class: 'sb-excerpt' }, it.excerpt) : null,
        h('p', { class: 'sb-where' }, `on ${it.page}`),
        actsOf(it, h)));
  }

  function draw() {
    const h = S.ctx.h;
    const a = S.answer;
    const name = a.project.name;
    const studio = String(a.studio || '').replace(/\/+$/, '');
    // focus kept across a redraw: the same item's same control
    const f = document.activeElement;
    const kept = f && S.root && S.root.contains(f) && f.closest('[data-shape]')
      ? { shape: f.closest('[data-shape]').dataset.shape, cls: ['sb-thumb', 'sb-open', 'sb-link'].find((c) => f.classList.contains(c)) || '', attr: f.getAttribute('data-open-vox') ?? f.getAttribute('data-open-run') ?? '' }
      : null;
    put(q('title'), `On ${name}'s board`);
    const summary = q('summary');
    summary?.classList.remove('tone-failed');
    if (a.board.unreadable) {
      put(summary, `${name}'s saved board could not be read, so nothing of it is listed here. Studio keeps such a file aside when it opens the board; nothing was changed here.`);
      summary?.classList.add('tone-failed');
    } else if (!a.board.revision && !a.items.length) {
      put(summary, `Nothing on ${name}'s board yet. In Studio, its side panel places the project's artifacts and reference images on it (each project has its own board).`);
    } else if (!a.items.length) {
      put(summary, `${name}'s own board, as Studio last saved it (revision ${a.board.revision}${a.board.savedAt ? `, ${when(a.board.savedAt)}` : ''}): nothing on it.`);
    } else {
      const waiting = a.drafts.length ? ` ${plural(a.drafts.length, 'draft', 'drafts')} of Timmy's waiting for Accept or Discard in Studio.` : '';
      put(summary, `${name}'s own board, as Studio last saved it (revision ${a.board.revision}${a.board.savedAt ? `, ${when(a.board.savedAt)}` : ''}): ${countWords(a.counts)}.${waiting}`);
    }
    drawMap(h);
    put(q('list'), a.items.map((it) => itemOf(it, h)));
    put(q('foot'),
      a.more ? `${a.more} more on the board are not listed (the first ${a.items.length}, in reading order). ` : null,
      a.oldLayout ? `${a.oldLayout} ` : null,
      HERE ? null : `Studio: open ${studio}/ on the computer that runs Timmy.`);
    if (kept) {
      const li = S.root.querySelector(`[data-shape="${CSS.escape(kept.shape)}"]`);
      const el = li && (kept.cls ? [...li.querySelectorAll(`.${kept.cls}`)].find((e) => !kept.attr || e.getAttribute('data-open-vox') === kept.attr || e.getAttribute('data-open-run') === kept.attr) : null);
      if (el) el.focus({ preventScroll: true });
    }
    // R11 round 7 (H176): the page on the scaffold follows the board: its state, its dock, its records, its context
    if (S.selected && !a.items.some((it) => it.shape === S.selected)) S.selected = '';
    registerPage();
    drawDock(h);
    drawRecords(h);
    drawContext(h);
  }

  /** Read again every few seconds while the tab is on screen and the page is visible (the frame alone may not change). */
  function ensureTimer() {
    if (S.timer) return;
    S.timer = setInterval(() => {
      if (!S.root || !S.host || !S.ctx || document.hidden || S.host.closest('[hidden]') || !S.host.contains(S.root)) return;
      read();
    }, EVERY_MS);
  }

  TimmyPanels.register('studio', {
    draw(host, frame, ctx) {
      S.ctx = ctx;
      S.host = host;
      if (!ctx.own) {
        reset(null);
        put(host, ctx.h('p', { class: 'empty', 'data-studio': 'not-own' }, 'Not shown: the frame is another project\'s, so no board is read here.'));
        return undefined;
      }
      if (S.project !== ctx.project || !S.root || !host.contains(S.root)) {
        reset(ctx.project);
        S.root = skeleton(ctx.h);
        put(host, S.root);
        registerPage();
      }
      ensureTimer();
      if (S.answer && Date.now() - S.at < AT_LEAST_MS) return undefined;
      return read();
    },
  });
})();
