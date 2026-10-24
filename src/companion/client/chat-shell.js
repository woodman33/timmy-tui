// R10 CHAT CHECKPOINT (H171; the operator's order of 2026-10-22, 16:01 PT): the browser companion's shell (the left menu
// beside every destination) and its Chat composition (the handoff's captures 01 to 06). Loaded after companion.js, whose
// page code it uses: `companion` (the token, its fetch and the streamed POST /chat), `workspace` (the frame and the tab
// shown), `h` (an element, its text set as text), `showWorkspaceTab`, `pinProject`, `copyCommand` and `typingIn`.
//
// What it draws comes from the companion, read only, never made up here: GET /api/chat/view (the project's saved
// conversation, each answer's model from its sealed receipt, the route this page's Send takes, the free-only policy, each
// provider's state, where the logs are) and GET /api/chat/models (one source's rows, sorted and filtered on the server).
// The page's Send is POST /api/chat/turn (R11 round 4, H169's agent turn): the project's conversation, with the project's
// tools and a sealed receipt, as the turn's evidence line says. Nothing here sends a key, a prompt or a request elsewhere.

/* global companion, workspace, h, showWorkspaceTab, pinProject, copyCommand, typingIn, projectHeader, onConnectionsChanged, helloMessage, wsConnection */

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
  /** R11 round 4: the model chip element, kept across the panel's redraws */
  chipEl: null,
  /** R11 round 4: the user's projects (GET /api/projects) for the project box */
  userProjects: null,
  userProjectsAsking: false,
  /** R11 round 4: the right panel's tab ('models' | 'tools') and the Tools tab's inventory read (GET /api/panel/tools/inventory) */
  panel: 'models',
  toolsInv: null,
  toolsInvAsking: false,
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
  /** R11 step 1: a choice of model under way on this page ({ model, source }), and the last choice's outcome for the rail's row */
  choosing: null,
  chose: null,
  /** R11 step 3: what the rail's finder holds */
  find: '',
};

const CX_VIEW_EVERY_MS = 4000;
const DRAFT_KEY = (id) => `timmy.chat.draft.${id || 'none'}`;
const projectQuery = (sep = '?') => (cx.project && cx.project.id ? `${sep}project=${encodeURIComponent(cx.project.id)}` : '');
const $ = (id) => document.getElementById(id);
const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
const fakeModel = (m) => /\bfake\b|^fake-|-fake\b/i.test(String(m || ''));
const shown = (el) => el instanceof HTMLElement && document.contains(el) && el.getClientRects().length > 0;
// R11 round 4 (H169's contract C3; the lead's ruling of 21:48): with an identity provider configured the turn runs in a
// signed-in user's own Timmy home, so Send needs the shell's session; with none configured this page is this computer's
// operator (H173's operator principal: the companion's own env and projects) and Send works as before accounts
const identityConfigured = () => Boolean(typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.identity === 'function' && TimmyShell.identity() && TimmyShell.identity().configured);
const signedIn = () => !identityConfigured() || Boolean(TimmyShell.session.user());
const SIGN_IN_TO_SEND = 'Sign in to send: the turn runs in your own Timmy home.';
// every read and write of the Chat's user data goes through the shell's fetch (the session rides on it; a 401 that needs a
// session is answered once and stops the polls until a session is set); a page without the shell keeps the token fetch
const userFetch = (url, init) => (typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.fetch === 'function' ? TimmyShell.fetch(url, init) : companion.fetch(url, init));
const sessionNeeded = () => Boolean(typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.sessionNeeded === 'function' && TimmyShell.sessionNeeded());

/**
 * A region's children replaced, the keyboard kept where it was: the menu and the controls are drawn again every few seconds
 * and the center whenever the companion's answer changes, and none of that may drop the focus of a person using the keys.
 */
function redraw(root, kids) {
  const a = document.activeElement;
  let pick = '';
  if (a instanceof HTMLElement && a !== root && root.contains(a)) {
    const k = ['data-cx-ctl', 'data-cx-way', 'data-cx-start', 'data-activity', 'data-cx', 'data-cx-copy', 'data-cx-dest', 'data-dest', 'data-away', 'data-stop-turn', 'href'].find((n) => a.getAttribute(n));
    pick = a.id ? `#${CSS.escape(a.id)}` : k ? `[${k}="${CSS.escape(a.getAttribute(k))}"]` : '';
  }
  root.replaceChildren(...kids);
  if (pick) { const back = root.querySelector(pick); if (back instanceof HTMLElement) back.focus({ preventScroll: true }); }
}

// ── the left menu ──

/**
 * The destinations in the terminal's groups (R11 step 3; H167's rail labels): Chat, the one item under no label; WORK, CREATE and
 * CONNECT as labels. `id` a tab of this page, `away` one this page does not have (it says where it opens). Each old route stays
 * reachable: Runs & receipts is the Logs page, Canvas is Studio, Vision is VoxVision, Motion & 3D the create page, Models &
 * accounts opens Home at its connections, Tools & integrations the Tools & MCP page; Fleet & Clef (this page's own tab) keeps
 * its place under CONNECT.
 */
// R11 round 4 (H171; the preview's rail, captures 04/05/09): Chat; WORK Files · Workflows · Runs & receipts; CREATE Canvas
// (tldraw: the existing Studio canvas) · VoxVision · Motion & 3D; CONNECT Models & accounts (the connections screen) ·
// Tools & integrations. Control Room and Fleet & Clef keep their keys (7, 8) and the finder finds them.
const DESTS = [
  { id: 'chat', label: 'Chat', glyph: '▤' },
  { group: 'Work' },
  { away: 'files', label: 'Files', glyph: '▱', where: 'terminal' },
  { id: 'workflows', label: 'Workflows', glyph: '⇄' },
  { id: 'logs', label: 'Runs & receipts', glyph: '≡' },
  { group: 'Create' },
  { id: 'studio', label: 'Canvas', glyph: '▧' },
  { id: 'voxvision', label: 'VoxVision', glyph: '◈' },
  { id: 'create', label: 'Motion & 3D', glyph: '◇' },
  { group: 'Connect' },
  { screen: 'connections', label: 'Models & accounts', glyph: '⌁' },
  { id: 'tools', label: 'Tools & integrations', glyph: '⌘' },
  { id: 'control', label: 'Control Room', glyph: '▦', find: true },
  { id: 'fleet', label: 'Fleet & Clef', glyph: '⋔', find: true },
  // (R10's Home page — the project's newest run image, its strip — keeps its route: the finder finds it)
  { id: 'home', label: 'Home', glyph: '⌂', find: true },
];

function drawRail() {
  const menu = $('rail-menu');
  if (!menu) return;
  drawMarks();
  const tabs = new Map(((workspace.frame && workspace.frame.tabs) || []).map((t) => [String(t.id), t]));
  const q = (cx.find || '').trim().toLowerCase();
  const items = [];
  let group = null;
  for (const d of DESTS) {
    if (d.group) { group = h('div', { class: 'rail-sec rail-group', 'data-rail-group': d.group.toLowerCase() }, d.group); items.push(group); continue; }
    if (q && !d.label.toLowerCase().includes(q) && !(d.id || '').includes(q)) continue;
    // (a destination the preview's rail does not list is found by the finder only)
    if (d.find && !q) continue;
    const t = d.id ? tabs.get(d.id) : null;
    const waiting = t && t.waiting > 0 ? ` · ${t.waiting}` : '';
    const title = d.screen ? 'Models & accounts: the connections screen (OpenRouter, Ollama local, Ollama cloud, Cloudflare)' : d.id ? `${d.label}${t && t.label !== d.label ? ` (${t.label}${t.key ? `, key ${t.key}` : ''})` : t && t.key ? ` (key ${t.key})` : ''}${t && t.waiting > 0 ? `: ${t.waiting} waiting on you` : ''}` : 'Files: not on this page; the project’s folder opens in the terminal or your file manager';
    items.push(h('button', {
      type: 'button', class: `rail-item${d.away ? ' is-away' : ''}`, 'data-dest': d.id || '', 'data-away': d.away || '', 'data-scroll': d.scroll || '', ...(d.screen ? { 'data-shell-go': d.screen } : {}), title,
      'aria-current': d.id && d.id === cx.dest ? 'page' : null, ...(t ? { 'aria-keyshortcuts': String(t.key) } : {}),
    }, h('span', { class: 'rail-glyph', 'aria-hidden': 'true' }, d.glyph), h('span', { class: 'rail-label' }, `${d.label}${waiting}`), d.where ? h('span', { class: 'rail-where' }, d.where) : null));
    if (group) { group.hidden = false; group = null; }
  }
  // a group with nothing under it (the finder left it empty) is not drawn
  for (let i = 0; i < items.length; i += 1) if (items[i].classList && items[i].classList.contains('rail-group') && (i === items.length - 1 || items[i + 1].classList.contains('rail-group'))) items[i].hidden = true;
  if (q && !items.some((el) => el.classList.contains('rail-item'))) items.push(h('p', { class: 'rail-none' }, `Nothing named “${cx.find.trim()}” here.`));
  redraw(menu, items);
}

/** R11 step 3: the rail's finder (`/` on the Chat screen, or the footer's "/ find"): the destinations filtered by name as you type; Enter opens the first; Esc clears it. */
function toggleFind(open) {
  const box = $('rail-find-box');
  const input = $('rail-find');
  if (!box || !input) return;
  const show = open === undefined ? box.hidden : open;
  box.hidden = !show;
  $('rail-find-btn')?.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) { input.focus(); input.select(); return; }
  // (closed: the keyboard leaves the hidden box, so the next key is a page key again)
  const had = document.activeElement === input;
  input.value = ''; cx.find = ''; drawRail();
  if (had) { const btn = $('rail-find-btn'); if (btn && shown(btn)) btn.focus(); else input.blur(); }
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
    : p.user ? 'Your project, in your own Timmy home: its conversation, tools and receipts are yours alone.'
    : p.mode === 'fixed' ? 'A setting fixed this companion’s folder: it follows no project.'
      : p.mode === 'pinned' ? `Pinned on this page${p.active && p.active.id !== p.id ? `; the active project is ${p.active.name}` : ''}.`
        : 'Following the active project: this page moves when Timmy’s active project changes.';
  const kids = [h('p', { class: 'rail-mode' }, mode)];
  // R11 round 4: a signed-in user's projects (H173's GET /api/projects: the user's registry) switch this page and make a new one
  const user = typeof TimmyShell !== 'undefined' && TimmyShell.session.user();
  if (user) {
    const list = cx.userProjects;
    if (!list && !cx.userProjectsAsking) readUserProjects();
    kids.push(h('p', { class: 'rail-sec' }, 'Your projects'));
    if (!list) kids.push(h('p', null, 'Reading your projects…'));
    else if (!list.ok) kids.push(h('p', null, list.error || 'Your projects could not be read.'));
    else if (!list.rows.length) kids.push(h('p', null, 'No project yet.'));
    else for (const r of list.rows) kids.push(h('button', { type: 'button', class: `rail-small-btn rail-project-row${p && r.root === p.root ? ' is-current' : ''}`, 'data-cx-project': r.id || r.root, title: r.root ? 'In your Timmy home' : '' }, r.name || r.id));
    kids.push(h('form', { class: 'rail-new-form', id: 'rail-new-form' }, h('label', { class: 'sh-field' }, h('span', { class: 'sh-field-k' }, 'New project'), h('input', { class: 'sh-input', name: 'name', placeholder: 'Its name', autocomplete: 'off', required: '' })), h('button', { type: 'submit', class: 'sh-btn is-small' }, '+ New project')));
  }
  if (p && p.mode !== 'fixed' && !p.user) {
    const pinned = p.mode === 'pinned';
    kids.push(h('button', { type: 'button', class: 'rail-small-btn', 'data-cx': pinned ? 'unpin' : 'pin' }, pinned ? 'Follow the active project' : `Keep this page on ${p.name}`));
  }
  if (!user && f && f.project && f.project.switch) {
    kids.push(h('p', null, 'Another project opens in the terminal:'), h('button', { type: 'button', class: 'rail-small-btn', 'data-cx-copy': f.project.switch, title: f.project.switch }, 'Copy its command'));
  }
  redraw(menu, kids);
}

/** R11 round 4: the user's project registry (H173's GET /api/projects → [{ id?, root, name }] or { projects: [...] }). */
function readUserProjects() {
  cx.userProjectsAsking = true;
  TimmyShell.fetch('/api/projects').then(async (r) => {
    if (r.status !== 200) { cx.userProjects = { ok: false, error: r.status === 404 ? 'This companion has no GET /api/projects yet (the account’s server side).' : `GET /api/projects answered HTTP ${r.status}.` }; return; }
    const b = await r.json();
    const rows = Array.isArray(b) ? b : Array.isArray(b && b.projects) ? b.projects : [];
    cx.userProjects = { ok: true, rows };
  }).catch(() => { cx.userProjects = { ok: false, error: 'Your projects could not be read.' }; })
    .finally(() => { cx.userProjectsAsking = false; railProject(); });
}

/** A project of the user's chosen in the menu: this page pins it (the companion's follower knows the registry's projects: H173). */
function chooseUserProject(id) {
  if (typeof wsConnection === 'undefined' || !wsConnection || wsConnection.readyState !== 1) { TimmyShell.toast('Not connected to the companion, so the project was not changed.'); return; }
  wsConnection.send(JSON.stringify({ type: 'pin', id }));
  toggleProjectMenu(false);
}

/** New project (H173's POST /api/projects { name } → 201 { id, name, root }): made in the user's home, then shown. */
async function makeUserProject(name) {
  const r = await TimmyShell.fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (r.status !== 201 && r.status !== 200) { TimmyShell.toast(r.status === 404 ? 'This companion cannot make a project yet (no POST /api/projects).' : `The project was not made (HTTP ${r.status}).`); return; }
  const made = await r.json().catch(() => null);
  cx.userProjects = null;
  railProject();
  if (made && (made.id || made.root)) chooseUserProject(made.id || made.root);
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
  // (the lead's gate-2 ruling 2: after a 401 that needs a session, nothing is asked again until one is set)
  if (sessionNeeded()) { drawChat(); return Promise.resolve(); }
  if (cx.asking) return cx.asking;
  const q = [projectQuery(''), fresh ? 'fresh=1' : ''].filter(Boolean).join('&');
  cx.asking = userFetch(`/api/chat/view${q ? `?${q}` : ''}`)
    .then((r) => r.json().then((body) => ({ r, body })))
    .then(({ r, body }) => {
      if (!r.ok || !body || body.ok !== true) { cx.viewFailed = (body && body.error) || `The companion answered HTTP ${r.status}.`; return; }
      cx.viewFailed = '';
      const key = JSON.stringify([body.conversation, body.route, body.choice, body.providers, body.policy]);
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
const openActivity = new Set();
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
/** A running thing's indicator (the playbook §17: a braille spinner at 80 ms; still, with reduced motion), always with its words. */
const spinner = () => h('span', { class: 'cx-spin', 'aria-hidden': 'true' }, SPIN[0]);
const seconds = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : 'time not recorded');

/**
 * R11 step 2 (H171; the plan's section 2): the one line under an answer, "<model> · <where> · <seconds> · receipt <id> ✓" (✓
 * only when the companion verified the receipt on this read; "no receipt" when none seals it), a button that opens the
 * activity: the tools the turn ran as grouped lines, then the receipt's facts. Never the raw receipt in the chat.
 */
function evidence(key, model, rc, tools, extra) {
  const open = openActivity.has(key);
  // (as the terminal's line: ✓ only when the receipt verified on this read, no mark otherwise; "no receipt" when none seals it)
  const mark = rc && rc.verified ? h('span', { class: 'cx-ev-ok' }, '✓') : null;
  const line = rc ? `${model || 'model not recorded'} · ${rc.where} · ${seconds(rc.ms)} · receipt ${rc.id}${rc.verified ? ' ' : ''}`
    : extra && extra.own ? `${model || 'no model'} · ${extra.where} · ${extra.seconds} · no receipt`
      : `${model || 'model not recorded'} · no receipt`;
  const btn = h('button', { type: 'button', class: 'cx-evidence', 'aria-expanded': open ? 'true' : 'false', 'data-activity': key },
    h('span', { class: 'cx-ev-mark', 'aria-hidden': 'true' }, open ? '▾' : '▸'), ` ${line}`, mark);
  if (!open) return [btn];
  const act = h('div', { class: 'cx-activity', role: 'region', 'aria-label': 'Activity of this answer' });
  // the tools, grouped: the receipt's outcomes in order (its tool_outcomes), each with the result the conversation kept, cut to a line
  const said = new Map((tools || []).map((m) => [m.tool || '', m]));
  const lines = h('div', { class: 'cx-act-tools' });
  if (rc && rc.tools.length) {
    rc.tools.forEach((t) => {
      const line = h('p', { class: 'cx-act-line' }, h('span', { class: 'cx-act-dot', 'aria-hidden': 'true' }, t.outcome === 'completed' ? '●' : t.outcome === 'failed' ? '✕' : '○'), ` ${t.name} · ${t.outcome}${t.receipt ? ` · its own receipt ${t.receipt.slice(7)}` : ''}`);
      lines.append(line);
      const m = said.get(t.name);
      if (m) lines.append(h('p', { class: 'cx-act-sub' }, `└ ${String(m.text || '').split('\n')[0].slice(0, 120)}${String(m.text || '').includes('\n') || String(m.text || '').length > 120 ? '…' : ''}`));
    });
  } else if (tools && tools.length) {
    tools.forEach((m) => lines.append(h('p', { class: 'cx-act-line' }, h('span', { class: 'cx-act-dot', 'aria-hidden': 'true' }, '●'), ` ${m.tool || 'a tool'} · result kept in the conversation`), h('p', { class: 'cx-act-sub' }, `└ ${String(m.text || '').split('\n')[0].slice(0, 120)}`)));
  } else lines.append(h('p', { class: 'cx-act-line is-none' }, rc ? 'No tool ran: the answer came from the model alone.' : 'No tool ran in this turn.'));
  act.append(h('p', { class: 'cx-act-k' }, 'Tools'), lines);
  // the receipt's facts, each named; a FAKE receipt in a test is said not verified, never ✓
  const facts = h('dl', { class: 'cx-facts' });
  const add = (k, v) => facts.append(h('dt', null, k), h('dd', null, v));
  if (rc) {
    add('Receipt', `${rc.id} · sealed by ${SURFACE_SAID[rc.surface] || 'another surface'} · ${rc.status}${typeof rc.steps === 'number' ? ` · ${rc.steps} step${rc.steps === 1 ? '' : 's'}` : ''}`);
    add('Verified', rc.verified ? '✓ its links, body hashes and signature verify on this computer (checked on this read)' : `✕ not verified: ${rc.why || 'it does not verify'}`);
    add('Model', model || 'not recorded');
    add('Ran on', rc.where);
    add('Time', seconds(rc.ms));
    add('Spend', rc.cost ? (rc.cost.usd === 0 ? 'none' : `$${rc.cost.usd.toFixed(4)}${rc.cost.measured ? ' (the whole charge reported)' : ' (a lower bound, not the whole charge)'}`) : 'not recorded');
    if (typeof rc.files === 'number') add('Files written', rc.files === 0 ? 'none' : String(rc.files));
  } else {
    add('Receipt', 'not sealed yet: the turn’s receipt is read back from the project’s conversation when it ends');
    if (extra && extra.cost) add('Spend', extra.cost);
  }
  act.append(h('p', { class: 'cx-act-k' }, 'Receipt'), facts);
  return [btn, act];
}

/** The saved turns drawn: a tool message folds into the answer that follows it (its activity); one after no answer stands alone. */
function savedTurns(turns, session) {
  const out = [];
  let pending = [];
  turns.forEach((t, i) => {
    if (t.kind === 'tool') { pending.push({ ...t, index: i }); return; }
    if (t.kind === 'timmy') { out.push(savedTurn(t, i, pending, session)); pending = []; return; }
    pending.forEach((m) => out.push(savedTurn(m, m.index, [], session)));
    pending = [];
    out.push(savedTurn(t, i, [], session));
  });
  pending.forEach((m) => out.push(savedTurn(m, m.index, [], session)));
  return out;
}

function savedTurn(t, i, tools, session) {
  if (t.kind === 'tool') {
    const lines = String(t.text || '').split('\n').length;
    const key = `${session || ''}:${i}`;
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
  // R10 (H171; H168's pass 3b R19): a stopped turn shows the answer written before the stop (or that none was) and the stop,
  // with its receipt; Timmy's record of the stop, which the conversation keeps for the next turn, is said apart, folded
  const stop = !you && t.stopped ? t.stopped : null;
  const body = stop && !t.text ? h('p', { class: 'cx-text is-none' }, 'Nothing was written before the stop.') : textBlock(t.text);
  const li = h('li', { class: `cx-turn ${you ? 'is-you' : 'is-timmy'}${stop ? ' is-stopped' : ''}` }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, you ? '›' : '>_'), who, body);
  if (!you) {
    const meta = h('div', { class: 'cx-meta' });
    if (stop) meta.append(h('span', { class: 'cx-end' }, `■ stopped by you${stop.by ? ` (asked from ${SURFACE_SAID[stop.by] || 'another surface'})` : ''}`));
    else if (t.receipt && t.receipt.status !== 'ok') meta.append(h('span', { class: 'cx-end' }, t.receipt.status));
    if (t.cut) meta.append(h('span', null, 'cut: the answer is longer than this page shows'));
    if (meta.childElementCount) li.append(meta);
    // R11 step 2: the evidence line and its activity
    const key = `${session || ''}:${i}`;
    li.append(...evidence(key, t.model, t.receipt || null, tools, null));
    if (stop) li.append(h('details', { class: 'cx-tool cx-stop-record' }, h('summary', null, 'Timmy’s record of the stop · kept in the conversation for the next turn'), h('pre', null, stop.record)));
    if (t.text) li.append(h('div', { class: 'cx-actions' }, h('button', { type: 'button', class: 'cx-link', 'data-cx-copy-text': '1' }, 'Copy text')));
  }
  return li;
}

function ownTurn(t, i) {
  const frag = document.createDocumentFragment();
  frag.append(h('li', { class: 'cx-turn is-you' }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '›'),
    h('div', { class: 'cx-who' }, h('strong', null, 'YOU'), h('span', { class: 'cx-when', title: t.at }, clock(t.at))), textBlock(t.you)));
  const who = h('div', { class: 'cx-who' }, h('strong', null, 'TIMMY'), t.model ? h('span', { class: 'cx-model' }, t.model) : h('span', { class: 'cx-model is-unknown' }, 'no model asked'));
  if (t.model && fakeModel(t.model)) who.append(h('span', { class: 'cx-chip' }, 'FAKE model'));
  const where = t.where || 'not known';
  const elapsed = (t.ended || Date.now()) - (t.started || Date.now());
  const meta = h('div', { class: 'cx-meta' });
  // R11 step 2: a running turn always shows an indicator with its words (the playbook §17)
  const toolsNow = (t.tools || []).length;
  if (t.state === 'streaming') meta.append(h('span', { class: 'cx-end cx-running' }, spinner(), ` Answering · ${t.model || 'the model'} · ${where} · ${Math.max(0, Math.round(elapsed / 1000))} s · ${toolsNow ? `${toolsNow} tool${toolsNow === 1 ? '' : 's'}` : 'no tool yet'}`));
  else if (t.state === 'stopped') meta.append(h('span', { class: 'cx-end' }, '✕ stopped by you: the answer so far is kept here'));
  else if (t.state === 'failed') meta.append(h('span', { class: 'cx-end' }, `✕ failed: ${t.words || 'no answer'}`));
  if (t.notice) meta.append(h('span', null, t.notice));
  // R11 round 4: each tool as a line with its outcome (H169's `tool` events), as they come
  const toolLines = (t.tools || []).length ? h('div', { class: 'cx-act-tools cx-own-tools' }, ...(t.tools || []).map((x) => h('p', { class: 'cx-act-line', 'data-tool': x.name }, h('span', { class: 'cx-act-dot', 'aria-hidden': 'true' }, x.status === 'completed' ? '●' : x.status === 'failed' ? '✕' : '○'), ` ${x.name} · ${x.status}${x.receipt ? ` · its own receipt ${String(x.receipt).slice(-8)}` : ''}`))) : null;
  // NEEDS-YOU: the question inline with its options; the choice goes back to the turn
  const needs = t.needs ? h('div', { class: 'cx-needs', role: 'group', 'aria-label': 'Timmy needs you', 'data-needs': t.needs.id },
    h('p', { class: 'cx-needs-k' }, 'Needs you'), h('p', null, t.needs.words),
    t.needs.answered ? h('p', { class: 'cx-act-sub' }, `└ answered: ${t.needs.answered}`) : h('div', { class: 'cx-needs-opts' }, ...(t.needs.options.length ? t.needs.options : ['yes', 'no']).map((o) => h('button', { type: 'button', class: 'cx-btn', 'data-cx-answer': String(typeof o === 'string' ? o : o.id || o.value || ''), 'data-cx-answer-id': t.needs.id }, typeof o === 'string' ? o : (o.label || o.id || String(o.value || ''))))),
    t.needs.failed ? h('p', { class: 'cx-act-sub' }, `└ ${t.needs.failed}`) : null) : null;
  const li = h('li', { class: `cx-turn is-timmy is-${t.state}`, 'data-own': String(i), ...(t.id ? { 'data-turn-id': t.id } : {}) }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '>_'), who, textBlock(t.answer || ''), toolLines, needs, meta);
  // the evidence line from `done`: the sealed receipt (✓ only when the companion said it verified), else no receipt
  if (t.state !== 'streaming') {
    const rc = t.receipt ? (typeof t.receipt === 'string' ? { id: t.receipt.slice(-8), hash: t.receipt, verified: false, where, ms: elapsed, surface: 'companion', status: t.state, steps: t.steps, tools: (t.tools || []).map((x) => ({ name: x.name, outcome: x.status, receipt: x.receipt || '' })), cost: t.cost && typeof t.cost.usd === 'number' ? t.cost : null } : { id: String(t.receipt.id || String(t.receipt.hash || '').slice(-8)), hash: t.receipt.hash || '', verified: t.receipt.verified === true, why: t.receipt.why || (t.receipt.verified === true ? '' : 'not checked on this read: Runs & receipts verifies it'), where: t.receipt.where || where, ms: typeof t.receipt.ms === 'number' ? t.receipt.ms : elapsed, surface: t.receipt.surface || 'companion', status: t.receipt.status || t.state, steps: typeof t.steps === 'number' ? t.steps : t.receipt.steps, tools: (t.tools || []).map((x) => ({ name: x.name, outcome: x.status, receipt: x.receipt || '' })), cost: t.cost && typeof t.cost.usd === 'number' ? t.cost : (t.receipt.cost || null) }) : null;
    li.append(...evidence(`own:${i}`, t.model, rc, [], { own: true, where, seconds: seconds(elapsed), cost: t.cost && t.cost.words ? t.cost.words : '' }));
  }
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
  // R11 round 4: the descriptor keeps the preview's sentence; the saved conversation's facts are the list's label (and its title)
  if (!companion.token || companion.refused) {
    if (sub) sub.textContent = 'Nothing is read without the companion’s token (the note above says how to open this page from Timmy).';
  } else if (!v) {
    if (sub) sub.textContent = cx.viewFailed || 'Think, make and check your work.';
  } else {
    const n = conv ? conv.turns.filter((t) => t.kind !== 'tool').length : 0;
    const since = conv && conv.session ? Number((/^session-(\d{10,14})-/.exec(conv.session) || [])[1]) : NaN;
    if (kicker) kicker.textContent = `Chat / ${cx.project ? cx.project.name : 'this project'}${Number.isFinite(since) ? ` · since ${new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock(new Date(since).toISOString())}` : ''}`;
    if (sub) sub.textContent = 'Think, make and check your work.';
    const facts = conv && conv.session
      ? `The project’s saved conversation, kept in its .sessions folder and continued by the Workbench, the REPL and the monitor: ${n} message${n === 1 ? '' : 's'}${conv.total > conv.turns.length ? `, the newest ${conv.turns.length} of ${conv.total} shown` : ''}. Each answer names the model its sealed receipt records.`
      : 'No conversation saved here yet; the first turn sent from this page begins it.';
    turns.setAttribute('aria-label', facts); turns.title = facts;
    if (tag) { tag.hidden = !(v.route && v.route.kind === 'local' && fakeModel(v.route.model)); tag.textContent = 'FAKE model on this computer'; }
    const fakeTag = $('cx-fake-tag');
    if (fakeTag) { fakeTag.hidden = !(v.route && v.route.kind === 'local' && fakeModel(v.route.model)); }
  }
  // the saved conversation drawn again only when it changed (the companion's answer also changes with a provider's check time):
  // a focused Copy text or an open tool result stays as it was
  const convKey = JSON.stringify(conv ? [conv.session, conv.total, conv.turns] : null);
  if (convKey !== cx.convKey) {
    cx.convKey = convKey;
    turns.replaceChildren(...savedTurns((conv && conv.turns) || [], conv && conv.session));
  }
  drawRunning();
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
  // (R11 step 2: the welcome opens at its top too, as the first run's panel does)
  const panel = st === 'first-run' || st === 'setup' || st === 'empty';
  const shownKey = `${st}:${cx.setup || ''}`;
  const wasPanel = /^(first-run|setup|empty):/.test(cx.shownKey || '');
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
  // (R11 round 4: the route is made on the connections screen; the center shows the welcome until the first turn, and the
  // line above the composer says when no model is connected)
  const empty = (!v.conversation || v.conversation.turns.length === 0) && cx.own.length === 0;
  return empty ? 'empty' : 'chat';
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
    h('li', null, 'Choose it in Models (Enter on its row, or Use for the next turn): this page asks Ollama for that exact name first (no model runs), then keeps it as the setup’s answer, as ', cmd('timmy init --chat local --model <model>'), ' would in a terminal.')),
    h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'refresh' }, 'Refresh'))]];
  if (id === 'ollama-cloud') return ['Remote inference', 'Use Ollama Cloud', [state, h('ol', { class: 'cx-steps' },
    h('li', null, 'Sign in to (or create) your Ollama account and make a key: ', link('ollama-cloud', 0), '. Its plans and usage: ', link('ollama-cloud', 1), '.'),
    h('li', null, 'Its key is set up in the terminal, as part of this checkpoint’s setup; no local weights are downloaded for it.'),
    h('li', null, 'A cloud model served through this computer’s Ollama is still cloud inference: the chat leaves this computer, and local-only refuses it.'))]];
  return ['Advanced, optional', 'Cloudflare', [state, h('p', null, 'An AI Gateway routes and observes model requests; Workers AI runs hosted models; the Agents SDK hosts agents. Each is optional and separate from the logs on this computer, which work without it.'),
    h('p', null, 'Timmy never checks Cloudflare from here: a first request can create a gateway and bill. Its setup: ', link('cloudflare', 0), '.')]];
}

/** R11 step 2: a turn of this project being answered by another surface now: an indicator while it runs (its receipt comes when it ends). */
function drawRunning() {
  const box = $('cx-running');
  if (!box) return;
  const conv = cx.view && cx.view.conversation;
  const run = conv && Array.isArray(conv.running) ? conv.running : [];
  box.hidden = run.length === 0;
  if (!run.length) { box.replaceChildren(); return; }
  box.replaceChildren(...run.map((r) => h('p', { class: 'cx-running-line' }, spinner(), ` A turn of this project is being answered in ${SURFACE_SAID[r.surface] || 'another surface'} since ${clock(r.since) || r.since}; its receipt comes when it ends.`)));
}

/** This page's own turns, said apart from the project's conversation. */
function drawOwn() {
  const own = $('cx-own');
  if (!own) return;
  // (a turn of this page that the project's conversation now holds, by its receipt, is drawn there, not twice)
  const saved = new Set((((cx.view && cx.view.conversation) || {}).turns || []).map((t) => t.receipt && (t.receipt.id || t.receipt.hash)).filter(Boolean));
  const mine = cx.own.filter((t) => !(t.receipt && saved.has(typeof t.receipt === 'string' ? t.receipt.slice(-8) : (t.receipt.id || t.receipt.hash))));
  if (!mine.length) { own.replaceChildren(); return; }
  const list = h('ol', { class: 'cx-turns', 'aria-label': 'This page’s turns in the project’s conversation' });
  mine.forEach((t) => list.append(ownTurn(t, cx.own.indexOf(t))));
  own.replaceChildren(h('p', { class: 'cx-divider' }, 'This page’s turns · sealed to the project’s conversation as they end'), list);
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
  // R11 step 2 (H171; the plan's section 2): a route and no conversation yet: the welcome (three lines) and four starter actions
  // that work today, drawn as the first run's choices; the words are the terminal's (H167's step 2), which the page mirrors
  // R11 round 4 (the preview's welcome, capture 04): the mark, the question, one line, three starters
  box.classList.add('is-welcome');
  redraw(box, [
    h('span', { class: 'sh-mark is-big cx-welcome-mark', 'aria-hidden': 'true' }, h('canvas', { 'data-timmy-mark': '' }), h('span', { class: 'sh-mark-text' }, 'T')),
    h('h2', { class: 'cx-title cx-welcome-title' }, 'What would you like to make?'),
    h('p', { class: 'cx-welcome-line' }, 'Your models, tools and ideas share one workspace.'),
    h('div', { class: 'cx-ways cx-starters' }, ...STARTERS.map((a) => h('button', { type: 'button', class: 'cx-way cx-way-compact', 'data-cx-start': a.id },
      h('span', { class: 'cx-way-glyph', 'aria-hidden': 'true' }, a.glyph), h('span', { class: 'cx-way-title' }, a.title), h('span', { class: 'cx-way-words' }, a.words))))]);
  drawMarks();
}

/** The four starter actions (the plan's section 2; the terminal's words): each a real action this page has today, never a tour. */
/**
 * R11 round 4 (H171, step 3): the T mark (the preview's assets/timmy-mark.riv: a proposed T mark, not a final mascot), drawn
 * through @rive-app/canvas served by the companion (/vendor/rive/rive.js + rive.wasm; no CDN) on every canvas[data-timmy-mark]
 * that has none yet; a runtime or file that is not here leaves the text mark beside it, never an error.
 */
const marks = [];
function drawMarks() {
  const rv = typeof window !== 'undefined' && window.rive && window.rive.Rive ? window.rive : null;
  if (!rv) { loadMarkRuntime(); return; }
  try { if (rv.RuntimeLoader && !drawMarks.wasmSet) { rv.RuntimeLoader.setWasmUrl('/vendor/rive/rive.wasm'); drawMarks.wasmSet = true; } } catch (e) { return; }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const canvas of document.querySelectorAll('canvas[data-timmy-mark]:not([data-rive-started])')) {
    canvas.dataset.riveStarted = '1';
    try {
      const r = new rv.Rive({ src: '/assets/timmy-mark.riv', canvas, artboard: 'TimmyMark', animations: 'Idle', autoplay: !still, enableRiveAssetCDN: false,
        onLoad: () => { try { r.resizeDrawingSurfaceToCanvas(); } catch (e) { /* drawn at its size */ } canvas.dataset.loaded = 'true'; },
        onLoadError: () => { delete canvas.dataset.loaded; } });
      marks.push(r);
    } catch (e) { delete canvas.dataset.loaded; }
  }
}
/**
 * The mark's runtime (/vendor/rive/rive.js, the companion's own copy of @rive-app/canvas), loaded once and only when the companion
 * says it serves the mark's file and the runtime (GET /assets/mark.json → { mark, runtime }; always 200, so a page without the
 * mark records no failed request): without a mark to draw the page loads no runtime, compiles no WebAssembly and asks no CDN,
 * and the text mark stays. (The page's policy allows the WebAssembly only then too: page.ts.)
 */
function loadMarkRuntime() {
  if (drawMarks.runtime || typeof fetch !== 'function') return;
  if (!document.querySelector('canvas[data-timmy-mark]')) return;
  drawMarks.runtime = 'asking';
  fetch('/assets/mark.json', { cache: 'no-store', credentials: 'omit' }).then(async (r) => {
    const b = r.status === 200 ? await r.json().catch(() => null) : null;
    if (!b || b.mark !== true || b.runtime !== true) { drawMarks.runtime = 'none'; return; }
    const s = document.createElement('script');
    s.src = '/vendor/rive/rive.js';
    s.onload = () => { drawMarks.runtime = 'here'; drawMarks(); };
    s.onerror = () => { drawMarks.runtime = 'none'; };
    document.head.append(s);
  }).catch(() => { drawMarks.runtime = 'none'; });
}
window.addEventListener('pagehide', () => { for (const r of marks) { try { r.cleanup(); } catch (e) { /* gone */ } } });

/** The three starters (the preview's words): a draft in the composer, or one of this page's destinations. */
const STARTERS = [
  { id: 'plan', glyph: '⌁', title: 'Plan a project', words: 'Turn an idea into the next step.' },
  { id: 'image', glyph: '◈', title: 'Inspect an image', words: 'Bring it into VoxVision.' },
  { id: 'workflow', glyph: '⇄', title: 'Build a workflow', words: 'Connect your tools around a task.' },
];
const SAMPLE_QUESTION = 'Plan this project: what it does, what ran here last, and the next step.';

/** A starter action: the draft and the composer, or one of this page's tabs. */
function startWith(id) {
  if (id === 'plan' || id === 'ask') {
    const input = $('cx-input');
    if (!input) return;
    if (!input.value.trim()) { input.value = SAMPLE_QUESTION; saveDraft(); drawComposer(); }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  const dest = id === 'image' ? 'voxvision' : id === 'workflow' ? 'workflows' : id === 'canvas' ? 'studio' : '';
  if (dest) { document.body.classList.remove('rail-open'); showWorkspaceTab(dest); }
}

/** The page's choice of model, as the companion read it (GET /api/chat/view's `choice`; see src/companion/chat-view.ts pageChoice). */
function choiceOf(v) { return (v && v.choice) || null; }

function drawRoute() {
  const line = $('cx-route');
  const words = $('cx-route-words');
  if (!line || !words) return;
  const r = routeOf(cx.view);
  const c = choiceOf(cx.view);
  const change = $('cx-change');
  line.classList.toggle('is-off', !(r && r.ready));
  if (!r) { words.textContent = cx.view ? 'The companion said no route.' : 'Asking the companion which route the next turn takes…'; if (change) change.hidden = true; return; }
  if (r.ready) {
    words.replaceChildren('Next turn: ', h('strong', null, r.model), ` · ${routeWhere(r)}`);
    words.title = r.words || '';
    if (change) { change.hidden = false; change.textContent = 'Change model'; change.removeAttribute('data-shell-go'); change.classList.remove('is-setup'); }
  } else {
    // (the preview's words; the exact reason is the line's title and the panel's NEXT TURN)
    words.textContent = 'No model connected. Choose one when you’re ready.';
    words.title = (c && !c.chosen ? 'No model chosen: choose one in Models' : r.label || 'Send is off') + (r.words ? ` — ${r.words}` : '');
    if (change) { change.hidden = false; change.textContent = 'Set up a model →'; change.setAttribute('data-shell-go', 'connections'); change.classList.add('is-setup'); }
  }
}

/**
 * R11 step 1: the composer and its model chip. Send is amber only when a model is chosen and its route is ready; with no
 * choice it is DISABLED and says why ("No model chosen: choose one in Models"); during a turn it is Stop. The chip names
 * the next turn's model and where it runs, its dot by the honesty rule: amber while this page checks, green only after an
 * answer (Ollama's /api/show for a local model, the key's check for OpenRouter), grey when nothing has answered, ✕ with the
 * word on a failure. The chip opens Models.
 */
/**
 * R11 Phase 2 (H168's pass 4b, R51): the composer is one row until typed in, and grows with the draft (to eight rows): the
 * conversation takes the height first. The field's rows follow its text (the attribute, not a style: the page sets none).
 */
function fitInput(input) {
  const lines = input.value ? input.value.split('\n').length : 1;
  input.rows = 1;
  const line = parseFloat(getComputedStyle(input).lineHeight) || 23;
  const fits = Math.round((input.scrollHeight - 4) / line);
  input.rows = Math.min(8, Math.max(1, lines, fits));
}

function drawComposer() {
  const input = $('cx-input');
  const send = $('cx-send');
  const why = $('cx-send-why');
  if (!input || !send) return;
  const r = routeOf(cx.view);
  const c = choiceOf(cx.view);
  fitInput(input);
  drawChip();
  if (cx.running) {
    send.disabled = false;
    send.classList.add('is-stop');
    send.classList.remove('is-muted');
    send.textContent = 'Stop';
    send.setAttribute('aria-label', 'Stop');
    send.title = 'Stops this page’s turn; the answer so far is kept here';
    if (why) why.textContent = '';
    return;
  }
  // R11 step 3: Stop lives in the composer: while another surface answers a turn of this project, it asks that turn to stop
  const other = otherTurn();
  if (other) {
    send.disabled = false;
    send.classList.add('is-stop');
    send.classList.remove('is-muted');
    send.textContent = 'Stop';
    send.setAttribute('aria-label', 'Stop');
    send.dataset.stopTurn = other.id;
    send.title = other.words || `Asks the turn being answered in ${SURFACE_SAID[other.surface] || 'another surface'} to stop`;
    if (why) { why.textContent = `Being answered in ${SURFACE_SAID[other.surface] || 'another surface'}: Stop asks it to stop.`; why.title = other.words || ''; why.dataset.row = 'own'; }
    return;
  }
  delete send.dataset.stopTurn;
  if (why) delete why.dataset.row;
  send.classList.remove('is-stop', 'is-muted');
  send.replaceChildren(h('span', { 'aria-hidden': 'true' }, '↑'));
  send.setAttribute('aria-label', 'Send message');
  const ready = Boolean(r && r.ready);
  const user = signedIn();
  send.disabled = !ready || !user || !input.value.trim();
  const reason = !cx.view ? 'Reading the next turn’s route…' : !r ? 'The companion said no route.' : !ready ? (c && !c.chosen ? 'No model chosen: choose one in Models' : (r.label || 'Send is off')) : !user ? SIGN_IN_TO_SEND : '';
  if (why) { why.textContent = reason; why.title = reason === SIGN_IN_TO_SEND ? SIGN_IN_TO_SEND : r && r.words ? r.words : ''; }
  send.title = !ready ? (r ? r.words || 'Send is off' : 'The route is not known yet') : !user ? SIGN_IN_TO_SEND : !input.value.trim() ? 'Write a message first' : `Sends to ${r.model}: ${r.words || ''}`;
  input.placeholder = 'Message Timmy…';
}

/** The chip's words and dot (see drawComposer). */
function drawChip() {
  const chip = $('cx-chip');
  const dot = $('cx-dot');
  const words = $('cx-chip-words');
  if (!chip || !dot || !words) return;
  const r = routeOf(cx.view);
  const c = choiceOf(cx.view);
  const set = (state, text, title) => { dot.dataset.state = state; dot.textContent = state === 'failed' ? '✕' : state === 'unknown' && !(c && c.chosen) ? '○' : '●'; words.textContent = text; chip.title = title || ''; };
  if (cx.choosing) { set('checking', `${cx.choosing.model} · checking…`, 'Asking Ollama for this model (its /api/show; no model runs)'); return; }
  if (!cx.view) { set('unknown', 'reading…', 'The companion has not answered the Chat’s read yet'); return; }
  if (!c || !c.chosen) { set('unknown', 'no model · choose one', (c && c.words) || (r && r.words) || ''); return; }
  const where = c.source === 'ollama-local' ? 'this computer' : r && r.kind === 'openrouter' && r.price ? `OpenRouter · ${r.price}` : 'OpenRouter';
  const k = c.check || { state: 'unknown', words: '' };
  // (H168's pass 4a R40: the dot's state in a word with its time, as the terminal's chip says it: "· ready HH:MM")
  if (k.state === 'failed') set('failed', `${c.model} · ${c.source === 'ollama-local' ? (/did not answer/.test(k.words) ? 'Ollama did not answer' : 'not listed') : (r && !r.ready ? 'Send is off' : 'key not usable')}`, k.words);
  else set(k.state === 'ready' ? 'ready' : 'unknown', `${c.model} · ${where}${k.state === 'ready' ? ` · ready${k.at ? ` ${clock(k.at)}` : ''}` : k.state === 'unknown' ? ' · not checked' : ''}`, k.words);
  chip.setAttribute('aria-expanded', modelsShown() ? 'true' : 'false');
}

// ── sending: POST /api/chat/turn, the project's conversation, streamed ──

function saveDraft() {
  const input = $('cx-input');
  if (!input) return;
  // R11 round 4: the draft survives the page closed and opened again (localStorage, by project; never a token, never a key)
  try { if (input.value) localStorage.setItem(DRAFT_KEY(cx.project && cx.project.id), input.value); else localStorage.removeItem(DRAFT_KEY(cx.project && cx.project.id)); } catch (e) { /* no storage here */ }
}
function restoreDraft() {
  const input = $('cx-input');
  if (!input) return;
  let text = '';
  try { text = localStorage.getItem(DRAFT_KEY(cx.project && cx.project.id)) || ''; } catch (e) { text = ''; }
  input.value = text;
  drawComposer();
}

/**
 * R11 round 4 (H171, step 2): the turn is the real agent, through H169's POST /api/chat/turn (SSE: route · turn · delta · tool ·
 * needs-you · done · error), for the user's project (the session rides on TimmyShell.fetch). The answer streams; each tool is
 * a line with its outcome; NEEDS-YOU is a question with its options (POST /api/chat/answer); Stop is POST /api/chat/stop by the
 * turn's id; the evidence line comes from `done` (the sealed receipt). The legacy POST /chat caller is gone.
 */
async function sendNow() {
  const input = $('cx-input');
  const r = routeOf(cx.view);
  if (!input || cx.running || !r || !r.ready || !signedIn()) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  saveDraft();
  // the route snapshotted as the turn starts: a later change applies to the next turn, never this one
  const turn = { id: '', you: text, answer: '', model: r.model, label: r.label, state: 'streaming', words: '', at: new Date().toISOString(), started: Date.now(), ended: 0, where: routeWhere(r), tools: [], needs: null, receipt: null, steps: null };
  cx.own.push(turn);
  const controller = new AbortController();
  cx.running = controller;
  cx.follow = true;
  drawChat();
  let raf = 0;
  const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawStreaming(); }); };
  const fetcher = typeof TimmyShell !== 'undefined' ? TimmyShell.fetch : companion.fetch;
  try {
    // (H169's contract C3: { message, project: { root } }; the root is the user's project's, as the companion's socket named it
    // for a signed-in page (project.root); without a session the turn is refused with words, and nothing is sent anywhere)
    const res = await fetcher('/api/chat/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, ...(cx.project && cx.project.root ? { project: { root: cx.project.root } } : {}) }), signal: controller.signal });
    if (res.status === 404) { turn.state = 'failed'; turn.words = 'this companion has no POST /api/chat/turn yet (the agent turn’s server side); nothing was sent'; }
    else if (res.status === 401) { turn.state = 'failed'; turn.words = 'sign in first: the turn runs in your own Timmy home'; }
    else if (!res.ok || !res.body) { let words = `the companion answered HTTP ${res.status}`; try { const b = await res.json(); if (b && (b.words || b.error)) words = b.words || b.error; } catch (e) { /* no body */ } turn.state = 'failed'; turn.words = words; }
    else {
      await readSse(res.body, (event, data) => {
        if (event === 'route' && data) { if (typeof data.label === 'string') turn.label = data.label; if (typeof data.model === 'string' && data.model) turn.model = data.model; }
        else if (event === 'turn' && data) { if (typeof data.id === 'string') turn.id = data.id; redraw(); }
        else if (event === 'delta' && data) { turn.answer += typeof data === 'string' ? data : (data.text || ''); redraw(); }
        else if (event === 'tool' && data) {
          const name = String(data.name || 'a tool');
          const had = turn.tools.find((t) => t.name === name && t.status !== 'completed' && t.status !== 'failed');
          if (had) Object.assign(had, { status: data.status || had.status, receipt: data.receipt || had.receipt });
          else turn.tools.push({ name, status: data.status || 'started', receipt: data.receipt || '' });
          redraw();
        } else if (event === 'needs-you' && data) { turn.needs = { id: String(data.id || turn.id), words: String(data.words || 'Timmy needs you'), options: Array.isArray(data.options) ? data.options : [] }; redraw(); }
        else if (event === 'error') { turn.state = 'failed'; turn.words = (data && (data.words || data.error)) || 'the companion said the turn failed'; }
        else if (event === 'done') {
          if (turn.state === 'streaming') turn.state = 'answered';
          if (data) { if (typeof data.model === 'string' && data.model) turn.model = data.model; turn.receipt = data.receipt || null; turn.steps = typeof data.steps === 'number' ? data.steps : null; turn.cost = data.cost || null; }
          turn.needs = null;
        }
      }, controller.signal);
      if (turn.state === 'streaming') turn.state = 'answered';
    }
  } catch (e) {
    if (controller.signal.aborted) turn.state = 'stopped';
    else { turn.state = 'failed'; turn.words = 'the companion did not answer the request'; }
  } finally {
    turn.ended = Date.now();
    turn.needs = null;
    cx.running = null;
    cx.runningTurn = null;
    drawChat();
    // the turn is the project's now (sealed, in its conversation): read it back; the page's copy folds once it is there
    readView(true, true);
  }
}

/** Server-sent events read from a stream: on(event, data) per event (its data parsed as JSON when it is). */
async function readSse(body, on, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal && signal.aborted) throw new DOMException('stopped', 'AbortError');
    const chunk = await reader.read();
    if (chunk.done) return;
    buf += decoder.decode(chunk.value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let parsed = data.join('\n');
      try { parsed = JSON.parse(parsed); } catch (e) { /* raw text */ }
      on(event, parsed);
      if (event === 'done') return;
    }
  }
}

/** Stop: the companion is asked to stop the turn by its id (POST /api/chat/stop), and this page stops reading. */
function stopNow() {
  const t = cx.own[cx.own.length - 1];
  if (t && t.id) {
    const fetcher = typeof TimmyShell !== 'undefined' ? TimmyShell.fetch : companion.fetch;
    fetcher('/api/chat/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id }) }).catch(() => undefined);
  }
  if (cx.running) cx.running.abort();
}

/** NEEDS-YOU answered: the choice goes to the companion (POST /api/chat/answer); the turn goes on in the same stream. */
async function answerNeedsYou(id, choice) {
  const fetcher = typeof TimmyShell !== 'undefined' ? TimmyShell.fetch : companion.fetch;
  const t = cx.own.find((x) => x.needs && x.needs.id === id);
  if (t) { t.needs = { ...t.needs, answered: choice }; drawStreaming(); }
  try {
    const r = await fetcher('/api/chat/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, choice }) });
    if (!r.ok && t) { t.needs = { ...t.needs, answered: '', failed: `the answer was not taken (HTTP ${r.status})` }; drawStreaming(); }
  } catch (e) { if (t) { t.needs = { ...t.needs, answered: '', failed: 'the answer was not sent' }; drawStreaming(); } }
}


/**
 * R11 step 1: a model chosen on this page (a row's Enter, or Use for the next turn): POST /api/chat/choose, the companion's
 * token-checked route (src/companion/chat-view.ts chooseModel). While it runs, the chip and the row say "checking…"; ready
 * closes Models where it is a drawer, keeps the draft, gives the composer the keyboard and says the next turn's model on the
 * status row; a failure stays on the row with its reason, nothing changed.
 */
async function chooseRow(id) {
  if (!id || cx.choosing) return;
  const m = cx.models;
  const row = ((m.answer && m.answer.ok && m.answer.rows) || []).find((r) => r.id === id);
  if (!row) return;
  const source = row.source === 'openrouter' ? 'openrouter' : row.source === 'ollama-local' ? 'ollama-local' : null;
  if (!source) { cx.chose = { ok: false, model: id, words: 'Ollama Cloud is not a route this page can choose in this checkpoint.' }; drawModelsRail(); return; }
  cx.choosing = { model: id, source };
  cx.chose = null;
  m.selected = id;
  drawModelsRail();
  drawChip();
  let body = null;
  try {
    const r = await userFetch(`/api/chat/choose${projectQuery()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, model: id }) });
    body = await r.json().catch(() => null);
    if (!body || typeof body.words !== 'string') body = { ok: false, state: 'not kept', model: id, words: `The companion answered HTTP ${r.status}; nothing was changed.` };
  } catch (err) {
    body = { ok: false, state: 'unreachable', model: id, words: `The companion could not be reached (${err && err.message ? err.message : String(err)}); nothing was changed.` };
  }
  cx.choosing = null;
  cx.chose = body;
  if (body.ok) {
    chatNote(body.words, null);
    // a setup panel of the first run gives way to the conversation and the composer
    cx.setup = ''; cx.forceChoices = false;
    // the view read again now: the route, the choice and its readiness as the companion holds them after the write
    await readView(true, true);
    drawChat();
    readModels();
    if (narrow()) toggleModels(false);
    const input = $('cx-input');
    if (input) input.focus({ preventScroll: true });
  } else {
    // the selector stays open on that row, its state beside the row and the words in its detail; the row scrolls into view
    drawModelsRail();
    drawChip();
    const back = document.querySelector(`.cm-row[data-model="${CSS.escape(id)}"]`);
    if (back) { back.scrollIntoView({ block: 'nearest' }); back.focus({ preventScroll: true }); }
  }
}

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
    const fetcher = typeof TimmyShell !== 'undefined' ? TimmyShell.fetch : companion.fetch;
    // (the operator's page names the turn; a signed-in page names it with its project's root too: H169's /api/chat/stop)
    const r = await fetcher(`/api/chat/stop${projectQuery()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn: id, id, ...(cx.project && cx.project.root ? { project: { root: cx.project.root } } : {}) }) });
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

const PROVIDERS = [['openrouter', 'local', 'OpenRouter'], ['ollama', 'local', 'Ollama local'], ['ollama', 'cloud', 'Ollama cloud'], ['cloudflare', 'local', 'Cloudflare']];
// R11 round 4: the preview's words for the sort (the companion's sort keys stay)
const SORT_WORDS = { recent: 'Newest first', name: 'Name', price: 'Lowest cost', context: 'Largest context' };
/** The preview's description of each provider tab and its one action (the connections screen does the connecting). */
const PROVIDER_WORDS = {
  'openrouter:local': { name: 'OpenRouter', state: 'openrouter', words: 'Use models from many makers through your OpenRouter account.', act: 'Connect with OpenRouter ↗' },
  'ollama:local': { name: 'Ollama · local', state: 'ollama-local', words: 'Run models on this computer. No provider account required.', act: 'Set up local Ollama ↗' },
  'ollama:cloud': { name: 'Ollama · cloud', state: 'ollama-cloud', words: 'Use models running on Ollama’s servers, under your account’s terms.', act: 'Sign in to Ollama ↗' },
  'cloudflare:local': { name: 'Cloudflare', state: 'cloudflare', words: 'Connect AI Gateway and optional cloud logs. Local logs work without it.', act: 'Open Cloudflare setup ↗' },
};

function sourceOf(m) { return m.provider === 'openrouter' ? 'openrouter' : m.provider === 'ollama' ? (m.sub === 'cloud' ? 'ollama-cloud' : 'ollama-local') : null; }

function readModels() {
  const m = cx.models;
  const source = sourceOf(m);
  if (!source || !companion.token || companion.refused || sessionNeeded()) { drawModelsRail(); return; }
  const seq = ++m.asking;
  const q = new URLSearchParams({ source, sort: m.q.sort });
  for (const k of ['search', 'maker', 'capability', 'cost', 'context']) if (m.q[k]) q.set(k, m.q[k]);
  if (cx.project && cx.project.id) q.set('project', cx.project.id);
  userFetch(`/api/chat/models?${q}`)
    .then((r) => r.json())
    .then((body) => { if (seq !== m.asking) return; m.answer = body && body.ok ? body : { ok: false, error: (body && body.error) || 'The companion could not read the models.' }; })
    .catch(() => { if (seq === m.asking) m.answer = { ok: false, error: 'The companion did not answer the models’ read.' }; })
    .finally(() => { if (seq === m.asking) drawModelsRail({ top: true }); });
}

/** NEXT TURN (the preview's panel bottom): the chosen model or "No model selected", the words, and the model chip (its dot by the honesty rule). */
function nextTurnBlock() {
  const r = routeOf(cx.view);
  const c = choiceOf(cx.view);
  // (the chip is one element, kept across the panel's redraws: it moves into each new block)
  const chip = $('cx-chip') || cx.chipEl;
  if (chip) cx.chipEl = chip;
  const chosen = c && c.chosen ? c.model : r && r.ready ? r.model : '';
  const box = h('div', { class: 'cm-bottom', id: 'cx-next-turn' },
    h('span', { class: 'sh-label' }, 'Next turn'),
    h('h3', { id: 'cx-next-turn-model' }, chosen || 'No model selected'),
    h('p', { class: 'cm-state', id: 'cx-next-turn-words' }, !cx.view ? 'Reading the next turn’s route…' : chosen ? (r && r.ready ? `${routeWhere(r)}. ${r.price ? `${r.price}.` : ''}`.trim() : (r && r.label) || 'Send is off until its route is ready.') : 'Choose a connected model before sending.'));
  if (chip) { chip.hidden = false; box.append(chip); }
  return box;
}

/** The preview's four contextual tools, each with its state word and next step from what this page reads (never invented). */
function toolsPanel() {
  const inv = cx.toolsInv;
  const rows = inv && inv.inventory ? inv.inventory.rows : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const standing = (r) => (r.exercised && r.exercised.ok ? 'exercised' : r.configured && r.configured.ok ? 'configured' : r.available && r.available.ok ? 'available' : '');
  const mcp = rows.filter((r) => /^mcp:server:/.test(r.id));
  const mcpBest = mcp.sort((x, y) => ['', 'available', 'configured', 'exercised'].indexOf(standing(y)) - ['', 'available', 'configured', 'exercised'].indexOf(standing(x)))[0];
  const cf = byId.get('model:cloudflare');
  const items = [
    { id: 'files', name: 'Project files', words: 'Read and write within the current project.',
      state: cx.project ? 'available' : '', next: cx.project ? `${cx.project.name}: writes ask first (Permissions).` : 'No project is shown yet.', act: ['approvals', 'Permissions'] },
    { id: 'web', name: 'Web & research', words: 'Find sources and bring them into your work.',
      state: mcpBest ? standing(mcpBest) : '', next: mcpBest ? `${mcpBest.name}: ${mcpBest.next || 'exercised here'}` : (inv ? 'Connect an integration: an MCP server named in MCPorter’s config (Tools & integrations).' : 'Reading the capability inventory…'), act: ['tools-tab', 'Tools & integrations'] },
    { id: 'canvas', name: 'Canvas', words: 'Plan visually with tldraw and Rive components.',
      state: 'available', next: 'Open the Canvas workspace (the Studio canvas in this page).', act: ['studio', 'Open the Canvas workspace'] },
    { id: 'cloudflare', name: 'Cloudflare agents', words: 'Configure agents, Gateway and optional log sync.',
      state: cf ? standing(cf) : '', next: cf ? (cf.next || (cf.exercised && cf.exercised.ok ? 'exercised here' : '')) : (inv ? 'Optional · not connected' : 'Reading the capability inventory…'), act: ['connections', 'Open Cloudflare setup'] },
  ];
  const kids = [h('div', { class: 'cm-desc' }, h('h3', null, 'Tools for this conversation'), h('p', null, 'Discover tools here, where you use them.'))];
  for (const t of items) {
    kids.push(h('div', { class: 'cx-tool-item', 'data-cx-tool': t.id, 'data-state': t.state || 'none' },
      h('div', { class: 'cm-desc-head' }, h('h3', null, t.name), t.state ? h('span', { class: `cm-word${t.state === 'exercised' ? ' is-verified' : ''}` }, t.state) : h('span', { class: 'cm-word' }, 'not available')),
      h('p', null, t.words),
      h('p', { class: 'cm-state' }, t.next),
      h('button', { type: 'button', class: 'sh-btn-text', ...(t.act[0] === 'connections' ? { 'data-shell-go': 'connections' } : t.act[0] === 'approvals' ? { 'data-cx-ctl': 'approvals' } : t.act[0] === 'tools-tab' ? { 'data-dest': 'tools' } : { 'data-dest': t.act[0] }) }, t.act[1])));
  }
  if (!inv && !cx.toolsInvAsking) readToolsInventory();
  return kids;
}

/** The capability inventory this page's Tools tab reads (GET /api/panel/tools/inventory), once per open; Check again on that tab reads it fresh. */
function readToolsInventory() {
  if (!companion.token || companion.refused) return;
  cx.toolsInvAsking = true;
  const q = cx.project && cx.project.id ? `?project=${encodeURIComponent(cx.project.id)}` : '';
  (typeof TimmyShell !== 'undefined' ? TimmyShell.fetch : companion.fetch)(`/api/panel/tools/inventory${q}`)
    .then((r) => (r.status === 200 ? r.json() : null))
    .then((body) => { cx.toolsInv = body && body.ok ? body : { ok: false, inventory: { rows: [] } }; })
    .catch(() => { cx.toolsInv = { ok: false, inventory: { rows: [] } }; })
    .finally(() => { cx.toolsInvAsking = false; if (cx.panel === 'tools') drawModelsRail(); });
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

/** R11 step 1: the choice's state beside the row itself (as the terminal's selector shows it): "● checking…" while Ollama is asked, "✕ <state>" when it failed; the full words stay in the detail. */
function rowState(row) {
  if (cx.choosing && cx.choosing.model === row.id) return h('span', { class: 'cm-row-state', 'data-state': 'checking' }, h('span', { class: 'cx-dot', 'data-state': 'checking', 'aria-hidden': 'true' }, '●'), ' checking…');
  if (cx.chose && !cx.chose.ok && cx.chose.model === row.id) return h('span', { class: 'cm-row-state', 'data-state': 'failed' }, `✕ ${cx.chose.state === 'unreachable' ? 'no answer from Ollama' : cx.chose.state || 'not kept'}`);
  return null;
}

/** A model's row; the selected one carries its detail right below it (SELECTED), so a short list has no gap and a long one scrolls. */
function modelRow(row, first = false) {
  const sel = row.id === cx.models.selected;
  const btn = h('button', {
    type: 'button', class: 'cm-row', 'aria-current': sel ? 'true' : 'false', 'data-model': row.id, tabindex: sel || (first && !cx.models.selected) ? '0' : '-1', ...(sel ? { 'aria-describedby': 'cm-detail' } : {}),
  },
  h('span', { class: 'cm-row-name' }, h('span', { class: 'cm-name' }, row.name), inUse(row) ? h('span', { class: 'cm-inuse' }, '✓ in use') : rowState(row)),
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
  // R11 step 1: a row is chosen for the next turn from here (the Workbench's own write path, through the companion), with
  // the terminal's feedback: checking… → ready, or not a chat model / unreachable, said beside the row, nothing changed
  const use = h('div', { class: 'cm-use' });
  const chosen = cx.chose && cx.chose.model === row.id ? cx.chose : null;
  const busy = cx.choosing && cx.choosing.model === row.id;
  if (inUse(row)) use.append(h('p', null, '✓ The next turn of this page uses this model.'));
  else if (busy) use.append(h('p', { class: 'cm-use-state', 'data-state': 'checking' }, h('span', { class: 'cx-dot', 'data-state': 'checking', 'aria-hidden': 'true' }, '●'), ` checking… Ollama is asked for ${row.id} (its /api/show; no model runs)`));
  else {
    const can = row.source !== 'ollama-cloud';
    // (the one amber primary: this button while no model is chosen and the center shows no other step; Send once one is)
    const c = choiceOf(cx.view);
    const primary = !(c && c.chosen) && !['first-run', 'setup'].includes(document.body.dataset.chatState || '');
    use.append(h('button', { type: 'button', class: `cx-btn${primary ? ' is-primary' : ''}`, 'data-cm-use': row.id, disabled: !can, 'aria-describedby': 'cm-use-why' }, 'Use for the next turn'),
      h('p', { id: 'cm-use-why' }, row.source === 'ollama-cloud' ? 'Ollama Cloud is not a route this page can choose in this checkpoint (its setup, key and list are; the lead’s decision).'
        : row.source === 'ollama-local' ? 'Ollama is asked for this exact name first (its /api/show; no model runs); then it is kept as the setup’s answer, as timmy init --chat local --model keeps it, for every surface’s next turn.'
          : 'Kept in the settings and as Models’ record, as the Workbench keeps a choice: the next turn of every surface takes it (a turn being answered keeps its own).'));
  }
  if (chosen && !chosen.ok) use.append(h('p', { class: 'cm-use-state', 'data-state': 'failed' }, h('span', { class: 'cx-dot', 'data-state': 'failed', 'aria-hidden': 'true' }, '✕'), ` ${chosen.words}`));
  return h('div', { class: 'cm-detail', id: 'cm-detail' },
    // R10 (H171; H168's pass 3b R18): SELECTED only for the next turn's model; a row the person opened is MODEL / its name
    h('div', { class: 'cm-detail-top' }, h('p', { class: 'cm-detail-k' }, inUse(row) ? 'Selected' : 'Model'), h('p', { class: 'cm-detail-id' }, row.source === 'openrouter' ? `${row.makerLabel || row.maker} · OpenRouter` : row.source === 'ollama-local' ? 'Ollama · this computer' : 'Ollama Cloud')),
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
  // R11 round 4 (the preview's right panel, captures 04/05): the Models and Tools tabs
  kids.push(h('div', { class: 'cx-panel-tabs', role: 'tablist', 'aria-label': 'Panel' },
    h('button', { type: 'button', class: 'cx-panel-tab', role: 'tab', id: 'cx-panel-models', 'data-cx-panel': 'models', 'aria-selected': cx.panel === 'models' ? 'true' : 'false', tabindex: cx.panel === 'models' ? '0' : '-1' }, 'Models'),
    h('button', { type: 'button', class: 'cx-panel-tab', role: 'tab', id: 'cx-panel-tools', 'data-cx-panel': 'tools', 'aria-selected': cx.panel === 'tools' ? 'true' : 'false', tabindex: cx.panel === 'tools' ? '0' : '-1' }, 'Tools')));
  if (cx.panel === 'tools') {
    kids.push(...toolsPanel(), nextTurnBlock());
    rail.replaceChildren(...kids);
    rail.dataset.panel = 'tools';
    return;
  }
  rail.dataset.panel = 'models';
  kids.push(h('div', { class: 'cm-head' }, h('h2', { id: 'cm-title', class: 'visually-hidden' }, 'Models'), a && a.ok ? h('span', { class: 'cm-count visually-hidden' }, String(a.all)) : null));
  kids.push(h('div', { class: 'cm-providers', role: 'tablist', 'aria-label': 'Provider' }, ...PROVIDERS.map(([id, sub, words]) => {
    const on = m.provider === id && (id !== 'ollama' || m.sub === sub);
    return h('button', { type: 'button', class: 'cm-provider', role: 'tab', 'aria-selected': on ? 'true' : 'false', 'data-cm-provider': id, 'data-cm-sub': sub, tabindex: on ? '0' : '-1', id: `cm-p-${id}-${sub}` }, words);
  })));
  // the chosen provider: its name with its state word, the preview's description, its one action (the connections screen)
  const pw = PROVIDER_WORDS[`${m.provider}:${m.sub}`];
  const st = providerState(pw.state);
  const live = Boolean(st && st.state === 'checked');
  kids.push(h('div', { class: 'cm-desc', id: 'cm-desc' },
    h('div', { class: 'cm-desc-head' }, h('h3', null, pw.name), h('span', { class: `cm-word cm-desc-state${live ? ' is-live' : ''}`, id: 'cm-desc-state' }, !st ? 'not known yet' : live ? `● answered ${st.at ? clock(st.at) : ''}`.trim() : st.state === 'not set up' ? 'Not connected' : st.state)),
    h('p', null, pw.words),
    st ? h('p', { class: 'cm-state' }, `${st.words}${st.next ? ` ${st.next}` : ''}`) : h('p', { class: 'cm-state' }, 'Reading the providers’ states…'),
    h('button', { type: 'button', class: 'sh-btn is-wide cm-connect', 'data-shell-go': 'connections', 'data-cm-connect': pw.state }, pw.act)));
  if (m.provider === 'cloudflare') {
    const cf = st;
    kids.push(h('div', { class: 'cm-panel' },
      h('ul', { class: 'cm-parts' }, ...cfLines(cf).map(([k, v]) => h('li', null, h('strong', null, k), h('span', null, v)))),
      h('p', null, 'Cloudflare routes no model of its own here: its settings are on the connections screen.')));
    kids.push(nextTurnBlock());
    rail.replaceChildren(...kids);
    return;
  }
  kids.push(h('label', { class: 'cm-search', for: 'cm-search' }, h('span', { 'aria-hidden': 'true' }, '⌕'),
    h('input', { id: 'cm-search', type: 'search', placeholder: 'Search models or makers', value: m.q.search, 'data-cm-q': 'search', 'aria-controls': 'cm-list', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search models or makers' })));
  const makers = (a && a.ok && a.makers) || [];
  // the five controls (the preview's words): Sort · All makers · All capabilities · Any cost · Any context
  kids.push(h('div', { class: 'cm-filters' },
    selectOpt('sort', 'Sort', m.q.sort, Object.entries(SORT_WORDS), 'is-sort'),
    selectOpt('maker', 'Maker', m.q.maker, [['', 'All makers'], ...makers.map((x) => (typeof x === 'string' ? [x, x] : [x.id, `${x.label} (${x.count})`]))]),
    selectOpt('capability', 'Capability', m.q.capability, [['', 'All capabilities'], ['tools', 'Tools'], ['vision', 'Vision'], ['reasoning', 'Reasoning']]),
    selectOpt('cost', 'Cost', m.q.cost, [['', 'Any cost'], ['free', 'Free models'], ['paid', 'Paid only']]),
    selectOpt('context', 'Context', m.q.context, [['', 'Any context'], ['32000', '32K or more'], ['128000', '128K or more'], ['1000000', '1M or more']])));
  if (m.q.search || m.q.maker || m.q.capability || m.q.cost || m.q.context) kids.push(h('button', { type: 'button', class: 'cm-clear', 'data-cx': 'clear-filters' }, 'Clear filters'));
  const rows = (a && a.ok && a.rows) || [];
  // R10 (H171; H168's pass 3b R18): a row is opened for the person only when it is the next turn's model; with none in use
  // here nothing is ("Model / none"), until the person opens a row (a click, Enter, or the arrows)
  if (!rows.some((r) => r.id === m.selected)) { const used = rows.find(inUse); m.selected = used ? used.id : ''; }
  const matched = a && a.ok ? (typeof a.matched === 'number' ? a.matched : rows.length) : 0;
  // (the local Ollama: its chat models of all it lists, H168's R20; a model that is not one is listed, not a row)
  const listed = a && a.ok && typeof a.listed === 'number' && a.listed > (a.all || 0) ? a.listed : 0;
  const count = `${matched} ${listed ? `chat model${matched === 1 ? '' : 's'} · ${listed} listed` : `model${matched === 1 ? '' : 's'}`}${matched > rows.length ? ` · first ${rows.length}` : ''}`;
  kids.push(h('div', { class: 'cm-list-head' }, h('span', null, m.provider === 'openrouter' ? (a && a.from === 'cache' ? (a.cache === 'fetched' ? 'Public catalog · fetched' : 'Public catalog snapshot') : 'Catalog') : m.sub === 'local' ? 'Installed on this computer' : 'Ollama Cloud'), h('span', null, a && a.ok ? count : '')));
  if (rows.length && !m.selected) {
    const r = routeOf(cx.view);
    kids.push(h('p', { class: 'cm-none', id: 'cm-none' }, h('span', { class: 'cm-none-k' }, 'Model'), ' / none · ',
      r && r.ready ? `the next turn uses ${r.model} (${routeWhere(r)}), not a row here; a row shows its facts when you open it.` : 'no model is chosen for the next turn; a row shows its facts when you open it.'));
  }
  const list = h('ul', { class: 'cm-list', id: 'cm-list', 'aria-label': 'Models' });
  // an Ollama with nothing listed: the state line above already says why, in the provider's words
  const stated = m.provider === 'ollama' && providerState(m.sub === 'cloud' ? 'ollama-cloud' : 'ollama-local');
  if (!a) list.append(h('li', { class: 'cm-empty' }, 'Reading the models…'));
  else if (!a.ok) list.append(h('li', { class: 'cm-empty' }, a.error));
  else if (!rows.length && !a.all && !(stated && listed)) list.append(h('li', { class: 'cm-empty cm-empty-models' }, h('span', { 'aria-hidden': 'true' }, '⌁'), h('strong', null, 'Your models will appear here.'), h('span', null, stated ? 'None listed: the line above says why. ' : (a.words ? `${a.words} ` : ''), 'Connect a provider to load its real catalog. No catalog or live prices are invented.')));
  else if (!rows.length) list.append(h('li', { class: 'cm-empty' }, a.all ? 'No model matches these filters. Clear filters shows them all again.' : 'No local chat model here: the line above says why.'));
  else rows.forEach((r, i) => list.append(modelRow(r, i === 0)));
  if (a && a.ok && a.left) list.append(h('li', { class: 'cm-empty cm-left' }, `Not shown as local chat models: ${a.left}.`));
  kids.push(list);
  // OpenRouter's catalog: where its rows come from and their date (a snapshot, never a live quote)
  if (a && a.ok && m.provider === 'openrouter' && a.words && rows.length) kids.push(h('div', { class: 'cm-foot', id: 'cm-foot' }, a.words));
  kids.push(nextTurnBlock());
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

/**
 * R11 step 3 (the plan's bottom row; H167's): [Attach] [Tools] [Budget] [Logs]; below 1181 px (the terminal target's 80 x 24)
 * Attach and Logs move into More. Plan / Run, Permissions and Cloudflare live in the Tools drawer ("More controls"); Stop
 * lives in the composer. What waits on you counts on Tools.
 */
// R11 round 4 (the preview's bottom row, capture 04): Plan / Run · Permissions · Budget · Logs, and Cloudflare optional at the right
const CONTROLS = [['plan', '▱', 'Plan / Run', false], ['approvals', '◇', 'Permissions', false], ['budget', '$', 'Budget', false], ['logs', '≡', 'Logs', false]];
const MINOR = [['attachments', '+', 'Attach'], ['tools', '⌘', 'Tools']];
const MORE_CONTROLS = [['attachments', '+', 'Attach'], ['tools', '⌘', 'Tools'], ['cloudflare', '⌁', 'Cloudflare optional']];
// (on a phone More also holds Cloudflare optional, which the row leaves out there)

function controlCounts() {
  const f = workspace.frame;
  const v = cx.view;
  const waiting = f && f.activity ? f.activity.waitingOnYou : null;
  return { tools: waiting ? String(waiting) : '', attachments: '', plan: '', budget: v && v.policy && v.policy.freeOnly ? 'free-only' : '', approvals: waiting ? String(waiting) : '', logs: '', cloudflare: '' };
}

/** Another surface's turn of this project being answered now (the frame's activity), for the composer's Stop and the status row. */
function otherTurn() {
  const f = workspace.frame;
  return f && f.activity && f.activity.chatTurn && f.activity.chatTurn.id ? f.activity.chatTurn : null;
}

function drawControls() {
  const bar = $('cx-controls');
  if (!bar) return;
  const counts = controlCounts();
  const kids = [];
  for (const [id, glyph, words, minor] of CONTROLS) kids.push(ctlButton(id, glyph, words, counts[id], minor));
  // (Stop lives in the composer; while the composer is away, another surface's turn keeps its Stop here)
  const other = otherTurn();
  const composer = $('cx-composer');
  if (other && composer && composer.hidden) kids.push(h('button', { type: 'button', class: 'cx-ctl is-stop', 'data-cx': 'stop-other', 'data-stop-turn': other.id, title: other.words }, `■ Stop the turn in ${SURFACE_SAID[other.surface] || 'another surface'}`));
  kids.push(h('button', { type: 'button', class: 'cx-more', id: 'cx-more', 'data-cx-ctl': 'more', 'aria-expanded': cx.drawer === 'more' ? 'true' : 'false', 'aria-controls': 'cx-drawer' }, h('span', { 'aria-hidden': 'true' }, '⋯'), 'More'));
  // the right side: the running words (what the status row said) and Cloudflare optional
  const running = cx.running ? '1 running (this page’s turn)' : other ? '1 running (the chat turn)' : '';
  kids.push(h('span', { class: 'cx-ctl-right' }, running ? h('span', { class: 'cx-ctl-running', id: 'cx-running-words' }, running) : null,
    ctlButton('cloudflare', '⌁', 'Cloudflare optional', '', false)));
  redraw(bar, kids);
}

function ctlButton(id, glyph, words, n, minor) {
  return h('button', { type: 'button', class: `cx-ctl${minor ? ' is-minor' : ''}`, 'data-cx-ctl': id, 'aria-expanded': cx.drawer === id ? 'true' : 'false', 'aria-controls': 'cx-drawer' },
    h('span', { 'aria-hidden': 'true' }, glyph), ' ', words, n ? [' ', h('span', { class: 'cx-ctl-n' }, n)] : null);
}

function drawerBody(id) {
  const v = cx.view;
  const r = routeOf(v);
  const f = workspace.frame;
  const p = (k) => providerState(k);
  switch (id) {
    case 'tools': {
      const counts = controlCounts();
      // (R11 round 4: the turn is the real agent (POST /api/chat/turn): the project's tools run in it, a write only after you allow it)
      return ['Tools', [h('p', null, 'The turn runs the project’s tools (reading, searching, running what the workflow names), writing a file only after you allow it: each tool is a line under the answer with its outcome. The panel’s Tools tab says which tools this conversation has, in the three words of their state.'),
        h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx-panel': 'tools' }, 'Tools for this conversation'), h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'tools' }, 'Open Tools & integrations')),
        h('p', { class: 'cx-act-k' }, 'More controls'),
        h('div', { class: 'cx-more-list' }, ...MORE_CONTROLS.filter(([k]) => k !== 'tools').map(([k, glyph, words]) => h('button', { type: 'button', class: 'cx-btn', 'data-cx-ctl': k, 'aria-controls': 'cx-drawer' }, h('span', { 'aria-hidden': 'true' }, `${glyph} `), words, counts[k] ? h('span', { class: 'cx-ctl-n' }, ` ${counts[k]}`) : null))),
        h('p', { class: 'cx-setup-note' }, 'Stop lives in the composer: it stops this page’s turn, or asks the turn another surface is answering to stop.')]];
    }
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
      return ['More controls', [h('div', { class: 'cx-more-list' }, ...MORE_CONTROLS.map(([k, glyph, words]) => h('button', { type: 'button', class: 'cx-btn', 'data-cx-ctl': k, 'aria-controls': 'cx-drawer' },
        h('span', { 'aria-hidden': 'true' }, `${glyph} `), words, counts[k] ? h('span', { class: 'cx-ctl-n' }, ` ${counts[k]}`) : null)))]];
    }
    case 'keys': return ['Help', [h('div', { class: 'cx-drawer-grid' },
      h('section', null, h('h4', null, 'Chat'), h('p', null, 'Enter sends · Ctrl+J (or Shift+Enter) a new line · Stop in the composer stops the turn · Enter or a click on the line under an answer opens its activity · keys you type in the composer never open anything')),
      h('section', null, h('h4', null, 'Models'), h('p', null, 'M shows or hides Models · the chip opens them too · Up and Down move along the list · Enter on a row chooses it for the next turn (Ollama is asked first; nothing runs) · Tab moves to the next control')),
      h('section', null, h('h4', null, 'Moving around'), h('p', null, '1 to 9, then 0, the destinations · / finds one by name · ? this help · Esc closes a drawer and returns to where you were')),
      h('section', null, h('h4', null, 'Runs'), h('p', null, 'Runs & receipts lists this project’s runs with their receipts · Workflows shows each run’s progress and result · a run starts in the terminal (/run <workflow> <block>)')))]];
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

/** "granite4.2:latest on this computer", "none (no model chosen)", or why Send is off. */
function nextTurnWords() {
  const r = routeOf(cx.view);
  const c = choiceOf(cx.view);
  if (!cx.view || !r) return 'not known yet';
  if (r.ready) return `${r.model} on ${r.kind === 'local' ? (r.cloud ? 'Ollama Cloud through this computer’s Ollama' : r.loopback ? 'this computer' : 'another computer’s Ollama') : 'OpenRouter'}`;
  if (c && !c.chosen) return 'none (no model chosen: choose one in Models)';
  return `none (${r.label || 'Send is off'})`;
}

/** Whether the workspace frame says logs sync to the cloud (H170's Cloudflare setting); off unless the frame says so. */
function cloudSyncOn() {
  const f = workspace.frame;
  const c = f && (f.cloud || f.connections);
  if (!c) return false;
  if (typeof c.sync === 'boolean') return c.sync;
  if (c.cloudflare && typeof c.cloudflare === 'object') return c.cloudflare.state === 'checked' && c.cloudflare.sync === true;
  return false;
}

/** The next turn's spend in H167's words: "no charge", "$x in / $y out per 1M", "free", "unknown", "none (no model)". */
function spendWords() {
  const r = routeOf(cx.view);
  if (!r || !r.ready) return 'none (no model)';
  if (r.kind === 'local') return r.cloud ? 'unknown' : 'no charge';
  const p = String(r.price || '');
  if (/^free\b/.test(p)) return 'free';
  const m = /(\$[\d.,]+) in \/ (\$[\d.,]+) out per 1M/.exec(p);
  return m ? `${m[1]} in / ${m[2]} out per 1M` : 'unknown';
}

function drawStatus() {
  const bar = $('cx-status');
  const stateWords = $('cx-state-words');
  const descState = $('cx-descriptor-state');
  // R11 round 4: the state words of the top line and the descriptor (the preview's "Local logs · cloud sync off")
  const sync = `Local logs · cloud sync ${cloudSyncOn() ? 'on' : 'off'}`;
  if (stateWords) stateWords.textContent = sync;
  if (descState) descState.textContent = sync;
  if (!bar) return;
  const r = routeOf(cx.view);
  const fake = r && r.kind === 'local' && fakeModel(r.model);
  const other = otherTurn();
  // R11 step 3: sentences, as the terminal's status row ("Logs stay on this computer · 1 running (the chat turn)"; "cloud sync off · spend …")
  const running = cx.running ? ' · 1 running (this page’s turn)' : other ? ' · 1 running (the chat turn)' : '';
  bar.replaceChildren(
    h('span', { class: 'cx-st-pair is-logs' }, h('span', { class: 'cx-st-v' }, `Logs stay on this computer${running}`)),
    h('span', { class: 'cx-st-sep', 'aria-hidden': 'true' }, '·'),
    // (R11 step 1: the next turn's model, as the terminal's status row says it)
    h('span', { class: 'cx-st-pair is-inference' }, h('span', { class: 'cx-st-k' }, 'Next turn:'), h('span', { class: 'cx-st-v' }, nextTurnWords())),
    h('span', { class: 'cx-st-right' }, h('span', { class: 'cx-st-sync' }, `cloud sync off · spend ${spendWords()}`), fake ? h('span', null, 'FAKE model') : null));
}

// ── events ──

document.addEventListener('click', (event) => {
  const at = event.target instanceof Element ? event.target : null;
  if (!at) return;
  const dest = at.closest('#rail-menu .rail-item');
  if (dest) {
    // (Models & accounts: the connections screen; shell.js's [data-shell-go] handler takes it)
    if (dest.dataset.shellGo) { awayNote(''); document.body.classList.remove('rail-open'); return; }
    if (dest.dataset.dest) {
      awayNote(''); document.body.classList.remove('rail-open'); showWorkspaceTab(dest.dataset.dest);
      // (Models & accounts: Home, at its connections)
      if (dest.dataset.scroll === 'connections') { const box = document.querySelector('.home-conn-box'); if (box) box.scrollIntoView({ block: 'start' }); }
      return;
    }
    if (dest.dataset.away === 'connections') { awayNote(''); showWorkspaceTab('home'); const box = document.querySelector('.home-conn-box'); if (box) box.scrollIntoView({ block: 'nearest' }); return; }
    if (dest.dataset.away === 'files') { awayNote('files'); return; }
  }
  if (at.closest('#rail-project')) { toggleProjectMenu($('rail-project-menu').hidden); return; }
  if (at.closest('#rail-new')) { toggleNewProject($('rail-new-note').hidden); return; }
  // R11 round 4: New conversation: this page's own turns put away and the draft cleared (the project's saved conversation stays)
  if (at.closest('#rail-new-conv')) { newConversation(); return; }
  const answer = at.closest('[data-cx-answer]');
  if (answer) { answerNeedsYou(answer.dataset.cxAnswerId, answer.dataset.cxAnswer); return; }
  const userProject = at.closest('[data-cx-project]');
  if (userProject) { chooseUserProject(userProject.dataset.cxProject); return; }
  // the right panel's tabs (Models | Tools); the composer's ⌘ Tools opens the Tools tab (and the panel, when it is a drawer)
  const panelTab = at.closest('[data-cx-panel]');
  if (panelTab) { cx.panel = panelTab.dataset.cxPanel === 'tools' ? 'tools' : 'models'; drawModelsRail(); if (panelTab.id === 'cx-tools-btn') toggleModels(true); else document.getElementById(`cx-panel-${cx.panel}`)?.focus(); return; }
  // a tool item's destination (Canvas, Tools & integrations): the page's tab
  const toolDest = at.closest('.cx-tool-item [data-dest]');
  if (toolDest) { closeDrawer(); showWorkspaceTab(toolDest.dataset.dest); return; }
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
  if (at.closest('#cx-chip')) { toggleModels(true); $('cm-search')?.focus(); return; }
  const use = at.closest('[data-cm-use]');
  if (use) { chooseRow(use.dataset.cmUse); return; }
  if (at.closest('#cx-menu, #ws-menu')) { toggleRail(); return; }
  if (at.closest('#cx-change')) { toggleModels(true); $('cm-search')?.focus(); return; }
  const prov = at.closest('[data-cm-provider]');
  if (prov) { cx.models.provider = prov.dataset.cmProvider; cx.models.sub = prov.dataset.cmSub || 'local'; cx.models.chosenProvider = true; cx.models.answer = null; cx.models.selected = ''; drawModelsRail(); readModels(); document.getElementById(prov.id)?.focus(); return; }
  const row = at.closest('[data-model]');
  if (row && row.classList.contains('cm-row')) { cx.models.selected = row.dataset.model; drawModelsRail(); document.querySelector(`.cm-row[data-model="${CSS.escape(row.dataset.model)}"]`)?.focus(); return; }
  const way = at.closest('[data-cx-way]');
  if (way) { chooseWay(way.dataset.cxWay); return; }
  const start = at.closest('[data-cx-start]');
  if (start) { startWith(start.dataset.cxStart); return; }
  if (at.closest('#rail-find-btn')) { toggleFind(); return; }
  if (at.closest('#rail-help')) { openDrawer('keys', $('rail-help')); return; }
  const ev = at.closest('[data-activity]');
  if (ev) { const k = ev.dataset.activity; if (openActivity.has(k)) openActivity.delete(k); else openActivity.add(k); cx.convKey = ''; drawChat(); document.querySelector(`[data-activity="${CSS.escape(k)}"]`)?.focus({ preventScroll: true }); return; }
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

/** R11 round 4: a new conversation on this page: its own turns put away, the draft cleared, the composer focused. */
function newConversation() {
  if (cx.running) cx.running.abort();
  cx.own = [];
  const input = $('cx-input');
  if (input) { input.value = ''; saveDraft(); }
  drawChat();
  document.body.classList.remove('rail-open');
  if (input) input.focus();
}

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
  if (event.target instanceof HTMLFormElement && event.target.id === 'rail-new-form') {
    event.preventDefault();
    const name = String(new FormData(event.target).get('name') || '').trim();
    if (name) makeUserProject(name);
    return;
  }
  if (event.target instanceof HTMLFormElement && event.target.id === 'cx-composer') {
    event.preventDefault();
    const send = $('cx-send');
    if (cx.running) stopNow();
    else if (send && send.dataset.stopTurn) stopOther(send);
    else sendNow();
  }
});
document.addEventListener('keydown', (event) => {
  const at = event.target;
  if (at instanceof HTMLTextAreaElement && at.id === 'cx-input' && !event.isComposing) {
    // Enter sends; Ctrl+J (the chord the hint names; Shift+Enter too) a new line
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) { event.preventDefault(); if (!cx.running) sendNow(); return; }
    if ((event.key === 'j' || event.key === 'J') && event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const a = at.selectionStart, b = at.selectionEnd;
      at.value = `${at.value.slice(0, a)}\n${at.value.slice(b)}`;
      at.selectionStart = at.selectionEnd = a + 1;
      saveDraft(); drawComposer();
      return;
    }
  }
  // R11 step 3: the rail's finder: typing filters the destinations, Enter opens the first, Esc clears it
  if (at instanceof HTMLInputElement && at.id === 'rail-find') {
    if (event.key === 'Enter') { event.preventDefault(); const first = document.querySelector('#rail-menu .rail-item'); if (first instanceof HTMLElement) { first.click(); toggleFind(false); } return; }
    if (event.key === 'Escape') { event.preventDefault(); toggleFind(false); $('rail-find-btn')?.focus(); return; }
    return;
  }
  // Enter on a row of Models chooses it for the next turn (the terminal's Enter); the arrows move along the list
  if (at instanceof Element && at.classList.contains('cm-row') && event.key === 'Enter') { event.preventDefault(); chooseRow(at.dataset.model); return; }
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
  if (event.key === '?') { event.preventDefault(); openDrawer('keys', $('cx-keys')); return; }
  if (event.key === '/') { event.preventDefault(); document.body.classList.add('rail-open'); toggleFind(true); }
});
$('rail-find')?.addEventListener('input', (event) => { cx.find = event.target instanceof HTMLInputElement ? event.target.value : ''; drawRail(); });
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
  // R11 step 2: the indicators of what runs (the playbook §17: a braille spinner at 80 ms, still under reduced motion) and the
  // elapsed seconds of this page's turn being answered
  let spin = 0;
  setInterval(() => {
    const spins = document.querySelectorAll('.cx-spin');
    if (!spins.length || reducedMotion()) return;
    spin = (spin + 1) % SPIN.length;
    spins.forEach((el) => { el.textContent = SPIN[spin]; });
  }, 80);
  setInterval(() => { if (cx.running) drawStreaming(); }, 1000);
  // the frame (tab labels, waiting counts, the project's commands, a turn running elsewhere) is read by companion.js; the
  // rail and the controls follow it
  // (R11 step 3: the composer's Stop and the status row follow the frame's activity too: another surface's turn)
  setInterval(() => { drawRail(); if (cx.dest === 'chat') { drawControls(); drawComposer(); drawStatus(); railProject(); } }, 3000);
  // R11 round 4: the rail's account block follows the session (H173's account.js sets it); a change re-reads what is the
  // user's (the view, the models, the projects); Sign out is H173's (window.timmyAccount.signOut) or the shell's forgetting
  if (typeof TimmyShell !== 'undefined') {
    const drawAccount = (user) => {
      const box = $('rail-account');
      if (!box) return;
      box.dataset.signed = user ? 'yes' : 'no';
      // (the lead's ruling of 21:48: with no identity provider configured the page is this computer's operator, and the block
      // names the dependency; configured and not signed in → "Not signed in")
      const idc = typeof TimmyShell.identity === 'function' ? TimmyShell.identity() : null;
      const configured = Boolean(idc && idc.configured);
      const needs = idc && Array.isArray(idc.needs) && idc.needs.length ? idc.needs.join(', ') : 'CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY';
      const name = user ? String(user.username || user.email || user.id || 'Signed in') : configured ? 'Not signed in' : 'This computer’s operator';
      $('rail-account-name').textContent = name;
      $('rail-account-sub').textContent = user ? 'your Timmy home' : configured ? 'this companion’s own workspace' : `no identity provider configured (${needs})`;
      $('rail-avatar').textContent = user ? (name.trim()[0] || 'T').toUpperCase() : 'T';
      $('rail-signout').hidden = !user;
    };
    drawAccount(TimmyShell.session.user());
    TimmyShell.on('identity', () => { drawAccount(TimmyShell.session.user()); drawComposer(); });
    TimmyShell.on('session', ({ user }) => {
      drawAccount(user); cx.view = null; cx.userProjects = null; cx.toolsInv = null; cx.models.answer = null;
      // the socket hears of the session too: a new hello (the companion's view becomes the user's project; a page that was
      // waiting without a session gets its project frames now)
      if (typeof wsConnection !== 'undefined' && wsConnection && wsConnection.readyState === 1 && typeof helloMessage === 'function') { try { wsConnection.send(JSON.stringify(helloMessage())); } catch (e) { /* the socket reconnects on its own */ } }
      if (cx.dest === 'chat') { readView(true); drawChat(); readModels(); }
    });
    // R11 round 4 (H170's socket event): a connection of this account changed: the models' states and the route are read again
    // eslint-disable-next-line no-global-assign
    onConnectionsChanged = () => { cx.models.answer = null; if (cx.dest === 'chat') { readView(true, true); readModels(); } };
    TimmyShell.on('screen', ({ id }) => {
      if (id !== 'chat' || cx.dest !== 'chat') return;
      readView(true); drawChat(); readModels();
      // the conversation read while this screen was hidden could not scroll (no height): shown, it opens at its end as a
      // conversation does, unless a panel (the first run, a setup, the welcome) is what is shown
      const s = $('cx-scroll');
      if (s && cx.follow && !/^(first-run|setup|empty):/.test(cx.shownKey || '')) s.scrollTop = s.scrollHeight;
    });
    $('rail-signout')?.addEventListener('click', () => {
      if (window.timmyAccount && typeof window.timmyAccount.signOut === 'function') { Promise.resolve(window.timmyAccount.signOut()).catch(() => undefined); return; }
      TimmyShell.session.clear();
      TimmyShell.land();
    });
  }
})();
