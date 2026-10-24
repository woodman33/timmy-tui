// R11 round 7 (H173): the FILES page — "Everything this project holds." Read-only: the project's folder listed, a text or an
// image opened beside it, a file handed to Chat as an attachment, and where the project lives behind Details.
//
//   THE ROUTES (src/companion/workspace.ts mountFiles; FILES ROUTE v1 in the handoff): GET /api/files?project&path (the
//   listing: entries with kind/view/size/mtime, heavy folders marked, links out as "other"), GET /api/files/file?project&path
//   (a text as JSON, an image as bytes, anything else 415 in words). Both through TimmyShell.fetch (the launch token, the
//   session; a 401 { needs: 'session' } is the shell's); the project is the one the page shows (?project=<id>), else the
//   user's default / the operator's followed project (the server's rule, identity.projectFor).
//   THE SCAFFOLD (H175's SHELL CONTRACT v1 §2): section#ws-files.page[data-page="files"] — the shell draws .page-head (the
//   kicker, title, intro and the ONE primary action from TimmyShell.page('files', …)) and the band's three cells (this page
//   adds a Files cell); this page draws its listing into [data-panel-host="files"] (TimmyPanels.register('files', …): drawn
//   when the page is shown and when a frame arrives), the selected file into the section's .page-context (context:
//   'selection'; a sheet on a phone), its tools as .dock-btn buttons in .page-dock, and where the project lives as
//   <details class="records"> in .page-records. States through TimmyShell.state('files', …): empty (verb-led: start a
//   conversation; add files to the folder) · content · error (the words, Retry). Where the shell has none of that (an older
//   shell, a test's FAKE), the same regions are found or made and the head is drawn here, so the page is whole on any host.
//   THE ATTACHMENT (for H171's Chat): "Attach to Chat" dispatches window 'timmy:attach' with detail { project, path, name,
//   size, view } — the same { project, path } the routes take — then goes to Chat; nothing is read here for it.
(() => {
  'use strict';
  const PAGE = 'files';
  const S = () => window.TimmyShell;
  const h = (...a) => S().h(...a);
  const WORDS = {
    kicker: '02 / OPEN THE PROJECT’S FILES',
    title: 'Everything this project holds.',
    intro: 'Browse the project’s folder, open a text or an image beside it, and hand a file to the conversation.',
    primaryIdle: 'Open Chat',
    primaryAttach: 'Attach to Chat',
    dock: 'FILE TOOLS',
    loading: 'Reading the project’s folder…',
    emptyTitle: 'No files yet.',
    empty: 'This project has nothing in its folder yet. Start a conversation and Timmy’s work lands here, or add files to the folder yourself.',
    emptyFolder: 'This folder is empty.',
    errorTitle: 'The project’s files could not be read.',
    pickTitle: 'Open a file to see it here.',
    pick: 'A text shows as text, an image as an image; anything else says what it is.',
    binary: 'This file is neither text nor an image this page shows, so it is not opened here. Its size and place are shown; a tool of a turn can still read it.',
    attach: 'Hand this file to the conversation: Timmy reads it as part of your next turn.',
    where: 'Where this project lives',
    recordsNote: 'Local first: the project’s files, conversations and receipts have one home on this computer.',
    truncated: (n) => `The first ${n} are shown; open a folder to see what it holds.`,
  };

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let section = null;           // the page's section (the scaffold), or the host when there is none
  let regions = null;           // { head, band, work, context, dock, records }
  let project = '';             // the project id the listing was asked for ('' = the default)
  let listing = null;           // the last GET /api/files answer
  let path = '';                // the folder shown
  let state = 'loading';        // loading | content | empty | error
  let error = '';
  let selected = null;          // the selected entry (a file)
  let opened = null;            // { path, kind, text?, truncated?, url?, words? } of the selected file, once read
  let opening = 0;              // the sequence of the read in flight
  let imageUrl = '';            // the blob URL of the image shown (revoked when another file is shown)
  let ctxProject = '';          // the project the panel registry named on the last draw

  const shownProject = () => {
    if (ctxProject) return ctxProject;
    const s = S();
    try { if (s && typeof s.project === 'function') { const p = s.project(); if (p && p.id) return String(p.id); } } catch (e) { /* the shell's own */ }
    const el = document.getElementById('project');
    return (el && el.dataset && el.dataset.project) || '';
  };
  const q = () => `/api/files?${project ? `project=${encodeURIComponent(project)}&` : ''}path=${encodeURIComponent(path)}`;
  const fileQ = (rel) => `/api/files/file?${project ? `project=${encodeURIComponent(project)}&` : ''}path=${encodeURIComponent(rel)}`;
  const phone = () => { try { return window.matchMedia('(max-width: 720px)').matches; } catch (e) { return false; } };

  const sizeWords = (n) => {
    if (typeof n !== 'number') return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };
  const whenWords = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
    if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const kindWords = (e) => (e.kind === 'dir' ? (e.heavy ? 'Folder · large' : 'Folder') : e.kind === 'other' ? 'Not the project’s (a link out)' : e.view === 'text' ? 'Text' : e.view === 'image' ? 'Image' : 'File');
  const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };

  // ── the regions of the scaffold (found on the section; made where the markup lacks them) ─────────────────────────────
  function region(root, cls, tag) {
    let el = root.querySelector(`.${cls}`);
    if (!el) { el = h(tag || 'div', { class: cls }); root.append(el); }
    return el;
  }
  function findRegions(host) {
    section = host.closest('section.page') || host.closest('[data-page]') || host;
    const work = host.matches('[data-panel-host]') ? host : (section.querySelector('[data-panel-host="files"]') || region(section, 'page-work'));
    regions = { head: region(section, 'page-head', 'header'), band: region(section, 'page-band'), work, context: region(section, 'page-context', 'aside'), dock: region(section, 'page-dock'), records: region(section, 'page-records') };
    if (!regions.context.getAttribute('aria-label')) regions.context.setAttribute('aria-label', 'The selected file');
  }
  const shellHasPages = () => Boolean(S() && typeof S().page === 'function');

  // ── reading ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function load() {
    if (!listing) { state = 'loading'; redraw(); }
    try {
      const r = await S().fetch(q());
      let body = null; try { body = await r.json(); } catch (e) { body = null; }
      if (r.status !== 200 || !body || !body.ok) { state = 'error'; error = (body && (body.words || body.error)) || `The companion answered HTTP ${r.status}.`; listing = null; redraw(); return; }
      listing = body;
      path = body.path || '';
      state = body.entries.length ? 'content' : 'empty';
      error = '';
      // a selection that is no longer listed is let go
      if (selected && !body.entries.some((e) => e.path === selected.path)) { selected = null; forgetOpened(); }
      redraw();
    } catch (e) { state = 'error'; error = `The project’s folder could not be read: ${e && e.message ? e.message : e}`; listing = null; redraw(); }
  }

  function forgetOpened() {
    opened = null; opening += 1;
    if (imageUrl) { try { URL.revokeObjectURL(imageUrl); } catch (e) { /* gone */ } imageUrl = ''; }
  }

  async function open(entry) {
    selected = entry;
    forgetOpened();
    if (entry.kind !== 'file') { redraw(); return; }
    const seq = ++opening;
    opened = { path: entry.path, kind: 'loading' };
    redraw();
    // on a phone the selected file is a sheet: opened for the person, closed by Escape or the scrim (the shell's rules)
    if (phone()) { try { if (typeof S().sheet === 'function') S().sheet('context', true); } catch (e) { /* no sheet here */ } }
    try {
      const r = await S().fetch(fileQ(entry.path));
      if (seq !== opening) return;
      const type = r.headers.get('content-type') || '';
      if (r.status === 200 && /^image\//.test(type)) {
        const blob = await r.blob();
        if (seq !== opening) return;
        imageUrl = URL.createObjectURL(blob);
        opened = { path: entry.path, kind: 'image', url: imageUrl, type };
      } else {
        let body = null; try { body = await r.json(); } catch (e) { body = null; }
        if (seq !== opening) return;
        if (r.status === 200 && body && body.kind === 'text') opened = { path: entry.path, kind: 'text', text: body.text, truncated: Boolean(body.truncated), size: body.size };
        else opened = { path: entry.path, kind: 'refused', words: (body && (body.words || body.error)) || `The companion answered HTTP ${r.status}.`, status: r.status };
      }
    } catch (e) { if (seq === opening) opened = { path: entry.path, kind: 'refused', words: `The file could not be read: ${e && e.message ? e.message : e}` }; }
    redraw();
  }

  function goTo(rel) { path = rel; selected = null; forgetOpened(); listing = null; load(); }
  function up() { if (listing && listing.parent !== null && listing.parent !== undefined) goTo(listing.parent); }

  function attach() {
    if (!selected || selected.kind !== 'file') return;
    const detail = { project: (listing && listing.project && listing.project.id) || project, path: selected.path, name: selected.name, size: selected.size, view: selected.view };
    try { window.dispatchEvent(new CustomEvent('timmy:attach', { detail })); } catch (e) { /* no CustomEvent here */ }
    S().toast(`${selected.name} goes with your next turn.`);
    try { S().go('chat', 'attach'); } catch (e) { /* no chat page here */ }
  }

  async function copyPath(text) {
    try { await navigator.clipboard.writeText(text); S().toast('Path copied.'); } catch (e) { S().toast('The path could not be copied here; it is shown under Details.'); }
  }

  // ── the registration (the shell draws the head and the band from it) ────────────────────────────────────────────────
  const primary = () => (selected && selected.kind === 'file' ? { label: WORDS.primaryAttach, run: attach } : { label: WORDS.primaryIdle, run: () => { try { S().go('chat', 'files'); } catch (e) { /* no chat page */ } } });
  const countWords = () => (listing ? `${listing.count}${listing.truncated ? '+' : ''} ${listing.count === 1 ? 'item' : 'items'}${path ? ` in ${path.split('/').pop()}` : ''}` : (state === 'error' ? 'not read' : '…'));
  function pageMeta() {
    const p = primary();
    return { kicker: WORDS.kicker, title: WORDS.title, intro: WORDS.intro, primary: { label: p.label, run: p.run, disabled: false }, context: 'selection', band: [{ k: 'Files', v: countWords() }], dock: WORDS.dock };
  }
  function register() {
    if (!shellHasPages()) return;
    try { S().page(PAGE, pageMeta()); } catch (e) { /* the shell's own */ }
    try {
      if (typeof S().state === 'function') {
        if (state === 'empty') S().state(PAGE, 'empty', { words: path ? WORDS.emptyFolder : WORDS.emptyTitle, next: path ? { label: 'Up one folder', run: up } : { label: 'Start a conversation', run: () => S().go('chat', 'files-empty') } });
        else if (state === 'error') S().state(PAGE, 'error', { words: error, next: { label: 'Retry', run: () => { listing = null; load(); } } });
        else S().state(PAGE, 'content');
      }
    } catch (e) { /* the shell's own */ }
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  function head() {
    // only where the shell has no page registration (an older shell, a test's FAKE): the same words the registration carries
    const p = primary();
    const btn = h('button', { type: 'button', class: 'ui-primary sh-btn-primary fs-primary', 'data-fs': 'primary' }, p.label, h('span', { 'aria-hidden': 'true' }, ' →'));
    btn.addEventListener('click', () => p.run());
    return [
      h('div', { class: 'page-head-words' }, h('p', { class: 'page-kicker' }, WORDS.kicker), h('h1', { class: 'page-title', tabindex: '-1' }, WORDS.title), h('p', { class: 'page-intro' }, WORDS.intro)),
      h('div', { class: 'page-primary' }, btn),
    ];
  }
  function band() {
    const name = (listing && listing.project && listing.project.name) || 'this project';
    return [
      h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Workspace'), h('strong', { class: 'band-v' }, name)),
      h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Files'), h('strong', { class: 'band-v' }, countWords())),
      h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, 'Records'), h('strong', { class: 'band-v' }, 'Local')),
    ];
  }

  function crumbs() {
    const parts = path ? path.split('/') : [];
    const nav = h('nav', { class: 'fs-crumbs', 'aria-label': 'Folder' });
    const rootBtn = h('button', { type: 'button', class: 'fs-crumb', 'aria-current': parts.length ? null : 'location' }, (listing && listing.project && listing.project.name) || 'Project');
    rootBtn.addEventListener('click', () => { if (path) goTo(''); });
    nav.append(rootBtn);
    parts.forEach((part, i) => {
      const rel = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      nav.append(h('span', { class: 'fs-crumb-sep', 'aria-hidden': 'true' }, '/'));
      const b = h('button', { type: 'button', class: 'fs-crumb', 'aria-current': last ? 'location' : null }, part);
      b.addEventListener('click', () => { if (!last) goTo(rel); });
      nav.append(b);
    });
    return nav;
  }

  function row(e) {
    const isSel = selected && selected.path === e.path;
    const b = h('button', { type: 'button', class: `fs-row fs-row-${e.kind}${e.view ? ` is-${e.view}` : ''}${isSel ? ' is-selected' : ''}`, 'aria-pressed': e.kind === 'file' ? (isSel ? 'true' : 'false') : null, 'data-path': e.path, title: e.kind === 'other' ? kindWords(e) : null },
      h('span', { class: 'fs-row-glyph', 'aria-hidden': 'true' }, e.kind === 'dir' ? '▸' : e.view === 'image' ? '▣' : e.view === 'text' ? '≡' : '·'),
      h('span', { class: 'fs-row-name' }, e.name),
      h('span', { class: 'fs-row-kind' }, kindWords(e)),
      h('span', { class: 'fs-row-size' }, e.kind === 'file' ? sizeWords(e.size) : ''),
      h('span', { class: 'fs-row-when' }, whenWords(e.mtime)));
    if (e.kind === 'dir') b.addEventListener('click', () => goTo(e.path));
    else if (e.kind === 'file') b.addEventListener('click', () => open(e));
    else b.disabled = true;
    return h('li', { role: 'listitem' }, b);
  }

  function work() {
    if (state === 'loading') return [h('p', { class: 'fs-state', role: 'status' }, WORDS.loading)];
    if (state === 'error') {
      const retry = h('button', { type: 'button', class: 'sh-btn', 'data-fs': 'retry' }, 'Retry');
      retry.addEventListener('click', () => { listing = null; load(); });
      return [h('div', { class: 'fs-state fs-error', role: 'alert' }, h('p', { class: 'fs-state-title' }, WORDS.errorTitle), h('p', { class: 'fs-note' }, error), h('div', { class: 'fs-actions' }, retry))];
    }
    const out = [crumbs()];
    if (state === 'empty') {
      const chat = h('button', { type: 'button', class: 'sh-btn', 'data-fs': 'empty-chat' }, 'Start a conversation', h('span', { 'aria-hidden': 'true' }, ' →'));
      chat.addEventListener('click', () => { try { S().go('chat', 'files-empty'); } catch (e) { /* no chat page */ } });
      const upBtn = path ? h('button', { type: 'button', class: 'sh-btn', 'data-fs': 'empty-up' }, 'Up one folder') : null;
      if (upBtn) upBtn.addEventListener('click', up);
      out.push(h('div', { class: 'fs-state fs-empty' },
        h('p', { class: 'fs-state-title' }, path ? WORDS.emptyFolder : WORDS.emptyTitle),
        h('p', { class: 'fs-note' }, path ? 'Nothing is in this folder yet.' : WORDS.empty),
        h('div', { class: 'fs-actions' }, path ? upBtn : chat)));
      return out;
    }
    out.push(h('ul', { class: 'fs-list', role: 'list', 'aria-label': `Files in ${path || 'the project'}` }, ...listing.entries.map(row)));
    if (listing.truncated) out.push(h('p', { class: 'fs-note fs-truncated' }, WORDS.truncated(listing.count)));
    return out;
  }

  function context() {
    if (!selected) return [h('div', { class: 'fs-ctx-empty' }, h('h2', { class: 'fs-ctx-title' }, WORDS.pickTitle), h('p', { class: 'fs-note' }, WORDS.pick))];
    const e = selected;
    const out = [h('h2', { class: 'fs-ctx-title' }, e.name), h('p', { class: 'fs-note fs-ctx-kind' }, `${kindWords(e)}${e.kind === 'file' ? ` · ${sizeWords(e.size)} · ${whenWords(e.mtime)}` : ''}`)];
    if (e.kind === 'file' && opened) {
      if (opened.kind === 'loading') out.push(h('p', { class: 'fs-state', role: 'status' }, 'Opening…'));
      else if (opened.kind === 'text') {
        out.push(h('pre', { class: 'fs-text', tabindex: '0', 'aria-label': `${e.name}, text` }, opened.text));
        if (opened.truncated) out.push(h('p', { class: 'fs-note' }, `The first 256 KB of ${sizeWords(opened.size)} are shown.`));
      } else if (opened.kind === 'image') out.push(h('figure', { class: 'fs-figure' }, h('img', { class: 'fs-image', src: opened.url, alt: e.name }), h('figcaption', { class: 'fs-note' }, `${e.name} · ${sizeWords(e.size)}`)));
      else out.push(h('p', { class: 'fs-note fs-refused', role: 'status' }, opened.words || WORDS.binary));
    }
    // a secondary here: the page's ONE primary is the head's, which says the same when a file is selected
    const attachBtn = h('button', { type: 'button', class: 'sh-btn is-wide', 'data-fs': 'attach', disabled: e.kind !== 'file' }, WORDS.primaryAttach, h('span', { 'aria-hidden': 'true' }, ' →'));
    attachBtn.addEventListener('click', attach);
    out.push(h('div', { class: 'fs-ctx-actions' }, attachBtn, h('p', { class: 'fs-note' }, WORDS.attach)));
    out.push(h('details', { class: 'ui-details fs-details' }, h('summary', null, 'Details'), h('dl', { class: 'fs-dl' },
      h('dt', null, 'Path in the project'), h('dd', { class: 'fs-mono' }, e.path),
      h('dt', null, 'Kind'), h('dd', null, `${e.kind}${e.view ? ` · ${e.view}` : ''}${extOf(e.name) ? ` · .${extOf(e.name)}` : ''}`),
      e.kind === 'file' ? h('dt', null, 'Size') : null, e.kind === 'file' ? h('dd', null, `${e.size} bytes`) : null,
      e.mtime ? h('dt', null, 'Modified') : null, e.mtime ? h('dd', { class: 'fs-mono' }, e.mtime) : null)));
    return out;
  }

  function dockButtons() {
    const upBtn = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-fs': 'up', disabled: !listing || listing.parent === null || listing.parent === undefined }, '↑ Up');
    upBtn.addEventListener('click', up);
    const refresh = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-fs': 'refresh' }, 'Refresh');
    refresh.addEventListener('click', () => load());
    const copy = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-fs': 'copy', disabled: !selected }, 'Copy path');
    copy.addEventListener('click', () => { if (selected) copyPath(selected.path); });
    const attachBtn = h('button', { type: 'button', class: 'dock-btn sh-btn', 'data-fs': 'dock-attach', disabled: !selected || selected.kind !== 'file' }, '＋ Attach');
    attachBtn.addEventListener('click', attach);
    return [upBtn, refresh, copy, attachBtn];
  }
  function dock() {
    // the page's own tools live in one group of the dock; the frame's actions (companion.js's #ws-strip) and the label are the shell's
    let group = regions.dock.querySelector('[data-dock-owner="files"]');
    if (!group) { group = h('span', { class: 'dock-group', 'data-dock-owner': 'files' }); regions.dock.append(group); }
    if (!shellHasPages() && !regions.dock.querySelector('.dock-label')) regions.dock.prepend(h('span', { class: 'dock-label' }, WORDS.dock));
    group.replaceChildren(...dockButtons());
  }
  function records() {
    const where = listing && listing.where;
    let det = regions.records.querySelector('details[data-records-owner="files"]');
    if (!det) { det = h('details', { class: 'records fs-records', 'data-records-owner': 'files' }); regions.records.append(det); }
    const wasOpen = det.open;
    det.replaceChildren(
      h('summary', null, WORDS.where),
      h('dl', { class: 'fs-dl' },
        h('dt', null, 'Project folder'), h('dd', { class: 'fs-mono' }, where ? where.root : 'not read yet'),
        h('dt', null, 'Records (conversations, receipts, settings)'), h('dd', { class: 'fs-mono' }, where ? where.home : 'not read yet')),
      h('p', { class: 'fs-note' }, WORDS.recordsNote));
    det.open = wasOpen;
  }
  function whereOpen() { const d = regions.records.querySelector('details[data-records-owner="files"]'); if (d) { d.open = true; d.scrollIntoView({ block: 'nearest' }); const s = d.querySelector('summary'); if (s) s.focus(); } }

  function redraw() {
    if (!regions || !regions.work.isConnected) return;
    const active = document.activeElement;
    const focused = active && section.contains(active) ? (active.getAttribute('data-path') || active.getAttribute('data-fs')) : null;
    if (shellHasPages()) register();
    else {
      regions.head.replaceChildren(...head());
      regions.band.replaceChildren(...band());
      const where = h('button', { type: 'button', class: 'band-action sh-btn-text', 'data-fs': 'where' }, WORDS.where, h('span', { 'aria-hidden': 'true' }, ' ↓'));
      where.addEventListener('click', whereOpen);
      regions.band.append(where);
    }
    regions.work.replaceChildren(...work());
    regions.context.replaceChildren(...context());
    dock();
    records();
    section.dataset.state = state === 'loading' ? 'content' : state;
    section.dataset.filesState = state;
    if (focused) { const again = section.querySelector(`[data-path="${CSS.escape(focused)}"], [data-fs="${CSS.escape(focused)}"]`); if (again && !again.disabled) again.focus({ preventScroll: true }); }
  }

  // ── showing: the panel registry's draw (when the page is shown, and on a frame) or the shell's page event ────────────
  function show(host, ctx) {
    if (!host) return;
    ctxProject = (ctx && ctx.project) || '';
    findRegions(host);
    const now = shownProject();
    if (now !== project || !listing) {
      if (now !== project) { project = now; path = ''; selected = null; forgetOpened(); }
      listing = null; state = 'loading';
      redraw();
      load();
    } else redraw();
  }

  const hostNow = () => document.querySelector('[data-panel-host="files"]') || document.querySelector('section.page[data-page="files"]') || document.getElementById('screen-files');

  function mount() {
    const s = S();
    if (!s) return;
    if (window.TimmyPanels && typeof window.TimmyPanels.register === 'function') {
      // companion.js draws this when the Files page is shown and when a frame of another revision arrives while it is shown
      window.TimmyPanels.register(PAGE, { draw(host, frame, ctx) { show(host, ctx); } });
    }
    register();
    if (typeof s.on === 'function') {
      s.on('page', (d) => { if (d && d.id === PAGE) { const host = hostNow(); if (host && !(window.TimmyPanels && window.TimmyPanels.has && window.TimmyPanels.has(PAGE))) show(host, null); } });
      s.on('screen', (d) => { if (d && d.id === PAGE) { const host = hostNow(); if (host) show(host, null); } });
    }
    if (typeof s.mount === 'function' && Array.isArray(s.SCREENS) && s.SCREENS.includes(PAGE)) { try { s.mount(PAGE, (el) => show(el, null)); } catch (e) { /* not a screen here */ } }
    // already on the page (a reload lands on it): drawn now where no registry will
    const host = hostNow();
    if (host && !(window.TimmyPanels && window.TimmyPanels.has && window.TimmyPanels.has(PAGE)) && typeof s.current === 'function' && s.current() === PAGE) show(host, null);
  }
  if (window.TimmyShell) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /** The seam for tests: show into a host now; the state as the page holds it (never a token). */
  window.timmyFiles = {
    mount: (host, ctx) => show(host, ctx || null),
    state: () => ({ state, path, project, count: listing ? listing.count : null, selected: selected ? selected.path : null, opened: opened ? opened.kind : null, error }),
    open: (rel) => { const e = listing && listing.entries.find((x) => x.path === rel); return e ? open(e) : Promise.resolve(); },
    goTo,
    meta: pageMeta,
  };
})();
