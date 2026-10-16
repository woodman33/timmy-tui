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
/** R5 lead (QA-R5E defect 28): the rows show once a receipt reached this page; until then one sentence says none has. */
function proofShown() {
  const box = document.getElementById('proof-box');
  const none = document.getElementById('proof-none');
  if (box) box.hidden = false;
  if (none) none.hidden = true;
}

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
// R5 lead (the QA round, defect 6): one time format, as the terminal Workbench and Studio show it: the 24-hour clock in this
// computer's local time (21:18:36), with the date where a time can be another day's (2026-10-15 21:18:36); never a locale's
// 12-hour clock beside another surface's 24-hour one
function pad2(n) { return String(n).padStart(2, '0'); }
function clockOf(iso) { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; }
function dateTimeOf(iso) { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${clockOf(t)}`; }

// R4 (H104): r24 found the mirror empty with nothing saying why. It shows this session's chat as the companion's socket
// carries it, and says where chat happens when none has come:
//  - this monitor's chat (`timmy watch`): its words, as its terminal sends them (sync, agent:delta);
//  - the REPL's (`timmy`, a process of its own): each turn when it ends, as the event bus carries it: the receipt Timmy
//    sealed (receipt.sealed of kind `turn`, src/repl/seal.ts). The REPL seals a turn's prompt and answer as SHA-256 hashes
//    only, so their words are never on the bus: the row names the receipt and says the words are in the REPL.
// Only this session's: the bus's live events (appended after this companion started) and, of the tail it sends on
// connecting (six hours), what was sealed at or after the start its welcome gives (`since`).
// R4 (H113): every surface's turns of the project, not the REPL's alone: the Workbench's, a monitor's and a companion page's
// too (each sealed by the REPL's own seal into the project, its surface named), each labelled with its surface, its receipt
// and its steps, once (by its receipt's hash), in time order with this monitor's chat.
let mirrorSince = null;
const mirrorTurns = new Map(); // this session's turns of every surface, by their receipt's hash
const REPL_TURN = /^repl · (cancelled · )?(\d+) steps?$/; // src/repl/seal.ts: the subject of a turn's receipt
// R4 (H113): one conversation per project. Every surface's turn is the one turn implementation, sealed by src/repl/seal.ts:
// the REPL's as kind `turn` ("repl · 2 steps"), the other surfaces' as kind `chat`, naming the surface, how it ended when it
// was not answered, its steps and the model: "chat.turn · workbench · 2 steps · qwen3:8b". A chat receipt in no such words
// (an older monitor's, the commander's) is not a turn row: its words came with this monitor's sync, if at all.
const SURFACE_TURN = /^chat\.turn · (monitor|workbench|companion) · (?:(cancelled|failed) · )?(\d+) steps? · /;
// how each surface is named in the mirror (its label, and where its words are: never on the bus)
const SURFACES = {
  monitor: { icon: '◉', name: 'Monitor', where: 'the monitor (<span class="mirror-code">timmy watch</span>)', words: 'Its words are in the monitor\'s chat (this page shows a monitor\'s words above only when that monitor serves it)' },
  workbench: { icon: '▣', name: 'Workbench', where: 'the Workbench (<span class="mirror-code">timmy workbench</span>)', words: 'Its words are in the Workbench\'s Chat' },
  companion: { icon: '◇', name: 'Companion', where: 'a companion page', words: 'Its words are on the companion page that sent it' },
};

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

/**
 * A turn of any surface from a bus event, or null: a sealed turn receipt of the runs chain, this session's. The REPL's (kind
 * turn) by its subject when it can be read, else as a turn that ended; another surface's (kind chat) only in the words
 * src/repl/seal.ts gives it (R4 H113).
 */
function replTurnOf(event, live) {
  if (!event || event.kind !== 'receipt.sealed' || !event.payload || typeof event.payload !== 'object') return null;
  const p = event.payload;
  if ((p.kind !== 'turn' && p.kind !== 'chat') || p.stream !== 'runs') return null;
  const hash = String(p.hash || '');
  if (!/^sha256_[0-9a-f]{64}$/.test(hash)) return null;
  const at = Date.parse(event.ts);
  if (!Number.isFinite(at)) return null;
  if (!live) {
    const since = Date.parse(mirrorSince);
    if (!Number.isFinite(since) || at < since) return null;
  }
  // R5 lead: the turn's identity, when its receipt names it (turn_id): the id the frame gave it while it was being answered
  const turn = typeof p.turn_id === 'string' && /^t[0-9]+-[0-9a-f]{8}$/.test(p.turn_id) ? p.turn_id : null;
  if (p.kind === 'chat') {
    const s = SURFACE_TURN.exec(String(p.subject || ''));
    if (!s) return null;
    return { hash, at, receipt: hash.slice(7, 15), surface: s[1], state: s[2] || 'ended', cancelled: s[2] === 'cancelled', steps: Number(s[3]), turn };
  }
  const m = REPL_TURN.exec(String(p.subject || ''));
  return { hash, at, receipt: hash.slice(7, 15), surface: 'repl', state: m && m[1] ? 'cancelled' : 'ended', cancelled: Boolean(m && m[1]), steps: m ? Number(m[2]) : null, turn };
}

/** Takes the turns among bus events (every surface's); true when one is new. */
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

/**
 * R4 (H113): another surface's turn (the monitor's, the Workbench's, a companion page's), as the bus carries it: which surface,
 * how it ended, its steps and its receipt; never its words (sealed as hashes only).
 */
/**
 * R5 lead (the finish line, item 3: the same state on every surface): how a turn ended, in the words the Workbench and the
 * shared frame use (answered, stopped, failed). A sealed receipt's subject on the bus says only "cancelled" or "failed"; a
 * turn the frame knows by its receipt takes the frame's word, a cancelled one is said stopped, and one the frame does not
 * know yet is said ended.
 */
function turnEnd(turn) {
  const f = frameDrawn();
  const known = f && f.chat && Array.isArray(f.chat.turns) ? f.chat.turns.find((t) => t && t.receipt === turn.receipt) : null;
  if (known && typeof known.state === 'string') return known.state;
  return turn.state === 'cancelled' ? 'stopped' : turn.state;
}

function surfaceTurnHtml(turn) {
  const s = SURFACES[turn.surface];
  const time = clockOf(turn.at);
  const steps = turn.steps === null ? '' : ` (${turn.steps} ${turn.steps === 1 ? 'step' : 'steps'})`;
  return `
      <div class="log-msg repl" data-mirror="surface-turn" data-surface="${escapeMirrorText(turn.surface)}">
        <div class="log-header repl">
          <span>${s.icon} ${s.name} turn · ${escapeMirrorText(turnEnd(turn))}</span>
          <span class="log-time">${escapeMirrorText(time)}</span>
        </div>
        <div class="log-content">A chat turn in ${s.where} ${escapeMirrorText(turnEnd(turn))}${steps}; Timmy sealed it as receipt <span class="mirror-code">${escapeMirrorText(turn.receipt)}</span>, in this project's one conversation. ${s.words}: Timmy seals a turn's prompt and answer as hashes only, so they are not on the event bus and are not shown here.</div>
      </div>
    `;
}

function replTurnHtml(turn) {
  if (turn.surface && turn.surface !== 'repl' && SURFACES[turn.surface]) return surfaceTurnHtml(turn);
  const time = clockOf(turn.at);
  const state = turnEnd({ ...turn, state: turn.cancelled ? 'cancelled' : 'ended' });
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
    head = `No chat in this session yet: none has reached this page since this companion started${Number.isNaN(since.getTime()) ? '' : ` at ${clockOf(since)}`}.`;
  }
  return `
      <div class="mirror-empty explain" data-mirror="empty">
        <div class="mirror-empty-head">${escapeMirrorText(head)}</div>
        <div>Chat happens in Timmy's terminal, not on this page:</div>
        <ul>
          <li>In this monitor (<span class="mirror-code">timmy watch</span>), type in its chat line: each message and its answer appear here as they are sent.</li>
          <li>In the REPL (<span class="mirror-code">timmy</span>), each turn appears here when it ends, as the receipt Timmy sealed for it. Its words stay in the REPL (a REPL turn's prompt and answer are sealed as hashes only). ${replWhereHtml()}</li>
          <li>In the Workbench (<span class="mirror-code">timmy workbench</span>), each turn of its Chat appears here the same way, when it ends, labelled Workbench; a monitor's turn is labelled Monitor. Every surface's turns are this project's one conversation, kept in its .sessions.</li>
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
    timestamp: dateTimeOf(new Date()),
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
  const timeStr = clockOf(new Date());
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

// The socket's state on the header's dot (its look follows data-state: connecting, connected, lost). R5 (H132, B10): green
// only while this page observes its socket open (.is-live), beside the words CONNECTED.
function setDot(state) {
  const dot = document.querySelector('.status-dot');
  if (!dot) return;
  dot.dataset.state = state;
  if (dot.classList) dot.classList.toggle('is-live', state === 'connected');
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
    // R5 (H132): the workspace frame is read again at once when the socket is back (nothing is sent again: a save in flight
    // is never repeated by itself)
    if (typeof onCompanionConnected === 'function') onCompanionConnected();
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
        // R5 lead (the final QA of a77d80d, defect 1): a turn's end reaches the whole page with its mirror row: the frame
        // (the strip, the activity line, the log) is read again now, not at its next 3 s read
        if (takeReplTurns([msg.event], true)) { mirrorChanged(); readFrameAfterTurnEnd(); }
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
          proofShown();
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

/**
 * R5 lead (the finish line, item 3: every surface shows the same conversation): the project's sealed turns as the shared
 * frame carries them (frame.chat.turns, from their receipts), those this page did not see arrive: a page opened after a turn
 * still shows it, labelled as sealed before this page connected. Its words are never here (receipts keep hashes only).
 */
const SURFACE_OF = { repl: { icon: '⌨', name: 'REPL', where: 'the REPL (<span class="mirror-code">timmy</span>)', words: 'Its words are in the REPL' }, ...SURFACES };
// the mirror is drawn from the first lines this file runs, before the frame's part below is set up: until then no frame is known
function frameDrawn() { try { return workspace.frame; } catch (e) { return null; } }
function frameOther(f) { try { return otherProject(f); } catch (e) { return false; } }
function frameTurnsUnseen() {
  const f = frameDrawn();
  if (isViewingSaved || !f || frameOther(f) || !f.chat || !Array.isArray(f.chat.turns)) return [];
  const seen = new Set([...mirrorTurns.values()].map((t) => t.receipt));
  return f.chat.turns.filter((t) => t && typeof t.receipt === 'string' && !seen.has(t.receipt));
}
function frameTurnHtml(t) {
  const s = SURFACE_OF[t.surface] || { icon: '·', name: escapeMirrorText(t.surface), where: escapeMirrorText(t.surface), words: 'Its words are where it was sent' };
  const op = t.operation ? `, operation <span class="mirror-code">${escapeMirrorText(t.operation)}</span>` : '';
  return `
      <div class="log-msg repl" data-mirror="frame-turn" data-surface="${escapeMirrorText(t.surface)}" data-state="${escapeMirrorText(t.state)}">
        <div class="log-header repl">
          <span>${s.icon} ${s.name} turn · ${escapeMirrorText(t.state)}</span>
          <span class="log-time">${escapeMirrorText(clockOf(t.at))}</span>
        </div>
        <div class="log-content">A chat turn in ${s.where} ${escapeMirrorText(t.state)}, sealed before this page connected as receipt <span class="mirror-code">${escapeMirrorText(t.receipt)}</span>${op} (${escapeMirrorText(t.model || 'model not recorded')}), in this project's one conversation. ${s.words}: Timmy seals a turn's prompt and answer as hashes only, so they are not shown here.</div>
      </div>
    `;
}
/** A turn being answered now, as the frame says it (one turn at a time per project): where, since when, and where it stops. */
function frameRunningHtml() {
  const f = frameDrawn();
  const t = !isViewingSaved && f && !frameOther(f) && f.activity ? f.activity.chatTurn : null;
  if (!t) return '';
  // R5 lead (the operator's 22:32 order, item 1): this turn's own receipt, sealed already (the bus is quicker than the next
  // frame), ends it here: matched by the turn's identity (its id, sealed as turn_id), never by surface and time
  if (turnSealed(t.id, f)) return '';
  const stop = f.activity.stopCurrent && f.activity.stopCurrent.words ? ` ${escapeMirrorText(f.activity.stopCurrent.words)}.` : '';
  const button = t.id ? ` <button type="button" class="btn-action tiny stop-turn" data-stop-turn="${escapeMirrorText(t.id)}">Stop this turn</button>` : '';
  return `
      <div class="log-msg repl" data-mirror="frame-running">
        <div class="log-header repl"><span>running · ${escapeMirrorText(t.words)}</span><span class="log-time">${escapeMirrorText(clockOf(t.since))}</span></div>
        <div class="log-content">It is shown here when its receipt is sealed.${stop}${button}</div>
      </div>
    `;
}
/** Whether the turn `id` is sealed already, as the bus or the frame says it (by its identity; false for no id). */
function turnSealed(id, f) {
  if (!id) return false;
  return [...mirrorTurns.values()].some((m) => m.turn === id) || (f && f.chat && Array.isArray(f.chat.turns) ? f.chat.turns : []).some((x) => x && x.turn === id);
}
/** The mirror again when the frame's turns or its running turn changed (not on every frame: a scroll is kept otherwise). */
let mirrorFrameKey = '';
function frameTurnsChanged() {
  const f = frameDrawn();
  const key = f ? JSON.stringify([(f.chat && f.chat.turns || []).map((t) => `${t.receipt}:${t.state}`), f.activity && f.activity.chatTurn ? f.activity.chatTurn.since : null, frameOther(f)]) : '';
  if (key === mirrorFrameKey) return;
  mirrorFrameKey = key;
  if (!isViewingSaved) renderConsoleLogs(activeChatHistory);
}

function renderConsoleLogs(history) {
  // R4 (H104): this session's REPL turns beside this monitor's chat, in time order (none in a saved chat's view); when
  // neither has come, words that say where chat happens (r24: an empty panel that said nothing)
  const turns = isViewingSaved ? [] : [...mirrorTurns.values()];
  // R5 lead: and the project's turns sealed before this page connected (the frame's), and a turn being answered now
  const earlier = frameTurnsUnseen();
  const running = frameRunningHtml();
  if (history.length === 0 && turns.length === 0 && earlier.length === 0 && !running) {
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
  earlier.forEach((t, j) => rows.push({ at: Date.parse(t.at) || 0, order: history.length + turns.length + j, html: frameTurnHtml(t) }));
  rows.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  const restored = mirrorRestored && !isViewingSaved && history.length > 0
    ? '<div class="mirror-note" data-mirror="restored">RESTORED · shown below: this browser\'s own copy of chat it mirrored before this page was opened (Delete Local removes it). Chat of this session is added here as it arrives.</div>'
    : '';
  consoleLogs.innerHTML = restored + rows.map((r) => r.html).join('') + running;

  consoleLogs.scrollTop = consoleLogs.scrollHeight;
  proofFromHistory(history);
}

/** One message of the monitor's chat (or of a saved chat), as the mirror draws it: text, escaped. */
function messageHtml(msg) {
    const timeStr = clockOf(msg.timestamp || Date.now());

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
    if (hashMatch || runIdMatch) proofShown();
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
// R5 lead (the QA round, defect 6): the one date-and-time format (the chat mirror's dateTimeOf), here too, since this part of
// the file runs by itself in tests/companion-canvas.test.ts
function canvasWhen(iso) { const t = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return Number.isNaN(t.getTime()) ? String(iso || '') : `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`; }
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
    : `<p><strong>Revision ${canvasEsc(s.revision)}</strong>${s.sourceRevision ? ` · source ${canvasEsc(String(s.sourceRevision).slice(0, 12))}` : ' · not saved yet'}${s.savedAt ? ` · saved ${canvasEsc(canvasWhen(s.savedAt))}` : ''}</p>`;
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
// R5 (H132): read again every 5 s while the Studio tab (which holds it) is shown
setInterval(() => { const studio = document.getElementById('ws-studio'); if (studio && !studio.hidden && !document.hidden) refreshCanvas(); }, 5000);

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
    btn.textContent = `Pin: keep this page on ${p.name}`;
  }
  const reads = `Project folder: ${p.folder}: this page reads its event bus and receipts (.timmy), for the Chat Mirror's REPL turns and the Logs tab`;
  folder.textContent = p.mode === 'fixed' ? `${reads}. TIMMY_REPO fixed this folder: this companion follows no project.`
    : p.mode === 'pinned' ? `${reads}. Pinned on this page${otherActive ? `; the active project is now ${p.active.name} (${p.active.folder})` : ''}.`
      : `${reads}. Following the active project, which Timmy records in ${p.record}.`;
  if (p.note) folder.textContent += ` ${p.note}`;
  // R5 (H132): the line is cut to one row on a wide screen; its whole words on hover
  folder.title = folder.textContent;
  // R5 (H132): the workspace frame of the project shown now
  if (typeof onProjectShown === 'function') onProjectShown(p);
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
  const when = (t) => { if (!t) return none('not recorded'); const x = new Date(t); return Number.isNaN(x.getTime()) ? e(t) : e(dateTimeOf(x)); };
  const elapsed = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return none('not recorded');
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const sourced = (s) => (s && typeof s === 'object' ? `${e(s.value)}${from(s.from)}` : none('not recorded'));
  const opLink = (id) => `<button type="button" class="run-link" data-action="open-run" data-op="${e(id)}">${e(id)}</button>`;
  // R5 (H132): in three columns, kept apart as reference 12 keeps them: before the run (.intent and .predict, amber), the run
  // itself, and after it (the verdict and the receipts); every row and section as before
  const COL = { objective: 'before', verdict: 'after', acceptance: 'after', related: 'after', next: 'after', summary: 'after' };
  const rows = { before: [], run: [], after: [] };
  const row = (key, label, html) => rows[COL[key] || 'run'].push(`<div class="run-row" data-field="${key}"><dt>${e(label)}</dt>
<dd>${html}</dd></div>`);
  const facts = (k) => `<dl class="run-facts">
${rows[k].join('\n')}
</dl>`;
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
  row('related', 'Parent · children', `${d.parent ? opLink(d.parent) : none('no parent')} · ${d.children.length ? d.children.map(opLink).join(' ') : none('no children')}`);
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
    <div class="rd-cols">
      <section class="rd-col rd-before" aria-label="Before the run: its intent and its prediction">
        <h5 class="rd-col-title">.intent · .predict · before the run</h5>
        ${facts('before')}
        <h5>Prediction (frozen before the result; not an observed receipt)</h5>
        ${prediction}
      </section>
      <section class="rd-col rd-run" aria-label="The run">
        <h5 class="rd-col-title">the run · stage, exits, checks</h5>
        ${facts('run')}
        <h5>Checks: predicted beside actual</h5>
        ${checks}
        <h5>Files</h5>
        ${files}
      </section>
      <section class="rd-col rd-after" aria-label="After the run: the verdict and its receipts">
        <h5 class="rd-col-title">.receipt · after the run</h5>
        ${facts('after')}
        <h5>Receipts</h5>
        ${receipts}
        <h5>Not known (no record says)</h5>
        ${unknown}
      </section>
    </div>
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
  // R5 (H132): each panel sits in one of the ten workspace tabs (data-ws), which is shown first; a panel shown with its tab
  // alone has nothing else to switch (its tab's own work, the canvas's summary or Slate 3D's frame, is that tab's)
  if (targetPanel.dataset.ws) showWorkspaceTab(targetPanel.dataset.ws);
  const group = targetPanel.dataset.group;
  if (!group) { targetPanel.classList.add('active'); return; }
  // the panels that share one place (the Chat tab's two views): their switches, then the fade between them
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    const p = document.getElementById(`tab-${btn.dataset.tab}`);
    if (!p || p.dataset.group !== group || btn.dataset.wsTab) return;
    const on = btn.dataset.tab === tabId;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  const inGroup = [...document.querySelectorAll('.tab-panel')].filter((p) => p.dataset.group === group);
  const activePanel = inGroup.find((p) => p.classList.contains('active')) ?? null;
  if (activePanel === targetPanel) return;
  // a newer switch wins: the running fades end where they are, and only the newest switch shows its panel
  const mine = ++tabSwitch;
  inGroup.forEach((p) => { if (typeof p.getAnimations === 'function') p.getAnimations().forEach((a) => a.cancel()); });
  const show = () => {
    if (mine !== tabSwitch) return;
    inGroup.forEach((p) => p.classList.remove('active'));
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
  const el = event.target instanceof Element ? event.target.closest('[data-stop-turn], [data-tab], [data-ws-tab], [data-act], [data-open-run], [data-action], [data-copy]') : null;
  if (!el) return;
  // R5 lead (the operator's 22:32 order, item 2): Stop for the chat turn being answered, whichever surface sent it
  if (el.dataset.stopTurn !== undefined) { stopTurn(el); return; }
  if (el.dataset.tab) { switchTab(el.dataset.tab); return; }
  // R5 (H132): a workspace tab, an action of the strip, a run to open (the Workflows tab's list, an event's operation)
  if (el.dataset.wsTab) { showWorkspaceTab(el.dataset.wsTab); return; }
  if (el.dataset.act !== undefined) { runAction(el); return; }
  if (el.dataset.openRun) { showRun(el.dataset.openRun); return; }
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
    // R5 (H132): the start-up settings after a conflict, and the activity stream folded or not
    case 'prefs-reload': if (typeof reloadPrefs === 'function') reloadPrefs(); break;
    case 'toggle-activity': foldActivity(); break;
    default: break;
  }
});

// Carbonyl's launch command names this page's own address (its port is the one this companion took), without the token.
(() => {
  const btn = document.querySelector('[data-copy-carbonyl]');
  if (btn) btn.dataset.copy = `carbonyl ${location.origin}/`;
})();

// ── R5 (H132): the workspace frame (src/contracts/workspace.ts), drawn around the page's own content ──
//
// The operator's completion order of 2026-10-15: the terminal is the main operating space and this page is the browser view
// of the same project workspace. GET /api/workspace (the token in a header) is the frame every surface draws: the ten tabs,
// each tab's numbered workflow actions (at most one primary next step), the connections as Timmy last observed them, the
// activity, the newest log lines, and which surfaces open when the workspace starts. The page draws what the frame says and
// makes none of it up: tab labels, action labels, commands and connection words are the frame's own. A command runs in Timmy's
// terminal; the page copies it (or opens a tab, for a tab's key). Text is set as text, never as markup.

const WS_TAB_KEY = 'timmy.companion.tab';
/** each connection state's glyph (its word is the frame's own state); green only for live (.is-live), amber ✕ for a failure */
const CONN_GLYPH = { live: ['●', 'is-live'], configured: ['○', 'is-configured'], 'not set up': ['·', 'is-unset'], unreachable: ['✕', 'is-failed'], refused: ['✕', 'is-failed'], unknown: ['?', 'is-unknown'] };
/** the connections a tab's own page shows beside its actions (Home shows them all) */
const CONN_FOR = { fleet: ['cloudroom', 'clef', 'cloudflare'], tools: ['mcp-sdk', 'mcporter'] };

const workspace = {
  /** the frame drawn now (null until the companion answers) */
  frame: null,
  /** the tab shown */
  tab: 'home',
  /** a read of the frame in flight */
  asking: null,
  /** why the last read failed, in words (null: it did not) */
  failed: null,
  /** the operation the Workflows tab shows, once one was opened there */
  run: null,
  /** the start-up settings: idle, saving, saved, failed or conflict, and their words */
  prefs: { state: 'idle', words: '', busy: false },
};

/** An element: its attributes (never a style) and its children (text is text). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const shownProjectId = () => document.getElementById('project')?.dataset.project || '';
/** the frame is another project's than the one this page shows (a page whose project the companion cannot name to it) */
const otherProject = (f) => Boolean(f && shownProjectId() && f.project && f.project.id !== shownProjectId());
/** what a command is: a tab's key (1 to 9, then 0), a command for Timmy's terminal, or words to do there */
const commandKind = (c) => (/^[0-9]$/.test(c) ? 'tab' : /^(?:\/|timmy\b)/.test(c) ? 'command' : 'words');
function stripNote(words, state, o = {}) {
  const note = document.getElementById('ws-strip-note');
  if (!note) return;
  note.textContent = words || '';
  if (state) note.dataset.state = state; else delete note.dataset.state;
  // R5 lead: what an action said stays for `hold` ms, so the next frame (each second) does not wipe it before it is read
  workspace.noteHeld = o.hold ? Date.now() + o.hold : 0;
}

/** Reads the frame of the project this page shows; one read at a time (a second ask waits for it). */
function readFrame() {
  if (!companion.token || companion.refused) {
    stripNote('Nothing is read without the companion’s token (see the note above).', 'failed');
    if (workspace.prefs.state === 'idle') setPrefs('idle', 'Not read: nothing is read without the companion’s token.');
    return Promise.resolve();
  }
  if (workspace.asking) return workspace.asking;
  const project = shownProjectId();
  workspace.asking = (async () => {
    try {
      const r = await companion.fetch(`/api/workspace${project ? `?project=${encodeURIComponent(project)}` : ''}`);
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || body.schema !== 'timmy.workspace/1') throw new Error((body && body.error) || `the companion answered HTTP ${r.status}`);
      workspace.failed = null;
      takeFrame(body);
    } catch (err) {
      workspace.failed = err && err.message ? err.message : String(err);
      stripNote(workspace.frame
        ? `The companion did not answer at ${clockOf(new Date().toISOString())} (${workspace.failed}); this is the frame read before.`
        : `The workspace frame could not be read: ${workspace.failed}`, 'failed');
    } finally { workspace.asking = null; }
  })();
  return workspace.asking;
}

/**
 * R5 lead (the final QA of a77d80d, defect 1: just after a stop the page's mirror said STOPPED while its strip still offered
 * Stop, its activity said "1 running" and its log had no stop, for up to 3 s, until the next read): a turn sealed on the bus
 * is read into the whole page at once. A read already under way began before the seal, so this one follows it.
 */
function readFrameAfterTurnEnd() {
  try {
    const under = workspace.asking;
    return under ? under.then(() => readFrame()) : readFrame();
  } catch (e) { return Promise.resolve(); } // the frame's part of the page is not set up yet: its first read follows
}

/** Takes a frame: drawn again only when its revision is another one. */
function takeFrame(frame, redraw = false) {
  const was = workspace.frame;
  workspace.frame = frame;
  if (redraw || !was || was.revision !== frame.revision) drawFrame();
  else if (workspace.failed === null) frameNote(frame);
}

/** The strip's note as the frame gives it (another project's words, else none), unless an action's words are held there. */
function frameNote(f) {
  if (otherProject(f) || !(workspace.noteHeld > Date.now())) stripNote(otherProjectWords(f), otherProject(f) ? 'failed' : null);
}

function otherProjectWords(f) {
  if (!otherProject(f)) return '';
  const shown = document.getElementById('project-name')?.textContent || 'this page’s project';
  return `This page shows ${shown}; the frame the companion gave is ${f.project.name}’s, so its actions, runs and log are not shown here.`;
}

/**
 * Where focus is among what a redraw replaces (an action, a connection card, a command, a run), to give it back to the
 * element drawn in its place: a frame that moves every few seconds must not take a keyboard's place away.
 */
function focusKey() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  for (const attr of ['data-act', 'data-connection', 'data-copy', 'data-open-run']) {
    if (el.hasAttribute(attr)) return { attr, value: el.getAttribute(attr), within: el.parentElement?.closest('[id]')?.id || null };
  }
  return null;
}
function refocus(k) {
  if (!k || (document.activeElement && document.activeElement !== document.body)) return;
  const scope = (k.within && document.getElementById(k.within)) || document;
  const el = scope.querySelector(`[${k.attr}="${CSS.escape(k.value)}"]`);
  if (el) el.focus({ preventScroll: true });
}

function drawFrame() {
  const f = workspace.frame;
  if (!f) return;
  const kept = focusKey();
  const own = !otherProject(f);
  drawTabs(f);
  drawActions(f, own);
  drawProjectCmds(f);
  drawConnections(f);
  drawHome(f, own);
  drawEvents(f, own);
  drawRuns(f, own);
  drawStudio(f);
  drawControl(f, own);
  drawActsFull(f, own);
  drawActivity(f, own);
  drawPrefs(f);
  frameTurnsChanged();
  frameNote(f);
  if (workspace.tab === 'workflows') openNewestRun();
  drawPanel(workspace.tab, f);
  refocus(kept);
  markOverflow();
}

/**
 * R6 lead: the panel of a tab (panels.js; each panel's own file registers it), drawn with this frame for the project the
 * page shows. Only the tab on screen draws: its panel reads its own routes when it is shown and when the frame changes.
 */
function drawPanel(tab, f) {
  if (typeof TimmyPanels === 'undefined' || !f) return;
  TimmyPanels.draw(tab, f, { own: !otherProject(f), project: shownProjectId(), fetch: companion.fetch, h });
}

/**
 * R5 lead (the QA round, defect 5): each box whose content goes on below its edge is marked (data-more), and its bottom
 * border says "more below ↓" (companion.css); scrolling to the end, a resize, a redraw or another tab marks again.
 */
function markOverflow() {
  for (const body of document.querySelectorAll('.box > .box-body')) {
    const box = body.parentElement;
    const more = body.clientHeight > 0 && body.scrollHeight - body.scrollTop - body.clientHeight > 2;
    if (more && box.dataset.more !== '1') box.dataset.more = '1';
    else if (!more && box.dataset.more !== undefined) delete box.dataset.more;
  }
}
document.addEventListener('scroll', (e) => { if (e.target instanceof Element && e.target.classList.contains('box-body')) markOverflow(); }, true);
window.addEventListener('resize', () => markOverflow());

// ── the ten tabs ──

function drawTabs(f) {
  for (const t of f.tabs || []) {
    const btn = document.querySelector(`#ws-tabs [data-ws-tab="${CSS.escape(String(t.id))}"]`);
    if (!btn) continue;
    btn.querySelector('.tab-key').textContent = String(t.key);
    btn.querySelector('.tab-label').textContent = String(t.label);
    btn.setAttribute('aria-keyshortcuts', String(t.key));
    const waiting = btn.querySelector('.tab-waiting');
    waiting.hidden = !(t.waiting > 0);
    waiting.textContent = t.waiting > 0 ? `· ${t.waiting} waiting` : '';
    btn.title = t.waiting > 0 ? `${t.label}: ${t.waiting} waiting on you (key ${t.key})` : `${t.label} (key ${t.key})`;
  }
}

/** The tab a key opens, as the tabs say it now (the frame's keys once it came). */
function tabForKey(key) {
  const btn = [...document.querySelectorAll('#ws-tabs [role="tab"]')].find((b) => b.querySelector('.tab-key')?.textContent === key);
  return btn ? btn.dataset.wsTab : null;
}

/** Shows a workspace tab: its page, its actions, and its own work the first time it is seen (the canvas, Slate 3D, a run). */
function showWorkspaceTab(id, o = {}) {
  const tabs = [...document.querySelectorAll('#ws-tabs [role="tab"]')];
  const btn = tabs.find((b) => b.dataset.wsTab === id);
  if (!btn) return;
  const was = workspace.tab;
  workspace.tab = id;
  for (const b of tabs) {
    const on = b === btn;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  let page = null;
  for (const p of document.querySelectorAll('.ws-page')) {
    const on = p.dataset.wsPage === id;
    p.hidden = !on;
    if (on) page = p;
  }
  if (page && was !== id) fade(page, 0, 1, 150, GSAP_POWER2_OUT).catch(() => undefined);
  if (o.focus) btn.focus();
  if (workspace.frame) drawActions(workspace.frame, !otherProject(workspace.frame));
  if (id === 'studio') refreshCanvas();
  if (id === 'create') openSlate();
  if (id === 'workflows') openNewestRun();
  if (was !== id && workspace.frame) drawPanel(id, workspace.frame);
  markOverflow();
  try { sessionStorage.setItem(WS_TAB_KEY, id); } catch (e) { /* no storage here */ }
}

// ── the Workflow actions strip ──

function drawActions(f, own) {
  const list = document.getElementById('ws-actions');
  if (!list) return;
  const acts = own ? ((f.actions && f.actions[workspace.tab]) || []) : [];
  const running = own && f.activity && f.activity.chatTurn && f.activity.chatTurn.id ? f.activity.chatTurn : null;
  list.replaceChildren(...acts.map((a) => {
    const off = a.enabled === false;
    // R5 lead (the operator's 22:32 order, item 2): Stop the turn stops it from this page (it asks the surface that sent it,
    // which stops it as its own key would); the frame's command says where its own key is
    if (a.label === 'Stop the turn' && !off && running) {
      return h('li', { 'data-primary': a.primary ? 'true' : 'false' }, h('button', {
        type: 'button', class: `act${a.primary ? ' is-primary' : ''}`, 'data-stop-turn': running.id, 'data-n': a.n, 'aria-disabled': 'false',
        title: `Asks ${String(running.surface)} to stop the turn it is answering`,
      }, h('span', { class: 'act-n' }, `${a.n}.`), h('span', { class: 'act-label' }, a.label), h('code', { class: 'act-cmd' }, `from this page, or ${a.command}`)));
    }
    const kind = commandKind(String(a.command));
    const why = off ? h('span', { id: `act-why-${a.n}`, class: 'act-why' }, `not now: ${a.why || 'not available'}`) : null;
    const btn = h('button', {
      type: 'button', class: `act${a.primary ? ' is-primary' : ''}`, 'data-act': a.command, 'data-act-kind': kind, 'data-n': a.n,
      'aria-disabled': off ? 'true' : 'false', 'aria-describedby': off ? `act-why-${a.n}` : null,
      title: kind === 'tab' ? `Opens tab ${a.command}` : kind === 'command' ? 'Copies the command for Timmy’s terminal' : 'Done in Timmy’s terminal',
    }, h('span', { class: 'act-n' }, `${a.n}.`), h('span', { class: 'act-label' }, a.label), h('code', { class: 'act-cmd' }, a.command),
    a.effect && a.effect !== 'read' ? h('span', { class: `act-effect${a.effect === 'spend' ? ' spends' : ''}` }, `· ${a.effect}`) : null);
    return h('li', { 'data-primary': a.primary ? 'true' : 'false' }, btn, why);
  }));
  if (!acts.length) list.append(h('li', { class: 'empty' }, own ? 'The frame gives this tab no actions.' : 'Not shown: the frame is another project’s.'));
}

/** An action pressed: a tab's key opens that tab; a command is copied for Timmy's terminal; words say where to do them. */
async function runAction(btn) {
  const cmd = btn.dataset.act || '';
  if (btn.getAttribute('aria-disabled') === 'true') {
    stripNote(`Not available now: ${document.getElementById(btn.getAttribute('aria-describedby') || '')?.textContent?.replace(/^not now: /, '') || 'the frame says it is not'}.`);
    return;
  }
  const kind = btn.dataset.actKind;
  if (kind === 'tab') { const id = tabForKey(cmd); if (id) showWorkspaceTab(id, { focus: true }); return; }
  if (kind === 'words') { stripNote(`In Timmy’s terminal: ${cmd}.`); return; }
  let copied = false;
  try {
    if (!window.isSecureContext || !navigator.clipboard) throw new Error('no clipboard here');
    await navigator.clipboard.writeText(cmd);
    copied = true;
  } catch (e) { copied = false; }
  stripNote(copied ? `Copied: ${cmd}. Run it in Timmy’s terminal.` : `Not copied (this browser would not): run ${cmd} in Timmy’s terminal.`, null, { hold: 6000 });
}

function drawProjectCmds(f) {
  const box = document.getElementById('project-cmds');
  if (!box || !f.project) return;
  const cmd = (label, c) => h('button', { type: 'button', class: 'cmd', 'data-copy': c, title: `Copies the command for Timmy’s terminal: ${c}` }, h('span', { class: 'cmd-label' }, `${label} `), c);
  box.replaceChildren(cmd('switch:', f.project.switch), cmd('new:', f.project.create));
}

// ── connections: one card each, the frame's own state word with its glyph ──

function connectionCard(c, where) {
  const [glyph, cls] = CONN_GLYPH[c.state] || ['?', 'is-unknown'];
  const id = `${where}-conn-${c.id}`;
  return h('article', { class: 'conn-card', 'data-connection': c.id, 'data-state': c.state, tabindex: '0', 'aria-labelledby': `${id}-name`, 'aria-describedby': `${id}-words` },
    h('div', { class: 'conn-head' }, h('h3', { class: 'conn-name', id: `${id}-name` }, c.label), h('span', { class: `conn-state ${cls}` }, `${glyph} ${c.state}`)),
    h('p', { class: 'conn-words', id: `${id}-words` }, c.words),
    c.detail ? h('p', { class: 'conn-detail' }, c.detail) : null,
    c.setup ? h('p', { class: 'conn-setup' }, h('span', { class: 'cmd-label' }, 'step:'), h('button', { type: 'button', class: 'cmd', 'data-copy': c.setup, title: 'Copies the command for Timmy’s terminal' }, c.setup)) : null);
}

function drawConnections(f) {
  const all = f.connections || [];
  const home = document.getElementById('home-connections');
  if (home) home.replaceChildren(...(all.length ? all.map((c) => connectionCard(c, 'home')) : [h('p', { class: 'empty' }, 'The frame lists no connections.')]));
  for (const box of document.querySelectorAll('[data-conns-for]')) {
    const ids = CONN_FOR[box.dataset.connsFor] || [];
    const these = all.filter((c) => ids.includes(c.id));
    box.replaceChildren(...(these.length ? these.map((c) => connectionCard(c, box.dataset.connsFor)) : [h('p', { class: 'empty' }, 'The frame lists none of this tab’s connections.')]));
  }
}

// ── Home's preview, Studio's state, the Control Room's counts ──

const newestRunOf = (f) => (f.log || []).find((e) => e.operation) || null;
const unknownWhy = (f, field) => ((f.unknown || []).find((u) => u.field === field) || {}).why || null;

/** Timmy Studio, as the frame says it: open it where it runs, else the Studio tab's own step. */
function studioItem(f) {
  const s = (f.surfaces && f.surfaces.studio) || { state: 'unknown', url: null, openAtStart: false };
  const c = (f.connections || []).find((x) => x.id === 'studio');
  const [glyph, cls] = c ? (CONN_GLYPH[c.state] || ['?', 'is-unknown']) : ['?', 'is-unknown'];
  const step = ((f.actions && f.actions.studio) || []).find((a) => a.primary) || ((f.actions && f.actions.studio) || [])[0];
  return h('div', { class: 'preview-item', 'data-preview': 'studio' },
    h('div', { class: 'preview-head' }, h('span', null, 'Timmy Studio'), c ? h('span', { class: `state-word ${cls === 'is-live' ? 'is-live' : ''}` }, `${glyph} ${c.state}`) : null),
    h('p', { class: 'preview-words' }, c ? c.words : 'The frame does not say.'),
    h('div', { class: 'preview-actions' },
      s.state === 'running' && s.url ? h('a', { class: 'link-open', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, `Open Studio at ${s.url}`) : null,
      step ? h('button', { type: 'button', class: 'cmd', 'data-copy': step.command, title: 'Copies the command for Timmy’s terminal' }, h('span', { class: 'cmd-label' }, `${step.label}: `), step.command) : null),
    h('p', { class: 'preview-note' }, s.openAtStart ? 'Opens when the workspace starts.' : 'Opens when asked.'));
}

function drawHome(f, own) {
  const box = document.getElementById('home-preview');
  if (!box) return;
  const items = [studioItem(f)];
  const run = own ? newestRunOf(f) : null;
  items.push(h('div', { class: 'preview-item', 'data-preview': 'run' },
    h('div', { class: 'preview-head' }, h('span', null, 'The newest run'), run ? h('time', { class: 'ev-time', datetime: run.at }, clockOf(run.at)) : null),
    run ? h('p', { class: 'preview-words' }, h('span', { class: `ev-tag tone-${run.tone}` }, `[${run.tag}] `), run.words) : h('p', { class: 'preview-words' }, own ? 'Nothing has run in this project yet.' : 'Not shown: the frame is another project’s.'),
    run ? h('div', { class: 'preview-actions' }, h('button', { type: 'button', class: 'btn-action', 'data-open-run': run.operation }, `Open run ${run.operation}`)) : (unknownWhy(f, 'log') ? h('p', { class: 'preview-note' }, `The frame says: ${unknownWhy(f, 'log')}.`) : null)));
  const a = f.activity || { running: 0, waitingOnYou: 0, stopCurrent: { words: '' } };
  items.push(h('div', { class: 'preview-item', 'data-preview': 'activity' },
    h('div', { class: 'preview-head' }, h('span', null, 'Running · waiting on you')),
    h('p', { class: 'preview-words' }, `${a.running} running · `, h('span', { class: a.waitingOnYou > 0 ? 'waits' : '' }, `${a.waitingOnYou} waiting on you`)),
    a.stopCurrent && a.stopCurrent.words ? h('p', { class: 'preview-note' }, a.stopCurrent.words) : null));
  const unknown = (f.unknown || []).filter((u) => u.field !== 'log');
  if (unknown.length) {
    items.push(h('div', { class: 'preview-item', 'data-preview': 'unknown' }, h('div', { class: 'preview-head' }, h('span', null, 'Not known (no record says)')),
      ...unknown.map((u) => h('p', { class: 'preview-note' }, h('strong', null, `${u.field}: `), u.why))));
  }
  box.replaceChildren(...items);
}

function drawStudio(f) {
  const box = document.getElementById('studio-state');
  if (box) box.replaceChildren(studioItem(f));
}

function drawControl(f, own) {
  const box = document.getElementById('control-now');
  if (!box) return;
  const a = f.activity || { running: 0, waitingOnYou: 0, stopCurrent: { words: '' } };
  const waiting = (f.tabs || []).filter((t) => t.waiting > 0);
  // R5 lead (the finish line, item 3): the chat turns, as the Workbench's Control Room lists them: a turn being answered now,
  // then the sealed ones, newest first, each with its operation
  const turns = own && f.chat && Array.isArray(f.chat.turns) ? f.chat.turns : [];
  // R5 lead (the QA round, defect 5): the DOM's replaceChildren writes a null as the word "null"; only nodes go in
  box.replaceChildren(...[
    h('p', { class: 'activity-words' }, `${a.running} running · `, h('span', { class: a.waitingOnYou > 0 ? 'waits' : '' }, `${a.waitingOnYou} waiting on you`)),
    h('p', { class: 'preview-note' }, own ? (a.stopCurrent && a.stopCurrent.words) || '' : 'Not shown: the frame is another project’s.'),
    ...waiting.map((t) => h('p', { class: 'preview-note' }, `${t.label}: ${t.waiting} waiting`)),
    own ? h('p', { class: 'preview-head', 'data-control': 'chat-turns' }, `Chat turns (${turns.length})`) : null,
    own && a.chatTurn ? h('p', { class: 'preview-note', 'data-control': 'chat-running' }, h('span', { 'data-control': 'chat-running-words' }, `running · ${a.chatTurn.words}${a.chatTurn.since ? ` · since ${clockOf(a.chatTurn.since)}` : ''}`),
      a.chatTurn.id ? h('button', { type: 'button', class: 'btn-action tiny stop-turn', 'data-stop-turn': a.chatTurn.id }, 'Stop this turn') : null) : null,
    own ? (turns.length
      ? h('ul', { class: 'ev-list', 'data-control': 'chat-turn-list' }, ...turns.map((t) => eventItem({ at: t.at, tag: 'chat', words: t.words, tone: t.state === 'failed' ? 'failure' : 'neutral', source: `receipt ${t.receipt}`, ...(t.operation ? { operation: t.operation } : {}) })))
      : h('p', { class: 'preview-note' }, 'No chat turn of this project is sealed yet: a turn is listed once its receipt is sealed, whichever surface sent it.')) : null,
  ].filter(Boolean));
}

/**
 * R5 lead (the operator's 22:32 order, item 2): stops the chat turn `btn` names (its id, as the frame gave it), whichever
 * surface is answering it: POST /api/chat/stop asks the process that holds the turn, which stops it as its own Esc or Ctrl+C
 * would; the turn then ends stopped, its receipt saying it was asked from this page, on every surface. The answer is said in
 * the strip's note; the frame and the bus show the turn's end.
 */
async function stopTurn(btn) {
  const id = btn.dataset.stopTurn || '';
  if (!id || btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  const project = shownProjectId();
  try {
    const r = await companion.fetch(`/api/chat/stop${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn: id }),
    });
    const body = await r.json().catch(() => null);
    stripNote(body && typeof (body.words || body.error) === 'string' ? (body.words || body.error) : `The companion answered HTTP ${r.status}.`, r.ok ? null : 'failed', { hold: 8000 });
  } catch (err) {
    stripNote(`Not stopped: the companion could not be reached (${err && err.message ? err.message : String(err)}).`, 'failed', { hold: 8000 });
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ── a tab's actions in full: what each runs, and whether it reads, changes, sends or spends ──

function drawActsFull(f, own) {
  for (const box of document.querySelectorAll('[data-acts-for]')) {
    const acts = own ? ((f.actions && f.actions[box.dataset.actsFor]) || []) : [];
    box.replaceChildren(...(acts.length ? acts.map((a) => {
      const kind = commandKind(String(a.command));
      return h('div', { class: `act-row${a.primary ? ' is-primary' : ''}`, 'data-n': a.n },
        h('div', { class: 'act-row-head' }, h('span', null, `${a.n}. ${a.label}`), h('span', { class: `act-row-tag${a.primary ? ' is-next' : ''}` }, a.primary ? 'the next step' : a.effect || '')),
        kind === 'command' ? h('p', null, h('button', { type: 'button', class: 'cmd', 'data-copy': a.command, title: 'Copies the command for Timmy’s terminal' }, a.command))
          : h('p', { class: 'act-row-why' }, kind === 'tab' ? `Key ${a.command} opens it.` : `In Timmy’s terminal: ${a.command}.`),
        a.primary && a.effect ? h('p', { class: 'act-row-why' }, `effect: ${a.effect}`) : null,
        a.enabled === false ? h('p', { class: 'act-row-why' }, `not now: ${a.why || 'not available'}`) : null);
    }) : [h('p', { class: 'empty' }, own ? 'The frame gives this tab no actions.' : 'Not shown: the frame is another project’s.')]));
  }
}

// ── events, runs and the activity stream, newest first ──

function eventItem(e, o = {}) {
  const tone = e.tone === 'live' ? 'is-live' : `tone-${e.tone}`;
  const glyph = e.tone === 'failure' ? '✕ ' : e.tone === 'live' ? '✓ ' : '';
  return h('li', { class: 'ev', 'data-tone': e.tone },
    h('time', { class: 'ev-time', datetime: e.at }, clockOf(e.at)),
    h('div', { class: 'ev-main' }, h('span', { class: `ev-tag ${tone}` }, `${glyph}[${e.tag}]`), e.words,
      e.operation ? h('button', { type: 'button', class: 'run-link ev-op', 'data-open-run': e.operation, title: `Opens run ${e.operation} in Workflows` }, e.operation) : null,
      o.from && e.source ? h('span', { class: 'ev-from' }, `from ${e.source}`) : null));
}

function emptyLog(f, own) {
  if (!own) return h('li', { class: 'empty' }, 'Not shown: the frame is another project’s.');
  const why = unknownWhy(f, 'log');
  return h('li', { class: 'empty' }, 'Nothing has run in this project yet.', why ? h('span', { class: 'ev-from' }, `The frame says: ${why}.`) : null);
}

/**
 * R5 lead (the finish line, item 3): the frame's log with the project's sealed chat turns among them, the newest first: the
 * same entries the Workbench's event log shows (src/workbench/hub.ts eventsNow), in the same words.
 */
function eventsOf(f, own) {
  if (!own) return [];
  const turns = (f.chat && Array.isArray(f.chat.turns) ? f.chat.turns : []).map((t) => ({
    at: t.at, tag: 'chat', words: t.words, tone: t.state === 'failed' ? 'failure' : 'neutral', source: `receipt ${t.receipt}`, ...(t.operation ? { operation: t.operation } : {}),
  }));
  return [...(f.log || []), ...turns].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

function drawEvents(f, own) {
  const log = eventsOf(f, own);
  const chat = document.getElementById('chat-events');
  if (chat) chat.replaceChildren(...(log.length ? log.map((e) => eventItem(e)) : [emptyLog(f, own)]));
  const logs = document.getElementById('logs-events');
  if (logs) logs.replaceChildren(...(log.length ? log.map((e) => eventItem(e, { from: true })) : [emptyLog(f, own)]));
}

function drawActivity(f, own) {
  const list = document.getElementById('ws-activity-list');
  const counts = document.getElementById('ws-activity-counts');
  const a = f.activity || { running: 0, waitingOnYou: 0 };
  if (counts) {
    counts.textContent = `${a.running} running · ${a.waitingOnYou} waiting on you`;
    // the whole of it, where a narrow window shortens the line
    counts.title = counts.textContent;
  }
  const events = eventsOf(f, own);
  if (list) list.replaceChildren(...(events.length ? events.map((e) => eventItem(e)) : [emptyLog(f, own)]));
}

function drawRuns(f, own) {
  const list = document.getElementById('flow-runs');
  const words = document.getElementById('flow-activity');
  const a = f.activity || { running: 0, waitingOnYou: 0, stopCurrent: { words: '' } };
  if (words) words.replaceChildren(`${a.running} running · `, h('span', { class: a.waitingOnYou > 0 ? 'waits' : '' }, `${a.waitingOnYou} waiting on you`));
  if (!list) return;
  const seen = new Set();
  const runs = (own ? (f.log || []) : []).filter((e) => e.operation && !seen.has(e.operation) && seen.add(e.operation));
  list.replaceChildren(...(runs.length ? runs.map((e) => h('li', null, h('button', { type: 'button', class: 'run-pick', 'data-open-run': e.operation, 'aria-current': workspace.run === e.operation ? 'true' : 'false' },
    h('span', { class: 'run-pick-op' }, e.operation), h('span', { class: 'run-pick-words' }, e.words), h('time', { class: 'run-pick-time', datetime: e.at }, clockOf(e.at))))) : [emptyLog(f, own)]));
}

/** A run opened from the page: the Workflows tab, its run detail. */
function showRun(op) {
  workspace.run = op;
  showWorkspaceTab('workflows');
  openRun(op);
  for (const b of document.querySelectorAll('.run-pick')) b.setAttribute('aria-current', b.dataset.openRun === op ? 'true' : 'false');
}

/** The Workflows tab shown with no run open yet: the newest run of the frame, without changing the page's address. */
function openNewestRun() {
  if (workspace.run || document.querySelector('#run-detail .run-view, #run-detail .run-error')) return;
  const f = workspace.frame;
  const run = f && !otherProject(f) ? newestRunOf(f) : null;
  if (!run) return;
  workspace.run = run.operation;
  openRun(run.operation, false);
  for (const b of document.querySelectorAll('.run-pick')) b.setAttribute('aria-current', b.dataset.openRun === run.operation ? 'true' : 'false');
}

/** The activity stream folded to its title, or open (this browser remembers which). */
function foldActivity(fold) {
  const box = document.getElementById('ws-activity');
  const btn = document.getElementById('ws-activity-toggle');
  if (!box || !btn) return;
  const folded = typeof fold === 'boolean' ? fold : !box.classList.contains('folded');
  box.classList.toggle('folded', folded);
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
  btn.textContent = folded ? 'Unfold' : 'Fold';
  try { localStorage.setItem('timmy.companion.activity', folded ? 'folded' : 'open'); } catch (e) { /* no storage here */ }
}

// ── the start-up settings, as the frame says them ──

function drawPrefs(f) {
  if (workspace.prefs.busy || workspace.prefs.state === 'conflict') return;
  const s = f.surfaces || {};
  for (const [id, key] of [['pref-companion', 'companion'], ['pref-studio', 'studio']]) {
    const box = document.getElementById(id);
    if (!box || !s[key]) continue;
    box.checked = s[key].openAtStart === true;
    box.disabled = false;
  }
  if (workspace.prefs.state === 'idle') setPrefs('idle', 'Kept in the Workbench’s settings file: the terminal reads the same one.');
}

function setPrefs(state, words) {
  workspace.prefs.state = state;
  workspace.prefs.words = words;
  const el = document.getElementById('prefs-state');
  if (el) { el.textContent = words; el.dataset.state = state; }
  const reload = document.getElementById('prefs-reload');
  if (reload) reload.hidden = state !== 'conflict';
}

// ── the start-up settings, saved from this page (POST /api/workspace/prefs) ──
//
// One save at a time, sent with the revision of the frame this page drew. The companion answers saved (with the newer
// frame), stale (409: the frame is another revision now; nothing written) or a failure in words. The frame's revision
// also moves with its time words ("answered 12 s ago"), so a stale answer whose frame shows the same two settings this
// page drew is sent once more with that frame's revision: nothing the person did not see is written over. A stale answer
// whose settings differ is a conflict, the person's to resolve: the boxes wait as before the click until Reload reads the
// newer frame; nothing is sent again by itself, after a reconnect either.

const PREF_SURFACE = { openCompanionAtStart: 'companion', openStudioAtStart: 'studio' };
/** "14:08": the hour and minute of a save, in this browser's time */
const hourMinute = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? String(iso || '') : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
/** the two settings a frame says, to compare with the ones this page drew */
const prefsOf = (f) => JSON.stringify(Object.values(PREF_SURFACE).map((k) => Boolean(f && f.surfaces && f.surfaces[k] && f.surfaces[k].openAtStart === true)));

function prefBoxes() { return ['pref-companion', 'pref-studio'].map((id) => document.getElementById(id)).filter(Boolean); }
function prefsBusy(busy) {
  workspace.prefs.busy = busy;
  document.getElementById('ws-prefs')?.setAttribute('aria-busy', busy ? 'true' : 'false');
  for (const box of prefBoxes()) box.disabled = busy || workspace.prefs.state === 'conflict';
}

async function postPref(key, want, revision) {
  const project = shownProjectId();
  const r = await companion.fetch(`/api/workspace/prefs${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: want, if_revision: revision }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function savePref(box) {
  const drawn = workspace.frame;
  const key = box.dataset.pref;
  const want = box.checked;
  // nothing drawn to save against yet, a save on its way, or a conflict waiting: the box goes back, nothing is sent
  if (!drawn || workspace.prefs.busy || workspace.prefs.state === 'conflict' || !Object.prototype.hasOwnProperty.call(PREF_SURFACE, key)) { box.checked = !want; return; }
  setPrefs('saving', 'Saving…');
  prefsBusy(true);
  let took = false;
  try {
    let { status, body } = await postPref(key, want, drawn.revision);
    const stale = () => status === 409 && body && body.error === 'stale';
    if (stale() && body.frame && prefsOf(body.frame) === prefsOf(drawn)) ({ status, body } = await postPref(key, want, body.frame.revision));
    if (status === 200 && body && typeof body.saved_at === 'string') {
      setPrefs('saved', `Saved at ${hourMinute(body.saved_at)}`);
      if (body.frame) { takeFrame(body.frame); took = true; }
    } else if (stale()) {
      box.checked = !want;
      setPrefs('conflict', 'Changed elsewhere: reload');
    } else {
      box.checked = !want;
      setPrefs('failed', `Failed to save: ${(body && typeof body.error === 'string' && body.error) || `the companion answered HTTP ${status}`}`);
    }
  } catch (err) {
    box.checked = !want;
    setPrefs('failed', `Failed to save: the companion could not be reached (${err && err.message ? err.message : String(err)})`);
  } finally {
    prefsBusy(false);
  }
  // both boxes as the saved frame says them (the other one may have changed elsewhere, and is shown, not written)
  if (took) drawPrefs(workspace.frame);
}

/** Reload after a conflict: the newer frame is read and drawn; the person decides again from what it says. */
async function reloadPrefs() {
  if (workspace.prefs.busy) return;
  setPrefs('saving', 'Reading the settings as they are now…');
  prefsBusy(true);
  await readFrame();
  if (workspace.failed) {
    setPrefs('conflict', `Changed elsewhere: reload (the companion did not answer: ${workspace.failed})`);
    prefsBusy(false);
    return;
  }
  // a state of its own, so these words stay while the boxes are drawn from the newer frame
  setPrefs('reloaded', `Reloaded at ${hourMinute(new Date().toISOString())}: these are the settings now.`);
  prefsBusy(false);
  if (workspace.frame) drawPrefs(workspace.frame);
}

document.getElementById('ws-prefs')?.addEventListener('change', (event) => {
  const box = event.target;
  if (box instanceof HTMLInputElement && box.type === 'checkbox' && box.dataset.pref) savePref(box);
});
document.getElementById('ws-prefs')?.addEventListener('submit', (event) => { event.preventDefault(); });

// ── the keyboard ──
//
// Keys 1 to 9, then 0, open the ten tabs (as the frame keys them), never while typing in a text field nor under an open
// dialog. Left, Right, Home and End move along a tablist and open the tab reached (the WAI-ARIA tabs pattern: the workspace's
// ten tabs, the chat's two views). Focus that a tab change would hide (in the tabs, the strip or the page left) goes to the
// tab opened.

const TEXT_INPUT = /^(?:text|search|url|email|password|number|tel|date|datetime-local|month|time|week)$/;
/** Whether keys typed now go into a text field (a text input, a text area, a list box or editable text). */
function typingIn(el) {
  if (!(el instanceof Element)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT.test(el.type || 'text');
  return el instanceof HTMLElement && el.isContentEditable;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  const at = event.target;
  if (/^[0-9]$/.test(event.key)) {
    if (typingIn(at) || document.querySelector('dialog[open], [aria-modal="true"]')) return;
    const id = tabForKey(event.key);
    if (!id) return;
    event.preventDefault();
    const moves = at instanceof Element && Boolean(at.closest('#ws-tabs, #ws-strip, .ws-page'));
    showWorkspaceTab(id, { focus: moves });
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(at instanceof Element) || at.getAttribute('role') !== 'tab') return;
  const list = at.closest('[role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(at);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});

// ── when the page reads the frame ──

function onCompanionConnected() { readFrame(); }
function onProjectShown(p) { if (!workspace.frame || workspace.frame.project.id !== p.id) readFrame(); }

// Live: the frame is read every WS_POLL_MS while this page is seen (one read at a time; drawn again only when its revision
// is another one), at once when the page is seen again, and when the companion's socket opens again (onCompanionConnected).
// A read changes nothing: a save waiting on a conflict stays the person's to reload.
const WS_POLL_MS = 3000;
setInterval(() => { if (!document.hidden) readFrame(); }, WS_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) readFrame(); });

(() => {
  // the tab this browser tab showed last (a run's address opens Workflows instead)
  let tab = 'home';
  try { tab = sessionStorage.getItem(WS_TAB_KEY) || 'home'; } catch (e) { tab = 'home'; }
  if (!/^\/run\//.test(location.pathname)) showWorkspaceTab(document.querySelector(`#ws-tabs [data-ws-tab="${CSS.escape(tab)}"]`) ? tab : 'home');
  let folded = false;
  try { folded = localStorage.getItem('timmy.companion.activity') === 'folded'; } catch (e) { folded = false; }
  if (folded) foldActivity(true);
  readFrame();
})();

// ── end of the workspace frame ──

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
