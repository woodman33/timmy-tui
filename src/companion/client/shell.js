// R11 round 4 (H171): the page's SHELL — the journey's screens and what every screen shares. R11 round 7 (H175; the operator's
// order of 2026-10-24, DESIGN.md §10 B11, the lead's D3/D4/D5; SHELL CONTRACT v1, review/SHELL-CONTRACT-v1.md): the shell is
// ONE frame for every destination — the permanent grouped rail, the topbar (breadcrumb · live status word · theme), the page
// scaffold (head · band · work + context · dock · records), the phone's sheets and the Help & find overlay. Loaded after
// companion.js (the launch token, kept in this page's memory only; the tab switcher showWorkspaceTab) and before the pages'
// own scripts (H173's account.js, H170's screen-connections.js, H171's chat-shell.js, the panels), which draw against it.
//
// THE CONTRACT (v1; a change is posted in the handoff first):
//   window.TimmyShell = {
//     PAGES: [{ id, legacy, label, group, … }],   // the destinations (the page ids are the rail's words; `legacy` the tab id)
//     SCREENS: ['account', 'connections', 'chat'],  // the journey's screens, as before (account and connections are pages now)
//     page(id, { kicker, title, intro, primary: { label, run, disabled?, why? }, context: 'models'|'selection'|null, band?, dock? }),
//     state(id, 'empty'|'content'|'running'|'approval'|'error', { words?, next?: { label, run } }),
//     band(id, { workspace?, model?, records? }),  // a page that knows better than the frame
//     go(id, why?),                 // shows a page (a page id or a legacy tab id), draws its head, moves the dock, marks the rail
//     current(),                    // the PAGE id shown (round 4 answered the screen id)
//     sheet(name, open?),           // 'rail' | 'context' | 'help' (a phone's sheets; the Help overlay everywhere)
//     theme(name?),                 // 'amber' | 'glacier'; persisted per viewer (localStorage timmy.theme); cosmetic only; 'theme' { name } emitted
//     mount(screenId, drawFn),      // drawFn(host, shell) draws the screen into its page's work region each time it is shown
//     fetch(url, init), socketHello(), session, identity(), sessionNeeded(), land(), toast(words, { live? }), h, tokens,
//     on(event, fn)                 // 'page' { id, legacy, why }, 'screen' { id, why }, 'session' { user }, 'identity', 'sheet' { name, open }, 'theme' { name }
//   }
// THE LANDING RULE is round 4's: 'account' when GET /api/identity says configured and there is no session; 'connections'
// when signed in with no chat route; the workspace (the page companion.js remembered, else Chat) otherwise. Nothing here
// signs anyone in; the page keeps no token and no key in any storage (the screen id, the theme and the draft only).
// ONE SWITCHER: every page is a `.ws-page` with a (hidden) tab button in #ws-tabs, so companion.js's showWorkspaceTab()
// shows and hides them all; go() calls it and the wrapper below finishes the page (the frame's keys 1–9/0 reach it too).
(() => {
  'use strict';
  const SCREENS = ['account', 'connections', 'chat'];
  const SCREEN_KEY = 'timmy.shell.screen';
  const THEME_KEY = 'timmy.theme';
  const THEMES = ['amber', 'glacier'];
  const PHONE = '(max-width: 720px)';

  /**
   * The destinations (D3): the rail's order is the kicker's number. `legacy` is the tab id companion.js and the frame use;
   * `screen` marks a page another script mounts whole (TimmyShell.mount); `rail: false` keeps a page out of the rail (found by
   * Help & find, its key, or a control). The words are what a page shows until its owner registers (TimmyShell.page): a title
   * and an intro that instruct, never a state.
   */
  const PAGES = [
    { id: 'chat', legacy: 'chat', label: 'Chat', glyph: '▤', group: '', verb: 'Start a conversation', title: 'Make room for your next idea.', intro: 'Choose a model, add your context, and give Timmy a direction.', context: 'models', dock: 'Chat tools' },
    { id: 'files', legacy: 'files', label: 'Files', glyph: '▱', group: 'Work', verb: 'Keep every source', title: 'Every source has a place.', intro: 'Keep inputs, editable sources and outputs together in the current project.', context: 'selection' },
    { id: 'workflows', legacy: 'workflows', label: 'Workflows', glyph: '⇄', group: 'Work', verb: 'Build a workflow', title: 'Give your work a clear path.', intro: 'Define the intent, inspect a trial, then decide what runs.', context: 'selection' },
    { id: 'runs', legacy: 'logs', label: 'Runs & receipts', glyph: '≡', group: 'Work', verb: 'Review what ran', title: 'Know what happened. Decide what follows.', intro: 'Open a run to inspect its result, its changes and the recorded evidence.', context: 'selection' },
    { id: 'canvas', legacy: 'studio', label: 'Canvas', glyph: '▧', group: 'Create', verb: 'Shape the work', title: 'A workspace you can think in.', intro: 'Arrange references, parameters and results on a persistent project canvas.', context: 'selection' },
    { id: 'voxvision', legacy: 'voxvision', label: 'VoxVision', glyph: '◈', group: 'Create', verb: 'Observe and compare', title: 'See the detail. Keep the evidence.', intro: 'Choose a source, ask a precise question, and inspect what the tools observed.', context: 'selection' },
    { id: 'motion', legacy: 'create', label: 'Motion & 3D', glyph: '◇', group: 'Create', verb: 'Create in 3D', title: 'From a parameter to a possibility.', intro: 'Start with a guided template, then work through the native application.', context: 'selection' },
    { id: 'connections', legacy: 'connections', label: 'Models & accounts', glyph: '⌁', group: 'Connect', verb: 'Connect a provider', title: 'One model is enough to begin.', intro: 'Use a local model or connect a cloud account. Add the others when you need them.', context: null, screen: true },
    { id: 'tools', legacy: 'tools', label: 'Tools & integrations', glyph: '⌘', group: 'Connect', verb: 'Find the right tool', title: 'Find the right tool for the task.', intro: 'Discover capabilities here, and use them in the workflow where they belong.', context: 'selection' },
    { id: 'control', legacy: 'control', label: 'Control Room', glyph: '▦', group: '', verb: 'See what needs you', title: 'See what needs your attention.', intro: 'Review active work, approvals and recovery from one place.', context: 'selection' },
    { id: 'settings', legacy: 'settings', label: 'Settings', glyph: '◌', rail: false, verb: 'Adjust Timmy', title: 'Set Timmy up your way.', intro: 'Preferences for this companion and the workspace, in one place.', context: null },
    { id: 'account', legacy: 'account', label: 'Account', glyph: '●', rail: false, verb: 'Your account', title: 'Your Timmy account.', intro: 'Sign in, create an account, or review what this companion knows about accounts.', context: null, screen: true },
    { id: 'home', legacy: 'home', label: 'Home', glyph: '⌂', rail: false, verb: 'Recent work', title: 'The project’s recent work.', intro: 'Recent work, the connections as Timmy last observed them, and the newest images.', context: null },
    { id: 'fleet', legacy: 'fleet', label: 'Fleet & Clef', glyph: '⋔', rail: false, verb: 'The fleet', title: 'The fleet backend, decisions and the edge.', intro: 'Folded into Control Room; this page keeps its key.', context: null },
  ];
  const RAIL = PAGES.filter((p) => p.rail !== false);
  RAIL.forEach((p, i) => { p.n = String(i + 1).padStart(2, '0'); });
  const byId = new Map(PAGES.map((p) => [p.id, p]));
  const byLegacy = new Map(PAGES.map((p) => [p.legacy, p]));
  const pageOf = (id) => byId.get(id) || byLegacy.get(id) || null;

  const draws = Object.create(null);
  const listeners = Object.create(null);
  const registrations = Object.create(null);
  const bands = Object.create(null);
  let shown = '';
  let shownScreen = '';
  let identityAnswer = null;
  let sessionToken = '';
  let sessionUser = null;
  // a 401 { needs: 'session' } was answered (the lead's gate-2 ruling 2): no user-data request goes out until a session is set
  let needsSession = false;
  let needsWords = 'Sign in to continue.';
  let landing = null;
  const openers = Object.create(null);

  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : String(v)); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  const $ = (id) => document.getElementById(id);
  const emit = (event, detail) => { for (const fn of listeners[event] || []) { try { fn(detail); } catch (e) { /* a listener's own */ } } };
  const phone = () => { try { return window.matchMedia(PHONE).matches; } catch (e) { return false; } };
  const text = (el, words) => { if (el && el.textContent !== words) el.textContent = words; };

  /** The launch token: companion.js keeps it (a classic script's top-level const is shared here); none → the page says so already. */
  const launchToken = () => (typeof companion !== 'undefined' && companion && companion.token) || '';
  /**
   * A page opened without any token (an address typed by hand: the token is kept nowhere, by design) asks the companion
   * nothing: every fetch answers this 401 in the page itself, so a page's script draws these words and companion.js's own
   * no-token note at the top (said as the page loaded) is never overwritten by the "not the companion's" refusal — a 401 from
   * the companion to a request that CARRIED a token is the only refusal (the lead's 18:01 ruling on H172's LEGACY 01).
   */
  const NO_TOKEN_WORDS = 'This page has no token from Timmy, so it loads nothing. Open it from Timmy: in the Workbench (`timmy workbench`), press c, which opens this page with its token; or in `timmy watch`, press q on HOME, which shows the companion’s address with its token.';
  const noTokenAnswer = () => new Response(JSON.stringify({ ok: false, needs: 'token', error: NO_TOKEN_WORDS, words: NO_TOKEN_WORDS }), { status: 401, headers: { 'content-type': 'application/json' } });
  /** The workspace frame companion.js read (GET /api/workspace), when it has. */
  const frame = () => (typeof workspace !== 'undefined' && workspace && workspace.frame) || null;

  const TOKENS = Object.freeze({
    // B10's variables (/timmy-theme.css, src/theme/tokens.ts): kept for the pages not yet on the contract
    vars: ['--timmy-ground', '--timmy-surface', '--timmy-raised', '--timmy-line', '--timmy-line-strong', '--timmy-text', '--timmy-text-secondary', '--timmy-accent', '--timmy-accent-ink', '--timmy-accent-soft', '--timmy-silver', '--timmy-live', '--timmy-font-mono'],
    // B11's registry (SHELL CONTRACT v1 §1): what a page on the contract reads
    ui: ['--timmy-ui-canvas', '--timmy-ui-surface', '--timmy-ui-raised', '--timmy-ui-paper', '--timmy-ui-border', '--timmy-ui-border-quiet', '--timmy-ui-text', '--timmy-ui-text-secondary', '--timmy-ui-text-muted', '--timmy-ui-ink', '--timmy-ui-ink-soft', '--timmy-ui-focus', '--timmy-ui-focus-halo', '--timmy-ui-verified', '--timmy-ui-verified-dim', '--timmy-ui-accent', '--timmy-ui-accent-soft', '--timmy-ui-accent-ink', '--timmy-ui-accent-start', '--timmy-ui-accent-wash', '--timmy-ui-accent-glow', '--timmy-ui-font', '--timmy-ui-font-mono', '--timmy-ui-elev-canvas', '--timmy-ui-elev-surface', '--timmy-ui-elev-raised', '--timmy-ui-elev-paper', '--timmy-ui-elev-primary', '--timmy-ui-shadow-raised', '--timmy-ui-shadow-paper', '--timmy-ui-shadow-primary', '--timmy-ui-motion-feedback', '--timmy-ui-motion-state', '--timmy-ui-motion-panel'],
    // the shell's classes (companion.css, "the shell" and "the scaffold")
    screen: 'sh-screen', head: 'sh-head', foot: 'sh-foot', card: 'sh-card', field: 'sh-field', input: 'sh-input',
    btnPrimary: 'sh-btn-primary', btn: 'sh-btn', btnText: 'sh-btn-text', label: 'sh-label', state: 'sh-state', note: 'sh-note',
    divider: 'sh-divider', toast: 'sh-toast', mark: 'sh-mark',
    // the scaffold (contract §2.2): the regions of every section.page
    page: 'page', pageHead: 'page-head', pageBand: 'page-band', pageWork: 'page-work', pageContext: 'page-context', pageDock: 'page-dock', pageRecords: 'page-records',
    primary: 'ui-primary', button: 'ui-btn', details: 'ui-details', dockBtn: 'dock-btn',
  });

  // ── the pages: their sections, the scaffold ──

  const sectionOf = (p) => (p ? document.querySelector(`.page[data-page="${CSS.escape(p.id)}"]`) || $(`screen-${p.id}`) : null);

  /** The scaffold's regions, made where index.html did not write them (an owner's section stays as it is; its children move into the work region). */
  function scaffold(section, p) {
    if (!section) return null;
    if (!section.classList.contains('page')) section.classList.add('page');
    if (!section.dataset.page) section.dataset.page = p.id;
    if (!section.dataset.state) section.dataset.state = 'content';
    let head = section.querySelector(':scope > .page-head');
    if (!head) {
      const kids = [...section.childNodes];
      head = h('header', { class: 'page-head' },
        h('div', { class: 'page-head-words' }, h('p', { class: 'page-kicker' }), h('h1', { class: 'page-title', tabindex: '-1' }), h('p', { class: 'page-intro' })),
        h('div', { class: 'page-head-actions' }, h('button', { type: 'button', class: 'ui-btn page-context-btn', 'aria-expanded': 'false', hidden: true }), h('div', { class: 'page-primary' })));
      const work = h('div', { class: 'page-work' }, h('div', { class: 'page-state', hidden: true }));
      const body = h('div', { class: 'page-body' }, work, h('aside', { class: 'page-context', 'aria-label': 'Context' }));
      section.append(head, h('div', { class: 'page-band' }), body, h('div', { class: 'page-dock' }), h('div', { class: 'page-records' }));
      for (const k of kids) work.append(k);
    }
    const ctx = section.querySelector(':scope > .page-body > .page-context');
    if (ctx && !ctx.id) ctx.id = `page-context-${p.id}`;
    const btn = section.querySelector(':scope > .page-head .page-context-btn');
    if (btn && ctx) btn.setAttribute('aria-controls', ctx.id);
    return section;
  }
  const region = (p, cls) => { const s = sectionOf(p); return s ? s.querySelector(`:scope > .${cls}, :scope > .page-body > .${cls}`) : null; };

  /** A control's words without a trailing arrow (the lead's D8: the shell draws the ONE →; a registration's label carries none). */
  const plainLabel = (words) => String(words || '').replace(/[\s\u00a0]*[→↗›»⟶]+[\s\u00a0]*$/u, '').trim();
  /** What a page registered, over its defaults. */
  const spec = (p) => {
    const r = Object.assign({ kicker: `${p.n || ''} / ${p.verb}`.replace(/^ \/ /, ''), title: p.title, intro: p.intro, primary: null, context: p.context, band: [], dock: p.dock || `${p.label} tools` }, registrations[p.id] || {});
    if (r.primary && r.primary.label) r.primary = Object.assign({}, r.primary, { label: plainLabel(r.primary.label) });
    return r;
  };

  /** The frame's actions for a page's tab (companion.js draws them into #ws-actions; the primary one is the page's default next action). */
  const frameActions = (p) => { const f = frame(); return (f && f.actions && f.actions[p.legacy]) || []; };
  const stripButton = (label) => [...document.querySelectorAll('#ws-actions li button, #ws-actions li .cmd')].find((b) => (b.textContent || '').trim().startsWith(label)) || null;

  function drawHead(p) {
    const s = sectionOf(p);
    if (!s) return;
    scaffold(s, p);
    const r = spec(p);
    const kicker = s.querySelector(':scope > .page-head .page-kicker');
    if (kicker) {
      // the kicker's NUMBER is the rail's order (contract §2.2: one numbering product-wide, the shell's); the verb phrase is the
      // page's own — a registration that wrote another number keeps its words and takes the rail's number
      const m = /^(\d+)\s*\/\s*(.+)$/.exec(r.kicker || '');
      const verb = m ? m[2] : (r.kicker || p.verb || p.label);
      const n = p.n || (m ? m[1] : '');
      kicker.replaceChildren(...(n ? [h('span', { class: 'page-kicker-n' }, n), h('span', { class: 'page-kicker-sep', 'aria-hidden': 'true' }, ' / '), h('span', { class: 'page-kicker-verb' }, verb)] : [h('span', { class: 'page-kicker-verb' }, verb)]));
    }
    const title = s.querySelector(':scope > .page-head .page-title');
    if (title) { text(title, r.title); title.id = title.id || `page-title-${p.id}`; s.setAttribute('aria-labelledby', title.id); }
    text(s.querySelector(':scope > .page-head .page-intro'), r.intro);
    // the primary next action: the page's own, else the frame's primary action for this tab (run by the strip's own button)
    const slot = s.querySelector(':scope > .page-head .page-primary');
    let primary = r.primary;
    if (!primary) {
      const a = frameActions(p).find((x) => x && x.primary);
      if (a) primary = { label: plainLabel(a.label), run: () => { const b = stripButton(String(a.label)); if (b) b.click(); else shell.toast('That action is not on this page yet.'); }, disabled: a.enabled === false, why: a.enabled === false ? String(a.why || a.disabledWhy || '') : '' };
    }
    if (slot) {
      slot.replaceChildren();
      if (primary) {
        const b = h('button', { type: 'button', class: 'ui-primary page-primary-btn', title: primary.disabled && primary.why ? primary.why : null, 'aria-disabled': primary.disabled ? 'true' : null }, h('span', null, plainLabel(primary.label)), h('span', { class: 'ui-arrow', 'aria-hidden': 'true' }, '→'));
        if (primary.disabled) b.disabled = true;
        b.addEventListener('click', () => { try { primary.run(); } catch (e) { shell.toast(`The action failed: ${e && e.message ? e.message : e}`); } });
        slot.append(b);
      }
    }
    const ctxBtn = s.querySelector(':scope > .page-head .page-context-btn');
    const ctx = region(p, 'page-context');
    // (the phone's opener: shown only while the column holds something — an owner that has not moved its context yet has none)
    if (ctxBtn) { ctxBtn.hidden = !r.context || !ctx || !ctx.childElementCount; ctxBtn.replaceChildren(h('span', { 'aria-hidden': 'true' }, r.context === 'models' ? '⌁ ' : '▣ '), r.context === 'models' ? 'Models' : 'Details'); }
    if (ctx) { ctx.dataset.kind = r.context || 'none'; ctx.hidden = !r.context; ctx.setAttribute('aria-label', r.context === 'models' ? 'Models' : 'The selected item'); }
    s.dataset.context = r.context || 'none';
    drawBand(p, primary);
    drawDock(p);
    drawState(p);
  }

  /** The summary band: Workspace · Model · Records (+ the page's cells) · the primary as a text action. */
  function drawBand(p, primary) {
    const band = region(p, 'page-band');
    if (!band) return;
    const r = spec(p);
    const own = bands[p.id] || {};
    const f = frame();
    const proj = (typeof companion !== 'undefined' && companion && companion.project && companion.project.name) || (f && f.project && f.project.name) || ($('project-name') && $('project-name').textContent !== 'not known yet' ? $('project-name').textContent : '') || '';
    const route = $('cx-route-words') ? ($('cx-route-words').textContent || '').trim() : '';
    const records = $('cx-state-words') ? ($('cx-state-words').textContent || '').trim() : '';
    const cells = [
      { k: 'Workspace', v: own.workspace || proj || 'Reading the project…' },
      { k: 'Model', v: own.model || (route && !/^Asking/.test(route) ? route : 'Not chosen yet') },
      { k: 'Records', v: own.records || records || 'Local records' },
      ...(Array.isArray(r.band) ? r.band : []),
    ];
    const state = sectionOf(p) ? sectionOf(p).dataset.state : 'content';
    const kids = cells.map((c) => h('div', { class: 'band-cell' }, h('span', { class: 'band-k' }, c.k), h('strong', { class: 'band-v' }, c.v)));
    if (state === 'approval') kids.unshift(h('div', { class: 'band-cell is-attn' }, h('span', { class: 'band-k' }, 'Needs you'), h('strong', { class: 'band-v' }, '◆ ', (registrations[p.id] && registrations[p.id].stateWords) || 'An approval waits on you')));
    if (primary) {
      const b = h('button', { type: 'button', class: 'band-action', 'aria-disabled': primary.disabled ? 'true' : null }, plainLabel(primary.label), ' ', h('span', { 'aria-hidden': 'true' }, '↗'));
      if (primary.disabled) b.disabled = true;
      b.addEventListener('click', () => { try { primary.run(); } catch (e) { shell.toast(`The action failed: ${e && e.message ? e.message : e}`); } });
      kids.push(b);
    }
    band.replaceChildren(...kids);
  }

  /** The task dock: the label, the frame's actions strip (#ws-strip, moved here), the page's own tools, a Stop slot while running. */
  function drawDock(p) {
    const dock = region(p, 'page-dock');
    if (!dock) return;
    const r = spec(p);
    let label = dock.querySelector(':scope > .dock-label');
    if (!label) { label = h('span', { class: 'dock-label' }); dock.prepend(label); }
    text(label, String(r.dock || '').toUpperCase());
    const strip = $('ws-strip');
    if (strip && strip.parentElement !== dock) label.after(strip);
    let tools = dock.querySelector(':scope > .dock-tools');
    if (!tools) { tools = h('div', { class: 'dock-tools' }); dock.append(tools); }
    let stop = dock.querySelector(':scope > .dock-stop');
    if (!stop) { stop = h('div', { class: 'dock-stop' }); dock.append(stop); }
    const state = sectionOf(p) ? sectionOf(p).dataset.state : 'content';
    stop.hidden = state !== 'running';
    const visible = [...dock.children].some((c) => c !== label && !c.hidden && c.id !== 'ws-strip' ? c.childElementCount > 0 : c.id === 'ws-strip' ? Boolean(strip && strip.querySelector('#ws-actions li')) : false);
    dock.dataset.empty = visible ? 'false' : 'true';
  }

  /** The page's state words (empty / error) under the head, with the verb-led next action. */
  function drawState(p) {
    const s = sectionOf(p);
    if (!s) return;
    const box = s.querySelector(':scope > .page-body > .page-work > .page-state');
    if (!box) return;
    const st = s.dataset.state || 'content';
    const r = registrations[p.id] || {};
    const words = r.stateWords || '';
    const next = r.stateNext || null;
    if ((st === 'empty' || st === 'error') && (words || next)) {
      box.replaceChildren(h('p', { class: `page-state-words${st === 'error' ? ' is-error' : ''}`, role: st === 'error' ? 'alert' : null }, st === 'error' ? h('span', { 'aria-hidden': 'true' }, '✕ ') : null, words),
        next ? h('button', { type: 'button', class: 'ui-btn page-state-next' }, next.label) : null);
      const b = box.querySelector('.page-state-next');
      if (b && next) b.addEventListener('click', () => { try { next.run(); } catch (e) { shell.toast(`The action failed: ${e && e.message ? e.message : e}`); } });
      box.hidden = false;
    } else { box.replaceChildren(); box.hidden = true; }
  }

  // ── the rail ──

  function drawRail() {
    const menu = $('rail-menu');
    if (!menu) return;
    const f = frame();
    const tabs = new Map(((f && f.tabs) || []).map((t) => [String(t.id), t]));
    const items = [];
    let group = '';
    for (const p of RAIL) {
      if (p.group !== group) { group = p.group; if (group) items.push(h('div', { class: 'rail-sec rail-group', 'data-rail-group': group.toLowerCase() }, group)); }
      const t = tabs.get(p.legacy);
      const waiting = t && t.waiting > 0 ? t.waiting : 0;
      items.push(h('button', {
        type: 'button', class: 'rail-item', 'data-page': p.id, 'data-dest': p.legacy,
        title: `${p.label}${waiting ? `: ${waiting} waiting on you` : ''}${t && t.key ? ` (key ${t.key})` : ''}`,
        'aria-current': p.id === shown ? 'page' : null, ...(t && t.key ? { 'aria-keyshortcuts': String(t.key) } : {}),
      }, h('span', { class: 'rail-glyph', 'aria-hidden': 'true' }, p.glyph), h('span', { class: 'rail-label' }, p.label), waiting ? h('span', { class: 'rail-count', title: `${waiting} waiting on you` }, `· ${waiting}`) : null));
    }
    menu.replaceChildren(...items);
  }

  function markRail() {
    for (const b of document.querySelectorAll('#rail-menu .rail-item')) {
      if (b.dataset.page === shown) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
  }

  // ── the topbar: the breadcrumb, the live status word ──

  function drawCrumb(p) {
    const name = $('project-name');
    const words = name ? (name.textContent || '').trim() : '';
    text($('shell-crumb-ws'), words && words !== 'not known yet' ? words : 'Workspace');
    if (p) text($('shell-crumb-page'), p.label);
    document.title = p ? `TIMMY · ${p.label}` : 'TIMMY · companion';
  }

  /** The live status word mirrors the legacy #status (companion.js writes it): green ONLY while the socket is observed open. */
  function drawStatus() {
    const el = $('shell-status');
    const st = $('status-text');
    const dot = document.querySelector('#status .status-dot');
    if (!el || !st) return;
    const raw = (st.textContent || '').trim();
    const live = Boolean(dot && dot.classList.contains('is-live'));
    const state = dot ? dot.dataset.state || '' : '';
    // the operator's 19:18 order (7): the live word is the SOCKET only — connected (green only while it is observed open) or
    // offline — never a turn's activity ("answering"): that is the Chat's console band word and the band's Records cell
    let words = 'Companion connecting…';
    if (/CONNECTED/.test(raw) || live) words = 'Companion connected';
    else if (/LOST|CLOSED|RECONNECT/i.test(raw) || state === 'lost') words = 'Companion offline · reconnecting';
    else if (/NEEDS ITS TOKEN/i.test(raw)) words = launchToken() ? 'Token refused · open the page from Timmy again' : 'No token · open the page from Timmy';
    else if (/REFUSED/i.test(raw)) words = 'Companion refused this page';
    else if (raw) words = raw.replace(/^COMPANION SOCKET · /, 'Companion: ').toLowerCase().replace(/^companion: /, 'Companion: ');
    text(el, words);
    el.classList.toggle('is-live', live);
    el.title = raw;
  }

  // ── the theme ──

  function theme(name) {
    if (name === undefined) return document.documentElement.dataset.theme || 'amber';
    const next = THEMES.includes(name) ? name : 'amber';
    const was = document.documentElement.dataset.theme || '';
    document.documentElement.dataset.theme = next;
    for (const b of document.querySelectorAll('.theme-switch [data-theme]')) b.setAttribute('aria-pressed', b.dataset.theme === next ? 'true' : 'false');
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* no storage here */ }
    // (H174's native artboards pick their family by it: 'theme' { name } on every change, and once at boot)
    if (was !== next) emit('theme', { name: next });
    return next;
  }
  function restoreTheme() { let kept = ''; try { kept = localStorage.getItem(THEME_KEY) || ''; } catch (e) { kept = ''; } theme(THEMES.includes(kept) ? kept : 'amber'); }

  // ── the sheets (a phone's rail and context) and the Help & find overlay ──

  const scrim = () => $('shell-scrim');

  function openRailSheet(open) {
    const rail = $('shell-rail');
    const btn = $('shell-menu');
    const sheet = $('rail-sheet');
    if (!rail || !sheet) return;
    const now = rail.classList.contains('is-open');
    const show = open === undefined ? !now : open;
    if (show === now) return;
    rail.classList.toggle('is-open', show);
    sheet.setAttribute('role', show && phone() ? 'dialog' : 'none');
    if (show && phone()) sheet.setAttribute('aria-modal', 'true'); else sheet.removeAttribute('aria-modal');
    if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (scrim()) scrim().hidden = !show && !document.querySelector('.page-context.is-open');
    if (show) {
      openers.rail = document.activeElement instanceof HTMLElement ? document.activeElement : btn;
      const cur = document.querySelector('#rail-menu .rail-item[aria-current="page"]') || document.querySelector('#rail-menu .rail-item');
      if (cur) cur.focus();
    } else {
      const back = openers.rail && document.contains(openers.rail) ? openers.rail : btn;
      if (back && back.getClientRects().length) back.focus();
    }
    emit('sheet', { name: 'rail', open: show });
  }

  function openContextSheet(open) {
    const p = pageOf(shown);
    const ctx = p ? region(p, 'page-context') : null;
    const btn = p && sectionOf(p) ? sectionOf(p).querySelector(':scope > .page-head .page-context-btn') : null;
    if (!ctx) return;
    // (a desk shows the column itself — one column under the work below 1100 px, beside it above: no sheet, no scrim there)
    if (!phone()) { if (open !== false) { try { ctx.scrollIntoView({ block: 'nearest' }); } catch (e) { /* no scroll */ } } return; }
    const now = ctx.classList.contains('is-open');
    const show = open === undefined ? !now : open;
    if (show === now) return;
    ctx.classList.toggle('is-open', show);
    if (show && phone()) { ctx.setAttribute('role', 'dialog'); ctx.setAttribute('aria-modal', 'true'); } else { ctx.removeAttribute('role'); ctx.removeAttribute('aria-modal'); }
    if (btn) btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (scrim()) scrim().hidden = !show && !($('shell-rail') && $('shell-rail').classList.contains('is-open'));
    if (show) {
      openers.context = document.activeElement instanceof HTMLElement ? document.activeElement : btn;
      const first = ctx.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (first) first.focus(); else { ctx.setAttribute('tabindex', '-1'); ctx.focus(); }
    } else {
      const back = openers.context && document.contains(openers.context) ? openers.context : btn;
      if (back && back.getClientRects().length) back.focus();
    }
    emit('sheet', { name: 'context', open: show });
  }

  function helpItems(query) {
    const q = (query || '').trim().toLowerCase();
    const hit = (s) => !q || String(s).toLowerCase().includes(q);
    const p = pageOf(shown);
    const dests = PAGES.filter((d) => d.rail !== false || ['settings', 'account', 'home'].includes(d.id)).filter((d) => hit(d.label) || hit(d.id) || hit(d.verb)).map((d) => ({ kind: 'go', label: `Open ${d.label}`, hint: d.group || (d.id === 'chat' ? 'the conversation' : ''), run: () => shell.go(d.id, 'help') }));
    const actions = [];
    if (p) {
      const r = spec(p);
      if (r.primary) actions.push({ kind: 'act', label: r.primary.label, hint: 'the page’s next step', run: r.primary.run, disabled: Boolean(r.primary.disabled) });
      for (const a of frameActions(p)) if (a && a.label && !(r.primary && r.primary.label === a.label)) actions.push({ kind: 'act', label: String(a.label), hint: a.primary ? 'the page’s next step' : (a.effect ? String(a.effect) : ''), disabled: a.enabled === false, run: () => { const b = stripButton(String(a.label)); if (b) b.click(); else shell.toast('That action is not on this page yet.'); } });
      actions.push({ kind: 'act', label: 'Switch to ' + (theme() === 'amber' ? 'Glacier' : 'Amber'), hint: 'the theme; a status keeps its meaning', run: () => theme(theme() === 'amber' ? 'glacier' : 'amber') });
    }
    const f = frame();
    const keys = [
      ...((f && f.tabs) || []).filter((t) => byLegacy.get(String(t.id))).map((t) => ({ kind: 'key', key: String(t.key), label: `Open ${byLegacy.get(String(t.id)).label}` })),
      { kind: 'key', key: '⌘K', label: 'Help & find (this)' }, { kind: 'key', key: '?', label: 'Help & find, when not typing' }, { kind: 'key', key: 'Esc', label: 'Close a sheet or this overlay' },
      ...(shown === 'chat' ? [{ kind: 'key', key: 'M', label: 'Show or hide the Models column' }, { kind: 'key', key: 'Enter', label: 'Send · Shift + Enter for a new line' }] : []),
    ].filter((k) => hit(k.label) || hit(k.key));
    return { dests, actions: actions.filter((a) => hit(a.label) || hit(a.hint)), keys };
  }

  function drawHelp(query) {
    const dlg = $('shell-help-dialog');
    if (!dlg) return;
    const { dests, actions, keys } = helpItems(query);
    const list = (title, items, draw) => h('section', { class: 'help-sec' }, h('h3', { class: 'help-k' }, title), items.length ? h('ul', { class: 'help-list', role: 'list' }, ...items.map(draw)) : h('p', { class: 'help-none' }, `Nothing named “${(query || '').trim()}” here.`));
    const box = dlg.querySelector('.help-lists');
    if (!box) return;
    box.replaceChildren(
      list('Go to', dests, (d) => h('li', null, h('button', { type: 'button', class: 'help-item', 'data-help-run': '' }, h('span', null, d.label), d.hint ? h('small', null, d.hint) : null))),
      list('On this page', actions, (a) => h('li', null, h('button', { type: 'button', class: 'help-item', 'data-help-run': '', disabled: a.disabled ? true : null }, h('span', null, a.label), a.hint ? h('small', null, a.hint) : null))),
      list('Keys', keys, (k) => h('li', { class: 'help-key' }, h('kbd', null, k.key), h('span', null, k.label))));
    const runs = [...dests, ...actions];
    box.querySelectorAll('[data-help-run]').forEach((b, i) => { b.addEventListener('click', () => { closeHelp(); try { runs[i].run(); } catch (e) { shell.toast(`The action failed: ${e && e.message ? e.message : e}`); } }); });
  }

  function openHelp(open) {
    const dlg = $('shell-help-dialog');
    if (!dlg) return;
    const show = open === undefined ? !dlg.open : open;
    if (show === dlg.open) return;
    if (show) {
      openers.help = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const input = dlg.querySelector('.help-find');
      if (input) input.value = '';
      drawHelp('');
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      if (input) input.focus();
    } else closeHelp();
    emit('sheet', { name: 'help', open: show });
  }
  function closeHelp() {
    const dlg = $('shell-help-dialog');
    if (!dlg || !dlg.open) return;
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    const back = openers.help && document.contains(openers.help) ? openers.help : $('shell-help');
    if (back && back.getClientRects().length) back.focus();
  }

  // ── showing a page ──

  const legacyScreen = (p) => (p && SCREENS.includes(p.id) ? p.id : 'chat');

  function fallback(p) {
    if (p.id === 'account') {
      const i = identityAnswer;
      const needs = i && Array.isArray(i.needs) && i.needs.length ? i.needs.join(', ') : '';
      return h('div', { class: 'sh-card sh-fallback' },
        h('h2', null, 'Create your Timmy account'),
        h('p', { class: 'sh-note' }, i ? (i.words || (i.configured ? 'An identity provider is configured; this screen’s sign-in has not loaded.' : 'No identity provider is configured, so nothing signs in here.')) : 'GET /api/identity has not answered: this companion does not have the account screen’s server side yet.'),
        needs ? h('p', { class: 'sh-note' }, h('span', { class: 'sh-label' }, 'Needs '), needs) : null,
        h('p', { class: 'sh-note' }, 'This is the shell’s placeholder: the account screen (account.js) draws here when it is mounted.'),
        h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn', 'data-shell-go': 'connections' }, 'Review the workspace without an account →')),
        h('p', { class: 'sh-note' }, 'Nothing is signed in: the page reads and writes as this companion’s own process, as it did before accounts.'));
    }
    if (p.id === 'connections') {
      return h('div', { class: 'sh-card sh-fallback' },
        h('h2', null, 'Choose how you want to run.'),
        h('p', { class: 'sh-note' }, 'This is the shell’s placeholder: the connections screen (screen-connections.js) draws here when it is mounted; its words are the provider states of GET /api/connections.'),
        h('div', { class: 'sh-actions' }, h('button', { type: 'button', class: 'sh-btn-text', 'data-shell-go': 'account' }, 'Back'), h('button', { type: 'button', class: 'sh-btn', 'data-shell-go': 'chat' }, 'Explore without a model')));
    }
    return null;
  }

  /**
   * A mounted screen's draw. `host` is the page's SECTION, which holds the shell's scaffold (contract §2.1): a draw that knows
   * the scaffold writes into its .page-work / .page-context / .page-dock / .page-records and registers the head; a draw that
   * replaces the section's children (round 4's) is wrapped again by scaffold() — its content moved into the work region — so
   * the head, band, dock and records are the shell's on every page (the lead's GATE 04 ruling).
   */
  function draw(p) {
    const s = sectionOf(p);
    if (!s) return;
    scaffold(s, p);
    const fn = draws[p.id];
    if (fn) { try { fn(s, shell); } catch (e) { const work = region(p, 'page-work') || s; work.append(h('p', { class: 'sh-note sh-error', role: 'alert' }, `This screen could not be drawn: ${e && e.message ? e.message : e}`)); } }
    else { const work = region(p, 'page-work'); if (work && ![...work.children].some((c) => !c.classList.contains('page-state'))) { const fb = fallback(p); if (fb) work.append(fb); } }
    scaffold(s, p);
  }

  /** The plain switch, used where companion.js's showWorkspaceTab is not on the page (a test page of the shell alone). */
  function showAlone(p) {
    for (const s of document.querySelectorAll('.page')) s.hidden = s.dataset.page !== p.id;
    for (const b of document.querySelectorAll('#ws-tabs [role="tab"]')) { const on = b.dataset.wsTab === p.legacy; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
  }

  let finishing = false;
  let pendingWhy = '';
  /** What finishes a page once companion.js has shown its section: the head, the dock, the rail, the crumb, the focus, the memory. */
  function finish(p, why, o) {
    if (!p || finishing) return;
    finishing = true;
    try {
      const was = shown;
      shown = p.id;
      document.body.dataset.page = p.id;
      const screen = legacyScreen(p);
      if (p.screen || screen !== shownScreen) { shownScreen = screen; document.body.dataset.screen = screen; }
      if (p.screen) draw(p);
      drawHead(p);
      markRail();
      drawCrumb(p);
      if (o && o.remember !== false) { try { localStorage.setItem(SCREEN_KEY, p.id); } catch (e) { /* no storage here */ } }
      openRailSheet(false);
      if (was !== p.id) { const ctx = region(pageOf(was), 'page-context'); if (ctx && ctx.classList.contains('is-open')) openContextSheet(false); }
      emit('page', { id: p.id, legacy: p.legacy, why: why || '' });
      if (p.screen || SCREENS.includes(p.id)) emit('screen', { id: p.id, why: why || '' });
      if (!(o && o.focus === false) && was !== p.id) {
        const title = sectionOf(p) && sectionOf(p).querySelector(':scope > .page-head .page-title');
        if (title) title.focus({ preventScroll: false });
        const main = $('ws-main');
        if (main) main.scrollTop = 0;
      }
    } finally { finishing = false; }
  }

  // companion.js's switcher finishes the page too (its keys 1–9/0, its [data-ws-tab] clicks, a run's address); chat-shell.js
  // wraps THIS wrapper (it loads after) and keeps its own onDest
  if (typeof showWorkspaceTab === 'function') {
    const before = showWorkspaceTab;
    // eslint-disable-next-line no-global-assign
    showWorkspaceTab = function showWorkspaceTabWithPage(id, o = {}) {
      before(id, o);
      if (typeof workspace !== 'undefined' && workspace && workspace.tab !== id) return;
      const p = byLegacy.get(String(id));
      const why = pendingWhy || 'tab';
      pendingWhy = '';
      if (p) finish(p, why, { focus: !o.focus });
    };
  }
  // the frame drawn again (every few seconds, and at once on a turn's end): the rail's counts, the head's default primary, the band
  if (typeof drawFrame === 'function') {
    const before = drawFrame;
    // eslint-disable-next-line no-global-assign
    drawFrame = function drawFrameWithShell(...args) {
      const r = before.apply(this, args);
      try { drawRail(); const p = pageOf(shown); if (p) drawHead(p); } catch (e) { /* drawn again on the next frame */ }
      return r;
    };
  }

  function remembered() { try { return localStorage.getItem(SCREEN_KEY) || ''; } catch (e) { return ''; } }

  const shell = {
    PAGES: PAGES.map((p) => ({ id: p.id, legacy: p.legacy, label: p.label, group: p.group, rail: p.rail !== false, n: p.n || '' })),
    SCREENS,
    tokens: TOKENS,
    h,
    page(id, reg) {
      const p = pageOf(id);
      if (!p) throw new Error(`TimmyShell.page: unknown page: ${id}`);
      registrations[p.id] = Object.assign({}, registrations[p.id] || {}, reg || {});
      if (shown === p.id) drawHead(p); else { const s = sectionOf(p); if (s) scaffold(s, p); }
      return p.id;
    },
    state(id, state, o) {
      const p = pageOf(id);
      const s = sectionOf(p);
      if (!p || !s) throw new Error(`TimmyShell.state: unknown page: ${id}`);
      s.dataset.state = ['empty', 'content', 'running', 'approval', 'error'].includes(state) ? state : 'content';
      registrations[p.id] = Object.assign({}, registrations[p.id] || {}, { stateWords: (o && o.words) || '', stateNext: (o && o.next) || null });
      if (shown === p.id) drawHead(p); else { drawDock(p); drawState(p); }
    },
    band(id, cells) {
      const p = pageOf(id);
      if (!p) throw new Error(`TimmyShell.band: unknown page: ${id}`);
      bands[p.id] = Object.assign({}, bands[p.id] || {}, cells || {});
      if (shown === p.id) drawHead(p);
    },
    mount(id, drawFn) {
      const p = pageOf(id);
      if (!p || typeof drawFn !== 'function') throw new Error(`TimmyShell.mount: unknown screen or draw: ${id}`);
      draws[p.id] = drawFn;
      if (shown === p.id) draw(p);
    },
    go(id, why, o) {
      const p = pageOf(id);
      if (!p) throw new Error(`TimmyShell.go: unknown page: ${id}`);
      if (typeof showWorkspaceTab === 'function') {
        pendingWhy = why || '';
        try { showWorkspaceTab(p.legacy); } finally { pendingWhy = ''; }
        if (shown !== p.id) finish(p, why, o); // (a tab the switcher did not take: finished here all the same)
      } else { showAlone(p); finish(p, why, o); }
    },
    current: () => shown,
    sheet(name, open) { if (name === 'rail') openRailSheet(open); else if (name === 'context') openContextSheet(open); else if (name === 'help') openHelp(open); },
    theme,
    identity: () => identityAnswer,
    sessionNeeded: () => needsSession && !sessionToken,
    session: {
      set(token, user) {
        sessionToken = typeof token === 'string' ? token : '';
        sessionUser = user && typeof user === 'object' ? user : null;
        if (sessionToken) needsSession = false;
        emit('session', { user: sessionUser });
      },
      clear() { sessionToken = ''; sessionUser = null; emit('session', { user: null }); },
      get: () => sessionToken,
      user: () => sessionUser,
    },
    fetch(url, init) {
      // (the lead's gate-2 ruling 2: one 401 that needs a session stops every later ask until a session is set — the page's
      // polls get this refusal back without a request, so a hidden chat screen never loops on the companion)
      // (GET /api/identity and /api/identity/me are how the page learns whether an account is possible and who is signed in:
      // never withheld; the user-data reads — the view, the models, the frame — are what the refusal stops)
      if (needsSession && !sessionToken && !/^\/api\/identity(\/|\?|$)/.test(String(url))) return Promise.resolve(new Response(JSON.stringify({ ok: false, needs: 'session', error: needsWords, words: needsWords }), { status: 401, headers: { 'content-type': 'application/json' } }));
      // no token at all: nothing is asked, nothing is refused (companion.js's no-token words stand)
      if (!launchToken()) return Promise.resolve(noTokenAnswer());
      const o = Object.assign({}, init || {});
      const headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + launchToken() });
      if (sessionToken) headers['X-Timmy-Session'] = sessionToken;
      o.headers = headers;
      o.credentials = 'omit';
      o.cache = 'no-store';
      const sent = sessionToken;
      return fetch(url, o).then(async (r) => {
        if (r.status !== 401) return r;
        // (R11 round 4, the lead after H172's gate: a 401 to a request that went out under an older session, or none, while a
        // fresher one has since been set must not wipe the fresher session)
        if (sent !== sessionToken) return r;
        let body = null;
        try { body = await r.clone().json(); } catch (e) { body = null; }
        if (body && body.needs === 'session') {
          // (a session that ended, or a user-only route asked without one: the account page, where an account can be made
          // or restored; with no identity provider configured there is none to make, so the page that asked keeps its own
          // words — "Sign in to Timmy first" — and the page stays where the person is)
          needsSession = true; needsWords = String(body.words || body.error || 'Sign in to continue.');
          shell.session.clear();
          if (identityAnswer && identityAnswer.configured) { shell.toast(body.words || body.error || 'Sign in to continue.'); shell.go('account', 'session'); }
        } else if (launchToken() && typeof companion !== 'undefined' && companion && typeof companion.refuse === 'function') companion.refuse(); // (a 401 to a request that carried the token: the token is not the companion's)
        return r;
      });
    },
    socketHello: () => (sessionToken ? { session: sessionToken } : {}),
    toast(words, opts) {
      const old = document.querySelector('.sh-toast');
      if (old) old.remove();
      const t = h('div', { class: `sh-toast${opts && opts.live ? ' is-live' : ''}`, role: 'status' }, words);
      document.body.append(t);
      setTimeout(() => { if (t.isConnected) t.remove(); }, 6000);
      return t;
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); }; },
    /**
     * The landing rule. Returns the page it chose. `why` names what asked: the boot's landing (the default), or 'continue' —
     * Models & accounts' "Continue to the workspace" (H170 runs land()); pressed there, the shown page IS connections, so the
     * why is 'continue' unless the caller says otherwise.
     */
    async land(why) {
      if (landing) return landing;
      const reason = why || (shown === 'connections' ? 'continue' : 'landing');
      landing = (async () => {
        let configured = false;
        // the page companion.js showed as it loaded (its remembered tab, the address's ?tab=, else Chat). A WORKSPACE page is
        // never the landing's own two stops: Models & accounts and Account are where the rule sends a person who cannot work
        // yet, so a memory of either (the landing itself remembered it; the tab the switcher took) is not a place to land —
        // the lead's 18:29 ruling: with a usable route, Continue leaves Models & accounts for the workspace (Chat) at every size.
        const workspaceOf = (id) => { const p = id ? pageOf(id) : null; return p && p.id !== 'account' && p.id !== 'connections' ? p.id : ''; };
        const tabPage = (typeof workspace !== 'undefined' && workspace && byLegacy.get(String(workspace.tab))) || byId.get('chat');
        const workspacePage = () => workspaceOf(tabPage && tabPage.id) || 'chat';
        // no launch token (or not this companion's): the page's own note says how to open it from Timmy; nothing else is read
        if (!launchToken() || (typeof companion !== 'undefined' && companion && companion.refused)) { shell.go(workspacePage(), 'no-token'); return shown; }
        try {
          const r = await shell.fetch('/api/identity');
          if (r.status === 200) { identityAnswer = await r.json(); configured = Boolean(identityAnswer && identityAnswer.configured); }
          else if (r.status === 404) identityAnswer = { configured: false, needs: [], words: 'This companion has no GET /api/identity yet (the account screen’s server side), so no account can be made or restored here.' };
          else identityAnswer = { configured: false, needs: [], words: `GET /api/identity answered HTTP ${r.status}.` };
        } catch (e) { identityAnswer = { configured: false, needs: [], words: 'GET /api/identity could not be read.' }; }
        emit('identity', identityAnswer);
        // R11 round 4 (the wiring): with no identity provider configured there is nothing to sign into, so the page is this
        // companion's own workspace (the rail's account block says "Not signed in" and opens the account page, which says
        // what is missing); configured and not signed in → the account page; signed in → connections until a route is
        // ready, then the remembered page or the workspace
        let id = configured ? 'account' : workspacePage();
        if (configured && sessionToken) {
          let ready = false;
          // (GET /api/chat/route answers the PageRoute itself: { kind, ready, … })
          try { const r = await shell.fetch('/api/chat/route'); if (r.status === 200) { const b = await r.json(); ready = Boolean(b && b.ready); } } catch (e) { ready = false; }
          // a usable route: the page remembered (a workspace page the person chose; never connections or account), else the
          // workspace; no usable route: Models & accounts
          id = ready ? (workspaceOf(remembered()) || workspacePage()) : 'connections';
        }
        shell.go(id, reason);
        return shown;
      })();
      try { return await landing; } finally { landing = null; }
    },
  };

  // ── events ──

  document.addEventListener('click', (ev) => {
    const at = ev.target instanceof Element ? ev.target : null;
    if (!at) return;
    const go = at.closest('[data-shell-go]');
    if (go) { ev.preventDefault(); shell.go(go.getAttribute('data-shell-go'), 'click'); return; }
    const item = at.closest('#rail-menu .rail-item[data-page]');
    if (item) { ev.preventDefault(); shell.go(item.dataset.page, 'rail'); return; }
    if (at.closest('#shell-menu') || at.closest('#cx-menu')) { openRailSheet(); return; }
    if (at.closest('#shell-scrim')) { openRailSheet(false); openContextSheet(false); return; }
    if (at.closest('.page-context-btn')) { openContextSheet(); return; }
    if (at.closest('#shell-help')) { openHelp(true); return; }
    if (at.closest('#shell-help-dialog .help-close')) { closeHelp(); return; }
    const sw = at.closest('.theme-switch [data-theme]');
    if (sw) { theme(sw.dataset.theme); return; }
    const acct = at.closest('#rail-account-go');
    if (acct && !acct.hasAttribute('data-shell-go')) { ev.preventDefault(); shell.go('account', 'rail'); }
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) { ev.preventDefault(); openHelp(true); return; }
    if (ev.key === 'Escape') {
      const dlg = $('shell-help-dialog');
      if (dlg && dlg.open) return; // (the dialog closes itself; its close handler returns the focus)
      const rail = $('shell-rail');
      if (rail && rail.classList.contains('is-open')) { ev.preventDefault(); openRailSheet(false); return; }
      if (document.querySelector('.page-context.is-open')) { ev.preventDefault(); openContextSheet(false); return; }
      return;
    }
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const at = ev.target;
    const typing = at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement || (at instanceof HTMLInputElement && !/^(?:checkbox|radio|button|submit|range)$/.test(at.type || 'text')) || (at instanceof HTMLElement && at.isContentEditable);
    if (ev.key === '?' && !typing && !document.querySelector('dialog[open]')) { ev.preventDefault(); openHelp(true); }
  });

  function wireHelp() {
    const dlg = $('shell-help-dialog');
    if (!dlg) return;
    const input = dlg.querySelector('.help-find');
    if (input) input.addEventListener('input', () => drawHelp(input.value));
    dlg.addEventListener('close', () => { const back = openers.help && document.contains(openers.help) ? openers.help : $('shell-help'); if (back && back.getClientRects().length) back.focus(); emit('sheet', { name: 'help', open: false }); });
    dlg.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !(ev.target instanceof HTMLInputElement)) return;
      const first = dlg.querySelector('[data-help-run]:not([disabled])');
      if (first) { ev.preventDefault(); first.click(); }
    });
  }

  /** The legacy header's words, mirrored into the topbar as companion.js writes them. */
  function watchLegacy() {
    const status = $('status');
    const name = $('project-name');
    try {
      const mo = new MutationObserver(() => { drawStatus(); drawCrumb(pageOf(shown)); });
      if (status) mo.observe(status, { subtree: true, childList: true, characterData: true, attributes: true });
      if (name) mo.observe(name, { subtree: true, childList: true, characterData: true });
    } catch (e) { /* drawn on the next frame instead */ }
    drawStatus();
  }

  /** The activity band folded by default (D4's quiet records): companion.js's foldActivity keeps the viewer's choice. */
  function foldRecordsByDefault() {
    let kept = '';
    try { kept = localStorage.getItem('timmy.companion.activity') || ''; } catch (e) { kept = ''; }
    if (kept !== 'open' && typeof foldActivity === 'function') { try { foldActivity(true); } catch (e) { /* the band stays as companion.js left it */ } }
  }

  function boot() {
    restoreTheme();
    foldRecordsByDefault();
    for (const p of PAGES) { const s = sectionOf(p); if (s) scaffold(s, p); }
    drawRail();
    wireHelp();
    watchLegacy();
    // TRANSITIONAL (contract §3.1): chat-shell.js's drawRail draws its own list into #rail-menu on every frame; one rail is
    // drawn — the shell's — until H171 deletes DESTS/drawRail with the Chat's move
    if (typeof window.drawRail === 'function' && window.drawRail !== drawRail) { try { window.drawRail = drawRail; } catch (e) { /* not writable: two rails until H171 moves */ } }
    drawRail();
    if (typeof workspace !== 'undefined' && workspace && workspace.tab) { const p = byLegacy.get(String(workspace.tab)); if (p) finish(p, 'load', { focus: false, remember: false }); }
    shell.land();
  }

  window.TimmyShell = shell;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
