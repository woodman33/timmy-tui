// timmy logs companion — live receipt/event viewer for headless mode.
// When TIMMY is driven via MCP or CLI (no TUI on screen), this zero-dep
// server auto-pops a localhost page that streams the SAME NDJSON event bus
// the TUI consumes, plus the receipt chain with a verify button.
// SSE tail of .timmy/runs/timmy-events.jsonl; no dependencies, no secrets.
//
// R4 (H84): it is this computer's own. It listens on 127.0.0.1 (no network mode: it is also the controller that stores, arms
// and launches plans). Every request first passes the local rule of Timmy's servers (src/utils/local-request.ts
// isLocalRequest: Host 127.0.0.1, localhost or [::1]; Origin, when a browser sends one, a page of this computer). "The token"
// is 32 random bytes this server makes when it starts: `timmy logs` prints and opens the address with it in the fragment
// (#t=…); each page keeps it in memory and sends it in an Authorization header (`Bearer <token>`), the event streams too
// (read with fetch: an EventSource cannot send a header). A token in an address is refused. The CLI also keeps it in
// <TIMMY_HOME>/state/logs-token-<port> (0600, with its pid) for this user's other programs: the browser companion's
// controller calls (Slate 3D's compile and store) and ensureLogCompanion, which opens the page. Never in a log.
//
//   route                                   requires                              why
//   GET /, /chat, /mission, /browser        nothing more                          the pages' code; without the token they show
//                                                                                 nothing and say how to open them from Timmy
//   GET /health                             nothing more; its folder with the     whether this is the log companion (and its port)
//                                           token (R4 H92: from ~, or by name)
//   GET /chat/page.js, /web/*               nothing more                          the chat mirror's token script and the companion's
//                                                                                 built web code (R4 H95; no content)
//   GET /chat/events, /events               the token                             the session's turns, receipts, the event bus
//   GET /receipts, /verify, /verify-receipt the token                             the receipt chain
//   GET /dispatch, /mission/escrows,        the token                             plans, escrows, a folder's theatre state
//       /mission/theatre
//   POST /mission/compile, /mission/store,  the token, and a peer on 127.0.0.1    writes plans (compile reads the checkout;
//        /mission/inspect, /dispatch/action                                       action arms, launches, holds, cancels)
//
// A refused request writes nothing (no plan, no companion.pair receipt) and says what to do.
//
// R4 (H87): it never dies on a request. Every route's reads (its page file, the chain, the bus, a plan, a folder's theatre
// state) are caught: a failure answers 500 with words (src/utils/server-failure.ts), no path of this computer, no stack,
// nothing logged, and the server keeps answering. The one file it reads beside its code, its chat page, is in
// LOGS_RUNTIME_FILES, which the build copies (scripts/copy-runtime-assets.mjs; r23: GET /chat crashed `timmy logs` in the
// installed package, whose dist/ had no chatpage.html).
//
// R4 (H95): every page it serves carries the strictest Content-Security-Policy it works under (logsPagePolicy): scripts
// only by this answer's nonce or from this server, no inline handler (the pages' buttons are wired by their own scripts),
// requests only to this server, no plugins, no <base>, no form posts, never framed; nosniff and no referrer. The chat
// mirror (/chat) draws with the companion's own Streamdown build (/web/, src/companion/web-assets.ts), not esm.sh.
import { createServer, ServerResponse, type IncomingMessage } from 'http';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { armPlan, dispatchPlan, dispatchContainerized, getPlan, pauseOrCancelLane, collectRun, createPlan, type DispatchPlan } from './dispatch.js';
import { composeUnifiedStage, stageHierarchy } from './usd-compiler.js';
import { merkleProofTree } from './agent-pass.js';
import { compileMissionMap, type MissionMapDoc } from './slate-compiler.js';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { readEvents, eventsPath, TimmyEvent } from './eventbus.js';
import { readChain, verifyChain, verifySignature, hashOf, appendReceipt } from './receipts.js';
import { listEscrows } from './escrow-engine.js';
import { theme } from '../tui/theme.js';
// R4 (H84): the local rule and the token (shared with Timmy Canvas and the browser companion).
import { dropTokenFile, isLocalRequest, LocalToken, logsTokenFile, readTokenFile, refuseRequest, TOKEN_IN_ADDRESS, writeTokenFile } from './local-request.js';
import { carriesSecret, writeLaunchPage } from './launch-page.js';
import { failRequest } from './server-failure.js';
import { tildePath } from './home-scrub.js';
import { sendWebFile } from '../companion/web-assets.js';

export const LOGS_PORT = (): number => Number(process.env.TIMMY_LOGS_PORT ?? 4310);

/**
 * R4 (H87): the files this server reads beside its code at run time, package-relative. The build copies each into dist/
 * (scripts/copy-runtime-assets.mjs RUNTIME_ASSETS; tests/runtime-pages.test.ts keeps the two lists together).
 */
export const LOGS_RUNTIME_FILES: readonly string[] = Object.freeze(['src/utils/chatpage.html']);

/**
 * R4 (H92; r23c, row 173: the page showed its working folder as an absolute path): the folder `timmy logs` works in, as its
 * page shows it: from ~ when it is a home folder or under one (src/utils/home-scrub.ts, as the board and /tools write
 * paths), else by its name. Never the whole path.
 */
export function folderWords(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const shown = tildePath(dir, env);
  if (shown.startsWith('~')) return shown;
  const name = dir.replace(/\/+$/, '').split('/').pop();
  return name || dir;
}

/** R4 (H87): what a request is told when what it needs could not be read. */
export const LOGS_FAILED = 'The log companion could not read what this request needs, so it answers with nothing and wrote nothing. It is still running: its other pages answer.';
export const LOGS_PAGE_FAILED = 'This page of the log companion could not be read (its file is missing from this installation, or unreadable), so it is not shown, and nothing was written. The log companion is still running: its other pages answer.';

/** R4 (H84): what a request without the token is told. */
export const LOGS_REFUSED = 'Refused: this needs the token of `timmy logs`. Open it from Timmy: `timmy logs` prints and opens its address with its token (after #, which the page keeps in memory and sends in a header).';
export const LOGS_FOREIGN = 'Refused: the log companion answers only to this computer (127.0.0.1 or localhost), and only from its own pages.';

/**
 * R4 (H84): the first lines of every page's script. The token comes from the page's fragment (#t=<64 hex>), which a browser
 * never sends to a server; it is taken out of the address at once and kept in this page's memory only (no storage, no
 * cookie). timmyFetch sends it in an Authorization header; timmyEvents reads an event stream with fetch (EventSource cannot
 * send a header) and stops for good once the token is refused; timmyLinks gives the other pages' links the token in their
 * fragment. Without the token a page fetches nothing and says how to open it from Timmy (#timmy-token-note).
 */
const PAGE_TOKEN_JS = `
var timmyToken = (function () {
  try {
    var m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (!m) return '';
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  } catch (e) { return ''; }
})();
var timmyStopped = false;
var TIMMY_OPEN = 'Open it from Timmy: \`timmy logs\` prints and opens its address with its token.';
function timmySay(words) {
  var note = document.getElementById('timmy-token-note');
  if (note) { note.textContent = words; note.hidden = false; }
}
function timmyRefused() {
  timmyStopped = true;
  timmySay(timmyToken
    ? 'This page\\u2019s token is not this log companion\\u2019s (it was started again, or the address was copied wrong), so it shows nothing. ' + TIMMY_OPEN
    : 'This page has no token from Timmy, so it shows nothing: the log companion answers only the address Timmy gives, which carries its token after #. ' + TIMMY_OPEN);
}
function timmyFetch(path, init) {
  if (!timmyToken || timmyStopped) { timmyRefused(); return Promise.reject(new Error('no token')); }
  var o = Object.assign({}, init || {});
  o.headers = Object.assign({}, o.headers || {}, { Authorization: 'Bearer ' + timmyToken });
  o.credentials = 'omit';
  o.cache = 'no-store';
  return fetch(path, o).then(function (r) { if (r.status === 401) timmyRefused(); return r; });
}
function timmyEvents(path) {
  var es = { onopen: null, onmessage: null, onerror: null };
  var wait = 1000;
  function again() { if (!timmyStopped) { setTimeout(open, wait); wait = Math.min(wait * 2, 15000); } }
  function open() {
    timmyFetch(path, { headers: { Accept: 'text/event-stream' } }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('events ' + r.status);
      wait = 1000;
      if (es.onopen) es.onopen();
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (c) {
          if (c.done) throw new Error('events ended');
          buf += dec.decode(c.value, { stream: true });
          var i;
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            var data = buf.slice(0, i).split('\\n').filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).replace(/^ /, ''); }).join('\\n');
            buf = buf.slice(i + 2);
            if (data && es.onmessage) { try { es.onmessage({ data: data }); } catch (e) { /* the page's own handler */ } }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () { if (es.onerror) es.onerror(); again(); });
  }
  open();
  return es;
}
function timmyLinks() {
  var links = document.querySelectorAll('a[data-timmy-page]');
  for (var i = 0; i < links.length; i++) links[i].href = links[i].getAttribute('data-timmy-page') + (timmyToken ? '#t=' + timmyToken : '');
}
if (!timmyToken) timmyRefused();
`;

/** R4 (H95): where each page's inline scripts carry this answer's nonce (replaced in every answer: sendPage). */
const NONCE = '__TIMMY_NONCE__';

/**
 * R4 (H95): each page's policy, as strict as it works under. `nonce`: this answer's (16 random bytes).
 *   /, /browser   their inline scripts by this nonce only (no inline handler: their buttons are wired by their scripts);
 *                 inline styles, for the theme colours their markup and the rows they write carry as style attributes (a
 *                 style can fetch nothing here: no image, font or request is allowed elsewhere); requests to this server.
 *   /mission      the same, and media from http(s) addresses: its video stem plays the address a person types there.
 *   /chat         scripts from this server only (its token script, /chat/page.js, and the Streamdown island, /web/), its
 *                 style block by this nonce (no inline style: Streamdown sets its styles through the DOM), images from
 *                 this server only.
 */
export function logsPagePolicy(nonce: string, page: '/' | '/mission' | '/browser' | '/chat'): string {
  const common = ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];
  if (page === '/chat') return ["default-src 'none'", "script-src 'self'", `style-src 'nonce-${nonce}'`, "img-src 'self'", "connect-src 'self'", ...common].join('; ');
  return ["default-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'unsafe-inline'", "connect-src 'self'", ...(page === '/mission' ? ['media-src http: https:'] : []), ...common].join('; ');
}

/** R4 (H95): a page with this answer's nonce in its inline scripts (and style block) and its policy. */
function sendPage(res: ServerResponse, html: string, page: '/' | '/mission' | '/browser' | '/chat'): void {
  const nonce = randomBytes(16).toString('base64');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', logsPagePolicy(nonce, page));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.end(html.split(NONCE).join(nonce));
}

/** R4 (H84): where a page says it has no token, or that its token was refused (theme colours only). */
const TOKEN_NOTE = `<p id="timmy-token-note" role="alert" hidden style="margin:8px 16px;padding:8px 12px;border:1px solid ${theme.warn};border-radius:6px;color:${theme.textPrimary};background:${theme.surfaceRaised}"></p>`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY :: LIVE LOGS</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid ${theme.surfaceRaised}; position: sticky; top: 0; background: ${theme.ground}; }
  header .logo { color: ${theme.accent}; font-weight: 700; letter-spacing: .08em; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: ${theme.danger}; }
  header .dot.on { background: ${theme.accent}; box-shadow: 0 0 8px ${theme.accent}88; }
  header .meta { color: ${theme.textMuted}; }
  header .right { margin-left: auto; display: flex; gap: 8px; }
  button { background: ${theme.surfaceRaised}; color: ${theme.accent}; border: 1px solid ${theme.line}; border-radius: 4px; font: inherit; padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: ${theme.accent}; }
  main { display: grid; grid-template-columns: 1.4fr 1fr; gap: 0; height: calc(100vh - 42px); }
  section { overflow-y: auto; padding: 12px 16px; }
  section + section { border-left: 1px solid ${theme.surfaceRaised}; }
  h2 { color: ${theme.accent}; font-size: 11px; letter-spacing: .18em; margin-bottom: 10px; }
  .empty { color: ${theme.textMuted}; margin-bottom: 10px; }
  .ev { display: flex; gap: 10px; padding: 2px 0; white-space: pre-wrap; word-break: break-word; }
  .ev .ts { color: ${theme.textMuted}; flex: 0 0 86px; }
  .ev .kind { flex: 0 0 150px; font-weight: 600; }
  .ev .pl { color: ${theme.textSecondary}; }
  .rc { border: 1px solid ${theme.surfaceRaised}; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: ${theme.ground}; }
  .rc .sub { color: ${theme.textPrimary}; }
  .rc .hash { color: ${theme.seal}; }
  .rc .prev { color: ${theme.textMuted}; }
  .rc .meta { color: ${theme.textMuted}; font-size: 11px; }
  #verify-out { color: ${theme.warn}; padding: 6px 16px; border-top: 1px solid ${theme.surfaceRaised}; }
</style></head><body>
<header>
  <span class="logo">TIMMY</span><span class="meta">:: LIVE LOGS</span>
  <span class="dot" id="dot"></span><span class="meta" id="conn">connecting…</span>
  <span class="meta" id="cwd"></span>
  <span class="meta"><a style="color:${theme.accent}" data-timmy-page="/mission">mission studio</a> · <a style="color:${theme.accent}" data-timmy-page="/browser">receipt browser</a> · <a style="color:${theme.accent}" data-timmy-page="/chat">chat mirror</a></span>
  <span class="right"><button id="verify">verify chain</button></span>
</header>
${TOKEN_NOTE}
<div id="verify-out"></div>
<main>
  <section><h2>EVENT BUS · LIVE</h2><p id="event-note" class="empty" role="status">No events received yet · waiting for this instance.</p><div id="events"></div></section>
  <section><h2>RECEIPT CHAIN · runs</h2><p id="chain-note" class="empty" role="status">Loading this store's receipt history…</p><div id="chain"></div></section>
</main>
<script nonce="${NONCE}">${PAGE_TOKEN_JS}
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const eventsEl = document.getElementById('events');
// Serialize server palette values; the browser has no imported theme module.
const eventPalette = ${JSON.stringify({ seal: theme.seal, danger: theme.danger, warn: theme.warn, accent: theme.accent, textSecondary: theme.textSecondary })};
const colors = KIND => KIND.includes('sealed') ? eventPalette.seal
  : KIND.includes('failed')||KIND.includes('broken') ? eventPalette.danger
  : KIND.includes('approval')||KIND.includes('gated') ? eventPalette.warn
  : KIND.includes('fusion')||KIND.includes('run') ? eventPalette.accent : eventPalette.textSecondary;
const maxEventRows = 200;
let eventCount = 0;
function addEvent(ev, scroll) {
  if (!ev || typeof ev.kind !== 'string' || !ev.kind || (ev.ts !== undefined && typeof ev.ts !== 'string')) throw new Error('unreadable event');
  const d = document.createElement('div'); d.className = 'ev';
  d.innerHTML = '<span class="ts">'+esc((ev.ts||'').slice(11,19))+'</span>'
    + '<span class="kind" style="color:'+colors(ev.kind)+'">'+esc(ev.kind)+'</span>'
    + '<span class="pl">'+esc(JSON.stringify(ev.payload||{}).slice(0,220))+'</span>';
  eventsEl.appendChild(d);
  eventCount++;
  while (eventsEl.children.length > maxEventRows) eventsEl.removeChild(eventsEl.firstElementChild);
  document.getElementById('event-note').textContent = eventCount > maxEventRows
    ? 'Showing last '+maxEventRows+' events · older rows omitted.' : eventCount+' events received.';
  if (scroll) eventsEl.parentElement.scrollTop = eventsEl.parentElement.scrollHeight;
}
function loadChain() {
  timmyFetch('/receipts?stream=runs').then(r=> { if (!r.ok) throw new Error('receipt request failed'); return r.json(); }).then(list => {
    if (!Array.isArray(list)) throw new Error('unreadable receipt history');
    const el = document.getElementById('chain');
    el.innerHTML = list.slice(-25).reverse().map(r =>
      '<div class="rc"><div class="sub">'+esc(r.subject||r.kind||'')+'</div>'
      + '<div><span class="hash">hash '+esc(String(r.hash||'').slice(0,18))+'…</span> '
      + '<span class="prev">prev '+esc(String(r.prev_hash||'').slice(0,18))+'…</span></div>'
      + '<div class="meta">'+esc(r.policy||'')+' · '+esc(String(r.ts||r.created_at||'').slice(11,19))+'</div></div>'
    ).join('');
    document.getElementById('chain-note').textContent = list.length
      ? 'Showing '+Math.min(list.length,25)+' of '+list.length+' receipts · use verify chain to check integrity.' : 'No receipts in this store yet.';
  }).catch(()=> { document.getElementById('chain-note').textContent = 'Receipt history unavailable · retrying when a receipt arrives.'; });
}
document.getElementById('verify').onclick = () => {
  timmyFetch('/verify?stream=runs').then(r=> { if (!r.ok) throw new Error('verification request failed'); return r.json(); }).then(v => {
    document.getElementById('verify-out').textContent = v.ok
      ? '✓ chain intact · '+v.count+' receipts · ed25519 signed · hash-linked'
      : '× chain BROKEN at '+(v.brokenAt||'?');
  }).catch(()=> { document.getElementById('verify-out').textContent = 'Chain verification unavailable · try again.'; });
};
timmyLinks();
// R4 (H84): with the token only: the event stream (fetch, with the token in a header), the folder and the chain
if (timmyToken) {
  const es = timmyEvents('/events');
  es.onopen = () => { document.getElementById('dot').className = 'dot on'; document.getElementById('conn').textContent = 'live'; };
  es.onerror = () => { document.getElementById('dot').className = 'dot'; document.getElementById('conn').textContent = timmyStopped ? 'needs its token' : 'reconnecting…'; };
  es.onmessage = m => {
    try { const ev = JSON.parse(m.data); addEvent(ev, true); if (ev.kind === 'receipt.sealed') loadChain(); }
    catch { document.getElementById('event-note').textContent = 'Skipped an unreadable event · waiting for the next event.'; }
  };
  timmyFetch('/health').then(r=>r.json()).then(h => { document.getElementById('cwd').textContent = typeof h.folder === 'string' ? h.folder : 'workspace unavailable'; }).catch(()=> { document.getElementById('cwd').textContent = 'workspace unavailable'; });
  loadChain();
} else {
  document.getElementById('conn').textContent = 'needs its token';
  document.getElementById('event-note').textContent = 'Nothing shown: this page has no token.';
  document.getElementById('chain-note').textContent = 'Nothing shown: this page has no token.';
}
</script></body></html>`;

// ---- Command Post survey column (same controller, allowlisted actions) ----
export const isLocalIp = (ip: string): boolean =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

const listPlans = () => {
  const dir = join(process.cwd(), '.timmy', 'dispatch');
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return {
        id: s.id, lifecycle: s.lifecycle, plan_hash: s.plan_hash,
        harness: (s.plan?.harnesses ?? []).join(','), objective: (s.plan?.objective ?? '').slice(0, 60),
        blocked: s.blocked ?? null
      };
    });
  } catch { return []; }
};

// Mission Studio: survey surface for the Mission Map compiler + frame-accurate
// playback of compiled mission stages. Compiles only — launching stays with
// the controller (plan_dispatch → approve → dispatch). The Bézier sampler
// MIRRORS src/utils/theatre-runtime.ts (same bisection math, deterministic);
// bundler-based studios load the identical state via @theatre/core.
const MISSION_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY :: MISSION STUDIO</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 16px; }
  h1 { color: ${theme.accent}; font-size: 14px; letter-spacing: .12em; margin-bottom: 10px; }
  h2 { color: ${theme.accent}; font-size: 11px; letter-spacing: .18em; margin: 14px 0 6px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  textarea { flex: 1; min-width: 320px; background: ${theme.surfaceRaised}; color: ${theme.textPrimary}; border: 1px solid ${theme.line}; border-radius: 6px; padding: 8px; font: inherit; height: 170px; }
  button { background: ${theme.surfaceRaised}; border: 1px solid ${theme.accent}; color: ${theme.accent}; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: ${theme.accent}; color: ${theme.accent}; }
  input { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.textPrimary}; border-radius: 6px; padding: 6px 8px; font: inherit; }
  .plan { border: 1px solid ${theme.line}; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; background: ${theme.surfaceRaised}; }
  .plan .obj { font-weight: 600; }
  .plan .meta { color: ${theme.textSecondary}; font-size: 11px; }
  .plan .hash { color: ${theme.textPrimary}; }
  .err { color: ${theme.danger}; margin: 6px 0; }
  #stage { width: 260px; height: 130px; border: 1px solid ${theme.line}; background: ${theme.surfaceRaised}; position: relative; margin: 8px 0; }
  #actor { position: absolute; left: 20px; top: 50px; width: 24px; height: 24px; background: ${theme.accent}; border-radius: 4px; }
  #clock { color: ${theme.warn}; }
  .note { color: ${theme.textMuted}; font-size: 11px; }
</style></head><body>
<h1>TIMMY :: MISSION STUDIO · compile + playback</h1>
${TOKEN_NOTE}

<h2>1 · MISSION MAP → CUE PLANS (timmy_mission_compile)</h2>
<div class="row"><textarea id="doc" spellcheck="false"></textarea></div>
<div class="row" style="margin-top:8px">
  <button data-run="compile">compile</button>
  <span class="note">compiles only — launch stays with the controller: timmy_plan_dispatch → timmy approve → timmy_dispatch_plan</span>
</div>
<div id="plans"></div>

<h2>2 · THEATRE PLAYBACK (frame-accurate · 30fps timebase)</h2>
<div class="row">
  <input id="folder" value="studio/timmy-sting-5s" size="34">
  <button data-run="loadState">load state</button>
  <button data-run="play">play</button>
  <button data-run="stop">stop</button>
</div>
<div id="stage"><div id="actor"></div></div>
<div id="clock">t=0.000</div>
<div id="stateNote" class="note">no state loaded — compiled folders carry theatre-state.json (theatre-runtime saveTheatreState)</div>

<h2>3 · VIDEO STEM (W3C media fragments — same addressing as the EDL)</h2>
<div class="row">
  <input id="vsrc" placeholder="media url" size="40">
  <input id="vin" type="number" value="0" step="0.1" style="width:70px">
  <input id="vout" type="number" value="5" step="0.1" style="width:70px">
  <button data-run="playVid">play fragment</button>
</div>
<video id="vid" controls style="max-width:480px;width:100%;margin-top:8px;border:1px solid ${theme.line}"></video>

<h2>4 · LIVE MISSION TELEMETRY (container runs · event-bus SSE)</h2>
<div style="max-height:180px;overflow-y:auto;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised}">
  <pre id="telelog" style="padding:8px;color:${theme.textSecondary};font:inherit;white-space:pre-wrap">no live run yet — arm + launch an openhands/docker plan above</pre>
</div>

<h2>5 · INSPECTORS (Merkle proof tree · USD stage hierarchy)</h2>
<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:280px">
    <h3 style="color:${theme.seal}">Merkle proof</h3>
    <textarea id="passjson" rows="4" style="width:100%;background:${theme.surfaceRaised};color:${theme.textSecondary};border:1px solid ${theme.line};border-radius:6px;font:inherit">paste AgentPass JSON</textarea>
    <button id="btnmerkle">inspect merkle</button>
  </div>
  <div style="flex:1;min-width:280px">
    <h3 style="color:${theme.accent}">USD stage</h3>
    <textarea id="scenejson" rows="4" style="width:100%;background:${theme.surfaceRaised};color:${theme.textSecondary};border:1px solid ${theme.line};border-radius:6px;font:inherit">paste UsdScene JSON</textarea>
    <button id="btnstage">inspect stage</button>
  </div>
</div>
<pre id="insp" style="max-height:240px;overflow-y:auto;padding:8px;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised};color:${theme.textSecondary};font:inherit;white-space:pre-wrap"></pre>

<h2>6 · ESCROW LEDGER (live locks · refunds · slashes)</h2>
<pre id="escrows" style="max-height:160px;overflow-y:auto;padding:8px;border:1px solid ${theme.line};border-radius:6px;background:${theme.surfaceRaised};color:${theme.textSecondary};font:inherit;white-space:pre-wrap">no escrows yet</pre>

<script nonce="${NONCE}">${PAGE_TOKEN_JS}
async function refreshEscrows() {
  const r = await (await timmyFetch('/mission/escrows')).json();
  const box = document.getElementById('escrows');
  if (!r.ok || !r.escrows.length) { box.textContent = 'no escrows yet — arm one via the escrow engine'; return; }
  box.textContent = r.escrows.map(e =>
    e.escrow_id + ' · ' + e.state + ' · ceiling ' + e.ceiling_usd + ' · drawn ' + e.drawn_usd +
    (e.refund_usd != null ? ' · refund ' + e.refund_usd : '') +
    (e.qa_value != null ? ' · qa ' + e.qa_value : '') +
    (e.merkle_root ? ' · merkle ' + e.merkle_root : '')).join('\\n');
}
// R4 (H84): with the token only (the stream is read with fetch, the token in a header)
if (timmyToken) {
  timmyEvents('/events').onmessage = m => {
    const e = JSON.parse(m.data);
    if (String(e.kind).startsWith('escrow.')) refreshEscrows();
  };
  refreshEscrows().catch(() => {});
}
async function inspectKind(kind) {
  const out = document.getElementById('insp');
  try {
    const body = kind === 'merkle'
      ? { kind, pass: JSON.parse(document.getElementById('passjson').value) }
      : { kind, scene: JSON.parse(document.getElementById('scenejson').value) };
    const r = await (await timmyFetch('/mission/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    out.textContent = JSON.stringify(r, null, 2);
  } catch (e) { out.textContent = 'parse error: ' + e; }
}
document.getElementById('btnmerkle').onclick = () => inspectKind('merkle');
document.getElementById('btnstage').onclick = () => inspectKind('stage');
// R4 (H95): the page's buttons, wired here (its policy runs no inline handler)
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button') : null;
  if (!b) return;
  const run = { compile, loadState, play, stop, playVid }[b.dataset.run];
  if (run) run();
  else if (b.dataset.store !== undefined) storePlan(Number(b.dataset.store));
  else if (b.dataset.arm !== undefined) armLaunch(Number(b.dataset.arm));
});
const DEFAULT_DOC = {
  nodes: [
    { id: 'sting', kind: 'capsule', objective: 'render the 5s sting', copies: 1 },
    { id: 'stingHarness', kind: 'harness', harness: 'hyperframes' },
    { id: 'fix', kind: 'capsule', objective: 'sandboxed patch pass' },
    { id: 'fixHarness', kind: 'harness', harness: 'openhands', workspace: 'docker' },
    { id: 'fixGate', kind: 'gate', approval: 'manual', acceptance: ['npm test'] },
    { id: 'stingOut', kind: 'artifact', path: 'package.json' }
  ],
  edges: [
    { from: 'stingHarness', to: 'sting', kind: 'harness' },
    { from: 'fixHarness', to: 'fix', kind: 'harness' },
    { from: 'fixGate', to: 'fix', kind: 'gate' },
    { from: 'stingOut', to: 'fix', kind: 'artifact' },
    { from: 'sting', to: 'fix', kind: 'depends' }
  ]
};
document.getElementById('doc').value = JSON.stringify(DEFAULT_DOC, null, 2);

async function compile() {
  const out = document.getElementById('plans');
  out.innerHTML = '';
  let r;
  try {
    const res = await timmyFetch('/mission/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: JSON.parse(document.getElementById('doc').value) }) });
    r = await res.json();
  } catch (e) { out.innerHTML = '<div class="err">compile failed: ' + String(e) + '</div>'; return; }
  for (const e of r.errors ?? []) out.innerHTML += '<div class="err">× ' + e + '</div>';
  PLANS = r.plans ?? [];
  PLANS.forEach((p, i) => {
    out.innerHTML += '<div class="plan"><div class="obj">' + p.plan.objective + '</div>'
      + '<div class="meta">node ' + p.node_id + ' · harness ' + p.plan.harnesses[0] + ' · workspace ' + p.plan.workspace.kind
      + ' · depends_on [' + (p.plan.cadence.depends_on || []).join(', ') + '] · approval ' + p.plan.approval.mode
      + ' · manifest ' + (p.plan.context_manifest || []).map(m => m.path + '@' + m.sha256.slice(0, 8) + '…').join(' ') + '</div>'
      + '<div class="meta" style="margin-top:6px"><button data-store="' + i + '">send to controller</button> <span id="gw-' + i + '"></span></div></div>';
  });
  if (!PLANS.length && !(r.errors ?? []).length) out.innerHTML = '<div class="err">no capsules in doc</div>';
}

// Arming gateway: the companion only EMITS hash-bound requests; the
// controller validates the operator token and alone executes (J-BANG).
let PLANS = [];
async function storePlan(i) {
  const el = document.getElementById('gw-' + i);
  const res = await timmyFetch('/mission/store', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: PLANS[i].plan }) });
  const r = await res.json();
  if (!r.ok) { el.innerHTML = '<span class="err">× ' + (r.note ?? 'rejected') + '</span>'; return; }
  el.dataset.id = r.id;
  el.innerHTML = 'stored ' + r.id + ' · hash <span class="hash">' + r.plan_hash + '</span> '
    + '<input id="tok-' + i + '" placeholder="operator token (timmy approve …)" size="26"> '
    + '<button data-arm="' + i + '">arm + launch</button> <span id="al-' + i + '"></span>';
}
async function armLaunch(i) {
  const el = document.getElementById('gw-' + i);
  const out = document.getElementById('al-' + i);
  const id = el.dataset.id;
  const token = (document.getElementById('tok-' + i) || {}).value ?? '';
  const a = await timmyFetch('/dispatch/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'arm', token }) });
  const ar = await a.json();
  if (!ar.ok) { out.innerHTML = '<span class="err">arm denied: ' + (ar.note ?? '?') + '</span>'; return; }
  const l = await timmyFetch('/dispatch/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'launch' }) });
  const lr = await l.json();
  out.innerHTML = lr.ok ? '<span class="hash">J-BANG! launched ' + (lr.session ?? id) + '</span>' : '<span class="err">launch refused: ' + (lr.note ?? '?') + '</span>';
  if (lr.ok && lr.container) { streamTelemetry(id); out.innerHTML += ' <span class="note">· containerized · telemetry below</span>'; }
}

// Real-time telemetry: the SAME NDJSON event bus the TUI consumes, filtered
// to the launched plan. Read-only — the companion still never executes.
// Hardened (v0.7.7): bounded ring buffer (oldest lines dropped), autoscroll
// only while pinned to the tail, and drop-recovery — on reconnect the /events
// replay refills a cleared buffer so a dropped connection never reads as
// silence.
const TELE_CAP = 200;
let TELE_ID = null, TELE_ES = null, TELE_LINES = [], TELE_DROP = false;
function teleRender() {
  const box = document.getElementById('telelog').parentElement;
  const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  document.getElementById('telelog').textContent = TELE_LINES.join('\\n') + (TELE_LINES.length ? '\\n' : '');
  if (pinned) box.scrollTop = box.scrollHeight;
}
function telePush(line) {
  TELE_LINES.push(line);
  if (TELE_LINES.length > TELE_CAP) TELE_LINES.splice(0, TELE_LINES.length - TELE_CAP);
  teleRender();
}
function streamTelemetry(id) {
  TELE_ID = id;
  TELE_LINES = [];
  document.getElementById('telelog').textContent = '';
  if (!TELE_ES) {
    TELE_ES = timmyEvents('/events');
    TELE_ES.onopen = () => {
      if (TELE_DROP) { TELE_LINES = []; telePush('sse.reconnected · replaying event tail'); TELE_DROP = false; }
    };
    TELE_ES.onerror = () => { TELE_DROP = true; telePush('sse.connection-dropped · reconnecting…'); };
    TELE_ES.onmessage = m => {
      const e = JSON.parse(m.data); const p = e.payload || {};
      if (!TELE_ID || p.plan_id !== TELE_ID) return;
      telePush(e.kind + (p.line ? ' · ' + p.line : (p.note ? ' · ' + p.note : (p.receipt ? ' · receipt ' + String(p.receipt).slice(0, 18) + '…' : ''))));
    };
  }
}

// cubic-bézier sampler — MIRROR of src/utils/theatre-runtime.ts bezierSample
function bez(h, x) {
  const [x1, y1, x2, y2] = h;
  const cx = u => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const cy = u => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  const t = Math.min(1, Math.max(0, x));
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (cx(m) < t) lo = m; else hi = m; }
  return cy((lo + hi) / 2);
}
function sampleKfs(kfs, t) {
  if (!kfs.length) return 0;
  if (t <= kfs[0].position) return kfs[0].value;
  if (t >= kfs[kfs.length - 1].position) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.position && t <= b.position) {
      if (typeof a.value === 'string' || typeof b.value === 'string') return a.value;
      const span = b.position - a.position;
      const x = span <= 0 ? 1 : (t - a.position) / span;
      return a.value + (b.value - a.value) * bez(a.interpolation.config.handles, x);
    }
  }
  return kfs[kfs.length - 1].value;
}
let STATE = null, RAF = 0, T0 = 0, LEN = 5;
async function loadState() {
  const note = document.getElementById('stateNote');
  const res = await timmyFetch('/mission/theatre?folder=' + encodeURIComponent(document.getElementById('folder').value));
  const s = await res.json();
  if (!s.sheets) { note.textContent = 'no theatre state in that folder (save one via theatre-runtime)'; STATE = null; return; }
  STATE = s;
  const sheet = Object.values(s.sheets)[0];
  LEN = sheet.sequence.length;
  note.textContent = 'loaded definition ' + s.definitionVersion + ' · ' + Object.keys(s.sheets)[0] + ' · ' + Object.keys(sheet.sequence.tracks).length + ' tracks · ' + LEN + 's';
}
function apply(t) {
  const actor = document.getElementById('actor');
  let x = 0, y = 0, sc = 1;
  if (STATE) {
    const sheet = Object.values(STATE.sheets)[0];
    for (const [key, tr] of Object.entries(sheet.sequence.tracks)) {
      const v = sampleKfs(tr.keyframes, t);
      if (typeof v !== 'number') continue;
      if (key.endsWith('.position.x')) x = v;
      else if (key.endsWith('.y')) y = v;
      else if (key.endsWith('.scale')) sc = v;
    }
  }
  actor.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + sc + ')';
  document.getElementById('clock').textContent = 't=' + t.toFixed(3) + ' / ' + LEN.toFixed(3);
}
function play() { stop(); T0 = performance.now(); const tick = () => { apply(((performance.now() - T0) / 1000) % LEN); RAF = requestAnimationFrame(tick); }; RAF = requestAnimationFrame(tick); }
function stop() { cancelAnimationFrame(RAF); }
function playVid() {
  const v = document.getElementById('vid');
  v.src = document.getElementById('vsrc').value + '#t=' + document.getElementById('vin').value + ',' + document.getElementById('vout').value;
  v.play();
}
</script></body></html>`;

const DISPATCH_HTML = `
<div style="border-top:1px solid ${theme.surfaceRaised};padding:12px 16px">
  <h2>DISPATCH · COMMAND POST</h2>
  <div id="plans" style="display:flex;flex-direction:column;gap:6px"></div>
</div>
<script nonce="${NONCE}">
// R4 (H95): a plan's id in an attribute; its buttons wired here (the page's policy runs no inline handler)
const planAttr = (v) => String(v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button[data-act][data-plan]') : null;
  if (b) act(b.dataset.plan, b.dataset.act);
});
async function act(id, action) {
  let token;
  if (action === 'arm') { token = prompt('operator approval token (timmy approve <planHash>):'); if (!token) return; }
  const r = await timmyFetch('/dispatch/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, token }) });
  const j = await r.json();
  alert(JSON.stringify(j).slice(0, 300));
  loadPlans();
}
async function loadPlans() {
  const r = await timmyFetch('/dispatch');
  const plans = await r.json();
  document.getElementById('plans').innerHTML = plans.length ? plans.map(p =>
    '<div style="border:1px solid ${theme.surfaceRaised};border-radius:6px;padding:6px 10px;background:${theme.ground}">'
    + '<span style="color:${theme.accent}">' + p.id + '</span> '
    + '<span style="color:${theme.accent}">' + p.lifecycle + '</span> '
    + '<span style="color:${theme.textSecondary}">' + p.harness + ' · ' + p.objective + '</span> '
    + '<span style="color:${theme.textMuted}">hash ' + (p.plan_hash || '').slice(0, 12) + '…</span>'
    + (p.blocked ? ' <span style="color:${theme.danger}">' + p.blocked.state + ': ' + p.blocked.note + '</span>' : '')
    + ' <button data-act="arm" data-plan="' + planAttr(p.id) + '">arm</button>'
    + ' <button data-act="launch" data-plan="' + planAttr(p.id) + '">launch</button>'
    + ' <button data-act="hold" data-plan="' + planAttr(p.id) + '">hold</button>'
    + ' <button data-act="cancel" data-plan="' + planAttr(p.id) + '">cancel</button>'
    + ' <button data-act="collect" data-plan="' + planAttr(p.id) + '">collect</button>'
    + '</div>').join('') : '<div style="color:${theme.textMuted}">no plans — prepare one from chat (ctrl+d rail) or timmy_plan_dispatch</div>';
}
// R4 (H84): with the token only; a refused token stops the polling
if (timmyToken) { loadPlans().catch(() => {}); const poll = setInterval(() => { if (timmyStopped) clearInterval(poll); else loadPlans().catch(() => {}); }, 3000); }
</script>`;

// ---- Receipt browser: timeline over the chain, verify per receipt ----
const BROWSER_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>TIMMY Receipt Browser</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: ${theme.ground}; color: ${theme.textPrimary}; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 16px; }
  header { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  header .logo { color: ${theme.accent}; font-weight: 700; letter-spacing: .08em; }
  button { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.accent}; border-radius: 6px; font: inherit; padding: 4px 10px; cursor: pointer; }
  input { background: ${theme.surfaceRaised}; border: 1px solid ${theme.line}; color: ${theme.textPrimary}; border-radius: 6px; font: inherit; padding: 4px 10px; }
  #chainstat { color: ${theme.seal}; }
  .epoch { color: ${theme.accent}; margin: 14px 0 6px; letter-spacing: .12em; }
  .rc { border: 1px solid ${theme.line}; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; background: ${theme.ground}; }
  .rc .row1 { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .rc .sub { color: ${theme.textPrimary}; font-weight: 600; }
  .rc .st-ok { color: ${theme.seal}; } .rc .st-failed { color: ${theme.danger}; } .rc .st-denied { color: ${theme.refuse}; }
  .rc .hash { color: ${theme.seal}; } .rc .prev { color: ${theme.textMuted}; }
  .rc .meta { color: ${theme.textSecondary}; font-size: 11px; }
  .rc .vf { color: ${theme.accent}; font-size: 11px; }
</style></head><body>
<header>
  <span class="logo">TIMMY ● RECEIPT BROWSER</span>
  <input id="q" placeholder="filter subject/kind…" size="28" />
  <select id="stream"><option>runs</option><option>gens</option><option>harness</option></select>
  <button id="verify">verify chain</button>
  <span id="chainstat"></span>
</header>
${TOKEN_NOTE}
<div id="list"></div>
<script nonce="${NONCE}">${PAGE_TOKEN_JS}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
// R4 (H95): a receipt's id in an attribute; the verify buttons wired here (the page's policy runs no inline handler)
const attr = s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('button[data-vf]') : null;
  if (b) vf(b.dataset.vf);
});
let CHAIN = [];
async function load() {
  const stream = document.getElementById('stream').value;
  CHAIN = await (await timmyFetch('/receipts?stream=' + stream)).json();
  render();
  const v = await (await timmyFetch('/verify?stream=' + stream)).json();
  document.getElementById('chainstat').textContent =
    (v.ok ? '✓ chain intact · ' : '× broken @ ' + (v.brokenAt ?? '?') + ' · ') + v.count + ' receipts · epoch ' + v.current_epoch;
}
function render() {
  const q = document.getElementById('q').value.toLowerCase();
  const list = document.getElementById('list');
  const rows = CHAIN.filter(r => !q || ((r.subject ?? '') + (r.kind ?? '')).toLowerCase().includes(q));
  let html = '', lastEpoch = null;
  for (const r of [...rows].reverse()) {
    const e = r.epoch ?? 1;
    if (e !== lastEpoch) { html += '<div class="epoch">EPOCH ' + e + '</div>'; lastEpoch = e; }
    html += '<div class="rc" id="rc-' + esc(r.id) + '"><div class="row1">'
      + '<span class="sub">' + esc(r.subject ?? r.kind) + '</span>'
      + '<span class="st-' + esc(r.status ?? 'ok') + '">' + esc(r.status ?? 'ok') + '</span>'
      + '<span class="meta">' + esc(r.ts ?? '').slice(11, 19) + ' · ' + esc(r.kind) + (r.cost_measured === false ? ' · cost declared-unknown' : (r.cost_usd ? ' · $' + r.cost_usd : '')) + (r.tokens ? ' · ' + r.tokens + 'tok' : '') + '</span>'
      + '<button data-vf="' + attr(r.id) + '">verify</button><span class="vf" id="vf-' + attr(r.id) + '"></span></div>'
      + '<div><span class="hash">hash ' + esc(String(r.hash ?? '').slice(0, 20)) + '…</span> <span class="prev">prev ' + esc(String(r.prev_hash ?? '').slice(0, 20)) + '…</span></div>'
      + (r.error_class ? '<div class="meta">error_class: ' + esc(r.error_class) + '</div>' : '')
      + '</div>';
  }
  list.innerHTML = html || '<div class="meta">no receipts match</div>';
}
async function vf(id) {
  const stream = document.getElementById('stream').value;
  const v = await (await timmyFetch('/verify-receipt?stream=' + stream + '&id=' + id)).json();
  document.getElementById('vf-' + id).textContent = v.ok ? '✓ body+sig' : '× ' + (v.bodyOk ? 'sig' : 'body');
}
document.getElementById('q').oninput = render;
document.getElementById('stream').onchange = load;
document.getElementById('verify').onclick = load;
// R4 (H84): with the token only; a refused token stops the polling
if (timmyToken) { load().catch(() => {}); const poll = setInterval(() => { if (timmyStopped) clearInterval(poll); else load().catch(() => {}); }, 5000); }
</script></body></html>`;

// WALNUT /chat mirror (work order p12 OPTIONAL): left column streams the
// TUI conversation through Vercel streamdown; right column is the receipt
// rain fed by SSE. READ-ONLY (§1): tails .sessions + the chain, writes nothing.
function latestSessionPath(): string | null {
  try {
    const files = readdirSync('.sessions').filter(f => f.endsWith('.jsonl')).map(f => join('.sessions', f));
    if (!files.length) return null;
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}
function readSessionTail(n: number): { role: string; content: string }[] {
  const p = latestSessionPath();
  if (!p) return [];
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n)
      .map(l => JSON.parse(l) as { role: string; content: string });
  } catch { return []; }
}
function sessionSize(): number {
  const p = latestSessionPath();
  try { return p ? statSync(p).size : 0; } catch { return 0; }
}

export interface LogServerHandle {
  port: number;
  /** R4 (H84): where it listens: 127.0.0.1 unless a caller gave another host. */
  host: string;
  /** R4 (H84): the address to open, with the token in its fragment (printed where the operator started it, never logged). */
  url: string;
  /** R4 (H87): what opening its page did (only when `open` was asked): handed to the browser opener, off, or not opened. */
  opened?: OpenOutcome;
  stop(): Promise<void>;
}

/**
 * R4 (H87): what openBrowser did: 'asked' (this computer's opener, open or xdg-open, started with the page: whether a browser
 * shows it is that program's), 'off' (TIMMY_LOGS_OPEN=0), or 'failed' (no opener here, or the private launch page could not
 * be written).
 */
export type OpenOutcome = 'asked' | 'off' | 'failed';

/** R4 (H87): what `timmy logs` says after its address, about where it listens and what opening the page did. */
export function logsStartWords(opened: OpenOutcome | undefined): string {
  const what = opened === 'asked' ? 'it was handed to your browser (through a private launch page that keeps the token off command lines)'
    : opened === 'off' ? 'it was not opened (TIMMY_LOGS_OPEN=0): open it yourself'
      : opened === 'failed' ? 'it could not be opened here (no browser opener, or the private launch page could not be written): open it yourself'
        : 'open it yourself';
  return `This computer only (127.0.0.1). The address carries its token after #: ${what}. Ctrl-C stops it.`;
}

export interface LogServerOptions {
  port?: number;
  /** Open the page (with its token, through a private launch page: never on a command line). */
  open?: boolean;
  /** Where it listens; 127.0.0.1 unless given (R4 H84: never every network by default). */
  host?: string;
  /** R4 (H84): the token (64 hex), a test's; made at random when absent. */
  token?: string;
  /**
   * R4 (H84): keep the token for this user's other programs in <TIMMY_HOME>/state/logs-token-<port> (0600, with this pid;
   * removed when it stops): the CLI's choice (`timmy logs`, ensureLogCompanion's server); a test's only with a temporary home.
   */
  tokenFile?: boolean;
  /** R4 (H87): the folder its page files are read from (a test's); this module's own folder when absent. */
  pageDir?: string;
  /** R4 (H95): the folder of the companion's built web code it serves at /web/ (a test's); the package's own when absent. */
  webDir?: string;
}

/** R4 (H84): the routes that carry the operator's content (turns, receipts, events, plans) or write: the token. */
const NEEDS_TOKEN: ReadonlySet<string> = new Set(['/chat/events', '/events', '/receipts', '/verify', '/verify-receipt', '/dispatch', '/dispatch/action', '/mission/compile', '/mission/store', '/mission/inspect', '/mission/escrows', '/mission/theatre']);

/**
 * R4 (H84): the chat mirror's page (chatpage.html). R4 (H87): it throws when the file cannot be read. R4 (H95): its token
 * script is a file of this server's (/chat/page.js: CHAT_PAGE_JS), so the page runs under script-src 'self'; its style
 * block carries the answer's nonce (sendPage).
 */
const chatPage = (dir?: string): string => readFileSync(dir ? join(dir, 'chatpage.html') : new URL('./chatpage.html', import.meta.url), 'utf8');
/** R4 (H95): the chat mirror's token script, served at /chat/page.js: the pages' token lines, then its links. */
export const CHAT_PAGE_JS = `${PAGE_TOKEN_JS}\ntimmyLinks();\n`;

/** Own the listener and polling lifecycle; callers may request port 0. */
export function startManagedLogServer(opts: LogServerOptions = {}): Promise<LogServerHandle> {
  let port = opts.port ?? LOGS_PORT();
  const host = opts.host ?? '127.0.0.1';
  const key = new LocalToken(opts.token);
  let pairSealed = false;
  interface SseClient { res: ServerResponse }
  let clients: SseClient[] = [];
  let tailOffset = 0;

  function broadcast(ev: TimmyEvent) {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.res.write(data);
  }

  function tailLoop() {
    return setInterval(() => {
      // R4 (H87): a bus that cannot be read now is read again on the next tick; it never ends the server
      try {
        const p = eventsPath();
        if (!existsSync(p)) return;
        const size = statSync(p).size;
        if (size < tailOffset) tailOffset = 0; // truncated — restart
        if (size === tailOffset) return;
        const fd = openSync(p, 'r');
        const buf = Buffer.alloc(size - tailOffset);
        try { readSync(fd, buf, 0, buf.length, tailOffset); } finally { closeSync(fd); }
        tailOffset = size;
        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
          try { broadcast(JSON.parse(line) as TimmyEvent); } catch { /* partial line, or a client gone */ }
        }
      } catch { /* next tick */ }
    }, 700);
  }
  // R4 (H87): never dies on a request: a throw anywhere in a route answers 500 with words; a request or answer stream's
  // error (a client gone) is no crash either
  const server = createServer((req, res) => {
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    try { handle(req, res); } catch { failRequest(res, 500, LOGS_FAILED); }
  });
  /** The routes; R4 (H87): what throws here becomes a 500 with words (above), and the callbacks below catch their own. */
  function handle(req: IncomingMessage, res: ServerResponse): void {
    // R4 (H84): this computer's, from its own pages; never a token in an address; the operator's content and every
    // write with the token (checked before anything is read, written or sealed)
    if (!isLocalRequest(req)) return refuseRequest(res, 403, LOGS_FOREIGN);
    if (key.inAddress(req.url)) return refuseRequest(res, 401, TOKEN_IN_ADDRESS);
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const credited = key.bearer(req.headers.authorization);
    if (NEEDS_TOKEN.has(url.pathname) && !credited) return refuseRequest(res, 401, LOGS_REFUSED);
    if (url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // its folder (a path of this computer's) only with the token
      res.end(JSON.stringify(credited ? { ok: true, app: 'timmy-logs', port, folder: folderWords(process.cwd()) } : { ok: true, app: 'timmy-logs', port }));
      return;
    }
    if (url.pathname === '/chat') {
      let page: string;
      try { page = chatPage(opts.pageDir); } catch { failRequest(res, 500, LOGS_PAGE_FAILED, 'text'); return; }
      sendPage(res, page, '/chat');
      return;
    }
    // R4 (H95): the chat mirror's token script, and the companion's built web code (its Streamdown island)
    if (url.pathname === '/chat/page.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(CHAT_PAGE_JS);
      return;
    }
    if (url.pathname.startsWith('/web/')) {
      void sendWebFile(url.pathname, res, opts.webDir).catch(() => failRequest(res, 500, LOGS_FAILED, 'text'));
      return;
    }
    if (url.pathname === '/chat/events') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(': connected\n\n');
      const send = (o: Record<string, unknown>): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
      const pushTurns = (): void => { send({ t: 'turns', turns: readSessionTail(20) }); };
      pushTurns();
      let chainLen = readChain('runs').length;
      for (const r of readChain('runs').slice(-8)) send({ t: 'receipt', hash: String(r.hash).slice(7, 15) + '…', subject: r.subject, kind: r.kind, ts: String(r.ts).slice(11, 19) });
      let sesSize = sessionSize();
      const iv = setInterval(() => {
        // R4 (H87): what cannot be read now is read again on the next tick
        try {
          const ns = sessionSize();
          if (ns !== sesSize) { sesSize = ns; pushTurns(); }
          const cl = readChain('runs').length;
          if (cl !== chainLen) {
            for (const r of readChain('runs').slice(chainLen)) send({ t: 'receipt', hash: String(r.hash).slice(7, 15) + '…', subject: r.subject, kind: r.kind, ts: String(r.ts).slice(11, 19) });
            chainLen = cl;
          }
        } catch { /* next tick */ }
      }, 700);
      res.on('close', () => clearInterval(iv));
      return;
    }
    if (url.pathname === '/events') {
      // SPEC §00 journey step 6: the first live companion client to attach is
      // the pair event — sealed once per server process, read by the HOME ladder.
      if (!pairSealed) {
        pairSealed = true;
        try {
          appendReceipt('runs', { kind: 'run', subject: `companion.pair · log companion SSE client · port ${port}`, policy: 'auto', status: 'ok' });
        } catch { /* best-effort */ }
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(': connected\n\n');
      for (const ev of readEvents(50)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const client = { res };
      clients.push(client);
      res.on('close', () => { clients = clients.filter(c => c !== client); });
      return;
    }
    if (url.pathname === '/receipts') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readChain(stream)));
      return;
    }
    if (url.pathname === '/verify') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(verifyChain(stream)));
      return;
    }
    // Receipt browser backend: per-receipt body-hash + signature check.
    if (url.pathname === '/verify-receipt') {
      const stream = url.searchParams.get('stream') ?? 'runs';
      const id = url.searchParams.get('id') ?? '';
      const rec = readChain(stream).find(r => r.id === id);
      res.setHeader('Content-Type', 'application/json');
      if (!rec) { res.end(JSON.stringify({ ok: false, note: 'unknown receipt' })); return; }
      const { hash, ...rest } = rec;
      const bodyOk = hashOf({ ...rest, hash: '' }) === hash;
      const sigOk = verifySignature(rec);
      res.end(JSON.stringify({ ok: bodyOk && sigOk, bodyOk, sigOk }));
      return;
    }
    if (url.pathname === '/browser') {
      sendPage(res, BROWSER_HTML, '/browser');
      return;
    }
    // Command Post survey surface: same controller, same allowlist. Browser
    // state is never sufficient — every mutation goes through the controller.
    if (url.pathname === '/dispatch') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(listPlans()));
      return;
    }
    if (url.pathname === '/dispatch/action' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', async () => {
        // R4 (H87): a failure answers with words; the server keeps answering
        try {
          const { id, action, token } = body;
          let r: unknown = { ok: false, error: 'unknown action' };
          if (action === 'arm' && token) r = armPlan(String(id), String(token));
          else if (action === 'launch') {
            // openhands+docker plans run through the containerized engine with
            // live telemetry; every other harness keeps the tmux lane runner
            const st = getPlan(String(id));
            r = st && st.plan.harnesses[0] === 'openhands' && st.plan.workspace.kind === 'docker'
              ? await dispatchContainerized(String(id))
              : dispatchPlan(String(id));
          }
          else if (action === 'hold') r = pauseOrCancelLane(String(id), 'hold');
          else if (action === 'cancel') r = pauseOrCancelLane(String(id), 'cancel');
          else if (action === 'collect') r = collectRun(String(id));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(r));
        } catch { failRequest(res, 500, LOGS_FAILED); }
      });
      return;
    }
    // Mission Studio: survey surface for the compiler + playback. Compiles
    // only — every mutation still goes through the controller.
    if (url.pathname === '/mission') {
      sendPage(res, MISSION_HTML, '/mission');
      return;
    }
    if (url.pathname === '/mission/compile' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, errors: ['localhost only'], plans: [] }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        try {
          const out = JSON.stringify(compileMissionMap((body?.doc ?? { nodes: [], edges: [] }) as MissionMapDoc, typeof body?.repo_root === 'string' ? { repoRoot: body.repo_root } : {}));
          res.setHeader('Content-Type', 'application/json');
          res.end(out);
        } catch { failRequest(res, 500, LOGS_FAILED); }
      });
      return;
    }
    // Arming gateway entry: store a compiled plan in the controller and
    // return its id + immutable hash. Arm/launch still require the operator
    // token via /dispatch/action — the companion never executes.
    if (url.pathname === '/mission/store' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, note: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        try {
          const out = JSON.stringify(createPlan((body?.plan ?? {}) as DispatchPlan));
          res.setHeader('Content-Type', 'application/json');
          res.end(out);
        } catch { failRequest(res, 500, LOGS_FAILED); }
      });
      return;
    }
    // v0.7.9 inspectors: Merkle proof tree + USD stage hierarchy. Read-only
    // display aids; localhost-gated like the rest of the gateway.
    if (url.pathname === '/mission/inspect' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLocalIp(ip)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, note: 'localhost only' }));
        return;
      }
      let body: any = {};
      req.on('data', d => { try { body = JSON.parse(d.toString()); } catch { /* ignore */ } });
      req.on('end', () => {
        try {
          let out: string;
          if (body?.kind === 'merkle' && body.pass?.leaves) {
            const tree = merkleProofTree((body.pass.leaves as { hash: string }[]).map(l => l.hash));
            out = JSON.stringify({ ok: true, ...tree, matches: tree.root === body.pass.merkle_root });
          } else if (body?.kind === 'stage' && body.scene) {
            const c = composeUnifiedStage(body.scene, body.hero ? { hero: body.hero } : undefined);
            out = JSON.stringify({ ok: c.ok, sha256: c.sha256, note: c.note, hierarchy: c.ok ? stageHierarchy(body.scene, body.hero) : undefined, usda: c.usda });
          } else {
            out = JSON.stringify({ ok: false, note: 'kind must be merkle|stage' });
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(out);
        } catch { failRequest(res, 500, LOGS_FAILED); }
      });
      return;
    }
    // v0.9.0 escrow ledger: live balance locks / refunds / slashes
    if (url.pathname === '/mission/escrows' && req.method === 'GET') {
      // store-resolved (same path the engine writes), not a hardcoded cwd scan
      const rows: unknown[] = listEscrows()
        .sort((a, b) => String(a.escrow_id).localeCompare(String(b.escrow_id)))
        .map(e => ({
          escrow_id: e.escrow_id, state: e.state, ceiling_usd: e.ceiling_usd, drawn_usd: e.drawn_usd,
          refund_usd: e.refund_usd ?? null, qa_threshold: e.qa_threshold, qa_value: e.qa_value ?? null,
          merkle_root: e.merkle_root ? String(e.merkle_root).slice(0, 16) + '…' : null
        }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, escrows: rows }));
      return;
    }
    if (url.pathname === '/mission/theatre') {
      const folder = String(url.searchParams.get('folder') ?? '');
      const root = process.cwd();
      const abs = resolve(root, folder);
      res.setHeader('Content-Type', 'application/json');
      if (!folder || !abs.startsWith(resolve(root) + '/') || !existsSync(join(abs, 'theatre-state.json'))) {
        res.end(JSON.stringify({ ok: false, error: 'no theatre state in that folder' }));
        return;
      }
      // R4 (H87): read before answering, so a file that cannot be read becomes a 500 with words (handle's catch)
      const state = readFileSync(join(abs, 'theatre-state.json'), 'utf8');
      res.end(state);
      return;
    }
    sendPage(res, PAGE + DISPATCH_HTML, '/');
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('companion did not bind a TCP port'));
        return;
      }
      port = address.port;
      // R4 (H87): an error of the listening server itself (a connection it could not take) never ends it either
      server.removeListener('error', reject);
      server.on('error', () => undefined);
      tailOffset = existsSync(eventsPath()) ? statSync(eventsPath()).size : 0;
      const poll = tailLoop();
      // R4 (H84): the token for this user's other programs, while this server runs
      const tokenAt = opts.tokenFile && writeTokenFile(logsTokenFile(port), key.value) ? logsTokenFile(port) : null;
      const drop = (): void => { if (tokenAt) dropTokenFile(tokenAt, key.value); };
      if (tokenAt) process.once('exit', drop);
      let stopping: Promise<void> | undefined;
      const stop = (): Promise<void> => {
        if (!stopping) {
          clearInterval(poll);
          drop();
          if (tokenAt) process.removeListener('exit', drop);
          stopping = new Promise<void>((done, fail) => {
            server.close(error => error ? fail(error) : done());
            // Includes SSE and keep-alive connections owned by this server.
            server.closeAllConnections();
          });
        }
        return stopping;
      };
      const pageUrl = key.open(`http://127.0.0.1:${port}/`);
      // R4 (H87): what opening the page did, so the words say it (TIMMY_LOGS_OPEN=0 opens nothing)
      if (opts.open) void openBrowser(pageUrl).then((opened) => resolve({ port, host, url: pageUrl, opened, stop }));
      else resolve({ port, host, url: pageUrl, stop });
    });
  });
}

/** Compatibility entry point for the long-lived CLI companion. */
export async function startLogServer(opts: LogServerOptions = {}): Promise<number> {
  return (await startManagedLogServer(opts)).port;
}

/**
 * Opens an address in the default browser. R4 (H84): an address that carries a token never goes on a command line (ps
 * shows it to anyone on this computer): a private launch page (src/utils/launch-page.ts, 0600, removed within a minute)
 * opens it instead; when that page cannot be written, nothing is opened (the address was printed where it was started).
 */
export function openBrowser(url: string): Promise<OpenOutcome> {
  if (process.env.TIMMY_LOGS_OPEN === '0') return Promise.resolve('off');
  let target = url;
  if (carriesSecret(url)) {
    try { target = writeLaunchPage(url).href; } catch { return Promise.resolve('failed'); }
  }
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
      child.once('spawn', () => resolve('asked'));
      child.once('error', () => resolve('failed')); // no opener on this computer: the address was printed
      child.unref();
    } catch { resolve('failed'); }
  });
}

// Idempotent: if the companion is already up, reuse it; else spawn detached so
// it outlives short-lived MCP client processes. First starter auto-pops the
// browser (TIMMY_LOGS_OPEN=0 opts out). R4 (H84): the page opens with the token
// the running log companion keeps for this user's programs; the address returned
// carries it (callers open it with openBrowser, never on a command line or in a log).
export async function ensureLogCompanion(): Promise<{ url: string; started: boolean }> {
  const port = LOGS_PORT();
  const base = `http://127.0.0.1:${port}`;
  const alive = async () => {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      return r.ok;
    } catch { return false; }
  };
  const withToken = async (): Promise<string> => {
    for (let i = 0; i < 8; i++) {
      const t = readTokenFile(logsTokenFile(port));
      if (t) return `${base}/#t=${t}`;
      await new Promise(r => setTimeout(r, 125));
    }
    return `${base}/`;
  };
  if (await alive()) return { url: await withToken(), started: false };
  const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [join(process.cwd(), 'src', 'utils', 'logserver.ts')], { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no tsx here: not started */ });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await alive()) {
      const url = await withToken();
      openBrowser(url);
      return { url, started: true };
    }
  }
  return { url: `${base}/`, started: false };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const open = process.argv.includes('--open') || process.env.TIMMY_LOGS_OPEN === '1';
  // R4 (H84): it keeps its token for this user's programs (ensureLogCompanion opens the page with it)
  startManagedLogServer({ open, tokenFile: true }).then(logs => {
    console.log(`timmy logs companion · ${logs.url} · this computer only · ctrl-c to stop`);
  }).catch(e => {
    console.error(`companion failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
