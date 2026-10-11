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
// The model chat (the Streamdown island, /web/island/companion-chat.js) streams through this call and asks whether the page
// may ask; the token itself is not put on window.
window.timmyCompanion = {
  chat: (messages, on, signal) => companion.chat(messages, on, signal),
  ready: () => Boolean(companion.token) && !companion.refused,
};

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
    updateMirrorStatus('RESTORED');
  } else {
    updateMirrorStatus('WAITING');
  }
} catch (e) {
  activeChatHistory = [];
  updateMirrorStatus('WAITING');
}

// ── The chat mirror (tests/companion-client.test.ts runs this part of the file) ──
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
    saveActiveChat();
    renderConsoleLogs([]);
    updateMirrorStatus('WAITING');
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

    ws.send(JSON.stringify({ type: 'hello' }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendToLocalLogs('INFO', `Received WebSocket packet type: ${msg.type}`);

      if (msg.type === 'state' || msg.type === 'welcome') {
        appendToLocalLogs('INFO', `TUI State change: ${msg.state || 'idle'}`);
      } else if (msg.type === 'bus.tail' && Array.isArray(msg.events)) {
        // R4 (H84): the event bus, as it reached this page: the tail on connecting, then each event
        appendToLocalLogs('INFO', `Event bus: ${msg.events.length} recent event${msg.events.length === 1 ? '' : 's'}${msg.events.length ? `, latest ${String(msg.events[msg.events.length - 1].kind)}` : ''}`);
      } else if (msg.type === 'bus' && msg.event) {
        appendToLocalLogs('INFO', `Event bus: ${String(msg.event.kind)}`);
      } else if (msg.type === 'sync') {
        // Live broadcasts use data; the hello/reconnect snapshot uses history.
        const history = msg.data ?? msg.history;
        if (!Array.isArray(history) || !history.every(m => m && typeof m.role === 'string' && typeof m.content === 'string')) {
          throw new Error('Invalid chat sync: expected messages with role and text content');
        }
        activeChatHistory = history;
        saveActiveChat();
        if (!isViewingSaved) {
          renderConsoleLogs(activeChatHistory);
        }
        updateMirrorStatus(activeChatHistory.length > 0 ? 'LIVE' : 'WAITING');
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

function renderConsoleLogs(history) {
  if (history.length === 0) {
    consoleLogs.innerHTML = '<div class="mirror-empty">Waiting for session chat streams...</div>';
    return;
  }

  consoleLogs.innerHTML = history.map(msg => {
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
  }).join('');

  consoleLogs.scrollTop = consoleLogs.scrollHeight;

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
    default: break;
  }
});

// Carbonyl's launch command names this page's own address (its port is the one this companion took), without the token.
(() => {
  const btn = document.querySelector('[data-copy-carbonyl]');
  if (btn) btn.dataset.copy = `carbonyl ${location.origin}/`;
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
