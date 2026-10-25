// R12: the Timmy app's one way to the companion. The launch token comes in the page's address after # (t=<64 hex>), as the
// companion's own page takes it (src/companion/client/companion.js): taken out of the address at once and kept in this page's
// memory only (no storage, no cookie), sent in an Authorization header on every request. A 401 that is not a session's stops
// the app and says how to open it again from Timmy.

/** How the app is opened with its token: the terminal command, and what it prints. */
export const OPEN_FROM_TIMMY = 'Open it from Timmy: run `timmy app` in a terminal; it opens this page with its token.';

export const TOKEN = (() => {
  try {
    const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (m) history.replaceState(null, '', location.pathname + location.search);
    return m ? m[1] : '';
  } catch { return ''; }
})();

const listeners = new Set();
let refused = '';
/** The words the app says when the companion refused its token or its session ('' while it has not). */
export const refusal = () => refused;
export function onRefused(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function refuse(words) { if (refused) return; refused = words; for (const fn of listeners) { try { fn(words); } catch { /* the listener's own */ } } }

// ── the records dock's own log: every request this page made to the companion (method, path, status, time), newest last; the
// token is never in a path (it rides in the header), so a line shows nothing secret ──
const LOG_MAX = 120;
const log = [];
const logSubs = new Set();
function record(method, path, status, t0, error) {
  const line = { at: new Date().toISOString(), method, path: String(path).split('#')[0], status, ms: Math.round(performance.now() - t0), error };
  log.push(line);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  for (const fn of logSubs) { try { fn(line); } catch { /* the listener's own */ } }
}
/** This page's requests so far (a copy) and a way to hear the next ones. */
export const requestLog = () => log.slice();
export function onRequest(fn) { logSubs.add(fn); return () => logSubs.delete(fn); }

/** Every request to the companion: the token in a header, never in the address. */
export async function call(path, init = {}) {
  if (!TOKEN) { refuse(`This page has no token, so it reads nothing. ${OPEN_FROM_TIMMY}`); throw new Error('no token'); }
  // the token goes only to this page's own companion: a path of this origin, never another host
  if (!/^\/(?!\/)/.test(String(path))) throw new Error(`not a path of this companion: ${String(path).slice(0, 80)}`);
  const o = { ...init, credentials: 'omit', cache: 'no-store', headers: { ...(init.headers || {}), Authorization: `Bearer ${TOKEN}` } };
  const t0 = performance.now();
  let r;
  try { r = await fetch(path, o); } catch (e) { record(o.method || 'GET', path, 0, t0, e instanceof Error ? e.message : String(e)); throw e; }
  record(o.method || 'GET', path, r.status, t0, '');
  if (r.status === 401) {
    let body = null;
    try { body = await r.clone().json(); } catch { body = null; }
    // (this app carries no account session yet: on a companion with accounts its routes answer needs: session)
    if (body && body.needs === 'session') refuse('This companion has accounts turned on, and this app does not carry an account\'s session yet: use the companion\'s own page (the address `timmy app` prints, without /app), where you can sign in.');
    else refuse(`The companion did not accept this page's token (Timmy started it again, or the address was copied wrong). ${OPEN_FROM_TIMMY}`);
  }
  return r;
}

/** GET as JSON; { ok: false, error } when the request fails or answers no JSON. */
export async function getJson(path) {
  try {
    const r = await call(path);
    const body = await r.json().catch(() => null);
    return body && typeof body === 'object' ? { status: r.status, ...body } : { ok: false, status: r.status, error: `The companion answered ${r.status} without JSON.` };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** POST JSON as JSON. */
export async function postJson(path, body) {
  try {
    const r = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const out = await r.json().catch(() => null);
    return out && typeof out === 'object' ? { status: r.status, ...out } : { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * POST that answers Server-Sent Events (the Chat's /api/chat/turn, the Ollama download): `onEvent(name, data)` for each event,
 * in order; resolves when the stream ends. `signal` aborts the read (the server's own Stop is a separate request).
 */
export async function postSse(path, body, onEvent, signal) {
  const r = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body ?? {}), signal });
  if (!r.ok || !r.body) {
    let words = `The companion answered ${r.status}.`;
    try { const j = await r.json(); words = j.error || j.words || words; } catch { /* no JSON */ }
    onEvent('error', { words, lines: [words], status: r.status });
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      let parsed = null;
      try { parsed = JSON.parse(data.join('\n')); } catch { parsed = { text: data.join('\n') }; }
      try { onEvent(name, parsed); } catch { /* the handler's own */ }
    }
  }
}
