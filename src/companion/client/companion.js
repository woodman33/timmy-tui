/*
 * The browser companion's page script (src/companion/client/index.html).
 *
 * R4 (H92): it was inline in the page; it is a file the companion serves, so the page runs under its
 * Content-Security-Policy (script-src 'self': no inline script and no inline handler). The page's buttons are wired here
 * (data-tab, data-action, data-copy), its looks are classes of companion.css (no style attribute), and the tab transitions
 * use the browser's own Web Animations (they were GSAP's, from a CDN). Nothing here comes from another site.
 * R4 (H95): the page's own design is back (companion.css, as at b69ab12): the markup this script writes carries the classes
 * that hold the values its style attributes had, and the tab fades have GSAP's durations and easing. The STREAMDOWN CHAT
 * tab is the Streamdown island (/web/island/companion-chat.js, built by scripts/companion-web-build.mjs), which asks
 * through this script's chat call.
 */

// R4 (H84): the companion's token. Timmy gives this page's address with it in the fragment (#t=<64 hex>), which a
// browser never sends to a server; it is taken out of the address at once and kept in this page's memory only (no
// storage, no cookie), and sent in an Authorization header on each request and as a WebSocket subprotocol. Without
// it, or when the companion says it is not its token, the page loads nothing more and says how to open it from Timmy.
const companion = (() => {
  let token = '';
  try {
    const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (m) {
      token = m[1];
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) { /* no address to read */ }
  const OPEN_FROM_TIMMY = 'Open it from Timmy: in `timmy watch`, press q on HOME; it shows the companion’s address with its token.';
  const c = {
    token,
    refused: false,
    protocols: () => ['timmy-companion', 'timmy-token.' + token],
    say(words) {
      const note = document.getElementById('token-note');
      if (note) { note.textContent = words; note.hidden = false; }
      const status = document.getElementById('status-text');
      if (status) status.textContent = 'COMPANION · NEEDS ITS TOKEN';
    },
    refuse() {
      c.refused = true;
      c.say('This page’s token is not the companion’s (Timmy started it again, or the address was copied wrong), so it loads nothing. ' + OPEN_FROM_TIMMY);
      // R4 (H104, second part): what waits for the companion (a run detail opened by its address) says why it is not read
      try { document.dispatchEvent(new Event('timmy:refused')); } catch (e) { /* no document events here */ }
    },
    // Every request to the companion: the token in a header, never in the address; a 401 stops the page.
    fetch(path, init) {
      const o = Object.assign({}, init || {});
      o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token });
      o.credentials = 'omit';
      o.cache = 'no-store';
      return fetch(path, o).then((r) => { if (r.status === 401) c.refuse(); return r; });
    },
    // Whether the companion still takes this token (asked when the socket closes); true when it cannot be asked.
    check: () => c.fetch('/api/auth').then((r) => r.status !== 401, () => true),
    // POST /chat, streamed: calls on(event, data) for each server-sent event (delta, usage, error, done).
    async chat(messages, on, signal) {
      const res = await c.fetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal });
      if (!res.ok || !res.body) throw new Error('Companion /chat responded HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
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
    },
  };
  if (!token) c.say('This page has no token from Timmy, so it loads nothing: the companion answers only the address Timmy gives, which carries its token after #. ' + OPEN_FROM_TIMMY);
  return c;
})();
// R4 (H104, second part): the chat's route as the companion says it (GET /api/chat/route: the setup's choice, read again at
// each ask): the local model through this computer's Ollama with no tools, OpenRouter with a key, or none, and then why Send
// is off. The island draws it beside Send; the STREAMDOWN CHAT tab's route line says it too. Never a key.
const chatRoute = (() => {
  let now = null;
  const listeners = new Set();
  const set = (r) => {
    now = r;
    const line = document.getElementById('sd-route');
    if (line) line.textContent = r.ready ? `POST /chat → ${r.label} → SSE → live React components` : String(r.label);
    for (const fn of listeners) { try { fn(r); } catch (e) { /* one listener's failure is its own */ } }
  };
  const refresh = async () => {
    if (!companion.token || companion.refused) {
      set({ kind: 'none', ready: false, label: 'no token · Send is off', words: 'Send is off: this page has no token from Timmy (or not this companion’s), so it asks nothing. Open the companion from `timmy watch` (q on HOME).' });
      return now;
    }
    try {
      const r = await companion.fetch('/api/chat/route');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      set(await r.json());
    } catch (e) {
      set({ kind: 'none', ready: false, label: 'route not known · Send is off', words: `Send is off: the companion could not be asked which route the chat takes (${e && e.message ? e.message : 'no answer'}), so this page asks nothing.` });
    }
    return now;
  };
  return { now: () => now, refresh, on(fn) { listeners.add(fn); if (now) fn(now); return () => { listeners.delete(fn); }; } };
})();
// The model chat (the Streamdown island, /web/island/companion-chat.js) streams through this call and asks whether the page
// may ask; the token itself is not put on window. R4 (H104, second part): and which route it takes (route, onRoute, refreshRoute).
window.timmyCompanion = {
  chat: (messages, on, signal) => companion.chat(messages, on, signal),
  ready: () => Boolean(companion.token) && !companion.refused,
  route: chatRoute.now,
  onRoute: chatRoute.on,
  refreshRoute: chatRoute.refresh,
};
chatRoute.refresh();

const statusEl = document.getElementById('status-text');
const consoleLogs = document.getElementById('console-logs');
const logsList = document.getElementById('logs-list');

// Proof labels
const pRunId = document.getElementById('proof-run-id');
const pPrompt = document.getElementById('proof-prompt');
const pAgent = document.getElementById('proof-agent');
const pTools = document.getElementById('proof-tools');
const pChanged = document.getElementById('proof-changed');
const pHash = document.getElementById('proof-hash');
const pPath = document.getElementById('proof-path');

let wsConnection = null;
let activeChatHistory = [];
let isViewingSaved = false;
let loadedChatId = null;
// R4 (H104): the history shown is this browser's own copy from before this page was opened (localStorage), not chat of
// this session; this session's own (a sync, a live answer, Delete Local) ends it.
let mirrorRestored = false;

const mirrorStatusEl = document.getElementById('mirror-status');

// The mirror's state, in its words (LIVE, RESTORED, SAVED, WAITING, RECONNECTING); its look follows data-state.
function updateMirrorStatus(status) {
  if (mirrorStatusEl) {
    mirrorStatusEl.textContent = `Local chat mirror: ${status}`;
    mirrorStatusEl.dataset.state = String(status).toLowerCase();
  }
}

// Load active mirror and saved sessions from localStorage
try {
  const activeCache = localStorage.getItem('timmy.chat.active');
  if (activeCache) {
    activeChatHistory = JSON.parse(activeCache);
    if (!Array.isArray(activeChatHistory)) activeChatHistory = [];
    mirrorRestored = activeChatHistory.length > 0;
    // R4 (H104): an empty copy restores nothing
    updateMirrorStatus(mirrorRestored ? 'RESTORED' : 'WAITING');
  } else {
    updateMirrorStatus('WAITING');
  }
} catch (e) {
  activeChatHistory = [];
  updateMirrorStatus('WAITING');
}

// ── The chat mirror (tests/companion-client.test.ts runs this part of the file) ──

// R4 (H104): r24 found the mirror empty with nothing saying why. It shows this session's chat as the companion's socket
// carries it, and says where chat happens when none has come:
//  - this monitor's chat (`timmy watch`): its words, as its terminal sends them (sync, agent:delta);
//  - the REPL's (`timmy`, a process of its own): each turn when it ends, as the event bus carries it: the receipt Timmy
//    sealed (receipt.sealed of kind `turn`, src/repl/seal.ts). The REPL seals a turn's prompt and answer as SHA-256 hashes
//    only, so their words are never on the bus: the row names the receipt and says the words are in the REPL.
// Only this session's: the bus's live events (appended after this companion started) and, of the tail it sends on
// connecting (six hours), what was sealed at or after the start its welcome gives (`since`).
let mirrorSince = null;
const mirrorTurns = new Map(); // this session's REPL turns, by their receipt's hash
const REPL_TURN = /^repl · (cancelled · )?(\d+) steps?$/; // src/repl/seal.ts: the subject of a turn's receipt

// R4 (H104, second part): the project this page shows, as the companion says it (its welcome, then a `project` message when
// it changes: its id, name, folder from ~, and following, pinned or fixed). The REPL turns shown are that project's (the
// companion tails its folder's bus); a page moved to another project does not keep the turns of the one before. A pin is
// this tab's own: kept over a reload (sessionStorage), named in the hello, forgotten when the companion does not keep it.
let mirrorProject = null;
const PIN_KEY = 'timmy.companion.pin';

/** The project id this tab pinned, or null. */
function storedPin() {
  try { const id = sessionStorage.getItem(PIN_KEY); return id && /^[0-9a-f]{16}$/.test(id) ? id : null; } catch (e) { return null; }
}
function keepPin(id) {
  try { if (id) sessionStorage.setItem(PIN_KEY, id); else sessionStorage.removeItem(PIN_KEY); } catch (e) { /* no storage here */ }
}

/** This page shows `project` now; true when it is another project than before (its REPL turns are not this one's). */
function takeProject(project) {
  if (!project || typeof project !== 'object' || typeof project.id !== 'string') return false;
  const moved = Boolean(mirrorProject) && mirrorProject.id !== project.id;
  if (moved) mirrorTurns.clear();
  mirrorProject = project;
  keepPin(project.mode === 'pinned' ? project.id : null);
  if (typeof projectHeader === 'function') projectHeader(project);
  return moved;
}

/** The hello this page sends: with the project this tab pinned, when it pinned one. */
function helloMessage() {
  const pin = storedPin();
  return pin ? { type: 'hello', pin } : { type: 'hello' };
}

/** A REPL turn from a bus event, or null: a sealed turn receipt of the runs chain, this session's. */
function replTurnOf(event, live) {
  if (!event || event.kind !== 'receipt.sealed' || !event.payload || typeof event.payload !== 'object') return null;
  const p = event.payload;
  if (p.kind !== 'turn' || p.stream !== 'runs') return null;
  const hash = String(p.hash || '');
  if (!/^sha256_[0-9a-f]{64}$/.test(hash)) return null;
  const at = Date.parse(event.ts);
  if (!Number.isFinite(at)) return null;
  if (!live) {
    const since = Date.parse(mirrorSince);
    if (!Number.isFinite(since) || at < since) return null;
  }
  const m = REPL_TURN.exec(String(p.subject || ''));
  return { hash, at, receipt: hash.slice(7, 15), cancelled: Boolean(m && m[1]), steps: m ? Number(m[2]) : null };
}

/** Takes the REPL turns among bus events; true when one is new. */
function takeReplTurns(events, live) {
  let added = false;
  for (const e of events) {
    const turn = replTurnOf(e, live);
    if (turn && !mirrorTurns.has(turn.hash)) { mirrorTurns.set(turn.hash, turn); added = true; }
  }
  return added;
}

/** Whether chat of this session has reached the mirror: this monitor's (not a restored copy) or a REPL turn. */
function mirrorHasSession() {
  return mirrorTurns.size > 0 || (!mirrorRestored && activeChatHistory.length > 0);
}

function replTurnHtml(turn) {
  const time = new Date(turn.at).toLocaleTimeString();
  const state = turn.cancelled ? 'cancelled' : 'ended';
  const steps = turn.steps === null ? '' : ` (${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'})`;
  return `
      <div class="log-msg repl" data-mirror="repl-turn">
        <div class="log-header repl">
          <span>⌨ REPL turn · ${state}</span>
          <span class="log-time">${escapeMirrorText(time)}</span>
        </div>
        <div class="log-content">A chat turn in the REPL (<span class="mirror-code">timmy</span>) ${state}${steps}; Timmy sealed it as receipt <span class="mirror-code">${escapeMirrorText(turn.receipt)}</span>. Its words are in the REPL: Timmy seals a REPL turn's prompt and answer as hashes only, so they are not on the event bus and are not shown here.</div>
      </div>
    `;
}

/**
 * R4 (H104, second part): where a REPL turn must happen to be seen here: in the project this page shows (Timmy keeps an
 * event bus in each project's folder, and the companion reads the shown project's).
 */
function replWhereHtml() {
  const p = mirrorProject;
  if (!p) return 'A REPL turn is seen here when the REPL works in the project this page shows (not known yet): Timmy keeps an event bus in each project\'s folder, and this page reads that project\'s.';
  const which = `${escapeMirrorText(p.name)} (<span class="mirror-code">${escapeMirrorText(p.folder)}</span>)`;
  if (p.mode === 'fixed') return `A REPL turn is seen here when the REPL works in ${which}, the folder <span class="mirror-code">TIMMY_REPO</span> fixed for this companion: Timmy keeps an event bus in each project's folder, and this page reads that one's.`;
  return `A REPL turn is seen here when the REPL works in the project this page shows, ${which} (in the REPL, <span class="mirror-code">/project</span> chooses one): Timmy keeps an event bus in each project's folder, and this page reads that project's.`;
}

/** What the mirror says when no chat of this session has reached it: where chat happens, and why none is shown. */
function mirrorEmptyHtml() {
  let head;
  if (!companion.token || companion.refused) {
    head = 'Nothing reaches this page without the companion\'s token (see the note above), so whether chat happened in this session is not known here.';
  } else if (!mirrorSince) {
    head = 'Not connected to the companion yet, so whether chat happened in this session is not known yet.';
  } else {
    const since = new Date(mirrorSince);
    head = `No chat in this session yet: none has reached this page since this companion started${Number.isNaN(since.getTime()) ? '' : ` at ${since.toLocaleTimeString()}`}.`;
  }
  return `
      <div class="mirror-empty explain" data-mirror="empty">
        <div class="mirror-empty-head">${escapeMirrorText(head)}</div>
        <div>Chat happens in Timmy's terminal, not on this page:</div>
        <ul>
          <li>In this monitor (<span class="mirror-code">timmy watch</span>), type in its chat line: each message and its answer appear here as they are sent.</li>
          <li>In the REPL (<span class="mirror-code">timmy</span>), each turn appears here when it ends, as the receipt Timmy sealed for it. Its words stay in the REPL (a REPL turn's prompt and answer are sealed as hashes only). ${replWhereHtml()}</li>
        </ul>
        <div>STREAMDOWN CHAT is this page's own chat with a model; its ✨ sample is labelled SAMPLE there and is never shown here.</div>
      </div>
    `;
}

function saveActiveChat() {
  try {
    localStorage.setItem('timmy.chat.active', JSON.stringify(activeChatHistory));
  } catch (e) {
    console.error('LocalStorage sync error:', e);
  }
}

function getSavedChats() {
  try {
    const raw = localStorage.getItem('timmy.chat.sessions');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSavedChats(chats) {
  try {
    localStorage.setItem('timmy.chat.sessions', JSON.stringify(chats));
  } catch (e) {
    console.error('LocalStorage save error:', e);
  }
}

// Save current active chat session
function saveCurrentChat() {
  const history = activeChatHistory;
  if (history.length === 0) {
    alert("Cannot save empty chat session.");
    return;
  }

  const chats = getSavedChats();
  const firstPromptMsg = history.find(m => m.role === 'user');
  const firstPrompt = firstPromptMsg ? firstPromptMsg.content : "Empty Chat";

  const newChat = {
    id: `chat_${Date.now()}`,
    timestamp: new Date().toLocaleString(),
    firstPrompt: firstPrompt.length > 50 ? firstPrompt.substring(0, 50) + '...' : firstPrompt,
    messagesCount: history.length,
    messages: history
  };

  // Check if we have already saved this state
  const alreadySaved = chats.find(c => c.messages.length === history.length && c.messages[c.messages.length - 1]?.content === history[history.length - 1]?.content);
  if (alreadySaved) {
    updateMirrorStatus('SAVED');
    setTimeout(() => updateMirrorStatus('LIVE'), 2000);
    return;
  }

  chats.unshift(newChat);
  saveSavedChats(chats);
  renderSavedChatsList();
  updateMirrorStatus('SAVED');
  setTimeout(() => updateMirrorStatus(activeChatHistory.length > 0 ? 'LIVE' : 'WAITING'), 2000);
  appendToLocalLogs('SUCCESS', `Saved current chat session locally: ${newChat.id}`);
}

// Download current chat as JSON
function downloadCurrentChat() {
  const history = isViewingSaved
    ? getSavedChats().find(c => c.id === loadedChatId)?.messages
    : activeChatHistory;

  if (!history || history.length === 0) {
    alert("No chat data available to download.");
    return;
  }

  try {
    const jsonStr = JSON.stringify(history, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timmy-chat-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    appendToLocalLogs('SUCCESS', 'Exported session chat messages as JSON successfully.');
  } catch (err) {
    alert("Export failed: " + err.message);
  }
}

// Delete current local active browser copy
function deleteCurrentChat() {
  if (confirm("Delete local browser copy? Terminal session and receipts are not deleted.")) {
    activeChatHistory = [];
    mirrorRestored = false;
    saveActiveChat();
    renderConsoleLogs([]);
    // R4 (H104): this session's REPL turns are not the browser's copy: they stay
    updateMirrorStatus(mirrorHasSession() ? 'LIVE' : 'WAITING');
    appendToLocalLogs('WARN', 'Cleared browser-local mirror memory cache.');
  }
}

// Load saved chat into viewer
function loadSavedChat(chatId) {
  const chats = getSavedChats();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  isViewingSaved = true;
  loadedChatId = chatId;

  renderConsoleLogs(chat.messages);

  // R4 (H92): built from elements and text (its button wired by the page's own click handler: data-action)
  const banner = document.createElement('div');
  banner.id = 'saved-chat-banner';
  banner.className = 'saved-banner';
  const label = document.createElement('span');
  const when = document.createElement('strong');
  when.textContent = String(chat.timestamp);
  label.append('📂 Viewing Saved Session from ', when);
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn-action success';
  back.dataset.action = 'exit-saved';
  back.textContent = 'Back to Live Mirror';
  banner.append(label, back);

  const logsContainer = document.getElementById('console-logs');
  if (logsContainer.firstChild) {
    logsContainer.insertBefore(banner, logsContainer.firstChild);
  } else {
    logsContainer.appendChild(banner);
  }

  appendToLocalLogs('INFO', `Loaded saved session: ${chatId}`);
}

function exitSavedChatViewer() {
  isViewingSaved = false;
  loadedChatId = null;
  renderConsoleLogs(activeChatHistory);
  appendToLocalLogs('INFO', 'Returned to real-time live terminal mirror.');
}

function downloadSavedChat(chatId) {
  const chats = getSavedChats();
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  try {
    const jsonStr = JSON.stringify(chat.messages, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timmy-saved-chat-${chatId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  }
}

function deleteSavedChat(chatId) {
  if (confirm("Delete this saved chat session from browser local storage?")) {
    let chats = getSavedChats();
    chats = chats.filter(c => c.id !== chatId);
    saveSavedChats(chats);
    renderSavedChatsList();

    if (isViewingSaved && loadedChatId === chatId) {
      exitSavedChatViewer();
    }
    appendToLocalLogs('WARN', `Deleted saved chat: ${chatId}`);
  }
}

function renderSavedChatsList() {
  const listEl = document.getElementById('saved-chats-list');
  const chats = getSavedChats();

  if (chats.length === 0) {
    listEl.innerHTML = '<div class="saved-empty">Saved chats will appear here after you press Save Chat.</div>';
    return;
  }

  listEl.innerHTML = chats.slice(0, 5).map(c => {
    // R4 (H92): the id travels in a data attribute, encoded (no " < > & survive encodeURIComponent), and the page's own
    // click handler reads it (no inline handler). Prompt and metadata remain text; stored chat bytes stay unchanged.
    const id = encodeURIComponent(String(c.id));
    return `
      <div class="saved-chat">
        <div class="saved-chat-meta">
          <span>${escapeMirrorText(c.timestamp)}</span>
          <span class="saved-chat-count">${escapeMirrorText(c.messagesCount)} msgs</span>
        </div>
        <div class="saved-chat-prompt">"${escapeMirrorText(c.firstPrompt)}"</div>
        <div class="saved-chat-actions">
          <button type="button" class="btn-action success tiny" data-action="load-saved" data-chat="${id}">Load</button>
          <button type="button" class="btn-action tiny" data-action="download-saved" data-chat="${id}">Download</button>
          <button type="button" class="btn-action danger tiny" data-action="delete-saved" data-chat="${id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function escapeMirrorText(value) {
  return String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const LOG_LEVEL_CLASS = { ERROR: 'error', WARN: 'warn', SUCCESS: 'success', INFO: 'info' };

function appendToLocalLogs(level, msg) {
  const timeStr = new Date().toLocaleTimeString();
  const lvl = String(level).toUpperCase();
  const cls = LOG_LEVEL_CLASS[lvl] || 'info';

  logsList.innerHTML += `
    <div class="log-line">
      <span class="log-stamp">[${escapeMirrorText(timeStr)}]</span>
      <span class="log-level ${cls}">[${escapeMirrorText(lvl)}]</span>
      <span>${escapeMirrorText(msg)}</span>
    </div>
  `;
  logsList.scrollTop = logsList.scrollHeight;
}

// The socket's state on the header's dot (its look follows data-state: connecting, connected, lost).
function setDot(state) {
  const dot = document.querySelector('.status-dot');
  if (dot) dot.dataset.state = state;
}

function connect() {
  // R4 (H84): only with the token (as a subprotocol), and never again once the companion refused it.
  if (!companion.token || companion.refused) return;
  const socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${socketProtocol}//${location.host}`, companion.protocols());
  wsConnection = ws;

  ws.onopen = () => {
    statusEl.textContent = 'COMPANION SOCKET · CONNECTED';
    setDot('connected');
    appendToLocalLogs('INFO', 'Companion WebSocket connected.');

    // R4 (H104, second part): with the project this tab pinned, when it pinned one
    ws.send(JSON.stringify(helloMessage()));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendToLocalLogs('INFO', `Received WebSocket packet type: ${msg.type}`);

      if (msg.type === 'state' || msg.type === 'welcome') {
        appendToLocalLogs('INFO', `TUI State change: ${msg.state || 'idle'}`);
        // R4 (H104, second part): the project this page shows (before the tail of its folder's bus, which follows)
        if (msg.type === 'welcome' && msg.project) {
          takeProject(msg.project);
          appendToLocalLogs('INFO', `Project: ${String(msg.project.name)} (${String(msg.project.folder)}), ${String(msg.project.mode)}`);
        }
        // R4 (H104): when this companion started (its session); the empty mirror says since when
        if (msg.type === 'welcome' && typeof msg.since === 'string' && Number.isFinite(Date.parse(msg.since))) {
          mirrorSince = msg.since;
          if (!isViewingSaved) renderConsoleLogs(activeChatHistory);
        }
      } else if (msg.type === 'project' && msg.project) {
        // R4 (H104, second part): the active project changed (a following page moves to it, its folder's tail follows), or
        // this page pinned or unpinned it
        const moved = takeProject(msg.project);
        appendToLocalLogs('INFO', `Project: ${String(msg.project.name)} (${String(msg.project.folder)}), ${String(msg.project.mode)}${msg.reason ? ` (${String(msg.reason)})` : ''}`);
        if (!isViewingSaved) renderConsoleLogs(activeChatHistory);
        if (moved) updateMirrorStatus(mirrorHasSession() ? 'LIVE' : 'WAITING');
      } else if (msg.type === 'bus.tail' && Array.isArray(msg.events)) {
        // R4 (H84): the event bus, as it reached this page: the tail on connecting, then each event
        appendToLocalLogs('INFO', `Event bus: ${msg.events.length} recent event${msg.events.length === 1 ? '' : 's'}${msg.events.length ? `, latest ${String(msg.events[msg.events.length - 1].kind)}` : ''}`);
        // R4 (H104): this session's REPL turns among them, in the mirror
        if (takeReplTurns(msg.events, false)) mirrorChanged();
      } else if (msg.type === 'bus' && msg.event) {
        appendToLocalLogs('INFO', `Event bus: ${String(msg.event.kind)}`);
        if (takeReplTurns([msg.event], true)) mirrorChanged();
      } else if (msg.type === 'sync') {
        // Live broadcasts use data; the hello/reconnect snapshot uses history.
        const history = msg.data ?? msg.history;
        if (!Array.isArray(history) || !history.every(m => m && typeof m.role === 'string' && typeof m.content === 'string')) {
          throw new Error('Invalid chat sync: expected messages with role and text content');
        }
        activeChatHistory = history;
        // R4 (H104): this monitor's own history replaces a restored copy
        mirrorRestored = false;
        saveActiveChat();
        if (!isViewingSaved) {
          renderConsoleLogs(activeChatHistory);
        }
        updateMirrorStatus(mirrorHasSession() ? 'LIVE' : 'WAITING');
      } else if (msg.type === 'tmux') {
        appendToLocalLogs('INFO', `Tmux cluster sync updated. Panels active: ${msg.data?.length || 0}`);
      } else if (msg.type === 'tmux:line') {
        appendToLocalLogs('INFO', `tmux pane trace: ${msg.data.line.substring(0, 40)}...`);
      } else if (msg.type === 'agent:tool') {
        appendToLocalLogs('WARN', `Agent tool-call gate triggered: ${msg.data.name}`);
        // Notification only: the terminal's canonical mirror snapshot
        // includes this tool row. Never synthesize or merge a second copy.
      } else if (msg.type === 'agent:delta') {
        // Exit saved chat view to show live sync
        if (isViewingSaved) {
          exitSavedChatViewer();
        }
        updateMirrorStatus('LIVE');
        // R4 (H104): a live answer is this session's: a restored copy from before is not continued
        if (mirrorRestored) { activeChatHistory = []; mirrorRestored = false; }

        let lastMsg = activeChatHistory[activeChatHistory.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.streaming) {
          lastMsg.content = msg.data.fullText || (lastMsg.content + msg.data.delta);
        } else {
          activeChatHistory.push({
            role: 'assistant',
            content: msg.data.fullText || msg.data.delta,
            timestamp: Date.now(),
            streaming: true
          });
        }
        saveActiveChat();
        if (!isViewingSaved) {
          renderConsoleLogs(activeChatHistory);
        }
      } else if (msg.type === 'receipt' || (msg.data && msg.data.manifestHash)) {
        const r = msg.data;
        if (r) {
          pRunId.textContent = r.runId || pRunId.textContent;
          pPrompt.textContent = r.prompt || pPrompt.textContent;
          pAgent.textContent = r.agent || pAgent.textContent;
          pTools.textContent = r.tools || pTools.textContent;
          pChanged.textContent = r.changed || pChanged.textContent;
          pHash.textContent = r.manifestHash || pHash.textContent;
          pPath.textContent = r.receiptPath || pPath.textContent;
          appendToLocalLogs('SUCCESS', `Sealed TIMMY Receipt committed to index: ${r.manifestHash}`);
        }
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'COMPANION SOCKET · RECONNECTING';
    setDot('lost');
    appendToLocalLogs('ERROR', 'WebSocket connection lost. Retrying in 2s...');
    if (!isViewingSaved) updateMirrorStatus('RECONNECTING');
    // R4 (H84): a socket refused for its token closes like a lost one; the companion is asked, and a refusal stops the retries
    companion.check();
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

/** R4 (H104): a REPL turn came: the mirror shows it (not over a saved chat being viewed) and says LIVE. */
function mirrorChanged() {
  if (!isViewingSaved) renderConsoleLogs(activeChatHistory);
  updateMirrorStatus('LIVE');
}

function renderConsoleLogs(history) {
  // R4 (H104): this session's REPL turns beside this monitor's chat, in time order (none in a saved chat's view); when
  // neither has come, words that say where chat happens (r24: an empty panel that said nothing)
  const turns = isViewingSaved ? [] : [...mirrorTurns.values()];
  if (history.length === 0 && turns.length === 0) {
    consoleLogs.innerHTML = mirrorEmptyHtml();
    return;
  }

  // the monitor's messages keep their own order (each at the latest time seen so far); a turn goes where its time puts it
  let at = 0;
  const rows = history.map((msg, i) => {
    const t = Number(msg.timestamp);
    if (Number.isFinite(t) && t > at) at = t;
    return { at, order: i, html: messageHtml(msg) };
  });
  turns.forEach((turn, j) => rows.push({ at: turn.at, order: history.length + j, html: replTurnHtml(turn) }));
  rows.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  const restored = mirrorRestored && !isViewingSaved && history.length > 0
    ? '<div class="mirror-note" data-mirror="restored">RESTORED · shown below: this browser\'s own copy of chat it mirrored before this page was opened (Delete Local removes it). Chat of this session is added here as it arrives.</div>'
    : '';
  consoleLogs.innerHTML = restored + rows.map((r) => r.html).join('');

  consoleLogs.scrollTop = consoleLogs.scrollHeight;
  proofFromHistory(history);
}

/** One message of the monitor's chat (or of a saved chat), as the mirror draws it: text, escaped. */
function messageHtml(msg) {
    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString();

    if (msg.role === 'system' && msg.isTool) {
      try {
        const delimiter = 'with arguments:';
        const index = msg.content.indexOf(delimiter);
        if (index < 0) throw new Error('Missing tool arguments delimiter');
        const name = msg.content.slice(0, index).replace('Swarm Orchestrator Tool Call:', '').trim();
        const args = JSON.parse(msg.content.slice(index + delimiter.length).trim());
        return `
          <div class="log-msg system">
            <div class="log-header system">
              <span>⚙️ Swarm Orchestrator Tool Call</span>
              <span class="log-time">${escapeMirrorText(timeStr)}</span>
            </div>
            <div class="log-content">Calling tool <code class="mirror-tool">${escapeMirrorText(name)}</code> with arguments:<pre class="code-box">${escapeMirrorText(JSON.stringify(args, null, 2))}</pre></div>
          </div>
        `;
      } catch (e) {
        // Fallback to normal rendering if parsing fails
      }
    }

    let formatted = msg.content || '';
    formatted = formatted
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    formatted = formatted.replace(/`(.*?)`/g, '<span class="mirror-code">$1</span>');
    formatted = formatted.replace(/```([\s\S]*?)```/g, '<div class="code-box">$1</div>');

    let msgClass = msg.role === 'user' ? 'user' : 'assistant';
    let displayRole = msg.role === 'user' ? '▶ You' : '◀ TIMMY Agent';

    if (msg.content && msg.content.includes('[SYSTEM]')) {
      msgClass = 'system';
      displayRole = '⚙️ Telemetry System Logs';
      formatted = formatted.replace('⚙️ **[SYSTEM]**', '').trim();
    }

    return `
      <div class="log-msg ${msgClass}">
        <div class="log-header ${msgClass}">
          <span>${displayRole}</span>
          <span class="log-time">${escapeMirrorText(timeStr)}</span>
        </div>
        <div class="log-content">${formatted}</div>
      </div>
    `;
}

/** The Proof tab's run id and sha256, as the newest message of the history that names one gave them (checked nowhere here). */
function proofFromHistory(history) {
  const receiptMsg = history.slice().reverse().find(m => m.content && (m.content.includes('run_proof') || m.content.includes('sha256_')));
  if (receiptMsg) {
    const text = receiptMsg.content;
    const hashMatch = text.match(/sha256_[0-9a-fA-F]+/);
    const runIdMatch = text.match(/run_[a-zA-Z0-9_]+/);
    if (hashMatch) pHash.textContent = hashMatch[0];
    if (runIdMatch) {
      pRunId.textContent = runIdMatch[0];
      pPath.textContent = `.runs/${runIdMatch[0]}.agentrun/manifest.json`;
    }
  }
}
// ── end of the chat mirror ──

// Timmy Canvas tab (fourth order, step 5): the canvas's revision, source revision and jobs, as the
// canvas page and `timmy receipts` show them. Links go to this computer's 127.0.0.1 only when this
// page is open on that computer; from a phone the address is said instead.
function canvasEsc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function canvasSummaryHtml(s, hostname) {
  const here = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  const base = String(s.open || 'http://127.0.0.1:4337/');
  // R4 (H92): opened apart from this page, with no referrer; looks by class (the page allows no style attribute)
  const link = (href, text) => here ? `<a href="${canvasEsc(href)}" target="_blank" rel="noopener noreferrer">${canvasEsc(text)}</a>` : canvasEsc(text);
  const head = s.unreadable
    ? '<p>The saved canvas could not be read. Open the canvas on the computer that runs Timmy: it keeps the file aside and starts blank.</p>'
    : `<p><strong>Revision ${canvasEsc(s.revision)}</strong>${s.sourceRevision ? ` · source ${canvasEsc(String(s.sourceRevision).slice(0, 12))}` : ' · not saved yet'}${s.savedAt ? ` · saved ${canvasEsc(new Date(s.savedAt).toLocaleString())}` : ''}</p>`;
  const jobs = (s.jobs || []).map((j) => `<li>${j.ok ? '<span class="canvas-ok">✓ done</span>' : '<span class="canvas-fail">✖ failed</span>'} ${canvasEsc(j.id)} · revision ${canvasEsc(j.revision)} · ${j.receipt ? link(`${base.replace(/\/$/, '')}/receipts/${encodeURIComponent(j.receipt)}`, `receipt ${j.receipt}`) : 'no receipt yet'}</li>`).join('');
  const open = here ? `<p>${link(base, 'Open Timmy Canvas')}</p>` : `<p>Open ${canvasEsc(base)} on the computer that runs Timmy.</p>`;
  return head + (jobs ? `<ol class="canvas-jobs">${jobs}</ol>` : '<p>No canvas jobs yet.</p>') + open;
}
async function refreshCanvas() {
  const box = document.getElementById('canvas-summary');
  if (!box) return;
  // R4 (H84): with the page's token; without it the companion answers nothing
  if (!companion.token || companion.refused) { box.textContent = 'The canvas is read with the companion’s token, which this page does not have.'; return; }
  try {
    const r = await companion.fetch('/api/canvas');
    if (!r.ok) throw new Error(String(r.status));
    box.innerHTML = canvasSummaryHtml(await r.json(), location.hostname);
  } catch {
    box.textContent = companion.refused ? 'The canvas is read with the companion’s token, which this page does not have.' : 'Timmy could not be reached to read the canvas.';
  }
}
// end Timmy Canvas tab
setInterval(() => { if (document.getElementById('tab-canvas')?.classList.contains('active')) refreshCanvas(); }, 5000);

// ── R4 (H104, second part): the project this page shows, and one operation's run detail ──

// A run detail asked for by this page's address (/run/<operation id>), opened once the companion has said which project
// this page shows (the detail is that project's).
const OPERATION_ID = /^o[0-9a-f]{8}$/;
let pendingRun = null;
// the run asked for last (an answer to an earlier ask that comes after it is not drawn over it)
let runAsked = 0;
document.addEventListener('timmy:refused', () => { if (pendingRun) { const op = pendingRun; pendingRun = null; openRun(op, false); } });

/** The header's project: its name, how this page came to show it, its Pin (what it does, and on which project); the folder line. */
function projectHeader(p) {
  const bar = document.getElementById('project');
  const name = document.getElementById('project-name');
  const mark = document.getElementById('project-pin-mark');
  const mode = document.getElementById('project-mode');
  const btn = document.getElementById('project-pin');
  const folder = document.getElementById('project-folder');
  if (!bar || !name || !mark || !mode || !btn || !folder) return;
  const otherActive = Boolean(p.active && p.active.id !== p.id);
  bar.dataset.mode = String(p.mode);
  bar.dataset.project = String(p.id);
  name.textContent = String(p.name);
  mark.hidden = p.mode !== 'pinned';
  if (p.mode === 'fixed') {
    mode.textContent = 'fixed by TIMMY_REPO';
    btn.disabled = true;
    btn.dataset.action = 'pin-project';
    btn.textContent = 'Pin: off (TIMMY_REPO fixed this companion’s folder)';
  } else if (p.mode === 'pinned') {
    mode.textContent = otherActive ? `pinned · the active project is ${p.active.name}` : 'pinned on this page';
    btn.disabled = false;
    btn.dataset.action = 'unpin-project';
    btn.textContent = otherActive ? `Unpin: follow the active project (${p.active.name})` : 'Unpin: follow the active project';
  } else {
    mode.textContent = p.chosen ? 'following the active project' : 'following the active project (none chosen yet: this companion’s folder)';
    btn.disabled = false;
    btn.dataset.action = 'pin-project';
    btn.textContent = `📌 Pin: keep this page on ${p.name}`;
  }
  const reads = `Project folder: ${p.folder}: this page reads its event bus and receipts (.timmy), for the Chat Mirror's REPL turns and the Logs tab`;
  folder.textContent = p.mode === 'fixed' ? `${reads}. TIMMY_REPO fixed this folder: this companion follows no project.`
    : p.mode === 'pinned' ? `${reads}. Pinned on this page${otherActive ? `; the active project is now ${p.active.name} (${p.active.folder})` : ''}.`
      : `${reads}. Following the active project, which Timmy records in ${p.record}.`;
  if (p.note) folder.textContent += ` ${p.note}`;
  if (pendingRun) { const op = pendingRun; pendingRun = null; openRun(op, false); }
}

/** Pin or unpin the project this page shows (the companion confirms, and the header says so). */
function pinProject(on) {
  if (!wsConnection || wsConnection.readyState !== 1) { appendToLocalLogs('WARN', 'Not connected to the companion, so the pin was not changed.'); return; }
  const id = document.getElementById('project')?.dataset.project;
  wsConnection.send(JSON.stringify(on ? (id ? { type: 'pin', id } : { type: 'pin' }) : { type: 'unpin' }));
}

/** Reads and draws the run detail of `op` for the project this page shows; `address`: this page's address says /run/<op>. */
async function openRun(op, address = true) {
  const box = document.getElementById('run-detail');
  const input = document.getElementById('run-op');
  if (!box) return;
  const mine = ++runAsked;
  const id = String(op || '').trim();
  if (input && input.value !== id) input.value = id;
  if (!OPERATION_ID.test(id)) {
    box.innerHTML = `<p class="run-error" data-run="not-an-id">${canvasEsc('Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it. Nothing was read.')}</p>`;
    return;
  }
  // the address names the run (never the token: the page took it out of its address when it opened)
  if (address) { try { history.replaceState(null, '', `/run/${id}`); } catch (e) { /* the address stays as it was */ } }
  if (!companion.token || companion.refused) {
    box.innerHTML = '<p class="run-error" data-run="no-token">The run detail is read with the companion’s token, which this page does not have, so nothing was read. Open the companion from Timmy: in <code>timmy watch</code>, press q on HOME.</p>';
    return;
  }
  box.innerHTML = `<p class="run-empty">Reading the run detail of ${canvasEsc(id)}…</p>`;
  const project = document.getElementById('project')?.dataset.project;
  let r;
  let body = null;
  try {
    r = await companion.fetch(`/api/run/${id}${project ? `?project=${encodeURIComponent(project)}` : ''}`);
    body = await r.json().catch(() => null);
  } catch (e) {
    if (mine !== runAsked) return;
    box.innerHTML = `<p class="run-error" data-run="unreachable">${canvasEsc(`The companion could not be reached to read the run detail of ${id}.`)}</p>`;
    return;
  }
  if (mine !== runAsked) return;
  if (!r.ok || !body || body.ok !== true || !body.detail) {
    box.innerHTML = `<p class="run-error" data-run="refused" data-status="${canvasEsc(r.status)}">${canvasEsc((body && body.error) || `The companion answered HTTP ${r.status}, so no run detail is shown.`)}</p>`;
    return;
  }
  box.innerHTML = runDetailHtml(body.detail);
  appendToLocalLogs('INFO', `Run detail: ${id}`);
}

/**
 * One run detail (src/contracts/run-detail.ts), as its producer gave it: every value with where it came from. Timmy's
 * verdict, the workflow stage (steps done of total, never a percentage), each process's exit, the artifact's freshness and
 * a person's acceptance each on a row of their own; a cost is the number reported, or unknown with why. Text only.
 */
function runDetailHtml(d) {
  const e = canvasEsc;
  const from = (f) => (f ? ` <span class="run-from">from ${e(f)}</span>` : '');
  const none = (words) => `<span class="run-none">${e(words)}</span>`;
  const when = (t) => { if (!t) return none('not recorded'); const x = new Date(t); return Number.isNaN(x.getTime()) ? e(t) : e(x.toLocaleString()); };
  const elapsed = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return none('not recorded');
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const sourced = (s) => (s && typeof s === 'object' ? `${e(s.value)}${from(s.from)}` : none('not recorded'));
  const opLink = (id) => `<button type="button" class="run-link" data-action="open-run" data-op="${e(id)}">${e(id)}</button>`;
  const rows = [];
  const row = (key, label, html) => rows.push(`<div class="run-row" data-field="${key}"><dt>${e(label)}</dt>
<dd>${html}</dd></div>`);
  row('verdict', 'Timmy’s verdict', `<strong class="run-verdict" data-state="${e(d.verdict.state)}">${e(d.verdict.state)}</strong> · ${e(d.verdict.words)}${from(d.verdict.from)}`);
  row('stage', 'Workflow stage', `${d.stage.current ? `${e(d.stage.current)} · ` : ''}${e(d.stage.done)} of ${d.stage.total === null || d.stage.total === undefined ? 'an unrecorded number of' : e(d.stage.total)} steps done${from(d.stage.from)}`);
  row('exits', 'Process exits', d.exits.length ? `<ul class="run-list">
${d.exits.map((x) => `<li>${e(x.who)}: ${x.code === null || x.code === undefined ? 'its exit is not known' : `exit ${e(x.code)}`}${x.state ? ` (${e(x.state)})` : ''}${from(x.from)}</li>`).join('\n')}
</ul>` : none('none recorded'));
  row('freshness', 'Artifact freshness', `${e(d.freshness.state)} · ${e(d.freshness.why)}${from(d.freshness.from)}`);
  row('acceptance', 'A person’s acceptance', `${e(d.acceptance.state)}${d.acceptance.by ? ` by ${e(d.acceptance.by)}` : ''}${d.acceptance.at ? `, ${when(d.acceptance.at)}` : ''}${from(d.acceptance.from)}`);
  row('objective', 'Objective', sourced(d.objective));
  row('project', 'Project', `${e(d.project.name)} <span class="run-from">${e(d.project.root)} · id ${e(d.project.id)}</span>`);
  row('source', 'Source revision', sourced(d.sourceRevision));
  const w = d.worker || {};
  row('worker', 'Worker', [['model', w.model], ['harness', w.harness], ['environment', w.environment]].filter(([, v]) => v).map(([k, v]) => `${e(k)} ${sourced(v)}`).join('; ') || none('not recorded'));
  row('time', 'Time', `started ${when(d.time.startedAt)} · ended ${when(d.time.endedAt)} · elapsed ${elapsed(d.time.elapsedMs)}`);
  row('family', 'Parent · children', `${d.parent ? opLink(d.parent) : none('no parent')} · ${d.children.length ? d.children.map(opLink).join(' ') : none('no children')}`);
  row('cost', 'Cost', d.cost.measured ? `$${e(Number(d.cost.usd).toFixed(4))} (reported)${from(d.cost.from)}` : `unknown: ${e(d.cost.why)}`);
  row('next', 'Next', d.next ? `${e(d.next.words)}${d.next.command ? ` <code>${e(d.next.command)}</code>` : ''}` : none('nothing recorded'));
  row('summary', 'Summary', d.summary && d.summary.path ? `<code>${e(d.summary.path)}</code>` : none('none saved'));
  const prediction = d.prediction
    ? `<p>${e(d.prediction.words)} <span class="run-from">receipt ${e(d.prediction.receipt)}${d.prediction.frozenAt ? `, frozen ${when(d.prediction.frozenAt)}` : ''}</span></p>`
    : `<p>${none('No prediction was recorded before this run.')}</p>`;
  const differs = (v) => (v === true ? 'differs' : v === false ? 'as predicted' : 'not compared');
  const checks = d.checks.length
    ? `<table class="run-table"><thead><tr><th>Check</th>
<th>Predicted</th>
<th>Actual</th>
<th>Compared</th></tr></thead>
<tbody>${d.checks.map((c) => `<tr data-differs="${e(c.differs)}"><td>${e(c.name)}</td>
<td>${c.predicted === null ? none('none') : e(c.predicted)}</td>
<td>${e(c.actual)}${from(c.from)}</td>
<td>${differs(c.differs)}</td></tr>`).join('\n')}</tbody></table>`
    : `<p>${none('No checks recorded.')}</p>`;
  const files = d.files.length
    ? `<table class="run-table"><thead><tr><th>File</th>
<th>Role</th>
<th>sha256</th></tr></thead>
<tbody>${d.files.map((f) => `<tr><td><code>${e(f.path)}</code>${from(f.from)}</td>
<td>${e(f.role)}</td>
<td>${f.sha256 ? `<code>${e(String(f.sha256).slice(0, 12))}</code>` : none('none')}</td></tr>`).join('\n')}</tbody></table>`
    : `<p>${none('No files recorded.')}</p>`;
  const receipts = d.receipts.length ? `<ul class="run-list">
${d.receipts.map((r) => `<li><code>${e(r.id)}</code> · ${e(r.kind)}${r.subject ? ` · ${e(r.subject)}` : ''}</li>`).join('\n')}
</ul>` : `<p>${none('No receipts recorded.')}</p>`;
  const unknown = d.unknown.length ? `<ul class="run-list">
${d.unknown.map((u) => `<li><strong>${e(u.field)}</strong>: ${e(u.why)}</li>`).join('\n')}
</ul>` : `<p>${none('Nothing listed.')}</p>`;
  return `<article class="run-view" data-operation="${e(d.operation)}">
    <h4 class="run-title">Run <code>${e(d.operation)}</code> · ${e(d.project.name)}</h4>
    <dl class="run-facts">
${rows.join('\n')}
</dl>
    <h5>Prediction (frozen before the result; not an observed receipt)</h5>
    ${prediction}
    <h5>Checks: predicted beside actual</h5>
    ${checks}
    <h5>Files</h5>
    ${files}
    <h5>Receipts</h5>
    ${receipts}
    <h5>Not known (no record says)</h5>
    ${unknown}
  </article>`;
}

// the run box: its form opens the id typed in it
document.getElementById('run-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  openRun(document.getElementById('run-op')?.value ?? '');
});

// Slate 3D's tab: its frame is given its address when the tab is first opened, with the same token in its fragment (the
// frame takes it out of its address too). Without a token the page loads nothing, Slate 3D included.
function openSlate() {
  const frame = document.getElementById('slate3d-frame');
  if (!frame || frame.getAttribute('src') || !companion.token || companion.refused) return;
  frame.src = frame.dataset.src + '#t=' + companion.token;
}

// The tab deck. R4 (H92): the panels fade with the browser's own Web Animations (GSAP's three transitions, from a CDN,
// before); at once where the person asks for reduced motion. R4 (H95): with GSAP's own timing, as the page had it: the
// panel shown fades out in 0.15 s with power2.in, then the next fades in from 0 in 0.25 s with power2.out (also when no
// panel was shown); no delay. GSAP's power2 is the cubic curve; these are its CSS forms (in: t³; out: 1 - (1 - t)³).
const GSAP_POWER2_IN = 'cubic-bezier(0.32, 0, 0.67, 0)';
const GSAP_POWER2_OUT = 'cubic-bezier(0.33, 1, 0.68, 1)';
let tabSwitch = 0;
function fade(el, from, to, ms, easing) {
  let still = false;
  try { still = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* no media queries here */ }
  if (still || typeof el.animate !== 'function') return Promise.resolve();
  return el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing }).finished;
}

function switchTab(tabId) {
  const targetPanel = document.getElementById(`tab-${tabId}`);
  if (!targetPanel) return;
  if (tabId === 'canvas') refreshCanvas();
  if (tabId === 'slate3d') openSlate();
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const on = btn.dataset.tab === tabId;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  const activePanel = document.querySelector('.tab-panel.active');
  if (activePanel === targetPanel) return;
  // a newer switch wins: the running fades end where they are, and only the newest switch shows its panel
  const mine = ++tabSwitch;
  document.querySelectorAll('.tab-panel').forEach((p) => { if (typeof p.getAnimations === 'function') p.getAnimations().forEach((a) => a.cancel()); });
  const show = () => {
    if (mine !== tabSwitch) return;
    document.querySelectorAll('.tab-panel.active').forEach((p) => p.classList.remove('active'));
    targetPanel.classList.add('active');
    fade(targetPanel, 0, 1, 250, GSAP_POWER2_OUT).catch(() => undefined);
  };
  if (activePanel) fade(activePanel, 1, 0, 150, GSAP_POWER2_IN).then(show, () => undefined);
  else show();
}

// A command copied for a person to paste; when the browser will not copy (a page over plain http from another device is
// not a secure context), the button says so and shows the command instead.
async function copyCommand(text, button) {
  const was = button.textContent;
  try {
    if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch (e) {
    button.textContent = 'Not copied (this browser would not): ' + text;
  }
  setTimeout(() => { button.textContent = was; }, 3000);
}

// The page's buttons: one click handler for all of them (the page allows no inline handler).
document.addEventListener('click', (event) => {
  const el = event.target instanceof Element ? event.target.closest('[data-tab], [data-action], [data-copy]') : null;
  if (!el) return;
  if (el.dataset.tab) { switchTab(el.dataset.tab); return; }
  if (el.dataset.copy) { copyCommand(el.dataset.copy, el); return; }
  let chatId = null;
  try { chatId = el.dataset.chat ? decodeURIComponent(el.dataset.chat) : null; } catch (e) { return; }
  switch (el.dataset.action) {
    case 'save-chat': saveCurrentChat(); break;
    case 'download-chat': downloadCurrentChat(); break;
    case 'delete-chat': deleteCurrentChat(); break;
    case 'exit-saved': exitSavedChatViewer(); break;
    case 'load-saved': if (chatId !== null) loadSavedChat(chatId); break;
    case 'download-saved': if (chatId !== null) downloadSavedChat(chatId); break;
    case 'delete-saved': if (chatId !== null) deleteSavedChat(chatId); break;
    // R4 (H104, second part): the header's Pin, and a run detail's parent or child operation
    case 'pin-project': pinProject(true); break;
    case 'unpin-project': pinProject(false); break;
    case 'open-run': if (el.dataset.op) openRun(el.dataset.op); break;
    default: break;
  }
});

// Carbonyl's launch command names this page's own address (its port is the one this companion took), without the token.
(() => {
  const btn = document.querySelector('[data-copy-carbonyl]');
  if (btn) btn.dataset.copy = `carbonyl ${location.origin}/`;
})();

// R4 (H104, second part): this page opened at /run/<operation id>: its RUN DETAIL tab, that run's detail once the companion
// has said which project this page shows (at once, in words, without the token)
(() => {
  const m = /^\/run\/([^/]+)$/.exec(location.pathname);
  if (!m) return;
  let op = '';
  try { op = decodeURIComponent(m[1]); } catch (e) { op = m[1]; }
  switchTab('run');
  const input = document.getElementById('run-op');
  if (input) input.value = op;
  if (!companion.token || companion.refused || !OPERATION_ID.test(op)) { openRun(op, false); return; }
  pendingRun = op;
  const box = document.getElementById('run-detail');
  if (box) box.innerHTML = `<p class="run-empty">The run detail of ${canvasEsc(op)} is read once the companion says which project this page shows.</p>`;
})();

// Initial load
renderSavedChatsList();

if (activeChatHistory.length > 0) {
  renderConsoleLogs(activeChatHistory);
} else {
  const saved = getSavedChats();
  if (saved.length > 0) {
    loadSavedChat(saved[0].id);
  } else {
    renderConsoleLogs([]);
  }
}

connect();
