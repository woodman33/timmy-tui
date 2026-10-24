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
  // R6 lead: the tab the address asks for (?tab=<id>, or &tab=<id> beside the token after #), read before the token is taken
  // out of the address; the start code opens it (a Workbench tab's `c` opens the companion on the same tab)
  let askedTab = '';
  // R7 (H152): and the run it asks for (?run=<operation id>, or run=<id> beside the token), opened on Workflows; an operation
  // id is not a secret, so it may stay in the address (the token never does)
  let askedRun = '';
  try {
    const fromQuery = new URLSearchParams(location.search).get('tab');
    const fromHash = /(?:^#|&)tab=([a-z]{2,16})(?:&|$)/.exec(location.hash);
    askedTab = (fromHash ? fromHash[1] : fromQuery || '').toLowerCase();
    const runHash = /(?:^#|&)run=(o[0-9a-f]{8})(?:&|$)/.exec(location.hash);
    const runQuery = new URLSearchParams(location.search).get('run') || '';
    askedRun = runHash ? runHash[1] : /^o[0-9a-f]{8}$/.test(runQuery) ? runQuery : '';
    const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (m) {
      token = m[1];
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) { /* no address to read */ }
  // R7 (H152; the R6 interaction review's N7): both ways Timmy opens this page with its token: the Workbench's c, and the
  // monitor's pairing card. The token is kept in this page's memory only, never in storage, so an address typed by hand has none.
  const OPEN_FROM_TIMMY = 'Open it from Timmy: in the Workbench (`timmy workbench`), press c, which opens this page on the tab it shows, with its token; or in `timmy watch`, press q on HOME, which shows the companion’s address with its token.';
  const c = {
    token,
    askedTab,
    askedRun,
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
      // R11 round 4: through the shell when it is here (the session header rides; a session 401 goes to the account screen,
      // a token 401 refuses the page as before)
      if (typeof TimmyShell !== 'undefined' && TimmyShell && typeof TimmyShell.fetch === 'function') return TimmyShell.fetch(path, init);
      const o = Object.assign({}, init || {});
      o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + token });
      o.credentials = 'omit';
      o.cache = 'no-store';
      // (R11 round 4, the lead's 23:33 blocker: a 401 whose body says { needs: 'session' } is a user-data route asking for a
      // signed-in account on a configured companion — the shell's landing shows the account screen for it; only a 401 that is
      // NOT one refuses the page as the launch token's refusal. The frame's first read runs before shell.js is here.)
      return fetch(path, o).then(async (r) => {
        if (r.status !== 401) return r;
        let body = null;
        try { body = await r.clone().json(); } catch (e) { body = null; }
        if (body && body.needs === 'session') return r;
        c.refuse();
        return r;
      });
    },
    // Whether the companion still takes this token (asked when the socket closes); true when it cannot be asked.
    check: () => c.fetch('/api/auth').then((r) => r.status !== 401, () => true),
    // (R11 round 4: the chat's turn is POST /api/chat/turn through TimmyShell.fetch, in chat-shell.js; the legacy POST /chat caller is gone)
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
    // R10 (H167; H164's scope): whose chat this is, in words (H164's route.scope.words), not the request's path
    if (line) line.textContent = r.ready ? String((r.scope && r.scope.words) || r.label) : String(r.label);
    for (const fn of listeners) { try { fn(r); } catch (e) { /* one listener's failure is its own */ } }
  };
  const refresh = async () => {
    if (!companion.token || companion.refused) {
      set({ kind: 'none', ready: false, label: 'no token · Send is off', words: 'Send is off: this page has no token from Timmy (or not this companion’s), so it asks nothing. Open the companion from Timmy: the Workbench’s c, or q on HOME in `timmy watch`.' });
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
  // R11 round 4: the legacy POST /chat caller is gone: the chat is the agent turn in the Chat composition (POST /api/chat/turn,
  // chat-shell.js); the older Streamdown view sends nothing and says so
  chat: () => Promise.reject(new Error('This older view sends nothing: the chat is the agent turn in Chat above (POST /api/chat/turn).')),
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
// R11 round 4 (H170's socket event): what the Chat does when a connection of the account changed (chat-shell.js sets it)
// eslint-disable-next-line prefer-const
let onConnectionsChanged = null;
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
  // (R10 H167; H168's F3 on the page: a surface by its name, not its command)
  monitor: { icon: '◉', name: 'Monitor', where: 'the monitor', words: 'Its words are in the monitor\'s chat (this page shows a monitor\'s words above only when that monitor serves it)' },
  workbench: { icon: '▣', name: 'Workbench', where: 'the Workbench', words: 'Its words are in the Workbench\'s Chat' },
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
  // R11 round 4 (H171): the session, when the account screen has one (TimmyShell.socketHello: { session }), never a key
  const session = typeof TimmyShell !== 'undefined' && TimmyShell ? TimmyShell.socketHello() : {};
  return Object.assign(pin ? { type: 'hello', pin } : { type: 'hello' }, session);
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
  // R7 (H152): who asked a stopped turn to stop, when another surface did (the receipt's stopped_by, on the bus beside it)
  const stoppedBy = typeof p.stopped_by === 'string' && Object.prototype.hasOwnProperty.call(STOP_SURFACE, p.stopped_by) ? p.stopped_by : '';
  if (p.kind === 'chat') {
    const s = SURFACE_TURN.exec(String(p.subject || ''));
    if (!s) return null;
    return { hash, at, receipt: hash.slice(7, 15), surface: s[1], state: s[2] || 'ended', cancelled: s[2] === 'cancelled', steps: Number(s[3]), turn, stoppedBy };
  }
  const m = REPL_TURN.exec(String(p.subject || ''));
  return { hash, at, receipt: hash.slice(7, 15), surface: 'repl', state: m && m[1] ? 'cancelled' : 'ended', cancelled: Boolean(m && m[1]), steps: m ? Number(m[2]) : null, turn, stoppedBy };
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
  const state = known && typeof known.state === 'string' ? known.state : turn.state === 'cancelled' ? 'stopped' : turn.state;
  return { state, words: turnEndSaid(state, turn.surface, (known && known.stoppedBy) || turn.stoppedBy || '') };
}

/**
 * R7 (H152; the R5 visual review's 13, "mirror rows don't say who stopped"): how a turn ended, in the one table's words
 * (src/contracts/stop-words.ts turnEndWords; tests/companion-client.test.ts holds the two to the same words): answered, failed,
 * ended (not known to the frame yet), or "stopped (asked from <the surface that asked>)": the surface its receipt names
 * (stopped_by) when another one asked, else the one that sent it. Never "cancelled": that word is a workflow job's.
 */
const STOP_SURFACE = { repl: 'the REPL', workbench: 'the Workbench', monitor: 'the monitor', companion: 'the companion', unknown: 'another surface' };
function turnEndSaid(state, surface, stoppedBy) {
  if (state !== 'stopped') return state;
  const asker = stoppedBy || surface;
  return `stopped (asked from ${Object.prototype.hasOwnProperty.call(STOP_SURFACE, asker) ? STOP_SURFACE[asker] : asker})`;
}
/** A turn's end and its steps, in one phrase: "ended (2 steps)", "stopped (asked from the REPL; 1 step)". */
function turnEndPhrase(end, steps) {
  const n = steps === null || steps === undefined ? '' : `${steps} ${steps === 1 ? 'step' : 'steps'}`;
  if (end.state === 'stopped') return n ? `${end.words.slice(0, -1)}; ${n})` : end.words;
  return n ? `${end.words} (${n})` : end.words;
}

function surfaceTurnHtml(turn) {
  const s = SURFACES[turn.surface];
  const time = clockOf(turn.at);
  const end = turnEnd(turn);
  return `
      <div class="log-msg repl" data-mirror="surface-turn" data-surface="${escapeMirrorText(turn.surface)}" data-state="${escapeMirrorText(end.state)}">
        <div class="log-header repl">
          <span>${s.icon} ${s.name} turn · ${escapeMirrorText(end.words)}</span>
          <span class="log-time">${escapeMirrorText(time)}</span>
        </div>
        <div class="log-content">A chat turn in ${s.where} ${escapeMirrorText(turnEndPhrase(end, turn.steps))}; Timmy sealed its receipt, in this project's one conversation. ${s.words}: Timmy seals a turn's prompt and answer as hashes only, so they are not on the event bus and are not shown here. <details class="mirror-more"><summary>Details</summary> receipt <span class="mirror-code">${escapeMirrorText(turn.receipt)}</span></details></div>
      </div>
    `;
}

function replTurnHtml(turn) {
  if (turn.surface && turn.surface !== 'repl' && SURFACES[turn.surface]) return surfaceTurnHtml(turn);
  const time = clockOf(turn.at);
  const end = turnEnd({ ...turn, state: turn.cancelled ? 'cancelled' : 'ended' });
  return `
      <div class="log-msg repl" data-mirror="repl-turn" data-state="${escapeMirrorText(end.state)}">
        <div class="log-header repl">
          <span>⌨ REPL turn · ${escapeMirrorText(end.words)}</span>
          <span class="log-time">${escapeMirrorText(time)}</span>
        </div>
        <div class="log-content">A chat turn in the REPL ${escapeMirrorText(turnEndPhrase(end, turn.steps))}; Timmy sealed its receipt. Its words are in the REPL: Timmy seals a REPL turn's prompt and answer as hashes only, so they are not on the event bus and are not shown here. <details class="mirror-more"><summary>Details</summary> receipt <span class="mirror-code">${escapeMirrorText(turn.receipt)}</span></details></div>
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
        <div>The older STREAMDOWN CHAT view sends nothing now: the chat is the agent turn in Chat (POST /api/chat/turn); its ✨ sample is labelled SAMPLE there and is never shown here.</div>
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
    // R10 (H167): its subject in a part of its own, which a narrower window leaves out (the state stays): the header keeps one row
    statusEl.replaceChildren(h('span', { class: 'status-what' }, 'COMPANION SOCKET · '), 'CONNECTED');
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
      } else if (msg.type === 'session' && msg.ok === false) {
        // R11 round 4 (H171): the hello's session did not verify (or names no project of the account's): the shell forgets
        // it and lands on the account screen, in the companion's words; this page shows no project meanwhile
        appendToLocalLogs('WARN', `Session refused by the companion: ${String(msg.words || '')}`);
        // (a hello sent without a session on a configured companion is told so and waits: the shell is already landing on
        // the account screen, nothing more to say; a session the page held that did not verify is forgotten, and said)
        if (typeof TimmyShell !== 'undefined' && TimmyShell && TimmyShell.session.get()) { TimmyShell.toast(String(msg.words || 'Sign in to continue.')); if (msg.needs === 'session') { TimmyShell.session.clear(); TimmyShell.land(); } }
      } else if (msg.type === 'connections' && typeof msg.provider === 'string') {
        // R11 round 4 (H170): a connection of this account changed (saved, checked, downloaded): the connections screen reads
        // again, and the Chat's models and route follow
        appendToLocalLogs('INFO', `Connections: ${String(msg.provider)} ${String(msg.state || '')}`);
        const host = document.getElementById('screen-connections');
        const scr = host && host._cxScreen;
        if (scr && typeof scr.update === 'function') { try { scr.update(msg); } catch (e) { /* its own */ } }
        if (typeof onConnectionsChanged === 'function') { try { onConnectionsChanged(msg); } catch (e) { /* its own */ } }
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
    statusEl.replaceChildren(h('span', { class: 'status-what' }, 'COMPANION SOCKET · '), 'RECONNECTING');
    setDot('lost');
    appendToLocalLogs('ERROR', 'WebSocket connection lost. Retrying in 2s...');
    if (!isViewingSaved) updateMirrorStatus('RECONNECTING');
    // R4 (H84): a socket refused for its token closes like a lost one; the companion is asked, and a refusal stops the retries
    companion.check();
    // R6 (H140): and, while the page is seen, the frame is asked at once: a companion that is gone makes the read fail, and its
    // card says so now (a page not seen reads nothing; seen again, it reads)
    if (!document.hidden) { try { readFrame(); } catch (e) { /* the frame's part of the page is not set up yet */ } }
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
const SURFACE_OF = { repl: { icon: '⌨', name: 'REPL', where: 'the REPL', words: 'Its words are in the REPL' }, ...SURFACES };
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
          <span>${s.icon} ${s.name} turn · ${escapeMirrorText(turnEndSaid(t.state, t.surface, t.stoppedBy || ''))}</span>
          <span class="log-time">${escapeMirrorText(clockOf(t.at))}</span>
        </div>
        <div class="log-content">A chat turn in ${s.where} ${escapeMirrorText(turnEndSaid(t.state, t.surface, t.stoppedBy || ''))} (${escapeMirrorText(t.model || 'model not recorded')}), its receipt sealed before this page connected, in this project's one conversation. ${s.words}: Timmy seals a turn's prompt and answer as hashes only, so they are not shown here. <details class="mirror-more"><summary>Details</summary> receipt <span class="mirror-code">${escapeMirrorText(t.receipt)}</span>${op}</details></div>
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
  const whose = s.project ? `<p class="canvas-whose">The board of ${canvasEsc(s.project)} (each project has its own)</p>` : '';
  const head = whose + (s.unreadable
    ? '<p>The saved canvas could not be read. Open the canvas on the computer that runs Timmy: it keeps the file aside and starts blank.</p>'
    : `<p><strong>Revision ${canvasEsc(s.revision)}</strong>${s.sourceRevision ? ` · source ${canvasEsc(String(s.sourceRevision).slice(0, 12))}` : ' · not saved yet'}${s.savedAt ? ` · saved ${canvasEsc(canvasWhen(s.savedAt))}` : ''}</p>`);
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
    // R6 lead: the board of the project this page shows (each project has its own since H139)
    const project = shownProjectId();
    const r = await companion.fetch(`/api/canvas${project ? `?project=${encodeURIComponent(project)}` : ''}`);
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
  const whole = (p.mode === 'fixed' ? `${reads}. TIMMY_REPO fixed this folder: this companion follows no project.`
    : p.mode === 'pinned' ? `${reads}. Pinned on this page${otherActive ? `; the active project is now ${p.active.name} (${p.active.folder})` : ''}.`
      : `${reads}. Following the active project, which Timmy records in ${p.record}.`) + (p.note ? ` ${p.note}` : '');
  // R10 (H167; H168's F3 on the page): said in words; the folder, the record's file and the note whole under Details (and on
  // hover). R5 (H132): the line is one row on a wide screen
  const said = `This page reads ${p.name}’s event bus and receipts, for the Chat Mirror’s REPL turns and the Logs tab. ${p.mode === 'fixed' ? 'A setting fixed its folder: this companion follows no project.' : p.mode === 'pinned' ? `Pinned on this page${otherActive ? `; the active project is now ${p.active.name}` : ''}.` : 'Following the active project.'}`;
  folder.replaceChildren(h('span', { class: 'folder-said' }, said), ' ', h('details', { class: 'folder-more' }, h('summary', null, 'Details'), h('span', { class: 'folder-whole' }, whole)));
  folder.title = whole;
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

// R6 (H144): one run's detail (openRun) is drawn by src/companion/client/panel-run.js, loaded before this file: its
// source, its changes with their diffs, its outputs and its receipts as the companion's server verified them.

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
  const el = event.target instanceof Element ? event.target.closest('[data-stop-turn], [data-tab], [data-ws-tab], [data-act], [data-open-run], [data-open-vox], [data-action], [data-copy]') : null;
  if (!el) return;
  // R5 lead (the operator's 22:32 order, item 2): Stop for the chat turn being answered, whichever surface sent it
  if (el.dataset.stopTurn !== undefined) { stopTurn(el); return; }
  if (el.dataset.tab) { switchTab(el.dataset.tab); return; }
  // R5 (H132): a workspace tab, an action of the strip, a run to open (the Workflows tab's list, an event's operation)
  if (el.dataset.wsTab) { showWorkspaceTab(el.dataset.wsTab); return; }
  if (el.dataset.act !== undefined) { runAction(el); return; }
  if (el.dataset.openRun) { showRun(el.dataset.openRun); return; }
  // R6 lead: a VoxVision record to open (Home's newest images): its tab, with the record chosen there (panel-vox.js)
  if (el.dataset.openVox) { document.dispatchEvent(new CustomEvent('timmy:vox-show', { detail: { id: el.dataset.openVox } })); showWorkspaceTab('voxvision'); return; }
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
  /** R6 (H140): when this page's reads began to fail (null: they do not), and when the companion last answered one */
  failedAt: null,
  answeredAt: null,
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
      // R6 (H140): the companion answered this page now; a page whose reads had failed draws the whole frame again
      const had = workspace.failed !== null;
      workspace.failed = null;
      workspace.failedAt = null;
      workspace.answeredAt = new Date().toISOString();
      takeFrame(body, had);
    } catch (err) {
      workspace.failed = err && err.message ? err.message : String(err);
      if (!workspace.failedAt) workspace.failedAt = new Date().toISOString();
      stripNote(workspace.frame
        ? `The companion did not answer at ${clockOf(new Date().toISOString())} (${workspace.failed}); this is the frame read before.`
        : `The workspace frame could not be read: ${workspace.failed}`, 'failed');
      // R6 (H140): the cards say so at once (shownConnections): the companion's is not live, no other stays green
      if (workspace.frame) {
        try { drawConnections(workspace.frame); drawHome(workspace.frame, !otherProject(workspace.frame)); drawStudio(workspace.frame); } catch (e) { /* the frame's part of the page is not set up yet */ }
      }
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
  for (const attr of ['data-act', 'data-connection', 'data-copy', 'data-open-run', 'data-open-vox', 'data-enlarge']) {
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
  // R10 (H167): Home's recent work read again when the frame changes (a run that started or ended, a turn sealed)
  if (workspace.tab === 'home' || homeWork.items === null) readHomeWork(true);
  drawHomeWork();
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
  if (workspace.tab === 'studio') refreshCanvas();
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

/** R7 (H152): the frame's words for a tab whose intended interactions do not all work yet (TabDef.unfinished), or null. */
const unfinishedOf = (t) => (t && t.unfinished && typeof t.unfinished.works === 'string' && typeof t.unfinished.missing === 'string' ? t.unfinished : null);

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
    // R7 (H152; the operator's order of 2026-10-16, 22:08 PT: "Keep 3D/Motion, Control Room, Fleet/Clef and Logs/Receipts
    // visibly unfinished until their intended interactions work"): marked in the strip by its shape and a glyph, never by a
    // colour alone (a dashed border and ◌, in structure and text colours), its words in its title and its description
    const u = unfinishedOf(t);
    let mark = btn.querySelector('.tab-unfinished');
    if (u && !mark) { mark = h('span', { class: 'tab-unfinished', 'aria-hidden': 'true' }, '◌'); btn.querySelector('.tab-label').after(mark); }
    if (!u && mark) mark.remove();
    if (u) { btn.dataset.unfinished = 'true'; btn.setAttribute('aria-description', `unfinished: works now: ${u.works}; not yet: ${u.missing}`); }
    else { delete btn.dataset.unfinished; btn.removeAttribute('aria-description'); }
    btn.title = `${t.label}${t.waiting > 0 ? `: ${t.waiting} waiting on you` : ''}${u ? ' · unfinished (its tab says what works now)' : ''} (key ${t.key})`;
  }
  drawUnfinished(f);
}

/**
 * R7 (H152): each unfinished tab's page opens with an "Unfinished" box, above the tab's own content: what works on it now and
 * what it does not do yet, in the frame's words (src/contracts/workspace.ts TabDef.unfinished, carried on the frame's tabs[]);
 * none is made up here. In structure and text colours: it is neither a step nor a state. A tab the frame no longer marks loses
 * its box.
 */
function drawUnfinished(f) {
  const marked = new Map((f.tabs || []).filter((t) => unfinishedOf(t)).map((t) => [String(t.id), t]));
  for (const page of document.querySelectorAll('.ws-page[data-ws-page]')) {
    const t = marked.get(page.dataset.wsPage);
    let box = page.querySelector(':scope > .unfinished');
    if (!t) { if (box) box.remove(); continue; }
    const u = unfinishedOf(t);
    const id = `unfinished-${t.id}`;
    if (!box) {
      box = h('section', { class: 'unfinished', 'data-unfinished': t.id, role: 'note', 'aria-labelledby': `${id}-title` });
      page.prepend(box);
    }
    box.replaceChildren(
      h('h2', { class: 'unfinished-title', id: `${id}-title` }, h('span', { 'aria-hidden': 'true' }, '◌ '), `Unfinished · ${t.label}`),
      h('p', { class: 'unfinished-line', 'data-unfinished-part': 'works' }, h('span', { class: 'unfinished-k' }, 'Works now: '), u.works),
      h('p', { class: 'unfinished-line', 'data-unfinished-part': 'missing' }, h('span', { class: 'unfinished-k' }, 'Not yet: '), u.missing));
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
  if (id === 'home') { readHomeWork(); drawHomeWork(); }
  if (id === 'chat') { readProjectRoute(); drawProjectRoute(); }
  if (was !== id && workspace.frame) drawPanel(id, workspace.frame);
  markOverflow();
  try { sessionStorage.setItem(WS_TAB_KEY, id); } catch (e) { /* no storage here */ }
}

// ── the Workflow actions strip ──

/** R10 (H167): what an action touches, in words (the Workbench's row 2 says the same) */
const EFFECT_WORDS = { network: 'asks over the network', 'local change': 'changes files on this computer', spend: 'can spend' };

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
      // (R10 H167: where its own key is, in words beside it, as the frame says it; no command chip)
      }, h('span', { class: 'act-n' }, `${a.n}.`), h('span', { class: 'act-label' }, a.label), h('span', { class: 'act-effect' }, `· from this page, or ${a.command}`)));
    }
    const kind = commandKind(String(a.command));
    const why = off ? h('span', { id: `act-why-${a.n}`, class: 'act-why' }, `not now: ${a.why || 'not available'}`) : null;
    const btn = h('button', {
      type: 'button', class: `act${a.primary ? ' is-primary' : ''}`, 'data-act': a.command, 'data-act-kind': kind, 'data-n': a.n,
      'aria-disabled': off ? 'true' : 'false', 'aria-describedby': off ? `act-why-${a.n}` : null,
      title: kind === 'tab' ? `Opens tab ${a.command}` : kind === 'command' ? 'Copies the command for Timmy’s terminal' : 'Done in Timmy’s terminal',
    // R10 (H167; H168's patterns 1 and 7): the action in words, what it touches beside it; the command it copies is said when
    // pressed (the strip's note) and on hover, never as the button's words
    }, h('span', { class: 'act-n' }, `${a.n}.`), h('span', { class: 'act-label' }, a.label),
    a.effect && a.effect !== 'read' ? h('span', { class: `act-effect${a.effect === 'spend' ? ' spends' : ''}` }, `· ${EFFECT_WORDS[a.effect] || a.effect}`) : null);
    if (kind === 'command') btn.title = `Copies its command for Timmy’s terminal: ${a.command}`;
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
  // R10 (H167; H168's pattern 1): the two steps in words; each copies its command for Timmy's terminal (said on hover and when
  // copied), never shown as the button's words
  const cmd = (label, c) => h('button', { type: 'button', class: 'btn-action tiny project-cmd', 'data-copy': c, title: `Copies the command for Timmy’s terminal: ${c}` }, label);
  box.replaceChildren(cmd('Switch project', f.project.switch), cmd('New project', f.project.create));
}

// ── connections: one card each, the frame's own state word with its glyph ──

/**
 * R10 (H167; H168's F3 and pattern 1): a connection's words as a screen says them: an address, a port, an error's code, a
 * command, a setting's name and a path said by what they are (the terminal Workbench's inWords, src/workbench/home-journey.ts);
 * the card's Details keep them whole.
 */
function inWordsPage(words) {
  return String(words || '')
    .replace(/\b(?:at|on) (?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?(?=[\s,;.)]|$)/g, 'on this computer')
    .replace(/\(?(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s,;)]*)?\)?/g, 'this computer')
    .replace(/\bhttps?:\/\/[^\s,;)]+/g, 'its address')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'its address')
    .replace(/the connection failed \(ECONNREFUSED\)/g, 'the connection was refused')
    .replace(/\s*\(E[A-Z]{3,}\)/g, '')
    .replace(/\s*\((?:[^()]*: )?(?:timmy|ollama|npm|npx|brew|curl|open|xdg-open)\b[^()]*\)/g, '')
    .replace(/\b(?:start it|run) \((?:ollama serve|open -a Ollama)[^)]*\)/gi, 'start the Ollama app')
    .replace(/`[^`]+`/g, 'the command (Details)')
    .replace(/\bthen timmy workspace check\b/g, 'then check again')
    .replace(/\btimmy workspace check\b/g, 'a check')
    .replace(/\btimmy (?:init|setup|act)(?: --?[\w-]+(?:[ =](?!asks\b|reads\b|and\b|or\b)[\w./:<>-]+)?)*/g, 'the setup (in a shell)')
    .replace(/\/(?:setup|model|run|op|jobs|open)\b(?: (?![A-Z])[\w./-]+)*/g, 'a REPL command (Details)')
    .replace(/\bollama (?:serve|pull|run)\b(?: [\w.:<>-]+)?/g, 'Ollama')
    .replace(/\bset [A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, 'set it in the environment (Details)')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, 'a setting (Details)')
    .replace(/(?:~|<Timmy home>)?\/?(?:[\w.@-]+\/)+[\w.@-]+\.(?:json|jsonl|md|log|txt|ts|js|png|stl|obj|ply|rrd)\b/g, 'its file')
    .replace(/(?:~|<Timmy home>)\/[\w.@/-]+/g, 'its folder')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function connectionCard(c, where) {
  const [glyph, cls] = CONN_GLYPH[c.state] || ['?', 'is-unknown'];
  const id = `${where}-conn-${c.id}`;
  // R10 (H167): the card in words; its own words whole, its address and its step's command under Details
  const said = inWordsPage(c.words);
  const more = said !== c.words || (c.detail && inWordsPage(c.detail) !== c.detail) || c.setup;
  return h('article', { class: 'conn-card', 'data-connection': c.id, 'data-state': c.state, tabindex: '0', 'aria-labelledby': `${id}-name`, 'aria-describedby': `${id}-words` },
    h('div', { class: 'conn-head' }, h('h3', { class: 'conn-name', id: `${id}-name` }, c.label), h('span', { class: `conn-state ${cls}` }, `${glyph} ${c.state}`)),
    h('p', { class: 'conn-words', id: `${id}-words` }, said),
    c.detail ? h('p', { class: 'conn-detail' }, inWordsPage(c.detail)) : null,
    more ? h('details', { class: 'conn-more' }, h('summary', null, 'Details'),
      said !== c.words ? h('p', { class: 'conn-raw' }, c.words) : null,
      c.detail && inWordsPage(c.detail) !== c.detail ? h('p', { class: 'conn-raw' }, c.detail) : null,
      c.setup ? h('p', { class: 'conn-setup' }, h('span', { class: 'cmd-label' }, 'its step, for Timmy’s terminal: '), h('button', { type: 'button', class: 'cmd', 'data-copy': c.setup, title: 'Copies the command for Timmy’s terminal' }, c.setup)) : null) : null);
}

/**
 * R6 (H140; the R5 interaction review, claim c: the page kept "● live · answered just now" for its own companion for 2.5 min
 * after the Workbench that served it quit, beside "COMPANION SOCKET · RECONNECTING"): the connections as this page can say
 * them now. While its own reads of the frame fail, the companion's card is not live: it says that this page's reads fail,
 * since when and why, and when the companion last answered this page. No other card stays green on a frame the page cannot
 * read again: each says it is not known now, and what the frame said when it was last read.
 */
function shownConnections(f) {
  const all = (f && f.connections) || [];
  if (!workspace.failed) return all;
  const last = workspace.answeredAt ? `it last answered this page at ${clockOf(workspace.answeredAt)}` : 'it has not answered this page';
  const since = workspace.failedAt ? ` since ${clockOf(workspace.failedAt)}` : '';
  return all.map((c) => {
    if (c.id === 'companion') return { ...c, state: 'unreachable', words: `not answering this page: its reads of the frame fail${since} (${workspace.failed}); ${last}` };
    if (c.state === 'live') return { ...c, state: 'unknown', words: `not known now: this page cannot read the frame; when it last could${workspace.answeredAt ? ` (${clockOf(workspace.answeredAt)})` : ''}, the frame said: ${c.words}` };
    return c;
  });
}

function drawConnections(f) {
  const all = shownConnections(f);
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
  const c = shownConnections(f).find((x) => x.id === 'studio');
  const [glyph, cls] = c ? (CONN_GLYPH[c.state] || ['?', 'is-unknown']) : ['?', 'is-unknown'];
  const step = ((f.actions && f.actions.studio) || []).find((a) => a.primary) || ((f.actions && f.actions.studio) || [])[0];
  return h('div', { class: 'preview-item', 'data-preview': 'studio' },
    h('div', { class: 'preview-head' }, h('span', null, 'Timmy Studio'), c ? h('span', { class: `state-word ${cls === 'is-live' ? 'is-live' : ''}` }, `${glyph} ${c.state}`) : null),
    h('p', { class: 'preview-words' }, c ? c.words : 'The frame does not say.'),
    // (R10 H167, H168's F3 and pattern 1 on the page: Studio opened by its name, its address the link's own; a step in words,
    // the command it copies for Timmy's terminal said on hover and when copied)
    h('div', { class: 'preview-actions' },
      s.state === 'running' && s.url ? h('a', { class: 'link-open', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: 'Opens Timmy Studio in a new tab, at its address on this computer' }, 'Open Studio') : null,
      step ? h('button', { type: 'button', class: 'btn-action tiny', 'data-copy': step.command, title: `Copies its command for Timmy’s terminal: ${step.command}` }, step.label) : null),
    h('p', { class: 'preview-note' }, s.openAtStart ? 'Opens when the workspace starts.' : 'Opens when asked.'));
}

// ── R6 lead (reference 01; the operator's R6 order: a requested preview is drawn, not described): Home's newest images ──
// The shown project's newest work, drawn: the newest run's first image (an output, or a file it changed, as the run detail's
// inspection draws it) and the newest VoxVision record's image (its annotated copy when the record has one it can show, else
// the observed file). Each is a thumbnail that shows it at size (panels.js TimmyEnlarge), with the action that opens it: the
// run in Workflows, the record in VoxVision. They are read with the page's token from the routes those tabs read: a run once
// (kept while it is the newest), the records list at most every 10 s while Home is on screen. Nothing is drawn of another
// project, and an image that cannot be read says why.
// R7 (H152; the R6 interaction review's N9: Home followed the newest run only, so after a run with no image the report run's
// image left Home): the newest images the project's records hold, whatever ran after: the newest run that holds an image (the
// companion looks back through the project's runs: GET /api/newest-run-image, asked again when the frame's newest run changes)
// and the newest VoxVision record that has an image it can show; each names its run or record and opens it.
// R8 lead (R7's open item D; the CI of PR #102 at 1dd6ec9, as at R7's b40fad3: Home's run image still said no newer run 20 s
// after one had ended): it was asked again only when the frame's newest run was another run, and never while an ask was out.
// So an answer read while the newest run still ran, or one that came back after the frame had moved on, stayed until another
// run began. Now `want` is what the frame shows (its newest run and that run's newest entry: its end asks again) and `key` what
// the image held was asked for; an ask that comes back to a frame that has moved on is followed by one more, for the newest.
// R9 lead (R7's item D a third time: the CI of PR #103 at 194ea7c, as R8's at 1dd6ec9): 20 s after a newer run that wrote no
// image had ended, Home's run image still did not say so, with nothing on the page changing any more. Whatever the answer read
// then (one read while the run's records were still being written: no newer run counted, or no image found), it stayed until
// the frame changed again, and an ask that never came back would have held every later one. Now, while Home is shown, the run
// image is asked again HOME_RUN_EVERY_MS after its last answer whatever the frame does (homeImagesDue, as the VoxVision image
// is), an ask that has not come back in HOME_RUN_ASK_MS is let go (said so; a late answer to it is not drawn), and an answer
// that could not be read is asked again on the next look.
const homeImages = { project: '', redraw: null, run: { key: null, want: null, item: null, asking: false, at: 0, seq: 0 }, vox: { key: '', item: null, asking: false, at: 0 } };
const HOME_VOX_EVERY_MS = 10_000;
const HOME_RUN_EVERY_MS = 10_000;
const HOME_RUN_ASK_MS = 20_000;
/** the most VoxVision records with images read for one look (newest first), when the newer ones' images cannot be shown */
const HOME_VOX_TRIES = 4;

function homeImagesReset(project) {
  if (homeImages.project === project) return;
  homeImages.project = project;
  homeImages.redraw = null;
  homeImages.run = { key: null, want: null, item: null, asking: false, at: 0, seq: homeImages.run.seq + 1 };
  homeImages.vox = { key: '', item: null, asking: false, at: 0 };
}

/** What the frame's newest run is, for Home's run image: the run, and its newest entry (the run's own later entries ask again). */
const homeRunKey = (run) => (run && run.operation ? [run.operation, run.tag || '', run.source || '', run.at || ''].join(' ') : '');

async function homeJson(url) {
  const r = await companion.fetch(url);
  const body = await r.json().catch(() => null);
  if (!body || body.ok !== true) throw new Error((body && body.error) || `the companion answered HTTP ${r.status}`);
  return body;
}

/** The newest run that holds an image: { op, path, src, words, newer } or { none: why }. */
async function homeRunImage(project) {
  const body = await homeJson(`/api/newest-run-image${project ? `?project=${encodeURIComponent(project)}` : ''}`);
  const im = body.image;
  // no run in the records yet: nothing to say beside Home's own "No image yet"
  if (!im) return body.looked ? { none: body.why || 'no run of this project holds an image Timmy can show' } : null;
  // R10 (H167; H168's F3 on the page): said in words, the file by its name; the run's id is its Open's (and that button's tip).
  // (Its name taken here, not by baseName: this part of the page runs on its own in tests/companion-home-images-ask.test.ts)
  return { op: im.op, path: im.path, src: im.src, newer: Number(im.newer) || 0, words: `run · ${String(im.path).split('/').pop()}${im.width && im.height ? ` · ${im.width} × ${im.height}` : ''}` };
}

/** The newest VoxVision record with an image it can show: { id, path, src, words, newer } or { none: why }, or null with no record. */
async function homeVoxImage(project) {
  const q = project ? `project=${encodeURIComponent(project)}` : '';
  const list = await homeJson(`/api/panel/voxvision/records${q ? `?${q}` : ''}`);
  const records = list.records || [];
  if (!records.length) return null;
  // the records newest first: those that observed no image are passed over (counted, and said beside the one shown)
  const withImages = records.filter((r) => r && r.counts && r.counts.images > 0);
  const first = withImages[0];
  if (!first) return { none: `none of its ${records.length === 1 ? 'one record' : `${records.length} records`} observed an image` };
  const newerThan = (id) => records.findIndex((r) => r.id === id);
  if (homeImages.vox.item && homeImages.vox.item.id === first.id && !homeImages.vox.item.none) return { ...homeImages.vox.item, newer: newerThan(first.id) };
  const why = [];
  for (const rec of withImages.slice(0, HOME_VOX_TRIES)) {
    const body = await homeJson(`/api/panel/voxvision/record?id=${encodeURIComponent(rec.id)}${q ? `&${q}` : ''}`);
    const images = (body.preview && body.preview.images) || [];
    const im = images.find((x) => x.servable && x.role === 'highlight') || images.find((x) => x.servable);
    if (!im) { why.push(`${rec.id}: none of its images can be shown (VoxVision says why)`); continue; }
    const r = await companion.fetch(`/api/panel/voxvision/file?id=${encodeURIComponent(rec.id)}&path=${encodeURIComponent(im.path)}${q ? `&${q}` : ''}`);
    if (!r.ok) {
      const b = await r.json().catch(() => null);
      why.push(`${rec.id}: ${(b && b.error) || `the companion answered HTTP ${r.status}`}`);
      continue;
    }
    const blob = await r.blob();
    const src = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('the image could not be read in the page'));
      fr.readAsDataURL(blob);
    });
    return { id: rec.id, path: im.path, src, newer: newerThan(rec.id), words: `VoxVision · ${rec.action} · ${String(im.path).split('/').pop()}` };
  }
  return { none: why.join('; ') || 'no image of its records can be shown' };
}

function homeFigure(kind, it) {
  if (!it) return null;
  if (it.none) return h('p', { class: 'preview-note', 'data-home-image': kind }, kind === 'run' ? `Runs: ${it.none}.` : `VoxVision: ${it.none}.`);
  // what ran after it, said beside it: the newest image is not always the newest work
  const newer = it.newer > 0 ? (kind === 'run'
    ? `the newest run that holds an image: ${it.newer} newer ${it.newer === 1 ? 'run holds' : 'runs hold'} none`
    : `the newest record with an image: ${it.newer} newer ${it.newer === 1 ? 'record observed' : 'records observed'} none it can show`) : '';
  return h('figure', { class: 'home-thumb', 'data-home-image': kind, 'data-newer': String(it.newer || 0) },
    h('button', { type: 'button', class: 'home-thumb-btn', 'data-enlarge': it.words, title: 'Show it at size' }, h('img', { src: it.src, alt: it.words })),
    h('figcaption', null, it.words),
    newer ? h('p', { class: 'home-thumb-note', 'data-home-newer': kind }, newer) : null,
    kind === 'run'
      ? h('button', { type: 'button', class: 'btn-action tiny', 'data-open-run': it.op, title: `operation ${it.op}` }, 'Open its run detail')
      : h('button', { type: 'button', class: 'btn-action tiny', 'data-open-vox': it.id, title: `record ${it.id}` }, 'Open it in VoxVision'));
}

function homeImagesItem(own) {
  const figs = own ? [homeFigure('run', homeImages.run.item), homeFigure('vox', homeImages.vox.item)].filter(Boolean) : [];
  const asking = homeImages.run.asking || homeImages.vox.asking;
  return h('div', { class: 'preview-item', 'data-preview': 'images' },
    h('div', { class: 'preview-head' }, h('span', null, 'The newest images')),
    figs.length ? h('div', { class: 'home-thumbs' }, ...figs)
      : h('p', { class: 'preview-words' }, !own ? 'Not shown: the frame is another project’s.' : asking ? 'Reading the newest run and VoxVision record…' : 'No image yet: a run that writes one, or a VoxVision record (/detect <image>), shows here.'));
}

/**
 * R8 lead (item D): asks for the newest run image when the frame shows another newest run, or another entry of it, than the
 * image held was asked for; one ask at a time, and when it comes back to a frame that has moved on, one more for the newest.
 * R9 lead: `again` asks for the frame shown now even when it was asked for (homeImagesDue, while Home is shown); an ask with no
 * answer in HOME_RUN_ASK_MS is let go, and an answer that could not be read leaves the image to be asked for again.
 */
function homeRunAsk(project, redraw, again = false) {
  const r = homeImages.run;
  if (r.asking || (!again && r.want === r.key)) return;
  const key = r.want;
  const seq = ++r.seq;
  r.asking = true;
  // this ask's answer is drawn only while it is the one out: not after the project changed, nor after it was let go
  const settle = (item, read) => {
    const run = homeImages.run;
    if (homeImages.project !== project || run.seq !== seq || !run.asking) return false;
    Object.assign(run, { key: read ? key : null, item, asking: false, at: Date.now() });
    return true;
  };
  // an answer read asks once more when the frame moved on meanwhile; one not read waits for the next look (a frame that
  // changes, or homeImagesDue), so a companion that keeps failing is not asked in a loop
  const after = (read) => { redraw(); if (read && homeImages.project === project) homeRunAsk(project, redraw); };
  const timer = setTimeout(() => { if (settle({ none: `not read: the companion gave no answer in ${HOME_RUN_ASK_MS / 1000} s` }, false)) after(false); }, HOME_RUN_ASK_MS);
  homeRunImage(project).then((item) => ({ item, read: true }), (e) => ({ item: { none: `not read: ${e && e.message ? e.message : String(e)}` }, read: false }))
    .then(({ item, read }) => { clearTimeout(timer); if (settle(item, read)) after(read); });
}

/**
 * R9 lead: while Home is shown (the page calls it every few seconds), the newest run image is asked for again
 * HOME_RUN_EVERY_MS after its last answer, for the frame shown now, so an answer read while a run's records were being written
 * does not stay when nothing on the page changes any more.
 */
function homeImagesDue() {
  const r = homeImages.run;
  if (!homeImages.redraw || r.asking || !r.at || Date.now() - r.at < HOME_RUN_EVERY_MS) return;
  homeRunAsk(homeImages.project, homeImages.redraw, true);
}

/** Reads what changed (a newer run, a newer record) and draws the item again when it is read. */
function homeImagesRefresh(f, own) {
  const project = shownProjectId();
  homeImagesReset(project);
  if (!own || !companion.token || companion.refused) return;
  const redraw = () => {
    if (homeImages.project !== project) return;
    const old = document.querySelector('#home-preview [data-preview="images"]');
    if (old) old.replaceWith(homeImagesItem(true));
  };
  homeImages.redraw = redraw;
  // asked again when the frame's newest run is another one (a new run may hold a newer image; one without leaves it), or that
  // run has a newer entry (an answer read while it ran may be another once it has ended)
  homeImages.run.want = homeRunKey(newestRunOf(f));
  homeRunAsk(project, redraw);
  if (!homeImages.vox.asking && Date.now() - homeImages.vox.at >= HOME_VOX_EVERY_MS) {
    homeImages.vox.asking = true;
    homeImages.vox.at = Date.now();
    homeVoxImage(project).then((it) => { if (homeImages.project === project) Object.assign(homeImages.vox, { key: it && it.id ? it.id : '', item: it, asking: false }); },
      (e) => { if (homeImages.project === project) Object.assign(homeImages.vox, { item: { none: `not read: ${e && e.message ? e.message : String(e)}` }, asking: false }); })
      .finally(redraw);
  }
}

function drawHome(f, own) {
  const box = document.getElementById('home-preview');
  if (!box) return;
  // R6 lead: the newest images first (reference 01 leads with the work itself), then Studio, the newest run, what runs
  const items = [homeImagesItem(own), studioItem(f)];
  homeImagesRefresh(f, own);
  const run = own ? newestRunOf(f) : null;
  items.push(h('div', { class: 'preview-item', 'data-preview': 'run' },
    h('div', { class: 'preview-head' }, h('span', null, 'The newest run'), run ? h('time', { class: 'ev-time', datetime: run.at }, clockOf(run.at)) : null),
    // (R10 H167, H168's F3 on the page: the run in words; its operation's id is its Open's tip)
    run ? h('p', { class: 'preview-words' }, h('span', { class: `ev-tag tone-${run.tone}` }, `[${run.tag}] `), eventWords(run.words) || run.words) : h('p', { class: 'preview-words' }, own ? 'Nothing has run in this project yet.' : 'Not shown: the frame is another project’s.'),
    run ? h('div', { class: 'preview-actions' }, h('button', { type: 'button', class: 'btn-action', 'data-open-run': run.operation, title: `operation ${run.operation}` }, 'Open its run detail')) : (unknownWhy(f, 'log') ? h('p', { class: 'preview-note' }, `The frame says: ${unknownWhy(f, 'log')}.`) : null)));
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

// ── R10 (H167): Home's recent work and the selected item's preview ──
// The journey's first screen in the browser (the R10 brief: "open Timmy and understand the project and the next action";
// "open a project artifact in the companion preview"; "inspect a run's progress, result and receipt without losing project
// context"), as the terminal Workbench's Home draws it, from the same functions (H164's src/journey, by its routes):
//   GET /api/journey/recent     the project's recent work, newest first, each with where it opens (openTarget)
//   GET /api/journey/run/<op>   a run's progress, result and receipt, each receipt verified on the companion's server now
//   GET /api/journey/open       what this page's own address asks for (?tab=home&file=…, run=…, vox=…), and a notice in
//                               words when that is not what is shown
// The selected item is drawn large beside the list: an image as its pixels (the run detail's or a VoxVision record's copy of
// it, the routes those tabs read: no new route), a run's progress, result and receipt, a mesh's format, a turn's question and
// route; under it the one way to open it where it belongs. Words only: ids, paths and addresses are under its Details. An
// image the companion has no copy of says so, and what would give it one.
const homeWork = { project: null, items: null, notes: [], why: '', asking: null, at: 0, sel: '', asked: undefined, notice: '', runs: new Map(), images: new Map() };
const HOME_WORK_EVERY_MS = 5000;
const HOME_RUN_AGAIN_MS = 3000;
const workKey = (it) => `${it.kind}:${it.id}`;
const baseName = (p) => String(p || '').split('/').pop();
/** words with each project path said by its file's name (the path is the Details') */
const pathsAsNames = (t) => String(t || '').replace(/(?:[\w.~-]+\/)+([\w.-]+)/g, '$1');
const WORK_KIND = { run: 'run', turn: 'chat', observation: 'VoxVision', result: 'result', reference: 'reference', mesh: 'mesh', recording: 'recording', receipt: 'receipt', draft: 'draft', card: 'card' };
const FILE_KIND = new Set(['result', 'reference', 'mesh', 'recording']);
/** what a file is, by its kind of content (the row says "reference · image") */
function fileWhat(p) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(p)) || [])[1]?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['stl', 'obj', 'ply', 'glb', 'gltf', 'usd', 'usda', 'usdz'].includes(ext)) return ext.toUpperCase();
  if (ext === 'step' || ext === 'stp') return 'STEP';
  if (ext === 'rrd') return 'Rerun';
  if (ext === 'md' || ext === 'markdown') return 'document';
  return ext ? 'text' : 'file';
}
const WORK_GLYPH = { answered: '✓', completed: '✓', saved: '◇', sealed: '✓', 'no change': '✓', failed: '✕', refused: '✕', running: '▶', 'waiting on you': '⚠', draft: '◌' };
function workAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'time not recorded';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? clockOf(iso).slice(0, 5) : dateTimeOf(iso).slice(0, 16);
}
/** two files of one name say their folders (the terminal's Home does the same) */
function workTitles(items) {
  const n = new Map();
  for (const it of items) if (FILE_KIND.has(it.kind)) n.set(baseName(it.id), (n.get(baseName(it.id)) || 0) + 1);
  return new Map(items.map((it) => {
    if (!FILE_KIND.has(it.kind)) return [workKey(it), pathsAsNames(it.title)];
    const name = baseName(it.id);
    const dir = String(it.id).split('/').slice(0, -1).join('/');
    return [workKey(it), n.get(name) > 1 && dir ? `${name} (in ${dir})` : name];
  }));
}

/** Reads the shown project's recent work (at most every HOME_WORK_EVERY_MS unless `force`), then draws Home's list and stage. */
function readHomeWork(force = false) {
  if (!companion.token || companion.refused) return;
  const project = shownProjectId();
  if (homeWork.project !== project) {
    Object.assign(homeWork, { project, items: null, notes: [], why: '', at: 0, sel: '' });
    homeWork.runs.clear();
    homeWork.images.clear();
  }
  if (homeWork.asked === undefined) readHomeAsked(project);
  if (homeWork.asking || (!force && Date.now() - homeWork.at < HOME_WORK_EVERY_MS)) return;
  homeWork.asking = (async () => {
    try {
      const body = await homeJson(`/api/journey/recent?limit=12${project ? `&project=${encodeURIComponent(project)}` : ''}`);
      if (homeWork.project !== project) return;
      homeWork.items = Array.isArray(body.items) ? body.items : [];
      homeWork.notes = Array.isArray(body.notes) ? body.notes : [];
      homeWork.why = '';
    } catch (e) {
      if (homeWork.project === project) homeWork.why = e && e.message ? e.message : String(e);
    } finally {
      homeWork.at = Date.now();
      homeWork.asking = null;
      drawHomeWork();
    }
  })();
}

/** What this page's own address asks Home to show (?tab=home&file=…, run=…): H164's GET /api/journey/open, once. */
function readHomeAsked(project) {
  homeWork.asked = null;
  if (companion.askedTab !== 'home' && !/[?&](?:file|vox|mesh|recording|receipt)=/.test(location.search)) return;
  const q = location.search.replace(/^\?/, '').split('&').filter((p) => p && !p.startsWith('project=')).join('&');
  if (!q) return;
  homeJson(`/api/journey/open?${q}${project ? `&project=${encodeURIComponent(project)}` : ''}`)
    .then((b) => { homeWork.asked = (b.asked && b.asked.select) || null; homeWork.notice = b.notice ? pathsAsNames(b.notice) : (b.asked && b.asked.problems && b.asked.problems[0] ? pathsAsNames(b.asked.problems[0]) : ''); })
    .catch((e) => { homeWork.notice = `What this page’s address asks for could not be read: ${e && e.message ? e.message : String(e)}.`; })
    .finally(() => drawHomeWork());
}

/** The item the address asked for, as one of the list's (a file by its path; a run, a record or a receipt by its id). */
function askedItem(items) {
  const a = homeWork.asked;
  if (!a) return null;
  const by = { file: (it) => FILE_KIND.has(it.kind) && it.id === a.value, run: (it) => it.kind === 'run' && it.id === a.value, vox: (it) => it.kind === 'observation' && it.id === a.value, mesh: (it) => it.kind === 'mesh' && it.id === a.value, recording: (it) => it.kind === 'recording' && it.id === a.value, receipt: (it) => it.receipt && it.receipt.id === a.value };
  const f = by[a.name];
  const found = f ? items.find(f) : null;
  if (found) return found;
  // a file of the project that is not among the newest: shown all the same (H164's open route said it is one)
  if (a.name === 'file' && !homeWork.notice) return { kind: 'reference', id: a.value, title: a.value, when: null, state: 'saved', receipt: null, fake: false, operation: null, open: { surface: 'companion', tab: 'home', select: a, query: '', path: '', preview: fileWhat(a.value) === 'image' ? 'image' : 'none', words: 'the companion’s preview' } };
  return null;
}

function selectedWork() {
  const items = homeWork.items || [];
  const asked = askedItem(items);
  if (!homeWork.sel && asked) homeWork.sel = workKey(asked);
  const it = items.find((x) => workKey(x) === homeWork.sel) || (asked && workKey(asked) === homeWork.sel ? asked : null) || items[0] || null;
  if (it) homeWork.sel = workKey(it);
  return it;
}

function drawHomeWork() {
  const list = document.getElementById('home-work');
  const stage = document.getElementById('home-stage');
  if (!list || !stage) return;
  const items = homeWork.items;
  const title = document.getElementById('home-work-title');
  if (title) title.textContent = items && homeWork.project !== null ? `Recent work · ${document.getElementById('project-name')?.textContent || 'this project'}` : 'Recent work';
  if (!items) {
    list.replaceChildren(h('li', { class: 'empty' }, homeWork.why ? `The project’s recent work could not be read: ${homeWork.why}.` : 'Reading the project’s recent work…'));
    if (!homeWork.why) stage.replaceChildren(h('p', { class: 'empty' }, 'Reading the project’s recent work…'));
    else stage.replaceChildren(h('p', { class: 'empty' }, 'Nothing to preview: the recent work could not be read.'));
    return;
  }
  const sel = selectedWork();
  const titles = workTitles(sel && !items.includes(sel) ? [...items, sel] : items);
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'empty work-empty' },
      h('strong', null, 'Nothing here yet. '),
      'No workflow run, chat turn or result is recorded in this project yet. The next step above writes your first message; Workflows runs a block.'));
  } else {
    const focused = document.activeElement === list;
    list.replaceChildren(...items.map((it) => {
      const on = sel && workKey(it) === workKey(sel);
      const glyph = WORK_GLYPH[it.state] || '·';
      const kind = FILE_KIND.has(it.kind) ? `${WORK_KIND[it.kind] || it.kind} · ${fileWhat(it.id)}` : `${WORK_KIND[it.kind] || it.kind} · ${it.state}`;
      return h('li', { class: `work-row${on ? ' is-selected' : ''}`, role: 'option', 'aria-selected': on ? 'true' : 'false', 'data-work': workKey(it), 'data-work-kind': it.kind, 'data-op': it.kind === 'run' ? it.id : null, id: `work-${workKey(it).replace(/[^A-Za-z0-9_-]/g, '_')}` },
        h('span', { class: `work-glyph ${it.state === 'failed' || it.state === 'refused' ? 'tone-failed' : it.state === 'waiting on you' ? 'waits' : 'tone-quiet'}`, 'aria-hidden': 'true' }, glyph),
        h('span', { class: 'work-title' }, `${it.fake ? 'FAKE · ' : ''}${titles.get(workKey(it)) || it.title}`),
        h('span', { class: 'work-kind' }, kind),
        h('time', { class: 'work-when', datetime: it.when || '' }, workAgo(it.when)));
    }));
    if (sel) list.setAttribute('aria-activedescendant', `work-${workKey(sel).replace(/[^A-Za-z0-9_-]/g, '_')}`);
    if (focused) list.focus({ preventScroll: true });
  }
  for (const n of homeWork.notes) list.append(h('li', { class: 'work-note' }, pathsAsNames(n)));
  drawStage(sel, sel ? titles.get(workKey(sel)) : '');
}

/** One fact of the stage: its name and its words. */
const stageFact = (k, ...v) => h('div', { class: 'stage-fact' }, h('span', { class: 'stage-k' }, k), h('span', { class: 'stage-v' }, ...v));

/** Where the selected item opens, as a button (one per stage: the primary is the strip's amber step, this a brighter neutral). */
function stageOpen(it) {
  const o = it.open || {};
  if (o.surface === 'studio') {
    const s = workspace.frame && workspace.frame.surfaces && workspace.frame.surfaces.studio;
    return s && s.state === 'running' && s.url
      ? h('a', { class: 'btn-action stage-open', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Studio: Accept or Discard it there')
      : h('p', { class: 'stage-note' }, 'It waits in Studio, on the project’s board, for Accept or Discard: Studio is not running now (the Workbench’s s starts it).');
  }
  const sel = o.select || {};
  const label = o.tab === 'workflows' ? 'Open its run detail' : o.tab === 'voxvision' ? 'Open it in VoxVision' : o.tab === 'create' ? 'Open it in 3D & Motion' : o.tab === 'chat' ? 'Open it in Chat & Intent' : o.tab === 'logs' ? 'Open it in Logs & Receipts' : null;
  if (!label) return null;
  return h('button', { type: 'button', class: 'btn-action stage-open', 'data-work-open': workKey(it), 'data-open-tab': o.tab, 'data-open-name': sel.name || '', 'data-open-value': sel.value || '' }, label);
}

function stageDetails(it) {
  const rows = [['Kind', it.kind], ['Id', it.id], ['Operation', it.operation || 'none'], ['Receipt', it.receipt ? `${it.receipt.id} ${it.receipt.verified ? '(verified on the companion’s server now)' : `(does not verify: ${it.receipt.why || 'not said'})`}` : 'none sealed'], ['When', it.when ? dateTimeOf(it.when) : 'not recorded'], ['Opens', it.open && it.open.path ? it.open.path : 'Studio, on the project’s board']];
  if (it.results && it.results.length) rows.push(['Results', it.results.join(', ')]);
  return h('details', { class: 'stage-details' }, h('summary', null, 'Details'), h('dl', null, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])));
}

function drawStage(it, title) {
  const stage = document.getElementById('home-stage');
  if (!stage) return;
  const head = document.getElementById('home-stage-title');
  if (!it) {
    if (head) head.textContent = 'Preview';
    stage.replaceChildren(h('p', { class: 'empty' }, (homeWork.items || []).length ? 'Choose an item of the recent work: it is drawn here.' : 'Nothing to preview yet: a run’s results, an image, a mesh or a chat turn shows here once the project has one.'),
      homeWork.notice ? h('p', { class: 'stage-notice', role: 'status' }, homeWork.notice) : null);
    return;
  }
  if (head) head.textContent = `Preview · ${it.fake ? 'FAKE · ' : ''}${title || it.title}`;
  const kids = [];
  if (homeWork.notice) kids.push(h('p', { class: 'stage-notice', role: 'status' }, homeWork.notice));
  if (it.kind === 'run') kids.push(...stageRun(it));
  // R10 (H167): a file of the project drawn as it is now (H164's GET /api/journey/file): an image, or a text's first lines
  else if (FILE_KIND.has(it.kind) && it.open && (it.open.preview === 'image' || it.open.preview === 'text')) kids.push(...stageFile(it));
  else if (it.kind === 'observation') kids.push(...stageImage(it));
  else if (it.kind === 'mesh' || it.kind === 'recording') kids.push(stageFact('What', `${WORK_KIND[it.kind]} · ${fileWhat(it.id)}`), h('p', { class: 'stage-note' }, it.kind === 'mesh' ? '3D & Motion draws its triangles, a view you can turn, and what Timmy’s own reader measured from the whole file.' : '3D & Motion says what Timmy can read of it: its entities and timelines.'));
  else if (it.kind === 'turn') {
    const r = it.route || {};
    kids.push(h('p', { class: 'stage-question' }, it.title));
    kids.push(stageFact('Answered by', `${r.fake ? 'FAKE ' : ''}${r.answeredBy || r.requested || 'not recorded'}${r.where ? ` · ${r.where}` : ''}${r.fallback ? ' · the last-resort fallback' : ''}`));
  } else kids.push(stageFact('What', `${WORK_KIND[it.kind] || it.kind} · ${it.state}`));
  if (it.kind !== 'run') kids.push(stageReceipt(it.receipt, it.kind === 'turn' || it.kind === 'observation'));
  kids.push(stageFact('When', it.when ? `${clockOf(it.when)} · ${workAgo(it.when)}` : 'not recorded'));
  const open = stageOpen(it);
  if (open) kids.push(h('div', { class: 'stage-actions' }, open));
  kids.push(stageDetails(it));
  // R10 (H167; the lead's B3 note): the item drawn (an image or a text) fills the box's height on the left, never more, and its
  // facts stand beside it, so its progress, result and receipt are in sight with it; a notice stays above both
  const drawn = kids.filter((k) => k instanceof Element && (k.classList.contains('stage-figure') || k.classList.contains('stage-text')));
  const notice = kids.filter((k) => k instanceof Element && k.classList.contains('stage-notice'));
  const rest = kids.filter((k) => !drawn.includes(k) && !notice.includes(k));
  stage.replaceChildren(...notice, ...(drawn.length ? [h('div', { class: 'stage-split' }, h('div', { class: 'stage-media' }, ...drawn), h('div', { class: 'stage-side' }, ...rest))] : rest));
}

function stageReceipt(r, expected) {
  if (!r) return stageFact('Receipt', expected ? 'none sealed for it yet' : 'none: a file is not sealed by itself (the run that wrote it is)');
  return r.verified
    ? stageFact('Receipt', h('span', { class: 'stage-verified is-verified' }, '✓ sealed and verified'), ' on the companion’s server now')
    : stageFact('Receipt', h('span', { class: 'tone-failed' }, `✕ sealed, not verified: ${r.why || 'not said'}`));
}

/** A run's progress, result and receipt (H164's runSummary, read on the companion's server), its first image drawn large. */
function stageRun(it) {
  const op = it.id;
  const held = homeWork.runs.get(op);
  if (!held || (!held.asking && held.answer && held.answer.ok && held.answer.run.progress.state === 'running' && Date.now() - held.at > HOME_RUN_AGAIN_MS)) askRun(op);
  const a = held && held.answer;
  if (!a) return [h('p', { class: 'stage-note' }, 'Reading its progress, result and receipt…')];
  if (!a.ok) return [h('p', { class: 'stage-note' }, `Its progress is not read: ${pathsAsNames(a.error || 'the companion did not say why')}.`)];
  const r = a.run;
  const out = [];
  const glyph = WORK_GLYPH[r.progress.state] || '·';
  out.push(stageFact('Progress', h('strong', { class: `stage-state tone-${r.progress.state === 'failed' ? 'failed' : 'quiet'}` }, `${glyph} ${r.progress.state}`), ` · ${pathsAsNames(r.progress.words)}`));
  const t = r.time || {};
  const ms = typeof t.ms === 'number' ? t.ms : (Date.parse(t.endedAt || '') - Date.parse(t.startedAt || ''));
  if (t.startedAt) out.push(stageFact('Time', `${clockOf(t.startedAt)}${t.endedAt ? ` to ${clockOf(t.endedAt)}` : ' · still running'}${Number.isFinite(ms) && ms >= 0 ? ` · ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}` : ''}`));
  const outputs = (r.result && r.result.outputs) || [];
  out.push(stageFact('Result', outputs.length ? `${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} written: ${outputs.slice(0, 4).map((o) => baseName(o.path)).join(', ')}${outputs.length > 4 ? `, ${outputs.length - 4} more` : ''}` : pathsAsNames(r.result.verdict || 'no file written')));
  out.push(stageReceipt(r.receipt ? { id: r.receipt.id, verified: r.receipt.verified, why: r.receipt.why } : null, true));
  const image = homeWork.images.get(`run:${op}`);
  if (image === undefined) askRunImage(op);
  else if (image && image.src) out.unshift(stageFigure(image.src, image.words));
  return out;
}

function askRun(op) {
  const held = homeWork.runs.get(op) || {};
  if (held.asking) return;
  const project = homeWork.project;
  homeWork.runs.set(op, { ...held, asking: true });
  homeJson(`/api/journey/run/${encodeURIComponent(op)}${project ? `?project=${encodeURIComponent(project)}` : ''}`)
    .then((b) => ({ ok: true, run: b.run }), (e) => ({ ok: false, error: e && e.message ? e.message : String(e) }))
    .then((answer) => { if (homeWork.project !== project) return; homeWork.runs.set(op, { answer, at: Date.now(), asking: false }); drawHomeWork(); });
}

/** The run detail's own copy of the first image the run wrote or changed (the route Workflows reads), or none. */
function askRunImage(op, path) {
  const key = path ? `file:${path}` : `run:${op}`;
  if (homeWork.images.has(key)) return;
  homeWork.images.set(key, null);
  const project = homeWork.project;
  companion.fetch(`/api/run/${encodeURIComponent(op)}${project ? `?project=${encodeURIComponent(project)}` : ''}`)
    .then((r) => r.json()).then((b) => {
      const list = (b && b.inspection && b.inspection.changes && b.inspection.changes.list) || [];
      const ch = list.find((x) => x && x.preview && x.preview.kind === 'image' && typeof x.preview.data === 'string' && x.preview.data.startsWith('data:image/') && (!path || x.path === path));
      if (homeWork.project !== project) return;
      homeWork.images.set(key, ch ? { src: ch.preview.data, words: `${baseName(ch.path)}${ch.preview.width && ch.preview.height ? ` · ${ch.preview.width} × ${ch.preview.height} px` : ''}`, w: ch.preview.width, h: ch.preview.height } : { none: path ? 'the run that wrote it holds no copy the page can draw' : '' });
      drawHomeWork();
    }, () => { if (homeWork.project === project) { homeWork.images.set(key, { none: 'the run’s detail could not be read' }); drawHomeWork(); } });
}

/** A VoxVision record's copy of an image (the newest record that observed `path`, or the record itself), or none. */
function askVoxImage(id, path) {
  const key = id ? `vox:${id}` : `file:${path}`;
  if (homeWork.images.has(key)) return;
  homeWork.images.set(key, null);
  const project = homeWork.project;
  const q = project ? `project=${encodeURIComponent(project)}` : '';
  (async () => {
    const records = id ? [{ id }] : ((await homeJson(`/api/panel/voxvision/records${q ? `?${q}` : ''}`)).records || []).filter((r) => r && r.counts && r.counts.images > 0).slice(0, HOME_VOX_TRIES);
    for (const rec of records) {
      const body = await homeJson(`/api/panel/voxvision/record?id=${encodeURIComponent(rec.id)}${q ? `&${q}` : ''}`);
      const images = (body.preview && body.preview.images) || [];
      const im = path ? images.find((x) => x.servable && x.path === path) : (images.find((x) => x.servable && x.role === 'highlight') || images.find((x) => x.servable));
      if (!im) continue;
      const r = await companion.fetch(`/api/panel/voxvision/file?id=${encodeURIComponent(rec.id)}&path=${encodeURIComponent(im.path)}${q ? `&${q}` : ''}`);
      if (!r.ok) continue;
      const blob = await r.blob();
      const src = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('not read')); fr.readAsDataURL(blob); });
      const measured = (body.preview && (body.preview.measures || body.preview.values)) || null;
      return { src, words: `${baseName(im.path)}${im.role === 'highlight' ? ' · as VoxVision marked it' : ''}`, by: rec.id, measured: Array.isArray(measured) ? measured.length : null, when: body.at || null };
    }
    return { none: id ? 'none of its images can be drawn here' : 'no VoxVision record has observed it, and no run wrote it' };
  })().then((v) => v, (e) => ({ none: `not read: ${e && e.message ? e.message : String(e)}` }))
    .then((v) => { if (homeWork.project !== project) return; homeWork.images.set(key, v); drawHomeWork(); });
}

function stageFigure(src, words) {
  return h('figure', { class: 'stage-figure' },
    h('button', { type: 'button', class: 'stage-img-btn', 'data-enlarge': words, title: 'Show it at size' }, h('img', { class: 'stage-img', src, alt: words })),
    h('figcaption', null, words));
}

/** An image: drawn from the copy a run's detail or a VoxVision record holds, with its pixel size and who observed it. */
function stageImage(it) {
  const out = [];
  let key;
  if (it.kind === 'observation') { key = `vox:${it.id}`; askVoxImage(it.id, null); }
  else if (it.operation && OPERATION_ID.test(it.operation)) { key = `file:${it.id}`; askRunImage(it.operation, it.id); }
  else { key = `file:${it.id}`; askVoxImage(null, it.id); }
  const im = homeWork.images.get(key);
  if (!im) out.push(h('p', { class: 'stage-note' }, 'Reading the image…'));
  else if (im.src) {
    out.push(stageFigure(im.src, im.words));
    if (im.by) out.push(stageFact('Observed', `by VoxVision${im.measured !== null && im.measured !== undefined ? ` · ${im.measured} values measured` : ''} (Open it in VoxVision for what was measured)`));
  } else out.push(h('p', { class: 'stage-note' }, `This page draws an image from a run’s detail or a VoxVision record; ${im.none}. VoxVision’s Detect in the terminal observes it.`));
  out.push(stageFact('What', `${WORK_KIND[it.kind] || it.kind} · ${it.kind === 'observation' ? 'an observation' : fileWhat(it.id)}`));
  return out;
}

/** The most of a text file's lines the stage shows (the companion sends its first 64 KB). */
const STAGE_TEXT_LINES = 60;

/**
 * R10 (H167): a project file as the companion reads it now (H164's GET /api/journey/file: an image as a data URL with its
 * pixel size, a text's first 64 KB, or why not in words), kept by its path until the project or the list moves on.
 */
function askFile(path) {
  const key = `now:${path}`;
  if (homeWork.images.has(key)) return;
  homeWork.images.set(key, null);
  const project = homeWork.project;
  companion.fetch(`/api/journey/file?${project ? `project=${encodeURIComponent(project)}&` : ''}path=${encodeURIComponent(path)}`)
    .then((r) => r.json().then((b) => b, () => null).then((b) => (b && typeof b === 'object' ? b : { ok: false, why: `the companion answered HTTP ${r.status}` })))
    .then((b) => b, (e) => ({ ok: false, why: `not read: ${e && e.message ? e.message : String(e)}` }))
    .then((b) => { if (homeWork.project !== project) return; homeWork.images.set(key, b); drawHomeWork(); });
}

/** A file of the project as it is now: its image drawn large, or its text's first lines; else the copy a run or a record keeps. */
function stageFile(it) {
  const now = homeWork.images.get(`now:${it.id}`);
  if (now === undefined) askFile(it.id);
  if (!now) return [h('p', { class: 'stage-note' }, 'Reading it…'), stageFact('What', `${WORK_KIND[it.kind] || it.kind} · ${fileWhat(it.id)}`)];
  const what = stageFact('What', `${WORK_KIND[it.kind] || it.kind} · ${fileWhat(it.id)}${typeof now.size === 'number' ? ` · ${humanSize(now.size)}` : ''}`);
  if (now.ok && now.kind === 'image' && typeof now.data === 'string' && now.data.startsWith('data:image/')) {
    return [stageFigure(now.data, `${baseName(it.id)} · ${now.width} × ${now.height} px · as the file is now`), what];
  }
  if (now.ok && now.kind === 'text' && typeof now.data === 'string') {
    const lines = now.data.split('\n');
    const shown = lines.slice(0, STAGE_TEXT_LINES);
    const more = lines.length - shown.length;
    return [h('pre', { class: 'stage-text', tabindex: '0', 'aria-label': `${baseName(it.id)}, its first lines` }, shown.join('\n')),
      h('p', { class: 'stage-note' }, `${baseName(it.id)} as the file is now${more > 0 || now.truncated ? ': its first lines (the whole file opens where it belongs)' : ''}`), what];
  }
  // not drawn from the file (too big, another type, a link…): an image is drawn from the copy its run or a record keeps
  const why = h('p', { class: 'stage-note' }, `Not read from the file itself: ${pathsAsNames(now.why || 'the companion did not say why')}.`);
  return it.open && it.open.preview === 'image' ? [why, ...stageImage(it)] : [why, what];
}

/** A size in bytes, in words. */
function humanSize(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Enter (or a click) on the stage's button: where the item belongs, on this page. */
function openWork(btn) {
  const tab = btn.dataset.openTab;
  const name = btn.dataset.openName;
  const value = btn.dataset.openValue;
  if (tab === 'workflows' && OPERATION_ID.test(value)) { showRun(value); return; }
  if (tab === 'voxvision' && value) { document.dispatchEvent(new CustomEvent('timmy:vox-show', { detail: { id: value } })); showWorkspaceTab('voxvision'); return; }
  if (tab === 'create' && value) { document.dispatchEvent(new CustomEvent('timmy:create-show', { detail: { [name]: value } })); showWorkspaceTab('create'); return; }
  if (tab) showWorkspaceTab(tab);
}

document.addEventListener('click', (e) => {
  const row = e.target instanceof Element ? e.target.closest('#home-work [data-work]') : null;
  if (row) { homeWork.sel = row.dataset.work; drawHomeWork(); return; }
  const open = e.target instanceof Element ? e.target.closest('[data-work-open]') : null;
  if (open) openWork(open);
});
document.addEventListener('keydown', (e) => {
  const list = document.getElementById('home-work');
  if (!list || document.activeElement !== list || !homeWork.items || !homeWork.items.length) return;
  const keys = homeWork.items.map(workKey);
  const at = Math.max(0, keys.indexOf(homeWork.sel));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : Math.max(0, Math.min(keys.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    homeWork.sel = keys[next];
    drawHomeWork();
    document.querySelector('#home-work [aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const btn = document.querySelector('#home-stage [data-work-open]');
    if (btn) { e.preventDefault(); openWork(btn); }
  }
});

// ── R10 (H167): the project's conversation, where it continues and the route its next turn takes ──
// R11 round 4: this page's Send is the project's conversation too (POST /api/chat/turn, H169); the conversation continues in
// the Workbench (2 Chat) or the REPL as well, and the mirror says the route its next turn takes there, as their top lines say it
// (H164's routeNow for the Workbench), FAKE where its model's name says so. Asked when the Chat tab is shown, at most every
// HOME_WORK_EVERY_MS.
const projectRoute = { at: 0, asking: false, route: null, why: '', hooked: false };
// R11 round 7 (the lead, H171's 16:48 finding): the mirror never keeps a refusal that only says the page had no session yet —
// the companion's 401 for a user-data read before the session is set (its words "…none was sent") is not the route's state.
// It is said as what it is, and the route is asked again the moment the shell's session arrives (TimmyShell 'session').
const ROUTE_NO_SESSION_YET = 'the page has no signed-in session yet';
function hookProjectRoute() {
  if (projectRoute.hooked || typeof TimmyShell === 'undefined' || !TimmyShell || typeof TimmyShell.on !== 'function') return;
  projectRoute.hooked = true;
  TimmyShell.on('session', (e) => {
    if (!e || !e.user) return;
    projectRoute.at = 0; projectRoute.route = null; projectRoute.why = '';
    if (workspace.tab === 'chat') readProjectRoute(); else drawProjectRoute();
  });
}
function readProjectRoute() {
  hookProjectRoute();
  if (!companion.token || companion.refused || projectRoute.asking || Date.now() - projectRoute.at < HOME_WORK_EVERY_MS) return;
  projectRoute.asking = true;
  homeJson('/api/journey/route?surface=workbench')
    .then((b) => { projectRoute.route = b.route || null; projectRoute.why = ''; }, (e) => {
      const words = e && e.message ? e.message : String(e);
      projectRoute.why = /none was sent|needs a signed-in|Sign in to continue/i.test(words) ? ROUTE_NO_SESSION_YET : words;
    })
    .finally(() => { projectRoute.asking = false; projectRoute.at = Date.now(); drawProjectRoute(); });
}
function drawProjectRoute() {
  const el = document.getElementById('mirror-route');
  if (!el) return;
  const r = projectRoute.route;
  if (!r) { el.textContent = projectRoute.why ? `The project’s route is not known here: ${projectRoute.why}.` : 'Asking the companion which route the project’s next turn takes…'; return; }
  const where = r.where === 'this computer' ? 'this computer' : r.where === 'another computer' ? 'another computer' : r.where === 'cloud' ? 'the cloud' : 'no place yet';
  const said = r.ready
    ? [h('span', null, 'The project’s conversation continues in the Workbench (2 Chat) or the REPL; its next turn goes to '), h('strong', null, `${r.fake ? 'FAKE ' : ''}${r.model}`), ` · ${where} · ${(r.price && r.price.words) || 'no price declared'}.`]
    : [h('span', null, `The project’s conversation has no route now: ${r.why || 'nothing would be sent'}.`)];
  el.replaceChildren(...said);
  el.title = r.words || '';
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
        // (R10 H167, H168's F3 on the page: what it does in words; the command it copies for Timmy's terminal under Details)
        kind === 'command' ? h('details', { class: 'act-row-more' }, h('summary', null, 'Details'), h('p', null, h('span', { class: 'cmd-label' }, 'its command, for Timmy’s terminal: '), h('button', { type: 'button', class: 'cmd', 'data-copy': a.command, title: 'Copies the command for Timmy’s terminal' }, a.command)))
          : h('p', { class: 'act-row-why' }, kind === 'tab' ? `Key ${a.command} opens it.` : `In Timmy’s terminal: ${a.command}.`),
        a.primary && a.effect ? h('p', { class: 'act-row-why' }, `effect: ${a.effect}`) : null,
        a.enabled === false ? h('p', { class: 'act-row-why' }, `not now: ${a.why || 'not available'}`) : null);
    }) : [h('p', { class: 'empty' }, own ? 'The frame gives this tab no actions.' : 'Not shown: the frame is another project’s.')]));
  }
}

// ── events, runs and the activity stream, newest first ──

/**
 * R10 (H167; H168's F3 on the page): an event's words as the activity stream says them: a job by what it ran (its id dropped),
 * a receipt as sealed, an operation's id left to its link's tip; Logs & Receipts (tab 0) keeps every event whole.
 */
const eventWords = (w) => String(w || '')
  .replace(/\bj[0-9a-f]{6}\b:? ?/g, '')
  .replace(/\breceipt [0-9a-f]{8}\b/g, 'receipt sealed')
  .replace(/\s*\(?\bo[0-9a-f]{8}\b\)?/g, '')
  .replace(/ {2,}/g, ' ').trim();

function eventItem(e, o = {}) {
  const tone = e.tone === 'live' ? 'is-live' : `tone-${e.tone}`;
  const glyph = e.tone === 'failure' ? '✕ ' : e.tone === 'live' ? '✓ ' : '';
  return h('li', { class: 'ev', 'data-tone': e.tone },
    h('time', { class: 'ev-time', datetime: e.at }, clockOf(e.at)),
    h('div', { class: 'ev-main' }, h('span', { class: `ev-tag ${tone}` }, `${glyph}[${e.tag}]`), o.plain ? eventWords(e.words) : e.words,
      e.operation ? h('button', { type: 'button', class: 'run-link ev-op', 'data-open-run': e.operation, title: `Opens run ${e.operation} in Workflows` }, o.plain ? (e.tag === 'chat' ? 'its record' : 'open the run') : e.operation) : null,
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
  // R10 (H167; the lead's note on the A2 captures, references 02 and 11): beside the conversation, its own events (its turns),
  // in words; every event is the activity stream's and Logs & Receipts'
  const turns = log.filter((e) => e.tag === 'chat');
  const chat = document.getElementById('chat-events');
  if (chat) chat.replaceChildren(...(turns.length ? turns.map((e) => eventItem(e, { plain: true })) : [own ? h('li', { class: 'empty' }, 'No chat turn of this project is sealed yet: a turn sent in the Workbench, the REPL or the monitor is listed once its receipt is sealed.') : emptyLog(f, own)]));
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
  if (list) list.replaceChildren(...(events.length ? events.map((e) => eventItem(e, { plain: true })) : [emptyLog(f, own)]));
}

function drawRuns(f, own) {
  const list = document.getElementById('flow-runs');
  const words = document.getElementById('flow-activity');
  const a = f.activity || { running: 0, waitingOnYou: 0, stopCurrent: { words: '' } };
  if (words) words.replaceChildren(`${a.running} running · `, h('span', { class: a.waitingOnYou > 0 ? 'waits' : '' }, `${a.waitingOnYou} waiting on you`));
  if (!list) return;
  const seen = new Set();
  const runs = (own ? (f.log || []) : []).filter((e) => e.operation && !seen.has(e.operation) && seen.add(e.operation));
  // R10 (H167; H168's F3 on the page): each run by what it did, in words; its operation's id is the button's tip
  list.replaceChildren(...(runs.length ? runs.map((e) => h('li', null, h('button', { type: 'button', class: 'run-pick', 'data-open-run': e.operation, 'aria-current': workspace.run === e.operation ? 'true' : 'false', title: `operation ${e.operation}` },
    h('span', { class: 'run-pick-words' }, eventWords(e.words) || e.words), h('time', { class: 'run-pick-time', datetime: e.at }, clockOf(e.at))))) : [emptyLog(f, own)]));
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
  if (workspace.run || document.querySelector('#run-detail .run-view, #run-detail .run-error')) {
    // R6 (H144): its boxes had no size while the tab was hidden: their "more below" cues are marked again now
    if (typeof rvMark === 'function') requestAnimationFrame(() => rvMark(document.getElementById('run-detail')));
    return;
  }
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
// R9 lead (item D): Home's newest run image asked again while Home is shown, whatever the frame does (homeImagesDue)
setInterval(() => { const home = document.getElementById('ws-home'); if (!document.hidden && home && !home.hidden) { homeImagesDue(); readHomeWork(); } }, WS_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) readFrame(); });

(() => {
  // the tab the address asks for (R6 lead: ?tab=<id>, or tab=<id> beside the token), else the one this browser tab showed
  // last (a run's address opens Workflows instead). R10 CHAT (H171; the operator's order of 2026-10-22: "Chat is selected
  // after setup and on subsequent launches"): Chat, when neither names one.
  let tab = 'chat';
  try { tab = sessionStorage.getItem(WS_TAB_KEY) || 'chat'; } catch (e) { tab = 'chat'; }
  if (companion.askedTab && document.querySelector(`#ws-tabs [data-ws-tab="${CSS.escape(companion.askedTab)}"]`)) tab = companion.askedTab;
  if (!/^\/run\//.test(location.pathname) && !companion.askedRun) showWorkspaceTab(document.querySelector(`#ws-tabs [data-ws-tab="${CSS.escape(tab)}"]`) ? tab : 'chat');
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
  // R7 (H152): or ?run=<operation id> (a Workbench's c on a run can name it): the same, on this page's own address
  if (!m && !companion.askedRun) return;
  let op = companion.askedRun;
  if (m) { try { op = decodeURIComponent(m[1]); } catch (e) { op = m[1]; } }
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
