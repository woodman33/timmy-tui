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
  /** the bottom drawer open now ('' none) and the control that opened it */
  drawer: '',
  drawerFrom: null,
  /** the conversation follows new messages while the person is at its end */
  follow: true,
  lastKey: '',
};

const CX_VIEW_EVERY_MS = 4000;
const DRAFT_KEY = (id) => `timmy.chat.draft.${id || 'none'}`;
const projectQuery = (sep = '?') => (cx.project && cx.project.id ? `${sep}project=${encodeURIComponent(cx.project.id)}` : '');
const $ = (id) => document.getElementById(id);
const clock = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
const fakeModel = (m) => /\bfake\b|^fake-|-fake\b/i.test(String(m || ''));

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
  menu.replaceChildren(...items);
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
  menu.replaceChildren(...kids);
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
  if (workspace.tab === id) onDest(id);
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

function readView(force = false) {
  if (!companion.token || companion.refused) { drawChat(); return Promise.resolve(); }
  if (cx.asking) return cx.asking;
  cx.asking = companion.fetch(`/api/chat/view${projectQuery()}`)
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

function savedTurn(t) {
  if (t.kind === 'tool') {
    const lines = String(t.text || '').split('\n').length;
    return h('li', { class: 'cx-turn is-tool' }, h('span', { class: 'cx-mark', 'aria-hidden': 'true' }, '⚒'),
      h('details', { class: 'cx-tool' }, h('summary', null, 'Tool result · ', h('strong', null, t.tool || 'a tool'), ` · ${lines} line${lines === 1 ? '' : 's'}${t.cut ? ' (cut)' : ''}`), h('pre', null, t.text)));
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
  turns.replaceChildren(...((conv && conv.turns) || []).map(savedTurn));
  // this page's own turns, said apart from the project's conversation
  const own = $('cx-own');
  if (own) {
    if (cx.own.length) {
      const list = h('ol', { class: 'cx-turns', 'aria-label': 'This page’s own chat' });
      cx.own.forEach((t, i) => list.append(ownTurn(t, i)));
      own.replaceChildren(h('p', { class: 'cx-divider' }, 'This page’s own chat · not saved to the project’s conversation · no tools · no receipt'), list);
    } else own.replaceChildren();
  }
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
  if (scroll && cx.follow && atEnd) scroll.scrollTop = scroll.scrollHeight;
}

function drawEmpty() {
  const box = $('cx-empty');
  if (!box) return;
  const v = cx.view;
  const empty = v && v.conversation && v.conversation.turns.length === 0 && cx.own.length === 0;
  box.hidden = !empty;
  if (!empty) return;
  const r = routeOf(v);
  if (r && r.ready) {
    box.replaceChildren(h('h3', null, 'Start the conversation.'),
      h('p', null, `Your first message goes to ${r.model} (${routeWhere(r)}). This page’s own chat is not saved to the project; the Workbench’s is.`),
      h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'focus-composer' }, 'Write a message')));
  } else {
    box.replaceChildren(h('h3', null, 'Connect a model to chat.'),
      h('p', null, 'Your project, its files and its local logs work without a model. Answers need a model: on this computer (Ollama) or a provider you connect.'),
      h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn is-primary', 'data-cx': 'open-models' }, 'Choose a model')));
  }
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
  send.textContent = 'Send ↑';
  const ready = Boolean(r && r.ready);
  send.disabled = !ready || !input.value.trim();
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
  const redraw = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; drawChat(); }); };
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
    .finally(() => { if (seq === m.asking) drawModelsRail(); });
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
const providerState = (id) => ((cx.view && cx.view.providers) || []).find((p) => p.id === id) || null;

function inUse(row) {
  const r = routeOf(cx.view);
  if (!r || !r.ready) return false;
  if (r.kind === 'local') return row.source !== 'openrouter' && row.id === r.model;
  return row.source === 'openrouter' && row.id === r.model;
}

function modelRow(row) {
  const sel = row.id === cx.models.selected;
  return h('li', { role: 'presentation' }, h('button', {
    type: 'button', class: 'cm-row', role: 'option', 'aria-selected': sel ? 'true' : 'false', 'data-model': row.id, tabindex: sel ? '0' : '-1',
  },
  h('span', { class: 'cm-row-name' }, h('span', { class: 'cm-name' }, row.name), inUse(row) ? h('span', { class: 'cm-inuse' }, '✓ in use') : null),
  row.name !== row.id ? h('span', { class: 'cm-row-id' }, row.id) : null,
  row.description ? h('span', { class: 'cm-row-desc' }, row.description) : null,
  h('span', { class: 'cm-row-facts' }, h('span', null, row.source === 'openrouter' ? ctxWords(row.contextLength) : row.installed ? `installed${typeof row.sizeBytes === 'number' ? ` · ${(row.sizeBytes / 1e9).toFixed(1)} GB` : ''}` : 'cloud-backed'), h('span', null, row.source === 'ollama-local' ? 'no charge' : priceWords(row.price)))));
}

function modelDetail(row) {
  if (!row) return null;
  const facts = [];
  const add = (k, v) => facts.push(h('dt', null, k), h('dd', null, v));
  add('Model id', row.id);
  if (row.source === 'openrouter') {
    add('Context', typeof row.contextLength === 'number' ? `${row.contextLength.toLocaleString('en-US')} tokens` : 'unknown');
    add('Input', typeof row.price.inPerM === 'number' ? `${money(row.price.inPerM)} per 1M tokens` : 'unknown');
    add('Output', typeof row.price.outPerM === 'number' ? `${money(row.price.outPerM)} per 1M tokens` : 'unknown');
    add('Tools', capWord(row.caps.tools));
    add('Vision', capWord(row.caps.vision));
    add('Reasoning', capWord(row.caps.reasoning));
    if (row.created) add('Added to OpenRouter', new Date(row.created * 1000).toISOString().slice(0, 10));
  } else {
    add('Runs', row.source === 'ollama-local' ? 'on this computer (local weights)' : 'in Ollama’s cloud: the chat leaves this computer');
    if (typeof row.sizeBytes === 'number') add('On disk', `${(row.sizeBytes / 1e9).toFixed(1)} GB (not the memory it needs)`);
    add('Tools', capWord(row.caps.tools));
  }
  const r = routeOf(cx.view);
  const use = h('div', { class: 'cm-use' });
  if (inUse(row)) use.append(h('p', null, '✓ The next turn of this page uses this model.'));
  else {
    use.append(h('button', { type: 'button', class: 'cx-btn', disabled: true, 'aria-describedby': 'cm-use-why' }, 'Use for the next turn'),
      h('p', { id: 'cm-use-why' }, `Not available on this page yet: its Send asks ${r && r.model ? r.model : 'the setup’s model'}, the setup’s choice. In the REPL, /setup chat keeps the model every surface uses.`));
  }
  return h('div', { class: 'cm-detail', 'aria-live': 'polite' }, h('p', { class: 'cm-detail-k' }, 'Selected'), h('h3', null, row.name), h('p', { class: 'cm-detail-id' }, row.source === 'openrouter' ? `${row.maker} · OpenRouter` : row.source === 'ollama-local' ? 'Ollama · this computer' : 'Ollama Cloud'),
    row.description ? h('p', null, row.description) : null, h('dl', { class: 'cm-facts' }, ...facts), use);
}

function selectOpt(name, label, value, options, cls = '', shown = true) {
  const id = `cm-${name}`;
  const sel = h('select', { id, 'data-cm-q': name });
  for (const [v, words] of options) { const o = h('option', { value: v }, words); if (v === value) o.selected = true; sel.append(o); }
  return h('div', { class: `cm-filter ${cls}` }, h('label', { for: id, class: shown ? null : 'visually-hidden' }, label), sel);
}

function drawModelsRail() {
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
      h('dl', { class: 'cm-kv' }, h('dt', null, 'This computer holds'), h('dd', null, cf ? cf.state : 'not known yet'), h('dt', null, 'AI Gateway'), h('dd', null, 'not configured'), h('dt', null, 'Cloud log sync'), h('dd', null, 'off')),
      h('p', null, cf ? cf.words : 'Reading the providers’ states…'),
      h('p', null, 'Its setup is in the terminal; Timmy never checks it from here (a request can create a gateway and bill).')));
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
    selectOpt('maker', 'Maker', m.q.maker, [['', 'All'], ...makers.map((x) => [x, x])]),
    selectOpt('capability', 'Capability', m.q.capability, [['', 'All'], ['tools', 'Tools'], ['vision', 'Vision'], ['reasoning', 'Reasoning']]),
    selectOpt('cost', 'Cost', m.q.cost, [['', 'All'], ['free', 'Free only'], ['paid', 'Paid only']]),
    selectOpt('context', 'Context', m.q.context, [['', 'All'], ['32000', '32K+'], ['128000', '128K+'], ['1000000', '1M+']])));
  if (m.q.search || m.q.maker || m.q.capability || m.q.cost || m.q.context) kids.push(h('button', { type: 'button', class: 'cm-clear', 'data-cx': 'clear-filters' }, 'Clear filters'));
  const rows = (a && a.ok && a.rows) || [];
  if (rows.length && !rows.some((r) => r.id === m.selected)) {
    const used = rows.find(inUse);
    m.selected = (used || rows[0]).id;
  }
  kids.push(h('div', { class: 'cm-list-head' }, h('span', null, m.provider === 'openrouter' ? (a && a.from === 'cache' ? 'Public catalog snapshot' : 'Catalog') : m.sub === 'local' ? 'Installed on this computer' : 'Cloud-backed'), h('span', null, a && a.ok ? `${a.total} model${a.total === 1 ? '' : 's'}${a.total > rows.length ? ` · first ${rows.length}` : ''}` : '')));
  const list = h('ul', { class: 'cm-list', id: 'cm-list', role: 'listbox', 'aria-label': 'Models' });
  if (!a) list.append(h('li', { class: 'cm-empty' }, 'Reading the models…'));
  else if (!a.ok) list.append(h('li', { class: 'cm-empty' }, a.error));
  else if (!rows.length) list.append(h('li', { class: 'cm-empty' }, a.all ? 'No model matches these filters. Clear filters shows them all again.' : a.words));
  else for (const r of rows) list.append(modelRow(r));
  kids.push(list);
  const chosen = rows.find((r) => r.id === m.selected);
  if (chosen) kids.push(modelDetail(chosen));
  // the source's words (OpenRouter's catalog and its date; an Ollama that did not answer); the state line above says the rest
  const foot = a && a.ok && (m.provider === 'openrouter' || !rows.length) ? a.words : '';
  if (foot) kids.push(h('div', { class: 'cm-foot', id: 'cm-foot' }, foot));
  rail.replaceChildren(...kids);
  if (focusedId) {
    const back = document.getElementById(focusedId) || rail.querySelector(`[data-model="${CSS.escape(focusedId)}"]`);
    if (back) { back.focus(); if (back instanceof HTMLInputElement) { const n = back.value.length; back.setSelectionRange(n, n); } }
  }
}

let searchTimer = 0;
function setQuery(name, value) {
  cx.models.q[name] = value;
  if (name === 'search') { clearTimeout(searchTimer); searchTimer = setTimeout(readModels, 220); return; }
  readModels();
}

// ── the bottom: the conversation's controls, the drawer, the status line ──

const CONTROLS = [
  ['attachments', '⎘', 'Attach'], ['tools', '⚒', 'Tools'], ['plan', '☰', 'Plan / Run'], ['approvals', '✓', 'Permissions'], ['budget', '$', 'Budget'],
];

function drawControls() {
  const bar = $('cx-controls');
  if (!bar) return;
  const f = workspace.frame;
  const v = cx.view;
  const waiting = f && f.activity ? f.activity.waitingOnYou : null;
  const counts = { tools: '0', attachments: '0', plan: '', budget: v && v.policy && v.policy.freeOnly ? 'free-only' : '—', approvals: waiting === null ? '' : String(waiting) };
  const kids = [h('span', { class: 'cx-controls-label' }, 'This conversation')];
  for (const [id, glyph, words] of CONTROLS) kids.push(ctlButton(id, glyph, words, counts[id]));
  const other = f && f.activity && f.activity.chatTurn && f.activity.chatTurn.id ? f.activity.chatTurn : null;
  if (cx.running) kids.push(h('button', { type: 'button', class: 'cx-ctl is-stop', 'data-cx': 'stop' }, '■ Stop'));
  else if (other) kids.push(h('button', { type: 'button', class: 'cx-ctl is-stop', 'data-cx': 'stop-other', 'data-stop-turn': other.id, title: other.words }, `■ Stop the turn in ${other.surface}`));
  else kids.push(h('button', { type: 'button', class: 'cx-ctl is-off', disabled: true, title: 'Nothing is being answered now' }, '■ Stop'));
  kids.push(ctlButton('logs', '▤', 'Logs', 'this computer'), ctlButton('cloudflare', '☁', 'Cloudflare', ''));
  bar.replaceChildren(...kids);
}

function ctlButton(id, glyph, words, n) {
  return h('button', { type: 'button', class: 'cx-ctl', 'data-cx-ctl': id, 'aria-expanded': cx.drawer === id ? 'true' : 'false', 'aria-controls': 'cx-drawer' },
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
      h('section', null, h('h4', null, 'Local-only'), h('p', { class: 'cx-d-state' }, 'not in this revision'), h('p', null, (v && v.policy && v.policy.localOnlyWords) || '')))]];
    case 'approvals': {
      const n = f && f.activity ? f.activity.waitingOnYou : null;
      return ['Permissions', [h('p', null, `${n === null ? 'Not known yet' : `${n} waiting on you`}. A tool that needs you waits in the surface running the turn (the Workbench, the REPL); this page’s Send runs no tool, so it asks for none. Control Room lists what waits.`), h('div', { class: 'cx-empty-actions' }, h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'control' }, 'Open Control Room'))]];
    }
    case 'cloudflare': {
      const cf = p('cloudflare');
      return ['Optional Cloudflare settings', [h('p', null, 'Chat history and logs stay usable on this computer without a Cloudflare account. Each service has its own state, and Timmy never checks one from here: a request can create a gateway and bill.'), h('div', { class: 'cx-drawer-grid' },
        h('section', null, h('h4', null, 'Worker / Commander'), h('p', { class: 'cx-d-state' }, cf && cf.state === 'saved, not checked' ? 'saved, not checked' : 'not connected'), h('p', null, 'Durable application service and agent route.')),
        h('section', null, h('h4', null, 'AI Gateway'), h('p', { class: 'cx-d-state' }, 'not configured'), h('p', null, 'Optional routing and observability for model requests.')),
        h('section', null, h('h4', null, 'Cloud log sync'), h('p', { class: 'cx-d-state' }, 'off · logs stay local'), h('p', null, 'Turning it on needs a configured destination and your clear consent.')))]];
    }
    case 'logs': return ['Logs on this computer', [h('p', null, (v && v.logs && v.logs.words) || 'Logs and receipts stay on this computer.'), h('p', null, (v && v.logs && v.logs.cloud) || ''), h('div', { class: 'cx-empty-actions' },
      h('button', { type: 'button', class: 'cx-btn', 'data-cx-dest': 'logs' }, 'Open Logs & receipts'), h('button', { type: 'button', class: 'cx-btn', 'data-cx': 'older' }, 'Show the turn mirror'))]];
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
  const back = cx.drawerFrom && document.contains(cx.drawerFrom) ? cx.drawerFrom : (was === 'keys' ? $('cx-keys') : document.querySelector(`[data-cx-ctl="${was}"]`));
  cx.drawerFrom = null;
  if (back) back.focus();
  return true;
}

function drawStatus() {
  const bar = $('cx-status');
  if (!bar) return;
  const r = routeOf(cx.view);
  const fake = r && r.kind === 'local' && fakeModel(r.model);
  bar.replaceChildren(
    h('span', { class: 'cx-st-k' }, 'Logs:'), h('span', { class: 'cx-st-v' }, `this computer / ${cx.running ? 'answering' : 'idle'}`),
    h('span', { class: 'cx-st-sep', 'aria-hidden': 'true' }, '|'),
    h('span', { class: 'cx-st-k' }, 'Inference:'), h('span', { class: 'cx-st-v' }, r ? `${routeWhere(r)}${r.ready ? ` / ${r.model}` : ''}` : 'not known yet'),
    h('span', { class: 'cx-st-right' }, h('span', null, 'Cloud sync off'), fake ? h('span', null, 'FAKE model') : null));
}

// ── events ──

document.addEventListener('click', (event) => {
  const at = event.target instanceof Element ? event.target : null;
  if (!at) return;
  const dest = at.closest('#rail-menu .rail-item');
  if (dest) {
    if (dest.dataset.dest) { awayNote(''); showWorkspaceTab(dest.dataset.dest); return; }
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
  if (ctl) { openDrawer(ctl.dataset.cxCtl, ctl); return; }
  if (at.closest('#cx-keys')) { openDrawer('keys', $('cx-keys')); return; }
  if (at.closest('#cx-models-toggle')) { toggleModels(); return; }
  if (at.closest('#cx-change')) { toggleModels(true); $('cm-search')?.focus(); return; }
  const prov = at.closest('[data-cm-provider]');
  if (prov) { cx.models.provider = prov.dataset.cmProvider; cx.models.sub = prov.dataset.cmSub || 'local'; cx.models.chosenProvider = true; cx.models.answer = null; cx.models.selected = ''; drawModelsRail(); readModels(); document.getElementById(prov.id)?.focus(); return; }
  const row = at.closest('[data-model]');
  if (row && row.classList.contains('cm-row')) { cx.models.selected = row.dataset.model; drawModelsRail(); document.querySelector(`.cm-row[data-model="${CSS.escape(row.dataset.model)}"]`)?.focus(); return; }
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
  else if (what === 'stop-other' && typeof stopTurn === 'function') stopTurn(act);
  else if (what === 'older') { closeDrawer(); $('cx-older')?.scrollIntoView({ block: 'start' }); }
});

function toggleModels(open) {
  const body = $('cx-body');
  const btn = $('cx-models-toggle');
  if (!body || !btn) return;
  const show = open === undefined ? body.classList.contains('models-closed') : open;
  body.classList.toggle('models-closed', !show);
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  try { localStorage.setItem('timmy.chat.models', show ? 'open' : 'closed'); } catch (e) { /* no storage here */ }
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
  if (event.target instanceof HTMLFormElement && event.target.id === 'cx-composer') { event.preventDefault(); if (cx.running) stopNow(); else sendNow(); }
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
  if (models === 'closed') toggleModels(false);
  drawRail();
  restoreDraft();
  onDest(workspace.tab);
  setInterval(() => { if (!document.hidden && cx.dest === 'chat') readView(); }, CX_VIEW_EVERY_MS);
  // the frame (tab labels, waiting counts, the project's commands, a turn running elsewhere) is read by companion.js; the
  // rail and the controls follow it
  setInterval(() => { drawRail(); if (cx.dest === 'chat') { drawControls(); railProject(); } }, 3000);
})();
