// The bus side of Slate 3D: which lane an event belongs to, what colour class
// it carries, and three ways to receive events. The viewer only reads.
//
// sources
//   ws    the companion server's WebSocket ({type:'bus.tail'} then {type:'bus'})
//   sse   an EventSource URL that streams one event JSON per message
//   room  a Durable Object room speaking the runs/events contract
//         (GET <worker>/runs/<room>/events, polled)

// R4 (H84): the companion's token, from this page's fragment (#t=<64 hex>: the companion page sets it on its Slate 3D
// frame; a lane opens the page with it). Taken out of the address at once and kept in memory only; sent in an
// Authorization header on this page's requests to the companion (companionFetch) and as a WebSocket subprotocol on the
// companion's socket. Never sent anywhere else: not to a room's worker, not to the edge head.
export const slateToken = (() => {
  try {
    const m = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/.exec(location.hash);
    if (!m) return '';
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  } catch { return ''; }
})();

/** A request to the companion that serves this page (a relative path), with its token in a header. */
export function companionFetch(path, init = {}) {
  return fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${slateToken}` }, credentials: 'omit', cache: 'no-store' });
}

const KIND_ALIASES = { comfy: 'comfyui', oapi: 'openapi', roboflow: 'roboflow', openhands: 'openhands', apify: 'apify', hyperframes: 'hyperframes', defold: 'defold', blender: 'blender', godot: 'godot', unity: 'unity' };

export function laneOf(ev, lanes) {
  const p = ev.payload ?? {};
  if (typeof p.harness === 'string' && lanes.has(p.harness)) return p.harness;
  if (typeof p.lane === 'string' && lanes.has(p.lane)) return p.lane;
  const head = String(ev.kind ?? '').split('.')[0];
  const k = KIND_ALIASES[head] ?? head;
  if (lanes.has(k)) return k;
  if (ev.kind === 'receipt.sealed') {
    const s = String(p.subject ?? '').split(/[.\s:/]/)[0];
    if (lanes.has(s)) return s;
  }
  return null;
}

export function classOf(ev) {
  const k = String(ev.kind ?? '');
  const status = String(ev.payload?.status ?? '');
  if (/denied$/.test(k)) return 'refusal';
  if (k.startsWith('approval.') || k === 'dispatch.armed') return 'human';
  if (/failed$/.test(k) || status === 'failed') return 'failed';
  if (k.startsWith('slate.')) return 'slate';
  if (k === 'receipt.sealed' || k.startsWith('dispatch.') || k.startsWith('run.') || /(done|completed|ok|planned|judged)$/.test(k)) return 'chain';
  return 'other';
}

export function connectBus(opts, onEvent, onStatus) {
  const { source = 'ws', sse, room, worker, poll = false } = opts;
  const q_noWs = () => poll === true;
  let closed = false;
  const status = (live, text) => onStatus?.({ live, text, source });

  if (source === 'sse' && sse) {
    const es = new EventSource(sse);
    es.onopen = () => status(true, 'bus live');
    es.onerror = () => status(false, 'bus reconnecting');
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data), { tail: false }); } catch { /* skip bad line */ } };
    return { close: () => es.close() };
  }

  if (source === 'room' && room && worker) {
    // Preferred: the room's WebSocket (SlateRoom sends {type:'bus.tail'} on
    // connect and {type:'bus', event} for every stored event). Fallback: the
    // cursor poll below when the socket cannot be opened or drops twice.
    const seen = new Set();
    let first = true;
    let next = 0;
    const base = worker.replace(/\/$/, '');
    const wsUrl = `${base.replace(/^http/, 'ws')}/runs/${encodeURIComponent(room)}/ws`;
    let wsFailures = 0;
    let polling = false;
    const accept = (e, tail) => {
      const id = e.id ?? `${e.timestamp ?? e.ts}:${e.type ?? e.kind}`;
      if (typeof e.seq === 'number' && e.seq > next) next = e.seq;
      if (seen.has(id)) return;
      seen.add(id);
      let payload = e.payload ?? e.payload_json ?? {};
      if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
      onEvent({ v: 1, ts: e.timestamp ?? e.ts, kind: e.type ?? e.kind, payload }, { tail });
    };
    const openWs = () => {
      if (closed || polling) return;
      let ws;
      try { ws = new WebSocket(wsUrl); } catch { wsFailures = 2; startPoll(); return; }
      ws.onopen = () => { status(true, `room ${room} live · websocket`); ws.send(JSON.stringify({ type: 'hello', client: 'slate3d' })); };
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.type === 'bus.tail' && Array.isArray(msg.events)) { for (const e of msg.events) accept(e, first); first = false; }
        else if (msg.type === 'bus' && msg.event) accept(msg.event, false);
      };
      ws.onclose = () => {
        if (closed) return;
        wsFailures++;
        status(false, `room ${room} socket closed`);
        if (wsFailures >= 2) startPoll(); else setTimeout(openWs, 1500);
      };
      ws.onerror = () => { /* onclose follows */ };
      closers.push(() => ws.close());
    };
    const closers = [];
    const startPoll = () => { if (polling) return; polling = true; tick(); };
    const tick = async () => {
      if (closed) return;
      try {
        const q = first ? '' : `?since=${next}`;
        const r = await fetch(`${base}/runs/${encodeURIComponent(room)}/events${q}`, { cache: 'no-store' });
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j.events ?? []);
        if (typeof j.next === 'number' && j.next > next) next = j.next;
        for (const e of arr) accept(e, first);
        status(true, `room ${room} live · poll`);
      } catch {
        status(false, `room ${room} unreachable`);
      }
      first = false;
      setTimeout(tick, 1500);
    };
    if (q_noWs()) startPoll(); else openWs();
    return { close: () => { closed = true; for (const c of closers) c(); } };
  }

  // default: the companion WebSocket on the same origin. R4 (H84): it takes the page's token as a subprotocol.
  if (!slateToken) {
    status(false, 'bus needs the companion\'s token: open Slate 3D from the companion page (its SLATE 3D tab)');
    return { close: () => { closed = true; } };
  }
  let ws;
  let backoff = 500;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, ['timmy-companion', `timmy-token.${slateToken}`]);
    ws.onopen = () => { backoff = 500; status(true, 'bus live'); ws.send(JSON.stringify({ type: 'hello', client: 'slate3d' })); };
    ws.onclose = () => { status(false, 'bus reconnecting'); if (!closed) setTimeout(open, (backoff = Math.min(backoff * 2, 8000))); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'bus.tail' && Array.isArray(msg.events)) for (const e of msg.events) onEvent(e, { tail: true });
      else if (msg.type === 'bus' && msg.event) onEvent(msg.event, { tail: false });
    };
  };
  open();
  return { close: () => { closed = true; ws?.close(); } };
}
