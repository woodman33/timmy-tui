// R10 CHAT CHECKPOINT (H171; the operator's order of 2026-10-22, 16:01 PT): the browser companion's shell (the left menu
// beside every destination) and its Chat composition (the handoff's captures 01 to 06). Loaded after companion.js, whose
// page code it uses: `companion` (the token, its fetch and the streamed POST /chat), `workspace` (the frame and the tab
// shown), `h` (an element, its text set as text), `showWorkspaceTab`, `pinProject`, `copyCommand` and `typingIn`.
//
// What it draws comes from the companion, read only, never made up here: GET /api/chat/view (the project's saved
// conversation, each answer's model from its sealed receipt, the route this page's Send takes, the free-only policy, each
// provider's state, where the logs are) and GET /api/chat/models (one source's rows, sorted and filtered on the server).
// The page's Send is POST /chat, its existing route: this page's own chat, not saved to the project's conversation, with no
// tools and no receipt, and every turn it shows says so. Nothing here sends a key, a prompt or a request elsewhere.

/* global companion, workspace, h, showWorkspaceTab, pinProject, copyCommand, typingIn, projectHeader */

const cx = {
  /** the destination shown ('chat', or one of the workspace's tabs) */
  dest: 'chat',
  /** the project this page shows, as the companion says it (projectHeader's p) */
  project: null,
  /** the last GET /api/chat/view answer, and its read in flight */
  view: null,
  asking: null,
  viewFailed: '',
  /** this page's own turns: { you, answer, model, label, state: 'streaming'|'answered'|'stopped'|'failed', words, at } */
  own: [],
  /** the turn being answered now: its AbortController */
  running: null,
  /** the Models rail */
  models: { provider: 'openrouter', sub: 'local', q: { search: '', sort: 'recent', maker: '', capability: '', cost: '', context: '' }, answer: null, asking: 0, selected: '', chosenProvider: false },
  /** a first-run choice whose setup the center shows ('' none), and the choices shown again on request */
  setup: '',
  forceChoices: false,
  /** the bottom drawer open now ('' none) and the control that opened it */
  drawer: '',
  drawerFrom: null,
  /** the conversation follows new messages while the person is at its end */
  follow: true,
  lastKey: '',
  /** the saved conversation as last drawn, and the center's state as last shown (a panel opens at its top) */
  convKey: '',
  shownKey: '',
};

const CX_VIEW_EVERY_MS = 4000;
const DRAFT_KEY = (id) => `timmy.chat.draft.${id || 'none'}`;
const projectQuery = (sep = '?') => (cx.project && cx.project.id ? `${sep}project=${encodeURIComponent(cx.project.id)}` : '');
const $ = (id) => document.getElementById(id);
const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
const fakeModel = (m) => /\bfake\b|^fake-|-fake\b/i.test(String(m || ''));
const shown = (el) => el instanceof HTMLElement && document.contains(el) && el.getClientRects().length > 0;

/**
 * A region's children replaced, the keyboard kept where it was: the menu and the controls are drawn again every few seconds
 * and the center whenever the companion's answer changes, and none of that may drop the focus of a person using the keys.
 */
function redraw(root, kids) {
  const a = document.activeElement;
  let pick = '';
  if (a instanceof HTMLElement && a !== root && root.contains(a)) {
    const k = ['data-cx-ctl', 'data-cx-way', 'data-cx', 'data-cx-copy', 'data-cx-dest', 'data-dest', 'data-away', 'data-stop-turn', 'href'].find((n) => a.getAttribute(n));
    pick = a.id ? `#${CSS.escape(a.id)}` : k ? `[${k}="${CSS.escape(a.getAttribute(k))}"]` : '';
  }
  root.replaceChildren(...kids);
  if (pick) { const back = root.querySelector(pick); if (back instanceof HTMLElement) back.focus({ preventScroll: true }); }
}

// ── the left menu ──

/** The destinations, Chat first; `id` a tab of this page, `away` one this page does not have (it says where it opens). */
const DESTS = [
  { id: 'chat', label: 'Chat', glyph: '▤' },
  { id: 'studio', label: 'Studio', glyph: '▦' },
  { id: 'workflows', label: 'Workflows', glyph: '⇄' },
  { id: 'voxvision', label: 'VoxVision', glyph: '◈' },
  { id: 'create', label: 'Motion', glyph: '∿' },
  { id: 'control', label: 'Control Room', glyph: '≡' },
  { away: 'files', label: 'Files', glyph: '▢', where: 'terminal' },
  { id: 'logs', label: 'Logs & records', glyph: '☰' },
  { away: 'connections', label: 'Connections', glyph: '⌁', where: 'Home' },
  null,
  { id: 'home', label: 'Home', glyph: '⌂' },
  { id: 'fleet', label: 'Fleet & Clef', glyph: '⋔' },
  { id: 'tools', label: 'Tools & MCP', glyph: '⚒' },
];

function drawRail() {
  const menu = $('rail-menu');
  if (!menu) return;
  const tabs = new Map(((workspace.frame && workspace.frame.tabs) || []).map((t) => [String(t.id), t]));
  const items = DESTS.map((d) => {
    if (!d) return h('hr', { class: 'rail-rule', 'aria-hidden': 'true' });
    const t = d.id ? tabs.get(d.id) : null;
    const waiting = t && t.waiting > 0 ? ` · ${t.waiting}` : '';
    const title = d.id ? `${t ? t.label : d.label}${t ? ` (key ${t.key})` : ''}${t && t.waiting > 0 ? `: ${t.waiting} waiting on you` : ''}` : d.away === 'files' ? 'Files: not on this page; the project’s folder opens in the terminal or your file manager' : 'Connections: on Home (its connections and runtimes)';
    return h('button', {
      type: 'button', class: `rail-item${d.away ? ' is-away' : ''}`, 'data-dest': d.id || '', 'data-away': d.away || '', title,
      'aria-current': d.id && d.id === cx.dest ? 'page' : null, ...(t ? { 'aria-keyshortcuts': String(t.key) } : {}),
    }, h('span', { class: 'rail-glyph', 'aria-hidden': 'true' }, d.glyph), h('span', { class: 'rail-label' }, `${d.label}${waiting}`), d.where ? h('span', { class: 'rail-where' }, d.where) : null);
  });
  redraw(menu, items);
}

function railProject() {
  const p = cx.project;
  const name = $('rail-project-name');
  if (name) name.textContent = p ? String(p.name) : 'not known yet';
  const crumb = $('cx-proj');
  if (crumb) crumb.textContent = p ? String(p.name) : 'project not known yet';
  const menu = $('rail-project-menu');
  if (!menu || menu.hidden) return;
  const f = workspace.frame;
  const mode = !p ? 'The companion has not said which project this page shows yet.'
    : p.mode === 'fixed' ? 'A setting fixed this companion’s folder: it follows no project.'
      : p.mode === 'pinned' ? `Pinned on this page${p.active && p.active.id !== p.id ? `; the active project is ${p.active.name}` : ''}.`
        : 'Following the active project: this page moves when Timmy’s active project changes.';
  const kids = [h('p', { class: 'rail-mode' }, mode)];
  if (p && p.mode !== 'fixed') {
    const pinned = p.mode === 'pinned';
    kids.push(h('button', { type: 'button', class: 'rail-small-btn', 'data-cx': pinned ? 'unpin' : 'pin' }, pinned ? 'Follow the active project' : `Keep this page on ${p.name}`));
  }
  if (f && f.project && f.project.switch) {
    kids.push(h('p', null, 'Another project opens in the terminal:'), h('button', { type: 'button', class: 'rail-small-btn', 'data-cx-copy': f.project.switch, title: f.project.switch }, 'Copy its command'));
  }
  redraw(menu, kids);
}

function toggleProjectMenu(open) {
  const btn = $('rail-project');
  const menu = $('rail-project-menu');
  if (!btn || !menu) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) railProject();
}

function toggleNewProject(open) {
  const btn = $('rail-new');
  const note = $('rail-new-note');
  if (!btn || !note) return;
  note.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) return;
  const f = workspace.frame;
  const cmd = f && f.project && f.project.create;
  note.replaceChildren(
    h('span', null, 'A new project starts in the terminal: Timmy makes its folder and records it as the active project, and this page follows it. '),
    cmd ? h('button', { type: 'button', class: 'rail-small-btn', 'data-cx-copy': cmd, title: cmd }, 'Copy the command') : h('span', null, 'Its command shows once the companion answers.'));
}

function awayNote(kind) {
  const note = $('rail-away-note');
  if (!note) return;
  if (kind === 'files') {
    const folder = cx.project && cx.project.folder ? cx.project.folder : 'the project’s folder';
    note.textContent = `Files: this page has no file browser. Home previews the project’s newest files; the whole folder (${folder}) opens in the terminal or your file manager.`;
    note.hidden = false;
    return;
  }
  note.hidden = true;
}

/** The destination shown: the rail marks it, and the Chat composition fills the shell when it is Chat. */
function onDest(id) {
  cx.dest = id;
  document.body.dataset.dest = id;
  for (const b of document.querySelectorAll('#rail-menu .rail-item')) {
    if (b.dataset.dest && b.dataset.dest === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (id === 'chat') { readView(); drawChat(); readModels(); }
}

// the workspace's tab changes (a key, the old tab row, an action) move the rail and the shell with it
const showWorkspaceTabBefore = showWorkspaceTab;
// eslint-disable-next-line no-global-assign
showWorkspaceTab = function showWorkspaceTabWithShell(id, o = {}) {
  showWorkspaceTabBefore(id, o);
  if (workspace.tab !== id) return;
  onDest(id);
  if (o.focus && id === 'chat') document.querySelector('#rail-menu .rail-item[data-dest="chat"]')?.focus();
};
// the frame drawn (a read every few seconds, and at once when the bus brings a turn's end): the menu's waiting counts and the
// Chat's controls (Stop for a turn running elsewhere, the waiting count) follow it at once
const drawFrameBefore = drawFrame;
// eslint-disable-next-line no-global-assign
drawFrame = function drawFrameWithShell(...args) {
  const r = drawFrameBefore.apply(this, args);
  try { drawRail(); if (cx.dest === 'chat') { drawControls(); railProject(); } } catch (e) { /* the shell draws again on its timer */ }
  return r;
};
// the project the page shows: the rail's selector, the crumb, the draft
const projectHeaderBefore = projectHeader;
// eslint-disable-next-line no-global-assign
projectHeader = function projectHeaderWithShell(p) {
  const was = cx.project && cx.project.id;
  cx.project = p;
  projectHeaderBefore(p);
  railProject();
  if (was !== p.id) {
    cx.view = null;
    cx.own = [];
    restoreDraft();
    if (cx.dest === 'chat') { readView(true); drawChat(); }
  }
};

// ── the Chat: the project's saved conversation, this page's own turns, the route and the composer ──

function readView(force = false, fresh = false) {
  if (!companion.token || companion.refused) { drawChat(); return Promise.resolve(); }
  if (cx.asking) return cx.asking;
  const q = [projectQuery(''), fresh ? 'fresh=1' : ''].filter(Boolean).join('&');
  cx.asking = companion.fetch(`/api/chat/view${q ? `?${q}` : ''}`)
    .then((r) => r.json().then((body) => ({ r, body })))
    .then(({ r, body }) => {
      if (!r.ok || !body || body.ok !== true) { cx.viewFailed = (body && body.error) || `The companion answered HTTP ${r.status}.`; return; }
      cx.viewFailed = '';
      const key = JSON.stringify([body.conversation, body.route, body.providers, body.policy]);
      const changed = force || key !== cx.lastKey;
      cx.lastKey = key;
      const first = !cx.view;
      cx.view = body;
      if (first && !cx.models.chosenProvider) {
        const kind = body.route && (body.route.kind === 'local' ? 'local' : body.route.kind === 'none' ? body.route.chat : body.route.kind);
        cx.models.provider = kind === 'local' ? 'ollama' : 'openrouter';
        cx.models.sub = 'local';
        readModels();
      }
      if (changed) drawChat();
    })
    .catch(() => { cx.viewFailed = 'The companion did not answer the Chat’s read.'; })
    .finally(() => { cx.asking = null; });
  return cx.asking;
}

/** An answer's text: plain text, with fenced code as a block (set as text, never as markup). */
function textBlock(text, cls = 'cx-text') {
  const box = h('div', { class: cls });
  const parts = String(text || '').split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) box.append(h('pre', null, part.replace(/\n$/, '')));
    else box.append(document.createTextNode(part));
  });
  return box;
}

const SURFACE_SAID = { workbench: 'the Workbench', repl: 'the REPL', monitor: 'the monitor', companion: 'a companion page', unknown: 'another surface' };

const openTools = new Set();
function savedTurn(t, i) {
  if (t.kind === 'tool') {
    const lines = String(t.text || '').split('\n').length;
    const key = `${(cx.view && cx.view.conversation && cx.view.conversation.session) || ''}:${i}`;
    const box = h('details', { class: 'cx-tool', 'data-tool-key': key, open: openTools.has(key) }, h('summary', null, 'Tool result · ', h('strong', null, t.tool || 'a tool'), ` · ${lines} line${lines === 1 ? '' : 's'}${t.cut ? ' (cut)' : ''}`), h('pre', null, t.text));
    box.addEventListener('toggle', () => { if (box.open) openTools.add(key); else openTools.delete(key); });
    return h('li', { class: 'cx-turn is-tool' }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '⚒'), box);
  }
  const you = t.kind === 'you';
  const who = h('div', { class: 'cx-who' }, h('strong', null, you ? 'YOU' : 'TIMMY'));
  if (!you) {
    who.append(t.model ? h('span', { class: 'cx-model' }, t.model) : h('span', { class: 'cx-model is-unknown' }, 'model not recorded'));
    if (t.model && fakeModel(t.model)) who.append(h('span', { class: 'cx-chip' }, 'FAKE model'));
  }
  if (t.at) who.append(h('span', { class: 'cx-when', title: t.at }, clock(t.at)));
  const li = h('li', { class: `cx-turn ${you ? 'is-you' : 'is-timmy'}` }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, you ? '›' : '>_'), who, textBlock(t.text));
  if (!you) {
    const meta = h('div', { class: 'cx-meta' });
    if (t.receipt) {
      meta.append(h('span', null, `${t.receipt.status === 'ok' ? 'answered' : t.receipt.status} · sent from ${SURFACE_SAID[t.receipt.surface] || 'another surface'} · sealed in receipt ${t.receipt.id} (not checked here)`));
    } else meta.append(h('span', null, 'no sealed receipt of this project matches this answer'));
    if (t.cut) meta.append(h('span', null, 'cut: the answer is longer than this page shows'));
    li.append(meta, h('div', { class: 'cx-actions' }, h('button', { type: 'button', class: 'cx-link', 'data-cx-copy-text': '1' }, 'Copy text')));
  }
  return li;
}

function ownTurn(t, i) {
  const frag = document.createDocumentFragment();
  frag.append(h('li', { class: 'cx-turn is-you' }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '›'),
    h('div', { class: 'cx-who' }, h('strong', null, 'YOU'), h('span', { class: 'cx-when', title: t.at }, clock(t.at))), textBlock(t.you)));
  const who = h('div', { class: 'cx-who' }, h('strong', null, 'TIMMY'), t.model ? h('span', { class: 'cx-model' }, t.model) : h('span', { class: 'cx-model is-unknown' }, 'no model asked'));
  if (t.model && fakeModel(t.model)) who.append(h('span', { class: 'cx-chip' }, 'FAKE model'));
  const end = t.state === 'streaming' ? 'answering…' : t.state === 'answered' ? 'answered' : t.state === 'stopped' ? '✕ stopped by you: the answer so far is kept here' : `✕ failed: ${t.words || 'no answer'}`;
  const meta = h('div', { class: 'cx-meta' }, h('span', { class: 'cx-chip' }, 'this page’s own chat'), h('span', { class: 'cx-end' }, end));
  if (t.cost) meta.append(h('span', null, t.cost));
  if (t.notice) meta.append(h('span', null, t.notice));
  const li = h('li', { class: `cx-turn is-timmy is-${t.state}`, 'data-own': String(i) }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '>_'), who, textBlock(t.answer || (t.state === 'streaming' ? '' : '')), meta);
  if (t.answer) li.append(h('div', { class: 'cx-actions' }, h('button', { type: 'button', class: 'cx-link', 'data-cx-copy-text': '1' }, 'Copy text')));
  frag.append(li);
  return frag;
}

function routeOf(v) { return (v && v.route) || null; }

/** Where a route's inference runs, in words (never an address on the page's face). */
function routeWhere(r) {
  if (!r) return 'not known yet';
  if (r.kind === 'local') return r.cloud ? 'Ollama Cloud · through this computer’s Ollama' : r.loopback ? 'Ollama on this computer' : 'Ollama on another computer';
  if (r.kind === 'openrouter') return 'OpenRouter · hosted';
  return 'no route';
}

function drawChat() {
  const v = cx.view;
  const turns = $('cx-turns');
  if (!turns) return;
  const scroll = $('cx-scroll');
  const atEnd = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 : true;
  const conv = v && v.conversation;
  const sub = $('cx-sub');
  const kicker = $('cx-kicker');
  const tag = $('cx-tag');
  if (!companion.token || companion.refused) {
    if (sub) sub.textContent = 'Nothing is read without the companion’s token (the note above says how to open this page from Timmy).';
  } else if (!v) {
    if (sub) sub.textContent = cx.viewFailed || 'Reading the project’s saved conversation…';
  } else {
    const n = conv ? conv.turns.filter((t) => t.kind !== 'tool').length : 0;
    const since = conv && conv.session ? Number((/^session-(\d{10,14})-/.exec(conv.session) || [])[1]) : NaN;
    if (kicker) kicker.textContent = `Chat / ${cx.project ? cx.project.name : 'this project'}${Number.isFinite(since) ? ` · since ${new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock(new Date(since).toISOString())}` : ''}`;
    if (sub) sub.textContent = conv && conv.session
      ? `Kept in the project (its .sessions folder) and continued by the Workbench, the REPL and the monitor: ${n} message${n === 1 ? '' : 's'}${conv.total > conv.turns.length ? `, the newest ${conv.turns.length} of ${conv.total} shown` : ''}. Each answer names the model its sealed receipt records.`
      : 'The project keeps no conversation yet. The Workbench, the REPL and the monitor save theirs here; this page’s own chat (below) is not saved.';
    if (tag) { tag.hidden = !(v.route && v.route.kind === 'local' && fakeModel(v.route.model)); tag.textContent = 'FAKE model on this computer'; }
  }
  // the saved conversation drawn again only when it changed (the companion's answer also changes with a provider's check time):
  // a focused Copy text or an open tool result stays as it was
  const convKey = JSON.stringify(conv ? [conv.session, conv.total, conv.turns] : null);
  if (convKey !== cx.convKey) {
    cx.convKey = convKey;
    turns.replaceChildren(...((conv && conv.turns) || []).map((t, i) => savedTurn(t, i)));
  }
  drawOwn();
  drawEmpty();
  drawRoute();
  drawComposer();
  drawControls();
  drawStatus();
  drawModelsRail();
  const socket = $('cx-socket');
  if (socket) {
    const live = typeof wsConnection !== 'undefined' && wsConnection && wsConnection.readyState === 1;
    socket.textContent = live ? '● companion answering' : 'companion not connected';
    socket.classList.toggle('is-live', Boolean(live));
  }
  // a panel (the first run, a provider's setup) opens at its top; the conversation follows its end while the person is there,
  // and comes back to its end when a panel closes
  const st = document.body.dataset.chatState || '';
  const panel = st === 'first-run' || st === 'setup';
  const shownKey = `${st}:${cx.setup || ''}`;
  const wasPanel = /^(first-run|setup):/.test(cx.shownKey || '');
  if (scroll) {
    if (panel) { if (cx.shownKey !== shownKey) scroll.scrollTop = 0; }
    else if ((cx.follow && atEnd) || wasPanel) scroll.scrollTop = scroll.scrollHeight;
  }
  cx.shownKey = shownKey;
}

// ── the center's state: first run, a provider's setup, no model, or chat ──

const EXPLORE_KEY = 'timmy.chat.explore';
function explored() { try { return localStorage.getItem(EXPLORE_KEY) === '1'; } catch (e) { return false; } }
function setExplored(on) { try { if (on) localStorage.setItem(EXPLORE_KEY, '1'); else localStorage.removeItem(EXPLORE_KEY); } catch (e) { /* no storage here */ } }

/**
 * What the center shows: 'reading' until the companion answers; 'setup' while a provider's setup is open; 'first-run' with no
 * route, no conversation and the choices not set aside yet; 'no-model' with no route otherwise; 'empty' with a route and no
 * conversation; 'chat'.
 */
function centerState() {
  const v = cx.view;
  if (!v) return 'reading';
  if (cx.setup) return 'setup';
  const r = routeOf(v);
  const empty = (!v.conversation || v.conversation.turns.length === 0) && cx.own.length === 0;
  if (r && r.ready) return empty ? 'empty' : 'chat';
  return (empty && !explored()) || cx.forceChoices ? 'first-run' : 'no-model';
}

/** The first run's four ways in, as the terminal's (OpenRouter, Ollama on this computer, Ollama Cloud, none); Cloudflare apart. */
const WAYS = [
  { id: 'openrouter', kicker: 'Hosted models', title: 'Connect OpenRouter', words: 'Browse models from many makers with your own OpenRouter account. Timmy never asks for its password.', act: 'Set up OpenRouter' },
  { id: 'ollama-local', kicker: 'On this computer', title: 'Use Ollama on this computer', words: 'Run installed models here. No account and no key; nothing leaves this computer.', act: 'Set up Ollama here' },
  { id: 'ollama-cloud', kicker: 'Remote inference', title: 'Use Ollama Cloud', words: 'Use your Ollama account’s cloud models. No local weights to download.', act: 'Set up Ollama Cloud' },
  { id: 'explore', kicker: 'No model needed', title: 'Explore without a model', words: 'Open the project, browse its files and keep local logs. Connect a model when you need an answer.', act: 'Continue exploring' },
];

/** The way the first run suggests: Ollama here when it answered with a model installed, else OpenRouter (said why, in words). */
function suggestedWay() {
  const local = providerState('ollama-local');
  const installed = Boolean(local && local.state === 'checked' && local.models > 0);
  return installed ? { id: 'ollama-local', why: 'Ollama on this computer answered with a model installed, so it can answer here with no account.' }
    : { id: 'openrouter', why: 'Nothing on this computer answered with a model installed, so a hosted provider is the shortest way to an answer.' };
}

/** A provider's official page, as the companion names it (GET /api/chat/view's links: this page holds no address of its own). */
const link = (id, i) => {
  const l = cx.view && cx.view.links && cx.view.links[id] && cx.view.links[id][i];
  return l ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label) : h('span', null, 'its official page');
};

/** A provider's setup, in words: its state as this computer holds it, and the steps (Timmy installs, downloads and buys nothing here). */
function setupBody(id) {
  const st = providerState(id);
  const state = st ? h('p', { class: 'cx-setup-state' }, h('span', { class: `cx-setup-word${st.state === 'checked' ? ' is-live' : ''}` }, st.state === 'checked' ? `● ${st.state}${st.at ? ` ${clock(st.at)}` : ''}` : st.state), ` · ${st.words}`) : h('p', { class: 'cx-setup-state' }, 'Reading this computer’s state…');
  const cmd = (c) => h('span', { class: 'cx-cmd' }, h('code', null, c), h('button', { type: 'button', class: 'cx-link', 'data-cx-copy': c }, 'Copy'));
  if (id === 'openrouter') return ['Hosted models', 'Connect OpenRouter', [state, h('ol', { class: 'cx-steps' },
    h('li', null, 'Use your own OpenRouter account, and make a key with a small limit: ', link('openrouter', 0), '. Buying credits is your decision on OpenRouter’s site; Timmy never buys any.'),
    h('li', null, 'Give the key to Timmy in the terminal (it reads it from the keyboard and keeps it in the Timmy home, readable only by you): ', cmd('timmy init --openrouter -')),
    h('li', null, 'Signing in from the browser instead of a key (', link('openrouter', 1), ') is part of this checkpoint’s setup in the terminal; this page then shows the key as saved, not checked, until a check answers.')),
    h('p', { class: 'cx-setup-note' }, 'A key never reaches this page: it shows only where the key is kept and its state.')]];
  if (id === 'ollama-local') return ['On this computer', 'Use Ollama on this computer', [state, h('ol', { class: 'cx-steps' },
    h('li', null, 'Install Ollama yourself if it is not here: ', link('ollama-local', 0), '. Timmy installs nothing.'),
    h('li', null, 'Start it (the app, or ', h('code', null, 'ollama serve'), '), then Refresh below: this page asks it for its list of models, which runs no model.'),
    h('li', null, 'Install a model yourself, for example ', h('code', null, 'ollama pull qwen3:0.6b'), ' (', link('ollama-local', 1), ': a 523 MB download, not the memory it needs to run, and not benchmarked for Timmy). This page downloads nothing.'),
    h('li', null, 'Choose it for chat in the terminal: ', cmd('timmy init --chat local --model <model>'), ' (or /setup chat in the REPL).')),
    h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'refresh' }, 'Refresh'))]];
  if (id === 'ollama-cloud') return ['Remote inference', 'Use Ollama Cloud', [state, h('ol', { class: 'cx-steps' },
    h('li', null, 'Sign in to (or create) your Ollama account and make a key: ', link('ollama-cloud', 0), '. Its plans and usage: ', link('ollama-cloud', 1), '.'),
    h('li', null, 'Its key is set up in the terminal, as part of this checkpoint’s setup; no local weights are downloaded for it.'),
    h('li', null, 'A cloud model served through this computer’s Ollama is still cloud inference: the chat leaves this computer, and local-only refuses it.'))]];
  return ['Advanced, optional', 'Cloudflare', [state, h('p', null, 'An AI Gateway routes and observes model requests; Workers AI runs hosted models; the Agents SDK hosts agents. Each is optional and separate from the logs on this computer, which work without it.'),
    h('p', null, 'Timmy never checks Cloudflare from here: a first request can create a gateway and bill. Its setup: ', link('cloudflare', 0), '.')]];
}

/** This page's own turns, said apart from the project's conversation. */
function drawOwn() {
  const own = $('cx-own');
  if (!own) return;
  if (!cx.own.length) { own.replaceChildren(); return; }
  const list = h('ol', { class: 'cx-turns', 'aria-label': 'This page’s own chat' });
  cx.own.forEach((t, i) => list.append(ownTurn(t, i)));
  own.replaceChildren(h('p', { class: 'cx-divider' }, 'This page’s own chat · not saved to the project’s conversation · no tools · no receipt'), list);
}

/** While an answer streams: this page's turns, the composer and the status line, following the end when the person is there. */
function drawStreaming() {
  const scroll = $('cx-scroll');
  const atEnd = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40 : true;
  drawOwn();
  drawComposer();
  drawStatus();
  if (scroll && cx.follow && atEnd) scroll.scrollTop = scroll.scrollHeight;
}

function drawEmpty() {
  const box = $('cx-empty');
  if (!box) return;
  const st = centerState();
  document.body.dataset.chatState = st;
  const away = st === 'first-run' || st === 'setup';
  for (const el of [document.querySelector('.cx-head'), $('cx-turns'), $('cx-route'), $('cx-composer'), document.querySelector('.cx-hint')]) if (el) el.hidden = away;
  box.hidden = !['first-run', 'setup', 'no-model', 'empty'].includes(st);
  if (box.hidden) return;
  const r = routeOf(cx.view);
  if (st === 'first-run') {
    const sug = suggestedWay();
    redraw(box, [
      h('p', { class: 'cx-kicker' }, 'Welcome / first run'), h('h2', { class: 'cx-title' }, 'How would you like to run chat?'),
      h('p', { class: 'cx-sub' }, 'Choose one; you can add the others later. Your project and its logs begin on this computer, and no account is needed to explore.'),
      h('div', { class: 'cx-ways' }, ...WAYS.map((w) => h('button', { type: 'button', class: `cx-way${w.id === sug.id ? ' is-suggested' : ''}`, 'data-cx-way': w.id },
        h('span', { class: 'cx-way-k' }, w.kicker), h('span', { class: 'cx-way-title' }, w.title), h('span', { class: 'cx-way-words' }, w.words), h('span', { class: 'cx-way-act' }, `${w.act} →`)))),
      h('div', { class: 'cx-note-box' }, h('strong', null, 'Local logs are included. Cloud sync is optional.'), h('span', null, 'Logs and receipts stay in the project’s .timmy folder. Cloudflare (advanced) can be set up later: '), h('button', { type: 'button', class: 'cx-link', 'data-cx-way': 'cloudflare' }, 'Cloudflare settings')),
      h('div', { class: 'cx-guide' }, h('span', { class: 'cx-guide-k' }, 'Timmy guide · fixed words, no model'), h('p', null, `Suggested: ${WAYS.find((w) => w.id === sug.id).title}. ${sug.why} OpenRouter runs remotely; Ollama on this computer runs here; you can explore now and connect either later.`))]);
    return;
  }
  if (st === 'setup') {
    const [kicker, title, body] = setupBody(cx.setup);
    redraw(box, [h('p', { class: 'cx-kicker' }, kicker), h('h2', { class: 'cx-title', id: 'cx-setup-title', tabindex: '-1' }, title), ...body,
      h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'setup-back' }, '← Back to the choices'))]);
    return;
  }
  if (st === 'no-model') {
    const conv = cx.view && cx.view.conversation;
    const n = conv ? conv.turns.length : 0;
    redraw(box, [h('h3', null, 'A model is optional until you need an answer.'),
      h('p', null, `${r && r.words ? r.words.replace(/^Send is off: /, 'Send is off: ') : 'No route for chat is set up.'}`),
      h('p', null, 'Write a draft below: connecting a model later keeps your draft and this project’s local history in place.'),
      h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn is-primary', 'data-cx': 'open-models' }, 'Choose a model →'), h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'setup-choices' }, 'Review setup choices')),
      h('dl', { class: 'cx-avail' }, h('dt', null, 'Project files'), h('dd', null, 'available on this computer'), h('dt', null, 'Logs & records'), h('dd', null, 'kept on this computer'), h('dt', null, 'The saved conversation'), h('dd', null, n ? `${n} message${n === 1 ? '' : 's'} above` : 'none yet'), h('dt', null, 'AI answers'), h('dd', null, 'not connected'))]);
    return;
  }
  // a route and no conversation yet: one useful next action
  redraw(box, [h('h3', null, 'Start the conversation.'),
    h('p', null, `Your first message goes to ${r.model} (${routeWhere(r)}). This page’s own chat is not saved to the project; the Workbench’s is.`),
    h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'focus-composer' }, 'Write a message'))]);
}

function drawRoute() {
  const line = $('cx-route');
  const words = $('cx-route-words');
  if (!line || !words) return;
  const r = routeOf(cx.view);
  line.classList.toggle('is-off', Boolean(r && !r.ready));
  if (!r) { words.textContent = cx.view ? 'The companion said no route.' : 'Asking the companion which route the next turn takes…'; return; }
  if (r.ready) {
    words.replaceChildren('Next turn ', h('strong', null, r.model), ` / ${routeWhere(r)} · this page’s own chat · no tools`);
    words.title = r.words || '';
  } else {
    words.replaceChildren('Next turn ', h('strong', null, 'Send is off'), ` / ${r.label || 'no route'}`);
    words.title = r.words || '';
  }
}

function drawComposer() {
  const input = $('cx-input');
  const send = $('cx-send');
  if (!input || !send) return;
  const r = routeOf(cx.view);
  if (cx.running) {
    send.disabled = false;
    send.classList.add('is-stop');
    send.textContent = 'Stop';
    send.title = 'Stops this page’s turn; the answer so far is kept here';
    return;
  }
  send.classList.remove('is-stop');
  const ready = Boolean(r && r.ready);
  send.textContent = ready || !r ? 'Send ↑' : 'Choose a model ↑';
  send.disabled = ready ? !input.value.trim() : !r;
  // with no route the panel's "Choose a model" is the one primary step; this one is a plain control
  send.classList.toggle('is-muted', Boolean(r && !ready));
  send.title = !ready ? (r ? r.words || 'Send is off' : 'The route is not known yet') : !input.value.trim() ? 'Write a message first' : `Sends to ${r.model}: ${r.words || ''}`;
  input.placeholder = ready ? 'Ask a question, describe an idea, or make a plan…' : 'You can write a draft. Choose a model when you are ready.';
}

// ── sending: POST /chat, this page's own chat, streamed ──

function saveDraft() {
  const input = $('cx-input');
  if (!input) return;
  try { sessionStorage.setItem(DRAFT_KEY(cx.project && cx.project.id), input.value); } catch (e) { /* no storage here */ }
}
function restoreDraft() {
  const input = $('cx-input');
  if (!input) return;
  let text = '';
  try { text = sessionStorage.getItem(DRAFT_KEY(cx.project && cx.project.id)) || ''; } catch (e) { text = ''; }
  input.value = text;
  drawComposer();
}

async function sendNow() {
  const input = $('cx-input');
  const r = routeOf(cx.view);
  if (!input || cx.running || !r || !r.ready) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  saveDraft();
  // the route snapshotted as the turn starts: a later change applies to the next turn, never this one
  const turn = { you: text, answer: '', model: r.model, label: r.label, state: 'streaming', words: '', at: new Date().toISOString() };
  const history = [];
  for (const t of cx.own) { if (t.state === 'answered' && t.answer) history.push({ role: 'user', content: t.you }, { role: 'assistant', content: t.answer }); }
  history.push({ role: 'user', content: text });
  cx.own.push(turn);
  const controller = new AbortController();
  cx.running = controller;
  cx.follow = true;
  drawChat();
  let raf = 0;
  const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawStreaming(); }); };
  try {
    await companion.chat(history, (event, data) => {
      if (event === 'delta' && typeof data === 'string') { turn.answer += data; redraw(); }
      else if (event === 'route' && data && typeof data.label === 'string') { turn.label = data.label; }
      else if (event === 'notice' && data && typeof data.text === 'string') { turn.notice = data.text; redraw(); }
      else if (event === 'cost' && data && typeof data.words === 'string') { turn.cost = data.words; redraw(); }
      else if (event === 'error') { turn.state = 'failed'; turn.words = (data && (data.error || data.details)) || 'the companion said it failed'; }
      else if (event === 'done') { if (turn.state === 'streaming') turn.state = 'answered'; if (data && typeof data.model === 'string' && data.model) turn.model = data.model; }
    }, controller.signal);
    if (turn.state === 'streaming') turn.state = 'answered';
  } catch (e) {
    if (controller.signal.aborted) turn.state = 'stopped';
    else { turn.state = 'failed'; turn.words = 'the companion did not answer the request'; }
  } finally {
    cx.running = null;
    drawChat();
  }
}

function stopNow() { if (cx.running) cx.running.abort(); }

/** What the Chat says for a moment (a Stop asked of another surface's turn, and its answer), in words. */
function chatNote(words, state) {
  const note = $('cx-note');
  if (!note) return;
  note.textContent = words;
  note.hidden = !words;
  if (state) note.dataset.state = state; else delete note.dataset.state;
}

/** Stop the project's turn another surface is answering, by its id (POST /api/chat/stop, the companion's existing route). */
async function stopOther(btn) {
  const id = btn.dataset.stopTurn || '';
  if (!id || btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const r = await companion.fetch(`/api/chat/stop${projectQuery()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn: id }) });
    const body = await r.json().catch(() => null);
    chatNote(body && typeof (body.words || body.error) === 'string' ? (body.words || body.error) : `The companion answered HTTP ${r.status}.`, r.ok ? null : 'failed');
  } catch (err) {
    chatNote(`Not stopped: the companion could not be reached (${err && err.message ? err.message : String(err)}).`, 'failed');
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ── the Models rail ──

const PROVIDERS = [['openrouter', 'local', 'OpenRouter'], ['ollama', 'local', 'Ollama local'], ['ollama', 'cloud', 'Ollama cloud'], ['cloudflare', 'local', 'Cloudflare (optional)']];
const SORT_WORDS = { recent: 'Recently added', name: 'Name', price: 'Price, lowest first', context: 'Context, largest first' };

function sourceOf(m) { return m.provider === 'openrouter' ? 'openrouter' : m.provider === 'ollama' ? (m.sub === 'cloud' ? 'ollama-cloud' : 'ollama-local') : null; }

function readModels() {
  const m = cx.models;
  const source = sourceOf(m);
  if (!source || !companion.token || companion.refused) { drawModelsRail(); return; }
  const seq = ++m.asking;
  const q = new URLSearchParams({ source, sort: m.q.sort });
  for (const k of ['search', 'maker', 'capability', 'cost', 'context']) if (m.q[k]) q.set(k, m.q[k]);
  if (cx.project && cx.project.id) q.set('project', cx.project.id);
  companion.fetch(`/api/chat/models?${q}`)
    .then((r) => r.json())
    .then((body) => { if (seq !== m.asking) return; m.answer = body && body.ok ? body : { ok: false, error: (body && body.error) || 'The companion could not read the models.' }; })
    .catch(() => { if (seq === m.asking) m.answer = { ok: false, error: 'The companion did not answer the models’ read.' }; })
    .finally(() => { if (seq === m.asking) drawModelsRail({ top: true }); });
}

const money = (n) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toPrecision(2)}` : `$${Number(n.toFixed(2))}`);
const ctxWords = (n) => (typeof n !== 'number' ? 'context unknown' : n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M ctx` : `${Math.round(n / 1000)}K ctx`);
function priceWords(p) {
  if (!p) return 'price unknown';
  if (p.free === true) return 'free · $0 / $0 per M';
  if (typeof p.inPerM === 'number' && typeof p.outPerM === 'number') return `${money(p.inPerM)} / ${money(p.outPerM)} per M`;
  return 'price unknown';
}
const capWord = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
/** Cloudflare's parts as H170's state says them ("Worker: not set up (…)"), each as [part, its state]. */
const cfLines = (cf) => ((cf && cf.lines) || []).map((l) => { const i = String(l).indexOf(': '); return i > 0 ? [l.slice(0, i), l.slice(i + 2)] : ['', String(l)]; });
const providerState = (id) => ((cx.view && cx.view.providers) || []).find((p) => p.id === id) || null;

function inUse(row) {
  const r = routeOf(cx.view);
  if (!r || !r.ready) return false;
  if (r.kind === 'local') return row.source !== 'openrouter' && row.id === r.model;
  return row.source === 'openrouter' && row.id === r.model;
}

/** A model's row; the selected one carries its detail right below it (SELECTED), so a short list has no gap and a long one scrolls. */
function modelRow(row) {
  const sel = row.id === cx.models.selected;
  const btn = h('button', {
    type: 'button', class: 'cm-row', 'aria-current': sel ? 'true' : 'false', 'data-model': row.id, tabindex: sel ? '0' : '-1', ...(sel ? { 'aria-describedby': 'cm-detail' } : {}),
  },
  h('span', { class: 'cm-row-name' }, h('span', { class: 'cm-name' }, row.name), inUse(row) ? h('span', { class: 'cm-inuse' }, '✓ in use') : null),
  row.name !== row.id ? h('span', { class: 'cm-row-id' }, row.id) : null,
  row.description ? h('span', { class: 'cm-row-desc' }, row.description) : null,
  h('span', { class: 'cm-row-facts' }, h('span', null, row.source === 'openrouter' ? ctxWords(row.contextLength) : row.installed ? `installed${typeof row.sizeBytes === 'number' ? ` · ${(row.sizeBytes / 1e9).toFixed(1)} GB` : ''}` : 'cloud-backed'), h('span', null, row.source === 'ollama-local' ? 'no charge' : priceWords(row.price))));
  return h('li', { class: sel ? 'is-selected' : null }, btn, sel ? modelDetail(row) : null);
}

const tokensWords = (n) => (typeof n !== 'number' ? 'unknown' : n >= 1e6 ? `${Number((n / 1e6).toFixed(2))}M tokens` : `${n.toLocaleString('en-US')} tokens`);

function modelDetail(row) {
  if (!row) return null;
  const facts = [];
  const add = (k, v, wide = false) => facts.push(h('div', { class: `cm-fact${wide ? ' is-wide' : ''}` }, h('dt', null, k), h('dd', null, v)));
  add('Model id', row.id, true);
  if (row.source === 'openrouter') {
    add('Context', tokensWords(row.contextLength));
    add('Added', row.created ? new Date(row.created * 1000).toISOString().slice(0, 10) : 'unknown');
    add('Input', typeof row.price.inPerM === 'number' ? `${money(row.price.inPerM)} per 1M` : 'unknown');
    add('Output', typeof row.price.outPerM === 'number' ? `${money(row.price.outPerM)} per 1M` : 'unknown');
    add('Tools · Vision · Reasoning', `${capWord(row.caps.tools)} · ${capWord(row.caps.vision)} · ${capWord(row.caps.reasoning)}`, true);
  } else {
    add('Runs', row.source === 'ollama-local' ? 'on this computer (local weights)' : 'in Ollama’s cloud: the chat leaves this computer', true);
    if (row.parameterSize) add('Parameters', row.parameterSize);
    if (row.quantization) add('Quantization', row.quantization);
    if (typeof row.sizeBytes === 'number') add('On disk', `${(row.sizeBytes / 1e9).toFixed(1)} GB (not the memory it needs)`, true);
    add('Context', tokensWords(row.contextLength));
    if (typeof row.running === 'boolean') add('Loaded now', row.running ? 'yes' : 'no');
    add('Tools · Vision', `${capWord(row.caps.tools)} · ${capWord(row.caps.vision)}`, true);
  }
  const r = routeOf(cx.view);
  const use = h('div', { class: 'cm-use' });
  if (inUse(row)) use.append(h('p', null, '✓ The next turn of this page uses this model.'));
  else {
    use.append(h('button', { type: 'button', class: 'cx-btn', disabled: true, 'aria-describedby': 'cm-use-why' }, 'Use for the next turn'),
      h('p', { id: 'cm-use-why' }, `Not available on this page yet: its Send asks ${r && r.model ? r.model : 'the setup’s model'}, the setup’s choice. In the REPL, /setup chat keeps the model every surface uses.`));
  }
  return h('div', { class: 'cm-detail', id: 'cm-detail' },
    h('div', { class: 'cm-detail-top' }, h('p', { class: 'cm-detail-k' }, 'Selected'), h('p', { class: 'cm-detail-id' }, row.source === 'openrouter' ? `${row.makerLabel || row.maker} · OpenRouter` : row.source === 'ollama-local' ? 'Ollama · this computer' : 'Ollama Cloud')),
    h('h3', { class: 'visually-hidden' }, row.name), h('dl', { class: 'cm-facts' }, ...facts), use);
}

function selectOpt(name, label, value, options, cls = '', shown = true) {
  const id = `cm-${name}`;
  const sel = h('select', { id, 'data-cm-q': name });
  for (const [v, words] of options) { const o = h('option', { value: v }, words); if (v === value) o.selected = true; sel.append(o); }
  return h('div', { class: `cm-filter ${cls}` }, h('label', { for: id, class: shown ? null : 'visually-hidden' }, label), sel);
}

function drawModelsRail(o = {}) {
  const rail = $('cx-models');
  if (!rail) return;
  const m = cx.models;
  const focusedId = document.activeElement && rail.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.model || '' : '';
  const kids = [];
  const a = m.answer;
  kids.push(h('div', { class: 'cm-head' }, h('h2', { id: 'cm-title' }, 'Models'), a && a.ok ? h('span', { class: 'cm-count' }, String(a.all)) : null, h('span', { class: 'cm-applies' }, 'applies to the next turn')));
  kids.push(h('div', { class: 'cm-providers', role: 'tablist', 'aria-label': 'Provider' }, ...PROVIDERS.map(([id, sub, words]) => {
    const on = m.provider === id && (id !== 'ollama' || m.sub === sub);
    return h('button', { type: 'button', class: 'cm-provider', role: 'tab', 'aria-selected': on ? 'true' : 'false', 'data-cm-provider': id, 'data-cm-sub': sub, tabindex: on ? '0' : '-1', id: `cm-p-${id}-${sub}` }, words);
  })));
  if (m.provider === 'cloudflare') {
    const cf = providerState('cloudflare');
    kids.push(h('div', { class: 'cm-panel' },
      h('h3', null, 'Optional service'), h('p', { class: 'cm-panel-title' }, 'Cloudflare connection'),
      h('p', null, 'Cloudflare can route model requests through an AI Gateway and host Timmy’s worker. It is separate from your model account and from the logs on this computer, which work without it.'),
      h('p', null, h('span', { class: 'cm-word' }, cf ? cf.state : 'not known yet'), ` · ${cf ? cf.words : 'Reading the providers’ states…'}`),
      h('ul', { class: 'cm-parts' }, ...cfLines(cf).map(([k, v]) => h('li', null, h('strong', null, k), h('span', null, v)))),
      h('p', null, 'Its setup is in the terminal.')));
    rail.replaceChildren(...kids);
    return;
  }
  if (m.provider === 'ollama') {
    const st = providerState(m.sub === 'cloud' ? 'ollama-cloud' : 'ollama-local');
    if (st) {
      const live = st.state === 'checked';
      kids.push(h('p', { class: 'cm-state' }, h('span', { class: `cm-word${live ? ' is-live' : ''}` }, live ? `● answered ${st.at ? clock(st.at) : ''}`.trim() : st.state), ` · ${st.words}${st.next ? ` ${st.next}` : ''}`));
    }
  } else {
    const st = providerState('openrouter');
    if (st) kids.push(h('p', { class: 'cm-state' }, h('span', { class: 'cm-word' }, st.state), ` · ${st.words}`));
  }
  kids.push(h('label', { class: 'cm-search', for: 'cm-search' }, h('span', { 'aria-hidden': 'true' }, '⌕'),
    h('input', { id: 'cm-search', type: 'search', placeholder: 'Search model or maker', value: m.q.search, 'data-cm-q': 'search', 'aria-controls': 'cm-list', autocomplete: 'off', spellcheck: 'false' })));
  const makers = (a && a.ok && a.makers) || [];
  kids.push(h('div', { class: 'cm-filters' },
    selectOpt('sort', 'Sort', m.q.sort, Object.entries(SORT_WORDS), 'is-sort'),
    selectOpt('maker', 'Maker', m.q.maker, [['', 'All'], ...makers.map((x) => (typeof x === 'string' ? [x, x] : [x.id, `${x.label} (${x.count})`]))]),
    selectOpt('capability', 'Capability', m.q.capability, [['', 'All'], ['tools', 'Tools'], ['vision', 'Vision'], ['reasoning', 'Reasoning']]),
    selectOpt('cost', 'Cost', m.q.cost, [['', 'All'], ['free', 'Free only'], ['paid', 'Paid only']]),
    selectOpt('context', 'Context', m.q.context, [['', 'All'], ['32000', '32K+'], ['128000', '128K+'], ['1000000', '1M+']])));
  if (m.q.search || m.q.maker || m.q.capability || m.q.cost || m.q.context) kids.push(h('button', { type: 'button', class: 'cm-clear', 'data-cx': 'clear-filters' }, 'Clear filters'));
  const rows = (a && a.ok && a.rows) || [];
  if (rows.length && !rows.some((r) => r.id === m.selected)) {
    const used = rows.find(inUse);
    m.selected = (used || rows[0]).id;
  }
  const matched = a && a.ok ? (typeof a.matched === 'number' ? a.matched : rows.length) : 0;
  kids.push(h('div', { class: 'cm-list-head' }, h('span', null, m.provider === 'openrouter' ? (a && a.from === 'cache' ? (a.cache === 'fetched' ? 'Public catalog · fetched' : 'Public catalog snapshot') : 'Catalog') : m.sub === 'local' ? 'Installed on this computer' : 'Ollama Cloud'), h('span', null, a && a.ok ? `${matched} model${matched === 1 ? '' : 's'}${matched > rows.length ? ` · first ${rows.length}` : ''}` : '')));
  const list = h('ul', { class: 'cm-list', id: 'cm-list', 'aria-label': 'Models' });
  // an Ollama with nothing listed: the state line above already says why, in the provider's words
  const stated = m.provider === 'ollama' && providerState(m.sub === 'cloud' ? 'ollama-cloud' : 'ollama-local');
  if (!a) list.append(h('li', { class: 'cm-empty' }, 'Reading the models…'));
  else if (!a.ok) list.append(h('li', { class: 'cm-empty' }, a.error));
  else if (!rows.length) list.append(h('li', { class: 'cm-empty' }, a.all ? 'No model matches these filters. Clear filters shows them all again.' : stated ? 'None listed: the line above says why.' : a.words));
  else for (const r of rows) list.append(modelRow(r));
  kids.push(list);
  // OpenRouter's catalog: where its rows come from and their date (a snapshot, never a live quote)
  if (a && a.ok && m.provider === 'openrouter' && a.words) kids.push(h('div', { class: 'cm-foot', id: 'cm-foot' }, a.words));
  const was = $('cm-list');
  const listTop = was ? was.scrollTop : 0;
  const railTop = rail.scrollTop;
  const same = was && was.dataset.source === `${m.provider}:${m.sub}`;
  list.dataset.source = `${m.provider}:${m.sub}`;
  rail.replaceChildren(...kids);
  // drawn again with the same source (a provider's check time, a filter): the list and the rail stay where the person was
  if (same && !o.top) list.scrollTop = listTop;
  rail.scrollTop = railTop;
  if (focusedId) {
    const back = document.getElementById(focusedId) || rail.querySelector(`[data-model="${CSS.escape(focusedId)}"]`);
    if (back) { back.focus({ preventScroll: true }); if (back instanceof HTMLInputElement) { const n = back.value.length; back.setSelectionRange(n, n); } }
  }
}

let searchTimer = 0;
function setQuery(name, value) {
  cx.models.q[name] = value;
  if (name === 'search') { clearTimeout(searchTimer); searchTimer = setTimeout(readModels, 220); return; }
  readModels();
}

// ── the bottom: the conversation's controls, the drawer, the status line ──

/** The conversation's controls, the lead's order; `minor` ones move into More under 1120 px (the terminal target's 80 x 24 does so). */
const CONTROLS = [
  ['attachments', '⎘', 'Attach', true], ['tools', '⚒', 'Tools', false], ['plan', '☰', 'Plan / Run', true], ['approvals', '✓', 'Permissions', true], ['budget', '$', 'Budget', false],
];
const MINOR = [['attachments', '⎘', 'Attach'], ['plan', '☰', 'Plan / Run'], ['approvals', '✓', 'Permissions'], ['cloudflare', '☁', 'Cloudflare']];

function controlCounts() {
  const f = workspace.frame;
  const v = cx.view;
  const waiting = f && f.activity ? f.activity.waitingOnYou : null;
  return { tools: '0', attachments: '0', plan: '', budget: v && v.policy && v.policy.freeOnly ? 'free-only' : '—', approvals: waiting === null ? '' : String(waiting), logs: 'this computer', cloudflare: '' };
}

function drawControls() {
  const bar = $('cx-controls');
  if (!bar) return;
  const f = workspace.frame;
  const counts = controlCounts();
  const kids = [h('span', { class: 'cx-controls-label' }, 'This conversation')];
  for (const [id, glyph, words, minor] of CONTROLS) kids.push(ctlButton(id, glyph, words, counts[id], minor));
  const other = f && f.activity && f.activity.chatTurn && f.activity.chatTurn.id ? f.activity.chatTurn : null;
  if (cx.running) kids.push(h('button', { type: 'button', class: 'cx-ctl is-stop', 'data-cx': 'stop' }, '■ Stop'));
  else if (other) kids.push(h('button', { type: 'button', class: 'cx-ctl is-stop', 'data-cx': 'stop-other', 'data-stop-turn': other.id, title: other.words }, `■ Stop the turn in ${SURFACE_SAID[other.surface] || 'another surface'}`));
  else kids.push(h('button', { type: 'button', class: 'cx-ctl is-off', disabled: true, title: 'Nothing is being answered now' }, '■ Stop'));
  kids.push(h('span', { class: 'cx-ctl-gap', 'aria-hidden': 'true' }), ctlButton('logs', '▤', 'Logs', counts.logs, false), ctlButton('cloudflare', '☁', 'Cloudflare', '', true),
    h('button', { type: 'button', class: 'cx-more', id: 'cx-more', 'data-cx-ctl': 'more', 'aria-expanded': cx.drawer === 'more' ? 'true' : 'false', 'aria-controls': 'cx-drawer' }, h('span', { 'aria-hidden': 'true' }, '⋯'), 'More'));
  redraw(bar, kids);
}

function ctlButton(id, glyph, words, n, minor) {
  return h('button', { type: 'button', class: `cx-ctl${minor ? ' is-minor' : ''}`, 'data-cx-ctl': id, 'aria-expanded': cx.drawer === id ? 'true' : 'false', 'aria-controls': 'cx-drawer' },
    h('span', { 'aria-hidden': 'true' }, glyph), words, n ? h('span', { class: 'cx-ctl-n' }, n) : null);
}

function drawerBody(id) {
  const v = cx.view;
  const r = routeOf(v);
  const f = workspace.frame;
  const p = (k) => providerState(k);
  switch (id) {
    case 'tools': return ['Tools', [h('p', null, 'This page’s Send offers no tools: it cannot read or change files or run anything from here (its route says so). The project’s conversation in the Workbench and the REPL offers the project’s tools: listing and reading its files, and writing one only after you allow it.')]];
    case 'attachments': return ['Attach', [h('p', null, 'Not on this page yet: its Send carries text only. It needs a Send that carries files, which this revision does not have. In the terminal, /add <file> puts a file in the project, where its preview shows on Home.')]];
    case 'plan': return ['Plan / Run', [h('p', null, 'Plans and runs are the project’s workflows. Workflows shows each run’s progress, result and receipt here; a run starts in the terminal (/run <workflow> <block>).'), h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'workflows' }, 'Open Workflows'))]];
    case 'budget': return ['Budget', [h('div', { class: 'cx-drawer-grid' },
      h('section', null, h('h4', null, 'Free-only'), h('p', { class: 'cx-d-state' }, v && v.policy ? (v.policy.freeOnly ? 'on: a model not known to be free is not sent' : 'off') : 'not known yet'), h('p', null, 'Set in the REPL with /model free-only on or off (or TIMMY_CHAT_FREE_ONLY). Unknown pricing is never free.')),
      h('section', null, h('h4', null, 'This page’s route'), h('p', { class: 'cx-d-state' }, r && r.ready ? `${r.model}` : 'Send is off'), h('p', null, r ? (r.kind === 'openrouter' ? r.price : r.kind === 'local' ? (r.cloud ? 'cost unknown: Ollama reports none for a cloud-backed model' : 'no charge: Ollama on this computer, local weights') : (r.label || '')) : '')),
      h('section', null, h('h4', null, 'A spending cap'), h('p', { class: 'cx-d-state' }, 'none in this revision'), h('p', null, 'OpenRouter’s maxCost stops a request; it is not a guaranteed cap on billing.')),
      h('section', null, h('h4', null, 'Local-only'), h('p', { class: 'cx-d-state' }, v && v.policy ? (v.policy.localOnly ? 'on: only a model with local weights on this computer is sent' : 'off') : 'not known yet'),
        h('p', null, v && v.policy && v.policy.from ? `${v.policy.from.localOnly === 'environment' ? 'Set by TIMMY_CHAT_LOCAL_ONLY for this companion.' : 'From the settings (localOnly).'} TIMMY_CHAT_LOCAL_ONLY=1 sets it for a process; a cloud model through this computer’s Ollama is still cloud.` : '')))]];
    case 'approvals': {
      const n = f && f.activity ? f.activity.waitingOnYou : null;
      return ['Permissions', [h('p', null, `${n === null ? 'Not known yet' : `${n} waiting on you`}. A tool that needs you waits in the surface running the turn (the Workbench, the REPL); this page’s Send runs no tool, so it asks for none. Control Room lists what waits.`), h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'control' }, 'Open Control Room'))]];
    }
    case 'cloudflare': {
      const cf = p('cloudflare');
      const parts = cfLines(cf);
      return ['Optional Cloudflare settings', [h('p', null, cf ? cf.words : 'Chat history and logs stay usable on this computer without a Cloudflare account; Timmy never checks Cloudflare from here (a request can create a gateway and bill).'), h('div', { class: 'cx-drawer-grid' },
        ...(parts.length ? parts : [['Its parts', 'not known yet']]).map(([k, v]) => h('section', null, h('h4', null, k), h('p', { class: 'cx-d-state' }, v))))]];
    }
    case 'logs': return ['Logs on this computer', [h('p', null, (v && v.logs && v.logs.words) || 'Logs and receipts stay on this computer.'), h('p', null, (v && v.logs && v.logs.cloud) || ''), h('div', { class: 'cx-empty-actions' },
      h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'logs' }, 'Open Logs & receipts'), h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'older' }, 'Show the turn mirror'))]];
    case 'more': {
      const counts = controlCounts();
      return ['More controls', [h('div', { class: 'cx-more-list' }, ...MINOR.map(([k, glyph, words]) => h('button', { type: 'button', class: 'cx-btn', 'data-cx-ctl': k, 'aria-controls': 'cx-drawer' },
        h('span', { 'aria-hidden': 'true' }, `${glyph} `), words, counts[k] ? h('span', { class: 'cx-ctl-n' }, ` ${counts[k]}`) : null)))]];
    }
    case 'keys': return ['Keys', [h('div', { class: 'cx-drawer-grid' },
      h('section', null, h('h4', null, 'In the composer'), h('p', null, 'Enter sends · Shift+Enter a new line · keys you type never open anything')),
      h('section', null, h('h4', null, 'Anywhere else'), h('p', null, 'M shows or hides Models · ? these keys · 1 to 9, then 0, the destinations · Esc closes a drawer and returns to where you were')),
      h('section', null, h('h4', null, 'In Models'), h('p', null, 'Up and Down move along the list · Enter shows the model · Tab moves to the next control')))]];
    default: return ['', []];
  }
}

function openDrawer(id, from) {
  const drawer = $('cx-drawer');
  if (!drawer) return;
  if (!id || cx.drawer === id) { closeDrawer(); return; }
  cx.drawer = id;
  cx.drawerFrom = from || null;
  const [title, body] = drawerBody(id);
  drawer.replaceChildren(h('h3', { id: 'cx-drawer-title' }, title), ...body, h('button', { type: 'button', class: 'cx-drawer-close', 'data-cx': 'close-drawer', 'aria-label': `Close ${title}` }, '✕'));
  drawer.hidden = false;
  $('cx-keys')?.setAttribute('aria-expanded', id === 'keys' ? 'true' : 'false');
  drawControls();
}

function closeDrawer() {
  const drawer = $('cx-drawer');
  if (!drawer || drawer.hidden) return false;
  drawer.hidden = true;
  const was = cx.drawer;
  cx.drawer = '';
  $('cx-keys')?.setAttribute('aria-expanded', 'false');
  drawControls();
  // focus back where the drawer was opened from, else its control (drawn again), else More (a control More holds is not shown)
  const back = [cx.drawerFrom, was === 'keys' ? $('cx-keys') : null, document.querySelector(`#cx-controls [data-cx-ctl="${was}"]`), $('cx-more')].find(shown);
  cx.drawerFrom = null;
  if (back) back.focus();
  return true;
}

function drawStatus() {
  const bar = $('cx-status');
  if (!bar) return;
  const r = routeOf(cx.view);
  const fake = r && r.kind === 'local' && fakeModel(r.model);
  // each word and its value kept together (a phone's width puts the two on two lines, never a word apart from its value)
  bar.replaceChildren(
    h('span', { class: 'cx-st-pair is-logs' }, h('span', { class: 'cx-st-k' }, 'Logs:'), h('span', { class: 'cx-st-v' }, `this computer / ${cx.running ? 'answering' : 'idle'}`)),
    h('span', { class: 'cx-st-sep', 'aria-hidden': 'true' }, '|'),
    h('span', { class: 'cx-st-pair is-inference' }, h('span', { class: 'cx-st-k' }, 'Inference:'), h('span', { class: 'cx-st-v' }, r ? `${routeWhere(r)}${r.ready ? ` / ${r.model}` : ''}` : 'not known yet')),
    h('span', { class: 'cx-st-right' }, h('span', { class: 'cx-st-sync' }, 'Cloud sync off'), fake ? h('span', null, 'FAKE model') : null));
}

// ── events ──

document.addEventListener('click', (event) => {
  const at = event.target instanceof Element ? event.target : null;
  if (!at) return;
  const dest = at.closest('#rail-menu .rail-item');
  if (dest) {
    if (dest.dataset.dest) { awayNote(''); document.body.classList.remove('rail-open'); showWorkspaceTab(dest.dataset.dest); return; }
    if (dest.dataset.away === 'connections') { awayNote(''); showWorkspaceTab('home'); const box = document.querySelector('.home-conn-box'); if (box) box.scrollIntoView({ block: 'nearest' }); return; }
    if (dest.dataset.away === 'files') { awayNote('files'); return; }
  }
  if (at.closest('#rail-project')) { toggleProjectMenu($('rail-project-menu').hidden); return; }
  if (at.closest('#rail-new')) { toggleNewProject($('rail-new-note').hidden); return; }
  const copy = at.closest('[data-cx-copy]');
  if (copy) { copyCommand(copy.dataset.cxCopy, copy); return; }
  const copyText = at.closest('[data-cx-copy-text]');
  if (copyText) {
    const text = copyText.closest('.cx-turn')?.querySelector('.cx-text')?.textContent || '';
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => { copyText.textContent = 'Copied'; setTimeout(() => { copyText.textContent = 'Copy text'; }, 1500); }, () => { copyText.textContent = 'Not copied (the browser refused)'; });
    return;
  }
  const go = at.closest('[data-cx-dest]');
  if (go) { closeDrawer(); showWorkspaceTab(go.dataset.cxDest); return; }
  const ctl = at.closest('[data-cx-ctl]');
  if (ctl) { openDrawer(ctl.dataset.cxCtl, ctl.closest('#cx-drawer') ? $('cx-more') : ctl); return; }
  if (at.closest('#cx-keys')) { openDrawer('keys', $('cx-keys')); return; }
  if (at.closest('#cx-models-toggle')) { toggleModels(); return; }
  if (at.closest('#cx-menu, #ws-menu')) { toggleRail(); return; }
  if (at.closest('#cx-change')) { toggleModels(true); $('cm-search')?.focus(); return; }
  const prov = at.closest('[data-cm-provider]');
  if (prov) { cx.models.provider = prov.dataset.cmProvider; cx.models.sub = prov.dataset.cmSub || 'local'; cx.models.chosenProvider = true; cx.models.answer = null; cx.models.selected = ''; drawModelsRail(); readModels(); document.getElementById(prov.id)?.focus(); return; }
  const row = at.closest('[data-model]');
  if (row && row.classList.contains('cm-row')) { cx.models.selected = row.dataset.model; drawModelsRail(); document.querySelector(`.cm-row[data-model="${CSS.escape(row.dataset.model)}"]`)?.focus(); return; }
  const way = at.closest('[data-cx-way]');
  if (way) { chooseWay(way.dataset.cxWay); return; }
  const act = at.closest('[data-cx]');
  if (!act) return;
  const what = act.dataset.cx;
  if (what === 'pin') pinProject(true);
  else if (what === 'unpin') pinProject(false);
  else if (what === 'close-drawer') closeDrawer();
  else if (what === 'clear-filters') { Object.assign(cx.models.q, { search: '', maker: '', capability: '', cost: '', context: '' }); readModels(); drawModelsRail(); }
  else if (what === 'focus-composer') $('cx-input')?.focus();
  else if (what === 'open-models') { toggleModels(true); $('cm-search')?.focus(); }
  else if (what === 'stop') stopNow();
  else if (what === 'stop-other') stopOther(act);
  else if (what === 'older') { closeDrawer(); $('cx-older')?.scrollIntoView({ block: 'start' }); }
  else if (what === 'setup-back') { cx.setup = ''; drawChat(); document.querySelector('[data-cx-way]')?.focus({ preventScroll: true }); }
  else if (what === 'setup-choices') { setExplored(false); cx.setup = ''; cx.forceChoices = true; drawChat(); document.querySelector('[data-cx-way]')?.focus({ preventScroll: true }); }
  else if (what === 'refresh') { readView(true, true).then(() => readModels()); }
});

/** A first-run choice: a provider's setup in the center with the Models rail on it, or exploring without a model. */
function chooseWay(id) {
  if (id === 'explore') { setExplored(true); cx.setup = ''; cx.forceChoices = false; drawChat(); $('cx-input')?.focus(); return; }
  cx.setup = id;
  const m = cx.models;
  m.provider = id === 'openrouter' ? 'openrouter' : id === 'cloudflare' ? 'cloudflare' : 'ollama';
  m.sub = id === 'ollama-cloud' ? 'cloud' : 'local';
  m.chosenProvider = true; m.answer = null; m.selected = '';
  toggleModels(true);
  drawChat();
  readModels();
  // the setup opens at its top, its title holding the keyboard (Tab goes on through its steps; Back is at its end)
  $('cx-setup-title')?.focus({ preventScroll: true });
}

/** Under 1180 px the Models rail is a drawer over the conversation (closed until asked for), and under 760 px the menu is too. */
const NARROW = '(max-width: 1180px)';
const PHONE = '(max-width: 760px)';
const narrow = () => { try { return matchMedia(NARROW).matches; } catch (e) { return false; } };
let modelsFrom = null;

function modelsShown() {
  const body = $('cx-body');
  if (!body) return false;
  return narrow() ? body.classList.contains('models-open') : !body.classList.contains('models-closed');
}

function toggleModels(open) {
  const body = $('cx-body');
  const btn = $('cx-models-toggle');
  if (!body || !btn) return;
  const show = open === undefined ? !modelsShown() : open;
  // hiding the rail that holds the keyboard: the focus goes to the control that shows it again
  const rail = $('cx-models');
  if (!show && rail && rail.contains(document.activeElement)) btn.focus();
  if (narrow()) {
    if (show && !body.classList.contains('models-open')) modelsFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    body.classList.toggle('models-open', show);
  } else {
    body.classList.toggle('models-closed', !show);
    try { localStorage.setItem('timmy.chat.models', show ? 'open' : 'closed'); } catch (e) { /* no storage here */ }
  }
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-expanded', show ? 'true' : 'false');
}

/** A drawer of the narrow layout closed by Esc: focus goes back where it was. */
function closeNarrowDrawers() {
  const body = $('cx-body');
  if (narrow() && body && body.classList.contains('models-open')) {
    toggleModels(false);
    const back = modelsFrom && document.contains(modelsFrom) ? modelsFrom : $('cx-models-toggle');
    modelsFrom = null;
    back?.focus();
    return true;
  }
  return closeRail();
}

let railFrom = null;
function toggleRail(open) {
  const show = open === undefined ? !document.body.classList.contains('rail-open') : open;
  if (show && !document.body.classList.contains('rail-open')) railFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.classList.toggle('rail-open', show);
  for (const id of ['cx-menu', 'ws-menu']) $(id)?.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) document.querySelector('#rail-menu .rail-item[aria-current="page"]')?.focus();
}
/** The menu drawn over the page closed: focus goes back to what opened it. */
function closeRail() {
  if (!document.body.classList.contains('rail-open')) return false;
  toggleRail(false);
  const back = railFrom && document.contains(railFrom) && railFrom.getClientRects().length ? railFrom : (cx.dest === 'chat' ? $('cx-menu') : $('ws-menu'));
  railFrom = null;
  back?.focus();
  return true;
}

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el instanceof HTMLSelectElement && el.dataset.cmQ) setQuery(el.dataset.cmQ, el.value);
});
document.addEventListener('input', (event) => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.dataset.cmQ === 'search') setQuery('search', el.value);
  if (el instanceof HTMLTextAreaElement && el.id === 'cx-input') { saveDraft(); drawComposer(); }
});
document.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === 'cx-composer') {
    event.preventDefault();
    const r = routeOf(cx.view);
    if (cx.running) stopNow(); else if (r && !r.ready) { toggleModels(true); $('cm-search')?.focus(); } else sendNow();
  }
});
document.addEventListener('keydown', (event) => {
  const at = event.target;
  if (at instanceof HTMLTextAreaElement && at.id === 'cx-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!cx.running) sendNow();
    return;
  }
  if (event.key === 'Escape') {
    if (closeDrawer()) { event.preventDefault(); return; }
    if (closeNarrowDrawers()) { event.preventDefault(); return; }
    const pm = $('rail-project-menu');
    if (pm && !pm.hidden) { toggleProjectMenu(false); $('rail-project')?.focus(); event.preventDefault(); return; }
  }
  if (at instanceof Element && at.classList.contains('cm-row') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const rows = [...document.querySelectorAll('#cm-list .cm-row')];
    const i = rows.indexOf(at);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next !== at) { event.preventDefault(); cx.models.selected = next.dataset.model; drawModelsRail(); document.querySelector(`.cm-row[data-model="${CSS.escape(next.dataset.model)}"]`)?.focus(); }
    return;
  }
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typingIn(at) || cx.dest !== 'chat') return;
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
  if (event.key === 'm' || event.key === 'M') { event.preventDefault(); toggleModels(); return; }
  if (event.key === '?') { event.preventDefault(); openDrawer('keys', $('cx-keys')); }
});
$('cx-scroll')?.addEventListener('scroll', () => {
  const s = $('cx-scroll');
  cx.follow = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
});

// ── start ──

(() => {
  let models = 'open';
  try { models = localStorage.getItem('timmy.chat.models') || 'open'; } catch (e) { models = 'open'; }
  if (models === 'closed' && !narrow()) toggleModels(false);
  $('cx-models-toggle')?.setAttribute('aria-expanded', modelsShown() ? 'true' : 'false');
  drawRail();
  restoreDraft();
  onDest(workspace.tab);
  setInterval(() => { if (!document.hidden && cx.dest === 'chat') readView(); }, CX_VIEW_EVERY_MS);
  // the frame (tab labels, waiting counts, the project's commands, a turn running elsewhere) is read by companion.js; the
  // rail and the controls follow it
  setInterval(() => { drawRail(); if (cx.dest === 'chat') { drawControls(); railProject(); } }, 3000);
})();
